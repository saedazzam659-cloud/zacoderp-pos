/**
 * Sales-invoice print + share for the mobile app.
 *
 * Ports the web's "قالب 14 — الأصلي" (SalesPrintModal.template14) in a
 * condensed form: company column (right) / centered logo+title / customer
 * card (left), full-width lines table, totals + ZATCA QR side-by-side,
 * tafqeet summary and audit footer. The math (lineFigures / totals /
 * TLV QR) mirrors the web implementation so print always matches the
 * saved header totals.
 */
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import QRCode from 'qrcode';

// ── Arabic tafqeet (ported verbatim from the web print modal) ───────────────
function numberToArabicWords(n: number): string {
  if (!isFinite(n) || n < 0 || n > 999999999.99) return String(n);
  const ones = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة',
    'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر',
    'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
  const tens = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
  const hundreds = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];
  const under1000 = (x: number): string => {
    if (x === 0) return '';
    const h = Math.floor(x / 100); const r = x % 100; const parts: string[] = [];
    if (h) parts.push(hundreds[h]!);
    if (r < 20) { if (r) parts.push(ones[r]!); }
    else {
      const t = Math.floor(r / 10); const o = r % 10;
      if (o) parts.push(`${ones[o]} و${tens[t]}`); else parts.push(tens[t]!);
    }
    return parts.join(' و');
  };
  const intPart = Math.floor(n);
  const fracPart = Math.round((n - intPart) * 100);
  const millions = Math.floor(intPart / 1000000);
  const thousands = Math.floor((intPart % 1000000) / 1000);
  const rest = intPart % 1000;
  const segments: string[] = [];
  if (millions) {
    if (millions === 1) segments.push('مليون');
    else if (millions === 2) segments.push('مليونان');
    else if (millions <= 10) segments.push(`${under1000(millions)} ملايين`);
    else segments.push(`${under1000(millions)} مليون`);
  }
  if (thousands) {
    if (thousands === 1) segments.push('ألف');
    else if (thousands === 2) segments.push('ألفان');
    else if (thousands <= 10) segments.push(`${under1000(thousands)} آلاف`);
    else segments.push(`${under1000(thousands)} ألف`);
  }
  if (rest) segments.push(under1000(rest));
  let out = segments.join(' و') || 'صفر';
  if (fracPart > 0) out += ` و ${under1000(fracPart)} هللة`;
  return `فقط ${out} ريال سعودي لا غير`;
}

// ── Per-line figures honoring the document tax mode (mirror of web) ─────────
function lineFigures(l: any, inc: boolean) {
  const qty = Number(l.qty) || 0;
  const price = Number(l.unitPrice) || 0;
  const rate = (Number(l.vatRate) || 0) / 100;
  const gross = qty * price;
  const dPct = Math.max(0, Math.min(100, Number(l.discount) || 0));
  const dAmt = Math.max(0, Number(l.discountAmount) || 0);
  const disc = Math.min(gross, dAmt > 0 ? dAmt : (gross * dPct) / 100);
  const afterDisc = Math.max(0, gross - disc);
  const div = inc && rate > -1 ? 1 + rate : 1;
  const grossEx = gross / div;
  const discEx = disc / div;
  const netEx = afterDisc / div;
  const vat = inc ? afterDisc - netEx : netEx * rate;
  const tot = netEx + vat;
  return { qty, price, gross, disc, grossEx, discEx, netEx, vat, tot };
}

function computeTotals(doc: any, lines: any[]) {
  const inc = !!doc?.priceIncludesVat;
  let subtotalPreDiscount = 0, discountTotal = 0, netPreVat = 0, vatAmount = 0, totalQty = 0;
  for (const l of lines ?? []) {
    const f = lineFigures(l, inc);
    subtotalPreDiscount += f.grossEx;
    discountTotal += f.discEx;
    netPreVat += f.netEx;
    vatAmount += f.vat;
    totalQty += f.qty;
  }
  const grandTotal = netPreVat + vatAmount;
  return {
    inc, subtotalPreDiscount, discountTotal, netPreVat, vatAmount, grandTotal,
    totalQty, itemsCount: (lines ?? []).length,
    amountWords: numberToArabicWords(grandTotal),
  };
}

