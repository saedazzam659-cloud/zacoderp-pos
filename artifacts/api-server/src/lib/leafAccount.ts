import { db } from "@workspace/db";
import { accountsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

export const PARENT_ACCOUNT_ERROR =
  "لا يمكن اختيار حساب رئيسي، يرجى اختيار حساب فرعي";

/**
 * Validates that every supplied accountId belongs to a leaf, postable
 * account in the given company. Throws an Error (with an Arabic message
 * suitable for direct display to the user) when any of the accounts is
 * a parent (has children) or is flagged as non-posting.
 *
 * Accepts a mix of numbers, strings, null and undefined so callers can
 * pass through raw form payloads without having to filter first.
 */
export async function ensureLeafAccounts(
  companyId: number,
  rawIds: Array<number | string | null | undefined>,
): Promise<void> {
  const ids = Array.from(
    new Set(
      rawIds
        .map((v) => (v == null || v === "" ? NaN : Number(v)))
        .filter((n) => Number.isFinite(n) && n > 0) as number[],
    ),
  );
  if (ids.length === 0) return;

  // 1. Load the requested accounts (scoped to the company).
  const rows = await db
    .select({
      id:        accountsTable.id,
      code:      accountsTable.code,
      nameAr:    accountsTable.nameAr,
      isPosting: accountsTable.isPosting,
    })
    .from(accountsTable)
    .where(and(eq(accountsTable.companyId, companyId), inArray(accountsTable.id, ids)));

  // 1b. Cross-tenant safety: every id supplied by the client MUST belong to
  // this company. If anything is missing, refuse the operation entirely
  // instead of silently letting it through.
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    throw new Error(`الحساب غير موجود لهذه الشركة: ${missing.join("، ")}`);
  }

  // 2. Find which of them are referenced as a parent by any other account.
  const childrenRows = await db
    .select({ parentId: accountsTable.parentId })
    .from(accountsTable)
    .where(and(eq(accountsTable.companyId, companyId), inArray(accountsTable.parentId, ids)));
  const parentIds = new Set<number>(
    childrenRows.map((c) => c.parentId).filter((v): v is number => v != null),
  );

  // 3. Anything that has children OR is flagged non-posting is invalid.
  const offending = rows.filter(
    (r) => parentIds.has(r.id) || r.isPosting === false,
  );
  if (offending.length === 0) return;

  const list = offending.map((o) => `${o.code} — ${o.nameAr}`).join("، ");
  throw new Error(`${PARENT_ACCOUNT_ERROR}. الحسابات: ${list}`);
}
