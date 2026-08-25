export type TaxCalculationMode = 'before_discount' | 'after_discount';

export type InvoiceLineAmounts = {
  qty: number; unitPrice: number; vatRate: number; discount: number; discountAmount: number;
};

const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const grossOf = (line: Pick<InvoiceLineAmounts, 'qty' | 'unitPrice'>) => Math.max(0, number(line.qty) * number(line.unitPrice));

export function effectiveLineDiscount(line: InvoiceLineAmounts) {
  const gross = grossOf(line);
  const amount = Math.max(0, number(line.discountAmount));
  if (amount > 0) return Math.min(amount, gross);
  return gross * Math.max(0, Math.min(100, number(line.discount))) / 100;
}

export function syncLineDiscount(line: InvoiceLineAmounts, field: 'discount' | 'discountAmount', value: number) {
  const gross = grossOf(line);
  if (field === 'discount') {
    const discount = Math.max(0, Math.min(100, number(value)));
    return { discount, discountAmount: gross ? +(gross * discount / 100).toFixed(2) : 0 };
  }
  const discountAmount = Math.min(gross, Math.max(0, number(value)));
  return { discount: gross ? +((discountAmount / gross) * 100).toFixed(4) : 0, discountAmount };
}

/** Mirrors web SalesDocumentForm calcLine exactly; free qty never enters revenue/VAT. */
export function calcInvoiceLine(line: InvoiceLineAmounts, priceIncludesVat: boolean, mode: TaxCalculationMode = 'after_discount') {
  const fullGross = grossOf(line);
  const rate = number(line.vatRate) / 100;
  const discount = effectiveLineDiscount(line);
  if (mode === 'before_discount') {
    if (priceIncludesVat) {
      const subtotal = fullGross / (1 + rate);
      return { subtotal: Math.max(0, subtotal - discount), vat: fullGross - subtotal, total: Math.max(0, fullGross - discount) };
    }
    return { subtotal: Math.max(0, fullGross - discount), vat: fullGross * rate, total: Math.max(0, fullGross + fullGross * rate - discount) };
  }
  const gross = Math.max(0, fullGross - discount);
  if (priceIncludesVat) {
    const subtotal = gross / (1 + rate);
    return { subtotal, vat: gross - subtotal, total: gross };
  }
  return { subtotal: gross, vat: gross * rate, total: gross * (1 + rate) };
}