import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Download, FileSpreadsheet, FileText, ChevronDown, Loader2, Printer } from "lucide-react";
import { exportToExcelBranded, exportToPDF, type ExportColumn, type ExportExtraSection, type ExportCompanyInfo } from "@/lib/export";
import { useAuth } from "@/contexts/AuthContext";

interface ExportButtonsProps {
  rows: Record<string, unknown>[];
  columns: ExportColumn[];
  filename: string;
  title: string;
  subtitle?: string;
  disabled?: boolean;
  size?: "sm" | "default";
  // Optional grand-totals row appended to BOTH the Excel sheet and the
  // PDF/print view. Same shape as data rows (keys map to column.key).
  // The first cell typically carries an "الإجمالي" label and the rest
  // hold pre-formatted currency / count values.
  totalsRow?: Record<string, unknown> | null;
  // Optional summary footer (PDF/print only) — used by reports such as
  // Customer Statement to render the classic "previous balance /
  // movement / closing balance" cards beneath the table.
  summaryFooter?: Array<{ label: string; value: string; tone?: "default" | "debit" | "credit" | "primary" }> | null;
  // Optional extra tables exported AFTER the main one. In PDF they
  // render as titled sub-tables; in Excel they are appended below the
  // main rows, separated by a blank row and a bold title row.
  extraSections?: ExportExtraSection[] | null;
}

export default function ExportButtons({
  rows, columns, filename, title, subtitle, disabled, size = "sm", totalsRow, summaryFooter, extraSections,
}: ExportButtonsProps) {
  const [busy, setBusy] = useState(false);
  // The company brand (logo + name + CR/VAT/phone/address) is stored on the
  // user's `company` object. We forward the whole record to every Excel and
  // PDF/print invocation so each report file carries the company brand
  // consistently. The logo alone is also passed to keep the old positional
  // arg working.
  const { user } = useAuth() as any;
  const companyLogo: string | null = user?.company?.logo ?? null;
  const c = user?.company;
  const company: ExportCompanyInfo | null = c
    ? {
        nameAr: c.nameAr ?? c.name ?? null,
        nameEn: c.nameEn ?? null,
        crNumber: c.crNumber ?? null,
        vatNumber: c.vatNumber ?? null,
        phone: c.phone ?? null,
        buildingNumber: c.buildingNumber ?? null,
        street: c.street ?? null,
        district: c.district ?? null,
        city: c.city ?? null,
        postalCode: c.postalCode ?? null,
        logo: c.logo ?? null,
      }
    : null;

  async function handleExport(type: "excel" | "pdf" | "print") {
    setBusy(true);
    try {
      if (type === "excel") {
        // Excel can't render the summary cards — instead append the
        // same numbers as extra rows so they're not lost from the file.
        // Place each card's VALUE under the matching column by tone:
        //   debit  → "debit" column, credit → "credit" column, otherwise
        //   the last (balance) column. So "إجمالي المدين" lands under the
        //   debit column and "إجمالي الدائن" under the credit column rather
        //   than all piling into the balance column.
        const hasKey = (k: string) => columns.some(col => col.key === k);
        const valueKeyForTone = (tone?: string): string => {
          if (tone === "debit" && hasKey("debit")) return "debit";
          if (tone === "credit" && hasKey("credit")) return "credit";
          return columns[columns.length - 1]?.key ?? "value";
        };
        const extra = (summaryFooter ?? []).map(card => ({
          [columns[0]?.key ?? "label"]: card.label,
          [valueKeyForTone(card.tone)]: card.value,
        }));
        // Append each extra section below the main rows in the same
        // sheet. Each section is preceded by a blank separator row and
        // a "title" row placed in the first column, followed by its
        // own header row (rendered into the SAME main columns by
        // mapping the section's columns into the first N main keys).
        // We keep the main `columns` array as the source-of-truth grid
        // so the sheet stays a single rectangular table — sections
        // simply re-use the leading columns.
        const sectionRows: Record<string, unknown>[] = [];
        (extraSections ?? []).filter(s => s.rows.length > 0).forEach(s => {
          const firstKey = columns[0]?.key ?? "label";
          sectionRows.push({});                                              // blank separator
          sectionRows.push({ [firstKey]: `── ${s.title} ──` });              // section title
          const headerRow: Record<string, unknown> = {};                      // section headers
          s.columns.forEach((c, i) => { headerRow[columns[i]?.key ?? c.key] = c.header; });
          sectionRows.push(headerRow);
          s.rows.forEach(r => {
            const mapped: Record<string, unknown> = {};
            s.columns.forEach((c, i) => { mapped[columns[i]?.key ?? c.key] = r[c.key]; });
            sectionRows.push(mapped);
          });
          if (s.totalsRow) {
            const mappedT: Record<string, unknown> = {};
            s.columns.forEach((c, i) => { mappedT[columns[i]?.key ?? c.key] = s.totalsRow![c.key]; });
            sectionRows.push(mappedT);
          }
        });
        await exportToExcelBranded([...rows, ...extra, ...sectionRows], columns, filename, {
          sheetName: "Sheet1",
          totalsRow,
          company,
          title,
          subtitle,
        });
      } else if (type === "pdf") {
        // Real .pdf download — html2pdf.js renders the same HTML report
        // offscreen, rasterises it (so Arabic/RTL renders correctly) and
        // saves as `${filename}.pdf`. Must await so the busy spinner
        // stays visible until the file dialog appears.
        await exportToPDF(rows, columns, filename, title, subtitle, false, totalsRow, summaryFooter, companyLogo, extraSections, company);
      } else {
        // Print: open the formatted HTML and trigger window.print() automatically
        await exportToPDF(rows, columns, filename, title, subtitle, true, totalsRow, summaryFooter, companyLogo, extraSections, company);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={size}
          disabled={disabled || busy}
          className="gap-2"
        >
          {busy
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Download className="h-3.5 w-3.5" />}
          تصدير
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {rows.length === 0 ? "لا توجد بيانات" : `${rows.length} سجل`}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2.5 cursor-pointer" onClick={() => handleExport("excel")}>
          <FileSpreadsheet className="h-4 w-4 text-green-600" />
          <span>Excel (.xlsx)</span>
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 cursor-pointer" onClick={() => handleExport("pdf")}>
          <FileText className="h-4 w-4 text-red-500" />
          <span>PDF (.pdf)</span>
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 cursor-pointer" onClick={() => handleExport("print")}>
          <Printer className="h-4 w-4 text-blue-600" />
          <span>طباعة</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
