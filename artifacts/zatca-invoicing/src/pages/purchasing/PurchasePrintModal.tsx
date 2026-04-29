import { useState } from "react";
import { useLocation } from "wouter";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Printer, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { safeLogoSrc } from "@/lib/export";
import { useToast } from "@/hooks/use-toast";
import { ensurePrinterReady } from "@/lib/printerGuard";

const fmt = (n: any) => Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2 });

interface PrintData {
  type: "invoice" | "return";
  doc: any;
  lines: any[];
  supplier: any;
  company: any;
}

// ─── Template generators (return HTML strings) ───────────────────────────────

function baseStyles(accent: string, accentText = "#fff") {
  return `
    <style>
      @page { size: A4; margin: 12mm 14mm; }
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; }
      body { direction: rtl; background: #fff; color: #1a1a1a; font-size: 11px; }
      .accent { background: ${accent}; color: ${accentText}; }
      .accent-text { color: ${accent}; }
      .accent-border { border-color: ${accent}; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 5px 8px; text-align: right; }
      .mono { font-variant-numeric: tabular-nums; }
      @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    </style>`;
}

function docTitle(type: "invoice" | "return") {
  return type === "invoice" ? "فاتورة مشتريات" : "مرتجع مشتريات";
}

function companyBlock(c: any) {
  // Render the company logo above the textual identity block when one
  // is configured on the General Settings page.  Pass through
  // `safeLogoSrc` to defang attribute-injection / XSS via crafted
  // values before the logo reaches the print HTML sink.
  const safeLogo = safeLogoSrc(c?.logo);
  const logo = safeLogo
    ? `<div style="margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:54px;max-width:160px;object-fit:contain;display:block;" /></div>`
    : "";
  return `
    <div>
      ${logo}
      <div style="font-size:15px;font-weight:700;">${c?.nameAr ?? "اسم الشركة"}</div>
      ${c?.nameEn ? `<div style="font-size:10px;opacity:.7;">${c.nameEn}</div>` : ""}
      ${c?.vatNumber ? `<div>الرقم الضريبي: ${c.vatNumber}</div>` : ""}
      ${c?.crNumber  ? `<div>السجل التجاري: ${c.crNumber}</div>`  : ""}
      ${c?.city      ? `<div>${c.city}${c.country ? ` — ${c.country}` : ""}</div>` : ""}
    </div>`;
}

function supplierBlock(s: any) {
  if (!s) return "<div>—</div>";
  return `
    <div>
      <div style="font-weight:600;">${s.nameAr ?? "—"}</div>
      ${s.vatNumber ? `<div>الرقم الضريبي: ${s.vatNumber}</div>` : ""}
      ${s.phone     ? `<div>هاتف: ${s.phone}</div>` : ""}
      ${s.city      ? `<div>${s.city}</div>` : ""}
    </div>`;
}

