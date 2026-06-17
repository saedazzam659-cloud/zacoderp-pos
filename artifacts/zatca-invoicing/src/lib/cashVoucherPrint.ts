// RAGM-style A4 print for cash vouchers — سند قبض نقدي / سند صرف نقدي.
//
// Replicates the reference voucher layout the user supplied:
//   - bilingual company header (Arabic labels on the right, English labels on
//     the left) with a central logo/stamp
//   - a coloured title bar ("سند قبض نقدي" / "سند صرف نقدي")
//   - an info block (رقم السند / تاريخ السند / رمز النقدية / اسم النقدية /
//     بيان السند)
//   - a single-line account table: رمز الحساب | اسم الحساب | البيان | المبلغ |
//     الخصم | الإجمالي
//   - tafqeet ("فقط … ريال سعودي لا غير")
//   - three signature columns: المدير المالي | مدير الحسابات | إعداد
//
// Self-contained (its own escape/tafqeet helpers) so it never drifts with the
// other print builders. Shared by ReceiptVoucherForm.tsx and
// PaymentVoucherForm.tsx so سند القبض and سند الصرف stay in lock-step.
import { safeLogoSrc } from "@/lib/export";

export type CashVoucherKind = "receipt" | "payment";

function esc(s: any): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

const fmtMoney = (n: any): string =>
  Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Arabic number-to-words (tafqeet) → "فقط … ريال سعودي لا غير".
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
  if (fracPart > 0) out += ` و${under1000(fracPart)} هللة`;
  return `فقط ${out} ريال سعودي لا غير`;
}

export interface CashVoucherCompany {
  nameAr?: string | null;
  nameEn?: string | null;
  crNumber?: string | null;
  vatNumber?: string | null;
  phone?: string | null;
  fax?: string | null;
  city?: string | null;
  street?: string | null;
  buildingNumber?: string | null;
  address?: string | null;
  logo?: string | null;
}

export interface CashVoucherDoc {
  code?: string | null;
  date?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  description?: string | null;
  /** رقم الفاتورة المرتبطة (سداد فاتورة مبيعات/مشتريات) — يظهر فقط عند الربط. */
  invoiceNumber?: string | null;
}

export interface CashVoucherArgs {
  kind: CashVoucherKind;
  doc: CashVoucherDoc;
  /** Cash box / bank account (رمز النقدية / اسم النقدية). */
  treasury: { code?: string | null; name?: string | null } | null;
  /** Counterparty or GL account shown in the table row (رمز/اسم الحساب). */
  account: { code?: string | null; name?: string | null } | null;
  company?: CashVoucherCompany | null;
  /** إعداد — name of the user who prepared the voucher. */
  preparedBy?: string | null;
  onError?: (msg: string) => void;
}

function companyAddress(c?: CashVoucherCompany | null): string {
  if (!c) return "";
  if (c.address) return String(c.address);
  return [c.street, c.buildingNumber, c.city].filter(Boolean).join(" - ");
}

