import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Download, FileSpreadsheet, FileText, ChevronDown, Loader2, Printer } from "lucide-react";
import { exportToExcel, exportToPDF, type ExportColumn } from "@/lib/export";
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
}

export default function ExportButtons({
  rows, columns, filename, title, subtitle, disabled, size = "sm", totalsRow, summaryFooter,
}: ExportButtonsProps) {
  const [busy, setBusy] = useState(false);
  // The company logo is stored on the user's `company` object as a base64
  // data URL.  We forward it to every PDF/print invocation so the print
  // header carries the company brand consistently across all reports.
  const { user } = useAuth() as any;
  const companyLogo: string | null = user?.company?.logo ?? null;

  async function handleExport(type: "excel" | "pdf" | "print") {
    setBusy(true);
    try {
      if (type === "excel") {
        // Excel can't render the summary cards — instead append the
        // same numbers as extra rows so they're not lost from the file.
        const extra = (summaryFooter ?? []).map(c => ({ [columns[0]?.key ?? "label"]: c.label, [columns[columns.length - 1]?.key ?? "value"]: c.value }));
        exportToExcel([...rows, ...extra], columns, filename, "Sheet1", totalsRow);
      } else if (type === "pdf") {
        // Open PDF view without auto-print so user can save as PDF (Ctrl+S)
        exportToPDF(rows, columns, filename, title, subtitle, false, totalsRow, summaryFooter, companyLogo);
      } else {
        // Print: open the formatted HTML and trigger window.print() automatically
        exportToPDF(rows, columns, filename, title, subtitle, true, totalsRow, summaryFooter, companyLogo);
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
