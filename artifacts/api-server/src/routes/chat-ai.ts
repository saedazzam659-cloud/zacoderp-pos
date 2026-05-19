// ─────────────────────────────────────────────────────────────────────────
// Chat AI — six features over the chat module:
//   POST /chat-ai/summarize         — TL;DR of a long conversation
//   POST /chat-ai/suggest-replies   — 3 short reply suggestions
//   POST /chat-ai/translate         — Arabic ↔ English
//   POST /chat-ai/extract-tasks     — pulls action items / decisions
//   POST /chat-ai/transcribe        — voice → text (audio URL passthrough)
//   GET  /chat-ai/search            — semantic-ish keyword search across
//                                     the user's conversations
// All endpoints respect the same multi-tenant + participant invariants
// as routes/chat.ts and return rule-based fallbacks when the AI proxy
// isn't available.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  chatConversationsTable, chatParticipantsTable, chatMessagesTable,
  usersTable,
} from "@workspace/db";
import { and, eq, sql, desc, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requireModulePermission } from "../middleware/permissions.js";
import { requireAiFeature, logAiUsage } from "../middleware/requireAiFeature.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("chat"));

import { chat as aiChat } from "../lib/aiClient.js";

function getCid(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.query.companyId ?? req.body?.companyId ?? req.authUser?.companyId);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

async function ensureParticipant(convId: number, cid: number, userId: number): Promise<boolean> {
  const r: any = await db.execute(sql`
    SELECT 1 FROM chat_conversations c
      JOIN chat_participants p ON p.conversation_id = c.id
     WHERE c.id = ${convId} AND c.company_id = ${cid} AND p.user_id = ${userId}
     LIMIT 1
  `);
  return !!(r.rows?.length);
}

// Thin shim over the unified aiClient — keeps the existing call sites
// (and their rule-based fallbacks) untouched while gaining the OpenAI →
// Anthropic provider failover automatically.
async function callAI(messages: any[], opts?: { json?: boolean }): Promise<{ ok: boolean; data?: any; text?: string }> {
  const r = await aiChat(messages, { json: opts?.json });
  if (!r.ok) return { ok: false };
  return { ok: true, text: r.text, data: r.data };
}

// Pulls the last N non-deleted messages of a conversation as plain text.
async function loadTranscript(convId: number, limit = 60): Promise<{ author: string; text: string; createdAt: Date }[]> {
  const rows = await db.select({
    body: chatMessagesTable.body,
    createdAt: chatMessagesTable.createdAt,
    senderUserId: chatMessagesTable.senderUserId,
  }).from(chatMessagesTable)
    .where(and(eq(chatMessagesTable.conversationId, convId), sql`${chatMessagesTable.deletedAt} IS NULL`))
    .orderBy(desc(chatMessagesTable.id))
    .limit(limit);
  rows.reverse();
  const userIds = Array.from(new Set(rows.map(r => r.senderUserId).filter(Boolean) as number[]));
  const users = userIds.length ? await db.select({
    id: usersTable.id, username: usersTable.username,
    nameAr: usersTable.nameAr, nameEn: usersTable.nameEn,
  }).from(usersTable).where(inArray(usersTable.id, userIds)) : [];
  const byId = new Map(users.map(u => [u.id, u]));
  return rows.map(r => ({
    author: r.senderUserId ? (byId.get(r.senderUserId)?.nameAr || byId.get(r.senderUserId)?.username || "?") : "system",
    text: r.body,
    createdAt: r.createdAt as any,
  }));
}

