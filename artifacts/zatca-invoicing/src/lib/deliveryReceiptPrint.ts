// SAP-style print HTML builder for goods-receipt (سند استلام) and delivery
// (سند تسليم) documents. Produces a complete, self-contained A4 HTML document
// with an inline auto-print script, matching the visual treatment of the
// voucher/invoice prints (company header, logo, framed party/recipient blocks,
// a bordered lines table that paginates cleanly, signature panel, footer).
//
// The caller opens a popup and writes the returned string into it. Printing is
// done in an isolated document (NOT an in-DOM @media-print overlay) so parent
// flex/overflow ancestors can never clip page 2.

import { safeLogoSrc } from "./export";

export interface DRPrintCompany {
  nameAr?: string | null;
  nameEn?: string | null;
  vatNumber?: string | null;
  crNumber?: string | null;
  city?: string | null;
  street?: string | null;
  buildingNumber?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  logo?: string | null;
}

export interface DRPrintLine {
  itemName: string;
  unit?: string | null;
  orderedQty?: number | string | null;
  actualQty?: number | string | null;
  notes?: string | null;
}

export interface DRPrintDoc {
  kind: "receipt" | "delivery";
  docNumber?: string | null;
  docDate?: string | null;
  invoiceNumber?: string | null;
  partyName?: string | null;
  warehouseName?: string | null;
  branchName?: string | null;
  status?: string | null;
  notes?: string | null;
  recipientName?: string | null;
  recipientJob?: string | null;
  recipientIdNumber?: string | null;
  recipientPhone?: string | null;
  signatureUrl?: string | null;   // resolved image URL (object download or data)
  createdByName?: string | null;
  approvedByName?: string | null;
  lines: DRPrintLine[];
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

function fmtQty(v: unknown): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function fmtDate(v?: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return esc(v);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

const STATUS_LABEL: Record<string, string> = {
  full: "استلام/تسليم كامل",
  partial: "استلام/تسليم جزئي",
  damaged: "به تلفيات",
};

export function buildDeliveryReceiptPrintHtml(doc: DRPrintDoc, company: DRPrintCompany | null): string {
  const isReceipt = doc.kind === "receipt";
  const title = isReceipt ? "سند استلام بضاعة" : "سند تسليم بضاعة";
  const partyLabel = isReceipt ? "المورد / الجهة المسلِّمة" : "العميل / الجهة المستلِمة";
  const accent = isReceipt ? "#0f766e" : "#1d4ed8";
  const logo = safeLogoSrc(company?.logo ?? null);

  const companyName = esc(company?.nameAr || company?.nameEn || "");
  const companyAddr = [company?.buildingNumber, company?.street, company?.city, company?.postalCode]
    .filter(Boolean).map(esc).join("، ");

  const rows = (doc.lines.length ? doc.lines : [{ itemName: "—" } as DRPrintLine])
    .map((l, i) => `
      <tr>
        <td class="c">${i + 1}</td>
        <td class="r-name">${esc(l.itemName)}</td>
        <td class="c">${esc(l.unit ?? "")}</td>
        <td class="c">${fmtQty(l.orderedQty)}</td>
        <td class="c">${fmtQty(l.actualQty)}</td>
        <td class="r-note">${esc(l.notes ?? "")}</td>
      </tr>`).join("");

  const signatureBlock = doc.signatureUrl
    ? `<img src="${esc(doc.signatureUrl)}" class="sig-img" alt="التوقيع" />`
    : `<div class="sig-empty"></div>`;

  return `<!doctype html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8" />
<title>${esc(title)} ${esc(doc.docNumber ?? "")}</title>
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: "Tajawal","Segoe UI",Arial,sans-serif; color: #111827; margin: 0; padding: 14mm 12mm; font-size: 12px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid ${accent}; padding-bottom: 10px; margin-bottom: 12px; }
  .co { max-width: 60%; }
  .co h1 { margin: 0 0 4px; font-size: 18px; color: ${accent}; }
  .co .meta { font-size: 11px; color: #4b5563; line-height: 1.7; }
  .logo { max-height: 66px; max-width: 180px; object-fit: contain; }
  .title-badge { text-align: center; margin: 6px 0 14px; }
  .title-badge span { display: inline-block; background: ${accent}; color: #fff; font-size: 16px; font-weight: 700; padding: 6px 26px; border-radius: 6px; letter-spacing: .5px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
  .card { border: 1px solid #d1d5db; border-radius: 6px; padding: 9px 11px; }
  .card h3 { margin: 0 0 6px; font-size: 12px; color: ${accent}; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
  .kv { display: flex; justify-content: space-between; font-size: 11px; padding: 2px 0; }
  .kv b { color: #374151; font-weight: 600; }
  .kv span { color: #111827; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  thead { display: table-header-group; }
  th, td { border: 1px solid #9ca3af; padding: 6px 7px; font-size: 11px; }
  th { background: ${accent}; color: #fff; font-weight: 700; }
  td.c { text-align: center; }
  td.r-name { text-align: right; font-weight: 600; }
  td.r-note { text-align: right; color: #4b5563; }
  tr { page-break-inside: avoid; }
  tbody tr:nth-child(even) { background: #f9fafb; }
  .notes { margin-top: 10px; border: 1px dashed #d1d5db; border-radius: 6px; padding: 8px 11px; font-size: 11px; min-height: 34px; }
  .notes b { color: ${accent}; }
  .sign-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px; page-break-inside: avoid; }
  .sign-box { border: 1px solid #d1d5db; border-radius: 6px; padding: 9px 11px; }
  .sign-box h4 { margin: 0 0 6px; font-size: 11px; color: ${accent}; }
  .sig-img { max-height: 90px; max-width: 100%; object-fit: contain; display: block; margin: 4px auto; }
  .sig-empty { height: 70px; border-bottom: 1px solid #9ca3af; }
  .recip-line { font-size: 11px; padding: 2px 0; }
  .foot { margin-top: 22px; text-align: center; font-size: 10px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 8px; }
  @media print { body { padding: 8mm; } .no-print { display: none; } }
</style>
</head>
<body>
  <div class="head">
    <div class="co">
      <h1>${companyName}</h1>
      <div class="meta">
        ${company?.vatNumber ? `الرقم الضريبي: ${esc(company.vatNumber)}<br/>` : ""}
        ${company?.crNumber ? `السجل التجاري: ${esc(company.crNumber)}<br/>` : ""}
        ${companyAddr ? `${companyAddr}<br/>` : ""}
        ${company?.phone ? `هاتف: ${esc(company.phone)}` : ""}
      </div>
    </div>
    ${logo ? `<img src="${esc(logo)}" class="logo" alt="logo" />` : ""}
  </div>

  <div class="title-badge"><span>${esc(title)}</span></div>

  <div class="grid">
    <div class="card">
      <h3>بيانات المستند</h3>
      <div class="kv"><b>رقم السند</b><span>${esc(doc.docNumber ?? "—")}</span></div>
      <div class="kv"><b>التاريخ</b><span>${fmtDate(doc.docDate)}</span></div>
      ${doc.invoiceNumber ? `<div class="kv"><b>الفاتورة المرتبطة</b><span>${esc(doc.invoiceNumber)}</span></div>` : ""}
      ${doc.warehouseName ? `<div class="kv"><b>المستودع</b><span>${esc(doc.warehouseName)}</span></div>` : ""}
      ${doc.branchName ? `<div class="kv"><b>الفرع</b><span>${esc(doc.branchName)}</span></div>` : ""}
      <div class="kv"><b>الحالة</b><span>${esc(STATUS_LABEL[doc.status ?? "full"] ?? doc.status ?? "—")}</span></div>
    </div>
    <div class="card">
      <h3>${esc(partyLabel)}</h3>
      <div class="kv"><b>الاسم</b><span>${esc(doc.partyName ?? "—")}</span></div>
      <div class="recip-line"><b>المستلِم:</b> ${esc(doc.recipientName ?? "—")}${doc.recipientJob ? ` — ${esc(doc.recipientJob)}` : ""}</div>
      ${doc.recipientIdNumber ? `<div class="recip-line"><b>رقم الهوية:</b> ${esc(doc.recipientIdNumber)}</div>` : ""}
      ${doc.recipientPhone ? `<div class="recip-line"><b>الجوال:</b> ${esc(doc.recipientPhone)}</div>` : ""}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:6%">#</th>
        <th style="width:40%">الصنف</th>
        <th style="width:12%">الوحدة</th>
        <th style="width:14%">الكمية بالفاتورة</th>
        <th style="width:14%">الكمية الفعلية</th>
        <th style="width:14%">ملاحظات</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="notes"><b>ملاحظات:</b> ${esc(doc.notes ?? "")}</div>

  <div class="sign-row">
    <div class="sign-box">
      <h4>توقيع المستلِم</h4>
      ${signatureBlock}
      <div class="recip-line" style="text-align:center;border-top:1px solid #9ca3af;margin-top:6px;padding-top:4px">${esc(doc.recipientName ?? "")}</div>
    </div>
    <div class="sign-box">
      <h4>${isReceipt ? "توقيع أمين المستودع" : "توقيع المسؤول"}</h4>
      <div class="sig-empty"></div>
      <div class="recip-line" style="text-align:center;border-top:1px solid #9ca3af;margin-top:6px;padding-top:4px">${esc(doc.approvedByName || doc.createdByName || "")}</div>
    </div>
  </div>

  <div class="foot">
    تم إنشاء هذا السند إلكترونياً بواسطة نظام زاكود · ${esc(company?.nameAr || "")} · هذا المستند لأغراض التوثيق ولا يمثل مستنداً محاسبياً أو ضريبياً
  </div>

  <script>
    window.onload = function () { setTimeout(function () { window.focus(); window.print(); }, 250); };
  </script>
</body>
</html>`;
}

// Render the print HTML into a real A4 PDF Blob (for email/download). Mirrors
// the Arabic-safe capture pipeline used elsewhere: offscreen iframe → wait for
// fonts + images → html2canvas → jsPDF, then slice one tall canvas into A4
// pages. Row-cutting is minimised by page-height slicing (docs are short).
export async function htmlToPdfBlob(html: string): Promise<Blob> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;left:-99999px;top:0;width:794px;height:1123px;border:0;visibility:hidden;";
  document.body.appendChild(iframe);
  try {
    const doc = iframe.contentDocument;
    if (!doc) throw new Error("iframe contentDocument unavailable");
    doc.open(); doc.write(html.replace(/<script[\s\S]*?<\/script>/gi, "")); doc.close();

    await new Promise<void>((resolve) => {
      const imgs = Array.from(doc.images);
      if (imgs.length === 0) return resolve();
      let remaining = imgs.length;
      const done = () => { if (--remaining <= 0) resolve(); };
      imgs.forEach((img) => {
        if (img.complete && img.naturalWidth > 0) done();
        else { img.addEventListener("load", done); img.addEventListener("error", done); }
      });
      setTimeout(resolve, 2500);
    });
    try {
      const fonts = (doc as any).fonts;
      if (fonts) {
        await Promise.race([
          (async () => {
            await Promise.all([
              fonts.load("400 12pt Tajawal").catch(() => {}),
              fonts.load("700 12pt Tajawal").catch(() => {}),
            ]);
            await fonts.ready;
          })(),
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      }
    } catch { /* font API unavailable */ }
    await Promise.all(Array.from(doc.images).map((img) =>
      typeof img.decode === "function" ? img.decode().catch(() => {}) : Promise.resolve()));
    await new Promise((r) => setTimeout(r, 200));

    const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
      import("html2canvas"), import("jspdf"),
    ]);
    const SCALE = 2;
    const body = doc.body;
    const fullHeight = Math.max(body.scrollHeight, doc.documentElement.scrollHeight, body.offsetHeight);
    iframe.style.height = `${fullHeight + 60}px`;
    iframe.contentWindow?.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 80));

