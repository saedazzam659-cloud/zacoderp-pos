import { Router } from "express";
import { db } from "@workspace/db";
import {
  salesInvoicesTable,
  salesInvoiceLinesTable,
  itemsTable,
  customersTable,
  posSuspiciousOpsTable,
  stockBalanceTable,
} from "@workspace/db";
import { and, eq, sql, desc, gte, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرّح" }); return; }
  next();
});

function cidOr401(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرّح" }); return null; }
  return cid;
}

// ─── /products  (lightweight POS-shaped view of inventory) ─────────────
router.get("/products", async (req, res) => {
  try {
    const cid = cidOr401(req, res); if (!cid) return;
    const rows = await db.select({
      id: itemsTable.id, code: itemsTable.code, nameAr: itemsTable.nameAr,
      nameEn: itemsTable.nameEn, barcode: itemsTable.barcode,
      salePrice: itemsTable.salePrice, vatRate: itemsTable.vatRate,
      groupId: itemsTable.groupId, imageUrl: itemsTable.imageUrl,
    }).from(itemsTable).where(eq(itemsTable.companyId, cid)).limit(2000);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── /stock ─────────────────────────────────────────────────────────────
router.get("/stock", async (req, res) => {
  try {
    const cid = cidOr401(req, res); if (!cid) return;
    const warehouseId = req.query.warehouseId ? Number(req.query.warehouseId) : undefined;
    const where = warehouseId
      ? and(eq(stockBalanceTable.companyId, cid), eq(stockBalanceTable.warehouseId, warehouseId))
      : eq(stockBalanceTable.companyId, cid);
    const rows = await db.select({
      itemId: stockBalanceTable.itemId,
      warehouseId: stockBalanceTable.warehouseId,
      qty: stockBalanceTable.qty,
    }).from(stockBalanceTable).where(where);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── /customers (slim) ──────────────────────────────────────────────────
router.get("/customers", async (req, res) => {
  try {
    const cid = cidOr401(req, res); if (!cid) return;
    const rows = await db.select({
      id: customersTable.id, nameAr: customersTable.nameAr, phone: customersTable.phone,
      vatNumber: customersTable.vatNumber,
    }).from(customersTable).where(eq(customersTable.companyId, cid)).limit(1000);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── /sync — accept queued offline operations ──────────────────────────
// Body: { operations: [{ clientId, kind: "invoice", payload: CreateInvoiceBody }] }
// Returns: { results: [{ clientId, ok, id?, error? }] }
router.post("/sync", async (req, res) => {
  try {
    const cid = cidOr401(req, res); if (!cid) return;
    const ops: Array<{ clientId: string; kind: string; payload: any }> = req.body?.operations ?? [];
    const results: Array<{ clientId: string; ok: boolean; id?: number; error?: string; duplicate?: boolean }> = [];
    for (const op of ops) {
      try {
        if (op.kind !== "invoice") {
          results.push({ clientId: op.clientId, ok: false, error: "نوع غير مدعوم" });
          continue;
        }
        // Idempotency: if a sales_invoice with notes containing the clientId exists, skip
        const existing = await db.select({ id: salesInvoicesTable.id })
          .from(salesInvoicesTable)
          .where(and(
            eq(salesInvoicesTable.companyId, cid),
            sql`${salesInvoicesTable.notes} LIKE ${`%[offline:${op.clientId}]%`}`,
          )).limit(1);
        if (existing.length) {
          results.push({ clientId: op.clientId, ok: true, id: existing[0].id, duplicate: true });
          continue;
        }
        const p = op.payload || {};
        const noteTag = `[offline:${op.clientId}]`;
        const notes = p.notes ? `${p.notes} ${noteTag}` : noteTag;
        const [inv] = await db.insert(salesInvoicesTable).values({
          companyId: cid,
          customerId: p.customerId ?? null,
          branchId: p.branchId ?? null,
          invoiceDate: p.invoiceDate,
          paymentType: p.paymentType ?? "cash",
          cashBoxId: p.cashBoxId ?? null,
          bankAccountId: p.bankAccountId ?? null,
          currencyCode: p.currencyCode ?? "SAR",
          subtotal: String(p.subtotal ?? 0),
          vatAmount: String(p.vatAmount ?? 0),
          discountAmount: String(p.discountAmount ?? 0),
          totalAmount: String(p.totalAmount ?? 0),
          priceIncludesVat: !!p.priceIncludesVat,
          status: "draft",
          notes,
        }).returning({ id: salesInvoicesTable.id });
        if (Array.isArray(p.lines) && p.lines.length) {
          await db.insert(salesInvoiceLinesTable).values(
            p.lines.map((l: any) => ({
              invoiceId: inv.id,
              itemId: l.itemId ?? null,
              itemName: l.itemName,
              itemCode: l.itemCode ?? null,
              unit: l.unit ?? null,
              unitId: l.unitId ?? null,
              warehouseId: l.warehouseId ?? null,
              qty: String(l.qty),
              unitPrice: String(l.unitPrice),
              discount: String(l.discount ?? 0),
              vatRate: String(l.vatRate ?? 15),
              lineTotal: String(l.lineTotal),
            })),
          );
        }
        results.push({ clientId: op.clientId, ok: true, id: inv.id });
      } catch (err: any) {
        results.push({ clientId: op.clientId, ok: false, error: err.message });
      }
    }
    res.json({ results, syncedAt: new Date().toISOString() });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════
// AI ENGINE — rule-based, server-authoritative
// ═══════════════════════════════════════════════════════════════════════

// 1) Smart product suggestions (co-purchase analysis)
// GET /ai/suggest?customerId=&itemIds=1,2,3&limit=6
router.get("/ai/suggest", async (req, res) => {
  try {
    const cid = cidOr401(req, res); if (!cid) return;
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 6));
    const customerId = req.query.customerId ? Number(req.query.customerId) : null;
    const itemIds = String(req.query.itemIds || "").split(",")
      .map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);

    // Fallback: top-selling items in the company over last 60 days
    const since = new Date(); since.setDate(since.getDate() - 60);
    const baseTop = db.select({
      itemId: salesInvoiceLinesTable.itemId,
      itemName: salesInvoiceLinesTable.itemName,
      score: sql<number>`COALESCE(SUM(${salesInvoiceLinesTable.qty}::numeric), 0)::float`,
    })
      .from(salesInvoiceLinesTable)
      .innerJoin(salesInvoicesTable, eq(salesInvoiceLinesTable.invoiceId, salesInvoicesTable.id))
      .where(and(
        eq(salesInvoicesTable.companyId, cid),
        gte(salesInvoicesTable.invoiceDate, since.toISOString().slice(0, 10)),
      ))
      .groupBy(salesInvoiceLinesTable.itemId, salesInvoiceLinesTable.itemName)
      .orderBy(desc(sql`SUM(${salesInvoiceLinesTable.qty}::numeric)`))
      .limit(limit * 3);

    // Co-purchase: invoices that contained any of the cart items, find OTHER items in those invoices
    let suggestions: Array<{ itemId: number | null; itemName: string; score: number; reason: string }> = [];
    if (itemIds.length) {
      const coRows = await db.execute(sql`
        WITH src AS (
          SELECT DISTINCT invoice_id FROM sales_invoice_lines
          WHERE item_id = ANY(${itemIds}::int[])
        )
        SELECT l.item_id AS "itemId", MIN(l.item_name) AS "itemName",
               COUNT(*)::int AS "score"
          FROM sales_invoice_lines l
          INNER JOIN src ON src.invoice_id = l.invoice_id
          INNER JOIN sales_invoices i ON i.id = l.invoice_id
         WHERE i.company_id = ${cid}
           AND l.item_id IS NOT NULL
           AND NOT (l.item_id = ANY(${itemIds}::int[]))
         GROUP BY l.item_id
         ORDER BY COUNT(*) DESC
         LIMIT ${limit}
      `);
      suggestions = (coRows.rows as any[]).map((r) => ({
        itemId: r.itemId, itemName: r.itemName, score: Number(r.score),
        reason: "كثيراً ما يُشترى مع المنتجات في السلة",
      }));
    }

    // Customer history: items this customer bought before
    if (customerId && suggestions.length < limit) {
      const histRows = await db.execute(sql`
        SELECT l.item_id AS "itemId", MIN(l.item_name) AS "itemName",
               COUNT(*)::int AS "score"
          FROM sales_invoice_lines l
          INNER JOIN sales_invoices i ON i.id = l.invoice_id
         WHERE i.company_id = ${cid}
           AND i.customer_id = ${customerId}
           AND l.item_id IS NOT NULL
         GROUP BY l.item_id
         ORDER BY COUNT(*) DESC
         LIMIT ${limit}
      `);
      const seen = new Set(suggestions.map((s) => s.itemId));
      for (const r of histRows.rows as any[]) {
        if (suggestions.length >= limit) break;
        if (seen.has(r.itemId)) continue;
        if (itemIds.includes(r.itemId)) continue;
        suggestions.push({
          itemId: r.itemId, itemName: r.itemName, score: Number(r.score),
          reason: "اشتراه هذا العميل سابقاً",
        });
      }
    }

    // Top sellers fallback
    if (suggestions.length < limit) {
      const topRows = await baseTop;
      const seen = new Set(suggestions.map((s) => s.itemId));
      for (const r of topRows) {
        if (suggestions.length >= limit) break;
        if (seen.has(r.itemId)) continue;
        if (r.itemId == null || itemIds.includes(r.itemId)) continue;
        suggestions.push({
          itemId: r.itemId, itemName: r.itemName, score: Number(r.score),
          reason: "من الأكثر مبيعاً",
        });
      }
    }

    res.json({ suggestions });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 2) Intelligent discount suggestion
// POST /ai/discount  body: { customerId?, totalAmount, qty, hour? }
router.post("/ai/discount", async (req, res) => {
  try {
    const cid = cidOr401(req, res); if (!cid) return;
    const { customerId, totalAmount = 0, qty = 0, hour } = req.body || {};
    const reasons: string[] = [];
    let pct = 0;

    // Loyalty: based on prior invoice count for this customer
    if (customerId) {
      const [{ c, sum }] = await db.select({
        c: sql<number>`COUNT(*)::int`,
        sum: sql<number>`COALESCE(SUM(${salesInvoicesTable.totalAmount}::numeric), 0)::float`,
      }).from(salesInvoicesTable)
        .where(and(eq(salesInvoicesTable.companyId, cid), eq(salesInvoicesTable.customerId, Number(customerId))));
      if (c >= 20) { pct += 5; reasons.push(`عميل مميز (${c} فاتورة سابقة)`); }
      else if (c >= 5) { pct += 3; reasons.push(`عميل متكرر (${c} فاتورة)`); }
      if (sum >= 10000) { pct += 2; reasons.push("إجمالي مشتريات تاريخية مرتفع"); }
    }

    // Volume bonus
    if (Number(totalAmount) >= 1000) { pct += 3; reasons.push("سلة كبيرة (≥1000 ر.س)"); }
    else if (Number(totalAmount) >= 500) { pct += 2; reasons.push("سلة متوسطة (≥500 ر.س)"); }
    if (Number(qty) >= 10) { pct += 1; reasons.push(`كمية كبيرة (${qty} وحدة)`); }

    // Off-peak hour boost (encourage sales at quiet times)
    const h = Number.isFinite(hour) ? Number(hour) : new Date().getHours();
    if (h >= 14 && h <= 17) { pct += 1; reasons.push("ساعات الذروة الهادئة"); }

    pct = Math.min(15, pct); // cap at 15%
    res.json({
      suggestedPercent: pct,
      maxPercent: 15,
      reasons: reasons.length ? reasons : ["لا يوجد سبب لخصم إضافي"],
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 3) Fraud detection on a transaction (pre-commit)
// POST /ai/fraud-check  body: { discountPct, totalAmount, qty, lines, paymentType }
router.post("/ai/fraud-check", async (req, res) => {
  try {
    const cid = cidOr401(req, res); if (!cid) return;
    const userId = (req as any).authUser?.id ?? null;
    const { discountPct = 0, totalAmount = 0, qty = 0, lines = [], paymentType = "cash" } = req.body || {};
    const flags: Array<{ severity: "low" | "medium" | "high"; message: string }> = [];

    if (Number(discountPct) >= 30) flags.push({ severity: "high", message: `خصم ضخم (${discountPct}%)` });
    else if (Number(discountPct) >= 15) flags.push({ severity: "medium", message: `خصم مرتفع (${discountPct}%)` });

    if (Number(totalAmount) >= 50000) flags.push({ severity: "high", message: "قيمة فاتورة استثنائية" });
    else if (Number(totalAmount) >= 10000) flags.push({ severity: "medium", message: "قيمة فاتورة كبيرة" });

    if (Array.isArray(lines)) {
      for (const l of lines) {
        if (Number(l.qty) >= 100) {
          flags.push({ severity: "medium", message: `كمية كبيرة لمنتج: ${l.itemName} (${l.qty})` });
        }
        if (Number(l.discount) > Number(l.lineTotal) * 0.5) {
          flags.push({ severity: "high", message: `خصم سطر يتجاوز 50%: ${l.itemName}` });
        }
      }
    }

    // Recent void/cancel pattern by this user (last 24h)
    if (userId) {
      const since = new Date(); since.setHours(since.getHours() - 24);
      const [{ c }] = await db.select({ c: sql<number>`COUNT(*)::int` })
        .from(posSuspiciousOpsTable)
        .where(and(
          eq(posSuspiciousOpsTable.companyId, cid),
          eq(posSuspiciousOpsTable.userId, userId),
          gte(posSuspiciousOpsTable.createdAt, since),
        ));
      if (c >= 5) flags.push({ severity: "high", message: `${c} عمليات مشبوهة لنفس المستخدم خلال 24 ساعة` });
      else if (c >= 2) flags.push({ severity: "medium", message: `${c} عمليات مشبوهة سابقة` });
    }

    const maxSev = flags.reduce((s, f) =>
      s === "high" || f.severity === "high" ? "high"
      : s === "medium" || f.severity === "medium" ? "medium" : "low", "low" as "low" | "medium" | "high");
    const block = flags.some((f) => f.severity === "high");

    // Persist if non-trivial
    if (flags.length && userId) {
      try {
        await db.insert(posSuspiciousOpsTable).values({
          companyId: cid,
          userId,
          kind: (Number(discountPct) >= 15 ? "large_discount" : "rapid_voids") as any,
          severity: maxSev,
          description: flags.map((f) => f.message).join(" | "),
          payload: { discountPct, totalAmount, qty, paymentType },
          acknowledged: false,
        });
      } catch {}
    }

    res.json({ ok: !block, severity: maxSev, flags, block });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 4) AI chat — natural-language Q&A on POS sales (rule-based intent)
// POST /ai/chat  body: { question }
router.post("/ai/chat", async (req, res) => {
  try {
    const cid = cidOr401(req, res); if (!cid) return;
    const q = String(req.body?.question || "").toLowerCase().trim();
    if (!q) { res.json({ answer: "اكتب سؤالاً مثل: أعلى مبيعات اليوم، أفضل عميل، أكثر منتج مبيعاً." }); return; }

    const today = new Date().toISOString().slice(0, 10);
    const monthStart = new Date(); monthStart.setDate(1);
    const since30 = new Date(); since30.setDate(since30.getDate() - 30);

    // Intent: top sales today
    if (/(اليوم|today)/.test(q) && /(مبيع|sales|إجمالي|total)/.test(q)) {
      const [{ total, count }] = await db.select({
        total: sql<number>`COALESCE(SUM(${salesInvoicesTable.totalAmount}::numeric), 0)::float`,
        count: sql<number>`COUNT(*)::int`,
      }).from(salesInvoicesTable)
        .where(and(eq(salesInvoicesTable.companyId, cid), eq(salesInvoicesTable.invoiceDate, today)));
      res.json({ answer: `مبيعات اليوم: ${(total || 0).toFixed(2)} ر.س عبر ${count} فاتورة.`, data: { total, count } });
      return;
    }

    // Best customer (last 30d)
    if (/(أفضل|best|أعلى).{0,8}(عميل|customer)/.test(q)) {
      const rows = await db.execute(sql`
        SELECT i.customer_id AS "customerId", c.name_ar AS "nameAr",
               COUNT(*)::int AS "cnt",
               COALESCE(SUM(i.total_amount::numeric),0)::float AS "total"
          FROM sales_invoices i
          LEFT JOIN customers c ON c.id = i.customer_id
         WHERE i.company_id = ${cid} AND i.invoice_date >= ${since30.toISOString().slice(0,10)}
           AND i.customer_id IS NOT NULL
         GROUP BY i.customer_id, c.name_ar
         ORDER BY SUM(i.total_amount::numeric) DESC
         LIMIT 3
      `);
      const top = (rows.rows as any[])[0];
      if (!top) { res.json({ answer: "لا توجد بيانات عملاء كافية في آخر 30 يوماً." }); return; }
      res.json({
        answer: `أفضل عميل (آخر 30 يوماً): ${top.nameAr || "—"} بإجمالي ${Number(top.total).toFixed(2)} ر.س عبر ${top.cnt} فاتورة.`,
        data: rows.rows,
      });
      return;
    }

    // Top items
    if (/(أكثر|top|الأكثر|بيع|product|منتج|صنف)/.test(q)) {
      const rows = await db.execute(sql`
        SELECT l.item_name AS "name",
               SUM(l.qty::numeric)::float AS "qty",
               SUM(l.line_total::numeric)::float AS "revenue"
          FROM sales_invoice_lines l
          INNER JOIN sales_invoices i ON i.id = l.invoice_id
         WHERE i.company_id = ${cid} AND i.invoice_date >= ${since30.toISOString().slice(0,10)}
         GROUP BY l.item_name
         ORDER BY SUM(l.qty::numeric) DESC
         LIMIT 5
      `);
      const list = (rows.rows as any[]).map((r, i) => `${i + 1}. ${r.name} — ${Number(r.qty).toFixed(0)} وحدة (${Number(r.revenue).toFixed(2)} ر.س)`).join("\n");
      res.json({ answer: `أكثر 5 منتجات مبيعاً (آخر 30 يوماً):\n${list || "—"}`, data: rows.rows });
      return;
    }

    // This-month total
    if (/(الشهر|month)/.test(q)) {
      const [{ total, count }] = await db.select({
        total: sql<number>`COALESCE(SUM(${salesInvoicesTable.totalAmount}::numeric), 0)::float`,
        count: sql<number>`COUNT(*)::int`,
      }).from(salesInvoicesTable)
        .where(and(eq(salesInvoicesTable.companyId, cid),
          gte(salesInvoicesTable.invoiceDate, monthStart.toISOString().slice(0,10))));
      res.json({ answer: `مبيعات الشهر حتى الآن: ${(total || 0).toFixed(2)} ر.س عبر ${count} فاتورة.`, data: { total, count } });
      return;
    }

    res.json({
      answer: "جرّب: «مبيعات اليوم»، «أفضل عميل»، «أكثر المنتجات مبيعاً»، أو «إجمالي الشهر».",
      suggestions: ["مبيعات اليوم", "أفضل عميل", "أكثر المنتجات مبيعاً", "إجمالي الشهر"],
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
