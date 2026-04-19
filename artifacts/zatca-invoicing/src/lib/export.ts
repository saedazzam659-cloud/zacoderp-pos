import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

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

  // Auto column widths
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

// ─── PDF Export ───────────────────────────────────────────────────────────────

export function exportToPDF(
  rows: Record<string, unknown>[],
  columns: ExportColumn[],
  filename: string,
  title: string,
  subtitle?: string,
) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  // Header
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(title, doc.internal.pageSize.getWidth() / 2, 16, { align: "center" });

  if (subtitle) {
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100);
    doc.text(subtitle, doc.internal.pageSize.getWidth() / 2, 22, { align: "center" });
    doc.setTextColor(0);
  }

  const head = [columns.map(c => c.header)];
  const body = rows.map(row =>
    columns.map(c => {
      const val = row[c.key];
      return val === null || val === undefined ? "" : String(val);
    })
  );

  autoTable(doc, {
    head,
    body,
    startY: subtitle ? 27 : 22,
    styles: {
      font: "helvetica",
      fontSize: 8,
      cellPadding: 3,
      overflow: "linebreak",
      lineColor: [220, 220, 220],
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: [30, 130, 100],
      textColor: 255,
      fontStyle: "bold",
      halign: "center",
      fontSize: 9,
    },
    alternateRowStyles: {
      fillColor: [248, 250, 248],
    },
    columnStyles: columns.reduce((acc, c, i) => {
      if (c.width) acc[i] = { cellWidth: c.width };
      return acc;
    }, {} as Record<number, unknown>),
    margin: { left: 10, right: 10 },
    didDrawPage: (data) => {
      const pageCount = (doc as any).internal.getNumberOfPages();
      doc.setFontSize(7);
      doc.setTextColor(150);
      doc.text(
        `Page ${data.pageNumber} of ${pageCount}  |  ${new Date().toLocaleDateString("en-SA")}`,
        data.settings.margin.left,
        doc.internal.pageSize.getHeight() - 5,
      );
      doc.setTextColor(0);
    },
  });

  doc.save(`${filename}.pdf`);
}
