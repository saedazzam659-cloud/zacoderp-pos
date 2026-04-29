// Standalone print HTML builders for receipt vouchers (سند قبض) and
// payment vouchers (سند صرف). Shared between CustomerSettlement and
// SupplierSettlement so the layout — and the security treatment of the
// company logo — stays in lock-step. Each builder produces a complete
// HTML document with an inline auto-print script so the caller only
// has to write it into a freshly-opened popup.
//
// Two layouts are supported via the `template` arg:
//   - "a4":      full A4 page with party blocks, totals, signature line
//   - "thermal": narrow 80 mm receipt suitable for thermal printers

import { safeLogoSrc } from "./export";

export type VoucherKind = "receipt" | "payment";
export type VoucherTemplate = "a4" | "thermal";

export interface VoucherCompany {
  nameAr?: string | null;
  nameEn?: string | null;
  vatNumber?: string | null;
  crNumber?: string | null;
  city?: string | null;
  street?: string | null;
  buildingNumber?: string | null;
  postalCode?: string | null;
  logo?: string | null;
}

export interface VoucherDoc {
  docNumber?: string | null;
  id?: number | string;
  settlementDate?: string | null;
  paymentMethod?: string | null;
  amount?: number | string | null;
  currencyCode?: string | null;
  exchangeRate?: number | string | null;
  notes?: string | null;
}

export interface VoucherCounterparty {
  nameAr?: string | null;
  nameEn?: string | null;
  vatNumber?: string | null;
  phone?: string | null;
}

export interface VoucherAccount {
  code?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
}

export interface BuildVoucherArgs {
  kind: VoucherKind;
  template: VoucherTemplate;
  doc: VoucherDoc;
  counterparty: VoucherCounterparty | null;
  account: VoucherAccount | null;
  company: VoucherCompany | null;
}

const escapeHtml = (s: any): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );

const fmtMoney = (n: any): string =>
  Number(n || 0).toLocaleString("ar-SA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function paymentMethodLabel(m?: string | null): string {
  if (m === "cash")  return "نقدي";
  if (m === "check") return "شيك";
  return "تحويل بنكي";
}

/** Convert a positive number to Arabic words. Best-effort, accuracy-good-
 *  enough for cheque amounts up to 999,999,999.99. Falls back to digits
 *  if anything looks off, so we never print something misleading. */
function numberToArabicWords(n: number): string {
  if (!isFinite(n) || n < 0 || n > 999999999.99) return String(n);
  const ones = [
    "", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة",
    "عشرة", "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر",
    "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر",
  ];
  const tens = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
  const hundreds = [
    "", "مائة", "مائتان", "ثلاثمائة", "أربعمائة", "خمسمائة",
    "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة",
  ];
  const under1000 = (x: number): string => {
    if (x === 0) return "";
    const h = Math.floor(x / 100);
    const r = x % 100;
    const parts: string[] = [];
    if (h) parts.push(hundreds[h]!);
    if (r < 20) {
      if (r) parts.push(ones[r]!);
    } else {
      const t = Math.floor(r / 10);
      const o = r % 10;
      if (o) parts.push(`${ones[o]} و${tens[t]}`);
      else parts.push(tens[t]!);
    }
    return parts.join(" و");
  };
  const intPart = Math.floor(n);
  const fracPart = Math.round((n - intPart) * 100);
  const millions = Math.floor(intPart / 1000000);
  const thousands = Math.floor((intPart % 1000000) / 1000);
  const rest = intPart % 1000;
  const segments: string[] = [];
  if (millions) {
    if (millions === 1) segments.push("مليون");
    else if (millions === 2) segments.push("مليونان");
    else if (millions <= 10) segments.push(`${under1000(millions)} ملايين`);
    else segments.push(`${under1000(millions)} مليون`);
  }
  if (thousands) {
    if (thousands === 1) segments.push("ألف");
    else if (thousands === 2) segments.push("ألفان");
    else if (thousands <= 10) segments.push(`${under1000(thousands)} آلاف`);
    else segments.push(`${under1000(thousands)} ألف`);
  }
  if (rest) segments.push(under1000(rest));
  let out = segments.join(" و") || "صفر";
  if (fracPart > 0) out += ` و ${under1000(fracPart)} هللة`;
  return `${out} ريال سعودي فقط لا غير`;
}

function logoBlockHtml(company: VoucherCompany | null, maxH = 60): string {
  const safe = safeLogoSrc(company?.logo);
  if (!safe) return "";
  return `<div style="margin-bottom:6px;text-align:center;"><img src="${safe}" alt="" style="max-height:${maxH}px;max-width:180px;object-fit:contain;display:inline-block;" /></div>`;
}

/* ─── A4 layout ──────────────────────────────────────────────────────── */

