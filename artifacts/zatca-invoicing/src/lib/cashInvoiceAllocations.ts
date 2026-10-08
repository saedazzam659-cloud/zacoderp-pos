export interface InvoiceAllocationDraft {
  invoiceId: number;
  percentage: number;
}

function percentagesFromWeights(
  invoiceIds: string[],
  getWeight: (invoiceId: string) => number,
): Record<string, string> {
  if (invoiceIds.length < 2) return {};
  const weights = invoiceIds.map((id) => Math.max(0, Number(getWeight(id)) || 0));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const effectiveWeights = weightTotal > 0 ? weights : weights.map(() => 1);
  const total = effectiveWeights.reduce((sum, weight) => sum + weight, 0);
  // Keep six decimal places in percentages so very small open balances remain
  // representable alongside much larger invoices without being rounded up
  // into an overpayment.
  const exact = effectiveWeights.map((weight) => 100_000_000 * weight / total);
  const units = exact.map(Math.floor);
  let remaining = 100_000_000 - units.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - units[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < remaining; i += 1) units[order[i % order.length].index] += 1;

  // The voucher API requires every selected invoice to receive a positive
  // share. Preserve 100.00% by moving a hundredth from the largest shares.
  for (let i = 0; i < units.length; i += 1) {
    if (units[i] > 0) continue;
    const donorIndex = units.reduce((best, value, index) => (
      value > units[best] ? index : best
    ), 0);
    if (units[donorIndex] <= 1) break;
    units[donorIndex] -= 1;
    units[i] = 1;
  }

  return Object.fromEntries(invoiceIds.map((id, index) => [id, (units[index] / 1_000_000).toFixed(6)]));
}

export function defaultInvoicePercentages(
  invoiceIds: string[],
  getRemainingAmount: (invoiceId: string) => number,
): Record<string, string> {
  return percentagesFromWeights(invoiceIds, getRemainingAmount);
}

export function invoicePercentagesFromAmounts(
  invoiceIds: string[],
  allocations: Array<{ invoiceId: number | string; amount: number | string }>,
): Record<string, string> {
  const amounts = new Map(allocations.map((allocation) => [
    String(allocation.invoiceId),
    Math.max(0, Number(allocation.amount) || 0),
  ]));
  return percentagesFromWeights(invoiceIds, (id) => amounts.get(id) ?? 0);
}

export function isInvoicePercentageTotalValid(
  invoiceIds: string[],
  percentages: Record<string, string>,
): boolean {
  if (invoiceIds.length < 2) return true;
  const values = invoiceIds.map((id) => Number(percentages[id]));
  return values.every((value) => Number.isFinite(value) && value > 0 && value <= 100)
    && Math.abs(values.reduce((sum, value) => sum + value, 0) - 100) < 0.005;
}

export function buildInvoiceAllocationDraft(
  invoiceIds: string[],
  percentages: Record<string, string>,
): InvoiceAllocationDraft[] {
  if (!isInvoicePercentageTotalValid(invoiceIds, percentages)) {
    throw new Error("Invoice distribution percentages must be positive and total 100%.");
  }
  return invoiceIds.map((invoiceId) => ({
    invoiceId: Number(invoiceId),
    percentage: Number(percentages[invoiceId]),
  }));
}
