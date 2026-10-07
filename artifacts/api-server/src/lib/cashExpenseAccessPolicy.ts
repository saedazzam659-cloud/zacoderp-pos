export type CashExpenseBoxScope = {
  userId: number;
  companyId: number;
  branchIds: Set<number>;
  allBranchBoxes: boolean;
};

export function cashExpenseBoxAllowed(
  box: {
    branchId: number | null;
    branchCompanyId: number | null | undefined;
    cashExpenseManagerUserId: number | null;
  },
  scope: CashExpenseBoxScope,
): boolean {
  if (box.cashExpenseManagerUserId === scope.userId) return true;
  if (box.branchId == null || box.branchCompanyId !== scope.companyId) return false;
  return scope.allBranchBoxes || scope.branchIds.has(box.branchId);
}

export function cashExpenseRecordVisible(
  createdByUserId: number,
  currentUserId: number,
  canViewOwn: boolean,
  canViewAll: boolean,
): boolean {
  return canViewAll || (canViewOwn && createdByUserId === currentUserId);
}

export function summarizeCashExpenseCurrencyTotals(
  rows: readonly { amount: number; currencyCode: string | null }[],
): { totalAmount: number | null; currencyCode: string | null } {
  if (rows.length === 0) return { totalAmount: 0, currencyCode: null };
  const currencyCode = rows[0].currencyCode;
  if (!currencyCode || rows.some((row) => row.currencyCode !== currencyCode)) {
    return { totalAmount: null, currencyCode: null };
  }
  return {
    totalAmount: rows.reduce((sum, row) => sum + row.amount, 0),
    currencyCode,
  };
}