function buildA4(args: BuildVoucherArgs): string {
  const { kind, doc, counterparty, account, company } = args;
  const isReceipt = kind === "receipt";
  const titleAr = isReceipt ? "سند قبض" : "سند صرف";
  const partyLabel = isReceipt ? "المُستلَم منه" : "المدفوع له";
  const fallbackPrefix = isReceipt ? "CR" : "SP";
  const docNumber = doc.docNumber || `${fallbackPrefix}-${doc.id ?? "—"}`;
  const amountNumber = Number(doc.amount || 0);
  const currency = doc.currencyCode || "SAR";
  const amountInWords = numberToArabicWords(amountNumber);
  const today = new Date().toLocaleDateString("ar-SA");
  const accountLabel = account
    ? `${escapeHtml(account.code ?? "")} — ${escapeHtml(account.nameAr || account.nameEn || "")}`
    : "—";
  const counterpartyName = counterparty
    ? escapeHtml(counterparty.nameAr || counterparty.nameEn || "—")
    : "—";
  const counterpartyVat = counterparty?.vatNumber ? escapeHtml(counterparty.vatNumber) : "";
  const companyAddress = [company?.street, company?.buildingNumber, company?.city]
    .filter(Boolean)
    .map(escapeHtml)
    .join(" — ");
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${escapeHtml(titleAr)} — ${escapeHtml(docNumber)}</title>
<style>
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; padding:0; }
.header { text-align:center; border-bottom: 3px double #1e3a8a; padding-bottom: 10px; margin-bottom: 14px; }
.header .company { font-size:15px; font-weight:700; color:#1e3a8a; margin-bottom:2px; }
.header .meta { font-size:11px; color:#555; }
.title-bar { background:${isReceipt ? "#15803d" : "#b45309"}; color:#fff; padding:8px 14px; border-radius:6px; display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; font-size:14px; font-weight:700; }
.info-grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:6px 14px; font-size:12px; margin-bottom:14px; padding:10px; border:1px solid #e5e7eb; border-radius:6px; background:#fafbfd; }
.info-grid .lbl { color:#6b7280; font-size:10px; }
.info-grid .val { font-weight:600; }
.party-box { border:1px solid #e5e7eb; border-radius:6px; padding:10px 14px; margin-bottom:14px; font-size:12px; background:#f9fafb; }
.party-box .lbl { color:#6b7280; font-size:10px; margin-bottom:4px; display:block; }
.party-box .val { font-weight:600; font-size:14px; }
.amount-box { border:2px solid #1e3a8a; border-radius:6px; padding:12px 16px; margin-bottom:14px; background:#eff6ff; display:flex; justify-content:space-between; align-items:center; }
.amount-box .digits { font-family:"Consolas",monospace; font-size:22px; font-weight:700; color:#1e3a8a; }
.amount-box .words { font-size:13px; color:#1e3a8a; max-width:65%; text-align:left; }
.notes-box { font-size:12px; padding:10px 14px; border:1px dashed #cbd5e1; border-radius:6px; margin-bottom:18px; background:#fff; }
.notes-box .lbl { color:#6b7280; font-size:10px; display:block; margin-bottom:2px; }
.signatures { display:grid; grid-template-columns:1fr 1fr; gap:30px; margin-top:30px; font-size:12px; }
.signatures .sig-line { border-top:1px solid #111; padding-top:6px; text-align:center; min-height:50px; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة / حفظ PDF</button>
<div class="header">
  ${logoBlockHtml(company, 60)}
  ${company?.nameAr ? `<div class="company">${escapeHtml(company.nameAr)}</div>` : ""}
  ${companyAddress ? `<div class="meta">${companyAddress}</div>` : ""}
  ${company?.vatNumber ? `<div class="meta">الرقم الضريبي: ${escapeHtml(company.vatNumber)}</div>` : ""}
</div>
<div class="title-bar">
  <span>${escapeHtml(titleAr)}</span>
  <span>${escapeHtml(docNumber)}</span>
</div>
<div class="info-grid">
  <div><div class="lbl">رقم المستند</div><div class="val">${escapeHtml(docNumber)}</div></div>
  <div><div class="lbl">التاريخ</div><div class="val">${escapeHtml(doc.settlementDate ?? today)}</div></div>
  <div><div class="lbl">طريقة الدفع</div><div class="val">${escapeHtml(paymentMethodLabel(doc.paymentMethod))}</div></div>
  <div><div class="lbl">العملة</div><div class="val">${escapeHtml(currency)}</div></div>
  <div><div class="lbl">سعر الصرف</div><div class="val">${escapeHtml(doc.exchangeRate ?? "1")}</div></div>
  <div><div class="lbl">حساب البنك / الخزنة</div><div class="val">${accountLabel}</div></div>
</div>
<div class="party-box">
  <span class="lbl">${escapeHtml(partyLabel)}</span>
  <div class="val">${counterpartyName}</div>
  ${counterpartyVat ? `<div style="font-size:11px;color:#6b7280;margin-top:4px;">الرقم الضريبي: ${counterpartyVat}</div>` : ""}
</div>
<div class="amount-box">
  <div class="digits">${fmtMoney(amountNumber)} ${escapeHtml(currency)}</div>
  <div class="words">${escapeHtml(amountInWords)}</div>
</div>
${doc.notes ? `<div class="notes-box"><span class="lbl">ملاحظات</span>${escapeHtml(doc.notes)}</div>` : ""}
<div class="signatures">
  <div class="sig-line">توقيع المُحاسب</div>
  <div class="sig-line">توقيع ${isReceipt ? "المستلم" : "المُستفيد"}</div>
</div>
<script>setTimeout(()=>window.print(),300);</script>
</body></html>`;
}

/* ─── Thermal 80 mm layout ───────────────────────────────────────────── */

function buildThermal(args: BuildVoucherArgs): string {
  const { kind, doc, counterparty, account, company } = args;
  const isReceipt = kind === "receipt";
  const titleAr = isReceipt ? "سند قبض" : "سند صرف";
  const partyLabel = isReceipt ? "المُستلَم منه" : "المدفوع له";
  const fallbackPrefix = isReceipt ? "CR" : "SP";
  const docNumber = doc.docNumber || `${fallbackPrefix}-${doc.id ?? "—"}`;
  const amountNumber = Number(doc.amount || 0);
  const currency = doc.currencyCode || "SAR";
  const today = new Date().toLocaleDateString("ar-SA");
  const accountLabel = account
    ? `${escapeHtml(account.code ?? "")} — ${escapeHtml(account.nameAr || account.nameEn || "")}`
    : "—";
  const counterpartyName = counterparty
    ? escapeHtml(counterparty.nameAr || counterparty.nameEn || "—")
    : "—";
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${escapeHtml(titleAr)} — ${escapeHtml(docNumber)}</title>
<style>
@page { size: 80mm auto; margin: 3mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#000; margin:0; padding:0; width:74mm; font-size:11px; line-height:1.4; }
.center { text-align:center; }
.bold { font-weight:700; }
.h1 { font-size:14px; font-weight:700; margin:6px 0 2px; }
.h2 { font-size:13px; font-weight:700; margin:6px 0; padding:4px 0; border-top:1px dashed #000; border-bottom:1px dashed #000; }
.row { display:flex; justify-content:space-between; padding:1px 0; font-size:11px; }
.row .lbl { color:#333; }
.row .val { font-weight:600; }
.amount { text-align:center; font-size:18px; font-weight:700; margin:8px 0; padding:6px 0; border-top:2px solid #000; border-bottom:2px solid #000; }
.notes { font-size:10px; padding:4px 0; border-top:1px dashed #000; margin-top:4px; }
.footer { text-align:center; font-size:10px; margin-top:10px; padding-top:4px; border-top:1px dashed #000; color:#333; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } body { width:auto; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة / حفظ PDF</button>
${logoBlockHtml(company, 50)}
${company?.nameAr ? `<div class="center bold" style="font-size:13px;">${escapeHtml(company.nameAr)}</div>` : ""}
${company?.vatNumber ? `<div class="center" style="font-size:10px;">ض.ق.م: ${escapeHtml(company.vatNumber)}</div>` : ""}
<div class="h2 center">${escapeHtml(titleAr)}</div>
<div class="row"><span class="lbl">رقم</span><span class="val">${escapeHtml(docNumber)}</span></div>
<div class="row"><span class="lbl">التاريخ</span><span class="val">${escapeHtml(doc.settlementDate ?? today)}</span></div>
<div class="row"><span class="lbl">${escapeHtml(partyLabel)}</span><span class="val">${counterpartyName}</span></div>
<div class="row"><span class="lbl">طريقة الدفع</span><span class="val">${escapeHtml(paymentMethodLabel(doc.paymentMethod))}</span></div>
<div class="row"><span class="lbl">الحساب</span><span class="val" style="font-size:10px;">${accountLabel}</span></div>
<div class="amount">${fmtMoney(amountNumber)} ${escapeHtml(currency)}</div>
${doc.notes ? `<div class="notes"><span class="bold">ملاحظات: </span>${escapeHtml(doc.notes)}</div>` : ""}
<div class="footer">شكراً لتعاملكم</div>
<script>setTimeout(()=>window.print(),300);</script>
</body></html>`;
}

/** Public entry point: returns a complete HTML document ready for
 *  `popup.document.write()`. */
export function buildVoucherPrintHtml(args: BuildVoucherArgs): string {
  return args.template === "thermal" ? buildThermal(args) : buildA4(args);
}

/** Convenience helper: opens a new window and writes the HTML into it.
 *  Returns false when the popup was blocked by the browser so the caller
 *  can fall back to a toast. */
export function openVoucherPrintWindow(html: string): boolean {
  const w = window.open("", "_blank", "width=900,height=800");
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}
