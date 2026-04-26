import nodemailer, { type Transporter } from "nodemailer";

let cached: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (cached) return cached;
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const port = Number(portRaw ?? "587");
  cached = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return cached;
}

function getFrom(): string {
  return process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "no-reply@localhost";
}

// Microsoft Outlook (Microsoft Graph) — Replit connector fallback when SMTP isn't set.
// Uses the @replit/connectors-sdk to send via POST /v1.0/me/sendMail with the
// authenticated user's mailbox.
function outlookEnabled(): boolean {
  return Boolean(
    process.env.REPLIT_CONNECTORS_HOSTNAME &&
      (process.env.REPL_IDENTITY || process.env.WEB_REPL_RENEWAL || process.env.REPL_IDENTITY_KEY),
  );
}

let cachedOutlook: any = null;
async function getOutlookConnector() {
  if (cachedOutlook) return cachedOutlook;
  try {
    const mod: any = await import("@replit/connectors-sdk");
    const Ctor = mod.ReplitConnectors ?? mod.default?.ReplitConnectors ?? mod.default;
    if (!Ctor) return null;
    cachedOutlook = new Ctor();
    return cachedOutlook;
  } catch {
    return null;
  }
}

function toBase64(buf: string | Buffer): string {
  if (Buffer.isBuffer(buf)) return buf.toString("base64");
  return Buffer.from(buf, "utf-8").toString("base64");
}

async function sendViaOutlook(opts: SendOpts): Promise<{ ok: boolean; reason?: string }> {
  const connectors = await getOutlookConnector();
  if (!connectors) return { ok: false, reason: "outlook_sdk_unavailable" };
  const recipients = (Array.isArray(opts.to) ? opts.to : [opts.to])
    .map((e) => ({ emailAddress: { address: e } }));
  const message: Record<string, unknown> = {
    subject: opts.subject,
    body: { contentType: "HTML", content: opts.html },
    toRecipients: recipients,
  };
  if (opts.attachments?.length) {
    message.attachments = opts.attachments.map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.filename,
      contentType: a.contentType ?? "text/csv; charset=utf-8",
      contentBytes: toBase64(a.content),
    }));
  }
  const payload = { message, saveToSentItems: true };
  try {
    const resp: any = await connectors.proxy("outlook", "/v1.0/me/sendMail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp && typeof resp.status === "number" && resp.status >= 200 && resp.status < 300) {
      return { ok: true };
    }
    let detail = "";
    try { detail = await resp.text(); } catch {}
    return { ok: false, reason: `outlook_http_${resp?.status ?? "?"}:${detail.slice(0, 200)}` };
  } catch (err: any) {
    return { ok: false, reason: `outlook_error:${err?.message ?? "unknown"}` };
  }
}

export function emailConfigured(): boolean {
  return Boolean(
    (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) || outlookEnabled(),
  );
}

export interface EmailAttachment {
  filename: string;
  content: string | Buffer;
  contentType?: string;
}

export interface SendOpts {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
}

export async function sendEmail(opts: SendOpts): Promise<{ ok: boolean; reason?: string }> {
  const transporter = getTransporter();
  let smtpReason: string | null = null;
  if (transporter) {
    try {
      await transporter.sendMail({
        from: getFrom(),
        to: Array.isArray(opts.to) ? opts.to.join(", ") : opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        attachments: opts.attachments?.map(a => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType ?? "text/csv; charset=utf-8",
        })),
      });
      return { ok: true };
    } catch (err: any) {
      smtpReason = err?.message ?? "send_failed";
      console.error("[email] SMTP send failed; will try Outlook fallback if available", smtpReason);
    }
  }
  if (outlookEnabled()) {
    const r = await sendViaOutlook(opts);
    if (r.ok) {
      console.info("[email] sent via Outlook connector", { to: opts.to, subject: opts.subject });
      return r;
    }
    console.error("[email] Outlook send failed", r.reason);
    return { ok: false, reason: smtpReason ? `smtp:${smtpReason}|${r.reason}` : r.reason };
  }
  if (smtpReason) return { ok: false, reason: smtpReason };
  console.warn("[email] No transport configured — skipping send", { to: opts.to, subject: opts.subject });
  return { ok: false, reason: "no_transport_configured" };
}

