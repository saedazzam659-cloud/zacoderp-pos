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

  // Pass 1 — EXACT group-node code match, in the order given. `like '21011%'`
  // also matches that group's own children (2101101…) and `like '2101%'`
  // matches the whole subtree, so a prefix hit that is not the group node
  // itself may be a LEAF account — nesting a new supplier under a leaf is
  // semantically wrong. Only an exact code match is trusted here.
  for (const p of fallbackCodePrefixes) {
    const exact = candidates.find(a => (a.code ?? "").trim() === p);
    if (exact) return exact;
  }
  // Pass 2 — name-like matches in the order given (category-specific names
  // come first in the list, generic ones last), shortest code wins ties.
  for (const n of nameLikes) {
    const hits = candidates
      .filter(a => (a.nameAr ?? "").includes(n) || (a.nameEn ?? "").toLowerCase().includes(n.toLowerCase()))
      .sort((a, b) => (a.code ?? "").length - (b.code ?? "").length);
    if (hits.length > 0) return hits[0]!;
  }
  // Pass 3 — last resort for non-standard COAs with neither the standard
  // group codes nor recognizable names: shortest code among prefix hits
  // (legacy behavior; better than failing outright).
  for (const p of fallbackCodePrefixes) {
    const hits = candidates
      .filter(a => a.code?.startsWith(p))
      .sort((a, b) => (a.code ?? "").length - (b.code ?? "").length);
    if (hits.length > 0) return hits[0]!;
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
export function computeNextChildCode(parentCodeRaw: string, taken: Set<string>): string {
  const parentCode = (parentCodeRaw ?? "").trim();
  const numericParent = /^\d+$/.test(parentCode);

  if (numericParent) {
    // 1) Continue the DOMINANT existing numeric scheme first. COA imports
    //    typically create zero-padded children (21011 → 2101101..2101116);
    //    the old "parentCode + n" probe would mint "210111" (unpadded, off
    //    by a digit) next to them, which reads as a totally different
    //    account. Instead: among numeric siblings extending the parent
    //    code, find the most common suffix width, take max+1 at that
    //    width (padding preserved; width may grow past 99 → 100).
    const numericSibs = [...taken].filter(c =>
      /^\d+$/.test(c) && c.startsWith(parentCode) && c.length > parentCode.length,
    );
    if (numericSibs.length > 0) {
      const widthCount = new Map<number, number>();
      for (const c of numericSibs) {
        const w = c.length - parentCode.length;
        widthCount.set(w, (widthCount.get(w) ?? 0) + 1);
      }
      // Most common width wins; ties break toward the WIDER (newer) scheme.
      const width = [...widthCount.entries()]
        .sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
      let max = 0;
      for (const c of numericSibs) {
        if (c.length - parentCode.length !== width) continue;
        const n = parseInt(c.slice(parentCode.length), 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
      for (let n = max + 1; n <= max + 10_000; n++) {
        const candidate = `${parentCode}${String(n).padStart(width, "0")}`;
        if (!taken.has(candidate)) return candidate;
      }
    }

    // 2) No numeric children yet — legacy concatenated probe: 1102 → 11021…
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

async function siblingCodes(companyId: number, parentId: number): Promise<Set<string>> {
  const siblings = await db.select({ code: accountsTable.code })
    .from(accountsTable)
    .where(and(
      eq(accountsTable.companyId, companyId),
      eq(accountsTable.parentId, parentId),
    ));
  return new Set(siblings.map(s => (s.code ?? "").trim()).filter(Boolean));
}

async function nextChildCode(companyId: number, parent: { id: number; code: string }): Promise<string> {
  const taken = await siblingCodes(companyId, parent.id);
  return computeNextChildCode(parent.code, taken);
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
  return mintChildUnderParent(companyId, parent, name, accountType, forceNew);
}

/**
 * Create (or idempotently reuse) a child posting account under an ALREADY
 * RESOLVED parent row. Shared by ensureEntitySubAccount (heuristic parent)
 * and the explicit-parent supplier flow so numbering/idempotency/races are
 * handled identically in both.
 */
async function mintChildUnderParent(
  companyId: number,
  parent: typeof accountsTable.$inferSelect,
  name: string,
  accountType: AccountType,
  forceNew = false,
): Promise<number | null> {
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

// Shared between ensureSupplierLedger (creation) and peekSupplierNextAccount
// (preview) so the previewed code can NEVER diverge from the minted one.
const supplierRoleKeys = (category?: SupplierCategory): string[] =>
  category === "foreign"
    ? ["supplier_foreign_account_parent", "supplier_account_parent"]
    : category === "local"
    ? ["supplier_local_account_parent", "supplier_account_parent"]
    : ["supplier_account_parent"];
// Category-specific prefixes/names FIRST (21011 محليون / 21012 خارجيون-أجانب),
// generic supplier fallbacks LAST — resolveEntityParent honors this order, so
// a company with the standard COA nests locals under 21011 and foreigners
// under 21012 instead of both landing on the generic 2101 group.
const SUPPLIER_CODE_PREFIXES = (category?: SupplierCategory): string[] =>
  category === "foreign" ? ["21012", "2101", "2110", "211"]
  : category === "local" ? ["21011", "2101", "2110", "211"]
  : ["2101", "2110", "211"];
const SUPPLIER_NAME_LIKES = (category?: SupplierCategory): string[] =>
  category === "foreign"
    ? ["موردون خارجي", "موردين خارجي", "خارجي", "أجانب", "اجانب", "أجنبي", "اجنبي", "foreign", "موردين", "ذمم دائن", "دائن", "supplier", "payab"]
  : category === "local"
    ? ["موردون محلي", "موردين محلي", "محلي", "local", "موردين", "ذمم دائن", "دائن", "supplier", "payab"]
  : ["موردين", "ذمم دائن", "دائن", "supplier", "payab"];

export const ensureSupplierLedger = (
  companyId: number,
  name: string,
  category?: SupplierCategory,
) =>
  ensureEntitySubAccount({
    companyId,
    // Category-specific parent first, generic parent as fallback.
    roleKeys: supplierRoleKeys(category),
    name,
    fallbackCodePrefixes: SUPPLIER_CODE_PREFIXES(category),
    nameLikes: SUPPLIER_NAME_LIKES(category),
    accountType: "liability",
  });

/** Fetch + validate an EXPLICITLY user-picked parent for the supplier AP
 *  sub-account: must belong to the company and be a liability account. */
async function resolveExplicitSupplierParent(companyId: number, parentId: number) {
  const [parent] = await db.select().from(accountsTable).where(and(
    eq(accountsTable.id, parentId),
    eq(accountsTable.companyId, companyId), // tenant guard
    eq(accountsTable.accountType, "liability"), // never nest AP under a non-liability
  ));
  return parent ?? null;
}

/** Create the supplier AP sub-account under an EXPLICIT parent picked by the
 *  user in the form (بديل سهل عن الاستنتاج التلقائي). Same minting path. */
export async function ensureSupplierLedgerUnderParent(
  companyId: number,
  name: string,
  parentId: number,
): Promise<number | null> {
  const parent = await resolveExplicitSupplierParent(companyId, parentId);
  if (!parent) return null;
  return mintChildUnderParent(companyId, parent, name, "liability");
}

/**
 * Preview (read-only, nothing created) which parent the auto-minted supplier
 * AP sub-account would nest under for the given category, the LAST code
 * already used there, and the NEXT code that would be assigned. Powers the
 * "آخر حساب / الحساب التالي" hint on the supplier create forms.
 */
export async function peekSupplierNextAccount(companyId: number, category?: SupplierCategory) {
  const parent = await resolveEntityParent(
    companyId, supplierRoleKeys(category), SUPPLIER_CODE_PREFIXES(category), SUPPLIER_NAME_LIKES(category), "liability",
  );
  if (!parent) return null;
  return buildSupplierPeek(companyId, parent);
}

/** Same preview but under an EXPLICIT user-picked parent account —
 *  mirrors ensureSupplierLedgerUnderParent so hint and save can't diverge. */
export async function peekSupplierNextAccountUnderParent(companyId: number, parentId: number) {
  const parent = await resolveExplicitSupplierParent(companyId, parentId);
  if (!parent) return null;
  return buildSupplierPeek(companyId, parent);
}

async function buildSupplierPeek(companyId: number, parent: typeof accountsTable.$inferSelect) {
  const taken = await siblingCodes(companyId, parent.id);
  const nextCode = computeNextChildCode(parent.code ?? "", taken);

  // "Last used" = numerically-highest numeric sibling (matches how users read
  // the COA tree); falls back to lexicographic max for non-numeric schemes.
  const codes = [...taken];
  const numeric = codes.filter(c => /^\d+$/.test(c));
  const lastCode = numeric.length > 0
    ? numeric.reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a))
    : (codes.sort().at(-1) ?? null);

  return {
    parentId: parent.id,
    parentCode: parent.code ?? null,
    parentName: parent.nameAr ?? parent.nameEn ?? null,
    lastCode,
    nextCode,
    childCount: taken.size,
  };
}

// ── Item-group (فئات الأصناف) accounting routing ────────────────────────────
// The category's default account is auto-minted under an EXPLICIT user-picked
// parent, supplier-style (last child 111002 → mint 111003). Allowed parent
// account types depend on the category type.
export type ItemGroupCategoryType = "inventory" | "fixed_asset" | "expense";

export const ITEM_GROUP_PARENT_TYPES: Record<ItemGroupCategoryType, AccountType[]> = {
  inventory:   ["asset"],
  fixed_asset: ["asset"],
  expense:     ["expense"],
};

async function resolveExplicitGroupParent(
  companyId: number,
  parentId: number,
  categoryType: ItemGroupCategoryType,
) {
  const [parent] = await db.select().from(accountsTable).where(and(
    eq(accountsTable.id, parentId),
    eq(accountsTable.companyId, companyId), // tenant guard
  ));
  if (!parent) return null;
  const allowed = ITEM_GROUP_PARENT_TYPES[categoryType];
  if (!allowed.includes(parent.accountType as AccountType)) return null;
  return parent;
}

/** Mint (or idempotently reuse) the category's default sub-account under the
 *  explicit parent. Same minting path as suppliers → peek never diverges. */
export async function ensureItemGroupAccountUnderParent(
  companyId: number,
  name: string,
  parentId: number,
  categoryType: ItemGroupCategoryType,
): Promise<number | null> {
  const parent = await resolveExplicitGroupParent(companyId, parentId, categoryType);
  if (!parent) return null;
  return mintChildUnderParent(companyId, parent, name, parent.accountType as AccountType);
}

/** Read-only preview of last/next child code under the picked parent —
 *  mirrors ensureItemGroupAccountUnderParent so hint and save can't diverge. */
export async function peekItemGroupNextAccountUnderParent(
  companyId: number,
  parentId: number,
  categoryType: ItemGroupCategoryType,
) {
  const parent = await resolveExplicitGroupParent(companyId, parentId, categoryType);
  if (!parent) return null;
  return buildSupplierPeek(companyId, parent);
}

// ── وضع "بدون اختيار" (auto): حلّ الحساب الأب الافتراضي حسب نوع الفئة ──
// mapping screen role key first, then standard code prefixes, then names.
const GROUP_AUTO_PARENT_RULES: Record<ItemGroupCategoryType, {
  roleKeys: string[]; prefixes: string[]; nameLikes: string[]; accountType: AccountType;
}> = {
  inventory: {
    roleKeys: ["item_group_inventory_parent", "warehouse_account_parent"],
    prefixes: ["1105", "1220", "112", "1300", "13"],
    nameLikes: ["مخزون", "مخزن", "بضاعة", "inventory", "stock"],
    accountType: "asset",
  },
  fixed_asset: {
    roleKeys: ["item_group_fixed_asset_parent", "fixed_asset_account_parent"],
    prefixes: ["1201", "121", "12"],
    nameLikes: ["أصول ثابتة", "الأصول الثابتة", "اصول ثابتة", "fixed asset"],
    accountType: "asset",
  },
  expense: {
    roleKeys: ["item_group_expense_parent"],
    prefixes: ["5100", "51", "5"],
    nameLikes: ["مصروفات", "مصاريف", "expense"],
    accountType: "expense",
  },
};

async function resolveDefaultGroupParent(companyId: number, categoryType: ItemGroupCategoryType) {
  const r = GROUP_AUTO_PARENT_RULES[categoryType];
  return resolveEntityParent(companyId, r.roleKeys, r.prefixes, r.nameLikes, r.accountType);
}

/** Auto mode (no explicit pick): mint the category sub-account under the
 *  default parent resolved for the category type. */
export async function ensureItemGroupAccountAuto(
  companyId: number,
  name: string,
  categoryType: ItemGroupCategoryType,
): Promise<number | null> {
  const parent = await resolveDefaultGroupParent(companyId, categoryType);
  if (!parent) return null;
  return mintChildUnderParent(companyId, parent, name, parent.accountType as AccountType);
}

/** Peek for the auto mode — mirrors ensureItemGroupAccountAuto. */
export async function peekItemGroupNextAccountAuto(companyId: number, categoryType: ItemGroupCategoryType) {
  const parent = await resolveDefaultGroupParent(companyId, categoryType);
  if (!parent) return null;
  return buildSupplierPeek(companyId, parent);
}

export const ensureWarehouseAccount = (companyId: number, name: string) =>
  ensureEntitySubAccount({
    companyId, roleKeys: ["warehouse_account_parent"], name,
    fallbackCodePrefixes: ["1105", "1220", "112"],
    nameLikes: ["مخزون", "مخزن", "بضاعة", "inventory", "stock", "warehouse"],
    accountType: "asset",
  });
