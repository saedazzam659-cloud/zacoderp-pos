import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Download, Loader2, PieChart as PieIcon, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { useAuth } from "@/contexts/AuthContext";
import { downloadCsv } from "./shared/downloadCsv";
import { PeriodSelector, periodToQuery, usePeriodState } from "./shared/PeriodSelector";

interface PlanRow {
  plan: string; billingCycle: string;
  subscriptionCount: number; totalBilled: number;
}
interface ReportPeriod { from: string; to: string; days: number; prevFrom: string; prevTo: string }
interface Resp { period: ReportPeriod; rows: PlanRow[]; total: number }

const fmt = new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const fmtSAR = (n: number) => `${fmt.format(n)} ر.س`;

const COLORS = ["#0ea5e9", "#10b981", "#f59e0b", "#a855f7", "#ec4899", "#6366f1", "#14b8a6", "#ef4444"];

const PLAN_LABEL: Record<string, string> = {
  starter: "مبتدئ", professional: "احترافي", enterprise: "مؤسسي", custom: "مخصص",
};
const CYCLE_LABEL: Record<string, string> = { monthly: "شهري", yearly: "سنوي" };

export default function RevenueByPlanReport() {
  const { token } = useAuth();
  const period = usePeriodState();
  const [search, setSearch] = useState("");

  const queryString = useMemo(() => {
    const qs = new URLSearchParams(periodToQuery(period));
    if (search.trim()) qs.set("search", search.trim());
    return qs.toString();
  }, [period.preset, period.from, period.to, search]);

  const { data, isLoading, error } = useQuery<Resp>({
    queryKey: ["report-revenue-by-plan", queryString],
    queryFn: async () => {
      const r = await fetch(`/api/admin/reports/revenue-by-plan?${queryString}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "تعذر التحميل");
      return r.json();
    },
  });

  const chartData = useMemo(() => (data?.rows ?? []).map((r, i) => ({
    name: `${PLAN_LABEL[r.plan] ?? r.plan} - ${CYCLE_LABEL[r.billingCycle] ?? r.billingCycle}`,
    value: r.totalBilled,
    color: COLORS[i % COLORS.length],
  })), [data]);

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
            <PieIcon className="h-5 w-5 text-primary" /> الإيرادات حسب الباقة
          </h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => downloadCsv(token, `/api/admin/reports/revenue-by-plan?${queryString}&format=csv`, `revenue-by-plan-${period.from}_${period.to}.csv`)}
          disabled={!data || data.rows.length === 0}
        >
          <Download className="h-4 w-4 ml-1" /> تصدير CSV
        </Button>
      </div>

      <div className="flex items-end gap-3 flex-wrap bg-muted/40 border rounded-lg p-3">
        <PeriodSelector period={period} />
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs text-muted-foreground block mb-1">بحث باسم الشركة</label>
          <div className="relative">
            <Search className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} className="pr-8" placeholder="اسم الشركة..." />
          </div>
        </div>
      </div>

      {error && <div className="text-rose-700 bg-rose-50 border border-rose-200 rounded p-3 text-sm">{(error as Error).message}</div>}

      {isLoading ? (
        <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : (data?.rows.length ?? 0) === 0 ? (
        <div className="text-center text-muted-foreground py-16 border rounded-lg">
          لا توجد إيرادات في الفترة المحددة.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="border rounded-lg p-4">
            <div className="text-sm font-bold mb-3">التوزيع</div>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={2}
                >
                  {chartData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => fmtSAR(v)} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
            <div className="text-center text-xs text-muted-foreground mt-2">
              الإجمالي: <span className="font-bold text-foreground">{fmtSAR(data?.total ?? 0)}</span>
            </div>
          </div>

          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">الباقة</TableHead>
                  <TableHead className="text-right">الدورة</TableHead>
                  <TableHead className="text-right">عدد الشركات</TableHead>
                  <TableHead className="text-right">إجمالي الإيرادات</TableHead>
                  <TableHead className="text-right">الحصة %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.rows.map((r, i) => {
                  const pct = (data.total > 0) ? (r.totalBilled / data.total) * 100 : 0;
                  return (
                    <TableRow key={`${r.plan}-${r.billingCycle}`}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="inline-block h-3 w-3 rounded" style={{ background: COLORS[i % COLORS.length] }} />
                          {PLAN_LABEL[r.plan] ?? r.plan}
                        </div>
                      </TableCell>
                      <TableCell>{CYCLE_LABEL[r.billingCycle] ?? r.billingCycle}</TableCell>
                      <TableCell className="tabular-nums">{r.subscriptionCount}</TableCell>
                      <TableCell className="tabular-nums">{fmtSAR(r.totalBilled)}</TableCell>
                      <TableCell className="tabular-nums">{fmt.format(pct)}%</TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="bg-muted/40 font-bold">
                  <TableCell colSpan={3}>الإجمالي</TableCell>
                  <TableCell className="tabular-nums">{fmtSAR(data?.total ?? 0)}</TableCell>
                  <TableCell className="tabular-nums">100.00%</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