const wrapHtml = (title: string, body: string) => `
<div dir="rtl" lang="ar" style="font-family: 'Tahoma', Arial, sans-serif; background:#f4f6f8; padding:32px;">
  <div style="max-width:520px; margin:auto; background:#fff; border-radius:12px; padding:28px; box-shadow:0 2px 6px rgba(0,0,0,.06);">
    <div style="border-bottom:2px solid #10b981; padding-bottom:12px; margin-bottom:18px;">
      <h2 style="margin:0; color:#0f172a; font-size:20px;">${title}</h2>
    </div>
    <div style="color:#334155; line-height:1.7; font-size:14px;">${body}</div>
    <hr style="border:none; border-top:1px solid #e2e8f0; margin:24px 0;" />
    <p style="font-size:12px; color:#94a3b8; margin:0;">
      هذه رسالة آلية من نظام الفاتورة الإلكترونية السعودية. إذا لم تطلب هذا الإجراء فيرجى تجاهل الرسالة أو التواصل مع الدعم.
    </p>
  </div>
</div>`;

export async function sendOtpEmail(to: string, code: string, ip: string | null, ua: string | null) {
  const body = `
    <p>رمز التحقق الخاص بك لتسجيل الدخول كـ <strong>سوبر أدمن</strong>:</p>
    <p style="font-size:34px; font-weight:bold; letter-spacing:6px; text-align:center;
      background:#ecfdf5; color:#065f46; padding:14px; border-radius:8px; margin:12px 0;">${code}</p>
    <p>صالح لمدة <strong>60 ثانية</strong> فقط.</p>
    <p style="color:#64748b; font-size:12px;">عنوان IP: ${ip ?? "غير معروف"}<br/>المتصفح: ${ua ?? "غير معروف"}</p>`;
  return sendEmail({ to, subject: "رمز التحقق — تسجيل الدخول", html: wrapHtml("رمز التحقق", body) });
}

export async function sendNewDeviceAlert(to: string, ip: string | null, ua: string | null) {
  const body = `
    <p>تم تسجيل دخول ناجح من <strong>جهاز جديد</strong> إلى حساب السوبر أدمن.</p>
    <p style="color:#64748b; font-size:13px;">
      الوقت: ${new Date().toLocaleString("ar-SA")}<br/>
      عنوان IP: ${ip ?? "غير معروف"}<br/>
      المتصفح: ${ua ?? "غير معروف"}
    </p>
    <p>إذا كنت أنت من قام بهذا، فلا داعي لأي إجراء. وإلا، فيرجى تغيير كلمة المرور وتعطيل جميع الأجهزة فورًا من صفحة الأمان.</p>`;
  return sendEmail({ to, subject: "تنبيه: تسجيل دخول من جهاز جديد", html: wrapHtml("جهاز جديد", body) });
}

export async function sendFailedLoginAlert(to: string, ip: string | null, reason: string) {
  const body = `
    <p>تم رصد محاولة دخول <strong>فاشلة</strong> لحساب السوبر أدمن.</p>
    <p style="color:#64748b; font-size:13px;">
      الوقت: ${new Date().toLocaleString("ar-SA")}<br/>
      عنوان IP: ${ip ?? "غير معروف"}<br/>
      السبب: ${reason}
    </p>
    <p>إذا تكررت هذه المحاولات، فيرجى تغيير كلمة المرور فورًا.</p>`;
  return sendEmail({ to, subject: "تنبيه: محاولة دخول فاشلة", html: wrapHtml("محاولة فاشلة", body) });
}

export async function sendPasswordChangeAlert(to: string, ip: string | null) {
  const body = `
    <p>تم <strong>تغيير كلمة مرور</strong> حساب السوبر أدمن للتو.</p>
    <p style="color:#64748b; font-size:13px;">
      الوقت: ${new Date().toLocaleString("ar-SA")}<br/>
      عنوان IP: ${ip ?? "غير معروف"}
    </p>
    <p>إذا لم تكن أنت، فيرجى استخدام رابط الاسترجاع في صفحة تسجيل الدخول فورًا.</p>`;
  return sendEmail({ to, subject: "تم تغيير كلمة المرور", html: wrapHtml("تغيير كلمة المرور", body) });
}

