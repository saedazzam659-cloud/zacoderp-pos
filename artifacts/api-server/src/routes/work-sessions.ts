// Work-sessions router. A "work session" represents one user's login window
// (login → logout). Each session can be enriched on demand with an AI report
// summarising every recorded action that happened during the window.
//
// Endpoints (all scoped to the caller's companyId):
//   GET    /                  — list sessions (paginated, filterable)
//   GET    /summary           — quick stats (active count, today, this month)
//   GET    /:id               — one session, with activity preview
//   POST   /:id/end           — manually end an active session
//   POST   /:id/generate-report — collect activity and ask Anthropic to
//                                summarise it; persists the result.
//
// Permission model:
//   - Admins (role = "admin" / "superadmin") see every user in the company.
//   - Regular users only see (and can act on) their own sessions.
//
// We rely on the existing centralised `audit_log` table as the source of
// truth for "what did the user actually do during this window?" — that table
// already records every authenticated mutation alongside userId/companyId/
// module/action/entityType/entityId/metadata. No separate scrape of every
// financial table is needed; if a future feature is missing from audit_log,
// the fix is to make sure that feature writes through `writeAudit`, not to
// hand-roll another collector here.

import { Router } from "express";
import { db } from "@workspace/db";
import { workSessionsTable, auditLogTable, usersTable } from "@workspace/db";
import { and, eq, desc, gte, lte, ne, count, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import Anthropic from "@anthropic-ai/sdk";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

// Helpers ---------------------------------------------------------------------

function getCid(req: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query?.companyId);
  return cid ?? null;
}

function isAdmin(req: any): boolean {
  const role = req.authUser?.role;
  return role === "admin" || role === "superadmin";
}

// Sensitive-key allowlist for the AI prompt. audit_log.metadata is a free-
// form jsonb that may contain user-influenced strings, and a few of our
// writers stash auth-adjacent values (password reset tokens, support-message
// replies, license keys, etc). Before forwarding metadata to an external
// AI provider, walk the JSON and replace any value whose key matches one of
// these patterns with the literal "[REDACTED]".
// Word-boundary matching to avoid false positives on benign keys like
// "monkey", "passage", "tokenize", "keyword". Common compound forms
// (api_key, access_token, etc.) are still caught because the parts they
// contain are themselves bounded.
const SENSITIVE_KEY_RE = /\b(pass(word|phrase)?|token|access_token|refresh_token|secret|api[_-]?key|secret[_-]?key|public[_-]?key|private[_-]?key|otp|pin|salt|hash|cookie|authorization|bearer|credit[_-]?card|card[_-]?number|cvv|cvc|iban|signature|x[_-]?api[_-]?key|jwt)\b/i;

function redactMetadata(input: unknown, depth = 0): unknown {
  if (input == null || depth > 6) return input;
  if (Array.isArray(input)) return input.map((v) => redactMetadata(v, depth + 1));
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactMetadata(v, depth + 1);
      }
    }
    return out;
  }
  return input;
}

// Format a duration in seconds to "Xh Ym" (Arabic).
function fmtDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h && m) return `${h}س ${m}د`;
  if (h)      return `${h}س`;
  return `${m}د`;
}

