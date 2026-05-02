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
} from "@workspace/db";
import { and, eq, sql, desc, asc, isNull, gte, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرّح" }); return; }
  next();
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

function recalcTotals(lines: Array<{ qty: string | number; price: string | number }>) {
  const subtotal = lines.reduce((s, l) => s + Number(l.qty) * Number(l.price), 0);
  const vat = subtotal * 0.15;
  return {
    subtotal: subtotal.toFixed(2),
    vatAmount: vat.toFixed(2),
    total: (subtotal + vat).toFixed(2),
  };
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
  const rows = await db.select().from(posMenuItemsTable).where(where).orderBy(asc(posMenuItemsTable.nameAr));
  res.json(rows);
});

router.post("/menu/items", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const { categoryId, code, nameAr, nameEn, description, price, prepTimeMinutes, kitchenStation, imageUrl, itemId, vatIncluded, modifiers } = req.body ?? {};
  if (!categoryId || !code || !nameAr) { res.status(400).json({ error: "categoryId/code/nameAr مطلوبة" }); return; }
  try {
    const [row] = await db.insert(posMenuItemsTable).values({
      companyId: cid, categoryId: Number(categoryId), code, nameAr,
      nameEn: nameEn ?? null, description: description ?? null,
      price: String(price ?? "0"),
      prepTimeMinutes: Number(prepTimeMinutes ?? 0),
      kitchenStation: kitchenStation ?? "kitchen",
      imageUrl: imageUrl ?? null,
      itemId: itemId ? Number(itemId) : null,
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

router.get("/orders/:id", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [order] = await db.select().from(posOrdersTable)
    .where(and(eq(posOrdersTable.id, id), eq(posOrdersTable.companyId, cid)));
  if (!order) { res.status(404).json({ error: "not found" }); return; }
  const items = await db.select().from(posOrderItemsTable)
    .where(eq(posOrderItemsTable.orderId, id))
    .orderBy(asc(posOrderItemsTable.id));
  res.json({ ...order, items });
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
  const total = (Number(mi.price) * q).toFixed(2);
  await db.insert(posOrderItemsTable).values({
    orderId: id, menuItemId: mi.id, nameSnapshot: mi.nameAr,
    qty: String(q), price: mi.price, total,
    kitchenStation: mi.kitchenStation,
    modifiers: modifiers ?? [],
    notes: notes ?? null,
  });
  // Recalc totals
  const items = await db.select().from(posOrderItemsTable).where(eq(posOrderItemsTable.orderId, id));
  const totals = recalcTotals(items.filter(i => i.status !== "cancelled"));
  await db.update(posOrdersTable).set({ ...totals, updatedAt: new Date() })
    .where(eq(posOrdersTable.id, id));
  res.status(201).json({ ok: true, ...totals });
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
  const items = await db.select().from(posOrderItemsTable).where(eq(posOrderItemsTable.orderId, id));
  const totals = recalcTotals(items.filter(i => i.status !== "cancelled"));
  await db.update(posOrdersTable).set({ ...totals, updatedAt: new Date() })
    .where(eq(posOrdersTable.id, id));
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
  const { salesInvoiceId } = req.body ?? {};
  const [order] = await db.select().from(posOrdersTable)
    .where(and(eq(posOrdersTable.id, id), eq(posOrdersTable.companyId, cid)));
  if (!order) { res.status(404).json({ error: "not found" }); return; }
  await db.update(posOrdersTable)
    .set({
      status: "billed", billedAt: new Date(),
      billedInvoiceId: salesInvoiceId ? Number(salesInvoiceId) : null,
      updatedAt: new Date(),
    })
    .where(eq(posOrdersTable.id, id));
  if (order.tableId) {
    await db.update(posTablesTable)
      .set({ status: "free", currentOrderId: null, updatedAt: new Date() })
      .where(eq(posTablesTable.id, order.tableId));
  }
  res.json({ ok: true });
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
    userId: salesInvoicesTable.createdBy,
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

router.put("/ai/suspicious/:id/ack", async (req, res) => {
  const cid = cidOr401(req, res); if (!cid) return;
  const id = Number(req.params.id);
  await db.update(posSuspiciousOpsTable).set({ acknowledged: true })
    .where(and(eq(posSuspiciousOpsTable.id, id), eq(posSuspiciousOpsTable.companyId, cid)));
  res.json({ ok: true });
});

export default router;
