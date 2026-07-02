// WhatsApp share helper (web ERP). Opens wa.me with a prefilled message; if a
// phone is supplied it targets that contact directly, otherwise WhatsApp lets
// the user pick a recipient. Uses window.open, falling back to a location
// change when the popup is blocked.
//
// NOTE: wa.me cannot attach files. To "share" a document we send a tidy text
// summary plus a secure download link the recipient can open.

function digits(phone?: string | null): string {
  return (phone ?? "").replace(/\D/g, "");
}

export function openWhatsApp(message: string, phone?: string | null): void {
  const d = digits(phone);
  const base = d ? `https://wa.me/${d}` : "https://wa.me/";
  const url = `${base}?text=${encodeURIComponent(message)}`;
  let win: Window | null = null;
  try {
    win = window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    win = null;
  }
  if (!win) location.href = url;
}

export interface DocWhatsAppSummary {
  companyName?: string | null;
  title: string;            // e.g. "سند تسليم" / "سند استلام" / file name
  docNo?: string | null;
  date?: string | null;
  partyName?: string | null;
  link?: string | null;     // optional secure download link
  note?: string | null;
}

/** Build a tidy Arabic message block to prefill a WhatsApp share. */
export function buildDocWhatsAppText(s: DocWhatsAppSummary): string {
  const lines: string[] = [];
  if (s.companyName) lines.push(`*${s.companyName}*`);
  lines.push(s.docNo ? `${s.title} رقم: ${s.docNo}` : s.title);
  if (s.date) lines.push(`التاريخ: ${s.date}`);
  if (s.partyName) lines.push(`الجهة: ${s.partyName}`);
  if (s.note) lines.push(s.note);
  if (s.link) lines.push(`الرابط: ${s.link}`);
  return lines.join("\n");
}