export async function sendDeviceApprovalRequest(
  to: string,
  approvalToken: string,
  ip: string | null,
  ua: string | null,
  publicBaseUrl: string,
) {
  const link = `${publicBaseUrl.replace(/\/$/, "")}/admin/security-superadmin?approve=${encodeURIComponent(approvalToken)}`;
  const body = `
    <p>هناك محاولة تسجيل دخول من <strong>جهاز جديد لم يُعتمد بعد</strong>.</p>
    <p style="color:#64748b; font-size:13px;">
      الوقت: ${new Date().toLocaleString("ar-SA")}<br/>
      عنوان IP: ${ip ?? "غير معروف"}<br/>
      المتصفح: ${ua ?? "غير معروف"}
    </p>
    <p>للموافقة على هذا الجهاز، افتح الرابط التالي من جهاز موثوق ومسجَّل الدخول مسبقًا:</p>
    <p><a href="${link}" style="display:inline-block; background:#10b981; color:#fff; text-decoration:none; padding:10px 18px; border-radius:8px;">مراجعة الطلب</a></p>
    <p style="font-size:12px; color:#94a3b8;">صالح لمدة 15 دقيقة. إذا لم تطلب هذا، تجاهل الرسالة وسيُمنع الجهاز تلقائيًا.</p>`;
  return sendEmail({ to, subject: "طلب اعتماد جهاز جديد", html: wrapHtml("جهاز جديد ينتظر الاعتماد", body) });
}

export async function sendReportsDigest(opts: {
  to: string[];
  frequency: "weekly" | "monthly";
  attachments: EmailAttachment[];
  reportLabels: string[];
}) {
  const freqLabel = opts.frequency === "monthly" ? "الشهري" : "الأسبوعي";
  const list = opts.reportLabels.map(l => `<li>${l}</li>`).join("");
  const body = `
    <p>هذا تقريرك ${freqLabel} الموجز للنظام.</p>
    <p>تجد المرفقات بصيغة CSV قابلة للفتح مباشرة في Excel:</p>
    <ul style="padding-inline-start:18px; line-height:1.8;">${list}</ul>
    <p style="color:#64748b; font-size:13px;">تاريخ الإرسال: ${new Date().toLocaleString("ar-SA")}</p>
    <p style="color:#64748b; font-size:12px;">يمكنك تعديل قائمة التقارير، التكرار، والمستلمين من صفحة التقارير في لوحة المشرف العام.</p>`;
  const subject = opts.frequency === "monthly"
    ? "تقرير المشرف العام الشهري"
    : "تقرير المشرف العام الأسبوعي";
  return sendEmail({
    to: opts.to,
    subject,
    html: wrapHtml(subject, body),
    attachments: opts.attachments,
  });
}

// ─── Maintenance critical-findings digest ────────────────────────────────────
// Sent by the daily sweep when at least one non-OK finding exists and alerts
// aren't snoozed. Each row is one (company, tool) pair so SuperAdmins can
// triage from inbox. `severity` is 'critical' (red) or 'warn' (amber); both
// can appear in the same email — recipient filtering by per-account severity
// threshold happens in the scheduler before send.
export interface MaintenanceDigestRow {
  companyId:   number;
  companyName: string;
  toolKey:     string;
  toolLabelAr: string;
  count:       number;
  runAt:       Date | string;
  severity:    "critical" | "warn";
}

// Companion shape for the second (errored-tool) section appended to the
// digest when at least one tool's latest run threw within the recency window.
// Rendered alongside criticals so SuperAdmins notice silently-broken checks
// — without those, a wedged tool can stay invisible (its 0-count "error" row
// never lifts criticalCount, which is what triggers the alert in the first
// place).
export interface MaintenanceErrorDigestRow {
  companyId:   number;
  companyName: string;
  toolKey:     string;
  toolLabelAr: string;
  error:       string | null;
  runAt:       Date | string;
}

// Companion shape for the third (recovered-tool) section appended to the
// digest. Mirrors `MaintenanceErrorDigestRow` in spirit but in the positive
// direction: the named tool was previously broken (its prior run was an
// 'error') and its latest run completed without error within the recency
// window. Rendered as a small green "recovered tools" block so SuperAdmins
// get explicit confirmation that a fix landed — without it, a recovered
// tool just silently disappears from the error section.
export interface MaintenanceRecoveryDigestRow {
  companyId:       number;
  companyName:     string;
  toolKey:         string;
  toolLabelAr:     string;
  // Status of the recovery run itself: "ok" / "warn" / "critical" — never
  // "error" by definition. Surfaced so a recovery to "warn"/"critical" reads
  // honestly ("ran successfully but found findings") instead of implying a
  // clean bill of health.
  currentStatus:   string;
  previousErrorAt: Date | string;
  recoveredAt:     Date | string;
}

