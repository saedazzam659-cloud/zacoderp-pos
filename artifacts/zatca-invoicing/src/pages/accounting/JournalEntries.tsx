import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { journalEntriesApi } from "@/lib/journalEntriesApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Search, Pencil, Trash2, BookOpen, ArrowUpDown, Calendar, CheckCircle2, FileText, Printer, FileSpreadsheet, FileDown } from "lucide-react";
import * as XLSX from "xlsx";
import { cn } from "@/lib/utils";

// Maps a journal-entry's `entryType` + resolved `sourceId` to the route of the
// source document that produced it. For sourced entry types we ALWAYS return a
// route — when `sourceId` is missing (older posts that didn't carry a
// docNumber forward, or rows whose source we couldn't resolve) we fall back to
// the source module's list page so the user still lands on the right place
// instead of the journal-entry edit modal. Returns null only for genuinely
// manual / general entries that have no source to drill into.
function sourceUrlFor(entryType: string | null | undefined, sourceId: number | null | undefined): string | null {
  const t = entryType ?? "";
  switch (t) {
    case "sales_invoice":       return sourceId ? `/sales/invoices/${sourceId}` : "/sales/invoices";
    case "sales_return":        return "/sales/returns";
    case "customer_settlement": return "/sales/settlements";
    case "purchase_invoice":    return sourceId ? `/purchasing/invoices/${sourceId}` : "/purchasing/invoices";
    case "purchase_return":     return "/purchasing/returns";
    case "supplier_settlement": return "/purchasing/settlements";
    case "receipt":
    case "receipt_voucher":     return "/cash/receipt-vouchers";
    case "payment":
    case "payment_voucher":     return "/cash/payment-vouchers";
    case "stock_transfer":      return "/inventory/transfers";
    case "stock_adjustment":    return "/inventory/adjustments";
    case "payroll_run":         return "/hr/payroll";
    case "employee_loan":       return "/hr/loans";
    case "eos_payment":         return "/hr/end-of-service";
    default:                    return null;
  }
}

