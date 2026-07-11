// ─── WhatsApp (Meta Cloud API) transport ───────────────────────────────────
// Sends business-initiated messages via the Meta WhatsApp Cloud API. Meta
// requires ALL business-initiated messages (OTP + backup notification) to use
// PRE-APPROVED templates created in the Meta Business Manager — free-form text
// is only allowed inside a 24h customer-service window, which we never have for
// a backup notification. Template NAMES are therefore configurable via env so
// the operator can point us at whatever they got approved.
//
// Required secrets:
//   WHATSAPP_ACCESS_TOKEN     — permanent/system-user token with whatsapp perms
//   WHATSAPP_PHONE_NUMBER_ID  — the sending phone-number id (NOT the phone)
// Optional config (env, sensible defaults):
//   WHATSAPP_API_VERSION          (default "v21.0")
//   WHATSAPP_TEMPLATE_LANG        (default "ar")
//   WHATSAPP_OTP_TEMPLATE         (default "backup_otp")   — one body param {{1}} = code
//   WHATSAPP_OTP_TEMPLATE_STYLE   ("body_only" | "authentication"; default "body_only")
//   WHATSAPP_BACKUP_TEMPLATE      (default "backup_ready")  — 4 body params: name, date, contents, link

const GRAPH_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

/** True when both mandatory secrets are present. Cheap, sync — safe on hot paths. */
export function whatsappConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

/**
 * Normalise a phone number to WhatsApp's expected form: digits only, no leading
 * "+", no spaces/dashes, "00" international prefix dropped. Returns null when it
 * doesn't look like a plausible international number (7–15 digits).
 */
export function normalizeWhatsappPhone(raw: string): string | null {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[^\d+]/g, "");
  s = s.replace(/^00/, "").replace(/^\+/, "");
  if (!/^\d{7,15}$/.test(s)) return null;
  return s;
}

interface TemplateComponent {
  type: string;
  [k: string]: unknown;
}

async function postMessage(payload: unknown): Promise<{ ok: boolean; reason?: string }> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return { ok: false, reason: "whatsapp_not_configured" };
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.ok) return { ok: true };
    let detail = "";
    try { detail = await resp.text(); } catch { /* ignore */ }
    return { ok: false, reason: `whatsapp_http_${resp.status}:${detail.slice(0, 300)}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "unknown";
    return { ok: false, reason: `whatsapp_error:${msg}` };
  }
}

/**
 * Send a template message. `bodyParams` fill the body's {{1}}..{{n}}
 * placeholders in order; `urlButtonParam` supplies the dynamic value for a
 * URL/copy-code button at index 0 (used by authentication OTP templates).
 */
export async function sendWhatsappTemplate(opts: {
  to: string;
  template: string;
  lang?: string;
  bodyParams?: string[];
  urlButtonParam?: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const to = normalizeWhatsappPhone(opts.to);
  if (!to) return { ok: false, reason: "invalid_phone" };
  const components: TemplateComponent[] = [];
  if (opts.bodyParams?.length) {
    components.push({
      type: "body",
      parameters: opts.bodyParams.map((t) => ({ type: "text", text: String(t) })),
    });
  }
  if (opts.urlButtonParam) {
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: String(opts.urlButtonParam) }],
    });
  }
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: opts.template,
      language: { code: opts.lang || process.env.WHATSAPP_TEMPLATE_LANG || "ar" },
      ...(components.length ? { components } : {}),
    },
  };
  return postMessage(payload);
}

/** Send a verification code. Uses a body-param template by default; set
 *  WHATSAPP_OTP_TEMPLATE_STYLE=authentication for Meta auth templates (which
 *  also carry a copy-code button). */
export async function sendWhatsappOtp(to: string, code: string): Promise<{ ok: boolean; reason?: string }> {
  const template = process.env.WHATSAPP_OTP_TEMPLATE || "backup_otp";
  const style = (process.env.WHATSAPP_OTP_TEMPLATE_STYLE || "body_only").toLowerCase();
  if (style === "authentication") {
    return sendWhatsappTemplate({ to, template, bodyParams: [code], urlButtonParam: code });
  }
  return sendWhatsappTemplate({ to, template, bodyParams: [code] });
}

/** Send the backup-ready notification carrying a secure download link. The
 *  link is placed as the last body parameter; WhatsApp auto-linkifies URLs. */
export async function sendWhatsappBackupNotice(to: string, opts: {
  companyName: string;
  dateStr: string;
  countsSummary: string;
  downloadUrl: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const template = process.env.WHATSAPP_BACKUP_TEMPLATE || "backup_ready";
  return sendWhatsappTemplate({
    to,
    template,
    bodyParams: [opts.companyName, opts.dateStr, opts.countsSummary, opts.downloadUrl],
  });
}
