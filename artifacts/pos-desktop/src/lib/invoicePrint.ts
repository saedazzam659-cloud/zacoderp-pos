// Sales-document printing for the desktop app. Two templates:
//   • A4 — a port of the web app's "classic" tax-invoice layout.
//   • thermal — an 80 mm receipt layout for thermal printers.
// Both are printed inside a standalone hidden iframe (its own document, no
// clipping ancestors) — the same isolation pattern JournalEntries uses. The
// ZATCA QR is rendered from the stored TLV (base64) via the `qrcode` lib, the
// same way the web builds it.
import QRCode from "qrcode";
import { getCompanyProfile, getDecimals, type CompanyProfile } from "./appSettings";
import { currencySymbol, baseCurrencyCode, currencyByCode } from "./currency";
import { isZatcaCountry } from "./zatcaBridge";
import type { SalesLine } from "./accounting";

export type PrintKind = "a4" | "thermal";
export type PrintDocKind = "invoice" | "return";

export interface PrintDoc {
  kind: PrintDocKind;
  docNo: string;
  date: string;
  customerName: string | null;
  customerVat?: string | null;
  paymentMethod: "credit" | "cash" | "bank";
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
  notes: string | null;
  lines: SalesLine[];
  /** ZATCA TLV QR (base64). null/empty when not a ZATCA install / not bridged. */
  qrBase64?: string | null;
}

