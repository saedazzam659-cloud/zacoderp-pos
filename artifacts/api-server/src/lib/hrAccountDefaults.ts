export const HR_ACCOUNT_COLUMNS = {
  salariesExpense: "hrSalariesExpenseAccountId",
  allowancesExpense: "hrAllowancesExpenseAccountId",
  housingAllowanceExpense: "hrHousingAllowanceExpenseAccountId",
  transportAllowanceExpense: "hrTransportAllowanceExpenseAccountId",
  overtimeExpense: "hrOvertimeExpenseAccountId",
  bonusExpense: "hrBonusExpenseAccountId",
  gosiExpense: "hrGosiExpenseAccountId",
  eosExpense: "hrEosExpenseAccountId",
  salariesPayable: "hrSalariesPayableAccountId",
  gosiPayable: "hrGosiPayableAccountId",
  otherDeductions: "hrOtherDeductionsAccountId",
  employeeLoans: "hrEmployeeLoansAccountId",
  employeeCustody: "hrEmployeeCustodyAccountId",
  eosProvision: "hrEosProvisionAccountId",
  leaveProvisionExpense: "hrLeaveProvisionExpenseAccountId",
  leaveProvisionLiability: "hrLeaveProvisionLiabilityAccountId",
  travelTicketExpense: "hrTravelTicketExpenseAccountId",
  travelTicketLiability: "hrTravelTicketLiabilityAccountId",
} as const;

export type HrAccountKey = keyof typeof HR_ACCOUNT_COLUMNS;

// These are the established HR accounts in the canonical chart plus four
// dedicated expense accounts approved for the split payroll components.
export const HR_ACCOUNT_CODES: Record<HrAccountKey, string> = {
  salariesExpense: "5201",
  allowancesExpense: "5202",
  housingAllowanceExpense: "5219",
  transportAllowanceExpense: "5220",
  overtimeExpense: "5221",
  bonusExpense: "5222",
  gosiExpense: "5203",
  eosExpense: "5215",
  salariesPayable: "21051",
  gosiPayable: "21052",
  otherDeductions: "21053",
  employeeLoans: "11081",
  employeeCustody: "11082",
  eosProvision: "22021",
  leaveProvisionExpense: "5217",
  leaveProvisionLiability: "22022",
  travelTicketExpense: "5218",
  travelTicketLiability: "22023",
};

// These dedicated accounts are optional-module accounts, so they are added
// only when HR is selected for a new company or explicitly enabled later.
export const HR_OPTIONAL_ACCOUNTS = [
  { code: "5219", nameAr: "مصروف بدل السكن", nameEn: "Housing Allowance Expense", type: "expense", parent: "52" },
  { code: "5220", nameAr: "مصروف بدل النقل", nameEn: "Transportation Allowance Expense", type: "expense", parent: "52" },
  { code: "5221", nameAr: "مصروف العمل الإضافي", nameEn: "Overtime Expense", type: "expense", parent: "52" },
  { code: "5222", nameAr: "مصروف المكافآت", nameEn: "Bonus Expense", type: "expense", parent: "52" },
] as const;
