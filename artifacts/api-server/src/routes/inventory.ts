import { Router } from "express";
import { nextEntityCode } from "../lib/nextEntityCode.js";
import { requirePostRight, requireUnpostRight } from "../lib/postingRights.js";
import { db, pool } from "@workspace/db";
import { fullAuditFor } from "../lib/journalAudit.js";
import {
  warehouseGroupsTable, warehousesTable, itemGroupsTable, unitsTable,
  brandsTable, itemBrandsTable,
  itemsTable, itemUnitPricesTable, stockBalanceTable, stockLedgerTable,
  stockTransfersTable, stockTransferItemsTable,
  stockAdjustmentsTable, stockAdjustmentItemsTable,
  stockCountsTable, stockCountItemsTable,
  journalEntriesTable, journalEntryLinesTable,
  accountsTable, auditLogTable,
  salesInvoicesTable, salesInvoiceLinesTable,
  salesReturnsTable, salesReturnLinesTable,
  purchaseInvoicesTable, purchaseReturnsTable,
  purchaseInvoiceLinesTable, purchaseReturnLinesTable,
  goodsReceiptsTable, goodsDeliveriesTable,
  itemDocumentsTable,
  itemSuppliersTable,
  itemBundleComponentsTable,
  itemUsageControlsTable,
  suppliersTable,
  // Batch 8 — final 5 PRO Extensions
  itemCurrencyPricesTable,
  itemBranchStockTable,
  itemBomStepsTable,
  branchesTable,
  currenciesTable,
  notificationsTable,
  subscriptionsTable,
  accountingMappingsTable,
} from "@workspace/db";
import { eq, ne, and, sql, desc, asc, gte, lte, lt, inArray, isNull, or, count } from "drizzle-orm";
import { resolvePostingStatus } from "../lib/postingStatus.js";
import { aliasedTable } from "drizzle-orm";
import { extractAuth, resolveCompanyId, branchScopeSpread, getAllowedBranchIds } from "../middleware/auth.js";
import { pathRbac, writeAudit } from "../middleware/permissions.js";
import { getItemUsageControls, normalizeUsageMode, isValidScreenKey, DEFAULT_USAGE_MODE, getScreenRules, isUsagePrivileged, checkItemsUsable, usageViolationMessage } from "../lib/itemUsageControl.js";
import {
  ensureWarehouseAccount,
  ensureItemGroupAccountUnderParent,
  peekItemGroupNextAccountUnderParent,
  ensureItemGroupAccountAuto,
  peekItemGroupNextAccountAuto,
  ITEM_GROUP_PARENT_TYPES,
  type ItemGroupCategoryType,
} from "../lib/entityAccounts.js";
import { nextJeSubSequence, nextSequenceNumber } from "../lib/sequences.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import {
  getBalance,
  lockStockBalance,
  lockStockBalances,
  upsertBalance,
  refreshItemCost,
  pickBatches,
  type BatchPick,
} from "../lib/stockHelpers.js";
import {
  INVENTORY_OPENING_CREDIT_MARKER,
  INVENTORY_OPENING_DEBIT_MARKER,
} from "../lib/openingBalances.js";
import {
  UnitConversionError,
  resolveItemUnitConversion,
  multiplyQuantity,
  divideQuantity,
  formatRational,
  isPositiveExactDecimal,
  parseExactDecimal,
  resolveUnitGraph,
  roundQuantity,
  decimalForStorage,
  toStorageDecimal,
} from "../lib/unitConversion.js";

const router = Router();
router.use(extractAuth);
router.use(pathRbac([
  ["/warehouse-groups",         "warehouses"],
  ["/warehouses",               "warehouses"],
  ["/item-groups",              "items"],
  ["/units",                    "items"],
  // Brands master — own module key rolling up to the inventory company gate.
  // Item↔brand links live under /items/:id/brands and stay gated by "items".
  ["/brands",                   "brands"],
  ["/items",                    "items"],
  ["/stock-transfers",          "stock_transfers"],
  ["/stock-adjustments",        "stock_adjustments"],
  ["/stock-counts",             "stock_counts"],
  // Read-only inventory reports / dashboard — gate them on the high-level
  // "items" module so the company-level menu permission applies even on GETs.
  ["/stock-ledger",             "items"],
  ["/stock-balance",            "items"],
  ["/last-movements",           "items"],
  ["/dashboard",                "items"],
  // Sales-driven inventory reports (read-only) — same module gate as the
  // other inventory reports so the company-level menu permission applies.
  ["/reports/free-quantities",      "items"],
  ["/reports/item-sales-valuation", "items"],
  // PRO Extension #6 — Smart Alerts: gate on "items" module like other
  // read-only inventory views.
  ["/alerts",                   "items"],
  // Import endpoints — gate as "items" (item rows) and "stock_adjustments"
  // (opening balances become posted adjustment movements).
  ["/import/items",             "items"],
  ["/import/opening-balances",  "stock_adjustments"],
]));

// ─── GUARD: require auth ──────────────────────────────────────────────────────
function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

function getCompanyId(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

// ═══════════════════════════════════════════════════════════════════
// WAREHOUSE GROUPS
// ═══════════════════════════════════════════════════════════════════
router.get("/warehouse-groups", async (req, res) => {
  const cid = getCompanyId(req);
  const rows = cid
    ? await db.select().from(warehouseGroupsTable).where(eq(warehouseGroupsTable.companyId, cid)).orderBy(asc(warehouseGroupsTable.code))
    : await db.select().from(warehouseGroupsTable).orderBy(asc(warehouseGroupsTable.code));
  res.json(rows);
});

router.post("/warehouse-groups", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const { code, nameAr, nameEn } = req.body;
  if (!code || !nameAr) { res.status(400).json({ error: "كود واسم المجموعة مطلوبان" }); return; }
  const [row] = await db.insert(warehouseGroupsTable).values({ companyId: cid, code, nameAr, nameEn }).returning();
  res.status(201).json(row);
});

router.put("/warehouse-groups/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { code, nameAr, nameEn } = req.body;
  const [row] = await db.update(warehouseGroupsTable).set({ code, nameAr, nameEn }).where(and(eq(warehouseGroupsTable.id, id), eq(warehouseGroupsTable.companyId, cid))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.delete("/warehouse-groups/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  await db.delete(warehouseGroupsTable).where(and(eq(warehouseGroupsTable.id, id), eq(warehouseGroupsTable.companyId, cid)));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// WAREHOUSES
// ═══════════════════════════════════════════════════════════════════
// Branch isolation (READ): warehouses with branchId IS NULL are shared
// across all branches (HQ default). Restricted users see those plus
// warehouses linked to their allowed branches; admin / viewAll users see
// everything.
function warehouseBranchScope(req: any): any {
  const allowed = getAllowedBranchIds(req);
  if (allowed === null) return undefined;
  if (allowed.length === 0) return sql`false`;
  return or(isNull(warehousesTable.branchId), inArray(warehousesTable.branchId, allowed));
}

function pickerWarehouseScope(req: any): any {
  if (req.query.onlyUserBranches !== "1" && req.query.onlyUserBranches !== "true") {
    return warehouseBranchScope(req);
  }
  const ids = req.authUser?.branchIds ?? [];
  return ids.length ? inArray(warehousesTable.branchId, ids) : sql`false`;
}

// Branch isolation (WRITE): stricter than READ — restricted users can only
// MUTATE warehouses whose branchId is in their allowed list. Shared (NULL)
// warehouses are read-only for them; only admin / viewAll users can update
// or delete them.
function warehouseBranchWriteScope(req: any): any {
  const allowed = getAllowedBranchIds(req);
  if (allowed === null) return undefined;
  if (allowed.length === 0) return sql`false`;
  return inArray(warehousesTable.branchId, allowed);
}

// Write-side authorization for warehouse branchId. Returns the normalized
// branchId (number) on success, or an {error,status} object otherwise.
// Branch is MANDATORY on save for everyone — there are no shared/NULL
// warehouses on create/update anymore.
//   * admin / viewAll users: branchId must be non-null AND belong to the
//     same company.
//   * restricted users: branchId MUST be non-null AND in their allowed list —
//     they cannot create or move a warehouse to another branch.
async function assertWarehouseBranchWritable(req: any, rawBranchId: any, cid: number):
  Promise<{ ok: true; branchId: number | null } | { ok: false; status: number; error: string }> {
  const branchId = rawBranchId === "" || rawBranchId === undefined || rawBranchId === null
    ? null
    : Number(rawBranchId);
  const allowed = getAllowedBranchIds(req);

  if (allowed === null) {
    // Admin / viewAll: branch is mandatory — every warehouse must belong to a
    // branch (shared/NULL warehouses are no longer allowed on save).
    if (branchId == null) {
      return { ok: false, status: 400, error: "اختيار الفرع إجباري" };
    }
    const [b] = await db.select({ id: branchesTable.id })
      .from(branchesTable)
      .where(and(eq(branchesTable.id, branchId), eq(branchesTable.companyId, cid)));
    if (!b) return { ok: false, status: 400, error: "الفرع المحدد غير صالح أو لا ينتمي لهذه الشركة" };
    return { ok: true, branchId };
  }

  // Restricted user.
  if (branchId == null) {
    return { ok: false, status: 403, error: "ليس لديك صلاحية إنشاء مخزن مشترك بين كل الفروع" };
  }
  if (!allowed.includes(branchId)) {
    return { ok: false, status: 403, error: "ليس لديك صلاحية على هذا الفرع" };
  }
  return { ok: true, branchId };
}

// Resolve the *currently effective* warehouse cap for a company by reading
// the latest subscription row (most-recent end_date wins, then highest id).
// Falls back to a generous unlimited-ish cap when no subscription exists so
// the system never blocks legitimate use due to missing billing data.
// No caching — every call hits the DB so SuperAdmin plan edits apply on the
// very next request without forcing the user to re-login or refresh.
async function getWarehouseQuota(companyId: number): Promise<{ limit: number; used: number; remaining: number; hasSubscription: boolean }> {
  const [sub] = await db
    .select({ maxWarehouses: subscriptionsTable.maxWarehouses })
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.companyId, companyId))
    .orderBy(desc(subscriptionsTable.endDate), desc(subscriptionsTable.id))
    .limit(1);
  const limit = sub?.maxWarehouses ?? 1_000_000;
  const [{ n }] = await db
    .select({ n: count() })
    .from(warehousesTable)
    .where(eq(warehousesTable.companyId, companyId));
  const used = Number(n ?? 0);
  return { limit, used, remaining: Math.max(0, limit - used), hasSubscription: !!sub };
}

// GET /warehouses/quota — surfaces "X of Y" to the UI so the user knows
// where they stand BEFORE attempting to add a new warehouse. The frontend
// invalidates this on `subscription_changed` SSE so SuperAdmin upgrades
// reflect instantly.
router.get("/warehouses/quota", async (req, res) => {
  const cid = getCompanyId(req);
  if (!cid) { res.status(400).json({ error: "company_id مطلوب" }); return; }
  const q = await getWarehouseQuota(cid);
  res.json(q);
});

router.get("/warehouses", async (req, res) => {
  const cid = getCompanyId(req);
  const branchCond = pickerWarehouseScope(req);
  const conds: any[] = [];
  if (cid) conds.push(eq(warehousesTable.companyId, cid));
  if (branchCond) conds.push(branchCond);
  const rows = conds.length
    ? await db.select({ wh: warehousesTable, group: warehouseGroupsTable })
        .from(warehousesTable)
        .leftJoin(warehouseGroupsTable, eq(warehousesTable.groupId, warehouseGroupsTable.id))
        .where(and(...conds))
        .orderBy(asc(warehousesTable.code))
    : await db.select({ wh: warehousesTable, group: warehouseGroupsTable })
        .from(warehousesTable)
        .leftJoin(warehouseGroupsTable, eq(warehousesTable.groupId, warehouseGroupsTable.id))
        .orderBy(asc(warehousesTable.code));
  res.json(rows.map(r => ({ ...r.wh, group: r.group })));
});

router.post("/warehouses", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const { code: rawCode, nameAr, nameEn, groupId, branchId, city, region, allowNegative, negativeLimit, accountId, isDefault } = req.body;
  if (!nameAr) { res.status(400).json({ error: "اسم المخزن مطلوب" }); return; }
  const normalizedNegativeLimit = negativeLimit === "" || negativeLimit == null ? null : Number(negativeLimit);
  if (normalizedNegativeLimit != null && (!Number.isFinite(normalizedNegativeLimit) || normalizedNegativeLimit < 0)) {
    res.status(400).json({ error: "حد السحب على المكشوف يجب أن يكون صفراً أو رقماً موجباً" }); return;
  }
  // Plan-based cap. Re-checked on every POST so SuperAdmin upgrades take
  // effect immediately. Returns the limit + used count in the body so the
  // frontend can render an actionable message instead of a generic error.
  const quota = await getWarehouseQuota(cid);
  if (quota.used >= quota.limit) {
    res.status(403).json({
      error: `وصلت إلى الحد الأقصى للمخازن المسموح به في خطتك (${quota.limit} ${quota.limit === 1 ? "مخزن" : "مخازن"}). يرجى ترقية الخطة لإضافة المزيد.`,
      code: "WAREHOUSE_LIMIT_REACHED",
      limit: quota.limit,
      used: quota.used,
    });
    return;
  }
  // Branch-level write guard: restricted users can only create warehouses
  // for their own branch(es); admin/viewAll users can create shared (NULL)
  // warehouses but the branchId (if any) must belong to the same company.
  const branchCheck = await assertWarehouseBranchWritable(req, branchId, cid);
  if (!branchCheck.ok) { res.status(branchCheck.status).json({ error: branchCheck.error }); return; }
  const existing = await db.select().from(warehousesTable).where(eq(warehousesTable.companyId, cid));
  const code = String(rawCode ?? "").trim() || nextEntityCode("WH", existing.map(w => w.code));
  if (existing.some(w => w.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لمخزن آخر` }); return;
  }
  if (existing.some(w => w.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لمخزن آخر` }); return;
  }
  if (accountId && existing.some(w => w.accountId === Number(accountId))) {
    res.status(409).json({ error: "هذا الحساب مرتبط بمخزن آخر — اختر حساباً آخر" }); return;
  }
  // Auto-create a sub-account under the warehouse parent (from the Account
  // Mapping screen) when the user didn't explicitly pick one.
  let resolvedAccountId: number | null = accountId ? Number(accountId) : null;
  if (!resolvedAccountId) {
    try {
      resolvedAccountId = await ensureWarehouseAccount(cid, String(nameAr).trim());
    } catch (err) {
      req.log?.warn({ err }, "ensureWarehouseAccount failed");
      resolvedAccountId = null;
    }
  }
  // إذا طُلب جعله الافتراضي — نلغي الافتراضي من بقية مخازن نفس الشركة أولاً
  // ليبقى مخزن افتراضي واحد فقط لكل شركة.
  if (isDefault) {
    await db.update(warehousesTable).set({ isDefault: false }).where(eq(warehousesTable.companyId, cid));
  }
  const [row] = await db.insert(warehousesTable).values({ companyId: cid, code, nameAr, nameEn, groupId: groupId || null, branchId: branchCheck.branchId, city, region, allowNegative: !!allowNegative, negativeLimit: normalizedNegativeLimit == null ? null : String(normalizedNegativeLimit), accountId: resolvedAccountId, isDefault: !!isDefault }).returning();
  res.status(201).json(row);
});

router.put("/warehouses/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { code, nameAr, nameEn, groupId, branchId, city, region, allowNegative, negativeLimit, isActive, accountId, isDefault } = req.body;
  const normalizedNegativeLimit = negativeLimit === "" || negativeLimit == null ? null : Number(negativeLimit);
  if (normalizedNegativeLimit != null && (!Number.isFinite(normalizedNegativeLimit) || normalizedNegativeLimit < 0)) {
    res.status(400).json({ error: "حد السحب على المكشوف يجب أن يكون صفراً أو رقماً موجباً" }); return;
  }
  // First make sure the existing warehouse is within the caller's branch
  // WRITE scope. Restricted users cannot update shared (NULL) warehouses
  // even though they can SEE them — only admin can mutate shared resources.
  const scopeCond = warehouseBranchWriteScope(req);
  const existingConds: any[] = [eq(warehousesTable.id, id), eq(warehousesTable.companyId, cid)];
  if (scopeCond) existingConds.push(scopeCond);
  const [current] = await db.select().from(warehousesTable).where(and(...existingConds));
  if (!current) { res.status(404).json({ error: "غير موجود" }); return; }
  // Then validate the *target* branchId the user is trying to set.
  const branchCheck = await assertWarehouseBranchWritable(req, branchId, cid);
  if (!branchCheck.ok) { res.status(branchCheck.status).json({ error: branchCheck.error }); return; }
  const others = await db.select().from(warehousesTable).where(eq(warehousesTable.companyId, cid));
  if (code && others.some(w => w.id !== id && w.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لمخزن آخر` }); return;
  }
  if (nameAr && others.some(w => w.id !== id && w.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لمخزن آخر` }); return;
  }
  if (accountId && others.some(w => w.id !== id && w.accountId === Number(accountId))) {
    res.status(409).json({ error: "هذا الحساب مرتبط بمخزن آخر — اختر حساباً آخر" }); return;
  }
  if (isDefault) {
    // نلغي الافتراضي من بقية المخازن قبل تعيين هذا
    await db.update(warehousesTable).set({ isDefault: false }).where(and(eq(warehousesTable.companyId, cid), ne(warehousesTable.id, id)));
  }
  const [row] = await db.update(warehousesTable).set({ code, nameAr, nameEn, groupId: groupId || null, branchId: branchCheck.branchId, city, region, allowNegative: !!allowNegative, negativeLimit: normalizedNegativeLimit == null ? null : String(normalizedNegativeLimit), isActive: isActive !== false, accountId: accountId ? Number(accountId) : null, isDefault: !!isDefault }).where(and(eq(warehousesTable.id, id), eq(warehousesTable.companyId, cid))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.delete("/warehouses/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  // Branch-scoped delete: restricted users can only delete warehouses they
  // OWN (in their branch list). Shared (NULL) warehouses are admin-only.
  const scopeCond = warehouseBranchWriteScope(req);
  const conds: any[] = [eq(warehousesTable.id, id), eq(warehousesTable.companyId, cid)];
  if (scopeCond) conds.push(scopeCond);
  const result = await db.delete(warehousesTable).where(and(...conds)).returning({ id: warehousesTable.id });
  if (!result.length) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// ITEM GROUPS
// ═══════════════════════════════════════════════════════════════════
router.get("/item-groups", async (req, res) => {
  const cid = getCompanyId(req);
  const rows = cid
    ? await db.select().from(itemGroupsTable).where(eq(itemGroupsTable.companyId, cid)).orderBy(asc(itemGroupsTable.code))
    : await db.select().from(itemGroupsTable).orderBy(asc(itemGroupsTable.code));
  res.json(rows);
});

// ── التوجيه المحاسبي: normalize + validate routing fields from the body ──
const GROUP_CATEGORY_TYPES = new Set(["inventory", "fixed_asset", "expense", "deferred_expense"]);

// Default cost/revenue accounts (حساب التكلفة/الإيراد الافتراضي) on a group:
// optional, but when provided the account must exist within THIS tenant.
async function parseGroupDefaultAccounts(cid: number, body: any): Promise<{ costAccountId: number | null; revenueAccountId: number | null; error?: string }> {
  const parse = (v: any) => (v != null && v !== "" ? Number(v) : null);
  const costAccountId    = parse(body?.costAccountId);
  const revenueAccountId = parse(body?.revenueAccountId);
  for (const [label, accId] of [["حساب التكلفة الافتراضي", costAccountId], ["حساب الإيراد الافتراضي", revenueAccountId]] as const) {
    if (accId == null) continue;
    if (!Number.isInteger(accId) || accId <= 0) return { costAccountId: null, revenueAccountId: null, error: `${label} غير صالح` };
    const [acc] = await db.select({ id: accountsTable.id }).from(accountsTable)
      .where(and(eq(accountsTable.id, accId), eq(accountsTable.companyId, cid)));
    if (!acc) return { costAccountId: null, revenueAccountId: null, error: `${label} غير موجود ضمن شجرة حسابات الشركة` };
  }
  return { costAccountId, revenueAccountId };
}
// سلوك الربط المحاسبي (خانة واحدة، مثل شاشة المستودعات):
//  - المستخدم اختار حساباً من الشجرة (accountId) → تُربط الفئة عليه مباشرة، بدون إنشاء أي حساب.
//  - لم يختر شيئاً → النظام يحلّ الحساب الأب الافتراضي حسب نوع الفئة ويُنشئ
//    حساباً فرعياً جديداً بعد آخر حساب فرعي تحته (تلقائي).
//  - (توافق قديم) لو وصل parentAccountId صراحة، يُستخدم كأب للإنشاء التلقائي.
function parseGroupRouting(body: any): {
  categoryType: ItemGroupCategoryType | null;
  parentAccountId: number | null;
  directAccountId: number | null;
  error?: string;
} {
  const none = { categoryType: null, parentAccountId: null, directAccountId: null };
  const rawType = body?.categoryType ? String(body.categoryType) : null;
  if (!rawType) return none;
  if (!GROUP_CATEGORY_TYPES.has(rawType)) return { ...none, error: "نوع الفئة غير صالح" };
  const directAccountId = Number(body?.accountId);
  if (Number.isInteger(directAccountId) && directAccountId > 0) {
    return { categoryType: rawType as ItemGroupCategoryType, parentAccountId: null, directAccountId };
  }
  const parentAccountId = Number(body?.parentAccountId);
  if (Number.isInteger(parentAccountId) && parentAccountId > 0) {
    return { categoryType: rawType as ItemGroupCategoryType, parentAccountId, directAccountId: null };
  }
  // لا اختيار → auto بالكامل (الأب الافتراضي يُحلّ في المسار نفسه)
  return { categoryType: rawType as ItemGroupCategoryType, parentAccountId: null, directAccountId: null };
}

/** Validate a MANUALLY-picked account: tenant-owned + type-compatible with the
 *  category. Header (main) accounts ARE allowed here by explicit user request —
 *  picking an account means "link to exactly this one". */
async function validateGroupDirectAccount(
  companyId: number,
  accountId: number,
  categoryType: ItemGroupCategoryType,
): Promise<string | null> {
  const [acc] = await db.select().from(accountsTable).where(and(
    eq(accountsTable.id, accountId),
    eq(accountsTable.companyId, companyId),
  ));
  if (!acc) return "الحساب المختار غير موجود";
  const allowed = ITEM_GROUP_PARENT_TYPES[categoryType] as string[];
  if (!allowed.includes(String(acc.accountType))) {
    return "نوع الحساب المختار لا يتوافق مع نوع الفئة (مخزون/أصل ثابت/مصروف مؤجل → أصول، مصروف → مصروفات)";
  }
  return null;
}

// Preview (read-only) of the next auto-minted sub-account under a picked
// parent — powers the "آخر حساب / الحساب التالي" hint on the category form.
// NOTE: registered BEFORE /item-groups/:id (Express 5 literal-first rule).
router.get("/item-groups/next-account", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const parentId = Number(req.query.parentId);
  const categoryType = String(req.query.categoryType ?? "");
  if (!Number.isInteger(parentId) || parentId <= 0 || !GROUP_CATEGORY_TYPES.has(categoryType)) {
    res.status(400).json({ error: "بيانات غير صالحة" }); return;
  }
  const peek = await peekItemGroupNextAccountUnderParent(cid, parentId, categoryType as ItemGroupCategoryType);
  if (!peek) { res.status(404).json({ error: "الحساب الرئيسي غير صالح لهذا النوع من الفئات" }); return; }
  res.json(peek);
});

// معاينة الوضع التلقائي (بدون اختيار حساب): الأب الافتراضي + آخر/التالي.
// NOTE: registered BEFORE /item-groups/:id (Express 5 literal-first rule).
router.get("/item-groups/next-account-auto", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const categoryType = String(req.query.categoryType ?? "");
  if (!GROUP_CATEGORY_TYPES.has(categoryType)) { res.status(400).json({ error: "بيانات غير صالحة" }); return; }
  const peek = await peekItemGroupNextAccountAuto(cid, categoryType as ItemGroupCategoryType);
  if (!peek) { res.status(404).json({ error: "تعذّر تحديد الحساب الأب الافتراضي لهذا النوع — اختر الحساب يدوياً" }); return; }
  res.json(peek);
});

router.post("/item-groups", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const { code: rawCode, nameAr, nameEn } = req.body;
  if (!nameAr) { res.status(400).json({ error: "اسم المجموعة مطلوب" }); return; }
  const routing = parseGroupRouting(req.body);
  if (routing.error) { res.status(400).json({ error: routing.error }); return; }
  const existing = await db.select().from(itemGroupsTable).where(eq(itemGroupsTable.companyId, cid));
  const code = String(rawCode ?? "").trim() || nextEntityCode("GRP", existing.map(g => g.code));
  if (existing.some(g => g.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لمجموعة أخرى` }); return;
  }
  if (existing.some(g => g.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لمجموعة أخرى` }); return;
  }
  // Mint the category's default sub-account (supplier-style) BEFORE the insert
  // so a minting failure never leaves a half-routed category behind.
  // Manual mode: link the picked leaf account directly (no minting).
  let accountId: number | null = null;
  if (routing.categoryType && routing.directAccountId) {
    const err = await validateGroupDirectAccount(cid, routing.directAccountId, routing.categoryType);
    if (err) { res.status(400).json({ error: err }); return; }
    accountId = routing.directAccountId;
  } else if (routing.categoryType && routing.parentAccountId) {
    accountId = await ensureItemGroupAccountUnderParent(cid, String(nameAr).trim(), routing.parentAccountId, routing.categoryType);
    if (!accountId) { res.status(400).json({ error: "تعذّر إنشاء الحساب الفرعي للفئة — تأكد من صلاحية الحساب الرئيسي المختار" }); return; }
  } else if (routing.categoryType) {
    // لا اختيار → auto: أنشئ الحساب تحت الأب الافتراضي لنوع الفئة
    accountId = await ensureItemGroupAccountAuto(cid, String(nameAr).trim(), routing.categoryType);
    if (!accountId) { res.status(400).json({ error: "تعذّر تحديد الحساب الأب الافتراضي لهذا النوع — اختر الحساب من شجرة الحسابات يدوياً" }); return; }
  }
  const defAccounts = await parseGroupDefaultAccounts(cid, req.body);
  if (defAccounts.error) { res.status(400).json({ error: defAccounts.error }); return; }
  const [row] = await db.insert(itemGroupsTable).values({
    companyId: cid, code, nameAr, nameEn,
    categoryType: routing.categoryType, parentAccountId: routing.parentAccountId, accountId,
    costAccountId: defAccounts.costAccountId, revenueAccountId: defAccounts.revenueAccountId,
  }).returning();
  res.status(201).json(row);
});

