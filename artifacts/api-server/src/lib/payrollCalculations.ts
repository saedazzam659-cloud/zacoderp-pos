import { HrValidationError } from "./hrValidate.js";

type PayrollLineAmounts = {
  basicSalary?: unknown;
  housingAllow?: unknown;
  transportAllow?: unknown;
  otherAllow?: unknown;
  overtimeAmount?: unknown;
  bonusAmount?: unknown;
  totalDeductions?: unknown;
};

function amount(value: unknown, label: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) throw new HrValidationError(`${label}: قيمة رقمية غير صالحة`);
  return parsed;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculatePayrollLineTotals(line: PayrollLineAmounts) {
  const grossSalary = roundMoney(
    amount(line.basicSalary, "الراتب الأساسي") +
    amount(line.housingAllow, "بدل السكن") +
    amount(line.transportAllow, "بدل النقل") +
    amount(line.otherAllow, "البدلات الأخرى") +
    amount(line.overtimeAmount, "العمل الإضافي") +
    amount(line.bonusAmount, "المكافأة"),
  );
  const netSalary = roundMoney(grossSalary - amount(line.totalDeductions, "إجمالي الخصومات"));
  return { grossSalary, netSalary };
}
