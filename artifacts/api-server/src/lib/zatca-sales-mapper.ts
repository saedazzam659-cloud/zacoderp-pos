/**
 * Map a back-office sales invoice (`sales_invoices` + `sales_invoice_lines`)
 * into the `InvoiceData` shape the ZATCA UBL generator expects.
 *
 * Unlike the web `invoicesTable`, sales-invoice lines store ONLY a gross
 * `lineTotal` (no per-line VAT-exclusive subtotal / VAT split), prices may be
 * VAT-inclusive, and the document may be in a foreign currency. ZATCA requires:
 *   - every document amount in SAR (we convert via the stored exchange rate);
 *   - per-line `LineExtensionAmount = unitPrice*qty - allowance` (BR-CO-13);
 *   - `Σ line LineExtensionAmount = document LineExtensionAmount` (BR-CO-10);
 *   - `document TaxExclusiveAmount = LineExtension - AllowanceTotal` and
 *     `TaxInclusiveAmount = TaxExclusive + TaxAmount` (BR-CO-13/15).
 *
 * The UBL generator emits NO document-level `cac:AllowanceCharge`, so a non-zero
 * document `AllowanceTotalAmount` would violate BR-CO-11. We therefore FOLD all
 * discounts (line + header) into the per-line net amounts and set
 * `discountTotal = 0`. Every per-line value is computed so the sums reconcile by
 * construction; the caller reconciles the resulting grand total against the
 * stored header total and fails loudly on any drift rather than submitting a
 * document ZATCA would reject opaquely.
 */
import type {
  salesInvoicesTable,
  salesInvoiceLinesTable,
  companiesTable,
  customersTable,
} from "@workspace/db";
import type { InvoiceData } from "./zatca-xml.js";

type SalesInvoiceRow = typeof salesInvoicesTable.$inferSelect;
type SalesLineRow = typeof salesInvoiceLinesTable.$inferSelect;
type CompanyRow = typeof companiesTable.$inferSelect;
type CustomerRow = typeof customersTable.$inferSelect;

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface SalesZatcaChainParams {
  invoiceCounterValue: number;
  previousInvoiceHash: string;
  issueTime?: string;
}

export interface SalesZatcaMapResult {
  data: Omit<InvoiceData, "qrCode">;
  /** Document grand total in SAR derived from the per-line construction. */
  computedGrandTotalSar: number;
  /** Authoritative grand total in SAR (stored header × exchange rate). */
  storedGrandTotalSar: number;
  /** Document VAT total in SAR (sum of per-line VAT). */
  computedVatTotalSar: number;
  /** Resolved ZATCA invoice type: standard (B2B) vs simplified (B2C). */
  invoiceType: "standard" | "simplified";
}

