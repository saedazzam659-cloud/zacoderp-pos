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
) {
  const headers = columns.map(c => c.header);
  const data    = rows.map(row =>
    columns.map(c => {
      const val = row[c.key];
      return val === null || val === undefined ? "" : String(val);
    })
  );

  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);

  const colWidths = columns.map((c, i) => ({
    wch: c.width ?? Math.max(
      c.header.length + 2,
      ...data.map(row => String(row[i] ?? "").length + 2),
    ),
  }));
  ws["!cols"] = colWidths;

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
    .footer {
      margin-top: 14px;
      font-size: 8pt;
      color: #94a3b8;
      text-align: center;
      border-top: 1px solid #e2e8f0;
      padding-top: 8px;
    }
    .empty { text-align: center; padding: 30px; color: #94a3b8; font-size: 11pt; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      thead tr { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
    @page { margin: 15mm; size: A4 landscape; }
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
      </tbody>
    </table>
    <div class="footer">
      نظام الفاتورة الإلكترونية السعودية &nbsp;|&nbsp; ${escape(filename)} &nbsp;|&nbsp; ${today}
    </div>
  </div>
  <script>
    window.onload = function() {
      setTimeout(function() { window.print(); }, 600);
    };
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
    @page { margin: 15mm; size: A4 portrait; }
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
