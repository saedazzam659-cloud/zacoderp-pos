/**
 * Posting Center (مركز الترحيل)
 *
 * Unified manual-posting workbench. The accountant picks a module from the
 * "نوع الحركة" dropdown, optionally filters by status (مرحل / غير مرحل / الكل),
 * date range, and per-column filters, then performs bulk post / unpost on
 * the selected rows.
 *
 * IMPORTANT: This screen does NOT duplicate any posting logic. It calls the
 * existing per-module post/unpost endpoints in client-side chunks so the
 * journal-entry math, account-mapping resolution, and stock side-effects all
 * stay in their original modules. The chunking is necessary because Express
 * cannot reliably handle a single request that needs to post 100k+ docs in
 * one transaction — instead we run with a small concurrency cap and stream
 * progress to the user.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  RefreshCw, Sparkles, FileSpreadsheet, FileDown, Send, Undo2,
  CheckSquare, Square, Loader2, AlertTriangle, Info, ShieldCheck,
  Filter, X, Layers, Calculator,
} from "lucide-react";
import { exportToExcel, exportToPDF, type ExportColumn } from "@/lib/export";
import { cn } from "@/lib/utils";

// ─── Module options ────────────────────────────────────────────────────────
// Each module is mapped to (1) its Arabic label for the dropdown, (2) the
// REST path used to post / unpost a single document, and (3) the HTTP method
// (sales/purchase use PATCH, vouchers use POST).
type ModuleKey =
  | "sales_invoices"   | "sales_returns"
  | "purchase_invoices" | "purchase_returns"
  | "receipt_vouchers"  | "payment_vouchers"
  | "journal_entries"
  | "goods_receipts"    | "goods_deliveries"
  | "cash_transfers"
  | "stock_transfers"   | "stock_adjustments" | "stock_counts";

type ModuleDef = {
  key: ModuleKey;
  label: string;
  endpoint: (id: number, action: "post" | "unpost") => string;
  method: "PATCH" | "POST";
  // Some inventory/cash modules only expose a "post" endpoint; bulk-unpost
  // is hidden for those so the user never gets stuck with a 404.
  supportsUnpost?: boolean;
};

const MODULES: ModuleDef[] = [
  // ── Sales ──
  { key: "sales_invoices",    label: "فواتير المبيعات",    endpoint: (id, a) => `/api/sales/sales-invoices/${id}/${a}`,       method: "PATCH", supportsUnpost: true },
  { key: "sales_returns",     label: "مرتجعات المبيعات",   endpoint: (id, a) => `/api/sales/sales-returns/${id}/${a}`,        method: "PATCH", supportsUnpost: true },
  // ── Purchasing ──
  { key: "purchase_invoices", label: "فواتير المشتريات",   endpoint: (id, a) => `/api/purchasing/purchase-invoices/${id}/${a}`, method: "PATCH", supportsUnpost: true },
  { key: "purchase_returns",  label: "مرتجعات المشتريات",  endpoint: (id, a) => `/api/purchasing/purchase-returns/${id}/${a}`,  method: "PATCH", supportsUnpost: true },
  // ── Cash ──
  { key: "receipt_vouchers",  label: "سندات القبض",        endpoint: (id, a) => `/api/receipt-vouchers/${id}/${a}`,           method: "POST",  supportsUnpost: true },
  { key: "payment_vouchers",  label: "سندات الصرف",        endpoint: (id, a) => `/api/payment-vouchers/${id}/${a}`,           method: "POST",  supportsUnpost: true },
  { key: "cash_transfers",    label: "التحويلات النقدية",  endpoint: (id, a) => `/api/cash-transfers/${id}/${a}`,             method: "POST",  supportsUnpost: false },
  // ── Accounting ──
  { key: "journal_entries",   label: "القيود المحاسبية",   endpoint: (id, a) => `/api/journal-entries/${id}/${a}`,            method: "POST",  supportsUnpost: true },
  // ── Inventory documents ──
  { key: "goods_receipts",    label: "إيصالات الاستلام",   endpoint: (id, a) => `/api/goods-receipts/${id}/${a}`,             method: "PATCH", supportsUnpost: true },
  { key: "goods_deliveries",  label: "إذونات التسليم",     endpoint: (id, a) => `/api/goods-deliveries/${id}/${a}`,           method: "PATCH", supportsUnpost: true },
  { key: "stock_transfers",   label: "تحويلات المخزون",    endpoint: (id, a) => `/api/inventory/stock-transfers/${id}/${a}`,  method: "POST",  supportsUnpost: false },
  { key: "stock_adjustments", label: "تسويات المخزون",     endpoint: (id, a) => `/api/inventory/stock-adjustments/${id}/${a}`, method: "POST",  supportsUnpost: false },
  { key: "stock_counts",      label: "جرد المخزون",        endpoint: (id, a) => `/api/inventory/stock-counts/${id}/${a}`,     method: "POST",  supportsUnpost: false },
];

type StatusFilter = "all" | "posted" | "unposted";

// Unified row shape returned by /api/posting-center/list
type PostingRow = {
  id: number;
  module: ModuleKey;
  docNumber: string | null;
  date: string;
  type: string;
  description: string | null;
  party: string | null;
  amount: number;
  status: string;
  posted: boolean;
  journalEntryId: number | null;
  journalEntryDocNumber: string | null;
};

// AI summary card payload — see /api/posting-center/ai-summary for source.
type AiSummary = {
  module: ModuleKey;
  moduleLabel: string;
  counts: { total: number; unposted: number; posted: number };
  totals: { unposted: number; posted: number };
  anomalies: { oldUnposted: number; missingParty: number; zeroAmount: number; largeAmount: number };
  insights: { level: "info" | "warning" | "danger"; message: string }[];
};

// ─── Bulk post chunking config ─────────────────────────────────────────────
// CONCURRENCY = how many simultaneous in-flight requests. 8 is a safe value
// across the proxy + Express + Postgres pool without thrashing connections.
// At ~100ms/request, 8-way concurrency processes ~80 docs/sec, so a 100k
// batch finishes in ~21 minutes. The user sees a live progress bar so they
// can leave it running and come back.
const BULK_CONCURRENCY = 8;

export default function PostingCenter() {
  const { user } = useAuth();
  const cid = (user as any)?.companyId ?? null;
  const { toast } = useToast();
  const qc = useQueryClient();
  const fmt = useFormatters();

  const [selectedModule, setSelectedModule] = useState<ModuleKey>("sales_invoices");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("unposted");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Selection state — persists across re-renders so the user can scroll, page
  // through filters, and still keep their original selection.
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Bulk action progress UI
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkAction, setBulkAction] = useState<"post" | "unpost" | null>(null);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0, failed: 0 });

  // AI sheet
  const [aiOpen, setAiOpen] = useState(false);
  const cancelRef = useRef(false);

  // Reset selection when module or status filter changes — preserving stale
  // IDs across modules would let the user accidentally post a sales invoice
  // when they're looking at purchase invoices.
  useEffect(() => {
    setSelected(new Set());
  }, [selectedModule, statusFilter, dateFrom, dateTo]);

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["posting-center-list", cid, selectedModule, statusFilter, dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams({
        module: selectedModule,
        status: statusFilter,
      });
      if (cid) params.set("companyId", String(cid));
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      const r = await fetch(`/api/posting-center/list?${params.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error("فشل جلب البيانات");
      return (await r.json()) as {
        items: PostingRow[];
        total: number;
        totalMatched?: number;
        truncated?: boolean;
        limit?: number;
        moduleLabel: string;
      };
    },
    enabled: !!user,
  });

  const allRows = data?.items ?? [];
  const truncated = !!data?.truncated;
  const totalMatched = data?.totalMatched ?? allRows.length;
  const serverLimit = data?.limit ?? 5000;

  // Apply per-grid quick-search on top of server-side status/date filters so
  // the user can type to narrow without re-fetching.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter(r =>
      (r.docNumber ?? "").toLowerCase().includes(q) ||
      (r.party ?? "").toLowerCase().includes(q) ||
      (r.description ?? "").toLowerCase().includes(q) ||
      (r.journalEntryDocNumber ?? "").toLowerCase().includes(q),
    );
  }, [allRows, search]);

  const allFilteredIds = useMemo(() => filtered.map(r => r.id), [filtered]);
  const allSelected = allFilteredIds.length > 0 && allFilteredIds.every(id => selected.has(id));
  const someSelected = !allSelected && allFilteredIds.some(id => selected.has(id));

  function toggleRow(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allFilteredIds));
  }
  function clearSelection() {
    setSelected(new Set());
  }
  function selectAllPostable() {
    // اظهار الكل button — selects every row that can still be posted
    // (i.e. unposted + not cancelled). Uses the server-side filtered set.
    const ids = filtered.filter(r => !r.posted && r.status !== "cancelled").map(r => r.id);
    setSelected(new Set(ids));
  }

  // ─── Bulk post / unpost with chunked concurrency ─────────────────────────
  // Runs `worker` over `ids` with at most `BULK_CONCURRENCY` in flight.
  // Aborts as soon as `cancelRef.current` becomes true (the user clicks the
  // floating Cancel button mid-run).
  async function runBulk(action: "post" | "unpost") {
    const def = MODULES.find(m => m.key === selectedModule)!;

    // Some modules (cash transfers, stock transfers/adjustments/counts) only
    // expose a "post" endpoint server-side. Block unpost early with a clear
    // message so the user isn't left with a wall of failed-row toasts.
    if (action === "unpost" && def.supportsUnpost === false) {
      toast({
        title: "فك الترحيل غير مدعوم لهذا الموديول",
        description: `${def.label} لا تدعم فك الترحيل من مركز الترحيل — قم بإلغاء أو حذف المستند الأصلي بدلاً من ذلك.`,
        variant: "destructive",
      });
      return;
    }

    const ids = Array.from(selected);
    const eligible = ids.filter(id => {
      const row = allRows.find(r => r.id === id);
      if (!row) return false;
      // Only post unposted rows; only unpost posted rows.
      return action === "post" ? !row.posted : row.posted;
    });

    if (eligible.length === 0) {
      toast({ title: "لا توجد عناصر مؤهلة لهذه العملية", variant: "destructive" });
      return;
    }

    if (!confirm(
      action === "post"
        ? `سيتم ترحيل ${eligible.length} عملية. هل تريد المتابعة؟`
        : `سيتم فك ترحيل ${eligible.length} عملية. هل تريد المتابعة؟`,
    )) return;

    setBulkBusy(true);
    setBulkAction(action);
    setBulkProgress({ done: 0, total: eligible.length, failed: 0 });
    cancelRef.current = false;

    let cursor = 0;
    let failed = 0;
    const failures: { id: number; error: string }[] = [];

    async function worker() {
      while (cursor < eligible.length) {
        if (cancelRef.current) break;
        const idx = cursor++;
        const id = eligible[idx];
        try {
          const r = await fetch(def.endpoint(id, action), {
            method: def.method,
            credentials: "include",
            headers: { "content-type": "application/json" },
          });
          if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            throw new Error(body?.error || `HTTP ${r.status}`);
          }
        } catch (e: any) {
          failed++;
          failures.push({ id, error: e?.message || "خطأ" });
        }
        setBulkProgress(p => ({ ...p, done: p.done + 1, failed }));
      }
    }

    const workers = Array.from({ length: Math.min(BULK_CONCURRENCY, eligible.length) }, worker);
    await Promise.all(workers);

    setBulkBusy(false);
    setBulkAction(null);
    const ok = eligible.length - failed - (cancelRef.current ? eligible.length - cursor : 0);
    if (cancelRef.current) {
      toast({
        title: "تم إيقاف العملية",
        description: `تم تنفيذ ${ok} من ${eligible.length} — ${failed} فشل`,
      });
    } else if (failed === 0) {
      toast({
        title: action === "post" ? "تم الترحيل بنجاح" : "تم فك الترحيل بنجاح",
        description: `${ok} عملية`,
      });
    } else {
      toast({
        title: "تمت العملية مع وجود أخطاء",
        description: `نجح ${ok} — فشل ${failed}`,
        variant: "destructive",
      });
      // Log failures so the user can inspect them in devtools.
      console.warn("[posting-center] failures:", failures);
    }

    clearSelection();
    qc.invalidateQueries({ queryKey: ["posting-center-list"] });
  }

  // ─── AI summary ──────────────────────────────────────────────────────────
  const [aiSummary, setAiSummary] = useState<AiSummary | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  async function openAi() {
    setAiOpen(true);
    setAiLoading(true);
    try {
      const params = new URLSearchParams({ module: selectedModule });
      if (cid) params.set("companyId", String(cid));
      const r = await fetch(`/api/posting-center/ai-summary?${params.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error("فشل التحليل");
      setAiSummary(await r.json());
    } catch (e: any) {
      toast({ title: "تعذر التحليل", description: e?.message, variant: "destructive" });
    } finally {
      setAiLoading(false);
    }
  }

  // ─── Export ──────────────────────────────────────────────────────────────
  // The shared `exportToExcel`/`exportToPDF` helpers take plain row objects
  // keyed by column.key (NOT a `value` callback), so we pre-build flat rows.
  const exportColumns: ExportColumn[] = [
    { header: "#",          key: "_idx",        width: 5  },
    { header: "رقم المستند", key: "docNumber",   width: 18 },
    { header: "التاريخ",     key: "date",        width: 14 },
    { header: "النوع",       key: "type",        width: 22 },
    { header: "الوصف",       key: "description", width: 30 },
    { header: "الجهة",       key: "party",       width: 24 },
    { header: "القيمة",      key: "amount",      width: 14 },
    { header: "الحالة",      key: "status",      width: 12 },
    { header: "رقم القيد",   key: "je",          width: 14 },
  ];
  function buildExportRows() {
    return filtered.map((r, idx) => ({
      _idx:        idx + 1,
      docNumber:   r.docNumber ?? "",
      date:        r.date,
      type:        r.type,
      description: r.description ?? "",
      party:       r.party ?? "",
      amount:      r.amount.toFixed(2),
      status:      r.posted ? "مرحّل" : r.status === "cancelled" ? "ملغى" : "غير مرحّل",
      je:          r.journalEntryDocNumber ?? (r.journalEntryId ? `#${r.journalEntryId}` : ""),
    }));
  }
  function buildExportTotals() {
    return {
      _idx: "",
      docNumber: "الإجمالي",
      date: "",
      type: `${filtered.length} عملية`,
      description: "",
      party: "",
      amount: totalAmount.toFixed(2),
      status: "",
      je: "",
    };
  }
  function doExportExcel() {
    if (filtered.length === 0) {
      toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" });
      return;
    }
    const moduleLabel = MODULES.find(m => m.key === selectedModule)?.label ?? "";
    exportToExcel(
      buildExportRows(),
      exportColumns,
      `posting-center-${selectedModule}-${new Date().toISOString().slice(0, 10)}`,
      moduleLabel || "Posting Center",
      buildExportTotals(),
    );
    toast({ title: `تم تصدير ${filtered.length} عملية إلى Excel` });
  }
  function doExportPdf() {
    if (filtered.length === 0) {
      toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" });
      return;
    }
    const moduleLabel = MODULES.find(m => m.key === selectedModule)?.label ?? "";
    exportToPDF(
      buildExportRows(),
      exportColumns,
      `posting-center-${selectedModule}-${new Date().toISOString().slice(0, 10)}`,
      `مركز الترحيل — ${moduleLabel}`,
      `إجمالي السجلات: ${filtered.length}`,
      true,
      buildExportTotals(),
    );
  }

  // ─── Render ──────────────────────────────────────────────────────────────
  const moduleLabel = MODULES.find(m => m.key === selectedModule)?.label ?? "";
  const totalAmount = filtered.reduce((s, r) => s + r.amount, 0);
  const selectedAmount = filtered
    .filter(r => selected.has(r.id))
    .reduce((s, r) => s + r.amount, 0);

  return (
    <div className="p-3 sm:p-4 space-y-3" dir="rtl">
      {/* Page title */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-gradient-to-br from-indigo-600 to-violet-700 p-2 text-white shadow-md">
            <Layers className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">مركز الترحيل</h1>
            <p className="text-xs text-slate-500">
              ترحيل وفك ترحيل العمليات يدويًا من جميع الموديولات في مكان واحد
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={openAi}
                  className="border-violet-300 text-violet-700 hover:bg-violet-50"
                  data-testid="button-ai-summary">
            <Sparkles className="size-4 me-1.5" /> تحليل ذكي
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()}
                  disabled={isFetching}
                  data-testid="button-refresh">
            {isFetching
              ? <Loader2 className="size-4 me-1.5 animate-spin" />
              : <RefreshCw className="size-4 me-1.5" />}
            تحديث
          </Button>
          <Button variant="outline" size="sm" onClick={doExportExcel}
                  data-testid="button-export-excel"
                  className="text-emerald-700 hover:text-emerald-800">
            <FileSpreadsheet className="size-4 me-1.5" /> Excel
          </Button>
          <Button variant="outline" size="sm" onClick={doExportPdf}
                  data-testid="button-export-pdf"
                  className="text-rose-700 hover:text-rose-800">
            <FileDown className="size-4 me-1.5" /> PDF
          </Button>
        </div>
      </div>

      {/* Filter card */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-3 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">نوع الحركة</label>
            <Select value={selectedModule} onValueChange={(v) => setSelectedModule(v as ModuleKey)}>
              <SelectTrigger data-testid="select-module">
                <SelectValue placeholder="اختر نوع الحركة" />
              </SelectTrigger>
              <SelectContent>
                {MODULES.map(m => (
                  <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">الحالة</label>
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
              <SelectTrigger data-testid="select-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unposted">غير مرحّل</SelectItem>
                <SelectItem value="posted">مرحّل</SelectItem>
                <SelectItem value="all">الكل</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">من تاريخ</label>
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                   data-testid="input-date-from" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">إلى تاريخ</label>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                   data-testid="input-date-to" />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Filter className="absolute start-2 top-1/2 -translate-y-1/2 size-4 text-slate-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)}
                   placeholder="بحث في رقم المستند، الجهة، الوصف، رقم القيد..."
                   className="ps-8" data-testid="input-search" />
          </div>
          {(search || dateFrom || dateTo) && (
            <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setDateFrom(""); setDateTo(""); }}
                    data-testid="button-clear-filters">
              <X className="size-4 me-1" /> مسح الفلاتر
            </Button>
          )}
          <div className="text-xs text-slate-500 ms-auto">
            <span className="font-bold text-slate-700">{filtered.length.toLocaleString("ar-EG")}</span>{" "}
            من <span className="font-bold">{(data?.total ?? 0).toLocaleString("ar-EG")}</span> عملية
          </div>
        </div>
        {truncated && (
          <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-start gap-2"
               data-testid="banner-truncated">
            <AlertTriangle className="size-4 mt-0.5 shrink-0 text-amber-600" />
            <div>
              النتائج كثيرة جدًا — تم عرض أول{" "}
              <span className="font-bold">{serverLimit.toLocaleString("ar-EG")}</span> سجل
              من إجمالي <span className="font-bold">{totalMatched.toLocaleString("ar-EG")}</span>.
              ضيّق نطاق التاريخ أو استخدم البحث للوصول إلى الباقي.
            </div>
          </div>
        )}
      </div>

      {/* Action bar */}
      <div className="rounded-xl border border-teal-200 bg-gradient-to-l from-teal-50 to-white shadow-sm p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => runBulk("post")} disabled={bulkBusy || selected.size === 0}
                  className="bg-teal-600 hover:bg-teal-700 text-white" data-testid="button-bulk-post">
            <Send className="size-4 me-1.5" /> الترحيل
          </Button>
          {(MODULES.find(m => m.key === selectedModule)?.supportsUnpost !== false) && (
            <Button onClick={() => runBulk("unpost")} disabled={bulkBusy || selected.size === 0}
                    variant="outline" className="border-amber-300 text-amber-800 hover:bg-amber-50"
                    data-testid="button-bulk-unpost">
              <Undo2 className="size-4 me-1.5" /> فك الترحيل
            </Button>
          )}
          <div className="h-6 w-px bg-slate-300 mx-1" />
          <Button onClick={selectAllPostable} disabled={bulkBusy}
                  variant="outline" className="border-teal-300 text-teal-800 hover:bg-teal-50"
                  data-testid="button-select-all-postable">
            <CheckSquare className="size-4 me-1.5" /> اظهار الكل
          </Button>
          <Button onClick={clearSelection} disabled={bulkBusy || selected.size === 0}
                  variant="outline" data-testid="button-clear-selection">
            <Square className="size-4 me-1.5" /> الغاء الكل
          </Button>
          <div className="ms-auto flex items-center gap-3 text-sm">
            <span className="text-slate-600">
              المحدد: <span className="font-bold text-teal-700">{selected.size.toLocaleString("ar-EG")}</span>
            </span>
            {selected.size > 0 && (
              <span className="text-slate-600">
                إجمالي المحدد:{" "}
                <span className="font-bold text-teal-700 font-mono">{fmt.fmtMoney(selectedAmount)}</span>
              </span>
            )}
          </div>
        </div>

        {bulkBusy && (
          <div className="mt-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-600">
                {bulkAction === "post" ? "جاري الترحيل..." : "جاري فك الترحيل..."}
                {" — "}
                <span className="font-bold text-teal-700">{bulkProgress.done}</span> / {bulkProgress.total}
                {bulkProgress.failed > 0 && (
                  <span className="text-rose-600"> ({bulkProgress.failed} فشل)</span>
                )}
              </span>
              <Button size="sm" variant="ghost" onClick={() => { cancelRef.current = true; }}
                      data-testid="button-cancel-bulk">
                إيقاف
              </Button>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden">
              <div className="h-full bg-teal-500 transition-all"
                   style={{ width: `${bulkProgress.total ? (bulkProgress.done / bulkProgress.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* Grid */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gradient-to-l from-teal-700 to-teal-800 text-white">
                <th className="px-2 py-2 w-10">
                  <input type="checkbox" checked={allSelected}
                         ref={el => { if (el) el.indeterminate = someSelected; }}
                         onChange={toggleAll}
                         className="size-4 cursor-pointer accent-white"
                         data-testid="checkbox-select-all" />
                </th>
                <th className="px-2 py-2 text-center text-xs font-semibold w-14">#</th>
                <th className="px-2 py-2 text-start text-xs font-semibold">رقم المستند</th>
                <th className="px-2 py-2 text-start text-xs font-semibold">التاريخ</th>
                <th className="px-2 py-2 text-start text-xs font-semibold">النوع</th>
                <th className="px-2 py-2 text-start text-xs font-semibold">الوصف</th>
                <th className="px-2 py-2 text-start text-xs font-semibold">الجهة</th>
                <th className="px-2 py-2 text-end text-xs font-semibold">القيمة</th>
                <th className="px-2 py-2 text-center text-xs font-semibold">الحالة</th>
                <th className="px-2 py-2 text-start text-xs font-semibold">رقم القيد</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={10} className="text-center py-8 text-slate-500">
                    <Loader2 className="size-5 animate-spin inline-block me-2" />
                    جاري التحميل...
                  </td>
                </tr>
              )}
              {!!error && (
                <tr>
                  <td colSpan={10} className="text-center py-8 text-rose-600">
                    <AlertTriangle className="size-5 inline-block me-2" />
                    خطأ في تحميل البيانات
                  </td>
                </tr>
              )}
              {!isLoading && !error && filtered.length === 0 && (
                <tr>
                  <td colSpan={10} className="text-center py-12 text-slate-500">
                    <Info className="size-6 inline-block mb-2 text-slate-400" />
                    <div>لا توجد عمليات{statusFilter === "unposted" ? " غير مرحّلة" : statusFilter === "posted" ? " مرحّلة" : ""} في {moduleLabel}</div>
                  </td>
                </tr>
              )}
              {filtered.map((r, idx) => {
                const isSel = selected.has(r.id);
                return (
                  <tr key={`${r.module}-${r.id}`}
                      onClick={(e) => {
                        const target = e.target as HTMLElement;
                        if (target.closest("button,a,input")) return;
                        toggleRow(r.id);
                      }}
                      className={cn(
                        "border-t border-slate-100 cursor-pointer transition-colors",
                        isSel ? "bg-teal-50" : "hover:bg-slate-50",
                      )}
                      data-testid={`row-${r.module}-${r.id}`}>
                    <td className="px-2 py-1.5 text-center">
                      <input type="checkbox" checked={isSel}
                             onChange={() => toggleRow(r.id)}
                             className="size-4 cursor-pointer accent-teal-600"
                             data-testid={`checkbox-${r.id}`} />
                    </td>
                    <td className="px-2 py-1.5 text-center text-xs text-slate-500">{idx + 1}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">{r.docNumber || "—"}</td>
                    <td className="px-2 py-1.5 text-xs">{r.date}</td>
                    <td className="px-2 py-1.5 text-xs text-slate-600">{r.type}</td>
                    <td className="px-2 py-1.5 text-xs text-slate-600 max-w-[260px] truncate" title={r.description || ""}>
                      {r.description || "—"}
                    </td>
                    <td className="px-2 py-1.5 text-xs">{r.party || "—"}</td>
                    <td className="px-2 py-1.5 text-end font-mono text-xs">
                      {fmt.fmtMoney(r.amount)}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {r.posted ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-800">
                          <ShieldCheck className="size-3" /> مرحّل
                        </span>
                      ) : r.status === "cancelled" ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-100 text-rose-800">
                          ملغى
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800">
                          غير مرحّل
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-xs text-violet-700">
                      {r.journalEntryDocNumber || (r.journalEntryId ? `#${r.journalEntryId}` : "—")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {filtered.length > 0 && (
              <tfoot>
                <tr className="bg-slate-100 font-bold border-t-2 border-slate-300">
                  <td colSpan={7} className="px-2 py-2 text-end text-xs text-slate-700">
                    الإجمالي:
                  </td>
                  <td className="px-2 py-2 text-end font-mono text-sm text-teal-800">
                    {fmt.fmtMoney(totalAmount)}
                  </td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* AI Sheet */}
      <Sheet open={aiOpen} onOpenChange={setAiOpen}>
        <SheetContent side="left" className="w-full sm:max-w-md overflow-y-auto" dir="rtl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Sparkles className="size-5 text-violet-600" />
              تحليل ذكي للترحيل
            </SheetTitle>
            <SheetDescription>
              نظرة سريعة على وضع الترحيل في {moduleLabel} مع تنبيهات ذكية
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-3">
            {aiLoading && (
              <div className="flex items-center justify-center py-12 text-slate-500">
                <Loader2 className="size-5 animate-spin me-2" /> جاري التحليل...
              </div>
            )}
            {!aiLoading && aiSummary && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <StatCard label="الإجمالي" value={aiSummary.counts.total} />
                  <StatCard label="غير مرحّل" value={aiSummary.counts.unposted}
                            tone="amber" />
                  <StatCard label="مرحّل" value={aiSummary.counts.posted} tone="emerald" />
                  <StatCard label="إجمالي غير المرحّل"
                            value={fmt.fmtMoney(aiSummary.totals.unposted)}
                            tone="violet" small />
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                    <Calculator className="size-4" /> ملاحظات وتوصيات
                  </div>
                  <ul className="space-y-2">
                    {aiSummary.insights.map((i, idx) => (
                      <li key={idx} className={cn(
                        "text-xs rounded-md p-2 border-s-4",
                        i.level === "danger"
                          ? "bg-rose-50 border-rose-400 text-rose-900"
                          : i.level === "warning"
                          ? "bg-amber-50 border-amber-400 text-amber-900"
                          : "bg-sky-50 border-sky-400 text-sky-900",
                      )}>
                        {i.message}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─── Small UI helpers ──────────────────────────────────────────────────────
function StatCard({
  label, value, tone, small,
}: {
  label: string;
  value: string | number;
  tone?: "emerald" | "amber" | "violet";
  small?: boolean;
}) {
  const toneClass =
    tone === "emerald" ? "from-emerald-50 to-white border-emerald-200 text-emerald-900"
    : tone === "amber"  ? "from-amber-50 to-white border-amber-200 text-amber-900"
    : tone === "violet" ? "from-violet-50 to-white border-violet-200 text-violet-900"
    : "from-slate-50 to-white border-slate-200 text-slate-900";
  return (
    <div className={cn("rounded-lg border bg-gradient-to-b p-3", toneClass)}>
      <div className="text-[10px] font-medium opacity-70">{label}</div>
      <div className={cn("font-bold mt-0.5", small ? "text-sm font-mono" : "text-lg")}>
        {typeof value === "number" ? value.toLocaleString("ar-EG") : value}
      </div>
    </div>
  );
}
