// Sales-invoice-style A4 print for Credit/Debit account notes (الإشعارات).
//
// Adapted from `pages/sales/SalesPrintModal.tsx` so a printed note carries the
// SAME visual language as a sales invoice (centered logo + title, seller/buyer
// blocks, totals card, ZATCA QR) — but WITHOUT any item-line rows, since a
// note has no line items. The document title sits directly under the logo and
// is driven purely by the note TYPE:
//   credit → "إشعار دائن ضريبي"
//   debit  → "إشعار مدين ضريبي"
//
// Shared by both the note form (`AccountNoteForm.tsx`) and the notes list
// (`AccountNotesList.tsx`) so the two print paths never drift.
import QRCode from "qrcode";
import { safeLogoSrc } from "@/lib/export";
import { currencySymbol } from "@/lib/format";
import type { AccountNote, AccountNoteType } from "@/lib/accountNotesApi";

// Number formatter mirroring SalesPrintModal: Arabic-Indic digits with all
// invisible BiDi control codepoints stripped so Windows fonts never render a
// stray ".notdef" vertical-stroke next to the totals.
const NUM_FMT = new Intl.NumberFormat("ar-SA-u-nu-arab", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STRIP_INVISIBLE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const fmt = (n: any) => NUM_FMT.format(Number(n || 0)).replace(STRIP_INVISIBLE, "");

function esc(s: any): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// ── Arabic number-to-words (tafqeet) — copied from SalesPrintModal so this
// module stays self-contained. Handles up to 999,999,999.99.
function numberToArabicWords(n: number): string {
  if (!isFinite(n) || n < 0 || n > 999999999.99) return String(n);
  const ones = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة",
    "عشرة", "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر",
    "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"];
  const tens = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
  const hundreds = ["", "مائة", "مائتان", "ثلاثمائة", "أربعمائة", "خمسمائة",
    "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة"];
  const under1000 = (x: number): string => {
    if (x === 0) return "";
    const h = Math.floor(x / 100); const r = x % 100; const parts: string[] = [];
    if (h) parts.push(hundreds[h]!);
    if (r < 20) { if (r) parts.push(ones[r]!); }
    else {
      const t = Math.floor(r / 10); const o = r % 10;
      if (o) parts.push(`${ones[o]} و${tens[t]}`); else parts.push(tens[t]!);
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
  return `فقط ${out} ريال سعودي لا غير`;
}

// ── ZATCA TLV QR (Phase-1, 5 mandatory tags) → data URL ──────────────────
function buildTlvBase64(company: any, note: AccountNote, total: number, vat: number): string {
  const enc = new TextEncoder();
  const pieces: Uint8Array[] = [];
  const push = (tag: number, val: string) => {
    const bytes = enc.encode(val);
    pieces.push(Uint8Array.from([tag, bytes.length]));
    pieces.push(bytes);
  };
  push(1, String(company?.nameAr ?? company?.nameEn ?? ""));
  push(2, String(company?.vatNumber ?? ""));
  let ts = "";
  if (note.noteDate) {
    try {
      const dt = new Date(note.noteDate);
      if (!isNaN(dt.getTime())) ts = dt.toISOString().replace(/\.\d{3}Z$/, "Z");
    } catch { /* noop */ }
  }
  if (!ts) ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  push(3, ts);
  push(4, total.toFixed(2));
  push(5, vat.toFixed(2));
  const totalLen = pieces.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const p of pieces) { out.set(p, off); off += p.length; }
  let bin = "";
  for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]!);
  return btoa(bin);
}

async function buildZatcaQrDataUrl(company: any, note: AccountNote, total: number, vat: number): Promise<string> {
  try {
    const b64 = buildTlvBase64(company, note, total, vat);
    return await QRCode.toDataURL(b64, { width: 220, margin: 1, errorCorrectionLevel: "M" });
  } catch { return ""; }
}

function noteTitle(noteType: AccountNoteType): string {
  return noteType === "credit" ? "إشعار دائن ضريبي" : "إشعار مدين ضريبي";
}

function companyBlock(c: any): string {
  return `
    <div>
      <div style="font-size:15px;font-weight:700;">${esc(c?.nameAr ?? "اسم الشركة")}</div>
      ${c?.nameEn ? `<div style="font-size:10px;opacity:.7;">${esc(c.nameEn)}</div>` : ""}
      ${c?.vatNumber ? `<div>الرقم الضريبي: ${esc(c.vatNumber)}</div>` : ""}
      ${c?.crNumber  ? `<div>السجل التجاري: ${esc(c.crNumber)}</div>`  : ""}
      ${c?.city      ? `<div>${esc(c.city)}${c.country ? ` — ${esc(c.country)}` : ""}</div>` : ""}
    </div>`;
}

