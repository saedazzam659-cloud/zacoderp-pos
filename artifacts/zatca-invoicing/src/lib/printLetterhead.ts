// ─── Shared company letterhead for print/PDF surfaces ────────────────────────
//
// One reusable letterhead block (logo + Arabic/English name + س.ت + الرقم
// الضريبي + جوال + العنوان) used by: journal-entry print templates, custody
// (سند عهدة) + loan (سند سلفة) vouchers, receipt/payment vouchers, and the
// shared bulk-print templates.
//
// IMPORTANT: the account-statement exports in `export.ts` (كشف حساب عميل /
// مورد / الشركات الشقيقة) intentionally do NOT use this module — those
// templates must stay byte-identical per user requirement. This module only
// COPIES their visual model (compact white header + brand-color accent).
//
// Repeating on every printed page: `wrapWithLetterhead` puts the letterhead
// inside the <thead> of a single-cell layout table (`table.lh-shell`).
// Browsers natively repeat <thead> at the top of every printed page, so the
// letterhead appears fixed at the top of EVERY page in window.print() /
// "Save as PDF" without position:fixed hacks (which overlap content).
//
// For the html2canvas→jsPDF raster paths (custody/loan "تنزيل PDF"), use
// `addCanvasToPdfWithRepeatingHeader` — it slices the tall canvas into A4
// pages and re-stamps the letterhead band at the top of pages 2+.
import { safeLogoSrc } from "@/lib/export";

