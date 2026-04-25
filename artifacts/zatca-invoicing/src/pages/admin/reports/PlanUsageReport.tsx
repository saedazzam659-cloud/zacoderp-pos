import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Download, Loader2, Search, Gauge, AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { PeriodSelector, periodToQuery, usePeriodState, useStoredSearch } from "./shared/PeriodSelector";
import { downloadCsv } from "./shared/downloadCsv";

interface UsageMetric { actual: number; max: number }
interface UsageRow {
  subscriptionId: number; companyId: number; companyName: string; companyStatus: string;
  plan: string; billingCycle: string;
  startDate: string; endDate: string; price: number; isActive: boolean;
  users: UsageMetric; branches: UsageMetric; warehouses: UsageMetric; invoices: UsageMetric;
  overLimit: boolean;
}
interface UsageResp {
  period: { from: string; to: string };
  rows: UsageRow[];
}

const fmtInt = new Intl.NumberFormat("ar-SA");

export default function PlanUsageReport() {
  const { token } = useAuth();
  // Persist filters per report so the admin returns to the same view.
  const period = usePeriodState("this_month", "plan-usage");
  const [search, setSearch] = useStoredSearch("plan-usage");
  const [onlyOver, setOnlyOver] = useState(false);

  // All filters (search + onlyOver) are sent to the backend so CSV export
  // and the visible table stay in sync.
  const queryString = useMemo(() => {
    const qs = new URLSearchParams(periodToQuery(period));
    if (search.trim()) qs.set("search", search.trim());
    if (onlyOver) qs.set("onlyOver", "true");
    return qs.toString();
  }, [period.preset, period.from, period.to, search, onlyOver]);

  const { data, isLoading, error } = useQuery<UsageResp>({
    queryKey: ["report-plan-usage", queryString],
    queryFn: async () => {
      const r = await fetch(`/api/admin/reports/plan-usage?${queryString}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "تعذر التحميل");
      return r.json();
    },
  });

  const filtered = data?.rows ?? [];

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
            <Gauge className="h-5 w-5 text-primary" /> استخدام الباقات
          </h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => downloadCsv(token, `/api/admin/reports/plan-usage?${queryString}&format=csv`, `plan-usage-${period.from}_${period.to}.csv`)}
          disabled={!data || filtered.length === 0}
        >
          <Download className="h-4 w-4 ml-1" /> تصدير CSV
        </Button>
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
        <label className="flex items-center gap-2 text-sm cursor-pointer pb-2">
          <input type="checkbox" checked={onlyOver} onChange={e => setOnlyOver(e.target.checked)} />
          المتجاوزة فقط
        </label>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { period.reset(); setSearch(""); setOnlyOver(false); }}
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
                <TableHead className="text-right">الباقة</TableHead>
                <TableHead className="text-right">الدورة</TableHead>
                <TableHead className="text-right w-[180px]">المستخدمون</TableHead>
                <TableHead className="text-right w-[180px]">الفروع</TableHead>
                <TableHead className="text-right w-[180px]">المخازن</TableHead>
                <TableHead className="text-right w-[180px]">الفواتير في الفترة</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">لا توجد بيانات.</TableCell></TableRow>
              ) : filtered.map(r => (
                <TableRow key={r.subscriptionId} className={r.overLimit ? "bg-rose-50/40" : ""}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {r.companyName}
                      {r.overLimit && (
                        <Badge variant="outline" className="text-[10px] border-rose-400 text-rose-700">
                          <AlertTriangle className="h-3 w-3 ml-0.5" /> متجاوزة
                        </Badge>
                      )}
                      {!r.isActive && (
                        <Badge variant="outline" className="text-[10px] border-slate-400 text-slate-600">موقوف</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell><Badge variant="outline">{r.plan}</Badge></TableCell>
                  <TableCell className="text-xs">{r.billingCycle === "yearly" ? "سنوي" : "شهري"}</TableCell>
                  <UsageBarCell metric={r.users} />
                  <UsageBarCell metric={r.branches} />
                  <UsageBarCell metric={r.warehouses} />
                  <UsageBarCell metric={r.invoices} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function UsageBarCell({ metric }: { metric: UsageMetric }) {
  const pct = metric.max > 0 ? Math.min(100, (metric.actual / metric.max) * 100) : 0;
  const over = metric.actual > metric.max;
  // Color steps: green ≤60, amber ≤90, red >90 or over.
  const barColor = over || pct > 100 ? "bg-rose-500" : pct >= 90 ? "bg-rose-400" : pct >= 60 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <TableCell>
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs tabular-nums">
          <span className={over ? "text-rose-700 font-bold" : ""}>{fmtInt.format(metric.actual)}</span>
          <span className="text-muted-foreground">/ {fmtInt.format(metric.max)}</span>
        </div>
        <div className="h-1.5 bg-slate-200 rounded overflow-hidden">
          <div className={`h-full ${barColor} transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      </div>
    </TableCell>
  );
}
