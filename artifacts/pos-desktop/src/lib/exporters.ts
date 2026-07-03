// Reusable offline export helpers for list/report screens.
//   • exportToExcel — real .xlsx via SheetJS (RTL sheet, Arabic-safe).
//   • exportToPdf   — prints an HTML table through an isolated hidden iframe
//                     (the OS "Save as PDF" target). Using the print pipeline
//                     keeps Arabic shaping correct, unlike canvas/jsPDF.
// Both run fully client-side, so they work with no internet (standalone app).
import * as XLSX from "xlsx";
import { saveWorkbook } from "./saveFile";

export interface ExportColumn<T> {
  header: string;
  cell: (row: T) => string | number | null | undefined;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function exportToExcel<T>(filenameBase: string, columns: ExportColumn<T>[], rows: T[]): void {
  const header = columns.map((c) => c.header);
  const body = rows.map((r) =>
    columns.map((c) => {
      const v = c.cell(r);
      return v == null ? "" : v;
    }),
  );
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  ws["!cols"] = columns.map((c) => ({ wch: Math.max(12, c.header.length + 2) }));
  const wb = XLSX.utils.book_new();
  // Right-to-left sheet so Arabic columns read naturally in Excel.
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, "البيانات");
  saveWorkbook(wb, `${filenameBase}-${stamp()}.xlsx`);
}

function escHtml(x: unknown): string {
  return String(x ?? "").replace(/[&<>"]/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch,
  );
}

// Standalone hidden-iframe print (mirrors invoicePrint's isolation pattern —
// an in-DOM @media-print overlay gets clipped by the shell's flex/overflow
// ancestors and prints cropped).
function printDocHtml(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  document.body.appendChild(iframe);
  const win = iframe.contentWindow;
  const idoc = win?.document;
  if (!win || !idoc) { iframe.remove(); return; }
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    try { win.focus(); win.print(); } catch { /* cancelled / unsupported */ }
    setTimeout(() => iframe.remove(), 1500);
  };
  idoc.open();
  idoc.write(html);
  idoc.close();
  if (idoc.readyState === "complete") setTimeout(run, 200);
  else { win.addEventListener("load", () => setTimeout(run, 200)); setTimeout(run, 1000); }
}

export function exportToPdf<T>(title: string, columns: ExportColumn<T>[], rows: T[]): void {
  const thead = columns.map((c) => `<th>${escHtml(c.header)}</th>`).join("");
  const tbody = rows
    .map(
      (r) =>
        `<tr>${columns.map((c) => `<td>${escHtml(c.cell(r))}</td>`).join("")}</tr>`,
    )
    .join("");
  const html = `<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>${escHtml(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4 landscape; margin: 10mm; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; color: #0f172a; direction: rtl; padding: 4px; }
  .hd { display:flex; justify-content:space-between; align-items:flex-end; border-bottom:2px solid #b88a2a; padding-bottom:8px; margin-bottom:12px; }
  .hd h1 { font-size:18px; font-weight:800; }
  .hd .meta { font-size:10px; color:#64748b; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  thead tr { background:#f3f4f6; }
  th { padding:7px 6px; text-align:right; font-weight:700; border-bottom:1px solid #e5e7eb; font-size:10.5px; }
  td { padding:6px; text-align:right; border-bottom:1px solid #eef2f7; }
  tbody tr:nth-child(even) td { background:#fafbfc; }
  tbody tr { page-break-inside: avoid; break-inside: avoid; }
  .ft { margin-top:10px; font-size:9px; color:#94a3b8; text-align:center; }
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style></head>
<body>
  <div class="hd">
    <h1>${escHtml(title)}</h1>
    <div class="meta">عدد السجلات: ${rows.length} — تاريخ الطباعة: ${escHtml(new Date().toLocaleString("en-GB"))}</div>
  </div>
  <table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
  <div class="ft">تم التصدير من نظام نقاط البيع</div>
</body></html>`;
  printDocHtml(html);
}
