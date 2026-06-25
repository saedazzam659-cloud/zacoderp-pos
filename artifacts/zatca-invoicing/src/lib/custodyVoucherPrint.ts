// A4 print for employee custody / imprest vouchers — سند عهدة.
//
// Unlike the loan voucher, custody is NOT salary-deducted — there is NO
// installment / salary-deduction text. The voucher shows the custody data,
// the notes, and (when present) the expense settlement lines + the return.
//
// Self-contained (its own escape/tafqeet helpers) so it never drifts with the
// other print builders.
import { safeLogoSrc } from "@/lib/export";

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

export interface CustodyVoucherCompany {
  nameAr?: string | null;
  nameEn?: string | null;
  logo?: string | null;
}

export interface CustodySettlementLine {
  settleDate?: string | null;
  kind?: string | null;            // expense | return
  account?: string | null;
  amount?: number | string | null;
  description?: string | null;
  invoiceNumber?: string | null;
}

export interface CustodyVoucherDoc {
  employeeName: string;
  employeeCode?: string | null;
  custodyDate?: string | null;
  amount?: number | string | null;
  settledAmount?: number | string | null;
  returnedAmount?: number | string | null;
  remaining?: number | string | null;
  purpose?: string | null;
  notes?: string | null;
  statusLabel?: string | null;
  settlements?: CustodySettlementLine[];
}

export interface CustodyVoucherArgs {
  doc: CustodyVoucherDoc;
  company?: CustodyVoucherCompany | null;
  onError?: (msg: string) => void;
}

export function buildCustodyVoucherHtml(args: CustodyVoucherArgs): string {
  const { doc, company } = args;
  const amount = Number(doc.amount || 0);
  const settled = Number(doc.settledAmount || 0);
  const returned = Number(doc.returnedAmount || 0);
  const remaining = doc.remaining != null
    ? Number(doc.remaining)
    : +(amount - settled - returned).toFixed(2);
  const tafqeet = numberToArabicWords(amount);
  const safeLogo = safeLogoSrc(company?.logo);
  const coName = company?.nameAr || company?.nameEn || "اسم الشركة";
  const printedAt = new Date().toLocaleString("en-GB", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });

  const dataRows: Array<[string, string]> = [
    ["الموظف", `${esc(doc.employeeName)}${doc.employeeCode ? ` (${esc(doc.employeeCode)})` : ""}`],
    ["تاريخ العهدة", esc(doc.custodyDate || "—")],
    ["مبلغ العهدة", `${fmtMoney(amount)} ر.س`],
    ["الحالة", esc(doc.statusLabel || "—")],
  ];
  if (doc.purpose) dataRows.push(["الغرض", esc(doc.purpose)]);

  const dataHtml = dataRows
    .map(([k, v]) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`)
    .join("");

  const lines = (doc.settlements || []).filter(Boolean);
  const settlementsHtml = lines.length
    ? `<div class="section-label" style="margin-top:18px">حركات التسوية والإرجاع</div>
       <table class="lines">
         <thead><tr>
           <th>التاريخ</th><th>النوع</th><th>الحساب / البيان</th><th>رقم الفاتورة</th><th>المبلغ</th>
         </tr></thead>
         <tbody>
         ${lines.map((s) => `<tr>
           <td>${esc(s.settleDate || "—")}</td>
           <td>${s.kind === "return" ? "إرجاع" : "مصروف"}</td>
           <td>${esc(s.account || s.description || "—")}</td>
           <td>${esc(s.invoiceNumber || "—")}</td>
           <td class="num">${fmtMoney(s.amount)} ر.س</td>
         </tr>`).join("")}
         </tbody>
       </table>`
    : "";

  const notesHtml = doc.notes
    ? `<div class="notes"><span class="notes-label">ملاحظات:</span> ${esc(doc.notes)}</div>`
    : "";

  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"/>
<title>سند عهدة — ${esc(doc.employeeName)}</title>
<style>
@page { size: A4; margin: 14mm 14mm 16mm 14mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; font-size:13px; }
.sheet { min-height: 255mm; display:flex; flex-direction:column; }
.header { display:flex; align-items:center; justify-content:center; gap:18px; border-bottom:3px solid #166534; padding:6px 0 16px; }
.header .logo img { max-height:80px; max-width:140px; object-fit:contain; }
.header .co-name { font-size:24px; font-weight:800; color:#14532d; text-align:center; }
.title-bar { background:#166534; color:#fff; font-size:17px; font-weight:800; text-align:center; padding:8px 12px; margin:12px auto 0; border-radius:6px; width:60%; }
.data-wrap { flex:1; display:flex; flex-direction:column; justify-content:flex-start; padding:14px 0 0; }
.section-label { font-size:14px; font-weight:700; color:#166534; margin:0 0 10px; text-align:center; }
table.data { width:80%; margin:0 auto; border-collapse:collapse; font-size:13.5px; }
table.data td { border:1px solid #cbd5e1; padding:9px 14px; }
table.data td.k { background:#f0fdf4; color:#166534; font-weight:700; width:40%; }
table.data td.v { font-weight:600; }
table.lines { width:90%; margin:0 auto; border-collapse:collapse; font-size:12.5px; }
table.lines th, table.lines td { border:1px solid #cbd5e1; padding:7px 10px; text-align:center; }
table.lines th { background:#166534; color:#fff; font-weight:700; }
table.lines td.num { font-weight:700; }
.notes { width:90%; margin:14px auto 0; font-size:12.5px; border:1px dashed #a7f3d0; border-radius:6px; padding:8px 12px; background:#f0fdf4; }
.notes-label { font-weight:700; color:#166534; }
.tafqeet { text-align:center; font-size:14px; font-weight:700; color:#14532d; margin:18px auto 0; padding:8px; width:80%; border-top:1px dashed #a7f3d0; }
.recipient { display:flex; justify-content:center; margin:24px auto 0; width:100%; font-size:12.5px; text-align:center; }
.sig-row { display:flex; justify-content:space-between; gap:40px; width:92%; margin:36px auto 0; font-size:12.5px; text-align:center; }
.sig-row .sig { flex:1; }
.sig { padding:0 8px; }
.sig .role { font-weight:700; margin-bottom:46px; }
.sig .line { border-top:1px solid #111; padding-top:6px; color:#475569; font-size:11px; max-width:210px; margin:0 auto; }
.footer { display:flex; justify-content:space-between; font-size:10px; color:#64748b; border-top:1px solid #e2e8f0; padding-top:6px; margin-top:18px; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#166534; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة</button>
<div class="sheet">
  <div class="header">
    ${safeLogo ? `<div class="logo"><img src="${safeLogo}" alt="" /></div>` : ""}
    <div class="co-name">${esc(coName)}</div>
  </div>
  <div class="title-bar">سند عهدة</div>
  <div class="data-wrap">
    <div class="section-label">بيانات العهدة</div>
    <table class="data">${dataHtml}</table>
    ${settlementsHtml}
    ${notesHtml}
    <div class="tafqeet">${esc(tafqeet)}</div>
    <div class="sig-row">
      <div class="sig">
        <div class="role">توقيع الموظف (المستلم)</div>
        <div class="line">${esc(doc.employeeName)}</div>
      </div>
      <div class="sig">
        <div class="role">الإدارة المالية</div>
        <div class="line">الاسم والتوقيع</div>
      </div>
    </div>
  </div>
  <div class="recipient">
    <div class="sig">
      <div class="role">اعتماد</div>
      <div class="line">الاسم والتوقيع</div>
    </div>
  </div>
  <div class="footer">
    <span>تاريخ الطباعة : ${esc(printedAt)}</span>
    <span>الصفحة 1 من 1</span>
  </div>
</div>
<script>setTimeout(function(){window.print()},300);</script>
</body></html>`;
}

