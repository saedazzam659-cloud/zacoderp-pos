import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { safeLogoSrc } from "@/lib/export";
import { useAuth } from "@/contexts/AuthContext";
import { journalEntriesApi } from "@/lib/journalEntriesApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus, Pencil, Trash2, BookOpen, ArrowUpDown, CheckCircle2, FileText, Printer,
  FileSpreadsheet, FileDown, X, Calendar, Loader2,
} from "lucide-react";
import * as XLSX from "xlsx";
import { cn } from "@/lib/utils";
import {
  downloadCsv, matchCol, useAuditGridLayout, useColumnResize,
} from "@/lib/auditGridLayout";
import {
  AuditGridBulkBar, AuditGridPagination, ColumnReorderPopover,
  FooterColorPicker, HeaderColorPicker, HeaderSelectCheckbox, RowSelectCheckbox,
} from "@/components/auditGrid/AuditGridControls";

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

type ColType = "text" | "num" | "none";
interface ColDef {
  key: string;
  label: string;
  type: ColType;
  valueOf: (e: any, ctx: Ctx) => string | number;
}
interface Ctx { entryTypes: Record<string, string>; statusLabels: Record<string, string>; }

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
    draft:  { label: t("journalEntries.statusDraft"),  cls: "bg-amber-100 text-amber-800 border-amber-300" },
    posted: { label: t("journalEntries.statusPosted"), cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
    voided: { label: t("journalEntries.statusVoided"), cls: "bg-rose-100 text-rose-800 border-rose-300" },
  };

  // Column descriptors — defined inside the component so we can localize
  // labels via `t()`. They're cheap to recreate per render and keeping them
  // in scope means `valueOf` can close over Arabic translations.
  const COL_DOC_L    = t("journalEntries.docNumber");
  const COL_DATE_L   = t("journalEntries.date");
  const COL_TYPE_L   = t("journalEntries.type");
  const COL_DESC_L   = t("journalEntries.description");
  const COL_DEBIT_L  = t("journalEntries.debit");
  const COL_CREDIT_L = t("journalEntries.credit");
  const COL_STATUS_L = t("journalEntries.status");

  const COLUMNS: ColDef[] = [
    { key: "_sel",   label: "",           type: "none", valueOf: () => "" },
    { key: "_idx",   label: "#",          type: "none", valueOf: () => "" },
    { key: "doc",    label: COL_DOC_L,    type: "text", valueOf: (e) => e.docNumber ?? `QYD-${String(e.id).padStart(4, "0")}` },
    { key: "date",   label: COL_DATE_L,   type: "text", valueOf: (e) => e.entryDate ?? "" },
    { key: "type",   label: COL_TYPE_L,   type: "text", valueOf: (e, c) => c.entryTypes[e.entryType] ?? e.entryType ?? "" },
    { key: "desc",   label: COL_DESC_L,   type: "text", valueOf: (e) => e.description ?? "" },
    { key: "debit",  label: COL_DEBIT_L,  type: "num",  valueOf: (e) => Number(e.totalDebit  ?? 0) },
    { key: "credit", label: COL_CREDIT_L, type: "num",  valueOf: (e) => Number(e.totalCredit ?? 0) },
    { key: "status", label: COL_STATUS_L, type: "text", valueOf: (e, c) => c.statusLabels[e.status] ?? e.status ?? "" },
    { key: "_act",   label: t("journalEntries.actions"), type: "none", valueOf: () => "" },
  ];
  const DATA_KEYS = useMemo(() => COLUMNS.filter(c => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map(c => c.key), [COLUMNS]);
  const ALL_KEYS  = useMemo(() => COLUMNS.map(c => c.key), [COLUMNS]);

  const ctx: Ctx = useMemo(() => ({
    entryTypes: ENTRY_TYPES,
    statusLabels: Object.fromEntries(Object.entries(STATUS_MAP).map(([k, v]) => [k, v.label])),
  }), [t]);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "posted" | "voided">("all");
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const layout = useAuditGridLayout({
    screenSlug: "journalEntriesAuditGrid",
    cid,
    dataKeys: DATA_KEYS,
    allColKeys: ALL_KEYS,
  });
  const { tableRef, gripProps } = useColumnResize(layout.setColWidths);

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

  /* ── Bulk-action helpers ─────────────────────────────────────────────── */
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // Entry deletes are subject to multiple server-side guards (already-posted,
  // referenced from a source doc, period-locked). We run them sequentially and
  // surface a per-row failure summary so the user knows which rows survived.
  async function bulkRun(
    ids: number[],
    fn: (id: number) => Promise<any>,
  ): Promise<{ ok: number; failures: string[] }> {
    setBulkBusy(true);
    let ok = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try { await fn(id); ok++; } catch (e: any) { failures.push(e?.message || String(e)); }
    }
    setBulkBusy(false);
    qc.invalidateQueries({ queryKey: ["journal-entries", cid] });
    layout.clearSelection();
    return { ok, failures };
  }

  const selectedIds = useMemo(
    () => Array.from(layout.selected).map((x) => Number(x)).filter((n) => Number.isFinite(n)),
    [layout.selected],
  );

  async function confirmBulkDelete() {
    setBulkDeleteOpen(false);
    if (selectedIds.length === 0) return;
    const { ok, failures } = await bulkRun(
      selectedIds,
      async (id) => { await journalEntriesApi.remove(id); },
    );
    // Lightweight in-app feedback — the page already lacks a toast hook here,
    // so we surface the result via a non-blocking alert when something failed.
    if (failures.length > 0) {
      window.alert(
        `${t("journalEntries.delete")}: ${ok}/${selectedIds.length}\n` +
        `${failures.length} عنصر فشل:\n• ${failures.slice(0, 5).join("\n• ")}`,
      );
    }
  }

  /* ── Filtering ── */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (entries as any[]).filter((e) => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (q) {
        const hay = [
          e.docNumber, `QYD-${String(e.id).padStart(4, "0")}`,
          e.description, e.entryDate, ENTRY_TYPES[e.entryType] ?? e.entryType,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      for (const col of COLUMNS) {
        const f = layout.colFilters[col.key];
        if (!f) continue;
        if (!matchCol(col.valueOf(e, ctx), f, col.type)) return false;
      }
      return true;
    });
  }, [entries, search, statusFilter, layout.colFilters, ctx, COLUMNS]);

  /* ── Pagination ── */
  const { pageSize, page, setPage } = layout;
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  if (safePage !== page) setPage(safePage);
  const paged = useMemo(
    () => pageSize === 0 ? filtered : filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filtered, pageSize, safePage],
  );
  const pageStart = filtered.length === 0 ? 0 : pageSize === 0 ? 1 : (safePage - 1) * pageSize + 1;
  const pageEnd   = pageSize === 0 ? filtered.length : Math.min(safePage * pageSize, filtered.length);

  /* ── Totals (over the filtered set) ── */
  const totals = useMemo(() => {
    return filtered.reduce(
      (a, e: any) => {
        a.debit  += Number(e.totalDebit  ?? 0);
        a.credit += Number(e.totalCredit ?? 0);
        return a;
      },
      { debit: 0, credit: 0 },
    );
  }, [filtered]);
  // Print/Excel exports historically used the unfiltered totals — keep that
  // legacy value available but compute it from the same source.
  const totalDebitAll  = entries.reduce((s: number, e: any) => s + Number(e.totalDebit  ?? 0), 0);
  const totalCreditAll = entries.reduce((s: number, e: any) => s + Number(e.totalCredit ?? 0), 0);

  /* ── Visible columns in user's saved order ── */
  const visibleColumns = useMemo(() => {
    const dataCols = layout.dataOrder
      .map((k) => COLUMNS.find((c) => c.key === k))
      .filter((c): c is ColDef => !!c);
    const sel = COLUMNS.find((c) => c.key === "_sel")!;
    const idx = COLUMNS.find((c) => c.key === "_idx")!;
    const act = COLUMNS.find((c) => c.key === "_act")!;
    return [sel, idx, ...dataCols, act];
  }, [layout.dataOrder, COLUMNS]);
  const reorderableCols = useMemo(
    () => DATA_KEYS.map((k) => COLUMNS.find((c) => c.key === k)!).map((c) => ({ key: c.key, label: c.label })),
    [DATA_KEYS, COLUMNS],
  );

  /* ── Existing exports (kept verbatim so PDF / print look identical) ── */
  const buildRows = (source: any[] = filtered) => source.map((e: any) => ({
    [COL_DOC_L]:    e.docNumber ?? `QYD-${String(e.id).padStart(4, "0")}`,
    [COL_DATE_L]:   e.entryDate ?? "",
    [COL_TYPE_L]:   ENTRY_TYPES[e.entryType] ?? e.entryType ?? "",
    [COL_DESC_L]:   e.description ?? "",
    [COL_DEBIT_L]:  Number(e.totalDebit  ?? 0).toFixed(2),
    [COL_CREDIT_L]: Number(e.totalCredit ?? 0).toFixed(2),
    [COL_STATUS_L]: (STATUS_MAP[e.status] ?? STATUS_MAP.posted).label,
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

  const buildPrintHtml = (source: any[] = filtered) => {
    const rows = buildRows(source);
    const totalDebitOfRows  = source.reduce((s: number, e: any) => s + Number(e.totalDebit  ?? 0), 0);
    const totalCreditOfRows = source.reduce((s: number, e: any) => s + Number(e.totalCredit ?? 0), 0);
    const cols = Object.keys(rows[0] ?? { [COL_DOC_L]: "", [COL_DATE_L]: "", [COL_TYPE_L]: "", [COL_DESC_L]: "", [COL_DEBIT_L]: "", [COL_CREDIT_L]: "", [COL_STATUS_L]: "" });
    const today = new Date().toLocaleDateString(isRtl ? "ar-SA" : "en-GB");
    const dir = isRtl ? "rtl" : "ltr";
    const lang = isRtl ? "ar" : "en";
    const align = isRtl ? "right" : "left";
    const safeLogo = safeLogoSrc((user?.company as any)?.logo);
    const logoHtml = safeLogo
      ? `<div style="margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:54px;max-width:170px;object-fit:contain;display:block;margin:0 auto;" /></div>`
      : "";
    const companyNameHtml = user?.company?.nameAr
      ? `<div style="font-size:13px;font-weight:600;color:#1e3a8a;margin-bottom:2px;">${escapeHtml(user.company.nameAr)}</div>`
      : "";
    return `<!DOCTYPE html><html dir="${dir}" lang="${lang}"><head><meta charset="utf-8"><title>${escapeHtml(t("journalEntries.printSheetTitle"))}</title>
<style>
@page { size: A4 landscape; margin: 12mm 12mm 22mm 12mm; @bottom-center { content: "صفحة " counter(page) " من " counter(pages); font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; font-size: 9pt; color: #475569; } }
@media print { thead { display: table-header-group; } }
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
<div class="h">${logoHtml}${companyNameHtml}<h1>${escapeHtml(t("journalEntries.printSheetTitle"))}</h1>
<div class="meta">${escapeHtml(t("journalEntries.reportDate"))}: ${today} — ${escapeHtml(t("journalEntries.entriesCount", { count: rows.length }))}</div></div>
<div class="totals">
  <span>${escapeHtml(t("journalEntries.totalDebit"))}: <b>${totalDebitOfRows.toFixed(2)}</b></span>
  <span>${escapeHtml(t("journalEntries.totalCredit"))}: <b>${totalCreditOfRows.toFixed(2)}</b></span>
</div>
<table><thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
<tbody>${rows.map(r => `<tr>${cols.map(c => {
      const isNum = c === COL_DEBIT_L || c === COL_CREDIT_L;
      return `<td class="${isNum ? "num" : ""}">${escapeHtml((r as any)[c])}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table>
<script>setTimeout(()=>window.print(),300);</script></body></html>`;
  };

  const openPrintWindow = (html: string) => {
    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) return;
    w.document.open(); w.document.write(html); w.document.close();
  };

  const handleExportPDF = () => openPrintWindow(buildPrintHtml());
  const handlePrint    = () => openPrintWindow(buildPrintHtml());

  /* ── Print only the rows the user has selected via checkboxes ── */
  const handleBulkPrint = () => {
    const ids = Array.from(layout.selected);
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    // Preserve the on-screen order so the printout matches what the user sees.
    const selectedRows = (entries as any[]).filter((e: any) => idSet.has(e.id));
    if (selectedRows.length === 0) return;
    openPrintWindow(buildPrintHtml(selectedRows));
  };

  /* ── Quick CSV export (uses visible columns + filtered set) ── */
  function exportCsv() {
    if (filtered.length === 0) return;
    const header = ["#", ...visibleColumns.filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map((c) => c.label)];
    const rows = filtered.map((e: any, i: number) => [
      i + 1,
      ...visibleColumns
        .filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act")
        .map((c) => {
          const v = c.valueOf(e, ctx);
          return c.type === "num" ? Number(v).toFixed(2) : String(v);
        }),
    ]);
    downloadCsv(`journal-entries-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  }

  const { theme, footerTheme, colWidths, colFilters, setColFilter, clearColFilters } = layout;

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
                <p className="text-2xl font-bold text-green-600">{fmt(totalDebitAll)}</p>
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
                <p className="text-2xl font-bold text-purple-600">{fmt(totalCreditAll)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Audit-grid toolbar ───────────────────────────────────────────── */}
      <div className={cn("rounded-t-lg overflow-hidden border shadow-sm transition-colors", theme.border)}>
        <div className={cn("px-3 py-2 flex items-center gap-2 flex-wrap transition-colors", theme.bar, theme.text)}>
          <div className={cn("flex-1 text-sm font-bold tracking-wide flex items-center gap-2", theme.text)}>
            <BookOpen className="h-4 w-4 opacity-90" />
            {t("journalEntries.log")}
          </div>
          <div className="flex items-center gap-1.5">
            <HeaderColorPicker layout={layout} isRtl={isRtl} />
            <FooterColorPicker layout={layout} isRtl={isRtl} />
            <ColumnReorderPopover layout={layout} isRtl={isRtl} columns={reorderableCols} />
            <Button type="button" size="sm" variant="ghost"
              className={cn("h-7 px-2 text-xs gap-1", theme.btn)} onClick={exportCsv}>
              <FileSpreadsheet className="h-3.5 w-3.5" />
              تصدير CSV
            </Button>
          </div>
        </div>

        <div className="bg-slate-50 border-t border-slate-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs">
          <Input
            placeholder={t("journalEntries.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs w-56"
          />
          <div className="flex gap-1">
            {(["all", "draft", "posted", "voided"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={cn(
                  "px-2 py-1 rounded text-[11px] font-medium border transition-colors",
                  statusFilter === s
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100",
                )}
              >
                {s === "all" ? t("journalEntries.statusAll", { defaultValue: "الكل" }) : (STATUS_MAP[s]?.label ?? s)}
              </button>
            ))}
          </div>
          {Object.values(colFilters).some((v) => v) && (
            <Button type="button" size="sm" variant="ghost"
              className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50"
              onClick={clearColFilters} title="مسح فلاتر الأعمدة">
              <X className="h-3.5 w-3.5 me-1" />
              مسح فلاتر الأعمدة
            </Button>
          )}
          <div className="flex-1" />
          <span className="text-slate-700 font-medium">
            {filtered.length} {t("journalEntries.itemLabel", { defaultValue: "قيد" })}
            {filtered.length !== entries.length && <span className="text-slate-400"> / {entries.length}</span>}
          </span>
        </div>
        {/* ── Bulk-action bar (visible only when one or more rows selected) ── */}
        <AuditGridBulkBar
          count={layout.selected.size}
          onClear={layout.clearSelection}
          busy={bulkBusy}
        >
          <Button
            type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-blue-700 hover:bg-blue-600 text-white"
            onClick={handleBulkPrint}
            disabled={selectedIds.length === 0}
            title={`${t("accountingReports.print")} (${selectedIds.length})`}
          >
            <Printer className="h-3.5 w-3.5" />
            {t("accountingReports.print")} ({selectedIds.length})
          </Button>
          <Button
            type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-rose-600 hover:bg-rose-500 text-white"
            onClick={() => setBulkDeleteOpen(true)}
            disabled={bulkBusy || selectedIds.length === 0}
            title={`${t("journalEntries.delete")} (${selectedIds.length})`}
          >
            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {t("journalEntries.delete")} ({selectedIds.length})
          </Button>
        </AuditGridBulkBar>
      </div>

      {/* ── Audit-grid table ─────────────────────────────────────────────── */}
      <div className="border border-slate-300 rounded-b-lg bg-white overflow-hidden shadow-sm -mt-3">
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
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
            <table ref={tableRef} className="w-full text-[11px] border-collapse" dir={isRtl ? "rtl" : "ltr"}>
              <colgroup>
                {visibleColumns.map((col) => (
                  <col key={col.key} data-col-key={col.key}
                    style={colWidths[col.key] ? { width: `${colWidths[col.key]}px` } : undefined} />
                ))}
              </colgroup>
              <thead className="sticky top-0 z-10">
                <tr className="bg-gradient-to-b from-slate-100 to-slate-200 text-slate-700">
                  {visibleColumns.map((col, idx) => {
                    if (col.key === "_sel") {
                      const visibleIds = paged.map((e: any) => Number(e.id));
                      return (
                        <th
                          key={col.key}
                          data-col-key={col.key}
                          style={colWidths[col.key] ? { width: `${colWidths[col.key]}px`, minWidth: `${colWidths[col.key]}px` } : undefined}
                          className="relative px-2 py-1.5 border border-slate-300 text-center font-semibold whitespace-nowrap text-[10.5px] w-9"
                        >
                          <HeaderSelectCheckbox
                            allSelected={layout.isAllSelected(visibleIds)}
                            someSelected={layout.isSomeSelected(visibleIds)}
                            onToggle={() => layout.toggleAll(visibleIds)}
                            disabled={visibleIds.length === 0 || bulkBusy}
                          />
                        </th>
                      );
                    }
                    return (
                      <th
                        key={col.key}
                        data-col-key={col.key}
                        style={colWidths[col.key] ? { width: `${colWidths[col.key]}px`, minWidth: `${colWidths[col.key]}px` } : undefined}
                        className="relative px-2 py-1.5 border border-slate-300 text-center font-semibold whitespace-nowrap text-[10.5px]"
                      >
                        {col.label}
                        <span
                          {...gripProps(col.key, idx)}
                          className="print:hidden absolute top-0 bottom-0 w-2 cursor-col-resize select-none touch-none hover:bg-blue-400/60 active:bg-blue-500/80 z-20"
                          style={{ insetInlineEnd: -4 }}
                        />
                      </th>
                    );
                  })}
                </tr>
                <tr className="bg-amber-50/80 border-b border-amber-200">
                  {visibleColumns.map((col) => (
                    <th key={col.key} className="px-1 py-1 border border-slate-200 text-center">
                      {col.type === "none" ? null : (
                        <Input
                          value={colFilters[col.key] ?? ""}
                          onChange={(e) => setColFilter(col.key, e.target.value)}
                          placeholder={col.type === "num" ? ">=100" : "بحث…"}
                          className="h-6 text-[10.5px] px-1.5 border-slate-300 bg-white"
                          title={col.type === "num" ? "أمثلة: >=100, <500, =0" : "بحث جزئي"}
                        />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.map((entry: any, idx: number) => {
                  const absIdx = pageSize === 0 ? idx : (safePage - 1) * pageSize + idx;
                  const st = STATUS_MAP[entry.status] ?? STATUS_MAP.posted;
                  const docLabel = entry.docNumber ?? `QYD-${String(entry.id).padStart(4, "0")}`;
                  const sourceUrl = sourceUrlFor(entry.entryType, entry.sourceId);
                  const rid = Number(entry.id);
                  const isSel = layout.isSelected(rid);
                  const renderCell = (col: ColDef) => {
                    switch (col.key) {
                      case "_sel":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <RowSelectCheckbox
                              checked={isSel}
                              onToggle={() => layout.toggleRow(rid)}
                              ariaLabel={`تحديد القيد ${docLabel}`}
                            />
                          </td>
                        );
                      case "_idx":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{absIdx + 1}</td>;
                      case "doc":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 font-mono font-semibold text-center">
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
                        );
                      case "date":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center whitespace-nowrap text-slate-600">
                            <span className="inline-flex items-center gap-1">
                              <Calendar className="h-3 w-3 opacity-70" />
                              {entry.entryDate}
                            </span>
                          </td>
                        );
                      case "type":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-600">{ENTRY_TYPES[entry.entryType] ?? entry.entryType}</td>;
                      case "desc":
                        return <td key={col.key} className={cn("px-2 py-1 border border-slate-200 truncate text-slate-600", colWidths.desc ? "" : "max-w-[260px]")} title={entry.description ?? ""}>{entry.description ?? "—"}</td>;
                      case "debit":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-emerald-700 font-medium">{fmt(Number(entry.totalDebit ?? 0))}</td>;
                      case "credit":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-rose-700 font-medium">{fmt(Number(entry.totalCredit ?? 0))}</td>;
                      case "status":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <span className={cn("inline-flex items-center text-[10px] rounded px-1.5 py-0.5 font-medium border", st.cls)}>{st.label}</span>
                          </td>
                        );
                      case "_act":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <div className="flex items-center justify-center gap-0.5">
                              <Button
                                variant="ghost" size="icon"
                                className="h-6 w-6 text-muted-foreground hover:text-primary"
                                onClick={(e) => { e.stopPropagation(); navigate(`/accounting/journals/${entry.id}`); }}
                                title={t("journalEntries.actions")}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost" size="icon"
                                className="h-6 w-6 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                                onClick={(e) => { e.stopPropagation(); setDeleteId(entry.id); }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </td>
                        );
                      default:
                        return <td key={col.key} className="px-2 py-1 border border-slate-200" />;
                    }
                  };
                  return (
                    <tr
                      key={entry.id}
                      className={cn(
                        "transition-colors cursor-pointer",
                        isSel ? "bg-emerald-100/70 hover:bg-emerald-100" : "hover:bg-amber-50/60",
                      )}
                      onClick={(e) => {
                        const tag = (e.target as HTMLElement).tagName;
                        if (tag === "BUTTON" || tag === "INPUT" || tag === "A" || (e.target as HTMLElement).closest("button,a,input")) return;
                        layout.toggleRow(rid);
                      }}
                      onDoubleClick={() => navigate(`/accounting/journals/${entry.id}?tab=lines`)}
                      title={t("journalEntries.doubleClickHint")}
                    >
                      {visibleColumns.map(renderCell)}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="sticky bottom-0">
                <tr className={cn("text-[11px] font-semibold", footerTheme.bg, footerTheme.text)}>
                  {visibleColumns.map((col, i) => {
                    // _sel sits at index 0; the "الإجمالي:" label belongs in the next cell.
                    if (col.key === "_sel") {
                      return <td key={col.key} className={cn("px-2 py-2 border", footerTheme.border)} />;
                    }
                    if (i === 1) {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end whitespace-nowrap", footerTheme.border)}>الإجمالي:</td>;
                    }
                    if (col.key === "debit") {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end font-mono", footerTheme.border)}>{fmt(totals.debit)}</td>;
                    }
                    if (col.key === "credit") {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end font-mono", footerTheme.border)}>{fmt(totals.credit)}</td>;
                    }
                    return <td key={col.key} className={cn("px-2 py-2 border", footerTheme.border)} />;
                  })}
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        <AuditGridPagination
          layout={layout}
          totalRows={filtered.length}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalPages={totalPages}
          unitLabel={t("journalEntries.itemLabel", { defaultValue: "قيد" })}
        />
      </div>

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

      {/* Bulk-delete confirm */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("journalEntries.confirmDelete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {`سيتم محاولة حذف ${selectedIds.length} قيد. القيود المرحَّلة أو المرتبطة بمستند مصدر سيتم تجاوزها.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel>{t("journalEntries.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmBulkDelete}
            >
              {`${t("journalEntries.delete")} (${selectedIds.length})`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