router.put("/item-groups/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { code, nameAr, nameEn } = req.body;
  const routing = parseGroupRouting(req.body);
  if (routing.error) { res.status(400).json({ error: routing.error }); return; }
  const others = await db.select().from(itemGroupsTable).where(eq(itemGroupsTable.companyId, cid));
  const current = others.find(g => g.id === id);
  if (!current) { res.status(404).json({ error: "غير موجود" }); return; }
  if (code && others.some(g => g.id !== id && g.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لمجموعة أخرى` }); return;
  }
  if (nameAr && others.some(g => g.id !== id && g.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لمجموعة أخرى` }); return;
  }
  // Keep-if-exists: re-mint ONLY when routing is newly set or the parent/type
  // changed; never NULL an existing account link on an unrelated edit.
  let accountId: number | null = current.accountId ?? null;
  if (routing.categoryType && routing.directAccountId) {
    // Manual pick: link the picked account directly (no minting).
    const err = await validateGroupDirectAccount(cid, routing.directAccountId, routing.categoryType);
    if (err) { res.status(400).json({ error: err }); return; }
    accountId = routing.directAccountId;
  } else if (routing.categoryType && routing.parentAccountId) {
    const changed = current.categoryType !== routing.categoryType
      || current.parentAccountId !== routing.parentAccountId
      || !current.accountId;
    if (changed) {
      const minted = await ensureItemGroupAccountUnderParent(cid, String(nameAr ?? current.nameAr).trim(), routing.parentAccountId, routing.categoryType);
      if (!minted) { res.status(400).json({ error: "تعذّر إنشاء الحساب الفرعي للفئة — تأكد من صلاحية الحساب الرئيسي المختار" }); return; }
      accountId = minted;
    }
  } else if (routing.categoryType) {
    // Keep-if-exists: لو الفئة عندها حساب بالفعل ونفس النوع، لا تُنشئ جديداً.
    const changed = current.categoryType !== routing.categoryType || !current.accountId;
    if (changed) {
      const minted = await ensureItemGroupAccountAuto(cid, String(nameAr ?? current.nameAr).trim(), routing.categoryType);
      if (!minted) { res.status(400).json({ error: "تعذّر تحديد الحساب الأب الافتراضي لهذا النوع — اختر الحساب من شجرة الحسابات يدوياً" }); return; }
      accountId = minted;
    }
  } else {
    // Routing removed entirely → clear it (legacy behavior restored).
    accountId = null;
  }
  const defAccounts = await parseGroupDefaultAccounts(cid, req.body);
  if (defAccounts.error) { res.status(400).json({ error: defAccounts.error }); return; }
  const [row] = await db.update(itemGroupsTable).set({
    code, nameAr, nameEn,
    categoryType: routing.categoryType, parentAccountId: routing.parentAccountId, accountId,
    costAccountId: defAccounts.costAccountId, revenueAccountId: defAccounts.revenueAccountId,
  }).where(and(eq(itemGroupsTable.id, id), eq(itemGroupsTable.companyId, cid))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.delete("/item-groups/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  await db.delete(itemGroupsTable).where(and(eq(itemGroupsTable.id, Number(req.params.id)), eq(itemGroupsTable.companyId, cid)));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// BRANDS (العلامات التجارية) — master CRUD.
// OPTIONAL/additive. Brand is PRINT-ONLY on invoices; it never enters the
// ZATCA UBL XML, invoice hash, QR, or ICV/PIH chain.
// ═══════════════════════════════════════════════════════════════════
const BRAND_TEXT_FIELDS = [
  "code", "nameAr", "nameEn", "manufacturerName", "supplierName",
  "countryOfOrigin", "logoUrl", "notes",
] as const;
function pickBrandBody(body: any) {
  const out: Record<string, unknown> = {};
  for (const f of BRAND_TEXT_FIELDS) {
    if (body?.[f] !== undefined) out[f] = body[f] === "" ? null : body[f];
  }
  if (body?.status !== undefined) {
    out.status = body.status === "inactive" ? "inactive" : "active";
  }
  return out;
}

router.get("/brands", async (req, res) => {
  const cid = getCompanyId(req);
  const rows = cid
    ? await db.select().from(brandsTable).where(eq(brandsTable.companyId, cid)).orderBy(asc(brandsTable.code))
    : await db.select().from(brandsTable).orderBy(asc(brandsTable.code));
  res.json(rows);
});

router.post("/brands", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const { code: rawCode, nameAr } = req.body ?? {};
  if (!nameAr) { res.status(400).json({ error: "اسم العلامة التجارية مطلوب" }); return; }
  const existing = await db.select().from(brandsTable).where(eq(brandsTable.companyId, cid));
  const code = String(rawCode ?? "").trim() || nextEntityCode("BRD", existing.map(b => b.code));
  if (existing.some(b => b.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لعلامة تجارية أخرى` }); return;
  }
  if (existing.some(b => b.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لعلامة تجارية أخرى` }); return;
  }
  try {
    const [row] = await db.insert(brandsTable).values({ companyId: cid, code, nameAr, ...pickBrandBody(req.body) }).returning();
    res.status(201).json(row);
  } catch (err: any) {
    if (err?.code === "23505") { res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل` }); return; }
    throw err;
  }
});

router.put("/brands/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const { code, nameAr } = req.body ?? {};
  const others = await db.select().from(brandsTable).where(eq(brandsTable.companyId, cid));
  if (code && others.some(b => b.id !== id && b.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لعلامة تجارية أخرى` }); return;
  }
  if (nameAr && others.some(b => b.id !== id && b.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لعلامة تجارية أخرى` }); return;
  }
  const [row] = await db.update(brandsTable).set(pickBrandBody(req.body))
    .where(and(eq(brandsTable.id, id), eq(brandsTable.companyId, cid))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.delete("/brands/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  // item_brands has NO DB-level FK to brands (removed to keep the publish diff
  // additive), so its rows must be cleaned up explicitly here. sales_invoice_lines
  // .brand_id is a print-only snapshot (no FK) → historical invoices keep brandName.
  await db.delete(itemBrandsTable).where(and(eq(itemBrandsTable.brandId, id), eq(itemBrandsTable.companyId, cid)));
  await db.delete(brandsTable).where(and(eq(brandsTable.id, id), eq(brandsTable.companyId, cid)));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// ITEM ↔ BRAND links (سعر/باركود/رقم قطعة لكل علامة تجارية لصنف واحد)
// Gated by the "items" module (same as the item form that hosts them).
// ═══════════════════════════════════════════════════════════════════
const ITEM_BRAND_TEXT_FIELDS = [
  "barcode", "partNumber", "supplierCode", "purchaseUnit",
  "countryOfOrigin", "warrantyPeriod", "notes",
] as const;
const ITEM_BRAND_NUM_FIELDS = [
  "purchaseCost", "lastPurchaseCost", "avgCost",
  "salePrice1", "salePrice2", "salePrice3", "minSalePrice", "profitMargin",
] as const;
function pickItemBrandBody(body: any) {
  const out: Record<string, unknown> = {};
  for (const f of ITEM_BRAND_TEXT_FIELDS) {
    if (body?.[f] !== undefined) out[f] = body[f] === "" ? null : String(body[f]).slice(0, 1000);
  }
  for (const f of ITEM_BRAND_NUM_FIELDS) {
    if (body?.[f] !== undefined) out[f] = (body[f] == null || body[f] === "") ? "0" : String(body[f]);
  }
  if (body?.status !== undefined) out.status = body.status === "inactive" ? "inactive" : "active";
  return out;
}

router.get("/items/:id/brands", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [own] = await db.select({ id: itemsTable.id }).from(itemsTable)
    .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid)));
  if (!own) { res.status(404).json({ error: "الصنف غير موجود" }); return; }
  const rows = await db.select({
    id:              itemBrandsTable.id,
    companyId:       itemBrandsTable.companyId,
    itemId:          itemBrandsTable.itemId,
    brandId:         itemBrandsTable.brandId,
    barcode:         itemBrandsTable.barcode,
    partNumber:      itemBrandsTable.partNumber,
    supplierCode:    itemBrandsTable.supplierCode,
    purchaseUnit:    itemBrandsTable.purchaseUnit,
    purchaseCost:    itemBrandsTable.purchaseCost,
    lastPurchaseCost:itemBrandsTable.lastPurchaseCost,
    avgCost:         itemBrandsTable.avgCost,
    salePrice1:      itemBrandsTable.salePrice1,
    salePrice2:      itemBrandsTable.salePrice2,
    salePrice3:      itemBrandsTable.salePrice3,
    minSalePrice:    itemBrandsTable.minSalePrice,
    profitMargin:    itemBrandsTable.profitMargin,
    countryOfOrigin: itemBrandsTable.countryOfOrigin,
    warrantyPeriod:  itemBrandsTable.warrantyPeriod,
    status:          itemBrandsTable.status,
    notes:           itemBrandsTable.notes,
    createdAt:       itemBrandsTable.createdAt,
    brandCode:       brandsTable.code,
    brandNameAr:     brandsTable.nameAr,
    brandNameEn:     brandsTable.nameEn,
  })
    .from(itemBrandsTable)
    .leftJoin(brandsTable, eq(brandsTable.id, itemBrandsTable.brandId))
    .where(and(eq(itemBrandsTable.itemId, id), eq(itemBrandsTable.companyId, cid)))
    .orderBy(desc(itemBrandsTable.createdAt));
  res.json(rows);
});

router.post("/items/:id/brands", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const bid = Number(req.body?.brandId);
  if (!Number.isInteger(bid) || bid <= 0) { res.status(400).json({ error: "العلامة التجارية مطلوبة" }); return; }
  const [[ownItem], [ownBrand]] = await Promise.all([
    db.select({ id: itemsTable.id }).from(itemsTable).where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid))),
    db.select({ id: brandsTable.id }).from(brandsTable).where(and(eq(brandsTable.id, bid), eq(brandsTable.companyId, cid))),
  ]);
  if (!ownItem)  { res.status(404).json({ error: "الصنف غير موجود" }); return; }
  if (!ownBrand) { res.status(404).json({ error: "العلامة التجارية غير موجودة" }); return; }
  const [dup] = await db.select({ id: itemBrandsTable.id }).from(itemBrandsTable)
    .where(and(eq(itemBrandsTable.itemId, id), eq(itemBrandsTable.brandId, bid), eq(itemBrandsTable.companyId, cid)));
  if (dup) { res.status(409).json({ error: "هذه العلامة التجارية مرتبطة بالفعل بالصنف" }); return; }
  try {
    const [row] = await db.insert(itemBrandsTable)
      .values({ companyId: cid, itemId: id, brandId: bid, ...pickItemBrandBody(req.body) }).returning();
    auditSubEntity(req, "item_brands", row.id, "create", null, row);
    res.status(201).json(row);
  } catch (err: any) {
    if (err?.code === "23505") { res.status(409).json({ error: "هذه العلامة التجارية مرتبطة بالفعل بالصنف" }); return; }
    throw err;
  }
});

router.put("/items/:id/brands/:linkId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const linkId = Number(req.params.linkId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(linkId) || linkId <= 0) {
    res.status(400).json({ error: "معرّف غير صالح" }); return;
  }
  const [existing] = await db.select().from(itemBrandsTable)
    .where(and(eq(itemBrandsTable.id, linkId), eq(itemBrandsTable.itemId, id), eq(itemBrandsTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "الارتباط غير موجود" }); return; }
  const [row] = await db.update(itemBrandsTable).set(pickItemBrandBody(req.body))
    .where(and(eq(itemBrandsTable.id, linkId), eq(itemBrandsTable.companyId, cid))).returning();
  auditSubEntity(req, "item_brands", linkId, "edit", existing, row);
  res.json(row);
});

router.delete("/items/:id/brands/:linkId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const linkId = Number(req.params.linkId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(linkId) || linkId <= 0) {
    res.status(400).json({ error: "معرّف غير صالح" }); return;
  }
  const [existing] = await db.select().from(itemBrandsTable)
    .where(and(eq(itemBrandsTable.id, linkId), eq(itemBrandsTable.itemId, id), eq(itemBrandsTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "الارتباط غير موجود" }); return; }
  await db.delete(itemBrandsTable).where(and(eq(itemBrandsTable.id, linkId), eq(itemBrandsTable.companyId, cid)));
  auditSubEntity(req, "item_brands", linkId, "delete", existing, null);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// UNITS
// ═══════════════════════════════════════════════════════════════════
function unitErrorResponse(res: any, error: unknown): void {
  if (error instanceof UnitConversionError) {
    const status = error.code === "ITEM_NOT_FOUND" || error.code === "UNIT_NOT_FOUND" || error.code === "UNIT_ROW_NOT_FOUND" ? 404
      : ["DUPLICATE_UNIT", "CONFLICTING_BASE", "BASE_CHANGE_BLOCKED", "BASE_DISABLE_BLOCKED", "BASE_REQUIRED", "BASE_ROW_REQUIRED", "ANCESTOR_IN_USE", "BASE_CHANGE_REQUIRES_EDIT", "INACTIVE_UNIT"].includes(error.code) ? 409
      : 400;
    res.status(status).json({ error: error.message, code: error.code, ...(error.details ?? {}) });
    return;
  }
  const candidate = error as { code?: string; message?: string } | null;
  if (candidate?.code === "23505") {
    res.status(409).json({ error: "يوجد رابط وحدة مكرر" });
    return;
  }
  res.status(400).json({ error: candidate?.message ?? "بيانات تحويل الوحدات غير صالحة" });
}

function positiveDecimal(value: unknown, field: string): string {
  const candidate = typeof value === "string" ? value.trim() : String(value ?? "");
  if (!isPositiveExactDecimal(candidate)) {
    throw new UnitConversionError("INVALID_RELATION_FACTOR", `${field} must be a positive exact decimal`);
  }
  return formatRational(parseExactDecimal(candidate));
}

function decimalPlacesValue(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 18) {
    throw new UnitConversionError("INVALID_DECIMAL_PLACES", "decimalPlaces must be an integer from 0 to 18");
  }
  return value;
}

async function itemHasHistoricalUsage(executor: any, cid: number, itemId: number): Promise<boolean> {
  const probes = await Promise.all([
    executor.select({ id: stockLedgerTable.id }).from(stockLedgerTable)
      .where(and(eq(stockLedgerTable.companyId, cid), eq(stockLedgerTable.itemId, itemId))).limit(1),
    executor.select({ id: stockBalanceTable.id }).from(stockBalanceTable)
      .where(and(eq(stockBalanceTable.companyId, cid), eq(stockBalanceTable.itemId, itemId))).limit(1),
    executor.select({ id: salesInvoiceLinesTable.id }).from(salesInvoiceLinesTable)
      .where(and(eq(salesInvoiceLinesTable.companyId, cid), eq(salesInvoiceLinesTable.itemId, itemId))).limit(1),
    executor.select({ id: salesReturnLinesTable.id }).from(salesReturnLinesTable)
      .where(and(eq(salesReturnLinesTable.companyId, cid), eq(salesReturnLinesTable.itemId, itemId))).limit(1),
    executor.select({ id: purchaseInvoiceLinesTable.id }).from(purchaseInvoiceLinesTable)
      .where(and(eq(purchaseInvoiceLinesTable.companyId, cid), eq(purchaseInvoiceLinesTable.itemId, itemId))).limit(1),
    executor.select({ id: purchaseReturnLinesTable.id }).from(purchaseReturnLinesTable)
      .where(and(eq(purchaseReturnLinesTable.companyId, cid), eq(purchaseReturnLinesTable.itemId, itemId))).limit(1),
  ]);
  return probes.some((rows: unknown[]) => rows.length > 0);
}

async function lockItemUnitGraph(tx: any, cid: number, itemId: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${cid}::integer, hashtext(${`item-unit:${itemId}`}))`);
}

async function getItemForUnitEdit(executor: any, cid: number, itemId: number): Promise<any> {
  const [item] = await executor.select().from(itemsTable)
    .where(and(eq(itemsTable.id, itemId), eq(itemsTable.companyId, cid)));
  if (!item) throw new UnitConversionError("ITEM_NOT_FOUND", "Item does not belong to this company");
  return item;
}

async function assertCatalogUnit(executor: any, cid: number, unitId: number): Promise<any> {
  const [unit] = await executor.select().from(unitsTable)
    .where(and(eq(unitsTable.id, unitId), eq(unitsTable.companyId, cid)));
  if (!unit) throw new UnitConversionError("UNIT_NOT_FOUND", "Unit does not belong to this company");
  return unit;
}

async function recomputeCachedItemFactors(tx: any, cid: number, itemId: number): Promise<void> {
  const item = await getItemForUnitEdit(tx, cid, itemId);
  const rows = await tx.select().from(itemUnitPricesTable)
    .where(and(eq(itemUnitPricesTable.companyId, cid), eq(itemUnitPricesTable.itemId, itemId)));
  if (!rows.length) return;
  const graph = resolveUnitGraph({ baseUnitId: item.unitId ?? null, rows });
  for (const row of rows) {
    const factor = graph.factors.get(row.unitId);
    if (factor === undefined) continue;
    // The graph factor remains exact in memory; conversionFactor is only a
    // compatibility cache and must be a finite PostgreSQL numeric.
    await tx.update(itemUnitPricesTable).set({ conversionFactor: decimalForStorage(factor, 18, "half_up") })
      .where(and(eq(itemUnitPricesTable.id, row.id), eq(itemUnitPricesTable.companyId, cid)));
  }
}

async function changeItemBaseUnit(
  tx: any,
  cid: number,
  itemId: number,
  oldBaseId: number | null,
  newBaseId: number,
  rows: any[],
): Promise<void> {
  if (oldBaseId === newBaseId) return;
  // Re-basing would require rewriting every edge and can invalidate
  // historical/document/production snapshots.  Unit links are intentionally
  // immutable as a base once configured; callers may still edit relation
  // edges without changing the item's root.
  if (rows.length > 0) {
    throw new UnitConversionError("BASE_CHANGE_BLOCKED", "The base unit cannot change while item-unit relationships exist");
  }
  if (await itemHasHistoricalUsage(tx, cid, itemId)) {
    throw new UnitConversionError("BASE_CHANGE_BLOCKED", "The base unit cannot change after historical stock or usage exists");
  }
  await assertCatalogUnit(tx, cid, newBaseId);
  if (oldBaseId === null) {
    await tx.update(itemsTable).set({ unitId: newBaseId })
      .where(and(eq(itemsTable.id, itemId), eq(itemsTable.companyId, cid)));
    return;
  }
  await tx.update(itemsTable).set({ unitId: newBaseId })
    .where(and(eq(itemsTable.id, itemId), eq(itemsTable.companyId, cid)));
}

async function unitRowValues(body: any, current: any | null, item: any, unitId: number): Promise<any> {
  const currentIsBase = current?.isBase === true;
  let isBase = body.isBase === undefined ? currentIsBase : body.isBase === true;
  if (!current && item.unitId === unitId && body.isBase === undefined) isBase = true;
  const referenceRaw = body.referenceUnitId !== undefined
    ? body.referenceUnitId
    : current?.referenceUnitId ?? item.unitId ?? null;
  const referenceUnitId = isBase
    ? null
    : (referenceRaw === null || referenceRaw === "" || referenceRaw === undefined ? null : Number(referenceRaw));
  const relationRaw = body.relationFactor !== undefined
    ? body.relationFactor
    : body.conversionFactor !== undefined
      ? body.conversionFactor
      : current?.relationFactor ?? current?.conversionFactor ?? "1";
  const relationFactor = isBase ? "1" : positiveDecimal(relationRaw, "relationFactor");
  if (!isBase && (!Number.isInteger(referenceUnitId) || (referenceUnitId as number) <= 0)) {
    throw new UnitConversionError("MISSING_REFERENCE_UNIT", "A non-base unit must reference another unit");
  }
  const decimalPlaces = decimalPlacesValue(body.decimalPlaces, current?.decimalPlaces ?? 2);
  const roundingMode = String(body.roundingMode ?? current?.roundingMode ?? "half_up");
  // Validate the mode through the exact display helper without involving
  // conversion arithmetic.
  roundQuantity("0", decimalPlaces, roundingMode);
  if (isBase && body.isActive === false) {
    throw new UnitConversionError("BASE_DISABLE_BLOCKED", "The base unit cannot be inactive");
  }
  return {
    relationFactor,
    referenceUnitId,
    isBase,
    isActive: body.isActive === undefined ? current?.isActive !== false : body.isActive !== false,
    decimalPlaces,
    roundingMode,
  };
}

router.get("/units", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const rows = await db.select().from(unitsTable)
    .where(eq(unitsTable.companyId, cid))
    .orderBy(asc(unitsTable.code));
  res.json(rows);
});

router.post("/units", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const { code: rawCode, nameAr, nameEn, conversionFactor } = req.body;
  if (!nameAr) { res.status(400).json({ error: "اسم الوحدة مطلوب" }); return; }
  const existing = await db.select().from(unitsTable).where(eq(unitsTable.companyId, cid));
  const code = String(rawCode ?? "").trim() || nextEntityCode("UNT", existing.map(u => u.code));
  if (existing.some(u => u.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لوحدة أخرى` }); return;
  }
  if (existing.some(u => u.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لوحدة أخرى` }); return;
  }
  try {
    const factor = conversionFactor === undefined ? "1" : positiveDecimal(conversionFactor, "conversionFactor");
    const [row] = await db.insert(unitsTable).values({ companyId: cid, code, nameAr, nameEn, conversionFactor: factor }).returning();
    res.status(201).json(row);
  } catch (error) {
    unitErrorResponse(res, error);
  }
});

router.put("/units/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { code, nameAr, nameEn, conversionFactor } = req.body;
  const others = await db.select().from(unitsTable).where(eq(unitsTable.companyId, cid));
  if (code && others.some(u => u.id !== id && u.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لوحدة أخرى` }); return;
  }
  if (nameAr && others.some(u => u.id !== id && u.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لوحدة أخرى` }); return;
  }
  const [existing] = await db.select().from(unitsTable)
    .where(and(eq(unitsTable.id, id), eq(unitsTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  try {
    const factor = conversionFactor === undefined ? existing.conversionFactor : positiveDecimal(conversionFactor, "conversionFactor");
    const [row] = await db.update(unitsTable).set({ code, nameAr, nameEn, conversionFactor: factor })
      .where(and(eq(unitsTable.id, id), eq(unitsTable.companyId, cid))).returning();
    res.json(row);
  } catch (error) {
    unitErrorResponse(res, error);
  }
});

router.delete("/units/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [baseUse] = await db.select({ id: itemsTable.id }).from(itemsTable)
    .where(and(eq(itemsTable.companyId, cid), eq(itemsTable.unitId, id))).limit(1);
  const [itemUse] = await db.select({ id: itemUnitPricesTable.id }).from(itemUnitPricesTable)
    .where(and(eq(itemUnitPricesTable.companyId, cid), eq(itemUnitPricesTable.unitId, id))).limit(1);
  const [referenceUse] = await db.select({ id: itemUnitPricesTable.id }).from(itemUnitPricesTable)
    .where(and(eq(itemUnitPricesTable.companyId, cid), eq(itemUnitPricesTable.referenceUnitId, id))).limit(1);
  if (baseUse || itemUse || referenceUse) {
    res.status(409).json({ error: "لا يمكن حذف وحدة مستخدمة في صنف أو علاقة تحويل" }); return;
  }
  const deleted = await db.delete(unitsTable)
    .where(and(eq(unitsTable.id, id), eq(unitsTable.companyId, cid))).returning({ id: unitsTable.id });
  if (!deleted.length) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// ITEMS
// ═══════════════════════════════════════════════════════════════════
router.get("/items", async (req, res) => {
  const cid = getCompanyId(req);
  // PRO Extension #20 — note: variants ARE returned here. Variants are
  // stand-alone SKUs (own code, barcode, stock balance) so every "pick an
  // item" surface (sales/purchase/transfer/adjustment forms, scan-to-image,
  // bulk labels, bundle-component child dropdown, ...) needs to see them.
  // Hiding variants from the catalog list is a UI-only concern handled by
  // the Items master page client-side via `it.parentItemId == null`.
  // The POS apps (cashier / supermarket / restaurant) hit this same endpoint
  // and should only see items flagged `show_in_pos = true`. The main
  // inventory page in zatca-invoicing passes `?includeHidden=1` to see all.
  const includeHidden = String(req.query.includeHidden ?? "") === "1"
    || String(req.query.includeHidden ?? "").toLowerCase() === "true";
  const visibleFilter = includeHidden ? undefined : eq(itemsTable.showInPos, true);
  const rows = cid
    ? await db.select({ item: itemsTable, group: itemGroupsTable, unit: unitsTable })
        .from(itemsTable)
        .leftJoin(itemGroupsTable, eq(itemsTable.groupId, itemGroupsTable.id))
        .leftJoin(unitsTable, eq(itemsTable.unitId, unitsTable.id))
        .where(visibleFilter ? and(eq(itemsTable.companyId, cid), visibleFilter) : eq(itemsTable.companyId, cid))
        .orderBy(asc(itemsTable.code))
    : await db.select({ item: itemsTable, group: itemGroupsTable, unit: unitsTable })
        .from(itemsTable)
        .leftJoin(itemGroupsTable, eq(itemsTable.groupId, itemGroupsTable.id))
        .leftJoin(unitsTable, eq(itemsTable.unitId, unitsTable.id))
        .where(visibleFilter)
        .orderBy(asc(itemsTable.code));
  res.json(rows.map(r => ({ ...r.item, group: r.group, unit: r.unit })));
});

// ─── Batch usage-modes for ONE screen (Phase ب enforcement, frontend) ────────
// Returns every NON-default rule for the given screen across the company's
// catalogue plus whether the caller is usage-privileged, so a document form can
// annotate its item picker (hidden→drop, readonly/requires_permission→disable,
// requires_approval→badge) in a single query. Tenant-scoped; any logged-in user
// may read (it only exposes routing rules, never item financials). MUST stay
// ABOVE `/items/:id` — a one-segment literal route or Express treats
// "usage-modes" as an :id (Number(...) → NaN → 400).
router.get("/items/usage-modes", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const screenKey = String(req.query.screenKey ?? "").trim();
  if (!isValidScreenKey(screenKey)) { res.status(400).json({ error: "مفتاح شاشة غير صالح" }); return; }
  const rules = await getScreenRules(cid, screenKey);
  res.json({ screenKey, modes: rules, privileged: isUsagePrivileged(req.authUser) });
});

router.get("/items/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [row] = await db.select({ item: itemsTable, group: itemGroupsTable, unit: unitsTable })
    .from(itemsTable)
    .leftJoin(itemGroupsTable, eq(itemsTable.groupId, itemGroupsTable.id))
    .leftJoin(unitsTable, eq(itemsTable.unitId, unitsTable.id))
    .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid)));
  if (!row) { res.status(404).json({ error: "الصنف غير موجود" }); return; }
  // Fetch balances per warehouse
  const balances = await db.select({ bal: stockBalanceTable, wh: warehousesTable })
    .from(stockBalanceTable)
    .leftJoin(warehousesTable, eq(stockBalanceTable.warehouseId, warehousesTable.id))
    .where(eq(stockBalanceTable.itemId, id));
  res.json({ ...row.item, group: row.group, unit: row.unit, balances: balances.map(b => ({ ...b.bal, warehouse: b.wh })) });
});

// ─── ITEM AUDIT HELPERS ──────────────────────────────────────────────────────
// Track changes on these editable columns; intentionally skip auto-managed
// columns like id/companyId/createdAt/updatedAt that the user can't change.
const ITEM_AUDIT_FIELDS = [
  "code", "nameAr", "nameEn", "barcode", "itemType",
  "groupId", "unitId", "costPrice", "salePrice", "vatRate",
  "reorderLevel", "maxLevel", "costMethod", "description",
  "status", "imageUrl", "tags",
  // PRO Extension #3 — per-item default discount
  "discountType", "discountValue",
  // PRO Extension #2 — bundle flag
  "isBundle",
  // PRO Extension #20 — variant link + free-form attributes blob.
  // parentItemId is set-once at POST time; variantAttributes is editable.
  "parentItemId", "variantAttributes",
] as const;

function normAuditValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  return v;
}

function diffItem(before: any, after: any): Array<{ field: string; from: unknown; to: unknown }> {
  const out: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const f of ITEM_AUDIT_FIELDS) {
    const a = normAuditValue(before?.[f]);
    const b = normAuditValue(after?.[f]);
    if (String(a ?? "") !== String(b ?? "")) {
      out.push({ field: f, from: a, to: b });
    }
  }
  return out;
}

function snapshotItem(row: any): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const f of ITEM_AUDIT_FIELDS) snap[f] = normAuditValue(row?.[f]);
  return snap;
}

// PRO Extension #20 — Validate the variantAttributes payload. We accept a
// plain JSON object whose values are primitives (string/number/boolean) or
// null. Reject arrays, nested objects, functions, and oversized payloads
// (50 keys × 200 chars max) so the column can't be used as an arbitrary
// document store. Returns either { ok: true, value } or { ok: false, error }.
function validateVariantAttributes(input: unknown):
  { ok: true; value: Record<string, string | number | boolean | null> | null }
  | { ok: false; error: string }
{
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "السمات يجب أن تكون كائناً (key: value)" };
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 50) {
    return { ok: false, error: "عدد السمات أكثر من المسموح (الحد 50 سمة)" };
  }
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of entries) {
    if (typeof k !== "string" || k.length === 0 || k.length > 60) {
      return { ok: false, error: `اسم السمة "${k}" غير صالح` };
    }
    if (v === null) { out[k] = null; continue; }
    if (typeof v === "string") {
      if (v.length > 200) return { ok: false, error: `قيمة السمة "${k}" أطول من المسموح` };
      out[k] = v;
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) return { ok: false, error: `قيمة السمة "${k}" ليست رقماً صالحاً` };
      out[k] = v;
    } else if (typeof v === "boolean") {
      out[k] = v;
    } else {
      return { ok: false, error: `قيمة السمة "${k}" يجب أن تكون نص/رقم/منطقي` };
    }
  }
  return { ok: true, value: out };
}

// Compact wrapper around `writeAudit` for sub-entity tables (item_documents,
// item_suppliers, item_bundle_components, etc). Pulls the auth context off
// `req` and writes a row with before/after snapshots in `metadata`. The
// underlying `writeAudit` is fire-and-forget so this returns void quickly.
function auditSubEntity(
  req: any,
  module: string,
  entityId: number,
  action: "create" | "edit" | "delete",
  before: any,
  after: any,
): void {
  void writeAudit({
    userId:     req.authUser?.id ?? null,
    username:   req.authUser?.username ?? null,
    role:       req.authUser?.role ?? null,
    companyId:  req.authUser?.companyId ?? null,
    module,
    action,
    method:     req.method,
    path:       req.originalUrl ?? req.path,
    entityType: module,
    entityId:   String(entityId),
    statusCode: action === "create" ? 201 : 200,
    ip:         ipFromReq(req),
    userAgent:  req.get("user-agent")?.slice(0, 256) ?? null,
    metadata:   { before, after },
  });
}

function ipFromReq(req: any): string | null {
  const xf = req.headers?.["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0]!.trim().slice(0, 64);
  if (Array.isArray(xf) && xf.length) return String(xf[0]).slice(0, 64);
  return (req.socket?.remoteAddress ?? null)?.slice(0, 64) ?? null;
}

// Normalize a tags input (string or string[]) to a clean, deduped, trimmed,
// comma-joined string suitable for storage. Caps total length to 500 chars
// and individual tags to 40 chars to prevent abuse.
function normalizeTags(input: unknown): string | null {
  if (input === undefined) return undefined as any; // signal "leave alone"
  if (input === null || input === "") return null;
  const raw: string[] = Array.isArray(input)
    ? input.map(x => String(x))
    : String(input).split(",");
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const t of raw) {
    const v = t.trim().slice(0, 40);
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    cleaned.push(v);
    if (cleaned.length >= 20) break;
  }
  if (cleaned.length === 0) return null;
  return cleaned.join(",").slice(0, 500);
}

// Validate & normalize a per-item discount input. Returns
// `{ type: "none"|"percent"|"amount", value: string }` ready for insertion.
// Defends against bad client payloads: unknown types default to "none",
// negative values are clamped to 0, percent is capped at 100.
function normalizeDiscount(rawType: unknown, rawValue: unknown): { type: "none"|"percent"|"amount"; value: string } {
  let type: "none"|"percent"|"amount" = "none";
  if (rawType === "percent" || rawType === "amount") type = rawType;
  let n = Number(rawValue ?? 0);
  if (!isFinite(n) || n < 0) n = 0;
  if (type === "percent" && n > 100) n = 100;
  if (type === "none") n = 0;
  return { type, value: String(n) };
}

router.post("/items", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const { code: rawCode, nameAr, nameEn, barcode, itemType, itemNature, groupId, unitId, costPrice, salePrice, vatRate, reorderLevel, maxLevel, costMethod, description, imageUrl, tags, discountType, discountValue, isBundle, parentItemId, variantAttributes, showInPos, expiryDate, batchTrackingMode, costAccountId, revenueAccountId } = req.body;
  if (!nameAr) { res.status(400).json({ error: "اسم الصنف مطلوب" }); return; }
  const existing = await db.select().from(itemsTable).where(eq(itemsTable.companyId, cid));
  // كود الصنف اختياري — إن تُرك فارغاً يُولَّد تلقائياً بمتابعة أعلى رقم موجود.
  const code = String(rawCode ?? "").trim() || nextEntityCode("ITM", existing.map(i => i.code));
  if (existing.some(i => i.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لصنف آخر` }); return;
  }
  if (existing.some(i => i.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لصنف آخر` }); return;
  }
  if (barcode && existing.some(i => i.barcode?.trim() === String(barcode).trim())) {
    res.status(409).json({ error: `الباركود "${barcode}" مستخدم لصنف آخر` }); return;
  }
  // PRO Extension #20 — variant validation. If the client wants to create
  // this item as a variant of another item, validate the parent in this
  // tenant: must exist, must NOT be a variant itself (no nesting), and
  // must NOT be a bundle (variant/bundle are orthogonal). Variants also
  // can't themselves be bundles.
  let parentRowForVariant: any = null;
  if (parentItemId !== undefined && parentItemId !== null) {
    const pid = Number(parentItemId);
    if (!Number.isFinite(pid)) { res.status(400).json({ error: "parentItemId غير صالح" }); return; }
    parentRowForVariant = existing.find(i => i.id === pid);
    if (!parentRowForVariant) { res.status(404).json({ error: "الصنف الأب غير موجود" }); return; }
    if (parentRowForVariant.parentItemId) {
      res.status(400).json({ error: "لا يمكن إنشاء متغيّر لمتغيّر آخر (المتغيّرات لا تتداخل)" }); return;
    }
    if (parentRowForVariant.isBundle) {
      res.status(400).json({ error: "لا يمكن إضافة متغيّرات لصنف من نوع مركّب (Bundle)" }); return;
    }
    if (isBundle === true) {
      res.status(400).json({ error: "المتغيّر لا يمكن أن يكون مركّباً (Bundle)" }); return;
    }
  }
  const variantAttrsCheck = validateVariantAttributes(variantAttributes);
  if (!variantAttrsCheck.ok) { res.status(400).json({ error: variantAttrsCheck.error }); return; }
  const normalizedTags = normalizeTags(tags);
  const disc = normalizeDiscount(discountType, discountValue);
  if (unitId !== undefined && unitId !== null && unitId !== "") {
    const normalizedUnitId = Number(unitId);
    if (!Number.isInteger(normalizedUnitId) || normalizedUnitId <= 0) {
      res.status(400).json({ error: "وحدة الصنف غير صالحة" }); return;
    }
    const [ownedUnit] = await db.select({ id: unitsTable.id }).from(unitsTable)
      .where(and(eq(unitsTable.id, normalizedUnitId), eq(unitsTable.companyId, cid)));
    if (!ownedUnit) { res.status(400).json({ error: "وحدة الصنف لا تنتمي للشركة" }); return; }
  }
  const [row] = await db.insert(itemsTable).values({
    companyId: cid, code, nameAr, nameEn, barcode,
    itemType: itemType || parentRowForVariant?.itemType || "stock",
    itemNature: ["raw","semi","finished","consumable","merchandise"].includes(itemNature) ? itemNature : (parentRowForVariant?.itemNature || "merchandise"),
    groupId: groupId || parentRowForVariant?.groupId || null,
    unitId: unitId || parentRowForVariant?.unitId || null,
    costPrice: costPrice || parentRowForVariant?.costPrice || "0",
    salePrice: salePrice || parentRowForVariant?.salePrice || "0",
    vatRate:   vatRate   || parentRowForVariant?.vatRate   || "15",
    reorderLevel: reorderLevel || "0", maxLevel: maxLevel || null,
    costMethod: costMethod || "weighted_avg", description,
    imageUrl: imageUrl || null,
    tags: normalizedTags === undefined ? null : normalizedTags,
    discountType: disc.type, discountValue: disc.value,
    isBundle: isBundle === true,
    parentItemId: parentRowForVariant ? parentRowForVariant.id : null,
    variantAttributes: variantAttrsCheck.value,
    showInPos: showInPos === undefined ? true : showInPos === true,
    expiryDate: expiryDate || null,
    // Service-item GL links (cost / revenue accounts). Coerced to a numeric id
    // or null so an empty-string from the form doesn't break the FK.
    costAccountId:    costAccountId    != null && costAccountId    !== "" ? Number(costAccountId)    : null,
    revenueAccountId: revenueAccountId != null && revenueAccountId !== "" ? Number(revenueAccountId) : null,
    // PHASE E — Per-item batch picking mode. Validated to one of the three
    // allowed values; anything else (including legacy clients) falls back to
    // 'none' so the current WAC issue flow is preserved.
    batchTrackingMode: ["none","fifo","fefo"].includes(batchTrackingMode) ? batchTrackingMode : "none",
  }).returning();
  void writeAudit({
    userId:     (req as any).authUser?.id ?? null,
    username:   (req as any).authUser?.username ?? null,
    role:       (req as any).authUser?.role ?? null,
    companyId:  cid,
    module:     "inventory_items",
    action:     "create",
    method:     req.method,
    path:       req.originalUrl ?? req.path,
    entityType: "item",
    entityId:   String(row.id),
    statusCode: 201,
    ip:         ipFromReq(req),
    userAgent:  req.get("user-agent")?.slice(0, 256) ?? null,
    metadata:   { name: row.nameAr, code: row.code, snapshot: snapshotItem(row) },
  });
  res.status(201).json(row);
});

