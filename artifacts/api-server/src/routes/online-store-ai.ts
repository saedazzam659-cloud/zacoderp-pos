// ─────────────────────────────────────────────────────────────────────────
// Online Store AI helpers — product recommendations, sales analysis, low-
// stock alerts, AI product description writer. Falls back to deterministic
// rule-based logic when the OpenAI proxy isn't configured.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  storesTable, storeProductsTable, storeOrdersTable, storeOrderItemsTable,
  itemsTable,
} from "@workspace/db";
import { and, eq, desc, sql, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requireAiFeature, logAiUsage } from "../middleware/requireAiFeature.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

import { chat as aiChat, isAIAvailable } from "../lib/aiClient.js";

function getCid(req: any, res: any): number | null {
  const raw = req.body?.companyId ?? req.query.companyId;
  const cid = resolveCompanyId(req, raw ?? req.authUser?.companyId);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// Routes here pass `jsonMode=true` to get a parsed object back, or `false`
// to get raw text (wrapped in `{ text }` for symmetry with the old shim).
// Provider failover (OpenAI → Anthropic) is handled by the unified client.
async function callAI(messages: any[], jsonMode = true): Promise<any | null> {
  const r = await aiChat(messages, { json: jsonMode, maxTokens: 4096 });
  if (!r.ok) return null;
  return jsonMode ? (r.data ?? null) : { text: r.text };
}

// ─── Sales analysis: top products, revenue trend, payment-method split ───
router.get("/stores/:id/sales-analysis", requireAiFeature("online_store_ai"), async (req, res) => {
  const startedAt = Date.now();
  try {
    const cid = getCid(req, res); if (!cid) return;
    const sid = Number(req.params.id);

    const top = await db.select({
      productId:  storeOrderItemsTable.productId,
      name:       storeOrderItemsTable.productName,
      qty:        sql<number>`SUM(qty)::float`,
      revenue:    sql<number>`SUM(line_total)::float`,
      ordersCount: sql<number>`COUNT(DISTINCT order_id)::int`,
    }).from(storeOrderItemsTable)
      .innerJoin(storeOrdersTable, eq(storeOrderItemsTable.orderId, storeOrdersTable.id))
      .where(and(eq(storeOrdersTable.companyId, cid), eq(storeOrdersTable.storeId, sid)))
      .groupBy(storeOrderItemsTable.productId, storeOrderItemsTable.productName)
      .orderBy(sql`SUM(line_total) DESC`)
      .limit(8);

    const trend = await db.execute(sql`
      SELECT TO_CHAR(DATE_TRUNC('day', created_at), 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS orders,
             COALESCE(SUM(total), 0)::float AS revenue
        FROM store_orders
       WHERE company_id = ${cid} AND store_id = ${sid}
         AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY 1 ORDER BY 1
    `);
    const trendRows = (trend as any).rows ?? [];

    const pay = await db.select({
      method: storeOrdersTable.paymentMethod,
      count:  sql<number>`COUNT(*)::int`,
      total:  sql<number>`COALESCE(SUM(total), 0)::float`,
    }).from(storeOrdersTable)
      .where(and(eq(storeOrdersTable.companyId, cid), eq(storeOrdersTable.storeId, sid)))
      .groupBy(storeOrdersTable.paymentMethod);

    let aiInsights: string[] = [];
    if (top.length) {
      const ai = await callAI([
        { role: "system", content: "أنت محلل مبيعات لمتاجر إلكترونية سعودية. أعد JSON بصيغة { insights: string[] } يحتوي 3-5 رؤى عملية موجزة بالعربية." },
        { role: "user", content: `بيانات أعلى المنتجات: ${JSON.stringify(top.slice(0, 5))}\nبيانات اتجاه آخر 30 يوم: ${JSON.stringify(trendRows.slice(-14))}` },
      ]);
      aiInsights = Array.isArray(ai?.insights) ? ai.insights.slice(0, 5).map((s: any) => String(s)) : [];
    }
    if (!aiInsights.length) {
      aiInsights = top.length
        ? [`أعلى منتج مبيعاً: ${top[0].name} بإيراد ${Number(top[0].revenue).toFixed(2)} ر.س.`,
           `إجمالي الطلبات في آخر 30 يوم: ${trendRows.reduce((a: number, r: any) => a + Number(r.orders || 0), 0)}`]
        : ["لا يوجد بيانات مبيعات كافية بعد. ابدأ بإضافة منتجات وتفعيل بوابات الدفع."];
    }
    await logAiUsage(req, { status: "allowed", provider: isAIAvailable() ? "ai" : "rule", durationMs: Date.now() - startedAt });
    res.json({ topProducts: top, trend: trendRows, payments: pay, insights: aiInsights, source: isAIAvailable() ? "ai" : "rule" });
  } catch (e: any) {
    await logAiUsage(req, { status: "error", durationMs: Date.now() - startedAt, meta: { error: String(e?.message || e) } });
    res.status(500).json({ error: e.message });
  }
});

// ─── Recommended products to publish: items with stock not yet in store ──
router.get("/stores/:id/recommend-products", requireAiFeature("online_store_ai"), async (req, res) => {
  const startedAt = Date.now();
  try {
    const cid = getCid(req, res); if (!cid) return;
    const sid = Number(req.params.id);
    const linked = await db.select({ id: storeProductsTable.productId }).from(storeProductsTable)
      .where(and(eq(storeProductsTable.companyId, cid), eq(storeProductsTable.storeId, sid)));
    const linkedSet = new Set(linked.map(l => l.id));
    const all = await db.select().from(itemsTable).where(eq(itemsTable.companyId, cid)).limit(500);
    const candidates = all.filter(i => !linkedSet.has(i.id) && i.status === "active").slice(0, 50);

    let ranked: Array<{ id: number; nameAr: string; nameEn?: string | null; salePrice: string; reason: string; score: number }> = [];
    if (candidates.length && isAIAvailable()) {
      const ai = await callAI([
        { role: "system", content: "أنت مستشار تجارة إلكترونية. اختر أفضل 8 منتجات لإضافتها لمتجر إلكتروني مع سبب موجز لكل واحد. أعد JSON: { picks: [{ id, reason, score (0-100) }] }" },
        { role: "user", content: `المنتجات المرشحة:\n${JSON.stringify(candidates.slice(0, 30).map(i => ({ id: i.id, nameAr: i.nameAr, salePrice: i.salePrice, costPrice: i.costPrice })))}` },
      ]);
      const picks: any[] = Array.isArray(ai?.picks) ? ai.picks : [];
      const byId = Object.fromEntries(candidates.map(c => [c.id, c]));
      ranked = picks.filter(p => byId[Number(p.id)]).map(p => {
        const it = byId[Number(p.id)];
        return { id: it.id, nameAr: it.nameAr, nameEn: it.nameEn, salePrice: String(it.salePrice), reason: String(p.reason || ""), score: Number(p.score) || 50 };
      }).slice(0, 8);
    }
    if (!ranked.length) {
      ranked = candidates.slice(0, 8).map((it, i) => ({
        id: it.id, nameAr: it.nameAr, nameEn: it.nameEn, salePrice: String(it.salePrice),
        reason: "منتج نشط لم يُنشر بعد على المتجر",
        score: 80 - i * 5,
      }));
    }
    await logAiUsage(req, { status: "allowed", provider: isAIAvailable() ? "ai" : "rule", durationMs: Date.now() - startedAt });
    res.json({ recommendations: ranked, source: isAIAvailable() ? "ai" : "rule" });
  } catch (e: any) {
    await logAiUsage(req, { status: "error", durationMs: Date.now() - startedAt, meta: { error: String(e?.message || e) } });
    res.status(500).json({ error: e.message });
  }
});

// ─── Low stock alerts based on order velocity ────────────────────────────
router.get("/stores/:id/low-stock", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const sid = Number(req.params.id);
    const sold = await db.execute(sql`
      SELECT i.product_id AS pid, SUM(i.qty)::float AS sold30
        FROM store_order_items i
        JOIN store_orders o ON o.id = i.order_id
       WHERE o.company_id = ${cid} AND o.store_id = ${sid}
         AND o.status IN ('confirmed','shipped','delivered')
         AND o.created_at >= NOW() - INTERVAL '30 days'
       GROUP BY i.product_id
    `);
    const soldRows: any[] = (sold as any).rows ?? [];
    const soldMap: Record<number, number> = {};
    for (const r of soldRows) if (r.pid) soldMap[Number(r.pid)] = Number(r.sold30 || 0);
    const products = await db.select({
      id: storeProductsTable.id, productId: storeProductsTable.productId,
      itemNameAr: itemsTable.nameAr, reorderLevel: itemsTable.reorderLevel,
    }).from(storeProductsTable)
      .leftJoin(itemsTable, eq(itemsTable.id, storeProductsTable.productId))
      .where(and(eq(storeProductsTable.companyId, cid), eq(storeProductsTable.storeId, sid)));
    const alerts = products.map(p => {
      const sold = soldMap[p.productId] || 0;
      const dailyRate = sold / 30;
      const reorder = Number(p.reorderLevel || 0);
      const projectedDaysLeft = dailyRate > 0 ? Math.round(reorder / dailyRate) : 999;
      let severity: "ok" | "warn" | "critical" = "ok";
      if (dailyRate > 0 && projectedDaysLeft < 7) severity = "critical";
      else if (dailyRate > 0 && projectedDaysLeft < 14) severity = "warn";
      return {
        productId: p.productId, name: p.itemNameAr ?? `#${p.productId}`,
        sold30: sold, dailyRate: +dailyRate.toFixed(2), reorderLevel: reorder,
        projectedDaysLeft, severity,
      };
    }).filter(a => a.severity !== "ok").sort((a, b) => a.projectedDaysLeft - b.projectedDaysLeft);
    res.json({ alerts });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── AI product description generator ────────────────────────────────────
router.post("/generate-description", requireAiFeature("product_descriptions"), async (req, res) => {
  const startedAt = Date.now();
  try {
    const cid = getCid(req, res); if (!cid) return;
    const { productId, tone } = req.body || {};
    const [item] = await db.select().from(itemsTable)
      .where(and(eq(itemsTable.id, Number(productId)), eq(itemsTable.companyId, cid))).limit(1);
    if (!item) { res.status(404).json({ error: "المنتج غير موجود" }); return; }
    const ai = await callAI([
      { role: "system", content: "اكتب وصفاً تسويقياً جذاباً لمنتج بمتجر إلكتروني سعودي. أعد JSON: { ar: string, en: string } كل واحد بين 50 و120 كلمة." },
      { role: "user", content: `اسم المنتج: ${item.nameAr} ${item.nameEn ? `(${item.nameEn})` : ""}\nالكود: ${item.code}\nالسعر: ${item.salePrice} ر.س\nالنبرة المطلوبة: ${tone || "احترافية وموجزة"}` },
    ]);
    if (!ai) {
      await logAiUsage(req, { status: "allowed", provider: "rule", durationMs: Date.now() - startedAt });
      res.json({
        ar: `${item.nameAr} — منتج مميز بسعر ${item.salePrice} ر.س. اطلبه الآن واستمتع بتجربة شراء مريحة.`,
        en: `${item.nameEn ?? item.nameAr} — premium product. Order now and enjoy a smooth shopping experience.`,
        source: "rule",
      });
      return;
    }
    await logAiUsage(req, { status: "allowed", provider: "ai", durationMs: Date.now() - startedAt });
    res.json({ ar: String(ai.ar || ""), en: String(ai.en || ""), source: "ai" });
  } catch (e: any) {
    await logAiUsage(req, { status: "error", durationMs: Date.now() - startedAt, meta: { error: String(e?.message || e) } });
    res.status(500).json({ error: e.message });
  }
});

export default router;