const PAYMENT_LABEL: Record<PrintDoc["paymentMethod"], string> = {
  credit: "آجل", cash: "نقدي", bank: "تحويل بنكي",
};

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function fmt(n: number, dp = getDecimals()): string {
  return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function docTitle(kind: PrintDocKind): string {
  return kind === "invoice" ? "فاتورة ضريبية" : "إشعار دائن (مرتجع مبيعات)";
}

// ─── ZATCA QR (TLV base64 → PNG data URL) ─────────────────────────────
async function buildQrDataUrl(base64Tlv: string | null | undefined): Promise<string> {
  if (!base64Tlv) return "";
  try {
    const binary = atob(base64Tlv);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    // The byte-array form of toDataURL is untyped in @types/qrcode; cast to any
    // (same approach the web app uses) — TLV bytes must print verbatim, not as
    // a UTF-8 string segment.
    return await QRCode.toDataURL(Array.from(bytes) as any, {
      width: 200, margin: 1, errorCorrectionLevel: "M",
    });
  } catch {
    return "";
  }
}

// ─── A4 — "النموذج الأصلي" (a faithful port of the web app's template #14) ──
// 3-column header (company right / logo+title+pills center / customer left),
// gold accents, borderless zebra lines table, totals + QR cards, audit footer.
function buildA4Html(doc: PrintDoc, co: CompanyProfile, qrDataUrl: string, zatca: boolean): string {
  const dp = co.decimals ?? 2;
  const sym = currencySymbol();
  const logo = co.logo;
  const isReturn = doc.kind === "return";
  const isSimplified = !doc.customerVat;
  // Outside Saudi Arabia, drop all tax-authority ("ضريبية"/"Tax") wording.
  const titleMain = isReturn
    ? (zatca ? (isSimplified ? "مرتجع مبيعات مبسط" : "مرتجع مبيعات ضريبي") : "مرتجع مبيعات")
    : (zatca ? (isSimplified ? "فاتورة مبيعات مبسطة" : "فاتورة مبيعات ضريبية") : "فاتورة مبيعات");
  const titleSub = isReturn
    ? "Sales Return"
    : (zatca ? (isSimplified ? "Simplified Tax Invoice" : "Tax Invoice") : "Sales Invoice");

  // Only show the discount/free columns when at least one line uses them.
  const showFree = doc.lines.some((l) => (Number(l.freeQty) || 0) > 0);
  // Rendered columns: #, item, qty, [free], uom, unit price, [vat%, vat value], total.
  // The two tax columns are dropped entirely outside Saudi Arabia.
  const colCount = 6 + (zatca ? 2 : 0) + (showFree ? 1 : 0);

  const rows = doc.lines.map((l, i) => {
    const net = Number(l.lineTotal) || 0;
    const rate = Number(l.vatRate) || 0;
    const vat = net * (rate / 100);
    // Without tax, the line total is just the net amount.
    const tot = zatca ? net + vat : net;
    const freeQ = Number(l.freeQty) || 0;
    const note = (l.note ?? "").toString().trim();
    const itemRow = `
        <tr class="item-row">
          <td>${i + 1}</td>
          <td>${esc(l.itemName ?? "")}</td>
          <td class="mono">${esc(l.qty)}</td>
          ${showFree ? `<td class="mono" style="color:#b45309;font-weight:600;">${freeQ > 0 ? esc(freeQ) : "—"}</td>` : ""}
          <td>${l.uomName ? esc(l.uomName) : "—"}</td>
          <td class="mono">${fmt(l.unitPrice, dp)}</td>
          ${zatca ? `<td class="mono">${esc(rate)}%</td>` : ""}
          ${zatca ? `<td class="mono">${fmt(vat, dp)}</td>` : ""}
          <td class="mono" style="font-weight:600;">${fmt(tot, dp)}</td>
        </tr>`;
    const notesRow = note
      ? `<tr class="line-notes"><td colspan="${colCount}"><span class="nlbl">📝 ملاحظة:</span>${esc(note)}</td></tr>`
      : "";
    return itemRow + notesRow;
  }).join("");

  return `<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>${esc(titleMain)} — ${esc(doc.docNo)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 10mm; }
  :root { --ink:#0f172a; --line:#e5e7eb; --soft:#f8fafc; --gold:#b88a2a; --gold2:#e5c277; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 12px; color: var(--ink); background: #fff; direction: rtl; }
  .sheet { max-width: 800px; margin: 0 auto; }
  .mono { font-family: 'Segoe UI', monospace; }

  /* ── 3-column header ─────────────────────────────────────────────── */
  .hdr { display:grid; grid-template-columns: 1fr 1.1fr 1fr; gap:12px; align-items:stretch; margin-bottom:14px; }
  .col-co, .col-cu { background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .col-co .label, .col-cu .label { font-size:10px; letter-spacing:.08em; color:var(--gold); font-weight:800; margin-bottom:6px; border-bottom:1px solid var(--line); padding-bottom:4px; }
  .col-co .row, .col-cu .row { display:flex; gap:6px; align-items:baseline; margin-top:4px; font-size:11px; color:#334155; }
  .col-co .row b, .col-cu .row b { color:var(--ink); font-weight:700; min-width:70px; }
  .col-co .co-name-ar { font-size:16px; font-weight:800; color:var(--ink); margin-bottom:6px; }
  .col-cu .cu-name { font-size:15px; font-weight:800; color:var(--ink); margin-bottom:6px; }

  /* ── Center logo block ───────────────────────────────────────────── */
  .col-mid { text-align:center; display:flex; flex-direction:column; align-items:center; gap:8px; padding-top:2px; position:relative; }
  .col-mid::before, .col-mid::after { content:""; position:absolute; left:50%; transform:translateX(-50%); width:48px; height:2px; background:linear-gradient(90deg, transparent, var(--gold2), transparent); }
  .col-mid::before { top:0; } .col-mid::after { bottom:0; }
  .logo-wrap { background:#fff; border:1px solid var(--line); border-radius:14px; padding:8px 14px; display:inline-flex; align-items:center; justify-content:center; box-shadow: 0 2px 8px rgba(184,138,42,.10); }
  .logo-wrap img { max-height:62px; max-width:170px; object-fit:contain; display:block; }
  .doc-title-pill { background:transparent; color:var(--ink); padding:6px 14px; font-size:16px; font-weight:800; text-align:center; border-top:1px solid var(--gold2); border-bottom:1px solid var(--gold2); }
  .doc-title-pill .en { display:block; font-size:10px; color:var(--gold); font-weight:700; letter-spacing:.14em; margin-top:3px; text-transform:uppercase; }
  .meta-pills { display:flex; gap:6px; justify-content:center; flex-wrap:wrap; }
  .pill { background:var(--soft); border:1px solid var(--line); border-radius:18px; padding:4px 12px; font-size:10.5px; color:#334155; display:inline-flex; align-items:center; gap:5px; }
  .pill b { color:var(--ink); font-weight:700; }
  .pill.pay { background:#fef3c7; border-color:#fcd34d; color:#7c2d12; }
  .pill.no { background:#e0f2fe; border-color:#7dd3fc; color:#075985; font-family:'Segoe UI', monospace; }

  /* ── Lines table (full bordered grid; no overflow wrapper so it
       fragments cleanly across pages on long multi-page invoices) ────── */
  .lines-chunk { width:100%; border-collapse:collapse; font-size:11px; margin-top:8px; border:1.5px solid var(--gold2); }
  .lines-chunk thead tr { background:linear-gradient(180deg,#fbf2db,#f3e4bf); color:var(--ink); }
  .lines-chunk th { padding:9px 6px; font-weight:800; font-size:10.5px; border:1px solid var(--gold2); text-align:right; }
  .lines-chunk td { padding:9px 6px; border:1px solid var(--line); text-align:right; }
  .lines-chunk tbody tr.item-row:nth-of-type(odd) td { background:#fbfaf6; }
  .lines-chunk tbody tr { page-break-inside: avoid; break-inside: avoid; }
  .lines-chunk tbody tr.line-notes td { padding:6px 10px 10px; font-size:10.5px; color:#475569; font-style:italic; border-right:3px solid var(--gold2); }
  .lines-chunk tbody tr.line-notes .nlbl { color:var(--gold); font-weight:700; font-style:normal; margin-left:4px; }

  /* ── Totals + QR + footer ────────────────────────────────────────── */
  .bottom { display:grid; grid-template-columns: 1fr 280px; gap:14px; margin-top:14px; align-items:flex-start; }
  .qr-card { border:1px solid var(--line); border-radius:10px; padding:10px; text-align:center; background:#fff; }
  .qr-card .lbl { font-size:9px; color:#64748b; margin-top:4px; letter-spacing:.08em; }
  .totals-card { border:1px solid var(--line); border-radius:10px; padding:12px 14px; background:#fff; }
  .__totalsRow { display:flex; justify-content:space-between; font-size:11.5px; color:#334155; margin-bottom:5px; }
  .__totalsRow.grand { border-top:1.5px solid var(--ink); margin-top:6px; padding-top:7px; font-size:13.5px; font-weight:800; color:var(--ink); }
  .audit-footer { margin-top:14px; border-top:2px solid var(--gold); padding-top:8px; display:flex; justify-content:space-between; align-items:center; font-size:10.5px; color:#475569; }
  .audit-footer .grp { display:flex; flex-direction:column; gap:2px; }
  .audit-footer b { color:var(--ink); font-weight:700; }
  .notes-box { margin-top:10px; background:var(--soft); border:1px solid var(--line); border-right:3px solid var(--gold); border-radius:8px; padding:8px 12px; font-size:11px; color:#334155; }
  .notes-box b { color:var(--ink); }
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style></head>
<body><div class="sheet">
  <div class="hdr">
    <div class="col-co">
      <div class="label">بيانات المنشأة</div>
      <div class="co-name-ar">${esc(co.name)}</div>
      ${zatca && co.vat ? `<div class="row"><b>الرقم الضريبي:</b><span class="mono">${esc(co.vat)}</span></div>` : ""}
      ${co.cr ? `<div class="row"><b>السجل التجاري:</b><span class="mono">${esc(co.cr)}</span></div>` : ""}
      ${co.phone ? `<div class="row"><b>الهاتف:</b><span class="mono">${esc(co.phone)}</span></div>` : ""}
    </div>

    <div class="col-mid">
      ${logo ? `<div class="logo-wrap"><img src="${esc(logo)}" alt="logo" /></div>` : ""}
      <div class="doc-title-pill">${esc(titleMain)}<span class="en">${esc(titleSub)}</span></div>
      <div class="meta-pills">
        <span class="pill no"><b>${esc(doc.docNo)}</b></span>
        <span class="pill pay"><b>${PAYMENT_LABEL[doc.paymentMethod]}</b></span>
        <span class="pill">📅 <b>${esc(doc.date)}</b></span>
      </div>
    </div>

    <div class="col-cu">
      <div class="label">بيانات العميل</div>
      <div class="cu-name">${esc(doc.customerName ?? "عميل نقدي")}</div>
      ${zatca && doc.customerVat ? `<div class="row"><b>الرقم الضريبي:</b><span class="mono">${esc(doc.customerVat)}</span></div>` : ""}
    </div>
  </div>

  <table class="lines-chunk">
    <thead><tr>
      <th style="width:30px">#</th>
      <th>الصنف</th>
      <th>الكمية</th>
      ${showFree ? `<th style="color:#b45309;">مجاني</th>` : ""}
      <th>الوحدة</th>
      <th>سعر الوحدة</th>
      ${zatca ? `<th>الضريبة</th>` : ""}
      ${zatca ? `<th>قيمة الضريبة</th>` : ""}
      <th>الإجمالي</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  ${doc.notes ? `<div class="notes-box"><b>ملاحظات:</b> ${esc(doc.notes)}</div>` : ""}

  <div class="bottom">
    <div class="totals-card">
      ${zatca ? `<div class="__totalsRow"><span>المبلغ قبل الضريبة</span><span class="mono">${fmt(doc.subtotal, dp)} ${esc(sym)}</span></div>` : ""}
      ${zatca ? `<div class="__totalsRow"><span>ضريبة القيمة المضافة</span><span class="mono">${fmt(doc.vatTotal, dp)} ${esc(sym)}</span></div>` : ""}
      <div class="__totalsRow grand"><span>الإجمالي المستحق</span><span class="mono">${fmt(doc.grandTotal, dp)} ${esc(sym)}</span></div>
    </div>
    ${zatca && qrDataUrl ? `<div class="qr-card"><img src="${qrDataUrl}" width="150" height="150" /><div class="lbl">رمز الاستجابة السريعة (QR) — زاتكا</div></div>` : "<div></div>"}
  </div>

  <div class="audit-footer">
    <div class="grp">
      <span>${esc(titleMain)}</span>
      ${zatca ? `<span style="color:var(--gold);font-weight:700;">ZATCA e-Invoice</span>` : ""}
    </div>
    <div class="grp" style="text-align:left;">
      <span>تاريخ الطباعة: <b>${esc(new Date().toLocaleString("en-GB"))}</b></span>
      ${zatca ? `<span>نظام الفاتورة الإلكترونية — متوافق مع زاتكا</span>` : `<span>شكراً لتعاملكم معنا</span>`}
    </div>
  </div>
</div></body></html>`;
}

// ─── Thermal (80 mm receipt) ──────────────────────────────────────────
function buildThermalHtml(doc: PrintDoc, co: CompanyProfile, qrDataUrl: string, zatca: boolean): string {
  const thermalTitle = zatca ? docTitle(doc.kind) : (doc.kind === "invoice" ? "فاتورة مبيعات" : "مرتجع مبيعات");
  const dp = co.decimals ?? 2;
  const sym = currencySymbol();
  const rows = doc.lines.map((l) => `
      <div class="ln">
        <div class="ln-name">${esc(l.itemName ?? "")}</div>
        <div class="ln-calc">
          <span>${esc(l.qty)}${l.uomName ? " " + esc(l.uomName) : ""} × ${fmt(l.unitPrice, dp)}</span>
          <span>${fmt(l.lineTotal, dp)}</span>
        </div>
      </div>`).join("");
  return `<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>${esc(doc.docNo)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: 80mm auto; margin: 0; }
  body { font-family: 'Tahoma', 'Segoe UI', Arial, sans-serif; direction: rtl; color: #000; background: #fff; }
  .rcpt { width: 80mm; padding: 4mm 3mm; font-size: 12px; }
  .center { text-align: center; }
  .co-name { font-size: 16px; font-weight: 800; }
  .muted { color: #000; font-size: 11px; }
  .doc-title { font-weight: 800; font-size: 13px; margin: 4px 0; }
  .sep { border-top: 1px dashed #000; margin: 6px 0; }
  .meta { font-size: 11px; display: flex; justify-content: space-between; }
  .ln { margin: 4px 0; }
  .ln-name { font-weight: 600; }
  .ln-calc { display: flex; justify-content: space-between; font-size: 11px; }
  .tot { display: flex; justify-content: space-between; font-size: 12px; margin: 2px 0; }
  .tot.grand { font-weight: 800; font-size: 14px; }
  .qr { text-align: center; margin-top: 8px; }
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style></head>
<body><div class="rcpt">
  <div class="center">
    <div class="co-name">${esc(co.name)}</div>
    ${zatca && co.vat ? `<div class="muted">الرقم الضريبي: ${esc(co.vat)}</div>` : ""}
    ${co.cr ? `<div class="muted">س.ت: ${esc(co.cr)}</div>` : ""}
    ${co.phone ? `<div class="muted">هاتف: ${esc(co.phone)}</div>` : ""}
    <div class="doc-title">${esc(thermalTitle)}</div>
  </div>
  <div class="sep"></div>
  <div class="meta"><span>${doc.kind === "invoice" ? "رقم الفاتورة" : "رقم المرتجع"}</span><span>${esc(doc.docNo)}</span></div>
  <div class="meta"><span>التاريخ</span><span>${esc(doc.date)}</span></div>
  <div class="meta"><span>طريقة الدفع</span><span>${PAYMENT_LABEL[doc.paymentMethod]}</span></div>
  ${doc.customerName ? `<div class="meta"><span>العميل</span><span>${esc(doc.customerName)}</span></div>` : ""}
  <div class="sep"></div>
  ${rows}
  <div class="sep"></div>
  ${zatca ? `<div class="tot"><span>المبلغ قبل الضريبة</span><span>${fmt(doc.subtotal, dp)} ${esc(sym)}</span></div>` : ""}
  ${zatca ? `<div class="tot"><span>ضريبة القيمة المضافة</span><span>${fmt(doc.vatTotal, dp)} ${esc(sym)}</span></div>` : ""}
  <div class="tot grand"><span>الإجمالي</span><span>${fmt(doc.grandTotal, dp)} ${esc(sym)}</span></div>
  ${doc.notes ? `<div class="sep"></div><div class="muted">ملاحظات: ${esc(doc.notes)}</div>` : ""}
  ${zatca && qrDataUrl ? `<div class="qr"><img src="${qrDataUrl}" width="120" height="120" /></div>` : ""}
  <div class="sep"></div>
  <div class="center muted">شكراً لتعاملكم معنا</div>
</div></body></html>`;
}

// ─── Print via standalone hidden iframe ───────────────────────────────
function printHtml(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  document.body.appendChild(iframe);
  const win = iframe.contentWindow;
  const idoc = win?.document;
  if (!win || !idoc) { iframe.remove(); return; }
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    try { win.focus(); win.print(); } catch { /* user cancelled / unsupported */ }
    setTimeout(() => iframe.remove(), 1500);
  };
  idoc.open();
  idoc.write(html);
  idoc.close();
  // Wait for the document (incl. logo + QR images) to load so nothing prints
  // blank, with a timeout fallback in case onload never fires.
  if (idoc.readyState === "complete") setTimeout(run, 250);
  else { win.addEventListener("load", () => setTimeout(run, 250)); setTimeout(run, 1200); }
}