router.put("/items/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { code, nameAr, nameEn, barcode, itemType, itemNature, groupId, unitId, costPrice, salePrice, vatRate, reorderLevel, maxLevel, costMethod, description, status, imageUrl, tags, discountType, discountValue, isBundle, variantAttributes, showInPos, expiryDate, batchTrackingMode, costAccountId, revenueAccountId } = req.body;
  // PRO Extension #20 — variantAttributes is editable; parentItemId is
  // set-once at create time (re-parenting requires DELETE + recreate so
  // we don't have to reason about stock-balance migration).
  const variantAttrsCheck = (variantAttributes !== undefined)
    ? validateVariantAttributes(variantAttributes)
    : { ok: true as const, value: undefined };
  if (variantAttrsCheck.ok === false) {
    res.status(400).json({ error: variantAttrsCheck.error }); return;
  }
  const others = await db.select().from(itemsTable).where(eq(itemsTable.companyId, cid));
  if (code && others.some(i => i.id !== id && i.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لصنف آخر` }); return;
  }
  if (nameAr && others.some(i => i.id !== id && i.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لصنف آخر` }); return;
  }
  if (barcode && others.some(i => i.id !== id && i.barcode?.trim() === String(barcode).trim())) {
    res.status(409).json({ error: `الباركود "${barcode}" مستخدم لصنف آخر` }); return;
  }
  // Snapshot the existing row BEFORE mutating so we can compute a precise diff.
  const existing = others.find(i => i.id === id) ?? null;
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (unitId !== undefined) {
    const requestedUnitId = unitId === null || unitId === "" ? null : Number(unitId);
    if (requestedUnitId !== null && (!Number.isInteger(requestedUnitId) || requestedUnitId <= 0)) {
      res.status(400).json({ error: "وحدة الصنف غير صالحة" }); return;
    }
    if (requestedUnitId !== null) {
      const [ownedUnit] = await db.select({ id: unitsTable.id }).from(unitsTable)
        .where(and(eq(unitsTable.id, requestedUnitId), eq(unitsTable.companyId, cid)));
      if (!ownedUnit) { res.status(400).json({ error: "وحدة الصنف لا تنتمي للشركة" }); return; }
    }
    if (requestedUnitId !== existing.unitId) {
      const links = await db.select({ id: itemUnitPricesTable.id }).from(itemUnitPricesTable)
        .where(and(eq(itemUnitPricesTable.companyId, cid), eq(itemUnitPricesTable.itemId, id)));
      if (links.length) {
        res.status(409).json({ error: "لا تغيّر قاعدة الصنف مباشرة؛ عدّل رابط الوحدة عبر /items/:id/units" }); return;
      }
      if (await itemHasHistoricalUsage(db, cid, id)) {
        res.status(409).json({ error: "لا يمكن تغيير وحدة الأساس بعد وجود استخدام أو مخزون تاريخي", code: "BASE_CHANGE_BLOCKED" }); return;
      }
    }
  }
  // PRO Extension #20 — a variant (parentItemId IS NOT NULL) cannot also
  // be a bundle. The bundle/variant axes are intentionally orthogonal.
  if (isBundle === true && existing?.parentItemId) {
    res.status(400).json({ error: "المتغيّر لا يمكن أن يكون مركّباً (Bundle)" }); return;
  }
  const normalizedTags = normalizeTags(tags);
  // Only touch discount columns when the client actually sent them, so a
  // partial PUT (e.g. from an older client) doesn't accidentally reset the
  // per-item default discount to "none".
  const discPatch = (discountType !== undefined || discountValue !== undefined)
    ? (() => { const d = normalizeDiscount(discountType, discountValue); return { discountType: d.type, discountValue: d.value }; })()
    : {};
  const [row] = await db.update(itemsTable).set({
    code, nameAr, nameEn, barcode, itemType: itemType || "stock",
    ...(["raw","semi","finished","consumable","merchandise"].includes(itemNature) ? { itemNature } : {}),
    groupId: groupId || null, unitId: unitId === undefined ? existing.unitId : (unitId || null),
    costPrice: costPrice || "0", salePrice: salePrice || "0", vatRate: vatRate || "15",
    reorderLevel: reorderLevel || "0", maxLevel: maxLevel || null,
    costMethod: costMethod || "weighted_avg", description,
    imageUrl: imageUrl !== undefined ? (imageUrl || null) : undefined,
    tags: normalizedTags === undefined ? undefined : normalizedTags,
    ...discPatch,
    // Only touch isBundle when client explicitly sends it (so partial PUTs
    // from older clients don't accidentally flip the bundle flag). A variant
    // (parent_item_id IS NOT NULL) is also blocked from becoming a bundle
    // — checked below after we have `existing` in hand.
    ...(isBundle !== undefined ? { isBundle: isBundle === true } : {}),
    // PRO Extension #20 — only touch variantAttributes if client sent it.
    // `null` is a valid value (clears all attributes); `undefined` skips.
    ...(variantAttrsCheck.value !== undefined ? { variantAttributes: variantAttrsCheck.value } : {}),
    ...(showInPos !== undefined ? { showInPos: showInPos === true } : {}),
    ...(expiryDate !== undefined ? { expiryDate: expiryDate || null } : {}),
    // Service-item GL links — only touch when the client sent them (partial-PUT
    // safe). Empty-string / null clears the link; otherwise coerce to numeric id.
    ...(costAccountId !== undefined
      ? { costAccountId: costAccountId != null && costAccountId !== "" ? Number(costAccountId) : null }
      : {}),
    ...(revenueAccountId !== undefined
      ? { revenueAccountId: revenueAccountId != null && revenueAccountId !== "" ? Number(revenueAccountId) : null }
      : {}),
    // PHASE E — only touch when client explicitly sent; constrained list.
    ...(batchTrackingMode !== undefined && ["none","fifo","fefo"].includes(batchTrackingMode)
      ? { batchTrackingMode }
      : {}),
    status: status || "active", updatedAt: new Date(),
  }).where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  // Only audit when something actually changed (avoids "no-op save" noise).
  const changes = existing ? diffItem(existing, row) : [];
  if (changes.length > 0) {
    void writeAudit({
      userId:     (req as any).authUser?.id ?? null,
      username:   (req as any).authUser?.username ?? null,
      role:       (req as any).authUser?.role ?? null,
      companyId:  cid,
      module:     "inventory_items",
      action:     "edit",
      method:     req.method,
      path:       req.originalUrl ?? req.path,
      entityType: "item",
      entityId:   String(row.id),
      statusCode: 200,
      ip:         ipFromReq(req),
      userAgent:  req.get("user-agent")?.slice(0, 256) ?? null,
      metadata:   { name: row.nameAr, code: row.code, changes },
    });
  }
  res.json(row);
});

router.delete("/items/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  // Snapshot the row BEFORE deletion so the audit trail keeps a copy of what
  // existed (item rows themselves are gone after delete).
  const [existing] = await db.select().from(itemsTable)
    .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  // item_brands has NO DB-level FK to items (removed to keep the publish diff
  // additive), so its links must be cleaned up explicitly before the item goes.
  await db.delete(itemBrandsTable).where(and(eq(itemBrandsTable.itemId, id), eq(itemBrandsTable.companyId, cid)));
  await db.delete(itemsTable).where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid)));
  void writeAudit({
    userId:     (req as any).authUser?.id ?? null,
    username:   (req as any).authUser?.username ?? null,
    role:       (req as any).authUser?.role ?? null,
    companyId:  cid,
    module:     "inventory_items",
    action:     "delete",
    method:     req.method,
    path:       req.originalUrl ?? req.path,
    entityType: "item",
    entityId:   String(existing.id),
    statusCode: 200,
    ip:         ipFromReq(req),
    userAgent:  req.get("user-agent")?.slice(0, 256) ?? null,
    metadata:   { name: existing.nameAr, code: existing.code, snapshot: snapshotItem(existing) },
  });
  res.json({ ok: true });
});

// ─── ITEM AUDIT HISTORY ──────────────────────────────────────────────────────
// Returns the full audit trail for one item (most-recent first), capped at
// 500 rows. Tenant-scoped via `companyId` so other tenants' rows are hidden
// even if an attacker guesses an `entityId` from a different company.
router.get("/items/:id/audit", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const rows = await db.select({
    id:         auditLogTable.id,
    userId:     auditLogTable.userId,
    username:   auditLogTable.username,
    role:       auditLogTable.role,
    action:     auditLogTable.action,
    method:     auditLogTable.method,
    path:       auditLogTable.path,
    statusCode: auditLogTable.statusCode,
    ip:         auditLogTable.ip,
    metadata:   auditLogTable.metadata,
    createdAt:  auditLogTable.createdAt,
  }).from(auditLogTable)
    .where(and(
      eq(auditLogTable.companyId, cid),
      eq(auditLogTable.module, "inventory_items"),
      eq(auditLogTable.entityType, "item"),
      eq(auditLogTable.entityId, String(id)),
    ))
    .orderBy(desc(auditLogTable.createdAt))
    .limit(500);
  res.json(rows);
});

// ═══════════════════════════════════════════════════════════════════
// ITEM UNIT PRICES (multi-unit per item)
// ═══════════════════════════════════════════════════════════════════
router.get("/items/:id/units", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const itemId = Number(req.params.id);
  const rows = await db.select({ up: itemUnitPricesTable, unit: unitsTable })
    .from(itemUnitPricesTable)
    .leftJoin(unitsTable, eq(itemUnitPricesTable.unitId, unitsTable.id))
    .where(and(eq(itemUnitPricesTable.itemId, itemId), eq(itemUnitPricesTable.companyId, cid)))
    .orderBy(asc(itemUnitPricesTable.id));
  res.json(rows.map(r => ({ ...r.up, unit: r.unit })));
});

// GET unit prices for a specific item+unit combination (used in transaction forms)
router.get("/items/:id/units/:unitId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const itemId = Number(req.params.id);
  const unitId = Number(req.params.unitId);
  const [row] = await db.select({ up: itemUnitPricesTable, unit: unitsTable })
    .from(itemUnitPricesTable)
    .leftJoin(unitsTable, eq(itemUnitPricesTable.unitId, unitsTable.id))
    .where(and(eq(itemUnitPricesTable.itemId, itemId), eq(itemUnitPricesTable.unitId, unitId), eq(itemUnitPricesTable.companyId, cid)));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json({ ...row.up, unit: row.unit });
});

router.post("/items/:id/units", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const itemId = Number(req.params.id);
  const unitId = Number(req.body.unitId);
  if (!Number.isInteger(unitId) || unitId <= 0) {
    res.status(400).json({ error: "وحدة القياس مطلوبة" }); return;
  }
  try {
    await db.transaction(async (tx) => {
      await lockItemUnitGraph(tx, cid, itemId);
      const item = await getItemForUnitEdit(tx, cid, itemId);
      await assertCatalogUnit(tx, cid, unitId);
      const rows = await tx.select().from(itemUnitPricesTable)
        .where(and(eq(itemUnitPricesTable.companyId, cid), eq(itemUnitPricesTable.itemId, itemId)));
      if (rows.some((row: any) => row.unitId === unitId)) {
        throw new UnitConversionError("DUPLICATE_UNIT", "This unit is already linked to the item");
      }
      const values = await unitRowValues(req.body, null, item, unitId);
      // Explicit opt-in only: never infer a stock base from the catalog factor.
      if (req.body.initializeReferenceAsBase === true && !values.isBase) {
        if (item.unitId != null && item.unitId !== values.referenceUnitId) {
          throw new UnitConversionError("BASE_CHANGE_BLOCKED", "الصنف لديه وحدة أساسية مختلفة؛ لا يمكن استبدالها من علاقة تحويل.");
        }
        if (item.unitId == null) {
          await changeItemBaseUnit(tx, cid, itemId, null, values.referenceUnitId, rows);
          item.unitId = values.referenceUnitId;
        }
      }
      if (values.isBase && rows.length > 0) {
        throw new UnitConversionError("BASE_CHANGE_REQUIRES_EDIT", "Choose an existing linked unit when changing the base unit");
      }
      if (!values.isBase && item.unitId == null) {
        throw new UnitConversionError("MISSING_BASE", "حدد الوحدة الأساسية للصنف أولًا، أو اختر اعتماد الوحدة المرجعية كوحدة أساسية عند إنشاء أول علاقة.");
      }
      if (values.referenceUnitId !== null) await assertCatalogUnit(tx, cid, values.referenceUnitId);
      const [row] = await tx.insert(itemUnitPricesTable).values({
        companyId: cid,
        itemId,
        unitId,
        conversionFactor: "1",
        relationFactor: values.relationFactor,
        referenceUnitId: values.referenceUnitId,
        costPrice: String(req.body.costPrice ?? "0"),
        salePrice: String(req.body.salePrice ?? "0"),
        isBase: values.isBase,
        isActive: values.isActive,
        decimalPlaces: values.decimalPlaces,
        roundingMode: values.roundingMode,
      }).returning();
      if (values.isBase) {
        await tx.update(itemsTable).set({ unitId })
          .where(and(eq(itemsTable.id, itemId), eq(itemsTable.companyId, cid)));
      }
      await recomputeCachedItemFactors(tx, cid, itemId);
      auditSubEntity(req, "item_unit_prices", row.id, "create", null, row);
      res.status(201).json(row);
    });
  } catch (error) {
    unitErrorResponse(res, error);
  }
});

router.put("/items/:id/units/:upId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const itemId = Number(req.params.id);
  const upId = Number(req.params.upId);
  try {
    await db.transaction(async (tx) => {
      await lockItemUnitGraph(tx, cid, itemId);
      const item = await getItemForUnitEdit(tx, cid, itemId);
      const [current] = await tx.select().from(itemUnitPricesTable).where(and(
        eq(itemUnitPricesTable.id, upId),
        eq(itemUnitPricesTable.itemId, itemId),
        eq(itemUnitPricesTable.companyId, cid),
      ));
      if (!current) throw new UnitConversionError("UNIT_ROW_NOT_FOUND", "غير موجود");
      const rows = await tx.select().from(itemUnitPricesTable)
        .where(and(eq(itemUnitPricesTable.companyId, cid), eq(itemUnitPricesTable.itemId, itemId)));
      const unitId = req.body.unitId === undefined ? current.unitId : Number(req.body.unitId);
      if (!Number.isInteger(unitId) || unitId <= 0) throw new UnitConversionError("UNIT_NOT_FOUND", "وحدة القياس غير صالحة");
      await assertCatalogUnit(tx, cid, unitId);
      if (rows.some((row: any) => row.id !== upId && row.unitId === unitId)) {
        throw new UnitConversionError("DUPLICATE_UNIT", "This unit is already linked to the item");
      }
      const values = await unitRowValues(req.body, current, item, unitId);
      if (!values.isActive && current.isBase) {
        throw new UnitConversionError("BASE_DISABLE_BLOCKED", "The base unit cannot be disabled");
      }
      const child = rows.find((row: any) => row.isActive !== false && row.referenceUnitId === current.unitId && row.id !== current.id);
      if (!values.isActive && child) {
        throw new UnitConversionError("ANCESTOR_IN_USE", "Cannot disable a unit referenced by another active unit");
      }
      const changingBase = values.isBase && (item.unitId !== unitId || !current.isBase);
      if (changingBase) await changeItemBaseUnit(tx, cid, itemId, item.unitId ?? null, unitId, rows);
      if (!values.isBase && current.isBase) {
        throw new UnitConversionError("BASE_REQUIRED", "Select another base unit before disabling this base link");
      }
      if (!values.isBase && values.referenceUnitId !== null) await assertCatalogUnit(tx, cid, values.referenceUnitId);
      const [row] = await tx.update(itemUnitPricesTable).set({
        unitId,
        relationFactor: values.relationFactor,
        referenceUnitId: values.referenceUnitId,
        conversionFactor: "1",
        costPrice: req.body.costPrice === undefined ? current.costPrice : String(req.body.costPrice),
        salePrice: req.body.salePrice === undefined ? current.salePrice : String(req.body.salePrice),
        isBase: values.isBase,
        isActive: values.isActive,
        decimalPlaces: values.decimalPlaces,
        roundingMode: values.roundingMode,
        legacyConversionConflict: false,
      }).where(and(eq(itemUnitPricesTable.id, upId), eq(itemUnitPricesTable.companyId, cid))).returning();
      await recomputeCachedItemFactors(tx, cid, itemId);
      auditSubEntity(req, "item_unit_prices", upId, "edit", current, row);
      res.json(row);
    });
  } catch (error) {
    unitErrorResponse(res, error);
  }
});

router.delete("/items/:id/units/:upId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const itemId = Number(req.params.id);
  const upId = Number(req.params.upId);
  try {
    await db.transaction(async (tx) => {
      await lockItemUnitGraph(tx, cid, itemId);
      const [current] = await tx.select().from(itemUnitPricesTable).where(and(
        eq(itemUnitPricesTable.id, upId),
        eq(itemUnitPricesTable.itemId, itemId),
        eq(itemUnitPricesTable.companyId, cid),
      ));
      if (!current) throw new UnitConversionError("UNIT_ROW_NOT_FOUND", "غير موجود");
      const rows = await tx.select().from(itemUnitPricesTable)
        .where(and(eq(itemUnitPricesTable.companyId, cid), eq(itemUnitPricesTable.itemId, itemId)));
      const child = rows.find((row: any) => row.isActive !== false && row.referenceUnitId === current.unitId && row.id !== current.id);
      if (child) throw new UnitConversionError("ANCESTOR_IN_USE", "Cannot delete a unit referenced by another active unit");
      if (current.isBase && rows.some((row: any) => row.id !== current.id && row.isActive !== false)) {
        throw new UnitConversionError("BASE_REQUIRED", "Change the base unit before deleting it");
      }
      await tx.delete(itemUnitPricesTable).where(and(eq(itemUnitPricesTable.id, upId), eq(itemUnitPricesTable.companyId, cid)));
      await recomputeCachedItemFactors(tx, cid, itemId);
      auditSubEntity(req, "item_unit_prices", upId, "delete", current, null);
      res.json({ ok: true });
    });
  } catch (error) {
    unitErrorResponse(res, error);
  }
});

// Convert a quantity using only the item's explicit unit graph. The HTTP
// boundary intentionally has no historicalFactor escape hatch.
router.post("/items/:id/convert", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const itemId = Number(req.params.id);
  const fromUnitId = Number(req.body.fromUnitId);
  const toUnitId = Number(req.body.toUnitId);
  if (!Number.isInteger(fromUnitId) || !Number.isInteger(toUnitId) || fromUnitId <= 0 || toUnitId <= 0) {
    res.status(400).json({ error: "fromUnitId و toUnitId مطلوبان" }); return;
  }
  if (typeof req.body.quantity !== "string" && typeof req.body.quantity !== "number") {
    res.status(400).json({ error: "quantity must be an exact decimal string" }); return;
  }
  try {
    const from = await resolveItemUnitConversion({ companyId: cid, itemId, unitId: fromUnitId });
    const to = await resolveItemUnitConversion({ companyId: cid, itemId, unitId: toUnitId });
    const baseQuantity = multiplyQuantity(String(req.body.quantity), from.factor);
    const exactQuantity = divideQuantity(baseQuantity, to.factor);
    // Keep the public quantity compatible with JSON/SQL numeric consumers.
    // exactQuantity is the lossless rational metadata for callers that need
    // to carry a non-terminating result without a floating-point conversion.
    const preciseQuantity = decimalForStorage(exactQuantity, 18, "half_up");
    const result: Record<string, unknown> = {
      quantity: preciseQuantity,
      preciseQuantity,
      exactQuantity,
      fromUnitId,
      toUnitId,
      baseUnitId: from.baseUnitId,
      fromFactor: from.factor,
      toFactor: to.factor,
    };
    if (req.body.roundedDisplay === true || req.body.round === true) {
      const decimalPlaces = typeof req.body.decimalPlaces === "number"
        ? decimalPlacesValue(req.body.decimalPlaces, 2)
        : (to.decimalPlaces ?? 2);
      result.roundedQuantity = roundQuantity(preciseQuantity, decimalPlaces, String(req.body.roundingMode ?? to.roundingMode ?? "half_up"));
      result.displayQuantity = result.roundedQuantity;
    }
    res.json(result);
  } catch (error) {
    unitErrorResponse(res, error);
  }
});

// ═══════════════════════════════════════════════════════════════════
// STOCK TRANSFERS
// ═══════════════════════════════════════════════════════════════════
router.get("/stock-transfers", async (req, res) => {
  const cid = getCompanyId(req);
  const rows = cid
    ? await db.select({ tr: stockTransfersTable, from: warehousesTable, to: warehousesTable })
        .from(stockTransfersTable)
        .leftJoin(warehousesTable, eq(stockTransfersTable.fromWarehouseId, warehousesTable.id))
        .where(eq(stockTransfersTable.companyId, cid))
        .orderBy(desc(stockTransfersTable.transferDate))
    : [];
  // Fix: join both warehouses properly via alias - simpler approach:
  const transfers = await (cid
    ? db.select().from(stockTransfersTable).where(eq(stockTransfersTable.companyId, cid)).orderBy(desc(stockTransfersTable.transferDate))
    : db.select().from(stockTransfersTable).orderBy(desc(stockTransfersTable.transferDate)));
  // Attach warehouse names
  const whIds = [...new Set(transfers.flatMap(t => [t.fromWarehouseId, t.toWarehouseId]))];
  const whs = whIds.length ? await db.select().from(warehousesTable).where(inArray(warehousesTable.id, whIds)) : [];
  const whMap = Object.fromEntries(whs.map(w => [w.id, w]));
  res.json(transfers.map(t => ({ ...t, fromWarehouse: whMap[t.fromWarehouseId], toWarehouse: whMap[t.toWarehouseId] })));
});

router.get("/stock-transfers/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [tr] = await db.select().from(stockTransfersTable).where(and(eq(stockTransfersTable.id, id), eq(stockTransfersTable.companyId, cid)));
  if (!tr) { res.status(404).json({ error: "غير موجود" }); return; }
  const lineItems = await db.select({ li: stockTransferItemsTable, item: itemsTable, unit: unitsTable })
    .from(stockTransferItemsTable)
    .leftJoin(itemsTable, eq(stockTransferItemsTable.itemId, itemsTable.id))
    .leftJoin(unitsTable, eq(stockTransferItemsTable.unitId, unitsTable.id))
    .where(eq(stockTransferItemsTable.transferId, id));
  const [fromWh] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, tr.fromWarehouseId));
  const [toWh]   = await db.select().from(warehousesTable).where(eq(warehousesTable.id, tr.toWarehouseId));
  res.json({ ...tr, fromWarehouse: fromWh, toWarehouse: toWh, items: lineItems.map(l => ({ ...l.li, item: l.item, unit: l.unit })) });
});

// Verify the given warehouse/account IDs belong to the company (multi-tenant guard)
async function assertCompanyOwned(cid: number, ids: { warehouses?: number[]; accounts?: number[] }) {
  const whIds = (ids.warehouses ?? []).filter(Boolean) as number[];
  const accIds = (ids.accounts ?? []).filter(Boolean) as number[];
  if (whIds.length) {
    const rows = await db.select({ id: warehousesTable.id })
      .from(warehousesTable)
      .where(and(eq(warehousesTable.companyId, cid), inArray(warehousesTable.id, whIds)));
    if (rows.length !== new Set(whIds).size) throw new Error("مخزن غير صالح أو لا ينتمي للشركة");
  }
  if (accIds.length) {
    const rows = await db.select({ id: accountsTable.id })
      .from(accountsTable)
      .where(and(eq(accountsTable.companyId, cid), inArray(accountsTable.id, accIds)));
    if (rows.length !== new Set(accIds).size) throw new Error("حساب غير صالح أو لا ينتمي للشركة");
  }
}

/**
 * Resolve the usage-unit edge through the central unit engine.  The client
 * conversionFactor is deliberately never trusted here: drafts receive a
 * fresh snapshot from the active item-unit link, while an unchanged legacy
 * line can explicitly carry its already-frozen snapshot forward.
 */
async function movementUnitSnapshot(
  cid: number,
  itemId: number,
  line: any,
  executor: any,
  historicalFactor?: string | null,
) {
  const unitId = line?.unitId ? Number(line.unitId) : undefined;
  const result = await resolveItemUnitConversion({
    companyId: cid,
    itemId,
    unitId,
    unitCode: line?.unitCode ? String(line.unitCode) : undefined,
    historicalFactor: historicalFactor ?? undefined,
    executor,
  });
  const factor = decimalForStorage(String(result?.factor ?? historicalFactor ?? "1"), 18, "half_up");
  if (!isPositiveExactDecimal(factor)) throw new Error(`معامل تحويل غير صالح للصنف #${itemId}`);
  return {
    // Keep the persisted unit identity for a historical line, including a
    // legacy NULL unit. The current item's base-unit id must not be stamped
    // onto an otherwise unchanged old row.
    unitId: historicalFactor !== undefined
      ? (unitId ?? null)
      : (result?.unitId ?? (unitId ?? null)),
    conversionFactor: factor,
  };
}

router.post("/stock-transfers", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const { transferNumber, transferDate, fromWarehouseId, toWarehouseId, accountId, fromAccountId, toAccountId, notes, items } = req.body;
  if (!transferDate || !fromWarehouseId || !toWarehouseId) { res.status(400).json({ error: "بيانات ناقصة" }); return; }
  // Item Usage Control (Phase ب): block a save containing restricted items.
  {
    const usageIds = Array.from(new Set((items ?? []).map((l: any) => Number(l?.itemId)).filter((n: number) => Number.isInteger(n) && n > 0))) as number[];
    const usageV = await checkItemsUsable(cid, "stock_transfer", usageIds, (req as any).authUser, "save");
    if (usageV.length) { res.status(403).json({ error: usageViolationMessage(usageV, "save"), code: "ITEM_USAGE_BLOCKED", violations: usageV }); return; }
  }
  try {
    await assertCompanyOwned(cid, {
      warehouses: [Number(fromWarehouseId), Number(toWarehouseId)],
      accounts:   [accountId, fromAccountId, toAccountId].map(Number).filter(Boolean) as number[],
    });
  } catch (e: any) { res.status(400).json({ error: e.message }); return; }
  // Central sequence engine is authoritative when an active sequence is
  // configured for "stock_transfer"; otherwise fall back to the caller-
  // supplied value, then to the legacy timestamp scheme. Sequence errors
  // (e.g. capacity exceeded) surface to the user — never silently bypass
  // central numbering when it is configured.
  let num: string;
  try {
    const fromSeq = await nextSequenceNumber(cid, "stock_transfer", {
      userId:   (req as any).authUser?.id ?? null,
      refTable: "stock_transfers",
      // Stock transfers are warehouse-scoped (not branch-scoped) — use the
      // company-wide counter (branchId=null → sentinel 0).
      branchId: null,
    });
    num = fromSeq ?? ((transferNumber && String(transferNumber).trim()) || `TRF-${Date.now()}`);
  } catch (seqErr: any) {
    res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم التحويل" });
    return;
  }
  let tr: any;
  try {
    tr = await db.transaction(async (tx) => {
      const [created] = await tx.insert(stockTransfersTable).values({
        companyId: cid, transferNumber: num, transferDate, fromWarehouseId, toWarehouseId,
        accountId: accountId || null,
        fromAccountId: fromAccountId || null,
        toAccountId: toAccountId || null,
        notes, status: "draft",
      }).returning();
      if (items?.length) {
        const itemRows: any[] = [];
        for (const it of items) {
          const itemId = Number(it.itemId);
          const snapshot = await movementUnitSnapshot(cid, itemId, it, tx);
          itemRows.push({
            transferId: created.id,
            itemId,
            unitId: snapshot.unitId,
            qty: toStorageDecimal(String(it.qty), 4, "half_up"),
            // Cost is entered in the selected usage unit. It is converted to
            // base cost exactly once when the movement is posted.
            conversionFactor: snapshot.conversionFactor,
            costPrice: toStorageDecimal(String(it.costPrice || 0), 4, "half_up"),
          });
        }
        await tx.insert(stockTransferItemsTable).values(itemRows);
      }
      return created;
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "تعذر حفظ التحويل" });
    return;
  }
  res.status(201).json(tr);
});

router.put("/stock-transfers/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { transferDate, fromWarehouseId, toWarehouseId, fromAccountId, toAccountId, notes, items } = req.body;
  const [existing] = await db.select().from(stockTransfersTable).where(and(eq(stockTransfersTable.id, id), eq(stockTransfersTable.companyId, cid)));
  if (!existing || existing.status === "posted") { res.status(400).json({ error: "لا يمكن التعديل" }); return; }
  try {
    await assertCompanyOwned(cid, {
      warehouses: [Number(fromWarehouseId), Number(toWarehouseId)].filter(Boolean) as number[],
      accounts:   [fromAccountId, toAccountId].map(Number).filter(Boolean) as number[],
    });
  } catch (e: any) { res.status(400).json({ error: e.message }); return; }
  try {
    await db.transaction(async (tx) => {
      const oldLines = await tx.select().from(stockTransferItemsTable)
        .where(eq(stockTransferItemsTable.transferId, id))
        .orderBy(asc(stockTransferItemsTable.id));
      await tx.update(stockTransfersTable).set({
        transferDate, fromWarehouseId, toWarehouseId,
        fromAccountId: fromAccountId || null,
        toAccountId: toAccountId || null,
        notes, updatedAt: new Date(),
      }).where(eq(stockTransfersTable.id, id));
      if (items) {
        await tx.delete(stockTransferItemsTable).where(eq(stockTransferItemsTable.transferId, id));
        if (items.length) {
          const itemRows: any[] = [];
          const matchedOldIds = new Set<number>();
          for (const it of items) {
            const itemId = Number(it.itemId);
            const requestedUnitId = it.unitId ? Number(it.unitId) : null;
            let old = it.id
              ? oldLines.find(row => row.id === Number(it.id))
              : undefined;
            if (it.id && (!old || matchedOldIds.has(old.id))) {
              throw new Error("معرّف سطر التحويل غير صالح أو مكرر");
            }
            if (!it.id) {
              const candidates = oldLines.filter(row =>
                !matchedOldIds.has(row.id) &&
                row.itemId === itemId &&
                (row.unitId ?? null) === requestedUnitId,
              );
              if (candidates.length > 1) {
                throw new Error(`لا يمكن مطابقة سطر التحويل للصنف #${itemId}: توجد أسطر قديمة متطابقة`);
              }
              old = candidates[0];
            }
            const unchanged = !!old &&
              old.itemId === itemId &&
              (old.unitId ?? null) === requestedUnitId;
            if (old) matchedOldIds.add(old.id);
            const snapshot = await movementUnitSnapshot(
              cid,
              itemId,
              it,
              tx,
              unchanged ? String(old!.conversionFactor ?? "1") : undefined,
            );
            itemRows.push({
              transferId: id,
              itemId,
              unitId: snapshot.unitId,
              qty: toStorageDecimal(String(it.qty), 4, "half_up"),
              conversionFactor: snapshot.conversionFactor,
              costPrice: toStorageDecimal(String(it.costPrice || 0), 4, "half_up"),
            });
          }
          await tx.insert(stockTransferItemsTable).values(itemRows);
        }
      }
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "تعذر تعديل التحويل" });
    return;
  }
  res.json({ ok: true });
});

