export type PayrollExpenseAccountKey =
  | "salariesExpense"
  | "housingAllowanceExpense"
  | "transportAllowanceExpense"
  | "allowancesExpense"
  | "overtimeExpense"
  | "bonusExpense";

export interface PayrollExpenseComponent {
  accountKey: PayrollExpenseAccountKey;
  label: string;
  amount: number;
}

type PayrollLineAmounts = {
  basicSalary?: unknown;
  absenceDeduction?: unknown;
  housingAllow?: unknown;
  transportAllow?: unknown;
  otherAllow?: unknown;
  overtimeAmount?: unknown;
  bonusAmount?: unknown;
};

export const PAYROLL_EXPENSE_ACCOUNT_KEYS: PayrollExpenseAccountKey[] = [
  "salariesExpense",
  "housingAllowanceExpense",
  "transportAllowanceExpense",
  "allowancesExpense",
  "overtimeExpense",
  "bonusExpense",
];

const amount = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const money = (value: number) => Number(value.toFixed(2));

export function payrollExpenseComponents(line: PayrollLineAmounts): PayrollExpenseComponent[] {
  return [
    {
      accountKey: "salariesExpense",
      label: "مصروف الرواتب الأساسية",
      amount: money(amount(line.basicSalary) - amount(line.absenceDeduction)),
    },
    { accountKey: "housingAllowanceExpense", label: "مصروف بدل السكن", amount: money(amount(line.housingAllow)) },
    { accountKey: "transportAllowanceExpense", label: "مصروف بدل النقل", amount: money(amount(line.transportAllow)) },
    { accountKey: "allowancesExpense", label: "مصروف البدلات الأخرى", amount: money(amount(line.otherAllow)) },
    { accountKey: "overtimeExpense", label: "مصروف العمل الإضافي", amount: money(amount(line.overtimeAmount)) },
    { accountKey: "bonusExpense", label: "مصروف المكافآت", amount: money(amount(line.bonusAmount)) },
  ];
}

export function payrollExpenseTotals(
  lines: readonly PayrollLineAmounts[],
): Record<PayrollExpenseAccountKey, number> {
  const totals = Object.fromEntries(PAYROLL_EXPENSE_ACCOUNT_KEYS.map((key) => [key, 0])) as
    Record<PayrollExpenseAccountKey, number>;
  for (const line of lines) {
    for (const component of payrollExpenseComponents(line)) {
      totals[component.accountKey] = money(totals[component.accountKey] + component.amount);
    }
  }
  return totals;
}

export function missingPayrollExpenseMappings(
  lines: readonly PayrollLineAmounts[],
  accounts: Partial<Record<PayrollExpenseAccountKey, number | null | undefined>>,
): Array<{ key: PayrollExpenseAccountKey; label: string; amount: number }> {
  const totals = payrollExpenseTotals(lines);
  const labels = new Map(
    lines.flatMap((line) => payrollExpenseComponents(line).map((component) =>
      [component.accountKey, component.label] as const)),
  );
  return PAYROLL_EXPENSE_ACCOUNT_KEYS
    .filter((key) => totals[key] > 0 && !accounts[key])
    .map((key) => ({ key, label: labels.get(key) ?? key, amount: totals[key] }));
}
