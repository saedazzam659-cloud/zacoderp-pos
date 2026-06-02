import { useState } from "react";
import { useLocation } from "wouter";
import QRCode from "qrcode";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Printer, X, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { ensurePrinterReady } from "@/lib/printerGuard";
import { currencySymbol } from "@/lib/format";

// ─── Types ────────────────────────────────────────────────────────────────────
export interface PrintInvoice {
  invoiceNumber: string;
  issueDate: string;
  supplyDate?: string | null;
  paymentMethod?: string | null;
  invoiceType: string;
  status: string;
  notes?: string | null;
  subtotal: number | string;
  taxAmount: number | string;
  total: number | string;
  currencyCode?: string | null;
  discountAmount?: number | string | null;
  qrCode?: string | null;
  lineItems?: Array<{
    description: string;
    quantity: number | string;
    unitPrice: number | string;
    vatRate?: number | string | null;
    vatAmount?: number | string | null;
    totalPrice: number | string;
  }>;
  customer?: {
    nameAr?: string | null;
    nameEn?: string | null;
    vatNumber?: string | null;
    city?: string | null;
    phone?: string | null;
    email?: string | null;
  } | null;
  company?: {
    nameAr?: string | null;
    nameEn?: string | null;
    vatNumber?: string | null;
    crNumber?: string | null;
    city?: string | null;
    street?: string | null;
    phone?: string | null;
    logo?: string | null;
    decimalPlaces?: number | null;
  } | null;
}

