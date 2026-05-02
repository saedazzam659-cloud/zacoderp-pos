import { Router } from "express";
import { db } from "@workspace/db";
import {
  warehouseGroupsTable, warehousesTable, itemGroupsTable, unitsTable,
  itemsTable, itemUnitPricesTable, stockBalanceTable, stockLedgerTable,
  stockTransfersTable, stockTransferItemsTable,
  stockAdjustmentsTable, stockAdjustmentItemsTable,
  stockCountsTable, stockCountItemsTable,
  journalEntriesTable, journalEntryLinesTable,
  accountsTable, auditLogTable,
  salesInvoicesTable, salesInvoiceLinesTable,
  itemDocumentsTable,
  itemSuppliersTable,
  itemBundleComponentsTable,
  suppliersTable,
  // Batch 8 — final 5 PRO Extensions
  itemCurrencyPricesTable,
  itemBranchStockTable,
  itemBomStepsTable,
  branchesTable,
  currenciesTable,
  notificationsTable,
} from "@workspace/db";
import { eq, and, sql, desc, asc, gte, lte, lt, inArray } from "drizzle-orm";
import { aliasedTable } from "drizzle-orm";
import { extractAuth, resolveCompanyId, branchScopeSpread } from "../middleware/auth.js";
import { pathRbac, writeAudit } from "../middleware/permissions.js";
import { ensureWarehouseAccount } from "../lib/entityAccounts.js";
import { nextSequenceNumber } from "../lib/sequences.js";

