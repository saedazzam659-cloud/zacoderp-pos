// Standalone "المستخلصات" screen — company-wide progress-bills view across
// every project. Read-only list with KPI cards + filters; create/edit still
// happens inside the project (تفاصيل المشروع → تبويب المستخلصات) because
// every bill is anchored to a project.
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { usePermission } from "@/hooks/usePermission";
import {
  FileText, ArrowDownToLine, ArrowUpFromLine, ExternalLink, Filter, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { DateField } from "@/components/ui/date-field";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { BILL_DIRECTION_LABEL, BILL_STATUS_LABEL, BILL_TYPE_LABEL, labelEnum } from "@/lib/contractingLabels";
import { ContractingBillExportActions, ContractingBillsReportExportActions } from "@/components/ContractingExportActions";
import type { ContractingBillSnapshot } from "@/lib/contractingPrintExport";

const API = import.meta.env.VITE_API_URL || "";

type BillRow = {
  id: number;
  projectId: number;
  projectCode: string | null;
  projectName: string | null;
  direction: "outgoing" | "incoming";
  contractorId: number | null;
  contractorName: string | null;
  contractId: number | null;
  contractBaseId: number | null;
  billNumber: string;
  billType: string;
  billDate: string;
  grossWorks: number;
  previousWorks: number;
  currentWorks: number;
  cumulativeWorks: number;
  contractValue: number;
  remainingContract: number;
  completionPercent: number;
  deductions: number;
  retentions: number;
  penalties: number;
  vatAmount: string;
  netAmount: string;
  payments: number;
  outstanding: number;
  settlementPaid: number;
  status: string;
};

type Project   = { id: number; code: string; nameAr: string };
type Contractor= { id: number; name: string };
type ReportTotals = {
  grossWorks: number;
  previousWorks: number;
  currentWorks: number;
  cumulativeWorks: number;
  deductions: number;
  retentions: number;
  penalties: number;
  payments: number;
  outstanding: number;
  contractValue: number;
  remainingContract: number;
  completionPercent: number;
};

const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "secondary", submitted: "outline", approved: "default", paid: "default",
  rejected: "destructive", reversed: "destructive", cancelled: "destructive",
};

const EMPTY_TOTALS: ReportTotals = {
  grossWorks: 0, previousWorks: 0, currentWorks: 0, cumulativeWorks: 0,
  deductions: 0, retentions: 0, penalties: 0, payments: 0, outstanding: 0,
  contractValue: 0, remainingContract: 0, completionPercent: 0,
};

const fmt = (n: number | string) =>
  Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const parseDirection = (search: string): "" | "outgoing" | "incoming" => {
  const value = new URLSearchParams(search).get("direction");
  return value === "outgoing" || value === "incoming" ? value : "";
};

