// Shared discount math + display overlay for the 4 invoice screens
// (sales invoice / sales return / purchase / purchase return).
//
// IMPORTANT — why we bake net unit prices into the payload:
// The Rust create commands (sales_invoice_create, sales_return_create,
// purchase_create, purchase_return_create) RECOMPUTE subtotal / VAT /
// grand-total from qty × unitPrice|unitCost and IGNORE any totals sent by
// the frontend. SQLite has no discount columns. So to apply a discount
// WITHOUT touching Rust/SQLite we fold the discount into the unit price we
// send: VAT then lands on the net (post-discount) base, which is exactly the
// ZATCA-correct behaviour. The original discount breakdown is kept in a
// localStorage overlay (see saveDocDiscount) purely for re-display.

import { baseCurrencyCode } from "./currency";

export type DiscType = "percent" | "value";

/** Optional discount fields attached to a form line (stripped before payload). */
export type DiscFields = { disc?: number; discType?: DiscType };

/** Discount amount + net (pre-VAT) for a single line. */
export function lineNet(
  qty: number, unit: number, disc?: number, discType?: DiscType,
): { gross: number; discAmt: number; net: number } {
  const q = Number(qty) || 0;
  const u = Number(unit) || 0;
  const gross = q * u;
  const d = Number(disc) || 0;
  if (d <= 0 || gross <= 0) return { gross, discAmt: 0, net: gross };
  const discAmt = discType === "value"
    ? Math.min(d, gross)
    : gross * Math.min(d, 100) / 100;
  return { gross, discAmt, net: gross - discAmt };
}

export type DiscInputLine = { qty: number; unit: number; vatRate: number } & DiscFields;

export type DiscountResult = {
  grossSubtotal: number;       // Σ qty×unit, before any discount, pre-VAT
  lineDiscountTotal: number;   // Σ per-line discounts
  afterLine: number;           // grossSubtotal − lineDiscountTotal
  headerDiscountValue: number; // resolved whole-invoice discount (currency)
  netSubtotal: number;         // taxable base after all discounts, pre-VAT
  vatTotal: number;
  grandTotal: number;
  /** Final net unit price per input line (line + header folded in). */
  netUnitPrices: number[];
};

/**
 * Compute all totals + the per-line net unit prices to send to Rust.
 * Header discount is distributed across lines proportionally (by a single
 * factor) so each line keeps its own VAT rate and the per-line VAT stays
 * correct after Rust recomputes from the net unit price.
 */
export function computeDiscount(
  lines: DiscInputLine[], headerDisc: number, headerType: DiscType,
): DiscountResult {
  let grossSubtotal = 0, lineDiscountTotal = 0, afterLine = 0;
  const lineNets = lines.map((l) => {
    const { gross, discAmt, net } = lineNet(l.qty, l.unit, l.disc, l.discType);
    grossSubtotal += gross;
    lineDiscountTotal += discAmt;
    afterLine += net;
    return net;
  });

  const hd = Number(headerDisc) || 0;
  let headerDiscountValue = 0;
  if (hd > 0 && afterLine > 0) {
    headerDiscountValue = headerType === "value"
      ? Math.min(hd, afterLine)
      : afterLine * Math.min(hd, 100) / 100;
  }
  const factor = afterLine > 0 ? (afterLine - headerDiscountValue) / afterLine : 1;

  let netSubtotal = 0, vatTotal = 0;
  const netUnitPrices = lines.map((l, i) => {
    const q = Number(l.qty) || 0;
    const netLine = lineNets[i] * factor;
    netSubtotal += netLine;
    vatTotal += netLine * (Number(l.vatRate) || 0) / 100;
    return q > 0 ? netLine / q : 0;
  });

  return {
    grossSubtotal, lineDiscountTotal, afterLine, headerDiscountValue,
    netSubtotal, vatTotal, grandTotal: netSubtotal + vatTotal, netUnitPrices,
  };
}

// ─── Re-display overlay ──────────────────────────────────────────────
// Keyed by `${docType}:${id}`; lets the expanded detail show the original
// pre-discount subtotal + total discount even though SQLite only stored the
// net prices. Same `pos_desktop_*` overlay convention as the rest of the app.

const DISC_KEY = "pos_desktop_invoice_disc_v1";

export type DocType = "sales_invoice" | "sales_return" | "purchase" | "purchase_return";

export type StoredDisc = {
  grossSubtotal: number;
  lineDiscountTotal: number;
  headerDiscountValue: number;
  /** Document currency code (ISO-4217). Omitted/equal-to-base means base currency. */
  currencyCode?: string;
  /** Exchange rate to base currency (1 for base-currency documents). */
  exchangeRate?: number;
};

function readAll(): Record<string, StoredDisc> {
  try {
    const raw = localStorage.getItem(DISC_KEY);
    return raw ? (JSON.parse(raw) as Record<string, StoredDisc>) : {};
  } catch { return {}; }
}

export function saveDocDiscount(docType: DocType, id: number, d: StoredDisc): void {
  if (!id) return;
  const hasDisc = (d.lineDiscountTotal || 0) > 0 || (d.headerDiscountValue || 0) > 0;
  const hasForeignCurrency = !!d.currencyCode && d.currencyCode !== baseCurrencyCode();
  if (!hasDisc && !hasForeignCurrency) return;
  try {
    const all = readAll();
    all[`${docType}:${id}`] = d;
    localStorage.setItem(DISC_KEY, JSON.stringify(all));
  } catch { /* overlay is best-effort */ }
}

export function getDocDiscount(docType: DocType, id: number): StoredDisc | null {
  return readAll()[`${docType}:${id}`] ?? null;
}

export function clearDocDiscount(docType: DocType, id: number): void {
  if (!id) return;
  try {
    const all = readAll();
    if (`${docType}:${id}` in all) {
      delete all[`${docType}:${id}`];
      localStorage.setItem(DISC_KEY, JSON.stringify(all));
    }
  } catch { /* overlay is best-effort */ }
}
