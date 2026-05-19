// ─────────────────────────────────────────────────────────────────────────
// Support assistant — free in-app help powered by:
//   1. A curated bilingual knowledge base (support_knowledge_base table)
//   2. The unified AI client (`aiClient.chat`) for synthesis
//
// Flow:
//   POST /support-ai/ask   { question, pagePath?, locale? }
//      → keyword-search KB for top 3 candidates
//      → page-hint boosts entries relevant to the caller's current screen
//      → send {question, KB snippets, page path} to AI for a friendly answer
//      → if AI offline, return the highest-scoring KB row verbatim (so the
//        assistant always says SOMETHING useful — never just "AI offline")
//
// All endpoints are public auth-gated (extractAuth) but not company-scoped,
// because the KB is global. We tag the response with the active page to
// help client-side analytics later.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { extractAuth } from "../middleware/auth.js";
import { chat as aiChat } from "../lib/aiClient.js";
import { requireAiFeature, logAiUsage } from "../middleware/requireAiFeature.js";

const router = Router();
router.use(extractAuth);

const askSchema = z.object({
  question: z.string().min(2).max(2000),
  pagePath: z.string().max(200).optional(),
  locale:   z.enum(["ar", "en"]).optional().default("ar"),
});

interface KBHit {
  id: number;
  slug: string;
  category: string;
  questionAr: string;
  answerAr: string;
  questionEn: string | null;
  answerEn:   string | null;
  pageHints:  string[];
  score:      number;
}

// Plain keyword search:
//   • Word matches in question/answer text → +3 each
//   • Match inside the `keywords` JSONB array → +5 each (stronger signal)
//   • Page-hint prefix overlap with the caller's pagePath → +4
//
// Postgres-native scoring keeps us off any embeddings dependency.
async function retrieveCandidates(question: string, pagePath?: string): Promise<KBHit[]> {
  // Tokenise; keep tokens length ≥ 2 to avoid useless 1-char joins.
  const tokens = Array.from(
    new Set(
      question
        .toLowerCase()
        .replace(/[^\u0600-\u06FFa-z0-9\s]/gi, " ")
        .split(/\s+/)
        .filter(t => t.length >= 2),
    ),
  ).slice(0, 12);
  if (tokens.length === 0) return [];

  // ILIKE pattern per token; Postgres builds a fast scan over the table
  // (which is tiny — <100 rows). For each row we sum 3 per text hit + 5
  // per keyword hit. Page-hint boost is added in JS afterwards.
  const orClauses = tokens.map(t => sql`(question_ar ILIKE ${'%' + t + '%'} OR answer_ar ILIKE ${'%' + t + '%'} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(keywords) k WHERE k ILIKE ${'%' + t + '%'}))`);
  const matchAny = orClauses.reduce<any>((acc, c, i) => i === 0 ? c : sql`${acc} OR ${c}`, sql``);

  // Build the score expression dynamically per token.
  const scoreParts = tokens.map(
    t => sql`(CASE WHEN question_ar ILIKE ${'%' + t + '%'} THEN 3 ELSE 0 END) +
             (CASE WHEN answer_ar   ILIKE ${'%' + t + '%'} THEN 3 ELSE 0 END) +
             (CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(keywords) k WHERE k ILIKE ${'%' + t + '%'}) THEN 5 ELSE 0 END)`,
  );
  const scoreExpr = scoreParts.reduce<any>((acc, p, i) => i === 0 ? p : sql`${acc} + ${p}`, sql``);

  const r: any = await db.execute(sql`
    SELECT id, slug, category, question_ar, answer_ar, question_en, answer_en, page_hints,
           (${scoreExpr}) AS score
      FROM support_knowledge_base
     WHERE ${matchAny}
     ORDER BY score DESC
     LIMIT 8
  `);

  const rows: KBHit[] = (r.rows ?? []).map((row: any) => ({
    id:         row.id,
    slug:       row.slug,
    category:   row.category,
    questionAr: row.question_ar,
    answerAr:   row.answer_ar,
    questionEn: row.question_en,
    answerEn:   row.answer_en,
    pageHints:  Array.isArray(row.page_hints) ? row.page_hints : [],
    score:      Number(row.score) || 0,
  }));

  // Page-hint boost: if any hint is a prefix of the current page, +4.
  if (pagePath) {
    for (const h of rows) {
      if (h.pageHints.some(p => pagePath.startsWith(p))) h.score += 4;
    }
    rows.sort((a, b) => b.score - a.score);
  }

  return rows.slice(0, 3);
}

