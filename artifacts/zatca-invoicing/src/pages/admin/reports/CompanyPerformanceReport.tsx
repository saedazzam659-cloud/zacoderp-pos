import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Download, Loader2, Search, BarChart3, TrendingUp, TrendingDown, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/contexts/AuthContext";
import { PeriodSelector, periodToQuery, usePeriodState, useStoredSearch } from "./shared/PeriodSelector";
import { downloadCsv } from "./shared/downloadCsv";

interface PerfRow {
  companyId: number; companyName: string;
  revenue: number; invoiceCount: number; avgInvoice: number;
  prevRevenue: number; growthPct: number | null;
}
interface PerfResp {
  period: { from: string; to: string; prevFrom: string; prevTo: string };
  rows: PerfRow[];
}

const fmt = new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const fmtInt = new Intl.NumberFormat("ar-SA");

type SortKey = "revenue" | "invoiceCount" | "avgInvoice" | "growthPct";

export default function CompanyPerformanceReport() {
  const { token } = useAuth();
  // storageKey persists this report's period+search in localStorage so the
  // admin returns to the same window after navigating away (e.g. month-end close).
  const period = usePeriodState("this_month", "company-performance");
  const [search, setSearch] = useStoredSearch("company-performance");
  const [sortKey, setSortKey] = useState<SortKey>("revenue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Backend filters by name when ?search is set so CSV export matches the
  // visible table. Sorting stays client-side so the CSV is sorted by the
  // backend's deterministic order (revenue desc) — that's intentional, the
  // CSV is canonical and not affected by transient UI sort.
  const queryString = useMemo(() => {
    const qs = new URLSearchParams(periodToQuery(period));
    if (search.trim()) qs.set("search", search.trim());
    return qs.toString();
  }, [period.preset, period.from, period.to, search]);

  const { data, isLoading, error } = useQuery<PerfResp>({
    queryKey: ["report-company-performance", queryString],
    queryFn: async () => {
      const r = await fetch(`/api/admin/reports/company-performance?${queryString}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "تعذر التحميل");
      return r.json();
    },
  });

  const filtered = useMemo(() => {
    const rows = data?.rows ?? [];
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      return (Number(av) - Number(bv)) * dir;
    });
  }, [data, sortKey, sortDir]);

  const totals = useMemo(() => ({
    revenue: filtered.reduce((s, r) => s + r.revenue, 0),
    invoiceCount: filtered.reduce((s, r) => s + r.invoiceCount, 0),
  }), [filtered]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("desc"); }
  }

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <Link href="/admin/reports">
            <a className="text-muted-foreground hover:text-primary flex items-center gap-1 text-sm">
              <ArrowRight className="h-4 w-4" /> رجوع
            </a>
          </Link>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-primary" /> أداء الشركات
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground hidden sm:inline" title="ترتيب التصدير ثابت بحسب الإيرادات تنازلياً، بصرف النظر عن ترتيب الجدول المعروض">
            (مرتّب بالإيرادات تنازلياً)
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadCsv(token, `/api/admin/reports/company-performance?${queryString}&format=csv`, `company-performance-${period.from}_${period.to}.csv`)}
            disabled={!data || filtered.length === 0}
          >
            <Download className="h-4 w-4 ml-1" /> تصدير CSV
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 p-3 border rounded-lg bg-muted/20">
        <PeriodSelector period={period} />
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs text-muted-foreground block mb-1">بحث باسم الشركة</label>
          <div className="relative">
            <Search className="h-4 w-4 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="اسم الشركة..." className="pr-9" />
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { period.reset(); setSearch(""); }}
          title="إعادة الفترة الافتراضية ومسح البحث"
        >
          <RotateCcw className="h-4 w-4 ml-1" /> إعادة الضبط
        </Button>
      </div>

      {error && <div className="text-rose-700 bg-rose-50 border border-rose-200 rounded p-3 text-sm">{(error as Error).message}</div>}

      <div className="border rounded-lg overflow-x-auto">
        {isLoading ? (
          <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">الشركة</TableHead>
                <SortableHead label="الإيرادات" k="revenue" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHead label="عدد الفواتير" k="invoiceCount" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHead label="متوسط الفاتورة" k="avgInvoice" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHead label="نمو %" k="growthPct" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">لا توجد بيانات للفترة المحددة.</TableCell></TableRow>
              ) : filtered.map(r => (
                <TableRow key={r.companyId}>
                  <TableCell className="font-medium">{r.companyName}</TableCell>
                  <TableCell className="tabular-nums">{fmt.format(r.revenue)}</TableCell>
                  <TableCell className="tabular-nums">{fmtInt.format(r.invoiceCount)}</TableCell>
                  <TableCell className="tabular-nums">{fmt.format(r.avgInvoice)}</TableCell>
                  <TableCell className="tabular-nums">
                    {r.growthPct == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : r.growthPct >= 0 ? (
                      <span className="text-emerald-700 inline-flex items-center gap-1">
                        <TrendingUp className="h-3 w-3" /> {fmt.format(r.growthPct)}%
                      </span>
                    ) : (
                      <span className="text-rose-700 inline-flex items-center gap-1">
                        <TrendingDown className="h-3 w-3" /> {fmt.format(r.growthPct)}%
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length > 0 && (
                <TableRow className="bg-muted/40 font-bold">
                  <TableCell>الإجمالي</TableCell>
                  <TableCell className="tabular-nums">{fmt.format(totals.revenue)}</TableCell>
                  <TableCell className="tabular-nums">{fmtInt.format(totals.invoiceCount)}</TableCell>
                  <TableCell colSpan={2} />
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function SortableHead({
  label, k, sortKey, sortDir, onSort,
}: {
  label: string; k: SortKey; sortKey: SortKey; sortDir: "asc" | "desc"; onSort: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  return (
    <TableHead className="text-right">
      <button onClick={() => onSort(k)} className={`inline-flex items-center gap-1 ${active ? "text-primary" : ""}`}>
        {label} {active && (sortDir === "asc" ? "▲" : "▼")}
      </button>
    </TableHead>
  );
}