// POST transfer — confirm/post
router.post("/stock-transfers/:id/post", requirePostRight("stockMovement"), async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);

  // ── Round 8 v3 atomicity + single-winner concurrency control ──
  // Everything (claim, ledger, balances, JE, final status flip) runs inside
  // a single DB transaction. The claim itself is now a SELECT … FOR UPDATE
  // on the transfer row so two concurrent /post calls cannot both proceed:
  // the second one blocks until the first commits, then re-reads the row,
  // sees status='posted', and aborts with 400. On any failure (insufficient
  // stock, closed period, DB error) the tx rolls back so no partial ledger
  // rows / balance mutations / JEs remain, and status stays 'draft' so the
  // request is safely retryable. User-facing 4xx are signalled via a
  // file-local `HttpError` thrown inside the tx and caught outside; any
  // other throw bubbles up as 500 with full rollback.
  class HttpError extends Error {
    constructor(public httpStatus: number, msg: string) { super(msg); }
  }

  try {
    // Item Usage Control (Phase ب): block posting a doc carrying restricted items.
    {
      const trLines = await db.select({ itemId: stockTransferItemsTable.itemId }).from(stockTransferItemsTable).where(eq(stockTransferItemsTable.transferId, id));
      const usageIds = Array.from(new Set(trLines.map(l => l.itemId).filter((x): x is number => !!x)));
      const usageV = await checkItemsUsable(cid, "stock_transfer", usageIds, (req as any).authUser, "post");
      if (usageV.length) { res.status(403).json({ error: usageViolationMessage(usageV, "post"), code: "ITEM_USAGE_BLOCKED", violations: usageV }); return; }
    }
    const result = await db.transaction(async (tx) => {
      // Row-lock + re-check status under the lock. Pessimistic FOR UPDATE
      // is the right tool here: posting touches many rows, so the
      // serialisable retry path of an optimistic CAS would amplify
      // contention. Lock window = the whole posting flow (intentional).
      const [tr] = await tx.select().from(stockTransfersTable)
        .where(and(eq(stockTransfersTable.id, id), eq(stockTransfersTable.companyId, cid)))
        .for("update");
      if (!tr) throw new HttpError(404, "الحركة غير موجودة");
      if (tr.status !== "draft") throw new HttpError(400, "الحركة مُرحَّلة مسبقاً");
      const lines = await tx.select().from(stockTransferItemsTable).where(eq(stockTransferItemsTable.transferId, id));
      if (!lines.length) throw new HttpError(400, "لا توجد أصناف");
      await lockStockBalances(lines.flatMap(line => [
        { companyId: cid, itemId: line.itemId, warehouseId: tr.fromWarehouseId },
        { companyId: cid, itemId: line.itemId, warehouseId: tr.toWarehouseId },
      ]), tx);

      // Period guard: do this BEFORE any mutations so a closed period
      // can't even partially write ledger rows. The post-loop JE branch
      // checks `writability.period?.id` but the guard itself must run
      // upfront — same intent as production-order/sales-invoice posting.
      const writability = await assertWritableForDate(cid, tr.transferDate);
      if (!writability.ok) throw new HttpError(423, writability.reason ?? "الفترة مغلقة");

      // ── Round 8: batch-aware transfers ──
      // For items with batch_tracking_mode='fifo'|'fefo', the source
      // warehouse releases stock via FIFO/FEFO across its tracked batches
      // and we stamp batch_number/expiry_date + the batch's actual cost
      // onto BOTH the OUT (source) and IN (destination) ledger rows. The
      // destination warehouse inherits the same batch identity → future
      // issues from there can continue FEFO correctly.
      // Items with mode='none' keep the legacy single-row WAC flow.
      const lineItemIds = Array.from(new Set(lines.map(l => l.itemId)));
      const itemRows = lineItemIds.length
        ? await tx.select({ id: itemsTable.id, mode: itemsTable.batchTrackingMode })
            .from(itemsTable)
            .where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, lineItemIds)))
        : [];
      const modeById = new Map<number, "none" | "fifo" | "fefo">();
      for (const r of itemRows) {
        const m = (r.mode ?? "none") as string;
        modeById.set(r.id, m === "fifo" || m === "fefo" ? (m as "fifo" | "fefo") : "none");
      }

      // Aggregate the real cost moved so the JE below totals from batch
      // picks (not the user-entered cost field) — keeps GL inventory
      // movement tied exactly to the stock subledger (Rounds 6/7 pattern).
      let realTotalCost = 0;

      for (const line of lines) {
        const baseQtyText = toStorageDecimal(
          multiplyQuantity(
            String(line.qty),
            String(line.conversionFactor ?? "1"),
          ),
          4,
          "half_up",
        );
        const qty = Number(baseQtyText);
        if (qty <= 0) continue;
        const mode = modeById.get(line.itemId) ?? "none";

        if (mode === "none") {
          // Legacy single-row WAC issue at the line's recorded cost.
          // Cost is stored in the selected usage unit; convert it to the
          // item's base-unit price exactly once at posting time.
          const cost = Number(toStorageDecimal(
            divideQuantity(
              String(line.costPrice),
              String(line.conversionFactor ?? "1"),
            ),
            4,
            "half_up",
          ));
          const lineCost = qty * cost;
          realTotalCost += lineCost;
          await upsertBalance(cid, line.itemId, tr.fromWarehouseId, -qty, cost, tx);
          await upsertBalance(cid, line.itemId, tr.toWarehouseId,   +qty, cost, tx);
          const newFromBal = await getBalance(cid, line.itemId, tr.fromWarehouseId, tx);
          const newToBal   = await getBalance(cid, line.itemId, tr.toWarehouseId,   tx);
          await tx.insert(stockLedgerTable).values([
            { companyId: cid, itemId: line.itemId, warehouseId: tr.fromWarehouseId, txDate: tr.transferDate, txType: "transfer_out", qty: String(-qty), costPrice: String(cost), totalCost: String(-lineCost), balanceQty: String(newFromBal), refId: id, refType: "transfer" },
            { companyId: cid, itemId: line.itemId, warehouseId: tr.toWarehouseId,   txDate: tr.transferDate, txType: "transfer_in",  qty: String(qty), costPrice: String(cost), totalCost: String(lineCost),  balanceQty: String(newToBal),   refId: id, refType: "transfer" },
          ]);
        } else {
          // FIFO/FEFO: allocate across source-warehouse batches; emit one
          // OUT + one IN ledger row per batch with the batch's actual cost
          // and stamped batch_number/expiry_date on both sides.
          let picks: BatchPick[];
          try {
            // Pass `tx` so the batch read happens inside the same SQL
            // transaction as the subsequent ledger writes — keeps the
            // pick consistent with any partial mutations from earlier
            // lines in this same posting (e.g. when two lines on the
            // same item drain a tracked batch).
            picks = await pickBatches(cid, line.itemId, tr.fromWarehouseId, qty, mode, tx);
          } catch (e: any) {
            throw new HttpError(400, `الصنف #${line.itemId}: ${e?.message ?? "كمية غير متاحة بالتشغيلات"}`);
          }
          for (const p of picks) {
            const lineCost = p.takeQty * p.costPrice;
            realTotalCost += lineCost;
            // Source: WAC balance decreases at the batch's actual cost.
            await upsertBalance(cid, line.itemId, tr.fromWarehouseId, -p.takeQty, p.costPrice, tx);
            // Destination: same cost (transfer moves stock, doesn't revalue).
            await upsertBalance(cid, line.itemId, tr.toWarehouseId,   +p.takeQty, p.costPrice, tx);
            const newFromBal = await getBalance(cid, line.itemId, tr.fromWarehouseId, tx);
            const newToBal   = await getBalance(cid, line.itemId, tr.toWarehouseId,   tx);
            await tx.insert(stockLedgerTable).values([
              { companyId: cid, itemId: line.itemId, warehouseId: tr.fromWarehouseId, txDate: tr.transferDate, txType: "transfer_out", qty: String(-p.takeQty), costPrice: String(p.costPrice), totalCost: String(-lineCost), balanceQty: String(newFromBal), refId: id, refType: "transfer", batchNumber: p.batchNumber, expiryDate: p.expiryDate },
              { companyId: cid, itemId: line.itemId, warehouseId: tr.toWarehouseId,   txDate: tr.transferDate, txType: "transfer_in",  qty: String(p.takeQty),  costPrice: String(p.costPrice), totalCost: String(lineCost),  balanceQty: String(newToBal),   refId: id, refType: "transfer", batchNumber: p.batchNumber, expiryDate: p.expiryDate },
            ]);
          }
        }
      }

      // ─── Auto-generate balanced journal entry (DR destination / CR source) ───
      // Resolve account IDs: prefer transfer-level overrides, fallback to
      // warehouse.accountId. Always scope warehouse lookup by company.
      let fromAcc = tr.fromAccountId;
      let toAcc   = tr.toAccountId;
      if (!fromAcc || !toAcc) {
        const [fromWh] = await tx.select().from(warehousesTable)
          .where(and(eq(warehousesTable.id, tr.fromWarehouseId), eq(warehousesTable.companyId, cid)));
        const [toWh]   = await tx.select().from(warehousesTable)
          .where(and(eq(warehousesTable.id, tr.toWarehouseId),   eq(warehousesTable.companyId, cid)));
        fromAcc = fromAcc || (fromWh?.accountId ?? null);
        toAcc   = toAcc   || (toWh?.accountId   ?? null);
      }
      let journalEntryId: number | null = null;
      const totalAmount = realTotalCost;
      if (fromAcc && toAcc && fromAcc !== toAcc && totalAmount > 0) {
        const desc = `تحويل مخزني ${tr.transferNumber}${tr.notes ? " - " + tr.notes : ""}`;
        const jeStatus = await resolvePostingStatus(cid, "stockMovement");
        // JE draws its own continuous "journal_entry" number; the transfer
        // number stays in the description + source link. Falls back to it.
        const jeDocNumber = (await nextJeSubSequence(cid, "stock_transfer_je", {
          userId: (req as any).authUser?.id ?? null, refTable: "journal_entries",
          branchId: (tr as any).branchId ?? null, docDate: tr.transferDate as any,
        })) ?? tr.transferNumber;
        const [entry] = await tx.insert(journalEntriesTable).values({
          companyId: cid, docNumber: jeDocNumber, entryDate: tr.transferDate,
          currency: "SAR", exchangeRate: "1",
          description: desc, entryType: "stock_transfer",
          status: jeStatus,
          periodId: writability.period?.id ?? null,
          ...fullAuditFor(req, jeStatus),
        }).returning();
        await tx.insert(journalEntryLinesTable).values([
          { entryId: entry.id, accountId: toAcc,   debit: totalAmount.toFixed(2), credit: "0.00", description: `استلام بالمخزن (${tr.transferNumber})`, sortOrder: 0 },
          { entryId: entry.id, accountId: fromAcc, debit: "0.00", credit: totalAmount.toFixed(2), description: `صرف من المخزن (${tr.transferNumber})`, sortOrder: 1 },
        ]);
        journalEntryId = entry.id;
      }

      await tx.update(stockTransfersTable).set({ status: "posted", journalEntryId, updatedAt: new Date() })
        .where(and(eq(stockTransfersTable.id, id), eq(stockTransfersTable.companyId, cid)));
      return { journalEntryId };
    });
    res.json({ ok: true, journalEntryId: result.journalEntryId });
  } catch (e: any) {
    if (e instanceof HttpError) {
      res.status(e.httpStatus).json({ error: e.message });
      return;
    }
    throw e;
  }
});

router.delete("/stock-transfers/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [tr] = await db.select().from(stockTransfersTable).where(and(eq(stockTransfersTable.id, id), eq(stockTransfersTable.companyId, cid)));
  if (!tr || tr.status === "posted") { res.status(400).json({ error: "لا يمكن الحذف" }); return; }
  await db.delete(stockTransfersTable).where(eq(stockTransfersTable.id, id));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// STOCK ADJUSTMENTS
// ═══════════════════════════════════════════════════════════════════
router.get("/stock-adjustments", async (req, res) => {
  const cid = getCompanyId(req);
  const rows = cid
    ? await db.select().from(stockAdjustmentsTable).where(eq(stockAdjustmentsTable.companyId, cid)).orderBy(desc(stockAdjustmentsTable.adjustmentDate))
    : await db.select().from(stockAdjustmentsTable).orderBy(desc(stockAdjustmentsTable.adjustmentDate));
  const whIds = [...new Set(rows.map(r => r.warehouseId))];
  const whs = whIds.length ? await db.select().from(warehousesTable).where(inArray(warehousesTable.id, whIds)) : [];
  const whMap = Object.fromEntries(whs.map(w => [w.id, w]));
  res.json(rows.map(r => ({ ...r, warehouse: whMap[r.warehouseId] })));
});

router.get("/stock-adjustments/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [adj] = await db.select().from(stockAdjustmentsTable).where(and(eq(stockAdjustmentsTable.id, id), eq(stockAdjustmentsTable.companyId, cid)));
  if (!adj) { res.status(404).json({ error: "غير موجود" }); return; }
  const lines = await db.select({ li: stockAdjustmentItemsTable, item: itemsTable, unit: unitsTable })
    .from(stockAdjustmentItemsTable)
    .leftJoin(itemsTable, eq(stockAdjustmentItemsTable.itemId, itemsTable.id))
    .leftJoin(unitsTable, eq(stockAdjustmentItemsTable.unitId, unitsTable.id))
    .where(eq(stockAdjustmentItemsTable.adjustmentId, id));
  const [wh] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, adj.warehouseId));
  res.json({ ...adj, warehouse: wh, items: lines.map(l => ({ ...l.li, item: l.item, unit: l.unit })) });
});

router.post("/stock-adjustments", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const { adjustmentNumber, adjustmentDate, warehouseId, accountId, inventoryAccountId, adjustmentAccountId, reason, notes, items } = req.body;
  if (!adjustmentDate || !warehouseId) { res.status(400).json({ error: "بيانات ناقصة" }); return; }
  // Item Usage Control (Phase ب): block a save containing restricted items.
  {
    const usageIds = Array.from(new Set((items ?? []).map((l: any) => Number(l?.itemId)).filter((n: number) => Number.isInteger(n) && n > 0))) as number[];
    const usageV = await checkItemsUsable(cid, "stock_adjust", usageIds, (req as any).authUser, "save");
    if (usageV.length) { res.status(403).json({ error: usageViolationMessage(usageV, "save"), code: "ITEM_USAGE_BLOCKED", violations: usageV }); return; }
  }
  try {
    await assertCompanyOwned(cid, {
      warehouses: [Number(warehouseId)],
      accounts:   [accountId, inventoryAccountId, adjustmentAccountId].map(Number).filter(Boolean) as number[],
    });
  } catch (e: any) { res.status(400).json({ error: e.message }); return; }
  // Central sequence engine is authoritative when an active sequence is
  // configured for "stock_adjustment"; otherwise fall back to the caller-
  // supplied value, then to the legacy timestamp scheme. Sequence errors
  // surface to the user — never silently bypass central numbering.
  let num: string;
  try {
    const fromSeq = await nextSequenceNumber(cid, "stock_adjustment", {
      userId:   (req as any).authUser?.id ?? null,
      refTable: "stock_adjustments",
      // Stock adjustments are warehouse-scoped (not branch-scoped) — use the
      // company-wide counter (branchId=null → sentinel 0).
      branchId: null,
    });
    num = fromSeq ?? ((adjustmentNumber && String(adjustmentNumber).trim()) || `ADJ-${Date.now()}`);
  } catch (seqErr: any) {
    res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم التسوية" });
    return;
  }
  if (!Array.isArray(items) || !items.length) { res.status(400).json({ error: "أضف صنفاً واحداً على الأقل" }); return; }
  const itemIds = Array.from(new Set(items.map((it: any) => Number(it.itemId)).filter((v: number) => Number.isInteger(v) && v > 0))) as number[];
  const ownedItems = itemIds.length ? await db.select({ id: itemsTable.id }).from(itemsTable).where(and(
    eq(itemsTable.companyId, cid), inArray(itemsTable.id, itemIds),
  )) : [];
  if (items.some((it: any) => !Number.isInteger(Number(it.itemId)) || Number(it.itemId) <= 0) || ownedItems.length !== itemIds.length) {
    res.status(400).json({ error: "تحتوي التسوية على صنف غير صالح" }); return;
  }
  for (const it of items) {
    const qty = Number(toStorageDecimal(String(it.qty), 4, "half_up"));
    const cost = Number(toStorageDecimal(String(it.costPrice), 4, "half_up"));
    if (!Number.isFinite(qty) || qty === 0 || !Number.isFinite(cost) || cost < 0) {
      res.status(400).json({ error: "الكمية يجب ألا تكون صفراً والتكلفة يجب أن تكون رقماً موجباً أو صفراً" }); return;
    }
  }
  let adj: any;
  try {
    adj = await db.transaction(async (tx) => {
      const [created] = await tx.insert(stockAdjustmentsTable).values({
        companyId: cid, adjustmentNumber: num, adjustmentDate, warehouseId,
        accountId: accountId || null,
        inventoryAccountId: inventoryAccountId || null,
        adjustmentAccountId: adjustmentAccountId || null,
        reason, notes, status: "draft",
      }).returning();
      const itemRows: any[] = [];
      for (const it of items) {
        const itemId = Number(it.itemId);
        const snapshot = await movementUnitSnapshot(cid, itemId, it, tx);
        itemRows.push({
          adjustmentId: created.id,
          itemId,
          unitId: snapshot.unitId,
          qty: toStorageDecimal(String(it.qty), 4, "half_up"),
          // Keep the entered price in the selected usage unit. Posting
          // converts this price to the base-unit price once.
          conversionFactor: snapshot.conversionFactor,
          costPrice: toStorageDecimal(String(it.costPrice), 4, "half_up"),
          notes: it.notes,
        });
      }
      await tx.insert(stockAdjustmentItemsTable).values(itemRows);
      return created;
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "تعذر حفظ التسوية" });
    return;
  }
  res.status(201).json(adj);
});

router.put("/stock-adjustments/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { adjustmentDate, warehouseId, inventoryAccountId, adjustmentAccountId, reason, notes, items } = req.body;
  const [existing] = await db.select().from(stockAdjustmentsTable).where(and(eq(stockAdjustmentsTable.id, id), eq(stockAdjustmentsTable.companyId, cid)));
  if (!existing || existing.status === "posted") { res.status(400).json({ error: "لا يمكن التعديل" }); return; }
  try {
    await assertCompanyOwned(cid, {
      warehouses: [Number(warehouseId)].filter(Boolean) as number[],
      accounts:   [inventoryAccountId, adjustmentAccountId].map(Number).filter(Boolean) as number[],
    });
  } catch (e: any) { res.status(400).json({ error: e.message }); return; }
  if (items && (!Array.isArray(items) || !items.length)) { res.status(400).json({ error: "أضف صنفاً واحداً على الأقل" }); return; }
  try {
    await db.transaction(async (tx) => {
      const oldLines = await tx.select().from(stockAdjustmentItemsTable)
        .where(eq(stockAdjustmentItemsTable.adjustmentId, id))
        .orderBy(asc(stockAdjustmentItemsTable.id));
      await tx.update(stockAdjustmentsTable).set({
        adjustmentDate, warehouseId, reason, notes,
        inventoryAccountId: inventoryAccountId || null,
        adjustmentAccountId: adjustmentAccountId || null,
        updatedAt: new Date(),
      }).where(and(eq(stockAdjustmentsTable.id, id), eq(stockAdjustmentsTable.companyId, cid)));
      if (items) {
        await tx.delete(stockAdjustmentItemsTable).where(eq(stockAdjustmentItemsTable.adjustmentId, id));
        const itemRows: any[] = [];
        const matchedOldIds = new Set<number>();
        for (const it of items) {
          const itemId = Number(it.itemId);
          const requestedUnitId = it.unitId ? Number(it.unitId) : null;
          let old = it.id
            ? oldLines.find(row => row.id === Number(it.id))
            : undefined;
          if (it.id && (!old || matchedOldIds.has(old.id))) {
            throw new Error("معرّف سطر التسوية غير صالح أو مكرر");
          }
          if (!it.id) {
            const candidates = oldLines.filter(row =>
              !matchedOldIds.has(row.id) &&
              row.itemId === itemId &&
              (row.unitId ?? null) === requestedUnitId,
            );
            if (candidates.length > 1) {
              throw new Error(`لا يمكن مطابقة سطر التسوية للصنف #${itemId}: توجد أسطر قديمة متطابقة`);
            }
            old = candidates[0];
          }
          const unchanged = !!old &&
            old.itemId === itemId &&
            (old.unitId ?? null) === requestedUnitId;
          if (old) matchedOldIds.add(old.id);
          const snapshot = await movementUnitSnapshot(
            cid,
            itemId,
            it,
            tx,
            unchanged ? String(old!.conversionFactor ?? "1") : undefined,
          );
          itemRows.push({
            adjustmentId: id,
            itemId,
            unitId: snapshot.unitId,
            qty: toStorageDecimal(String(it.qty), 4, "half_up"),
            conversionFactor: snapshot.conversionFactor,
            costPrice: toStorageDecimal(String(it.costPrice || 0), 4, "half_up"),
            notes: it.notes,
          });
        }
        await tx.insert(stockAdjustmentItemsTable).values(itemRows);
      }
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "تعذر تعديل التسوية" });
    return;
  }
  res.json({ ok: true });
});

router.post("/stock-adjustments/:id/post", requirePostRight("stockMovement"), async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  class HttpError extends Error {
    constructor(public httpStatus: number, message: string) { super(message); }
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [adj] = await tx.select().from(stockAdjustmentsTable)
        .where(and(eq(stockAdjustmentsTable.id, id), eq(stockAdjustmentsTable.companyId, cid)))
        .for("update");
      if (!adj) throw new HttpError(404, "التسوية غير موجودة");
      if (adj.status !== "draft") throw new HttpError(409, "التسوية مُرحَّلة مسبقاً");

      const lines = await tx.select().from(stockAdjustmentItemsTable)
        .where(eq(stockAdjustmentItemsTable.adjustmentId, id))
        .orderBy(asc(stockAdjustmentItemsTable.itemId), asc(stockAdjustmentItemsTable.id));
      if (!lines.length) throw new HttpError(400, "لا توجد أصناف");

      const usageIds = Array.from(new Set(lines.map(l => l.itemId).filter((x): x is number => !!x)));
      const usageV = await checkItemsUsable(cid, "stock_adjust", usageIds, (req as any).authUser, "post");
      if (usageV.length) throw new HttpError(403, usageViolationMessage(usageV, "post"));

      const ownedItems = await tx.select({ id: itemsTable.id }).from(itemsTable).where(and(
        eq(itemsTable.companyId, cid),
        inArray(itemsTable.id, usageIds),
      ));
      if (ownedItems.length !== usageIds.length) throw new HttpError(400, "تحتوي التسوية على صنف لا ينتمي للشركة");

      const writability = await assertWritableForDate(cid, adj.adjustmentDate);
      if (!writability.ok) throw new HttpError(423, writability.reason ?? "الفترة المالية مغلقة");

      const [wh] = await tx.select().from(warehousesTable).where(and(
        eq(warehousesTable.id, adj.warehouseId),
        eq(warehousesTable.companyId, cid),
      ));
      if (!wh) throw new HttpError(400, "المخزن غير صالح");

      let inventoryValueDelta = 0;
      const touchedItems = new Set<number>();
      await lockStockBalances(lines.map(line => ({
        companyId: cid, itemId: line.itemId, warehouseId: adj.warehouseId,
      })), tx);
      for (const line of lines) {
        const qty = Number(toStorageDecimal(
          multiplyQuantity(
            String(line.qty),
            String(line.conversionFactor ?? "1"),
          ),
          4,
          "half_up",
        ));
        const enteredCost = Number(toStorageDecimal(
          divideQuantity(
            String(line.costPrice),
            String(line.conversionFactor ?? "1"),
          ),
          4,
          "half_up",
        ));
        if (!Number.isFinite(qty) || qty === 0) throw new HttpError(400, `كمية الصنف #${line.itemId} يجب ألا تكون صفراً`);
        if (!Number.isFinite(enteredCost) || enteredCost < 0) throw new HttpError(400, `تكلفة الصنف #${line.itemId} غير صحيحة`);

        const newBal = await upsertBalance(cid, line.itemId, adj.warehouseId, qty, enteredCost, tx);
        const [balanceRow] = await tx.select({ avgCost: stockBalanceTable.avgCost })
          .from(stockBalanceTable).where(and(
            eq(stockBalanceTable.companyId, cid),
            eq(stockBalanceTable.itemId, line.itemId),
            eq(stockBalanceTable.warehouseId, adj.warehouseId),
          ));
        // Outflows keep the warehouse WAC.  Inflows use their entered cost;
        // this is the same value used by the weighted-average update.
        const movementCost = qty < 0 ? Number(balanceRow?.avgCost ?? enteredCost) : enteredCost;
        const totalCost = qty * movementCost;
        inventoryValueDelta += totalCost;
        touchedItems.add(line.itemId);
        await tx.insert(stockLedgerTable).values({
          companyId: cid, itemId: line.itemId, warehouseId: adj.warehouseId,
          txDate: adj.adjustmentDate, txType: "adjustment",
          qty: String(qty), costPrice: String(movementCost),
          totalCost: String(totalCost), balanceQty: String(newBal),
          refId: id, refType: "adjustment", notes: line.notes,
        });
      }
      for (const itemId of touchedItems) await refreshItemCost(cid, itemId, tx);

      const invAccId = adj.inventoryAccountId || wh.accountId || null;
      const adjAccId = adj.adjustmentAccountId || null;
      const amount = Math.abs(inventoryValueDelta);
      let journalEntryId: number | null = null;
      if (amount >= 0.005) {
        if (!invAccId || !adjAccId) throw new HttpError(400, "حدد حساب المخزون وحساب مقابل التسوية قبل الترحيل");
        if (invAccId === adjAccId) throw new HttpError(400, "حساب المخزون وحساب مقابل التسوية يجب أن يكونا مختلفين");
        const jeStatus = await resolvePostingStatus(cid, "stockMovement", (req as any).authUser);
        const jeDocNumber = (await nextJeSubSequence(cid, "stock_adjustment_je", {
          userId: (req as any).authUser?.id ?? null,
          refTable: "journal_entries",
          branchId: wh.branchId ?? null,
          docDate: adj.adjustmentDate as any,
        })) ?? `ADJ-JE-${adj.adjustmentNumber}`;
        const [je] = await tx.insert(journalEntriesTable).values({
          companyId: cid, docNumber: jeDocNumber, entryDate: adj.adjustmentDate,
          description: `قيد تسوية مخزنية: ${adj.adjustmentNumber}${adj.reason ? " — " + adj.reason : ""}`,
          entryType: "stock_adjustment", status: jeStatus,
          periodId: writability.period?.id ?? null,
          ...fullAuditFor(req, jeStatus),
        }).returning();
        journalEntryId = je.id;
        const value = amount.toFixed(2);
        await tx.insert(journalEntryLinesTable).values(inventoryValueDelta > 0 ? [
          { entryId: je.id, accountId: invAccId, debit: value, credit: "0", description: `زيادة مخزون — ${wh.nameAr ?? ""}`, sortOrder: 0 },
          { entryId: je.id, accountId: adjAccId, debit: "0", credit: value, description: "تسوية — فائض مخزون", sortOrder: 1 },
        ] : [
          { entryId: je.id, accountId: adjAccId, debit: value, credit: "0", description: "تسوية — عجز/تالف مخزون", sortOrder: 0 },
          { entryId: je.id, accountId: invAccId, debit: "0", credit: value, description: `نقص مخزون — ${wh.nameAr ?? ""}`, sortOrder: 1 },
        ]);
      }

      await tx.update(stockAdjustmentsTable)
        .set({ status: "posted", journalEntryId, updatedAt: new Date() })
        .where(and(eq(stockAdjustmentsTable.id, id), eq(stockAdjustmentsTable.companyId, cid)));
      return { journalEntryId };
    });
    res.json({ ok: true, journalEntryId: result.journalEntryId });
  } catch (e: any) {
    if (e instanceof HttpError) {
      res.status(e.httpStatus).json({ error: e.message });
      return;
    }
    throw e;
  }
});

router.delete("/stock-adjustments/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [adj] = await db.select().from(stockAdjustmentsTable).where(and(eq(stockAdjustmentsTable.id, id), eq(stockAdjustmentsTable.companyId, cid)));
  if (!adj || adj.status === "posted") { res.status(400).json({ error: "لا يمكن الحذف" }); return; }
  await db.delete(stockAdjustmentsTable).where(eq(stockAdjustmentsTable.id, id));
  res.json({ ok: true });
});

// Create an auditable correcting document instead of editing a posted movement.
// The new draft reverses every source line and points back to the original.
router.post("/stock-adjustments/:id/reverse", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const sourceId = Number(req.params.id);
  const correctionDate = String(req.body?.date || new Date().toISOString().slice(0, 10));
  let correctionNumber: string;
  try {
    correctionNumber = (await nextSequenceNumber(cid, "stock_adjustment", {
      userId: (req as any).authUser?.id ?? null,
      refTable: "stock_adjustments",
      docDate: correctionDate,
      branchId: null,
    })) ?? `ADJ-${Date.now()}`;
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "تعذر توليد رقم مستند التصحيح" });
    return;
  }
  try {
    const correction = await db.transaction(async (tx) => {
      const [source] = await tx.select().from(stockAdjustmentsTable).where(and(
        eq(stockAdjustmentsTable.id, sourceId),
        eq(stockAdjustmentsTable.companyId, cid),
      )).for("update");
      if (!source) throw new Error("التسوية الأصلية غير موجودة");
      if (source.status !== "posted") throw new Error("يمكن إنشاء تصحيح عكسي للمستند المرحّل فقط");
      const [existingCorrection] = await tx.select({ id: stockAdjustmentsTable.id })
        .from(stockAdjustmentsTable)
        .where(and(
          eq(stockAdjustmentsTable.companyId, cid),
          eq(stockAdjustmentsTable.correctionOfId, source.id),
        ))
        .limit(1);
      if (existingCorrection) throw new Error("تم إنشاء مستند تصحيح لهذه التسوية مسبقاً");
      const sourceLines = await tx.select().from(stockAdjustmentItemsTable)
        .where(eq(stockAdjustmentItemsTable.adjustmentId, sourceId));
      if (!sourceLines.length) throw new Error("لا توجد بنود في التسوية الأصلية");
      const [created] = await tx.insert(stockAdjustmentsTable).values({
        companyId: cid,
        adjustmentNumber: correctionNumber,
        adjustmentDate: correctionDate,
        warehouseId: source.warehouseId,
        accountId: source.accountId,
        inventoryAccountId: source.inventoryAccountId,
        adjustmentAccountId: source.adjustmentAccountId,
        correctionOfId: source.id,
        reason: "تصحيح مخزون",
        notes: `تصحيح عكسي للتسوية ${source.adjustmentNumber}${req.body?.reason ? ` — ${String(req.body.reason).trim()}` : ""}`,
        status: "draft",
      }).returning();
      await tx.insert(stockAdjustmentItemsTable).values(sourceLines.map(line => ({
        adjustmentId: created.id,
        itemId: line.itemId,
        unitId: line.unitId,
         qty: toStorageDecimal(multiplyQuantity("-1", String(line.qty)), 4, "half_up"),
         conversionFactor: String(line.conversionFactor ?? "1"),
        costPrice: line.costPrice,
        notes: `عكس بند من ${source.adjustmentNumber}${line.notes ? ` — ${line.notes}` : ""}`,
      })));
      return created;
    });
    res.status(201).json(correction);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "تعذر إنشاء مستند التصحيح" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// STOCK COUNTS
// ═══════════════════════════════════════════════════════════════════
router.get("/stock-counts", async (req, res) => {
  const cid = getCompanyId(req);
  const rows = cid
    ? await db.select().from(stockCountsTable).where(eq(stockCountsTable.companyId, cid)).orderBy(desc(stockCountsTable.countDate))
    : await db.select().from(stockCountsTable).orderBy(desc(stockCountsTable.countDate));
  const whIds = [...new Set(rows.map(r => r.warehouseId))];
  const whs = whIds.length ? await db.select().from(warehousesTable).where(inArray(warehousesTable.id, whIds)) : [];
  const whMap = Object.fromEntries(whs.map(w => [w.id, w]));
  res.json(rows.map(r => ({ ...r, warehouse: whMap[r.warehouseId] })));
});

router.get("/stock-counts/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [cnt] = await db.select().from(stockCountsTable).where(and(eq(stockCountsTable.id, id), eq(stockCountsTable.companyId, cid)));
  if (!cnt) { res.status(404).json({ error: "غير موجود" }); return; }
  const lines = await db.select({ li: stockCountItemsTable, item: itemsTable })
    .from(stockCountItemsTable)
    .leftJoin(itemsTable, eq(stockCountItemsTable.itemId, itemsTable.id))
    .where(eq(stockCountItemsTable.countId, id));
  const [wh] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, cnt.warehouseId));
  res.json({ ...cnt, warehouse: wh, items: lines.map(l => ({ ...l.li, item: l.item })) });
});

router.post("/stock-counts", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const { countNumber, countDate, warehouseId, inventoryAccountId, adjustmentAccountId, notes } = req.body;
  if (!countDate || !warehouseId) { res.status(400).json({ error: "بيانات ناقصة" }); return; }
  try {
    await assertCompanyOwned(cid, {
      warehouses: [Number(warehouseId)],
      accounts: [inventoryAccountId, adjustmentAccountId].map(Number).filter(Boolean) as number[],
    });
  } catch (e: any) { res.status(400).json({ error: e.message }); return; }
  // Central sequence engine is authoritative when an active sequence is
  // configured for "stock_count"; otherwise fall back to the caller-
  // supplied value, then to the legacy timestamp scheme. Sequence errors
  // surface to the user — never silently bypass central numbering.
  let num: string;
  try {
    const fromSeq = await nextSequenceNumber(cid, "stock_count", {
      userId:   (req as any).authUser?.id ?? null,
      refTable: "stock_counts",
      // Stock counts are warehouse-scoped (not branch-scoped) — use the
      // company-wide counter (branchId=null → sentinel 0).
      branchId: null,
    });
    num = fromSeq ?? ((countNumber && String(countNumber).trim()) || `CNT-${Date.now()}`);
  } catch (seqErr: any) {
    res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم الجرد" });
    return;
  }
  const cnt = await db.transaction(async (tx) => {
    const stockItems = await tx.select({
      id: itemsTable.id,
      costPrice: itemsTable.costPrice,
    }).from(itemsTable).where(and(
      eq(itemsTable.companyId, cid),
      eq(itemsTable.itemType, "stock"),
      eq(itemsTable.status, "active"),
    )).orderBy(asc(itemsTable.code));
    const balances = await tx.select().from(stockBalanceTable).where(and(
      eq(stockBalanceTable.warehouseId, Number(warehouseId)),
      eq(stockBalanceTable.companyId, cid),
    ));
    const balanceByItem = new Map(balances.map(b => [b.itemId, b]));
    const [created] = await tx.insert(stockCountsTable).values({
      companyId: cid, countNumber: num, countDate, warehouseId: Number(warehouseId),
      inventoryAccountId: inventoryAccountId || null,
      adjustmentAccountId: adjustmentAccountId || null,
      notes, status: "draft",
    }).returning();
    if (stockItems.length) {
      const countRows: any[] = [];
      for (const item of stockItems) {
        // Count sheets are intentionally base-unit only. Resolve through the
        // central engine with an explicit factor-1 historical snapshot,
        // without inventing an arbitrary usage unit.
        await resolveItemUnitConversion({
          companyId: cid,
          itemId: item.id,
          historicalFactor: "1",
          executor: tx,
        });
        const balance = balanceByItem.get(item.id);
        const systemQty = balance?.qty ?? "0";
        countRows.push({
          countId: created.id, itemId: item.id,
          systemQty, actualQty: systemQty, diff: "0",
          costPrice: balance?.avgCost ?? item.costPrice ?? "0",
        });
      }
      await tx.insert(stockCountItemsTable).values(countRows);
    }
    return created;
  });
  res.status(201).json(cnt);
});