export default function ContractingBills() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const canCreate = usePermission("contracting", "create");
  const searchString = useSearch();
  const [, navigate] = useLocation();

  const [rows, setRows]               = useState<BillRow[]>([]);
  const [reportTotals, setReportTotals] = useState<ReportTotals>(EMPTY_TOTALS);
  const [draftTotals, setDraftTotals] = useState<ReportTotals>(EMPTY_TOTALS);
  const [projects, setProjects]       = useState<Project[]>([]);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const reportAbort = useRef<AbortController | null>(null);

  // Filters — all controlled. "" = no filter.
  // Direction is URL-backed so the owner/subcontractor sidebar shortcuts can
  // reuse this component and remain correct when wouter navigates between
  // query strings or the user presses browser-back.
  const direction = parseDirection(searchString);
  const [status, setStatus]         = useState<string>("");
  const [projectId, setProjectId]   = useState<string>("");
  const [contractorId, setContractorId] = useState<string>("");
  const [dateFrom, setDateFrom]     = useState<string>("");
  const [dateTo, setDateTo]         = useState<string>("");
  const [search, setSearch]         = useState<string>("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    reportAbort.current?.abort();
    const controller = new AbortController();
    reportAbort.current = controller;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (direction)    qs.set("direction",    direction);
      if (status)       qs.set("status",       status);
      if (projectId)    qs.set("projectId",    projectId);
      if (contractorId) qs.set("contractorId", contractorId);
      if (dateFrom)     qs.set("dateFrom",     dateFrom);
      if (dateTo)       qs.set("dateTo",       dateTo);
      const r = await fetch(`${API}/api/contracting/reports/bills?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const payload = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(payload?.error || `HTTP ${r.status}`);
      if (!Array.isArray(payload?.bills)) throw new Error("استجابة تقرير المستخلصات غير صالحة");
      setRows(payload.bills);
      setReportTotals({ ...EMPTY_TOTALS, ...(payload.totals || {}) });
      setDraftTotals({ ...EMPTY_TOTALS, ...(payload.draftTotals || {}) });
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setError(e?.message || "تعذر تحميل تقرير المستخلصات");
        toast({ title: "تعذر تحميل التقرير", description: e?.message, variant: "destructive" });
      }
    } finally {
      if (reportAbort.current === controller) {
        reportAbort.current = null;
        setLoading(false);
      }
    }
  }, [token, direction, status, projectId, contractorId, dateFrom, dateTo, toast]);

  // Project + contractor lookup lists for the filter selects. Loaded once.
  const loadLookups = useCallback(async () => {
    if (!token) return;
    try {
      const [pr, cr] = await Promise.all([
        fetch(`${API}/api/contracting/projects`,    { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API}/api/contracting/contractors`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (pr.ok) setProjects(await pr.json());
      if (cr.ok) setContractors(await cr.json());
    } catch { /* lookup failures shouldn't block the page */ }
  }, [token]);

  useEffect(() => { void loadLookups(); }, [loadLookups]);
  useEffect(() => {
    void load();
    return () => reportAbort.current?.abort();
  }, [load]);

  // Free-text search runs client-side over the already-filtered rows so
  // the user gets instant feedback without round-tripping.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      r.billNumber.toLowerCase().includes(q)
      || (r.projectName    || "").toLowerCase().includes(q)
      || (r.projectCode    || "").toLowerCase().includes(q)
      || (r.contractorName || "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  // Cumulative values are calculated server-side from the selected report
  // scope. Re-summing each visible row would count earlier periods repeatedly.
  const totals = reportTotals;

  const hasFilters = !!(direction || status || projectId || contractorId || dateFrom || dateTo || search);
  const clearFilters = () => {
    const params = new URLSearchParams(searchString);
    params.delete("direction");
    navigate(`/contracting/bills${params.toString() ? `?${params.toString()}` : ""}`, { replace: true });
    setStatus(""); setProjectId(""); setContractorId("");
    setDateFrom(""); setDateTo(""); setSearch("");
  };

  function openProjectBillForm() {
    const id = Number(createProjectId);
    // The project list is branch/company scoped by the API. Validate the
    // selected value against that list before constructing a project route so
    // a stale or tampered select value cannot open an arbitrary project.
    const project = projects.find(p => Number(p.id) === id);
    if (!project || !Number.isInteger(id) || id <= 0) {
      toast({ title: "اختر مشروعاً صالحاً", variant: "destructive" });
      return;
    }
    const billDirection = direction || "outgoing";
    setCreateDialogOpen(false);
    setCreateProjectId("");
    // Keep this as a normal navigation (not replace): browser Back returns
    // to the exact report URL, including its outgoing/incoming filter.
    navigate(`/contracting/projects/${id}?tab=bills&direction=${billDirection}&createBill=1`);
  }

  const exportRows: ContractingBillSnapshot[] = visible.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    projectCode: row.projectCode,
    projectName: row.projectName,
    direction: row.direction,
    contractorId: row.contractorId,
    contractorName: row.contractorName,
    contractValue: row.contractValue,
    remainingContract: row.remainingContract,
    billNumber: row.billNumber,
    billType: row.billType,
    billDate: row.billDate,
    grossWorks: row.grossWorks,
    previousWorks: row.previousWorks,
    currentWorks: row.currentWorks,
    cumulativeWorks: row.cumulativeWorks,
    deductions: row.deductions,
    retentions: row.retentions,
    penalties: row.penalties,
    vatAmount: row.vatAmount,
    netAmount: row.netAmount,
    payments: row.payments,
    outstanding: row.outstanding,
    paidAmount: row.settlementPaid,
    status: row.status,
  }));

  return (
    <div className="space-y-6 p-6" dir="rtl">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="h-6 w-6 text-emerald-600" />
            المستخلصات
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            عرض موحّد لكل مستخلصات المقاولات عبر المشاريع — صادرة للمالك ووواردة من المقاولين الباطن.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ContractingBillsReportExportActions rows={exportRows} />
          {canCreate && (
            <Button
              variant="default"
              onClick={() => setCreateDialogOpen(true)}
              data-testid="button-create-contracting-bill"
            >
              <FileText className="ms-1 h-4 w-4" /> إنشاء مستخلص
            </Button>
          )}
        </div>
      </header>

      {canCreate && (
        <Dialog
          open={createDialogOpen}
          onOpenChange={(open) => {
            setCreateDialogOpen(open);
            if (!open) setCreateProjectId("");
          }}
        >
          <DialogContent dir="rtl" data-testid="dialog-create-contracting-bill">
            <DialogHeader>
              <DialogTitle>إنشاء مستخلص جديد</DialogTitle>
              <DialogDescription>
                اختر مشروعاً مصرحاً لك به لفتح نموذج المستخلص الموجود داخل تفاصيل المشروع.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="create-bill-project">
                المشروع
              </label>
              <SearchCombobox
                items={projects
                  .filter(project => Number.isInteger(Number(project.id)) && Number(project.id) > 0)
                  .map(project => ({
                    value: String(project.id),
                    label: `${project.code} — ${project.nameAr}`,
                  }))}
                value={createProjectId}
                onValueChange={setCreateProjectId}
                placeholder="اختر مشروعاً"
                searchPlaceholder="بحث بالكود أو اسم المشروع..."
                emptyText="لا توجد مشاريع مطابقة"
                disabled={loading}
                openOnFocus={false}
                testId="select-create-bill-project"
              />
              {projects.length === 0 && (
                <p className="text-xs text-muted-foreground">لا توجد مشاريع متاحة لك.</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                إلغاء
              </Button>
              <Button
                onClick={openProjectBillForm}
                disabled={!createProjectId}
                data-testid="button-confirm-create-contracting-bill"
              >
                متابعة
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-8 gap-3">
        <KpiCard label="عدد المستخلصات" value={visible.length.toLocaleString("en-US")} tone="slate" />
        <KpiCard label="إجمالي الأعمال" value={fmt(totals.grossWorks)} tone="slate" suffix="ر.س" />
        <KpiCard label="الأعمال التراكمية" value={fmt(totals.cumulativeWorks)} tone="slate" suffix="ر.س" />
        <KpiCard label="المحتجز" value={fmt(totals.retentions)} tone="amber" suffix="ر.س" />
        <KpiCard label="الاستقطاعات" value={fmt(totals.deductions)} tone="amber" suffix="ر.س" />
        <KpiCard label="الغرامات" value={fmt(totals.penalties)} tone="rose" suffix="ر.س" />
        <KpiCard label="المدفوعات" value={fmt(totals.payments)} tone="emerald" suffix="ر.س" />
        <KpiCard label="المتبقي للسداد" value={fmt(totals.outstanding)} tone="rose" suffix="ر.س" />
      </div>
      <div className="text-xs text-muted-foreground">
        قيمة العقود: {fmt(totals.contractValue)} ر.س · المتبقي من العقود: {fmt(totals.remainingContract)} ر.س ·
        نسبة الإنجاز التراكمية: {Number(totals.completionPercent || 0).toFixed(2)}%
        {search.trim() ? " · الإجماليات مبنية على فلاتر التقرير، بينما البحث يضيّق العرض فقط" : ""}
      </div>
      {(draftTotals.grossWorks || draftTotals.cumulativeWorks || draftTotals.outstanding) > 0 && (
        <div className="text-xs text-amber-700 dark:text-amber-300">
          المسودات غير المعتمدة (مستثناة من الإجماليات المالية): أعمال {fmt(draftTotals.grossWorks)} ر.س ·
          تراكمي {fmt(draftTotals.cumulativeWorks)} ر.س · متبقي {fmt(draftTotals.outstanding)} ر.س
        </div>
      )}

      {/* Filters */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Filter className="h-4 w-4" />
            الفلاتر
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="button-clear-filters">
              <X className="h-4 w-4 ms-1" /> مسح الفلاتر
            </Button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <FilterSelect
            label="الاتجاه"
            value={direction}
            onChange={(v) => {
              const params = new URLSearchParams(searchString);
              if (v) params.set("direction", v);
              else params.delete("direction");
              navigate(`/contracting/bills${params.toString() ? `?${params.toString()}` : ""}`, { replace: true });
            }}
            placeholder="الكل"
            options={[
               { value: "outgoing", label: labelEnum(BILL_DIRECTION_LABEL, "outgoing") },
               { value: "incoming", label: labelEnum(BILL_DIRECTION_LABEL, "incoming") },
            ]}
            testId="filter-direction"
          />
          <FilterSelect
            label="الحالة"
            value={status}
            onChange={setStatus}
            placeholder="الكل"
            options={Object.entries(BILL_STATUS_LABEL).map(([value, label]) => ({ value, label }))}
            testId="filter-status"
          />
          <FilterSelect
            label="المشروع"
            value={projectId}
            onChange={setProjectId}
            placeholder="كل المشاريع"
            options={projects.map(p => ({ value: String(p.id), label: `${p.code} — ${p.nameAr}` }))}
            testId="filter-project"
          />
          <FilterSelect
            label="المقاول الباطن"
            value={contractorId}
            onChange={setContractorId}
            placeholder="كل المقاولين"
            options={contractors.map(c => ({ value: String(c.id), label: c.name }))}
            testId="filter-contractor"
          />

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">من تاريخ</label>
            <DateField value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} data-testid="filter-date-from" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">إلى تاريخ</label>
            <DateField value={dateTo} onChange={(e) => setDateTo(e.target.value)} data-testid="filter-date-to" />
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-muted-foreground mb-1 block">بحث (رقم المستخلص / مشروع / مقاول)</label>
            <Input
              placeholder="اكتب للبحث..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="filter-search"
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200" data-testid="status-contracting-bills-error">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void load()} data-testid="button-retry-contracting-bills">
            إعادة المحاولة
          </Button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-start">المشروع</TableHead>
              <TableHead className="text-start">رقم المستخلص</TableHead>
              <TableHead className="text-start">التاريخ</TableHead>
              <TableHead className="text-start">الاتجاه</TableHead>
              <TableHead className="text-start">المقاول الباطن</TableHead>
              <TableHead className="text-end">إجمالي الأعمال</TableHead>
              <TableHead className="text-end">السابق</TableHead>
              <TableHead className="text-end">الحالي</TableHead>
              <TableHead className="text-end">التراكمي</TableHead>
              <TableHead className="text-end">قيمة العقد</TableHead>
              <TableHead className="text-end">المتبقي من العقد</TableHead>
              <TableHead className="text-end">المحتجز</TableHead>
              <TableHead className="text-end">الاستقطاعات</TableHead>
              <TableHead className="text-end">الغرامات</TableHead>
              <TableHead className="text-end">المدفوعات</TableHead>
              <TableHead className="text-end">المتبقي</TableHead>
              <TableHead className="text-start">الحالة</TableHead>
              <TableHead className="text-end">إجراء</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && Array.from({ length: 5 }).map((_, i) => (
              <TableRow key={`sk-${i}`}>
                {Array.from({ length: 18 }).map((__, j) => (
                  <TableCell key={j}><Skeleton className="h-5 w-full" /></TableCell>
                ))}
              </TableRow>
            ))}

            {!loading && visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={18} className="text-center py-12 text-muted-foreground" data-testid="text-contracting-bills-empty">
                  {hasFilters
                    ? "لا توجد نتائج مطابقة للفلاتر — جرّب مسح بعضها."
                    : "لا توجد مستخلصات بعد. يتم إنشاء المستخلصات من داخل تفاصيل المشروع."}
                </TableCell>
              </TableRow>
            )}

            {!loading && visible.map((r) => (
              <TableRow key={r.id} data-testid={`row-bill-${r.id}`}>
                <TableCell>
                  <div className="font-medium">{r.projectName || "—"}</div>
                  {r.projectCode && <div className="text-xs text-muted-foreground">{r.projectCode}</div>}
                </TableCell>
                 <TableCell className="font-mono text-sm">
                   <div>{r.billNumber}</div>
                   <div className="font-sans text-xs text-muted-foreground">{labelEnum(BILL_TYPE_LABEL, r.billType)}</div>
                 </TableCell>
                <TableCell className="whitespace-nowrap text-sm">{r.billDate}</TableCell>
                <TableCell>
                  {r.direction === "incoming" ? (
                    <Badge variant="outline" className="gap-1">
                       <ArrowDownToLine className="h-3 w-3" /> {labelEnum(BILL_DIRECTION_LABEL, "incoming")}
                    </Badge>
                  ) : (
                    <Badge variant="default" className="gap-1 bg-emerald-600">
                       <ArrowUpFromLine className="h-3 w-3" /> {labelEnum(BILL_DIRECTION_LABEL, "outgoing")}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{r.contractorName || (r.direction === "outgoing" ? "—" : "—")}</TableCell>
                <TableCell className="text-end font-mono">{fmt(r.grossWorks)}</TableCell>
                <TableCell className="text-end font-mono">{fmt(r.previousWorks)}</TableCell>
                <TableCell className="text-end font-mono">{fmt(r.currentWorks)}</TableCell>
                <TableCell className="text-end font-mono font-semibold">{fmt(r.cumulativeWorks)}</TableCell>
                <TableCell className="text-end font-mono">{fmt(r.contractValue)}</TableCell>
                <TableCell className="text-end font-mono">{fmt(r.remainingContract)}</TableCell>
                <TableCell className="text-end font-mono">{fmt(r.retentions)}</TableCell>
                <TableCell className="text-end font-mono">{fmt(r.deductions)}</TableCell>
                <TableCell className="text-end font-mono">{fmt(r.penalties)}</TableCell>
                <TableCell className="text-end font-mono">{fmt(r.payments)}</TableCell>
                <TableCell className="text-end font-mono font-semibold">{fmt(r.outstanding)}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_TONE[r.status] || "secondary"} data-testid={`status-bill-${r.id}`}>
                    {labelEnum(BILL_STATUS_LABEL, r.status)}
                  </Badge>
                </TableCell>
                <TableCell className="text-end">
                   <ContractingBillExportActions
                     compact
                     snapshot={{
                       bill: {
                         id: r.id,
                         projectId: r.projectId,
                         projectCode: r.projectCode,
                         projectName: r.projectName,
                         direction: r.direction,
                         contractorId: r.contractorId,
                         contractorName: r.contractorName,
                         billNumber: r.billNumber,
                         billType: r.billType,
                         billDate: r.billDate,
                         grossWorks: r.grossWorks,
                         previousWorks: r.previousWorks,
                         currentWorks: r.currentWorks,
                         cumulativeWorks: r.cumulativeWorks,
                         contractValue: r.contractValue,
                         remainingContract: r.remainingContract,
                         retentions: r.retentions,
                         deductions: r.deductions,
                         penalties: r.penalties,
                         vatAmount: r.vatAmount,
                         netAmount: r.netAmount,
                         payments: r.payments,
                         outstanding: r.outstanding,
                         paidAmount: r.settlementPaid,
                         status: r.status,
                       },
                       project: {
                         id: r.projectId,
                         code: r.projectCode,
                         nameAr: r.projectName,
                       },
                     }}
                   />
                  <Link href={`/contracting/projects/${r.projectId}`}>
                    <Button variant="ghost" size="sm" data-testid={`link-project-${r.projectId}`}>
                      <ExternalLink className="h-4 w-4 ms-1" /> فتح المشروع
                    </Button>
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─────────────────── tiny presentational helpers ───────────────────

function KpiCard({
  label, value, suffix, tone,
}: {
  label: string;
  value: string;
  suffix?: string;
  tone: "slate" | "amber" | "emerald" | "rose";
}) {
  const toneClasses: Record<string, string> = {
    slate:   "bg-slate-50   text-slate-900   dark:bg-slate-900/40   dark:text-slate-100",
    amber:   "bg-amber-50   text-amber-900   dark:bg-amber-900/30   dark:text-amber-100",
    emerald: "bg-emerald-50 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-100",
    rose:    "bg-rose-50    text-rose-900    dark:bg-rose-900/30    dark:text-rose-100",
  };
  return (
    <div className={`rounded-lg border p-3 ${toneClasses[tone]}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className="mt-1 text-lg font-bold font-mono">
        {value}
        {suffix && <span className="text-xs ms-1 opacity-70">{suffix}</span>}
      </div>
    </div>
  );
}

function FilterSelect({
  label, value, onChange, placeholder, options, testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: { value: string; label: string }[];
  testId: string;
}) {
  const items: ComboboxItem[] = [
    { value: "__all__", label: placeholder },
    ...options,
  ];
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
      <SearchCombobox
        items={items}
        value={value || "__all__"}
        onValueChange={(v) => onChange(v === "__all__" ? "" : v)}
        placeholder={placeholder}
        searchPlaceholder={`بحث في ${label}...`}
        emptyText="لا توجد نتائج"
        testId={testId}
        openOnFocus={false}
      />
    </div>
  );
}
