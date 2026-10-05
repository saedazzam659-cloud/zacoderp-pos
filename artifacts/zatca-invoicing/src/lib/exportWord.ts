import { saveBlob } from "./saveFile";
import { buildCompanyAddressLine } from "./export";
import type { ExportColumn, ExportCompanyInfo, ExportExtraSection } from "./export";

type WordExportOptions = {
  company?: ExportCompanyInfo | null;
  title?: string;
  subtitle?: string;
  totalsRow?: Record<string, unknown> | null;
  summaryFooter?: Array<{ label: string; value: string }>;
  extraSections?: ExportExtraSection[] | null;
};

const asText = (value: unknown) => {
  if (value == null || value === "") return "—";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

const asFilename = (filename: string) => {
  const base = filename
    .replace(/\.docx$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .trim() || "school-records";
  return `${base}.docx`;
};

export async function exportToWordBranded(
  rows: Record<string, unknown>[],
  columns: ExportColumn[],
  filename: string,
  options: WordExportOptions = {},
): Promise<void> {
  const docx: any = await import("docx");
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
    AlignmentType, BorderStyle, ShadingType, WidthType, PageOrientation,
  } = docx;
  const border = { style: BorderStyle.SINGLE, size: 4, color: "D8E4E0" };
  const tableBorders = {
    top: border, bottom: border, left: border, right: border,
    insideHorizontal: border, insideVertical: border,
  };
  const paragraph = (text: string, opts: Record<string, any> = {}) => {
    const { textRun, ...paragraphOptions } = opts;
    return new Paragraph({
      children: [new TextRun({ text, ...(textRun ?? {}) })],
      alignment: AlignmentType.RIGHT,
      bidirectional: true,
      ...paragraphOptions,
    });
  };
  const cell = (text: string, header = false) => new TableCell({
    shading: header ? { type: ShadingType.CLEAR, fill: "126B57", color: "FFFFFF" } : undefined,
    margins: { top: 90, bottom: 90, left: 100, right: 100 },
    children: [new Paragraph({
      children: [new TextRun({
        text,
        bold: header,
        color: header ? "FFFFFF" : "203630",
        size: 18,
      })],
      alignment: AlignmentType.RIGHT,
      bidirectional: true,
    })],
  });
  const makeTable = (
    tableRows: Record<string, unknown>[],
    tableColumns: ExportColumn[],
    totalsRow?: Record<string, unknown> | null,
  ) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorders,
    rows: [
      new TableRow({
        tableHeader: true,
        children: tableColumns.map(column => cell(column.header, true)),
      }),
      ...tableRows.map((row, rowIndex) => new TableRow({
        cantSplit: true,
        children: tableColumns.map(column => cell(asText(row[column.key]))),
      })),
      ...(totalsRow ? [new TableRow({
        cantSplit: true,
        children: tableColumns.map(column => cell(asText(totalsRow[column.key]))),
      })] : []),
    ],
  });

  const children: any[] = [];
  const company = options.company;
  const logoSource = company?.brandLogo || company?.logo;
  if (logoSource && typeof window !== "undefined") {
    try {
      const isRasterDataUrl = /^data:image\/(?:png|jpe?g|gif|bmp);base64,/i.test(logoSource);
      const url = isRasterDataUrl ? logoSource : new URL(logoSource, window.location.href).toString();
      const response = await fetch(url);
      const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (response.ok && mime && /^image\/(?:png|jpeg|gif|bmp)$/.test(mime)) {
        const data = new Uint8Array(await response.arrayBuffer());
        children.push(new Paragraph({
          children: [new ImageRun({ data, transformation: { width: 68, height: 68 } })],
          alignment: AlignmentType.RIGHT,
          bidirectional: true,
          spacing: { after: 100 },
        }));
      }
    } catch {
      // A logo that is inaccessible from the browser should not block export.
    }
  }
  const companyName = company?.nameAr || company?.nameEn;
  if (companyName) {
    children.push(new Paragraph({
      children: [new TextRun({ text: companyName, bold: true, color: "126B57", size: 30 })],
      alignment: AlignmentType.RIGHT,
      bidirectional: true,
      spacing: { after: 80 },
    }));
  }
  const companyMeta = [
    company?.nameAr && company?.nameEn && company.nameAr !== company.nameEn ? company.nameEn : null,
    company?.crNumber ? `السجل التجاري: ${company.crNumber}` : null,
    company?.vatNumber ? `الرقم الضريبي: ${company.vatNumber}` : null,
    company?.phone ? `الهاتف: ${company.phone}` : null,
    buildCompanyAddressLine(company) || null,
  ].filter((value): value is string => !!value);
  companyMeta.forEach(value => children.push(paragraph(value, { spacing: { after: 30 } })));
  if (companyName || companyMeta.length) {
    children.push(new Paragraph({ text: "", spacing: { after: 100 } }));
  }
  if (options.title) {
    children.push(new Paragraph({
      children: [new TextRun({ text: options.title, bold: true, color: "173D33", size: 28 })],
      alignment: AlignmentType.RIGHT,
      bidirectional: true,
      spacing: { before: 80, after: 80 },
    }));
  }
  if (options.subtitle) {
    children.push(paragraph(options.subtitle, { spacing: { after: 180 } }));
  }
  if (columns.length) children.push(makeTable(rows, columns, options.totalsRow));
  (options.summaryFooter ?? []).forEach(item => {
    children.push(paragraph(`${item.label}: ${item.value}`, {
      spacing: { before: 100, after: 40 },
      textRun: { bold: true, color: "126B57" },
    }));
  });
  (options.extraSections ?? []).filter(section => section.columns.length).forEach(section => {
    children.push(new Paragraph({
      children: [new TextRun({ text: section.title, bold: true, color: "126B57", size: 24 })],
      alignment: AlignmentType.RIGHT,
      bidirectional: true,
      spacing: { before: 260, after: 100 },
    }));
    children.push(makeTable(section.rows, section.columns, section.totalsRow));
  });
  if (!children.length) children.push(paragraph("لا توجد بيانات للتصدير."));

  const document = new Document({
    sections: [{
      properties: {
        page: {
          size: {
            orientation: columns.length > 5 ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
          },
          margin: { top: 720, right: 720, bottom: 720, left: 720 },
        },
      },
      children,
    }],
  });
  const blob = await Packer.toBlob(document);
  await saveBlob(blob, asFilename(filename));
}
