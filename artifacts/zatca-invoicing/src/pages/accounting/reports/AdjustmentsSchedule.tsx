import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { DateField } from "@/components/ui/date-field";
import ExportButtons from "@/components/ExportButtons";
import { exportToPDF, type ExportColumn, type ExportCompanyInfo } from "@/lib/export";
import {
  DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CalendarRange, Printer, Loader2, ChevronDown, ChevronLeft, ChevronsDownUp, ChevronsUpDown, Layers, ListTree } from "lucide-react";
import { useDemoActionGate } from "@/hooks/use-demo-action-gate";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type RunDetail = { ym: string; amount: number; jeId: number | null; jeNumber: string | null; posted: boolean };
type Row = {
  adjustmentId: number; name: string; type: string; status: string;
  startDate: string; endDate: string; monthsCount: number;
  monthlyAmount: number; costCenter: string | null; contraAccount: string | null;
  total: number; opening: number; period: number; closing: number;
  remaining: number; progressPct: number;
  runs: RunDetail[];
};
type Group = {
  accountId: number; accountCode: string; accountName: string;
  rows: Row[];
  totals: { total: number; opening: number; period: number; closing: number; remaining: number };
};
type ScheduleResp = {
  from: string; to: string; groups: Group[];
  totals: { total: number; opening: number; period: number; closing: number; remaining: number };
};

const fmt = (n: number | null | undefined) =>
  Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TYPE_LABELS: Record<string, string> = { prepaid: "مصروف مقدم", accrued: "مصروف مستحق" };
const STATUS_LABELS: Record<string, string> = {
  active: "نشطة", completed: "مكتملة", cancelled: "ملغاة", carried_forward: "مرحّلة للأمام",
};

function defaultRange() {
  const today = new Date();
  const y = today.getFullYear();
  const to = today.toISOString().slice(0, 10);
  return { from: `${y}-01-01`, to };
}

