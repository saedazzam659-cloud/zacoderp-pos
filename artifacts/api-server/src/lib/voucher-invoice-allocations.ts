export interface VoucherInvoiceAllocation {
  invoiceId: number;
  percentage: number;
  amount: string;
}

/**
 * Parse the simple-voucher multi-invoice payload and distribute its total in
 * cents. A missing property means the caller is using the legacy single-link
 * path; an empty array explicitly clears prior partial links on update.
 */
export function normalizeVoucherInvoiceAllocations(
  raw: unknown,
  voucherAmount: unknown,
): VoucherInvoiceAllocation[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new Error("توزيع الفواتير غير صالح");
  if (raw.length === 0) return [];
  if (raw.length < 2) throw new Error("اختر فاتورتين على الأقل للتوزيع المتعدد");

  const seen = new Set<number>();
  const allocations = raw.map((item: any) => {
    const invoiceId = Number(item?.invoiceId);
    const percentage = Number(item?.percentage);
    if (!Number.isSafeInteger(invoiceId) || invoiceId < 1) {
      throw new Error("معرّف الفاتورة غير صالح");
    }
    if (seen.has(invoiceId)) throw new Error("لا يمكن اختيار الفاتورة أكثر من مرة");
    seen.add(invoiceId);
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      throw new Error("يجب أن تكون نسبة كل فاتورة أكبر من صفر ولا تتجاوز 100٪");
    }
    return { invoiceId, percentage };
  });

  const percentageTotal = allocations.reduce((sum, item) => sum + item.percentage, 0);
  if (Math.abs(percentageTotal - 100) > 0.005) {
    throw new Error("يجب أن يكون مجموع نسب توزيع الفواتير 100٪");
  }

  const amount = Number(voucherAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("مبلغ السند يجب أن يكون أكبر من صفر");
  }
  const totalCents = Math.round(amount * 100);
  if (!Number.isSafeInteger(totalCents) || totalCents < allocations.length) {
    throw new Error("يجب أن يغطي مبلغ السند 0.01 على الأقل لكل فاتورة");
  }

  // Normalize the tiny accepted percentage-rounding tolerance, then use the
  // largest-remainder method so stored link amounts always total the voucher
  // amount exactly to the cent.
  const shares = allocations.map((item, index) => {
    const exactCents = totalCents * item.percentage / percentageTotal;
    const cents = Math.floor(exactCents);
    return { index, cents, remainder: exactCents - cents };
  });
  let centsLeft = totalCents - shares.reduce((sum, share) => sum + share.cents, 0);
  const remainderOrder = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < centsLeft; i += 1) remainderOrder[i % remainderOrder.length].cents += 1;

  if (shares.some((share) => share.cents < 1)) {
    throw new Error("يجب أن يتجاوز نصيب كل فاتورة 0.01 على الأقل");
  }

  return allocations.map((item, index) => ({
    ...item,
    amount: (shares[index].cents / 100).toFixed(2),
  }));
}
