/** Read-only allocations for legacy posted vouchers which have no entityId.
 * Existing entity-linked report aggregates deliberately remain untouched. */
export type UnownedVoucher = { id: number; amount: unknown };
export type VoucherAllocation = {
  id: number;
  voucherId: number;
  partyId: number | null;
  amount: unknown;
};
export type VoucherHeaderLink = { voucherId: number; partyId: number | null };

export function supplementalInvoiceLinkedVoucherTotals(
  vouchers: UnownedVoucher[],
  lines: VoucherAllocation[],
  settlements: VoucherAllocation[],
  headers: VoucherHeaderLink[],
): Map<number, number> {
  const voucherAmount = new Map(vouchers.map(v => [v.id, Number(v.amount)]));
  const totals = new Map<number, number>();
  const add = (partyId: number | null, amount: unknown) => {
    const value = Number(amount);
    if (partyId != null && Number.isFinite(value)) {
      totals.set(partyId, (totals.get(partyId) ?? 0) + value);
    }
  };
  const used = new Set<number>();
  const hasAllocation = new Set<number>();

  // A line is an actual portion of the payment, including its input VAT.
  for (const line of lines) {
    if (!voucherAmount.has(line.voucherId) || used.has(line.id)) continue;
    used.add(line.id);
    const amount = Number(line.amount);
    if (!Number.isFinite(amount)) continue;
    hasAllocation.add(line.voucherId);
    add(line.partyId, amount);
  }

  // Settlement links are already residual allocations by invariant. They are
  // additive with voucher lines and each unique link is counted in full.
  used.clear();
  for (const link of settlements) {
    if (!voucherAmount.has(link.voucherId) || used.has(link.id)) continue;
    used.add(link.id);
    const amount = Number(link.amount);
    if (!Number.isFinite(amount)) continue;
    hasAllocation.add(link.voucherId);
    add(link.partyId, amount);
  }

  // The legacy header FK has no allocation amount. It is safe only when this
  // voucher has neither line nor settlement portions.
  const headerVouchers = new Set<number>();
  for (const header of headers) {
    if (headerVouchers.has(header.voucherId) || hasAllocation.has(header.voucherId)) continue;
    headerVouchers.add(header.voucherId);
    if (voucherAmount.has(header.voucherId)) add(header.partyId, voucherAmount.get(header.voucherId));
  }
  return totals;
}