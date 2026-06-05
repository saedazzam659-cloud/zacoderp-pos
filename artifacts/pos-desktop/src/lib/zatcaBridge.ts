// ZATCA bridge for back-office sales invoices.
//
// The POS register already produces a ZATCA TLV QR and enqueues the sale into
// the `offline_invoices` table, which the existing cloud sync (`/api/sync/push`)
// carries to the server for ZATCA reporting/clearance. Back-office sales
// invoices (SalesInvoicesAdmin → `sales_invoices_local`) historically did NOT
// flow through that pipeline. This module bridges them: after an invoice is
// created we build the SAME `OfflineInvoicePayload` shape the register uses,
// generate the QR, enqueue it, and link the resulting row back onto the invoice
// — reusing the unchanged cloud submission path end-to-end.
//
// Everything is gated to country == "SA" (the only ZATCA jurisdiction). For any
// other country the bridge is a no-op and sales invoices behave exactly as
// before.

import { generateZatcaQr } from "./zatca";
import { saveOfflineInvoice, type OfflineInvoicePayload } from "./invoices";
import { getSalesInvoice, setSalesInvoiceZatca } from "./accounting";
import { getCompanyProfile } from "./appSettings";

const LS_COUNTRY = "pos_desktop_country";

/**
 * True when the install is configured for Saudi Arabia (the ZATCA jurisdiction).
 *
 * An absent country key resolves to "SA" — this matches the app-wide convention
 * (`taxSettings.ts` reads the SAME key as `country || "SA"`, defaulting VAT to
 * 15%) and the first-run wizard always writes it, so a real SA install always
 * bridges rather than silently skipping ZATCA.
 */
export function isZatcaCountry(): boolean {
  if (typeof window === "undefined") return false;
  return (localStorage.getItem(LS_COUNTRY) || "SA").toUpperCase() === "SA";
}

export interface BridgeInput {
  invoiceId: number;
  /** "cash" | "bank" | "credit" — mapped to the ZATCA payload's cash/card axis. */
  paymentMethod: "cash" | "bank" | "credit";
  customerName?: string | null;
  /** Customer VAT number (buyer) — informational on the payload; the QR uses the SELLER VAT. */
  customerVat?: string | null;
}

export interface BridgeResult {
  qrBase64: string;
  offlineUuid: string;
  status: string;
}

/** Round to 2 decimals (ZATCA amounts) without binary-float artefacts. */
function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Bridge a saved sales invoice into the ZATCA offline pipeline. Best-effort by
 * design: the invoice is already persisted before this runs, so a failure here
 * never loses the invoice — the caller surfaces a non-fatal warning and the
 * bridge can be re-run later (idempotent via the stable `sinv-<id>` key).
 *
 * Totals + lines are read back from the PERSISTED invoice (`getSalesInvoice`)
 * rather than recomputed in the UI, so the QR (tags 4/5) and payload always
 * reflect exactly what `sales_invoice_create` stored — no rounding/FX drift.
 */
export async function bridgeSalesInvoiceToZatca(input: BridgeInput): Promise<BridgeResult> {
  const inv = await getSalesInvoice(input.invoiceId);

  const company = getCompanyProfile();
  const sellerName = company.name || "ZACOD POS";
  const sellerVat = company.vat || "";

  // Authoritative, base-currency (SAR) totals as stored by the Rust layer.
  const subtotal = r2(inv.subtotal);
  const vat = r2(inv.vatTotal);
  const grandTotal = r2(inv.grandTotal);

  const payload: OfflineInvoicePayload = {
    customerName: input.customerName ?? inv.customerName ?? undefined,
    // Buyer VAT (when supplied) drives standard-vs-simplified classification on
    // the cloud; fall back to the seller VAT to mirror the register's
    // simplified-invoice behaviour when no buyer VAT is present.
    vatNumber: input.customerVat || sellerVat || undefined,
    paymentMethod: input.paymentMethod === "cash" ? "cash" : "card",
    timestamp: new Date(`${inv.invoiceDate}T00:00:00Z`).toISOString(),
    subtotal,
    vat,
    grandTotal,
    lines: inv.lines.map((l) => ({
      itemId: l.itemId,
      nameAr: l.itemName ?? "",
      qty: l.qty,
      unitPrice: r2(l.unitPrice),
      vatRate: l.vatRate,
    })),
  };

  // ZATCA QR is bound to the SELLER (tag 1 name, tag 2 VAT) + the authoritative totals.
  const qr = await generateZatcaQr({
    sellerName,
    vatNumber: sellerVat,
    timestamp: payload.timestamp,
    invoiceTotal: grandTotal.toFixed(2),
    vatTotal: vat.toFixed(2),
  });

  // Stable idempotency key → re-running the bridge for the same invoice reuses
  // the same offline_invoices row instead of minting duplicates.
  const idempotencyKey = `sinv-${input.invoiceId}`;
  const saved = await saveOfflineInvoice(payload, qr || undefined, undefined, idempotencyKey);

  // Link the QR + offline row back onto the invoice for display / re-print.
  await setSalesInvoiceZatca(input.invoiceId, qr || null, saved.localUuid);

  return { qrBase64: qr, offlineUuid: saved.localUuid, status: "pending" };
}