// ─── Templates metadata ───────────────────────────────────────────────────────
const TEMPLATES = [
  {
    id: "classic",
    nameAr: "الكلاسيكي",
    desc: "تصميم تقليدي بحدود سوداء",
    preview: (
      <div className="bg-white border border-gray-300 rounded p-2 h-full flex flex-col gap-1 text-[6px]">
        <div className="border-b border-gray-400 pb-1 text-center font-bold text-[7px]">شركة المثال</div>
        <div className="flex justify-between border-b border-dashed border-gray-300 pb-1">
          <span>فاتورة ضريبية</span><span>#INV-001</span>
        </div>
        <div className="flex-1 border border-gray-200 rounded">
          <div className="bg-gray-100 flex px-1 py-0.5 font-bold"><span className="flex-1">البيان</span><span>المبلغ</span></div>
          <div className="flex px-1 py-0.5"><span className="flex-1">منتج 1</span><span>100</span></div>
          <div className="flex px-1 py-0.5"><span className="flex-1">منتج 2</span><span>200</span></div>
        </div>
        <div className="flex justify-between border-t border-gray-300 pt-1 font-bold">
          <span>الإجمالي</span><span>345 ريال</span>
        </div>
      </div>
    ),
  },
  {
    id: "modern",
    nameAr: "العصري",
    desc: "نظيف وبسيط برمادي خفيف",
    preview: (
      <div className="bg-white rounded p-2 h-full flex flex-col gap-1 text-[6px]">
        <div className="flex justify-between items-center pb-1">
          <div className="bg-gray-800 text-white text-[6px] px-1.5 py-0.5 rounded font-bold">INVOICE</div>
          <span className="text-gray-500">#INV-001</span>
        </div>
        <div className="text-[7px] font-bold text-gray-800">شركة المثال</div>
        <div className="h-px bg-gray-200 my-0.5" />
        <div className="flex-1 space-y-0.5">
          <div className="flex justify-between text-gray-500"><span>منتج 1</span><span>100</span></div>
          <div className="flex justify-between text-gray-500"><span>منتج 2</span><span>200</span></div>
        </div>
        <div className="bg-gray-800 text-white flex justify-between px-1.5 py-0.5 rounded text-[6px]">
          <span>الإجمالي</span><span>345</span>
        </div>
      </div>
    ),
  },
  {
    id: "professional",
    nameAr: "الاحترافي",
    desc: "رأس أخضر مع تخطيط منظم",
    preview: (
      <div className="bg-white rounded overflow-hidden h-full flex flex-col text-[6px]">
        <div className="bg-teal-600 text-white px-2 py-1.5">
          <div className="font-bold text-[7px]">شركة المثال</div>
          <div className="opacity-80">فاتورة ضريبية</div>
        </div>
        <div className="p-2 flex-1 flex flex-col gap-1">
          <div className="flex justify-between text-gray-500 text-[5px]">
            <span>رقم الفاتورة: INV-001</span><span>2026/01/01</span>
          </div>
          <table className="w-full text-[5px]">
            <thead><tr className="bg-teal-50"><td className="p-0.5">البيان</td><td className="p-0.5 text-left">المبلغ</td></tr></thead>
            <tbody>
              <tr><td className="p-0.5">منتج 1</td><td className="p-0.5 text-left">100</td></tr>
              <tr><td className="p-0.5">منتج 2</td><td className="p-0.5 text-left">200</td></tr>
            </tbody>
          </table>
          <div className="bg-teal-600 text-white flex justify-between px-1 py-0.5 rounded text-[5px]">
            <span>الإجمالي</span><span>345</span>
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "colorful",
    nameAr: "الملوّن",
    desc: "رأس أزرق متدرج وخط عريض",
    preview: (
      <div className="bg-white rounded overflow-hidden h-full flex flex-col text-[6px]">
        <div className="bg-gradient-to-l from-blue-700 to-indigo-800 text-white px-2 py-2">
          <div className="font-bold text-[7px]">شركة المثال</div>
          <div className="mt-0.5 flex justify-between opacity-80 text-[5px]">
            <span>فاتورة ضريبية</span><span>#INV-001</span>
          </div>
        </div>
        <div className="p-2 flex-1 flex flex-col gap-1">
          <div className="grid grid-cols-2 gap-1 text-[5px]">
            <div className="bg-blue-50 rounded px-1 py-0.5"><span className="text-blue-700">التاريخ</span><br/>2026/01/01</div>
            <div className="bg-indigo-50 rounded px-1 py-0.5"><span className="text-indigo-700">العميل</span><br/>أحمد محمد</div>
          </div>
          <div className="flex-1 space-y-0.5 text-[5px]">
            <div className="flex justify-between border-b border-gray-100 pb-0.5"><span>منتج 1</span><span>100</span></div>
            <div className="flex justify-between border-b border-gray-100 pb-0.5"><span>منتج 2</span><span>200</span></div>
          </div>
          <div className="bg-indigo-600 text-white flex justify-between px-1 py-0.5 rounded text-[5px]">
            <span>الإجمالي</span><span>345</span>
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "compact",
    nameAr: "المدمج",
    desc: "تصميم ثنائي الأعمدة مع QR بارز",
    preview: (
      <div className="bg-white rounded overflow-hidden h-full flex flex-col text-[6px]">
        <div className="bg-purple-700 text-white px-2 py-1 text-center">
          <div className="font-bold text-[7px]">شركة المثال</div>
        </div>
        <div className="flex flex-1 p-1 gap-1">
          <div className="flex-1 flex flex-col gap-0.5 text-[5px]">
            <div className="font-bold text-[6px]">#INV-001</div>
            <div className="text-gray-500">2026/01/01</div>
            <div className="mt-0.5 flex flex-col gap-0.5">
              <div className="flex justify-between"><span>منتج 1</span><span>100</span></div>
              <div className="flex justify-between"><span>منتج 2</span><span>200</span></div>
            </div>
            <div className="mt-auto bg-purple-600 text-white flex justify-between px-0.5 py-0.5 rounded text-[5px]">
              <span>الإجمالي</span><span>345</span>
            </div>
          </div>
          <div className="flex flex-col items-center justify-center bg-gray-50 rounded border border-gray-200 w-10">
            <div className="w-7 h-7 bg-gray-800 rounded-sm flex items-center justify-center">
              <div className="grid grid-cols-3 gap-px w-5 h-5">
                {Array.from({length: 9}).map((_,i) => (
                  <div key={i} className={`${[0,1,3,5,7,8].includes(i) ? 'bg-white' : 'bg-gray-800'}`} />
                ))}
              </div>
            </div>
            <span className="text-[4px] text-gray-500 mt-0.5">QR Code</span>
          </div>
        </div>
      </div>
    ),
  },
];

// ─── Format helpers ────────────────────────────────────────────────────────────
const PAYMENT_LABELS: Record<string, string> = {
  "10": "نقدي", "30": "تحويل بنكي", "42": "حساب بنكي",
  "48": "بطاقة بنكية", "1": "أخرى",
};

function fmt(n: number | string, dp = 2) {
  return Number(n).toLocaleString("ar-SA", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtDate(d: string) {
  try { return new Date(d).toLocaleDateString("ar-SA", { year: "numeric", month: "long", day: "numeric" }); }
  catch { return d; }
}

// ─── HTML template generators ─────────────────────────────────────────────────

function buildClassicHtml(inv: PrintInvoice, qrDataUrl: string): string {
  const dp = inv.company?.decimalPlaces ?? 2;
  const sym = currencySymbol(inv.currencyCode);
  const logo = inv.company?.logo;
  return `<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>فاتورة ${inv.invoiceNumber}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 12px; color: #111; background: #fff; direction: rtl; }
  .page { max-width: 800px; margin: 0 auto; padding: 32px; border: 2px solid #111; }
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
  .totals { margin-right: auto; width: 260px; }
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
      <h1>${inv.company?.nameAr ?? ""}</h1>
      ${inv.company?.nameEn ? `<p>${inv.company.nameEn}</p>` : ""}
      <p>الرقم الضريبي: ${inv.company?.vatNumber ?? ""}</p>
      ${inv.company?.crNumber ? `<p>السجل التجاري: ${inv.company.crNumber}</p>` : ""}
      ${inv.company?.city ? `<p>${inv.company.city}${inv.company.street ? " — " + inv.company.street : ""}</p>` : ""}
    </div>
    ${logo ? `<img src="${logo}" class="logo" alt="شعار" />` : '<div style="width:80px"></div>'}
  </div>

  <div class="title-box">
    <h2>${inv.invoiceType === "standard" ? "فاتورة ضريبية" : "فاتورة ضريبية مبسطة"}</h2>
  </div>

  <div class="meta-grid">
    <div class="meta-item"><span class="label">رقم الفاتورة:</span><span>${inv.invoiceNumber}</span></div>
    <div class="meta-item"><span class="label">تاريخ الإصدار:</span><span>${fmtDate(inv.issueDate)}</span></div>
    ${inv.supplyDate ? `<div class="meta-item"><span class="label">تاريخ التوريد:</span><span>${fmtDate(inv.supplyDate)}</span></div>` : ""}
    ${inv.paymentMethod ? `<div class="meta-item"><span class="label">طريقة الدفع:</span><span>${PAYMENT_LABELS[inv.paymentMethod] ?? inv.paymentMethod}</span></div>` : ""}
    ${inv.customer?.nameAr ? `<div class="meta-item"><span class="label">العميل:</span><span>${inv.customer.nameAr}</span></div>` : ""}
    ${inv.customer?.vatNumber ? `<div class="meta-item"><span class="label">رقم ضريبي العميل:</span><span>${inv.customer.vatNumber}</span></div>` : ""}
  </div>

  <table>
    <thead><tr><th>البيان</th><th>الكمية</th><th>سعر الوحدة</th><th>نسبة الضريبة</th><th>الضريبة</th><th>الإجمالي</th></tr></thead>
    <tbody>
      ${(inv.lineItems ?? []).map(li => `
        <tr>
          <td>${li.description}</td>
          <td style="text-align:center">${li.quantity}</td>
          <td>${fmt(li.unitPrice, dp)}</td>
          <td style="text-align:center">${li.vatRate ?? 15}%</td>
          <td>${fmt(li.vatAmount ?? 0, dp)}</td>
          <td style="font-weight:bold">${fmt(li.totalPrice, dp)}</td>
        </tr>`).join("")}
    </tbody>
  </table>

  <div class="totals">
    <div class="totals-row"><span>المبلغ قبل الضريبة</span><span>${fmt(inv.subtotal, dp)} ${sym}</span></div>
    ${inv.discountAmount ? `<div class="totals-row"><span>الخصم</span><span>- ${fmt(inv.discountAmount, dp)} ${sym}</span></div>` : ""}
    <div class="totals-row"><span>ضريبة القيمة المضافة (15%)</span><span>${fmt(inv.taxAmount, dp)} ${sym}</span></div>
    <div class="totals-row total"><span>الإجمالي المستحق</span><span>${fmt(inv.total, dp)} ${sym}</span></div>
  </div>

  ${inv.notes ? `<div style="margin-top:16px;border:1px solid #ccc;padding:8px;font-size:11px"><strong>ملاحظات:</strong> ${inv.notes}</div>` : ""}

  <div class="footer">
    <div><p>توليد من نظام الفاتورة الإلكترونية — ZATCA Compliant</p><p>تاريخ الطباعة: ${new Date().toLocaleDateString("ar-SA")}</p></div>
    ${qrDataUrl ? `<div class="qr-box"><img src="${qrDataUrl}" width="100" height="100" /><p>رمز QR للتحقق</p></div>` : ""}
  </div>
</div></body></html>`;
}

function buildModernHtml(inv: PrintInvoice, qrDataUrl: string): string {
  const dp = inv.company?.decimalPlaces ?? 2;
  const sym = currencySymbol(inv.currencyCode);
  const logo = inv.company?.logo;
  return `<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>فاتورة ${inv.invoiceNumber}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 12px; color: #222; background: #fafafa; direction: rtl; }
  .page { max-width: 800px; margin: 0 auto; background: #fff; padding: 40px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
  .company-name { font-size: 22px; font-weight: 700; color: #111; }
  .company-sub { font-size: 11px; color: #888; margin-top: 4px; line-height: 1.6; }
  .badge { display: inline-block; background: #222; color: #fff; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 4px; letter-spacing: 1px; margin-bottom: 6px; }
  .inv-num { font-size: 16px; font-weight: 700; color: #222; }
  .inv-date { font-size: 11px; color: #888; margin-top: 3px; }
  .logo { max-height: 70px; max-width: 180px; object-fit: contain; }
  .divider { height: 2px; background: #f0f0f0; margin: 20px 0; }
  .meta-row { display: flex; gap: 24px; margin-bottom: 20px; }
  .meta-card { flex: 1; background: #f8f8f8; border-radius: 8px; padding: 12px 14px; }
  .meta-card .title { font-size: 10px; color: #888; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .meta-card .value { font-size: 12px; font-weight: 600; color: #111; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  thead tr { border-bottom: 2px solid #222; }
  th { padding: 8px 10px; color: #555; font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; text-align: right; }
  td { padding: 8px 10px; border-bottom: 1px solid #f0f0f0; }
  .totals { margin-top: 20px; margin-right: auto; width: 280px; }
  .t-row { display: flex; justify-content: space-between; padding: 5px 10px; font-size: 12px; color: #555; }
  .t-row.grand { background: #222; color: #fff; font-size: 14px; font-weight: 800; border-radius: 6px; margin-top: 4px; padding: 8px 12px; }
  .footer { margin-top: 32px; display: flex; justify-content: space-between; align-items: flex-end; padding-top: 20px; border-top: 1px solid #f0f0f0; }
  .footer p { font-size: 10px; color: #bbb; }
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style></head>
<body><div class="page">
  <div class="header">
    <div>
      ${logo ? `<img src="${logo}" class="logo" alt="شعار" style="margin-bottom:12px;display:block" />` : ""}
      <div class="company-name">${inv.company?.nameAr ?? ""}</div>
      ${inv.company?.nameEn ? `<div class="company-sub">${inv.company.nameEn}</div>` : ""}
      <div class="company-sub">ر.ض: ${inv.company?.vatNumber ?? ""}${inv.company?.city ? " | " + inv.company.city : ""}</div>
    </div>
    <div style="text-align:left">
      <div class="badge">INVOICE</div>
      <div class="inv-num">${inv.invoiceNumber}</div>
      <div class="inv-date">${fmtDate(inv.issueDate)}</div>
    </div>
  </div>

  <div class="meta-row">
    <div class="meta-card"><div class="title">نوع الفاتورة</div><div class="value">${inv.invoiceType === "standard" ? "فاتورة ضريبية B2B" : "فاتورة مبسطة B2C"}</div></div>
    ${inv.paymentMethod ? `<div class="meta-card"><div class="title">طريقة الدفع</div><div class="value">${PAYMENT_LABELS[inv.paymentMethod] ?? inv.paymentMethod}</div></div>` : ""}
    ${inv.customer?.nameAr ? `<div class="meta-card"><div class="title">العميل</div><div class="value">${inv.customer.nameAr}</div></div>` : ""}
    ${inv.supplyDate ? `<div class="meta-card"><div class="title">تاريخ التوريد</div><div class="value">${fmtDate(inv.supplyDate)}</div></div>` : ""}
  </div>

  <table>
    <thead><tr><th>البيان</th><th>الكمية</th><th>سعر الوحدة</th><th>الضريبة</th><th>الإجمالي</th></tr></thead>
    <tbody>
      ${(inv.lineItems ?? []).map(li => `<tr>
        <td>${li.description}</td>
        <td style="text-align:center">${li.quantity}</td>
        <td>${fmt(li.unitPrice, dp)}</td>
        <td>${fmt(li.vatAmount ?? 0, dp)} <span style="color:#888">(${li.vatRate ?? 15}%)</span></td>
        <td style="font-weight:700">${fmt(li.totalPrice, dp)}</td>
      </tr>`).join("")}
    </tbody>
  </table>

  <div class="totals">
    <div class="t-row"><span>المبلغ قبل الضريبة</span><span>${fmt(inv.subtotal, dp)}</span></div>
    <div class="t-row"><span>ضريبة 15%</span><span>${fmt(inv.taxAmount, dp)}</span></div>
    <div class="t-row grand"><span>الإجمالي — ${sym}</span><span>${fmt(inv.total, dp)}</span></div>
  </div>

  ${inv.notes ? `<div style="margin-top:20px;background:#f8f8f8;border-radius:8px;padding:12px;font-size:11px;color:#555"><strong>ملاحظات:</strong> ${inv.notes}</div>` : ""}

  <div class="footer">
    <div><p>نظام الفاتورة الإلكترونية | ZATCA Compliant</p><p>طُبعت: ${new Date().toLocaleDateString("ar-SA")}</p></div>
    ${qrDataUrl ? `<div style="text-align:center"><img src="${qrDataUrl}" width="90" height="90" /><p style="font-size:9px;color:#bbb;margin-top:4px">رمز QR</p></div>` : ""}
  </div>
</div></body></html>`;
}

function buildProfessionalHtml(inv: PrintInvoice, qrDataUrl: string): string {
  const dp = inv.company?.decimalPlaces ?? 2;
  const sym = currencySymbol(inv.currencyCode);
  const logo = inv.company?.logo;
  const C = "#0d9488";  // teal-600
  return `<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>فاتورة ${inv.invoiceNumber}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 12px; color: #1a1a1a; background: #fff; direction: rtl; }
  .page { max-width: 800px; margin: 0 auto; }
  .top-bar { height: 6px; background: ${C}; }
  .header { background: ${C}; color: #fff; padding: 24px 32px; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 22px; font-weight: 800; }
  .header p { font-size: 11px; opacity: 0.85; margin-top: 3px; }
  .header .inv-info { text-align: left; }
  .header .inv-info .num { font-size: 16px; font-weight: 700; }
  .header .inv-info .date { font-size: 11px; opacity: 0.8; margin-top: 2px; }
  .logo-white { max-height: 65px; max-width: 160px; object-fit: contain; filter: brightness(0) invert(1); }
  .body { padding: 28px 32px; }
  .info-strip { display: flex; gap: 16px; margin-bottom: 24px; }
  .info-box { flex: 1; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; }
  .info-box .title { font-size: 10px; color: #888; font-weight: 700; text-transform: uppercase; margin-bottom: 6px; }
  .info-box p { font-size: 11px; color: #222; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { background: ${C}; color: #fff; padding: 8px 10px; text-align: right; font-size: 10px; letter-spacing: 0.5px; }
  td { padding: 7px 10px; border-bottom: 1px solid #f1f5f9; }
  tr:nth-child(odd) td { background: #f8fffe; }
  .totals { display: flex; justify-content: flex-end; margin-top: 20px; }
  .totals-inner { width: 280px; }
  .t-row { display: flex; justify-content: space-between; padding: 5px 10px; border-bottom: 1px solid #f0f0f0; font-size: 12px; }
  .t-row.grand { background: ${C}; color: #fff; font-weight: 800; font-size: 14px; border-radius: 6px; padding: 9px 12px; border: none; margin-top: 4px; }
  .footer-bar { background: #f8fffe; border-top: 2px solid ${C}; padding: 16px 32px; display: flex; justify-content: space-between; align-items: center; margin-top: 24px; }
  .footer-bar p { font-size: 10px; color: #888; }
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style></head>
<body><div class="page">
  <div class="top-bar"></div>
  <div class="header">
    <div>
      ${logo ? `<img src="${logo}" class="logo-white" alt="شعار" style="margin-bottom:10px;display:block" />` : ""}
      <h1>${inv.company?.nameAr ?? ""}</h1>
      ${inv.company?.nameEn ? `<p>${inv.company.nameEn}</p>` : ""}
      <p>ر.ض: ${inv.company?.vatNumber ?? ""}${inv.company?.city ? " | " + inv.company.city : ""}</p>
    </div>
    <div class="inv-info">
      <div style="font-size:11px;opacity:0.8">${inv.invoiceType === "standard" ? "فاتورة ضريبية" : "فاتورة مبسطة"}</div>
      <div class="num">${inv.invoiceNumber}</div>
      <div class="date">${fmtDate(inv.issueDate)}</div>
    </div>
  </div>

  <div class="body">
    <div class="info-strip">
      ${inv.customer?.nameAr ? `<div class="info-box"><div class="title">العميل</div><p>${inv.customer.nameAr}</p>${inv.customer.vatNumber ? `<p>ر.ض: ${inv.customer.vatNumber}</p>` : ""}${inv.customer.city ? `<p>${inv.customer.city}</p>` : ""}</div>` : ""}
      <div class="info-box"><div class="title">تفاصيل الفاتورة</div><p>رقم: ${inv.invoiceNumber}</p><p>التاريخ: ${fmtDate(inv.issueDate)}</p>${inv.supplyDate ? `<p>التوريد: ${fmtDate(inv.supplyDate)}</p>` : ""}</div>
      ${inv.paymentMethod ? `<div class="info-box"><div class="title">الدفع</div><p>${PAYMENT_LABELS[inv.paymentMethod] ?? inv.paymentMethod}</p></div>` : ""}
    </div>

    <table>
      <thead><tr><th>البيان</th><th>الكمية</th><th>سعر الوحدة</th><th>نسبة الضريبة</th><th>الضريبة</th><th>الإجمالي</th></tr></thead>
      <tbody>
        ${(inv.lineItems ?? []).map(li => `<tr>
          <td>${li.description}</td>
          <td style="text-align:center">${li.quantity}</td>
          <td>${fmt(li.unitPrice, dp)} ${sym}</td>
          <td style="text-align:center">${li.vatRate ?? 15}%</td>
          <td>${fmt(li.vatAmount ?? 0, dp)} ${sym}</td>
          <td style="font-weight:700;color:${C}">${fmt(li.totalPrice, dp)} ${sym}</td>
        </tr>`).join("")}
      </tbody>
    </table>

    <div class="totals"><div class="totals-inner">
      <div class="t-row"><span>المبلغ قبل الضريبة</span><span>${fmt(inv.subtotal, dp)} ${sym}</span></div>
      ${inv.discountAmount ? `<div class="t-row"><span>الخصم</span><span>- ${fmt(inv.discountAmount, dp)} ${sym}</span></div>` : ""}
      <div class="t-row"><span>ضريبة القيمة المضافة 15%</span><span>${fmt(inv.taxAmount, dp)} ${sym}</span></div>
      <div class="t-row grand"><span>الإجمالي المستحق</span><span>${fmt(inv.total, dp)} ${sym}</span></div>
    </div></div>

    ${inv.notes ? `<div style="margin-top:16px;border-right:4px solid ${C};padding:10px 14px;background:#f0fdfa;font-size:11px;border-radius:0 8px 8px 0"><strong>ملاحظات:</strong> ${inv.notes}</div>` : ""}
  </div>

  <div class="footer-bar">
    <p>نظام الفاتورة الإلكترونية | ZATCA Compliant | طُبعت: ${new Date().toLocaleDateString("ar-SA")}</p>
    ${qrDataUrl ? `<div style="text-align:center"><img src="${qrDataUrl}" width="85" height="85" /><p style="font-size:9px;color:#aaa;margin-top:3px">رمز QR</p></div>` : ""}
  </div>
</div></body></html>`;
}

function buildColorfulHtml(inv: PrintInvoice, qrDataUrl: string): string {
  const dp = inv.company?.decimalPlaces ?? 2;
  const sym = currencySymbol(inv.currencyCode);
  const logo = inv.company?.logo;
  return `<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>فاتورة ${inv.invoiceNumber}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 12px; color: #1e1b4b; background: #fff; direction: rtl; }
  .page { max-width: 800px; margin: 0 auto; }
  .header { background: linear-gradient(135deg, #1e40af 0%, #4f46e5 60%, #7c3aed 100%); color: #fff; padding: 28px 32px; }
  .header-top { display: flex; justify-content: space-between; align-items: flex-start; }
  .company-name { font-size: 22px; font-weight: 800; }
  .company-sub { font-size: 11px; opacity: 0.8; margin-top: 3px; }
  .logo-white { max-height: 65px; max-width: 160px; object-fit: contain; filter: brightness(0) invert(1); }
  .invoice-badge { background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.3); border-radius: 8px; padding: 10px 16px; text-align: center; }
  .invoice-badge .type { font-size: 10px; opacity: 0.8; letter-spacing: 1px; }
  .invoice-badge .num { font-size: 15px; font-weight: 700; margin-top: 4px; }
  .invoice-badge .date { font-size: 11px; opacity: 0.8; margin-top: 2px; }
  .header-cards { display: flex; gap: 10px; margin-top: 20px; }
  .h-card { flex: 1; background: rgba(255,255,255,0.15); border-radius: 8px; padding: 10px 12px; }
  .h-card .label { font-size: 9px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.5px; }
  .h-card .val { font-size: 12px; font-weight: 700; margin-top: 3px; }
  .body { padding: 28px 32px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { background: #4f46e5; color: #fff; padding: 9px 10px; text-align: right; font-size: 10px; }
  td { padding: 7px 10px; border-bottom: 1px solid #e8e8f0; }
  tr:nth-child(even) td { background: #f5f3ff; }
  .totals { display: flex; justify-content: flex-end; margin-top: 20px; }
  .totals-inner { width: 300px; border: 1px solid #e8e8f0; border-radius: 8px; overflow: hidden; }
  .t-row { display: flex; justify-content: space-between; padding: 7px 14px; font-size: 12px; border-bottom: 1px solid #e8e8f0; }
  .t-row.grand { background: linear-gradient(135deg, #4f46e5, #7c3aed); color: #fff; font-weight: 800; font-size: 14px; border: none; padding: 10px 14px; }
  .footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 24px; padding: 16px 0; border-top: 1px solid #e8e8f0; }
  .footer p { font-size: 10px; color: #aaa; }
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style></head>
<body><div class="page">
  <div class="header">
    <div class="header-top">
      <div>
        ${logo ? `<img src="${logo}" class="logo-white" alt="شعار" style="margin-bottom:10px;display:block" />` : ""}
        <div class="company-name">${inv.company?.nameAr ?? ""}</div>
        ${inv.company?.nameEn ? `<div class="company-sub">${inv.company.nameEn}</div>` : ""}
        <div class="company-sub">ر.ض: ${inv.company?.vatNumber ?? ""}${inv.company?.crNumber ? " | س.ت: " + inv.company.crNumber : ""}</div>
        ${inv.company?.city ? `<div class="company-sub">${inv.company.city}${inv.company.street ? " — " + inv.company.street : ""}</div>` : ""}
      </div>
      <div class="invoice-badge">
        <div class="type">${inv.invoiceType === "standard" ? "STANDARD INVOICE" : "SIMPLIFIED INVOICE"}</div>
        <div class="num">${inv.invoiceNumber}</div>
        <div class="date">${fmtDate(inv.issueDate)}</div>
      </div>
    </div>
    <div class="header-cards">
      ${inv.customer?.nameAr ? `<div class="h-card"><div class="label">العميل</div><div class="val">${inv.customer.nameAr}</div>${inv.customer.vatNumber ? `<div style="font-size:10px;opacity:0.8;margin-top:2px">${inv.customer.vatNumber}</div>` : ""}</div>` : ""}
      ${inv.paymentMethod ? `<div class="h-card"><div class="label">طريقة الدفع</div><div class="val">${PAYMENT_LABELS[inv.paymentMethod] ?? inv.paymentMethod}</div></div>` : ""}
      ${inv.supplyDate ? `<div class="h-card"><div class="label">تاريخ التوريد</div><div class="val">${fmtDate(inv.supplyDate)}</div></div>` : ""}
    </div>
  </div>

  <div class="body">
    <table>
      <thead><tr><th>البيان</th><th>الكمية</th><th>سعر الوحدة</th><th>الضريبة</th><th>الإجمالي</th></tr></thead>
      <tbody>
        ${(inv.lineItems ?? []).map(li => `<tr>
          <td><strong>${li.description}</strong></td>
          <td style="text-align:center">${li.quantity}</td>
          <td>${fmt(li.unitPrice, dp)} ${sym}</td>
          <td>${fmt(li.vatAmount ?? 0, dp)} ${sym} <span style="color:#888">(${li.vatRate ?? 15}%)</span></td>
          <td style="font-weight:700;color:#4f46e5">${fmt(li.totalPrice, dp)} ${sym}</td>
        </tr>`).join("")}
      </tbody>
    </table>

    <div class="totals"><div class="totals-inner">
      <div class="t-row"><span>المبلغ قبل الضريبة</span><span>${fmt(inv.subtotal, dp)} ${sym}</span></div>
      ${inv.discountAmount ? `<div class="t-row"><span>الخصم</span><span style="color:#e53e3e">- ${fmt(inv.discountAmount, dp)} ${sym}</span></div>` : ""}
      <div class="t-row"><span>ضريبة 15%</span><span>${fmt(inv.taxAmount, dp)} ${sym}</span></div>
      <div class="t-row grand"><span>الإجمالي المستحق</span><span>${fmt(inv.total, dp)} ${sym}</span></div>
    </div></div>

    ${inv.notes ? `<div style="margin-top:16px;border-right:4px solid #4f46e5;padding:10px 14px;background:#f5f3ff;border-radius:0 8px 8px 0;font-size:11px"><strong>ملاحظات:</strong> ${inv.notes}</div>` : ""}
  </div>

  <div class="footer" style="padding: 16px 32px;">
    <p>نظام الفاتورة الإلكترونية | ZATCA Compliant | ${new Date().toLocaleDateString("ar-SA")}</p>
    ${qrDataUrl ? `<div style="text-align:center"><img src="${qrDataUrl}" width="88" height="88" /><p style="font-size:9px;color:#aaa;margin-top:3px">رمز QR ZATCA</p></div>` : ""}
  </div>
</div></body></html>`;
}

function buildCompactHtml(inv: PrintInvoice, qrDataUrl: string): string {
  const dp = inv.company?.decimalPlaces ?? 2;
  const sym = currencySymbol(inv.currencyCode);
  const logo = inv.company?.logo;
  const C = "#7c3aed";  // purple
  return `<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>فاتورة ${inv.invoiceNumber}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 11.5px; color: #111; background: #fff; direction: rtl; }
  .page { max-width: 800px; margin: 0 auto; padding: 0; }
  .banner { background: ${C}; height: 8px; }
  .header { display: flex; justify-content: space-between; align-items: center; padding: 20px 28px; background: #faf5ff; border-bottom: 1px solid #ede9fe; }
  .company-name { font-size: 20px; font-weight: 800; color: ${C}; }
  .company-sub { font-size: 11px; color: #777; margin-top: 2px; }
  .logo { max-height: 60px; max-width: 150px; object-fit: contain; }
  .content { display: flex; gap: 0; padding: 0; }
  .main { flex: 1; padding: 20px 28px; }
  .side { width: 160px; background: #faf5ff; border-right: 1px solid #ede9fe; padding: 20px 16px; display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .meta-block { margin-bottom: 16px; }
  .meta-block .title { font-size: 9px; color: #888; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px; margin-bottom: 6px; }
  .meta-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 11px; }
  .meta-grid .lbl { color: #777; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 12px; }
  th { background: ${C}; color: #fff; padding: 6px 8px; text-align: right; font-size: 10px; }
  td { padding: 5px 8px; border-bottom: 1px solid #f0ebff; }
  .totals { border: 1px solid #ede9fe; border-radius: 8px; overflow: hidden; }
  .t-row { display: flex; justify-content: space-between; padding: 5px 10px; font-size: 11.5px; border-bottom: 1px solid #f0ebff; }
  .t-row.grand { background: ${C}; color: #fff; font-weight: 800; font-size: 13px; border: none; padding: 7px 10px; }
  .qr-label { font-size: 9px; color: #888; text-align: center; }
  .inv-badge { background: ${C}; color: #fff; border-radius: 6px; padding: 6px 10px; text-align: center; width: 100%; }
  .inv-badge .n { font-size: 12px; font-weight: 700; }
  .inv-badge .d { font-size: 9px; opacity: 0.85; margin-top: 2px; }
  .info-pill { background: #fff; border: 1px solid #ede9fe; border-radius: 6px; padding: 6px 10px; width: 100%; font-size: 10px; }
  .info-pill .t { color: ${C}; font-weight: 700; font-size: 9px; margin-bottom: 2px; }
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style></head>
<body><div class="page">
  <div class="banner"></div>
  <div class="header">
    <div>
      <div class="company-name">${inv.company?.nameAr ?? ""}</div>
      ${inv.company?.nameEn ? `<div class="company-sub">${inv.company.nameEn}</div>` : ""}
      <div class="company-sub">ر.ض: ${inv.company?.vatNumber ?? ""}${inv.company?.city ? " | " + inv.company.city : ""}</div>
    </div>
    ${logo ? `<img src="${logo}" class="logo" alt="شعار" />` : `<div style="width:60px;height:60px;background:#f3f4f6;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:22px;font-weight:700">${(inv.company?.nameAr ?? "؟")[0]}</div>`}
  </div>

  <div class="content">
    <div class="main">
      <div class="meta-block">
        <div class="title">تفاصيل الفاتورة</div>
        <div class="meta-grid">
          <span class="lbl">النوع:</span><span>${inv.invoiceType === "standard" ? "فاتورة ضريبية B2B" : "فاتورة مبسطة B2C"}</span>
          <span class="lbl">التاريخ:</span><span>${fmtDate(inv.issueDate)}</span>
          ${inv.supplyDate ? `<span class="lbl">التوريد:</span><span>${fmtDate(inv.supplyDate)}</span>` : ""}
          ${inv.paymentMethod ? `<span class="lbl">الدفع:</span><span>${PAYMENT_LABELS[inv.paymentMethod] ?? inv.paymentMethod}</span>` : ""}
          ${inv.customer?.nameAr ? `<span class="lbl">العميل:</span><span>${inv.customer.nameAr}</span>` : ""}
          ${inv.customer?.vatNumber ? `<span class="lbl">ر.ض العميل:</span><span>${inv.customer.vatNumber}</span>` : ""}
        </div>
      </div>

      <table>
        <thead><tr><th>البيان</th><th>الكمية</th><th>سعر الوحدة</th><th>ض.ق.م</th><th>الإجمالي</th></tr></thead>
        <tbody>
          ${(inv.lineItems ?? []).map(li => `<tr>
            <td>${li.description}</td>
            <td style="text-align:center">${li.quantity}</td>
            <td>${fmt(li.unitPrice, dp)}</td>
            <td>${fmt(li.vatAmount ?? 0, dp)}</td>
            <td style="font-weight:700">${fmt(li.totalPrice, dp)}</td>
          </tr>`).join("")}
        </tbody>
      </table>

      <div class="totals">
        <div class="t-row"><span>قبل الضريبة</span><span>${fmt(inv.subtotal, dp)} ${sym}</span></div>
        <div class="t-row"><span>ضريبة 15%</span><span>${fmt(inv.taxAmount, dp)} ${sym}</span></div>
        <div class="t-row grand"><span>الإجمالي</span><span>${fmt(inv.total, dp)} ${sym}</span></div>
      </div>

      ${inv.notes ? `<div style="margin-top:12px;font-size:10px;color:#555;border-top:1px dashed #ede9fe;padding-top:10px"><strong>ملاحظات:</strong> ${inv.notes}</div>` : ""}
    </div>

    <div class="side">
      <div class="inv-badge">
        <div style="font-size:9px;opacity:0.9">${inv.invoiceType === "standard" ? "فاتورة ضريبية" : "فاتورة مبسطة"}</div>
        <div class="n">${inv.invoiceNumber}</div>
        <div class="d">${new Date(inv.issueDate).toLocaleDateString("ar-SA")}</div>
      </div>
      ${qrDataUrl ? `<div style="text-align:center"><img src="${qrDataUrl}" width="120" height="120" style="border:1px solid #ede9fe;border-radius:6px;padding:4px" /><div class="qr-label" style="margin-top:6px">رمز QR للتحقق</div></div>` : ""}
      <div class="info-pill"><div class="t">ZATCA</div><div>فاتورة إلكترونية معتمدة</div></div>
      <div class="info-pill"><div class="t">طُبعت</div><div>${new Date().toLocaleDateString("ar-SA")}</div></div>
    </div>
  </div>
</div></body></html>`;
}

// ─── Generate QR code data URL ────────────────────────────────────────────────
async function buildQrDataUrl(base64Tlv: string | null | undefined): Promise<string> {
  if (!base64Tlv) return "";
  try {
    const binary = atob(base64Tlv);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return await QRCode.toDataURL(Array.from(bytes) as any, {
      width: 200, margin: 1,
      errorCorrectionLevel: "M",
    });
  } catch {
    return "";
  }
}

// ─── Template HTML builder dispatch ──────────────────────────────────────────
async function generateHtml(templateId: string, inv: PrintInvoice): Promise<string> {
  const qrDataUrl = await buildQrDataUrl(inv.qrCode);
  switch (templateId) {
    case "classic":      return buildClassicHtml(inv, qrDataUrl);
    case "modern":       return buildModernHtml(inv, qrDataUrl);
    case "professional": return buildProfessionalHtml(inv, qrDataUrl);
    case "colorful":     return buildColorfulHtml(inv, qrDataUrl);
    case "compact":      return buildCompactHtml(inv, qrDataUrl);
    default:             return buildModernHtml(inv, qrDataUrl);
  }
}

// ─── Dialog component ─────────────────────────────────────────────────────────
interface Props {
  open: boolean;
  onClose: () => void;
  invoice: PrintInvoice;
}

export default function InvoicePrintDialog({ open, onClose, invoice }: Props) {
  const [selected, setSelected] = useState("professional");
  const [printing, setPrinting] = useState(false);
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const handlePrint = async () => {
    if (!ensurePrinterReady(toast, navigate)) return;
    setPrinting(true);
    try {
      const html = await generateHtml(selected, invoice);
      const win = window.open("", "_blank", "width=900,height=700");
      if (!win) { alert("يرجى السماح بالنوافذ المنبثقة"); return; }
      win.document.open();
      win.document.write(html);
      win.document.close();
      // Wait for images to load then print
      win.onload = () => { win.focus(); win.print(); };
      // Fallback
      setTimeout(() => { try { win.focus(); win.print(); } catch {} }, 800);
    } finally {
      setPrinting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Printer className="h-4 w-4 text-primary" />
            اختر نموذج الطباعة
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground -mt-1">
          اختر النموذج المناسب ثم اضغط طباعة — ستُفتح نافذة جديدة بالفاتورة الجاهزة
        </p>

        {/* Template grid */}
        <div className="grid grid-cols-5 gap-3 mt-2">
          {TEMPLATES.map(t => (
            <button
              key={t.id}
              onClick={() => setSelected(t.id)}
              className={cn(
                "group relative flex flex-col rounded-xl border-2 overflow-hidden transition-all",
                selected === t.id
                  ? "border-primary shadow-md shadow-primary/20 scale-[1.02]"
                  : "border-border hover:border-primary/40 hover:shadow-sm"
              )}
            >
              {/* Preview */}
              <div className="aspect-[3/4] p-1.5 bg-gray-50">
                {t.preview}
              </div>
              {/* Label */}
              <div className={cn(
                "px-2 py-1.5 text-center transition-colors",
                selected === t.id ? "bg-primary text-primary-foreground" : "bg-card"
              )}>
                <p className="text-[11px] font-bold">{t.nameAr}</p>
                <p className="text-[9px] opacity-70 mt-0.5 leading-tight">{t.desc}</p>
              </div>
              {/* Selected check */}
              {selected === t.id && (
                <div className="absolute top-1.5 right-1.5 h-5 w-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
                  <Check className="h-3 w-3" />
                </div>
              )}
            </button>
          ))}
        </div>

        {/* Actions */}
        <div className="flex justify-between items-center pt-2">
          <Button variant="outline" size="sm" onClick={onClose} className="gap-1.5">
            <X className="h-4 w-4" />إلغاء
          </Button>
          <Button onClick={handlePrint} disabled={printing} className="gap-2 min-w-32">
            {printing
              ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />جاري التحضير...</>
              : <><Printer className="h-4 w-4" />طباعة الآن</>
            }
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
