import { Router } from "express";
import { db } from "@workspace/db";
import {
  warehouseGroupsTable, warehousesTable, itemGroupsTable, unitsTable,
  itemsTable, itemUnitPricesTable, stockBalanceTable, stockLedgerTable,
  stockTransfersTable, stockTransferItemsTable,
  stockAdjustmentsTable, stockAdjustmentItemsTable,
  stockCountsTable, stockCountItemsTable,
  journalEntriesTable, journalEntryLinesTable,
  accountsTable,
} from "@workspace/db";
import { eq, and, sql, desc, asc, gte, lte, lt, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId, branchScopeSpread } from "../middleware/auth.js";
import { pathRbac } from "../middleware/permissions.js";
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

router.post("/items", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const { code, nameAr, nameEn, barcode, itemType, groupId, unitId, costPrice, salePrice, vatRate, reorderLevel, maxLevel, costMethod, description, imageUrl } = req.body;
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
  const [row] = await db.insert(itemsTable).values({
    companyId: cid, code, nameAr, nameEn, barcode,
    itemType: itemType || "stock", groupId: groupId || null, unitId: unitId || null,
    costPrice: costPrice || "0", salePrice: salePrice || "0", vatRate: vatRate || "15",
    reorderLevel: reorderLevel || "0", maxLevel: maxLevel || null,
    costMethod: costMethod || "weighted_avg", description,
    imageUrl: imageUrl || null,
  }).returning();
  res.status(201).json(row);
});

router.put("/items/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { code, nameAr, nameEn, barcode, itemType, groupId, unitId, costPrice, salePrice, vatRate, reorderLevel, maxLevel, costMethod, description, status, imageUrl } = req.body;
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
  const [row] = await db.update(itemsTable).set({
    code, nameAr, nameEn, barcode, itemType: itemType || "stock",
    groupId: groupId || null, unitId: unitId || null,
    costPrice: costPrice || "0", salePrice: salePrice || "0", vatRate: vatRate || "15",
    reorderLevel: reorderLevel || "0", maxLevel: maxLevel || null,
    costMethod: costMethod || "weighted_avg", description,
    imageUrl: imageUrl !== undefined ? (imageUrl || null) : undefined,
    status: status || "active", updatedAt: new Date(),
  }).where(and(eq(itemsTable.id, id), eq(itemsTable.companyId, cid))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.delete("/items/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  await db.delete(itemsTable).where(and(eq(itemsTable.id, Number(req.params.id)), eq(itemsTable.companyId, cid)));
  res.json({ ok: true });
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
router.post("/import/items", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const rows: any[] = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!rows.length) { res.status(400).json({ error: "لا توجد بيانات" }); return; }

  const groups = await db.select().from(itemGroupsTable).where(eq(itemGroupsTable.companyId, cid));
  const units  = await db.select().from(unitsTable).where(eq(unitsTable.companyId, cid));
  const existing = await db.select({ id: itemsTable.id, code: itemsTable.code }).from(itemsTable).where(eq(itemsTable.companyId, cid));
  const groupByCode = new Map(groups.map((g: any) => [String(g.code).trim().toLowerCase(), g.id]));
  const unitByCode  = new Map(units.map((u: any)  => [String(u.code).trim().toLowerCase(), u.id]));
  const itemByCode  = new Map(existing.map((it: any) => [String(it.code).trim().toLowerCase(), it.id]));

  let created = 0, updated = 0;
  const errors: { row: number; error: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    try {
      const code   = String(r.code ?? "").trim();
      const nameAr = String(r.nameAr ?? r.name ?? "").trim();
      if (!code || !nameAr) { errors.push({ row: i + 2, error: "الكود واسم الصنف العربي مطلوبان" }); continue; }

      const groupId = r.groupCode ? groupByCode.get(String(r.groupCode).trim().toLowerCase()) ?? null : null;
      const unitId  = r.unitCode  ? unitByCode.get(String(r.unitCode).trim().toLowerCase())   ?? null : null;
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
      };

      const existingId = itemByCode.get(code.toLowerCase());
      if (existingId) {
        const { companyId, ...upd } = values as any;
        await db.update(itemsTable).set({ ...upd, updatedAt: new Date() })
          .where(and(eq(itemsTable.id, existingId), eq(itemsTable.companyId, cid)));
        updated++;
      } else {
        const [ins] = await db.insert(itemsTable).values(values).returning({ id: itemsTable.id });
        if (ins?.id) itemByCode.set(code.toLowerCase(), ins.id);
        created++;
      }
    } catch (e: any) {
      errors.push({ row: i + 2, error: e?.message || "خطأ غير معروف" });
    }
  }

  res.json({ created, updated, errors, total: rows.length });
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

export default router;