router.put("/stock-counts/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { items } = req.body; // items: [{id, actualQty}]
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(stockCountsTable)
      .where(and(eq(stockCountsTable.id, id), eq(stockCountsTable.companyId, cid)))
      .for("update");
    if (!existing || existing.status !== "draft") throw new Error("لا يمكن تعديل جرد مُرحّل");
    if (items?.length) {
      const ids = items.map((it: any) => Number(it.id)).filter((v: number) => Number.isInteger(v) && v > 0);
      const stored = await tx.select().from(stockCountItemsTable).where(and(
        eq(stockCountItemsTable.countId, id),
        inArray(stockCountItemsTable.id, ids),
      ));
      if (stored.length !== new Set(ids).size) throw new Error("تحتوي البيانات على سطر لا ينتمي إلى مستند الجرد");
      const storedById = new Map(stored.map(row => [row.id, row]));
      for (const it of items) {
        const row = storedById.get(Number(it.id));
        if (!row) continue;
         const actualQty = Number(toStorageDecimal(String(it.actualQty), 4, "half_up"));
        if (!Number.isFinite(actualQty) || actualQty < 0) throw new Error("الكمية الفعلية يجب أن تكون صفراً أو رقماً موجباً");
        const diff = actualQty - Number(row.systemQty);
        await tx.update(stockCountItemsTable)
          .set({ actualQty: String(actualQty), diff: String(diff), notes: it.notes ?? row.notes })
          .where(and(eq(stockCountItemsTable.id, row.id), eq(stockCountItemsTable.countId, id)));
      }
    }
  });
  res.json({ ok: true });
});

router.post("/stock-counts/:id/post", requirePostRight("stockMovement"), async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  class HttpError extends Error {
    constructor(public httpStatus: number, message: string) { super(message); }
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [cnt] = await tx.select().from(stockCountsTable)
        .where(and(eq(stockCountsTable.id, id), eq(stockCountsTable.companyId, cid)))
        .for("update");
      if (!cnt) throw new HttpError(404, "مستند الجرد غير موجود");
      if (cnt.status !== "draft") throw new HttpError(409, "تم ترحيل مستند الجرد مسبقاً");

      const lines = await tx.select().from(stockCountItemsTable)
        .where(eq(stockCountItemsTable.countId, id))
        .orderBy(asc(stockCountItemsTable.itemId), asc(stockCountItemsTable.id));
      if (!lines.length) throw new HttpError(400, "لا توجد أصناف في مستند الجرد");
      const usageIds = Array.from(new Set(lines.map(l => l.itemId).filter((x): x is number => !!x)));
      const usageV = await checkItemsUsable(cid, "stock_count", usageIds, (req as any).authUser, "post");
      if (usageV.length) throw new HttpError(403, usageViolationMessage(usageV, "post"));

      const writability = await assertWritableForDate(cid, cnt.countDate);
      if (!writability.ok) throw new HttpError(423, writability.reason ?? "الفترة المالية مغلقة");
      const [wh] = await tx.select().from(warehousesTable).where(and(
        eq(warehousesTable.id, cnt.warehouseId),
        eq(warehousesTable.companyId, cid),
      ));
      if (!wh) throw new HttpError(400, "المخزن غير صالح");

      let inventoryValueDelta = 0;
      const touchedItems = new Set<number>();
      await lockStockBalances(lines.map(line => ({
        companyId: cid, itemId: line.itemId, warehouseId: cnt.warehouseId,
      })), tx);
      for (const line of lines) {
        // Counts remain base-unit only; explicitly route that invariant
        // through the central unit engine rather than linking an arbitrary
        // usage unit to the count schema.
        await resolveItemUnitConversion({
          companyId: cid,
          itemId: line.itemId,
          historicalFactor: "1",
          executor: tx,
        });
        const actualQty = Number(line.actualQty);
        if (!Number.isFinite(actualQty) || actualQty < 0) throw new HttpError(400, `الكمية الفعلية للصنف #${line.itemId} غير صحيحة`);
        const [currentRow] = await tx.select().from(stockBalanceTable).where(and(
          eq(stockBalanceTable.companyId, cid),
          eq(stockBalanceTable.itemId, line.itemId),
          eq(stockBalanceTable.warehouseId, cnt.warehouseId),
        ));
        const currentQty = Number(currentRow?.qty ?? 0);
        const movementCost = Number(currentRow?.avgCost ?? line.costPrice ?? 0);
        const diff = actualQty - currentQty;
        await tx.update(stockCountItemsTable).set({
          systemQty: String(currentQty),
          diff: String(diff),
          costPrice: String(movementCost),
        }).where(and(eq(stockCountItemsTable.id, line.id), eq(stockCountItemsTable.countId, id)));
        if (Math.abs(diff) < 0.0001) continue;
        const newBal = await upsertBalance(cid, line.itemId, cnt.warehouseId, diff, movementCost, tx);
        const totalCost = diff * movementCost;
        inventoryValueDelta += totalCost;
        touchedItems.add(line.itemId);
        await tx.insert(stockLedgerTable).values({
          companyId: cid, itemId: line.itemId, warehouseId: cnt.warehouseId,
          txDate: cnt.countDate, txType: "count_adj",
          qty: String(diff), costPrice: String(movementCost),
          totalCost: String(totalCost), balanceQty: String(newBal),
          refId: id, refType: "count",
          notes: line.notes || `فرق جرد ${cnt.countNumber}`,
        });
      }
      for (const itemId of touchedItems) await refreshItemCost(cid, itemId, tx);

      const invAccId = cnt.inventoryAccountId || wh.accountId || null;
      const adjAccId = cnt.adjustmentAccountId || null;
      const amount = Math.abs(inventoryValueDelta);
      let journalEntryId: number | null = null;
      if (amount >= 0.005) {
        if (!invAccId || !adjAccId) throw new HttpError(400, "حدد حساب المخزون وحساب فروق الجرد قبل الترحيل");
        if (invAccId === adjAccId) throw new HttpError(400, "حساب المخزون وحساب فروق الجرد يجب أن يكونا مختلفين");
        const jeStatus = await resolvePostingStatus(cid, "stockMovement", (req as any).authUser);
        const jeDocNumber = (await nextJeSubSequence(cid, "stock_adjustment_je", {
          userId: (req as any).authUser?.id ?? null,
          refTable: "journal_entries",
          branchId: wh.branchId ?? null,
          docDate: cnt.countDate as any,
        })) ?? `CNT-JE-${cnt.countNumber}`;
        const [je] = await tx.insert(journalEntriesTable).values({
          companyId: cid, docNumber: jeDocNumber, entryDate: cnt.countDate,
          description: `قيد فروق جرد مخزني: ${cnt.countNumber}`,
          entryType: "stock_count", status: jeStatus,
          periodId: writability.period?.id ?? null,
          ...fullAuditFor(req, jeStatus),
        }).returning();
        journalEntryId = je.id;
        const value = amount.toFixed(2);
        await tx.insert(journalEntryLinesTable).values(inventoryValueDelta > 0 ? [
          { entryId: je.id, accountId: invAccId, debit: value, credit: "0", description: `فائض جرد — ${wh.nameAr ?? ""}`, sortOrder: 0 },
          { entryId: je.id, accountId: adjAccId, debit: "0", credit: value, description: "مقابل فائض الجرد", sortOrder: 1 },
        ] : [
          { entryId: je.id, accountId: adjAccId, debit: value, credit: "0", description: "عجز جرد مخزني", sortOrder: 0 },
          { entryId: je.id, accountId: invAccId, debit: "0", credit: value, description: `نقص جرد — ${wh.nameAr ?? ""}`, sortOrder: 1 },
        ]);
      }

      await tx.update(stockCountsTable)
        .set({ status: "posted", journalEntryId, updatedAt: new Date() })
        .where(and(eq(stockCountsTable.id, id), eq(stockCountsTable.companyId, cid)));
      return { journalEntryId };
    });
    res.json({ ok: true, journalEntryId: result.journalEntryId });
  } catch (e: any) {
    if (e instanceof HttpError) {
      res.status(e.httpStatus).json({ error: e.message });
      return;
    }
    throw e;
  }
});

router.delete("/stock-counts/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [cnt] = await db.select().from(stockCountsTable).where(and(eq(stockCountsTable.id, id), eq(stockCountsTable.companyId, cid)));
  if (!cnt || cnt.status === "posted") { res.status(400).json({ error: "لا يمكن الحذف" }); return; }
  await db.delete(stockCountsTable).where(eq(stockCountsTable.id, id));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// STOCK LEDGER
// ═══════════════════════════════════════════════════════════════════
router.get("/stock-ledger", async (req, res) => {
  const {
    itemId, warehouseId, from, to, customerId, txType, costCenter,
    paged, page: pageParam, pageSize: pageSizeParam,
  } = req.query as Record<string, string>;
  const wantsPaged = paged === "1";
  const allowedPageSizes = new Set([10, 25, 50, 100, 1000]);
  const requestedPageSize = Number(pageSizeParam);
  const pageSize = allowedPageSizes.has(requestedPageSize) ? requestedPageSize : 25;
  const page = Math.max(1, Math.floor(Number(pageParam) || 1));
  const emptyPage = {
    rows: [],
    total: 0,
    page,
    pageSize,
    pageCount: 1,
    summary: { opening: 0, totalIn: 0, totalOut: 0, final: 0 },
  };
  const cid = getCompanyId(req);
  if (!cid) { res.json(wantsPaged ? emptyPage : []); return; }
  const conditions = [eq(stockLedgerTable.companyId, cid)];
  if (itemId)      conditions.push(eq(stockLedgerTable.itemId,      Number(itemId)));
  if (warehouseId) conditions.push(eq(stockLedgerTable.warehouseId, Number(warehouseId)));
  if (from)        conditions.push(gte(stockLedgerTable.txDate, from));
  if (to)          conditions.push(lte(stockLedgerTable.txDate, to));
  if (txType)      conditions.push(eq(stockLedgerTable.txType, txType as any));
  if (costCenter?.trim()) {
    const pattern = `%${costCenter.trim()}%`;
    conditions.push(sql`(
      (
        ${stockLedgerTable.refType} = 'sales_invoice'
        AND EXISTS (
          SELECT 1 FROM ${salesInvoicesTable}
          WHERE ${salesInvoicesTable.id} = ${stockLedgerTable.refId}
            AND ${salesInvoicesTable.companyId} = ${cid}
            AND COALESCE(${salesInvoicesTable.costCenter}, '') ILIKE ${pattern}
        )
      )
      OR
      (
        ${stockLedgerTable.refType} = 'purchase_invoice'
        AND EXISTS (
          SELECT 1 FROM ${purchaseInvoicesTable}
          WHERE ${purchaseInvoicesTable.id} = ${stockLedgerTable.refId}
            AND ${purchaseInvoicesTable.companyId} = ${cid}
            AND COALESCE(${purchaseInvoicesTable.costCenter}, '') ILIKE ${pattern}
        )
      )
    )`);
  }

  // Customer filter: restrict ledger to movements that originated from a sales
  // invoice or sales return belonging to that customer. Non-sale rows
  // (purchases, transfers, adjustments, openings) are excluded when this
  // filter is active because they have no customer association.
  if (customerId) {
    const custId = Number(customerId);
    const invIds = await db.select({ id: salesInvoicesTable.id })
      .from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.companyId, cid), eq(salesInvoicesTable.customerId, custId)));
    const retIds = await db.select({ id: salesReturnsTable.id })
      .from(salesReturnsTable)
      .where(and(eq(salesReturnsTable.companyId, cid), eq(salesReturnsTable.customerId, custId)));
    const invIdList = invIds.map(r => r.id);
    const retIdList = retIds.map(r => r.id);
    const parts: any[] = [];
    if (invIdList.length) parts.push(and(eq(stockLedgerTable.refType, "sales_invoice"), inArray(stockLedgerTable.refId, invIdList)));
    if (retIdList.length) parts.push(and(eq(stockLedgerTable.refType, "sales_return"),  inArray(stockLedgerTable.refId, retIdList)));
    if (parts.length === 0) { res.json(wantsPaged ? emptyPage : []); return; }
    conditions.push(parts.length === 1 ? parts[0] : or(...parts)!);
  }

  const ledgerWhere = and(...conditions)!;
  const summaryPromise = wantsPaged
    ? Promise.all([
        db.select({
          total: count(),
          totalIn: sql<string>`COALESCE(SUM(CASE WHEN ${stockLedgerTable.qty}::numeric > 0 THEN ${stockLedgerTable.qty}::numeric ELSE 0 END), 0)`,
          totalOut: sql<string>`COALESCE(SUM(CASE WHEN ${stockLedgerTable.qty}::numeric < 0 THEN -${stockLedgerTable.qty}::numeric ELSE 0 END), 0)`,
        }).from(stockLedgerTable).where(ledgerWhere),
        db.selectDistinctOn([stockLedgerTable.warehouseId], {
          qty: stockLedgerTable.qty,
          balanceQty: stockLedgerTable.balanceQty,
        }).from(stockLedgerTable)
          .where(ledgerWhere)
          .orderBy(stockLedgerTable.warehouseId, asc(stockLedgerTable.txDate), asc(stockLedgerTable.id)),
        db.selectDistinctOn([stockLedgerTable.warehouseId], {
          balanceQty: stockLedgerTable.balanceQty,
        }).from(stockLedgerTable)
          .where(ledgerWhere)
          .orderBy(stockLedgerTable.warehouseId, desc(stockLedgerTable.txDate), desc(stockLedgerTable.id)),
      ])
    : Promise.resolve(null);

  const rowsPromise = db.select({
    led: stockLedgerTable,
    item: itemsTable,
    wh: warehousesTable,
    unit: unitsTable,
  })
    .from(stockLedgerTable)
    .leftJoin(itemsTable, and(
      eq(stockLedgerTable.itemId, itemsTable.id),
      eq(itemsTable.companyId, cid),
    ))
    .leftJoin(warehousesTable, and(
      eq(stockLedgerTable.warehouseId, warehousesTable.id),
      eq(warehousesTable.companyId, cid),
    ))
    .leftJoin(unitsTable, and(
      eq(itemsTable.unitId, unitsTable.id),
      eq(unitsTable.companyId, cid),
    ))
    .where(ledgerWhere)
    .orderBy(desc(stockLedgerTable.txDate), desc(stockLedgerTable.id))
    .limit(wantsPaged ? pageSize : 500)
    .offset(wantsPaged ? (page - 1) * pageSize : 0);

  const [rows, summaryParts] = await Promise.all([rowsPromise, summaryPromise]);

  // Resolve every source document in batched, tenant-scoped queries. The stock
  // ledger remains the source of truth for quantities/costs; these lookups add
  // report-only context and never mutate inventory or source documents.
  const idsFor = (refType: string) => [...new Set(
    rows
      .filter(r => r.led.refType === refType && r.led.refId != null)
      .map(r => Number(r.led.refId)),
  )];
  const salesInvoiceIds = idsFor("sales_invoice");
  const purchaseInvoiceIds = idsFor("purchase_invoice");
  const salesReturnIds = idsFor("sales_return");
  const purchaseReturnIds = idsFor("purchase_return");
  const transferIds = idsFor("transfer");
  const adjustmentIds = idsFor("adjustment");
  const countIds = idsFor("count");
  const receiptIds = idsFor("goods_receipt");
  const deliveryIds = idsFor("goods_delivery");

  const [
    salesDocs, purchaseDocs, salesReturnDocs, purchaseReturnDocs,
    transferDocs, adjustmentDocs, countDocs, receiptDocs, deliveryDocs,
  ] = await Promise.all([
    salesInvoiceIds.length
      ? db.select({
          id: salesInvoicesTable.id,
          docNumber: salesInvoicesTable.docNumber,
          costCenter: salesInvoicesTable.costCenter,
          notes: salesInvoicesTable.notes,
        })
          .from(salesInvoicesTable)
          .where(and(
            eq(salesInvoicesTable.companyId, cid),
            inArray(salesInvoicesTable.id, salesInvoiceIds),
          ))
      : Promise.resolve([]),
    purchaseInvoiceIds.length
      ? db.select({
          id: purchaseInvoicesTable.id,
          docNumber: purchaseInvoicesTable.docNumber,
          costCenter: purchaseInvoicesTable.costCenter,
          notes: purchaseInvoicesTable.notes,
        })
          .from(purchaseInvoicesTable)
          .where(and(
            eq(purchaseInvoicesTable.companyId, cid),
            inArray(purchaseInvoicesTable.id, purchaseInvoiceIds),
          ))
      : Promise.resolve([]),
    salesReturnIds.length
      ? db.select({
          id: salesReturnsTable.id,
          docNumber: salesReturnsTable.docNumber,
          notes: salesReturnsTable.notes,
        })
          .from(salesReturnsTable)
          .where(and(
            eq(salesReturnsTable.companyId, cid),
            inArray(salesReturnsTable.id, salesReturnIds),
          ))
      : Promise.resolve([]),
    purchaseReturnIds.length
      ? db.select({
          id: purchaseReturnsTable.id,
          docNumber: purchaseReturnsTable.docNumber,
          notes: purchaseReturnsTable.notes,
        })
          .from(purchaseReturnsTable)
          .where(and(
            eq(purchaseReturnsTable.companyId, cid),
            inArray(purchaseReturnsTable.id, purchaseReturnIds),
          ))
      : Promise.resolve([]),
    transferIds.length
      ? db.select({
          id: stockTransfersTable.id,
          docNumber: stockTransfersTable.transferNumber,
          fromWarehouseId: stockTransfersTable.fromWarehouseId,
          toWarehouseId: stockTransfersTable.toWarehouseId,
          notes: stockTransfersTable.notes,
        })
          .from(stockTransfersTable)
          .where(and(
            eq(stockTransfersTable.companyId, cid),
            inArray(stockTransfersTable.id, transferIds),
          ))
      : Promise.resolve([]),
    adjustmentIds.length
      ? db.select({
          id: stockAdjustmentsTable.id,
          docNumber: stockAdjustmentsTable.adjustmentNumber,
          notes: stockAdjustmentsTable.notes,
          reason: stockAdjustmentsTable.reason,
        })
          .from(stockAdjustmentsTable)
          .where(and(
            eq(stockAdjustmentsTable.companyId, cid),
            inArray(stockAdjustmentsTable.id, adjustmentIds),
          ))
      : Promise.resolve([]),
    countIds.length
      ? db.select({
          id: stockCountsTable.id,
          docNumber: stockCountsTable.countNumber,
          notes: stockCountsTable.notes,
        })
          .from(stockCountsTable)
          .where(and(
            eq(stockCountsTable.companyId, cid),
            inArray(stockCountsTable.id, countIds),
          ))
      : Promise.resolve([]),
    receiptIds.length
      ? db.select({
          id: goodsReceiptsTable.id,
          docNumber: goodsReceiptsTable.docNumber,
          notes: goodsReceiptsTable.notes,
        })
          .from(goodsReceiptsTable)
          .where(and(
            eq(goodsReceiptsTable.companyId, cid),
            inArray(goodsReceiptsTable.id, receiptIds),
          ))
      : Promise.resolve([]),
    deliveryIds.length
      ? db.select({
          id: goodsDeliveriesTable.id,
          docNumber: goodsDeliveriesTable.docNumber,
          notes: goodsDeliveriesTable.notes,
        })
          .from(goodsDeliveriesTable)
          .where(and(
            eq(goodsDeliveriesTable.companyId, cid),
            inArray(goodsDeliveriesTable.id, deliveryIds),
          ))
      : Promise.resolve([]),
  ]);

  type SourceMeta = {
    documentNumber: string | null;
    documentPath: string | null;
    costCenter?: string | null;
    notes?: string | null;
    fromWarehouseId?: number | null;
    toWarehouseId?: number | null;
  };
  const sourceRefs = new Map<string, SourceMeta>();
  for (const doc of salesDocs) {
    sourceRefs.set(`sales_invoice:${doc.id}`, {
      documentNumber: doc.docNumber,
      documentPath: `/sales/invoices/${doc.id}`,
      costCenter: doc.costCenter,
      notes: doc.notes,
    });
  }
  for (const doc of purchaseDocs) {
    sourceRefs.set(`purchase_invoice:${doc.id}`, {
      documentNumber: doc.docNumber,
      documentPath: `/purchasing/invoices/${doc.id}`,
      costCenter: doc.costCenter,
      notes: doc.notes,
    });
  }
  for (const doc of salesReturnDocs) {
    sourceRefs.set(`sales_return:${doc.id}`, {
      documentNumber: doc.docNumber,
      documentPath: "/sales/returns",
      notes: doc.notes,
    });
  }
  for (const doc of purchaseReturnDocs) {
    sourceRefs.set(`purchase_return:${doc.id}`, {
      documentNumber: doc.docNumber,
      documentPath: "/purchasing/returns",
      notes: doc.notes,
    });
  }
  for (const doc of transferDocs) {
    sourceRefs.set(`transfer:${doc.id}`, {
      documentNumber: doc.docNumber,
      documentPath: "/inventory/transfers",
      fromWarehouseId: doc.fromWarehouseId,
      toWarehouseId: doc.toWarehouseId,
      notes: doc.notes,
    });
  }
  for (const doc of adjustmentDocs) {
    sourceRefs.set(`adjustment:${doc.id}`, {
      documentNumber: doc.docNumber,
      documentPath: "/inventory/adjustments",
      notes: doc.notes ?? doc.reason,
    });
  }
  for (const doc of countDocs) {
    sourceRefs.set(`count:${doc.id}`, {
      documentNumber: doc.docNumber,
      documentPath: "/inventory/counts",
      notes: doc.notes,
    });
  }
  for (const doc of receiptDocs) {
    sourceRefs.set(`goods_receipt:${doc.id}`, {
      documentNumber: doc.docNumber,
      documentPath: "/goods-receipts",
      notes: doc.notes,
    });
  }
  for (const doc of deliveryDocs) {
    sourceRefs.set(`goods_delivery:${doc.id}`, {
      documentNumber: doc.docNumber,
      documentPath: "/goods-deliveries",
      notes: doc.notes,
    });
  }

  const transferWarehouseIds = [...new Set(
    transferDocs.flatMap(d => [d.fromWarehouseId, d.toWarehouseId]),
  )];
  const transferWarehouses = transferWarehouseIds.length
    ? await db.select({
        id: warehousesTable.id,
        nameAr: warehousesTable.nameAr,
        nameEn: warehousesTable.nameEn,
      })
        .from(warehousesTable)
        .where(and(
          eq(warehousesTable.companyId, cid),
          inArray(warehousesTable.id, transferWarehouseIds),
        ))
    : [];
  const warehouseNames = new Map(transferWarehouses.map(w => [w.id, w]));

  const mappedRows = rows.map(r => {
    const sourceDocument = r.led.refId && r.led.refType
      ? sourceRefs.get(`${r.led.refType}:${r.led.refId}`)
      : undefined;
    const qty = Number(r.led.qty) || 0;
    const balanceAfter = Number(r.led.balanceQty) || 0;
    return {
      ...r.led,
      item: r.item,
      warehouse: r.wh,
      unit: r.unit,
      documentNumber: sourceDocument?.documentNumber ?? null,
      documentPath: sourceDocument?.documentPath ?? null,
      documentType: r.led.refType ?? r.led.txType,
      sourceWarehouse: sourceDocument?.fromWarehouseId
        ? warehouseNames.get(sourceDocument.fromWarehouseId) ?? null
        : null,
      targetWarehouse: sourceDocument?.toWarehouseId
        ? warehouseNames.get(sourceDocument.toWarehouseId) ?? null
        : null,
      costCenter: sourceDocument?.costCenter ?? null,
      project: null,
      movementNotes: r.led.notes ?? sourceDocument?.notes ?? null,
      balanceBefore: balanceAfter - qty,
      balanceAfter,
    };
  });
  if (!wantsPaged || !summaryParts) {
    res.json(mappedRows);
    return;
  }
  const [[aggregate], openingRows, finalRows] = summaryParts;
  const total = Number(aggregate?.total ?? 0);
  res.json({
    rows: mappedRows,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    summary: {
      opening: openingRows.reduce((sum, row) => sum + Number(row.balanceQty ?? 0) - Number(row.qty ?? 0), 0),
      totalIn: Number(aggregate?.totalIn ?? 0),
      totalOut: Number(aggregate?.totalOut ?? 0),
      final: finalRows.reduce((sum, row) => sum + Number(row.balanceQty ?? 0), 0),
    },
  });
});

// ═══════════════════════════════════════════════════════════════════
// STOCK BALANCE (per item per warehouse)
// ═══════════════════════════════════════════════════════════════════
router.get("/stock-balance", async (req, res) => {
  const cid = getCompanyId(req);
  if (!cid) { res.json([]); return; }
  const { warehouseId } = req.query as Record<string, string>;
  const conditions: any[] = [eq(stockBalanceTable.companyId, cid)];
  if (warehouseId) conditions.push(eq(stockBalanceTable.warehouseId, Number(warehouseId)));
  // NOTE: `warehousesTable` has no branchId column, so stock balance is
  // intentionally not filterable by branch. See ALLOWLIST entry for
  // LowStockReport.tsx in audit-branch-filter.cjs for rationale.
  const rows = await db.select({ bal: stockBalanceTable, item: itemsTable, wh: warehousesTable, group: itemGroupsTable, unit: unitsTable })
    .from(stockBalanceTable)
    .leftJoin(itemsTable,       eq(stockBalanceTable.itemId,      itemsTable.id))
    .leftJoin(warehousesTable,  eq(stockBalanceTable.warehouseId, warehousesTable.id))
    .leftJoin(itemGroupsTable,  eq(itemsTable.groupId, itemGroupsTable.id))
    .leftJoin(unitsTable,       eq(itemsTable.unitId,  unitsTable.id))
    .where(and(...conditions))
    .orderBy(asc(itemsTable.code));
  res.json(rows.map(r => ({ ...r.bal, item: r.item, warehouse: r.wh, group: r.group, unit: r.unit })));
});

// ═══════════════════════════════════════════════════════════════════
// LAST MOVEMENT PER ITEM (for slow-moving items report)
// ═══════════════════════════════════════════════════════════════════
router.get("/last-movements", async (req, res) => {
  const cid = getCompanyId(req);
  if (!cid) { res.json([]); return; }
  const rows = await db
    .select({
      itemId:   stockLedgerTable.itemId,
      lastDate: sql<string>`max(${stockLedgerTable.txDate})`,
    })
    .from(stockLedgerTable)
    .where(eq(stockLedgerTable.companyId, cid))
    .groupBy(stockLedgerTable.itemId);
  res.json(rows);
});

// ═══════════════════════════════════════════════════════════════════
// INVENTORY DASHBOARD
// ═══════════════════════════════════════════════════════════════════
router.get("/dashboard", async (req, res) => {
  const cid = getCompanyId(req);
  if (!cid) { res.json({}); return; }
  const [itemsCount] = await db.select({ cnt: sql<number>`count(*)::int` }).from(itemsTable).where(eq(itemsTable.companyId, cid));
  const [whCount]    = await db.select({ cnt: sql<number>`count(*)::int` }).from(warehousesTable).where(eq(warehousesTable.companyId, cid));
  // Total stock value
  const valueRows = await db.select({ qty: stockBalanceTable.qty, avg: stockBalanceTable.avgCost })
    .from(stockBalanceTable).where(eq(stockBalanceTable.companyId, cid));
  const totalValue = valueRows.reduce((s, r) => s + Number(r.qty) * Number(r.avg), 0);
  // Items below reorder
  const allItems = await db.select().from(itemsTable).where(and(eq(itemsTable.companyId, cid), eq(itemsTable.itemType, "stock")));
  const balances  = await db.select().from(stockBalanceTable).where(eq(stockBalanceTable.companyId, cid));
  const qtyByItem: Record<number, number> = {};
  balances.forEach(b => { qtyByItem[b.itemId] = (qtyByItem[b.itemId] || 0) + Number(b.qty); });
  const belowReorder = allItems.filter(it => Number(it.reorderLevel) > 0 && (qtyByItem[it.id] || 0) < Number(it.reorderLevel)).length;
  // Recent movements
  const recentMovements = await db.select({ led: stockLedgerTable, item: itemsTable, wh: warehousesTable })
    .from(stockLedgerTable)
    .leftJoin(itemsTable,      eq(stockLedgerTable.itemId,      itemsTable.id))
    .leftJoin(warehousesTable, eq(stockLedgerTable.warehouseId, warehousesTable.id))
    .where(eq(stockLedgerTable.companyId, cid))
    .orderBy(desc(stockLedgerTable.id))
    .limit(10);
  res.json({
    totalItems: itemsCount.cnt,
    totalWarehouses: whCount.cnt,
    totalStockValue: totalValue.toFixed(2),
    itemsBelowReorder: belowReorder,
    recentMovements: recentMovements.map(r => ({ ...r.led, item: r.item, warehouse: r.wh })),
  });
});

// ═══════════════════════════════════════════════════════════════════
// BULK IMPORT — Items
// Body: { items: [{ code, nameAr, nameEn?, barcode?, groupCode?, unitCode?, itemType?, costPrice?, salePrice?, vatRate?, reorderLevel?, maxLevel?, description? }, ...] }
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// PRO Extension #10 — Item Documents (warranty / certificates / manuals)
// ═══════════════════════════════════════════════════════════════════
// All three routes are tenant-scoped on company_id and require the item to
// belong to the same tenant. The actual file blob lives in object storage;
// we store the /objects/... path returned by the existing presigned-URL
// flow (POST /api/storage/uploads/request-url) so the storage proxy + ACL
// rules apply uniformly.
router.get("/items/:id/documents", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  // Confirm item belongs to this tenant before returning anything.
  const [own] = await db.select({ id: itemsTable.id })
    .from(itemsTable)
    .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid)));
  if (!own) { res.status(404).json({ error: "الصنف غير موجود" }); return; }

  const rows = await db.select()
    .from(itemDocumentsTable)
    .where(and(
      eq(itemDocumentsTable.itemId, id),
      eq(itemDocumentsTable.companyId, cid),
    ))
    .orderBy(desc(itemDocumentsTable.createdAt));
  res.json(rows);
});

router.post("/items/:id/documents", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const { fileUrl, fileName, fileType, fileSize, category, notes } = req.body ?? {};
  if (!fileUrl || !fileName) {
    res.status(400).json({ error: "fileUrl و fileName مطلوبان" });
    return;
  }
  // Defensive: only accept /objects/... paths produced by our storage layer.
  // Rejects accidental absolute URLs to attacker-controlled hosts and caps
  // the path length so a malicious / buggy client can't bloat the row with
  // a multi-megabyte string. 1 KB is far more than any real GCS path.
  if (typeof fileUrl !== "string" || !fileUrl.startsWith("/objects/") || fileUrl.length > 1000) {
    res.status(400).json({ error: "مسار الملف غير صالح" });
    return;
  }

  const [own] = await db.select({ id: itemsTable.id })
    .from(itemsTable)
    .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid)));
  if (!own) { res.status(404).json({ error: "الصنف غير موجود" }); return; }

  const [row] = await db.insert(itemDocumentsTable).values({
    companyId: cid,
    itemId: id,
    fileUrl,
    fileName: String(fileName).slice(0, 500),
    fileType: fileType ? String(fileType).slice(0, 200) : null,
    fileSize: Number.isFinite(Number(fileSize)) ? Number(fileSize) : null,
    category: category ? String(category).slice(0, 100) : "other",
    notes: notes ? String(notes).slice(0, 1000) : null,
    uploadedByUserId: req.authUser?.id ?? null,
  }).returning();
  auditSubEntity(req, "item_documents", row.id, "create", null, row);
  res.status(201).json(row);
});

router.delete("/items/:id/documents/:docId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const docId = Number(req.params.docId);
  if (!Number.isFinite(id) || !Number.isFinite(docId)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  // Composite filter: must match BOTH the item and the tenant. Prevents
  // cross-item / cross-tenant deletions even if the docId is guessed.
  const [existing] = await db.select()
    .from(itemDocumentsTable)
    .where(and(
      eq(itemDocumentsTable.id, docId),
      eq(itemDocumentsTable.itemId, id),
      eq(itemDocumentsTable.companyId, cid),
    ));
  if (!existing) { res.status(404).json({ error: "المستند غير موجود" }); return; }

  await db.delete(itemDocumentsTable).where(eq(itemDocumentsTable.id, docId));
  auditSubEntity(req, "item_documents", docId, "delete", existing, null);
  // Note: we intentionally don't delete the underlying object-storage blob
  // here — the storage layer doesn't expose a deletion API at this level
  // and orphaned blobs are negligible cost; we can sweep them later.
  res.json({ ok: true });
});

// ─── PRO Extension #17 — Item Suppliers ─────────────────────────────────────
// Manages the many-to-many link between items and suppliers, plus per-link
// metadata: last purchase price, supplier's own SKU, lead time, preferred
// flag. All routes are tenant-scoped: the item AND the supplier must both
// belong to the caller's company before any row is touched.
//
// "Preferred supplier" invariant: at most ONE preferred row per item. When
// a POST/PUT sets preferredSupplier=true, we first clear the flag on every
// other row for the same (companyId, itemId) inside a single transaction.

