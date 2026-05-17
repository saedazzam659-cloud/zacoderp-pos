// ─────────────────────────────────────────────────────────────────────────
// Accounting standards AI — RAG-lite assistant grounded in the seeded
// IFRS / GAAP / ZATCA knowledge base. Three endpoints:
//
//   GET  /accounting-ai/standards            — list + filter
//   GET  /accounting-ai/standards/:id        — full entry
//   POST /accounting-ai/ask                  — natural-language Q + answer
//
// The ask endpoint retrieves the top-N most relevant entries by keyword/
// tag match, then prompts the LLM with them as authoritative context. The
// answer ALWAYS includes citation chips so the user can verify and read
// the original standard text.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { extractAuth } from "../middleware/auth.js";
import { chat as aiChat } from "../lib/aiClient.js";

const router = Router();
router.use(extractAuth);

// ─── GET /standards ───────────────────────────────────────────────────────
router.get("/standards", async (req, res) => {
  try {
    const standard = String(req.query.standard || "").slice(0, 16);
    const tag      = String(req.query.tag || "").slice(0, 60);
    const q        = String(req.query.q || "").trim().slice(0, 200);

    const conds: any[] = [];
    if (standard && ["ifrs", "gaap", "zatca"].includes(standard)) {
      conds.push(sql`standard = ${standard}`);
    }
    if (tag) {
      conds.push(sql`tags ? ${tag}`);
    }
    if (q) {
      const pat = `%${q}%`;
      conds.push(sql`(code ILIKE ${pat} OR title_ar ILIKE ${pat} OR title_en ILIKE ${pat} OR summary_ar ILIKE ${pat})`);
    }
    const where = conds.length
      ? conds.reduce<any>((acc, c, i) => i === 0 ? sql`WHERE ${c}` : sql`${acc} AND ${c}`, sql``)
      : sql``;

    const r: any = await db.execute(sql`
      SELECT id, standard, code, title_ar, title_en, summary_ar, summary_en, tags
        FROM accounting_standards_kb
        ${where}
       ORDER BY standard, code
    `);
    res.json({ entries: r.rows ?? [] });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

// ─── GET /standards/:id ───────────────────────────────────────────────────
router.get("/standards/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "id required" }); return; }
  try {
    const r: any = await db.execute(sql`SELECT * FROM accounting_standards_kb WHERE id = ${id}`);
    const row = r.rows?.[0];
    if (!row) { res.status(404).json({ error: "not found" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

// ─── POST /ask ────────────────────────────────────────────────────────────
const askSchema = z.object({
  question: z.string().min(3).max(2000),
  standard: z.enum(["ifrs", "gaap", "zatca"]).optional(),
  locale:   z.enum(["ar", "en"]).optional().default("ar"),
});

interface StdHit {
  id: number;
  code: string;
  standard: string;
  titleAr: string;
  summaryAr: string;
  fullTextAr: string;
  score: number;
}

async function retrieveStandards(question: string, scope?: string): Promise<StdHit[]> {
  const tokens = Array.from(new Set(
    question.toLowerCase()
      .replace(/[^\u0600-\u06FFa-z0-9\s]/gi, " ")
      .split(/\s+/)
      .filter(t => t.length >= 2),
  )).slice(0, 12);
  if (tokens.length === 0) return [];

  const orClauses = tokens.map(t => sql`(title_ar ILIKE ${'%' + t + '%'} OR title_en ILIKE ${'%' + t + '%'} OR summary_ar ILIKE ${'%' + t + '%'} OR full_text_ar ILIKE ${'%' + t + '%'} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) tg WHERE tg ILIKE ${'%' + t + '%'}))`);
  const matchAny = orClauses.reduce<any>((acc, c, i) => i === 0 ? c : sql`${acc} OR ${c}`, sql``);

  const scoreParts = tokens.map(t => sql`
    (CASE WHEN title_ar    ILIKE ${'%' + t + '%'} THEN 5 ELSE 0 END) +
    (CASE WHEN title_en    ILIKE ${'%' + t + '%'} THEN 4 ELSE 0 END) +
    (CASE WHEN summary_ar  ILIKE ${'%' + t + '%'} THEN 3 ELSE 0 END) +
    (CASE WHEN full_text_ar ILIKE ${'%' + t + '%'} THEN 1 ELSE 0 END) +
    (CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) tg WHERE tg ILIKE ${'%' + t + '%'}) THEN 4 ELSE 0 END)
  `);
  const scoreExpr = scoreParts.reduce<any>((acc, p, i) => i === 0 ? p : sql`${acc} + ${p}`, sql``);

  const scopeClause = scope ? sql` AND standard = ${scope}` : sql``;

  const r: any = await db.execute(sql`
    SELECT id, code, standard, title_ar, summary_ar, full_text_ar,
           (${scoreExpr}) AS score
      FROM accounting_standards_kb
     WHERE (${matchAny}) ${scopeClause}
     ORDER BY score DESC
     LIMIT 4
  `);

  return (r.rows ?? []).map((row: any) => ({
    id: row.id, code: row.code, standard: row.standard,
    titleAr: row.title_ar, summaryAr: row.summary_ar, fullTextAr: row.full_text_ar,
    score: Number(row.score) || 0,
  }));
}

router.post("/ask", async (req, res) => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "input invalid", details: parsed.error.flatten() }); return; }
  const { question, standard, locale } = parsed.data;

  try {
    const hits = await retrieveStandards(question, standard);

    const sys = locale === "en"
      ? "You are an accounting advisor explaining IFRS, US GAAP, and Saudi ZATCA rules. Ground your answer in the provided standard excerpts only. Be precise, cite the standard codes you used in [brackets], and end with a one-line disclaimer that this is informational, not legal/tax advice."
      : "أنت مستشار محاسبي تشرح معايير IFRS وUS GAAP ولوائح زاتكا. ابنِ إجابتك على المقتطفات المعيارية المُرفقة فقط، واذكر الأكواد المعيارية التي استخدمتها بين [أقواس مربعة]. أنهِ الإجابة بسطر تنويه: (هذه إجابة استرشادية وليست استشارة قانونية أو ضريبية).";

    const context = hits.length
      ? hits.map(h => `[${h.code}] ${h.titleAr}\nملخص: ${h.summaryAr}\nالتفصيل: ${h.fullTextAr}`).join("\n\n──\n\n")
      : "(لم يُعثَر على معايير مطابقة في القاعدة المعرفية المحلية)";

    const userMsg = `سؤال المحاسب:\n${question}\n\nمقتطفات المعايير ذات الصلة:\n${context}`;

    const ai = await aiChat([
      { role: "system", content: sys },
      { role: "user", content: userMsg },
    ], { maxTokens: 900 });

    const citations = hits.map(h => ({ id: h.id, code: h.code, standard: h.standard, title: h.titleAr }));

    if (ai.ok) {
      res.json({ answer: ai.text.trim(), source: "ai", provider: ai.provider, citations });
      return;
    }

    // Fallback: stitch the top-1 hit's summary into a deterministic answer.
    if (hits.length > 0) {
      const top = hits[0];
      res.json({
        answer:  `بناءً على [${top.code}] — ${top.titleAr}:\n\n${top.summaryAr}\n\n(الإجابة من قاعدة المعرفة المحاسبية لأن الذكاء الاصطناعي غير متاح حالياً. هذه إجابة استرشادية وليست استشارة قانونية أو ضريبية.)`,
        source: "kb",
        citations,
      });
      return;
    }

    res.json({
      answer: "لم أعثر على معيار مطابق في قاعدة المعرفة، وخادم الذكاء الاصطناعي غير متاح حالياً. حاول إعادة صياغة السؤال أو حدّد المعيار (IFRS / GAAP / ZATCA).",
      source: "none",
      citations: [],
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "accounting-ai failed" });
  }
});

export default router;