/** Opens a print window (synchronously, popup-blocker safe) and writes the
 *  custody voucher HTML. */
export function printCustodyVoucher(args: CustodyVoucherArgs): void {
  const w = window.open("", "_blank", "width=900,height=900");
  if (!w) {
    args.onError?.("تم منع النوافذ المنبثقة — اسمح بفتح النوافذ المنبثقة من هذا الموقع لإجراء الطباعة.");
    return;
  }
  const html = buildCustodyVoucherHtml(args);
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/** Renders the custody voucher to a downloadable A4-portrait PDF file via
 *  html2canvas + jsPDF (dynamic-imported so they stay out of the page bundle). */
export async function downloadCustodyVoucherPdf(args: CustodyVoucherArgs, filename: string): Promise<void> {
  const html = buildCustodyVoucherHtml(args)
    .replace(/<button class="print-btn"[\s\S]*?<\/button>/, "")
    .replace(/<script>[\s\S]*?<\/script>/, "");
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;left:-99999px;top:0;width:794px;height:1123px;border:0;visibility:hidden;";
  document.body.appendChild(iframe);
  try {
    const doc = iframe.contentDocument;
    if (!doc) throw new Error("iframe contentDocument unavailable");
    doc.open(); doc.write(html); doc.close();
    await new Promise<void>((resolve) => {
      const imgs = Array.from(doc.images);
      if (imgs.length === 0) return resolve();
      let remaining = imgs.length;
      const done = () => { if (--remaining <= 0) resolve(); };
      imgs.forEach((img) => { if (img.complete) done(); else { img.addEventListener("load", done); img.addEventListener("error", done); } });
      setTimeout(resolve, 2500);
    });
    await new Promise((r) => setTimeout(r, 200));
    const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
      import("html2canvas"),
      import("jspdf"),
    ]);
    const body = doc.body;
    const fullHeight = Math.max(body.scrollHeight, doc.documentElement.scrollHeight, body.offsetHeight);
    iframe.style.height = `${fullHeight + 50}px`;
    await new Promise((r) => setTimeout(r, 80));
    const canvas = await html2canvas(body, {
      scale: 2, useCORS: true, backgroundColor: "#ffffff",
      windowWidth: 794, windowHeight: fullHeight + 50, scrollX: 0, scrollY: 0, logging: false,
    });
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgH = (canvas.height * pageW) / canvas.width;
    const img = canvas.toDataURL("image/jpeg", 0.95);
    if (imgH <= pageH) {
      pdf.addImage(img, "JPEG", 0, 0, pageW, imgH);
    } else {
      let remaining = imgH; let position = 0;
      while (remaining > 0) {
        pdf.addImage(img, "JPEG", 0, position, pageW, imgH);
        remaining -= pageH;
        if (remaining > 0) { pdf.addPage(); position -= pageH; }
      }
    }
    pdf.save(`${filename}.pdf`);
  } finally {
    document.body.removeChild(iframe);
  }
}