export function buildCashVoucherHtml(args: CashVoucherArgs): string {
  const { kind, doc, treasury, account, company, preparedBy } = args;
  const isReceipt = kind === "receipt";
  const title = isReceipt ? "سند قبض نقدي" : "سند صرف نقدي";
  const accentBar = isReceipt ? "#15803d" : "#b45309";
  const amount = Number(doc.amount || 0);
  const code = doc.code || "—";
  const date = doc.date || "—";
  const desc = doc.description || "";
  const invoiceNumber = doc.invoiceNumber || "";
  const tafqeet = numberToArabicWords(amount);
  const safeLogo = safeLogoSrc(company?.logo);
  const addr = companyAddress(company);
  const printedAt = new Date().toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  // Bilingual company header: Arabic block (right) + logo (center) +
  // English block (left). Both blocks carry the SAME values.
  const arBlock = `
    <div class="co-block ar">
      <div class="co-name">${esc(company?.nameAr ?? "اسم الشركة")}</div>
      <table class="co-meta">
        <tr><td class="k">: السجل التجاري</td><td class="v">${esc(company?.crNumber ?? "")}</td></tr>
        <tr><td class="k">: الرقم الضريبي</td><td class="v">${esc(company?.vatNumber ?? "")}</td></tr>
        <tr><td class="k">: الجوال</td><td class="v">${esc(company?.phone ?? "")}</td></tr>
        <tr><td class="k">: الفاكس</td><td class="v">${esc(company?.fax ?? "")}</td></tr>
        <tr><td class="k">: العنوان</td><td class="v">${esc(addr)}</td></tr>
      </table>
    </div>`;
  const enBlock = `
    <div class="co-block en" dir="ltr">
      <div class="co-name">${esc(company?.nameEn ?? company?.nameAr ?? "")}</div>
      <table class="co-meta">
        <tr><td class="k">C.R-No :</td><td class="v">${esc(company?.crNumber ?? "")}</td></tr>
        <tr><td class="k">VAT Number :</td><td class="v">${esc(company?.vatNumber ?? "")}</td></tr>
        <tr><td class="k">Phone :</td><td class="v">${esc(company?.phone ?? "")}</td></tr>
        <tr><td class="k">Fax :</td><td class="v">${esc(company?.fax ?? "")}</td></tr>
        <tr><td class="k">Address :</td><td class="v">${esc(addr)}</td></tr>
      </table>
    </div>`;
  const logoBlock = `<div class="co-logo">${
    safeLogo ? `<img src="${safeLogo}" alt="" />` : ""
  }</div>`;

  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"/>
<title>${esc(title)} — ${esc(code)}</title>
<style>
@page { size: A4; margin: 12mm 12mm 16mm 12mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; font-size:12px; padding-bottom:18mm; }
.header { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; border:1px solid #cbd5e1; padding:10px 12px; }
.co-block { flex:1; }
.co-block.en { text-align:left; }
.co-name { font-size:14px; font-weight:800; margin-bottom:4px; }
.co-meta { border-collapse:collapse; font-size:10.5px; color:#333; }
.co-meta td { padding:1px 4px; vertical-align:top; }
.co-meta .k { color:#555; white-space:nowrap; }
.co-meta .v { font-weight:600; }
.co-logo { flex:0 0 90px; text-align:center; }
.co-logo img { max-height:70px; max-width:90px; object-fit:contain; }
.title-bar { background:${accentBar}; color:#fff; font-size:15px; font-weight:800; text-align:center; padding:6px 12px; margin:10px 0; border-radius:4px; }
.info { display:grid; grid-template-columns:1fr 1fr; gap:4px 24px; font-size:12px; margin-bottom:12px; }
.info .row { display:flex; justify-content:flex-start; gap:8px; padding:2px 0; border-bottom:1px dotted #e2e8f0; }
.info .k { color:#555; min-width:90px; }
.info .v { font-weight:700; }
table.lines { width:100%; border-collapse:collapse; font-size:12px; margin-bottom:10px; }
table.lines th { background:#dbeafe; color:#1e3a8a; border:1px solid #93c5fd; padding:6px 8px; font-weight:700; white-space:nowrap; }
table.lines td { border:1px solid #cbd5e1; padding:6px 8px; }
table.lines td.num { text-align:center; font-family:"Consolas",monospace; white-space:nowrap; }
table.lines tfoot td { font-weight:800; background:#f1f5f9; }
.tafqeet { text-align:center; font-size:13px; font-weight:700; padding:8px; margin-bottom:24px; }
.sigs { display:grid; grid-template-columns:repeat(3,1fr); gap:30px; margin-top:48px; font-size:12px; text-align:center; }
.sigs .box { border-top:1px solid #111; padding-top:6px; min-height:40px; }
.footer { position:fixed; bottom:6mm; left:12mm; right:12mm; display:flex; justify-content:space-between; font-size:10px; color:#64748b; border-top:1px solid #e2e8f0; padding-top:6px; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة</button>
<div class="header">
  ${arBlock}
  ${logoBlock}
  ${enBlock}
</div>
<div class="title-bar">${esc(title)}</div>
<div class="info">
  <div class="row"><span class="k">رقم السند</span><span class="v">: ${esc(code)}</span></div>
  <div class="row"><span class="k">تاريخ السند</span><span class="v">: ${esc(date)}</span></div>
  <div class="row"><span class="k">رمز النقدية</span><span class="v">: ${esc(treasury?.code ?? "")}</span></div>
  <div class="row"><span class="k">اسم النقدية</span><span class="v">: ${esc(treasury?.name ?? "—")}</span></div>
  <div class="row"><span class="k">رمز الحساب</span><span class="v">: ${esc(account?.code ?? "—")}</span></div>
  <div class="row"><span class="k">اسم الحساب</span><span class="v">: ${esc(account?.name ?? "—")}</span></div>
  ${invoiceNumber ? `<div class="row"><span class="k">رقم الفاتورة</span><span class="v">: ${esc(invoiceNumber)}</span></div>` : ""}
  <div class="row" style="grid-column:1 / -1;"><span class="k">بيان السند</span><span class="v">: ${esc(desc || "—")}</span></div>
</div>
<table class="lines">
  <thead>
    <tr>
      <th>رمز الحساب</th>
      <th>اسم الحساب</th>
      <th>البيان</th>
      <th>المبلغ</th>
      <th>الخصم</th>
      <th>الإجمالي</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td class="num">${esc(account?.code ?? "")}</td>
      <td>${esc(account?.name ?? "—")}</td>
      <td>${esc(desc || "")}</td>
      <td class="num">${fmtMoney(amount)}</td>
      <td class="num">0.00</td>
      <td class="num">${fmtMoney(amount)}</td>
    </tr>
  </tbody>
  <tfoot>
    <tr>
      <td colspan="3" style="text-align:left;">الإجمالي</td>
      <td class="num">${fmtMoney(amount)}</td>
      <td class="num">0.00</td>
      <td class="num">${fmtMoney(amount)}</td>
    </tr>
  </tfoot>
</table>
<div class="tafqeet">${esc(tafqeet)}</div>
<div class="sigs">
  <div class="box">المدير المالي</div>
  <div class="box">مدير الحسابات</div>
  <div class="box">إعداد${preparedBy ? ` : ${esc(preparedBy)}` : ""}</div>
</div>
<div class="footer">
  <span>تاريخ الطباعة : ${esc(printedAt)}</span>
  <span>الصفحة 1 من 1</span>
</div>
<script>setTimeout(function(){window.print()},300);</script>
</body></html>`;
}

/** Opens a print window (synchronously, popup-blocker safe) and writes the
 *  voucher HTML. Calls onError with an Arabic message if the popup is blocked. */
export function printCashVoucher(args: CashVoucherArgs): void {
  const w = window.open("", "_blank", "width=900,height=800");
  if (!w) {
    args.onError?.("تم منع النوافذ المنبثقة — اسمح بفتح النوافذ المنبثقة من هذا الموقع لإجراء الطباعة.");
    return;
  }
  const html = buildCashVoucherHtml(args);
  w.document.open();
  w.document.write(html);
  w.document.close();
}
