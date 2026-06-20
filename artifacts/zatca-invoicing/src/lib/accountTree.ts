/**
 * Account-hierarchy helpers for the General Accounts reports
 * (Trial Balance / Balance Sheet / Income Statement).
 *
 * The chart of accounts is a parent/child tree (`accounts.parent_id`).
 * The stored `accounts.level` column is unreliable after bulk imports
 * (it stays at the default for parented rows), so we ALWAYS derive the
 * level by walking the `parentId` chain instead of trusting the column.
 */

export interface AccountNode {
  id: number;
  code?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
  parentId?: number | null;
  accountType?: string | null;
}

export interface AccountTree {
  /** Every account indexed by id. */
  byId: Map<number, AccountNode>;
  /** Ids that are a parent of at least one other account. */
  parentIds: Set<number>;
  /** parentId → direct child ids. */
  childrenByParent: Map<number, number[]>;
  /** 1-based depth derived from the parent chain (root = 1). */
  levelOf: (id: number) => number;
  /** Deepest level present in the tree. */
  maxLevel: number;
  /** A leaf (posting) account = has no children. */
  isLeaf: (id: number) => boolean;
}

/** Build the lookup maps + memoised level/leaf accessors from a flat list. */
export function buildAccountTree(accounts: AccountNode[]): AccountTree {
  const byId = new Map<number, AccountNode>();
  const childrenByParent = new Map<number, number[]>();
  const parentIds = new Set<number>();

  for (const a of accounts) {
    if (a?.id == null) continue;
    byId.set(Number(a.id), a);
  }
  for (const a of accounts) {
    const pid = a?.parentId == null ? null : Number(a.parentId);
    if (pid != null && byId.has(pid)) {
      parentIds.add(pid);
      const arr = childrenByParent.get(pid) ?? [];
      arr.push(Number(a.id));
      childrenByParent.set(pid, arr);
    }
  }

  // Memoise level lookups; guard against cycles / orphaned parents.
  const levelCache = new Map<number, number>();
  const levelOf = (id: number): number => {
    const cached = levelCache.get(id);
    if (cached != null) return cached;
    let depth = 1;
    let cur = byId.get(id);
    const seen = new Set<number>([id]);
    while (cur && cur.parentId != null) {
      const pid = Number(cur.parentId);
      if (!byId.has(pid) || seen.has(pid) || depth > 50) break;
      seen.add(pid);
      depth += 1;
      cur = byId.get(pid);
    }
    levelCache.set(id, depth);
    return depth;
  };

  let maxLevel = 1;
  for (const id of byId.keys()) maxLevel = Math.max(maxLevel, levelOf(id));

  const isLeaf = (id: number) => !parentIds.has(id);

  return { byId, parentIds, childrenByParent, levelOf, maxLevel, isLeaf };
}

/**
 * Collect the ids of every selected parent PLUS all of its descendants
 * (children, grandchildren, …). The returned set always includes the
 * selected parent ids themselves so a report row sitting on the parent
 * account is kept too. Returns `null` when no parent is selected (caller
 * treats `null` as "no parent filter").
 */
export function descendantIds(
  tree: AccountTree,
  selectedParentIds: number[],
): Set<number> | null {
  if (!selectedParentIds.length) return null;
  const out = new Set<number>();
  const stack = [...selectedParentIds];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of tree.childrenByParent.get(id) ?? []) stack.push(child);
  }
  return out;
}

export type AccountLevelMode = "all" | "first" | "last";

/**
 * Predicate used by the reports to keep/drop a row based on the active
 * parent + level filters. Zero-balance filtering is handled separately by
 * each report (the balance fields differ per report).
 */
export function matchesAccountFilters(
  accountId: number,
  tree: AccountTree,
  opts: { parentDescendants: Set<number> | null; levelMode: AccountLevelMode },
): boolean {
  const { parentDescendants, levelMode } = opts;
  if (parentDescendants && !parentDescendants.has(accountId)) return false;
  if (levelMode === "first" && tree.levelOf(accountId) !== 1) return false;
  if (levelMode === "last" && !tree.isLeaf(accountId)) return false;
  return true;
}
