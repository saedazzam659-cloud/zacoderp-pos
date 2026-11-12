import type { Account } from "./accounting";

export type AccountLevelMode = "all" | "first" | "last";

export type AccountReportRow = { accountId: number };

/** Derive hierarchy from parent links; imported `level` values can be stale. */
export function accountReportTree(accounts: Account[]) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const children = new Map<number, number[]>();
  for (const account of accounts) {
    const parentId = account.parentId;
    if (parentId == null || !byId.has(parentId)) continue;
    const list = children.get(parentId) ?? [];
    list.push(account.id);
    children.set(parentId, list);
  }

  const depthOf = (accountId: number) => {
    let depth = 1;
    let current = byId.get(accountId);
    const seen = new Set<number>([accountId]);
    while (current?.parentId != null && depth <= 50) {
      const parentId = current.parentId;
      if (!byId.has(parentId) || seen.has(parentId)) break;
      seen.add(parentId);
      depth += 1;
      current = byId.get(parentId);
    }
    return depth;
  };

  const descendantsOf = (parentIds: number[]) => {
    if (parentIds.length === 0) return null;
    const result = new Set<number>();
    const pending = [...parentIds];
    while (pending.length) {
      const id = pending.pop()!;
      if (result.has(id) || !byId.has(id)) continue;
      result.add(id);
      pending.push(...(children.get(id) ?? []));
    }
    return result;
  };

  return { byId, children, depthOf, descendantsOf };
}

export function filterAccountReportRows<T extends AccountReportRow>(
  rows: T[],
  accounts: Account[],
  options: { parentIds: number[]; levelMode: AccountLevelMode },
): T[] {
  const tree = accountReportTree(accounts);
  const included = tree.descendantsOf(options.parentIds);
  return rows.filter((row) => {
    if (included && !included.has(row.accountId)) return false;
    if (options.levelMode === "first" && tree.depthOf(row.accountId) !== 1) return false;
    if (options.levelMode === "last" && (tree.children.get(row.accountId)?.length ?? 0) > 0) return false;
    return true;
  });
}