function linesTable(lines: any[], headerStyle = "", rowEvenStyle = "") {
  const showDisc = lines.some(l => (Number(l.discount) || 0) > 0);
  const rows = lines.map((l, i) => {
    const disc = Math.max(0, Math.min(100, Number(l.discount) || 0));
    const sub  = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * (1 - disc / 100);
    const vat  = sub * ((Number(l.vatRate) || 0) / 100);
    const tot  = sub + vat;
    return `
      <tr style="${i % 2 === 0 ? rowEvenStyle : ""}">
        <td>${i + 1}</td>
        <td>${l.itemName ?? l.itemCode ?? "—"}</td>
        <td class="mono">${Math.round(Number(l.qty) || 0)}</td>
        <td>${l.unit ?? "—"}</td>
        <td class="mono">${fmt(l.unitPrice)}</td>
        ${showDisc ? `<td class="mono" style="color:#b91c1c;">${disc}%</td>` : ""}
        <td class="mono">${l.vatRate ?? 15}%</td>
        <td class="mono">${fmt(vat)}</td>
        <td class="mono" style="font-weight:600;">${fmt(tot)}</td>
      </tr>`;
  }).join("");

  return `
    <table>
      <thead>
        <tr style="${headerStyle}">
          <th style="width:30px">#</th>
          <th>الصنف / الخدمة</th>
          <th>الكمية</th>
          <th>الوحدة</th>
          <th>سعر الوحدة</th>
          ${showDisc ? `<th>خصم%</th>` : ""}
          <th>الضريبة</th>
          <th>قيمة الضريبة</th>
          <th>الإجمالي</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function totalsBlock(doc: any, align = "right") {
  return `
    <div style="display:flex;justify-content:${align === "right" ? "flex-start" : "flex-end"}">
      <div style="min-width:220px;border:1px solid #ddd;border-radius:6px;padding:10px 14px;font-size:12px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
          <span style="color:#666">المجموع قبل الضريبة:</span>
          <span class="mono">${fmt(doc.subtotal)} ${doc.currencyCode ?? "SAR"}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
          <span style="color:#666">ضريبة القيمة المضافة (15%):</span>
          <span class="mono" style="color:#b45309;">${fmt(doc.vatAmount)} ${doc.currencyCode ?? "SAR"}</span>
        </div>
        <div style="display:flex;justify-content:space-between;border-top:2px solid #ddd;padding-top:6px;font-size:14px;font-weight:700;">
          <span>الإجمالي الشامل:</span>
          <span class="mono">${fmt(doc.totalAmount)} ${doc.currencyCode ?? "SAR"}</span>
        </div>
      </div>
    </div>`;
}

// ── Template 1: كلاسيكي ──────────────────────────────────────────────────────
function template1(d: PrintData): string {
  const { doc, lines, supplier, company } = d;
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  ${baseStyles("#2563eb")}
  <style>
    .header-box { border: 2px solid #2563eb; border-radius: 4px; padding: 14px 18px; display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
    .doc-badge  { background: #2563eb; color: #fff; border-radius: 4px; padding: 10px 18px; text-align: center; }
    .section    { border: 1px solid #ddd; border-radius: 4px; padding: 10px 14px; margin-bottom: 12px; }
    .section h4 { font-size: 11px; color: #2563eb; border-bottom: 1px solid #e5e7eb; margin-bottom: 8px; padding-bottom: 4px; font-weight: 700; }
    .parties    { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
    thead tr    { background: #2563eb; color: #fff; }
    tbody tr:nth-child(even) { background: #eff6ff; }
    td, th { border: 1px solid #ddd; }
    .footer { display: flex; justify-content: space-between; margin-top: 28px; font-size: 11px; color: #888; }
    .stamp { border: 2px dashed #ccc; border-radius: 50%; width: 90px; height: 90px; display: flex; align-items: center; justify-content: center; color: #ccc; font-size: 10px; text-align: center; }
  </style>
  </head><body>
  <div class="header-box">
    ${companyBlock(company)}
    <div class="doc-badge">
      <div style="font-size:16px;font-weight:700;">${docTitle(d.type)}</div>
      <div style="font-size:11px;margin-top:4px;">${d.type === "return" ? "مرتجع رقم" : "فاتورة رقم"} ${doc.docNumber ?? (d.type === "return" ? `PR-${doc.id}` : `PI-${doc.id}`)}</div>
      <div style="font-size:11px;">التاريخ: ${doc.invoiceDate ?? doc.returnDate ?? "—"}</div>
    </div>
  </div>
  <div class="parties">
    <div class="section"><h4>بيانات المورد</h4>${supplierBlock(supplier)}</div>
    <div class="section"><h4>بيانات المنشأة</h4>${companyBlock(company)}</div>
  </div>
  <div class="section">
    <h4>بنود ${docTitle(d.type)}</h4>
    ${linesTable(lines, "", "background:#eff6ff")}
  </div>
  <br>
  ${totalsBlock(doc)}
  ${doc.notes ? `<div class="section" style="margin-top:12px;"><h4>ملاحظات</h4><p>${doc.notes}</p></div>` : ""}
  <div class="footer">
    <div>
      <div>طريقة الدفع: ${doc.paymentType === "cash" ? "نقدي" : "آجل"}</div>
      <div style="margin-top:4px;color:#2563eb;">تم إنشاؤه بنظام الفاتورة الإلكترونية ZATCA</div>
    </div>
    <div style="text-align:center;">
      <div class="stamp">ختم<br>الشركة</div>
      <div style="margin-top:4px;">التوقيع المفوّض</div>
    </div>
  </div>
  </body></html>`;
}

