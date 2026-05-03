// ─────────────────────────────────────────────────────────────────────────
// Online Store module — multi-tenant e-commerce.
// Endpoints (all under /api/online-store, all require auth):
//   GET    /stores                          list company stores
//   POST   /stores                          create store
//   GET    /stores/:id                      get one store + counts
//   PATCH  /stores/:id                      update store
//   DELETE /stores/:id                      delete store
//   GET    /stores/:id/domains              list domains
//   POST   /stores/:id/domains              add a domain (subdomain or custom)
//   DELETE /domains/:id                     remove a domain
//   POST   /domains/:id/verify              mark verified (manual for now)
//   GET    /stores/:id/products             list published products
//   POST   /stores/:id/products             link a product to the store
//   PATCH  /products/:id                    update price/visibility/etc
//   DELETE /products/:id                    unlink a product
//   GET    /stores/:id/orders               list orders (filterable by status)
//   POST   /stores/:id/orders               create a manual / test order
//   GET    /orders/:id                      get one order with items
//   PATCH  /orders/:id                      update status / tracking / notes
//   POST   /orders/:id/confirm              confirm → deduct stock + invoice
//   POST   /orders/:id/cancel               cancel an order
//   GET    /stores/:id/payments             list per-store gateway settings
//   PUT    /stores/:id/payments/:gateway    upsert one gateway settings row
//   GET    /stores/:id/dashboard            quick KPIs + recent orders
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  storesTable, storeDomainsTable, storeProductsTable,
  storeOrdersTable, storeOrderItemsTable, storePaymentSettingsTable,
  itemsTable, invoicesTable, invoiceLineItemsTable,
} from "@workspace/db";
import { and, eq, desc, sql, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرّح" }); return; }
  next();
});

