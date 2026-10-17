export function cashTransferBranchAllowed(
  branchId: number | null | undefined,
  allowedBranchIds: readonly number[] | null,
): boolean {
  return allowedBranchIds === null || branchId == null || allowedBranchIds.includes(branchId);
}

export function cashTransferAvailableBalance(
  received: number,
  paid: number,
  incomingTransfers: number,
  outgoingTransfers: number,
): number {
  return received - paid + incomingTransfers - outgoingTransfers;
}

export function cashTransferHasSufficientBalance(amount: number, balance: number): boolean {
  return Number.isFinite(amount) && amount > 0 && Number.isFinite(balance) && amount <= balance;
}

export function cashTransferNeedsCurrencyRejection(
  isMobile: boolean,
  sourceCurrencyId: number | null,
  targetCurrencyId: number | null,
): boolean {
  return isMobile && sourceCurrencyId !== targetCurrencyId;
}

export function cashTransferPostingAmount(amount: number, exchangeRate: number): number | null {
  const value = amount * exchangeRate;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function cashTransferAlreadyPosted(status: string, journalEntryId: number | null | undefined): boolean {
  return status === "posted" || journalEntryId != null;
}