// ── Template 2: حديث ─────────────────────────────────────────────────────────
function template2(d: PrintData): string {
  const { doc, lines, supplier, company } = d;
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  ${baseStyles("#059669")}
  <style>
    .top-bar { background: #059669; color: #fff; padding: 20px 24px; display: flex; justify-content: space-between; align-items: center; border-radius: 0 0 12px 12px; margin-bottom: 20px; }
    .top-bar .logo { font-size: 28px; font-weight: 900; opacity: .15; position: absolute; left: 24px; top: 10px; }
    .doc-num { background: rgba(255,255,255,.2); border-radius: 8px; padding: 8px 14px; font-size: 13px; font-weight: 700; }
    .card { background: #f8fafc; border-radius: 8px; padding: 12px 16px; margin-bottom: 14px; }
    .card h4 { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #059669; margin-bottom: 8px; font-weight: 700; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
    thead tr { background: #059669; color: #fff; }
    tbody tr:hover { background: #f0fdf4; }
    td, th { border-bottom: 1px solid #e5e7eb; }
    .badge { display: inline-block; background: #d1fae5; color: #065f46; border-radius: 20px; padding: 2px 10px; font-size: 10px; font-weight: 600; }
    .footer-line { border-top: 2px solid #059669; margin-top: 24px; padding-top: 10px; display: flex; justify-content: space-between; color: #6b7280; font-size: 10px; }
  </style>
  </head><body>
  <div class="top-bar" style="position:relative">
    <div style="display:flex;align-items:center;gap:10px;">
      ${(() => { const sl = safeLogoSrc(company?.logo); return sl ? `<div style="background:#fff;border-radius:6px;padding:3px 6px;display:inline-flex;align-items:center;justify-content:center;"><img src="${sl}" alt="" style="max-height:42px;max-width:120px;object-fit:contain;display:block;"/></div>` : ""; })()}
      <div>
        <div style="font-size:20px;font-weight:700;">${company?.nameAr ?? "اسم الشركة"}</div>
        <div style="opacity:.8;font-size:11px;margin-top:2px;">${company?.vatNumber ? `ر.ض: ${company.vatNumber}` : ""} ${company?.city ?? ""}</div>
      </div>
    </div>
    <div style="text-align:center">
      <div style="font-size:18px;font-weight:800;">${docTitle(d.type)}</div>
      <div class="doc-num">${doc.docNumber ?? (d.type === "return" ? `PR-${doc.id}` : `PI-${doc.id}`)}</div>
      <div style="opacity:.8;font-size:11px;margin-top:4px;">التاريخ: ${doc.invoiceDate ?? doc.returnDate ?? "—"}</div>
    </div>
  </div>
  <div class="two-col">
    <div class="card"><h4>المورد</h4>${supplierBlock(supplier)}</div>
    <div class="card">
      <h4>تفاصيل الوثيقة</h4>
      <div>النوع: <span class="badge">${doc.paymentType === "cash" ? "نقدي" : "آجل"}</span></div>
      <div style="margin-top:4px;">العملة: ${doc.currencyCode ?? "SAR"}</div>
      ${doc.invoiceId ? `<div style="margin-top:4px;">فاتورة مرجعية: ${doc.invoiceId}</div>` : ""}
    </div>
  </div>
  <div class="card">
    <h4>البنود</h4>
    ${linesTable(lines, "", "")}
  </div>
  <br>
  ${totalsBlock(doc, "left")}
  ${doc.notes ? `<div class="card" style="margin-top:12px;"><h4>ملاحظات</h4>${doc.notes}</div>` : ""}
  <div class="footer-line">
    <span>نظام الفاتورة الإلكترونية — ZATCA Compliant</span>
    <span>طُبع: ${new Date().toLocaleDateString("ar-SA")}</span>
  </div>
  </body></html>`;
}

// ── Template 3: مؤسسي ────────────────────────────────────────────────────────
function template3(d: PrintData): string {
  const { doc, lines, supplier, company } = d;
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  ${baseStyles("#1e3a5f")}
  <style>
    .header { background: linear-gradient(135deg, #1e3a5f 0%, #2d5a8e 100%); color: #fff; padding: 22px 24px; display: flex; justify-content: space-between; align-items: center; }
    .logo-circle { width: 50px; height: 50px; background: rgba(255,255,255,.15); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 900; border: 2px solid rgba(255,255,255,.3); }
    .sub-header { background: #f8f8f8; border-bottom: 3px solid #1e3a5f; padding: 10px 24px; display: flex; gap: 30px; font-size: 11px; }
    .sub-header span { color: #555; }
    .sub-header b { color: #1e3a5f; }
    .body { padding: 16px 24px; }
    .party-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px; }
    .party-box { border-right: 4px solid #1e3a5f; padding: 10px 14px; background: #f9fafb; }
    .party-box h4 { font-size: 10px; color: #1e3a5f; font-weight: 700; margin-bottom: 6px; text-transform: uppercase; letter-spacing:.06em; }
    thead tr { background: #1e3a5f; color: #fff; }
    tbody tr:nth-child(even) { background: #f1f5f9; }
    td, th { border: 1px solid #d1d5db; }
    .totals-box { background: #1e3a5f; color: #fff; border-radius: 6px; padding: 12px 16px; min-width: 240px; font-size: 12px; }
    .totals-row { display: flex; justify-content: space-between; margin-bottom: 6px; }
    .totals-row.total { border-top: 1px solid rgba(255,255,255,.3); padding-top: 8px; margin-top: 4px; font-size: 15px; font-weight: 700; }
    .footer { background: #1e3a5f; color: rgba(255,255,255,.7); padding: 8px 24px; display: flex; justify-content: space-between; font-size: 10px; margin-top: 20px; }
    .sign-area { display: flex; gap: 30px; margin-top: 20px; }
    .sign-box { flex: 1; border-top: 1px solid #ddd; padding-top: 8px; text-align: center; font-size: 10px; color: #888; }
  </style>
  </head><body>
  <div class="header">
    <div style="display:flex;align-items:center;gap:14px;">
      <div class="logo-circle">Z</div>
      <div>
        <div style="font-size:18px;font-weight:800;">${company?.nameAr ?? "الشركة"}</div>
        <div style="opacity:.75;font-size:11px;">${company?.vatNumber ? `ر.ض: ${company.vatNumber}` : ""}</div>
      </div>
    </div>
    <div style="text-align:left;">
      <div style="font-size:22px;font-weight:900;letter-spacing:-.5px;">${docTitle(d.type)}</div>
      <div style="opacity:.8;font-size:12px;margin-top:4px;">${doc.docNumber ?? (d.type === "return" ? `PR-${doc.id}` : `PI-${doc.id}`)}</div>
    </div>
  </div>
  <div class="sub-header">
    <div><span>التاريخ: </span><b>${doc.invoiceDate ?? doc.returnDate ?? "—"}</b></div>
    <div><span>طريقة الدفع: </span><b>${doc.paymentType === "cash" ? "نقدي" : "آجل"}</b></div>
    <div><span>العملة: </span><b>${doc.currencyCode ?? "SAR"}</b></div>
    ${doc.currencyCode && doc.currencyCode !== "SAR" ? `<div><span>سعر الصرف: </span><b>${doc.exchangeRate}</b></div>` : ""}
  </div>
  <div class="body">
    <div class="party-grid">
      <div class="party-box"><h4>المورد</h4>${supplierBlock(supplier)}</div>
      <div class="party-box"><h4>المنشأة</h4>${companyBlock(company)}</div>
    </div>
    ${linesTable(lines, "", "")}
    <div style="display:flex;justify-content:flex-start;margin-top:16px;">
      <div class="totals-box">
        <div class="totals-row"><span>المجموع:</span><span class="mono">${fmt(doc.subtotal)} ${doc.currencyCode ?? "SAR"}</span></div>
        <div class="totals-row"><span>الضريبة:</span><span class="mono">${fmt(doc.vatAmount)} ${doc.currencyCode ?? "SAR"}</span></div>
        <div class="totals-row total"><span>الإجمالي:</span><span class="mono">${fmt(doc.totalAmount)} ${doc.currencyCode ?? "SAR"}</span></div>
      </div>
    </div>
    ${doc.notes ? `<div style="margin-top:14px;padding:10px 14px;background:#f1f5f9;border-radius:6px;font-size:11px;"><b>ملاحظات:</b> ${doc.notes}</div>` : ""}
    <div class="sign-area">
      <div class="sign-box">توقيع المورد</div>
      <div class="sign-box">توقيع المستلم</div>
      <div class="sign-box">ختم الشركة</div>
    </div>
  </div>
  <div class="footer">
    <span>${company?.nameAr ?? ""} — ${company?.city ?? ""}</span>
    <span>ZATCA e-Invoicing System | طُبع: ${new Date().toLocaleDateString("ar-SA")}</span>
  </div>
  </body></html>`;
}

// ── Template 4: ملوّن (Warm / Branded) ───────────────────────────────────────
function template4(d: PrintData): string {
  const { doc, lines, supplier, company } = d;
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  ${baseStyles("#d97706", "#fff")}
  <style>
    .stripe { height: 6px; background: linear-gradient(90deg,#d97706,#f59e0b,#fbbf24); }
    .header { padding: 18px 22px; display: flex; justify-content: space-between; border-bottom: 1px solid #fde68a; margin-bottom: 14px; }
    .doc-pill { background: #fffbeb; border: 2px solid #d97706; border-radius: 8px; padding: 10px 18px; text-align: center; }
    .doc-pill .num { font-size: 18px; font-weight: 800; color: #92400e; }
    .section-title { font-size: 10px; font-weight: 700; color: #d97706; text-transform: uppercase; letter-spacing: .08em; border-bottom: 2px solid #fde68a; padding-bottom: 4px; margin-bottom: 8px; }
    .box { background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 10px 14px; margin-bottom: 12px; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
    thead tr { background: #d97706; color: #fff; }
    tbody tr:nth-child(even) { background: #fffbeb; }
    td, th { border: 1px solid #fde68a; }
    .total-area { background: linear-gradient(135deg,#d97706,#f59e0b); color: #fff; border-radius: 8px; padding: 14px 18px; min-width: 230px; }
    .t-row { display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 12px; }
    .t-row.grand { border-top: 1px solid rgba(255,255,255,.4); padding-top: 6px; margin-top: 4px; font-size: 16px; font-weight: 800; }
    .footer { margin-top: 22px; border-top: 3px solid #d97706; padding-top: 10px; display: flex; justify-content: space-between; font-size: 10px; color: #92400e; }
  </style>
  </head><body>
  <div class="stripe"></div>
  <div class="header">
    <div style="display:flex;align-items:center;gap:10px;">
      ${(() => { const sl = safeLogoSrc(company?.logo); return sl ? `<img src="${sl}" alt="" style="max-height:48px;max-width:130px;object-fit:contain;display:block;"/>` : ""; })()}
      <div>
        <div style="font-size:19px;font-weight:800;color:#92400e;">${company?.nameAr ?? "الشركة"}</div>
        ${company?.vatNumber ? `<div style="font-size:11px;color:#b45309;">ر.ض: ${company.vatNumber}</div>` : ""}
        ${company?.crNumber  ? `<div style="font-size:11px;color:#b45309;">س.ت: ${company.crNumber}</div>`  : ""}
        ${company?.city      ? `<div style="font-size:11px;color:#78716c;">${company.city}</div>` : ""}
      </div>
    </div>
    <div class="doc-pill">
      <div style="font-size:12px;color:#92400e;font-weight:700;">${docTitle(d.type)}</div>
      <div class="num">${doc.docNumber ?? (d.type === "return" ? `PR-${doc.id}` : `PI-${doc.id}`)}</div>
      <div style="font-size:11px;color:#b45309;">📅 ${doc.invoiceDate ?? doc.returnDate ?? "—"}</div>
    </div>
  </div>
  <div class="two-col">
    <div class="box">
      <div class="section-title">بيانات المورد</div>
      ${supplierBlock(supplier)}
    </div>
    <div class="box">
      <div class="section-title">تفاصيل</div>
      <div>الدفع: ${doc.paymentType === "cash" ? "نقدي" : "آجل"}</div>
      <div>العملة: ${doc.currencyCode ?? "SAR"}</div>
    </div>
  </div>
  <div class="box">
    <div class="section-title">أصناف ${docTitle(d.type)}</div>
    ${linesTable(lines, "", "")}
  </div>
  <div style="display:flex;justify-content:flex-start;margin-top:12px;">
    <div class="total-area">
      <div class="t-row"><span>المجموع:</span><span class="mono">${fmt(doc.subtotal)}</span></div>
      <div class="t-row"><span>الضريبة 15%:</span><span class="mono">${fmt(doc.vatAmount)}</span></div>
      <div class="t-row grand"><span>الإجمالي:</span><span class="mono">${fmt(doc.totalAmount)} ${doc.currencyCode ?? "SAR"}</span></div>
    </div>
  </div>
  ${doc.notes ? `<div class="box" style="margin-top:12px;"><div class="section-title">ملاحظات</div>${doc.notes}</div>` : ""}
  <div class="footer">
    <div>
      <div style="font-weight:700;">${company?.nameAr ?? ""}</div>
      <div style="margin-top:2px;">الرقم الضريبي: ${company?.vatNumber ?? "—"}</div>
    </div>
    <div style="text-align:left;">
      <div>نظام الفاتورة الإلكترونية المتوافق مع ZATCA</div>
      <div style="margin-top:2px;">تاريخ الطباعة: ${new Date().toLocaleDateString("ar-SA")}</div>
    </div>
  </div>
  </body></html>`;
}

// ── Template 5: ZATCA رسمي ────────────────────────────────────────────────────
function template5(d: PrintData): string {
  const { doc, lines, supplier, company } = d;
  const isReturn = d.type === "return";
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  ${baseStyles("#1a6e3d", "#fff")}
  <style>
    .zatca-header { background: #1a6e3d; color: #fff; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; }
    .zatca-title { font-size: 20px; font-weight: 900; letter-spacing: -0.5px; }
    .zatca-badge { background: rgba(255,255,255,.15); border: 1px solid rgba(255,255,255,.4); border-radius: 4px; padding: 6px 12px; font-size: 13px; text-align: center; }
    .info-strip { background: #f0fdf4; border: 1px solid #bbf7d0; padding: 8px 20px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; font-size: 11px; }
    .info-strip .label { color: #166534; font-weight: 700; font-size: 9px; text-transform: uppercase; }
    .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1.5px solid #1a6e3d; border-radius: 6px; overflow: hidden; margin-bottom: 14px; }
    .party-cell { padding: 10px 14px; }
    .party-cell:first-child { border-left: 1.5px solid #1a6e3d; }
    .party-head { background: #1a6e3d; color: #fff; font-size: 10px; font-weight: 700; padding: 4px 14px; }
    thead tr { background: #1a6e3d; color: #fff; }
    tbody tr:nth-child(even) { background: #f0fdf4; }
    td, th { border: 1px solid #d1fae5; }
    .qr-box { width: 90px; height: 90px; border: 1.5px solid #1a6e3d; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 9px; color: #1a6e3d; text-align: center; background: #f0fdf4; }
    .totals { border: 1.5px solid #1a6e3d; border-radius: 6px; overflow: hidden; min-width: 240px; font-size: 12px; }
    .totals .row { display: flex; justify-content: space-between; padding: 6px 14px; border-bottom: 1px solid #d1fae5; }
    .totals .row.grand { background: #1a6e3d; color: #fff; font-size: 15px; font-weight: 800; border: 0; }
    .footer-z { background: #1a6e3d; color: rgba(255,255,255,.8); padding: 8px 20px; display: flex; justify-content: space-between; font-size: 10px; margin-top: 18px; }
    .sign-row { display: flex; gap: 20px; margin-top: 18px; }
    .sign-cell { flex:1; border: 1px solid #1a6e3d; border-radius: 4px; padding: 8px; text-align: center; height: 60px; display: flex; flex-direction: column; justify-content: flex-end; }
    .sign-cell span { font-size: 10px; color: #1a6e3d; font-weight: 600; }
    ${isReturn ? `.return-banner { background: #fef2f2; border: 2px solid #ef4444; color: #b91c1c; text-align: center; padding: 6px; font-weight: 700; margin-bottom: 12px; border-radius: 4px; }` : ""}
  </style>
  </head><body>
  <div class="zatca-header">
    <div>
      <div class="zatca-title">${company?.nameAr ?? "الشركة"}</div>
      <div style="opacity:.8;font-size:11px;">${company?.nameEn ?? ""}</div>
    </div>
    <div class="zatca-badge">
      <div style="font-size:14px;font-weight:700;">${docTitle(d.type)}</div>
      <div style="font-size:12px;margin-top:2px;">Purchase ${isReturn ? "Return" : "Invoice"}</div>
    </div>
  </div>

  ${isReturn ? `<div class="return-banner">⚠ مستند مرتجع مشتريات — لا يُعدّ فاتورة بيع</div>` : ""}

  <div class="info-strip">
    <div><div class="label">رقم الوثيقة</div><b>${doc.docNumber ?? (isReturn ? `PR-${doc.id}` : `PI-${doc.id}`)}</b></div>
    <div><div class="label">التاريخ</div><b>${doc.invoiceDate ?? doc.returnDate ?? "—"}</b></div>
    <div><div class="label">طريقة الدفع</div><b>${doc.paymentType === "cash" ? "نقدي Cash" : "آجل Credit"}</b></div>
    <div><div class="label">العملة</div><b>${doc.currencyCode ?? "SAR"}</b></div>
  </div>

  <div class="parties">
    <div>
      <div class="party-head">البائع / المورد — Seller / Supplier</div>
      <div class="party-cell">${supplierBlock(supplier)}</div>
    </div>
    <div>
      <div class="party-head">المشتري / المنشأة — Buyer / Entity</div>
      <div class="party-cell">${companyBlock(company)}</div>
    </div>
  </div>

  ${linesTable(lines, "", "")}

  <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:16px;">
    <div>
      <div style="font-size:10px;color:#1a6e3d;font-weight:700;margin-bottom:6px;">رمز QR للتحقق</div>
      <div class="qr-box">QR Code<br>ZATCA<br>رمز التحقق</div>
    </div>
    <div class="totals">
      <div class="row"><span>المجموع الخاضع للضريبة:</span><span class="mono">${fmt(doc.subtotal)} ${doc.currencyCode ?? "SAR"}</span></div>
      <div class="row"><span>ضريبة القيمة المضافة (15%):</span><span class="mono" style="color:#b45309;">${fmt(doc.vatAmount)} ${doc.currencyCode ?? "SAR"}</span></div>
      <div class="row grand"><span>الإجمالي الشامل:</span><span class="mono">${fmt(doc.totalAmount)} ${doc.currencyCode ?? "SAR"}</span></div>
    </div>
  </div>

  ${doc.notes ? `<div style="margin-top:12px;padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:4px;font-size:11px;"><b>ملاحظات:</b> ${doc.notes}</div>` : ""}

  <div class="sign-row">
    <div class="sign-cell"><span>اعتماد المورد</span></div>
    <div class="sign-cell"><span>اعتماد المستلم</span></div>
    <div class="sign-cell"><span>مدير الشراء</span></div>
    <div class="sign-cell"><span>ختم الشركة</span></div>
  </div>

  <div class="footer-z">
    <span>ر.ض: ${company?.vatNumber ?? "—"} | س.ت: ${company?.crNumber ?? "—"} | ${company?.city ?? ""}</span>
    <span>ZATCA e-Invoicing System — طُبع: ${new Date().toLocaleDateString("ar-SA")}</span>
  </div>
  </body></html>`;
}

// ─── Template registry ────────────────────────────────────────────────────────
const TEMPLATES = [
  { id: 1, name: "كلاسيكي",    desc: "حدود وجداول تقليدية",      color: "#2563eb", fn: template1 },
  { id: 2, name: "حديث",       desc: "تصميم نظيف بهيدر أخضر",   color: "#059669", fn: template2 },
  { id: 3, name: "مؤسسي",      desc: "هيدر داكن احترافي",        color: "#1e3a5f", fn: template3 },
  { id: 4, name: "ملوّن",      desc: "ألوان دافئة مع تدرج",      color: "#d97706", fn: template4 },
  { id: 5, name: "ZATCA رسمي", desc: "النموذج الحكومي مع QR",    color: "#1a6e3d", fn: template5 },
];

// ─── Main Modal ───────────────────────────────────────────────────────────────
interface Props {
  open: boolean;
  onClose: () => void;
  data: PrintData | null;
}

export default function PurchasePrintModal({ open, onClose, data }: Props) {
  const [selected, setSelected] = useState(1);
  const { toast } = useToast();
  const [, navigate] = useLocation();

  function handlePrint() {
    if (!data) return;
    if (!ensurePrinterReady(toast, navigate)) return;
    const tmpl = TEMPLATES.find(t => t.id === selected);
    if (!tmpl) return;
    const html = tmpl.fn(data);
    const win = window.open("", "_blank", "width=900,height=700");
    if (!win) return;
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.onload = () => { win.print(); };
  }

  if (!data) return null;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Printer className="h-5 w-5 text-primary" />
            اختر نموذج الطباعة — {data.type === "invoice" ? "فاتورة المشتريات" : "مرتجع المشتريات"}
          </DialogTitle>
        </DialogHeader>

        {/* Template selector */}
        <div className="grid grid-cols-5 gap-3 my-4">
          {TEMPLATES.map(t => (
            <button
              key={t.id}
              onClick={() => setSelected(t.id)}
              className={cn(
                "rounded-xl border-2 p-3 text-center transition-all hover:shadow-md",
                selected === t.id
                  ? "shadow-lg scale-105"
                  : "border-border hover:border-muted-foreground"
              )}
              style={selected === t.id ? { borderColor: t.color } : {}}
            >
              {/* Mini preview */}
              <div
                className="w-full aspect-[3/4] rounded-md mb-2 flex flex-col overflow-hidden"
                style={{ background: "#f8f8f8", border: `2px solid ${t.color}` }}
              >
                <div className="h-6 w-full flex-shrink-0" style={{ background: t.color }} />
                <div className="flex-1 p-1 space-y-1">
                  {[70, 55, 85, 50, 65].map((w, i) => (
                    <div key={i} className="rounded-sm h-1.5" style={{ width: `${w}%`, background: i === 0 ? t.color : "#ddd", opacity: i === 0 ? .8 : 1 }} />
                  ))}
                  <div className="h-px w-full" style={{ background: t.color, opacity: .3 }} />
                  {[100, 80, 90, 70].map((w, i) => (
                    <div key={i} className="rounded-sm h-1" style={{ width: `${w}%`, background: "#e5e5e5" }} />
                  ))}
                </div>
              </div>
              <p className="text-xs font-bold" style={selected === t.id ? { color: t.color } : {}}>{t.name}</p>
              <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">{t.desc}</p>
            </button>
          ))}
        </div>

        {/* Info summary */}
        <div className="rounded-lg bg-muted/40 border px-4 py-3 text-sm space-y-1">
          <div className="flex gap-6">
            <span className="text-muted-foreground">المورد:</span>
            <span className="font-medium">{data.supplier?.nameAr ?? "—"}</span>
            <span className="text-muted-foreground">الوثيقة:</span>
            <span className="font-mono font-medium">
              {data.doc.docNumber ?? (data.type === "return" ? `PR-${data.doc.id}` : `PI-${data.doc.id}`)}
            </span>
          </div>
          <div className="flex gap-6">
            <span className="text-muted-foreground">الإجمالي:</span>
            <span className="font-bold text-primary">
              {Number(data.doc.totalAmount || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2 })} {data.doc.currencyCode ?? "SAR"}
            </span>
            <span className="text-muted-foreground">الأصناف:</span>
            <span>{data.lines.length} صنف</span>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={onClose}>
            <X className="h-4 w-4 ml-1" />إلغاء
          </Button>
          <Button onClick={handlePrint} className="gap-2">
            <Printer className="h-4 w-4" />طباعة النموذج {selected}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