export interface SendMaintenanceDigestOpts {
  to: string[];
  rows: MaintenanceDigestRow[];
  publicBaseUrl: string;
  /** Marks the email as a manual test send so SuperAdmins don't confuse it with a real alert. */
  isTest?: boolean;
  /** True when more critical findings exist than rows shown — caller is responsible for capping. */
  truncated?: boolean;
  /** Tools whose latest run errored within the recency window (last 7d). Optional. */
  errorRows?: MaintenanceErrorDigestRow[];
  /** Tools whose latest run recovered (error → non-error) within the recency window. Optional. */
  recoveryRows?: MaintenanceRecoveryDigestRow[];
}

export async function sendMaintenanceCriticalDigest(opts: SendMaintenanceDigestOpts) {
  const base = opts.publicBaseUrl.replace(/\/$/, "");
  const link = `${base}/admin/ai-fix`;
  const distinctCompanies = new Set(opts.rows.map((r) => r.companyId)).size;
  const truncSuffix = opts.truncated ? " (تم اقتطاع القائمة)" : "";
  // Per-severity counters drive both the subject line and the row colouring
  // so threshold='warning' SuperAdmins see at a glance whether the alert is
  // led by criticals, warnings, or a mix.
  const criticalRowCount = opts.rows.filter((r) => r.severity === "critical").length;
  const warnRowCount     = opts.rows.filter((r) => r.severity === "warn").length;
  const subjectParts: string[] = [];
  if (criticalRowCount > 0) subjectParts.push(`${criticalRowCount} حرجة`);
  if (warnRowCount > 0)     subjectParts.push(`${warnRowCount} تحذير`);
  const subjectBody = subjectParts.length > 0
    ? subjectParts.join(" و ")
    : `${opts.rows.length} نتيجة`;
  const subjectBase = opts.isTest
    ? "اختبار: تنبيه فحص الصيانة"
    : `تنبيه صيانة: ${subjectBody} في ${distinctCompanies} شركة${truncSuffix}`;
  const rowsHtml = opts.rows
    .map((r) => {
      const when = (r.runAt instanceof Date ? r.runAt : new Date(r.runAt)).toLocaleString("ar-SA");
      const escName = String(r.companyName ?? "").replace(/[<>&]/g, (c) =>
        c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
      );
      // Critical rows stay red (#b91c1c) — preserves the prior visual idiom for
      // existing readers. Warn rows render in amber (#b45309) so the two are
      // distinguishable at a glance without needing a separate column.
      const sevLabel = r.severity === "critical" ? "حرجة" : "تحذير";
      const sevColor = r.severity === "critical" ? "#b91c1c" : "#b45309";
      const sevBg    = r.severity === "critical" ? "#fee2e2" : "#fef3c7";
      return `
        <tr>
          <td style="padding:6px 8px; border-bottom:1px solid #f1f5f9;">${escName}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #f1f5f9;">${r.toolLabelAr}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #f1f5f9;">
            <span style="display:inline-block; padding:1px 8px; border-radius:9999px; background:${sevBg}; color:${sevColor}; font-size:11px; font-weight:600;">${sevLabel}</span>
          </td>
          <td style="padding:6px 8px; border-bottom:1px solid #f1f5f9; color:${sevColor}; font-weight:600;">${r.count}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #f1f5f9; color:#64748b; font-size:12px;">${when}</td>
        </tr>`;
    })
    .join("");
  const introCounts: string[] = [];
  if (criticalRowCount > 0) introCounts.push(`<strong>${criticalRowCount}</strong> حرجة`);
  if (warnRowCount > 0)     introCounts.push(`<strong>${warnRowCount}</strong> تحذير`);
  const intro = opts.isTest
    ? `<p>هذه رسالة <strong>تجريبية</strong> أُرسلت من صفحة جدولة الصيانة للتأكد من وصول التنبيهات.</p>`
    : `<p>اكتشف الفحص التلقائي الأخير ${introCounts.join(" و ")} في <strong>${distinctCompanies}</strong> شركة. تفاصيل أدناه:</p>`;
  // Optional second section: tools whose latest run threw within the recency
  // window. We HTML-escape the dynamic strings (company name, error text) here
  // because they originate from the DB / runtime exceptions and would otherwise
  // poison the email body. Limited rendering to keep the email scannable.
  const escHtml = (s: string) =>
    String(s ?? "").replace(/[&<>]/g, (c) =>
      c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
    );
  const errorRowsList = opts.errorRows ?? [];
  const distinctErrorCompanies = new Set(errorRowsList.map((r) => r.companyId)).size;
  const errorRowsHtml = errorRowsList.length === 0 ? "" : `
    <h3 style="font-size:14px; color:#92400e; margin-top:22px; margin-bottom:6px;">
      أدوات صيانة تعطّلت آخر 7 أيام (${errorRowsList.length} في ${distinctErrorCompanies} شركة)
    </h3>
    <p style="font-size:12px; color:#64748b; margin:0 0 6px 0;">
      هذه الفحوصات لم تكتمل بسبب خطأ — تحتاج مراجعة فنية لأن نتائجها لا تدخل في عدّ النتائج الحرجة.
    </p>
    <table style="width:100%; border-collapse:collapse; margin-top:6px; font-size:13px;">
      <thead>
        <tr style="background:#fffbeb; color:#78350f;">
          <th style="padding:8px; text-align:right; border-bottom:2px solid #fde68a;">الشركة</th>
          <th style="padding:8px; text-align:right; border-bottom:2px solid #fde68a;">الأداة</th>
          <th style="padding:8px; text-align:right; border-bottom:2px solid #fde68a;">رسالة الخطأ</th>
          <th style="padding:8px; text-align:right; border-bottom:2px solid #fde68a;">وقت الفحص</th>
        </tr>
      </thead>
      <tbody>
        ${errorRowsList.map((r) => {
          const when = (r.runAt instanceof Date ? r.runAt : new Date(r.runAt)).toLocaleString("ar-SA");
          return `
            <tr>
              <td style="padding:6px 8px; border-bottom:1px solid #fef3c7;">${escHtml(r.companyName)}</td>
              <td style="padding:6px 8px; border-bottom:1px solid #fef3c7;">${escHtml(r.toolLabelAr)}</td>
              <td style="padding:6px 8px; border-bottom:1px solid #fef3c7; color:#92400e; font-family:monospace; font-size:12px;">${escHtml(r.error ?? "")}</td>
              <td style="padding:6px 8px; border-bottom:1px solid #fef3c7; color:#64748b; font-size:12px;">${when}</td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>`;
  // Optional third section: tools that recovered (error → non-error) within
  // the recency window. Rendered in green (#15803d / #dcfce7) so it visually
  // contrasts with the red criticals and amber errors above — at a glance
  // the SuperAdmin sees "this is the good news" without having to read.
  // We map currentStatus → an Arabic badge so a recovery to warn/critical
  // doesn't masquerade as a clean bill of health.
  const recoveryRowsList = opts.recoveryRows ?? [];
  const distinctRecoveryCompanies = new Set(recoveryRowsList.map((r) => r.companyId)).size;
  const recoveryRowsHtml = recoveryRowsList.length === 0 ? "" : `
    <h3 style="font-size:14px; color:#15803d; margin-top:22px; margin-bottom:6px;">
      أدوات صيانة تعافت آخر 7 أيام (${recoveryRowsList.length} في ${distinctRecoveryCompanies} شركة)
    </h3>
    <p style="font-size:12px; color:#64748b; margin:0 0 6px 0;">
      هذه الفحوصات كانت مُعطّلة سابقاً ثم اكتمل تشغيلها بنجاح — لا حاجة لإجراء، عرض للإطمئنان.
    </p>
    <table style="width:100%; border-collapse:collapse; margin-top:6px; font-size:13px;">
      <thead>
        <tr style="background:#f0fdf4; color:#14532d;">
          <th style="padding:8px; text-align:right; border-bottom:2px solid #bbf7d0;">الشركة</th>
          <th style="padding:8px; text-align:right; border-bottom:2px solid #bbf7d0;">الأداة</th>
          <th style="padding:8px; text-align:right; border-bottom:2px solid #bbf7d0;">الحالة الحالية</th>
          <th style="padding:8px; text-align:right; border-bottom:2px solid #bbf7d0;">آخر خطأ</th>
          <th style="padding:8px; text-align:right; border-bottom:2px solid #bbf7d0;">وقت التعافي</th>
        </tr>
      </thead>
      <tbody>
        ${recoveryRowsList.map((r) => {
          const recoveredAt = (r.recoveredAt instanceof Date ? r.recoveredAt : new Date(r.recoveredAt)).toLocaleString("ar-SA");
          const previousErrorAt = (r.previousErrorAt instanceof Date ? r.previousErrorAt : new Date(r.previousErrorAt)).toLocaleString("ar-SA");
          // Badge mirrors the severity badges in the criticals table so the
          // visual idiom is consistent. "ok" stays green, warn = amber,
          // critical = red — same colours as the row colouring above.
          const status = r.currentStatus;
          const statusLabel =
            status === "ok"       ? "سليم"  :
            status === "warn"     ? "تحذير" :
            status === "critical" ? "حرجة"  : status;
          const statusColor =
            status === "ok"       ? "#15803d" :
            status === "warn"     ? "#b45309" :
            status === "critical" ? "#b91c1c" : "#475569";
          const statusBg =
            status === "ok"       ? "#dcfce7" :
            status === "warn"     ? "#fef3c7" :
            status === "critical" ? "#fee2e2" : "#f1f5f9";
          return `
            <tr>
              <td style="padding:6px 8px; border-bottom:1px solid #dcfce7;">${escHtml(r.companyName)}</td>
              <td style="padding:6px 8px; border-bottom:1px solid #dcfce7;">${escHtml(r.toolLabelAr)}</td>
              <td style="padding:6px 8px; border-bottom:1px solid #dcfce7;">
                <span style="display:inline-block; padding:1px 8px; border-radius:9999px; background:${statusBg}; color:${statusColor}; font-size:11px; font-weight:600;">${statusLabel}</span>
              </td>
              <td style="padding:6px 8px; border-bottom:1px solid #dcfce7; color:#64748b; font-size:12px;">${previousErrorAt}</td>
              <td style="padding:6px 8px; border-bottom:1px solid #dcfce7; color:#15803d; font-size:12px;">${recoveredAt}</td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>`;
  const body = `
    ${intro}
    <table style="width:100%; border-collapse:collapse; margin-top:10px; font-size:13px;">
      <thead>
        <tr style="background:#f8fafc; color:#0f172a;">
          <th style="padding:8px; text-align:right; border-bottom:2px solid #e2e8f0;">الشركة</th>
          <th style="padding:8px; text-align:right; border-bottom:2px solid #e2e8f0;">الأداة</th>
          <th style="padding:8px; text-align:right; border-bottom:2px solid #e2e8f0;">الخطورة</th>
          <th style="padding:8px; text-align:right; border-bottom:2px solid #e2e8f0;">العدد</th>
          <th style="padding:8px; text-align:right; border-bottom:2px solid #e2e8f0;">وقت الفحص</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${errorRowsHtml}
    ${recoveryRowsHtml}
    <p style="margin-top:18px;">
      <a href="${link}" style="display:inline-block; background:#7c3aed; color:#fff; text-decoration:none; padding:10px 18px; border-radius:8px;">
        فتح صفحة الإصلاح بالذكاء الاصطناعي
      </a>
    </p>
    <p style="font-size:12px; color:#94a3b8; margin-top:14px;">
      يمكنك تعطيل هذه التنبيهات أو ضبط وقت الفحص اليومي من بطاقة "الفحص التلقائي اليومي" في صفحة الإصلاح.
    </p>`;
  return sendEmail({
    to: opts.to,
    subject: subjectBase,
    html: wrapHtml(opts.isTest ? "اختبار تنبيه الصيانة" : "تنبيه فحص الصيانة الحرج", body),
  });
}

export async function sendRecoveryLink(to: string, token: string, publicBaseUrl: string, ip: string | null) {
  const link = `${publicBaseUrl.replace(/\/$/, "")}/recover-superadmin/${encodeURIComponent(token)}`;
  const body = `
    <p>تلقّينا طلب <strong>استرجاع حساب السوبر أدمن</strong>.</p>
    <p style="color:#64748b; font-size:13px;">
      الوقت: ${new Date().toLocaleString("ar-SA")}<br/>
      عنوان IP: ${ip ?? "غير معروف"}
    </p>
    <p>لمتابعة الاسترجاع، افتح الرابط التالي خلال 30 دقيقة:</p>
    <p><a href="${link}" style="display:inline-block; background:#dc2626; color:#fff; text-decoration:none; padding:10px 18px; border-radius:8px;">استرجاع الحساب</a></p>
    <p style="font-size:12px; color:#94a3b8;">سيؤدي الاسترجاع إلى إنهاء جميع الجلسات وإلغاء جميع الأجهزة الموثوقة وتوليد رموز استرجاع جديدة.</p>`;
  return sendEmail({ to, subject: "استرجاع حساب السوبر أدمن", html: wrapHtml("استرجاع الحساب", body) });
}
