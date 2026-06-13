// Sales-document printing for the desktop app. Two templates:
//   • A4 — a port of the web app's "classic" tax-invoice layout.
//   • thermal — an 80 mm receipt layout for thermal printers.
// Both are printed inside a standalone hidden iframe (its own document, no
// clipping ancestors) — the same isolation pattern JournalEntries uses. The
// ZATCA QR is rendered from the stored TLV (base64) via the `qrcode` lib, the
// same way the web builds it.
import QRCode from "qrcode";
import { getCompanyProfile, getDecimals, type CompanyProfile } from "./appSettings";
import { currencySymbol } from "./currency";
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

// ─── A4 (classic) ─────────────────────────────────────────────────────
function buildA4Html(doc: PrintDoc, co: CompanyProfile, qrDataUrl: string): string {
  const dp = co.decimals ?? 2;
  const sym = currencySymbol();
  const logo = co.logo;
  const rows = doc.lines.map((l) => `
        <tr>
          <td>${esc(l.itemName ?? "")}</td>
          <td style="text-align:center">${esc(l.qty)}${l.uomName ? " " + esc(l.uomName) : ""}</td>
          <td>${fmt(l.unitPrice, dp)}</td>
          <td style="text-align:center">${esc(l.vatRate)}%</td>
          <td style="font-weight:bold">${fmt(l.lineTotal, dp)}</td>
        </tr>`).join("");
  return `<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>${esc(doc.docNo)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 12mm; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 12px; color: #111; background: #fff; direction: rtl; }
  .page { max-width: 800px; margin: 0 auto; padding: 24px; border: 2px solid #111; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px double #111; padding-bottom: 16px; margin-bottom: 16px; }
  .header-right h1 { font-size: 20px; font-weight: 800; }
  .header-right p { font-size: 11px; color: #444; margin-top: 2px; }
  .logo { max-height: 80px; max-width: 200px; object-fit: contain; }
  .title-box { text-align: center; border: 2px solid #111; padding: 8px 24px; margin-bottom: 16px; }
  .title-box h2 { font-size: 18px; font-weight: 800; letter-spacing: 2px; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; margin-bottom: 16px; }
  .meta-item { display: flex; gap: 6px; border-bottom: 1px dotted #ccc; padding: 4px 0; font-size: 11px; }
  .meta-item .label { color: #555; font-weight: 600; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 11px; }
  th { background: #111; color: #fff; padding: 6px 8px; text-align: right; }
  td { border: 1px solid #ccc; padding: 5px 8px; }
  tr:nth-child(even) td { background: #f9f9f9; }
  .totals { margin-right: auto; width: 280px; }
  .totals-row { display: flex; justify-content: space-between; padding: 4px 8px; font-size: 12px; border: 1px solid #ccc; margin-top: -1px; }
  .totals-row.total { background: #111; color: #fff; font-size: 14px; font-weight: 800; }
  .footer { display: flex; justify-content: space-between; align-items: flex-end; border-top: 2px double #111; padding-top: 16px; margin-top: 16px; }
  .footer p { font-size: 10px; color: #666; }
  .qr-box { text-align: center; }
  .qr-box p { font-size: 9px; color: #666; margin-top: 4px; }
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style></head>
<body><div class="page">
  <div class="header">
    <div class="header-right">
      <h1>${esc(co.name)}</h1>
      <p>الرقم الضريبي: ${esc(co.vat)}</p>
      ${co.cr ? `<p>السجل التجاري: ${esc(co.cr)}</p>` : ""}
    </div>
    ${logo ? `<img src="${esc(logo)}" class="logo" alt="شعار" />` : '<div style="width:80px"></div>'}
  </div>

  <div class="title-box"><h2>${docTitle(doc.kind)}</h2></div>

  <div class="meta-grid">
    <div class="meta-item"><span class="label">${doc.kind === "invoice" ? "رقم الفاتورة:" : "رقم المرتجع:"}</span><span>${esc(doc.docNo)}</span></div>
    <div class="meta-item"><span class="label">التاريخ:</span><span>${esc(doc.date)}</span></div>
    <div class="meta-item"><span class="label">طريقة الدفع:</span><span>${PAYMENT_LABEL[doc.paymentMethod]}</span></div>
    ${doc.customerName ? `<div class="meta-item"><span class="label">العميل:</span><span>${esc(doc.customerName)}</span></div>` : ""}
    ${doc.customerVat ? `<div class="meta-item"><span class="label">الرقم الضريبي للعميل:</span><span>${esc(doc.customerVat)}</span></div>` : ""}
  </div>

  <table>
    <thead><tr><th>البيان</th><th>الكمية</th><th>سعر الوحدة</th><th>نسبة الضريبة</th><th>الإجمالي</th></tr></thead>
    <tbody>${rows}
    </tbody>
  </table>

  <div class="totals">
    <div class="totals-row"><span>المبلغ قبل الضريبة</span><span>${fmt(doc.subtotal, dp)} ${esc(sym)}</span></div>
    <div class="totals-row"><span>ضريبة القيمة المضافة</span><span>${fmt(doc.vatTotal, dp)} ${esc(sym)}</span></div>
    <div class="totals-row total"><span>الإجمالي المستحق</span><span>${fmt(doc.grandTotal, dp)} ${esc(sym)}</span></div>
  </div>

  ${doc.notes ? `<div style="margin-top:16px;border:1px solid #ccc;padding:8px;font-size:11px"><strong>ملاحظات:</strong> ${esc(doc.notes)}</div>` : ""}

  <div class="footer">
    <div><p>نظام الفاتورة الإلكترونية — متوافق مع زاتكا</p><p>تاريخ الطباعة: ${esc(new Date().toLocaleString("en-GB"))}</p></div>
    ${qrDataUrl ? `<div class="qr-box"><img src="${qrDataUrl}" width="110" height="110" /><p>رمز QR للتحقق</p></div>` : ""}
  </div>
</div></body></html>`;
}