/** Build + print a sales document with the chosen template. */
export async function printSalesDoc(kind: PrintKind, doc: PrintDoc): Promise<void> {
  const co = getCompanyProfile();
  const zatca = isZatcaCountry();
  const qrDataUrl = await buildQrDataUrl(doc.qrBase64);
  const html = kind === "a4" ? buildA4Html(doc, co, qrDataUrl, zatca) : buildThermalHtml(doc, co, qrDataUrl, zatca);
  printHtml(html);
}

// ─── Vouchers (سند قبض / سند صرف / سند تحصيل) ─────────────────────────
export type VoucherKind = "receipt" | "payment";

export interface VoucherDoc {
  kind: VoucherKind;            // receipt = قبض (money in), payment = صرف (money out)
  title: string;               // e.g. "سند قبض" / "سند صرف" / "سند تحصيل"
  docNo: string;
  date: string;
  partyName: string | null;     // العميل / المورد
  amount: number;
  description: string | null;
  walletKind: "cash" | "bank" | null;
  walletName: string | null;    // الصندوق / البنك
  linkedDocNo?: string | null;  // الفاتورة / السند المرتبط
}

// ── Arabic number-to-words (تفقيط) ──
const SUBUNIT_NAME: Record<string, string> = {
  SAR: "هللة", QAR: "درهم", AED: "فلس", KWD: "فلس", BHD: "فلس", IQD: "فلس",
  JOD: "فلس", OMR: "بيسة", LYD: "درهم", TND: "مليم", EGP: "قرش",
  USD: "سنت", EUR: "سنت", GBP: "بنس",
};

