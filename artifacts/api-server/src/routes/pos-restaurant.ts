import { Router } from "express";
import { db } from "@workspace/db";
import {
  posTablesTable,
  posMenuCategoriesTable,
  posMenuItemsTable,
  posOrdersTable,
  posOrderItemsTable,
  posSuspiciousOpsTable,
  salesInvoicesTable,
  salesInvoiceLinesTable,
  salesReturnsTable,
  itemsTable,
  usersTable,
  stockBalanceTable,
  branchesTable,
} from "@workspace/db";
import { and, eq, sql, desc, asc, isNull, isNotNull, gte, lte, inArray, ne } from "drizzle-orm";
import { branchScopeSpread, extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { generateRestaurantTables } from "../lib/posRestaurantTableBatch.js";
import { calculateRestaurantOrderTotals } from "../lib/restaurant-order-pricing.js";
import { validateRestaurantModifierSelection } from "../lib/restaurant-modifier-selection.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرّح" }); return; }
  next();
});
// The web waiter and kitchen screens are independently licensed company
// features. Gate their existing restaurant routes here so direct API calls
// cannot bypass the POS app's route-level checks.
router.use((req, res, next) => {
  const path = req.path.replace(/\/+$/, "") || "/";
  let module: string | null = null;
  let action: "view" | "create" | "edit" | "cancel" = "view";

  if (path.startsWith("/kitchen/")) {
    module = "pos_kitchen";
    action = req.method === "GET" ? "view" : "edit";
  } else if (path === "/orders" || path.startsWith("/orders/")) {
    module = "pos_waiter";
    if (req.method === "GET") action = "view";
    else if (path.endsWith("/cancel")) action = "cancel";
    else if (path === "/orders" && req.method === "POST") action = "create";
    else action = "edit";
  } else if (
    path === "/tables" || path.startsWith("/tables/") ||
    path.startsWith("/menu/")
  ) {
    module = "pos_waiter";
    action = req.method === "GET" ? "view" : "edit";
  } else if (path.startsWith("/ai/")) {
    module = "pos_waiter";
    action = req.method === "GET" ? "view" : "edit";
  }

  if (!module) { next(); return; }
  requirePermission(module, action)(req, res, next);
});

// ─── helpers ─────────────────────────────────────────────────────────────
function cidOr401(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرّح" }); return null; }
  return cid;
}

async function nextOrderNumber(cid: number): Promise<string> {
  const today = new Date();
  const ym = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}`;
  const [{ c }] = await db.select({ c: sql<number>`COUNT(*)::int` })
    .from(posOrdersTable)
    .where(and(
      eq(posOrdersTable.companyId, cid),
      sql`${posOrdersTable.orderNumber} LIKE ${`ORD-${ym}-%`}`,
    ));
  return `ORD-${ym}-${String((c ?? 0) + 1).padStart(5, "0")}`;
}

async function recalculateOrderTotals(companyId: number, orderId: number) {
  const lines = await db.select({
    menuItemId: posOrderItemsTable.menuItemId,
    erpItemId: posMenuItemsTable.itemId,
    qty: posOrderItemsTable.qty,
    price: posOrderItemsTable.price,
    modifiers: posOrderItemsTable.modifiers,
    status: posOrderItemsTable.status,
    vatIncluded: posMenuItemsTable.vatIncluded,
    vatRate: itemsTable.vatRate,
  }).from(posOrderItemsTable)
    .leftJoin(posMenuItemsTable, and(
      eq(posMenuItemsTable.id, posOrderItemsTable.menuItemId),
      eq(posMenuItemsTable.companyId, companyId),
    ))
    .leftJoin(itemsTable, and(
      eq(itemsTable.id, posMenuItemsTable.itemId),
      eq(itemsTable.companyId, companyId),
    ))
    .where(eq(posOrderItemsTable.orderId, orderId));
  const totals = calculateRestaurantOrderTotals(lines.filter(line => line.status !== "cancelled"));
  await db.update(posOrdersTable).set({ ...totals, updatedAt: new Date() })
    .where(and(eq(posOrdersTable.id, orderId), eq(posOrdersTable.companyId, companyId)));
  return totals;
}

async function validateRestaurantErpItemLink(companyId: number, value: unknown): Promise<number | null> {
  if (value == null || String(value).trim() === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error("اختر صنف مخزون أو خدمة صحيحاً"), { statusCode: 400 });
  }
  const [item] = await db.select({
    id: itemsTable.id,
    itemType: itemsTable.itemType,
    status: itemsTable.status,
  }).from(itemsTable).where(and(
    eq(itemsTable.id, id),
    eq(itemsTable.companyId, companyId),
  ));
  if (!item || item.status !== "active" || !["stock", "service"].includes(item.itemType)) {
    throw Object.assign(new Error("الصنف المرتبط غير موجود أو غير نشط أو ليس صنف مخزون/خدمة"), { statusCode: 400 });
  }
  return item.id;
}

function configuredRestaurantModifierGroups(attributes: unknown): any[] {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return [];
  const groups = (attributes as Record<string, unknown>)._restaurantModifierGroups;
  return Array.isArray(groups) ? groups : [];
}

async function resolveRestaurantModifiers(
  companyId: number,
  baseItem: any,
  rawSelections: unknown,
  vatIncluded: boolean,
) {
  const groups = configuredRestaurantModifierGroups(baseItem?.variantAttributes);
  const chosen = validateRestaurantModifierSelection(groups, rawSelections);
  const itemIds = [...new Set(chosen.map(entry => Number(entry.option.itemId)))];
  if (!itemIds.length) return [];
  const linkedItems = await db.select({
    id: itemsTable.id, nameAr: itemsTable.nameAr, nameEn: itemsTable.nameEn,
    code: itemsTable.code, itemType: itemsTable.itemType, status: itemsTable.status,
    vatRate: itemsTable.vatRate,
  }).from(itemsTable).where(and(
    eq(itemsTable.companyId, companyId),
    inArray(itemsTable.id, itemIds),
  ));
  const linkedById = new Map(linkedItems.map(item => [item.id, item]));
  return chosen.map(({ group, option }) => {
    const item = linkedById.get(Number(option.itemId));
    if (!item || item.status !== "active" || !["stock", "service"].includes(item.itemType)) {
      throw new Error("أحد أصناف الإضافة غير نشط أو لم يعد متاحاً");
    }
    return {
      name: group.nameAr,
      option: item.nameAr,
      price: Number(option.extraPrice),
      consumptionQtyPerSelection: Number(option.consumptionQtyPerSelection ?? 1),
      groupId: String(group.id),
      optionId: String(option.id),
      itemId: item.id,
      itemType: item.itemType as "stock" | "service",
      vatRate: item.vatRate,
      vatIncluded,
    };
  });
}

// ════════════════════════════════════════════════════════════════════════
// TABLES
// ════════════════════════════════════════════════════════════════════════
router.get("/tables", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const rows = await db.select().from(posTablesTable)
    .where(and(eq(posTablesTable.companyId, cid), eq(posTablesTable.isActive, true)))
    .orderBy(asc(posTablesTable.code));
  res.json(rows);
});

router.post("/tables", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const { branchId, code, nameAr, capacity, area, notes } = req.body ?? {};
  if (!branchId || !code || !nameAr) { res.status(400).json({ error: "branchId/code/nameAr مطلوبة" }); return; }
  try {
    const [row] = await db.insert(posTablesTable).values({
      companyId: cid, branchId: Number(branchId), code, nameAr,
      capacity: Number(capacity ?? 4), area: area ?? null, notes: notes ?? null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    req.log.error({ err: e }, "create table failed");
    res.status(400).json({ error: e?.message ?? "فشل الإنشاء" });
  }
});

router.post("/tables/batch", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const body = req.body ?? {};
  const branchId = Number(body.branchId);
  const capacity = Number(body.capacity ?? 4);
  const area = String(body.area ?? "الصالة").trim();
  if (!Number.isInteger(branchId) || branchId <= 0) {
    res.status(400).json({ error: "يجب اختيار فرع صحيح" }); return;
  }
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) {
    res.status(400).json({ error: "سعة الطاولة يجب أن تكون بين 1 و50" }); return;
  }
  if (area.length > 80) {
    res.status(400).json({ error: "اسم المنطقة يجب ألا يتجاوز 80 حرفاً" }); return;
  }

  const [branch] = await db.select({ id: branchesTable.id })
    .from(branchesTable)
    .where(and(
      eq(branchesTable.id, branchId),
      eq(branchesTable.companyId, cid),
      eq(branchesTable.status, "active"),
    ));
  if (!branch) { res.status(400).json({ error: "الفرع غير موجود أو غير نشط" }); return; }

  try {
    const rows = await db.transaction(async (tx) => {
      // Serialize numbering for this company so two setup screens cannot
      // reserve the same table codes at the same time.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${cid}, 821704)`);
      const existing = await tx.select({ code: posTablesTable.code })
        .from(posTablesTable)
        .where(eq(posTablesTable.companyId, cid));
      const generated = generateRestaurantTables({
        count: Number(body.count),
        startNumber: Number(body.startNumber ?? 1),
        codePrefix: String(body.codePrefix ?? "T"),
        namePrefix: String(body.namePrefix ?? "طاولة"),
      }, existing.map((table) => table.code));

      return tx.insert(posTablesTable).values(generated.map((table) => ({
        companyId: cid,
        branchId,
        code: table.code,
        nameAr: table.nameAr,
        capacity,
        area: area || null,
      }))).returning();
    });
    res.status(201).json(rows);
  } catch (e: any) {
    if (e instanceof Error && /عدد الطاولات|رقم البداية|بادئة الرمز|اسم الطاولة|الحد الأقصى/.test(e.message)) {
      res.status(400).json({ error: e.message }); return;
    }
    req.log.error({ err: e }, "create restaurant table batch failed");
    res.status(e?.code === "23505" ? 409 : 400).json({
      error: e?.code === "23505" ? "تعارض في ترقيم الطاولات؛ أعد المحاولة" : (e?.message ?? "فشل إنشاء الطاولات"),
    });
  }
});

