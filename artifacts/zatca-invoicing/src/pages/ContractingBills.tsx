// Standalone "المستخلصات" screen — company-wide progress-bills view across
// every project. Read-only list with KPI cards + filters; create/edit still
// happens inside the project (تفاصيل المشروع → تبويب المستخلصات) because
// every bill is anchored to a project.
import { useEffect, useMemo, useState, useCallback } from "react";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { FileText, ArrowDownToLine, ArrowUpFromLine, ExternalLink, Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

const API = import.meta.env.VITE_API_URL || "";

type BillRow = {
  id: number;
  projectId: number;
  projectCode: string | null;
  projectName: string | null;
  direction: "outgoing" | "incoming";
  contractorId: number | null;
  contractorName: string | null;
  billNumber: string;
  billType: string;
  billDate: string;
  progressPercent: string;
  grossAmount: string;
  retentionAmount: string;
  previousPaid: string;
  dueAmount: string;
  vatAmount: string;
  netAmount: string;
  paidAmount: string;
  status: "draft" | "submitted" | "approved" | "paid" | "rejected";
};

type Project   = { id: number; code: string; nameAr: string };
type Contractor= { id: number; name: string };

const STATUS_LABEL: Record<string, string> = {
  draft: "مسودة", submitted: "مُقدَّم", approved: "معتمد", paid: "مدفوع", rejected: "مرفوض",
};
const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "secondary", submitted: "outline", approved: "default", paid: "default", rejected: "destructive",
};

const fmt = (n: number | string) =>
  Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ContractingBills() {
  const { token } = useAuth() as any;
  const { toast } = useToast();

  const [rows, setRows]               = useState<BillRow[]>([]);
  const [projects, setProjects]       = useState<Project[]>([]);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [loading, setLoading]         = useState(false);

  // Filters — all controlled. "" = no filter.
  const [direction, setDirection]   = useState<"" | "outgoing" | "incoming">("");
  const [status, setStatus]         = useState<string>("");
  const [projectId, setProjectId]   = useState<string>("");
  const [contractorId, setContractorId] = useState<string>("");
  const [dateFrom, setDateFrom]     = useState<string>("");
  const [dateTo, setDateTo]         = useState<string>("");
  const [search, setSearch]         = useState<string>("");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (direction)    qs.set("direction",    direction);
      if (status)       qs.set("status",       status);
      if (projectId)    qs.set("projectId",    projectId);
      if (contractorId) qs.set("contractorId", contractorId);
      if (dateFrom)     qs.set("dateFrom",     dateFrom);
      if (dateTo)       qs.set("dateTo",       dateTo);
      const r = await fetch(`${API}/api/contracting/bills?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) {
      toast({ title: "حدث خطأ", description: e?.message, variant: "destructive" });
    } finally { setLoading(false); }
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
  useEffect(() => { void load(); }, [load]);

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

  // KPI totals are computed from `visible` so they stay in sync with what
  // the user is actually looking at after applying filters + search.
  const totals = useMemo(() => {
    let count = visible.length, gross = 0, due = 0, net = 0, paid = 0;
    for (const r of visible) {
      gross += Number(r.grossAmount || 0);
      due   += Number(r.dueAmount   || 0);
      net   += Number(r.netAmount   || 0);
      paid  += Number(r.paidAmount  || 0);
    }
    return { count, gross, due, net, paid, outstanding: net - paid };
  }, [visible]);

  const hasFilters = !!(direction || status || projectId || contractorId || dateFrom || dateTo || search);
  const clearFilters = () => {
    setDirection(""); setStatus(""); setProjectId(""); setContractorId("");
    setDateFrom(""); setDateTo(""); setSearch("");
  };

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
      </header>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard label="عدد المستخلصات" value={totals.count.toLocaleString("ar-SA")} tone="slate" />
        <KpiCard label="إجمالي الأعمال" value={fmt(totals.gross)} tone="slate" suffix="ر.س" />
        <KpiCard label="المستحق قبل الضريبة" value={fmt(totals.due)} tone="amber" suffix="ر.س" />
        <KpiCard label="الصافي شامل الضريبة" value={fmt(totals.net)} tone="emerald" suffix="ر.س" />
        <KpiCard label="المدفوع" value={fmt(totals.paid)} tone="emerald" suffix="ر.س" />
        <KpiCard label="المتبقي للسداد" value={fmt(totals.outstanding)} tone="rose" suffix="ر.س" />
      </div>

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
            onChange={(v) => setDirection(v as any)}
            placeholder="الكل"
            options={[
              { value: "outgoing", label: "صادر للمالك" },
              { value: "incoming", label: "وارد من الباطن" },
            ]}
            testId="filter-direction"
          />
          <FilterSelect
            label="الحالة"
            value={status}
            onChange={setStatus}
            placeholder="الكل"
            options={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))}
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
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} data-testid="filter-date-from" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">إلى تاريخ</label>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} data-testid="filter-date-to" />
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
              <TableHead className="text-end">المستحق</TableHead>
              <TableHead className="text-end">الصافي</TableHead>
              <TableHead className="text-end">المدفوع</TableHead>
              <TableHead className="text-start">الحالة</TableHead>
              <TableHead className="text-end">إجراء</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && Array.from({ length: 5 }).map((_, i) => (
              <TableRow key={`sk-${i}`}>
                {Array.from({ length: 11 }).map((__, j) => (
                  <TableCell key={j}><Skeleton className="h-5 w-full" /></TableCell>
                ))}
              </TableRow>
            ))}

            {!loading && visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} className="text-center py-12 text-muted-foreground">
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
                <TableCell className="font-mono text-sm">{r.billNumber}</TableCell>
                <TableCell className="whitespace-nowrap text-sm">{r.billDate}</TableCell>
                <TableCell>
                  {r.direction === "incoming" ? (
                    <Badge variant="outline" className="gap-1">
                      <ArrowDownToLine className="h-3 w-3" /> وارد
                    </Badge>
                  ) : (
                    <Badge variant="default" className="gap-1 bg-emerald-600">
                      <ArrowUpFromLine className="h-3 w-3" /> صادر
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{r.contractorName || (r.direction === "outgoing" ? "—" : "—")}</TableCell>
                <TableCell className="text-end font-mono">{fmt(r.grossAmount)}</TableCell>
                <TableCell className="text-end font-mono">{fmt(r.dueAmount)}</TableCell>
                <TableCell className="text-end font-mono font-semibold">{fmt(r.netAmount)}</TableCell>
                <TableCell className="text-end font-mono">{fmt(r.paidAmount)}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_TONE[r.status] || "secondary"}>
                    {STATUS_LABEL[r.status] || r.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-end">
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
  // Select uses a sentinel "__all__" because Radix's <SelectItem> can't have
  // an empty-string value. We translate it to "" outside the component.
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
      <Select
        value={value || "__all__"}
        onValueChange={(v) => onChange(v === "__all__" ? "" : v)}
      >
        <SelectTrigger data-testid={testId}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">{placeholder}</SelectItem>
          {options.map(o => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