function partyBlock(p: any, partyLabel: string): string {
  if (!p) return "<div>—</div>";
  const vat = p.vatNumber ?? p.taxNumber;
  const code = p.code ?? p.customerCode ?? p.supplierCode;
  return `
    <div style="line-height:1.8;">
      <div style="font-weight:700;font-size:13px;">${esc(p.nameAr ?? p.nameEn ?? "—")}</div>
      ${code      ? `<div>رمز ${esc(partyLabel)}: ${esc(code)}</div>` : ""}
      ${vat       ? `<div>الرقم الضريبي: ${esc(vat)}</div>` : ""}
      ${p.phone   ? `<div>هاتف: ${esc(p.phone)}</div>` : ""}
      ${p.city    ? `<div>${esc(p.city)}</div>` : ""}
    </div>`;
}

export interface PrintAccountNoteOpts {
  note: AccountNote;
  party?: any | null;
  company?: any | null;
  /** "العميل" | "المورد" — section heading for the party block. */
  partyLabel: string;
  /** معد الإشعار — name of the user who prepared the note. */
  preparedBy?: string | null;
  /** Called with an Arabic message when the popup can't be opened. */
  onError?: (msg: string) => void;
}

// Renders the note into a new print window styled like the classic sales
// invoice (accent #2563eb). The window is opened SYNCHRONOUSLY (popup-blocker
// safe) and filled once the async QR is ready.
export async function printAccountNote(opts: PrintAccountNoteOpts): Promise<void> {
  const { note, party, company, partyLabel, preparedBy, onError } = opts;

  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) {
    onError?.("تعذّر فتح نافذة الطباعة — اسمح بالنوافذ المنبثقة");
    return;
  }
  // Placeholder while the QR generates so the tab isn't blank.
  win.document.write('<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>…</title></head><body style="font-family:Tahoma,Arial,sans-serif;padding:40px;text-align:center;color:#666">جاري تحضير الطباعة…</body></html>');

  const amount = Number(note.amount || 0);
  const vat    = note.vatEnabled ? Number(note.vatAmount || 0) : 0;
  const total  = Number(note.totalAmount || 0);
  const sym    = currencySymbol("SAR");
  const title  = noteTitle(note.noteType);
  const statusLabel = note.status === "posted" ? "مُرحَّل" : note.status === "cancelled" ? "ملغي" : "مسودة";
  const safeLogo = safeLogoSrc(company?.logo);

  const qrUrl = await buildZatcaQrDataUrl(company, note, total, vat);
  const qrHtml = qrUrl
    ? `<img src="${qrUrl}" alt="QR ZATCA" width="110" height="110" style="display:block;padding:3px;border-radius:4px;" />`
    : `<div style="width:110px;height:110px;border:1.5px dashed #999;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#999;font-size:10px;text-align:center;background:#fafafa;">QR<br/>ZATCA</div>`;

  const totalsRows = `
    <div class="trow"><span style="color:#666">المبلغ قبل الضريبة — Amount</span><span class="mono">${fmt(amount)} ${sym}</span></div>
    ${note.vatEnabled ? `<div class="trow"><span style="color:#666">ضريبة القيمة المضافة (${fmt(note.vatRate)}%) — VAT</span><span class="mono" style="color:#b45309;">${fmt(vat)} ${sym}</span></div>` : ""}
    <div class="trow grand"><span>الإجمالي شامل الضريبة — Total</span><span class="mono">${fmt(total)} ${sym}</span></div>`;

  const docMetaRows = `
    <div class="row"><span class="k">رقم الإشعار</span><span class="v">${esc(note.noteNumber ?? String(note.id))}</span></div>
    <div class="row"><span class="k">تاريخ الإشعار</span><span class="v">${esc(note.noteDate ?? "—")}</span></div>
    <div class="row"><span class="k">رقم فاتورة ${partyLabel === "المورد" ? "المشتريات" : "المبيعات"}</span><span class="v">${esc(note.referenceNumber ?? "—")}</span></div>
    ${note.operationNumber ? `<div class="row"><span class="k">رقم العملية</span><span class="v">${esc(note.operationNumber)}</span></div>` : ""}
    ${note.journalEntryId ? `<div class="row"><span class="k">رقم القيد</span><span class="v">#${esc(note.journalEntryId)}</span></div>` : ""}
    <div class="row"><span class="k">الحالة</span><span class="v">${esc(statusLabel)}</span></div>
    ${preparedBy ? `<div class="row"><span class="k">المُعِدّ</span><span class="v">${esc(preparedBy)}</span></div>` : ""}`;

  const statementText = esc(note.description ?? note.notes ?? "");
  const extraNotes = (note.description && note.notes) ? esc(note.notes) : "";

  const html = `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${esc(title)} ${esc(note.noteNumber ?? "")}</title>
  <style>
    @page { size: A4; margin: 12mm 14mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; }
    body { direction: rtl; background: #fff; color: #1a1a1a; font-size: 11px; }
    .mono { font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: isolate; }
    /* ── Top bar (ABOVE blue line): company data + enlarged logo ── */
    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 18px;
              border-bottom: 2px solid #2563eb; padding-bottom: 12px; margin-bottom: 14px; }
    .topbar .co { line-height: 1.7; font-size: 11px; color: #374151; }
    .topbar .co .nm { font-size: 17px; font-weight: 800; color: #111827; }
    .topbar .co .en { font-size: 10px; opacity: .7; }
    .topbar .logo { flex-shrink: 0; }
    .topbar .logo img { max-height: 100px; max-width: 230px; object-fit: contain; display: block; }
    /* ── Centered title (BELOW blue line) ── */
    .title-center { text-align: center; font-size: 22px; font-weight: 800; color: #2563eb; margin: 4px 0 16px; }
    /* ── Mid grid: customer (right) + doc meta (left) ── */
    .midgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
    .section { border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 14px; }
    .section h4 { font-size: 11px; color: #1a1a1a; border-bottom: 1px solid #e5e7eb; margin-bottom: 8px; padding-bottom: 4px; font-weight: 700; }
    .docmeta .row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px dashed #eef2f7; font-size: 12px; }
    .docmeta .row:last-child { border-bottom: none; }
    .docmeta .row .k { color: #6b7280; }
    .docmeta .row .v { font-weight: 700; color: #111827; }
    /* ── Enlarged statement box ── */
    .statement { border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 16px; }
    .statement .lbl { background: #f8fafc; border-bottom: 1px solid #e5e7eb; padding: 6px 12px; font-weight: 700; color: #2563eb; font-size: 12px; }
    .statement .body { padding: 12px 14px; min-height: 80px; font-size: 12px; line-height: 1.8; white-space: pre-wrap; color: #1f2937; }
    /* ── Totals + QR (pushed down) ── */
    .totals-wrap { display: flex; justify-content: flex-start; gap: 18px; align-items: flex-start; margin-top: 10px; }
    .totals-card { min-width: 300px; border: 1px solid #ddd; border-radius: 6px; padding: 12px 16px; }
    .trow { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 12px; color: #374151; }
    .trow.grand { border-top: 2px solid #ddd; padding-top: 6px; margin-top: 4px; font-size: 14px; font-weight: 700; color: #0f172a; }
    .words { margin-top: 10px; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 12px; font-size: 11px; background: #fafafa; font-weight: 700; color: #0f172a; line-height: 1.5; }
    .qrwrap { text-align: center; }
    /* ── Signatures + stamp ── */
    .signs { display: flex; justify-content: space-between; gap: 20px; margin-top: 34px; }
    .sign { flex: 1; text-align: center; }
    .sign .line { border-top: 1px solid #9ca3af; margin-top: 44px; padding-top: 5px; font-size: 11px; color: #374151; }
    .stamp { border: 2px dashed #ccc; border-radius: 50%; width: 88px; height: 88px; display: flex; align-items: center; justify-content: center; color: #ccc; font-size: 10px; text-align: center; margin: 0 auto; }
    /* ── Page footer (numbering + print info) ── */
    .pagefoot { display: flex; justify-content: space-between; align-items: center; margin-top: 22px; padding-top: 8px; border-top: 1px solid #eef2f7; font-size: 10px; color: #9ca3af; }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
  </head><body>
    <div class="topbar">
      <div class="co">
        <div class="nm">${esc(company?.nameAr ?? "اسم الشركة")}</div>
        ${company?.nameEn ? `<div class="en">${esc(company.nameEn)}</div>` : ""}
        ${company?.vatNumber ? `<div>الرقم الضريبي: ${esc(company.vatNumber)}</div>` : ""}
        ${company?.crNumber  ? `<div>السجل التجاري: ${esc(company.crNumber)}</div>`  : ""}
        ${company?.city      ? `<div>${esc(company.city)}${company.country ? ` — ${esc(company.country)}` : ""}</div>` : ""}
      </div>
      <div class="logo">${safeLogo ? `<img src="${safeLogo}" alt="" />` : ""}</div>
    </div>
    <div class="title-center">${esc(title)}</div>
    <div class="midgrid">
      <div class="section"><h4>بيانات ${esc(partyLabel)}</h4>${partyBlock(party, partyLabel)}</div>
      <div class="section docmeta"><h4>بيانات الإشعار</h4>${docMetaRows}</div>
    </div>
    <div class="statement">
      <div class="lbl">بيان السند</div>
      <div class="body">${statementText}</div>
    </div>
    ${extraNotes ? `<div class="statement"><div class="lbl">ملاحظات</div><div class="body" style="min-height:auto;">${extraNotes}</div></div>` : ""}
    <div class="totals-wrap">
      <div class="qrwrap">
        ${qrHtml}
        <div style="font-size:9px;color:#666;margin-top:4px;">رمز QR — ZATCA</div>
      </div>
      <div class="totals-card">
        ${totalsRows}
        <div class="words">${esc(numberToArabicWords(total))}</div>
      </div>
    </div>
    <div class="signs">
      <div class="sign"><div class="line">مدير الحسابات</div></div>
      <div class="sign"><div class="stamp">ختم<br>الشركة</div></div>
      <div class="sign"><div class="line">التوقيع المفوّض</div></div>
    </div>
    <div class="pagefoot">
      <div>تم إنشاؤه بنظام الفاتورة الإلكترونية ZATCA — طُبع في ${esc(new Date().toLocaleString("ar-EG"))}</div>
      <div>صفحة ١ من ١</div>
    </div>
    <script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script>
  </body></html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}