export function salesInvoiceRowToZatcaData(
  invoice: SalesInvoiceRow,
  lines: SalesLineRow[],
  company: CompanyRow,
  customer: CustomerRow | null,
  chain: SalesZatcaChainParams,
): SalesZatcaMapResult {
  const fx = Number(invoice.exchangeRate) || 1;
  const priceIncludesVat = !!invoice.priceIncludesVat;

  // A customer with a (non-empty) VAT number → standard tax invoice (B2B,
  // clearance); otherwise a simplified invoice (B2C, reporting).
  const custVat = (customer?.vatNumber ?? "").replace(/\D/g, "");
  const invoiceType: "standard" | "simplified" = custVat.length === 15 ? "standard" : "simplified";

  // 1. Per line: net (VAT-exclusive, after the line's own discount), in the
  //    invoice currency, plus the VAT-exclusive unit price.
  type Calc = {
    qty: number;
    rate: number;
    unitPriceExcl: number;
    netBefore: number;
    description: string;
    unitCode: string;
  };
  const calc: Calc[] = [];
  for (const ln of lines) {
    const qty = Number(ln.qty) || 0;
    const price = Number(ln.unitPrice) || 0;
    const discPct = Number(ln.discount) || 0;
    const discAmt = Number(ln.discountAmount) || 0;
    if (qty <= 0 || price <= 0) continue;
    const rate = (Number(ln.vatRate) || 0) / 100;
    const grossPre = qty * price;
    const discGross = Math.min(grossPre, grossPre * (discPct / 100) + discAmt);
    const netGross = grossPre - discGross; // after line discount, still ±VAT
    const netBefore = priceIncludesVat ? netGross / (1 + rate) : netGross;
    const unitPriceExcl = priceIncludesVat ? price / (1 + rate) : price;
    calc.push({
      qty,
      rate,
      unitPriceExcl,
      netBefore,
      description: ln.itemName,
      unitCode: ln.unit ?? "PCE",
    });
  }

  // 2. Fold the document-level (header) discount in proportionally so the line
  //    nets sum to the authoritative taxable base. The taxable base is derived
  //    from the stored header (total − VAT), which already nets every discount.
  const sumBefore = calc.reduce((s, c) => s + c.netBefore, 0);
  const targetNet = (Number(invoice.totalAmount) || 0) - (Number(invoice.vatAmount) || 0);
  const factor = sumBefore > 0 ? targetNet / sumBefore : 1;

  // 3. Build per-line ZATCA items in SAR, fixing rounding remainders on the last
  //    line so the sums match the authoritative header exactly.
  const lineItems: InvoiceData["lineItems"] = [];
  let netSarRunning = 0;
  let vatSarRunning = 0;
  const targetNetSar = r2(targetNet * fx);
  const targetVatSar = r2((Number(invoice.vatAmount) || 0) * fx);

  calc.forEach((c, idx) => {
    const isLast = idx === calc.length - 1;
    const netInvCur = c.netBefore * factor;
    let netSar = r2(netInvCur * fx);
    let vatSar = r2(netSar * c.rate);
    if (isLast) {
      // Absorb accumulated rounding error so Σ lines === header totals.
      netSar = r2(targetNetSar - netSarRunning);
      vatSar = r2(targetVatSar - vatSarRunning);
    }
    netSarRunning = r2(netSarRunning + netSar);
    vatSarRunning = r2(vatSarRunning + vatSar);

    // BR-CO-13: LineExtensionAmount = unitPrice*qty - allowance. Derive the
    // allowance from the SAR unit price so the line reconciles exactly.
    let unitPriceSar = r2(c.unitPriceExcl * fx);
    let allowanceSar = r2(unitPriceSar * c.qty - netSar);
    if (allowanceSar < 0) {
      // Discount-folding + last-line rounding pushed this line's net ABOVE
      // unitPrice*qty, which would force a negative (invalid) allowance. Raise
      // the unit price just enough that the BR-CO-13 line equation still holds
      // with a non-negative allowance, rather than clamping and leaving
      // LineExtension ≠ price*qty - allowance (which ZATCA rejects).
      unitPriceSar = Math.ceil((netSar / c.qty) * 100) / 100;
      allowanceSar = r2(unitPriceSar * c.qty - netSar);
      if (allowanceSar < 0) allowanceSar = 0;
    }

    lineItems.push({
      id: idx + 1,
      description: c.description,
      quantity: String(c.qty),
      unitCode: c.unitCode,
      unitPrice: unitPriceSar.toFixed(2),
      discountAmount: allowanceSar.toFixed(2),
      taxCategory: "S",
      vatRate: (c.rate * 100).toFixed(2),
      vatAmount: vatSar.toFixed(2),
      subtotal: netSar.toFixed(2),
      total: r2(netSar + vatSar).toFixed(2),
    });
  });

  const computedSubtotalSar = netSarRunning;
  const computedVatTotalSar = vatSarRunning;
  const computedGrandTotalSar = r2(computedSubtotalSar + computedVatTotalSar);

  const data: Omit<InvoiceData, "qrCode"> = {
    invoiceNumber: invoice.docNumber || `SINV-${invoice.id}`,
    invoiceType,
    issueDate: invoice.invoiceDate,
    issueTime: chain.issueTime ?? new Date().toTimeString().split(" ")[0],
    supplyDate: invoice.invoiceDate,
    currency: "SAR",
    paymentMethod: invoice.paymentType === "cash" ? "10" : "30",
    subtotal: computedSubtotalSar.toFixed(2),
    discountTotal: "0.00",
    vatTotal: computedVatTotalSar.toFixed(2),
    grandTotal: computedGrandTotalSar.toFixed(2),
    notes: invoice.notes,
    invoiceCounterValue: chain.invoiceCounterValue,
    previousInvoiceHash: chain.previousInvoiceHash,
    lineItems,
    company: {
      nameAr: company.nameAr,
      nameEn: company.nameEn ?? null,
      vatNumber: company.vatNumber,
      crNumber: company.crNumber ?? "",
      street: company.street ?? "",
      buildingNumber: company.buildingNumber ?? "",
      city: company.city ?? "",
      district: company.district ?? null,
      postalCode: company.postalCode ?? "",
      country: company.country ?? "SA",
    },
    customer: customer
      ? {
          nameAr: customer.nameAr,
          vatNumber: customer.vatNumber,
          crNumber: customer.crNumber,
          street: customer.street,
          buildingNumber: customer.buildingNumber,
          district: customer.district,
          city: customer.city,
          postalCode: customer.postalCode,
          country: customer.country ?? "SA",
        }
      : null,
  };

  return {
    data,
    computedGrandTotalSar,
    storedGrandTotalSar: r2((Number(invoice.totalAmount) || 0) * fx),
    computedVatTotalSar,
    invoiceType,
  };
}
