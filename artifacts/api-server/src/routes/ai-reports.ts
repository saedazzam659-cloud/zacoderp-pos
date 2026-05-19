import { Router } from "express";
import { db } from "@workspace/db";
import {
  salesInvoicesTable, salesReturnsTable,
  receiptVouchersTable, paymentVouchersTable,
  branchesTable,
} from "@workspace/db";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { extractAuth } from "../middleware/auth.js";
import { deliverReport, getCompanyAdminUserIds } from "../lib/inboxDelivery.js";
import { sendEmail } from "../lib/email.js";
import { chat as aiChat, isAIAvailable } from "../lib/aiClient.js";
import { logAiUsage, requireAiFeature } from "../middleware/requireAiFeature.js";
import { AsyncLocalStorage } from "node:async_hooks";

const router = Router();
  // ─────────────────────────────────────────────────────────────────────────
  // Gemini-first transparent redirect (see notes in routes/ai.ts).
  // Re-binds OPENAI_BASE/KEY (declared elsewhere in this file) to a sentinel
  // "AI_PROXY" string and shadows the global fetch with a local one that
  // intercepts the sentinel URL, dispatches via aiChat, and returns a
  // Response-shaped object so existing r.ok/r.json()/r.text() callsites
  // continue to work unchanged. AsyncLocalStorage threads `req` through
  // so the feature-gate's logAiUsage counter still advances.
  // ─────────────────────────────────────────────────────────────────────────
  const __aiReqStore = new AsyncLocalStorage<any>();
  router.use((req, _res, next) => { __aiReqStore.run(req, () => next()); });

  const __nativeFetch = globalThis.fetch;
  async function fetch(input: any, init?: any): Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }> {
    if (typeof input === "string" && input.startsWith("AI_PROXY")) {
      const body = (() => { try { return JSON.parse(init?.body ?? "{}"); } catch { return {}; } })();
      const result = await aiChat(body.messages ?? [], {
        json:      body.response_format?.type === "json_object",
        maxTokens: body.max_completion_tokens ?? body.max_tokens ?? 2048,
        providers: ["gemini"],
      });
      const req = __aiReqStore.getStore();
      if (req) {
        try {
          await logAiUsage(req, result.ok
            ? { status: "allowed", provider: result.provider }
            : { status: "error",   meta: { reason: result.reason } });
        } catch { /* logging must never break the call */ }
      }
      if (!result.ok) {
        return { ok: false, status: 502, json: async () => ({ error: result.reason }), text: async () => result.reason };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: result.text } }] }),
        text: async () => result.text,
      };
    }
    return (__nativeFetch as any)(input, init);
  }
  

router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (req.authUser.role !== "admin" && req.authUser.role !== "superadmin") {
    res.status(403).json({ error: "صلاحية الإدارة مطلوبة" });
    return;
  }
  if (!req.authUser.companyId && req.authUser.role !== "superadmin") {
    res.status(400).json({ error: "لا توجد شركة مرتبطة بالحساب" });
    return;
  }
  next();
});

const OPENAI_BASE = "AI_PROXY";
const OPENAI_KEY  = "AI_PROXY";

// ─── Supported report builders ────────────────────────────────────────────────
type ReportType =
  | "sales_summary"
  | "sales_returns_summary"
  | "receipts_summary"
  | "payments_summary"
  | "invoices_list";

interface ReportArgs {
  reportType: ReportType;
  dateFrom: string;   // YYYY-MM-DD
  dateTo:   string;   // YYYY-MM-DD
  branchId?: number | null;
}

const REPORT_LABELS_AR: Record<ReportType, string> = {
  sales_summary:         "ملخص المبيعات",
  sales_returns_summary: "ملخص مرتجعات المبيعات",
  receipts_summary:      "ملخص سندات القبض",
  payments_summary:      "ملخص سندات الصرف",
  invoices_list:         "كشف فواتير المبيعات",
};

