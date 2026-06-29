import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Printer, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { safeLogoSrc } from "@/lib/export";
import { currencySymbol } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { ZATCA_UNIT_CODES } from "@/lib/zatca-units";
import { getWorldCountryName } from "@/lib/worldCountries";
import QRCode from "qrcode";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// Number formatter — uses Arabic-Indic digits with a deterministic
// separator scheme so output is identical on every device.
//
// CRITICAL: `Intl.NumberFormat` for Arabic locales (and any RTL locale)
// frequently emits INVISIBLE BiDi control characters at the start /
// between groups of the formatted string — typically `U+061C` (Arabic
// Letter Mark) or `U+200F` (Right-to-Left Mark). These are zero-width on
// fonts that ship a `.notdef`-suppressing rule (Chrome on Linux /
// macOS), but on Windows + fonts that lack a glyph for them, the
// browser falls back to rendering the `.notdef` box — which in many
// system fonts on Saudi Windows installs is drawn as a *plain vertical
// stroke that is visually identical to the digit "1"*. That is the
// mysterious vertical "1" column the user kept seeing next to the
// totals card on the second device — one stray BiDi marker prefixing
// every formatted amount.
//
// Strip every BiDi / formatting control codepoint after formatting so
// the printed string contains ONLY real visible glyphs (digits +
// separators). Belt-and-braces: the wrapping `.mono` span in the
// totals card is also forced to `direction:ltr; unicode-bidi:isolate`
// in `baseStyles()` so the browser never injects new BiDi marks at
// render time.
const NUM_FMT = new Intl.NumberFormat("ar-SA-u-nu-arab", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Codepoints to strip:
//   U+061C  Arabic Letter Mark
//   U+200E  LTR Mark
//   U+200F  RTL Mark
//   U+202A-U+202E  LRE / RLE / PDF / LRO / RLO  (legacy bidi)
//   U+2066-U+2069  LRI / RLI / FSI / PDI        (isolate bidi)
//   U+FEFF  Zero-width no-break space (BOM)
const STRIP_INVISIBLE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const fmt = (n: any) => NUM_FMT.format(Number(n || 0)).replace(STRIP_INVISIBLE, "");
// Latin-digit formatter for English print mode — Arabic-Indic numerals
// (ar-SA-u-nu-arab) look broken inside an otherwise-English invoice.
const EN_NUM_FMT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtEn = (n: any) => EN_NUM_FMT.format(Number(n || 0)).replace(STRIP_INVISIBLE, "");
// Build the Arabic-name → English-name lookup map from an inventory item list.
// Keys are normalised (trimmed + lower-cased) Arabic names; only items that
// actually carry an English name are included.
function buildEnNamesMap(items: any[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const it of (items ?? [])) {
    const ar = (it?.nameAr ?? "").toString().trim().toLowerCase();
    const en = (it?.nameEn ?? "").toString().trim();
    if (ar && en) m.set(ar, en);
  }
  return m;
}
// Build the unit-of-measure → English-name lookup. A line's `unit` field stores
// the unit's Arabic name (e.g. "علبة") or sometimes its UN/CEFACT code. We seed
// the map with the ZATCA static dictionary (covers the common units) and then
// overlay the company's own `units` rows so a per-company English name wins.
// Keys: normalised-lowercase Arabic name AND uppercased code → English name.
function buildEnUnitsMap(dbUnits: any[]): Map<string, string> {
  const m = new Map<string, string>();
  const add = (ar: any, code: any, en: any) => {
    const enS = (en ?? "").toString().trim();
    if (!enS) return;
    const arS = (ar ?? "").toString().trim().toLowerCase();
    const codeS = (code ?? "").toString().trim().toUpperCase();
    if (arS) m.set(arS, enS);
    if (codeS) m.set(codeS, enS);
  };
  for (const u of ZATCA_UNIT_CODES) add(u.nameAr, u.code, u.nameEn);
  for (const u of (dbUnits ?? [])) add(u?.nameAr, u?.code, u?.nameEn);
  return m;
}

// ── Arabic number-to-words (tafqeet) ─────────────────────────────────────────
// Copied verbatim from voucherPrint.ts so the print modal stays self-contained
// (no cross-page coupling). Handles values up to 999,999,999.99.
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

// ── Full totals computation ──────────────────────────────────────────────────
// Derives the 5 standard print totals from lines (so it works even when the
// server-side aggregates haven't refreshed yet). Combines BOTH percent‑based
// (`discount` as %) and value‑based (`discountAmount` as absolute SAR) per‑line
// discounts — clamped so the line discount can never exceed the gross.
interface FullTotals {
  subtotalPreDiscount: number;
  discountTotal: number;
  netPreVat: number;
  vatAmount: number;
  grandTotal: number;
  totalQty: number;
  totalFreeQty: number;
  itemsCount: number;
  currency: string;
  currencySym: string;
  amountWords: string;
  // ── Base-currency (SAR) equivalents — ZATCA requires the VAT amount (and we
  // also surface the grand total) in the company's base currency whenever a
  // TAX document is issued in a foreign currency. `showSarEq` already folds in
  // the foreign-currency + tax-document gating so callers can render blindly.
  exchangeRate: number;
  baseCurrency: string;
  baseSym: string;
  isForeign: boolean;
  vatAmountBase: number;
  grandTotalBase: number;
  showSarEq: boolean;
}
function computeFullTotals(doc: any, lines: any[], printType?: SalesPrintType): FullTotals {
  let subtotalPreDiscount = 0, discountTotal = 0, netPreVat = 0, vatAmount = 0;
  let totalQty = 0, totalFreeQty = 0;
  for (const l of (lines ?? [])) {
    const qty   = Number(l.qty)         || 0;
    const free  = Number(l.freeQty)     || 0;
    const price = Number(l.unitPrice)   || 0;
    const dPct  = Math.max(0, Math.min(100, Number(l.discount) || 0));
    const dAmt  = Math.max(0, Number(l.discountAmount) || 0);
    const gross = qty * price;
    // The two discount fields mirror one value (see `lib/lineDiscountSync.ts`).
    // Prefer the SAR amount when set, else derive from %. Never sum both
    // — that would double‑count after sync.
    const disc  = Math.min(gross, dAmt > 0 ? dAmt : (gross * dPct / 100));
    const net   = gross - disc;
    const vat   = net * ((Number(l.vatRate) || 0) / 100);
    subtotalPreDiscount += gross;
    discountTotal       += disc;
    netPreVat           += net;
    vatAmount           += vat;
    totalQty            += qty;
    totalFreeQty        += free;
  }
  const grandTotal = netPreVat + vatAmount;
  const currency = doc?.currencyCode ?? "SAR";
  // ── Base-currency (SAR) equivalents ────────────────────────────────────────
  // The document is denominated in `currency`; the company books everything in
  // SAR. base = foreign × exchangeRate (rate is "1 foreign = X SAR").
  const baseCurrency = "SAR";
  const exchangeRate = Number(doc?.exchangeRate) || 1;
  const isForeign = !!currency && currency.toUpperCase() !== baseCurrency;
  // Resolve the print TYPE — explicit arg wins, else the value stamped onto the
  // doc in handlePrint (`doc.__printType`). Quotations / sales orders are NOT
  // tax documents, so they never show the SAR-equivalent block.
  const resolvedType: SalesPrintType | undefined = printType ?? (doc?.__printType as SalesPrintType | undefined);
  const isTaxDoc = resolvedType ? (resolvedType === "invoice" || resolvedType === "return") : true;
  const vatAmountBase = vatAmount * exchangeRate;
  const grandTotalBase = grandTotal * exchangeRate;
  return {
    subtotalPreDiscount, discountTotal, netPreVat, vatAmount, grandTotal,
    totalQty, totalFreeQty, itemsCount: (lines ?? []).length, currency,
    currencySym: currencySymbol(currency),
    amountWords: numberToArabicWords(grandTotal),
    exchangeRate, baseCurrency, baseSym: currencySymbol(baseCurrency),
    isForeign, vatAmountBase, grandTotalBase,
    showSarEq: isForeign && isTaxDoc,
  };
}

// SAR-equivalent rows appended after the grand-total line. Renders ONLY for a
// foreign-currency tax document (gated via `t.showSarEq`); returns "" otherwise
// so every template can splice it in unconditionally. `tl` lets template14
// pass its bilingual / EN-only labeller and `nf` its locale number formatter;
// the defaults keep the AR "عربي — English" pairing used by the other templates.
function sarEqRowsHtml(
  t: FullTotals,
  rowClass = "totals-row",
  tl: (ar: string, en: string) => string = (ar, en) => `${ar} — ${en}`,
  nf: (n: number) => string = fmt,
): string {
  if (!t.showSarEq) return "";
  return `
    <div class="${rowClass}" style="border-top:1px dashed #cbd5e1;margin-top:4px;padding-top:6px;"><span>${tl("ضريبة القيمة المضافة (بالريال)", "VAT (in SAR)")}</span><span class="mono">${nf(t.vatAmountBase)} ${t.baseSym}</span></div>
    <div class="${rowClass}"><span>${tl("الإجمالي شامل الضريبة (بالريال)", "Total (in SAR)")}</span><span class="mono">${nf(t.grandTotalBase)} ${t.baseSym}</span></div>
    <div class="${rowClass}" style="font-size:9px;opacity:.65;"><span>${tl("سعر الصرف", "Exchange rate")}</span><span class="mono">1 ${t.currency} = ${nf(t.exchangeRate)} ${t.baseSym}</span></div>`;
}

// Standardised 5‑row totals body matching the screenshot reference. Caller
// provides the CSS row class (so each template keeps its native styling)
// plus an optional grand‑row class for the final highlighted line.
function totalRowsHtml(t: FullTotals, rowClass = "totals-row", grandClass = "grand"): string {
  return `
    <div class="${rowClass}"><span>الإجمالي قبل الخصم — Subtotal</span><span class="mono">${fmt(t.subtotalPreDiscount)} ${t.currencySym}</span></div>
    <div class="${rowClass}"><span>مبلغ الخصم — Discount</span><span class="mono">${fmt(t.discountTotal)} ${t.currencySym}</span></div>
    <div class="${rowClass}"><span>الصافي بدون الضريبة — Net</span><span class="mono">${fmt(t.netPreVat)} ${t.currencySym}</span></div>
    <div class="${rowClass}"><span>ضريبة القيمة المضافة — VAT</span><span class="mono">${fmt(t.vatAmount)} ${t.currencySym}</span></div>
    <div class="${rowClass} ${grandClass}"><span>الصافي شامل الضريبة — Total</span><span class="mono">${fmt(t.grandTotal)} ${t.currencySym}</span></div>`;
}

// Universal summary footer (tafqeet + total items + total qty inc. free) shown
// directly under every totals card. Self‑contained styling so it renders the
// same in every template regardless of accent colour.
function summaryFooterHtml(t: FullTotals): string {
  return `
    <div style="margin-top:10px;border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;font-size:11px;background:#fafafa;">
      <div style="font-weight:700;color:#0f172a;margin-bottom:6px;line-height:1.5;">${t.amountWords}</div>
      <div style="display:flex;justify-content:space-between;border-top:1px dashed #cbd5e1;padding-top:6px;">
        <span>إجمالي أصناف الفاتورة</span>
        <span class="mono" style="font-weight:700;">${t.itemsCount}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:3px;">
        <span>إجمالي كميات الفاتورة (شاملة المجانية)</span>
        <span class="mono" style="font-weight:700;">${fmt(t.totalQty + t.totalFreeQty)}${t.totalFreeQty > 0 ? ` <span style="color:#b45309;font-weight:600;">(منها ${fmt(t.totalFreeQty)} مجاني)</span>` : ""}</span>
      </div>
    </div>`;
}

// ── ZATCA TLV QR builder ─────────────────────────────────────────────────────
// Phase‑1 e‑invoicing TLV spec (5 mandatory tags). Returns a data URL for an
// <img> tag. Falls back to "" on any error so print never breaks.
//   Tag 1: seller name (UTF‑8)
//   Tag 2: VAT registration number
//   Tag 3: timestamp (ISO 8601 ZULU)
//   Tag 4: invoice total (with VAT)
//   Tag 5: VAT total
function buildTlvBase64(company: any, doc: any, t: FullTotals): string {
  const enc = new TextEncoder();
  const pieces: Uint8Array[] = [];
  const push = (tag: number, val: string) => {
    const bytes = enc.encode(val);
    pieces.push(Uint8Array.from([tag, bytes.length]));
    pieces.push(bytes);
  };
  push(1, String(company?.nameAr ?? company?.nameEn ?? ""));
  push(2, String(company?.vatNumber ?? ""));
  // Prefer an ISO timestamp if the doc has one; otherwise build a UTC stamp
  // from `invoiceDate` + 00:00:00. ZATCA accepts ISO 8601 UTC.
  let ts = "";
  const raw = doc?.invoiceDate ?? doc?.issueDate ?? doc?.createdAt ?? doc?.returnDate ?? doc?.orderDate ?? doc?.quotationDate;
  if (raw) {
    try {
      const dt = new Date(raw);
      if (!isNaN(dt.getTime())) ts = dt.toISOString().replace(/\.\d{3}Z$/, "Z");
    } catch { /* noop */ }
  }
  if (!ts) ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  push(3, ts);
  push(4, t.grandTotal.toFixed(2));
  push(5, t.vatAmount.toFixed(2));
  // Concatenate
  const total = pieces.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of pieces) { out.set(p, off); off += p.length; }
  // base64 encode
  let bin = "";
  for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]!);
  return btoa(bin);
}

async function buildZatcaQrDataUrl(company: any, doc: any, t: FullTotals): Promise<string> {
  try {
    // ZATCA spec: the QR content is the base64 string of the TLV byte stream.
    // Scanners base64-decode it and parse the tags. Encoding the raw bytes
    // here would produce an unscannable result, since `qrcode` treats a
    // number array as segments rather than binary input.
    const b64 = buildTlvBase64(company, doc, t);
    return await QRCode.toDataURL(b64, {
      width: 220, margin: 1, errorCorrectionLevel: "M",
    });
  } catch { return ""; }
}

// Reusable QR rendering helper — uses the real ZATCA data URL when available,
// falls back to a labelled placeholder so layouts don't collapse during
// development / when QRCode generation fails.
function qrImgHtml(d: PrintData, opts: { size?: number; border?: string; bg?: string; color?: string } = {}): string {
  const size = opts.size ?? 110;
  const url = (d as any)._qrDataUrl as string | undefined;
  if (url) {
    return `<img src="${url}" alt="QR ZATCA" width="${size}" height="${size}" style="display:block;${opts.border ? `border:${opts.border};` : ""}${opts.bg ? `background:${opts.bg};` : ""}padding:3px;border-radius:4px;" />`;
  }
  // Fallback placeholder
  return `<div style="width:${size}px;height:${size}px;border:1.5px dashed ${opts.color ?? "#999"};border-radius:4px;display:flex;align-items:center;justify-content:center;color:${opts.color ?? "#999"};font-size:10px;text-align:center;background:${opts.bg ?? "#fafafa"};">QR<br/>ZATCA</div>`;
}

// "order" prints exactly like a quotation: same finance-free, no-VAT-reporting
// document. The header label and field names differ; everything else (lines,
// totals, customer block) is identical.
export type SalesPrintType = "invoice" | "return" | "quotation" | "order";

// Document types that should NOT show "payment method" in print since they
// represent no actual payment event.
function isNonPaymentDoc(type: SalesPrintType) {
  return type === "quotation" || type === "order";
}

export interface PrintData {
  type: SalesPrintType;
  doc: any;
  lines: any[];
  customer: any;
  company: any;
}

function docTitle(type: SalesPrintType) {
  return type === "invoice" ? "فاتورة مبيعات"
    : type === "return"   ? "مرتجع مبيعات"
    : type === "order"    ? "أمر بيع"
    : "عرض سعر";
}

function docPrefix(type: SalesPrintType) {
  return type === "invoice" ? "SI"
    : type === "return"   ? "SR"
    : type === "order"    ? "SO"
    : "SQ";
}