router.post("/ask", requireAiFeature("support_ai"), async (req, res) => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "input invalid", details: parsed.error.flatten() }); return; }
  const { question, pagePath, locale } = parsed.data;
  const startedAt = Date.now();

  try {
    const candidates = await retrieveCandidates(question, pagePath);

    // Build the AI prompt. We pass the candidate rows as CONTEXT and force
    // the model to either ground its answer in them or politely say it
    // doesn't know — this prevents hallucinated "feature exists" answers.
    const sys = locale === "en"
      ? "You are a support assistant for the Zacoderp ZATCA ERP. Answer briefly and clearly in English using ONLY the provided knowledge entries. If the answer is not in the context, say so honestly and suggest contacting human support. Mention relevant page paths in backticks when the entry hints at them."
      : "أنت مساعد دعم لنظام زاكود ERP الخاص بالفوترة الإلكترونية السعودية. أجب بإيجاز ووضوح بالعربية مستنداً فقط إلى مقاطع المعرفة المرفقة. لو الإجابة غير موجودة، صرّح بذلك واقترح التواصل مع الدعم البشري. اذكر مسارات الصفحات بين علامتي ` ` لو كانت موجودة في المقاطع.";

    const context = candidates.length
      ? candidates.map((c, i) =>
          `[${i + 1}] (${c.category}) ${c.questionAr}\n${c.answerAr}`,
        ).join("\n\n")
      : "(لا توجد مقاطع مطابقة في قاعدة المعرفة)";

    const userMsg = `الصفحة الحالية: ${pagePath || "غير معروف"}\n\nسؤال المستخدم:\n${question}\n\nمقاطع من قاعدة المعرفة:\n${context}`;

    const ai = await aiChat([
      { role: "system", content: sys },
      { role: "user", content: userMsg },
    ], { maxTokens: 600 });

    if (ai.ok) {
      await logAiUsage(req, { status: "allowed", provider: ai.provider, durationMs: Date.now() - startedAt });
      res.json({
        answer:   ai.text.trim(),
        source:   "ai",
        provider: ai.provider,
        citations: candidates.map(c => ({ id: c.id, slug: c.slug, title: c.questionAr })),
      });
      return;
    }

    // Rule fallback — always return SOMETHING. If there's no KB hit at
    // all, fall back to a generic "contact support" message.
    if (candidates.length > 0) {
      const top = candidates[0];
      await logAiUsage(req, { status: "allowed", provider: "kb", durationMs: Date.now() - startedAt });
      res.json({
        answer:  `${top.answerAr}\n\n(الإجابة من قاعدة المعرفة لأن خادم الذكاء الاصطناعي غير متاح حالياً.)`,
        source:  "kb",
        citations: [{ id: top.id, slug: top.slug, title: top.questionAr }],
      });
      return;
    }

    await logAiUsage(req, { status: "allowed", provider: "none", durationMs: Date.now() - startedAt });
    res.json({
      answer:  "لم أجد إجابة مطابقة في قاعدة المعرفة، وخادم الذكاء الاصطناعي غير متاح حالياً. جرّب صياغة أخرى أو تواصل مع الدعم الفني.",
      source:  "none",
      citations: [],
    });
  } catch (e: any) {
    await logAiUsage(req, { status: "error", durationMs: Date.now() - startedAt, meta: { error: String(e?.message || e) } });
    res.status(500).json({ error: e?.message || "support-ai failed" });
  }
});

// ─── Browse endpoints (optional UI later) ─────────────────────────────────
router.get("/topics", async (_req, res) => {
  try {
    const r: any = await db.execute(sql`
      SELECT category, COUNT(*)::int AS n
        FROM support_knowledge_base
       GROUP BY category ORDER BY n DESC
    `);
    res.json({ topics: r.rows ?? [] });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.get("/entries", async (req, res) => {
  try {
    const category = String(req.query.category || "").slice(0, 60);
    const r: any = await db.execute(category
      ? sql`SELECT id, slug, category, question_ar, answer_ar FROM support_knowledge_base WHERE category = ${category} ORDER BY id`
      : sql`SELECT id, slug, category, question_ar, answer_ar FROM support_knowledge_base ORDER BY category, id`,
    );
    res.json({ entries: r.rows ?? [] });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

// Thumbs-up / thumbs-down on a KB entry that the assistant cited — used
// later to surface low-quality entries for human curation.
router.post("/feedback", async (req, res) => {
  const id = Number(req.body?.id);
  const helpful = req.body?.helpful === true;
  if (!Number.isFinite(id)) { res.status(400).json({ error: "id required" }); return; }
  try {
    await db.execute(helpful
      ? sql`UPDATE support_knowledge_base SET helpful_count = helpful_count + 1, updated_at = NOW() WHERE id = ${id}`
      : sql`UPDATE support_knowledge_base SET not_helpful_count = not_helpful_count + 1, updated_at = NOW() WHERE id = ${id}`,
    );
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

export default router;
