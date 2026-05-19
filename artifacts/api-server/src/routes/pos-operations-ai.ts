// ─────────────────────────────────────────────────────────────────────────
// POS Operations AI — anomaly detection & insights for POS sales/returns.
// Falls back to deterministic rule-based summaries when the AI proxy isn't
// configured.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId, getAllowedBranchIds } from "../middleware/auth.js";
import { requireModulePermission } from "../middleware/permissions.js";
import { requireAiFeature, logAiUsage } from "../middleware/requireAiFeature.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("pos"));

import { chat as aiChat } from "../lib/aiClient.js";

function getCid(req: any, res: any): number | null {
  const raw = req.query.companyId ?? req.body?.companyId;
  const cid = resolveCompanyId(req, raw ?? req.authUser?.companyId);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// Always JSON mode here — every caller in this file structures its
// system prompt to demand a JSON object back. Provider failover is
// transparent via the unified aiClient.
async function callAI(messages: any[]): Promise<any | null> {
  const r = await aiChat(messages, { json: true, maxTokens: 4096 });
  if (!r.ok) return null;
  return r.data ?? null;
}

// ─── GET /pos-operations-ai/insights ─────────────────────────────────────
// Pulls aggregate POS sales for the last 30 days and asks the AI for
// 4–7 short, actionable insights + anomaly flags. Always returns something
// usable even when the AI isn't available.
router.get("/insights", requireAiFeature("pos_ai"), async (req, res) => {
  const startedAt = Date.now();
  try {
    const cid = getCid(req, res); if (!cid) return;

    // Per-user branch scope — branch-restricted users get analytics for
    // their branches only, never the whole company.
    const allowed = getAllowedBranchIds(req);
    const invBranchSql = allowed === null
      ? sql`TRUE`
      : allowed.length === 0
        ? sql`FALSE`
        : sql`i.branch_id IN (${sql.join(allowed.map(b => sql`${b}`), sql`, `)})`;
    const retBranchSql = allowed === null
      ? sql`TRUE`
      : allowed.length === 0
        ? sql`FALSE`
        : sql`r.branch_id IN (${sql.join(allowed.map(b => sql`${b}`), sql`, `)})`;
    const flatBranchSql = allowed === null
      ? sql`TRUE`
      : allowed.length === 0
        ? sql`FALSE`
        : sql`branch_id IN (${sql.join(allowed.map(b => sql`${b}`), sql`, `)})`;

    // Daily revenue + invoice count for trending.
    const trend = (await db.execute<any>(sql`
      SELECT invoice_date AS day,
             COUNT(*)::int AS invoices,
             COALESCE(SUM(total_amount), 0)::float AS revenue,
             COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts
        FROM sales_invoices
       WHERE company_id = ${cid}
         AND pos_session_id IS NOT NULL
         AND ${flatBranchSql}
         AND invoice_date::date >= (CURRENT_DATE - INTERVAL '30 days')
       GROUP BY invoice_date ORDER BY invoice_date
    `) as any).rows ?? [];

    // Top cashiers by revenue (joins through pos_sessions to users).
    const topCashiers = (await db.execute<any>(sql`
      SELECT u.id, u.username, u.name_ar AS "nameAr", u.name_en AS "nameEn",
             COUNT(i.*)::int AS invoices,
             COALESCE(SUM(i.total_amount), 0)::float AS revenue
        FROM sales_invoices i
        JOIN pos_sessions s ON s.id = i.pos_session_id
        JOIN users u        ON u.id = s.user_id
       WHERE i.company_id = ${cid}
         AND i.pos_session_id IS NOT NULL
         AND ${invBranchSql}
         AND i.invoice_date::date >= (CURRENT_DATE - INTERVAL '30 days')
       GROUP BY u.id, u.username, u.name_ar, u.name_en
       ORDER BY revenue DESC
       LIMIT 5
    `) as any).rows ?? [];

    // High-value invoices (top 1% by amount) — potential anomalies.
    const bigTickets = (await db.execute<any>(sql`
      SELECT i.id, i.doc_number AS "docNumber", i.invoice_date AS "invoiceDate",
             i.total_amount::float AS amount, i.status,
             u.username AS cashier
        FROM sales_invoices i
        LEFT JOIN pos_sessions s ON s.id = i.pos_session_id
        LEFT JOIN users u        ON u.id = s.user_id
       WHERE i.company_id = ${cid}
         AND i.pos_session_id IS NOT NULL
         AND ${invBranchSql}
         AND i.invoice_date::date >= (CURRENT_DATE - INTERVAL '30 days')
       ORDER BY i.total_amount DESC
       LIMIT 5
    `) as any).rows ?? [];

    // Returns ratio per cashier — high ratios may indicate fraud / training.
    const returnRatio = (await db.execute<any>(sql`
      WITH inv AS (
        SELECT s.user_id, COUNT(*)::int AS invoices,
               COALESCE(SUM(i.total_amount), 0)::float AS sales
          FROM sales_invoices i
          JOIN pos_sessions s ON s.id = i.pos_session_id
         WHERE i.company_id = ${cid}
           AND ${invBranchSql}
           AND i.invoice_date::date >= (CURRENT_DATE - INTERVAL '30 days')
         GROUP BY s.user_id
      ), ret AS (
        SELECT s.user_id, COUNT(*)::int AS returns,
               COALESCE(SUM(r.total_amount), 0)::float AS refunded
          FROM sales_returns r
          JOIN sales_invoices i ON i.id = r.invoice_id
          JOIN pos_sessions s   ON s.id = i.pos_session_id
         WHERE r.company_id = ${cid}
           AND ${retBranchSql}
           AND r.return_date::date >= (CURRENT_DATE - INTERVAL '30 days')
         GROUP BY s.user_id
      )
      SELECT u.username, u.name_ar AS "nameAr",
             inv.invoices, inv.sales,
             COALESCE(ret.returns, 0) AS returns,
             COALESCE(ret.refunded, 0) AS refunded,
             CASE WHEN inv.sales > 0
                  THEN ROUND(((COALESCE(ret.refunded, 0) / inv.sales) * 100)::numeric, 2)::float
                  ELSE 0 END AS "returnRatePct"
        FROM inv
        JOIN users u ON u.id = inv.user_id
        LEFT JOIN ret ON ret.user_id = inv.user_id
       ORDER BY "returnRatePct" DESC
       LIMIT 5
    `) as any).rows ?? [];

    // Drafts older than 24h — these are unposted invoices that need attention.
    const [{ stale_drafts: staleDrafts } = { stale_drafts: 0 }] = (await db.execute<any>(sql`
      SELECT COUNT(*)::int AS stale_drafts
        FROM sales_invoices
       WHERE company_id = ${cid}
         AND pos_session_id IS NOT NULL
         AND ${flatBranchSql}
         AND status = 'draft'
         AND created_at < NOW() - INTERVAL '24 hours'
    `) as any).rows ?? [];

    let insights: string[] = [];
    let anomalies: Array<{ severity: "high" | "medium" | "low"; title: string; description: string }> = [];
    let aiSucceeded = false;
    if (trend.length || topCashiers.length) {
      const ai = await callAI([
        { role: "system", content: "أنت مدقق عمليات نقاط بيع لشركة سعودية. حلّل البيانات وأعد JSON بالشكل: { insights: string[] (3–6 رؤى عملية موجزة بالعربية)، anomalies: [{ severity: 'high'|'medium'|'low', title: string, description: string }] (0–4 تحذيرات أو ملاحظات شذوذ بالعربية) }. ركّز على: نسب المرتجعات المرتفعة، فواتير غير مرحّلة قديمة، تركّز المبيعات على كاشير واحد، ذروة/هبوط في يوم معين، فواتير ذات قيمة استثنائية." },
        { role: "user", content: JSON.stringify({
          trendLast30Days: trend.slice(-30),
          topCashiers,
          highValueInvoices: bigTickets,
          returnRatioByCashier: returnRatio,
          staleDrafts,
        })},
      ]);
      if (Array.isArray(ai?.insights)) {
        insights = ai.insights.slice(0, 6).map((s: any) => String(s));
        if (insights.length) aiSucceeded = true;
      }
      if (Array.isArray(ai?.anomalies)) anomalies = ai.anomalies.slice(0, 4).map((a: any) => ({
        severity: (a?.severity === "high" || a?.severity === "low") ? a.severity : "medium",
        title: String(a?.title ?? ""), description: String(a?.description ?? ""),
      })).filter((a: any) => a.title);
    }
    if (!insights.length) {
      const totalRev = trend.reduce((s: number, r: any) => s + Number(r.revenue || 0), 0);
      const totalInv = trend.reduce((s: number, r: any) => s + Number(r.invoices || 0), 0);
      insights = [
        `إجمالي مبيعات نقاط البيع آخر 30 يوم: ${totalRev.toFixed(2)} ر.س موزعة على ${totalInv} فاتورة.`,
        topCashiers[0]
          ? `أعلى كاشير مبيعاً: ${topCashiers[0].nameAr || topCashiers[0].username} بإجمالي ${Number(topCashiers[0].revenue).toFixed(2)} ر.س.`
          : "لا توجد بيانات كاشير كافية بعد.",
        staleDrafts > 0
          ? `يوجد ${staleDrafts} فاتورة مسودة قديمة (أكثر من 24 ساعة) — راجعها وقم بالترحيل أو الحذف.`
          : "لا توجد فواتير مسودة متأخرة — العمليات نظيفة.",
      ];
    }
    if (!anomalies.length) {
      const hot = returnRatio.find((r: any) => Number(r.returnRatePct) >= 15);
      if (hot) anomalies.push({
        severity: "medium",
        title: `نسبة مرتجع مرتفعة لـ ${hot.nameAr || hot.username}`,
        description: `${hot.returnRatePct}% من مبيعاته خلال آخر 30 يوم تحوّلت إلى مرتجعات. ينصح بالتدقيق.`,
      });
      if (staleDrafts >= 5) anomalies.push({
        severity: "high",
        title: "تراكم فواتير مسودة",
        description: `${staleDrafts} فاتورة مسودة لم تُرحَّل منذ أكثر من 24 ساعة.`,
      });
    }

    await logAiUsage(req, { status: "allowed", provider: aiSucceeded ? "ai" : "rule", durationMs: Date.now() - startedAt });
    res.json({
      trend, topCashiers, bigTickets, returnRatio, staleDrafts,
      insights, anomalies, source: aiSucceeded ? "ai" : "rule",
    });
  } catch (e: any) {
    await logAiUsage(req, { status: "error", durationMs: Date.now() - startedAt, meta: { error: String(e?.message || e) } });
    res.status(500).json({ error: e.message });
  }
});

export default router;
