// Shared helper for the Work Sessions feature.
//
// This module owns two responsibilities that need to be invoked from more
// than one place:
//
//   1. `generateSessionReport(...)`
//      Pulls every non-"view" audit_log row inside the session window,
//      asks Claude (via the Replit Anthropic proxy) to summarise it as
//      Arabic Markdown, persists the result onto `work_sessions.aiReport`,
//      and returns the rendered Markdown.
//      Called from:
//        - POST /api/work-sessions/:id/generate-report  (manual click)
//        - end-of-session hook                          (auto-on-end)
//
//   2. `sendSessionReportEmail(...)`
//      Wraps the cached Markdown in a polished RTL HTML email and ships it
//      via the existing `sendEmail` utility (SMTP first, Outlook/Graph
//      fallback). Best-effort — failures are logged and swallowed so
//      they never break logout / end-session flows.
//      Called from:
//        - POST /api/work-sessions/:id/end              (when auto-email is on)
//        - logout audit hook                            (when auto-email is on)
//
//   3. `loadSessionSettings(...)`
//      Reads (and lazily synthesizes defaults for) the per-company
//      work_session_settings row. Returns plain values + a `recipients`
//      array parsed from the comma-separated text column.

import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte, lte, ne } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  workSessionsTable,
  workSessionSettingsTable,
  auditLogTable,
  usersTable,
  branchesTable,
  type WorkSessionRow,
  type WorkSessionSettingsRow,
} from "@workspace/db";
import { sendEmail } from "./email.js";

// --- Redaction (mirrors the route-local copy; kept here so callers outside
// the route can also redact safely) -----------------------------------------
const SENSITIVE_KEY_RE =
  /\b(pass(word|phrase)?|token|access_token|refresh_token|secret|api[_-]?key|secret[_-]?key|public[_-]?key|private[_-]?key|otp|pin|salt|hash|cookie|authorization|bearer|credit[_-]?card|card[_-]?number|cvv|cvc|iban|signature|x[_-]?api[_-]?key|jwt)\b/i;

function redactMetadata(input: unknown, depth = 0): unknown {
  if (input == null || depth > 6) return input;
  if (Array.isArray(input)) return input.map((v) => redactMetadata(v, depth + 1));
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? "[REDACTED]" : redactMetadata(v, depth + 1);
    }
    return out;
  }
  return input;
}

function fmtDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h && m) return `${h}س ${m}د`;
  if (h)      return `${h}س`;
  return `${m}د`;
}

// --- Settings ---------------------------------------------------------------

export interface ResolvedSessionSettings {
  raw: WorkSessionSettingsRow | null;
  emailReportsEnabled:     boolean;
  emailOnSessionEnd:       boolean;
  autoGenerateReportOnEnd: boolean;
  requireBranchSelection:  boolean;
  defaultBranchId:         number | null;
  aiModel:                 string;
  recipients:              string[];
  idleTimeoutMinutes:      number | null;
}

const DEFAULTS: Omit<ResolvedSessionSettings, "raw"> = {
  emailReportsEnabled:     false,
  emailOnSessionEnd:       true,
  autoGenerateReportOnEnd: true,
  requireBranchSelection:  false,
  defaultBranchId:         null,
  aiModel:                 "claude-haiku-4-5",
  recipients:              [],
  idleTimeoutMinutes:      null,
};