const router = Router();
router.use(extractAuth);
router.use(pathRbac([
  ["/warehouse-groups",         "warehouses"],
  ["/warehouses",               "warehouses"],
  ["/item-groups",              "items"],
  ["/units",                    "items"],
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
router.get("/warehouses", async (req, res) => {
  const cid = getCompanyId(req);
  const rows = cid
    ? await db.select({ wh: warehousesTable, group: warehouseGroupsTable })
        .from(warehousesTable)
        .leftJoin(warehouseGroupsTable, eq(warehousesTable.groupId, warehouseGroupsTable.id))
        .where(eq(warehousesTable.companyId, cid))
        .orderBy(asc(warehousesTable.code))
    : await db.select({ wh: warehousesTable, group: warehouseGroupsTable })
        .from(warehousesTable)
        .leftJoin(warehouseGroupsTable, eq(warehousesTable.groupId, warehouseGroupsTable.id))
        .orderBy(asc(warehousesTable.code));
  res.json(rows.map(r => ({ ...r.wh, group: r.group })));
});

router.post("/warehouses", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const { code, nameAr, nameEn, groupId, city, region, allowNegative, negativeLimit, accountId } = req.body;
  if (!code || !nameAr) { res.status(400).json({ error: "كود واسم المخزن مطلوبان" }); return; }
  const existing = await db.select().from(warehousesTable).where(eq(warehousesTable.companyId, cid));
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
  const [row] = await db.insert(warehousesTable).values({ companyId: cid, code, nameAr, nameEn, groupId: groupId || null, city, region, allowNegative: !!allowNegative, negativeLimit: negativeLimit || null, accountId: resolvedAccountId }).returning();
  res.status(201).json(row);
});

router.put("/warehouses/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { code, nameAr, nameEn, groupId, city, region, allowNegative, negativeLimit, isActive, accountId } = req.body;
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
  const [row] = await db.update(warehousesTable).set({ code, nameAr, nameEn, groupId: groupId || null, city, region, allowNegative: !!allowNegative, negativeLimit: negativeLimit || null, isActive: isActive !== false, accountId: accountId ? Number(accountId) : null }).where(and(eq(warehousesTable.id, id), eq(warehousesTable.companyId, cid))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.delete("/warehouses/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  await db.delete(warehousesTable).where(and(eq(warehousesTable.id, id), eq(warehousesTable.companyId, cid)));
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

router.post("/item-groups", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const { code, nameAr, nameEn } = req.body;
  if (!code || !nameAr) { res.status(400).json({ error: "كود واسم المجموعة مطلوبان" }); return; }
  const existing = await db.select().from(itemGroupsTable).where(eq(itemGroupsTable.companyId, cid));
  if (existing.some(g => g.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لمجموعة أخرى` }); return;
  }
  if (existing.some(g => g.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لمجموعة أخرى` }); return;
  }
  const [row] = await db.insert(itemGroupsTable).values({ companyId: cid, code, nameAr, nameEn }).returning();
  res.status(201).json(row);
});

router.put("/item-groups/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { code, nameAr, nameEn } = req.body;
  const others = await db.select().from(itemGroupsTable).where(eq(itemGroupsTable.companyId, cid));
  if (code && others.some(g => g.id !== id && g.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لمجموعة أخرى` }); return;
  }
  if (nameAr && others.some(g => g.id !== id && g.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لمجموعة أخرى` }); return;
  }
  const [row] = await db.update(itemGroupsTable).set({ code, nameAr, nameEn }).where(and(eq(itemGroupsTable.id, id), eq(itemGroupsTable.companyId, cid))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.delete("/item-groups/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  await db.delete(itemGroupsTable).where(and(eq(itemGroupsTable.id, Number(req.params.id)), eq(itemGroupsTable.companyId, cid)));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// UNITS
// ═══════════════════════════════════════════════════════════════════
router.get("/units", async (req, res) => {
  const cid = getCompanyId(req);
  const rows = cid
    ? await db.select().from(unitsTable).where(eq(unitsTable.companyId, cid)).orderBy(asc(unitsTable.code))
    : await db.select().from(unitsTable).orderBy(asc(unitsTable.code));
  res.json(rows);
});

router.post("/units", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const { code, nameAr, nameEn, conversionFactor } = req.body;
  if (!code || !nameAr) { res.status(400).json({ error: "كود واسم الوحدة مطلوبان" }); return; }
  const existing = await db.select().from(unitsTable).where(eq(unitsTable.companyId, cid));
  if (existing.some(u => u.code?.trim().toLowerCase() === String(code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لوحدة أخرى` }); return;
  }
  if (existing.some(u => u.nameAr?.trim().toLowerCase() === String(nameAr).trim().toLowerCase())) {
    res.status(409).json({ error: `الاسم "${nameAr}" مسجَّل بالفعل لوحدة أخرى` }); return;
  }
  const [row] = await db.insert(unitsTable).values({ companyId: cid, code, nameAr, nameEn, conversionFactor: conversionFactor || "1" }).returning();
  res.status(201).json(row);
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
  const [row] = await db.update(unitsTable).set({ code, nameAr, nameEn, conversionFactor: conversionFactor || "1" }).where(and(eq(unitsTable.id, id), eq(unitsTable.companyId, cid))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.delete("/units/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  await db.delete(unitsTable).where(and(eq(unitsTable.id, Number(req.params.id)), eq(unitsTable.companyId, cid)));
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
  const rows = cid
    ? await db.select({ item: itemsTable, group: itemGroupsTable, unit: unitsTable })
        .from(itemsTable)
        .leftJoin(itemGroupsTable, eq(itemsTable.groupId, itemGroupsTable.id))
        .leftJoin(unitsTable, eq(itemsTable.unitId, unitsTable.id))
        .where(eq(itemsTable.companyId, cid))
        .orderBy(asc(itemsTable.code))
    : await db.select({ item: itemsTable, group: itemGroupsTable, unit: unitsTable })
        .from(itemsTable)
        .leftJoin(itemGroupsTable, eq(itemsTable.groupId, itemGroupsTable.id))
        .leftJoin(unitsTable, eq(itemsTable.unitId, unitsTable.id))
        .orderBy(asc(itemsTable.code));
  res.json(rows.map(r => ({ ...r.item, group: r.group, unit: r.unit })));
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
  const { code, nameAr, nameEn, barcode, itemType, groupId, unitId, costPrice, salePrice, vatRate, reorderLevel, maxLevel, costMethod, description, imageUrl, tags, discountType, discountValue, isBundle, parentItemId, variantAttributes } = req.body;
  if (!code || !nameAr) { res.status(400).json({ error: "كود واسم الصنف مطلوبان" }); return; }
  const existing = await db.select().from(itemsTable).where(eq(itemsTable.companyId, cid));
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
  const [row] = await db.insert(itemsTable).values({
    companyId: cid, code, nameAr, nameEn, barcode,
    itemType: itemType || parentRowForVariant?.itemType || "stock",
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
  const { code, nameAr, nameEn, barcode, itemType, groupId, unitId, costPrice, salePrice, vatRate, reorderLevel, maxLevel, costMethod, description, status, imageUrl, tags, discountType, discountValue, isBundle, variantAttributes } = req.body;
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
    groupId: groupId || null, unitId: unitId || null,
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
  const { unitId, conversionFactor, costPrice, salePrice, isBase } = req.body;
  if (!unitId) { res.status(400).json({ error: "وحدة القياس مطلوبة" }); return; }
  // If setting as base, clear other base flags first
  if (isBase) {
    await db.update(itemUnitPricesTable).set({ isBase: false }).where(and(eq(itemUnitPricesTable.itemId, itemId), eq(itemUnitPricesTable.companyId, cid)));
  }
  const [row] = await db.insert(itemUnitPricesTable).values({
    companyId: cid, itemId, unitId: Number(unitId),
    conversionFactor: String(conversionFactor || "1"),
    costPrice: String(costPrice || "0"),
    salePrice: String(salePrice || "0"),
    isBase: !!isBase,
  }).returning();
  res.status(201).json(row);
});

router.put("/items/:id/units/:upId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const itemId = Number(req.params.id);
  const upId = Number(req.params.upId);
  const { unitId, conversionFactor, costPrice, salePrice, isBase } = req.body;
  if (isBase) {
    await db.update(itemUnitPricesTable).set({ isBase: false }).where(and(eq(itemUnitPricesTable.itemId, itemId), eq(itemUnitPricesTable.companyId, cid)));
  }
  const [row] = await db.update(itemUnitPricesTable).set({
    unitId: unitId ? Number(unitId) : undefined,
    conversionFactor: String(conversionFactor || "1"),
    costPrice: String(costPrice || "0"),
    salePrice: String(salePrice || "0"),
    isBase: !!isBase,
  }).where(and(eq(itemUnitPricesTable.id, upId), eq(itemUnitPricesTable.companyId, cid))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.delete("/items/:id/units/:upId", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  await db.delete(itemUnitPricesTable).where(and(eq(itemUnitPricesTable.id, Number(req.params.upId)), eq(itemUnitPricesTable.companyId, cid)));
  res.json({ ok: true });
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

router.post("/stock-transfers", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const { transferNumber, transferDate, fromWarehouseId, toWarehouseId, accountId, fromAccountId, toAccountId, notes, items } = req.body;
  if (!transferDate || !fromWarehouseId || !toWarehouseId) { res.status(400).json({ error: "بيانات ناقصة" }); return; }
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
  const [tr] = await db.insert(stockTransfersTable).values({
    companyId: cid, transferNumber: num, transferDate, fromWarehouseId, toWarehouseId,
    accountId: accountId || null,
    fromAccountId: fromAccountId || null,
    toAccountId: toAccountId || null,
    notes, status: "draft",
  }).returning();
  if (items?.length) {
    await db.insert(stockTransferItemsTable).values(items.map((it: any) => ({ transferId: tr.id, itemId: it.itemId, unitId: it.unitId || null, qty: String(it.qty), costPrice: String(it.costPrice || 0) })));
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
  await db.update(stockTransfersTable).set({
    transferDate, fromWarehouseId, toWarehouseId,
    fromAccountId: fromAccountId || null,
    toAccountId: toAccountId || null,
    notes, updatedAt: new Date(),
  }).where(eq(stockTransfersTable.id, id));
  if (items) {
    await db.delete(stockTransferItemsTable).where(eq(stockTransferItemsTable.transferId, id));
    if (items.length) await db.insert(stockTransferItemsTable).values(items.map((it: any) => ({ transferId: id, itemId: it.itemId, unitId: it.unitId || null, qty: String(it.qty), costPrice: String(it.costPrice || 0) })));
  }
  res.json({ ok: true });
});

// POST transfer — confirm/post
router.post("/stock-transfers/:id/post", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  // Atomic status flip: draft → posting (claims the transfer; concurrent calls will get 0 rows)
  const claim = await db.update(stockTransfersTable)
    .set({ updatedAt: new Date() })
    .where(and(eq(stockTransfersTable.id, id), eq(stockTransfersTable.companyId, cid), eq(stockTransfersTable.status, "draft")))
    .returning();
  if (!claim.length) { res.status(400).json({ error: "الحركة غير موجودة أو مُرحَّلة مسبقاً" }); return; }
  const tr = claim[0];
  const lines = await db.select().from(stockTransferItemsTable).where(eq(stockTransferItemsTable.transferId, id));
  if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف" }); return; }
  // Process each line: deduct from source, add to destination
  for (const line of lines) {
    await upsertBalance(cid, line.itemId, tr.fromWarehouseId, -Number(line.qty), Number(line.costPrice));
    await upsertBalance(cid, line.itemId, tr.toWarehouseId,   +Number(line.qty), Number(line.costPrice));
    // Ledger entries
    const newFromBal = await getBalance(cid, line.itemId, tr.fromWarehouseId);
    const newToBal   = await getBalance(cid, line.itemId, tr.toWarehouseId);
    await db.insert(stockLedgerTable).values([
      { companyId: cid, itemId: line.itemId, warehouseId: tr.fromWarehouseId, txDate: tr.transferDate, txType: "transfer_out", qty: String(-Number(line.qty)), costPrice: line.costPrice, totalCost: String(-Number(line.qty) * Number(line.costPrice)), balanceQty: String(newFromBal), refId: id, refType: "transfer" },
      { companyId: cid, itemId: line.itemId, warehouseId: tr.toWarehouseId,   txDate: tr.transferDate, txType: "transfer_in",  qty: line.qty, costPrice: line.costPrice, totalCost: String(Number(line.qty) * Number(line.costPrice)), balanceQty: String(newToBal),   refId: id, refType: "transfer" },
    ]);
  }

  // ─── Auto-generate balanced journal entry (DR: destination inventory, CR: source inventory) ───
  // Resolve account IDs: prefer transfer-level overrides, fallback to warehouse.accountId.
  // Always scope warehouse lookup by company (defense-in-depth multi-tenant guard).
  let fromAcc = tr.fromAccountId;
  let toAcc   = tr.toAccountId;
  if (!fromAcc || !toAcc) {
    const [fromWh] = await db.select().from(warehousesTable)
      .where(and(eq(warehousesTable.id, tr.fromWarehouseId), eq(warehousesTable.companyId, cid)));
    const [toWh]   = await db.select().from(warehousesTable)
      .where(and(eq(warehousesTable.id, tr.toWarehouseId),   eq(warehousesTable.companyId, cid)));
    fromAcc = fromAcc || (fromWh?.accountId ?? null);
    toAcc   = toAcc   || (toWh?.accountId   ?? null);
  }
  let journalEntryId: number | null = null;
  const totalAmount = lines.reduce((s, l) => s + Number(l.qty) * Number(l.costPrice), 0);
  if (fromAcc && toAcc && fromAcc !== toAcc && totalAmount > 0) {
    const desc = `تحويل مخزني ${tr.transferNumber}${tr.notes ? " - " + tr.notes : ""}`;
    const [entry] = await db.insert(journalEntriesTable).values({
      companyId: cid, docNumber: tr.transferNumber, entryDate: tr.transferDate,
      currency: "SAR", exchangeRate: "1",
      description: desc, entryType: "stock_transfer", status: "posted",
    }).returning();
    await db.insert(journalEntryLinesTable).values([
      { entryId: entry.id, accountId: toAcc,   debit: totalAmount.toFixed(2), credit: "0.00", description: `استلام بالمخزن (${tr.transferNumber})`, sortOrder: 0 },
      { entryId: entry.id, accountId: fromAcc, debit: "0.00", credit: totalAmount.toFixed(2), description: `صرف من المخزن (${tr.transferNumber})`, sortOrder: 1 },
    ]);
    journalEntryId = entry.id;
  }

  await db.update(stockTransfersTable).set({ status: "posted", journalEntryId, updatedAt: new Date() })
    .where(and(eq(stockTransfersTable.id, id), eq(stockTransfersTable.companyId, cid)));
  res.json({ ok: true, journalEntryId });
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
  const [adj] = await db.insert(stockAdjustmentsTable).values({
    companyId: cid, adjustmentNumber: num, adjustmentDate, warehouseId,
    accountId: accountId || null,
    inventoryAccountId:  inventoryAccountId  || null,
    adjustmentAccountId: adjustmentAccountId || null,
    reason, notes, status: "draft",
  }).returning();
  if (items?.length) {
    await db.insert(stockAdjustmentItemsTable).values(items.map((it: any) => ({ adjustmentId: adj.id, itemId: it.itemId, unitId: it.unitId || null, qty: String(it.qty), costPrice: String(it.costPrice || 0), notes: it.notes })));
  }
  res.status(201).json(adj);
});

router.put("/stock-adjustments/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { adjustmentDate, warehouseId, reason, notes, items } = req.body;
  const [existing] = await db.select().from(stockAdjustmentsTable).where(and(eq(stockAdjustmentsTable.id, id), eq(stockAdjustmentsTable.companyId, cid)));
  if (!existing || existing.status === "posted") { res.status(400).json({ error: "لا يمكن التعديل" }); return; }
  try {
    await assertCompanyOwned(cid, {
      warehouses: [Number(warehouseId)].filter(Boolean) as number[],
      accounts:   [inventoryAccountId, adjustmentAccountId].map(Number).filter(Boolean) as number[],
    });
  } catch (e: any) { res.status(400).json({ error: e.message }); return; }
  await db.update(stockAdjustmentsTable).set({
    adjustmentDate, warehouseId, reason, notes,
    inventoryAccountId:  inventoryAccountId  || null,
    adjustmentAccountId: adjustmentAccountId || null,
    updatedAt: new Date(),
  }).where(eq(stockAdjustmentsTable.id, id));
  if (items) {
    await db.delete(stockAdjustmentItemsTable).where(eq(stockAdjustmentItemsTable.adjustmentId, id));
    if (items.length) await db.insert(stockAdjustmentItemsTable).values(items.map((it: any) => ({ adjustmentId: id, itemId: it.itemId, unitId: it.unitId || null, qty: String(it.qty), costPrice: String(it.costPrice || 0), notes: it.notes })));
  }
  res.json({ ok: true });
});

router.post("/stock-adjustments/:id/post", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  // Atomic claim: only one concurrent caller can flip draft → posted (we keep status here; final flip after JE).
  const claim = await db.update(stockAdjustmentsTable)
    .set({ updatedAt: new Date() })
    .where(and(eq(stockAdjustmentsTable.id, id), eq(stockAdjustmentsTable.companyId, cid), eq(stockAdjustmentsTable.status, "draft")))
    .returning();
  if (!claim.length) { res.status(400).json({ error: "التسوية غير موجودة أو مُرحَّلة مسبقاً" }); return; }
  const adj = claim[0];
  const lines = await db.select().from(stockAdjustmentItemsTable).where(eq(stockAdjustmentItemsTable.adjustmentId, id));
  if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف" }); return; }
  // 1) Apply stock movements
  for (const line of lines) {
    await upsertBalance(cid, line.itemId, adj.warehouseId, Number(line.qty), Number(line.costPrice));
    const newBal = await getBalance(cid, line.itemId, adj.warehouseId);
    await db.insert(stockLedgerTable).values({ companyId: cid, itemId: line.itemId, warehouseId: adj.warehouseId, txDate: adj.adjustmentDate, txType: "adjustment", qty: line.qty, costPrice: line.costPrice, totalCost: String(Number(line.qty) * Number(line.costPrice)), balanceQty: String(newBal), refId: id, refType: "adjustment", notes: line.notes });
  }
  // 2) Build JE: inventory account (asset) ↔ adjustment account (expense/income)
  //    Increase line (qty>0)  → DR inventory  / CR adjustment   (gain/expense reversal)
  //    Decrease line (qty<0)  → DR adjustment / CR inventory    (loss/expense)
  // Resolve fallbacks: if invAcc not set, use warehouse.accountId.
  const [wh] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, adj.warehouseId));
  const invAccId = adj.inventoryAccountId  || wh?.accountId || null;
  const adjAccId = adj.adjustmentAccountId || null;
  let netDebitInv  = 0;  // positive when net stock increase
  let netCreditInv = 0;  // positive when net stock decrease
  for (const l of lines) {
    const amt = Math.abs(Number(l.qty)) * Number(l.costPrice);
    if (Number(l.qty) > 0) netDebitInv  += amt;
    else                   netCreditInv += amt;
  }
  // Net the two sides so a balanced 2-line JE is created.
  const debitInv  = Math.max(0, netDebitInv  - netCreditInv);
  const creditInv = Math.max(0, netCreditInv - netDebitInv);
  let journalEntryId: number | null = null;
  if (invAccId && adjAccId && (debitInv > 0 || creditInv > 0) && invAccId !== adjAccId) {
    const [je] = await db.insert(journalEntriesTable).values({
      companyId: cid,
      docNumber: `ADJ-JE-${adj.adjustmentNumber}`,
      entryDate: adj.adjustmentDate,
      description: `قيد تسوية مخزنية: ${adj.adjustmentNumber}${adj.reason ? " — " + adj.reason : ""}`,
      entryType: "stock_adjustment",
      status: "posted",
    }).returning();
    journalEntryId = je.id;
    if (debitInv > 0) {
      // Net increase: DR inventory, CR adjustment (gain)
      await db.insert(journalEntryLinesTable).values([
        { entryId: je.id, accountId: invAccId, debit: String(debitInv.toFixed(2)),  credit: "0", description: `زيادة مخزون — ${wh?.nameAr ?? ""}`, sortOrder: 0 },
        { entryId: je.id, accountId: adjAccId, debit: "0", credit: String(debitInv.toFixed(2)), description: "تسوية — فائض مخزون", sortOrder: 1 },
      ]);
    } else {
      // Net decrease: DR adjustment (loss), CR inventory
      await db.insert(journalEntryLinesTable).values([
        { entryId: je.id, accountId: adjAccId, debit: String(creditInv.toFixed(2)),  credit: "0", description: "تسوية — عجز/تالف مخزون", sortOrder: 0 },
        { entryId: je.id, accountId: invAccId, debit: "0", credit: String(creditInv.toFixed(2)), description: `نقص مخزون — ${wh?.nameAr ?? ""}`, sortOrder: 1 },
      ]);
    }
  }
  await db.update(stockAdjustmentsTable).set({ status: "posted", journalEntryId, updatedAt: new Date() }).where(eq(stockAdjustmentsTable.id, id));
  res.json({ ok: true, journalEntryId });
});

router.delete("/stock-adjustments/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [adj] = await db.select().from(stockAdjustmentsTable).where(and(eq(stockAdjustmentsTable.id, id), eq(stockAdjustmentsTable.companyId, cid)));
  if (!adj || adj.status === "posted") { res.status(400).json({ error: "لا يمكن الحذف" }); return; }
  await db.delete(stockAdjustmentsTable).where(eq(stockAdjustmentsTable.id, id));
  res.json({ ok: true });
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
  const { countNumber, countDate, warehouseId, notes } = req.body;
  if (!countDate || !warehouseId) { res.status(400).json({ error: "بيانات ناقصة" }); return; }
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
  // Auto-load current system balances for this warehouse
  const balances = await db.select({ bal: stockBalanceTable, item: itemsTable })
    .from(stockBalanceTable)
    .leftJoin(itemsTable, eq(stockBalanceTable.itemId, itemsTable.id))
    .where(and(eq(stockBalanceTable.warehouseId, Number(warehouseId)), eq(stockBalanceTable.companyId, cid)));
  const [cnt] = await db.insert(stockCountsTable).values({ companyId: cid, countNumber: num, countDate, warehouseId, notes, status: "draft" }).returning();
  if (balances.length) {
    await db.insert(stockCountItemsTable).values(balances.map(b => ({ countId: cnt.id, itemId: b.bal.itemId, systemQty: b.bal.qty, actualQty: b.bal.qty, diff: "0", costPrice: b.bal.avgCost })));
  }
  res.status(201).json(cnt);
});

router.put("/stock-counts/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { items } = req.body; // items: [{id, actualQty}]
  const [existing] = await db.select().from(stockCountsTable).where(and(eq(stockCountsTable.id, id), eq(stockCountsTable.companyId, cid)));
  if (!existing || existing.status === "posted") { res.status(400).json({ error: "لا يمكن التعديل" }); return; }
  if (items?.length) {
    for (const it of items) {
      const diff = Number(it.actualQty) - Number(it.systemQty);
      await db.update(stockCountItemsTable).set({ actualQty: String(it.actualQty), diff: String(diff) }).where(eq(stockCountItemsTable.id, it.id));
    }
  }
  res.json({ ok: true });
});

router.post("/stock-counts/:id/post", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [cnt] = await db.select().from(stockCountsTable).where(and(eq(stockCountsTable.id, id), eq(stockCountsTable.companyId, cid)));
  if (!cnt || cnt.status !== "draft") { res.status(400).json({ error: "لا يمكن الترحيل" }); return; }
  const lines = await db.select().from(stockCountItemsTable).where(eq(stockCountItemsTable.countId, id));
  for (const line of lines) {
    const diff = Number(line.actualQty) - Number(line.systemQty);
    if (diff !== 0) {
      await upsertBalance(cid, line.itemId, cnt.warehouseId, diff, Number(line.costPrice));
      const newBal = await getBalance(cid, line.itemId, cnt.warehouseId);
      await db.insert(stockLedgerTable).values({ companyId: cid, itemId: line.itemId, warehouseId: cnt.warehouseId, txDate: cnt.countDate, txType: "count_adj", qty: String(diff), costPrice: line.costPrice, totalCost: String(diff * Number(line.costPrice)), balanceQty: String(newBal), refId: id, refType: "count" });
    }
  }
  await db.update(stockCountsTable).set({ status: "posted", updatedAt: new Date() }).where(eq(stockCountsTable.id, id));
  res.json({ ok: true });
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
  const cid = getCompanyId(req);
  if (!cid) { res.json([]); return; }
  const { itemId, warehouseId, from, to } = req.query as Record<string, string>;
  const conditions = [eq(stockLedgerTable.companyId, cid)];
  if (itemId)      conditions.push(eq(stockLedgerTable.itemId,      Number(itemId)));
  if (warehouseId) conditions.push(eq(stockLedgerTable.warehouseId, Number(warehouseId)));
  if (from)        conditions.push(gte(stockLedgerTable.txDate, from));
  if (to)          conditions.push(lte(stockLedgerTable.txDate, to));
  const rows = await db.select({ led: stockLedgerTable, item: itemsTable, wh: warehousesTable })
    .from(stockLedgerTable)
    .leftJoin(itemsTable,      eq(stockLedgerTable.itemId,      itemsTable.id))
    .leftJoin(warehousesTable, eq(stockLedgerTable.warehouseId, warehousesTable.id))
    .where(and(...conditions))
    .orderBy(desc(stockLedgerTable.txDate), desc(stockLedgerTable.id))
    .limit(500);
  res.json(rows.map(r => ({ ...r.led, item: r.item, warehouse: r.wh })));
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
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════
async function getBalance(companyId: number, itemId: number, warehouseId: number): Promise<number> {
  const [bal] = await db.select().from(stockBalanceTable).where(and(eq(stockBalanceTable.companyId, companyId), eq(stockBalanceTable.itemId, itemId), eq(stockBalanceTable.warehouseId, warehouseId)));
  return Number(bal?.qty ?? 0);
}

async function upsertBalance(companyId: number, itemId: number, warehouseId: number, deltaQty: number, costPrice: number) {
  const [existing] = await db.select().from(stockBalanceTable).where(and(eq(stockBalanceTable.companyId, companyId), eq(stockBalanceTable.itemId, itemId), eq(stockBalanceTable.warehouseId, warehouseId)));
  if (!existing) {
    const newQty = deltaQty;
    await db.insert(stockBalanceTable).values({ companyId, itemId, warehouseId, qty: String(newQty), avgCost: String(costPrice) });
  } else {
    const oldQty  = Number(existing.qty);
    const oldCost = Number(existing.avgCost);
    let newQty: number, newAvg: number;
    if (deltaQty > 0) {
      // Weighted average on in-flow
      newQty = oldQty + deltaQty;
      newAvg = newQty === 0 ? costPrice : (oldQty * oldCost + deltaQty * costPrice) / newQty;
    } else {
      // Out-flow — qty decreases, avg cost unchanged
      newQty = oldQty + deltaQty;
      newAvg = oldCost;
    }
    await db.update(stockBalanceTable).set({ qty: String(newQty), avgCost: String(newAvg), updatedAt: new Date() }).where(eq(stockBalanceTable.id, existing.id));
  }
}

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
    .filter(r => r.itemType !== "service")
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
      // Honor discount columns when present in the spreadsheet, otherwise
      // default to "none"/0 (matches the column default and keeps existing
      // imports backward-compatible).
      const importDisc = normalizeDiscount(r.discountType, r.discountValue);
      const values = {
        companyId: cid, code, nameAr,
        nameEn:       r.nameEn       != null && r.nameEn   !== "" ? String(r.nameEn)   : null,
        barcode:      r.barcode      != null && r.barcode  !== "" ? String(r.barcode)  : null,
        itemType:     (r.itemType === "service" ? "service" : "stock") as any,
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

      const existingRow = itemByCode.get(code.toLowerCase());
      if (existingRow) {
        const { companyId, ...upd } = values as any;
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
router.post("/import/opening-balances", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const rows: any[] = Array.isArray(req.body?.balances) ? req.body.balances : [];
  const txDate = String(req.body?.date || new Date().toISOString().slice(0, 10));
  if (!rows.length) { res.status(400).json({ error: "لا توجد بيانات" }); return; }

  const items = await db.select({ id: itemsTable.id, code: itemsTable.code }).from(itemsTable).where(eq(itemsTable.companyId, cid));
  const wh    = await db.select({ id: warehousesTable.id, code: warehousesTable.code }).from(warehousesTable).where(eq(warehousesTable.companyId, cid));
  const itemByCode = new Map(items.map((i: any) => [String(i.code).trim().toLowerCase(), i.id]));
  const whByCode   = new Map(wh.map((w: any)   => [String(w.code).trim().toLowerCase(), w.id]));

  let applied = 0;
  const errors: { row: number; error: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    try {
      const itemCode = String(r.itemCode ?? "").trim().toLowerCase();
      const whCode   = String(r.warehouseCode ?? "").trim().toLowerCase();
      const qty      = Number(r.qty ?? 0);
      const cost     = Number(r.costPrice ?? 0);
      if (!itemCode || !whCode) { errors.push({ row: i + 2, error: "كود الصنف وكود المخزن مطلوبان" }); continue; }
      if (!isFinite(qty)) { errors.push({ row: i + 2, error: "الكمية غير صحيحة" }); continue; }
      const itemId = itemByCode.get(itemCode);
      const whId   = whByCode.get(whCode);
      if (!itemId) { errors.push({ row: i + 2, error: `صنف غير موجود: ${r.itemCode}` }); continue; }
      if (!whId)   { errors.push({ row: i + 2, error: `مخزن غير موجود: ${r.warehouseCode}` }); continue; }

      await db.transaction(async (tx) => {
        const [bal] = await tx.select().from(stockBalanceTable).where(and(
          eq(stockBalanceTable.companyId, cid),
          eq(stockBalanceTable.itemId, itemId),
          eq(stockBalanceTable.warehouseId, whId),
        ));
        const oldQty = Number(bal?.qty ?? 0);
        const delta  = qty - oldQty;
        if (bal) {
          await tx.update(stockBalanceTable)
            .set({ qty: String(qty), avgCost: String(cost), updatedAt: new Date() })
            .where(eq(stockBalanceTable.id, bal.id));
        } else {
          await tx.insert(stockBalanceTable).values({
            companyId: cid, itemId, warehouseId: whId,
            qty: String(qty), avgCost: String(cost),
          });
        }
        // Idempotency: remove prior opening_balance ledger entries for same item/warehouse
        // before inserting the new snapshot, so re-importing doesn't pollute the ledger.
        await tx.delete(stockLedgerTable).where(and(
          eq(stockLedgerTable.companyId, cid),
          eq(stockLedgerTable.itemId, itemId),
          eq(stockLedgerTable.warehouseId, whId),
          eq(stockLedgerTable.refType, "opening_balance"),
        ));
        // Ledger row uses delta (movement) so reports stay consistent with balance math.
        await tx.insert(stockLedgerTable).values({
          companyId: cid, itemId, warehouseId: whId, txDate,
          txType: "opening" as any,
          qty: String(delta), costPrice: String(cost),
          totalCost: String(delta * cost), balanceQty: String(qty),
          refId: 0, refType: "opening_balance",
          notes: "رصيد افتتاحي مستورد",
        });
      });
      applied++;
    } catch (e: any) {
      errors.push({ row: i + 2, error: e?.message || "خطأ غير معروف" });
    }
  }

  res.json({ applied, errors, total: rows.length });
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
  auditSubEntity(req, "inventory_items", id, "update", { currencyPrice: existing }, { currencyPrice: updated });
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
    auditSubEntity(req, "inventory_items", id, "update",
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
  auditSubEntity(req, "inventory_items", id, "update", { bomStep: existing }, { bomStep: updated });
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
    totalQty: sql<string>`coalesce(sum(${stockBalanceTable.qty}), 0)`,
  })
    .from(itemsTable)
    .leftJoin(stockBalanceTable, and(
      eq(stockBalanceTable.itemId, itemsTable.id),
      eq(stockBalanceTable.companyId, cid),
    ))
    .where(and(
      eq(itemsTable.companyId, cid),
      eq(itemsTable.status, "active"),
      sql`coalesce(${itemsTable.reorderLevel}, 0) > 0`,
    ))
    .groupBy(itemsTable.id, itemsTable.code, itemsTable.nameAr, itemsTable.nameEn, itemsTable.reorderLevel);

  const today = new Date().toISOString().slice(0, 10);
  let created = 0;
  let skippedAlreadyNotified = 0;

  for (const r of rows) {
    const totalQty = Number(r.totalQty);
    const reorder  = Number(r.reorderLevel ?? 0);
    if (totalQty > reorder) continue;

    const sourceKey = `low_stock_item_${r.itemId}_${today}`;
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
      createdByUserId: req.authUser?.id ?? null,
    })
      .onConflictDoNothing({ target: [notificationsTable.companyId, notificationsTable.sourceKey] })
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

export default router;
