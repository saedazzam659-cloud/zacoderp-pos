/**
 * SalesAuditGrid
 * ──────────────
 * "الجرد الخارجي لفواتير المبيعات" — wide ERP-style spreadsheet view of all
 * sales invoices for review/audit. Mirrors the dense-grid layout of legacy
 * Saudi accounting software (the second reference screenshot) with many
 * narrow columns visible at once and a sticky dark toolbar at the top.
 *
 * Includes an "AI audit" button that calls POST /api/ai/audit-sales-invoices
 * to surface anomalies (VAT mismatches, missing customers, posted-without-JE,
 * ZATCA rejections, abnormally large totals, old drafts, open receivables)
 * and AI-generated recommendations. The result opens in a side Sheet.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  ArrowRight, RefreshCw, Sparkles, Printer, FileSpreadsheet,
  ListChecks, AlertTriangle, AlertCircle, Info, Loader2, Eye,
  CheckCircle2, FileText, Plus, Send, Undo2, RotateCcw, X, Filter,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Column descriptor ─────────────────────────────────────────────────────
// Drives header, per-column filter row, and footer alignment. Keys match the
// `colFilters` state and the `matchCol()` matcher below.
type ColType = "text" | "num" | "none";
const COLUMNS: ReadonlyArray<{ key: string; label: string; type: ColType; align?: "start" | "center" | "end" }> = [
  { key: "_sel",       label: "",           type: "none",   align: "center" },
  { key: "_idx",       label: "#",          type: "none",   align: "center" },
  { key: "doc",        label: "رقم الفاتورة", type: "text",  align: "center" },
  { key: "date",       label: "التاريخ",    type: "text",   align: "center" },
  { key: "customer",   label: "العميل",     type: "text",   align: "start"  },
  { key: "vat",        label: "الرقم الضريبي", type: "text", align: "center" },
  { key: "branch",     label: "الفرع",      type: "text",   align: "center" },
  { key: "rep",        label: "المندوب",    type: "text",   align: "center" },
  { key: "payment",    label: "نوع الدفع",  type: "text",   align: "center" },
  { key: "currency",   label: "العملة",     type: "text",   align: "center" },
  { key: "subtotal",   label: "المجموع",    type: "num",    align: "end"    },
  { key: "discount",   label: "الخصم",      type: "num",    align: "end"    },
  { key: "vatAmt",     label: "الضريبة",    type: "num",    align: "end"    },
  { key: "total",      label: "الإجمالي",   type: "num",    align: "end"    },
  { key: "commission", label: "العمولة",    type: "num",    align: "end"    },
  { key: "settle",     label: "حالة السداد", type: "text",  align: "center" },
  { key: "je",         label: "القيد",      type: "text",   align: "center" },
  { key: "zatca",      label: "ZATCA",      type: "text",   align: "center" },
  { key: "status",     label: "الحالة",     type: "text",   align: "center" },
  { key: "notes",      label: "ملاحظات",    type: "text",   align: "start"  },
  { key: "_act",       label: "",           type: "none",   align: "center" },
];

// Numeric filter: supports `>=N`, `<=N`, `>N`, `<N`, `=N`, or plain substring.
function matchCol(raw: any, q: string, type: ColType): boolean {
  const filter = q.trim();
  if (!filter) return true;
  if (type === "num") {
    const m = filter.match(/^\s*(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)\s*$/);
    const num = Number(raw ?? 0);
    if (m) {
      const op = m[1]; const v = Number(m[2]);
      if (Number.isNaN(num) || Number.isNaN(v)) return false;
      switch (op) {
        case ">=": return num >= v;
        case "<=": return num <= v;
        case ">":  return num >  v;
        case "<":  return num <  v;
        case "=":  return Math.abs(num - v) < 1e-9;
      }
    }
    return String(num).includes(filter);
  }
  return String(raw ?? "").toLowerCase().includes(filter.toLowerCase());
}

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Finding = {
  level: "error" | "warning" | "info";
  code: string;
  invoiceId?: number;
  docNumber?: string;
  message: string;
  fix?: string;
};

type AuditResponse = {
  findings: Finding[];
  metrics: {
    totalInvoices: number;
    totalPosted: number;
    totalDrafts: number;
    totalCancelled: number;
    sumPosted: number;
    sumDraft: number;
    sumVat: number;
    median: number;
    issuesCount: number;
    warningsCount: number;
  };
  recommendations: string[];
  source: "ai+rules" | "rules";
};

export default function SalesAuditGrid() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const { fmt, isRtl } = useFormatters();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const isAdmin = user?.role === "admin" || user?.role === "superadmin";
  const authH = { Authorization: `Bearer ${token}` };
  const headers = { ...authH, "Content-Type": "application/json" };

  // ── Filters ────────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "posted" | "cancelled">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [showColFilters, setShowColFilters] = useState(false);

  // ── Selection ─────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // ── AI audit state ─────────────────────────────────────────────────────
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [findingFilter, setFindingFilter] = useState<"all" | "error" | "warning" | "info">("all");

  // ── Data ───────────────────────────────────────────────────────────────
  // Helper: GET that always returns an array, never throws on bad shape.
  // The API may return an error object on auth/permission failure; without this
  // guard the UI would crash on `.filter`/`.map` further down.
  async function getList(url: string): Promise<any[]> {
    try {
      const r = await fetch(url, { headers: authH });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      return Array.isArray(data) ? data : [];
    } catch (e: any) {
      throw new Error(e?.message || "فشل تحميل البيانات");
    }
  }

  const { data: invoices = [], isLoading, refetch, isFetching, error: invoicesError } = useQuery<any[]>({
    queryKey: ["sales-invoices", cid, "audit-grid"],
    queryFn: () => getList(cid ? `${API}/api/sales/sales-invoices?companyId=${cid}` : `${API}/api/sales/sales-invoices`),
    enabled: !!user,
  });

  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: () => getList(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`),
    enabled: !!user,
  });

  const { data: salesReps = [] } = useQuery<any[]>({
    queryKey: ["sales-reps-audit", cid],
    queryFn: () => getList(cid ? `${API}/api/sales-reps?companyId=${cid}` : `${API}/api/sales-reps`),
    enabled: !!user,
  });

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches-audit", cid],
    queryFn: () => getList(cid ? `${API}/api/branches?companyId=${cid}` : `${API}/api/branches`).catch(() => []),
    enabled: !!user,
  });

  // ── Lookup maps ───────────────────────────────────────────────────────
  const cusMap = useMemo(() => Object.fromEntries(customers.map((c: any) => [c.id, { name: c.nameAr ?? c.nameEn, vat: c.vatNumber, phone: c.phone }])), [customers]);
  const repMap = useMemo(() => Object.fromEntries(salesReps.map((r: any) => [r.id, r.nameAr ?? r.nameEn])), [salesReps]);
  const branchMap = useMemo(() => Object.fromEntries(branches.map((b: any) => [b.id, b.nameAr ?? b.nameEn ?? b.name])), [branches]);

  // ── Filtering ─────────────────────────────────────────────────────────
  // Two layers: top-bar (search/status/date) AND per-column filters (Excel-like).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const PAY_AR: Record<string, string> = { cash: "نقدي", bank: "بنكي", credit: "آجل" };
    const STATUS_AR: Record<string, string> = { draft: "مسودة", posted: "مُرحَّل", cancelled: "ملغاة" };

    return invoices.filter((inv: any) => {
      const cusName = cusMap[inv.customerId]?.name ?? "";

      // top-bar filters
      const matchText = !q
        || (inv.docNumber ?? "").toLowerCase().includes(q)
        || cusName.toLowerCase().includes(q)
        || (inv.notes ?? "").toLowerCase().includes(q);
      const matchStatus = statusFilter === "all" || inv.status === statusFilter;
      const matchFrom = !dateFrom || (inv.invoiceDate >= dateFrom);
      const matchTo   = !dateTo   || (inv.invoiceDate <= dateTo);
      if (!(matchText && matchStatus && matchFrom && matchTo)) return false;

      // column filters
      for (const col of COLUMNS) {
        const fv = colFilters[col.key];
        if (!fv) continue;
        let cellValue: any = "";
        switch (col.key) {
          case "doc":        cellValue = inv.docNumber ?? `SI-${inv.id}`; break;
          case "date":       cellValue = inv.invoiceDate; break;
          case "customer":   cellValue = cusName; break;
          case "vat":        cellValue = cusMap[inv.customerId]?.vat ?? ""; break;
          case "branch":     cellValue = branchMap[inv.branchId] ?? ""; break;
          case "rep":        cellValue = repMap[inv.salesRepId] ?? ""; break;
          case "payment":    cellValue = PAY_AR[inv.paymentType] ?? inv.paymentType ?? ""; break;
          case "currency":   cellValue = inv.currencyCode ?? ""; break;
          case "subtotal":   cellValue = inv.subtotal; break;
          case "discount":   cellValue = inv.discountAmount; break;
          case "vatAmt":     cellValue = inv.vatAmount; break;
          case "total":      cellValue = inv.totalAmount; break;
          case "commission": cellValue = inv.commissionAmount ?? 0; break;
          case "settle":     cellValue = inv.paymentSettlement?.code ?? ""; break;
          case "je":         cellValue = inv.journalEntryId ? `JE-${inv.journalEntryId}` : ""; break;
          case "zatca":      cellValue = inv.zatcaStatus ?? ""; break;
          case "status":     cellValue = STATUS_AR[inv.status] ?? inv.status ?? ""; break;
          case "notes":      cellValue = inv.notes ?? ""; break;
        }
        if (!matchCol(cellValue, fv, col.type)) return false;
      }
      return true;
    });
  }, [invoices, search, statusFilter, dateFrom, dateTo, cusMap, branchMap, repMap, colFilters]);

  // ── Selection helpers ─────────────────────────────────────────────────
  const allFilteredIds = useMemo(() => filtered.map((i: any) => i.id), [filtered]);
  const allSelected = allFilteredIds.length > 0 && allFilteredIds.every((id: number) => selected.has(id));
  const someSelected = allFilteredIds.some((id: number) => selected.has(id)) && !allSelected;

  function toggleRow(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (allSelected) {
      setSelected(prev => {
        const next = new Set(prev);
        for (const id of allFilteredIds) next.delete(id);
        return next;
      });
    } else {
      setSelected(prev => {
        const next = new Set(prev);
        for (const id of allFilteredIds) next.add(id);
        return next;
      });
    }
  }
  function clearSelection() { setSelected(new Set()); }
  function clearColFilters() { setColFilters({}); }
  function setColFilter(key: string, value: string) {
    setColFilters(prev => ({ ...prev, [key]: value }));
  }

  // Selected invoices, partitioned by status for the bulk actions
  const selectedInvoices = useMemo(
    () => invoices.filter((i: any) => selected.has(i.id)),
    [invoices, selected],
  );
  const selectedDrafts = selectedInvoices.filter((i: any) => i.status === "draft");
  const selectedPosted = selectedInvoices.filter((i: any) => i.status === "posted");

  // ── Bulk actions ──────────────────────────────────────────────────────
  async function bulkPatch(ids: number[], path: "post" | "unpost"): Promise<{ ok: number; failed: Array<{ id: number; error: string }> }> {
    const results = await Promise.allSettled(
      ids.map(async id => {
        const r = await fetch(`${API}/api/sales/sales-invoices/${id}/${path}`, { method: "PATCH", headers });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }
      })
    );
    const failed = results
      .map((res, i) => ({ res, id: ids[i] }))
      .filter(x => x.res.status === "rejected")
      .map(x => ({ id: x.id, error: (x.res as PromiseRejectedResult).reason?.message ?? "خطأ" }));
    return { ok: ids.length - failed.length, failed };
  }

  async function bulkPost() {
    const ids = selectedDrafts.map((i: any) => i.id);
    if (ids.length === 0) {
      toast({ title: "لا توجد فواتير مسوّدة ضمن المحدَّد", variant: "destructive" });
      return;
    }
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkPatch(ids, "post");
      if (failed.length === 0) {
        toast({ title: `تم ترحيل ${ok} فاتورة بنجاح` });
        clearSelection();
      } else {
        toast({
          title: `ترحيل: ${ok} نجح، ${failed.length} فشل`,
          description: failed.slice(0, 3).map(f => `#${f.id}: ${f.error}`).join(" • "),
          variant: "destructive",
        });
      }
      qc.invalidateQueries({ queryKey: ["sales-invoices", cid, "audit-grid"] });
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkUnpost() {
    const ids = selectedPosted.map((i: any) => i.id);
    if (ids.length === 0) {
      toast({ title: "لا توجد فواتير مرحَّلة ضمن المحدَّد", variant: "destructive" });
      return;
    }
    if (!window.confirm(`فك ترحيل ${ids.length} فاتورة؟ سيتم حذف القيود المحاسبية المرتبطة.`)) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkPatch(ids, "unpost");
      if (failed.length === 0) {
        toast({ title: `تم فك ترحيل ${ok} فاتورة` });
        clearSelection();
      } else {
        toast({
          title: `فك الترحيل: ${ok} نجح، ${failed.length} فشل`,
          description: failed.slice(0, 3).map(f => `#${f.id}: ${f.error}`).join(" • "),
          variant: "destructive",
        });
      }
      qc.invalidateQueries({ queryKey: ["sales-invoices", cid, "audit-grid"] });
    } finally {
      setBulkBusy(false);
    }
  }

  function goReturn() {
    if (selected.size !== 1) {
      toast({ title: "يجب تحديد فاتورة واحدة فقط لإنشاء مرتجع", variant: "destructive" });
      return;
    }
    const inv = selectedInvoices[0];
    navigate(`/sales/returns?fromInvoice=${inv.id}`);
  }

  // ── Footer totals ─────────────────────────────────────────────────────
  const totals = useMemo(() => {
    return filtered.reduce((acc, inv: any) => {
      acc.subtotal += Number(inv.subtotal ?? 0);
      acc.discount += Number(inv.discountAmount ?? 0);
      acc.vat      += Number(inv.vatAmount ?? 0);
      acc.total    += Number(inv.totalAmount ?? 0);
      acc.commission += Number(inv.commissionAmount ?? 0);
      return acc;
    }, { subtotal: 0, discount: 0, vat: 0, total: 0, commission: 0 });
  }, [filtered]);

  // ── AI audit trigger ──────────────────────────────────────────────────
  async function runAudit() {
    if (filtered.length === 0) {
      toast({ title: "لا توجد فواتير ضمن التصفية الحالية", variant: "destructive" });
      return;
    }
    try {
      setAuditing(true);
      setAuditOpen(true);
      const payload = filtered.map((inv: any) => ({
        id: inv.id,
        docNumber: inv.docNumber,
        invoiceDate: inv.invoiceDate,
        customerId: inv.customerId,
        customerName: cusMap[inv.customerId]?.name,
        paymentType: inv.paymentType,
        subtotal: inv.subtotal,
        discountAmount: inv.discountAmount,
        vatAmount: inv.vatAmount,
        totalAmount: inv.totalAmount,
        status: inv.status,
        zatcaStatus: inv.zatcaStatus,
        zatcaResponseCode: inv.zatcaResponseCode,
        journalEntryId: inv.journalEntryId,
        paymentSettlement: inv.paymentSettlement ? { code: inv.paymentSettlement.code } : null,
      }));
      const r = await fetch(`${API}/api/ai/audit-sales-invoices`, {
        method: "POST",
        headers,
        body: JSON.stringify({ invoices: payload, currencyCode: "SAR" }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const data: AuditResponse = await r.json();
      setAudit(data);
    } catch (e: any) {
      toast({ title: e?.message ?? "فشل تشغيل التدقيق الذكي", variant: "destructive" });
      setAuditOpen(false);
    } finally {
      setAuditing(false);
    }
  }

  // ── CSV Export ────────────────────────────────────────────────────────
  function exportCsv() {
    if (filtered.length === 0) {
      toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" });
      return;
    }
    const header = [
      "#","رقم الفاتورة","التاريخ","العميل","الرقم الضريبي","الفرع","المندوب",
      "نوع الدفع","العملة","المجموع","الخصم","الضريبة","الإجمالي","العمولة",
      "حالة السداد","القيد","ZATCA","الحالة","ملاحظات",
    ];
    const rows = filtered.map((inv: any, idx: number) => [
      idx + 1,
      inv.docNumber ?? `SI-${inv.id}`,
      inv.invoiceDate ?? "",
      cusMap[inv.customerId]?.name ?? "",
      cusMap[inv.customerId]?.vat ?? "",
      branchMap[inv.branchId] ?? "",
      repMap[inv.salesRepId] ?? "",
      inv.paymentType === "cash" ? "نقدي" : inv.paymentType === "bank" ? "بنكي" : "آجل",
      inv.currencyCode ?? "SAR",
      Number(inv.subtotal ?? 0).toFixed(2),
      Number(inv.discountAmount ?? 0).toFixed(2),
      Number(inv.vatAmount ?? 0).toFixed(2),
      Number(inv.totalAmount ?? 0).toFixed(2),
      Number(inv.commissionAmount ?? 0).toFixed(2),
      inv.paymentSettlement ? `سُدِّد (${inv.paymentSettlement.code})` : "—",
      inv.journalEntryId ? `JE-${inv.journalEntryId}` : "—",
      inv.zatcaStatus ?? "—",
      inv.status,
      (inv.notes ?? "").replace(/[\r\n,]/g, " "),
    ]);
    const csv = [header, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `sales-audit-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast({ title: "تم تصدير ملف CSV بنجاح" });
  }

  // ── Status & ZATCA pills ──────────────────────────────────────────────
  const STATUS: Record<string, { label: string; cls: string }> = {
    draft:     { label: "مسودة",   cls: "bg-amber-100 text-amber-800 border-amber-300" },
    posted:    { label: "مُرحَّل", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
    cancelled: { label: "ملغاة",   cls: "bg-slate-200 text-slate-700 border-slate-300" },
  };
  const ZATCA: Record<string, { label: string; cls: string }> = {
    pending:  { label: "بانتظار", cls: "bg-slate-100 text-slate-600 border-slate-300" },
    approved: { label: "مقبول",   cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
    rejected: { label: "مرفوض",  cls: "bg-rose-100 text-rose-800 border-rose-300" },
  };

  const filteredFindings = audit?.findings.filter(f =>
    findingFilter === "all" ? true : f.level === findingFilter
  ) ?? [];

  return (
    <div className="space-y-3" dir={isRtl ? "rtl" : "ltr"}>
      {/* ─── Top dark toolbar (legacy ERP look) ───────────────────────── */}
      <div className="rounded-t-lg overflow-hidden border border-rose-900/30 shadow-sm">
        <div className="bg-gradient-to-l from-rose-900 via-rose-800 to-rose-900 text-white px-3 py-2 flex items-center gap-2 flex-wrap">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-white hover:bg-white/15 hover:text-white text-xs gap-1"
            onClick={() => navigate("/sales/invoices")}
          >
            <ArrowRight className="h-3.5 w-3.5" />
            رجوع
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-3 text-xs gap-1 bg-emerald-500 hover:bg-emerald-400 text-white border border-emerald-300/60 font-bold shadow-sm"
            onClick={() => navigate("/sales/invoices/new")}
            title="إنشاء فاتورة مبيعات جديدة"
          >
            <Plus className="h-3.5 w-3.5" />
            فاتورة جديدة
          </Button>
          <div className="flex-1 text-center text-sm font-bold tracking-wide flex items-center justify-center gap-2">
            <FileSpreadsheet className="h-4 w-4 opacity-90" />
            الجرد الخارجي لفواتير المبيعات — مراجعة وتدقيق شامل
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn(
                "h-7 px-2 text-white hover:bg-white/15 hover:text-white text-xs gap-1",
                showColFilters && "bg-white/20",
              )}
              onClick={() => setShowColFilters(s => !s)}
              title="إظهار/إخفاء فلاتر الأعمدة"
            >
              <Filter className="h-3.5 w-3.5" />
              فلاتر الأعمدة
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-white hover:bg-white/15 hover:text-white text-xs gap-1"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              تحديث
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-white hover:bg-white/15 hover:text-white text-xs gap-1"
              onClick={exportCsv}
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              تصدير CSV
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-white hover:bg-white/15 hover:text-white text-xs gap-1"
              onClick={() => window.print()}
            >
              <Printer className="h-3.5 w-3.5" />
              طباعة
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 px-3 text-xs gap-1 bg-purple-600 hover:bg-purple-500 text-white border border-purple-300/50"
              onClick={runAudit}
              disabled={auditing || filtered.length === 0}
            >
              {auditing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              تدقيق بالذكاء الاصطناعي
            </Button>
          </div>
        </div>

        {/* ─── Filter strip ────────────────────────────────────────────── */}
        <div className="bg-slate-50 border-t border-slate-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs">
          <Input
            placeholder="بحث (رقم فاتورة، عميل، ملاحظات)…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-7 text-xs w-56"
          />
          <div className="flex gap-1">
            {(["all","draft","posted","cancelled"] as const).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={cn(
                  "px-2 py-1 rounded text-[11px] font-medium border transition-colors",
                  statusFilter === s
                    ? "bg-rose-700 text-white border-rose-800"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100",
                )}
              >
                {s === "all" ? "الكل" : STATUS[s]?.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-600">من:</span>
            <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-7 text-xs w-32" />
            <span className="text-slate-600">إلى:</span>
            <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-7 text-xs w-32" />
            {(dateFrom || dateTo) && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => { setDateFrom(""); setDateTo(""); }}
              >
                مسح
              </Button>
            )}
          </div>
          {Object.values(colFilters).some(v => v) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50"
              onClick={clearColFilters}
              title="مسح فلاتر الأعمدة"
            >
              <X className="h-3.5 w-3.5 me-1" />
              مسح فلاتر الأعمدة
            </Button>
          )}
          <div className="flex-1" />
          <span className="text-slate-700 font-medium">
            {filtered.length} فاتورة
            {filtered.length !== invoices.length && <span className="text-slate-400"> / {invoices.length}</span>}
          </span>
        </div>

        {/* ─── Bulk action bar (visible when any row selected) ─────────── */}
        {selected.size > 0 && (
          <div className="bg-emerald-50 border-t border-emerald-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs animate-in fade-in slide-in-from-top-1">
            <span className="font-bold text-emerald-900 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" />
              {selected.size} محدَّد
            </span>
            <div className="h-5 w-px bg-emerald-300 mx-1" />
            <Button
              type="button"
              size="sm"
              className="h-7 px-3 text-xs gap-1 bg-emerald-700 hover:bg-emerald-600 text-white"
              onClick={bulkPost}
              disabled={bulkBusy || selectedDrafts.length === 0}
              title={selectedDrafts.length === 0 ? "لا توجد مسوّدات ضمن المحدَّد" : `ترحيل ${selectedDrafts.length} مسوّدة`}
            >
              {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              ترحيل ({selectedDrafts.length})
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-3 text-xs gap-1 border-amber-400 text-amber-800 hover:bg-amber-50"
              onClick={bulkUnpost}
              disabled={bulkBusy || selectedPosted.length === 0 || !isAdmin}
              title={
                !isAdmin
                  ? "فك الترحيل متاح للمدير فقط"
                  : selectedPosted.length === 0
                    ? "لا توجد فواتير مُرحَّلة ضمن المحدَّد"
                    : `فك ترحيل ${selectedPosted.length} فاتورة`
              }
            >
              <Undo2 className="h-3.5 w-3.5" />
              فك الترحيل ({selectedPosted.length})
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-3 text-xs gap-1 border-rose-400 text-rose-800 hover:bg-rose-50"
              onClick={goReturn}
              disabled={bulkBusy || selected.size !== 1}
              title={selected.size === 1 ? "إنشاء مرتجع من الفاتورة المحدَّدة" : "حدِّد فاتورة واحدة فقط"}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              ارتجاع
            </Button>
            <div className="flex-1" />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-slate-600 hover:bg-slate-100"
              onClick={clearSelection}
              disabled={bulkBusy}
            >
              <X className="h-3.5 w-3.5 me-1" />
              إلغاء التحديد
            </Button>
          </div>
        )}
      </div>

      {/* ─── Wide spreadsheet grid ─────────────────────────────────────── */}
      <div className="border border-slate-300 rounded-b-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 240px)" }}>
          {invoicesError ? (
            <div className="p-12 text-center">
              <AlertCircle className="h-10 w-10 text-rose-500 mx-auto mb-3" />
              <p className="text-rose-700 text-sm font-medium mb-1">تعذّر تحميل الفواتير</p>
              <p className="text-muted-foreground text-xs">{(invoicesError as Error)?.message ?? "خطأ غير معروف"}</p>
              <Button size="sm" variant="outline" className="mt-4 gap-2" onClick={() => refetch()}>
                <RefreshCw className="h-3.5 w-3.5" />
                إعادة المحاولة
              </Button>
            </div>
          ) : isLoading ? (
            <div className="p-12 text-center text-muted-foreground text-sm">جاري التحميل…</div>
          ) : filtered.length === 0 ? (
            <div className="p-12 text-center">
              <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
              <p className="text-muted-foreground text-sm">لا توجد فواتير ضمن التصفية الحالية</p>
            </div>
          ) : (
            <table className="w-full text-[11px] border-collapse" dir={isRtl ? "rtl" : "ltr"}>
              <thead className="sticky top-0 z-10">
                <tr className="bg-gradient-to-b from-slate-100 to-slate-200 text-slate-700">
                  {COLUMNS.map(col => (
                    <th
                      key={col.key}
                      className="px-2 py-1.5 border border-slate-300 text-center font-semibold whitespace-nowrap text-[10.5px]"
                    >
                      {col.key === "_sel" ? (
                        <input
                          type="checkbox"
                          aria-label="تحديد الكل"
                          checked={allSelected}
                          ref={el => { if (el) el.indeterminate = someSelected; }}
                          onChange={toggleAll}
                          className="cursor-pointer h-3.5 w-3.5 accent-rose-600"
                        />
                      ) : col.label}
                    </th>
                  ))}
                </tr>
                {showColFilters && (
                  <tr className="bg-amber-50/80 border-b border-amber-200">
                    {COLUMNS.map(col => (
                      <th
                        key={col.key}
                        className="px-1 py-1 border border-slate-200 text-center"
                      >
                        {col.type === "none" ? null : (
                          <Input
                            value={colFilters[col.key] ?? ""}
                            onChange={e => setColFilter(col.key, e.target.value)}
                            placeholder={col.type === "num" ? ">=100" : "بحث…"}
                            className="h-6 text-[10.5px] px-1.5 border-slate-300 bg-white"
                            title={col.type === "num" ? "أمثلة: >=100, <500, =0" : "بحث جزئي"}
                          />
                        )}
                      </th>
                    ))}
                  </tr>
                )}
              </thead>
              <tbody>
                {filtered.map((inv: any, idx: number) => {
                  const cus = cusMap[inv.customerId];
                  const st = STATUS[inv.status] ?? STATUS.draft;
                  const z = ZATCA[String(inv.zatcaStatus ?? "pending")] ?? null;
                  const payLabel = inv.paymentType === "cash" ? "نقدي" : inv.paymentType === "bank" ? "بنكي" : "آجل";
                  const isSel = selected.has(inv.id);
                  return (
                    <tr
                      key={inv.id}
                      className={cn(
                        "transition-colors cursor-pointer",
                        isSel ? "bg-emerald-100/70 hover:bg-emerald-100" : "hover:bg-amber-50/60",
                      )}
                      onClick={(e) => {
                        // Don't toggle when clicking interactive children (links, buttons, inputs).
                        const tag = (e.target as HTMLElement).tagName;
                        if (tag === "BUTTON" || tag === "INPUT" || tag === "A" || (e.target as HTMLElement).closest("button,a,input")) return;
                        toggleRow(inv.id);
                      }}
                      onDoubleClick={() => navigate(`/sales/invoices/${inv.id}`)}
                      title="اضغط لتحديد الصف، أو مرتين لفتح الفاتورة"
                    >
                      <td className="px-2 py-1 border border-slate-200 text-center">
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggleRow(inv.id)}
                          onClick={e => e.stopPropagation()}
                          className="cursor-pointer h-3.5 w-3.5 accent-rose-600"
                          aria-label={`تحديد الفاتورة ${inv.docNumber ?? inv.id}`}
                        />
                      </td>
                      <td className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{idx + 1}</td>
                      <td className="px-2 py-1 border border-slate-200 font-mono font-semibold text-rose-700 text-center">{inv.docNumber ?? `SI-${inv.id}`}</td>
                      <td className="px-2 py-1 border border-slate-200 text-center whitespace-nowrap">{inv.invoiceDate}</td>
                      <td className="px-2 py-1 border border-slate-200 max-w-[180px] truncate" title={cus?.name ?? ""}>{cus?.name ?? "—"}</td>
                      <td className="px-2 py-1 border border-slate-200 font-mono text-[10px] text-slate-600 text-center">{cus?.vat ?? "—"}</td>
                      <td className="px-2 py-1 border border-slate-200 text-center text-slate-600">{branchMap[inv.branchId] ?? "—"}</td>
                      <td className="px-2 py-1 border border-slate-200 text-center text-slate-600 max-w-[120px] truncate" title={repMap[inv.salesRepId] ?? ""}>{repMap[inv.salesRepId] ?? "—"}</td>
                      <td className="px-2 py-1 border border-slate-200 text-center text-slate-600">{payLabel}</td>
                      <td className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{inv.currencyCode}</td>
                      <td className="px-2 py-1 border border-slate-200 text-end font-mono">{fmt(inv.subtotal)}</td>
                      <td className="px-2 py-1 border border-slate-200 text-end font-mono text-orange-700">{fmt(inv.discountAmount)}</td>
                      <td className="px-2 py-1 border border-slate-200 text-end font-mono text-amber-700">{fmt(inv.vatAmount)}</td>
                      <td className="px-2 py-1 border border-slate-200 text-end font-mono font-bold text-slate-900">{fmt(inv.totalAmount)}</td>
                      <td className="px-2 py-1 border border-slate-200 text-end font-mono text-purple-700">{fmt(inv.commissionAmount ?? 0)}</td>
                      <td className="px-2 py-1 border border-slate-200 text-center">
                        {inv.paymentSettlement ? (
                          <span className="inline-flex items-center text-[10px] rounded px-1.5 py-0.5 font-medium border bg-blue-50 text-blue-700 border-blue-200" title={inv.paymentSettlement.code}>
                            ✓ {inv.paymentSettlement.code}
                          </span>
                        ) : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-2 py-1 border border-slate-200 text-center">
                        {inv.journalEntryId ? (
                          <button onClick={() => navigate(`/accounting/journals/${inv.journalEntryId}?tab=lines`)} className="font-mono text-[10px] text-blue-600 hover:underline">
                            JE-{inv.journalEntryId}
                          </button>
                        ) : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-2 py-1 border border-slate-200 text-center">
                        {z ? <span className={cn("inline-flex items-center text-[10px] rounded px-1.5 py-0.5 font-medium border", z.cls)}>{z.label}</span> : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-2 py-1 border border-slate-200 text-center">
                        <span className={cn("inline-flex items-center text-[10px] rounded px-1.5 py-0.5 font-medium border", st.cls)}>{st.label}</span>
                      </td>
                      <td className="px-2 py-1 border border-slate-200 text-slate-600 max-w-[140px] truncate" title={inv.notes ?? ""}>{inv.notes ?? "—"}</td>
                      <td className="px-2 py-1 border border-slate-200 text-center">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          title="فتح"
                          onClick={() => navigate(`/sales/invoices/${inv.id}`)}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="sticky bottom-0">
                <tr className="bg-slate-800 text-white text-[11px] font-semibold">
                  {/* 10 leading cells: _sel, _idx, doc, date, customer, vat, branch, rep, payment, currency */}
                  <td colSpan={10} className="px-2 py-2 border border-slate-700 text-end">الإجمالي:</td>
                  <td className="px-2 py-2 border border-slate-700 text-end font-mono">{fmt(totals.subtotal)}</td>
                  <td className="px-2 py-2 border border-slate-700 text-end font-mono text-orange-300">{fmt(totals.discount)}</td>
                  <td className="px-2 py-2 border border-slate-700 text-end font-mono text-amber-300">{fmt(totals.vat)}</td>
                  <td className="px-2 py-2 border border-slate-700 text-end font-mono">{fmt(totals.total)}</td>
                  <td className="px-2 py-2 border border-slate-700 text-end font-mono text-purple-300">{fmt(totals.commission)}</td>
                  {/* 6 trailing cells: settle, je, zatca, status, notes, _act */}
                  <td colSpan={6} className="px-2 py-2 border border-slate-700" />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>

      {/* ─── AI Audit Sheet (slide-out drawer) ───────────────────────────── */}
      <Sheet open={auditOpen} onOpenChange={setAuditOpen}>
        <SheetContent
          side={isRtl ? "left" : "right"}
          className="w-full sm:max-w-xl overflow-y-auto p-0"
        >
          <div className="bg-gradient-to-l from-purple-700 to-purple-600 text-white p-4">
            <SheetHeader>
              <SheetTitle className="text-white flex items-center gap-2">
                <Sparkles className="h-5 w-5" />
                التدقيق الذكي للفواتير
              </SheetTitle>
              <SheetDescription className="text-white/80">
                {auditing
                  ? "يقوم الذكاء الاصطناعي الآن بفحص فواتيرك..."
                  : audit
                    ? `${audit.findings.length} ملاحظة (${audit.metrics.issuesCount} حرجة + ${audit.metrics.warningsCount} تحذير)`
                    : "ابدأ التدقيق لاكتشاف الأخطاء والشذوذ في فواتيرك"}
              </SheetDescription>
            </SheetHeader>
          </div>

          <div className="p-4 space-y-4">
            {auditing && (
              <div className="p-8 text-center">
                <Loader2 className="h-8 w-8 animate-spin text-purple-600 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">يحلّل الذكاء الاصطناعي {filtered.length} فاتورة…</p>
              </div>
            )}

            {audit && !auditing && (
              <>
                {/* Metric tiles */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-center">
                    <div className="text-2xl font-bold text-rose-700 font-mono">{audit.metrics.issuesCount}</div>
                    <div className="text-[10px] text-rose-700 font-medium">مشاكل حرجة</div>
                  </div>
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-center">
                    <div className="text-2xl font-bold text-amber-700 font-mono">{audit.metrics.warningsCount}</div>
                    <div className="text-[10px] text-amber-700 font-medium">تحذيرات</div>
                  </div>
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-center">
                    <div className="text-2xl font-bold text-emerald-700 font-mono">{audit.metrics.totalPosted}</div>
                    <div className="text-[10px] text-emerald-700 font-medium">فواتير مُرحَّلة</div>
                  </div>
                </div>

                {/* Recommendations */}
                {audit.recommendations.length > 0 && (
                  <div className="rounded-lg border border-purple-200 bg-purple-50 p-3">
                    <div className="flex items-center gap-2 mb-2 text-purple-900 font-semibold text-sm">
                      <Sparkles className="h-4 w-4" />
                      توصيات
                    </div>
                    <ul className="space-y-1.5 text-xs text-purple-900/90 leading-relaxed list-disc pe-5">
                      {audit.recommendations.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Findings filter pills */}
                {audit.findings.length > 0 && (
                  <>
                    <div className="flex gap-1 flex-wrap items-center">
                      <span className="text-xs text-muted-foreground me-2 flex items-center gap-1">
                        <ListChecks className="h-3.5 w-3.5" />
                        الملاحظات:
                      </span>
                      {[
                        { v: "all" as const,     label: "الكل",     n: audit.findings.length, cls: "bg-slate-700 text-white" },
                        { v: "error" as const,   label: "حرجة",    n: audit.metrics.issuesCount, cls: "bg-rose-600 text-white" },
                        { v: "warning" as const, label: "تحذير",   n: audit.metrics.warningsCount, cls: "bg-amber-600 text-white" },
                        { v: "info" as const,    label: "معلومات", n: audit.findings.filter(f => f.level === "info").length, cls: "bg-blue-600 text-white" },
                      ].map(b => (
                        <button
                          key={b.v}
                          onClick={() => setFindingFilter(b.v)}
                          className={cn(
                            "text-[11px] rounded-full px-2.5 py-0.5 border font-medium",
                            findingFilter === b.v ? b.cls : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50",
                          )}
                        >
                          {b.label} ({b.n})
                        </button>
                      ))}
                    </div>

                    <div className="space-y-2">
                      {filteredFindings.length === 0 ? (
                        <div className="text-center py-8">
                          <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
                          <p className="text-sm text-muted-foreground">لا توجد ملاحظات في هذه الفئة</p>
                        </div>
                      ) : (
                        filteredFindings.map((f, i) => {
                          const Icon = f.level === "error" ? AlertCircle : f.level === "warning" ? AlertTriangle : Info;
                          const cls = f.level === "error"
                            ? "border-rose-200 bg-rose-50"
                            : f.level === "warning"
                              ? "border-amber-200 bg-amber-50"
                              : "border-blue-200 bg-blue-50";
                          const iconCls = f.level === "error"
                            ? "text-rose-600"
                            : f.level === "warning"
                              ? "text-amber-600"
                              : "text-blue-600";
                          return (
                            <div key={i} className={cn("rounded-lg border p-2.5 text-xs", cls)}>
                              <div className="flex items-start gap-2">
                                <Icon className={cn("h-4 w-4 flex-shrink-0 mt-0.5", iconCls)} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                                    {f.docNumber && f.invoiceId && (
                                      <button
                                        onClick={() => { setAuditOpen(false); navigate(`/sales/invoices/${f.invoiceId}`); }}
                                        className="font-mono font-semibold text-rose-700 hover:underline"
                                      >
                                        {f.docNumber}
                                      </button>
                                    )}
                                    <span className="text-[9px] font-mono text-slate-500 bg-white border border-slate-200 px-1 py-0.5 rounded">{f.code}</span>
                                  </div>
                                  <div className="text-slate-800 leading-relaxed">{f.message}</div>
                                  {f.fix && (
                                    <div className="mt-1.5 text-[11px] text-slate-600 bg-white/60 border border-slate-200 rounded p-1.5">
                                      <span className="font-semibold text-slate-700">الإصلاح:</span> {f.fix}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </>
                )}

                {audit.findings.length === 0 && (
                  <div className="text-center py-8 rounded-lg border border-emerald-200 bg-emerald-50">
                    <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto mb-2" />
                    <p className="text-sm font-semibold text-emerald-800">ممتاز! لم نجد أي ملاحظات</p>
                    <p className="text-xs text-emerald-700 mt-1">كل فواتيرك تبدو سليمة محاسبياً وضريبياً.</p>
                  </div>
                )}

                <div className="text-[10px] text-slate-400 text-center pt-2 border-t border-slate-100">
                  مصدر التحليل: {audit.source === "ai+rules" ? "ذكاء اصطناعي + قواعد محاسبية" : "قواعد محاسبية"}
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
