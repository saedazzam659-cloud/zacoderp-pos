import { db } from "@workspace/db";
import { accountsTable, accountingMappingsTable } from "@workspace/db";
import { and, eq, like, or } from "drizzle-orm";

type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

/**
 * Resolve the configured "parent" account for a given entity type.
 *
 * Resolution order:
 *   1. accounting_mappings row for documentType="entity_account_parents"
 *      and the given roleKey (set from the Account Mapping screen).
 *   2. Any company account whose code starts with one of fallbackCodePrefixes.
 *   3. Any company account whose Arabic/English name LIKE one of nameLikes.
 *
 * Returns the parent account row or null when nothing matches.
 */
async function resolveEntityParent(
  companyId: number,
  roleKeys: string[],
  fallbackCodePrefixes: string[],
  nameLikes: string[],
  accountType: AccountType,
) {
  // 1) explicit mapping — must match the expected accountType so an admin
  // who mis-mapped a parent to (say) an expense account doesn't end up with
  // an asset child under it.  When the type doesn't match we silently fall
  // through to the heuristic; a hard failure here would be worse since it
  // would block entity creation entirely.
  //
  // `roleKeys` is an ORDERED priority list: the category-specific parent
  // (e.g. supplier_foreign_account_parent) is tried first, then the generic
  // parent (supplier_account_parent) as a back-compat fallback. The first
  // role whose mapping resolves to a valid same-type account wins.
  for (const roleKey of roleKeys) {
    const [m] = await db.select().from(accountingMappingsTable).where(and(
      eq(accountingMappingsTable.companyId, companyId),
      eq(accountingMappingsTable.documentType, "entity_account_parents"),
      eq(accountingMappingsTable.roleKey, roleKey),
    ));
    if (m?.accountId) {
      const [acc] = await db.select().from(accountsTable).where(and(
        eq(accountsTable.id, m.accountId),
        eq(accountsTable.companyId, companyId), // tenant guard
        eq(accountsTable.accountType, accountType), // type guard
      ));
      if (acc) return acc;
    }
  }

  // 2/3) heuristic fallback — code prefixes then name like
  const conds: any[] = [];
  for (const p of fallbackCodePrefixes) conds.push(like(accountsTable.code, `${p}%`));
  for (const n of nameLikes) {
    conds.push(like(accountsTable.nameAr, `%${n}%`));
    conds.push(like(accountsTable.nameEn, `%${n}%`));
  }
  if (conds.length === 0) return null;

  const candidates = await db.select().from(accountsTable).where(and(
    eq(accountsTable.companyId, companyId),
    eq(accountsTable.accountType, accountType),
    or(...conds),
  ));
  if (candidates.length === 0) return null;

  // Prefer code-prefix matches in the order given.
  for (const p of fallbackCodePrefixes) {
    const hit = candidates.find(a => a.code?.startsWith(p));
    if (hit) return hit;
  }
  return candidates[0];
}

/**
 * Generate the next available sub-account code under `parent`.
 *
 * Strategy: if the parent code is purely numeric (e.g. "1102"), prefer a
 * concatenated numeric code ("11021", "11022", …). When the next slot would
 * collide with an existing sibling whose code uses a different scheme, we
 * fall back to the dashed pattern "<parentCode>-NNN" used by the older
 * customer/supplier flow so we never produce a duplicate.
 */