export default function AdjustmentsSchedule() {
    const gate = useDemoActionGate();
  const { user, token } = useAuth() as any;
  const cid = user?.companyId;
  const headers = { Authorization: `Bearer ${token}` };

  const init = defaultRange();
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const [typeFilter, setTypeFilter] = useState("");
  const [ccFilter, setCcFilter] = useState("");

  const { data: costCenters = [] } = useQuery<any[]>({
    queryKey: ["cost-centers", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/cost-centers?companyId=${cid}`, { headers });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j) ? j : [];
    },
    enabled: !!cid,
  });

  const { data, isFetching, isError } = useQuery<ScheduleResp>({
    queryKey: ["adjustments/movement-schedule", cid, from, to, typeFilter, ccFilter],
    queryFn: async () => {
      const p = new URLSearchParams({ companyId: String(cid), from, to });
      if (typeFilter) p.set("type", typeFilter);
      if (ccFilter) p.set("costCenterId", ccFilter);
      const r = await fetch(`${API}/api/adjustments/reports/movement-schedule?${p}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل التقرير");
      return r.json();
    },
    enabled: !!cid,
  });

  const groups = data?.groups ?? [];
  const totals = data?.totals;
  const flatCount = useMemo(() => groups.reduce((s, g) => s + g.rows.length, 0), [groups]);

  // Collapsible account groups + collapsible per-adjustment month detail.
  const groupKey = (g: Group) => String(g.accountId);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openMonths, setOpenMonths] = useState<Set<number>>(new Set());
  const toggleGroup = (k: string) =>
    setExpanded((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleMonths = (id: number) =>
    setOpenMonths((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const expandAll = () => setExpanded(new Set(groups.map(groupKey)));
  const collapseAll = () => { setExpanded(new Set()); setOpenMonths(new Set()); };
  const allExpanded = groups.length > 0 && groups.every((g) => expanded.has(groupKey(g)));

  // Year quick-filter (same UX as the FA schedule).
  const currentYear = new Date().getFullYear();
  const yearOptions = useMemo(() => {
    const ys: number[] = [];
    for (let y = currentYear + 1; y >= currentYear - 10; y--) ys.push(y);
    return ys;
  }, [currentYear]);
  const selectedYear = useMemo(() => {
    const m = /^(\d{4})-01-01$/.exec(from);
    return m && to === `${m[1]}-12-31` ? m[1] : "";
  }, [from, to]);
  const pickYear = (y: string) => {
    if (!y) return;
    setFrom(`${y}-01-01`);
    setTo(`${y}-12-31`);
  };

  // ── Export (Excel / PDF / Print) — same pattern as the FA schedule ──────
  const num = "#,##0.00";
  const exportColumns: ExportColumn[] = useMemo(() => [
    { header: "التسوية / البيان",    key: "item", width: 34 },
    { header: "النوع",               key: "type", width: 12 },
    { header: "الحالة",              key: "status", width: 10 },
    { header: "من",                  key: "start", width: 11 },
    { header: "إلى",                 key: "end", width: 11 },
    { header: "القسط الشهري",        key: "monthly", numFmt: num },
    { header: "إجمالي التسوية",      key: "total",   numFmt: num },
    { header: "رصيد أول (معترف به)", key: "opening", numFmt: num },
    { header: "المعترف به بالفترة",  key: "period",  numFmt: num },
    { header: "المعترف به تراكمي",   key: "closing", numFmt: num },
    { header: "الرصيد المتبقي",      key: "remaining", numFmt: num },
    { header: "الإنجاز %",           key: "pct", width: 9 },
  ], []);

  const exportRows = useMemo(() => {
    const out: Record<string, unknown>[] = [];
    for (const g of groups) {
      out.push({
        item: `${g.accountCode} — ${g.accountName} (${g.rows.length} تسوية)`,
        type: "", status: "", start: "", end: "", monthly: "",
        total: g.totals.total, opening: g.totals.opening, period: g.totals.period,
        closing: g.totals.closing, remaining: g.totals.remaining, pct: "",
      });
      for (const r of g.rows) {
        out.push({
          item: r.name,
          type: TYPE_LABELS[r.type] ?? r.type,
          status: STATUS_LABELS[r.status] ?? r.status,
          start: r.startDate, end: r.endDate,
          monthly: r.monthlyAmount, total: r.total,
          opening: r.opening, period: r.period, closing: r.closing,
          remaining: r.remaining, pct: `${fmt(r.progressPct)}%`,
        });
      }
    }
    return out;
  }, [groups]);

  const exportTotalsRow = useMemo(() => totals ? {
    item: "الإجمالي العام", type: "", status: "", start: "", end: "", monthly: "",
    total: totals.total, opening: totals.opening, period: totals.period,
    closing: totals.closing, remaining: totals.remaining, pct: "",
  } : null, [totals]);

  const summaryColumns: ExportColumn[] = useMemo(() => [
    { header: "الحساب / البيان",     key: "item", width: 40 },
    { header: "إجمالي التسوية",      key: "total",   numFmt: num },
    { header: "رصيد أول (معترف به)", key: "opening", numFmt: num },
    { header: "المعترف به بالفترة",  key: "period",  numFmt: num },
    { header: "المعترف به تراكمي",   key: "closing", numFmt: num },
    { header: "الرصيد المتبقي",      key: "remaining", numFmt: num },
  ], []);

  const summaryRows = useMemo(() =>
    groups.map((g) => ({
      item: `${g.accountCode} — ${g.accountName} (${g.rows.length} تسوية)`,
      total: g.totals.total, opening: g.totals.opening, period: g.totals.period,
      closing: g.totals.closing, remaining: g.totals.remaining,
    })), [groups]);

  const summaryTotalsRow = useMemo(() => totals ? {
    item: "الإجمالي العام",
    total: totals.total, opening: totals.opening, period: totals.period,
    closing: totals.closing, remaining: totals.remaining,
  } : null, [totals]);

  const reportTitle = "جدول التسويات وحركة المصروف المقدم والمستحق";
  const reportSubtitle = `من ${from} إلى ${to}`;
  const reportFilename = `جدول-التسويات_${from}_${to}`;

  const [printing, setPrinting] = useState(false);
  async function handlePrint(mode: "summary" | "detailed") {
      if (!(await gate('export'))) return;
    const rows = mode === "summary" ? summaryRows : exportRows;
    const cols = mode === "summary" ? summaryColumns : exportColumns;
    const totRow = mode === "summary" ? summaryTotalsRow : exportTotalsRow;
    if (!rows.length) return;
    setPrinting(true);
    try {
      const c = user?.company;
      const company: ExportCompanyInfo | null = c ? {
        nameAr: c.nameAr ?? c.name ?? null, nameEn: c.nameEn ?? null,
        crNumber: c.crNumber ?? null, vatNumber: c.vatNumber ?? null,
        phone: c.phone ?? null, buildingNumber: c.buildingNumber ?? null,
        street: c.street ?? null, district: c.district ?? null,
        city: c.city ?? null, postalCode: c.postalCode ?? null,
        logo: c.logo ?? null,
      } : null;
      await exportToPDF(
        rows, cols, reportFilename,
        reportTitle,
        `${reportSubtitle} — ${mode === "summary" ? "إجمالي" : "تفصيلي"}`,
        true, totRow, null, c?.logo ?? null, null, company,
        { fitOneLine: true },
      );
    } finally {
      setPrinting(false);
    }
  }

  const numCell = "px-2 py-1 text-center font-mono tabular-nums whitespace-nowrap";
  const th = "px-2 py-2 text-center font-semibold border border-slate-300";

  return (
    <div className="p-4 space-y-4" dir="rtl">
      {/* Header / controls */}
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-xl font-bold text-emerald-800 flex items-center gap-2">
            <CalendarRange className="h-6 w-6 text-emerald-600" />
            جدول التسويات وحركة المصروف المقدم والمستحق
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            مبني على القيود المحاسبية المُرحّلة فقط — يطابق ميزان المراجعة، بنفس فكرة جدول الإهلاك.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-600">
            النوع
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="block mt-1 h-9 w-32 px-2 rounded-md border border-slate-300 bg-white text-sm"
            >
              <option value="">الكل</option>
              <option value="prepaid">مصروف مقدم</option>
              <option value="accrued">مصروف مستحق</option>
            </select>
          </label>
          <label className="text-xs text-slate-600">
            مركز التكلفة
            <select
              value={ccFilter}
              onChange={(e) => setCcFilter(e.target.value)}
              className="block mt-1 h-9 w-36 px-2 rounded-md border border-slate-300 bg-white text-sm"
            >
              <option value="">الكل</option>
              {costCenters.map((c: any) => (
                <option key={c.id} value={String(c.id)}>{c.nameAr ?? c.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-600">
            السنة
            <select
              value={selectedYear}
              onChange={(e) => pickYear(e.target.value)}
              className="block mt-1 h-9 w-24 px-2 rounded-md border border-slate-300 bg-white text-sm"
            >
              <option value="">مخصص</option>
              {yearOptions.map((y) => (
                <option key={y} value={String(y)}>{y}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-600">
            من
            <DateField value={from} onChange={(e) => setFrom(e.target.value)} className="block mt-1 w-36" />
          </label>
          <label className="text-xs text-slate-600">
            إلى
            <DateField value={to} onChange={(e) => setTo(e.target.value)} className="block mt-1 w-36" />
          </label>
          <button
            onClick={() => (allExpanded ? collapseAll() : expandAll())}
            disabled={flatCount === 0}
            className="h-9 px-3 rounded-md border border-slate-300 bg-white text-slate-700 text-sm flex items-center gap-1 hover:bg-slate-50 disabled:opacity-50"
          >
            {allExpanded ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
            {allExpanded ? "طي الكل" : "توسيع الكل"}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                disabled={flatCount === 0 || printing}
                className="h-9 px-3 rounded-md bg-slate-700 text-white text-sm flex items-center gap-1 hover:bg-slate-800 disabled:opacity-50"
              >
                {printing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />} طباعة
                <ChevronDown className="h-3 w-3 opacity-70" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem className="gap-2.5 cursor-pointer" onClick={() => handlePrint("summary")}>
                <Layers className="h-4 w-4 text-emerald-600" />
                <span>طباعة إجمالية (بدون تفاصيل)</span>
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2.5 cursor-pointer" onClick={() => handlePrint("detailed")}>
                <ListTree className="h-4 w-4 text-sky-600" />
                <span>طباعة تفصيلية (بالتسويات)</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ExportButtons
            rows={summaryRows}
            columns={summaryColumns}
            filename={`${reportFilename}_إجمالي`}
            title={reportTitle}
            subtitle={`${reportSubtitle} — إجمالي`}
            totalsRow={summaryTotalsRow}
            disabled={flatCount === 0}
            size="default"
            label="تصدير إجمالي"
            pdfFitOneLine
          />
          <ExportButtons
            rows={exportRows}
            columns={exportColumns}
            filename={`${reportFilename}_تفصيلي`}
            title={reportTitle}
            subtitle={`${reportSubtitle} — تفصيلي`}
            totalsRow={exportTotalsRow}
            disabled={flatCount === 0}
            size="default"
            label="تصدير تفصيلي"
            pdfFitOneLine
          />
        </div>
      </div>

      {/* Print title */}
      <div className="hidden print:block text-center mb-2">
        <div className="text-lg font-bold">{reportTitle}</div>
        <div className="text-sm">من {from} إلى {to}</div>
      </div>

      {isFetching && (
        <div className="flex items-center gap-2 text-slate-500 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> جارٍ التحميل…
        </div>
      )}
      {isError && (
        <div className="text-red-600 text-sm">تعذّر تحميل التقرير. حاول مرة أخرى.</div>
      )}
      {!isFetching && !isError && flatCount === 0 && (
        <div className="text-slate-500 text-sm border border-dashed rounded-lg p-8 text-center">
          لا توجد تسويات شهرية في الفترة المحددة.
        </div>
      )}

      {flatCount > 0 && (
        <div className="overflow-x-auto border border-slate-300 rounded-lg">
          <table className="w-full text-xs border-collapse">
            <thead className="bg-slate-100 text-slate-700">
              <tr>
                <th className={th}>التسوية / البيان</th>
                <th className={th}>النوع</th>
                <th className={th}>الفترة الزمنية</th>
                <th className={th}>القسط الشهري</th>
                <th className={`${th} bg-emerald-50`}>إجمالي التسوية</th>
                <th className={`${th} bg-amber-50`}>رصيد أول (معترف به)</th>
                <th className={`${th} bg-amber-50`}>+ المعترف به بالفترة</th>
                <th className={`${th} bg-amber-50`}>المعترف به تراكمي</th>
                <th className={`${th} bg-sky-50`}>الرصيد المتبقي</th>
                <th className={th}>الإنجاز %</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <GroupBlock
                  key={g.accountId}
                  g={g}
                  numCell={numCell}
                  expanded={expanded.has(groupKey(g))}
                  onToggle={() => toggleGroup(groupKey(g))}
                  openMonths={openMonths}
                  onToggleMonths={toggleMonths}
                />
              ))}
            </tbody>
            {totals && (
              <tfoot>
                <tr className="bg-slate-800 text-white font-bold">
                  <td className="px-2 py-2 text-right" colSpan={4}>الإجمالي العام</td>
                  <td className={numCell}>{fmt(totals.total)}</td>
                  <td className={numCell}>{fmt(totals.opening)}</td>
                  <td className={numCell}>{fmt(totals.period)}</td>
                  <td className={numCell}>{fmt(totals.closing)}</td>
                  <td className={numCell}>{fmt(totals.remaining)}</td>
                  <td className={numCell}>
                    {totals.total > 0 ? `${fmt((totals.closing / totals.total) * 100)}%` : "—"}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

function GroupBlock({
  g, numCell, expanded, onToggle, openMonths, onToggleMonths,
}: {
  g: Group; numCell: string; expanded: boolean; onToggle: () => void;
  openMonths: Set<number>; onToggleMonths: (id: number) => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronLeft;
  return (
    <>
      <tr
        className="bg-emerald-100/70 text-emerald-900 font-bold cursor-pointer hover:bg-emerald-200/70 print:cursor-auto"
        onClick={onToggle}
      >
        <td className="px-2 py-1.5 text-right" colSpan={4}>
          <span className="inline-flex items-center gap-1.5">
            <Chevron className="h-4 w-4 shrink-0 text-emerald-700 print:hidden" />
            <span className="font-mono">{g.accountCode}</span>
            <span>— {g.accountName}</span>
            <span className="text-[10px] font-normal text-emerald-700/80">({g.rows.length} تسوية)</span>
          </span>
        </td>
        <td className={numCell}>{fmt(g.totals.total)}</td>
        <td className={numCell}>{fmt(g.totals.opening)}</td>
        <td className={numCell}>{fmt(g.totals.period)}</td>
        <td className={`${numCell} font-bold`}>{fmt(g.totals.closing)}</td>
        <td className={`${numCell} font-bold text-sky-800`}>{fmt(g.totals.remaining)}</td>
        <td className={numCell}>
          {g.totals.total > 0 ? `${fmt((g.totals.closing / g.totals.total) * 100)}%` : "—"}
        </td>
      </tr>
      {g.rows.map((r) => {
        const monthsOpen = openMonths.has(r.adjustmentId);
        const MChevron = monthsOpen ? ChevronDown : ChevronLeft;
        return (
          <AdjRows
            key={r.adjustmentId}
            r={r}
            numCell={numCell}
            hidden={!expanded}
            monthsOpen={monthsOpen}
            MChevron={MChevron}
            onToggleMonths={() => onToggleMonths(r.adjustmentId)}
          />
        );
      })}
    </>
  );
}

function AdjRows({
  r, numCell, hidden, monthsOpen, MChevron, onToggleMonths,
}: {
  r: Row; numCell: string; hidden: boolean; monthsOpen: boolean;
  MChevron: any; onToggleMonths: () => void;
}) {
  const rowCls = hidden ? "hidden print:table-row" : "";
  return (
    <>
      <tr className={`hover:bg-slate-50 ${rowCls}`}>
        <td className="py-1 pe-2 ps-7 text-right whitespace-nowrap">
          <button
            type="button"
            onClick={onToggleMonths}
            className="inline-flex items-center gap-1 text-right print:pointer-events-none"
            title="عرض تفاصيل الشهور"
          >
            <MChevron className="h-3.5 w-3.5 shrink-0 text-slate-400 print:hidden" />
            <span>{r.name}</span>
          </button>
          <span className="mr-1 text-[10px] text-slate-400">
            ({STATUS_LABELS[r.status] ?? r.status})
          </span>
          {r.costCenter && (
            <span className="mr-1 text-[10px] text-violet-500">• {r.costCenter}</span>
          )}
        </td>
        <td className="px-2 py-1 text-center whitespace-nowrap">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
            r.type === "prepaid" ? "bg-sky-100 text-sky-700" : "bg-orange-100 text-orange-700"
          }`}>
            {TYPE_LABELS[r.type] ?? r.type}
          </span>
        </td>
        <td className="px-2 py-1 text-center whitespace-nowrap text-[11px]">
          {r.startDate} ← {r.endDate}
          <span className="text-slate-400"> ({r.monthsCount} شهر)</span>
        </td>
        <td className={numCell}>{fmt(r.monthlyAmount)}</td>
        <td className={`${numCell} font-semibold`}>{fmt(r.total)}</td>
        <td className={numCell}>{fmt(r.opening)}</td>
        <td className={numCell}>{fmt(r.period)}</td>
        <td className={`${numCell} font-semibold`}>{fmt(r.closing)}</td>
        <td className={`${numCell} font-bold text-sky-800`}>{fmt(r.remaining)}</td>
        <td className={numCell}>
          <div className="flex items-center gap-1 justify-center">
            <div className="w-12 h-1.5 bg-slate-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full"
                style={{ width: `${Math.min(100, r.progressPct)}%` }}
              />
            </div>
            <span className="text-[10px]">{fmt(r.progressPct)}%</span>
          </div>
        </td>
      </tr>
      {/* Month-by-month detail (posted + draft flagged) */}
      {monthsOpen && !hidden && (
        <tr>
          <td colSpan={10} className="p-0 border-b border-slate-200">
            <div className="bg-slate-50/70 px-8 py-2">
              <table className="text-[11px] border-collapse">
                <thead>
                  <tr className="text-slate-500">
                    <th className="px-3 py-1 text-right font-semibold">الشهر</th>
                    <th className="px-3 py-1 text-center font-semibold">المبلغ</th>
                    <th className="px-3 py-1 text-center font-semibold">رقم القيد</th>
                    <th className="px-3 py-1 text-center font-semibold">حالة القيد</th>
                  </tr>
                </thead>
                <tbody>
                  {r.runs.length === 0 && (
                    <tr><td colSpan={4} className="px-3 py-1.5 text-slate-400">لم تُنشأ قيود بعد</td></tr>
                  )}
                  {r.runs.map((run) => (
                    <tr key={run.ym} className={run.posted ? "" : "text-slate-400 italic"}>
                      <td className="px-3 py-1 text-right font-mono">{run.ym}</td>
                      <td className="px-3 py-1 text-center font-mono tabular-nums">{fmt(run.amount)}</td>
                      <td className="px-3 py-1 text-center font-mono">
                        {run.jeId ? (
                          <Link href={`/accounting/journals/${run.jeId}`} className="text-sky-600 hover:underline">
                            {run.jeNumber ?? `#${run.jeId}`}
                          </Link>
                        ) : "—"}
                      </td>
                      <td className="px-3 py-1 text-center">
                        {run.posted
                          ? <span className="text-emerald-600 font-semibold">مرحّل</span>
                          : <span>مسودة (غير محتسب)</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
