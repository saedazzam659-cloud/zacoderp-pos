import * as XLSX from "xlsx";

export interface ExportColumn {
  header: string;
  key: string;
  width?: number;
}

// ─── Excel Export ─────────────────────────────────────────────────────────────

export function exportToExcel(
  rows: Record<string, unknown>[],
  columns: ExportColumn[],
  filename: string,
  sheetName = "Sheet1",
  // Optional grand-totals row appended at the bottom of the sheet. Keys
  // map to the same column.key as data rows; missing keys render blank.
  // We deliberately do NOT compute sums automatically — the caller knows
  // which columns make sense to total (currency, qty…) versus columns
  // that don't (status, payment type…). For the label cell, set the
  // totalsRow value of the first applicable column to e.g. "الإجمالي".
  totalsRow?: Record<string, unknown> | null,
) {
  const headers = columns.map(c => c.header);
  const data    = rows.map(row =>
    columns.map(c => {
      const val = row[c.key];
      return val === null || val === undefined ? "" : String(val);
    })
  );

  const aoa: (string)[][] = [headers, ...data];
  if (totalsRow) {
    aoa.push(columns.map(c => {
      const val = totalsRow[c.key];
      return val === null || val === undefined ? "" : String(val);
    }));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  const colWidths = columns.map((c, i) => ({
    wch: c.width ?? Math.max(
      c.header.length + 2,
      ...data.map(row => String(row[i] ?? "").length + 2),
      totalsRow ? String(totalsRow[c.key] ?? "").length + 2 : 0,
    ),
  }));
  ws["!cols"] = colWidths;

  // Bold the totals row so it stands out in Excel. We can't add styling
  // to plain `aoa_to_sheet` cells without `xlsx-style`, but writing the
  // cell with the `s` style hint is a no-op when xlsx ignores it — the
  // safer path is to just leave the value bold-aware and let users see
  // it's clearly a separate row by content.
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

// ─── Safe Logo Source ────────────────────────────────────────────────────────
// All print surfaces stitch their HTML by string interpolation into
// `document.write()`, so any company-supplied `logo` value reaches the
// browser as raw HTML.  To eliminate the resulting stored-XSS risk we
// run every logo through a strict allowlist before insertion: only
// well-formed `data:image/<png|jpeg|jpg|gif|webp|svg+xml>;base64,...`
// URIs and absolute `https?://` URLs are accepted, and the chars that
// could break out of an `src="..."` attribute (`"`, `'`, `<`, `>`, `&`,
// whitespace, control chars) are rejected outright.  Anything that
// fails validation is dropped (returns `null`), which the callers
// render as "no logo" — graceful degradation, no exception.
export function safeLogoSrc(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Reject anything containing characters that could break out of the
  // `src="..."` attribute or smuggle a JS scheme via crafted whitespace.
  // Allowed within data:/http(s): URIs are unreserved + sub-delims +
  // base64 chars + a few path/query separators.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F"'<>`\s]/.test(s)) return null;
  const dataRe = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
  const httpRe = /^https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+$/;
  if (dataRe.test(s) || httpRe.test(s)) return s;
  return null;
}

// ─── PDF Export (HTML Print) ──────────────────────────────────────────────────
// Uses the browser's native print-to-PDF which fully supports Arabic/RTL text.

export function exportToPDF(
  rows: Record<string, unknown>[],
  columns: ExportColumn[],
  filename: string,
  title: string,
  subtitle?: string,
  autoPrint: boolean = true,
  // Optional grand-totals row rendered as a bold <tfoot> tr beneath the
  // table body. Same shape as data rows (keys map to column.key).
  totalsRow?: Record<string, unknown> | null,
  // Optional summary footer rendered as a row of label/value cards
  // beneath the table — used by reports like Customer Statement to
  // surface "previous balance / movement / closing balance" classic
  // Arabic accounting summaries that don't fit a single table row.
  summaryFooter?: Array<{ label: string; value: string; tone?: "default" | "debit" | "credit" | "primary" }> | null,
  // Optional company logo (base64 data URL or absolute http(s) URL) shown
  // centered above the title in the green header of the printed page.
  logo?: string | null,
) {
  const escape = (s: unknown) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  // Logo HTML — wrapped in a white rounded card so it renders cleanly on
  // top of the dark-green header background regardless of the source image
  // having transparency or its own padding.  Falls back to an empty string
  // when the company has no logo configured.  The src is run through
  // `safeLogoSrc` to defang attribute-injection / XSS via crafted values.
  const safeLogo = safeLogoSrc(logo);
  const logoHtml = safeLogo
    ? `<div style="background:#fff;border-radius:8px;padding:5px 8px;display:inline-block;margin-bottom:8px;">
         <img src="${safeLogo}" alt="" style="max-height:54px;max-width:170px;object-fit:contain;display:block;" />
       </div>`
    : "";

  const theadCells = columns
    .map(c => `<th>${escape(c.header)}</th>`)
    .join("");

  const tbodyRows = rows
    .map(
      (row, i) =>
        `<tr class="${i % 2 === 0 ? "even" : "odd"}">${columns
          .map(c => `<td>${escape(row[c.key])}</td>`)
          .join("")}</tr>`,
    )
    .join("");

  // Totals row is rendered as the LAST row of <tbody> instead of inside
  // <tfoot>. Browsers repeat <tfoot> on every printed page by default,
  // which would put "الإجمالي" on every page — but for multi-page
  // statements the totals must only appear at the very end (after all
  // data). A trailing <tbody> row naturally flows to the last page
  // where the data ends, satisfying that requirement.
  const totalsTbodyRow = totalsRow
    ? `<tr class="totals">${columns
        .map(c => `<td>${escape(totalsRow[c.key])}</td>`)
        .join("")}</tr>`
    : "";

  const today = new Date().toLocaleDateString("ar-SA-u-nu-latn", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8"/>
  <title>${escape(filename)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Tajawal', 'Segoe UI', Tahoma, Arial, sans-serif;
      direction: rtl;
      font-size: 11pt;
      color: #1a1a1a;
      background: #fff;
    }
    .header {
      background: #166534;
      color: #fff;
      padding: 18px 24px 14px;
      text-align: center;
      margin-bottom: 0;
    }
    .header h1 { font-size: 17pt; font-weight: 700; margin-bottom: 4px; }
    .header p  { font-size: 10pt; opacity: .85; }
    .meta {
      background: #f0fdf4;
      border-bottom: 1px solid #bbf7d0;
      padding: 8px 24px;
      font-size: 9pt;
      color: #15803d;
      text-align: center;
    }
    .content { padding: 18px 20px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 9.5pt;
    }
    thead tr { background: #166534; color: #fff; }
    thead th {
      padding: 9px 8px;
      text-align: center;
      font-weight: 600;
      border: 1px solid #14532d;
      white-space: nowrap;
    }
    tbody td {
      padding: 7px 8px;
      border: 1px solid #e2e8f0;
      text-align: center;
      vertical-align: middle;
    }
    tr.even { background: #f8fafb; }
    tr.odd  { background: #ffffff; }
    tbody tr:hover { background: #f0fdf4; }
    /* Grand-totals row sits inside <tbody> so it doesn't repeat per
       printed page (which is what a <tfoot> would do). It's pinned to
       the bottom of the data via document order, so it always appears
       on the LAST printed page. */
    tbody tr.totals {
      background: #dcfce7;
      font-weight: 700;
      color: #14532d;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    tbody tr.totals td {
      border-top: 2px solid #166534;
      padding: 9px 8px;
      font-size: 10pt;
    }
    .footer {
      margin-top: 14px;
      font-size: 8pt;
      color: #94a3b8;
      text-align: center;
      border-top: 1px solid #e2e8f0;
      padding-top: 8px;
    }
    .empty { text-align: center; padding: 30px; color: #94a3b8; font-size: 11pt; }
    .summary-footer {
      margin-top: 14px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: stretch;
    }
    .summary-card {
      flex: 1 1 0;
      min-width: 140px;
      border: 1.5px solid #cbd5e1;
      border-radius: 6px;
      padding: 10px 14px;
      text-align: center;
      background: #f8fafc;
    }
    .summary-card .label {
      font-size: 9pt;
      color: #64748b;
      margin-bottom: 4px;
      font-weight: 500;
    }
    .summary-card .value {
      font-size: 13pt;
      font-weight: 700;
      color: #0f172a;
      direction: ltr;
      unicode-bidi: embed;
    }
    .summary-card.debit   { background: #eff6ff; border-color: #bfdbfe; }
    .summary-card.debit   .value { color: #1d4ed8; }
    .summary-card.credit  { background: #ecfdf5; border-color: #a7f3d0; }
    .summary-card.credit  .value { color: #047857; }
    .summary-card.primary { background: #f0fdf4; border-color: #86efac; }
    .summary-card.primary .value { color: #14532d; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      thead tr { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      tbody tr.totals { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      /* Repeat the column headers on every printed page so multi-page
         tables stay readable without scrolling back to page 1. */
      thead { display: table-header-group; }
    }
    /* Page numbering ("صفحة X من Y") via CSS Paged Media. Modern Chrome,
       Firefox and Safari all render @page margin boxes in print, so the
       footer renders on every printed page. Browsers without support
       silently degrade — the user can still enable the browser's
       built-in "Headers and footers" toggle in print preview. The
       generous bottom margin (22mm) reserves room for the page number
       so it never overlaps the table. */
    @page {
      margin: 15mm 15mm 22mm 15mm;
      size: A4 landscape;
      @bottom-center {
        content: "صفحة " counter(page) " من " counter(pages);
        font-family: 'Tajawal', 'Segoe UI', Tahoma, Arial, sans-serif;
        font-size: 9pt;
        color: #475569;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    ${logoHtml}
    <h1>${escape(title)}</h1>
    ${subtitle ? `<p>${escape(subtitle)}</p>` : ""}
  </div>
  <div class="meta">
    تاريخ الطباعة: ${today} &nbsp;|&nbsp; عدد السجلات: ${rows.length}
  </div>
  <div class="content">
    <table>
      <thead><tr>${theadCells}</tr></thead>
      <tbody>
        ${tbodyRows || `<tr><td colspan="${columns.length}" class="empty">لا توجد بيانات للتصدير</td></tr>`}
        ${totalsTbodyRow}
      </tbody>
    </table>
    ${summaryFooter && summaryFooter.length > 0
      ? `<div class="summary-footer">${summaryFooter
          .map(c => `<div class="summary-card ${c.tone ?? "default"}"><div class="label">${escape(c.label)}</div><div class="value">${escape(c.value)}</div></div>`)
          .join("")}</div>`
      : ""}
    <div class="footer">
      نظام الفاتورة الإلكترونية السعودية &nbsp;|&nbsp; ${escape(filename)} &nbsp;|&nbsp; ${today}
    </div>
  </div>
  <script>
    ${autoPrint ? `window.onload = function() { setTimeout(function() { window.print(); }, 600); };` : ""}
  </script>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, "_blank");
  if (win) {
    win.addEventListener("afterprint", () => {
      URL.revokeObjectURL(url);
    });
  }
}

// ─── Chart of Accounts External Print (Tree Style) ───────────────────────────
// A specialized "external print" for the Chart of Accounts that renders a
// rich, color-coded hierarchical tree instead of the generic table view.
// Designed to look noticeably better than the standard sales/purchase
// invoice prints — uses gradient header, summary cards per account type,
// indented tree nodes with connectors, and per-type color borders.

export interface CoaPrintAccount {
  id: number;
  parentId: number | null;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  accountType: string;
  level: number;
  isPosting: boolean;
  isActive: boolean;
  balance: string; // pre-formatted by caller
}

export interface CoaPrintTypeMeta {
  value: string;
  label: string;
  color: string;     // primary color for borders/text
  bg: string;        // background tint for the type chip
}

export function printChartOfAccountsExternal(opts: {
  accounts: CoaPrintAccount[];
  types: CoaPrintTypeMeta[];
  title: string;
  subtitle?: string;
  companyName?: string | null;
  logo?: string | null;
  autoPrint?: boolean;
}) {
  const { accounts, types, title, subtitle, companyName, logo, autoPrint = false } = opts;

  const escape = (s: unknown) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const safeLogo = safeLogoSrc(logo);
  const logoHtml = safeLogo
    ? `<div class="logo-card"><img src="${safeLogo}" alt="" /></div>`
    : "";

  const today = new Date().toLocaleDateString("ar-SA-u-nu-latn", {
    year: "numeric", month: "long", day: "numeric",
  });

  // ── Build hierarchy
  const childrenIdx = new Map<number | null, CoaPrintAccount[]>();
  for (const a of accounts) {
    const k = a.parentId ?? null;
    const arr = childrenIdx.get(k) || [];
    arr.push(a);
    childrenIdx.set(k, arr);
  }
  for (const [, arr] of childrenIdx) {
    arr.sort((a, b) => a.code.localeCompare(b.code, "ar"));
  }

  const typeMap = new Map(types.map(t => [t.value, t]));

  function renderNode(a: CoaPrintAccount, depth: number): string {
    const meta = typeMap.get(a.accountType);
    const color = meta?.color ?? "#64748b";
    const bg = meta?.bg ?? "#f1f5f9";
    const kids = childrenIdx.get(a.id) || [];
    const indent = depth * 22;
    const typeChip = meta
      ? `<span class="type-chip" style="background:${bg};color:${color};border-color:${color}40;">${escape(meta.label)}</span>`
      : "";
    const postingBadge = a.isPosting
      ? `<span class="badge badge-posting">ترحيل</span>`
      : `<span class="badge badge-summary">إجمالي</span>`;
    const activeDot = a.isActive
      ? `<span class="dot dot-active" title="نشط"></span>`
      : `<span class="dot dot-inactive" title="غير نشط"></span>`;

    return `
      <div class="node" style="margin-right:${indent}px;border-right:3px solid ${color};">
        <div class="node-row">
          <div class="node-left">
            ${activeDot}
            <span class="code">${escape(a.code)}</span>
            <span class="name">${escape(a.nameAr)}</span>
            ${a.nameEn ? `<span class="name-en">${escape(a.nameEn)}</span>` : ""}
          </div>
          <div class="node-right">
            ${typeChip}
            ${postingBadge}
            <span class="balance">${escape(a.balance)}</span>
          </div>
        </div>
        ${kids.map(c => renderNode(c, depth + 1)).join("")}
      </div>`;
  }

  const roots = childrenIdx.get(null) || [];
  // Accounts whose parent isn't in the visible set (e.g. when filtered) — surface as roots too.
  const visibleIds = new Set(accounts.map(a => a.id));
  const orphans = accounts.filter(a => a.parentId != null && !visibleIds.has(a.parentId));
  const treeHtml = [...roots, ...orphans].map(r => renderNode(r, 0)).join("");

  // ── Summary cards (one per account type)
  const summaryCards = types.map(tp => {
    const cnt = accounts.filter(a => a.accountType === tp.value).length;
    return `
      <div class="summary-card" style="border-color:${tp.color};background:${tp.bg};">
        <div class="summary-label" style="color:${tp.color};">${escape(tp.label)}</div>
        <div class="summary-value" style="color:${tp.color};">${cnt}</div>
      </div>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8"/>
  <title>${escape(title)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;600;700;800&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Tajawal', 'Segoe UI', Tahoma, Arial, sans-serif;
      direction: rtl;
      font-size: 11pt;
      color: #0f172a;
      background: #f8fafc;
    }
    .header {
      background: linear-gradient(135deg, #064e3b 0%, #166534 50%, #15803d 100%);
      color: #fff;
      padding: 22px 28px 18px;
      text-align: center;
      position: relative;
      box-shadow: 0 4px 14px rgba(22, 101, 52, 0.25);
    }
    .header::after {
      content: ""; position: absolute; left: 0; right: 0; bottom: 0;
      height: 4px;
      background: linear-gradient(90deg, #fbbf24, #f59e0b, #fbbf24);
    }
    .logo-card {
      background: #fff; border-radius: 10px; padding: 6px 10px;
      display: inline-block; margin-bottom: 10px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.15);
    }
    .logo-card img { max-height: 56px; max-width: 180px; object-fit: contain; display: block; }
    .header h1 { font-size: 20pt; font-weight: 800; margin-bottom: 4px; letter-spacing: 0.3px; }
    .header .company { font-size: 12pt; font-weight: 600; opacity: 0.95; margin-bottom: 2px; }
    .header .subtitle { font-size: 10pt; opacity: 0.85; }
    .meta-bar {
      background: #ecfdf5;
      border-bottom: 1px solid #a7f3d0;
      padding: 9px 28px;
      display: flex; justify-content: space-between; align-items: center;
      font-size: 9.5pt; color: #14532d; font-weight: 500;
    }
    .meta-bar .meta-item { display: inline-flex; align-items: center; gap: 6px; }
    .summary-grid {
      padding: 16px 24px 4px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 10px;
    }
    .summary-card {
      border: 1.5px solid;
      border-radius: 8px;
      padding: 10px 14px;
      text-align: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .summary-label { font-size: 9.5pt; font-weight: 600; margin-bottom: 4px; }
    .summary-value { font-size: 18pt; font-weight: 800; line-height: 1; }
    .tree {
      padding: 14px 24px 24px;
      background: #fff;
      margin: 8px 16px 16px;
      border-radius: 10px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.05);
    }
    .node {
      padding-right: 10px;
      margin-bottom: 4px;
      border-radius: 0 6px 6px 0;
      background: #fafafa;
    }
    .node-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 7px 10px;
      gap: 10px;
      border-bottom: 1px dashed #e2e8f0;
    }
    .node-left { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
    .node-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .code {
      font-family: 'Courier New', monospace;
      font-weight: 700; font-size: 10pt;
      background: #f1f5f9; color: #334155;
      padding: 2px 8px; border-radius: 4px;
      direction: ltr;
    }
    .name { font-weight: 600; font-size: 10.5pt; color: #0f172a; }
    .name-en { font-size: 9pt; color: #64748b; font-style: italic; direction: ltr; }
    .type-chip {
      font-size: 8.5pt; font-weight: 600;
      padding: 2px 8px; border-radius: 10px;
      border: 1px solid;
    }
    .badge {
      font-size: 8pt; font-weight: 600;
      padding: 2px 7px; border-radius: 10px;
    }
    .badge-posting { background: #dbeafe; color: #1d4ed8; }
    .badge-summary { background: #fef3c7; color: #92400e; }
    .balance {
      font-family: 'Courier New', monospace;
      font-weight: 700; font-size: 10pt;
      color: #166534;
      direction: ltr;
      min-width: 90px; text-align: left;
    }
    .dot {
      display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    }
    .dot-active { background: #22c55e; box-shadow: 0 0 0 2px #bbf7d0; }
    .dot-inactive { background: #cbd5e1; }
    .footer {
      text-align: center; padding: 12px 24px 20px;
      font-size: 8.5pt; color: #64748b;
    }
    @media print {
      body { background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .header, .meta-bar, .summary-card, .type-chip, .badge, .code, .dot {
        -webkit-print-color-adjust: exact; print-color-adjust: exact;
      }
      .tree { box-shadow: none; margin: 8px 0; }
      .node { page-break-inside: avoid; break-inside: avoid; }
    }
    @page {
      margin: 12mm 10mm 18mm 10mm;
      size: A4 portrait;
      @bottom-center {
        content: "صفحة " counter(page) " من " counter(pages);
        font-family: 'Tajawal', 'Segoe UI', Tahoma, Arial, sans-serif;
        font-size: 9pt;
        color: #475569;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    ${logoHtml}
    ${companyName ? `<div class="company">${escape(companyName)}</div>` : ""}
    <h1>${escape(title)}</h1>
    ${subtitle ? `<div class="subtitle">${escape(subtitle)}</div>` : ""}
  </div>
  <div class="meta-bar">
    <span class="meta-item">📅 ${today}</span>
    <span class="meta-item">📊 إجمالي الحسابات: <strong>${accounts.length}</strong></span>
  </div>
  <div class="summary-grid">${summaryCards}</div>
  <div class="tree">
    ${treeHtml || '<div style="text-align:center;padding:40px;color:#94a3b8;">لا توجد حسابات للعرض</div>'}
  </div>
  <div class="footer">
    نظام الفاتورة الإلكترونية السعودية &nbsp;|&nbsp; ${escape(title)} &nbsp;|&nbsp; ${today}
  </div>
  <script>
    ${autoPrint ? `window.onload = function() { setTimeout(function() { window.print(); }, 600); };` : ""}
  </script>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (win) {
    win.addEventListener("afterprint", () => URL.revokeObjectURL(url));
  }
}

// ─── Print HTML Sections (for complex reports like VAT Declaration) ───────────

export interface PrintSection {
  title: string;
  color: string;
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
}

export function printSectionsAsPDF(
  sections: PrintSection[],
  documentTitle: string,
  subtitle: string,
  // Optional company logo (base64 data URL or http(s) URL) shown above
  // the title in the green header.  Same contract as exportToPDF's `logo`.
  logo?: string | null,
) {
  const escape = (s: unknown) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const safeLogo = safeLogoSrc(logo);
  const logoHtml = safeLogo
    ? `<div style="background:#fff;border-radius:8px;padding:5px 8px;display:inline-block;margin-bottom:8px;">
         <img src="${safeLogo}" alt="" style="max-height:54px;max-width:170px;object-fit:contain;display:block;" />
       </div>`
    : "";

  const today = new Date().toLocaleDateString("ar-SA-u-nu-latn", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const sectionsHtml = sections
    .map(
      sec => `
      <div class="section">
        <div class="section-title" style="background:${sec.color}">
          ${escape(sec.title)}
        </div>
        <table>
          <thead>
            <tr>${sec.columns.map(c => `<th>${escape(c.header)}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${sec.rows
              .map(
                (row, i) =>
                  `<tr class="${i % 2 === 0 ? "even" : "odd"}">${sec.columns
                    .map(c => `<td>${escape(row[c.key])}</td>`)
                    .join("")}</tr>`,
              )
              .join("") || `<tr><td colspan="${sec.columns.length}" class="empty">لا توجد بيانات</td></tr>`}
          </tbody>
        </table>
      </div>`,
    )
    .join("");

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8"/>
  <title>${escape(documentTitle)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Tajawal', 'Segoe UI', Tahoma, Arial, sans-serif;
      direction: rtl;
      font-size: 11pt;
      color: #1a1a1a;
      background: #fff;
    }
    .header {
      background: #166534;
      color: #fff;
      padding: 18px 24px 14px;
      text-align: center;
    }
    .header h1 { font-size: 17pt; font-weight: 700; margin-bottom: 4px; }
    .header p  { font-size: 10pt; opacity: .85; }
    .meta {
      background: #f0fdf4;
      border-bottom: 1px solid #bbf7d0;
      padding: 8px 24px;
      font-size: 9pt;
      color: #15803d;
      text-align: center;
    }
    .content { padding: 16px 20px; }
    .section { margin-bottom: 20px; }
    .section-title {
      color: #fff;
      padding: 7px 14px;
      font-weight: 600;
      font-size: 10.5pt;
      border-radius: 4px 4px 0 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 9.5pt;
    }
    thead tr { background: #334155; color: #fff; }
    thead th {
      padding: 8px 10px;
      text-align: center;
      font-weight: 600;
      border: 1px solid #1e293b;
    }
    tbody td {
      padding: 7px 10px;
      border: 1px solid #e2e8f0;
      text-align: center;
    }
    tr.even { background: #f8fafb; }
    tr.odd  { background: #fff; }
    .empty  { color: #94a3b8; padding: 20px; }
    .footer {
      margin-top: 14px;
      font-size: 8pt;
      color: #94a3b8;
      text-align: center;
      border-top: 1px solid #e2e8f0;
      padding-top: 8px;
    }
    @media print {
      body  { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .header, thead tr, .section-title {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
    @page {
      margin: 15mm 15mm 22mm 15mm;
      size: A4 portrait;
      @bottom-center {
        content: "صفحة " counter(page) " من " counter(pages);
        font-family: 'Tajawal', 'Segoe UI', Tahoma, Arial, sans-serif;
        font-size: 9pt;
        color: #475569;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    ${logoHtml}
    <h1>${escape(documentTitle)}</h1>
    <p>${escape(subtitle)}</p>
  </div>
  <div class="meta">تاريخ الطباعة: ${today}</div>
  <div class="content">
    ${sectionsHtml}
    <div class="footer">
      نظام الفاتورة الإلكترونية السعودية &nbsp;|&nbsp; ${today}
    </div>
  </div>
  <script>
    window.onload = function() {
      setTimeout(function() { window.print(); }, 700);
    };
  </script>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, "_blank");
  if (win) {
    win.addEventListener("afterprint", () => URL.revokeObjectURL(url));
  }
}