function docDate(doc: any, type: SalesPrintType) {
  return type === "invoice" ? (doc.invoiceDate ?? "—")
    : type === "return"   ? (doc.returnDate ?? "—")
    : type === "order"    ? (doc.orderDate ?? "—")
    : (doc.quotationDate ?? "—");
}

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
      /* direction:ltr + unicode-bidi:isolate prevents the browser from
         inserting any BiDi marks at render time around the formatted
         numbers — pairs with the JS-side stripping of invisible BiDi
         control characters so the printed numeric span contains ONLY
         visible glyphs (digits + separators). Without this, some
         Windows fonts render an injected RTL/ALM marker as a stray
         vertical-stroke .notdef glyph next to every total. */
      .mono { font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: isolate; }
      @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    </style>`;
}

function companyBlock(c: any) {
  // Render the configured logo on top of the textual block so every layout
  // variant (classic / modern / receipt / etc.) shows the brand mark
  // automatically.  When the company has no logo the <img> is omitted.
  // The src is run through `safeLogoSrc` to defang attribute-injection
  // / XSS via crafted base64 data URLs.
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

// Reusable centered logo header used by the thermal / receipt-style
// templates (6 + 7) which don't render the full `companyBlock` —
// they just need the brand mark on top of the company name.
function logoCenterHtml(c: any, maxH = 50, maxW = 150): string {
  const safeLogo = safeLogoSrc(c?.logo);
  if (!safeLogo) return "";
  return `<div style="text-align:center;margin-bottom:4px;"><img src="${safeLogo}" alt="" style="max-height:${maxH}px;max-width:${maxW}px;object-fit:contain;display:inline-block;" /></div>`;
}

function customerBlock(cu: any) {
  if (!cu) return "<div>—</div>";
  return `
    <div>
      <div style="font-weight:600;">${cu.nameAr ?? cu.nameEn ?? "—"}</div>
      ${cu.vatNumber ? `<div>الرقم الضريبي: ${cu.vatNumber}</div>` : ""}
      ${cu.phone     ? `<div>هاتف: ${cu.phone}</div>` : ""}
      ${cu.city      ? `<div>${cu.city}</div>` : ""}
    </div>`;
}

function linesTable(lines: any[], headerStyle = "", rowEvenStyle = "") {
  // Discount column appears when ANY line has either a percentage discount
  // (`discount`) OR a value-based discount (`discountAmount`). Previously
  // only the % path was checked, so amount-only discounts were hidden in
  // the printout even though they affected totals.
  const showDisc = lines.some(l =>
    (Number(l.discount) || 0) > 0 || (Number(l.discountAmount) || 0) > 0
  );
  // Only render the "مجاني" column when at least one line has free qty —
  // keeps the printed table clean for invoices that don't use the feature.
  const showFree = lines.some(l => (Number(l.freeQty) || 0) > 0);
  const rows = lines.map((l, i) => {
    const qty   = Number(l.qty) || 0;
    const price = Number(l.unitPrice) || 0;
    const gross = qty * price;
    const discPct = Math.max(0, Math.min(100, Number(l.discount) || 0));
    const rawAmt  = Math.max(0, Number(l.discountAmount) || 0);
    // The two discount fields are mirrors of one value (see
    // `lib/lineDiscountSync.ts`). Use the SAR amount when present,
    // otherwise derive it from %. Never subtract both — that would
    // double-count post-sync.
    const discAmtEff = rawAmt > 0 ? Math.min(rawAmt, gross) : (gross * discPct) / 100;
    const sub  = Math.max(0, gross - discAmtEff);
    const vat  = sub * ((Number(l.vatRate) || 0) / 100);
    const tot  = sub + vat;
    const freeQ = Number(l.freeQty) || 0;
    // % cell shows percentage; value cell shows the SAR amount.
    const discPctCell = discPct > 0 ? `${discPct}%` : "—";
    const discValCell = discAmtEff > 0 ? fmt(discAmtEff) : "—";
    return `
      <tr style="${i % 2 === 0 ? rowEvenStyle : ""}">
        <td>${i + 1}</td>
        <td>${l.itemName ?? l.itemCode ?? "—"}</td>
        <td class="mono">${Math.round(Number(l.qty) || 0)}</td>
        ${showFree ? `<td class="mono" style="color:#b45309;font-weight:600;">${freeQ > 0 ? Math.round(freeQ) : "—"}</td>` : ""}
        <td>${l.unit ?? "—"}</td>
        <td class="mono">${fmt(l.unitPrice)}</td>
        ${showDisc ? `<td class="mono" style="color:#b91c1c;">${discPctCell}</td>` : ""}
        ${showDisc ? `<td class="mono" style="color:#b91c1c;">${discValCell}</td>` : ""}
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
          ${showFree ? `<th style="color:#b45309;">مجاني</th>` : ""}
          <th>الوحدة</th>
          <th>سعر الوحدة</th>
          ${showDisc ? `<th>الخصم</th>` : ""}
          ${showDisc ? `<th>قيمة الخصم</th>` : ""}
          <th>الضريبة</th>
          <th>قيمة الضريبة</th>
          <th>الإجمالي</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function totalsBlock(doc: any, lines: any[], align: "right" | "left" = "right") {
  const t = computeFullTotals(doc, lines);
  const rows = `
    <style>
      .__totalsRow { display:flex; justify-content:space-between; margin-bottom:6px; color:#374151; font-size:12px; }
      .__totalsRow.grand { border-top:2px solid #ddd; padding-top:6px; margin-top:4px; font-size:14px; font-weight:700; color:#0f172a; }
    </style>
    <div class="__totalsRow"><span style="color:#666">الإجمالي قبل الخصم — Subtotal</span><span class="mono">${fmt(t.subtotalPreDiscount)} ${t.currencySym}</span></div>
    <div class="__totalsRow"><span style="color:#666">مبلغ الخصم — Discount</span><span class="mono" style="color:#b91c1c;">${fmt(t.discountTotal)} ${t.currencySym}</span></div>
    <div class="__totalsRow"><span style="color:#666">الصافي بدون الضريبة — Net</span><span class="mono">${fmt(t.netPreVat)} ${t.currencySym}</span></div>
    <div class="__totalsRow"><span style="color:#666">ضريبة القيمة المضافة — VAT</span><span class="mono" style="color:#b45309;">${fmt(t.vatAmount)} ${t.currencySym}</span></div>
    <div class="__totalsRow grand"><span>الصافي شامل الضريبة — Total</span><span class="mono">${fmt(t.grandTotal)} ${t.currencySym}</span></div>`;
  return `
    <div style="display:flex;justify-content:${align === "right" ? "flex-start" : "flex-end"};gap:14px;align-items:flex-start;">
      <div style="${align === "right" ? "" : "margin-left:auto;"}">
        ${qrImgHtml(doc.__pd ?? { _qrDataUrl: (doc as any)._qrDataUrl }, { size: 110 })}
        <div style="font-size:9px;color:#666;text-align:center;margin-top:4px;">رمز QR — ZATCA</div>
      </div>
      <div style="min-width:280px;border:1px solid #ddd;border-radius:6px;padding:10px 14px;">${rows}${summaryFooterHtml(t)}</div>
    </div>`;
}

