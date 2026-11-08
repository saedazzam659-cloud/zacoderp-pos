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

export type StageLaborEmployeeInput = {
  employeeId: number;
  salaryAmount: number;
  leaveProvision: number | null;
  travelTicketProvision: number | null;
  eosProvision: number | null;
  monthlyHours: number;
};

export function calculateStageEmployeeLabor(
  stageHours: number,
  employees: StageLaborEmployeeInput[],
): {
  amount: number;
  employees: Array<StageLaborEmployeeInput & {
    monthlyCost: number;
    hourlyRate: number;
    stageCost: number;
  }>;
} {
  if (!Number.isFinite(stageHours) || stageHours < 0)
    throw new Error("stageHours must be a non-negative number");
  if (!employees.length) throw new Error("stage labor employees are required");
  const seen = new Set<number>();
  let totalCents = 0;
  const breakdown = employees.map((employee) => {
    if (!Number.isInteger(employee.employeeId) || employee.employeeId <= 0 ||
        seen.has(employee.employeeId)) {
      throw new Error("stage labor employees must be unique valid employee ids");
    }
    seen.add(employee.employeeId);
    if (!Number.isFinite(employee.salaryAmount) || employee.salaryAmount < 0 ||
        !Number.isFinite(employee.monthlyHours) || employee.monthlyHours <= 0) {
      throw new Error("employee salary and monthly hours must be valid");
    }
    const provisions = [
      employee.leaveProvision,
      employee.travelTicketProvision,
      employee.eosProvision,
    ];
    if (provisions.some((amount) => amount == null || !Number.isFinite(amount))) {
      throw new Error("frozen employee provision snapshots are required");
    }
    const monthlyCost = employee.salaryAmount + provisions.reduce<number>(
      (sum, amount) => sum + Number(amount), 0,
    );
    if (monthlyCost < 0) throw new Error("employee monthly labor cost cannot be negative");
    const hourlyRate = monthlyCost / employee.monthlyHours;
    const stageCost = Number((hourlyRate * stageHours).toFixed(2));
    totalCents += Math.round(stageCost * 100);
    return { ...employee, monthlyCost, hourlyRate, stageCost };
  });
  return { amount: totalCents / 100, employees: breakdown };
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