export interface LetterheadCompany {
  nameAr?: string | null;
  nameEn?: string | null;
  logo?: string | null;
  /** Secondary brand-mark image (علامة تجارية) — split layout only. */
  brandLogo?: string | null;
  crNumber?: string | null;
  vatNumber?: string | null;
  phone?: string | null;
  buildingNumber?: string | null;
  street?: string | null;
  district?: string | null;
  city?: string | null;
  postalCode?: string | null;
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/** "س.ت: … | الرقم الضريبي: … | جوال: …" — only the parts that exist. */
export function letterheadMetaLine(c?: LetterheadCompany | null): string {
  if (!c) return "";
  return [
    c.crNumber ? `س.ت: ${esc(c.crNumber)}` : "",
    c.vatNumber ? `الرقم الضريبي: ${esc(c.vatNumber)}` : "",
    c.phone ? `جوال: ${esc(c.phone)}` : "",
  ]
    .filter(Boolean)
    .join("&nbsp;&nbsp;|&nbsp;&nbsp;");
}

/** Single-line address from the granular ZATCA address parts. */
export function letterheadAddressLine(c?: LetterheadCompany | null): string {
  if (!c) return "";
  return [c.buildingNumber, c.street, c.district, c.city, c.postalCode]
    .filter(Boolean)
    .join(" - ");
}

export type LetterheadAccent = "green" | "navy";
export type LetterheadSize = "lg" | "md";

export interface LetterheadOptions {
  /** Brand accent: green (#166534 — سندات) or navy (#1e3a8a — قيود/وثائق). */
  accent?: LetterheadAccent;
  /** lg = prominent voucher header, md = compact document header. */
  size?: LetterheadSize;
  /** Extra pre-escaped HTML meta line(s), e.g. "تاريخ الطباعة: …". */
  extraMetaHtml?: string;
  /**
   * "center" (default) = the classic centered letterhead used everywhere.
   * "split" = journal-entry layout: company block (logo + names + meta) sits
   * at the START side, the brand-mark image (company.brandLogo) at the END
   * side, and the main logo is rendered bigger (2× width / 1.5× height).
   * Opt-in only — existing voucher/bulk templates keep "center".
   */
  layout?: "center" | "split";
}

const ACCENTS: Record<LetterheadAccent, { border: string; name: string }> = {
  green: { border: "#166534", name: "#14532d" },
  navy: { border: "#1e3a8a", name: "#1e3a8a" },
};

/** The letterhead block itself (`<div class="co-letterhead">…</div>`). */
export function buildLetterheadHtml(
  company?: LetterheadCompany | null,
  opts?: LetterheadOptions,
): string {
  const c = company ?? {};
  const safeLogo = safeLogoSrc(c.logo);
  const nameAr = c.nameAr || c.nameEn || "";
  const showEn = !!(c.nameEn && c.nameEn !== c.nameAr && c.nameAr);
  const meta = letterheadMetaLine(c);
  const addr = letterheadAddressLine(c);
  const companyBlock = `
  ${safeLogo ? `<img class="lh-logo" src="${safeLogo}" alt="" />` : ""}
  ${nameAr ? `<div class="lh-name-ar">${esc(nameAr)}</div>` : ""}
  ${showEn ? `<div class="lh-name-en">${esc(c.nameEn)}</div>` : ""}
  ${meta ? `<div class="lh-meta">${meta}</div>` : ""}
  ${addr ? `<div class="lh-meta">${esc(addr)}</div>` : ""}
  ${opts?.extraMetaHtml ? `<div class="lh-meta">${opts.extraMetaHtml}</div>` : ""}`;

  if (opts?.layout === "split") {
    const safeBrand = safeLogoSrc(c.brandLogo);
    return `<div class="co-letterhead lh-split">
  <div class="lh-co">${companyBlock}
  </div>
  <div class="lh-brand">${safeBrand ? `<img class="lh-brand-img" src="${safeBrand}" alt="" />` : ""}</div>
</div>`;
  }

  return `<div class="co-letterhead">${companyBlock}
</div>`;
}

/** CSS for `.co-letterhead` + the `table.lh-shell` repeat mechanism.
 *  The shell-cell overrides are `!important` so page-global `tbody td`
 *  border/padding rules in each template never leak into the shell. */
export function letterheadCss(opts?: LetterheadOptions): string {
  const a = ACCENTS[opts?.accent ?? "green"];
  const lg = (opts?.size ?? "md") === "lg";
  return `
.co-letterhead { text-align:center; background:#fff; padding:2px 0 ${lg ? 10 : 6}px; border-bottom:${lg ? "3px" : "2.5px"} solid ${a.border}; margin-bottom:${lg ? 12 : 8}px; }
.co-letterhead .lh-logo { max-height:${lg ? 64 : 44}px; max-width:${lg ? 170 : 150}px; object-fit:contain; display:block; margin:0 auto ${lg ? 4 : 3}px; }
.co-letterhead .lh-name-ar { font-size:${lg ? 20 : 15}px; font-weight:800; color:${a.name}; line-height:1.25; }
.co-letterhead .lh-name-en { font-size:${lg ? 11 : 10}px; font-weight:500; color:#6b7280; }
.co-letterhead .lh-meta { font-size:${lg ? 11 : 10.5}px; color:#475569; margin-top:1px; }
/* ── Split layout (journal-entry print) ─────────────────────────────────
   Company block at the START side (right in RTL), brand mark at the END
   side. The main logo doubles its width and grows 50% in height vs the
   centered "md" letterhead (44×150 → 66×300). */
.co-letterhead.lh-split { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; text-align:start; }
.co-letterhead.lh-split .lh-co { text-align:start; }
.co-letterhead.lh-split .lh-logo { margin:0 0 ${lg ? 4 : 3}px; max-height:${lg ? 96 : 66}px; max-width:${lg ? 340 : 300}px; }
.co-letterhead.lh-split .lh-brand { flex-shrink:0; display:flex; align-items:center; }
.co-letterhead.lh-split .lh-brand-img { max-height:${lg ? 96 : 66}px; max-width:${lg ? 340 : 300}px; object-fit:contain; }
table.lh-shell { width:100%; border-collapse:collapse; }
table.lh-shell > thead { display:table-header-group; }
table.lh-shell > thead > tr > td, table.lh-shell > tbody > tr > td { padding:0 !important; border:none !important; background:#fff !important; }
`;
}

/** Wrap `contentHtml` in the repeating-letterhead table shell. Anything in
 *  `headHtml` (letterhead + optional title strip) repeats on EVERY printed
 *  page; `contentHtml` flows across pages normally. */
export function wrapWithLetterhead(headHtml: string, contentHtml: string): string {
  return `<table class="lh-shell"><thead><tr><td>${headHtml}</td></tr></thead><tbody><tr><td>${contentHtml}</td></tr></tbody></table>`;
}

/** For html2canvas→jsPDF paths: slice a tall page-wide canvas into A4 pages,
 *  re-stamping the top `headerPx` band (the letterhead) on pages 2+ so the
 *  letterhead is fixed at the top of every PDF page. `headerPx` is in canvas
 *  pixels (element CSS px × html2canvas scale). Single-page canvases are
 *  added as-is. */
export function addCanvasToPdfWithRepeatingHeader(
  pdf: {
    addImage: (...args: any[]) => unknown;
    addPage: (...args: any[]) => unknown;
    internal: { pageSize: { getWidth: () => number; getHeight: () => number } };
  },
  canvas: HTMLCanvasElement,
  headerPx: number,
): void {
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const pxPerMm = canvas.width / pageW;
  const pageHpx = pageH * pxPerMm;

  if (canvas.height <= pageHpx) {
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, pageW, canvas.height / pxPerMm);
    return;
  }

  // Cap the repeated band so a pathological measurement can never eat the page.
  const bandPx = Math.max(0, Math.min(Math.floor(headerPx), Math.floor(pageHpx * 0.3)));

  const crop = (sy: number, sh: number): string => {
    const c = document.createElement("canvas");
    c.width = canvas.width;
    c.height = Math.max(1, Math.round(sh));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(canvas, 0, Math.round(sy), canvas.width, c.height, 0, 0, canvas.width, c.height);
    return c.toDataURL("image/jpeg", 0.95);
  };

  const headerData = bandPx > 0 ? crop(0, bandPx) : null;
  const headerMm = bandPx / pxPerMm;

  let sy = 0;
  let first = true;
  while (sy < canvas.height - 1) {
    if (!first) pdf.addPage();
    let yMm = 0;
    if (!first && headerData) {
      pdf.addImage(headerData, "JPEG", 0, 0, pageW, headerMm);
      yMm = headerMm;
    }
    const availPx = (pageH - yMm) * pxPerMm;
    const sh = Math.min(availPx, canvas.height - sy);
    if (sh <= 0) break;
    pdf.addImage(crop(sy, sh), "JPEG", 0, yMm, pageW, sh / pxPerMm);
    sy += sh;
    first = false;
  }
}
