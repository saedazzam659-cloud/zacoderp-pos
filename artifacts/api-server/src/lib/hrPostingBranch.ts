/**
 * HR cash movements belong to the document/employee branch when present.
 * If both are blank, the selected cash box or bank is the authoritative
 * branch; otherwise a null branch would consume the unrelated branch-0 JE
 * counter.
 */
export function resolveHrPostingBranch(
  primaryBranchId: number | null | undefined,
  paymentSourceBranchId: number | null | undefined,
  employeeBranchId?: number | null,
): number | null {
  return primaryBranchId ?? paymentSourceBranchId ?? employeeBranchId ?? null;
}