router.put("/tables/:id", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { nameAr, capacity, area, notes, isActive, status } = req.body ?? {};
  const patch: any = { updatedAt: new Date() };
  if (nameAr !== undefined) patch.nameAr = nameAr;
  if (capacity !== undefined) patch.capacity = Number(capacity);
  if (area !== undefined) patch.area = area;
  if (notes !== undefined) patch.notes = notes;
  if (isActive !== undefined) patch.isActive = !!isActive;
  if (status !== undefined) patch.status = status;
  const [row] = await db.update(posTablesTable).set(patch)
    .where(and(eq(posTablesTable.id, id), eq(posTablesTable.companyId, cid)))
    .returning();
  if (!row) { res.status(404).json({ error: "not found" }); return; }
  res.json(row);
});

router.delete("/tables/:id", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  await db.update(posTablesTable).set({ isActive: false })
    .where(and(eq(posTablesTable.id, id), eq(posTablesTable.companyId, cid)));
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════
// MENU CATEGORIES
// ════════════════════════════════════════════════════════════════════════
router.get("/menu/categories", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const rows = await db.select().from(posMenuCategoriesTable)
    .where(and(eq(posMenuCategoriesTable.companyId, cid), eq(posMenuCategoriesTable.isActive, true)))
    .orderBy(asc(posMenuCategoriesTable.displayOrder), asc(posMenuCategoriesTable.code));
  res.json(rows);
});

router.post("/menu/categories", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const { code, nameAr, nameEn, kind, displayOrder, color, branchId } = req.body ?? {};
  if (!code || !nameAr) { res.status(400).json({ error: "code/nameAr مطلوبة" }); return; }
  try {
    const [row] = await db.insert(posMenuCategoriesTable).values({
      companyId: cid, code, nameAr, nameEn: nameEn ?? null,
      kind: kind ?? "food", displayOrder: Number(displayOrder ?? 0),
      color: color ?? null, branchId: branchId ? Number(branchId) : null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "فشل الإنشاء" });
  }
});

router.put("/menu/categories/:id", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { nameAr, nameEn, kind, displayOrder, color, isActive } = req.body ?? {};
  const patch: any = { updatedAt: new Date() };
  if (nameAr !== undefined) patch.nameAr = nameAr;
  if (nameEn !== undefined) patch.nameEn = nameEn;
  if (kind !== undefined) patch.kind = kind;
  if (displayOrder !== undefined) patch.displayOrder = Number(displayOrder);
  if (color !== undefined) patch.color = color;
  if (isActive !== undefined) patch.isActive = !!isActive;
  const [row] = await db.update(posMenuCategoriesTable).set(patch)
    .where(and(eq(posMenuCategoriesTable.id, id), eq(posMenuCategoriesTable.companyId, cid)))
    .returning();
  if (!row) { res.status(404).json({ error: "not found" }); return; }
  res.json(row);
});