function parseRecipients(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

export async function loadSessionSettings(companyId: number): Promise<ResolvedSessionSettings> {
  const [row] = await db
    .select()
    .from(workSessionSettingsTable)
    .where(eq(workSessionSettingsTable.companyId, companyId))
    .limit(1);
  if (!row) return { raw: null, ...DEFAULTS };
  return {
    raw: row,
    emailReportsEnabled:     row.emailReportsEnabled,
    emailOnSessionEnd:       row.emailOnSessionEnd,
    autoGenerateReportOnEnd: row.autoGenerateReportOnEnd,
    requireBranchSelection:  row.requireBranchSelection,
    defaultBranchId:         row.defaultBranchId ?? null,
    aiModel:                 row.aiModel || DEFAULTS.aiModel,
    recipients:              parseRecipients(row.emailRecipients),
    idleTimeoutMinutes:      row.idleTimeoutMinutes ?? null,
  };
}

// --- Report generation ------------------------------------------------------

export interface GenerateReportResult {
  ok: boolean;
  reason?: string;
  aiReport?: string;
  activityCount?: number;
  truncated?: boolean;
}

export async function generateSessionReport(
  sessionId: number,
  companyId: number,
  opts?: { model?: string; force?: boolean },
): Promise<GenerateReportResult> {
  if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || !process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
    return { ok: false, reason: "anthropic_not_configured" };
  }

  const [row] = await db
    .select()
    .from(workSessionsTable)
    .where(and(eq(workSessionsTable.id, sessionId), eq(workSessionsTable.companyId, companyId)))
    .limit(1);
  if (!row) return { ok: false, reason: "session_not_found" };
  if (row.aiReport && !opts?.force) {
    return {
      ok: true,
      aiReport: row.aiReport,
      activityCount: row.activityCount ?? 0,
      truncated: false,
    };
  }

  const winEnd = row.endedAt ?? new Date();

  const [u] = await db
    .select({ username: usersTable.username, nameAr: usersTable.nameAr })
    .from(usersTable)
    .where(eq(usersTable.id, row.userId))
    .limit(1);

  let branchLabel: string | null = null;
  if (row.branchId) {
    const [b] = await db
      .select({ nameAr: branchesTable.nameAr, nameEn: branchesTable.nameEn, code: branchesTable.code })
      .from(branchesTable)
      .where(eq(branchesTable.id, row.branchId))
      .limit(1);
    if (b) branchLabel = b.nameAr || b.nameEn || b.code;
  }

  const ROW_CAP = 500;
  const activity = await db
    .select({
      module:     auditLogTable.module,
      action:     auditLogTable.action,
      entityType: auditLogTable.entityType,
      entityId:   auditLogTable.entityId,
      method:     auditLogTable.method,
      path:       auditLogTable.path,
      statusCode: auditLogTable.statusCode,
      metadata:   auditLogTable.metadata,
      createdAt:  auditLogTable.createdAt,
    })
    .from(auditLogTable)
    .where(
      and(
        eq(auditLogTable.userId, row.userId),
        eq(auditLogTable.companyId, companyId),
        gte(auditLogTable.createdAt, row.startedAt),
        lte(auditLogTable.createdAt, winEnd),
        ne(auditLogTable.action, "view"),
      ),
    )
    .orderBy(desc(auditLogTable.createdAt))
    .limit(ROW_CAP + 1);

  const truncated = activity.length > ROW_CAP;
  const sliced = truncated ? activity.slice(0, ROW_CAP) : activity;

  const moduleCounts: Record<string, number> = {};
  for (const a of activity) moduleCounts[a.module] = (moduleCounts[a.module] ?? 0) + 1;

  const durationSecs = Math.max(0, Math.floor((winEnd.getTime() - row.startedAt.getTime()) / 1000));

  const facts = {
    session: {
      id:            row.id,
      username:      u?.username ?? row.username ?? `#${row.userId}`,
      userNameAr:    u?.nameAr ?? null,
      branch:        branchLabel,
      startedAt:     row.startedAt.toISOString(),
      endedAt:       row.endedAt?.toISOString() ?? null,
      status:        row.status,
      durationSecs,
      durationLabel: fmtDuration(durationSecs),
      ip:            row.ip,
    },
    totals: {
      actions:        activity.length,
      truncated,
      rowCap:         ROW_CAP,
      modulesTouched: Object.keys(moduleCounts).length,
      moduleCounts,
    },
    activity: sliced.map((a) => ({
      at:         a.createdAt.toISOString(),
      module:     a.module,
      action:     a.action,
      entity:     a.entityType ?? null,
      entityId:   a.entityId ?? null,
      method:     a.method ?? null,
      statusCode: a.statusCode ?? null,
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
- المستخدم، الفرع (إن وُجد), تاريخ ووقت البداية، تاريخ ووقت النهاية (أو "جارية"), المدة الإجمالية، عنوان IP إن وُجد.

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

  // Defensive: even though PUT /work-session-settings allowlists aiModel,
  // a corrupted/legacy value in the row would otherwise cascade into a
  // failed Anthropic call. Re-validate here and fall back to the default.
  const ALLOWED_MODELS = new Set([
    "claude-haiku-4-5",
    "claude-sonnet-4-5",
    "claude-opus-4-5",
  ]);
  const requested = (opts?.model || "").trim();
  const safeModel = ALLOWED_MODELS.has(requested) ? requested : "claude-haiku-4-5";

  const message = await client.messages.create({
    model: safeModel,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const block = message.content[0];
  const reportMd = block && block.type === "text" ? block.text : "";

  await db
    .update(workSessionsTable)
    .set({
      aiReport: reportMd,
      aiReportGeneratedAt: new Date(),
      activityCount: activity.length,
      updatedAt: new Date(),
    })
    .where(eq(workSessionsTable.id, sessionId));

  return { ok: true, aiReport: reportMd, activityCount: activity.length, truncated };
}

// --- Email shipping ---------------------------------------------------------

// Tiny Markdown → HTML so the email body looks like the in-app dialog.
// Same shape as the page's renderer, kept self-contained here so the email
// path doesn't pull in any frontend code.
function markdownToHtml(md: string): string {
  if (!md) return "";
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = esc(md);

  html = html.replace(/((?:^\|.*\|\s*$\n?)+)/gm, (block) => {
    const lines = block.trim().split(/\n/).filter(Boolean);
    if (lines.length < 2) return block;
    const cells = (line: string) =>
      line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const head = cells(lines[0]);
    const isSep = /^[\s\-:|]+$/.test(lines[1]);
    const bodyLines = isSep ? lines.slice(2) : lines.slice(1);
    const thead = `<thead><tr>${head.map((h) => `<th style="padding:6px 10px;border:1px solid #ddd;background:#f5f5f5;text-align:start">${h}</th>`).join("")}</tr></thead>`;
    const tbody = `<tbody>${bodyLines.map((l) => `<tr>${cells(l).map((c) => `<td style="padding:6px 10px;border:1px solid #ddd;vertical-align:top">${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
    return `<table style="border-collapse:collapse;width:100%;margin:8px 0;font-size:13px">${thead}${tbody}</table>`;
  });

  html = html.replace(/^###\s+(.+)$/gm, '<h3 style="font-size:15px;margin:16px 0 6px">$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm,  '<h2 style="font-size:18px;margin:20px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px">$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm,   '<h1 style="font-size:22px;margin:24px 0 10px">$1</h1>');

  html = html.replace(/(?:^- .+\n?)+/gm, (block) => {
    const items = block.trim().split(/\n/).map((l) => l.replace(/^- /, "").trim());
    return `<ul style="padding-inline-start:24px;margin:8px 0">${items.map((i) => `<li style="margin:2px 0">${i}</li>`).join("")}</ul>`;
  });

  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code style="padding:1px 4px;background:#f1f5f9;border-radius:3px;font-size:12px">$1</code>');

  html = html
    .split(/\n{2,}/)
    .map((chunk) => {
      const c = chunk.trim();
      if (!c) return "";
      if (/^<(h\d|ul|ol|table|p|div|pre)/.test(c)) return c;
      return `<p style="margin:6px 0;line-height:1.7">${c.replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");

  return html;
}

export async function sendSessionReportEmail(
  session: WorkSessionRow,
  recipients: string[],
  reportMd: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!recipients.length) return { ok: false, reason: "no_recipients" };
  if (!reportMd) return { ok: false, reason: "no_report" };

  const startedAt = session.startedAt instanceof Date
    ? session.startedAt
    : new Date(session.startedAt as unknown as string);
  const endedAt = session.endedAt
    ? (session.endedAt instanceof Date ? session.endedAt : new Date(session.endedAt as unknown as string))
    : new Date();
  const durationSecs = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));

  const subject = `تقرير جلسة عمل — ${session.username ?? `#${session.userId}`} — ${startedAt.toLocaleString("ar-SA")}`;

  const reportHtml = markdownToHtml(reportMd);
  const html = `<!doctype html>
<html dir="rtl" lang="ar">
<head><meta charset="utf-8"/></head>
<body style="font-family: 'Tahoma','Segoe UI',Arial,sans-serif; color:#1f2937; max-width:760px; margin:0 auto; padding:18px;">
  <h1 style="font-size:20px;margin:0 0 6px">تقرير جلسة عمل</h1>
  <div style="font-size:13px;color:#6b7280;margin-bottom:12px">
    المستخدم: <strong style="color:#111827">${session.username ?? `#${session.userId}`}</strong> ·
    البداية: ${startedAt.toLocaleString("ar-SA")} ·
    النهاية: ${session.endedAt ? endedAt.toLocaleString("ar-SA") : "جارية"} ·
    المدة: ${fmtDuration(durationSecs)}
  </div>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:8px 0 16px"/>
  ${reportHtml}
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 8px"/>
  <p style="font-size:11px;color:#9ca3af">
    أُرسل هذا التقرير تلقائياً عند إنهاء الجلسة. لإيقاف الإرسال أو تغيير المستلمين، افتح
    "جلسات العمل" → "إعدادات الجلسات".
  </p>
</body></html>`;

  // Plain-text fallback — strip HTML tags, keep newlines.
  const text = reportMd;

  return sendEmail({ to: recipients, subject, html, text });
}

// --- End-of-session orchestrator -------------------------------------------
//
// Called from every code path that flips a session to 'ended' (manual end,
// logout, force-end on new login). Best-effort: any failure is logged and
// swallowed so the calling flow (logout, etc.) is never blocked.
export async function runEndOfSessionHooks(
  sessionId: number,
  companyId: number,
  opts?: { reason?: "logout" | "manual" | "new_login" | "system" },
): Promise<void> {
  try {
    const settings = await loadSessionSettings(companyId);
    if (!settings.emailReportsEnabled || !settings.emailOnSessionEnd) return;
    if (settings.recipients.length === 0) return;

    // Auto-generate the report if the admin asked us to and the row doesn't
    // already have one. We pass `force=false` so a previously-generated
    // report is reused (no extra Anthropic spend).
    if (settings.autoGenerateReportOnEnd) {
      await generateSessionReport(sessionId, companyId, { model: settings.aiModel });
    }

    const [row] = await db
      .select()
      .from(workSessionsTable)
      .where(and(eq(workSessionsTable.id, sessionId), eq(workSessionsTable.companyId, companyId)))
      .limit(1);
    if (!row || !row.aiReport) return;

    const result = await sendSessionReportEmail(row, settings.recipients, row.aiReport);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[work-sessions] email send skipped (${result.reason ?? "unknown"}) for session ${sessionId}`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[work-sessions] end-of-session hook failed (reason=${opts?.reason ?? "?"}):`, e);
  }
}