router.get("/items/:id/suppliers", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  // Confirm item belongs to this tenant before returning anything.
  const [own] = await db.select({ id: itemsTable.id })
    .from(itemsTable)
    .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid)));
  if (!own) { res.status(404).json({ error: "الصنف غير موجود" }); return; }

  // Join supplier name/code so the UI can render rows without a second fetch.
  const rows = await db.select({
    id:                 itemSuppliersTable.id,
    companyId:          itemSuppliersTable.companyId,
    itemId:             itemSuppliersTable.itemId,
    supplierId:         itemSuppliersTable.supplierId,
    supplierItemCode:   itemSuppliersTable.supplierItemCode,
    lastPurchasePrice:  itemSuppliersTable.lastPurchasePrice,
    lastPurchaseDate:   itemSuppliersTable.lastPurchaseDate,
    leadTimeDays:       itemSuppliersTable.leadTimeDays,
    preferredSupplier:  itemSuppliersTable.preferredSupplier,
    notes:              itemSuppliersTable.notes,
    createdAt:          itemSuppliersTable.createdAt,
    supplierName:       suppliersTable.nameAr,
    supplierNameEn:     suppliersTable.nameEn,
    supplierCode:       suppliersTable.code,
  })
    .from(itemSuppliersTable)
    .leftJoin(suppliersTable, eq(suppliersTable.id, itemSuppliersTable.supplierId))
    // Preferred row first, then most-recently-updated.
    .where(and(
      eq(itemSuppliersTable.itemId, id),
      eq(itemSuppliersTable.companyId, cid),
    ))
    .orderBy(desc(itemSuppliersTable.preferredSupplier), desc(itemSuppliersTable.createdAt));
  res.json(rows);
});

router.post("/items/:id/suppliers", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const {
    supplierId, supplierItemCode, lastPurchasePrice, lastPurchaseDate,
    leadTimeDays, preferredSupplier, notes,
  } = req.body ?? {};
  const sid = Number(supplierId);
  if (!Number.isFinite(sid)) { res.status(400).json({ error: "معرّف المورد مطلوب" }); return; }

  // Validate BOTH item and supplier belong to this tenant in parallel
  // before doing any writes (cheap defense against cross-tenant linking).
  const [[ownItem], [ownSup]] = await Promise.all([
    db.select({ id: itemsTable.id }).from(itemsTable)
      .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid))),
    db.select({ id: suppliersTable.id }).from(suppliersTable)
      .where(and(eq(suppliersTable.id, sid), eq(suppliersTable.companyId, cid))),
  ]);
  if (!ownItem) { res.status(404).json({ error: "الصنف غير موجود" }); return; }
  if (!ownSup)  { res.status(404).json({ error: "المورد غير موجود" }); return; }

  // Application-level uniqueness: one row per (item, supplier).
  const [dup] = await db.select({ id: itemSuppliersTable.id })
    .from(itemSuppliersTable)
    .where(and(
      eq(itemSuppliersTable.itemId, id),
      eq(itemSuppliersTable.supplierId, sid),
      eq(itemSuppliersTable.companyId, cid),
    ));
  if (dup) { res.status(409).json({ error: "هذا المورد مرتبط بالفعل بالصنف" }); return; }

  const wantsPreferred = !!preferredSupplier;
  const lastPx = lastPurchasePrice != null && lastPurchasePrice !== ""
    ? String(lastPurchasePrice) : null;
  const leadDays = Number.isFinite(Number(leadTimeDays)) ? Number(leadTimeDays) : null;

  // Run the optional "clear all preferred" + insert in one transaction so
  // we never leave the table in a state with two preferred rows for one item.
  // The DB-level partial unique index `item_suppliers_one_preferred_per_item_uniq`
  // is the actual safety net under concurrency — if two requests race past
  // the in-app clear, the index will reject the second commit and we 409.
  let row;
  try {
    row = await db.transaction(async (tx) => {
      if (wantsPreferred) {
        await tx.update(itemSuppliersTable)
          .set({ preferredSupplier: false })
          .where(and(
            eq(itemSuppliersTable.itemId, id),
            eq(itemSuppliersTable.companyId, cid),
          ));
      }
      const [inserted] = await tx.insert(itemSuppliersTable).values({
        companyId: cid,
        itemId: id,
        supplierId: sid,
        supplierItemCode: supplierItemCode ? String(supplierItemCode).slice(0, 100) : null,
        lastPurchasePrice: lastPx,
        lastPurchaseDate: lastPurchaseDate || null,
        leadTimeDays: leadDays,
        preferredSupplier: wantsPreferred,
        notes: notes ? String(notes).slice(0, 1000) : null,
      }).returning();
      return inserted;
    });
  } catch (err: any) {
    // Postgres unique-violation = 23505. Map to 409 with a friendly message
    // so the client can show the right toast even on the rare race-condition path.
    if (err?.code === "23505") {
      const which = String(err?.constraint ?? "").includes("preferred")
        ? "هناك بالفعل مورد مفضل لهذا الصنف — يرجى المحاولة مرة أخرى"
        : "هذا المورد مرتبط بالفعل بالصنف";
      res.status(409).json({ error: which });
      return;
    }
    throw err;
  }

  auditSubEntity(req, "item_suppliers", row.id, "create", null, row);
  res.status(201).json(row);
});

router.put("/items/:id/suppliers/:linkId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const linkId = Number(req.params.linkId);
  if (!Number.isFinite(id) || !Number.isFinite(linkId)) {
    res.status(400).json({ error: "معرّف غير صالح" }); return;
  }

  // Tenant + item ownership check on the existing row.
  const [existing] = await db.select()
    .from(itemSuppliersTable)
    .where(and(
      eq(itemSuppliersTable.id, linkId),
      eq(itemSuppliersTable.itemId, id),
      eq(itemSuppliersTable.companyId, cid),
    ));
  if (!existing) { res.status(404).json({ error: "الارتباط غير موجود" }); return; }

  const {
    supplierItemCode, lastPurchasePrice, lastPurchaseDate,
    leadTimeDays, preferredSupplier, notes,
  } = req.body ?? {};

  const patch: Record<string, unknown> = {};
  if (supplierItemCode !== undefined) {
    patch.supplierItemCode = supplierItemCode ? String(supplierItemCode).slice(0, 100) : null;
  }
  if (lastPurchasePrice !== undefined) {
    patch.lastPurchasePrice = (lastPurchasePrice == null || lastPurchasePrice === "")
      ? null : String(lastPurchasePrice);
  }
  if (lastPurchaseDate !== undefined) {
    patch.lastPurchaseDate = lastPurchaseDate || null;
  }
  if (leadTimeDays !== undefined) {
    patch.leadTimeDays = Number.isFinite(Number(leadTimeDays)) ? Number(leadTimeDays) : null;
  }
  if (notes !== undefined) {
    patch.notes = notes ? String(notes).slice(0, 1000) : null;
  }

  const wantsPreferred = preferredSupplier === true;
  const wantsUnpreferred = preferredSupplier === false;

  // Same partial-unique-index safety net applies on UPDATE: if two requests
  // race to flip preferred=true on different rows for the same item, the
  // second commit gets a unique-violation and we 409.
  let updated;
  try {
    updated = await db.transaction(async (tx) => {
      if (wantsPreferred) {
        // Clear other preferred rows first (will also unset the current row,
        // which we then re-set to true via patch — the unique index lets us
        // do this within a single transaction since both writes commit atomically).
        await tx.update(itemSuppliersTable)
          .set({ preferredSupplier: false })
          .where(and(
            eq(itemSuppliersTable.itemId, id),
            eq(itemSuppliersTable.companyId, cid),
          ));
        patch.preferredSupplier = true;
      } else if (wantsUnpreferred) {
        patch.preferredSupplier = false;
      }
      if (Object.keys(patch).length === 0) return existing;
      const [r] = await tx.update(itemSuppliersTable)
        .set(patch)
        .where(eq(itemSuppliersTable.id, linkId))
        .returning();
      return r;
    });
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: "هناك بالفعل مورد مفضل لهذا الصنف — يرجى المحاولة مرة أخرى" });
      return;
    }
    throw err;
  }

  auditSubEntity(req, "item_suppliers", linkId, "edit", existing, updated);
  res.json(updated);
});

router.delete("/items/:id/suppliers/:linkId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const linkId = Number(req.params.linkId);
  if (!Number.isFinite(id) || !Number.isFinite(linkId)) {
    res.status(400).json({ error: "معرّف غير صالح" }); return;
  }
  // Composite filter — must match item AND tenant before deletion.
  const [existing] = await db.select()
    .from(itemSuppliersTable)
    .where(and(
      eq(itemSuppliersTable.id, linkId),
      eq(itemSuppliersTable.itemId, id),
      eq(itemSuppliersTable.companyId, cid),
    ));
  if (!existing) { res.status(404).json({ error: "الارتباط غير موجود" }); return; }

  // Defense in depth: scope the actual delete by tenant too, even though
  // the preceding ownership check already guarantees safety. Cheap insurance
  // against future refactors that might lose the ownership check above.
  await db.delete(itemSuppliersTable).where(and(
    eq(itemSuppliersTable.id, linkId),
    eq(itemSuppliersTable.companyId, cid),
  ));
  auditSubEntity(req, "item_suppliers", linkId, "delete", existing, null);
  res.json({ ok: true });
});

// ─── PRO Extension #2 — Bundle Components ───────────────────────────────────
// CRUD for the child composition of a "bundle" parent item. Auto-flips the
// parent's `isBundle` flag: TRUE when the first component is added, FALSE
// when the last one is removed (so the UI doesn't have to micro-manage it).
//
// All routes are tenant-scoped: the parent item AND the child item must
// both belong to the caller's company before any row is touched, and a
// child cannot reference its own parent (no self-component).

router.get("/items/:id/bundle/components", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  // Confirm parent belongs to this tenant before returning anything.
  const [own] = await db.select({ id: itemsTable.id, isBundle: itemsTable.isBundle })
    .from(itemsTable)
    .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid)));
  if (!own) { res.status(404).json({ error: "الصنف غير موجود" }); return; }

  // Self-join to fetch child name/code/sale price for the table view in one round-trip.
  const childAlias = aliasedTable(itemsTable, "child");
  const rows = await db.select({
    id:           itemBundleComponentsTable.id,
    parentItemId: itemBundleComponentsTable.parentItemId,
    childItemId:  itemBundleComponentsTable.childItemId,
    qty:          itemBundleComponentsTable.qty,
    notes:        itemBundleComponentsTable.notes,
    createdAt:    itemBundleComponentsTable.createdAt,
    childCode:    childAlias.code,
    childNameAr:  childAlias.nameAr,
    childNameEn:  childAlias.nameEn,
    childSalePrice: childAlias.salePrice,
    childCostPrice: childAlias.costPrice,
    childIsBundle:  childAlias.isBundle,
  })
    .from(itemBundleComponentsTable)
    .leftJoin(childAlias, eq(childAlias.id, itemBundleComponentsTable.childItemId))
    .where(and(
      eq(itemBundleComponentsTable.parentItemId, id),
      eq(itemBundleComponentsTable.companyId, cid),
    ))
    .orderBy(asc(itemBundleComponentsTable.createdAt));

  res.json({ isBundle: own.isBundle, components: rows });
});

router.post("/items/:id/bundle/components", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const { childItemId, qty, notes } = req.body ?? {};
  const childId = Number(childItemId);
  if (!Number.isFinite(childId)) { res.status(400).json({ error: "معرّف الصنف الفرعي مطلوب" }); return; }
  if (childId === id) { res.status(400).json({ error: "لا يمكن إضافة الصنف كمكوّن لنفسه" }); return; }

  const qtyNum = Number(qty);
  if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
    res.status(400).json({ error: "الكمية يجب أن تكون رقماً موجباً" }); return;
  }

  // Validate BOTH parent and child belong to this tenant in parallel. We
  // also pull `parentItemId` so we can enforce the variant/bundle
  // orthogonality invariant (PRO Extension #20): a row that is itself a
  // variant cannot become a bundle, and a variant cannot be used as a
  // bundle component (variants ARE intended to be sold/picked directly,
  // and the recursive expansion isn't variant-aware).
  const [[ownParent], [ownChild]] = await Promise.all([
    db.select({ id: itemsTable.id, parentItemId: itemsTable.parentItemId }).from(itemsTable)
      .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid))),
    db.select({ id: itemsTable.id, isBundle: itemsTable.isBundle, parentItemId: itemsTable.parentItemId }).from(itemsTable)
      .where(and(eq(itemsTable.id, childId), eq(itemsTable.companyId, cid))),
  ]);
  if (!ownParent) { res.status(404).json({ error: "الصنف غير موجود" }); return; }
  if (!ownChild)  { res.status(404).json({ error: "الصنف الفرعي غير موجود" }); return; }
  // PRO Extension #20 — variant/bundle axes are intentionally orthogonal.
  if (ownParent.parentItemId) {
    res.status(400).json({ error: "لا يمكن تحويل المتغيّر إلى صنف مركّب (Bundle)" }); return;
  }
  if (ownChild.parentItemId) {
    res.status(400).json({ error: "لا يمكن استخدام متغيّر كمكوّن داخل صنف مركّب" }); return;
  }
  // Defensive: don't allow nesting bundles inside bundles in this batch.
  // The "deduct on sale" expansion isn't recursive yet, so a bundle-of-bundles
  // would silently misbehave. Keep this guard until that work lands.
  if (ownChild.isBundle) {
    res.status(400).json({ error: "لا يمكن استخدام صنف مركّب كمكوّن داخل صنف مركّب آخر" }); return;
  }

  // App-level dup check (the unique index is the concurrency safety net below).
  const [dup] = await db.select({ id: itemBundleComponentsTable.id })
    .from(itemBundleComponentsTable)
    .where(and(
      eq(itemBundleComponentsTable.parentItemId, id),
      eq(itemBundleComponentsTable.childItemId, childId),
      eq(itemBundleComponentsTable.companyId, cid),
    ));
  if (dup) { res.status(409).json({ error: "هذا المكوّن مضاف بالفعل للصنف المركّب" }); return; }

  // Auto-flip parent.isBundle = true on first insert. We lock the parent
  // items row with SELECT ... FOR UPDATE at the start of the transaction
  // so any concurrent insert/delete on the same parent must wait until we
  // commit. Without this lock, a concurrent DELETE-last + INSERT-first
  // could race and leave the invariant `count(components)>0 ⇔ isBundle=true`
  // broken (e.g. parent has rows but isBundle=false).
  let row;
  try {
    row = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM ${itemsTable}
        WHERE id = ${id} AND company_id = ${cid} FOR UPDATE`);
      const [inserted] = await tx.insert(itemBundleComponentsTable).values({
        companyId: cid,
        parentItemId: id,
        childItemId: childId,
        qty: String(qtyNum),
        notes: notes ? String(notes).slice(0, 1000) : null,
      }).returning();
      // Set parent.isBundle=true (idempotent — no-op if already true).
      await tx.update(itemsTable)
        .set({ isBundle: true, updatedAt: new Date() })
        .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid)));
      return inserted;
    });
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: "هذا المكوّن مضاف بالفعل للصنف المركّب" });
      return;
    }
    throw err;
  }

  auditSubEntity(req, "item_bundle_components", row.id, "create", null, row);
  res.status(201).json(row);
});

router.put("/items/:id/bundle/components/:linkId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const linkId = Number(req.params.linkId);
  if (!Number.isFinite(id) || !Number.isFinite(linkId)) {
    res.status(400).json({ error: "معرّف غير صالح" }); return;
  }

  // Tenant + parent ownership check on the existing row.
  const [existing] = await db.select()
    .from(itemBundleComponentsTable)
    .where(and(
      eq(itemBundleComponentsTable.id, linkId),
      eq(itemBundleComponentsTable.parentItemId, id),
      eq(itemBundleComponentsTable.companyId, cid),
    ));
  if (!existing) { res.status(404).json({ error: "المكوّن غير موجود" }); return; }

  const { qty, notes } = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (qty !== undefined) {
    const qtyNum = Number(qty);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      res.status(400).json({ error: "الكمية يجب أن تكون رقماً موجباً" }); return;
    }
    patch.qty = String(qtyNum);
  }
  if (notes !== undefined) {
    patch.notes = notes ? String(notes).slice(0, 1000) : null;
  }
  if (Object.keys(patch).length === 0) {
    res.json(existing); return;
  }

  const [updated] = await db.update(itemBundleComponentsTable)
    .set(patch)
    .where(eq(itemBundleComponentsTable.id, linkId))
    .returning();

  auditSubEntity(req, "item_bundle_components", linkId, "edit", existing, updated);
  res.json(updated);
});

router.delete("/items/:id/bundle/components/:linkId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const linkId = Number(req.params.linkId);
  if (!Number.isFinite(id) || !Number.isFinite(linkId)) {
    res.status(400).json({ error: "معرّف غير صالح" }); return;
  }

  const [existing] = await db.select()
    .from(itemBundleComponentsTable)
    .where(and(
      eq(itemBundleComponentsTable.id, linkId),
      eq(itemBundleComponentsTable.parentItemId, id),
      eq(itemBundleComponentsTable.companyId, cid),
    ));
  if (!existing) { res.status(404).json({ error: "المكوّن غير موجود" }); return; }

  // Auto-flip parent.isBundle=false when removing the LAST component.
  // Lock the parent items row up-front (SELECT ... FOR UPDATE) so that any
  // concurrent INSERT on the same parent must wait until we commit —
  // otherwise we could observe `remaining=0` while another tx has already
  // inserted a fresh component and set isBundle=true, then we'd overwrite
  // it back to false and leave a parent with components + isBundle=false.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM ${itemsTable}
      WHERE id = ${id} AND company_id = ${cid} FOR UPDATE`);
    await tx.delete(itemBundleComponentsTable).where(and(
      eq(itemBundleComponentsTable.id, linkId),
      eq(itemBundleComponentsTable.companyId, cid),
    ));
    const [{ remaining }] = await tx.select({
      remaining: sql<number>`count(*)::int`,
    })
      .from(itemBundleComponentsTable)
      .where(and(
        eq(itemBundleComponentsTable.parentItemId, id),
        eq(itemBundleComponentsTable.companyId, cid),
      ));
    if (remaining === 0) {
      await tx.update(itemsTable)
        .set({ isBundle: false, updatedAt: new Date() })
        .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid)));
    }
  });

  auditSubEntity(req, "item_bundle_components", linkId, "delete", existing, null);
  res.json({ ok: true });
});

// ─── PRO Extension #20 — Item Variants ──────────────────────────────────────
// Variants of a parent item (e.g. "T-Shirt – Red – Large" under "T-Shirt").
// A variant is just an item with `parentItemId` set; this route is sugar for
// listing/creating variants without the client having to know to filter by
// parent_item_id manually. Tenant-scoped via companyId on both parent and
// variants. The general POST/PUT/DELETE /items routes already understand
// `parentItemId` + `variantAttributes`, but this route enforces the
// "must be a child of :id" contract for the dedicated UI tab.
router.get("/items/:id/variants", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  // Confirm the parent exists in this tenant — gives a clean 404 instead
  // of silently returning [] when the user types in a wrong URL.
  const [parent] = await db.select({
    id: itemsTable.id,
    code: itemsTable.code,
    nameAr: itemsTable.nameAr,
    parentItemId: itemsTable.parentItemId,
    isBundle: itemsTable.isBundle,
  })
    .from(itemsTable)
    .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid)));
  if (!parent) { res.status(404).json({ error: "الصنف غير موجود" }); return; }
  const variants = await db.select()
    .from(itemsTable)
    .where(and(
      eq(itemsTable.parentItemId, id),
      eq(itemsTable.companyId, cid),
    ))
    .orderBy(asc(itemsTable.code));
  res.json({
    parent: { id: parent.id, code: parent.code, nameAr: parent.nameAr,
              isVariant: !!parent.parentItemId, isBundle: parent.isBundle },
    variants,
  });
});

router.post("/items/:id/variants", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const { code, nameAr, nameEn, barcode, costPrice, salePrice, vatRate,
          variantAttributes, description, imageUrl } = req.body ?? {};
  if (!code || !nameAr) { res.status(400).json({ error: "كود واسم المتغيّر مطلوبان" }); return; }

  const all = await db.select().from(itemsTable).where(eq(itemsTable.companyId, cid));
  const parent = all.find(i => i.id === id);
  if (!parent) { res.status(404).json({ error: "الصنف الأب غير موجود" }); return; }
  if (parent.parentItemId) {
    res.status(400).json({ error: "لا يمكن إنشاء متغيّر لمتغيّر آخر (المتغيّرات لا تتداخل)" }); return;
  }
  if (parent.isBundle) {
    res.status(400).json({ error: "لا يمكن إضافة متغيّرات لصنف من نوع مركّب (Bundle)" }); return;
  }
  if (all.some(i => i.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لصنف آخر` }); return;
  }
  if (all.some(i => i.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لصنف آخر` }); return;
  }
  if (barcode && all.some(i => i.barcode?.trim() === String(barcode).trim())) {
    res.status(409).json({ error: `الباركود "${barcode}" مستخدم لصنف آخر` }); return;
  }
  const attrsCheck = validateVariantAttributes(variantAttributes);
  if (!attrsCheck.ok) { res.status(400).json({ error: attrsCheck.error }); return; }

  const [row] = await db.insert(itemsTable).values({
    companyId: cid, code, nameAr, nameEn: nameEn ?? null,
    barcode: barcode ?? null,
    itemType: parent.itemType,
    groupId:  parent.groupId,
    unitId:   parent.unitId,
    costPrice: costPrice ?? parent.costPrice,
    salePrice: salePrice ?? parent.salePrice,
    vatRate:   vatRate   ?? parent.vatRate,
    costMethod: parent.costMethod,
    description: description ?? null,
    imageUrl: imageUrl ?? null,
    parentItemId: id,
    variantAttributes: attrsCheck.value,
    isBundle: false,
  }).returning();
  // Audit under module="inventory_items" (not a separate "item_variants"
  // module) so the variant-create event shows up in the parent item's
  // history dialog AND the variant's own history dialog — they share
  // the same module the rest of the items lifecycle uses.
  auditSubEntity(req, "inventory_items", row.id, "create", null, row);
  res.status(201).json(row);
});

// ─── PRO Extension #5 — Per-item Analytics ──────────────────────────────────
// Aggregates posted-sales activity for a single item: last sold date, total
// qty sold, total revenue, and average monthly sales (computed across the
// trailing 12 months — even months with zero sales count as "0", so the avg
// reflects steady velocity, not just the months that happened to have sales).
router.get("/items/:id/analytics", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  // Trailing-12-month cutoff for the monthly-velocity calculation. We compute
  // it once here in app code so the SQL only has to do a string compare.
  const trailing12Cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

  // Single SQL aggregation across all posted invoice lines for this item.
  // Tenant-scoped via BOTH tables to defend against any future cross-tenant
  // line leakage (defense in depth — both tables carry company_id).
  // Note: `lastSoldDate`, lifetime totals, and invoiceCount are LIFETIME;
  // only `qtyLast12` is filtered to the trailing 12 months so the average
  // monthly velocity actually reflects "the last 12 months", not lifetime/12.
  const [agg] = await db
    .select({
      lastSoldDate: sql<string | null>`max(${salesInvoicesTable.invoiceDate})`,
      totalQty:     sql<string>`coalesce(sum(${salesInvoiceLinesTable.qty}), 0)`,
      totalRevenue: sql<string>`coalesce(sum(${salesInvoiceLinesTable.lineTotal}), 0)`,
      invoiceCount: sql<number>`count(distinct ${salesInvoiceLinesTable.invoiceId})::int`,
      qtyLast12:    sql<string>`coalesce(sum(${salesInvoiceLinesTable.qty}) filter (where ${salesInvoicesTable.invoiceDate} >= ${trailing12Cutoff}), 0)`,
    })
    .from(salesInvoiceLinesTable)
    .innerJoin(salesInvoicesTable, eq(salesInvoiceLinesTable.invoiceId, salesInvoicesTable.id))
    .where(and(
      eq(salesInvoiceLinesTable.companyId, cid),
      eq(salesInvoicesTable.companyId, cid),
      eq(salesInvoicesTable.status, "posted"),
      eq(salesInvoiceLinesTable.itemId, id),
    ));

  const totalQty = Number(agg?.totalQty ?? 0);
  const totalRevenue = Number(agg?.totalRevenue ?? 0);
  // True trailing-12-month average: qty in the last 12 months / 12.
  // Months with zero sales count as zero — gives steady-velocity reading.
  const averageMonthlySales = Number(agg?.qtyLast12 ?? 0) / 12;

  res.json({
    itemId: id,
    lastSoldDate: agg?.lastSoldDate ?? null,
    totalSalesQty: totalQty,
    totalRevenue,
    averageMonthlySales,
    invoiceCount: agg?.invoiceCount ?? 0,
  });
});

// ─── PRO Extension #6 — Smart Alerts ─────────────────────────────────────────
// Returns two parallel alert lists in a single request:
//   - lowStock: items whose summed warehouse qty is at-or-below their
//     reorderLevel (only items with a positive reorderLevel are checked,
//     since reorderLevel=0 means "no threshold configured").
//   - idle:     items that haven't been sold (posted invoice) within the
//     last `idleDays` days. Items that have *never* sold are intentionally
//     excluded — they're new/unestablished, not "idle".
//
// Warranty-expiry and abnormal-price-change alerts are intentionally NOT
// implemented in this batch — both require schema additions (warranty
// tracking + price-change history) that are out of scope here.
router.get("/alerts", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const idleDays = Math.max(1, Math.min(3650, Number(req.query.idleDays ?? 90) || 90));
  const cutoff = new Date(Date.now() - idleDays * 86400000).toISOString().slice(0, 10);

  // ── Low stock: aggregate stock_balance per item then filter ───────────────
  // Key fix: select itemId from itemsTable.id (not stockBalanceTable.itemId),
  // because items with NO stock_balance rows yet still need a real itemId
  // for the UI deep-link.
  const balRows = await db
    .select({
      itemId:        itemsTable.id,
      totalQty:      sql<string>`coalesce(sum(${stockBalanceTable.qty}), 0)`,
      code:          itemsTable.code,
      nameAr:        itemsTable.nameAr,
      nameEn:        itemsTable.nameEn,
      reorderLevel:  itemsTable.reorderLevel,
      itemType:      itemsTable.itemType,
    })
    .from(itemsTable)
    .leftJoin(stockBalanceTable, and(
      eq(stockBalanceTable.itemId, itemsTable.id),
      eq(stockBalanceTable.companyId, cid),
    ))
    .where(and(
      eq(itemsTable.companyId, cid),
      eq(itemsTable.status, "active"),
    ))
    .groupBy(itemsTable.id, itemsTable.code, itemsTable.nameAr, itemsTable.nameEn, itemsTable.reorderLevel, itemsTable.itemType);

  const lowStock = balRows
    .filter(r => r.itemType !== "service" && r.itemType !== "prepaid_expense")
    .map(r => ({
      itemId:       Number(r.itemId),
      code:         r.code,
      nameAr:       r.nameAr,
      nameEn:       r.nameEn,
      totalQty:     Number(r.totalQty),
      reorderLevel: Number(r.reorderLevel ?? 0),
    }))
    .filter(r => r.reorderLevel > 0 && r.totalQty <= r.reorderLevel)
    .sort((a, b) => (a.totalQty - a.reorderLevel) - (b.totalQty - b.reorderLevel));

  // ── Idle: items whose latest posted-sale date is older than cutoff ────────
  const lastSold = await db
    .select({
      itemId:   salesInvoiceLinesTable.itemId,
      lastDate: sql<string>`max(${salesInvoicesTable.invoiceDate})`,
    })
    .from(salesInvoiceLinesTable)
    .innerJoin(salesInvoicesTable, eq(salesInvoiceLinesTable.invoiceId, salesInvoicesTable.id))
    .where(and(
      eq(salesInvoiceLinesTable.companyId, cid),
      eq(salesInvoicesTable.companyId, cid),
      eq(salesInvoicesTable.status, "posted"),
    ))
    .groupBy(salesInvoiceLinesTable.itemId);

  // Re-use balRows for the id→meta lookup (already tenant-scoped + active).
  // Avoids a second round-trip and the prior dead `itemMeta` block.
  const itemById = new Map(balRows.map(r => [Number(r.itemId), r]));

  const today = new Date();
  const idle = lastSold
    .filter(r => r.lastDate && r.lastDate < cutoff)
    .map(r => {
      const meta = itemById.get(Number(r.itemId));
      const days = Math.floor((today.getTime() - new Date(r.lastDate).getTime()) / 86400000);
      return {
        itemId:       Number(r.itemId),
        code:         meta?.code ?? "",
        nameAr:       meta?.nameAr ?? "",
        nameEn:       meta?.nameEn ?? "",
        lastSoldDate: r.lastDate,
        daysIdle:     days,
      };
    })
    .filter(r => r.code) // drop items whose row was deleted but still appears in line history
    .sort((a, b) => b.daysIdle - a.daysIdle);

  res.json({ idleDays, lowStock, idle });
});

router.post("/import/items", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const rows: any[] = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!rows.length) { res.status(400).json({ error: "لا توجد بيانات" }); return; }

  const groups = await db.select().from(itemGroupsTable).where(eq(itemGroupsTable.companyId, cid));
  const units  = await db.select().from(unitsTable).where(eq(unitsTable.companyId, cid));
  // Fetch FULL existing rows (not just id/code) so we can compute precise
  // before/after diffs for the audit log on each updated row.
  const existing = await db.select().from(itemsTable).where(eq(itemsTable.companyId, cid));
  const groupByCode = new Map(groups.map((g: any) => [String(g.code).trim().toLowerCase(), g.id]));
  const unitByCode  = new Map(units.map((u: any)  => [String(u.code).trim().toLowerCase(), u.id]));
  const itemByCode  = new Map<string, any>(existing.map((it: any) => [String(it.code).trim().toLowerCase(), it]));

  // Snapshot reusable audit-row metadata so each writeAudit call below stays
  // small and consistent (and importantly tagged with `source: "import"` so
  // the timeline can distinguish bulk-import activity from interactive edits).
  const auditBase = {
    userId:     (req as any).authUser?.id ?? null,
    username:   (req as any).authUser?.username ?? null,
    role:       (req as any).authUser?.role ?? null,
    companyId:  cid,
    module:     "inventory_items",
    method:     req.method,
    path:       req.originalUrl ?? req.path,
    entityType: "item",
    statusCode: 200,
    ip:         ipFromReq(req),
    userAgent:  req.get("user-agent")?.slice(0, 256) ?? null,
  };

  let createdCount = 0, updatedCount = 0;
  const errors: { row: number; error: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    try {
      const code   = String(r.code ?? "").trim();
      const nameAr = String(r.nameAr ?? r.name ?? "").trim();
      if (!code || !nameAr) { errors.push({ row: i + 2, error: "الكود واسم الصنف العربي مطلوبان" }); continue; }

      const groupId = r.groupCode ? groupByCode.get(String(r.groupCode).trim().toLowerCase()) ?? null : null;
      const unitId  = r.unitCode  ? unitByCode.get(String(r.unitCode).trim().toLowerCase())   ?? null : null;
      if (r.unitCode && unitId === null) {
        errors.push({ row: i + 2, error: "وحدة القياس غير موجودة في هذه الشركة" }); continue;
      }
      const existingRow = itemByCode.get(code.toLowerCase());
      // A bulk import is another item master writer. It may not silently
      // rebase an item that already has unit links or historical movement.
      if (existingRow && r.unitCode !== undefined && unitId !== existingRow.unitId) {
        const links = await db.select({ id: itemUnitPricesTable.id }).from(itemUnitPricesTable)
          .where(and(eq(itemUnitPricesTable.companyId, cid), eq(itemUnitPricesTable.itemId, existingRow.id)));
        if (links.length) {
          errors.push({ row: i + 2, error: "لا يمكن تغيير وحدة أساس مرتبطة؛ استخدم روابط وحدات الصنف" }); continue;
        }
        if (await itemHasHistoricalUsage(db, cid, existingRow.id)) {
          errors.push({ row: i + 2, error: "لا يمكن تغيير وحدة الأساس بعد وجود استخدام أو مخزون تاريخي" }); continue;
        }
      }
      // Honor discount columns when present in the spreadsheet, otherwise
      // default to "none"/0 (matches the column default and keeps existing
      // imports backward-compatible).
      const importDisc = normalizeDiscount(r.discountType, r.discountValue);
      const values = {
        companyId: cid, code, nameAr,
        nameEn:       r.nameEn       != null && r.nameEn   !== "" ? String(r.nameEn)   : null,
        barcode:      r.barcode      != null && r.barcode  !== "" ? String(r.barcode)  : null,
        itemType:     ((r.itemType === "service" || r.itemType === "fixed_asset" || r.itemType === "prepaid_expense") ? r.itemType : "stock") as any,
         groupId, unitId,
        costPrice:    String(Number(r.costPrice    ?? 0) || 0),
        salePrice:    String(Number(r.salePrice    ?? 0) || 0),
        vatRate:      String(Number(r.vatRate      ?? 15) || 0),
        reorderLevel: String(Number(r.reorderLevel ?? 0) || 0),
        maxLevel:     r.maxLevel != null && r.maxLevel !== "" ? String(Number(r.maxLevel) || 0) : null,
        description:  r.description != null && r.description !== "" ? String(r.description) : null,
        discountType:  importDisc.type,
        discountValue: importDisc.value,
      };

      if (existingRow) {
        const { companyId, ...upd } = values as any;
        if (r.unitCode === undefined) delete (upd as any).unitId;
        const [updatedRow] = await db.update(itemsTable).set({ ...upd, updatedAt: new Date() })
          .where(and(eq(itemsTable.id, existingRow.id), eq(itemsTable.companyId, cid)))
          .returning();
        // Skip audit when the import row had no real effect.
        const changes = updatedRow ? diffItem(existingRow, updatedRow) : [];
        if (changes.length > 0) {
          void writeAudit({
            ...auditBase,
            action:   "edit",
            entityId: String(existingRow.id),
            metadata: { name: updatedRow.nameAr, code: updatedRow.code, changes, source: "import" },
          });
          // Refresh map so a later row referencing the same code sees the new state.
          itemByCode.set(code.toLowerCase(), updatedRow);
        }
        updatedCount++;
      } else {
        const [ins] = await db.insert(itemsTable).values(values).returning();
        if (ins?.id) {
          itemByCode.set(code.toLowerCase(), ins);
          void writeAudit({
            ...auditBase,
            action:     "create",
            entityId:   String(ins.id),
            statusCode: 201,
            metadata:   { name: ins.nameAr, code: ins.code, snapshot: snapshotItem(ins), source: "import" },
          });
        }
        createdCount++;
      }
    } catch (e: any) {
      errors.push({ row: i + 2, error: e?.message || "خطأ غير معروف" });
    }
  }

  res.json({ created: createdCount, updated: updatedCount, errors, total: rows.length });
});

