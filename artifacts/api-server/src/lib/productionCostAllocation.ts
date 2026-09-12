export function calculateSourceAllocation(sourceAmount: number, sharePct: number): number {
  if (!Number.isFinite(sourceAmount) || sourceAmount < 0)
    throw new Error("sourceAmount must be a non-negative number");
  if (!Number.isFinite(sharePct) || sharePct <= 0 || sharePct > 100)
    throw new Error("sharePct must be greater than 0 and at most 100");
  return Number((sourceAmount * sharePct / 100).toFixed(2));
}

export function calculateFormulaAllocation(
  method: "operating_hours" | "production_quantity" | "fixed_hourly_rate",
  sourceAmount: number,
  numerator: number,
  denominatorOrRate: number,
): number {
  if (!Number.isFinite(sourceAmount) || sourceAmount < 0)
    throw new Error("sourceAmount must be a non-negative number");
  if (!Number.isFinite(numerator) || numerator < 0)
    throw new Error("allocation numerator must be non-negative");
  if (!Number.isFinite(denominatorOrRate) || denominatorOrRate <= 0)
    throw new Error("allocation denominator or rate must be greater than zero");
  const amount = method === "fixed_hourly_rate"
    ? numerator * denominatorOrRate
    : sourceAmount * numerator / denominatorOrRate;
  return Number(amount.toFixed(2));
}

export function assertAllocationCapacity(sourceAmount: number, alreadyAllocated: number, requested: number): void {
  if (alreadyAllocated < 0 || requested < 0 || alreadyAllocated + requested > sourceAmount + 0.005)
    throw new Error("allocation exceeds available source amount");
}

export type WeightedAccount = { accountId: number; weight: number };

/**
 * Split a frozen allocation over the debit accounts of its already-posted
 * source journal.  The final account receives the rounding residual so the
 * production reclassification always balances to the cent.
 */
export function allocateToSourceAccounts(amount: number, accounts: WeightedAccount[]): { accountId: number; amount: number }[] {
  if (!Number.isFinite(amount) || amount < 0)
    throw new Error("amount must be a non-negative number");
  const valid = accounts.filter((x) =>
    Number.isInteger(x.accountId) && x.accountId > 0 && Number.isFinite(x.weight) && x.weight > 0,
  );
  const weightTotal = valid.reduce((sum, x) => sum + x.weight, 0);
  if (amount > 0 && !(weightTotal > 0))
    throw new Error("source expense accounts are required");

  let assigned = 0;
  return valid.map((x, index) => {
    const part = index === valid.length - 1
      ? Number((amount - assigned).toFixed(2))
      : Number((amount * x.weight / weightTotal).toFixed(2));
    assigned += part;
    return { accountId: x.accountId, amount: part };
  }).filter((x) => x.amount > 0);
}