// ─── HTML escape (XSS guard for any user-supplied text in HTML body) ────────
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────
function escapeCsv(v: any): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes("\"") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
function rowsToCsv(headers: string[], rows: any[][]): Buffer {
  const lines = [headers.map(escapeCsv).join(",")];
  for (const r of rows) lines.push(r.map(escapeCsv).join(","));
  // BOM for Excel-on-Windows so Arabic text renders correctly.
  return Buffer.from("\uFEFF" + lines.join("\n"), "utf8");
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}
function todayStr(): string {
  // Riyadh-local date so "today/yesterday/this month" align with the user's TZ.
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date());
}
const MAX_DATE_SPAN_DAYS = 366;
function daySpan(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db_ = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db_ - da) / 86400000);
}
function shiftDays(s: string, n: number): string {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

// ─── Report builders ──────────────────────────────────────────────────────────
async function buildSalesSummary(companyId: number, args: ReportArgs) {
  const conds: any[] = [
    eq(salesInvoicesTable.companyId, companyId),
    gte(salesInvoicesTable.invoiceDate, args.dateFrom),
    lte(salesInvoicesTable.invoiceDate, args.dateTo),
  ];
  if (args.branchId) conds.push(eq(salesInvoicesTable.branchId, args.branchId));

  const rows = await db.select({
    date: salesInvoicesTable.invoiceDate,
    docNumber: salesInvoicesTable.docNumber,
    status: salesInvoicesTable.status,
    paymentType: salesInvoicesTable.paymentType,
    branchId: salesInvoicesTable.branchId,
    subtotal: salesInvoicesTable.subtotal,
    vat: salesInvoicesTable.vatAmount,
    discount: salesInvoicesTable.discountAmount,
    total: salesInvoicesTable.totalAmount,
  })
    .from(salesInvoicesTable)
    .where(and(...conds))
    .orderBy(desc(salesInvoicesTable.invoiceDate));

  let sumSubtotal = 0, sumVat = 0, sumDiscount = 0, sumTotal = 0;
  for (const r of rows) {
    sumSubtotal += Number(r.subtotal) || 0;
    sumVat      += Number(r.vat)      || 0;
    sumDiscount += Number(r.discount) || 0;
    sumTotal    += Number(r.total)    || 0;
  }

  const csv = rowsToCsv(
    ["التاريخ","رقم الفاتورة","الحالة","نوع الدفع","الفرع","الإجمالي قبل الضريبة","الضريبة","الخصم","الإجمالي النهائي"],
    rows.map(r => [r.date, r.docNumber ?? "", r.status, r.paymentType, r.branchId ?? "", r.subtotal, r.vat, r.discount, r.total]),
  );

  const summary = {
    count: rows.length,
    totals: { subtotal: sumSubtotal, vat: sumVat, discount: sumDiscount, total: sumTotal },
  };
  return { csv, summary };
}

async function buildSalesReturnsSummary(companyId: number, args: ReportArgs) {
  const conds: any[] = [
    eq(salesReturnsTable.companyId, companyId),
    gte(salesReturnsTable.returnDate, args.dateFrom),
    lte(salesReturnsTable.returnDate, args.dateTo),
  ];
  if (args.branchId) conds.push(eq(salesReturnsTable.branchId, args.branchId));

  const rows: any[] = await db.execute(sql`
    SELECT return_date, doc_number, branch_id, total_amount, status
    FROM sales_returns
    WHERE company_id = ${companyId}
      AND return_date >= ${args.dateFrom}
      AND return_date <= ${args.dateTo}
      ${args.branchId ? sql`AND branch_id = ${args.branchId}` : sql``}
    ORDER BY return_date DESC
  `).then((r: any) => r.rows ?? r);

  let sumTotal = 0;
  for (const r of rows) sumTotal += Number(r.total_amount) || 0;

  const csv = rowsToCsv(
    ["التاريخ","رقم المرتجع","الفرع","الإجمالي","الحالة"],
    rows.map(r => [r.return_date, r.doc_number ?? "", r.branch_id ?? "", r.total_amount, r.status]),
  );
  return { csv, summary: { count: rows.length, totals: { total: sumTotal } } };
}

async function buildVouchersSummary(
  companyId: number, args: ReportArgs, kind: "receipt" | "payment",
) {
  const table = kind === "receipt" ? receiptVouchersTable : paymentVouchersTable;
  const conds: any[] = [
    eq(table.companyId, companyId),
    gte(table.date, args.dateFrom),
    lte(table.date, args.dateTo),
  ];
  if (args.branchId) conds.push(eq(table.branchId, args.branchId));

  const rows = await db.select({
    date: table.date,
    code: table.code,
    paymentType: table.paymentType,
    entityType: table.entityType,
    entityName: table.entityName,
    amount: table.amount,
    status: table.status,
    branchId: table.branchId,
  }).from(table).where(and(...conds)).orderBy(desc(table.date));

  let sum = 0;
  for (const r of rows) sum += Number(r.amount) || 0;
  const csv = rowsToCsv(
    ["التاريخ","الرقم","طريقة الدفع","نوع الجهة","الجهة","الفرع","المبلغ","الحالة"],
    rows.map(r => [r.date, r.code, r.paymentType, r.entityType, r.entityName ?? "", r.branchId ?? "", r.amount, r.status]),
  );
  return { csv, summary: { count: rows.length, totals: { amount: sum } } };
}

async function buildInvoicesList(companyId: number, args: ReportArgs) {
  // Same data source as sales_summary but ordered+labelled as a doc list.
  return buildSalesSummary(companyId, args);
}

async function runReport(companyId: number, args: ReportArgs) {
  switch (args.reportType) {
    case "sales_summary":         return buildSalesSummary(companyId, args);
    case "sales_returns_summary": return buildSalesReturnsSummary(companyId, args);
    case "receipts_summary":      return buildVouchersSummary(companyId, args, "receipt");
    case "payments_summary":      return buildVouchersSummary(companyId, args, "payment");
    case "invoices_list":         return buildInvoicesList(companyId, args);
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────
function validateArgs(raw: any, allowedBranchIds?: Set<number>): ReportArgs | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "بيانات غير صحيحة" };
  const reportType = raw.reportType;
  const valid: ReportType[] = ["sales_summary", "sales_returns_summary", "receipts_summary", "payments_summary", "invoices_list"];
  if (!valid.includes(reportType)) return { error: "نوع تقرير غير معروف" };
  if (typeof raw.dateFrom !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.dateFrom)) return { error: "تاريخ البداية غير صحيح" };
  if (typeof raw.dateTo   !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.dateTo))   return { error: "تاريخ النهاية غير صحيح" };
  if (raw.dateFrom > raw.dateTo) return { error: "تاريخ البداية بعد تاريخ النهاية" };
  if (daySpan(raw.dateFrom, raw.dateTo) > MAX_DATE_SPAN_DAYS) {
    return { error: `الفترة طويلة جدًا (الحد الأقصى ${MAX_DATE_SPAN_DAYS} يومًا)` };
  }
  let branchId: number | null = null;
  if (raw.branchId !== undefined && raw.branchId !== null && raw.branchId !== "") {
    const n = Number(raw.branchId);
    if (!Number.isInteger(n) || n <= 0) return { error: "معرّف الفرع غير صحيح" };
    if (allowedBranchIds && !allowedBranchIds.has(n)) return { error: "الفرع غير موجود في هذه الشركة" };
    branchId = n;
  }
  return { reportType, dateFrom: raw.dateFrom, dateTo: raw.dateTo, branchId };
}