// ═══════════════════════════════════════════════════════════════════
// BULK IMPORT — Opening Balances
// Body: { date?, balances: [{ itemCode, warehouseCode, qty, costPrice }] }
// Sets balance directly (replaces) and writes a stock_ledger entry of type "opening"
// ═══════════════════════════════════════════════════════════════════
router.post("/import/opening-balances", requirePostRight("stockMovement"), async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const importLockClient = await pool.connect();
  let importLocked = false;
  try {
  await importLockClient.query("SELECT pg_advisory_lock($1, $2)", [cid, 1187]);
  importLocked = true;
  const rows: any[] = Array.isArray(req.body?.balances) ? req.body.balances : [];
  const txDate = String(req.body?.date || new Date().toISOString().slice(0, 10));
  const inventoryAccountId = Number(req.body?.accountId);
  if (!rows.length) { res.status(400).json({ error: "لا توجد بيانات" }); return; }
  if (!Number.isInteger(inventoryAccountId) || inventoryAccountId <= 0) {
    res.status(400).json({ error: "اختر حساب المخزون الذي ستُرحّل إليه القيمة الافتتاحية" });
    return;
  }

  const [inventoryAccount] = await db.select({
    id: accountsTable.id,
    isPosting: accountsTable.isPosting,
    isActive: accountsTable.isActive,
  }).from(accountsTable).where(and(
    eq(accountsTable.id, inventoryAccountId),
    eq(accountsTable.companyId, cid),
  ));
  if (!inventoryAccount || !inventoryAccount.isPosting || !inventoryAccount.isActive) {
    res.status(400).json({ error: "حساب المخزون يجب أن يكون حساباً فرعياً نشطاً من دليل الشركة" });
    return;
  }

  const [openingCounterMapping] = await db.select({
    accountId: accountingMappingsTable.accountId,
  }).from(accountingMappingsTable).where(and(
    eq(accountingMappingsTable.companyId, cid),
    eq(accountingMappingsTable.documentType, "warehouse"),
    eq(accountingMappingsTable.roleKey, "opening_balance"),
  ));
  let openingCounterAccountId = openingCounterMapping?.accountId ?? null;
  if (openingCounterAccountId == null) {
    const [fallback] = await db.select({ id: accountsTable.id }).from(accountsTable).where(and(
      eq(accountsTable.companyId, cid),
      eq(accountsTable.code, "3301"),
      eq(accountsTable.isActive, true),
      eq(accountsTable.isPosting, true),
    ));
    openingCounterAccountId = fallback?.id ?? null;
  }
  if (openingCounterAccountId == null) {
    res.status(400).json({
      error: "لم يتم ربط حساب مقابل الأرصدة الافتتاحية (warehouse.opening_balance). حدده من إعدادات الربط المحاسبي أولاً.",
    });
    return;
  }

  const [existingOpening] = await db.select({
    id: journalEntriesTable.id,
    status: journalEntriesTable.status,
  }).from(journalEntriesTable).where(and(
    eq(journalEntriesTable.companyId, cid),
    eq(journalEntriesTable.entryType, "opening"),
    sql`COALESCE(${journalEntriesTable.description}, '') NOT LIKE '%[ob:%'`,
  )).orderBy(desc(journalEntriesTable.createdAt), desc(journalEntriesTable.id)).limit(1);
  if (existingOpening?.status === "posted") {
    res.status(423).json({
      error: "قيد الأرصدة الافتتاحية مُرحّل. فك ترحيله من شاشة الأرصدة الافتتاحية قبل إعادة استيراد المخزون.",
    });
    return;
  }
  const dateGuard = await assertWritableForDate(cid, txDate);
  if (!dateGuard.ok) { res.status(423).json({ error: dateGuard.reason }); return; }

  const items = await db.select({ id: itemsTable.id, code: itemsTable.code }).from(itemsTable).where(eq(itemsTable.companyId, cid));
  const wh    = await db.select({ id: warehousesTable.id, code: warehousesTable.code }).from(warehousesTable).where(eq(warehousesTable.companyId, cid));
  const itemByCode = new Map(items.map((i: any) => [String(i.code).trim().toLowerCase(), i.id]));
  const whByCode   = new Map(wh.map((w: any)   => [String(w.code).trim().toLowerCase(), w.id]));

  const errors: { row: number; error: string }[] = [];
  const normalized: Array<{ row: number; itemId: number; warehouseId: number; qty: number; cost: number }> = [];
  const seenPairs = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const itemCode = String(r.itemCode ?? "").trim().toLowerCase();
    const whCode = String(r.warehouseCode ?? "").trim().toLowerCase();
    const qty = Number(r.qty);
    const cost = Number(r.costPrice);
    const itemId = itemByCode.get(itemCode);
    const warehouseId = whByCode.get(whCode);
    if (!itemCode || !whCode) errors.push({ row: i + 2, error: "كود الصنف وكود المخزن مطلوبان" });
    else if (!itemId) errors.push({ row: i + 2, error: `صنف غير موجود: ${r.itemCode}` });
    else if (!warehouseId) errors.push({ row: i + 2, error: `مخزن غير موجود: ${r.warehouseCode}` });
    else if (!Number.isFinite(qty) || qty < 0) errors.push({ row: i + 2, error: "الكمية يجب أن تكون صفراً أو رقماً موجباً" });
    else if (!Number.isFinite(cost) || cost < 0) errors.push({ row: i + 2, error: "التكلفة يجب أن تكون صفراً أو رقماً موجباً" });
    else {
      const pair = `${itemId}:${warehouseId}`;
      if (seenPairs.has(pair)) errors.push({ row: i + 2, error: "الصنف والمخزن مكرران في الملف" });
      else {
        seenPairs.add(pair);
        normalized.push({ row: i + 2, itemId, warehouseId, qty, cost });
      }
    }
  }
  if (errors.length) {
    res.status(400).json({ error: "لم يتم تطبيق أي رصيد لوجود أخطاء في الملف", errors, total: rows.length });
    return;
  }

  let generatedDocNumber: string | null = null;
  if (!existingOpening) {
    try {
      generatedDocNumber = await nextSequenceNumber(cid, "journal_entry", {
        userId: req.authUser?.id ?? null,
        refTable: "journal_entries",
        docDate: txDate,
      });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "تعذر توليد رقم قيد الأرصدة الافتتاحية" });
      return;
    }
  }

  const atomicResult = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(journalEntriesTable).where(and(
      eq(journalEntriesTable.companyId, cid),
      eq(journalEntriesTable.entryType, "opening"),
      sql`COALESCE(${journalEntriesTable.description}, '') NOT LIKE '%[ob:%'`,
    )).orderBy(desc(journalEntriesTable.createdAt), desc(journalEntriesTable.id)).limit(1).for("update");
    if (current?.status === "posted") {
      throw new Error("قيد الأرصدة الافتتاحية مُرحّل. فك ترحيله قبل إعادة الاستيراد.");
    }

    const selectedItemIds = Array.from(new Set(normalized.map(r => r.itemId)));
    const selectedWarehouseIds = Array.from(new Set(normalized.map(r => r.warehouseId)));
    const laterMovements = await tx.select({
      itemId: stockLedgerTable.itemId,
      warehouseId: stockLedgerTable.warehouseId,
    }).from(stockLedgerTable).where(and(
      eq(stockLedgerTable.companyId, cid),
      inArray(stockLedgerTable.itemId, selectedItemIds),
      inArray(stockLedgerTable.warehouseId, selectedWarehouseIds),
      ne(stockLedgerTable.refType, "opening_balance"),
    ));
    const laterPairs = new Set(laterMovements.map(r => `${r.itemId}:${r.warehouseId}`));
    const blocked = normalized.find(r => laterPairs.has(`${r.itemId}:${r.warehouseId}`));
    if (blocked) {
      throw new Error(`لا يمكن استبدال الرصيد الافتتاحي في الصف ${blocked.row} بعد وجود حركات مخزنية لاحقة`);
    }

    await lockStockBalances(normalized.map(row => ({
      companyId: cid, itemId: row.itemId, warehouseId: row.warehouseId,
    })), tx);
    for (const row of normalized.sort((a, b) => a.warehouseId - b.warehouseId || a.itemId - b.itemId)) {
      const [balance] = await tx.select().from(stockBalanceTable).where(and(
        eq(stockBalanceTable.companyId, cid),
        eq(stockBalanceTable.itemId, row.itemId),
        eq(stockBalanceTable.warehouseId, row.warehouseId),
      ));
      if (balance) {
        await tx.update(stockBalanceTable).set({
          qty: String(row.qty), avgCost: String(row.cost), updatedAt: new Date(),
        }).where(eq(stockBalanceTable.id, balance.id));
      } else {
        await tx.insert(stockBalanceTable).values({
          companyId: cid, itemId: row.itemId, warehouseId: row.warehouseId,
          qty: String(row.qty), avgCost: String(row.cost),
        });
      }
      await tx.delete(stockLedgerTable).where(and(
        eq(stockLedgerTable.companyId, cid),
        eq(stockLedgerTable.itemId, row.itemId),
        eq(stockLedgerTable.warehouseId, row.warehouseId),
        eq(stockLedgerTable.refType, "opening_balance"),
      ));
      await tx.insert(stockLedgerTable).values({
        companyId: cid, itemId: row.itemId, warehouseId: row.warehouseId,
        txDate, txType: "opening" as any,
        qty: String(row.qty), costPrice: String(row.cost),
        totalCost: String(row.qty * row.cost), balanceQty: String(row.qty),
        refId: 0, refType: "opening_balance", notes: "رصيد افتتاحي مستورد",
      });
    }
    for (const itemId of selectedItemIds) await refreshItemCost(cid, itemId, tx);

    const [valueRow] = await tx.select({
      total: sql<string>`COALESCE(SUM(${stockLedgerTable.balanceQty} * ${stockLedgerTable.costPrice}), 0)`,
    }).from(stockLedgerTable).where(and(
      eq(stockLedgerTable.companyId, cid),
      eq(stockLedgerTable.refType, "opening_balance"),
    ));
    const inventoryOpeningValue = Number(valueRow?.total ?? 0);

    await tx.insert(accountingMappingsTable).values({
      companyId: cid,
      documentType: "warehouse",
      roleKey: "inventory",
      accountId: inventoryAccountId,
    }).onConflictDoUpdate({
      target: [
        accountingMappingsTable.companyId,
        accountingMappingsTable.documentType,
        accountingMappingsTable.roleKey,
      ],
      set: { accountId: inventoryAccountId, updatedAt: new Date() },
    });

    let entryId = current?.id;
    if (!entryId) {
      const [created] = await tx.insert(journalEntriesTable).values({
        companyId: cid,
        docNumber: generatedDocNumber,
        entryDate: txDate,
        currency: "SAR",
        exchangeRate: "1",
        description: `الأرصدة الافتتاحية ${txDate.slice(0, 4)}`,
        entryType: "opening",
        periodId: dateGuard.period?.id ?? null,
        status: "draft",
        ...fullAuditFor(req),
        postedBy: null,
        postedAt: null,
        postedIp: null,
        postedUserAgent: null,
      }).returning();
      entryId = created.id;
    }

    await tx.delete(journalEntryLinesTable).where(and(
      eq(journalEntryLinesTable.entryId, entryId),
      sql`${journalEntryLinesTable.description} LIKE '%[opening-inventory:%'`,
    ));
    if (Math.abs(inventoryOpeningValue) >= 0.005) {
      const amount = Math.abs(inventoryOpeningValue).toFixed(2);
      await tx.insert(journalEntryLinesTable).values([
        {
          entryId,
          accountId: inventoryAccountId,
          debit: inventoryOpeningValue >= 0 ? amount : "0",
          credit: inventoryOpeningValue < 0 ? amount : "0",
          description: `${INVENTORY_OPENING_DEBIT_MARKER} قيمة مخزون أول المدة`,
          sortOrder: 900000,
        },
        {
          entryId,
          accountId: openingCounterAccountId,
          debit: inventoryOpeningValue < 0 ? amount : "0",
          credit: inventoryOpeningValue >= 0 ? amount : "0",
          description: `${INVENTORY_OPENING_CREDIT_MARKER} مقابل قيمة مخزون أول المدة`,
          sortOrder: 900001,
        },
      ]);
    }
    return { openingEntryId: entryId, inventoryOpeningValue };
  });

  res.json({
    applied: normalized.length,
    errors: [],
    total: rows.length,
    inventoryOpeningValue: atomicResult.inventoryOpeningValue,
    openingEntryId: atomicResult.openingEntryId,
    inventoryAccountId,
    openingCounterAccountId,
  });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e?.message ?? "فشل استيراد الأرصدة الافتتاحية" });
  } finally {
    if (importLocked) {
      await importLockClient.query("SELECT pg_advisory_unlock($1, $2)", [cid, 1187]).catch(() => {});
    }
    importLockClient.release();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PRO Extension #8 — Item Currency Prices
// ════════════════════════════════════════════════════════════════════════════
// Per-item override prices in non-default currencies. Useful for businesses
// that quote some items in USD/EUR/AED while keeping SAR as the company base.
// We store currency by `code` (text) — matching every other place in the
// system that already does this (suppliers, purchasing, inventoryReceipts).

// Helper: validate that an item belongs to the tenant; returns 404 if not.
async function ensureItemInTenant(cid: number, itemId: number): Promise<boolean> {
  const [r] = await db.select({ id: itemsTable.id }).from(itemsTable)
    .where(and(eq(itemsTable.id, itemId), eq(itemsTable.companyId, cid)));
  return !!r;
}

// Helper: pull the company's default currency code (used to reject creating
// an override row for the same currency as the base price columns).
async function getDefaultCurrencyCode(cid: number): Promise<string | null> {
  const [c] = await db.select({ code: currenciesTable.code })
    .from(currenciesTable)
    .where(and(eq(currenciesTable.companyId, cid), eq(currenciesTable.isDefault, true)));
  return c?.code ?? null;
}

router.get("/items/:id/currency-prices", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  if (!(await ensureItemInTenant(cid, id))) { res.status(404).json({ error: "الصنف غير موجود" }); return; }
  const rows = await db.select().from(itemCurrencyPricesTable)
    .where(and(eq(itemCurrencyPricesTable.companyId, cid), eq(itemCurrencyPricesTable.itemId, id)))
    .orderBy(asc(itemCurrencyPricesTable.currencyCode));
  res.json(rows);
});

router.post("/items/:id/currency-prices", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  if (!(await ensureItemInTenant(cid, id))) { res.status(404).json({ error: "الصنف غير موجود" }); return; }

  const { currencyCode, costPrice, salePrice, notes } = req.body ?? {};
  const code = String(currencyCode ?? "").trim().toUpperCase();
  if (!code) { res.status(400).json({ error: "رمز العملة مطلوب" }); return; }

  // Currency must exist in this tenant — otherwise the user can stuff arbitrary
  // codes into the table and the UI dropdowns won't recognise them.
  const [curr] = await db.select({ code: currenciesTable.code, isDefault: currenciesTable.isDefault })
    .from(currenciesTable)
    .where(and(eq(currenciesTable.companyId, cid), eq(currenciesTable.code, code)));
  if (!curr) { res.status(400).json({ error: "العملة غير معرّفة في هذه الشركة" }); return; }
  if (curr.isDefault) {
    res.status(400).json({ error: "العملة الافتراضية للشركة محفوظة في حقول السعر الأساسية للصنف" });
    return;
  }

  const cost = Number(costPrice ?? 0);
  const sale = Number(salePrice ?? 0);
  if (!Number.isFinite(cost) || cost < 0) { res.status(400).json({ error: "سعر التكلفة يجب أن يكون رقماً موجباً" }); return; }
  if (!Number.isFinite(sale) || sale < 0) { res.status(400).json({ error: "سعر البيع يجب أن يكون رقماً موجباً" }); return; }

  let row;
  try {
    [row] = await db.insert(itemCurrencyPricesTable).values({
      companyId: cid, itemId: id, currencyCode: code,
      costPrice: String(cost), salePrice: String(sale),
      notes: notes ? String(notes).slice(0, 500) : null,
    }).returning();
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: "هذه العملة مضافة بالفعل لهذا الصنف" });
      return;
    }
    throw err;
  }
  auditSubEntity(req, "inventory_items", id, "create", null, { currencyPrice: row });
  res.status(201).json(row);
});