// ── ZATCA phase-1 TLV → base64 (5 mandatory tags) ───────────────────────────
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 63];
  }
  return out;
}
// Minimal UTF-8 encoder (TextEncoder is available on Hermes, but stay safe).
function utf8(s: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}
function buildTlvBase64(company: any, doc: any, grandTotal: number, vatAmount: number): string {
  const pieces: Uint8Array[] = [];
  const push = (tag: number, val: string) => {
    const bytes = utf8(val);
    pieces.push(Uint8Array.from([tag, bytes.length]));
    pieces.push(bytes);
  };
  push(1, String(company?.nameAr ?? company?.nameEn ?? ''));
  push(2, String(company?.vatNumber ?? ''));
  let ts = '';
  const raw = doc?.invoiceDate ?? doc?.returnDate ?? doc?.quotationDate ?? doc?.createdAt;
  if (raw) {
    const dt = new Date(raw);
    if (!isNaN(dt.getTime())) ts = dt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  if (!ts) ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  push(3, ts);
  push(4, grandTotal.toFixed(2));
  push(5, vatAmount.toFixed(2));
  const total = pieces.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of pieces) { out.set(p, off); off += p.length; }
  return bytesToBase64(out);
}

async function buildQrSvg(company: any, doc: any, grandTotal: number, vatAmount: number): Promise<string> {
  try {
    const b64 = buildTlvBase64(company, doc, grandTotal, vatAmount);
    // Pure-JS SVG output — no canvas needed on native.
    return await QRCode.toString(b64, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', width: 150 });
  } catch { return ''; }
}

const fmt = (n: number) =>
  (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: any) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface InvoicePrintInput {
  doc: any;              // full sales document row incl. lines
  lines: any[];
  customer: any | null;
  company: any;
  logoUrl?: string | null; // absolute URL when the company has a logo
  type?: 'invoice' | 'quotation' | 'return';
  currency?: any | null;
}

// ── HTML builder — condensed template 14 ("الأصلي") ─────────────────────────
export async function buildInvoiceHtml(d: InvoicePrintInput): Promise<string> {
  const { doc, lines, customer, company } = d;
  const type = d.type ?? 'invoice';
  const isQuotation = type === 'quotation';
  const isReturn = type === 'return';
  const t = computeTotals(doc, lines);
  const hasBuyerVat = !!(customer?.vatNumber ?? doc?.buyerVatNumber);
  const titleAr = isQuotation
    ? 'عرض سعر'
    : isReturn
      ? (hasBuyerVat ? 'مرتجع مبيعات ضريبي' : 'مرتجع مبيعات مبسط')
      : (hasBuyerVat ? 'فاتورة مبيعات ضريبية' : 'فاتورة مبيعات مبسطة');
  const titleEn = isQuotation
    ? 'Quotation'
    : isReturn
      ? 'Sales Return'
      : (hasBuyerVat ? 'Tax Invoice' : 'Simplified Tax Invoice');
  const prefix = isQuotation ? 'SQ' : isReturn ? 'SR' : 'SI';
  const docNo = doc?.docNumber ?? `${prefix}-${doc?.id ?? ''}`;
  const dateStr = String(isQuotation ? doc?.quotationDate : isReturn ? doc?.returnDate : doc?.invoiceDate).slice(0, 10) || '—';
  const payLabel = isQuotation
    ? `صالح حتى: ${String(doc?.validUntil ?? '—').slice(0, 10)}`
    : doc?.paymentType === 'cash' ? 'نقداً' : doc?.paymentType === 'bank' ? 'على حساب' : 'آجل';
  const showQuotationQr = company?.printQuotationShowQr === true;
  const showQr = !isQuotation || showQuotationQr;
  const qrSvg = showQr ? await buildQrSvg(company, doc, t.grandTotal, t.vatAmount) : '';
  const logo = d.logoUrl ? `<img src="${esc(d.logoUrl)}" style="max-height:62px;max-width:170px;object-fit:contain;" />` : '';
  const showEnglishSubtitle = company?.printT14ShowEnSubtitle !== false;
  const showAccountCode = company?.printT14ShowAccountCode !== false;
  const showAuditFooter = company?.printT14ShowAuditFooter !== false;
  const showQuotationAddress = !isQuotation || company?.printQuotationShowCustomerAddress !== false;
  const currencyName = isQuotation && company?.printQuotationShowCurrencyName !== false
    ? String(d.currency?.nameAr ?? d.currency?.nameEn ?? '').trim()
    : '';
  const customerAddress = [
    customer?.buildingNumber ?? doc?.buyerBuildingNumber,
    customer?.street ?? doc?.buyerStreet,
    customer?.district ?? doc?.buyerDistrict,
    customer?.city ?? doc?.buyerCity,
    customer?.postalCode ?? doc?.buyerPostalCode,
    customer?.nationalAddressShort ?? doc?.buyerNationalAddressShort,
  ].map((v) => String(v ?? '').trim()).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('، ');
  const accountCode = customer?.accountCode ?? customer?.code ?? (customer?.accountId != null ? `A-${customer.accountId}` : null);
  const bankText = String(company?.bankAccountText ?? '').trim();
  const showQrColumn = showQr || !!bankText;
  const createdAt = doc?.createdAt ? new Date(doc.createdAt) : null;
  const createdStr = createdAt && !isNaN(createdAt.getTime())
    ? createdAt.toLocaleString('ar-SA-u-ca-gregory-nu-latn', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';

  const rowsHtml = (lines ?? []).map((l, i) => {
    const f = lineFigures(l, t.inc);
    return `<tr>
      <td class="mono">${i + 1}</td>
      <td>${esc(l.itemName ?? l.itemCode ?? '—')}</td>
      <td>${esc(l.unit ?? '—')}</td>
      <td class="mono">${fmt(f.qty)}</td>
      <td class="mono">${fmt(f.price)}</td>
      <td class="mono">${fmt(f.vat)}</td>
      <td class="mono">${fmt(f.tot)}</td>
    </tr>`;
  }).join('');

  const crow = (label: string, val: any) =>
    val ? `<div class="row"><b>${label}</b><span>${esc(val)}</span></div>` : '';

  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${esc(titleAr)} — ${esc(docNo)}</title>
<style>
  @page { size: A4; margin: 10mm 8mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; }
  body { direction: rtl; background: #fff; color: #0f172a; font-size: 11px; }
  :root { --line:#e5e7eb; --soft:#f8fafc; --gold:#b88a2a; --gold2:#e5c277; }
  .mono { font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: isolate; }
  .hdr { display:grid; grid-template-columns: 1fr 1.1fr 1fr; gap:12px; margin-bottom:14px; }
  .colbox { background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .colbox .label { font-size:10px; letter-spacing:.08em; color:var(--gold); font-weight:800; margin-bottom:6px; border-bottom:1px solid var(--line); padding-bottom:4px; }
  .colbox .row { display:flex; gap:6px; margin-top:4px; font-size:11px; color:#334155; }
  .colbox .row b { color:#0f172a; font-weight:700; min-width:70px; }
  .co-name-ar { font-size:15px; font-weight:800; margin-bottom:2px; }
  .co-name-en { font-size:11px; color:#64748b; margin-bottom:6px; font-style:italic; }
  .col-mid { text-align:center; display:flex; flex-direction:column; align-items:center; gap:8px; padding-top:2px; }
  .doc-title { padding:6px 14px; font-size:15px; font-weight:800; border-top:1px solid var(--gold2); border-bottom:1px solid var(--gold2); }
  .doc-title .en { display:block; font-size:9.5px; color:var(--gold); font-weight:700; letter-spacing:.12em; margin-top:3px; text-transform:uppercase; }
  .pill { background:var(--soft); border:1px solid var(--line); border-radius:18px; padding:4px 12px; font-size:10.5px; color:#334155; display:inline-block; margin:0 2px; }
  .pill.pay { background:#fef3c7; border-color:#fcd34d; color:#7c2d12; }
  .pill.no { background:#e0f2fe; border-color:#7dd3fc; color:#075985; }
  table.lines { width:100%; border-collapse:collapse; font-size:11px; margin-top:6px; }
  table.lines thead tr { background:#f3f4f6; }
  table.lines th { padding:8px 6px; font-weight:700; font-size:10.5px; border-bottom:1px solid var(--line); text-align:right; }
  table.lines td { padding:9px 6px; border-bottom:1px solid var(--line); text-align:right; }
  table.lines tbody tr:nth-of-type(odd) td { background:#fafbfc; }
  table.lines tbody tr { page-break-inside: avoid; }
  .bottom { display:grid; grid-template-columns: 1fr 200px; gap:14px; margin-top:14px; page-break-inside: avoid; }
  .card { border:1px solid var(--line); border-radius:10px; padding:12px 14px; background:#fff; }
  .qr-card { text-align:center; padding:10px; }
  .qr-card svg { width:150px; height:150px; }
  .qr-card .lbl { font-size:9px; color:#64748b; margin-top:4px; letter-spacing:.08em; }
  .trow { display:flex; justify-content:space-between; font-size:11.5px; color:#334155; margin-bottom:5px; }
  .trow.grand { border-top:1.5px solid #0f172a; margin-top:6px; padding-top:7px; font-size:13.5px; font-weight:800; color:#0f172a; }
  .summary { margin-top:10px; border:1px solid var(--line); border-radius:6px; padding:8px 12px; font-size:11px; background:#fafafa; }
  .notes-box { margin-top:10px; background:var(--soft); border:1px solid var(--line); border-right:3px solid var(--gold); border-radius:8px; padding:8px 12px; }
  .audit { margin-top:14px; border-top:2px solid var(--gold); padding-top:8px; display:flex; justify-content:space-between; font-size:10.5px; color:#475569; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head><body>
  <div class="hdr">
    <div class="colbox">
      <div class="label">بيانات المنشأة — SELLER</div>
      <div class="co-name-ar">${esc(company?.nameAr ?? '')}</div>
      ${company?.nameEn ? `<div class="co-name-en">${esc(company.nameEn)}</div>` : ''}
      ${crow('الرقم الضريبي', company?.vatNumber)}
      ${crow('السجل التجاري', company?.crNumber ?? company?.commercialRegistration)}
      ${crow('الهاتف', company?.phone)}
      ${crow('المدينة', company?.city)}
    </div>
    <div class="col-mid">
      ${logo}
       <div class="doc-title">${esc(titleAr)}${showEnglishSubtitle ? `<span class="en">${esc(titleEn)}</span>` : ''}</div>
      <div>
        <span class="pill no"><b>${esc(docNo)}</b></span>
        <span class="pill pay">${payLabel}</span>
        <span class="pill">${esc(dateStr)}</span>
      </div>
    </div>
    <div class="colbox">
      <div class="label">بيانات العميل — CUSTOMER</div>
      <div class="co-name-ar">${esc(customer?.nameAr ?? customer?.name ?? doc?.buyerName ?? 'عميل نقدي')}</div>
       ${showAccountCode ? crow('كود الحساب', accountCode) : ''}
      ${crow('الرقم الضريبي', customer?.vatNumber ?? doc?.buyerVatNumber)}
      ${crow('الهاتف', customer?.phone)}
       ${showQuotationAddress ? crow('العنوان', customerAddress || customer?.city) : ''}
       ${currencyName ? crow('العملة', currencyName) : ''}
    </div>
  </div>
  <table class="lines">
    <thead><tr><th>#</th><th>الصنف</th><th>الوحدة</th><th>الكمية</th><th>السعر</th><th>الضريبة</th><th>الإجمالي</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="bottom" style="grid-template-columns:${showQrColumn ? '1fr 200px' : '1fr'};">
    <div>
      <div class="card">
        <div class="trow" style="font-size:9px;opacity:.7;"><span>نوع التسعير</span><span>${t.inc ? 'الأسعار شاملة الضريبة' : 'ضريبة إضافية'}</span></div>
        <div class="trow"><span>الإجمالي قبل الخصم — Subtotal</span><span class="mono">${fmt(t.subtotalPreDiscount)}</span></div>
        <div class="trow"><span>مبلغ الخصم — Discount</span><span class="mono">${fmt(t.discountTotal)}</span></div>
        <div class="trow"><span>الصافي بدون الضريبة — Net</span><span class="mono">${fmt(t.netPreVat)}</span></div>
        <div class="trow"><span>ضريبة القيمة المضافة — VAT</span><span class="mono">${fmt(t.vatAmount)}</span></div>
        <div class="trow grand"><span>الصافي شامل الضريبة — Total</span><span class="mono">${fmt(t.grandTotal)}</span></div>
      </div>
      <div class="summary">
        <div style="font-weight:700;margin-bottom:6px;">${esc(t.amountWords)}</div>
         <div style="display:flex;justify-content:space-between;border-top:1px dashed #cbd5e1;padding-top:6px;">
           <span>إجمالي الأصناف</span><span class="mono" style="font-weight:700;">${t.itemsCount}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:3px;">
           <span>إجمالي الكميات</span><span class="mono" style="font-weight:700;">${fmt(t.totalQty)}</span>
        </div>
      </div>
      ${doc?.notes ? `<div class="notes-box"><b>ملاحظات:</b> ${esc(doc.notes)}</div>` : ''}
    </div>
     ${showQrColumn ? `<div class="card qr-card">${qrSvg}${qrSvg ? '<div class="lbl">ZATCA QR</div>' : ''}${bankText ? `<div style="white-space:pre-line;text-align:right;margin-top:8px;font-size:10px;">${esc(bankText)}</div>` : ''}</div>` : ''}
  </div>
   ${showAuditFooter ? `<div class="audit">
    <span>أنشئت: <b class="mono">${esc(createdStr)}</b></span>
    <span>${esc(company?.nameAr ?? '')} — نظام زاكود ERP</span>
   </div>` : ''}
</body></html>`;
}

/** Open the native print dialog with the invoice HTML. */
export async function printInvoice(input: InvoicePrintInput): Promise<void> {
  const html = await buildInvoiceHtml(input);
  await Print.printAsync({ html });
}

/** Render to PDF and open the system share sheet (WhatsApp / email / …). */
export async function shareInvoicePdf(input: InvoicePrintInput): Promise<void> {
  const html = await buildInvoiceHtml(input);
  const { uri } = await Print.printToFileAsync({ html });
  if (Platform.OS === 'web') {
    // Web preview fallback: no native share sheet; open the PDF.
    if (typeof window !== 'undefined') window.open(uri, '_blank');
    return;
  }
  if (await Sharing.isAvailableAsync()) {
    const title = input.type === 'quotation' ? 'مشاركة عرض السعر' : input.type === 'return' ? 'مشاركة مرتجع المبيعات' : 'مشاركة الفاتورة';
    await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: title, UTI: 'com.adobe.pdf' });
  }
}