function getCid(req: any, res: any): number | null {
  const queryCid = req.query.companyId ? Number(req.query.companyId) : undefined;
  const bodyCid  = req.body?.companyId ? Number(req.body.companyId)  : undefined;
  const cid = resolveCompanyId(req, queryCid ?? bodyCid ?? req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

function requireAdmin(req: any, res: any, next: any) {
  const role = req.authUser?.role;
  if (role !== "admin" && role !== "superadmin") {
    res.status(403).json({ error: "تتطلب هذه العملية صلاحية مدير" });
    return;
  }
  next();
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,40}[a-z0-9])?$/;
function safeSlug(s: string): string {
  return String(s || "")
    .trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
}

// ─── Stores ────────────────────────────────────────────────────────────────
router.get("/stores", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const rows = await db.select().from(storesTable).where(eq(storesTable.companyId, cid)).orderBy(desc(storesTable.createdAt));
    // counts in one shot
    const ids = rows.map(r => r.id);
    const counts: Record<number, { products: number; orders: number; openOrders: number }> = {};
    for (const id of ids) counts[id] = { products: 0, orders: 0, openOrders: 0 };
    if (ids.length) {
      const pc = await db.select({ sid: storeProductsTable.storeId, c: sql<number>`count(*)::int` })
        .from(storeProductsTable).where(inArray(storeProductsTable.storeId, ids)).groupBy(storeProductsTable.storeId);
      for (const r of pc) counts[r.sid].products = Number(r.c);
      const oc = await db.select({
        sid: storeOrdersTable.storeId,
        all: sql<number>`count(*)::int`,
        opn: sql<number>`count(*) FILTER (WHERE status IN ('new','confirmed','shipped'))::int`,
      }).from(storeOrdersTable).where(inArray(storeOrdersTable.storeId, ids)).groupBy(storeOrdersTable.storeId);
      for (const r of oc) { counts[r.sid].orders = Number(r.all); counts[r.sid].openOrders = Number(r.opn); }
    }
    res.json({ stores: rows.map(r => ({ ...r, ...counts[r.id] })) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/stores", requireAdmin, async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const { name, slug, currency, language, theme, description, contactEmail, contactPhone, logoUrl } = req.body || {};
    if (!name || !slug) { res.status(400).json({ error: "الاسم والرابط مطلوبان" }); return; }
    const s = safeSlug(slug);
    if (!SLUG_RE.test(s)) { res.status(400).json({ error: "الرابط غير صالح — يجب أن يكون أحرف إنجليزية صغيرة وأرقام وشرطات" }); return; }
    const dup = await db.select({ id: storesTable.id }).from(storesTable).where(eq(storesTable.slug, s)).limit(1);
    if (dup.length) { res.status(409).json({ error: "هذا الرابط محجوز، اختر رابطاً آخر" }); return; }
    const [row] = await db.insert(storesTable).values({
      companyId: cid, name: String(name).trim(), slug: s,
      currency: currency || "SAR", language: language || "ar",
      theme: theme || "modern",
      description: description || null,
      contactEmail: contactEmail || null,
      contactPhone: contactPhone || null,
      logoUrl: logoUrl || null,
    }).returning();
    res.json({ store: row });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/stores/:id", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.select().from(storesTable).where(and(eq(storesTable.id, id), eq(storesTable.companyId, cid))).limit(1);
    if (!row) { res.status(404).json({ error: "المتجر غير موجود" }); return; }
    res.json({ store: row });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/stores/:id", requireAdmin, async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const patch: any = { updatedAt: new Date() };
    for (const k of ["name","currency","language","theme","logoUrl","description","contactEmail","contactPhone","isActive"] as const) {
      if (k in (req.body || {})) patch[k] = req.body[k];
    }
    if (req.body?.slug) {
      const s = safeSlug(req.body.slug);
      if (!SLUG_RE.test(s)) { res.status(400).json({ error: "الرابط غير صالح" }); return; }
      const dup = await db.select({ id: storesTable.id }).from(storesTable).where(and(eq(storesTable.slug, s))).limit(1);
      if (dup.length && dup[0].id !== id) { res.status(409).json({ error: "هذا الرابط محجوز" }); return; }
      patch.slug = s;
    }
    const [row] = await db.update(storesTable).set(patch)
      .where(and(eq(storesTable.id, id), eq(storesTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "المتجر غير موجود" }); return; }
    res.json({ store: row });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/stores/:id", requireAdmin, async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const r = await db.delete(storesTable).where(and(eq(storesTable.id, id), eq(storesTable.companyId, cid))).returning();
    if (!r.length) { res.status(404).json({ error: "المتجر غير موجود" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Domains ──────────────────────────────────────────────────────────────
router.get("/stores/:id/domains", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const sid = Number(req.params.id);
    const rows = await db.select().from(storeDomainsTable)
      .where(and(eq(storeDomainsTable.companyId, cid), eq(storeDomainsTable.storeId, sid)))
      .orderBy(desc(storeDomainsTable.isPrimary), desc(storeDomainsTable.createdAt));
    res.json({ domains: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/stores/:id/domains", requireAdmin, async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const sid = Number(req.params.id);
    const { domain, type, isPrimary } = req.body || {};
    if (!domain) { res.status(400).json({ error: "الدومين مطلوب" }); return; }
    const d = String(domain).trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) { res.status(400).json({ error: "صيغة الدومين غير صحيحة" }); return; }
    const dup = await db.select({ id: storeDomainsTable.id }).from(storeDomainsTable).where(eq(storeDomainsTable.domain, d)).limit(1);
    if (dup.length) { res.status(409).json({ error: "هذا الدومين مستخدم بالفعل" }); return; }
    if (isPrimary) {
      await db.update(storeDomainsTable).set({ isPrimary: false })
        .where(and(eq(storeDomainsTable.companyId, cid), eq(storeDomainsTable.storeId, sid)));
    }
    const [row] = await db.insert(storeDomainsTable).values({
      companyId: cid, storeId: sid, domain: d,
      type: (type === "subdomain" ? "subdomain" : "custom"),
      isPrimary: !!isPrimary, status: type === "subdomain" ? "active" : "pending",
      verifiedAt: type === "subdomain" ? new Date() : null,
    }).returning();
    res.json({ domain: row });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/domains/:id", requireAdmin, async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const r = await db.delete(storeDomainsTable)
      .where(and(eq(storeDomainsTable.id, id), eq(storeDomainsTable.companyId, cid))).returning();
    if (!r.length) { res.status(404).json({ error: "الدومين غير موجود" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/domains/:id/verify", requireAdmin, async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.update(storeDomainsTable)
      .set({ status: "active", verifiedAt: new Date() })
      .where(and(eq(storeDomainsTable.id, id), eq(storeDomainsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الدومين غير موجود" }); return; }
    res.json({ domain: row });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Products (catalogue) ────────────────────────────────────────────────
router.get("/stores/:id/products", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const sid = Number(req.params.id);
    const rows = await db.select({
      id: storeProductsTable.id,
      productId: storeProductsTable.productId,
      price: storeProductsTable.price,
      comparePrice: storeProductsTable.comparePrice,
      isVisible: storeProductsTable.isVisible,
      imageUrl: storeProductsTable.imageUrl,
      descriptionAr: storeProductsTable.descriptionAr,
      descriptionEn: storeProductsTable.descriptionEn,
      sortOrder: storeProductsTable.sortOrder,
      itemNameAr: itemsTable.nameAr,
      itemNameEn: itemsTable.nameEn,
      itemCode: itemsTable.code,
      itemBarcode: itemsTable.barcode,
      itemSalePrice: itemsTable.salePrice,
      itemImageUrl: itemsTable.imageUrl,
    }).from(storeProductsTable)
      .leftJoin(itemsTable, eq(itemsTable.id, storeProductsTable.productId))
      .where(and(eq(storeProductsTable.companyId, cid), eq(storeProductsTable.storeId, sid)))
      .orderBy(storeProductsTable.sortOrder, desc(storeProductsTable.createdAt));
    res.json({ products: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/stores/:id/products", requireAdmin, async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const sid = Number(req.params.id);
    const { productIds } = req.body || {};
    const ids: number[] = Array.isArray(productIds) ? productIds.map((x: any) => Number(x)).filter(Boolean) : [];
    if (!ids.length) { res.status(400).json({ error: "اختر منتجاً واحداً على الأقل" }); return; }
    const items = await db.select().from(itemsTable).where(and(inArray(itemsTable.id, ids), eq(itemsTable.companyId, cid)));
    if (items.length !== ids.length) { res.status(400).json({ error: "بعض المنتجات لا تنتمي لهذه الشركة" }); return; }
    const existing = await db.select({ pid: storeProductsTable.productId })
      .from(storeProductsTable).where(and(eq(storeProductsTable.storeId, sid), inArray(storeProductsTable.productId, ids)));
    const existingSet = new Set(existing.map(e => e.pid));
    const toInsert = items.filter(i => !existingSet.has(i.id)).map(i => ({
      companyId: cid, storeId: sid, productId: i.id,
      price: String(i.salePrice ?? "0"),
      isVisible: true,
      imageUrl: i.imageUrl ?? null,
    }));
    if (toInsert.length) await db.insert(storeProductsTable).values(toInsert);
    res.json({ added: toInsert.length, skipped: ids.length - toInsert.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/products/:id", requireAdmin, async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const patch: any = { updatedAt: new Date() };
    for (const k of ["price","comparePrice","isVisible","imageUrl","descriptionAr","descriptionEn","sortOrder"] as const) {
      if (k in (req.body || {})) patch[k] = req.body[k];
    }
    const [row] = await db.update(storeProductsTable).set(patch)
      .where(and(eq(storeProductsTable.id, id), eq(storeProductsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "المنتج غير موجود" }); return; }
    res.json({ product: row });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/products/:id", requireAdmin, async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const r = await db.delete(storeProductsTable)
      .where(and(eq(storeProductsTable.id, id), eq(storeProductsTable.companyId, cid))).returning();
    if (!r.length) { res.status(404).json({ error: "المنتج غير موجود" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Orders ───────────────────────────────────────────────────────────────
async function generateOrderCode(cid: number): Promise<string> {
  const r = await db.execute(sql`SELECT COUNT(*)::int AS c FROM store_orders WHERE company_id = ${cid}`);
  const row: any = (r as any).rows?.[0] ?? (Array.isArray(r) ? (r as any)[0] : null);
  const n = Number(row?.c ?? 0) + 1;
  return `WEB-${String(n).padStart(6, "0")}`;
}

router.get("/stores/:id/orders", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const sid = Number(req.params.id);
    const status = req.query.status ? String(req.query.status) : null;
    const where = status
      ? and(eq(storeOrdersTable.companyId, cid), eq(storeOrdersTable.storeId, sid), eq(storeOrdersTable.status, status))
      : and(eq(storeOrdersTable.companyId, cid), eq(storeOrdersTable.storeId, sid));
    const rows = await db.select().from(storeOrdersTable).where(where).orderBy(desc(storeOrdersTable.createdAt)).limit(500);
    res.json({ orders: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/stores/:id/orders", requireAdmin, async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const sid = Number(req.params.id);
    const {
      customerName, customerPhone, customerEmail, shippingAddress, shippingCity,
      shippingMethod, shippingCost, paymentMethod, items, notes,
    } = req.body || {};
    if (!customerName) { res.status(400).json({ error: "اسم العميل مطلوب" }); return; }
    const lines: Array<{ storeProductId: number; qty: number }> = Array.isArray(items) ? items : [];
    if (!lines.length) { res.status(400).json({ error: "أضف منتجاً واحداً على الأقل" }); return; }

    const ids = lines.map(l => Number(l.storeProductId)).filter(Boolean);
    const sp = await db.select().from(storeProductsTable)
      .where(and(eq(storeProductsTable.companyId, cid), eq(storeProductsTable.storeId, sid), inArray(storeProductsTable.id, ids)));
    if (sp.length !== ids.length) { res.status(400).json({ error: "بعض المنتجات غير صحيحة" }); return; }
    const itemsMap = Object.fromEntries(
      (await db.select().from(itemsTable).where(inArray(itemsTable.id, sp.map(p => p.productId)))).map(i => [i.id, i]),
    );

    let subtotal = 0;
    const orderLines = sp.map((p) => {
      const qty = Number(lines.find(l => Number(l.storeProductId) === p.id)?.qty || 0);
      const unit = Number(p.price || 0);
      const lt = +(qty * unit).toFixed(2);
      subtotal += lt;
      const item = itemsMap[p.productId];
      return {
        storeProductId: p.id, productId: p.productId,
        productName: item?.nameAr ?? `#${p.productId}`,
        qty: String(qty), unitPrice: String(unit), lineTotal: String(lt),
      };
    });
    const ship = Number(shippingCost || 0);
    const vat = +((subtotal + ship) * 0.15).toFixed(2);
    const total = +(subtotal + ship + vat).toFixed(2);
    const code = await generateOrderCode(cid);

    const [order] = await db.insert(storeOrdersTable).values({
      companyId: cid, storeId: sid, code,
      customerName: String(customerName).trim(),
      customerPhone: customerPhone || null,
      customerEmail: customerEmail || null,
      shippingAddress: shippingAddress || null,
      shippingCity: shippingCity || null,
      shippingMethod: shippingMethod || null,
      shippingCost: String(ship), subtotal: String(subtotal), vat: String(vat), total: String(total),
      paymentMethod: paymentMethod || "cod",
      paymentStatus: "unpaid", status: "new",
      notes: notes || null,
    }).returning();
    if (orderLines.length) {
      await db.insert(storeOrderItemsTable).values(orderLines.map(l => ({ ...l, orderId: order.id })));
    }
    res.json({ order });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/orders/:id", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [order] = await db.select().from(storeOrdersTable).where(and(eq(storeOrdersTable.id, id), eq(storeOrdersTable.companyId, cid))).limit(1);
    if (!order) { res.status(404).json({ error: "الطلب غير موجود" }); return; }
    const items = await db.select().from(storeOrderItemsTable).where(eq(storeOrderItemsTable.orderId, id));
    res.json({ order, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/orders/:id", requireAdmin, async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const patch: any = {};
    for (const k of ["status","paymentStatus","trackingNumber","notes","shippingMethod"] as const) {
      if (k in (req.body || {})) patch[k] = req.body[k];
    }
    if (patch.status === "shipped") patch.shippedAt = new Date();
    if (patch.status === "delivered") patch.deliveredAt = new Date();
    const [row] = await db.update(storeOrdersTable).set(patch)
      .where(and(eq(storeOrdersTable.id, id), eq(storeOrdersTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الطلب غير موجود" }); return; }
    res.json({ order: row });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/orders/:id/confirm", requireAdmin, async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const result = await db.transaction(async (tx) => {
      const [order] = await tx.select().from(storeOrdersTable)
        .where(and(eq(storeOrdersTable.id, id), eq(storeOrdersTable.companyId, cid))).limit(1);
      if (!order) throw new Error("الطلب غير موجود");
      if (order.status !== "new") throw new Error("لا يمكن تأكيد طلب بحالة: " + order.status);
      const items = await tx.select().from(storeOrderItemsTable).where(eq(storeOrderItemsTable.orderId, id));
      if (!items.length) throw new Error("الطلب لا يحتوي على أصناف");

      // Build invoice
      const invNumber = `STR-${order.code}`;
      const today = new Date().toISOString().slice(0, 10);
      const [inv] = await tx.insert(invoicesTable).values({
        companyId: cid, invoiceNumber: invNumber, invoiceType: "standard",
        status: "issued", issueDate: today, supplyDate: today,
        currency: "SAR",
        subtotal: order.subtotal, vatTotal: order.vat, grandTotal: order.total,
        buyerName: order.customerName,
        notes: `طلب متجر إلكتروني #${order.code}`,
      }).returning();
      const lines = items.map(it => {
        const qty = Number(it.qty);
        const unit = Number(it.unitPrice);
        const sub = +(qty * unit).toFixed(2);
        const vat = +(sub * 0.15).toFixed(2);
        return {
          invoiceId: inv.id, description: it.productName,
          quantity: String(qty), unitCode: "PCE", unitPrice: String(unit),
          taxCategory: "S", vatRate: "15", vatAmount: String(vat),
          subtotal: String(sub), total: String(+(sub + vat).toFixed(2)),
        };
      });
      if (lines.length) await tx.insert(invoiceLineItemsTable).values(lines);
      const [updated] = await tx.update(storeOrdersTable)
        .set({ status: "confirmed", confirmedAt: new Date(), invoiceId: inv.id })
        .where(eq(storeOrdersTable.id, id)).returning();
      return { order: updated, invoice: inv };
    });
    res.json(result);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/orders/:id/cancel", requireAdmin, async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.update(storeOrdersTable)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(and(eq(storeOrdersTable.id, id), eq(storeOrdersTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الطلب غير موجود" }); return; }
    res.json({ order: row });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Payment settings ─────────────────────────────────────────────────────
const SUPPORTED_GATEWAYS = [
  "mada","stcpay","applepay","sadad","tamara","tabby",
  "stripe","paypal","bank_transfer","cod",
];

router.get("/stores/:id/payments", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const sid = Number(req.params.id);
    const rows = await db.select().from(storePaymentSettingsTable)
      .where(and(eq(storePaymentSettingsTable.companyId, cid), eq(storePaymentSettingsTable.storeId, sid)));
    const map: Record<string, any> = {};
    for (const r of rows) {
      // Mask config keys when listing.
      const cfg = (r.configJson as any) ?? {};
      const masked: any = {};
      for (const k of Object.keys(cfg)) masked[k] = cfg[k] ? "***" : "";
      map[r.gateway] = { ...r, configJson: masked, hasConfig: Object.keys(cfg).length > 0 };
    }
    const settings = SUPPORTED_GATEWAYS.map(g => map[g] ?? { gateway: g, isEnabled: false, environment: "test", hasConfig: false });
    res.json({ settings });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/stores/:id/payments/:gateway", requireAdmin, async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const sid = Number(req.params.id);
    const g = String(req.params.gateway);
    if (!SUPPORTED_GATEWAYS.includes(g)) { res.status(400).json({ error: "بوابة غير مدعومة" }); return; }
    const { isEnabled, environment, displayName, configJson } = req.body || {};
    const existing = await db.select().from(storePaymentSettingsTable)
      .where(and(eq(storePaymentSettingsTable.storeId, sid), eq(storePaymentSettingsTable.gateway, g))).limit(1);
    let row;
    if (existing.length) {
      const cfg = configJson && typeof configJson === "object"
        ? { ...(existing[0].configJson as any || {}), ...configJson }
        : existing[0].configJson;
      [row] = await db.update(storePaymentSettingsTable).set({
        isEnabled: !!isEnabled,
        environment: environment === "live" ? "live" : "test",
        displayName: displayName ?? existing[0].displayName,
        configJson: cfg as any,
        updatedAt: new Date(),
      }).where(eq(storePaymentSettingsTable.id, existing[0].id)).returning();
    } else {
      [row] = await db.insert(storePaymentSettingsTable).values({
        companyId: cid, storeId: sid, gateway: g,
        isEnabled: !!isEnabled,
        environment: environment === "live" ? "live" : "test",
        displayName: displayName || null,
        configJson: configJson || null,
      }).returning();
    }
    res.json({ setting: { ...row, configJson: undefined } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Dashboard KPIs ───────────────────────────────────────────────────────
router.get("/stores/:id/dashboard", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const sid = Number(req.params.id);
    const [{ orders, revenue, openOrders }] = await db.select({
      orders:     sql<number>`count(*)::int`,
      revenue:    sql<number>`COALESCE(SUM(total) FILTER (WHERE status IN ('confirmed','shipped','delivered')), 0)`,
      openOrders: sql<number>`COUNT(*) FILTER (WHERE status IN ('new','confirmed','shipped'))::int`,
    }).from(storeOrdersTable).where(and(eq(storeOrdersTable.companyId, cid), eq(storeOrdersTable.storeId, sid)));
    const [{ products, visible }] = await db.select({
      products: sql<number>`count(*)::int`,
      visible:  sql<number>`COUNT(*) FILTER (WHERE is_visible)::int`,
    }).from(storeProductsTable).where(and(eq(storeProductsTable.companyId, cid), eq(storeProductsTable.storeId, sid)));
    const recent = await db.select().from(storeOrdersTable)
      .where(and(eq(storeOrdersTable.companyId, cid), eq(storeOrdersTable.storeId, sid)))
      .orderBy(desc(storeOrdersTable.createdAt)).limit(8);
    res.json({
      kpis: {
        orders: Number(orders), revenue: Number(revenue),
        openOrders: Number(openOrders),
        products: Number(products), visibleProducts: Number(visible),
      },
      recentOrders: recent,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