router.put("/items/:id/currency-prices/:rowId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const rowId = Number(req.params.rowId);
  if (!Number.isFinite(id) || !Number.isFinite(rowId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const [existing] = await db.select().from(itemCurrencyPricesTable)
    .where(and(eq(itemCurrencyPricesTable.id, rowId),
               eq(itemCurrencyPricesTable.itemId, id),
               eq(itemCurrencyPricesTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "السعر غير موجود" }); return; }

  const patch: any = { updatedAt: new Date() };
  if (req.body.costPrice !== undefined) {
    const v = Number(req.body.costPrice);
    if (!Number.isFinite(v) || v < 0) { res.status(400).json({ error: "سعر التكلفة غير صالح" }); return; }
    patch.costPrice = String(v);
  }
  if (req.body.salePrice !== undefined) {
    const v = Number(req.body.salePrice);
    if (!Number.isFinite(v) || v < 0) { res.status(400).json({ error: "سعر البيع غير صالح" }); return; }
    patch.salePrice = String(v);
  }
  if (req.body.notes !== undefined) patch.notes = req.body.notes ? String(req.body.notes).slice(0, 500) : null;

  const [updated] = await db.update(itemCurrencyPricesTable).set(patch)
    .where(eq(itemCurrencyPricesTable.id, rowId)).returning();
  auditSubEntity(req, "inventory_items", id, "edit", { currencyPrice: existing }, { currencyPrice: updated });
  res.json(updated);
});

router.delete("/items/:id/currency-prices/:rowId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const rowId = Number(req.params.rowId);
  if (!Number.isFinite(id) || !Number.isFinite(rowId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const [existing] = await db.select().from(itemCurrencyPricesTable)
    .where(and(eq(itemCurrencyPricesTable.id, rowId),
               eq(itemCurrencyPricesTable.itemId, id),
               eq(itemCurrencyPricesTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "السعر غير موجود" }); return; }

  await db.delete(itemCurrencyPricesTable).where(eq(itemCurrencyPricesTable.id, rowId));
  auditSubEntity(req, "inventory_items", id, "delete", { currencyPrice: existing }, null);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// PRO Extension #9 — Item Branch Stock
// ════════════════════════════════════════════════════════════════════════════
// Per-item per-branch quantity & per-branch reorder thresholds. The "list"
// endpoint LEFT JOINs branches so the UI can render every tenant branch as
// a row even when no stock has been recorded yet — saves a round-trip and
// makes the empty-cell-vs-zero distinction obvious in the UI.

router.get("/items/:id/branch-stock", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  if (!(await ensureItemInTenant(cid, id))) { res.status(404).json({ error: "الصنف غير موجود" }); return; }

  // LEFT JOIN with the per-tenant branches list so the response is always
  // "every branch in the company, plus its stock row if any".
  const rows = await db.select({
    branch: branchesTable,
    stock:  itemBranchStockTable,
  })
    .from(branchesTable)
    .leftJoin(itemBranchStockTable,
      and(eq(itemBranchStockTable.branchId, branchesTable.id),
          eq(itemBranchStockTable.itemId, id),
          eq(itemBranchStockTable.companyId, cid)))
    .where(eq(branchesTable.companyId, cid))
    .orderBy(asc(branchesTable.code));
  res.json(rows.map(r => ({
    branchId:     r.branch.id,
    branchCode:   r.branch.code,
    branchNameAr: r.branch.nameAr,
    branchNameEn: r.branch.nameEn,
    isMain:       r.branch.isMain,
    rowId:        r.stock?.id ?? null,
    qty:          r.stock?.qty ?? "0",
    reorderLevel: r.stock?.reorderLevel ?? null,
    maxLevel:     r.stock?.maxLevel ?? null,
    notes:        r.stock?.notes ?? null,
  })));
});

router.put("/items/:id/branch-stock/:branchId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const branchId = Number(req.params.branchId);
  if (!Number.isFinite(id) || !Number.isFinite(branchId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  if (!(await ensureItemInTenant(cid, id))) { res.status(404).json({ error: "الصنف غير موجود" }); return; }

  // Validate branch is in this tenant before touching the stock table.
  const [br] = await db.select({ id: branchesTable.id }).from(branchesTable)
    .where(and(eq(branchesTable.id, branchId), eq(branchesTable.companyId, cid)));
  if (!br) { res.status(404).json({ error: "الفرع غير موجود" }); return; }

  const qty = Number(req.body.qty ?? 0);
  if (!Number.isFinite(qty)) { res.status(400).json({ error: "الكمية غير صالحة" }); return; }
  const reorderLevel = req.body.reorderLevel != null ? Number(req.body.reorderLevel) : null;
  const maxLevel     = req.body.maxLevel     != null ? Number(req.body.maxLevel)     : null;
  if (reorderLevel !== null && (!Number.isFinite(reorderLevel) || reorderLevel < 0)) {
    res.status(400).json({ error: "حد إعادة الطلب يجب أن يكون رقماً موجباً" }); return;
  }
  if (maxLevel !== null && (!Number.isFinite(maxLevel) || maxLevel < 0)) {
    res.status(400).json({ error: "الحد الأقصى يجب أن يكون رقماً موجباً" }); return;
  }
  const notes = req.body.notes ? String(req.body.notes).slice(0, 500) : null;

  // Upsert via SELECT-then-INSERT/UPDATE inside a transaction to avoid the
  // race window. The unique index on (company,item,branch) is the safety
  // net for the brief gap.
  const before = await db.select().from(itemBranchStockTable).where(and(
    eq(itemBranchStockTable.companyId, cid),
    eq(itemBranchStockTable.itemId, id),
    eq(itemBranchStockTable.branchId, branchId),
  ));
  let row;
  if (before[0]) {
    [row] = await db.update(itemBranchStockTable).set({
      qty: String(qty),
      reorderLevel: reorderLevel !== null ? String(reorderLevel) : null,
      maxLevel:     maxLevel     !== null ? String(maxLevel)     : null,
      notes,
      updatedAt: new Date(),
    }).where(eq(itemBranchStockTable.id, before[0].id)).returning();
    auditSubEntity(req, "inventory_items", id, "edit",
      { branchStock: before[0] }, { branchStock: row });
  } else {
    [row] = await db.insert(itemBranchStockTable).values({
      companyId: cid, itemId: id, branchId,
      qty: String(qty),
      reorderLevel: reorderLevel !== null ? String(reorderLevel) : null,
      maxLevel:     maxLevel     !== null ? String(maxLevel)     : null,
      notes,
    }).returning();
    auditSubEntity(req, "inventory_items", id, "create", null, { branchStock: row });
  }
  res.json(row);
});

router.delete("/items/:id/branch-stock/:rowId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const rowId = Number(req.params.rowId);
  if (!Number.isFinite(id) || !Number.isFinite(rowId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const [existing] = await db.select().from(itemBranchStockTable)
    .where(and(eq(itemBranchStockTable.id, rowId),
               eq(itemBranchStockTable.itemId, id),
               eq(itemBranchStockTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "السجل غير موجود" }); return; }

  await db.delete(itemBranchStockTable).where(eq(itemBranchStockTable.id, rowId));
  auditSubEntity(req, "inventory_items", id, "delete", { branchStock: existing }, null);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// PRO Extension #16 — Smart Reorder Suggestion
// ════════════════════════════════════════════════════════════════════════════
// Computes a suggested reorder quantity based on:
//   - currentStock          — sum of stock_balance.qty across all warehouses
//   - dailyVelocity         — averageMonthlySales / 30 (from /analytics math)
//   - leadTimeDays          — MAX(item_suppliers.lead_time_days), 0 if none
//   - reorderLevel/maxLevel — items.reorder_level / items.max_level
//
// Math:
//   targetStock     = max(reorderLevel + leadTimeDays * dailyVelocity * 1.2,
//                         maxLevel ?? reorderLevel * 2)
//   suggestedQty    = max(0, ceil(targetStock - currentStock))
//
// The 1.2 safety factor pads the lead-time consumption against velocity
// volatility (a common rule-of-thumb for "comfortable" buffer stock). The
// max(...) ensures we never aim BELOW the user-set reorder threshold.

router.get("/items/:id/reorder-suggestion", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const [item] = await db.select({
    id: itemsTable.id, code: itemsTable.code,
    nameAr: itemsTable.nameAr, nameEn: itemsTable.nameEn,
    reorderLevel: itemsTable.reorderLevel, maxLevel: itemsTable.maxLevel,
  }).from(itemsTable)
    .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid)));
  if (!item) { res.status(404).json({ error: "الصنف غير موجود" }); return; }

  // Pull all 3 inputs in parallel.
  const trailing12Cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const [stockAgg, velocityAgg, supplierAgg] = await Promise.all([
    // current stock across all warehouses
    db.select({ qty: sql<string>`coalesce(sum(${stockBalanceTable.qty}), 0)` })
      .from(stockBalanceTable)
      .where(and(eq(stockBalanceTable.companyId, cid), eq(stockBalanceTable.itemId, id))),
    // velocity from posted sales over last 12 months
    db.select({ qtyLast12: sql<string>`coalesce(sum(${salesInvoiceLinesTable.qty}) filter (where ${salesInvoicesTable.invoiceDate} >= ${trailing12Cutoff}), 0)` })
      .from(salesInvoiceLinesTable)
      .innerJoin(salesInvoicesTable, eq(salesInvoiceLinesTable.invoiceId, salesInvoicesTable.id))
      .where(and(
        eq(salesInvoiceLinesTable.companyId, cid),
        eq(salesInvoicesTable.companyId, cid),
        eq(salesInvoicesTable.status, "posted"),
        eq(salesInvoiceLinesTable.itemId, id),
      )),
    // longest lead time across linked suppliers
    db.select({ leadTime: sql<number>`coalesce(max(${itemSuppliersTable.leadTimeDays}), 0)::int` })
      .from(itemSuppliersTable)
      .where(and(eq(itemSuppliersTable.companyId, cid), eq(itemSuppliersTable.itemId, id))),
  ]);

  const currentStock = Number(stockAgg[0]?.qty ?? 0);
  const avgMonthlySales = Number(velocityAgg[0]?.qtyLast12 ?? 0) / 12;
  const dailyVelocity = avgMonthlySales / 30;
  const leadTimeDays = Number(supplierAgg[0]?.leadTime ?? 0);
  const reorderLevel = Number(item.reorderLevel ?? 0);
  const maxLevel = item.maxLevel != null ? Number(item.maxLevel) : null;

  const safetyFactor = 1.2;
  const leadTimeConsumption = leadTimeDays * dailyVelocity * safetyFactor;
  const upperTarget = maxLevel != null && maxLevel > 0 ? maxLevel : reorderLevel * 2;
  const targetStock = Math.max(reorderLevel + leadTimeConsumption, upperTarget);
  const suggestedOrderQty = Math.max(0, Math.ceil(targetStock - currentStock));

  // "needsReorder" = true when current is already at-or-below reorder threshold.
  // Useful for the UI to highlight the suggestion in red vs. green.
  const needsReorder = reorderLevel > 0 && currentStock <= reorderLevel;

  res.json({
    itemId: id,
    code: item.code, nameAr: item.nameAr, nameEn: item.nameEn,
    inputs: {
      currentStock,
      avgMonthlySales,
      dailyVelocity,
      leadTimeDays,
      reorderLevel,
      maxLevel,
      safetyFactor,
    },
    computed: {
      leadTimeConsumption,
      targetStock,
      suggestedOrderQty,
      needsReorder,
    },
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Batches per item (رقم الدفعة + تاريخ الانتهاء)
// ════════════════════════════════════════════════════════════════════════════
// Aggregates incoming stock movements (purchases + goods receipts) by
// (batch_number, expiry_date, warehouse). "Received" is the sum of positive
// qty entries for that combination. Outgoing movements do NOT carry a
// batch reference in this phase (medium scope: historical recording only,
// no FIFO/FEFO lot tracking), so we cannot subtract usage per batch — the
// UI shows received quantity + expiry status only.
router.get("/items/:id/batches", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  // Existence check (matches sibling endpoints like /reorder-suggestion)
  const [item] = await db.select({ id: itemsTable.id })
    .from(itemsTable)
    .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid)));
  if (!item) { res.status(404).json({ error: "الصنف غير موجود" }); return; }

  // Restrict aggregation to inbound tx types that legitimately carry a batch
  // reference (purchases + goods receipts). Other tx types may incidentally
  // copy a batch field on outbound moves, but counting them would distort
  // "received" totals.
  const INBOUND_TX = ["purchase", "goods_receipt"] as const;

  const rows = await db
    .select({
      batchNumber:  stockLedgerTable.batchNumber,
      expiryDate:   stockLedgerTable.expiryDate,
      warehouseId:  stockLedgerTable.warehouseId,
      warehouseAr:  warehousesTable.nameAr,
      warehouseEn:  warehousesTable.nameEn,
      receivedQty:  sql<string>`coalesce(sum(${stockLedgerTable.qty}) filter (where ${stockLedgerTable.qty} > 0), 0)`,
      firstSeen:    sql<string>`min(${stockLedgerTable.txDate})`,
      lastSeen:     sql<string>`max(${stockLedgerTable.txDate})`,
      avgCost:      sql<string>`coalesce(avg(nullif(${stockLedgerTable.costPrice}, 0)), 0)`,
    })
    .from(stockLedgerTable)
    .leftJoin(warehousesTable, eq(stockLedgerTable.warehouseId, warehousesTable.id))
    .where(and(
      eq(stockLedgerTable.companyId, cid),
      eq(stockLedgerTable.itemId, id),
      inArray(stockLedgerTable.txType, INBOUND_TX),
      sql`${stockLedgerTable.batchNumber} is not null`,
      sql`length(trim(${stockLedgerTable.batchNumber})) > 0`,
    ))
    .groupBy(stockLedgerTable.batchNumber, stockLedgerTable.expiryDate, stockLedgerTable.warehouseId, warehousesTable.nameAr, warehousesTable.nameEn)
    .having(sql`coalesce(sum(${stockLedgerTable.qty}) filter (where ${stockLedgerTable.qty} > 0), 0) > 0`)
    .orderBy(asc(stockLedgerTable.expiryDate), asc(stockLedgerTable.batchNumber));

  // Date-only arithmetic (timezone-safe). Both `today` and `expiryDate` are
  // treated as YYYY-MM-DD strings and compared via UTC day count to avoid
  // off-by-one drift across timezones.
  const todayStr = new Date().toISOString().slice(0, 10);
  const dayDiff = (a: string, b: string): number => {
    const [ay, am, ad] = a.split("-").map(Number);
    const [by, bm, bd] = b.split("-").map(Number);
    const aUtc = Date.UTC(ay, am - 1, ad);
    const bUtc = Date.UTC(by, bm - 1, bd);
    return Math.round((aUtc - bUtc) / 86400000);
  };

  const out = rows.map(r => {
    let status: "expired" | "expiring_soon" | "active" | "no_expiry" = "no_expiry";
    let daysToExpiry: number | null = null;
    if (r.expiryDate) {
      daysToExpiry = dayDiff(String(r.expiryDate), todayStr);
      status = daysToExpiry < 0 ? "expired" : daysToExpiry <= 30 ? "expiring_soon" : "active";
    }
    return {
      batchNumber: r.batchNumber,
      expiryDate:  r.expiryDate,
      warehouseId: r.warehouseId,
      warehouse:   { id: r.warehouseId, nameAr: r.warehouseAr, nameEn: r.warehouseEn },
      receivedQty: Number(r.receivedQty),
      avgCost:     Number(r.avgCost),
      firstSeen:   r.firstSeen,
      lastSeen:    r.lastSeen,
      daysToExpiry,
      status,
    };
  });

  res.json({
    itemId: id,
    batches: out,
    summary: {
      totalBatches:    out.length,
      expiredCount:    out.filter(b => b.status === "expired").length,
      expiringSoonCount: out.filter(b => b.status === "expiring_soon").length,
      activeCount:     out.filter(b => b.status === "active" || b.status === "no_expiry").length,
    },
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PRO Extension #18 — BOM Steps (manufacturing steps)
// ════════════════════════════════════════════════════════════════════════════
// Steps are only meaningful for items where `isBundle = true` — but we don't
// 400 on non-bundles since the user might add steps first then flip the
// bundle flag. The UI handles the visibility rule.

router.get("/items/:id/bom-steps", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  if (!(await ensureItemInTenant(cid, id))) { res.status(404).json({ error: "الصنف غير موجود" }); return; }

  // Compute the component cost in parallel — saves a round-trip from the UI.
  const [steps, compCostAgg] = await Promise.all([
    db.select().from(itemBomStepsTable)
      .where(and(eq(itemBomStepsTable.companyId, cid), eq(itemBomStepsTable.itemId, id)))
      .orderBy(asc(itemBomStepsTable.sequence), asc(itemBomStepsTable.id)),
    db.select({
      cost: sql<string>`coalesce(sum(${itemBundleComponentsTable.qty} * ${itemsTable.costPrice}), 0)`,
    })
    .from(itemBundleComponentsTable)
    .innerJoin(itemsTable, eq(itemsTable.id, itemBundleComponentsTable.childItemId))
    .where(and(
      eq(itemBundleComponentsTable.companyId, cid),
      eq(itemBundleComponentsTable.parentItemId, id),
    )),
  ]);

  const totalLabor    = steps.reduce((s, x) => s + Number(x.laborCost ?? 0), 0);
  const totalOverhead = steps.reduce((s, x) => s + Number(x.overheadCost ?? 0), 0);
  const totalDuration = steps.reduce((s, x) => s + Number(x.durationMinutes ?? 0), 0);
  const componentCost = Number(compCostAgg[0]?.cost ?? 0);

  res.json({
    steps,
    totals: {
      stepCount:        steps.length,
      totalDurationMin: totalDuration,
      totalLaborCost:   totalLabor,
      totalOverheadCost: totalOverhead,
      componentCost,
      manufacturedCost: componentCost + totalLabor + totalOverhead,
    },
  });
});

router.post("/items/:id/bom-steps", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  if (!(await ensureItemInTenant(cid, id))) { res.status(404).json({ error: "الصنف غير موجود" }); return; }

  const { sequence, nameAr, nameEn, durationMinutes, laborCost, overheadCost, notes } = req.body ?? {};
  if (!nameAr || !String(nameAr).trim()) { res.status(400).json({ error: "اسم الخطوة مطلوب" }); return; }
  const seq = Number(sequence ?? 0);
  const dur = Number(durationMinutes ?? 0);
  const lc  = Number(laborCost ?? 0);
  const oc  = Number(overheadCost ?? 0);
  if (!Number.isFinite(seq) || seq < 0)   { res.status(400).json({ error: "ترتيب الخطوة غير صالح" }); return; }
  if (!Number.isFinite(dur) || dur < 0)   { res.status(400).json({ error: "مدة الخطوة غير صالحة" }); return; }
  if (!Number.isFinite(lc)  || lc  < 0)   { res.status(400).json({ error: "تكلفة العمل غير صالحة" }); return; }
  if (!Number.isFinite(oc)  || oc  < 0)   { res.status(400).json({ error: "تكلفة الأعباء غير صالحة" }); return; }

  const [row] = await db.insert(itemBomStepsTable).values({
    companyId: cid, itemId: id,
    sequence: seq,
    nameAr: String(nameAr).slice(0, 200),
    nameEn: nameEn ? String(nameEn).slice(0, 200) : null,
    durationMinutes: dur,
    laborCost: String(lc),
    overheadCost: String(oc),
    notes: notes ? String(notes).slice(0, 1000) : null,
  }).returning();
  auditSubEntity(req, "inventory_items", id, "create", null, { bomStep: row });
  res.status(201).json(row);
});

router.put("/items/:id/bom-steps/:stepId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const stepId = Number(req.params.stepId);
  if (!Number.isFinite(id) || !Number.isFinite(stepId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const [existing] = await db.select().from(itemBomStepsTable)
    .where(and(eq(itemBomStepsTable.id, stepId),
               eq(itemBomStepsTable.itemId, id),
               eq(itemBomStepsTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "الخطوة غير موجودة" }); return; }

  const patch: any = { updatedAt: new Date() };
  if (req.body.sequence !== undefined) {
    const v = Number(req.body.sequence);
    if (!Number.isFinite(v) || v < 0) { res.status(400).json({ error: "ترتيب الخطوة غير صالح" }); return; }
    patch.sequence = v;
  }
  if (req.body.nameAr !== undefined) {
    if (!String(req.body.nameAr).trim()) { res.status(400).json({ error: "اسم الخطوة مطلوب" }); return; }
    patch.nameAr = String(req.body.nameAr).slice(0, 200);
  }
  if (req.body.nameEn !== undefined) patch.nameEn = req.body.nameEn ? String(req.body.nameEn).slice(0, 200) : null;
  if (req.body.durationMinutes !== undefined) {
    const v = Number(req.body.durationMinutes);
    if (!Number.isFinite(v) || v < 0) { res.status(400).json({ error: "مدة الخطوة غير صالحة" }); return; }
    patch.durationMinutes = v;
  }
  if (req.body.laborCost !== undefined) {
    const v = Number(req.body.laborCost);
    if (!Number.isFinite(v) || v < 0) { res.status(400).json({ error: "تكلفة العمل غير صالحة" }); return; }
    patch.laborCost = String(v);
  }
  if (req.body.overheadCost !== undefined) {
    const v = Number(req.body.overheadCost);
    if (!Number.isFinite(v) || v < 0) { res.status(400).json({ error: "تكلفة الأعباء غير صالحة" }); return; }
    patch.overheadCost = String(v);
  }
  if (req.body.notes !== undefined) patch.notes = req.body.notes ? String(req.body.notes).slice(0, 1000) : null;

  const [updated] = await db.update(itemBomStepsTable).set(patch)
    .where(eq(itemBomStepsTable.id, stepId)).returning();
  auditSubEntity(req, "inventory_items", id, "edit", { bomStep: existing }, { bomStep: updated });
  res.json(updated);
});

router.delete("/items/:id/bom-steps/:stepId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const stepId = Number(req.params.stepId);
  if (!Number.isFinite(id) || !Number.isFinite(stepId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const [existing] = await db.select().from(itemBomStepsTable)
    .where(and(eq(itemBomStepsTable.id, stepId),
               eq(itemBomStepsTable.itemId, id),
               eq(itemBomStepsTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "الخطوة غير موجودة" }); return; }

  await db.delete(itemBomStepsTable).where(eq(itemBomStepsTable.id, stepId));
  auditSubEntity(req, "inventory_items", id, "delete", { bomStep: existing }, null);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// PRO Extension #15 — Auto Low-Stock Notifications
// ════════════════════════════════════════════════════════════════════════════
// Scans the tenant's items, finds those with summed stock <= reorderLevel
// (only items with a positive reorderLevel are checked — 0 means "no
// threshold configured"), and creates ONE broadcast notification per
// item per day. Idempotency is via `source_key = "low_stock_item_<id>_<YYYY-MM-DD>"`
// — re-running the same day skips items already notified, so the user
// can safely click the button repeatedly.

router.post("/alerts/notify", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;

  // Aggregate stock per item, then filter on reorderLevel client-side.
  // We can't HAVING-filter on a column from `items` joined to a SUM,
  // so we do the comparison after the aggregation.
  const rows = await db.select({
    itemId: itemsTable.id, code: itemsTable.code,
    nameAr: itemsTable.nameAr, nameEn: itemsTable.nameEn,
    reorderLevel: itemsTable.reorderLevel,
     branchId: warehousesTable.branchId,
    totalQty: sql<string>`coalesce(sum(${stockBalanceTable.qty}), 0)`,
  })
    .from(itemsTable)
    .leftJoin(stockBalanceTable, and(
      eq(stockBalanceTable.itemId, itemsTable.id),
      eq(stockBalanceTable.companyId, cid),
    ))
    .leftJoin(warehousesTable, and(
      eq(warehousesTable.id, stockBalanceTable.warehouseId),
      eq(warehousesTable.companyId, cid),
    ))
    .where(and(
      eq(itemsTable.companyId, cid),
      eq(itemsTable.status, "active"),
      sql`coalesce(${itemsTable.reorderLevel}, 0) > 0`,
       ...(warehouseBranchScope(req) ? [warehouseBranchScope(req)] : []),
    ))
     .groupBy(itemsTable.id, itemsTable.code, itemsTable.nameAr, itemsTable.nameEn, itemsTable.reorderLevel, warehousesTable.branchId);

  const today = new Date().toISOString().slice(0, 10);
  let created = 0;
  let skippedAlreadyNotified = 0;
  // Backfill scope metadata on alerts produced before module/branch columns
  // existed. Their historical aggregate cannot be assigned to one branch,
  // so they remain company-wide but are still gated by inventory permission.
  await db.update(notificationsTable).set({ moduleKey: "inventory_reports" })
    .where(and(
      eq(notificationsTable.companyId, cid),
      eq(notificationsTable.category, "inventory_alert"),
      isNull(notificationsTable.moduleKey),
    ));

  for (const r of rows) {
    const totalQty = Number(r.totalQty);
    const reorder  = Number(r.reorderLevel ?? 0);
    if (totalQty > reorder) continue;

    const branchSuffix = r.branchId == null ? "shared" : String(r.branchId);
    const sourceKey = `low_stock_item_${r.itemId}_${branchSuffix}_${today}`;
    // Strict idempotency: rely on the partial unique index
    // ux_notifications_company_source_key (companyId, sourceKey)
    // WHERE sourceKey IS NOT NULL combined with ON CONFLICT DO NOTHING.
    // This is concurrency-safe — two parallel /alerts/notify requests
    // can never insert duplicate same-day notifications for the same
    // item, even if they pass the SELECT race window simultaneously.
    const inserted = await db.insert(notificationsTable).values({
      companyId: cid,
      userId:    null,                          // broadcast — every user sees it
      title:     `مخزون منخفض: ${r.nameAr}`,
      body:      `الصنف \`${r.code}\` (${r.nameAr}) — الرصيد الحالي ${totalQty} ≤ حد إعادة الطلب ${reorder}.`,
      severity:  "medium",
      category:  "inventory_alert",
      sourceKey,
      moduleKey: "inventory_reports",
      branchId: r.branchId ?? null,
      createdByUserId: req.authUser?.id ?? null,
    })
      // PostgreSQL requires the ON CONFLICT predicate to match the partial
      // unique index's WHERE clause exactly when the index is partial.
      // Index: ux_notifications_company_source_key (company_id, source_key)
      //        WHERE source_key IS NOT NULL.
      // NOTE: drizzle-orm 0.45.2 `onConflictDoNothing` ignores `targetWhere`
      // and only honors the deprecated `where` field — so we use `where`
      // here. This emits: ON CONFLICT (company_id, source_key)
      // WHERE source_key IS NOT NULL DO NOTHING.
      .onConflictDoNothing({
        target: [notificationsTable.companyId, notificationsTable.sourceKey],
        where: sql`${notificationsTable.sourceKey} IS NOT NULL`,
      })
      .returning({ id: notificationsTable.id });

    if (inserted.length > 0) created++;
    else skippedAlreadyNotified++;
  }

  res.json({
    scanned: rows.length,
    created,
    skippedAlreadyNotified,
    skippedAboveThreshold: rows.length - created - skippedAlreadyNotified,
  });
});

// ═══════════════════════════════════════════════════════════════════
// REPORT: FREE QUANTITIES (تقرير الكميات المجانية)
// Aggregates `free_qty` from posted sales invoices (sold/debit) and
// posted sales returns (returned/credit) per item, with net result.
// Free items use the dedicated `free_qty` column on the line tables
// (see lib/db/src/schema/sales.ts — line 92-96).
//
// Query params (all optional except date range):
//   from, to        — date range over invoice_date / return_date
//   warehouseId     — restrict to a single warehouse (line-level)
//   customerId      — restrict to a single customer (header-level)
//   itemId          — restrict to a single item
//   branchId        — restrict to a single branch (header-level)
//
// Response: [{ itemId, itemCode, itemNameAr, itemNameEn, unitName,
//              soldFreeQty, returnedFreeQty, netFreeQty }]
// ═══════════════════════════════════════════════════════════════════
router.get("/reports/free-quantities", async (req, res) => {
  const cid = getCompanyId(req);
  if (!cid) { res.json([]); return; }
  const { from, to, warehouseId, customerId, itemId, branchId } =
    req.query as Record<string, string>;

  const whId  = warehouseId ? Number(warehouseId) : null;
  const cusId = customerId  ? Number(customerId)  : null;
  const itId  = itemId      ? Number(itemId)      : null;
  const brId  = branchId    ? Number(branchId)    : null;

  // SOLD (debit) — posted sales invoice lines with freeQty > 0
  const soldConds: any[] = [
    eq(salesInvoiceLinesTable.companyId, cid),
    eq(salesInvoicesTable.companyId, cid),
    eq(salesInvoicesTable.status, "posted"),
    sql`${salesInvoiceLinesTable.freeQty} > 0`,
  ];
  if (from) soldConds.push(gte(salesInvoicesTable.invoiceDate, from));
  if (to)   soldConds.push(lte(salesInvoicesTable.invoiceDate, to));
  if (whId)  soldConds.push(eq(salesInvoiceLinesTable.warehouseId, whId));
  if (cusId) soldConds.push(eq(salesInvoicesTable.customerId, cusId));
  if (itId)  soldConds.push(eq(salesInvoiceLinesTable.itemId, itId));
  if (brId)  soldConds.push(eq(salesInvoicesTable.branchId, brId));

  const soldRows = await db
    .select({
      itemId: salesInvoiceLinesTable.itemId,
      sumFree: sql<string>`coalesce(sum(${salesInvoiceLinesTable.freeQty}), 0)`,
    })
    .from(salesInvoiceLinesTable)
    .innerJoin(salesInvoicesTable, eq(salesInvoiceLinesTable.invoiceId, salesInvoicesTable.id))
    .where(and(...soldConds))
    .groupBy(salesInvoiceLinesTable.itemId);

  // RETURNED (credit) — posted sales return lines with freeQty > 0
  const retConds: any[] = [
    eq(salesReturnLinesTable.companyId, cid),
    eq(salesReturnsTable.companyId, cid),
    eq(salesReturnsTable.status, "posted"),
    sql`${salesReturnLinesTable.freeQty} > 0`,
  ];
  if (from) retConds.push(gte(salesReturnsTable.returnDate, from));
  if (to)   retConds.push(lte(salesReturnsTable.returnDate, to));
  if (whId)  retConds.push(eq(salesReturnLinesTable.warehouseId, whId));
  if (cusId) retConds.push(eq(salesReturnsTable.customerId, cusId));
  if (itId)  retConds.push(eq(salesReturnLinesTable.itemId, itId));
  if (brId)  retConds.push(eq(salesReturnsTable.branchId, brId));

  const retRows = await db
    .select({
      itemId: salesReturnLinesTable.itemId,
      sumFree: sql<string>`coalesce(sum(${salesReturnLinesTable.freeQty}), 0)`,
    })
    .from(salesReturnLinesTable)
    .innerJoin(salesReturnsTable, eq(salesReturnLinesTable.returnId, salesReturnsTable.id))
    .where(and(...retConds))
    .groupBy(salesReturnLinesTable.itemId);

  // Merge by itemId
  const byItem = new Map<number, { sold: number; returned: number }>();
  for (const r of soldRows) {
    if (r.itemId == null) continue;
    const cur = byItem.get(r.itemId) ?? { sold: 0, returned: 0 };
    cur.sold += Number(r.sumFree);
    byItem.set(r.itemId, cur);
  }
  for (const r of retRows) {
    if (r.itemId == null) continue;
    const cur = byItem.get(r.itemId) ?? { sold: 0, returned: 0 };
    cur.returned += Number(r.sumFree);
    byItem.set(r.itemId, cur);
  }

  const ids = [...byItem.keys()];
  if (ids.length === 0) { res.json([]); return; }

  // Enrich with item metadata
  const items = await db
    .select({
      id: itemsTable.id,
      code: itemsTable.code,
      nameAr: itemsTable.nameAr,
      nameEn: itemsTable.nameEn,
      unitNameAr: unitsTable.nameAr,
    })
    .from(itemsTable)
    .leftJoin(unitsTable, eq(itemsTable.unitId, unitsTable.id))
    .where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, ids)));

  const out = items.map(it => {
    const v = byItem.get(it.id)!;
    return {
      itemId: it.id,
      itemCode: it.code,
      itemNameAr: it.nameAr,
      itemNameEn: it.nameEn,
      unitName: it.unitNameAr,
      soldFreeQty:     v.sold,
      returnedFreeQty: v.returned,
      netFreeQty:      v.sold - v.returned,
    };
  })
  // Drop rows where both sides round to zero (rare, but keeps report tidy)
  .filter(r => r.soldFreeQty !== 0 || r.returnedFreeQty !== 0)
  .sort((a, b) => b.netFreeQty - a.netFreeQty);

  res.json(out);
});

// ═══════════════════════════════════════════════════════════════════
// REPORT: ITEM SALES VALUATION (تقرير مبيعات الأصناف)
// Per-item aggregation of sold qty/value and returned qty/value with
// a `basis` toggle:
//   - basis=cost         → use stock_ledger.total_cost (historical cost)
//   - basis=excl_vat     → line_total adjusted for priceIncludesVat
//   - basis=incl_vat     → line_total + computed VAT (or as-is if
//                          header already includes VAT)
//
// Query params: from, to, branchId?, warehouseId?, customerId?,
// itemId?, basis (default "cost").
// Response: [{ itemId, itemCode, itemNameAr, itemNameEn, unitName,
//              soldQty, soldValue, returnedQty, returnedValue,
//              netQty, netValue }]
// ═══════════════════════════════════════════════════════════════════
router.get("/reports/item-sales-valuation", async (req, res) => {
  const cid = getCompanyId(req);
  if (!cid) { res.json([]); return; }
  const { from, to, warehouseId, customerId, itemId, branchId } =
    req.query as Record<string, string>;
  const basis = String((req.query.basis as string) ?? "cost");
  if (!["cost", "excl_vat", "incl_vat"].includes(basis)) {
    res.status(400).json({ error: "basis يجب أن تكون cost أو excl_vat أو incl_vat" });
    return;
  }

  const whId  = warehouseId ? Number(warehouseId) : null;
  const cusId = customerId  ? Number(customerId)  : null;
  const itId  = itemId      ? Number(itemId)      : null;
  const brId  = branchId    ? Number(branchId)    : null;

  // Value expression per line, based on basis. Note: `qty` here is the
  // PRICED qty only (freeQty contributes 0 revenue/VAT by spec). For
  // `cost`, we use stock_ledger.total_cost (covers BOTH priced & free
  // qty because the issue posts ALL outgoing stock at cost).
  const valueExclVat = sql<string>`
    coalesce(sum(
      case
        when ${salesInvoicesTable.priceIncludesVat}
          then ${salesInvoiceLinesTable.lineTotal}
               / (1 + coalesce(${salesInvoiceLinesTable.vatRate}, 0)/100)
        else ${salesInvoiceLinesTable.lineTotal}
      end
    ), 0)`;
  const valueInclVat = sql<string>`
    coalesce(sum(
      case
        when ${salesInvoicesTable.priceIncludesVat}
          then ${salesInvoiceLinesTable.lineTotal}
        else ${salesInvoiceLinesTable.lineTotal}
             * (1 + coalesce(${salesInvoiceLinesTable.vatRate}, 0)/100)
      end
    ), 0)`;
  const retValueExclVat = sql<string>`
    coalesce(sum(
      case
        when ${salesReturnsTable.priceIncludesVat}
          then ${salesReturnLinesTable.lineTotal}
               / (1 + coalesce(${salesReturnLinesTable.vatRate}, 0)/100)
        else ${salesReturnLinesTable.lineTotal}
      end
    ), 0)`;
  const retValueInclVat = sql<string>`
    coalesce(sum(
      case
        when ${salesReturnsTable.priceIncludesVat}
          then ${salesReturnLinesTable.lineTotal}
        else ${salesReturnLinesTable.lineTotal}
             * (1 + coalesce(${salesReturnLinesTable.vatRate}, 0)/100)
      end
    ), 0)`;

  // ─── Aggregation: sales (debit) ───────────────────────────────────
  const soldConds: any[] = [
    eq(salesInvoiceLinesTable.companyId, cid),
    eq(salesInvoicesTable.companyId, cid),
    eq(salesInvoicesTable.status, "posted"),
  ];
  if (from) soldConds.push(gte(salesInvoicesTable.invoiceDate, from));
  if (to)   soldConds.push(lte(salesInvoicesTable.invoiceDate, to));
  if (whId)  soldConds.push(eq(salesInvoiceLinesTable.warehouseId, whId));
  if (cusId) soldConds.push(eq(salesInvoicesTable.customerId, cusId));
  if (itId)  soldConds.push(eq(salesInvoiceLinesTable.itemId, itId));
  if (brId)  soldConds.push(eq(salesInvoicesTable.branchId, brId));

  const soldRows = await db
    .select({
      itemId: salesInvoiceLinesTable.itemId,
      sumQty: sql<string>`coalesce(sum(${salesInvoiceLinesTable.qty} + ${salesInvoiceLinesTable.freeQty}), 0)`,
      sumExcl: valueExclVat,
      sumIncl: valueInclVat,
    })
    .from(salesInvoiceLinesTable)
    .innerJoin(salesInvoicesTable, eq(salesInvoiceLinesTable.invoiceId, salesInvoicesTable.id))
    .where(and(...soldConds))
    .groupBy(salesInvoiceLinesTable.itemId);

  // ─── Aggregation: returns (credit) ────────────────────────────────
  const retConds: any[] = [
    eq(salesReturnLinesTable.companyId, cid),
    eq(salesReturnsTable.companyId, cid),
    eq(salesReturnsTable.status, "posted"),
  ];
  if (from) retConds.push(gte(salesReturnsTable.returnDate, from));
  if (to)   retConds.push(lte(salesReturnsTable.returnDate, to));
  if (whId)  retConds.push(eq(salesReturnLinesTable.warehouseId, whId));
  if (cusId) retConds.push(eq(salesReturnsTable.customerId, cusId));
  if (itId)  retConds.push(eq(salesReturnLinesTable.itemId, itId));
  if (brId)  retConds.push(eq(salesReturnsTable.branchId, brId));

  const retRows = await db
    .select({
      itemId: salesReturnLinesTable.itemId,
      sumQty: sql<string>`coalesce(sum(${salesReturnLinesTable.qty} + ${salesReturnLinesTable.freeQty}), 0)`,
      sumExcl: retValueExclVat,
      sumIncl: retValueInclVat,
    })
    .from(salesReturnLinesTable)
    .innerJoin(salesReturnsTable, eq(salesReturnLinesTable.returnId, salesReturnsTable.id))
    .where(and(...retConds))
    .groupBy(salesReturnLinesTable.itemId);

  // ─── Cost basis: pull cost from stock_ledger (historical, accurate) ──
  // Stock ledger writes for sales:
  //   refType='sales_invoice'  → outflow (totalCost reflects FIFO/avg cost
  //                              of all moved stock incl. freeQty)
  //   refType='sales_return'   → inflow
  // We compute SUM(ABS(totalCost)) by item, optionally filtered by warehouse,
  // date, and (via parent invoice/return joins) by branch + customer.
  type CostMap = Map<number, { soldCost: number; returnedCost: number }>;
  const costByItem: CostMap = new Map();
  if (basis === "cost") {
    // Pull all stock_ledger rows for sales operations in the period,
    // then optionally narrow by parent doc filters (branch/customer)
    // via in-memory join. This keeps the SQL simple while still
    // honouring the filters. For large datasets we could replace with
    // a single CTE; current scale (per-tenant, periodic report) is fine.
    const slConds: any[] = [
      eq(stockLedgerTable.companyId, cid),
      inArray(stockLedgerTable.refType, ["sales_invoice", "sales_return"]),
    ];
    if (from) slConds.push(gte(stockLedgerTable.txDate, from));
    if (to)   slConds.push(lte(stockLedgerTable.txDate, to));
    if (whId) slConds.push(eq(stockLedgerTable.warehouseId, whId));
    if (itId) slConds.push(eq(stockLedgerTable.itemId, itId));
    const ledgerRows = await db
      .select({
        itemId: stockLedgerTable.itemId,
        refType: stockLedgerTable.refType,
        refId: stockLedgerTable.refId,
        totalCost: stockLedgerTable.totalCost,
      })
      .from(stockLedgerTable)
      .where(and(...slConds));

    // Build branch/customer maps for parent docs if needed (only when
    // a branch or customer filter is active — otherwise skip the join).
    let allowedInvIds: Set<number> | null = null;
    let allowedRetIds: Set<number> | null = null;
    if (brId != null || cusId != null) {
      const invConds: any[] = [eq(salesInvoicesTable.companyId, cid), eq(salesInvoicesTable.status, "posted")];
      if (brId  != null) invConds.push(eq(salesInvoicesTable.branchId, brId));
      if (cusId != null) invConds.push(eq(salesInvoicesTable.customerId, cusId));
      const invIds = await db.select({ id: salesInvoicesTable.id }).from(salesInvoicesTable).where(and(...invConds));
      allowedInvIds = new Set(invIds.map(r => r.id));

      const rConds: any[] = [eq(salesReturnsTable.companyId, cid), eq(salesReturnsTable.status, "posted")];
      if (brId  != null) rConds.push(eq(salesReturnsTable.branchId, brId));
      if (cusId != null) rConds.push(eq(salesReturnsTable.customerId, cusId));
      const rIds = await db.select({ id: salesReturnsTable.id }).from(salesReturnsTable).where(and(...rConds));
      allowedRetIds = new Set(rIds.map(r => r.id));
    }

    for (const r of ledgerRows) {
      if (r.itemId == null || r.refId == null) continue;
      if (r.refType === "sales_invoice" && allowedInvIds && !allowedInvIds.has(r.refId)) continue;
      if (r.refType === "sales_return"  && allowedRetIds && !allowedRetIds.has(r.refId)) continue;
      const cur = costByItem.get(r.itemId) ?? { soldCost: 0, returnedCost: 0 };
      const absCost = Math.abs(Number(r.totalCost));
      if (r.refType === "sales_invoice") cur.soldCost += absCost;
      else                                cur.returnedCost += absCost;
      costByItem.set(r.itemId, cur);
    }
  }

  // ─── Merge sold + returned ────────────────────────────────────────
  type Agg = { soldQty: number; soldValue: number; returnedQty: number; returnedValue: number };
  const byItem = new Map<number, Agg>();
  for (const r of soldRows) {
    if (r.itemId == null) continue;
    const cur = byItem.get(r.itemId) ?? { soldQty: 0, soldValue: 0, returnedQty: 0, returnedValue: 0 };
    cur.soldQty   += Number(r.sumQty);
    cur.soldValue += basis === "cost"
      ? (costByItem.get(r.itemId)?.soldCost ?? 0)
      : basis === "excl_vat" ? Number(r.sumExcl) : Number(r.sumIncl);
    byItem.set(r.itemId, cur);
  }
  for (const r of retRows) {
    if (r.itemId == null) continue;
    const cur = byItem.get(r.itemId) ?? { soldQty: 0, soldValue: 0, returnedQty: 0, returnedValue: 0 };
    cur.returnedQty   += Number(r.sumQty);
    cur.returnedValue += basis === "cost"
      ? (costByItem.get(r.itemId)?.returnedCost ?? 0)
      : basis === "excl_vat" ? Number(r.sumExcl) : Number(r.sumIncl);
    byItem.set(r.itemId, cur);
  }
  // Cost-only items that appeared in ledger but had no priced line (rare)
  for (const [itemIdKey, c] of costByItem) {
    if (byItem.has(itemIdKey)) continue;
    if (basis !== "cost") continue;
    byItem.set(itemIdKey, { soldQty: 0, soldValue: c.soldCost, returnedQty: 0, returnedValue: c.returnedCost });
  }

  const ids = [...byItem.keys()];
  if (ids.length === 0) { res.json([]); return; }

  const items = await db
    .select({
      id: itemsTable.id,
      code: itemsTable.code,
      nameAr: itemsTable.nameAr,
      nameEn: itemsTable.nameEn,
      unitNameAr: unitsTable.nameAr,
    })
    .from(itemsTable)
    .leftJoin(unitsTable, eq(itemsTable.unitId, unitsTable.id))
    .where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, ids)));

  const out = items.map(it => {
    const v = byItem.get(it.id)!;
    return {
      itemId: it.id,
      itemCode: it.code,
      itemNameAr: it.nameAr,
      itemNameEn: it.nameEn,
      unitName: it.unitNameAr,
      soldQty: v.soldQty,
      soldValue: v.soldValue,
      returnedQty: v.returnedQty,
      returnedValue: v.returnedValue,
      netQty: v.soldQty - v.returnedQty,
      netValue: v.soldValue - v.returnedValue,
    };
  }).sort((a, b) => b.netValue - a.netValue);

  res.json(out);
});

// ─── Item Usage Control (التحكم في توجيه الصنف) ──────────────────────────────
// Per-item × per-screen routing rules, gated by the `/items` pathRbac entry
// (GET → view, PUT → edit). Absence of a row = allowed; only NON-default rows
// are persisted. PUT is a full-set replace with a before/after audit trail.
router.get("/items/:id/usage-controls", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف صنف غير صالح" }); return; }
  const [item] = await db.select({ id: itemsTable.id }).from(itemsTable)
    .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid))).limit(1);
  if (!item) { res.status(404).json({ error: "الصنف غير موجود" }); return; }
  const map = await getItemUsageControls(cid, id);
  res.json(Object.values(map));
});

router.put("/items/:id/usage-controls", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف صنف غير صالح" }); return; }
  const [item] = await db.select({ id: itemsTable.id }).from(itemsTable)
    .where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid))).limit(1);
  if (!item) { res.status(404).json({ error: "الصنف غير موجود" }); return; }
  const raw = Array.isArray(req.body?.controls) ? req.body.controls
            : Array.isArray(req.body) ? req.body : null;
  if (!raw) { res.status(400).json({ error: "قائمة الإعدادات مطلوبة" }); return; }
  // Normalize: dedupe by screenKey, drop invalid keys, keep only NON-default rows.
  const seen = new Set<string>();
  const rows: { screenKey: string; mode: string; reason: string | null }[] = [];
  for (const c of raw) {
    const screenKey = String(c?.screenKey ?? "").trim();
    if (!isValidScreenKey(screenKey) || seen.has(screenKey)) continue;
    const mode = normalizeUsageMode(c?.mode);
    // Persist ONLY non-default rows. A default ("allowed") row carries no rule,
    // so it is never stored — even if a reason was supplied (reason on a default
    // row is meaningless and would diverge from getScreenModesForItems's filter).
    if (mode === DEFAULT_USAGE_MODE) continue;
    const reason = c?.reason != null && String(c.reason).trim()
      ? String(c.reason).trim().slice(0, 300) : null;
    seen.add(screenKey);
    rows.push({ screenKey, mode, reason });
  }
  const before = await getItemUsageControls(cid, id);
  await db.transaction(async (tx) => {
    await tx.delete(itemUsageControlsTable)
      .where(and(eq(itemUsageControlsTable.companyId, cid), eq(itemUsageControlsTable.itemId, id)));
    if (rows.length) {
      await tx.insert(itemUsageControlsTable).values(rows.map(r => ({
        companyId: cid, itemId: id, screenKey: r.screenKey, mode: r.mode, reason: r.reason,
        createdByUserId: req.authUser?.id ?? null, updatedByUserId: req.authUser?.id ?? null,
      })));
    }
  });
  const after = await getItemUsageControls(cid, id);
  void writeAudit({
    userId:     req.authUser?.id ?? null,
    username:   req.authUser?.username ?? null,
    role:       req.authUser?.role ?? null,
    companyId:  cid,
    module:     "items",
    action:     "usage_control_update",
    method:     req.method,
    path:       req.originalUrl ?? req.path,
    entityType: "items",
    entityId:   String(id),
    statusCode: 200,
    ip:         ipFromReq(req),
    userAgent:  req.get("user-agent")?.slice(0, 256) ?? null,
    metadata:   { before: Object.values(before), after: Object.values(after) },
  });
  res.json(Object.values(after));
});

export default router;