router.delete("/menu/categories/:id", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  await db.update(posMenuCategoriesTable).set({ isActive: false })
    .where(and(eq(posMenuCategoriesTable.id, id), eq(posMenuCategoriesTable.companyId, cid)));
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════
// MENU ITEMS
// ════════════════════════════════════════════════════════════════════════
router.get("/menu/items", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const catId = req.query.categoryId ? Number(req.query.categoryId) : undefined;
  const where = catId
    ? and(eq(posMenuItemsTable.companyId, cid), eq(posMenuItemsTable.isActive, true), eq(posMenuItemsTable.categoryId, catId))
    : and(eq(posMenuItemsTable.companyId, cid), eq(posMenuItemsTable.isActive, true));
  const rows = await db.select({
    menuItem: posMenuItemsTable,
    linkedItemId: itemsTable.id,
    linkedAttributes: itemsTable.variantAttributes,
    linkedShowInPos: itemsTable.showInPos,
  }).from(posMenuItemsTable)
    .leftJoin(itemsTable, and(
      eq(itemsTable.id, posMenuItemsTable.itemId),
      eq(itemsTable.companyId, cid),
    ))
    .where(where).orderBy(asc(posMenuItemsTable.nameAr));
  const configuredGroups = rows.flatMap(row => row.linkedShowInPos === false
    ? [] : configuredRestaurantModifierGroups(row.linkedAttributes));
  const optionItemIds = [...new Set(configuredGroups.flatMap((group: any) =>
    (group.options ?? []).map((option: any) => Number(option.itemId)).filter(Number.isSafeInteger),
  ))];
  const optionItems = optionItemIds.length ? await db.select({
    id: itemsTable.id, nameAr: itemsTable.nameAr, nameEn: itemsTable.nameEn, code: itemsTable.code,
  }).from(itemsTable).where(and(
    eq(itemsTable.companyId, cid), eq(itemsTable.status, "active"), inArray(itemsTable.id, optionItemIds),
  )) : [];
  const optionById = new Map(optionItems.map(item => [item.id, item]));
  res.json(rows.map(row => ({
    ...row.menuItem,
    showInPos: row.linkedShowInPos !== false,
    modifierGroups: configuredRestaurantModifierGroups(row.linkedAttributes).map((group: any) => ({
      ...group,
      options: (group.options ?? []).flatMap((option: any) => {
        const item = optionById.get(Number(option.itemId));
        return item ? [{ ...option, nameAr: item.nameAr, nameEn: item.nameEn, code: item.code }] : [];
      }),
    })),
  })));
});

router.post("/menu/items", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const { categoryId, code, nameAr, nameEn, description, price, prepTimeMinutes, kitchenStation, imageUrl, itemId, vatIncluded, modifiers } = req.body ?? {};
  if (!categoryId || !code || !nameAr) { res.status(400).json({ error: "categoryId/code/nameAr مطلوبة" }); return; }
  try {
    const linkedItemId = await validateRestaurantErpItemLink(cid, itemId);
    const [row] = await db.insert(posMenuItemsTable).values({
      companyId: cid, categoryId: Number(categoryId), code, nameAr,
      nameEn: nameEn ?? null, description: description ?? null,
      price: String(price ?? "0"),
      prepTimeMinutes: Number(prepTimeMinutes ?? 0),
      kitchenStation: kitchenStation ?? "kitchen",
      imageUrl: imageUrl ?? null,
      itemId: linkedItemId,
      vatIncluded: vatIncluded !== false,
      modifiers: modifiers ?? [],
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "فشل الإنشاء" });
  }
});

router.put("/menu/items/:id", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const patch: any = { updatedAt: new Date() };
  if (req.body?.itemId !== undefined) {
    try {
      patch.itemId = await validateRestaurantErpItemLink(cid, req.body.itemId);
    } catch (error) {
      res.status(Number((error as { statusCode?: number })?.statusCode) || 400)
        .json({ error: error instanceof Error ? error.message : "الصنف المرتبط غير صالح" });
      return;
    }
  }
  for (const k of ["nameAr","nameEn","description","kitchenStation","imageUrl","modifiers"]) {
    if (req.body?.[k] !== undefined) patch[k] = req.body[k];
  }
  if (req.body?.price !== undefined) patch.price = String(req.body.price);
  if (req.body?.prepTimeMinutes !== undefined) patch.prepTimeMinutes = Number(req.body.prepTimeMinutes);
  if (req.body?.isActive !== undefined) patch.isActive = !!req.body.isActive;
  if (req.body?.vatIncluded !== undefined) patch.vatIncluded = !!req.body.vatIncluded;
  if (req.body?.categoryId !== undefined) patch.categoryId = Number(req.body.categoryId);
  const [row] = await db.update(posMenuItemsTable).set(patch)
    .where(and(eq(posMenuItemsTable.id, id), eq(posMenuItemsTable.companyId, cid)))
    .returning();
  if (!row) { res.status(404).json({ error: "not found" }); return; }
  res.json(row);
});

router.delete("/menu/items/:id", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  await db.update(posMenuItemsTable).set({ isActive: false })
    .where(and(eq(posMenuItemsTable.id, id), eq(posMenuItemsTable.companyId, cid)));
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════
// ORDERS
// ════════════════════════════════════════════════════════════════════════
router.get("/reports/order-types", requirePermission("pos_waiter", "view"), async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const date = String(req.query.date ?? new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    res.status(400).json({ error: "تاريخ التقرير غير صالح" }); return;
  }
  const branchId = req.query.branchId ? Number(req.query.branchId) : undefined;
  if (branchId !== undefined && (!Number.isInteger(branchId) || branchId <= 0)) {
    res.status(400).json({ error: "معرّف الفرع غير صالح" }); return;
  }
  const from = new Date(`${date}T00:00:00.000Z`);
  const to = new Date(from.getTime() + 86_400_000 - 1);
  const rows = await db.select({
    channel: posOrdersTable.channel,
    count: sql<number>`COUNT(*)::int`,
  }).from(posOrdersTable).where(and(
    eq(posOrdersTable.companyId, cid),
    gte(posOrdersTable.openedAt, from),
    lte(posOrdersTable.openedAt, to),
    ne(posOrdersTable.status, "cancelled"),
    ...branchScopeSpread(req, posOrdersTable.branchId, branchId),
  )).groupBy(posOrdersTable.channel);
  res.json(rows.map(row => ({ channel: row.channel, count: Number(row.count) })));
});

