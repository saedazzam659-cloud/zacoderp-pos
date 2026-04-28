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
) {
  const escape = (s: unknown) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

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
) {
  const escape = (s: unknown) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

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
