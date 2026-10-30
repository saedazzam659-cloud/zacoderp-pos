// WhatsApp share helper. Opens wa.me with a prefilled message; if a phone is
// supplied it targets that contact directly, otherwise WhatsApp lets the user
// pick a recipient. Uses window.open (the same way UpdatesScreen opens external
// links), falling back to a location change if the popup is blocked.
import { currencySymbol } from "./currency";
import { getDecimals } from "./appSettings";

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
  // Blocked popups usually return null without throwing — fall back to navigating.
  if (!win) location.href = url;
}

export interface DocSummary {
  kind: "invoice" | "quotation" | "return";
  companyName: string;
  docNo: string;
  date: string;
  grandTotal: number;
  customerName?: string | null;
}

const KIND_LABEL: Record<DocSummary["kind"], string> = {
  invoice: "فاتورة مبيعات",
  quotation: "عرض سعر",
  return: "مرتجع مبيعات",
};

/** Build a tidy Arabic summary line block to prefill the WhatsApp message. */
export function buildDocWhatsAppText(s: DocSummary): string {
  const sym = currencySymbol();
  const total = s.grandTotal.toFixed(getDecimals());
  const lines = [
    `*${s.companyName}*`,
    `${KIND_LABEL[s.kind]} رقم: ${s.docNo}`,
    `التاريخ: ${s.date}`,
  ];
  if (s.customerName) lines.push(`العميل: ${s.customerName}`);
  lines.push(`الإجمالي: ${total} ${sym}`);
  lines.push("شكراً لتعاملكم معنا.");
  return lines.join("\n");
}
