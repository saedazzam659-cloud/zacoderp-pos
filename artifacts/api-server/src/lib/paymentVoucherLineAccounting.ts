export interface PaymentVoucherLineAccountingInput {
  amount: number;
  taxAmount: number;
  opType?: string | null;
  purchaseInvoiceId?: number | null;
}

export interface PaymentVoucherLineAccountingSides {
  debit: number;
  credit: number;
  taxDebit: number;
  total: number;
}

/**
 * Convert one payment-voucher allocation into journal sides.
 *
 * Positive direct allocations debit their account. Negative direct
 * allocations credit their account and reduce the cash/bank paid. Special
 * operation lines remain positive because they create linked business
 * records (loan, custody, asset, etc.) whose reverse lifecycle is not a
 * negative payment line.
 */
export function paymentVoucherLineAccounting(
  line: PaymentVoucherLineAccountingInput,
): PaymentVoucherLineAccountingSides {
  const { amount, taxAmount, opType = "direct", purchaseInvoiceId = null } = line;
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error("مبلغ البند يجب ألا يساوي صفراً");
  }
  if (!Number.isFinite(taxAmount) || taxAmount < 0) {
    throw new Error("مبلغ الضريبة غير صالح");
  }
  if (amount < 0 && opType !== "direct") {
    throw new Error("لا يمكن أن يكون بند العملية الخاصة بالسالب");
  }
  if (amount < 0 && taxAmount !== 0) {
    throw new Error("البند السالب لا يقبل ضريبة؛ اجعل الضريبة صفراً");
  }
  if (amount < 0 && purchaseInvoiceId) {
    throw new Error("لا يمكن ربط بند سالب بفاتورة مورد");
  }
  return {
    debit: amount > 0 ? amount : 0,
    credit: amount < 0 ? Math.abs(amount) : 0,
    taxDebit: taxAmount,
    total: amount + taxAmount,
  };
}

export function paymentVoucherAccountingTotal(
  lines: PaymentVoucherLineAccountingInput[],
): number {
  return lines.reduce(
    (sum, line) => sum + paymentVoucherLineAccounting(line).total,
    0,
  );
}