export default function JournalEntries() {
  const { user } = useAuth() as any;
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  const ENTRY_TYPES: Record<string, string> = {
    general:      t("journalEntries.typeGeneral"),
    opening:      t("journalEntries.typeOpening"),
    closing:      t("journalEntries.typeClosing"),
    adjustment:   t("journalEntries.typeAdjustment"),
    depreciation: t("journalEntries.typeDepreciation"),
  };
  const STATUS_MAP: Record<string, { label: string; cls: string }> = {
    draft:  { label: t("journalEntries.statusDraft"),  cls: "bg-yellow-50 text-yellow-700 border-yellow-200" },
    posted: { label: t("journalEntries.statusPosted"), cls: "bg-green-50 text-green-700 border-green-200" },
    voided: { label: t("journalEntries.statusVoided"), cls: "bg-red-50 text-red-700 border-red-200" },
  };

  const [search, setSearch] = useState("");
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data: entries = [], isLoading } = useQuery<any[]>({
    queryKey: ["journal-entries", cid],
    queryFn: () => journalEntriesApi.list(cid),
    enabled: !!user,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => journalEntriesApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal-entries", cid] });
      setDeleteId(null);
    },
  });

  const filtered = entries.filter(e =>
    !search ||
    e.docNumber?.includes(search) ||
    e.description?.includes(search) ||
    e.entryDate?.includes(search)
  );

  const totalDebit  = entries.reduce((s: number, e: any) => s + Number(e.totalDebit  ?? 0), 0);
  const totalCredit = entries.reduce((s: number, e: any) => s + Number(e.totalCredit ?? 0), 0);

  const COL_DOC    = t("journalEntries.docNumber");
  const COL_DATE   = t("journalEntries.date");
  const COL_TYPE   = t("journalEntries.type");
  const COL_DESC   = t("journalEntries.description");
  const COL_DEBIT  = t("journalEntries.debit");
  const COL_CREDIT = t("journalEntries.credit");
  const COL_STATUS = t("journalEntries.status");

  const buildRows = () => filtered.map((e: any) => ({
    [COL_DOC]:    e.docNumber ?? `QYD-${String(e.id).padStart(4, "0")}`,
    [COL_DATE]:   e.entryDate ?? "",
    [COL_TYPE]:   ENTRY_TYPES[e.entryType] ?? e.entryType ?? "",
    [COL_DESC]:   e.description ?? "",
    [COL_DEBIT]:  Number(e.totalDebit  ?? 0).toFixed(2),
    [COL_CREDIT]: Number(e.totalCredit ?? 0).toFixed(2),
    [COL_STATUS]: (STATUS_MAP[e.status] ?? STATUS_MAP.posted).label,
  }));

  const handleExportExcel = () => {
    const rows = buildRows();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 32 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, t("journalEntries.title"));
    XLSX.writeFile(wb, `journal-entries-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const escapeHtml = (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

  const buildPrintHtml = () => {
    const rows = buildRows();
    const cols = Object.keys(rows[0] ?? { [COL_DOC]: "", [COL_DATE]: "", [COL_TYPE]: "", [COL_DESC]: "", [COL_DEBIT]: "", [COL_CREDIT]: "", [COL_STATUS]: "" });
    const today = new Date().toLocaleDateString(isRtl ? "ar-SA" : "en-GB");
    const dir = isRtl ? "rtl" : "ltr";
    const lang = isRtl ? "ar" : "en";
    const align = isRtl ? "right" : "left";
    return `<!DOCTYPE html><html dir="${dir}" lang="${lang}"><head><meta charset="utf-8"><title>${escapeHtml(t("journalEntries.printSheetTitle"))}</title>
<style>
@page { size: A4 landscape; margin: 12mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; padding:0; }
.h { text-align:center; margin-bottom:8px; }
.h h1 { margin:0 0 4px; font-size:18px; }
.h .meta { font-size:11px; color:#555; }
.totals { display:flex; gap:16px; justify-content:center; margin:8px 0 12px; font-size:12px; }
.totals span b { color:#1e3a8a; }
table { width:100%; border-collapse:collapse; font-size:11px; }
thead th { background:#1e3a8a; color:#fff; padding:6px 8px; border:1px solid #1e3a8a; text-align:${align}; font-weight:600; }
tbody td { padding:5px 8px; border:1px solid #d1d5db; text-align:${align}; }
tbody tr:nth-child(even) td { background:#f5f7fb; }
.num { font-family: "Consolas",monospace; }
.print-btn { position:fixed; top:10px; ${isRtl ? "left" : "right"}:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">${escapeHtml(t("journalEntries.printPdf"))}</button>
<div class="h">
  <h1>${escapeHtml(t("journalEntries.printSheetTitle"))}</h1>
  <div class="meta">${escapeHtml(t("journalEntries.reportDate"))}: ${today} — ${escapeHtml(t("journalEntries.entriesCount", { count: rows.length }))}</div>
</div>
<div class="totals">
  <span>${escapeHtml(t("journalEntries.totalDebit"))}: <b>${totalDebit.toFixed(2)}</b></span>
  <span>${escapeHtml(t("journalEntries.totalCredit"))}: <b>${totalCredit.toFixed(2)}</b></span>
</div>
<table>
  <thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
  <tbody>
    ${rows.map(r => `<tr>${cols.map(c => {
      const isNum = c === COL_DEBIT || c === COL_CREDIT;
      return `<td class="${isNum ? "num" : ""}">${escapeHtml((r as any)[c])}</td>`;
    }).join("")}</tr>`).join("")}
  </tbody>
</table>
<script>setTimeout(()=>window.print(),300);</script>
</body></html>`;
  };

  const openPrintWindow = (html: string) => {
    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) return;
    w.document.open(); w.document.write(html); w.document.close();
  };

  const handleExportPDF = () => openPrintWindow(buildPrintHtml());
  const handlePrint    = () => openPrintWindow(buildPrintHtml());

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <BookOpen className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">{t("journalEntries.title")}</h1>
            <p className="text-xs text-muted-foreground">{t("journalEntries.subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <Button variant="outline" size="sm" onClick={handlePrint} className="gap-1.5">
            <Printer className="h-4 w-4" /> {t("accountingReports.print")}
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportExcel} className="gap-1.5 text-green-700 border-green-200 hover:bg-green-50">
            <FileSpreadsheet className="h-4 w-4" /> {t("journalEntries.excel")}
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportPDF} className="gap-1.5 text-red-700 border-red-200 hover:bg-red-50">
            <FileDown className="h-4 w-4" /> {t("journalEntries.pdf")}
          </Button>
          <Button onClick={() => navigate("/accounting/journals/new")} className="gap-2">
            <Plus className="h-4 w-4" />
            {t("journalEntries.newEntry")}
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="border-2">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <FileText className="h-8 w-8 text-blue-500 bg-blue-50 rounded-lg p-1.5" />
              <div>
                <p className="text-xs text-muted-foreground">{t("journalEntries.totalEntries")}</p>
                <p className="text-2xl font-bold text-foreground">{entries.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-2">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <ArrowUpDown className="h-8 w-8 text-green-500 bg-green-50 rounded-lg p-1.5" />
              <div>
                <p className="text-xs text-muted-foreground">{t("journalEntries.totalDebit")}</p>
                <p className="text-2xl font-bold text-green-600">{fmt(totalDebit)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-2">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-8 w-8 text-purple-500 bg-purple-50 rounded-lg p-1.5" />
              <div>
                <p className="text-xs text-muted-foreground">{t("journalEntries.totalCredit")}</p>
                <p className="text-2xl font-bold text-purple-600">{fmt(totalCredit)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="relative">
            <Search className={cn("absolute top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground", isRtl ? "right-3" : "left-3")} />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t("journalEntries.searchPlaceholder")}
              className={isRtl ? "pr-9" : "pl-9"}
            />
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
            <BookOpen className="h-4 w-4" />
            {t("journalEntries.log")} ({filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-16 text-center text-muted-foreground text-sm">{t("journalEntries.loading")}</div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <BookOpen className="h-10 w-10 text-muted-foreground/30 mx-auto" />
              <p className="text-muted-foreground text-sm">{t("journalEntries.noEntries")}</p>
              <Button variant="outline" size="sm" onClick={() => navigate("/accounting/journals/new")}>
                <Plus className={cn("h-3.5 w-3.5", isRtl ? "ml-1" : "mr-1")} />
                {t("journalEntries.createFirstEntry")}
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30 text-muted-foreground">
                    <th className="px-4 py-2.5 text-start font-medium">{t("journalEntries.docNumber")}</th>
                    <th className="px-4 py-2.5 text-start font-medium">{t("journalEntries.date")}</th>
                    <th className="px-4 py-2.5 text-start font-medium">{t("journalEntries.type")}</th>
                    <th className="px-4 py-2.5 text-start font-medium">{t("journalEntries.description")}</th>
                    <th className="px-4 py-2.5 text-start font-medium">{t("journalEntries.debit")}</th>
                    <th className="px-4 py-2.5 text-start font-medium">{t("journalEntries.credit")}</th>
                    <th className="px-4 py-2.5 text-start font-medium">{t("journalEntries.status")}</th>
                    <th className="px-4 py-2.5 text-center font-medium">{t("journalEntries.actions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((entry: any) => {
                    const st = STATUS_MAP[entry.status] ?? STATUS_MAP.posted;
                    const docLabel = entry.docNumber ?? `QYD-${String(entry.id).padStart(4, "0")}`;
                    const sourceUrl = sourceUrlFor(entry.entryType, entry.sourceId);
                    return (
                      <tr
                        key={entry.id}
                        className="hover:bg-muted/20 transition-colors cursor-pointer"
                        onDoubleClick={() => navigate(`/accounting/journals/${entry.id}?tab=lines`)}
                        title={t("journalEntries.doubleClickHint")}
                      >
                        <td className="px-4 py-3 font-mono text-xs font-semibold">
                          {sourceUrl ? (
                            <button
                              type="button"
                              className="text-primary hover:underline"
                              title={t("journalEntries.openSource")}
                              onClick={(e) => { e.stopPropagation(); navigate(sourceUrl); }}
                            >
                              {docLabel}
                            </button>
                          ) : (
                            <span className="text-primary">{docLabel}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground flex items-center gap-1.5">
                          <Calendar className="h-3.5 w-3.5" />
                          {entry.entryDate}
                        </td>
                        <td className="px-4 py-3 text-xs">{ENTRY_TYPES[entry.entryType] ?? entry.entryType}</td>
                        <td className="px-4 py-3 text-muted-foreground max-w-[200px] truncate">{entry.description ?? "—"}</td>
                        <td className="px-4 py-3 font-mono text-green-700 font-medium">
                          {fmt(Number(entry.totalDebit ?? 0))}
                        </td>
                        <td className="px-4 py-3 font-mono text-red-700 font-medium">
                          {fmt(Number(entry.totalCredit ?? 0))}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className={`text-[10px] ${st.cls}`}>{st.label}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-1">
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-primary"
                              onClick={() => navigate(`/accounting/journals/${entry.id}`)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={() => setDeleteId(entry.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("journalEntries.confirmDelete")}</AlertDialogTitle>
            <AlertDialogDescription>{t("journalEntries.confirmDeleteDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel>{t("journalEntries.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            >
              {t("journalEntries.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