async function nextChildCode(companyId: number, parent: { id: number; code: string }): Promise<string> {
  const siblings = await db.select({ code: accountsTable.code })
    .from(accountsTable)
    .where(and(
      eq(accountsTable.companyId, companyId),
      eq(accountsTable.parentId, parent.id),
    ));
  const taken = new Set(siblings.map(s => (s.code ?? "").trim()));

  const parentCode = (parent.code ?? "").trim();
  const numericParent = /^\d+$/.test(parentCode);

  if (numericParent) {
    // Try concatenated numeric: 1102 → 11021..11029, then 110210, 110211, …
    let n = 1;
    while (n < 10_000) {
      const candidate = `${parentCode}${n}`;
      if (!taken.has(candidate)) return candidate;
      n++;
    }
  }

  // Dashed fallback ("<parent>-NNN") — find max existing N and add 1.
  const prefix = `${parentCode}-`;
  let maxSeq = 0;
  for (const c of taken) {
    if (c.startsWith(prefix)) {
      const n = parseInt(c.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  }
  return `${prefix}${String(maxSeq + 1).padStart(3, "0")}`;
}

/**
 * Ensure a posting sub-account exists for an entity (cashbox, bank,
 * customer, supplier, warehouse). Returns the new account id, or null
 * when no parent could be resolved (in which case the caller should
 * persist the entity with accountId=null and let the user pick later).
 *
 * Idempotency: if `entityName` already matches a sibling under the
 * resolved parent, that sibling is returned instead of creating a new
 * one — protects against double-clicks creating duplicate ledger
 * accounts.
 */
export async function ensureEntitySubAccount(args: {
  companyId: number;
  /**
   * Ordered priority list of entity_account_parents role keys. The first role
   * whose mapping resolves wins; later entries act as back-compat fallbacks
   * (e.g. ["supplier_foreign_account_parent", "supplier_account_parent"]).
   */
  roleKeys: string[];
  name: string;
  fallbackCodePrefixes: string[];
  nameLikes: string[];
  accountType: AccountType;
  /**
   * When true, ALWAYS mint a brand-new sub-account even if a same-name sibling
   * already exists — skips the idempotent reuse below. Used by the
   * allow-duplicates party import so that two establishments sharing one name
   * each get their OWN AR/AP ledger (their statements must not commingle).
   */
  forceNew?: boolean;
}): Promise<number | null> {
  const { companyId, roleKeys, name, fallbackCodePrefixes, nameLikes, accountType, forceNew = false } = args;
  const parent = await resolveEntityParent(companyId, roleKeys, fallbackCodePrefixes, nameLikes, accountType);
  if (!parent) return null;

  // Idempotency: same-name sibling under this parent (bypassed when forceNew)
  if (!forceNew) {
    const siblings = await db.select().from(accountsTable).where(and(
      eq(accountsTable.companyId, companyId),
      eq(accountsTable.parentId, parent.id),
    ));
    const trimmed = name.trim().toLowerCase();
    const dup = siblings.find(s => (s.nameAr ?? "").trim().toLowerCase() === trimmed);
    if (dup) return dup.id;
  }

  // Retry loop guards against the inherent race in nextChildCode: two
  // concurrent POSTs can read the same sibling list and try to insert
  // identical codes.  Postgres' unique index on (company_id, code) will
  // reject the loser; we re-read the siblings and try again.  We cap at
  // 5 attempts so a real bug can't hot-loop forever.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = await nextChildCode(companyId, parent);
    try {
      const [created] = await db.insert(accountsTable).values({
        companyId,
        parentId: parent.id,
        code,
        nameAr: name,
        accountType,
        reportDirection: parent.reportDirection ?? null,
        level: (parent.level ?? 1) + 1,
        isPosting: true,
        isActive: true,
      }).returning();

      // Promote the parent to non-posting if it currently is — sub-accounts
      // make the parent a roll-up node.
      if (parent.isPosting) {
        await db.update(accountsTable).set({ isPosting: false }).where(eq(accountsTable.id, parent.id));
      }
      return created?.id ?? null;
    } catch (err: any) {
      // Postgres unique-violation = "23505".  Anything else bubbles up.
      const isUnique = err?.code === "23505" || /duplicate key|unique constraint/i.test(String(err?.message ?? ""));
      if (!isUnique) throw err;
      // loop again — nextChildCode will pick the next free slot
    }
  }
  return null;
}

// ── Convenience wrappers used by the entity POST routes ─────────────────────

export const ensureCashBoxAccount = (companyId: number, name: string) =>
  ensureEntitySubAccount({
    companyId, roleKeys: ["cash_account_parent"], name,
    fallbackCodePrefixes: ["1101", "1110", "111"],
    nameLikes: ["نقد", "خزين", "خزن", "صندوق", "cash"],
    accountType: "asset",
  });

export const ensureBankAccountLedger = (companyId: number, name: string) =>
  ensureEntitySubAccount({
    companyId, roleKeys: ["bank_account_parent"], name,
    fallbackCodePrefixes: ["1102", "1130", "112"],
    nameLikes: ["بنك", "bank"],
    accountType: "asset",
  });

/** Customer commercial category → which parent account the auto-created
 *  AR sub-account nests under. `local` = عملاء محليون, `export` = عملاء تصدير.
 *  Undefined keeps the legacy single-parent behavior. */
export type CustomerCategory = "local" | "export";
export type SupplierCategory = "local" | "foreign";

export const ensureCustomerLedger = (
  companyId: number,
  name: string,
  forceNew = false,
  category?: CustomerCategory,
) =>
  ensureEntitySubAccount({
    companyId,
    // Category-specific parent first, generic parent as fallback.
    roleKeys: category === "export"
      ? ["customer_export_account_parent", "customer_account_parent"]
      : category === "local"
      ? ["customer_local_account_parent", "customer_account_parent"]
      : ["customer_account_parent"],
    name,
    fallbackCodePrefixes: ["1103", "1130", "121"],
    nameLikes: ["عملاء", "ذمم مدين", "مدين", "customer", "receiv"],
    accountType: "asset",
    forceNew,
  });

export const ensureSupplierLedger = (
  companyId: number,
  name: string,
  category?: SupplierCategory,
) =>
  ensureEntitySubAccount({
    companyId,
    // Category-specific parent first, generic parent as fallback.
    roleKeys: category === "foreign"
      ? ["supplier_foreign_account_parent", "supplier_account_parent"]
      : category === "local"
      ? ["supplier_local_account_parent", "supplier_account_parent"]
      : ["supplier_account_parent"],
    name,
    fallbackCodePrefixes: ["2101", "2110", "211"],
    nameLikes: ["موردين", "ذمم دائن", "دائن", "supplier", "payab"],
    accountType: "liability",
  });

export const ensureWarehouseAccount = (companyId: number, name: string) =>
  ensureEntitySubAccount({
    companyId, roleKeys: ["warehouse_account_parent"], name,
    fallbackCodePrefixes: ["1105", "1220", "112"],
    nameLikes: ["مخزون", "مخزن", "بضاعة", "inventory", "stock", "warehouse"],
    accountType: "asset",
  });