async function getCompanyBranchIds(companyId: number): Promise<Set<number>> {
  const rows = await db.select({ id: branchesTable.id })
    .from(branchesTable).where(eq(branchesTable.companyId, companyId));
  return new Set(rows.map(r => r.id));
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

/** Manual generation: caller already picked the report; no AI. */
router.post("/generate", async (req, res) => {
  try {
    const u = req.authUser!;
    const companyId = u.companyId;
    if (!companyId) { res.status(400).json({ error: "لا توجد شركة" }); return; }
    const allowedBranches = await getCompanyBranchIds(companyId);
    const v = validateArgs(req.body, allowedBranches);
    if ("error" in v) { res.status(400).json({ error: v.error }); return; }

    const { csv, summary } = await runReport(companyId, v);
    const labelAr = REPORT_LABELS_AR[v.reportType];
    const subject = `${labelAr} (${v.dateFrom} → ${v.dateTo})`;
    const body = renderReportHtml(labelAr, v, summary);

    const result = await deliverReport({
      companyId,
      recipientUserIds: [u.id],
      subject, body,
      attachment: { filename: `${v.reportType}-${v.dateFrom}-${v.dateTo}.csv`, mime: "text/csv; charset=utf-8", buffer: csv },
      createdByUserId: u.id,
    });
    res.json({ ok: true, summary, inboxMessageId: result.inboxMessageIds[0] ?? null });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

/** AI prompt → parse → run → deliver. */
router.post("/send", requireAiFeature("report_analyzer"), async (req, res) => {
  try {
    if (!isAIAvailable()) {
      res.status(500).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" });
      return;
    }
    const u = req.authUser!;
    const companyId = u.companyId;
    if (!companyId) { res.status(400).json({ error: "لا توجد شركة" }); return; }

    const prompt = String(req.body?.prompt ?? "").trim();
    const deliverByEmail = !!req.body?.deliverByEmail;
    const audience: "self" | "all_admins" = req.body?.audience === "all_admins" ? "all_admins" : "self";
    if (!prompt) { res.status(400).json({ error: "الرجاء كتابة الطلب" }); return; }
    if (prompt.length > 1000) { res.status(400).json({ error: "الطلب طويل جدًا" }); return; }

    // Fetch the company's branches so the LLM can map names → ids.
    const branchRows = await db.select({ id: branchesTable.id, nameAr: branchesTable.nameAr, nameEn: branchesTable.nameEn })
      .from(branchesTable).where(eq(branchesTable.companyId, companyId));
    const branchHint = branchRows.length
      ? `الفروع المتاحة (id|اسم): ${branchRows.map(b => `${b.id}|${b.nameAr || b.nameEn}`).join(", ")}.`
      : "لا توجد فروع مُعرَّفة.";

    const today = todayStr();
    const yesterday = shiftDays(today, -1);
    const last7 = shiftDays(today, -7);
    const last30 = shiftDays(today, -30);

    const systemPrompt = `أنت مساعد تحويل طلبات المستخدم لتقارير محاسبية مُهيكلة.
ترد فقط بـ JSON بالشكل التالي بدون أي شرح:
{
  "reportType": "sales_summary" | "sales_returns_summary" | "receipts_summary" | "payments_summary" | "invoices_list",
  "dateFrom": "YYYY-MM-DD",
  "dateTo":   "YYYY-MM-DD",
  "branchId": null | <رقم>
}

مرجع نوع التقرير حسب الكلمات:
- "مبيعات" / "فواتير المبيعات" / "البيع" → sales_summary أو invoices_list
- "مرتجعات" / "مرتجع مبيعات" → sales_returns_summary
- "قبض" / "تحصيلات" / "إيرادات نقدية" → receipts_summary
- "صرف" / "مدفوعات" → payments_summary

التواريخ المرجعية:
- اليوم = ${today}
- أمس  = ${yesterday}
- آخر ٧ أيام: من ${last7} إلى ${today}
- آخر ٣٠ يومًا: من ${last30} إلى ${today}
- الشهر الحالي: من بداية الشهر إلى ${today}.

${branchHint}
إذا لم يحدد المستخدم فرعًا، اجعل branchId = null.`;

    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(502).json({ error: `فشل الذكاء الاصطناعي: ${r.status} ${txt.slice(0, 200)}` });
      return;
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any;
    try { parsed = JSON.parse(content); }
    catch { res.status(500).json({ error: "تعذّر تحليل استجابة الذكاء الاصطناعي" }); return; }

    const allowedBranches = new Set(branchRows.map(b => b.id));
    const v = validateArgs(parsed, allowedBranches);
    if ("error" in v) {
      res.status(400).json({ error: `لم أفهم الطلب: ${v.error}` });
      return;
    }

    const { csv, summary } = await runReport(companyId, v);
    const labelAr = REPORT_LABELS_AR[v.reportType];
    const subject = `${labelAr} (${v.dateFrom} → ${v.dateTo})`;
    const body = renderReportHtml(labelAr, v, summary, prompt);

    // Audience: self by default; "all_admins" delivers to every admin.
    let recipients: number[] = [u.id];
    if (audience === "all_admins") {
      recipients = await getCompanyAdminUserIds(companyId);
      if (!recipients.includes(u.id)) recipients.push(u.id);
    }

    const result = await deliverReport({
      companyId,
      recipientUserIds: recipients,
      subject, body,
      attachment: { filename: `${v.reportType}-${v.dateFrom}-${v.dateTo}.csv`, mime: "text/csv; charset=utf-8", buffer: csv },
      createdByUserId: u.id,
    });

    // Optional email copy (best-effort, non-blocking failure mode).
    let emailSent = false;
    if (deliverByEmail) {
      try {
        const recipientEmails: string[] = [];
        const userRows: any = await db.execute(sql`
          SELECT email FROM users WHERE id = ANY(${recipients}) AND email IS NOT NULL
        `);
        for (const row of (userRows.rows ?? userRows ?? [])) {
          if (row.email) recipientEmails.push(row.email);
        }
        if (recipientEmails.length) {
          await sendEmail({
            to: recipientEmails.join(","),
            subject,
            html: body,
            attachments: [{
              filename: `${v.reportType}-${v.dateFrom}-${v.dateTo}.csv`,
              content: csv,
              contentType: "text/csv; charset=utf-8",
            }],
          });
          emailSent = true;
        }
      } catch { /* swallow — inbox delivery already succeeded */ }
    }

    res.json({
      ok: true,
      reportType: v.reportType,
      dateFrom: v.dateFrom, dateTo: v.dateTo, branchId: v.branchId,
      labelAr,
      summary,
      recipientsCount: recipients.length,
      inboxMessageIds: result.inboxMessageIds,
      inboxMessageId: result.inboxMessageIds[0] ?? null,
      emailSent,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "خطأ" });
  }
});

function renderReportHtml(label: string, v: ReportArgs, summary: any, prompt?: string): string {
  const fmt = (n: any) => Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const totalsHtml = Object.entries(summary?.totals || {}).map(([k, val]) => {
    const labelMap: Record<string, string> = {
      subtotal: "الإجمالي قبل الضريبة",
      vat: "الضريبة",
      discount: "الخصم",
      total: "الإجمالي النهائي",
      amount: "إجمالي المبلغ",
    };
    return `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${labelMap[k] || k}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:left;font-family:monospace">${fmt(val)} ر.س</td></tr>`;
  }).join("");

  return `<div dir="rtl" style="font-family:system-ui,'Segoe UI',Tahoma,sans-serif;line-height:1.7;color:#222">
  <h2 style="margin:0 0 8px">${escapeHtml(label)}</h2>
  <div style="color:#666;margin-bottom:12px">الفترة: ${escapeHtml(v.dateFrom)} → ${escapeHtml(v.dateTo)}${v.branchId ? ` — الفرع: ${Number(v.branchId)}` : ""}</div>
  ${prompt ? `<div style="background:#f6f6f6;border-right:3px solid #888;padding:8px 12px;margin:12px 0;color:#444">طلب المستخدم: «${escapeHtml(prompt)}»</div>` : ""}
  <div style="margin:12px 0">عدد السجلات: <b>${Number(summary?.count ?? 0)}</b></div>
  <table style="border-collapse:collapse;min-width:280px;background:#fafafa;border:1px solid #eee">${totalsHtml || `<tr><td style="padding:6px 12px;color:#888">لا توجد إجماليات</td></tr>`}</table>
  <div style="margin-top:14px;color:#888;font-size:12px">المرفق CSV يحتوي على البيانات التفصيلية كاملة.</div>
</div>`;
}

export default router;
