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

export function emailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export interface SendOpts {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(opts: SendOpts): Promise<{ ok: boolean; reason?: string }> {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn("[email] SMTP not configured — skipping send", { to: opts.to, subject: opts.subject });
    return { ok: false, reason: "smtp_not_configured" };
  }
  try {
    await transporter.sendMail({
      from: getFrom(),
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
    return { ok: true };
  } catch (err: any) {
    console.error("[email] send failed", err?.message ?? err);
    return { ok: false, reason: err?.message ?? "send_failed" };
  }
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