    const canvas = await html2canvas(body, {
      scale: SCALE, useCORS: true, backgroundColor: "#ffffff",
      windowWidth: 794, windowHeight: fullHeight + 60, scrollX: 0, scrollY: 0, logging: false,
    });

    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    const pageWmm = 210, pageHmm = 297;
    const pxPerMm = canvas.width / pageWmm;
    const pageHpx = Math.floor(pageHmm * pxPerMm);
    let y = 0, page = 0;
    while (y < canvas.height) {
      const sliceH = Math.min(pageHpx, canvas.height - y);
      const slice = document.createElement("canvas");
      slice.width = canvas.width; slice.height = sliceH;
      const ctx = slice.getContext("2d")!;
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, slice.width, slice.height);
      ctx.drawImage(canvas, 0, y, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
      const imgData = slice.toDataURL("image/jpeg", 0.92);
      if (page > 0) pdf.addPage();
      pdf.addImage(imgData, "JPEG", 0, 0, pageWmm, sliceH / pxPerMm, undefined, "FAST");
      y += sliceH; page++;
    }
    return pdf.output("blob");
  } finally {
    document.body.removeChild(iframe);
  }
}

/** Convert a Blob to a RAW base64 string (no data: prefix — prod WAF safe). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const s = String(r.result || "");
      const comma = s.indexOf(",");
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