// ─── POST /chat-ai/summarize ─────────────────────────────────────────────
router.post("/summarize", requireAiFeature("chat_assistant"), async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const convId = Number(req.body?.conversationId);
    if (!Number.isFinite(convId)) { res.status(400).json({ error: "معرّف المحادثة مطلوب" }); return; }
    if (!(await ensureParticipant(convId, cid, userId))) { res.status(404).json({ error: "غير موجود" }); return; }

    const transcript = await loadTranscript(convId, 80);
    if (!transcript.length) { res.json({ summary: "لا توجد رسائل بعد.", source: "rule" }); return; }
    const transcriptText = transcript.map(m => `${m.author}: ${m.text}`).join("\n");

    const ai = await callAI([
      { role: "system", content: "أنت مساعد تلخيص محادثات داخل نظام ERP. قدّم ملخصاً موجزاً جداً (5–8 جمل بالعربية) للمحادثة، مع التركيز على المواضيع الأساسية والقرارات المتفق عليها وأي مهام مفتوحة. تجنّب التحية والمجاملات." },
      { role: "user", content: transcriptText.slice(0, 12000) },
    ]);
    if (ai.ok && ai.text) {
      await logAiUsage(req, { status: "allowed", provider: "ai" });
      res.json({ summary: ai.text.trim(), source: "ai" });
      return;
    }
    // Fallback: take the first/last few lines as a heuristic summary.
    const sample = [...transcript.slice(0, 3), ...transcript.slice(-3)].map(m => `• ${m.author}: ${m.text.slice(0, 120)}`).join("\n");
    await logAiUsage(req, { status: "allowed", provider: "rule" });
    res.json({ summary: `ملخص أولي (الذكاء الاصطناعي غير متاح):\n${sample}`, source: "rule" });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /chat-ai/suggest-replies ───────────────────────────────────────
router.post("/suggest-replies", requireAiFeature("chat_assistant"), async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const convId = Number(req.body?.conversationId);
    if (!Number.isFinite(convId)) { res.status(400).json({ error: "معرّف المحادثة مطلوب" }); return; }
    if (!(await ensureParticipant(convId, cid, userId))) { res.status(404).json({ error: "غير موجود" }); return; }
    const transcript = await loadTranscript(convId, 12);
    if (!transcript.length) { res.json({ suggestions: [], source: "rule" }); return; }
    const last = transcript[transcript.length - 1];
    const transcriptText = transcript.map(m => `${m.author}: ${m.text}`).join("\n");

    const ai = await callAI([
      { role: "system", content: "أنت مساعد كتابة ردود قصيرة لمحادثة داخلية في نظام ERP. اقترح 3 ردود قصيرة (كل رد في سطر واحد، لا يزيد عن 12 كلمة، باللغة نفسها التي يستخدمها آخر متحدث). أعد JSON بهذا الشكل: { \"suggestions\": [\"رد 1\", \"رد 2\", \"رد 3\"] }. لا تكرر التحية." },
      { role: "user", content: transcriptText.slice(-3000) },
    ], { json: true });
    let suggestions: string[] = [];
    let usedAi = false;
    if (ai.ok && Array.isArray(ai.data?.suggestions)) {
      suggestions = ai.data.suggestions.slice(0, 3).map((s: any) => String(s).trim()).filter(Boolean);
      usedAi = suggestions.length > 0;
    }
    if (!suggestions.length) {
      // Tiny rule-based fallback. Reflect this honestly in `source`.
      const lower = (last?.text || "").toLowerCase();
      if (/\?|؟/.test(lower))      suggestions = ["نعم، تمام.", "سأرد عليك خلال قليل.", "لا، شكراً."];
      else if (/شكر|thank/.test(lower)) suggestions = ["العفو 🙂", "أي خدمة.", "تحت أمرك."];
      else                          suggestions = ["تمام، شكراً.", "سأطلع على الموضوع.", "نتابع لاحقاً."];
    }
    await logAiUsage(req, { status: "allowed", provider: usedAi ? "ai" : "rule" });
    res.json({ suggestions, source: usedAi ? "ai" : "rule" });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /chat-ai/translate ─────────────────────────────────────────────
const TranslateBody = z.object({
  text: z.string().min(1).max(8000),
  to:   z.enum(["ar", "en"]),
});
router.post("/translate", requireAiFeature("chat_assistant"), async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const parsed = TranslateBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "بيانات غير صحيحة" }); return; }
    const target = parsed.data.to === "ar" ? "Arabic" : "English";
    const ai = await callAI([
      { role: "system", content: `Translate the user message to ${target}. Output ONLY the translated text, no explanation, no quotes.` },
      { role: "user", content: parsed.data.text },
    ]);
    if (ai.ok && ai.text) {
      await logAiUsage(req, { status: "allowed", provider: "ai" });
      res.json({ translation: ai.text.trim(), source: "ai" });
      return;
    }
    // Deterministic fallback so the contract stays { translation, source }
    // even when the AI proxy is unreachable. The client can show a hint
    // when source !== "ai".
    await logAiUsage(req, { status: "allowed", provider: "rule" });
    res.json({
      translation: parsed.data.text,
      source: "rule",
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /chat-ai/extract-tasks ─────────────────────────────────────────
router.post("/extract-tasks", requireAiFeature("chat_assistant"), async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const convId = Number(req.body?.conversationId);
    if (!Number.isFinite(convId)) { res.status(400).json({ error: "معرّف المحادثة مطلوب" }); return; }
    if (!(await ensureParticipant(convId, cid, userId))) { res.status(404).json({ error: "غير موجود" }); return; }
    const transcript = await loadTranscript(convId, 80);
    if (!transcript.length) { res.json({ tasks: [], decisions: [], source: "rule" }); return; }
    const transcriptText = transcript.map(m => `${m.author}: ${m.text}`).join("\n");

    const ai = await callAI([
      { role: "system", content: "استخرج من المحادثة المهام (action items) والقرارات (decisions). أعد JSON: { \"tasks\": [{ \"text\": \"...\", \"owner\": \"اسم الشخص أو null\", \"due\": \"تاريخ نصي إن وُجد أو null\" }], \"decisions\": [\"قرار 1\", ...] }. إذا لم تجد، أعد مصفوفات فارغة. كل المخرجات بالعربية." },
      { role: "user", content: transcriptText.slice(0, 12000) },
    ], { json: true });
    let tasks: any[] = []; let decisions: string[] = [];
    if (ai.ok && ai.data) {
      if (Array.isArray(ai.data.tasks))     tasks     = ai.data.tasks.slice(0, 20).map((t: any) => ({
        text: String(t?.text ?? "").trim(),
        owner: t?.owner ? String(t.owner) : null,
        due:   t?.due ? String(t.due) : null,
      })).filter((t: any) => t.text);
      if (Array.isArray(ai.data.decisions)) decisions = ai.data.decisions.slice(0, 20).map((s: any) => String(s).trim()).filter(Boolean);
    }
    await logAiUsage(req, { status: "allowed", provider: ai.ok ? "ai" : "rule" });
    res.json({ tasks, decisions, source: ai.ok ? "ai" : "rule" });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /chat-ai/transcribe ────────────────────────────────────────────
// Accepts a public/internal audio URL and returns the transcription.
// Phase 1 ships the endpoint contract; full Whisper wiring lands when the
// audio-message UI is built (phase 1.5).
router.post("/transcribe", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const url = String(req.body?.audioUrl || "");
    if (!url) { res.status(400).json({ error: "رابط الملف الصوتي مطلوب" }); return; }
    res.status(503).json({
      error: "تحويل الصوت إلى نص سيُفعَّل مع إطلاق الرسائل الصوتية في المرحلة التالية.",
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /chat-ai/search ─────────────────────────────────────────────────
// Keyword search across all conversations the user participates in.
// Uses ILIKE with simple ranking by recency — fast and good enough for
// the first iteration. A real semantic-search upgrade can plug in later.
router.get("/search", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const userId = req.authUser!.id;
    const q = String(req.query.q || "").trim();
    if (q.length < 2) { res.json({ results: [] }); return; }
    const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
    const r: any = await db.execute(sql`
      SELECT m.id, m.conversation_id AS "conversationId", m.body,
             m.created_at AS "createdAt", m.sender_user_id AS "senderUserId",
             u.username AS "senderUsername",
             c.title AS "conversationTitle", c.kind AS "conversationKind"
        FROM chat_messages m
        JOIN chat_conversations c ON c.id = m.conversation_id
        JOIN chat_participants p  ON p.conversation_id = m.conversation_id AND p.user_id = ${userId}
        LEFT JOIN users u         ON u.id = m.sender_user_id
       WHERE c.company_id = ${cid}
         AND m.deleted_at IS NULL
         AND m.body ILIKE ${like}
       ORDER BY m.created_at DESC
       LIMIT 50
    `);
    res.json({ results: r.rows ?? [] });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