// ─── Thermal (80 mm receipt) ──────────────────────────────────────────
function buildThermalHtml(doc: PrintDoc, co: CompanyProfile, qrDataUrl: string): string {
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
    <div class="muted">الرقم الضريبي: ${esc(co.vat)}</div>
    ${co.cr ? `<div class="muted">س.ت: ${esc(co.cr)}</div>` : ""}
    <div class="doc-title">${docTitle(doc.kind)}</div>
  </div>
  <div class="sep"></div>
  <div class="meta"><span>${doc.kind === "invoice" ? "رقم الفاتورة" : "رقم المرتجع"}</span><span>${esc(doc.docNo)}</span></div>
  <div class="meta"><span>التاريخ</span><span>${esc(doc.date)}</span></div>
  <div class="meta"><span>طريقة الدفع</span><span>${PAYMENT_LABEL[doc.paymentMethod]}</span></div>
  ${doc.customerName ? `<div class="meta"><span>العميل</span><span>${esc(doc.customerName)}</span></div>` : ""}
  <div class="sep"></div>
  ${rows}
  <div class="sep"></div>
  <div class="tot"><span>المبلغ قبل الضريبة</span><span>${fmt(doc.subtotal, dp)} ${esc(sym)}</span></div>
  <div class="tot"><span>ضريبة القيمة المضافة</span><span>${fmt(doc.vatTotal, dp)} ${esc(sym)}</span></div>
  <div class="tot grand"><span>الإجمالي</span><span>${fmt(doc.grandTotal, dp)} ${esc(sym)}</span></div>
  ${doc.notes ? `<div class="sep"></div><div class="muted">ملاحظات: ${esc(doc.notes)}</div>` : ""}
  ${qrDataUrl ? `<div class="qr"><img src="${qrDataUrl}" width="120" height="120" /></div>` : ""}
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
  const qrDataUrl = await buildQrDataUrl(doc.qrBase64);
  const html = kind === "a4" ? buildA4Html(doc, co, qrDataUrl) : buildThermalHtml(doc, co, qrDataUrl);
  printHtml(html);
}