function threeDigitsToWords(n: number): string {
  const ones = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة", "عشرة",
    "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"];
  const tens = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
  const hundreds = ["", "مائة", "مائتان", "ثلاثمائة", "أربعمائة", "خمسمائة", "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة"];
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rem = n % 100;
  if (h > 0) parts.push(hundreds[h]);
  if (rem > 0) {
    if (rem < 20) parts.push(ones[rem]);
    else {
      const t = Math.floor(rem / 10);
      const o = rem % 10;
      parts.push(o > 0 ? `${ones[o]} و${tens[t]}` : tens[t]);
    }
  }
  return parts.join(" و");
}

function integerToWords(value: number): string {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return "صفر";
  const scales: { v: number; s: [string, string, string] }[] = [
    { v: 1_000_000_000, s: ["مليار", "ملياران", "مليارات"] },
    { v: 1_000_000, s: ["مليون", "مليونان", "ملايين"] },
    { v: 1_000, s: ["ألف", "ألفان", "آلاف"] },
  ];
  const groups: string[] = [];
  for (const sc of scales) {
    const count = Math.floor(n / sc.v);
    if (count > 0) {
      if (count === 1) groups.push(sc.s[0]);
      else if (count === 2) groups.push(sc.s[1]);
      else if (count <= 10) groups.push(`${threeDigitsToWords(count)} ${sc.s[2]}`);
      else groups.push(`${threeDigitsToWords(count)} ${sc.s[0]}`);
      n %= sc.v;
    }
  }
  if (n > 0) groups.push(threeDigitsToWords(n));
  return groups.join(" و");
}

