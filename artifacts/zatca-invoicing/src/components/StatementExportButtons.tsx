import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Download, FileSpreadsheet, FileText, ChevronDown, Loader2, Printer } from "lucide-react";
import {
  exportToExcel, exportStatementToPDF,
  type ExportColumn, type StatementPdfCompany, type StatementPdfAccount, type StatementPdfLine,
} from "@/lib/export";
import { useFmt } from "@/hooks/use-fmt";
import {
  STATEMENT_COL_DEFAULTS,
  type StatementColKey,
  type StatementVisibleCols,
} from "@/components/StatementColumnChooser";

/**
 * Export menu specialized for account statements (customer / supplier).
 *
 * - Excel  → flat sheet with the same columns the user sees on screen, plus
 *            an opening row at the top and a bold totals row at the bottom.
 * - PDF    → opens the dedicated `exportStatementToPDF` printable view that
 *            mirrors `<AccountStatementView />` on screen (company header
 *            card, "كشف حساب" pill, account meta, 7-col table, totals).
 * - Print  → same view as PDF but auto-triggers `window.print()`.
 */
interface Props {
  mode: "customer" | "supplier";
  company?: StatementPdfCompany | null;
  account: StatementPdfAccount;
  from: string;
  to: string;
  opening: number;
  lines: StatementPdfLine[];
  totals: { debit: number; credit: number };
  closing: number;
  filename: string;
  disabled?: boolean;
  /** Localized branch name when a specific branch is filtered; shown in
   *  the printable PDF view's account-meta block. */
  branchName?: string | null;
  /** Column visibility map shared with the on-screen table and the PDF
   *  exporter so the user sees an identical layout everywhere. Defaults
   *  to all visible when omitted. */
  visibleCols?: StatementVisibleCols;
  /** Logged-in user's display name — printed in the PDF footer under
   *  the print date so the paper carries an audit trail. */
  userName?: string | null;
}

export default function StatementExportButtons({
  mode, company, account, from, to, opening, lines, totals, closing, filename, disabled, branchName,
  visibleCols = STATEMENT_COL_DEFAULTS, userName,
}: Props) {
  const [busy, setBusy] = useState(false);
  const { fmt } = useFmt();

  const ALL_EXCEL_COLUMNS: (ExportColumn & { key: StatementColKey })[] = [
    { key: "date", header: "التاريخ", width: 14 },
    { key: "docType", header: "نوع الوثيقة", width: 18 },
    { key: "docNumber", header: "الرقم", width: 16 },
    { key: "type", header: "البيان", width: 16 },
    { key: "debit", header: "مدين", width: 14 },
    { key: "credit", header: "دائن", width: 14 },
    { key: "balance", header: "الرصيد", width: 16 },
    { key: "description", header: "الشرح", width: 30 },
  ];
  const excelColumns: ExportColumn[] = ALL_EXCEL_COLUMNS.filter(c => visibleCols[c.key]);

  const openingDebit  = mode === "supplier" ? (opening < 0 ? -opening : 0) : (opening > 0 ? opening  : 0);
  const openingCredit = mode === "supplier" ? (opening > 0 ? opening  : 0) : (opening < 0 ? -opening : 0);

  const excelRows: Record<string, unknown>[] = [
    {
      docType: "رصيد افتتاحي",
      date: from, docNumber: "—", type: "رصيد افتتاحي",
      debit:  openingDebit  ? fmt(openingDebit)  : "",
      credit: openingCredit ? fmt(openingCredit) : "",
      balance: fmt(opening),
      description: "—",
    },
    ...lines.map(l => ({
      docType: (l as any).docType ?? "",
      date: l.date,
      docNumber: l.docNumber ?? "—",
      type: l.type,
      debit:  l.debit  ? fmt(l.debit)  : "",
      credit: l.credit ? fmt(l.credit) : "",
      balance: fmt(l.balance),
      description: l.description,
    })),
  ];

  // Place the "الإجمالي" label in the first visible leading column so the
  // user always sees it on the totals row regardless of which columns
  // (docType / date / docNumber / type) are hidden via the chooser.
  const firstLeading: StatementColKey | null =
    visibleCols.date ? "date"
    : visibleCols.docType ? "docType"
    : visibleCols.docNumber ? "docNumber"
    : visibleCols.type ? "type"
    : null;
  const totalsRow: Record<string, unknown> | null = lines.length > 0 ? {
    docType: "", date: "", docNumber: "", type: "",
    debit: fmt(totals.debit), credit: fmt(totals.credit),
    balance: fmt(closing), description: "",
    ...(firstLeading ? { [firstLeading]: "الإجمالي" } : {}),
  } : null;

  async function handleExport(type: "excel" | "pdf" | "print") {
    setBusy(true);
    try {
      if (type === "excel") {
        exportToExcel(excelRows, excelColumns, filename, "كشف حساب", totalsRow);
      } else {
        exportStatementToPDF({
          mode, company, account, from, to, opening, lines, totals, closing,
          filename, autoPrint: type === "print", fmt, branchName, visibleCols, userName,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled || busy} className="gap-2">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          تصدير
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {lines.length === 0 ? "لا توجد حركات" : `${lines.length} حركة`}
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