router.get("/reports/custom-period-comparison", requirePermission("pos_waiter", "view"), async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const period1 = { from: String(req.query.period1From ?? ""), to: String(req.query.period1To ?? "") };
  const period2 = { from: String(req.query.period2From ?? ""), to: String(req.query.period2To ?? "") };
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (!validDate(period1.from) || !validDate(period1.to) || !validDate(period2.from) || !validDate(period2.to) ||
      period1.from > period1.to || period2.from > period2.to) {
    res.status(400).json({ error: "حدد تاريخ بداية ونهاية صالحين لكل فترة مقارنة" }); return;
  }
  const rawBranchId = req.query.branchId;
  const branchId = rawBranchId == null || rawBranchId === "" ? undefined : Number(rawBranchId);
  if (branchId !== undefined && (!Number.isInteger(branchId) || branchId <= 0)) {
    res.status(400).json({ error: "معرّف الفرع غير صالح" }); return;
  }

  const loadPeriod = async (range: { from: string; to: string }) => {
    const invoiceWhere = and(
      eq(salesInvoicesTable.companyId, cid),
      isNotNull(salesInvoicesTable.posSessionId),
      gte(salesInvoicesTable.invoiceDate, range.from),
      lte(salesInvoicesTable.invoiceDate, range.to),
      inArray(salesInvoicesTable.status, ["posted", "cancelled"]),
      ...branchScopeSpread(req, salesInvoicesTable.branchId, branchId),
    );
    const [invoices, returns, payments, items] = await Promise.all([
      db.select({
        currencyCode: salesInvoicesTable.currencyCode,
        sales: sql<string>`COALESCE(SUM(CASE WHEN ${salesInvoicesTable.status} = 'posted' THEN ${salesInvoicesTable.totalAmount} ELSE 0 END), 0)`,
        orders: sql<number>`COUNT(*) FILTER (WHERE ${salesInvoicesTable.status} = 'posted')::int`,
        discounts: sql<string>`COALESCE(SUM(CASE WHEN ${salesInvoicesTable.status} = 'posted' THEN ${salesInvoicesTable.discountAmount} ELSE 0 END), 0)`,
        voidCount: sql<number>`COUNT(*) FILTER (WHERE ${salesInvoicesTable.status} = 'cancelled')::int`,
        voidAmount: sql<string>`COALESCE(SUM(CASE WHEN ${salesInvoicesTable.status} = 'cancelled' THEN ${salesInvoicesTable.totalAmount} ELSE 0 END), 0)`,
      }).from(salesInvoicesTable).where(invoiceWhere).groupBy(salesInvoicesTable.currencyCode),
      db.select({
        currencyCode: salesReturnsTable.currencyCode,
        amount: sql<string>`COALESCE(SUM(${salesReturnsTable.totalAmount}), 0)`,
        count: sql<number>`COUNT(*)::int`,
      }).from(salesReturnsTable)
        .innerJoin(salesInvoicesTable, eq(salesReturnsTable.invoiceId, salesInvoicesTable.id))
        .where(and(
          eq(salesReturnsTable.companyId, cid),
          eq(salesReturnsTable.status, "posted"),
          gte(salesReturnsTable.returnDate, range.from),
          lte(salesReturnsTable.returnDate, range.to),
          isNotNull(salesInvoicesTable.posSessionId),
          ...branchScopeSpread(req, salesInvoicesTable.branchId, branchId),
        )).groupBy(salesReturnsTable.currencyCode),
      db.select({
        currencyCode: salesInvoicesTable.currencyCode,
        paymentType: salesInvoicesTable.paymentType,
        amount: sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}), 0)`,
        count: sql<number>`COUNT(*)::int`,
      }).from(salesInvoicesTable).where(and(invoiceWhere, eq(salesInvoicesTable.status, "posted")))
        .groupBy(salesInvoicesTable.currencyCode, salesInvoicesTable.paymentType),
      db.select({
        currencyCode: salesInvoicesTable.currencyCode,
        itemId: salesInvoiceLinesTable.itemId,
        name: salesInvoiceLinesTable.itemName,
        qty: sql<string>`COALESCE(SUM(${salesInvoiceLinesTable.qty}), 0)`,
        revenue: sql<string>`COALESCE(SUM(${salesInvoiceLinesTable.lineTotal}), 0)`,
      }).from(salesInvoiceLinesTable)
        .innerJoin(salesInvoicesTable, eq(salesInvoiceLinesTable.invoiceId, salesInvoicesTable.id))
        .where(and(
          eq(salesInvoiceLinesTable.companyId, cid),
          eq(salesInvoicesTable.companyId, cid),
          isNotNull(salesInvoicesTable.posSessionId),
          eq(salesInvoicesTable.status, "posted"),
          gte(salesInvoicesTable.invoiceDate, range.from),
          lte(salesInvoicesTable.invoiceDate, range.to),
          ...branchScopeSpread(req, salesInvoicesTable.branchId, branchId),
        )).groupBy(salesInvoicesTable.currencyCode, salesInvoiceLinesTable.itemId, salesInvoiceLinesTable.itemName)
        .orderBy(desc(sql`SUM(${salesInvoiceLinesTable.lineTotal})`)).limit(10),
    ]);

    const currencies = new Set([
      ...invoices.map(row => row.currencyCode),
      ...returns.map(row => row.currencyCode),
      ...payments.map(row => row.currencyCode),
      ...items.map(row => row.currencyCode),
    ]);
    return Array.from(currencies).sort().map(currencyCode => {
      const invoice = invoices.find(row => row.currencyCode === currencyCode);
      const returned = returns.find(row => row.currencyCode === currencyCode);
      const sales = Number(invoice?.sales ?? 0);
      const returnAmount = Number(returned?.amount ?? 0);
      const orders = Number(invoice?.orders ?? 0);
      return {
        currencyCode,
        sales,
        returns: returnAmount,
        netSales: sales - returnAmount,
        orders,
        averageOrder: orders ? (sales - returnAmount) / orders : 0,
        discounts: Number(invoice?.discounts ?? 0),
        returnCount: Number(returned?.count ?? 0),
        voidCount: Number(invoice?.voidCount ?? 0),
        voidAmount: Number(invoice?.voidAmount ?? 0),
        paymentMix: payments.filter(row => row.currencyCode === currencyCode)
          .map(row => ({ paymentType: row.paymentType, amount: Number(row.amount), count: Number(row.count) })),
        topItems: items.filter(row => row.currencyCode === currencyCode)
          .map(row => ({ itemId: row.itemId, name: row.name, qty: Number(row.qty), revenue: Number(row.revenue) })),
      };
    });
  };

  const [first, second] = await Promise.all([loadPeriod(period1), loadPeriod(period2)]);
  res.json({ period1: { ...period1, currencies: first }, period2: { ...period2, currencies: second } });
});

router.get("/orders", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const status = req.query.status as string | undefined;
  const tableId = req.query.tableId ? Number(req.query.tableId) : undefined;
  const conds: any[] = [eq(posOrdersTable.companyId, cid)];
  if (status) conds.push(eq(posOrdersTable.status, status as any));
  if (tableId) conds.push(eq(posOrdersTable.tableId, tableId));
  const rows = await db.select().from(posOrdersTable)
    .where(and(...conds))
    .orderBy(desc(posOrdersTable.openedAt))
    .limit(200);
  res.json(rows);
});

router.get("/orders/active-count", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const rawBranchId = req.query.branchId;
  const branchId = rawBranchId == null ? null : Number(rawBranchId);
  if (branchId != null && (!Number.isInteger(branchId) || branchId <= 0)) {
    res.status(400).json({ error: "معرّف الفرع غير صالح" }); return;
  }
  const filters = [
    eq(posOrdersTable.companyId, cid),
    inArray(posOrdersTable.status, ["open", "sent", "preparing", "ready", "served"] as any),
  ];
  if (branchId != null) filters.push(eq(posOrdersTable.branchId, branchId));
  const [{ count } = { count: 0 }] = await db.select({
    count: sql<number>`COUNT(*)::int`,
  }).from(posOrdersTable).where(and(...filters));
  res.json({ count: Number(count) });
});

router.get("/orders/:id", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [order] = await db.select().from(posOrdersTable)
    .where(and(eq(posOrdersTable.id, id), eq(posOrdersTable.companyId, cid)));
  if (!order) { res.status(404).json({ error: "not found" }); return; }
  const items = await db.select({
    id: posOrderItemsTable.id,
    orderId: posOrderItemsTable.orderId,
    menuItemId: posOrderItemsTable.menuItemId,
    erpItemId: posMenuItemsTable.itemId,
    erpItemType: itemsTable.itemType,
    erpVatRate: itemsTable.vatRate,
    vatIncluded: posMenuItemsTable.vatIncluded,
    nameSnapshot: posOrderItemsTable.nameSnapshot,
    qty: posOrderItemsTable.qty,
    price: posOrderItemsTable.price,
    total: posOrderItemsTable.total,
    modifiers: posOrderItemsTable.modifiers,
    kitchenStation: posOrderItemsTable.kitchenStation,
    status: posOrderItemsTable.status,
    notes: posOrderItemsTable.notes,
    sentAt: posOrderItemsTable.sentAt,
    readyAt: posOrderItemsTable.readyAt,
    createdAt: posOrderItemsTable.createdAt,
    updatedAt: posOrderItemsTable.updatedAt,
  }).from(posOrderItemsTable)
    .leftJoin(posMenuItemsTable, and(
      eq(posMenuItemsTable.id, posOrderItemsTable.menuItemId),
      eq(posMenuItemsTable.companyId, cid),
    ))
    .leftJoin(itemsTable, and(
      eq(itemsTable.id, posMenuItemsTable.itemId),
      eq(itemsTable.companyId, cid),
    ))
    .where(eq(posOrderItemsTable.orderId, id))
    .orderBy(asc(posOrderItemsTable.id));
  const totals = calculateRestaurantOrderTotals(items
    .filter(line => line.status !== "cancelled")
    .map(line => ({ ...line, vatRate: line.erpVatRate })));
  res.json({ ...order, ...totals, items });
});

router.post("/orders", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const { branchId, channel, tableId, customerName, customerPhone, guestCount, notes } = req.body ?? {};
  if (!branchId) { res.status(400).json({ error: "branchId مطلوب" }); return; }
  const orderNumber = await nextOrderNumber(cid);
  const [row] = await db.insert(posOrdersTable).values({
    companyId: cid, branchId: Number(branchId), orderNumber,
    channel: channel ?? "dine_in",
    tableId: tableId ? Number(tableId) : null,
    customerName: customerName ?? null,
    customerPhone: customerPhone ?? null,
    waiterId: req.authUser?.id ?? null,
    guestCount: Number(guestCount ?? 1),
    notes: notes ?? null,
  }).returning();
  if (tableId) {
    await db.update(posTablesTable)
      .set({ status: "occupied", currentOrderId: row.id, updatedAt: new Date() })
      .where(and(eq(posTablesTable.id, Number(tableId)), eq(posTablesTable.companyId, cid)));
  }
  res.status(201).json(row);
});

router.post("/orders/:id/items", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { menuItemId, qty, notes, modifiers } = req.body ?? {};
  if (!menuItemId) { res.status(400).json({ error: "menuItemId مطلوب" }); return; }
  const [order] = await db.select().from(posOrdersTable)
    .where(and(eq(posOrdersTable.id, id), eq(posOrdersTable.companyId, cid)));
  if (!order) { res.status(404).json({ error: "not found" }); return; }
  if (["billed", "cancelled"].includes(order.status)) {
    res.status(400).json({ error: "لا يمكن التعديل على طلب مغلق" }); return;
  }
  const [mi] = await db.select().from(posMenuItemsTable)
    .where(and(eq(posMenuItemsTable.id, Number(menuItemId)), eq(posMenuItemsTable.companyId, cid)));
  if (!mi) { res.status(404).json({ error: "صنف غير موجود" }); return; }
  const q = Number(qty ?? 1);
  if (!Number.isFinite(q) || q <= 0) { res.status(400).json({ error: "الكمية يجب أن تكون أكبر من صفر" }); return; }
  const [baseItem] = mi.itemId ? await db.select().from(itemsTable).where(and(
    eq(itemsTable.id, mi.itemId), eq(itemsTable.companyId, cid),
  )) : [];
  let resolvedModifiers: any[];
  try {
    resolvedModifiers = await resolveRestaurantModifiers(cid, baseItem, modifiers, mi.vatIncluded);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message }); return;
  }
  const total = calculateRestaurantOrderTotals([{
    menuItemId: mi.id, erpItemId: mi.itemId, qty: q, price: mi.price,
    vatIncluded: mi.vatIncluded, vatRate: baseItem?.vatRate, modifiers: resolvedModifiers,
  }]).total;
  await db.insert(posOrderItemsTable).values({
    orderId: id, menuItemId: mi.id, nameSnapshot: mi.nameAr,
    qty: String(q), price: mi.price, total,
    kitchenStation: mi.kitchenStation,
    modifiers: resolvedModifiers,
    notes: notes ?? null,
  });
  // Recalc totals
  const totals = await recalculateOrderTotals(cid, id);
  res.status(201).json({ ok: true, ...totals });
});

router.put("/orders/:id/items/:itemId", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const orderId = Number(req.params.id);
  const lineId = Number(req.params.itemId);
  const [order] = await db.select().from(posOrdersTable).where(and(
    eq(posOrdersTable.id, orderId), eq(posOrdersTable.companyId, cid),
  ));
  if (!order) { res.status(404).json({ error: "not found" }); return; }
  if (["billed", "cancelled"].includes(order.status)) {
    res.status(400).json({ error: "لا يمكن التعديل على طلب مغلق" }); return;
  }
  const [line] = await db.select().from(posOrderItemsTable).where(and(
    eq(posOrderItemsTable.id, lineId), eq(posOrderItemsTable.orderId, orderId),
  ));
  if (!line) { res.status(404).json({ error: "الصنف غير موجود في الطلب" }); return; }
  if (line.status === "cancelled") { res.status(400).json({ error: "لا يمكن تعديل صنف ملغى" }); return; }
  const [menuItem] = await db.select().from(posMenuItemsTable).where(and(
    eq(posMenuItemsTable.id, line.menuItemId), eq(posMenuItemsTable.companyId, cid),
  ));
  const [baseItem] = menuItem?.itemId ? await db.select().from(itemsTable).where(and(
    eq(itemsTable.id, menuItem.itemId), eq(itemsTable.companyId, cid),
  )) : [];
  let resolvedModifiers: any[];
  try {
    resolvedModifiers = await resolveRestaurantModifiers(cid, baseItem, req.body?.modifiers, menuItem?.vatIncluded ?? true);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message }); return;
  }
  const total = calculateRestaurantOrderTotals([{
    menuItemId: line.menuItemId, erpItemId: menuItem?.itemId, qty: line.qty, price: line.price,
    vatIncluded: menuItem?.vatIncluded ?? true, vatRate: baseItem?.vatRate, modifiers: resolvedModifiers,
  }]).total;
  await db.update(posOrderItemsTable).set({ modifiers: resolvedModifiers, total, updatedAt: new Date() })
    .where(eq(posOrderItemsTable.id, lineId));
  const totals = await recalculateOrderTotals(cid, orderId);
  res.json({ ok: true, ...totals });
});

router.delete("/orders/:id/items/:itemId", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const [order] = await db.select().from(posOrdersTable)
    .where(and(eq(posOrdersTable.id, id), eq(posOrdersTable.companyId, cid)));
  if (!order) { res.status(404).json({ error: "not found" }); return; }
  await db.delete(posOrderItemsTable)
    .where(and(eq(posOrderItemsTable.id, itemId), eq(posOrderItemsTable.orderId, id)));
  const totals = await recalculateOrderTotals(cid, id);
  res.json({ ok: true, ...totals });
});

// Send to kitchen — locks lines as pending → ready for prep
router.post("/orders/:id/send", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [order] = await db.select().from(posOrdersTable)
    .where(and(eq(posOrdersTable.id, id), eq(posOrdersTable.companyId, cid)));
  if (!order) { res.status(404).json({ error: "not found" }); return; }
  await db.update(posOrdersTable)
    .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
    .where(eq(posOrdersTable.id, id));
  await db.update(posOrderItemsTable)
    .set({ sentAt: new Date(), updatedAt: new Date() })
    .where(and(eq(posOrderItemsTable.orderId, id), isNull(posOrderItemsTable.sentAt)));
  res.json({ ok: true });
});

// Bill — close the order; cashier links a salesInvoice
router.post("/orders/:id/bill", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const salesInvoiceId = Number(req.body?.salesInvoiceId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(salesInvoiceId) || salesInvoiceId <= 0) {
    res.status(400).json({ error: "معرّف الطلب والفاتورة مطلوبان" }); return;
  }
  try {
    await db.transaction(async (tx) => {
      const [order] = await tx.select().from(posOrdersTable)
        .where(and(eq(posOrdersTable.id, id), eq(posOrdersTable.companyId, cid)))
        .for("update");
      if (!order) throw Object.assign(new Error("الطلب غير موجود"), { statusCode: 404 });

      const [invoice] = await tx.select({
        id: salesInvoicesTable.id,
        status: salesInvoicesTable.status,
        subtotal: salesInvoicesTable.subtotal,
        vatAmount: salesInvoicesTable.vatAmount,
        totalAmount: salesInvoicesTable.totalAmount,
      }).from(salesInvoicesTable)
        .where(and(
          eq(salesInvoicesTable.id, salesInvoiceId),
          eq(salesInvoicesTable.companyId, cid),
        ))
        .for("update");
      if (!invoice) throw Object.assign(new Error("الفاتورة غير موجودة"), { statusCode: 404 });
      if (invoice.status !== "posted") {
        throw Object.assign(new Error("لا يمكن إغلاق الطلب قبل ترحيل الفاتورة بنجاح"), { statusCode: 409 });
      }

      if (order.status === "billed") {
        if (order.billedInvoiceId === salesInvoiceId) return;
        throw Object.assign(new Error("الطلب مرتبط بفاتورة أخرى بالفعل"), { statusCode: 409 });
      }
      if (order.status === "cancelled") {
        throw Object.assign(new Error("لا يمكن فوترة طلب ملغى"), { statusCode: 409 });
      }

      await tx.update(posOrdersTable)
        .set({
          status: "billed", billedAt: new Date(),
          billedInvoiceId: salesInvoiceId,
          subtotal: invoice.subtotal,
          vatAmount: invoice.vatAmount,
          total: invoice.totalAmount,
          updatedAt: new Date(),
        })
        .where(and(
          eq(posOrdersTable.id, id),
          eq(posOrdersTable.companyId, cid),
        ));
      if (order.tableId) {
        await tx.update(posTablesTable)
          .set({ status: "free", currentOrderId: null, updatedAt: new Date() })
          .where(and(
            eq(posTablesTable.id, order.tableId),
            eq(posTablesTable.companyId, cid),
          ));
      }
    });
    res.json({ ok: true });
  } catch (error) {
    const statusCode = Number((error as { statusCode?: number })?.statusCode) || 500;
    if (statusCode >= 500) req.log.error({ err: error, orderId: id, salesInvoiceId }, "restaurant order billing link failed");
    res.status(statusCode).json({ error: error instanceof Error ? error.message : "تعذر إغلاق الطلب" });
  }
});

router.post("/orders/:id/cancel", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [order] = await db.select().from(posOrdersTable)
    .where(and(eq(posOrdersTable.id, id), eq(posOrdersTable.companyId, cid)));
  if (!order) { res.status(404).json({ error: "not found" }); return; }
  await db.update(posOrdersTable)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(eq(posOrdersTable.id, id));
  if (order.tableId) {
    await db.update(posTablesTable)
      .set({ status: "free", currentOrderId: null, updatedAt: new Date() })
      .where(eq(posTablesTable.id, order.tableId));
  }
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════
// KITCHEN DISPLAY
// ════════════════════════════════════════════════════════════════════════
router.get("/kitchen/tickets", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const station = (req.query.station as string) || undefined;
  const conds: any[] = [
    eq(posOrdersTable.companyId, cid),
    inArray(posOrdersTable.status, ["sent", "preparing", "ready"] as any),
  ];
  const orders = await db.select().from(posOrdersTable)
    .where(and(...conds))
    .orderBy(asc(posOrdersTable.sentAt));
  const orderIds = orders.map(o => o.id);
  if (orderIds.length === 0) { res.json([]); return; }
  const lineConds: any[] = [
    inArray(posOrderItemsTable.orderId, orderIds),
    inArray(posOrderItemsTable.status, ["pending", "preparing"] as any),
  ];
  if (station) lineConds.push(eq(posOrderItemsTable.kitchenStation, station));
  const items = await db.select().from(posOrderItemsTable)
    .where(and(...lineConds))
    .orderBy(asc(posOrderItemsTable.sentAt));
  const byOrder: Record<number, any[]> = {};
  for (const it of items) (byOrder[it.orderId] ??= []).push(it);
  res.json(orders
    .filter(o => byOrder[o.id]?.length)
    .map(o => ({ ...o, items: byOrder[o.id] })));
});

router.put("/kitchen/items/:id/status", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  if (!["preparing", "ready", "served"].includes(status)) {
    res.status(400).json({ error: "حالة غير صحيحة" }); return;
  }
  // Authz: line must belong to an order in user's company
  const [line] = await db.select({
    line: posOrderItemsTable, order: posOrdersTable,
  }).from(posOrderItemsTable)
    .innerJoin(posOrdersTable, eq(posOrdersTable.id, posOrderItemsTable.orderId))
    .where(eq(posOrderItemsTable.id, id));
  if (!line || line.order.companyId !== cid) { res.status(404).json({ error: "not found" }); return; }
  const patch: any = { status, updatedAt: new Date() };
  if (status === "ready") patch.readyAt = new Date();
  await db.update(posOrderItemsTable).set(patch).where(eq(posOrderItemsTable.id, id));
  // Roll up: if all lines ready → order=ready; if all served → order=served
  const all = await db.select().from(posOrderItemsTable)
    .where(eq(posOrderItemsTable.orderId, line.order.id));
  const active = all.filter(l => l.status !== "cancelled");
  if (active.every(l => l.status === "served")) {
    await db.update(posOrdersTable)
      .set({ status: "served", servedAt: new Date(), updatedAt: new Date() })
      .where(eq(posOrdersTable.id, line.order.id));
  } else if (active.every(l => ["ready","served"].includes(l.status))) {
    await db.update(posOrdersTable)
      .set({ status: "ready", readyAt: new Date(), updatedAt: new Date() })
      .where(eq(posOrdersTable.id, line.order.id));
  } else if (active.some(l => l.status === "preparing")) {
    await db.update(posOrdersTable)
      .set({ status: "preparing", updatedAt: new Date() })
      .where(eq(posOrdersTable.id, line.order.id));
  }
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════
// AI: top recommendations (history-based, no LLM needed)
// ════════════════════════════════════════════════════════════════════════
router.get("/ai/recommend", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const limit = Math.min(20, Number(req.query.limit ?? 8));
  // Aggregate menu items by qty sold over the last 30 days
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db.select({
    menuItemId: posOrderItemsTable.menuItemId,
    nameSnapshot: posOrderItemsTable.nameSnapshot,
    qtySum: sql<string>`SUM(${posOrderItemsTable.qty})`,
    revenue: sql<string>`SUM(${posOrderItemsTable.total})`,
    orderCount: sql<number>`COUNT(DISTINCT ${posOrderItemsTable.orderId})::int`,
  }).from(posOrderItemsTable)
    .innerJoin(posOrdersTable, eq(posOrdersTable.id, posOrderItemsTable.orderId))
    .where(and(
      eq(posOrdersTable.companyId, cid),
      gte(posOrdersTable.openedAt, since),
      eq(posOrderItemsTable.status, "served"),
    ))
    .groupBy(posOrderItemsTable.menuItemId, posOrderItemsTable.nameSnapshot)
    .orderBy(desc(sql`SUM(${posOrderItemsTable.qty})`))
    .limit(limit);
  res.json(rows);
});

// ════════════════════════════════════════════════════════════════════════
// AI: suspicious cashier ops scan (rule-based)
// ════════════════════════════════════════════════════════════════════════
router.post("/ai/suspicious/scan", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const created: any[] = [];

  // Rule 1: rapid order cancellations (>=3 cancellations in 1h by same waiter)
  const cancels = await db.select({
    waiterId: posOrdersTable.waiterId,
    cnt: sql<number>`COUNT(*)::int`,
  }).from(posOrdersTable)
    .where(and(
      eq(posOrdersTable.companyId, cid),
      eq(posOrdersTable.status, "cancelled"),
      gte(posOrdersTable.cancelledAt, since),
    ))
    .groupBy(posOrdersTable.waiterId);
  for (const c of cancels) {
    if ((c.cnt ?? 0) >= 3 && c.waiterId) {
      const [{ exists }] = await db.select({
        exists: sql<number>`COUNT(*)::int`,
      }).from(posSuspiciousOpsTable)
        .where(and(
          eq(posSuspiciousOpsTable.companyId, cid),
          eq(posSuspiciousOpsTable.userId, c.waiterId),
          eq(posSuspiciousOpsTable.kind, "rapid_voids"),
          gte(posSuspiciousOpsTable.createdAt, since),
        ));
      if (!exists) {
        const [row] = await db.insert(posSuspiciousOpsTable).values({
          companyId: cid, userId: c.waiterId,
          kind: "rapid_voids", severity: c.cnt >= 6 ? "high" : "medium",
          description: `${c.cnt} طلبات ملغاة خلال 24 ساعة من نفس المستخدم`,
          payload: { count: c.cnt, windowHours: 24 },
        }).returning();
        created.push(row);
      }
    }
  }

  // Rule 2: late-night sales (00:00–05:00) outside normal business hours
  const lateNight = await db.select({
    id: salesInvoicesTable.id,
    userId: salesInvoicesTable.createdById,
    total: salesInvoicesTable.totalAmount,
    when: salesInvoicesTable.createdAt,
  }).from(salesInvoicesTable)
    .where(and(
      eq(salesInvoicesTable.companyId, cid),
      gte(salesInvoicesTable.createdAt, since),
      sql`EXTRACT(HOUR FROM ${salesInvoicesTable.createdAt}) < 5`,
    ))
    .limit(20);
  for (const inv of lateNight) {
    if (!inv.userId) continue;
    const [{ exists }] = await db.select({
      exists: sql<number>`COUNT(*)::int`,
    }).from(posSuspiciousOpsTable)
      .where(and(
        eq(posSuspiciousOpsTable.companyId, cid),
        eq(posSuspiciousOpsTable.kind, "late_night_sale"),
        sql`(${posSuspiciousOpsTable.payload}->>'invoiceId')::int = ${inv.id}`,
      ));
    if (!exists) {
      const [row] = await db.insert(posSuspiciousOpsTable).values({
        companyId: cid, userId: inv.userId,
        kind: "late_night_sale", severity: "low",
        description: `بيع في وقت متأخر (قبل الفجر) — مبلغ ${inv.total}`,
        payload: { invoiceId: inv.id, total: inv.total, at: inv.when },
      }).returning();
      created.push(row);
    }
  }

  res.json({ created: created.length, items: created });
});

router.get("/ai/suspicious", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const rows = await db.select().from(posSuspiciousOpsTable)
    .where(eq(posSuspiciousOpsTable.companyId, cid))
    .orderBy(desc(posSuspiciousOpsTable.createdAt))
    .limit(100);
  res.json(rows);
});

// ════════════════════════════════════════════════════════════════════════
// AI: peak-hour analysis (last 30 days, by hour-of-day & day-of-week)
// ════════════════════════════════════════════════════════════════════════
router.get("/ai/peak-hours", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const days = Math.min(90, Math.max(1, Number(req.query.days ?? 30)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const byHour = await db.select({
    hour: sql<number>`EXTRACT(HOUR FROM ${posOrdersTable.openedAt})::int`,
    orders: sql<number>`COUNT(*)::int`,
    revenue: sql<string>`COALESCE(SUM(${posOrdersTable.total}::numeric), 0)::text`,
    guests: sql<number>`COALESCE(SUM(${posOrdersTable.guestCount}), 0)::int`,
  }).from(posOrdersTable)
    .where(and(
      eq(posOrdersTable.companyId, cid),
      gte(posOrdersTable.openedAt, since),
      sql`${posOrdersTable.status} != 'cancelled'`,
    ))
    .groupBy(sql`EXTRACT(HOUR FROM ${posOrdersTable.openedAt})`)
    .orderBy(sql`EXTRACT(HOUR FROM ${posOrdersTable.openedAt})`);

  const byDow = await db.select({
    dow: sql<number>`EXTRACT(DOW FROM ${posOrdersTable.openedAt})::int`,
    orders: sql<number>`COUNT(*)::int`,
    revenue: sql<string>`COALESCE(SUM(${posOrdersTable.total}::numeric), 0)::text`,
  }).from(posOrdersTable)
    .where(and(
      eq(posOrdersTable.companyId, cid),
      gte(posOrdersTable.openedAt, since),
      sql`${posOrdersTable.status} != 'cancelled'`,
    ))
    .groupBy(sql`EXTRACT(DOW FROM ${posOrdersTable.openedAt})`)
    .orderBy(sql`EXTRACT(DOW FROM ${posOrdersTable.openedAt})`);

  const totalOrders = byHour.reduce((s, r) => s + (r.orders ?? 0), 0);
  const totalRevenue = byHour.reduce((s, r) => s + Number(r.revenue ?? 0), 0);
  const peakHour = byHour.slice().sort((a, b) => (b.orders ?? 0) - (a.orders ?? 0))[0];
  const peakDow = byDow.slice().sort((a, b) => (b.orders ?? 0) - (a.orders ?? 0))[0];

  // Heuristic staffing recommendation: 1 waiter / 25 orders per hour
  const recommendations = byHour
    .filter(r => (r.orders ?? 0) > 0)
    .map(r => ({
      hour: r.hour,
      suggestedWaiters: Math.max(1, Math.ceil((r.orders / Math.max(1, days)) / 5)),
      avgOrdersPerDay: +(r.orders / Math.max(1, days)).toFixed(1),
    }));

  res.json({
    rangeDays: days, totalOrders, totalRevenue,
    byHour, byDow, peakHour, peakDow, recommendations,
  });
});

// ════════════════════════════════════════════════════════════════════════
// AI: waiter performance scoring (last 30 days)
// ════════════════════════════════════════════════════════════════════════
router.get("/ai/waiter-performance", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const days = Math.min(90, Math.max(1, Number(req.query.days ?? 30)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db.select({
    waiterId:    posOrdersTable.waiterId,
    waiterName:  usersTable.nameAr,
    orders:      sql<number>`COUNT(*)::int`,
    revenue:     sql<string>`COALESCE(SUM(${posOrdersTable.total}::numeric), 0)::text`,
    avgTicket:   sql<string>`COALESCE(AVG(${posOrdersTable.total}::numeric), 0)::text`,
    guests:      sql<number>`COALESCE(SUM(${posOrdersTable.guestCount}), 0)::int`,
    avgPrepMin:  sql<string>`COALESCE(AVG(EXTRACT(EPOCH FROM (${posOrdersTable.servedAt} - ${posOrdersTable.openedAt}))/60), 0)::text`,
    cancelled:   sql<number>`SUM(CASE WHEN ${posOrdersTable.status} = 'cancelled' THEN 1 ELSE 0 END)::int`,
  }).from(posOrdersTable)
    .leftJoin(usersTable, eq(usersTable.id, posOrdersTable.waiterId))
    .where(and(
      eq(posOrdersTable.companyId, cid),
      gte(posOrdersTable.openedAt, since),
      sql`${posOrdersTable.waiterId} IS NOT NULL`,
    ))
    .groupBy(posOrdersTable.waiterId, usersTable.nameAr)
    .orderBy(sql`SUM(${posOrdersTable.total}::numeric) DESC NULLS LAST`);

  // Score 0-100 = 60% revenue rank + 30% orders rank + 10% low-cancel
  const maxRev = Math.max(1, ...rows.map(r => Number(r.revenue)));
  const maxOrd = Math.max(1, ...rows.map(r => r.orders));
  const ranked = rows.map(r => {
    const revScore = (Number(r.revenue) / maxRev) * 60;
    const ordScore = (r.orders / maxOrd) * 30;
    const cancelRate = r.orders > 0 ? r.cancelled / r.orders : 0;
    const reliabilityScore = (1 - cancelRate) * 10;
    return { ...r, score: Math.round(revScore + ordScore + reliabilityScore) };
  });

  res.json({ rangeDays: days, waiters: ranked });
});

// ════════════════════════════════════════════════════════════════════════
// AI: inventory depletion prediction (per stock-linked menu item)
// ════════════════════════════════════════════════════════════════════════
router.get("/ai/inventory-forecast", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const days = Math.min(90, Math.max(7, Number(req.query.days ?? 30)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const consumption = await db.select({
    menuItemId: posOrderItemsTable.menuItemId,
    nameSnapshot: posMenuItemsTable.nameAr,
    itemId: posMenuItemsTable.itemId,
    qtyConsumed: sql<string>`COALESCE(SUM(${posOrderItemsTable.qty}::numeric), 0)::text`,
  }).from(posOrderItemsTable)
    .innerJoin(posOrdersTable, eq(posOrdersTable.id, posOrderItemsTable.orderId))
    .innerJoin(posMenuItemsTable, eq(posMenuItemsTable.id, posOrderItemsTable.menuItemId))
    .where(and(
      eq(posOrdersTable.companyId, cid),
      gte(posOrdersTable.openedAt, since),
      sql`${posOrderItemsTable.status} != 'cancelled'`,
      sql`${posMenuItemsTable.itemId} IS NOT NULL`,
    ))
    .groupBy(posOrderItemsTable.menuItemId, posMenuItemsTable.nameAr, posMenuItemsTable.itemId);

  const itemIds = consumption.map(c => c.itemId).filter((x): x is number => x != null);
  const stocks = itemIds.length > 0 ? await db.select({
    itemId: stockBalanceTable.itemId,
    onHand: sql<string>`COALESCE(SUM(${stockBalanceTable.qty}::numeric), 0)::text`,
  }).from(stockBalanceTable)
    .where(and(
      eq(stockBalanceTable.companyId, cid),
      inArray(stockBalanceTable.itemId, itemIds),
    ))
    .groupBy(stockBalanceTable.itemId) : [];
  const stockMap = new Map(stocks.map(s => [s.itemId, Number(s.onHand)]));

  const forecast = consumption.map(c => {
    const consumed = Number(c.qtyConsumed);
    const avgDaily = consumed / days;
    const onHand = stockMap.get(c.itemId!) ?? 0;
    const daysUntilZero = avgDaily > 0 ? Math.floor(onHand / avgDaily) : null;
    const status: "critical" | "low" | "ok" | "stockout" =
      onHand <= 0 ? "stockout" :
      daysUntilZero === null ? "ok" :
      daysUntilZero <= 3 ? "critical" :
      daysUntilZero <= 7 ? "low" : "ok";
    const reorderQty = avgDaily > 0 ? Math.ceil(avgDaily * 14) : 0; // suggest 14-day buffer
    return {
      menuItemId: c.menuItemId,
      itemId: c.itemId,
      name: c.nameSnapshot,
      onHand,
      avgDailyConsumption: +avgDaily.toFixed(2),
      qtyConsumed: consumed,
      daysUntilZero,
      reorderQty,
      status,
    };
  }).sort((a, b) => {
    const order = { stockout: 0, critical: 1, low: 2, ok: 3 };
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return (a.daysUntilZero ?? 999) - (b.daysUntilZero ?? 999);
  });

  res.json({
    rangeDays: days,
    items: forecast,
    summary: {
      stockout: forecast.filter(f => f.status === "stockout").length,
      critical: forecast.filter(f => f.status === "critical").length,
      low: forecast.filter(f => f.status === "low").length,
      ok: forecast.filter(f => f.status === "ok").length,
    },
  });
});

router.put("/ai/suspicious/:id/ack", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  await db.update(posSuspiciousOpsTable).set({ acknowledged: true })
    .where(and(eq(posSuspiciousOpsTable.id, id), eq(posSuspiciousOpsTable.companyId, cid)));
  res.json({ ok: true });
});

export default router;