// GET / -----------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }

    const limit  = Math.min(200, Math.max(1, Number(req.query.limit  ?? 50)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const status = (req.query.status as string | undefined) ?? null;

    // Non-admins are scoped to their own rows.
    const adminMode = isAdmin(req);
    const userScopeFilter = adminMode
      ? undefined
      : eq(workSessionsTable.userId, (req as any).authUser.id);

    const whereExpr = and(
      eq(workSessionsTable.companyId, cid),
      status ? eq(workSessionsTable.status, status) : undefined,
      userScopeFilter,
    );

    const rows = await db.select().from(workSessionsTable)
      .where(whereExpr)
      .orderBy(desc(workSessionsTable.startedAt))
      .limit(limit).offset(offset);

    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /summary ---------------------------------------------------------------
router.get("/summary", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }

    const adminMode = isAdmin(req);
    const userScopeFilter = adminMode
      ? undefined
      : eq(workSessionsTable.userId, (req as any).authUser.id);

    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

    const [active] = await db.select({ c: count() }).from(workSessionsTable)
      .where(and(
        eq(workSessionsTable.companyId, cid),
        eq(workSessionsTable.status, "active"),
        userScopeFilter,
      ));
    const [today] = await db.select({ c: count() }).from(workSessionsTable)
      .where(and(
        eq(workSessionsTable.companyId, cid),
        gte(workSessionsTable.startedAt, startOfToday),
        userScopeFilter,
      ));
    const [month] = await db.select({ c: count() }).from(workSessionsTable)
      .where(and(
        eq(workSessionsTable.companyId, cid),
        gte(workSessionsTable.startedAt, startOfMonth),
        userScopeFilter,
      ));

    res.json({
      active: Number(active?.c ?? 0),
      today:  Number(today?.c  ?? 0),
      month:  Number(month?.c  ?? 0),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id --------------------------------------------------------------------
router.get("/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const [row] = await db.select().from(workSessionsTable)
      .where(and(eq(workSessionsTable.id, id), eq(workSessionsTable.companyId, cid)))
      .limit(1);
    if (!row) { res.status(404).json({ error: "الجلسة غير موجودة" }); return; }

    // Permission: non-admins can only view their own rows.
    if (!isAdmin(req) && row.userId !== (req as any).authUser.id) {
      res.status(403).json({ error: "ممنوع" }); return;
    }

    // Activity preview: pull the audit_log rows for this user/company that
    // fall inside the session window. Skip "view" rows — they're noise.
    const winEnd = row.endedAt ?? new Date();
    const activity = await db.select({
      id:         auditLogTable.id,
      module:     auditLogTable.module,
      action:     auditLogTable.action,
      entityType: auditLogTable.entityType,
      entityId:   auditLogTable.entityId,
      method:     auditLogTable.method,
      path:       auditLogTable.path,
      statusCode: auditLogTable.statusCode,
      metadata:   auditLogTable.metadata,
      createdAt:  auditLogTable.createdAt,
    }).from(auditLogTable)
      .where(and(
        eq(auditLogTable.userId, row.userId),
        eq(auditLogTable.companyId, cid),
        gte(auditLogTable.createdAt, row.startedAt),
        lte(auditLogTable.createdAt, winEnd),
        ne(auditLogTable.action, "view"),
      ))
      .orderBy(desc(auditLogTable.createdAt))
      .limit(500);

    const durationSecs = Math.max(0, Math.floor(
      ((row.endedAt ?? new Date()).getTime() - row.startedAt.getTime()) / 1000));

    res.json({
      session: row,
      durationSecs,
      durationLabel: fmtDuration(durationSecs),
      activity,
      activityCount: activity.length,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/end ---------------------------------------------------------------
router.post("/:id/end", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const [row] = await db.select().from(workSessionsTable)
      .where(and(eq(workSessionsTable.id, id), eq(workSessionsTable.companyId, cid)))
      .limit(1);
    if (!row) { res.status(404).json({ error: "الجلسة غير موجودة" }); return; }
    if (!isAdmin(req) && row.userId !== (req as any).authUser.id) {
      res.status(403).json({ error: "ممنوع" }); return;
    }
    if (row.status !== "active") {
      res.status(400).json({ error: "الجلسة منتهية بالفعل" }); return;
    }

    await db.update(workSessionsTable).set({
      status:    "ended",
      endedAt:   new Date(),
      endReason: "manual",
      updatedAt: new Date(),
    }).where(eq(workSessionsTable.id, id));

    const [updated] = await db.select().from(workSessionsTable)
      .where(eq(workSessionsTable.id, id)).limit(1);
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/generate-report ---------------------------------------------------
//
// Collects every non-"view" audit_log row in the session window, formats it
// into a compact JSON facts payload, and asks Claude to write an Arabic
// Markdown summary. The result is cached on the session row so reopening the
// dialog doesn't re-bill Anthropic on every click.
router.post("/:id/generate-report", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || !process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
      res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير مهيّأة على الخادم." });
      return;
    }

    const [row] = await db.select().from(workSessionsTable)
      .where(and(eq(workSessionsTable.id, id), eq(workSessionsTable.companyId, cid)))
      .limit(1);
    if (!row) { res.status(404).json({ error: "الجلسة غير موجودة" }); return; }
    if (!isAdmin(req) && row.userId !== (req as any).authUser.id) {
      res.status(403).json({ error: "ممنوع" }); return;
    }

    const [u] = await db.select({ username: usersTable.username, nameAr: usersTable.nameAr })
      .from(usersTable).where(eq(usersTable.id, row.userId)).limit(1);

    const winEnd = row.endedAt ?? new Date();

    // We cap at 500 rows to keep the prompt small. If the cap is reached
    // the prompt explicitly tells the model the activity was truncated so
    // it doesn't claim "this is everything that happened."
    const ROW_CAP = 500;
    const activity = await db.select({
      module:     auditLogTable.module,
      action:     auditLogTable.action,
      entityType: auditLogTable.entityType,
      entityId:   auditLogTable.entityId,
      method:     auditLogTable.method,
      path:       auditLogTable.path,
      statusCode: auditLogTable.statusCode,
      metadata:   auditLogTable.metadata,
      createdAt:  auditLogTable.createdAt,
    }).from(auditLogTable)
      .where(and(
        eq(auditLogTable.userId, row.userId),
        eq(auditLogTable.companyId, cid),
        gte(auditLogTable.createdAt, row.startedAt),
        lte(auditLogTable.createdAt, winEnd),
        ne(auditLogTable.action, "view"),
      ))
      .orderBy(desc(auditLogTable.createdAt))
      .limit(ROW_CAP + 1);

    const truncated = activity.length > ROW_CAP;
    const sliced    = truncated ? activity.slice(0, ROW_CAP) : activity;

    // Per-module counts so the model has a reliable shape even if the
    // detailed list gets truncated.
    const moduleCounts: Record<string, number> = {};
    for (const a of activity) {
      moduleCounts[a.module] = (moduleCounts[a.module] ?? 0) + 1;
    }

    const durationSecs = Math.max(0, Math.floor(
      (winEnd.getTime() - row.startedAt.getTime()) / 1000));

    const facts = {
      session: {
        id:           row.id,
        username:     u?.username ?? row.username ?? `#${row.userId}`,
        userNameAr:   u?.nameAr ?? null,
        startedAt:    row.startedAt.toISOString(),
        endedAt:      row.endedAt?.toISOString() ?? null,
        status:       row.status,
        durationSecs,
        durationLabel: fmtDuration(durationSecs),
        ip:           row.ip,
      },
      totals: {
        actions:        activity.length,
        truncated,
        rowCap:         ROW_CAP,
        modulesTouched: Object.keys(moduleCounts).length,
        moduleCounts,
      },
      activity: sliced.map(a => ({
        at:         a.createdAt.toISOString(),
        module:     a.module,
        action:     a.action,
        entity:     a.entityType ?? null,
        entityId:   a.entityId ?? null,
        method:     a.method ?? null,
        statusCode: a.statusCode ?? null,
        // Redact sensitive jsonb keys *before* serialising, then truncate
        // to keep the prompt small. We never forward raw audit_log
        // metadata to a third-party AI provider unfiltered.
        metadata:   a.metadata
          ? JSON.stringify(redactMetadata(a.metadata)).slice(0, 200)
          : null,
      })),
    };

    const prompt = `أنت محلل تشغيلي ضمن نظام محاسبة عربي سعودي.
مهمتك: كتابة "تقرير جلسة عمل" بالعربية الفصحى وبتنسيق Markdown، يلخّص نشاط مستخدم واحد خلال جلسة دخول واحدة، بناءً على سجل التدقيق المُرفق فقط.

البيانات (JSON):
\`\`\`json
${JSON.stringify(facts, null, 2)}
\`\`\`

اكتب التقرير بالأقسام التالية بالضبط، وبهذا الترتيب:

## معلومات الجلسة
- المستخدم، تاريخ ووقت البداية، تاريخ ووقت النهاية (أو "جارية"), المدة الإجمالية، عنوان IP إن وُجد.

## ملخص الحركة
- جدول مختصر يعرض الوحدات (modules) التي عمل عليها المستخدم وعدد الإجراءات في كل وحدة (مأخوذة من \`totals.moduleCounts\`).

## التسلسل الزمني للحركات
- قائمة مرتّبة زمنيًا (من الأقدم إلى الأحدث) بكل إجراء مهم: الوقت، الوحدة، الإجراء، نوع السجل ومعرّفه إن وُجد.
- استخدم أسماء عربية مفهومة بدلاً من المفاتيح التقنية (مثلاً "sales_invoices/create" → "إنشاء فاتورة مبيعات").
- إذا كانت قائمة الحركات طويلة جداً، اعرض أهم 30-40 حركة فقط واذكر أنه تم اختصارها.

## ملاحظات وتنبيهات
- أي إجراءات حساسة (مثل الحذف delete, الترحيل post, التصدير export, تعديل الأسعار/الكميات) أو محاولات مرفوضة (statusCode 4xx/5xx). إن لم توجد، اكتب "لا توجد ملاحظات".

قواعد صارمة:
- لا تخترع بيانات غير موجودة في JSON.
- إذا كانت القائمة فارغة، اكتب صراحةً "لم تُسجّل أي حركات خلال هذه الجلسة".
- إذا كان \`totals.truncated = true\`، أضف ملاحظة في أسفل القسم الأول: "تم اختصار قائمة الحركات لأنها تجاوزت الحد المسموح في تقرير واحد".
- لا تذكر أسماء حقول JSON الخام (createdAt, statusCode إلخ). ترجمها إلى عربية واضحة.
- لا تُضف أقساماً غير المطلوبة، ولا توقيع/خاتمة.`;

    const client = new Anthropic({
      apiKey:  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });

    const message = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    const block = message.content[0];
    const reportMd = (block && block.type === "text") ? block.text : "";

    await db.update(workSessionsTable).set({
      aiReport:            reportMd,
      aiReportGeneratedAt: new Date(),
      activityCount:       activity.length,
      updatedAt:           new Date(),
    }).where(eq(workSessionsTable.id, id));

    res.json({
      ok: true,
      aiReport: reportMd,
      aiReportGeneratedAt: new Date().toISOString(),
      activityCount: activity.length,
      truncated,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "تعذّر توليد التقرير" });
  }
});

// Suppress an unused-import warning for `sql` — kept for future date filters.
void sql;

export default router;