// ── Template 1: كلاسيكي ──────────────────────────────────────────────────────
function template1(d: PrintData): string {
  const { doc, lines, customer, company } = d;
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  ${baseStyles("#2563eb")}
  <style>
    .header-box { padding: 14px 18px; display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
    .doc-badge  { padding: 10px 18px; text-align: center; color: #1a1a1a; }
    .section    { padding: 10px 14px; margin-bottom: 12px; }
    .section h4 { font-size: 11px; color: #1a1a1a; border-bottom: 1px solid #e5e7eb; margin-bottom: 8px; padding-bottom: 4px; font-weight: 700; }
    .parties    { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
    thead tr    { background: #f3f4f6; color: #1a1a1a; }
    tbody tr:nth-child(even) { background: #fafafa; }
    td, th { border-bottom: 1px solid #e5e7eb; }
    .footer { display: flex; justify-content: space-between; margin-top: 28px; font-size: 11px; color: #888; }
    .stamp { border: 2px dashed #ccc; border-radius: 50%; width: 90px; height: 90px; display: flex; align-items: center; justify-content: center; color: #ccc; font-size: 10px; text-align: center; }
  </style>
  </head><body>
  <div class="header-box">
    ${companyBlock(company)}
    <div class="doc-badge">
      <div style="font-size:16px;font-weight:700;">${docTitle(d.type)}</div>
      <div style="font-size:11px;margin-top:4px;">${docTitle(d.type)} رقم ${doc.docNumber ?? `${docPrefix(d.type)}-${doc.id}`}</div>
      <div style="font-size:11px;">التاريخ: ${docDate(doc, d.type)}</div>
    </div>
  </div>
  <div class="parties">
    <div class="section"><h4>بيانات العميل</h4>${customerBlock(customer)}</div>
    <div class="section"><h4>بيانات المنشأة</h4>${companyBlock(company)}</div>
  </div>
  <div class="section">
    <h4>بنود ${docTitle(d.type)}</h4>
    ${linesTable(lines, "", "background:#eff6ff")}
  </div>
  <br>
  ${totalsBlock({ ...doc, _qrDataUrl: (d as any)._qrDataUrl }, lines)}
  ${doc.notes ? `<div class="section" style="margin-top:12px;"><h4>ملاحظات</h4><p>${doc.notes}</p></div>` : ""}
  <div class="footer">
    <div>
      ${d.type !== "quotation" ? `<div>طريقة الدفع: ${doc.paymentType === "cash" ? "نقدي" : doc.paymentType === "bank" ? "تحويل بنكي" : "آجل"}</div>` : (doc.validUntil ? `<div>صالح حتى: ${doc.validUntil}</div>` : "")}
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
  const { doc, lines, customer, company } = d;
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  ${baseStyles("#059669")}
  <style>
    .top-bar { background: #059669; color: #fff; padding: 20px 24px; display: flex; justify-content: space-between; align-items: center; border-radius: 0 0 12px 12px; margin-bottom: 20px; }
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
      <div class="doc-num">${doc.docNumber ?? `${docPrefix(d.type)}-${doc.id}`}</div>
      <div style="opacity:.8;font-size:11px;margin-top:4px;">التاريخ: ${docDate(doc, d.type)}</div>
    </div>
  </div>
  <div class="two-col">
    <div class="card"><h4>العميل</h4>${customerBlock(customer)}</div>
    <div class="card">
      <h4>تفاصيل الوثيقة</h4>
      ${d.type !== "quotation" ? `<div>النوع: <span class="badge">${doc.paymentType === "cash" ? "نقدي" : doc.paymentType === "bank" ? "بنك" : "آجل"}</span></div>` : (doc.validUntil ? `<div>صالح حتى: <span class="badge">${doc.validUntil}</span></div>` : "")}
      <div style="margin-top:4px;">العملة: ${doc.currencyCode ?? "SAR"}</div>
      ${d.type === "return" && doc.invoiceId ? `<div style="margin-top:4px;">فاتورة مرجعية: ${doc.invoiceId}</div>` : ""}
    </div>
  </div>
  <div class="card">
    <h4>البنود</h4>
    ${linesTable(lines, "", "")}
  </div>
  <br>
  ${totalsBlock({ ...doc, _qrDataUrl: (d as any)._qrDataUrl }, lines, "left")}
  ${doc.notes ? `<div class="card" style="margin-top:12px;"><h4>ملاحظات</h4>${doc.notes}</div>` : ""}
  <div class="footer-line">
    <span>نظام الفاتورة الإلكترونية — ZATCA Compliant</span>
    <span>طُبع: ${new Date().toLocaleDateString("ar-SA")}</span>
  </div>
  </body></html>`;
}

// ── Template 3: مؤسسي ────────────────────────────────────────────────────────
function template3(d: PrintData): string {
  const { doc, lines, customer, company } = d;
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
      <div style="opacity:.8;font-size:12px;margin-top:4px;">${doc.docNumber ?? `${docPrefix(d.type)}-${doc.id}`}</div>
    </div>
  </div>
  <div class="sub-header">
    <div><span>التاريخ: </span><b>${docDate(doc, d.type)}</b></div>
    ${d.type !== "quotation" ? `<div><span>طريقة الدفع: </span><b>${doc.paymentType === "cash" ? "نقدي" : doc.paymentType === "bank" ? "بنك" : "آجل"}</b></div>` : (doc.validUntil ? `<div><span>صالح حتى: </span><b>${doc.validUntil}</b></div>` : "")}
    <div><span>العملة: </span><b>${doc.currencyCode ?? "SAR"}</b></div>
    ${doc.currencyCode && doc.currencyCode !== "SAR" ? `<div><span>سعر الصرف: </span><b>${doc.exchangeRate}</b></div>` : ""}
  </div>
  <div class="body">
    <div class="party-grid">
      <div class="party-box"><h4>العميل</h4>${customerBlock(customer)}</div>
      <div class="party-box"><h4>المنشأة</h4>${companyBlock(company)}</div>
    </div>
    ${linesTable(lines, "", "")}
    <div style="display:flex;justify-content:space-between;margin-top:16px;gap:14px;align-items:flex-start;">
      <div style="text-align:center;">
        ${qrImgHtml(d, { size: 110 })}
        <div style="font-size:9px;color:#1e3a5f;margin-top:4px;font-weight:700;">رمز QR — ZATCA</div>
      </div>
      <div style="flex:1;max-width:340px;">
        <div class="totals-box">${totalRowsHtml(computeFullTotals(doc, lines), "totals-row", "total")}</div>
        ${summaryFooterHtml(computeFullTotals(doc, lines))}
      </div>
    </div>
    ${doc.notes ? `<div style="margin-top:14px;padding:10px 14px;background:#f1f5f9;border-radius:6px;font-size:11px;"><b>ملاحظات:</b> ${doc.notes}</div>` : ""}
    <div class="sign-area">
      <div class="sign-box">توقيع العميل</div>
      <div class="sign-box">توقيع المندوب</div>
      <div class="sign-box">ختم الشركة</div>
    </div>
  </div>
  <div class="footer">
    <span>${company?.nameAr ?? ""} — ${company?.city ?? ""}</span>
    <span>ZATCA e-Invoicing System | طُبع: ${new Date().toLocaleDateString("ar-SA")}</span>
  </div>
  </body></html>`;
}

// ── Template 4: ملوّن ───────────────────────────────────────────────────────
function template4(d: PrintData): string {
  const { doc, lines, customer, company } = d;
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
      <div class="num">${doc.docNumber ?? `${docPrefix(d.type)}-${doc.id}`}</div>
      <div style="font-size:11px;color:#b45309;">${docDate(doc, d.type)}</div>
    </div>
  </div>
  <div class="two-col">
    <div class="box">
      <div class="section-title">بيانات العميل</div>
      ${customerBlock(customer)}
    </div>
    <div class="box">
      <div class="section-title">تفاصيل</div>
      ${d.type !== "quotation" ? `<div>الدفع: ${doc.paymentType === "cash" ? "نقدي" : doc.paymentType === "bank" ? "بنك" : "آجل"}</div>` : (doc.validUntil ? `<div>صالح حتى: ${doc.validUntil}</div>` : "")}
      <div>العملة: ${doc.currencyCode ?? "SAR"}</div>
    </div>
  </div>
  <div class="box">
    <div class="section-title">أصناف ${docTitle(d.type)}</div>
    ${linesTable(lines, "", "")}
  </div>
  <div style="display:flex;justify-content:space-between;margin-top:12px;gap:14px;align-items:flex-start;">
    <div style="text-align:center;">
      ${qrImgHtml(d, { size: 110, border: "1.5px solid #d97706", bg: "#fff" })}
      <div style="font-size:9px;color:#92400e;margin-top:4px;font-weight:700;">رمز QR — ZATCA</div>
    </div>
    <div style="flex:1;max-width:340px;">
      <div class="total-area">${totalRowsHtml(computeFullTotals(doc, lines), "t-row", "grand")}</div>
      ${summaryFooterHtml(computeFullTotals(doc, lines))}
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
  const { doc, lines, customer, company } = d;
  const isReturn = d.type === "return";
  const isQuot = d.type === "quotation";
  const english = isReturn ? "Sales Return" : isQuot ? "Quotation" : "Sales Invoice";
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
    ${isQuot ? `.quot-banner { background: #eff6ff; border: 2px solid #3b82f6; color: #1e40af; text-align: center; padding: 6px; font-weight: 700; margin-bottom: 12px; border-radius: 4px; }` : ""}
  </style>
  </head><body>
  <div class="zatca-header">
    <div>
      <div class="zatca-title">${company?.nameAr ?? "الشركة"}</div>
      <div style="opacity:.8;font-size:11px;">${company?.nameEn ?? ""}</div>
    </div>
    <div class="zatca-badge">
      <div style="font-size:14px;font-weight:700;">${docTitle(d.type)}</div>
      <div style="font-size:12px;margin-top:2px;">${english}</div>
    </div>
  </div>

  ${isReturn ? `<div class="return-banner">⚠ مستند مرتجع مبيعات</div>` : ""}
  ${isQuot ? `<div class="quot-banner">عرض سعر — غير فاتورة ضريبية</div>` : ""}

  <div class="info-strip">
    <div><div class="label">رقم الوثيقة</div><b>${doc.docNumber ?? `${docPrefix(d.type)}-${doc.id}`}</b></div>
    <div><div class="label">التاريخ</div><b>${docDate(doc, d.type)}</b></div>
    ${isQuot
      ? `<div><div class="label">صالح حتى</div><b>${doc.validUntil ?? "—"}</b></div>`
      : `<div><div class="label">طريقة الدفع</div><b>${doc.paymentType === "cash" ? "نقدي Cash" : doc.paymentType === "bank" ? "بنك Bank" : "آجل Credit"}</b></div>`}
    <div><div class="label">العملة</div><b>${doc.currencyCode ?? "SAR"}</b></div>
  </div>

  <div class="parties">
    <div>
      <div class="party-head">البائع / المنشأة — Seller</div>
      <div class="party-cell">${companyBlock(company)}</div>
    </div>
    <div>
      <div class="party-head">المشتري / العميل — Buyer</div>
      <div class="party-cell">${customerBlock(customer)}</div>
    </div>
  </div>

  ${linesTable(lines, "", "")}

  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-top:16px;gap:14px;">
    <div style="text-align:center;">
      <div style="font-size:10px;color:#1a6e3d;font-weight:700;margin-bottom:6px;">رمز QR للتحقق — ZATCA</div>
      ${qrImgHtml(d, { size: 110, border: "1.5px solid #1a6e3d", bg: "#f0fdf4", color: "#1a6e3d" })}
    </div>
    <div style="flex:1;max-width:360px;">
      <div class="totals">${totalRowsHtml(computeFullTotals(doc, lines), "row", "grand")}</div>
      ${summaryFooterHtml(computeFullTotals(doc, lines))}
    </div>
  </div>

  ${doc.notes ? `<div style="margin-top:12px;padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:4px;font-size:11px;"><b>ملاحظات:</b> ${doc.notes}</div>` : ""}

  <div class="sign-row">
    <div class="sign-cell"><span>اعتماد العميل</span></div>
    <div class="sign-cell"><span>اعتماد المندوب</span></div>
    <div class="sign-cell"><span>مدير المبيعات</span></div>
    <div class="sign-cell"><span>ختم الشركة</span></div>
  </div>

  <div class="footer-z">
    <span>ر.ض: ${company?.vatNumber ?? "—"} | س.ت: ${company?.crNumber ?? "—"} | ${company?.city ?? ""}</span>
    <span>ZATCA e-Invoicing System — طُبع: ${new Date().toLocaleDateString("ar-SA")}</span>
  </div>
  </body></html>`;
}

// Resolve customizable footer pieces from company settings (with safe defaults).
function footerSettings(company: any, isReturn: boolean) {
  const thanks = isReturn
    ? (company?.printFooterReturn  ?? "تم استلام المرتجع — شكراً لتعاملكم")
    : (company?.printFooterInvoice ?? "شكراً لزيارتكم — نتمنى لكم يوماً سعيداً");
  const showTimestamp  = company?.printShowTimestamp  !== false;
  const showZatcaBrand = company?.printShowZatcaBrand !== false;
  return { thanks, showTimestamp, showZatcaBrand };
}

// ── Template 6: حراري كلاسيكي (80mm) ─────────────────────────────────────────
function template6(d: PrintData): string {
  const { doc, lines, customer, company } = d;
  const isReturn = d.type === "return";
  const accent = isReturn ? "#b91c1c" : "#111";
  const { thanks, showTimestamp, showZatcaBrand } = footerSettings(company, isReturn);
  const itemsRows = lines.map((l) => {
    const disc = Math.max(0, Math.min(100, Number(l.discount) || 0));
    const sub = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * (1 - disc / 100);
    const vat = sub * ((Number(l.vatRate) || 0) / 100);
    const tot = sub + vat;
    return `
      <tr>
        <td colspan="3" style="padding-top:4px;">${l.itemName ?? l.itemCode ?? "—"}</td>
      </tr>
      <tr>
        <td class="mono" style="padding-bottom:4px;border-bottom:1px dashed #999;">
          ${Math.round(Number(l.qty) || 0)} × ${fmt(l.unitPrice)}${(Number(l.freeQty) || 0) > 0 ? ` <span style="color:#b45309;font-weight:700;">+ ${Math.round(Number(l.freeQty))} مجاني</span>` : ""}
        </td>
        <td class="mono" style="text-align:center;padding-bottom:4px;border-bottom:1px dashed #999;">
          ${l.vatRate ?? 15}%
        </td>
        <td class="mono" style="text-align:left;padding-bottom:4px;border-bottom:1px dashed #999;font-weight:700;">
          ${fmt(tot)}
        </td>
      </tr>`;
  }).join("");

  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  <style>
    @page { size: 80mm auto; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { direction: rtl; font-family: 'Courier New', 'Tahoma', monospace; font-size: 11px; color: #000; padding: 4mm 3mm; width: 80mm; }
    .center { text-align: center; }
    /* direction:ltr + unicode-bidi:isolate prevents the browser from
       inserting any BiDi marks at render time around the formatted
       numbers — pairs with the JS-side stripping of invisible BiDi
       control characters so the printed numeric span contains ONLY
       visible glyphs (digits + separators). Without this, some Windows
       fonts render an injected RTL/ALM marker as a stray
       vertical-stroke .notdef glyph next to every total. */
    .mono { font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: isolate; }
    .name-ar { font-size: 14px; font-weight: 700; }
    .name-en { font-size: 9px; opacity: .75; margin-top: 2px; }
    .meta { font-size: 10px; line-height: 1.45; }
    .doc-type { background: ${accent}; color: #fff; display: inline-block; padding: 3px 10px; margin: 6px 0 4px; font-weight: 700; font-size: 11px; border-radius: 3px; }
    .doc-num  { font-size: 12px; font-weight: 700; margin-top: 2px; }
    .sep { border-top: 1px dashed #555; margin: 6px 0; }
    .sep-solid { border-top: 1.5px solid #000; margin: 6px 0; }
    .info { font-size: 10px; line-height: 1.5; }
    .info b { display: inline-block; min-width: 42px; }
    table.items { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 2px; }
    table.items th { padding: 3px 0; border-top: 1.5px solid #000; border-bottom: 1.5px solid #000; font-size: 10px; }
    .totals { margin-top: 4px; font-size: 11px; }
    .totals .row { display: flex; justify-content: space-between; padding: 2px 0; }
    .totals .grand { font-size: 13px; font-weight: 700; border-top: 1.5px solid #000; border-bottom: 1.5px solid #000; padding: 4px 0; margin-top: 4px; }
    .footer { text-align: center; margin-top: 8px; font-size: 9px; line-height: 1.5; }
    .qr-box { text-align: center; margin: 8px 0 4px; font-size: 9px; }
    .qr-box .qr-ph { width: 30mm; height: 30mm; margin: 0 auto 4px; border: 1px dashed #999; display: flex; align-items: center; justify-content: center; color: #999; font-size: 9px; }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
  </head><body>
    <div class="center">
      ${logoCenterHtml(company, 46, 140)}
      <div class="name-ar">${company?.nameAr ?? "اسم الشركة"}</div>
      ${company?.nameEn ? `<div class="name-en">${company.nameEn}</div>` : ""}
      <div class="meta">
        ${company?.vatNumber ? `<div>الرقم الضريبي: ${company.vatNumber}</div>` : ""}
        ${company?.crNumber  ? `<div>س.ت: ${company.crNumber}</div>` : ""}
        ${company?.city      ? `<div>${company.city}${company.country ? ` — ${company.country}` : ""}</div>` : ""}
        ${company?.phone     ? `<div>هاتف: ${company.phone}</div>` : ""}
      </div>
      <div class="doc-type">${docTitle(d.type)}</div>
      <div class="doc-num mono">${doc.docNumber ?? `${docPrefix(d.type)}-${doc.id}`}</div>
      <div class="meta">${docDate(doc, d.type)}</div>
    </div>

    <div class="sep"></div>

    <div class="info">
      <div><b>العميل:</b> ${customer?.nameAr ?? customer?.nameEn ?? "—"}</div>
      ${customer?.vatNumber ? `<div><b>ر.ض:</b> ${customer.vatNumber}</div>` : ""}
      ${customer?.phone     ? `<div><b>هاتف:</b> ${customer.phone}</div>` : ""}
      ${d.type !== "quotation"
        ? `<div><b>الدفع:</b> ${doc.paymentType === "cash" ? "نقدي" : doc.paymentType === "bank" ? "تحويل بنكي" : "آجل"}</div>`
        : ""}
      ${isReturn && doc.returnReason ? `<div><b>السبب:</b> ${doc.returnReason}</div>` : ""}
      ${isReturn && doc.originalInvoiceNumber ? `<div><b>الفاتورة الأصلية:</b> ${doc.originalInvoiceNumber}</div>` : ""}
    </div>

    <table class="items">
      <thead>
        <tr>
          <th style="text-align:right;">الصنف / الكمية × السعر</th>
          <th style="text-align:center;width:18mm;">ض.</th>
          <th style="text-align:left;width:22mm;">الإجمالي</th>
        </tr>
      </thead>
      <tbody>${itemsRows}</tbody>
    </table>

    <div class="totals">${totalRowsHtml(computeFullTotals(doc, lines), "row", "grand")}</div>
    ${(() => { const t = computeFullTotals(doc, lines); return `
      <div style="margin-top:6px;font-size:10px;line-height:1.5;border-top:1px dashed #555;padding-top:5px;">
        <div style="font-weight:700;margin-bottom:3px;">${t.amountWords}</div>
        <div style="display:flex;justify-content:space-between;"><span>إجمالي الأصناف:</span><span class="mono"><b>${t.itemsCount}</b></span></div>
        <div style="display:flex;justify-content:space-between;"><span>إجمالي الكميات (مع المجاني):</span><span class="mono"><b>${fmt(t.totalQty + t.totalFreeQty)}</b></span></div>
      </div>`; })()}

    ${doc.notes ? `<div class="sep"></div><div class="info"><b>ملاحظات:</b> ${doc.notes}</div>` : ""}

    <div class="qr-box">
      ${qrImgHtml(d, { size: 110 })}
      <div style="margin-top:3px;">رمز ZATCA — تحقّق من الفاتورة</div>
    </div>

    <div class="sep-solid"></div>
    <div class="footer">
      ${thanks ? `<div>${thanks}</div>` : ""}
      ${showTimestamp ? `<div style="margin-top:3px;">طُبع: ${new Date().toLocaleString("ar-SA")}</div>` : ""}
      ${showZatcaBrand ? `<div style="margin-top:3px;opacity:.7;">ZATCA e-Invoicing</div>` : ""}
    </div>
  </body></html>`;
}

// ── Template 7: حراري عصري (80mm) ────────────────────────────────────────────
function template7(d: PrintData): string {
  const { doc, lines, customer, company } = d;
  const isReturn = d.type === "return";
  const accent = isReturn ? "#dc2626" : "#0f766e";
  const accentSoft = isReturn ? "#fee2e2" : "#ccfbf1";
  const { thanks, showTimestamp, showZatcaBrand } = footerSettings(company, isReturn);

  const itemsRows = lines.map((l, i) => {
    const disc = Math.max(0, Math.min(100, Number(l.discount) || 0));
    const sub = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * (1 - disc / 100);
    const vat = sub * ((Number(l.vatRate) || 0) / 100);
    const tot = sub + vat;
    return `
      <div class="line ${i % 2 === 0 ? "alt" : ""}">
        <div class="line-top">
          <span class="line-name">${l.itemName ?? l.itemCode ?? "—"}</span>
          <span class="mono line-tot">${fmt(tot)}</span>
        </div>
        <div class="line-sub mono">
          ${Math.round(Number(l.qty) || 0)} ${l.unit ?? ""} × ${fmt(l.unitPrice)}
          ${(Number(l.freeQty) || 0) > 0 ? ` <span style="color:#b45309;font-weight:700;">+ ${Math.round(Number(l.freeQty))} مجاني</span>` : ""}
          ${disc > 0 ? ` <span style="color:#b91c1c;">(خصم ${disc}%)</span>` : ""}
          <span style="opacity:.7;"> · ض ${l.vatRate ?? 15}%</span>
        </div>
      </div>`;
  }).join("");

  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  <style>
    @page { size: 80mm auto; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', 'Tahoma', sans-serif; }
    body { direction: rtl; font-size: 11px; color: #1a1a1a; width: 80mm; padding: 0; }
    /* direction:ltr + unicode-bidi:isolate prevents the browser from
       inserting any BiDi marks at render time around the formatted
       numbers — pairs with the JS-side stripping of invisible BiDi
       control characters so the printed numeric span contains ONLY
       visible glyphs (digits + separators). Without this, some Windows
       fonts render an injected RTL/ALM marker as a stray
       vertical-stroke .notdef glyph next to every total. */
    .mono { font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: isolate; }
    .header { background: ${accent}; color: #fff; padding: 8px 4mm 10px; text-align: center; }
    .header .name-ar { font-size: 14px; font-weight: 800; letter-spacing: .3px; }
    .header .name-en { font-size: 9px; opacity: .85; margin-top: 2px; }
    .header .meta { font-size: 9.5px; opacity: .9; margin-top: 4px; line-height: 1.45; }
    .doc-band { background: ${accentSoft}; padding: 6px 4mm; text-align: center; border-bottom: 1.5px solid ${accent}; }
    .doc-band .label { font-size: 10px; color: ${accent}; font-weight: 700; }
    .doc-band .num { font-size: 13px; font-weight: 800; margin-top: 2px; }
    .doc-band .date { font-size: 10px; color: #555; margin-top: 2px; }
    .body { padding: 6px 4mm; }
    .info-card { background: #f9fafb; border-radius: 4px; padding: 6px 8px; font-size: 10px; line-height: 1.55; margin-bottom: 6px; }
    .info-card b { color: ${accent}; display: inline-block; min-width: 42px; }
    .lines-title { font-size: 10px; font-weight: 700; color: ${accent}; margin: 8px 0 4px; padding-bottom: 3px; border-bottom: 1.5px solid ${accent}; }
    .line { padding: 4px 0; border-bottom: 1px dashed #d1d5db; }
    .line.alt { background: #fafafa; padding-right: 4px; padding-left: 4px; margin: 0 -4px; }
    .line-top { display: flex; justify-content: space-between; align-items: baseline; }
    .line-name { font-size: 11px; font-weight: 600; flex: 1; }
    .line-tot { font-size: 11px; font-weight: 700; color: ${accent}; }
    .line-sub { font-size: 9.5px; color: #666; margin-top: 2px; }
    .totals { margin-top: 8px; padding: 6px 8px; background: #f9fafb; border-radius: 4px; font-size: 10.5px; }
    .totals .row { display: flex; justify-content: space-between; padding: 2px 0; }
    .totals .grand { font-size: 13px; font-weight: 800; color: ${accent}; border-top: 2px solid ${accent}; padding-top: 5px; margin-top: 4px; }
    .qr-box { text-align: center; margin: 8px 0 4px; }
    .qr-box .qr-ph { width: 28mm; height: 28mm; margin: 0 auto 4px; border: 1.5px dashed ${accent}; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: ${accent}; font-size: 9px; font-weight: 700; }
    .qr-box .qr-cap { font-size: 9px; color: #555; }
    .footer { background: ${accent}; color: #fff; padding: 8px 4mm; text-align: center; font-size: 9.5px; line-height: 1.5; }
    .footer .thanks { font-size: 11px; font-weight: 700; margin-bottom: 3px; }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
  </head><body>
    <div class="header">
      ${logoCenterHtml(company, 46, 130)}
      <div class="name-ar">${company?.nameAr ?? "اسم الشركة"}</div>
      ${company?.nameEn ? `<div class="name-en">${company.nameEn}</div>` : ""}
      <div class="meta">
        ${company?.vatNumber ? `الرقم الضريبي: ${company.vatNumber}` : ""}
        ${company?.crNumber ? `<br/>س.ت: ${company.crNumber}` : ""}
        ${company?.phone ? `<br/>هاتف: ${company.phone}` : ""}
        ${company?.city ? `<br/>${company.city}${company.country ? ` — ${company.country}` : ""}` : ""}
      </div>
    </div>

    <div class="doc-band">
      <div class="label">${docTitle(d.type)}</div>
      <div class="num mono">${doc.docNumber ?? `${docPrefix(d.type)}-${doc.id}`}</div>
      <div class="date">${docDate(doc, d.type)}</div>
    </div>

    <div class="body">
      <div class="info-card">
        <div><b>العميل:</b> ${customer?.nameAr ?? customer?.nameEn ?? "—"}</div>
        ${customer?.vatNumber ? `<div><b>ر.ض:</b> ${customer.vatNumber}</div>` : ""}
        ${customer?.phone ? `<div><b>هاتف:</b> ${customer.phone}</div>` : ""}
        ${d.type !== "quotation"
          ? `<div><b>الدفع:</b> ${doc.paymentType === "cash" ? "نقدي" : doc.paymentType === "bank" ? "تحويل بنكي" : "آجل"}</div>`
          : ""}
        ${isReturn && doc.returnReason ? `<div><b>السبب:</b> ${doc.returnReason}</div>` : ""}
        ${isReturn && doc.originalInvoiceNumber ? `<div><b>الفاتورة الأصلية:</b> ${doc.originalInvoiceNumber}</div>` : ""}
      </div>

      <div class="lines-title">بنود ${docTitle(d.type)} (${lines.length})</div>
      ${itemsRows}

      <div class="totals">${totalRowsHtml(computeFullTotals(doc, lines), "row", "grand")}</div>
      ${(() => { const t = computeFullTotals(doc, lines); return `
        <div style="margin-top:6px;font-size:10px;line-height:1.5;background:#f9fafb;border-radius:4px;padding:6px 8px;">
          <div style="font-weight:700;color:${accent};margin-bottom:3px;">${t.amountWords}</div>
          <div style="display:flex;justify-content:space-between;"><span>إجمالي الأصناف:</span><span class="mono"><b>${t.itemsCount}</b></span></div>
          <div style="display:flex;justify-content:space-between;"><span>إجمالي الكميات (مع المجاني):</span><span class="mono"><b>${fmt(t.totalQty + t.totalFreeQty)}</b></span></div>
        </div>`; })()}

      ${doc.notes ? `<div class="info-card" style="margin-top:8px;"><b>ملاحظات:</b> ${doc.notes}</div>` : ""}

      <div class="qr-box">
        ${qrImgHtml(d, { size: 105, color: accent })}
        <div class="qr-cap">امسح للتحقق من الفاتورة</div>
      </div>
    </div>

    <div class="footer">
      ${thanks ? `<div class="thanks">${thanks}</div>` : ""}
      ${showTimestamp ? `<div>طُبع: ${new Date().toLocaleString("ar-SA")}</div>` : ""}
      ${showZatcaBrand ? `<div style="opacity:.85;margin-top:2px;">ZATCA e-Invoicing</div>` : ""}
    </div>
  </body></html>`;
}

// ── Template 8: نقي أنيق (Pure & Elegant) ───────────────────────────────────
function template8(d: PrintData): string {
  const { doc, lines, customer, company } = d;
  const safeLogo = safeLogoSrc(company?.logo);
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  ${baseStyles("#0f172a")}
  <style>
    body { font-family: 'Tajawal', 'Segoe UI', Tahoma, Arial, sans-serif; }
    .top { border-bottom: 1px solid #0f172a; padding-bottom: 14px; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: flex-end; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-name { font-size: 22px; font-weight: 300; letter-spacing: 4px; color: #0f172a; text-transform: uppercase; }
    .brand-name b { font-weight: 700; }
    .doc-title { text-align: left; }
    .doc-title .word { font-size: 11px; color: #64748b; letter-spacing: 2px; text-transform: uppercase; }
    .doc-title .num { font-size: 26px; font-weight: 200; color: #0f172a; margin-top: 2px; }
    .gold-bar { height: 3px; background: linear-gradient(90deg,#0f172a, #d4af37, #0f172a); margin: 0 0 18px; }
    .meta-strip { display: grid; grid-template-columns: repeat(3,1fr); gap: 1px; background: #e5e7eb; margin-bottom: 16px; }
    .meta-cell { background: #fff; padding: 10px 14px; }
    .meta-cell .k { font-size: 9px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 4px; }
    .meta-cell .v { font-size: 13px; color: #0f172a; font-weight: 600; }
    .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 18px; }
    .party { padding: 12px 16px; border: 1px solid #e2e8f0; border-radius: 2px; }
    .party h4 { font-size: 9px; color: #d4af37; letter-spacing: 2px; margin-bottom: 6px; text-transform: uppercase; font-weight: 700; }
    table { font-size: 11px; }
    thead tr { border-bottom: 2px solid #0f172a; border-top: 2px solid #0f172a; }
    thead th { padding: 9px 8px; font-size: 10px; color: #475569; text-transform: uppercase; letter-spacing: 1px; font-weight: 600; }
    tbody td { padding: 8px; border-bottom: 1px solid #f1f5f9; }
    .totals { margin-top: 18px; display: flex; justify-content: flex-start; }
    .totals-card { min-width: 260px; border-top: 2px solid #d4af37; padding: 12px 0; }
    .totals-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; color: #475569; }
    .totals-row.grand { font-size: 16px; font-weight: 700; color: #0f172a; border-top: 1px solid #e2e8f0; margin-top: 6px; padding-top: 8px; }
    .footer { margin-top: 28px; padding-top: 14px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 9px; color: #94a3b8; letter-spacing: 1px; text-transform: uppercase; }
  </style>
  </head><body>
  <div class="top">
    <div class="brand">
      ${safeLogo ? `<img src="${safeLogo}" alt="" style="max-height:50px;max-width:120px;object-fit:contain;display:block;"/>` : ""}
      <div>
        <div class="brand-name">${company?.nameAr ?? "اسم الشركة"}</div>
        ${company?.nameEn ? `<div style="font-size:10px;color:#94a3b8;letter-spacing:3px;">${company.nameEn}</div>` : ""}
      </div>
    </div>
    <div class="doc-title">
      <div class="word">${docTitle(d.type)}</div>
      <div class="num">${doc.docNumber ?? `${docPrefix(d.type)}-${doc.id}`}</div>
    </div>
  </div>
  <div class="gold-bar"></div>
  <div class="meta-strip">
    <div class="meta-cell"><div class="k">التاريخ</div><div class="v">${docDate(doc, d.type)}</div></div>
    <div class="meta-cell"><div class="k">العملة</div><div class="v">${doc.currencyCode ?? "SAR"}</div></div>
    <div class="meta-cell"><div class="k">${d.type === "quotation" ? "صلاحية" : "الدفع"}</div><div class="v">${d.type === "quotation" ? (doc.validUntil ?? "—") : (doc.paymentType === "cash" ? "نقدي" : doc.paymentType === "bank" ? "بنك" : "آجل")}</div></div>
  </div>
  <div class="parties">
    <div class="party"><h4>إلى</h4>${customerBlock(customer)}</div>
    <div class="party"><h4>من</h4>${companyBlock(company)}</div>
  </div>
  ${linesTable(lines, "", "")}
  <div class="totals" style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;">
    <div style="text-align:center;">
      ${qrImgHtml(d, { size: 110, border: "1px solid #0f172a", bg: "#fff" })}
      <div style="font-size:9px;color:#0f172a;margin-top:4px;letter-spacing:2px;text-transform:uppercase;">QR — ZATCA</div>
    </div>
    <div class="totals-card" style="flex:1;max-width:360px;">
      ${totalRowsHtml(computeFullTotals(doc, lines), "totals-row", "grand")}
      ${summaryFooterHtml(computeFullTotals(doc, lines))}
    </div>
  </div>
  ${doc.notes ? `<div style="margin-top:18px;padding:12px 14px;background:#f8fafc;border-right:3px solid #d4af37;font-size:11px;"><b>ملاحظات: </b>${doc.notes}</div>` : ""}
  <div class="footer">
    <span>${company?.vatNumber ? `VAT ${company.vatNumber}` : ""}</span>
    <span>طُبع ${new Date().toLocaleDateString("ar-SA")}</span>
  </div>
  </body></html>`;
}

// ── Template 9: ذهبي فاخر (Premium Gold) ────────────────────────────────────
function template9(d: PrintData): string {
  const { doc, lines, customer, company } = d;
  const safeLogo = safeLogoSrc(company?.logo);
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  ${baseStyles("#1c1917", "#f5d57a")}
  <style>
    body { background: #fafaf9; }
    .frame { border: 1px solid #d4af37; padding: 18px; background: #fff; }
    .header { background: linear-gradient(135deg,#1c1917 0%, #292524 50%, #1c1917 100%); color: #f5d57a; padding: 22px 26px; display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #d4af37; }
    .h-left { display: flex; align-items: center; gap: 14px; }
    .logo-box { background: rgba(212,175,55,.1); border: 1px solid rgba(212,175,55,.4); padding: 6px 8px; border-radius: 4px; }
    .h-name { font-size: 22px; font-weight: 700; letter-spacing: 1px; color: #f5d57a; }
    .h-sub { font-size: 11px; opacity: .7; margin-top: 4px; }
    .h-right { text-align: left; }
    .h-right .lbl { font-size: 11px; color: #d4af37; letter-spacing: 3px; text-transform: uppercase; }
    .h-right .num { font-size: 24px; font-weight: 800; color: #fff; margin-top: 2px; font-variant-numeric: tabular-nums; }
    .h-right .dt { font-size: 10px; color: rgba(245,213,122,.7); margin-top: 4px; }
    .body { padding: 18px 22px; background: #fff; }
    .strip { background: linear-gradient(90deg,#1c1917, #44403c); color: #f5d57a; padding: 10px 18px; font-size: 11px; display: flex; gap: 26px; margin-bottom: 16px; }
    .strip b { color: #fff; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
    .panel { background: #fafaf9; border: 1px solid #e7e5e4; border-radius: 4px; padding: 12px 16px; }
    .panel h4 { font-size: 10px; color: #92400e; letter-spacing: 2px; text-transform: uppercase; font-weight: 700; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #d4af37; }
    table { font-size: 11px; }
    thead tr { background: #1c1917; color: #f5d57a; }
    thead th { padding: 9px 8px; font-weight: 600; border-right: 1px solid rgba(212,175,55,.2); }
    tbody tr:nth-child(even) { background: #fefce8; }
    tbody td { padding: 8px; border: 1px solid #e7e5e4; }
    .totals-area { background: #1c1917; color: #f5d57a; padding: 14px 20px; margin-top: 16px; min-width: 280px; border: 1px solid #d4af37; }
    .t-row { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 12px; }
    .t-row.grand { border-top: 1px solid #d4af37; padding-top: 8px; margin-top: 6px; font-size: 17px; font-weight: 800; color: #fff; }
    .footer { background: #1c1917; color: #f5d57a; padding: 10px 22px; display: flex; justify-content: space-between; font-size: 10px; opacity: .9; margin-top: 14px; }
  </style>
  </head><body>
  <div class="frame">
    <div class="header">
      <div class="h-left">
        ${safeLogo ? `<div class="logo-box"><img src="${safeLogo}" alt="" style="max-height:48px;max-width:130px;object-fit:contain;display:block;"/></div>` : ""}
        <div>
          <div class="h-name">${company?.nameAr ?? "اسم الشركة"}</div>
          <div class="h-sub">${company?.vatNumber ? `الرقم الضريبي ${company.vatNumber}` : ""}${company?.crNumber ? ` • س.ت ${company.crNumber}` : ""}</div>
        </div>
      </div>
      <div class="h-right">
        <div class="lbl">${docTitle(d.type)}</div>
        <div class="num">${doc.docNumber ?? `${docPrefix(d.type)}-${doc.id}`}</div>
        <div class="dt">${docDate(doc, d.type)}</div>
      </div>
    </div>
    <div class="body">
      <div class="strip">
        <span>التاريخ: <b>${docDate(doc, d.type)}</b></span>
        <span>العملة: <b>${doc.currencyCode ?? "SAR"}</b></span>
        ${d.type !== "quotation" ? `<span>الدفع: <b>${doc.paymentType === "cash" ? "نقدي" : doc.paymentType === "bank" ? "بنك" : "آجل"}</b></span>` : (doc.validUntil ? `<span>صالح حتى: <b>${doc.validUntil}</b></span>` : "")}
      </div>
      <div class="two">
        <div class="panel"><h4>العميل</h4>${customerBlock(customer)}</div>
        <div class="panel"><h4>المنشأة</h4>${companyBlock(company)}</div>
      </div>
      ${linesTable(lines, "", "")}
      <div style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-top:14px;">
        <div style="text-align:center;">
          ${qrImgHtml(d, { size: 110, border: "1px solid #d4af37", bg: "#fff" })}
          <div style="font-size:9px;color:#d4af37;margin-top:4px;font-weight:700;letter-spacing:1px;">QR — ZATCA</div>
        </div>
        <div style="flex:1;max-width:360px;">
          <div class="totals-area">${totalRowsHtml(computeFullTotals(doc, lines), "t-row", "grand")}</div>
          ${summaryFooterHtml(computeFullTotals(doc, lines))}
        </div>
      </div>
      ${doc.notes ? `<div class="panel" style="margin-top:14px;"><h4>ملاحظات</h4>${doc.notes}</div>` : ""}
    </div>
    <div class="footer">
      <span>${company?.nameAr ?? ""} • ${company?.city ?? ""}</span>
      <span>تم بنظام الفاتورة الإلكترونية ZATCA</span>
    </div>
  </div>
  </body></html>`;
}

// ── Template 10: بحري عميق (Deep Ocean) ─────────────────────────────────────
function template10(d: PrintData): string {
  const { doc, lines, customer, company } = d;
  const safeLogo = safeLogoSrc(company?.logo);
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  ${baseStyles("#0e7490")}
  <style>
    .wave-header { background: linear-gradient(135deg,#0c4a6e 0%, #0e7490 50%, #06b6d4 100%); color: #fff; padding: 26px 28px 38px; position: relative; overflow: hidden; }
    .wave-header::after { content: ""; position: absolute; bottom: -1px; left: 0; right: 0; height: 22px; background: #fff; clip-path: polygon(0 100%, 100% 100%, 100% 30%, 80% 60%, 60% 30%, 40% 60%, 20% 30%, 0 60%); }
    .wh-grid { display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: center; position: relative; z-index: 2; }
    .wh-brand { display: flex; align-items: center; gap: 14px; }
    .wh-logo { background: rgba(255,255,255,.15); border: 1px solid rgba(255,255,255,.3); padding: 6px 10px; border-radius: 8px; backdrop-filter: blur(4px); }
    .wh-name { font-size: 21px; font-weight: 700; }
    .wh-meta { font-size: 11px; opacity: .85; margin-top: 4px; }
    .wh-badge { background: rgba(255,255,255,.2); border: 1px solid rgba(255,255,255,.4); border-radius: 12px; padding: 12px 18px; text-align: center; backdrop-filter: blur(4px); }
    .wh-badge .lbl { font-size: 10px; opacity: .85; letter-spacing: 1.5px; text-transform: uppercase; }
    .wh-badge .num { font-size: 20px; font-weight: 700; margin-top: 2px; }
    .body { padding: 12px 24px 24px; }
    .info-bar { background: #ecfeff; border: 1px solid #a5f3fc; border-radius: 8px; padding: 10px 16px; display: flex; justify-content: space-around; font-size: 11px; color: #155e75; margin-bottom: 16px; }
    .info-bar b { color: #0c4a6e; font-size: 12px; display: block; margin-top: 2px; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
    .card { background: #f0f9ff; border-right: 4px solid #0e7490; padding: 12px 16px; border-radius: 4px 0 0 4px; }
    .card h4 { font-size: 10px; color: #0e7490; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px; font-weight: 700; }
    table { border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.05); }
    thead tr { background: linear-gradient(90deg,#0c4a6e,#0e7490); color: #fff; }
    thead th { padding: 10px 8px; font-weight: 600; }
    tbody tr:nth-child(even) { background: #f0f9ff; }
    tbody td { padding: 8px; border-bottom: 1px solid #e0f2fe; }
    .totals-area { background: linear-gradient(135deg,#0c4a6e,#0e7490); color: #fff; padding: 16px 22px; border-radius: 12px; min-width: 280px; }
    .t-row { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 12px; opacity: .95; }
    .t-row.grand { border-top: 1px solid rgba(255,255,255,.3); padding-top: 8px; margin-top: 6px; font-size: 17px; font-weight: 800; opacity: 1; }
    .footer { margin-top: 22px; padding-top: 12px; border-top: 2px solid #06b6d4; display: flex; justify-content: space-between; font-size: 10px; color: #155e75; }
  </style>
  </head><body>
  <div class="wave-header">
    <div class="wh-grid">
      <div class="wh-brand">
        ${safeLogo ? `<div class="wh-logo"><img src="${safeLogo}" alt="" style="max-height:50px;max-width:140px;object-fit:contain;display:block;"/></div>` : ""}
        <div>
          <div class="wh-name">${company?.nameAr ?? "اسم الشركة"}</div>
          <div class="wh-meta">${company?.vatNumber ? `الرقم الضريبي ${company.vatNumber}` : ""}${company?.city ? ` • ${company.city}` : ""}</div>
        </div>
      </div>
      <div class="wh-badge">
        <div class="lbl">${docTitle(d.type)}</div>
        <div class="num">${doc.docNumber ?? `${docPrefix(d.type)}-${doc.id}`}</div>
      </div>
    </div>
  </div>
  <div class="body">
    <div class="info-bar">
      <span>التاريخ <b>${docDate(doc, d.type)}</b></span>
      <span>العملة <b>${doc.currencyCode ?? "SAR"}</b></span>
      ${d.type !== "quotation" ? `<span>الدفع <b>${doc.paymentType === "cash" ? "نقدي" : doc.paymentType === "bank" ? "بنك" : "آجل"}</b></span>` : (doc.validUntil ? `<span>صالح حتى <b>${doc.validUntil}</b></span>` : "")}
    </div>
    <div class="two">
      <div class="card"><h4>العميل</h4>${customerBlock(customer)}</div>
      <div class="card"><h4>المنشأة</h4>${companyBlock(company)}</div>
    </div>
    ${linesTable(lines, "", "")}
    <div style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-top:14px;">
      <div style="text-align:center;">
        ${qrImgHtml(d, { size: 110, bg: "#fff" })}
        <div style="font-size:9px;margin-top:4px;font-weight:700;">QR — ZATCA</div>
      </div>
      <div style="flex:1;max-width:360px;">
        <div class="totals-area">${totalRowsHtml(computeFullTotals(doc, lines), "t-row", "grand")}</div>
        ${summaryFooterHtml(computeFullTotals(doc, lines))}
      </div>
    </div>
    ${doc.notes ? `<div class="card" style="margin-top:14px;"><h4>ملاحظات</h4>${doc.notes}</div>` : ""}
    <div class="footer">
      <span>${company?.nameAr ?? ""}</span>
      <span>ZATCA e-Invoicing • ${new Date().toLocaleDateString("ar-SA")}</span>
    </div>
  </div>
  </body></html>`;
}

// ── Template 11: حيوي (Vibrant) ─────────────────────────────────────────────
function template11(d: PrintData): string {
  const { doc, lines, customer, company } = d;
  const safeLogo = safeLogoSrc(company?.logo);
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  ${baseStyles("#7c3aed")}
  <style>
    .top-stripe { height: 8px; background: linear-gradient(90deg,#ec4899,#a855f7,#7c3aed,#3b82f6); }
    .header { padding: 22px 26px 14px; display: flex; justify-content: space-between; align-items: flex-start; }
    .brand-row { display: flex; align-items: center; gap: 14px; }
    .brand-name { font-size: 22px; font-weight: 800; background: linear-gradient(90deg,#a855f7,#ec4899); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .brand-sub { font-size: 11px; color: #6b7280; margin-top: 2px; }
    .ribbon { background: linear-gradient(135deg,#a855f7,#ec4899); color: #fff; padding: 12px 22px; border-radius: 12px; box-shadow: 0 4px 12px rgba(168,85,247,.3); text-align: center; }
    .ribbon .l { font-size: 10px; opacity: .9; letter-spacing: 2px; text-transform: uppercase; }
    .ribbon .n { font-size: 22px; font-weight: 800; margin-top: 2px; font-variant-numeric: tabular-nums; }
    .body { padding: 4px 26px 22px; }
    .pills { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
    .pill { background: #f5f3ff; border: 1px solid #ddd6fe; color: #6b21a8; border-radius: 999px; padding: 6px 14px; font-size: 11px; font-weight: 600; }
    .pill b { color: #4c1d95; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
    .card { background: #faf5ff; border-radius: 12px; padding: 14px 16px; position: relative; overflow: hidden; }
    .card::before { content: ""; position: absolute; top: 0; right: 0; width: 60px; height: 60px; background: radial-gradient(circle at top right, rgba(168,85,247,.15), transparent 70%); }
    .card h4 { font-size: 10px; color: #7c3aed; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px; font-weight: 700; }
    table { border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
    thead tr { background: linear-gradient(90deg,#7c3aed,#a855f7,#ec4899); color: #fff; }
    thead th { padding: 10px 8px; font-weight: 600; }
    tbody tr:nth-child(even) { background: #faf5ff; }
    tbody td { padding: 8px; border-bottom: 1px solid #f3e8ff; }
    .totals-area { background: linear-gradient(135deg,#a855f7,#ec4899); color: #fff; padding: 16px 22px; border-radius: 12px; min-width: 280px; box-shadow: 0 6px 14px rgba(168,85,247,.25); }
    .t-row { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 12px; opacity: .95; }
    .t-row.grand { border-top: 1px solid rgba(255,255,255,.3); padding-top: 8px; margin-top: 6px; font-size: 18px; font-weight: 800; opacity: 1; }
    .footer { margin-top: 22px; padding: 10px 26px; background: linear-gradient(90deg,#7c3aed,#ec4899); color: #fff; display: flex; justify-content: space-between; font-size: 10px; }
  </style>
  </head><body>
  <div class="top-stripe"></div>
  <div class="header">
    <div class="brand-row">
      ${safeLogo ? `<img src="${safeLogo}" alt="" style="max-height:54px;max-width:140px;object-fit:contain;display:block;"/>` : ""}
      <div>
        <div class="brand-name">${company?.nameAr ?? "اسم الشركة"}</div>
        <div class="brand-sub">${company?.vatNumber ? `VAT ${company.vatNumber}` : ""}${company?.city ? ` • ${company.city}` : ""}</div>
      </div>
    </div>
    <div class="ribbon">
      <div class="l">${docTitle(d.type)}</div>
      <div class="n">${doc.docNumber ?? `${docPrefix(d.type)}-${doc.id}`}</div>
    </div>
  </div>
  <div class="body">
    <div class="pills">
      <span class="pill">التاريخ <b>${docDate(doc, d.type)}</b></span>
      <span class="pill">العملة <b>${doc.currencyCode ?? "SAR"}</b></span>
      ${d.type !== "quotation" ? `<span class="pill">الدفع <b>${doc.paymentType === "cash" ? "نقدي" : doc.paymentType === "bank" ? "بنك" : "آجل"}</b></span>` : (doc.validUntil ? `<span class="pill">صالح حتى <b>${doc.validUntil}</b></span>` : "")}
    </div>
    <div class="two">
      <div class="card"><h4>العميل</h4>${customerBlock(customer)}</div>
      <div class="card"><h4>المنشأة</h4>${companyBlock(company)}</div>
    </div>
    ${linesTable(lines, "", "")}
    <div style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-top:14px;">
      <div style="text-align:center;">
        ${qrImgHtml(d, { size: 110, bg: "#fff" })}
        <div style="font-size:9px;margin-top:4px;font-weight:700;">QR — ZATCA</div>
      </div>
      <div style="flex:1;max-width:360px;">
        <div class="totals-area">${totalRowsHtml(computeFullTotals(doc, lines), "t-row", "grand")}</div>
        ${summaryFooterHtml(computeFullTotals(doc, lines))}
      </div>
    </div>
    ${doc.notes ? `<div class="card" style="margin-top:14px;"><h4>ملاحظات</h4>${doc.notes}</div>` : ""}
  </div>
  <div class="footer">
    <span>${company?.nameAr ?? ""}</span>
    <span>ZATCA Compliant • ${new Date().toLocaleDateString("ar-SA")}</span>
  </div>
  </body></html>`;
}

// ── Template 12: تنفيذي (Executive Side-Panel) ──────────────────────────────
function template12(d: PrintData): string {
  const { doc, lines, customer, company } = d;
  const safeLogo = safeLogoSrc(company?.logo);
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  ${baseStyles("#334155")}
  <style>
    .layout { display: grid; grid-template-columns: 220px 1fr; min-height: 95vh; }
    .side { background: linear-gradient(180deg,#0f172a 0%, #1e293b 50%, #334155 100%); color: #f1f5f9; padding: 22px 18px; }
    .side .logo-wrap { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.15); border-radius: 8px; padding: 10px; text-align: center; margin-bottom: 16px; }
    .side .co-name { font-size: 16px; font-weight: 700; line-height: 1.4; }
    .side .co-en { font-size: 10px; opacity: .7; margin-top: 2px; }
    .side .divider { height: 1px; background: linear-gradient(90deg,transparent,#64748b,transparent); margin: 16px 0; }
    .side .info-block { font-size: 10.5px; color: #cbd5e1; line-height: 1.8; }
    .side .info-block b { color: #fff; display: block; font-size: 9px; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 2px; opacity: .8; }
    .side .info-block .grp { margin-bottom: 12px; }
    .main { padding: 22px 26px; background: #fff; }
    .main-head { border-bottom: 3px solid #0f172a; padding-bottom: 14px; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: flex-end; }
    .main-head h1 { font-size: 26px; font-weight: 800; color: #0f172a; }
    .main-head .sub { font-size: 11px; color: #64748b; margin-top: 4px; letter-spacing: 1px; }
    .num-box { text-align: left; }
    .num-box .lbl { font-size: 10px; color: #64748b; letter-spacing: 1.5px; }
    .num-box .num { font-size: 22px; font-weight: 800; color: #0f172a; font-variant-numeric: tabular-nums; }
    .num-box .dt { font-size: 11px; color: #64748b; margin-top: 2px; }
    .meta-cards { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; margin-bottom: 16px; }
    .mc { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 12px; text-align: center; }
    .mc .l { font-size: 9px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; }
    .mc .v { font-size: 12px; color: #0f172a; font-weight: 700; margin-top: 2px; }
    .cust-card { background: #f8fafc; border-right: 4px solid #0f172a; padding: 12px 16px; margin-bottom: 14px; border-radius: 4px 0 0 4px; }
    .cust-card h4 { font-size: 9px; color: #0f172a; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 6px; font-weight: 700; }
    table { font-size: 11px; }
    thead tr { background: #0f172a; color: #fff; }
    thead th { padding: 9px 8px; font-weight: 600; }
    tbody td { padding: 8px; border-bottom: 1px solid #e2e8f0; }
    tbody tr:nth-child(even) { background: #f8fafc; }
    .totals-area { margin-top: 14px; display: flex; justify-content: flex-start; }
    .totals-card { min-width: 280px; background: #0f172a; color: #fff; padding: 14px 18px; border-radius: 8px; }
    .t-row { display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 12px; }
    .t-row.grand { border-top: 1px solid rgba(255,255,255,.25); padding-top: 8px; margin-top: 6px; font-size: 16px; font-weight: 800; }
    .notes-box { margin-top: 16px; padding: 12px 14px; background: #fef3c7; border-right: 3px solid #f59e0b; border-radius: 4px 0 0 4px; font-size: 11px; }
    .footer { margin-top: 22px; padding-top: 10px; border-top: 1px solid #e2e8f0; font-size: 9px; color: #94a3b8; text-align: center; letter-spacing: 1px; }
  </style>
  </head><body>
  <div class="layout">
    <aside class="side">
      ${safeLogo ? `<div class="logo-wrap"><img src="${safeLogo}" alt="" style="max-height:60px;max-width:160px;object-fit:contain;display:block;margin:auto;"/></div>` : ""}
      <div class="co-name">${company?.nameAr ?? "اسم الشركة"}</div>
      ${company?.nameEn ? `<div class="co-en">${company.nameEn}</div>` : ""}
      <div class="divider"></div>
      <div class="info-block">
        ${company?.vatNumber ? `<div class="grp"><b>الرقم الضريبي</b>${company.vatNumber}</div>` : ""}
        ${company?.crNumber  ? `<div class="grp"><b>السجل التجاري</b>${company.crNumber}</div>` : ""}
        ${company?.city      ? `<div class="grp"><b>الموقع</b>${company.city}${company.country ? ` — ${company.country}` : ""}</div>` : ""}
        ${(company as any)?.phone ? `<div class="grp"><b>الهاتف</b>${(company as any).phone}</div>` : ""}
        ${(company as any)?.email ? `<div class="grp"><b>البريد</b>${(company as any).email}</div>` : ""}
      </div>
    </aside>
    <main class="main">
      <div class="main-head">
        <div>
          <h1>${docTitle(d.type)}</h1>
          <div class="sub">${docTitle(d.type).toUpperCase()}</div>
        </div>
        <div class="num-box">
          <div class="lbl">رقم الوثيقة</div>
          <div class="num">${doc.docNumber ?? `${docPrefix(d.type)}-${doc.id}`}</div>
          <div class="dt">${docDate(doc, d.type)}</div>
        </div>
      </div>
      <div class="meta-cards">
        <div class="mc"><div class="l">العملة</div><div class="v">${doc.currencyCode ?? "SAR"}</div></div>
        <div class="mc"><div class="l">${d.type === "quotation" ? "صلاحية" : "نوع الدفع"}</div><div class="v">${d.type === "quotation" ? (doc.validUntil ?? "—") : (doc.paymentType === "cash" ? "نقدي" : doc.paymentType === "bank" ? "بنك" : "آجل")}</div></div>
        <div class="mc"><div class="l">عدد البنود</div><div class="v">${lines.length}</div></div>
      </div>
      <div class="cust-card">
        <h4>العميل</h4>
        ${customerBlock(customer)}
      </div>
      ${linesTable(lines, "", "")}
      <div class="totals-area" style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;">
        <div style="text-align:center;">
          ${qrImgHtml(d, { size: 110, border: "1px solid #0f172a", bg: "#fff" })}
          <div style="font-size:9px;color:#0f172a;margin-top:4px;font-weight:700;letter-spacing:1px;">QR — ZATCA</div>
        </div>
        <div class="totals-card" style="flex:1;max-width:360px;">
          ${totalRowsHtml(computeFullTotals(doc, lines), "t-row", "grand")}
          ${summaryFooterHtml(computeFullTotals(doc, lines))}
        </div>
      </div>
      ${doc.notes ? `<div class="notes-box"><b>ملاحظات: </b>${doc.notes}</div>` : ""}
      <div class="footer">
        نظام الفاتورة الإلكترونية المتوافق مع ZATCA — طُبع ${new Date().toLocaleDateString("ar-SA")}
      </div>
    </main>
  </div>
  </body></html>`;
}

// ── Template 13: أنيق ذهبي ──────────────────────────────────────────────────
// Elegant gold/onyx layout inspired by premium boutique invoice designs:
// dark badge with the document number on one side, branded company card on
// the other, a rounded gold-bordered customer card, a slim accent-bar items
// table, and a split bottom row that mirrors the reference screenshot —
// totals stacked on the right with a dark/gold "Grand Total" ribbon, QR +
// Tafqeet card on the left. Uses the same shared helpers as the rest of
// the templates so every data field (logo, VAT, CR, branch, line discounts,
// free qty, Tafqeet, ZATCA QR) flows in unchanged.
function template13(d: PrintData): string {
  const { doc, lines, customer, company } = d;
  const isReturn = d.type === "return";
  const isQuot = d.type === "quotation";
  const english = isReturn ? "Sales Return" : isQuot ? "Quotation" : "Sales Invoice";
  const totals = computeFullTotals(doc, lines);
  const docNo = doc.docNumber ?? `${docPrefix(d.type)}-${doc.id}`;
  const safeLogo = safeLogoSrc(company?.logo);
  const GOLD = "#c9a35e";
  const GOLD_DARK = "#a8823d";
  const INK = "#0e1726";
  const CREAM = "#fbf8f1";

  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${docTitle(d.type)}</title>
  ${baseStyles(GOLD, "#fff")}
  <style>
    body { background:#fff; color:${INK}; font-family:'Segoe UI','Tajawal',Tahoma,Arial,sans-serif; }
    .sheet { padding:6px; }
    .ribbon-top { display:grid; grid-template-columns:1fr 1.2fr; gap:14px; margin-bottom:14px; }
    .badge-card {
      background:${INK}; color:#fff; border-radius:10px; padding:18px 20px;
      position:relative; overflow:hidden; min-height:130px;
      display:flex; flex-direction:column; justify-content:center;
      box-shadow:0 2px 8px rgba(14,23,38,.18);
    }
    .badge-card::before {
      content:""; position:absolute; top:0; right:0; width:6px; height:100%;
      background:linear-gradient(180deg, ${GOLD} 0%, ${GOLD_DARK} 100%);
    }
    .badge-card .lbl { font-size:10px; letter-spacing:2px; color:${GOLD}; text-transform:uppercase; margin-bottom:8px; }
    .badge-card .num { font-size:36px; font-weight:800; letter-spacing:1px; line-height:1; }
    .badge-card .meta { font-size:10px; opacity:.7; margin-top:10px; }
    .brand-card {
      background:#fff; border:1.5px solid ${GOLD}; border-radius:10px;
      padding:14px 18px; text-align:center; position:relative; min-height:130px;
      display:flex; flex-direction:column; align-items:center; justify-content:center;
    }
    .brand-card::before, .brand-card::after {
      content:""; position:absolute; top:50%; width:30px; height:1px; background:${GOLD}; opacity:.5;
    }
    .brand-card::before { right:14px; } .brand-card::after { left:14px; }
    .brand-card .crown {
      width:34px; height:14px; margin-bottom:6px;
      background:radial-gradient(circle at 50% 100%, ${GOLD} 0 38%, transparent 39%),
                 linear-gradient(90deg, transparent 30%, ${GOLD} 30% 70%, transparent 70%);
      opacity:.85;
    }
    .brand-card img { max-height:48px; max-width:160px; object-fit:contain; margin-bottom:4px; }
    .brand-card .name { font-size:18px; font-weight:800; color:${INK}; letter-spacing:.5px; }
    .brand-card .name-en { font-size:10px; color:${GOLD_DARK}; margin-top:2px; letter-spacing:1.5px; text-transform:uppercase; }

    .info-strip {
      display:grid; grid-template-columns:repeat(3,1fr); gap:0;
      border:1px solid ${GOLD}; border-radius:8px; overflow:hidden;
      margin-bottom:12px; background:${CREAM};
    }
    .info-strip > div { padding:8px 12px; border-left:1px solid ${GOLD}33; }
    .info-strip > div:first-child { border-left:0; }
    .info-strip .lbl { font-size:9px; color:${GOLD_DARK}; text-transform:uppercase; letter-spacing:1px; margin-bottom:2px; }
    .info-strip .val { font-size:12px; font-weight:700; color:${INK}; }

    .customer-card {
      border:1.5px solid ${GOLD}; border-radius:10px; padding:12px 16px;
      margin-bottom:14px; background:#fff; position:relative;
      display:grid; grid-template-columns:auto 1fr; gap:14px; align-items:center;
    }
    .customer-card .seal {
      width:44px; height:44px; border-radius:50%;
      background:${INK}; color:${GOLD}; display:flex; align-items:center; justify-content:center;
      font-size:18px; font-weight:800;
    }
    .customer-card .lines > div { font-size:11px; color:${INK}; margin-bottom:2px; }
    .customer-card .lines .name { font-size:14px; font-weight:700; color:${INK}; margin-bottom:4px; }

    table { border:0; }
    thead tr { background:${INK}; color:${GOLD}; }
    thead th { padding:8px 6px; font-size:10px; font-weight:700; letter-spacing:.5px; border:0; }
    thead th:first-child { border-top-right-radius:6px; }
    thead th:last-child  { border-top-left-radius:6px; }
    tbody td { padding:7px 6px; border-bottom:1px solid ${GOLD}33; font-size:11px; }
    tbody tr:nth-child(even) td { background:${CREAM}; }
    tbody tr:last-child td { border-bottom:1.5px solid ${GOLD}; }

    .bottom { display:grid; grid-template-columns:1fr 1.1fr; gap:14px; margin-top:14px; }
    .qr-card {
      border:1.5px solid ${GOLD}; border-radius:10px; padding:12px;
      background:${CREAM}; text-align:center;
    }
    .qr-card .lbl { font-size:9px; color:${GOLD_DARK}; letter-spacing:1.5px; text-transform:uppercase; margin-top:6px; }
    .tafqeet-card {
      margin-top:10px; border:1px dashed ${GOLD}; border-radius:8px;
      padding:8px 12px; background:#fff; font-size:11px; color:${INK};
    }
    .tafqeet-card .lbl { font-size:9px; color:${GOLD_DARK}; letter-spacing:1px; margin-bottom:3px; }

    .totals-card { border:1.5px solid ${GOLD}; border-radius:10px; overflow:hidden; background:#fff; }
    .totals-card .row {
      display:flex; justify-content:space-between; align-items:center;
      padding:8px 14px; font-size:12px; color:${INK}; border-bottom:1px solid ${GOLD}33;
    }
    .totals-card .row.muted { color:#6b7280; }
    .totals-card .row.disc  { color:#b91c1c; }
    .totals-card .row.vat   { color:${GOLD_DARK}; font-weight:600; }
    .totals-card .row.grand {
      background:${INK}; color:#fff; font-size:16px; font-weight:800;
      letter-spacing:.5px; border:0;
      position:relative;
    }
    .totals-card .row.grand::before {
      content:""; position:absolute; right:0; top:0; bottom:0; width:6px;
      background:linear-gradient(180deg, ${GOLD} 0%, ${GOLD_DARK} 100%);
    }
    .totals-card .row.grand .v { color:${GOLD}; }

    .doc-footer {
      margin-top:18px; padding:10px 16px; border-radius:8px;
      background:${INK}; color:#fff; display:flex; justify-content:space-between;
      align-items:center; font-size:10px;
    }
    .doc-footer .gold { color:${GOLD}; }

    .banner {
      text-align:center; padding:6px 10px; border-radius:6px; margin-bottom:10px;
      font-weight:700; font-size:11px;
    }
    .banner.ret { background:#fef2f2; border:1.5px solid #ef4444; color:#b91c1c; }
    .banner.quo { background:#eff6ff; border:1.5px solid #3b82f6; color:#1e40af; }

    .notes { margin-top:10px; padding:8px 12px; border-right:3px solid ${GOLD};
             background:${CREAM}; font-size:11px; color:${INK}; border-radius:4px; }
  </style>
  </head><body><div class="sheet">

    ${isReturn ? `<div class="banner ret">⚠ مستند مرتجع مبيعات — Sales Return</div>` : ""}
    ${isQuot   ? `<div class="banner quo">عرض سعر — غير فاتورة ضريبية</div>` : ""}

    <div class="ribbon-top">
      <div class="badge-card">
        <div class="lbl">${docTitle(d.type)}</div>
        <div class="num">${docNo}</div>
        <div class="meta">${english} · ${docDate(doc, d.type)}</div>
      </div>
      <div class="brand-card">
        <div class="crown"></div>
        ${safeLogo ? `<img src="${safeLogo}" alt="" />` : ""}
        <div class="name">${company?.nameAr ?? "اسم الشركة"}</div>
        ${company?.nameEn ? `<div class="name-en">${company.nameEn}</div>` : ""}
      </div>
    </div>

    <div class="info-strip">
      <div><div class="lbl">التاريخ — Date</div><div class="val">${docDate(doc, d.type)}</div></div>
      <div><div class="lbl">رقم العميل — Cust. No.</div><div class="val">${customer?.code ?? customer?.id ?? "—"}</div></div>
      <div><div class="lbl">${isQuot ? "صالح حتى — Valid Until" : "طريقة الدفع — Payment"}</div>
           <div class="val">${isQuot
             ? (doc.validUntil ?? "—")
             : (doc.paymentType === "cash" ? "نقدي Cash" : doc.paymentType === "bank" ? "بنك Bank" : "آجل Credit")}</div></div>
    </div>

    <div class="customer-card">
      <div class="seal">${(customer?.nameAr ?? customer?.nameEn ?? "؟").trim().charAt(0)}</div>
      <div class="lines">
        <div class="name">${customer?.nameAr ?? customer?.nameEn ?? "—"}</div>
        ${customer?.vatNumber ? `<div><span style="color:${GOLD_DARK}">الرقم الضريبي:</span> ${customer.vatNumber}</div>` : ""}
        ${customer?.phone     ? `<div><span style="color:${GOLD_DARK}">هاتف:</span> ${customer.phone}</div>` : ""}
        ${customer?.city      ? `<div><span style="color:${GOLD_DARK}">العنوان:</span> ${customer.city}${customer.country ? ` — ${customer.country}` : ""}</div>` : ""}
      </div>
    </div>

    ${linesTable(lines, "", "")}

    <div class="bottom">
      <div>
        <div class="qr-card">
          ${qrImgHtml(d, { size: 120, border: `1px solid ${GOLD}`, bg: "#fff", color: INK })}
          <div class="lbl">رمز QR — ZATCA</div>
        </div>
        <div class="tafqeet-card">
          <div class="lbl">المبلغ بالحروف — Amount in Words</div>
          <div><b>${numberToArabicWords(totals.grandTotal)} ${totals.currency === "SAR" ? "ريال سعودي لا غير" : totals.currency}</b></div>
        </div>
      </div>
      <div>
        <div class="totals-card">
          <div class="row muted"><span>الإجمالي قبل الخصم — Subtotal</span><span class="mono">${fmt(totals.subtotalPreDiscount)} ${totals.currencySym}</span></div>
          <div class="row disc"><span>مبلغ الخصم — Discount</span><span class="mono">${fmt(totals.discountTotal)} ${totals.currencySym}</span></div>
          <div class="row"><span>الصافي بدون الضريبة — Net</span><span class="mono">${fmt(totals.netPreVat)} ${totals.currencySym}</span></div>
          <div class="row vat"><span>ضريبة القيمة المضافة — VAT</span><span class="mono">${fmt(totals.vatAmount)} ${totals.currencySym}</span></div>
          <div class="row grand"><span>الصافي شامل الضريبة — Total</span><span class="mono v">${fmt(totals.grandTotal)} ${totals.currencySym}</span></div>
        </div>
        ${summaryFooterHtml(totals)}
      </div>
    </div>

    ${doc.notes ? `<div class="notes"><b>ملاحظات:</b> ${doc.notes}</div>` : ""}

    <div class="doc-footer">
      <span><span class="gold">ر.ض:</span> ${company?.vatNumber ?? "—"} · <span class="gold">س.ت:</span> ${company?.crNumber ?? "—"}${company?.phone ? ` · <span class="gold">هاتف:</span> ${company.phone}` : ""}</span>
      <span class="gold">ZATCA e-Invoice · ${new Date().toLocaleDateString("ar-SA")}</span>
    </div>

  </div></body></html>`;
}

// ── Print i18n (currently honoured by template 14 «الأصلي» only) ────────────
// Central label dictionary so future templates can opt into bilingual print
// by threading the same `getPrintLabels(lang)` map. English mode flips the
// document to LTR and uses English column / field labels; item names are
// resolved live from the inventory catalogue (Arabic name → English name)
// by the modal and passed in via `d._enNames`.
export type PrintLang = "ar" | "en";
interface PrintLabels {
  companyInfo: string; vatNumber: string; crNumber: string; phone: string;
  customerInfo: string; accountCode: string; customerAddress: string;
  validUntil: string; reference: string;
  colItem: string; colQty: string; colFree: string; colUnit: string;
  colUnitPrice: string; colDiscount: string; colDiscountValue: string;
  colAmount: string; colVat: string; colVatValue: string; colTotal: string;
  lineNotesLbl: string; notesLbl: string;
  createdAtLbl: string; byLbl: string; printedLbl: string;
  companyNameFallback: string; none: string;
  totalItemsLbl: string; totalQtyLbl: string; freeWord: string;
  street: string; postalCode: string; city: string; country: string;
}
function getPrintLabels(lang: PrintLang): PrintLabels {
  if (lang === "en") {
    return {
      companyInfo: "Company", vatNumber: "VAT No.", crNumber: "CR No.", phone: "Phone",
      customerInfo: "Customer", accountCode: "Account Code", customerAddress: "Address",
      validUntil: "Valid until", reference: "Ref",
      colItem: "Item / Service", colQty: "Qty", colFree: "Free Qty", colUnit: "Unit",
      colUnitPrice: "Unit Price", colDiscount: "Discount", colDiscountValue: "Disc. Value",
      colAmount: "Amount", colVat: "VAT", colVatValue: "VAT Value", colTotal: "Total",
      lineNotesLbl: "Notes:", notesLbl: "Notes:",
      createdAtLbl: "Created", byLbl: "By", printedLbl: "Printed",
      companyNameFallback: "Company Name", none: "—",
      totalItemsLbl: "Total Items", totalQtyLbl: "Total Quantity (incl. free)", freeWord: "free",
      street: "Street", postalCode: "Postal Code", city: "City", country: "Country",
    };
  }
  return {
    companyInfo: "بيانات الشركة", vatNumber: "الرقم الضريبي:", crNumber: "السجل التجاري:", phone: "الهاتف:",
    customerInfo: "بيانات العميل", accountCode: "كود الحساب:", customerAddress: "عنوان العميل:",
    validUntil: "صالح حتى", reference: "مرجع",
    colItem: "الصنف / الخدمة", colQty: "الكمية", colFree: "الكمية المجانية", colUnit: "الوحدة",
    colUnitPrice: "سعر الوحدة", colDiscount: "الخصم", colDiscountValue: "قيمة الخصم",
    colAmount: "المبلغ", colVat: "الضريبة", colVatValue: "قيمة الضريبة", colTotal: "الإجمالي",
    lineNotesLbl: "ملاحظات:", notesLbl: "ملاحظات:",
    createdAtLbl: "تاريخ الإنشاء", byLbl: "بواسطة", printedLbl: "طُبع",
    companyNameFallback: "اسم الشركة", none: "—",
    totalItemsLbl: "إجمالي أصناف الفاتورة", totalQtyLbl: "إجمالي كميات الفاتورة (شاملة المجانية)", freeWord: "مجاني",
    street: "اسم الشارع:", postalCode: "الرمز البريدي:", city: "المدينة:", country: "الدولة:",
  };
}
// English-only summary footer (no Arabic tafqeet) used when printing template
// 14 in English. Mirrors the layout of `summaryFooterHtml` minus amountWords.
function summaryFooterHtmlEn(t: FullTotals): string {
  return `
    <div style="margin-top:10px;border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;font-size:11px;background:#fafafa;">
      <div style="display:flex;justify-content:space-between;border-top:1px dashed #cbd5e1;padding-top:6px;">
        <span>Total Items</span>
        <span class="mono" style="font-weight:700;">${t.itemsCount}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:3px;">
        <span>Total Quantity (incl. free)</span>
        <span class="mono" style="font-weight:700;">${fmtEn(t.totalQty + t.totalFreeQty)}${t.totalFreeQty > 0 ? ` <span style="color:#b45309;font-weight:600;">(${fmtEn(t.totalFreeQty)} free)</span>` : ""}</span>
      </div>
    </div>`;
}

// ── Template 14: الأصلي ─────────────────────────────────────────────────────
// Per-spec layout requested by the user:
//   • Top-right  : company info column (AR + EN name, VAT, CR, phone)
//   • Top-center : centered logo + document title pill (ضريبية / مبسطة)
//                  + payment-type & date pills underneath
//   • Top-left   : customer card (name, VAT, account code, phone, building #)
//   • Lines      : full-width populated table (qty / unit / price / VAT / total)
//   • Bottom     : totals + ZATCA QR side-by-side, footer with
//                  created-at + "بواسطة" + username.
//
// "ضريبية" vs "مبسطة" follows the ZATCA classification rule: a customer with
// a VAT number is treated as a B2B taxable invoice (standard), otherwise as
// a simplified (B2C) invoice. Returns/orders/quotations are handled too.
function template14(d: PrintData): string {
  const { doc, lines, customer, company } = d;
  // ── Language ───────────────────────────────────────────────────────────
  // `_lang` / `_enNames` are injected by SalesPrintModal right before this
  // builder runs. English mode flips to LTR, English labels, and live
  // English item names (Arabic name → English name lookup map).
  const lang: PrintLang = (d as any)._lang === "en" ? "en" : "ar";
  const isEn = lang === "en";
  const L = getPrintLabels(lang);
  const enNames: Map<string, string> = (d as any)._enNames instanceof Map ? (d as any)._enNames : new Map();
  const enUnits: Map<string, string> = (d as any)._enUnits instanceof Map ? (d as any)._enUnits : new Map();
  const dir = isEn ? "ltr" : "rtl";
  const locale = isEn ? "en-GB" : "ar-SA";
  // Number formatter: Latin digits in EN mode, Arabic-Indic in AR mode.
  const nf = isEn ? fmtEn : fmt;
  // Bilingual totals label: AR mode keeps the "عربي — English" pairing,
  // EN mode shows English only.
  const tl = (ar: string, en: string) => (isEn ? en : `${ar} — ${en}`);
  // Item display name — English lookup by Arabic name when printing in EN.
  const itemDisplayName = (l: any): string => {
    const arName = (l.itemName ?? l.itemCode ?? "").toString();
    if (!isEn) return arName || L.none;
    const key = arName.trim().toLowerCase();
    const en = key ? enNames.get(key) : undefined;
    return en || arName || L.none;
  };
  // Unit-of-measure display — translated to English when printing in EN. The
  // line's `unit` is the Arabic name (or sometimes the UN/CEFACT code); fall
  // back to the raw value when no English mapping exists.
  const unitDisplay = (l: any): string => {
    const raw = (l.unit ?? "").toString().trim();
    if (!raw) return "—";
    if (!isEn) return raw;
    return enUnits.get(raw.toLowerCase()) || enUnits.get(raw.toUpperCase()) || raw;
  };
  const totals = computeFullTotals(doc, lines);
  const safeLogo = safeLogoSrc(company?.logo);
  const isReturn = d.type === "return";
  const isQuot   = d.type === "quotation";
  const isOrder  = d.type === "order";
  // Standard vs Simplified — driven by buyer-VAT presence per ZATCA spec.
  // Fall back to the invoice snapshot's `buyerVatNumber` so the title stays
  // "ضريبية" even when the customer master record is missing or stale
  // (e.g. walk-in / deleted customer rows where the VAT was captured on the
  // invoice itself).
  const hasBuyerVat = !!(customer?.vatNumber ?? doc.buyerVatNumber);
  const isSimplified = !hasBuyerVat;
  const titleAr = isReturn ? (isSimplified ? "مرتجع مبيعات مبسط" : "مرتجع مبيعات ضريبي")
              : isQuot   ? "عرض سعر"
              : isOrder  ? "أمر بيع"
              :            (isSimplified ? "فاتورة مبيعات مبسطة" : "فاتورة مبيعات ضريبية");
  const titleEn = isReturn ? "Sales Return"
              : isQuot   ? "Quotation"
              : isOrder  ? "Sales Order"
              :            (isSimplified ? "Simplified Tax Invoice" : "Tax Invoice");
  const titleMain = isEn ? titleEn : titleAr;
  const titleSub  = isEn ? titleAr : titleEn;
  const docNo = doc.docNumber ?? `${docPrefix(d.type)}-${doc.id}`;
  const dateStr = docDate(doc, d.type);
  const payLabel = isEn
    ? (doc.paymentType === "cash" ? "Cash" : doc.paymentType === "bank" ? "On Account" : "Credit")
    : (doc.paymentType === "cash" ? "نقداً" : doc.paymentType === "bank" ? "على حساب" : "آجل");
  // Customer "account code" — prefer an explicit code, else fall back to the
  // chart-of-accounts link, else the customer id (#123) so the field never
  // shows a blank placeholder.
  const acctCode = (customer as any)?.accountCode
                ?? (customer as any)?.code
                ?? (customer?.accountId != null ? `A-${customer.accountId}` : null)
                ?? (customer?.id != null ? `#${customer.id}` : null);
  // Saudi national address building number — pulled from the customer record
  // (already populated from the national-address service when available).
  const bldgNo = customer?.buildingNumber ?? (customer as any)?.buyerBuildingNumber ?? null;
  // Foreign-customer address (template 14 «النموذج الأصلي» only): when the
  // buyer's country is not SA, the customer block renders the international
  // address in a fixed order — name → street → postal code → city → country.
  // Saudi customers keep the original single-line (building number) layout.
  const custCountryCode = String((customer as any)?.country ?? (doc as any)?.buyerCountry ?? "SA").toUpperCase();
  const isForeignCust = custCountryCode !== "SA";
  const custStreet = (customer as any)?.street ?? (doc as any)?.buyerStreet ?? null;
  const custPostal = (customer as any)?.postalCode ?? (doc as any)?.buyerPostalCode ?? null;
  const custCity   = (customer as any)?.city ?? (doc as any)?.buyerCity ?? null;
  // Foreign-customer country always prints in ENGLISH (international document
  // convention), regardless of the print language (Arabic or English).
  const custCountryName = getWorldCountryName(custCountryCode, "en");
  // Footer audit line — only render the "أنشئ بـ" line when we actually have
  // a timestamp; some legacy rows may not carry one.
  const createdAtRaw = doc.createdAt ?? doc.invoiceDate ?? doc.returnDate ?? doc.orderDate ?? doc.quotationDate ?? null;
  let createdAtStr = "—";
  if (createdAtRaw) {
    try {
      const dt = new Date(createdAtRaw);
      if (!isNaN(dt.getTime())) {
        createdAtStr = dt.toLocaleString(locale, {
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit",
        });
      } else {
        createdAtStr = String(createdAtRaw);
      }
    } catch { createdAtStr = String(createdAtRaw); }
  }
  const userName = doc.createdByName ?? doc.postedByName ?? "—";

  // Split the lines into chunks per page so a long invoice paginates
  // cleanly. The page-frame `<thead>`/`<tfoot>` (company/customer + audit
  // footer) re-renders on every printed page automatically thanks to
  // `display: table-header-group / table-footer-group`.
  //
  // Sized so the LAST page can always fit both the remaining items AND
  // the bottom block (totals + QR ~50mm) together with safety margin —
  // otherwise overflow pushes the audit footer (or worse, the whole
  // bottom block) onto a fresh blank page. 12 rows × ~10mm + bottom
  // block ~50mm ≈ 170mm, well inside the ~200mm content area between
  // the running header and running footer on A4.
  // Natural pagination: render ALL items in ONE table and let the print
  // engine break across pages, filling each page completely with rows
  // before moving on. No fixed per-page row cap and NO empty filler rows
  // (those wasted space and pushed the totals block onto a blank page).
  // The page-frame's running header/footer repeat on every page, and the
  // lines table's own <thead> repeats too, so multi-page invoices stay
  // readable. The bottom block (totals + QR) flows right after the last
  // row and is kept intact via break-inside:avoid.
  const LINES_PER_PAGE = lines.length || 1; // retained for row-index math below
  const lineChunks: any[][] = [lines];

  // Bottom-anchor the totals/QR cluster ONLY for short invoices that are
  // guaranteed to fit on a single page together with that cluster. For those,
  // the items+totals are wrapped in a flex column so a spacer can push the
  // cluster to the page foot (fixes the large empty area under a few-item
  // invoice). For longer/multi-page invoices we stay in plain block flow so
  // the lines table paginates reliably (Chrome print fragmentation inside a
  // flex container is unreliable). ~12 rows is a conservative single-page cap.
  const anchorBottom = lines.length <= 12;

  const docHead = `<!DOCTYPE html><html dir="${dir}"><head><meta charset="UTF-8"><title>${titleMain} — ${docNo}</title>
  ${baseStyles("#0f172a")}
  <style>
    /* "النموذج الأصلي" — reasonable page margins so the running header
       (red box) and running footer (green box) have breathing room on
       every printed page. The browser injects whatever space it needs
       for the thead/tfoot inside .page-frame at the top/bottom of each
       page; the @page margin reserves the outer padding. */
    /* Tightened bottom & top margins so the running header on each
       new page sits closer to the previous page's running footer —
       removes the visual "gap between the red boxes" the user flagged. */
    @page { size: A4; margin: 8mm 8mm 10mm 8mm !important; }
    :root { --ink:#0f172a; --line:#e5e7eb; --soft:#f8fafc; --gold:#b88a2a; --gold2:#e5c277; }
    html, body { padding: 0 !important; margin: 0 !important; color: var(--ink); }
    .sheet { padding: 0 !important; }

    /* ── Page frame: repeating header + footer on every printed page ─ */
    .page-frame { width: 100%; border-collapse: collapse; }
    .page-frame > thead { display: table-header-group; }
    .page-frame > tfoot { display: table-footer-group; }
    .page-frame > thead > tr > td,
    .page-frame > tfoot > tr > td,
    .page-frame > tbody > tr > td { padding: 0; vertical-align: top; }
    /* Tight breathing space so consecutive page header/footer pairs
       sit close together across the page break. */
    .running-header { padding-top: 2mm; padding-bottom: 4px; }
    .running-footer { padding-top: 4px; padding-bottom: 1mm; }

    /* ── 3-column header ───────────────────────────────────────────── */
    .hdr { display:grid; grid-template-columns: 1fr 1.1fr 1fr; gap:12px; align-items:stretch; margin-bottom:14px; }
    .col-co, .col-cu { background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px 14px; box-shadow: 0 1px 0 rgba(15,23,42,.03); }
    .col-co .label, .col-cu .label {
      font-size:10px; letter-spacing:.08em; color:var(--gold);
      font-weight:800; text-transform:uppercase; margin-bottom:6px;
      border-bottom:1px solid var(--line); padding-bottom:4px;
    }
    .col-co .row, .col-cu .row {
      display:flex; gap:6px; align-items:baseline; margin-top:4px; font-size:11px; color:#334155;
    }
    .col-co .row b, .col-cu .row b { color:var(--ink); font-weight:700; min-width:70px; }
    .col-co .co-name-ar { font-size:16px; font-weight:800; color:var(--ink); margin-bottom:2px; }
    .col-co .co-name-en { font-size:11px; color:#64748b; margin-bottom:6px; font-style:italic; }
    .col-cu .cu-name { font-size:15px; font-weight:800; color:var(--ink); margin-bottom:6px; }

    /* ── Center logo block ─────────────────────────────────────────── */
    .col-mid { text-align:center; display:flex; flex-direction:column; align-items:center; justify-content:flex-start; gap:8px; padding-top:2px; position:relative; }
    .col-mid::before, .col-mid::after {
      content:""; position:absolute; left:50%; transform:translateX(-50%);
      width:48px; height:2px; background:linear-gradient(90deg, transparent, var(--gold2), transparent);
    }
    .col-mid::before { top:0; }
    .col-mid::after  { bottom:0; }
    .logo-wrap {
      background:#fff; border:1px solid var(--line); border-radius:14px;
      padding:8px 14px; display:inline-flex; align-items:center; justify-content:center;
      box-shadow: 0 2px 8px rgba(184,138,42,.10);
    }
    .logo-wrap img { max-height:62px; max-width:170px; object-fit:contain; display:block; }
    /* Classic, borderless title — no dark pill, no surrounding frame.
       Two thin gold accent lines above/below give it an elegant feel
       without the heavy "badge" look. */
    .doc-title-pill {
      background:transparent; color:var(--ink);
      padding:6px 14px; font-size:16px; font-weight:800;
      letter-spacing:.02em; text-align:center;
      border:none;
      border-top:1px solid var(--gold2);
      border-bottom:1px solid var(--gold2);
    }
    .doc-title-pill .en { display:block; font-size:10px; color:var(--gold); font-weight:700; letter-spacing:.14em; margin-top:3px; text-transform:uppercase; }
    .meta-pills { display:flex; gap:6px; justify-content:center; flex-wrap:wrap; }
    .pill {
      background:var(--soft); border:1px solid var(--line); border-radius:18px;
      padding:4px 12px; font-size:10.5px; color:#334155; display:inline-flex; align-items:center; gap:5px;
    }
    .pill b { color:var(--ink); font-weight:700; }
    .pill.pay { background:#fef3c7; border-color:#fcd34d; color:#7c2d12; }
    .pill.no  { background:#e0f2fe; border-color:#7dd3fc; color:#075985; font-family:'Segoe UI', monospace; }

    /* ── Lines table ───────────────────────────────────────────────── */
    /* Borderless, simple look: no outer frame, light grey thead with dark
       text, soft zebra striping, and only a bottom border on cells.
       Each chunk of 10 lines is its own <table> followed by an explicit
       page-break so pages stay capped at exactly 10 items. */
    .lines-wrap { margin-top:6px; border:none; border-radius:0; overflow:visible; }
    .lines-chunk { width:100%; border-collapse:collapse; font-size:11px; margin-bottom:0; }
    .lines-chunk + .lines-chunk { margin-top:0; }
    .lines-chunk thead tr { background:#f3f4f6; color:var(--ink); }
    .lines-chunk th { padding:8px 6px; font-weight:700; font-size:10.5px; letter-spacing:.02em; border:none; border-bottom:1px solid var(--line); text-align:right; }
    .lines-chunk td { padding:10px 6px; border:none; border-bottom:1px solid var(--line); text-align:right; }
    .lines-chunk tbody tr.item-row:nth-of-type(odd) td { background:#fafbfc; }
    /* Avoid splitting an item row (and its notes companion row) across
       pages — keeps line + its description glued together. */
    .lines-chunk tbody tr { page-break-inside: avoid; break-inside: avoid; }
    /* Per-line notes — a simple, lightweight row under the item with a
       gold side accent and italic body text. colspan is set inline so
       it matches the variable number of columns. */
    .lines-chunk tbody tr.line-notes td {
      padding:6px 10px 10px;
      background:#fff;
      border-bottom:1px solid var(--line);
      font-size:10.5px;
      color:#475569;
      font-style:italic;
      border-right:3px solid var(--gold2);
    }
    .lines-chunk tbody tr.line-notes .nlbl { color:var(--gold); font-weight:700; font-style:normal; margin-left:4px; }
    .page-break { page-break-after: always; break-after: page; height:0; }

    /* ── Page body: pin the totals/QR cluster to the page bottom ─────── */
    /* The tbody content is a flex column so the .bottom-spacer can push the
       totals/QR cluster (.bottom) down into the empty area at the foot of
       the page — instead of letting it float mid-page right under the items
       — even for a single-item invoice. Natural pagination is preserved:
       when the items are tall enough to fill/overflow a page the spacer
       collapses to 0 and the lines table simply breaks onto the next page.
       min-height = A4 printable height (297 − 8 top − 10 bottom = 279mm)
       minus a ~79mm reserve for the repeating running header + footer +
       safety, so the cluster lands near the page bottom WITHOUT ever
       spilling onto a fresh blank page. Keep in sync with the @page margins
       and the running header/footer above. */
    .page-body { display:flex; flex-direction:column; min-height:200mm; }
    .bottom-spacer { flex:1 1 auto; min-height:0; }

    /* ── Totals + QR + footer ───────────────────────────────────────── */
    .bottom { display:grid; grid-template-columns: 1fr 280px; gap:14px; margin-top:14px; align-items:flex-start; break-inside: avoid; page-break-inside: avoid; }
    .qr-card { border:1px solid var(--line); border-radius:10px; padding:10px; text-align:center; background:#fff; }
    .qr-card .lbl { font-size:9px; color:#64748b; margin-top:4px; letter-spacing:.08em; }
    .totals-card { border:1px solid var(--line); border-radius:10px; padding:12px 14px; background:#fff; }
    .__totalsRow { display:flex; justify-content:space-between; font-size:11.5px; color:#334155; margin-bottom:5px; }
    .__totalsRow.grand {
      border-top:1.5px solid var(--ink); margin-top:6px; padding-top:7px;
      font-size:13.5px; font-weight:800; color:var(--ink);
    }
    .audit-footer {
      margin-top:14px; border-top:2px solid var(--gold); padding-top:8px;
      display:flex; justify-content:space-between; align-items:center;
      font-size:10.5px; color:#475569;
    }
    .audit-footer .grp { display:flex; flex-direction:column; gap:2px; }
    .audit-footer b { color:var(--ink); font-weight:700; }
    .notes-box {
      margin-top:10px; background:var(--soft); border:1px solid var(--line); border-right:3px solid var(--gold);
      border-radius:8px; padding:8px 12px; font-size:11px; color:#334155;
    }
    .notes-box b { color:var(--ink); }
    /* QR column wrapper: stacks the QR card and the optional bank-details box. */
    .qr-col { display:flex; flex-direction:column; gap:10px; }
    .bank-box {
      border:1px solid var(--line); border-radius:10px; padding:10px 12px; background:#fff;
      font-size:11px; color:#334155; text-align:start;
    }
    .bank-box .bank-title { font-weight:700; color:var(--ink); margin-bottom:5px; font-size:11.5px; }
    .bank-box .bank-body { line-height:1.7; white-space:pre-line; }
    /* English (LTR) mode — flip table + field alignment so the layout
       reads naturally left-to-right while keeping the same structure.
       baseStyles hard-codes body direction:rtl which beats the html
       dir="ltr" attribute, so we must override the body direction here —
       this is what actually flips the item-table column order and the
       3-column header grid (COMPANY to the left, CUSTOMER to the right)
       to the English convention, mirror-imaging the Arabic layout. */
    html[dir="ltr"] body { direction: ltr; }
    /* English print: center the company & customer header blocks (label,
       name, and each label/value row) per the user's request. */
    html[dir="ltr"] .col-co, html[dir="ltr"] .col-cu { text-align:center; }
    html[dir="ltr"] .col-co .row, html[dir="ltr"] .col-cu .row { justify-content:center; }
    html[dir="ltr"] .col-co .row b, html[dir="ltr"] .col-cu .row b { min-width:0; }
    html[dir="ltr"] .lines-chunk th,
    html[dir="ltr"] .lines-chunk td { text-align:left; }
    html[dir="ltr"] .line-notes td { border-right:none; border-left:3px solid var(--gold2); }
    html[dir="ltr"] .audit-footer .grp:last-child { text-align:right !important; }
  </style>
  </head>`;

  // Build the per-page red-box header HTML once — repeated by the
  // browser's table-header-group machinery on every page.
  const headerHtml = `
    <div class="hdr">
      <!-- COMPANY (right side in RTL — first in DOM) -->
      <div class="col-co">
        <div class="label">${L.companyInfo}</div>
        <div class="co-name-ar">${(isEn ? (company?.nameEn ?? company?.nameAr) : company?.nameAr) ?? L.companyNameFallback}</div>
        ${(!isEn && company?.nameEn) ? `<div class="co-name-en">${company?.nameEn}</div>` : ""}
        ${company?.vatNumber ? `<div class="row"><b>${L.vatNumber}</b><span class="mono">${company.vatNumber}</span></div>` : ""}
        ${company?.crNumber  ? `<div class="row"><b>${L.crNumber}</b><span class="mono">${company.crNumber}</span></div>` : ""}
        ${(company as any)?.phone ? `<div class="row"><b>${L.phone}</b><span class="mono">${(company as any).phone}</span></div>` : ""}
      </div>

      <!-- LOGO + TITLE + META (center) -->
      <div class="col-mid">
        ${safeLogo ? `<div class="logo-wrap"><img src="${safeLogo}" alt="logo" /></div>` : ""}
        <div class="doc-title-pill">
          ${titleMain}
          ${!isEn ? `<span class="en">${titleSub}</span>` : ""}
        </div>
        <div class="meta-pills">
          <span class="pill no"><b>${docNo}</b></span>
          ${!isNonPaymentDoc(d.type) ? `<span class="pill pay"><b>${payLabel}</b></span>` : ""}
          <span class="pill">📅 <b>${dateStr}</b></span>
          ${isQuot && doc.validUntil ? `<span class="pill">${L.validUntil} <b>${doc.validUntil}</b></span>` : ""}
          ${isReturn && doc.invoiceId ? `<span class="pill">${L.reference}: <b>${doc.invoiceId}</b></span>` : ""}
        </div>
      </div>

      <!-- CUSTOMER (left side in RTL — last in DOM) -->
      <div class="col-cu">
        <div class="label">${L.customerInfo}</div>
        <div class="cu-name">${(isEn ? (customer?.nameEn ?? customer?.nameAr) : (customer?.nameAr ?? customer?.nameEn)) ?? doc.buyerName ?? L.none}</div>
        ${isForeignCust ? `
          ${custStreet ? `<div class="row"><b>${L.street}</b><span class="mono">${custStreet}</span></div>` : ""}
          ${custPostal ? `<div class="row"><b>${L.postalCode}</b><span class="mono">${custPostal}</span></div>` : ""}
          ${custCity ? `<div class="row"><b>${L.city}</b><span class="mono">${custCity}</span></div>` : ""}
          <div class="row"><b>${L.country}</b><span class="mono">${custCountryName}</span></div>
          ${(customer?.vatNumber ?? doc.buyerVatNumber)
            ? `<div class="row"><b>${L.vatNumber}</b><span class="mono">${customer?.vatNumber ?? doc.buyerVatNumber}</span></div>` : ""}
          ${acctCode ? `<div class="row"><b>${L.accountCode}</b><span class="mono">${acctCode}</span></div>` : ""}
          ${customer?.phone ? `<div class="row"><b>${L.phone}</b><span class="mono">${customer.phone}</span></div>` : ""}
        ` : `
          ${(customer?.vatNumber ?? doc.buyerVatNumber)
            ? `<div class="row"><b>${L.vatNumber}</b><span class="mono">${customer?.vatNumber ?? doc.buyerVatNumber}</span></div>` : ""}
          ${acctCode ? `<div class="row"><b>${L.accountCode}</b><span class="mono">${acctCode}</span></div>` : ""}
          ${customer?.phone ? `<div class="row"><b>${L.phone}</b><span class="mono">${customer.phone}</span></div>` : ""}
          ${bldgNo ? `<div class="row"><b>${L.customerAddress}</b><span class="mono">${bldgNo}</span></div>` : ""}
        `}
      </div>
    </div>`;

  // Green-box running footer — appears on every printed page.
  const footerHtml = `
    <div class="audit-footer">
      <div class="grp">
        <span>${L.createdAtLbl}: <b>${createdAtStr}</b></span>
        <span>${L.byLbl}: <b>${userName}</b></span>
      </div>
      <div class="grp" style="text-align:left;">
        <span>${L.printedLbl}: <b>${new Date().toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</b></span>
        <span style="color:var(--gold);font-weight:700;">ZATCA e-Invoice</span>
      </div>
    </div>`;

  // ── Build the per-chunk line tables (max 10 rows each) ──────────────
  // Fixed column layout per user spec — always show every column in this
  // exact order regardless of whether a line uses discount / free qty:
  //   # / الصنف / الوحدة / سعر الوحدة / الكمية / الخصم / الكمية المجانية /
  //   المبلغ / الضريبة / قيمة الضريبة / الإجمالي
  // Total visible column count — needed for the per-line notes colspan.
  const colCount = 11;

  const linesHeadHtml = `
    <thead>
      <tr>
        <th style="width:30px">#</th>
        <th>${L.colItem}</th>
        <th>${L.colUnit}</th>
        <th>${L.colUnitPrice}</th>
        <th>${L.colQty}</th>
        <th>${L.colDiscount}</th>
        <th style="color:#b45309;">${L.colFree}</th>
        <th>${L.colAmount}</th>
        <th>${L.colVat}</th>
        <th>${L.colVatValue}</th>
        <th>${L.colTotal}</th>
      </tr>
    </thead>`;

  const chunkTablesHtml = lineChunks.map((chunk, chunkIdx) => {
    const rowsHtml = chunk.map((l: any, j: number) => {
      const idx = chunkIdx * LINES_PER_PAGE + j;
      const qty   = Number(l.qty) || 0;
      const price = Number(l.unitPrice) || 0;
      const gross = qty * price;
      const discPct = Math.max(0, Math.min(100, Number(l.discount) || 0));
      const rawAmt  = Math.max(0, Number(l.discountAmount) || 0);
      const discAmtEff = rawAmt > 0 ? Math.min(rawAmt, gross) : (gross * discPct) / 100;
      const sub  = Math.max(0, gross - discAmtEff);
      const vat  = sub * ((Number(l.vatRate) || 0) / 100);
      const tot  = sub + vat;
      const freeQ = Number(l.freeQty) || 0;
      const discValCell = discAmtEff > 0 ? nf(discAmtEff) : "—";
      const noteText = (l.notes ?? l.description ?? "").toString().trim();
      const itemRow = `
        <tr class="item-row">
          <td>${idx + 1}</td>
          <td>${itemDisplayName(l)}</td>
          <td>${unitDisplay(l)}</td>
          <td class="mono">${nf(l.unitPrice)}</td>
          <td class="mono">${Math.round(qty)}</td>
          <td class="mono" style="color:#b91c1c;">${discValCell}</td>
          <td class="mono" style="color:#b45309;font-weight:600;">${freeQ > 0 ? Math.round(freeQ) : "—"}</td>
          <td class="mono">${nf(sub)}</td>
          <td class="mono">${l.vatRate ?? 15}%</td>
          <td class="mono">${nf(vat)}</td>
          <td class="mono" style="font-weight:600;">${nf(tot)}</td>
        </tr>`;
      const notesRow = noteText
        ? `<tr class="line-notes"><td colspan="${colCount}"><span class="nlbl">📝 ${L.lineNotesLbl}</span>${noteText}</td></tr>`
        : "";
      return itemRow + notesRow;
    }).join("");

    const isLast = chunkIdx === lineChunks.length - 1;
    // NO empty filler rows: rows flow naturally and the print engine fills
    // each page completely before breaking to the next. Filler rows used to
    // waste vertical space and shove the totals block onto a blank page.
    return `
      <table class="lines-chunk">
        ${linesHeadHtml}
        <tbody>${rowsHtml}</tbody>
      </table>
      ${!isLast ? `<div class="page-break"></div>` : ""}`;
  }).join("");

  return `${docHead}
  <body><div class="sheet">
    <table class="page-frame">
      <thead>
        <tr><td><div class="running-header">${headerHtml}</div></td></tr>
      </thead>
      <tfoot>
        <tr><td><div class="running-footer">${footerHtml}</div></td></tr>
      </tfoot>
      <tbody>
        <tr><td>
          ${anchorBottom ? `<div class="page-body">` : ""}
          <div class="lines-wrap">${chunkTablesHtml}</div>

          ${doc.notes ? `<div class="notes-box"><b>${L.notesLbl}</b> ${doc.notes}</div>` : ""}

          <!-- Flexible spacer: on a short (single-page) invoice it pushes the
               totals/QR cluster to the bottom of the page (the empty area the
               user flagged). Omitted for long/multi-page invoices so the lines
               table stays in plain block flow and paginates reliably. -->
          ${anchorBottom ? `<div class="bottom-spacer"></div>` : ""}

          <!-- Bottom : totals + QR (anchored to the page bottom) ──────── -->
          <div class="bottom">
            <div class="totals-card">
              <div class="__totalsRow"><span>${tl("الإجمالي قبل الخصم", "Subtotal")}</span><span class="mono">${nf(totals.subtotalPreDiscount)}</span></div>
              <div class="__totalsRow"><span>${tl("مبلغ الخصم", "Discount")}</span><span class="mono" style="color:#b91c1c;">${nf(totals.discountTotal)}</span></div>
              <div class="__totalsRow"><span>${tl("الصافي بدون الضريبة", "Net")}</span><span class="mono">${nf(totals.netPreVat)}</span></div>
              <div class="__totalsRow"><span>${tl("ضريبة القيمة المضافة", "VAT")}</span><span class="mono" style="color:#b45309;">${nf(totals.vatAmount)}</span></div>
              <div class="__totalsRow grand"><span>${tl("الصافي شامل الضريبة", "Total")}</span><span class="mono">${nf(totals.grandTotal)}</span></div>
              ${sarEqRowsHtml(totals, "__totalsRow", tl, nf)}
              ${(company?.printShowItemsSummary !== false) ? (isEn ? summaryFooterHtmlEn(totals) : summaryFooterHtml(totals)) : ""}
            </div>
            <div class="qr-col">
              <div class="qr-card">
                ${qrImgHtml(d, { size: 150 })}
                <div class="lbl">QR — ZATCA</div>
              </div>
              ${(() => {
                const bt = (company?.bankAccountText ?? "").toString().trim();
                if (!bt) return "";
                const esc = bt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                return `<div class="bank-box"><div class="bank-title">${tl("بيانات الحساب البنكي", "Bank Account Details")}</div><div class="bank-body">${esc}</div></div>`;
              })()}
            </div>
          </div>
          ${anchorBottom ? `</div>` : ""}
        </td></tr>
      </tbody>
    </table>
  </div></body></html>`;
}

const TEMPLATES = [
  { id: 14, name: "الأصلي",         desc: "نموذج مرتب بشعار وسط وبيانات شركة/عميل جانبية", color: "#b88a2a", fn: template14, thermal: false },
  { id: 1,  name: "كلاسيكي",       desc: "حدود وجداول تقليدية",      color: "#2563eb", fn: template1,  thermal: false },
  { id: 2,  name: "حديث",          desc: "تصميم نظيف بهيدر أخضر",   color: "#059669", fn: template2,  thermal: false },
  { id: 3,  name: "مؤسسي",         desc: "هيدر داكن احترافي",        color: "#1e3a5f", fn: template3,  thermal: false },
  { id: 4,  name: "ملوّن",         desc: "ألوان دافئة مع تدرج",      color: "#d97706", fn: template4,  thermal: false },
  { id: 5,  name: "ZATCA رسمي",    desc: "النموذج الحكومي مع QR",    color: "#1a6e3d", fn: template5,  thermal: false },
  { id: 8,  name: "نقي أنيق",      desc: "أبيض وأسود مع لمسة ذهبية", color: "#0f172a", fn: template8,  thermal: false },
  { id: 9,  name: "ذهبي فاخر",     desc: "خلفية داكنة ولمسات ذهبية", color: "#1c1917", fn: template9,  thermal: false },
  { id: 10, name: "بحري عميق",     desc: "تدرج أزرق مع موجة سفلية",  color: "#0e7490", fn: template10, thermal: false },
  { id: 11, name: "حيوي",          desc: "تدرجات بنفسجية ووردية",    color: "#a855f7", fn: template11, thermal: false },
  { id: 12, name: "تنفيذي",        desc: "شريط جانبي ببيانات الشركة", color: "#0f172a", fn: template12, thermal: false },
  { id: 13, name: "أنيق ذهبي",     desc: "أونكس وذهب فاخر مع QR وتفقيط", color: "#c9a35e", fn: template13, thermal: false },
  { id: 6,  name: "حراري كلاسيكي", desc: "إيصال 80mm أبيض/أسود",    color: "#111111", fn: template6,  thermal: true  },
  { id: 7,  name: "حراري عصري",    desc: "إيصال 80mm ملوّن",         color: "#0f766e", fn: template7,  thermal: true  },
];

interface Props {
  open: boolean;
  onClose: () => void;
  data: PrintData | null;
  /** Optional initial template selection.  When omitted, defaults to
   *  template 1 (classic A4) — historical behaviour.  Pass "thermal" to
   *  preselect template 7 so callers driven by the company-wide auto-print
   *  preference don't need to know about specific template ids. */
  defaultTemplate?: "a4" | "thermal";
  /** When true, immediately fires the print pipeline as soon as the
   *  modal opens.  Used by the post-save auto-print flow so the user
   *  doesn't have to click again.  The modal still renders so the user
   *  can re-print or pick a different template. */
  autoPrintOnOpen?: boolean;
}

export default function SalesPrintModal({ open, onClose, data, defaultTemplate, autoPrintOnOpen }: Props) {
  // ── Visibility filter ────────────────────────────────────────────────
  // Honour the per-company `printEnabledTemplates` (jsonb int[]) and
  // `printDefaultTemplate` (int) settings from the General Settings →
  // Print tab. NULL / empty array means "show all" (legacy behaviour).
  // If the configured default isn't visible (e.g. admin disabled it
  // after picking it), fall back to the first visible id.
  const companyCfg: any = (data as any)?.company ?? {};
  const visibleTemplates = useMemo(() => {
    const enabled = Array.isArray(companyCfg.printEnabledTemplates) && companyCfg.printEnabledTemplates.length > 0
      ? new Set<number>(companyCfg.printEnabledTemplates.map((n: any) => Number(n)))
      : null;
    const filtered = enabled ? TEMPLATES.filter(t => enabled.has(t.id)) : TEMPLATES;
    return filtered.length > 0 ? filtered : TEMPLATES; // never let the modal go empty
  }, [companyCfg.printEnabledTemplates]);

  function resolveInitialId(): number {
    // Caller's preference wins when it points at a visible template.
    if (defaultTemplate === "thermal") {
      const t = visibleTemplates.find(x => x.thermal);
      if (t) return t.id;
    }
    if (defaultTemplate === "a4") {
      const t = visibleTemplates.find(x => !x.thermal);
      if (t) return t.id;
    }
    // Otherwise use the company's configured default if it's visible.
    const cfgDefault = Number(companyCfg.printDefaultTemplate);
    if (Number.isInteger(cfgDefault) && visibleTemplates.some(t => t.id === cfgDefault)) {
      return cfgDefault;
    }
    return visibleTemplates[0]?.id ?? 1;
  }
  const [selected, setSelected] = useState<number>(resolveInitialId);
  const { toast } = useToast();
  const { user, token } = useAuth() as any;

  // ── Print language (template 14 «الأصلي» only, for now) ───────────────
  // Seed from the company default; the user can override per print job via
  // the toggle in the modal header. Re-syncs when the company default
  // changes underneath us.
  const [printLang, setPrintLang] = useState<PrintLang>(
    () => (companyCfg.invoicePrintLanguage === "en" ? "en" : "ar"),
  );
  useEffect(() => {
    setPrintLang(companyCfg.invoicePrintLanguage === "en" ? "en" : "ar");
  }, [companyCfg.invoicePrintLanguage]);

  // Live inventory catalogue → English item-name lookup. Only fetched when
  // we're actually printing in English (and the modal is open).
  const itemsCompanyId = companyCfg?.id ?? user?.company?.id;
  const enItemsQuery = useQuery({
    queryKey: ["print-en-items", itemsCompanyId],
    enabled: !!open && printLang === "en" && !!itemsCompanyId,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch(`${API}/api/inventory/items?companyId=${itemsCompanyId}&includeHidden=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return [] as any[];
      const j = await r.json();
      return Array.isArray(j) ? j : (j.items ?? j.data ?? []);
    },
  });
  const enNamesMap = useMemo(() => buildEnNamesMap(enItemsQuery.data ?? []), [enItemsQuery.data]);
  // Live units catalogue → English unit-name lookup (same EN-only gating).
  const enUnitsQuery = useQuery({
    queryKey: ["print-en-units", itemsCompanyId],
    enabled: !!open && printLang === "en" && !!itemsCompanyId && !!token,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch(`${API}/api/inventory/units?companyId=${itemsCompanyId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return [] as any[];
      const j = await r.json();
      return Array.isArray(j) ? j : (j.items ?? j.data ?? []);
    },
  });
  const enUnitsMap = useMemo(() => buildEnUnitsMap(enUnitsQuery.data ?? []), [enUnitsQuery.data]);
  // Live chart-of-accounts → resolve the customer's linked GL account id to
  // its real account CODE (e.g. 1103010004) for the "كود الحساب" field. Without
  // this the template falls back to a synthetic "A-<accountId>" placeholder
  // that is NOT the account's actual code in شجرة الحسابات.
  const accountsQuery = useQuery({
    queryKey: ["print-accounts", itemsCompanyId],
    enabled: !!open && !!itemsCompanyId && !!token,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch(`${API}/api/accounts?companyId=${itemsCompanyId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return [] as any[];
      const j = await r.json();
      return Array.isArray(j) ? j : (j.accounts ?? j.items ?? j.data ?? []);
    },
  });
  const accountCodeMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of (accountsQuery.data ?? [])) {
      if (a?.id != null && a?.code != null) m.set(Number(a.id), String(a.code));
    }
    return m;
  }, [accountsQuery.data]);
  // Re-sync the selected template when the caller's preference or the
  // company's visibility config changes.
  useEffect(() => { setSelected(resolveInitialId()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [defaultTemplate, companyCfg.printEnabledTemplates, companyCfg.printDefaultTemplate]);
  // Fire-and-forget auto-print on open. We track the last id we auto-
  // printed so we don't loop on re-renders, and reset when the modal
  // closes so the next "open" can auto-print again.
  const printedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !autoPrintOnOpen || !data) { printedKeyRef.current = null; return; }
    const key = `${(data as any)?.doc?.id ?? ""}-${defaultTemplate ?? "a4"}`;
    if (printedKeyRef.current === key) return;
    printedKeyRef.current = key;
    // Defer to the next tick so the dialog has a chance to mount before
    // we open the popup — some browsers throttle popups opened during
    // the same task as a state update.
    const t = setTimeout(() => { handlePrint(); }, 100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoPrintOnOpen, data, defaultTemplate]);

  // Intercept Ctrl+P / Cmd+P while the modal is open so the user gets the
  // selected template's print preview (a clean, properly-styled invoice
  // rendered in a hidden iframe) instead of the browser's default page
  // print, which would capture the modal UI itself and the surrounding
  // page chrome. Mirrors the click on the "Print" button.
  useEffect(() => {
    if (!open || !data) return;
    const onKey = (e: KeyboardEvent) => {
      const isPrintCombo = (e.ctrlKey || e.metaKey) && (e.key === "p" || e.key === "P");
      if (!isPrintCombo) return;
      e.preventDefault();
      e.stopPropagation();
      // Run on the next tick so the keydown's default-prevention has
      // settled before we open the iframe + call win.print().
      setTimeout(() => { handlePrint(); }, 0);
    };
    // Capture phase so we win against any nested listeners (e.g. CodeMirror
    // editors or the print designer canvas) that might also intercept Ctrl+P.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true } as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, data, selected]);

  async function handlePrint() {
    if (!data) return;
    // No "preferred printer" gate: the browser's system print dialog
    // is the real selector and lets the user pick any installed
    // printer (or "Save as PDF"). Gating on the localStorage hint
    // silently blocked Chrome users who never saved a printer name in
    // General Settings, which is what the user reported.
    const tmpl = TEMPLATES.find(t => t.id === selected);
    if (!tmpl) return;
    // Pre-compute the real ZATCA TLV QR (base64-encoded) so every
    // template can render it as a normal <img> — async so the QR png
    // is ready before the iframe document is built (otherwise the
    // print job would capture a placeholder).
    // Stamp the print TYPE onto the doc so the shared totals helpers can gate
    // the SAR-equivalent block to tax documents (invoice/return) only — every
    // template reads `doc` (directly or via {...doc}) so this reaches them all.
    (data.doc as any).__printType = data.type;
    try {
      const totals = computeFullTotals(data.doc, data.lines);
      const qr = await buildZatcaQrDataUrl(data.company, data.doc, totals);
      (data as any)._qrDataUrl = qr;
    } catch { /* fallback to placeholder inside qrImgHtml */ }
    // Inject the chosen print language + live English item-name map so the
    // (currently template-14-only) i18n builder can render in English.
    // The English name lookup is async (useQuery); if the user prints before
    // it has resolved (e.g. auto-print on open with EN default), await a
    // fetch here so the first print already has English item names instead
    // of silently falling back to Arabic.
    (data as any)._lang = printLang;
    let namesForPrint = enNamesMap;
    let unitsForPrint = enUnitsMap;
    if (printLang === "en" && itemsCompanyId && namesForPrint.size === 0) {
      try {
        const res = await enItemsQuery.refetch();
        namesForPrint = buildEnNamesMap((res.data as any[]) ?? []);
      } catch { /* fall back to Arabic names inside the template */ }
    }
    if (printLang === "en" && itemsCompanyId && enUnitsQuery.data == null) {
      try {
        const res = await enUnitsQuery.refetch();
        unitsForPrint = buildEnUnitsMap((res.data as any[]) ?? []);
      } catch { /* fall back to the static ZATCA dictionary / Arabic */ }
    }
    (data as any)._enNames = namesForPrint;
    (data as any)._enUnits = unitsForPrint;
    // Resolve the customer's linked GL account id → real chart-of-accounts
    // code (e.g. 1103010004) so the printed "كود الحساب" matches شجرة الحسابات
    // instead of the synthetic "A-<id>" fallback. Refetch if the accounts
    // query hasn't resolved yet (e.g. auto-print on open).
    if (data.customer?.accountId != null) {
      let map = accountCodeMap;
      if (map.size === 0 && itemsCompanyId) {
        try {
          const res = await accountsQuery.refetch();
          const m = new Map<number, string>();
          for (const a of ((res.data as any[]) ?? [])) {
            if (a?.id != null && a?.code != null) m.set(Number(a.id), String(a.code));
          }
          map = m;
        } catch { /* fall back to the template's A-<id> placeholder */ }
      }
      const resolved = map.get(Number(data.customer.accountId));
      if (resolved) (data.customer as any).accountCode = resolved;
    }
    const html = tmpl.fn(data);
    // Use a hidden same-origin iframe instead of `window.open` so popup
    // blockers don't kill auto-print after save (no user-gesture path)
    // and so the print preview always shows up — even when the print
    // call is fired from a setTimeout / async flow.
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    iframe.srcdoc = html;
    iframe.onload = () => {
      try {
        const win = iframe.contentWindow;
        if (!win) {
          toast({ title: "تعذَّر فتح معاينة الطباعة", variant: "destructive" });
          return;
        }
        win.focus();
        win.print();
      } catch (err: any) {
        toast({
          title: "تعذَّر بدء الطباعة",
          description: err?.message ?? String(err),
          variant: "destructive",
        });
      } finally {
        // Give the browser time to capture the print job before we
        // tear the iframe down. Without this, some engines abort the
        // queued print dialog when the document is removed.
        setTimeout(() => { try { iframe.remove(); } catch { /* noop */ } }, 2000);
      }
    };
    document.body.appendChild(iframe);
  }

  if (!data) return null;

  const typeLabelAr =
    data.type === "invoice" ? "فاتورة المبيعات"
    : data.type === "return" ? "مرتجع المبيعات"
    : "عرض السعر";

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Printer className="h-5 w-5 text-primary" />
            اختر نموذج الطباعة — {typeLabelAr}
          </DialogTitle>
        </DialogHeader>

        {selected === 14 && (
          <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2 mt-2">
            <span className="text-xs text-muted-foreground">
              لغة الطباعة <span className="opacity-70">(نموذج «الأصلي»)</span>
            </span>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant={printLang === "ar" ? "default" : "outline"}
                onClick={() => setPrintLang("ar")}
              >
                عربي
              </Button>
              <Button
                type="button"
                size="sm"
                variant={printLang === "en" ? "default" : "outline"}
                onClick={() => setPrintLang("en")}
              >
                English
              </Button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 md:grid-cols-6 gap-3 my-4 max-h-[55vh] overflow-y-auto pr-1">
          {visibleTemplates.map(t => (
            <button
              key={t.id}
              onClick={() => setSelected(t.id)}
              className={cn(
                "rounded-xl border-2 p-3 text-center transition-all hover:shadow-md relative",
                selected === t.id
                  ? "shadow-lg scale-105"
                  : "border-border hover:border-muted-foreground"
              )}
              style={selected === t.id ? { borderColor: t.color } : {}}
            >
              {t.thermal && (
                <span
                  className="absolute -top-2 -left-2 rounded-full text-[9px] font-bold px-2 py-0.5 text-white shadow"
                  style={{ background: t.color }}
                >
                  80mm
                </span>
              )}
              {t.thermal ? (
                <div
                  className="w-[60%] mx-auto aspect-[2/5] rounded-sm mb-2 flex flex-col overflow-hidden"
                  style={{ background: "#fff", border: `1.5px solid ${t.color}` }}
                >
                  <div className="h-4 w-full flex-shrink-0" style={{ background: t.color }} />
                  <div className="flex-1 p-1 space-y-1 flex flex-col">
                    {[80, 50, 70].map((w, i) => (
                      <div key={`a${i}`} className="rounded-sm h-1 mx-auto" style={{ width: `${w}%`, background: i === 0 ? t.color : "#999", opacity: i === 0 ? .8 : .5 }} />
                    ))}
                    <div className="h-px w-full my-0.5" style={{ background: t.color, opacity: .4 }} />
                    {[90, 70, 90, 60, 90].map((w, i) => (
                      <div key={`b${i}`} className="rounded-sm h-0.5" style={{ width: `${w}%`, background: "#bbb" }} />
                    ))}
                    <div className="h-px w-full my-0.5" style={{ background: t.color, opacity: .4 }} />
                    <div className="rounded-sm h-1.5 w-[80%] mx-auto" style={{ background: t.color }} />
                  </div>
                </div>
              ) : (
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
              )}
              <p className="text-xs font-bold" style={selected === t.id ? { color: t.color } : {}}>{t.name}</p>
              <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">{t.desc}</p>
            </button>
          ))}
        </div>

        <div className="rounded-lg bg-muted/40 border px-4 py-3 text-sm space-y-1">
          <div className="flex gap-6">
            <span className="text-muted-foreground">العميل:</span>
            <span className="font-medium">{data.customer?.nameAr ?? data.customer?.nameEn ?? "—"}</span>
            <span className="text-muted-foreground">الوثيقة:</span>
            <span className="font-mono font-medium">
              {data.doc.docNumber ?? `${docPrefix(data.type)}-${data.doc.id}`}
            </span>
          </div>
          <div className="flex gap-6">
            <span className="text-muted-foreground">الإجمالي:</span>
            <span className="font-bold text-primary">
              {Number(data.doc.totalAmount || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {data.doc.currencyCode ?? "SAR"}
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
