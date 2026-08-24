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

/**
 * A legacy HR source row may have been created without a branch even though
 * its selected cash box/bank (or employee) belongs to one. Once that branch is
 * inferred, persist it on the source row and do not reuse a number reserved
 * before the branch was fixed — that reservation may belong to branch 0.
 */
export function isHrPostingBranchBackfill(
  storedBranchId: number | null | undefined,
  resolvedBranchId: number | null | undefined,
): boolean {
  return storedBranchId == null && resolvedBranchId != null;
}