/** "فقط مائة وخمسون ريال سعودي وخمسون هللة لا غير" */
function amountInWords(amount: number, dp: number): string {
  const cur = currencyByCode(baseCurrencyCode());
  const curName = cur.nameAr || "";
  const places = Math.min(2, Math.max(0, dp || 0)) || 2;
  const factor = Math.pow(10, places);
  const abs = Math.abs(amount);
  const intPart = Math.floor(abs);
  const fracPart = Math.round((abs - intPart) * factor);
  let out = `فقط ${integerToWords(intPart)}${curName ? " " + curName : ""}`;
  if (fracPart > 0) {
    const subName = SUBUNIT_NAME[cur.code] || "";
    out += ` و${integerToWords(fracPart)}${subName ? " " + subName : ""}`;
  }
  return out + " لا غير";
}

function buildVoucherHtml(v: VoucherDoc, co: CompanyProfile, zatca: boolean): string {
  const dp = co.decimals ?? 2;
  const sym = currencySymbol();
  const isReceipt = v.kind === "receipt";
  const accent = isReceipt ? "#15803d" : "#b45309";      // green for in, amber for out
  const accentBg = isReceipt ? "#f0fdf4" : "#fffbeb";
  const partyLabel = isReceipt ? "استلمنا من السيد / السادة" : "صرفنا إلى السيد / السادة";
  const walletLabel = v.walletKind === "bank" ? "البنك" : "الصندوق";
  return `<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>${esc(v.title)} ${esc(v.docNo)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --accent: ${accent}; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; }
  @page { size: A4; margin: 14mm; }
  body { font-family: 'Tahoma', 'Segoe UI', Arial, sans-serif; direction: rtl; color: var(--ink); background: #fff; }
  .sheet { max-width: 760px; margin: 0 auto; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid var(--accent); padding-bottom: 12px; }
  .co .nm { font-size: 20px; font-weight: 800; }
  .co .row { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .co .row b { color: var(--ink); }
  .logo img { max-height: 70px; max-width: 180px; object-fit: contain; }
  .title-pill { margin: 18px auto 4px; text-align: center; }
  .title-pill .main { display: inline-block; background: var(--accent); color: #fff; font-size: 20px; font-weight: 800; padding: 8px 28px; border-radius: 999px; }
  .docmeta { display: flex; justify-content: center; gap: 26px; margin: 10px 0 18px; font-size: 13px; color: var(--muted); }
  .docmeta b { color: var(--ink); }
  .amount-box { display: flex; justify-content: space-between; align-items: center; background: ${accentBg}; border: 1px solid var(--accent); border-radius: 12px; padding: 14px 20px; margin-bottom: 14px; }
  .amount-box .lbl { font-size: 14px; font-weight: 700; color: var(--accent); }
  .amount-box .val { font-size: 26px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .words { background: #f8fafc; border: 1px dashed var(--line); border-radius: 10px; padding: 11px 16px; font-size: 14px; font-weight: 700; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; margin-bottom: 26px; }
  .grid .r { display: flex; padding: 10px 16px; font-size: 13.5px; }
  .grid .r:nth-child(odd) { background: #fafafa; }
  .grid .r .k { width: 170px; color: var(--muted); font-weight: 700; }
  .grid .r .v { flex: 1; font-weight: 600; }
  .sign { display: flex; justify-content: space-between; gap: 24px; margin-top: 40px; }
  .sign .cell { flex: 1; text-align: center; }
  .sign .line { border-top: 1.5px solid var(--ink); margin: 0 8px 6px; padding-top: 6px; }
  .sign .cap { font-size: 12.5px; color: var(--muted); font-weight: 700; }
  .ftr { margin-top: 26px; border-top: 1px solid var(--line); padding-top: 8px; display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); }
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style></head>
<body><div class="sheet">
  <div class="top">
    <div class="co">
      <div class="nm">${esc(co.name) || "—"}</div>
      ${co.cr ? `<div class="row"><b>س.ت:</b> ${esc(co.cr)}</div>` : ""}
      ${zatca && co.vat ? `<div class="row"><b>الرقم الضريبي:</b> ${esc(co.vat)}</div>` : ""}
      ${co.phone ? `<div class="row"><b>الهاتف:</b> ${esc(co.phone)}</div>` : ""}
    </div>
    ${co.logo ? `<div class="logo"><img src="${esc(co.logo)}" alt="logo" /></div>` : ""}
  </div>

  <div class="title-pill"><span class="main">${esc(v.title)}</span></div>
  <div class="docmeta"><span>رقم السند: <b>${esc(v.docNo)}</b></span><span>التاريخ: <b>${esc(v.date)}</b></span></div>

  <div class="amount-box">
    <span class="lbl">المبلغ</span>
    <span class="val">${fmt(v.amount, dp)} ${esc(sym)}</span>
  </div>
  <div class="words">${esc(amountInWords(v.amount, dp))}</div>

  <div class="grid">
    <div class="r"><div class="k">${partyLabel}</div><div class="v">${esc(v.partyName || "—")}</div></div>
    <div class="r"><div class="k">${walletLabel}</div><div class="v">${esc(v.walletName || "—")}</div></div>
    ${v.linkedDocNo ? `<div class="r"><div class="k">المستند المرتبط</div><div class="v">${esc(v.linkedDocNo)}</div></div>` : ""}
    <div class="r"><div class="k">وذلك عن / البيان</div><div class="v">${esc(v.description || "—")}</div></div>
  </div>

  <div class="sign">
    <div class="cell"><div class="line"></div><div class="cap">${isReceipt ? "المُستلِم" : "المُستلِم"}</div></div>
    <div class="cell"><div class="line"></div><div class="cap">المحاسب</div></div>
    <div class="cell"><div class="line"></div><div class="cap">المدير</div></div>
  </div>

  <div class="ftr">
    <span>${esc(v.title)} — ${esc(co.name)}</span>
    <span>تاريخ الطباعة: ${esc(new Date().toLocaleString("en-GB"))}</span>
  </div>
</div></body></html>`;
}

/** Build + print a financial voucher (receipt / payment / collection). */
export function printVoucher(v: VoucherDoc): void {
  const co = getCompanyProfile();
  const zatca = isZatcaCountry();
  printHtml(buildVoucherHtml(v, co, zatca));
}
