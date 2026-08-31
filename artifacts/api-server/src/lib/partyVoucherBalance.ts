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

export type NormalizedVoucherAllocation = {
  voucherId: number;
  partyId: number;
  amount: number;
};

/** Normalize the three legacy allocation sources into one row per source
 * portion. Both statement rows and report aggregates consume this function so
 * fallback and de-duplication rules cannot drift apart. Line and settlement
 * portions remain separate (and additive), including when they target the same
 * party; duplicate rows produced by joins are removed by their source id. */
export function supplementalInvoiceLinkedVoucherAllocations(
  vouchers: UnownedVoucher[],
  lines: VoucherAllocation[],
  settlements: VoucherAllocation[],
  headers: VoucherHeaderLink[],
): NormalizedVoucherAllocation[] {
  const voucherAmount = new Map(vouchers.map(v => [v.id, Number(v.amount)]));
  const portions: Array<NormalizedVoucherAllocation & { sourceOrder: number; sourceId: number }> = [];
  const add = (
    voucherId: number,
    partyId: number | null,
    amount: unknown,
    sourceOrder: number,
    sourceId: number,
  ): boolean => {
    const value = Number(amount);
    if (partyId == null || !Number.isFinite(value)) return false;
    portions.push({ voucherId, partyId, amount: value, sourceOrder, sourceId });
    return true;
  };
  const used = new Set<number>();
  const hasAllocation = new Set<number>();

  // A line is an actual portion of the payment, including its input VAT.
  for (const line of lines) {
    if (!voucherAmount.has(line.voucherId) || used.has(line.id)) continue;
    used.add(line.id);
    if (add(line.voucherId, line.partyId, line.amount, 0, line.id)) {
      hasAllocation.add(line.voucherId);
    }
  }

  // Settlement links are already residual allocations by invariant. They are
  // additive with voucher lines and each unique link is counted in full.
  used.clear();
  for (const link of settlements) {
    if (!voucherAmount.has(link.voucherId) || used.has(link.id)) continue;
    used.add(link.id);
    if (add(link.voucherId, link.partyId, link.amount, 1, link.id)) {
      hasAllocation.add(link.voucherId);
    }
  }

  // The legacy header FK has no allocation amount. It is safe only when this
  // voucher has neither line nor settlement portions.
  const headerVouchers = new Set<number>();
  for (const header of headers) {
    if (headerVouchers.has(header.voucherId) || hasAllocation.has(header.voucherId)) continue;
    headerVouchers.add(header.voucherId);
    if (voucherAmount.has(header.voucherId)) {
      add(header.voucherId, header.partyId, voucherAmount.get(header.voucherId), 2, header.voucherId);
    }
  }
  return portions
    .sort((a, b) =>
      a.voucherId - b.voucherId ||
      a.sourceOrder - b.sourceOrder ||
      a.sourceId - b.sourceId ||
      a.partyId - b.partyId)
    .map(({ voucherId, partyId, amount }) => ({ voucherId, partyId, amount }));
}

/** Statement rows are display movements rather than allocation-source audit
 * rows. Collapse a voucher's normalized portions for the same party so a
 * line plus its residual settlement renders as one payment/receipt movement.
 * Different parties intentionally remain distinct rows. */
export function supplementalInvoiceLinkedVoucherRowAllocations(
  vouchers: UnownedVoucher[],
  lines: VoucherAllocation[],
  settlements: VoucherAllocation[],
  headers: VoucherHeaderLink[],
): NormalizedVoucherAllocation[] {
  const grouped = new Map<string, NormalizedVoucherAllocation>();
  for (const allocation of supplementalInvoiceLinkedVoucherAllocations(vouchers, lines, settlements, headers)) {
    const key = `${allocation.voucherId}:${allocation.partyId}`;
    const prior = grouped.get(key);
    grouped.set(key, {
      voucherId: allocation.voucherId,
      partyId: allocation.partyId,
      amount: (prior?.amount ?? 0) + allocation.amount,
    });
  }
  return [...grouped.values()]
    .sort((a, b) => a.voucherId - b.voucherId || a.partyId - b.partyId);
}

export function supplementalInvoiceLinkedVoucherTotals(
  vouchers: UnownedVoucher[],
  lines: VoucherAllocation[],
  settlements: VoucherAllocation[],
  headers: VoucherHeaderLink[],
): Map<number, number> {
  const totals = new Map<number, number>();
  for (const row of supplementalInvoiceLinkedVoucherAllocations(vouchers, lines, settlements, headers)) {
    totals.set(row.partyId, (totals.get(row.partyId) ?? 0) + row.amount);
  }
  return totals;
}