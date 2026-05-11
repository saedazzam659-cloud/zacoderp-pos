import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import BranchFilter from "@/components/BranchFilter";
import ExportButtons from "@/components/ExportButtons";
import {
  Sparkles, TrendingUp, TrendingDown, Target, Zap, Shield,
  Lightbulb, Printer, AlertCircle, FileBarChart2, Briefcase,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type YearRow = { year: number; revenue: number; expenses: number; netIncome: number; growthPct?: number };
type Scenarios = { optimistic: YearRow[]; realistic: YearRow[]; conservative: YearRow[] };
type ForecastResp = {
  generatedAt: string;
  currentYear: number;
  horizonYears: number;
  historical: YearRow[];
  ytd: YearRow;
  commitments: {
    pendingSalesOrders:    { total: number; count: number };
    openQuotations:        { total: number; count: number };
    openPurchaseOrders:    { total: number; count: number };
    openMaintenanceOrders: { total: number; count: number };
    ytdRevenue: number;
    ytdExpenses: number;
  };
  scenarios: Scenarios;
  insights: string[];
  summary: string;
  aiUsed: boolean;
};

const SCENARIO_META = {
  optimistic:   { color: "emerald", icon: TrendingUp, ringClass: "ring-emerald-300 bg-emerald-50/50",   accent: "text-emerald-700",   barClass: "bg-emerald-500" },
  realistic:    { color: "sky",     icon: Target,     ringClass: "ring-sky-300 bg-sky-50/50",           accent: "text-sky-700",       barClass: "bg-sky-500" },
  conservative: { color: "amber",   icon: Shield,     ringClass: "ring-amber-300 bg-amber-50/50",       accent: "text-amber-700",     barClass: "bg-amber-500" },
} as const;

type ScenarioKey = keyof Scenarios;

export default function ForecastIncomeStatement() {
  const { user, token } = useAuth() as any;
  const { t } = useTranslation();
  const { fmt } = useFormatters();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [horizon, setHorizon] = useState<3 | 5 | 10>(5);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [active, setActive] = useState<ScenarioKey>("realistic");

  const mutation = useMutation<ForecastResp>({
    mutationFn: async () => {
      const params = new URLSearchParams();
      if (cid) params.set("companyId", String(cid));
      if (branchId) params.set("branchId", String(branchId));
      const res = await fetch(`${API}/api/accounting-reports/forecast-income-statement?${params}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ horizonYears: horizon }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "request failed");
      return res.json();
    },
  });

  const data = mutation.data;
  const scenario = data?.scenarios[active] ?? [];
  const meta = SCENARIO_META[active];
  const ScenarioIcon = meta.icon;

  // Combined chart series: historical + selected scenario
  const chartData = data ? [
    ...data.historical.map(h => ({ year: String(h.year), historical: h.netIncome, forecast: null as number | null, revenue: h.revenue, expenses: h.expenses })),
    { year: String(data.currentYear), historical: data.ytd.netIncome, forecast: data.ytd.netIncome, revenue: data.ytd.revenue, expenses: data.ytd.expenses },
    ...scenario.map(s => ({ year: String(s.year), historical: null as number | null, forecast: s.netIncome, revenue: s.revenue, expenses: s.expenses })),
  ] : [];

  // 3-scenario comparison series
  const comparisonData = data ? data.scenarios.realistic.map((_, idx) => ({
    year: String(data.scenarios.realistic[idx].year),
    optimistic:   data.scenarios.optimistic[idx]?.netIncome ?? 0,
    realistic:    data.scenarios.realistic[idx]?.netIncome ?? 0,
    conservative: data.scenarios.conservative[idx]?.netIncome ?? 0,
  })) : [];

  const exportRows = data ? [
    ...data.historical.map(h => ({ kind: t("forecastIncomeStatement.actual"), year: h.year, revenue: h.revenue, expenses: h.expenses, netIncome: h.netIncome })),
    { kind: t("forecastIncomeStatement.ytd"), year: data.ytd.year, revenue: data.ytd.revenue, expenses: data.ytd.expenses, netIncome: data.ytd.netIncome },
    ...scenario.map(s => ({ kind: t(`forecastIncomeStatement.${active}`), year: s.year, revenue: s.revenue, expenses: s.expenses, netIncome: s.netIncome })),
  ] : [];

  const exportCols = [
    { key: "kind",      header: t("forecastIncomeStatement.kind"),       width: 18 },
    { key: "year",      header: t("forecastIncomeStatement.year"),       width: 10 },
    { key: "revenue",   header: t("incomeStatement.totalRevenues"),      width: 18 },
    { key: "expenses",  header: t("incomeStatement.totalExpenses"),      width: 18 },
    { key: "netIncome", header: t("forecastIncomeStatement.netIncome"),  width: 18 },
  ];

  return (
    <div className="space-y-5">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-violet-600" />
            {t("forecastIncomeStatement.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("forecastIncomeStatement.subtitle")}
          </p>
        </div>
        {data && (
          <div className="flex gap-2">
            <ExportButtons rows={exportRows} columns={exportCols}
              filename={`${t("forecastIncomeStatement.filename_prefix")}-${active}-${horizon}y`}
              title={t("forecastIncomeStatement.title")} />
            <Button variant="outline" size="sm" className="gap-2" onClick={() => window.print()}>
              <Printer className="h-4 w-4" />{t("accountingReports.print")}
            </Button>
          </div>
        )}
      </div>

      {/* ── Filters ────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-gradient-to-br from-violet-50 via-white to-sky-50 p-4 shadow-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
          <div className="space-y-1.5">
            <Label>{t("forecastIncomeStatement.horizon")}</Label>
            <Select value={String(horizon)} onValueChange={v => setHorizon(Number(v) as 3 | 5 | 10)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="3">{t("forecastIncomeStatement.years3")}</SelectItem>
                <SelectItem value="5">{t("forecastIncomeStatement.years5")}</SelectItem>
                <SelectItem value="10">{t("forecastIncomeStatement.years10")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <BranchFilter value={branchId} onChange={setBranchId} />
          <div className="lg:col-span-2 flex justify-end">
            <Button
              size="lg"
              className="gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white shadow-md"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              <Sparkles className={cn("h-5 w-5", mutation.isPending && "animate-pulse")} />
              {mutation.isPending
                ? t("forecastIncomeStatement.generating")
                : t("forecastIncomeStatement.generate")}
            </Button>
          </div>
        </div>
        {!data && !mutation.isPending && (
          <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1.5">
            <Lightbulb className="h-3.5 w-3.5 text-amber-500" />
            {t("forecastIncomeStatement.hintHowItWorks")}
          </p>
        )}
      </div>

      {/* ── Error ──────────────────────────────────────────────────── */}
      {mutation.isError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {(mutation.error as Error)?.message || t("forecastIncomeStatement.error")}
        </div>
      )}

      {data && data.historical.every(h => h.revenue === 0 && h.expenses === 0) && data.ytd.revenue === 0 && data.ytd.expenses === 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center">
          <AlertCircle className="h-8 w-8 text-amber-500 mx-auto mb-2" />
          <h3 className="font-bold text-amber-900 mb-1">{t("forecastIncomeStatement.noDataTitle")}</h3>
          <p className="text-sm text-amber-800">{t("forecastIncomeStatement.noDataMsg")}</p>
        </div>
      )}

      {data && !(data.historical.every(h => h.revenue === 0 && h.expenses === 0) && data.ytd.revenue === 0 && data.ytd.expenses === 0) && (
        <>
          {/* ── AI summary banner ──────────────────────────────────── */}
          {data.summary && (
            <div className="rounded-xl border-2 border-violet-200 bg-gradient-to-br from-violet-50 to-fuchsia-50 p-5 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-violet-600 text-white p-2 shrink-0">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-bold text-violet-900 mb-1">
                    {data.aiUsed
                      ? t("forecastIncomeStatement.aiSummary")
                      : t("forecastIncomeStatement.heuristicSummary")}
                  </h3>
                  <p className="text-sm text-violet-800 leading-relaxed">{data.summary}</p>
                </div>
              </div>
            </div>
          )}

          {/* ── Commitments strip ──────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <CommitmentCard
              title={t("forecastIncomeStatement.commitPendingSales")}
              total={data.commitments.pendingSalesOrders.total}
              count={data.commitments.pendingSalesOrders.count}
              tone="emerald" fmt={fmt}
            />
            <CommitmentCard
              title={t("forecastIncomeStatement.commitQuotations")}
              total={data.commitments.openQuotations.total}
              count={data.commitments.openQuotations.count}
              tone="sky" fmt={fmt}
            />
            <CommitmentCard
              title={t("forecastIncomeStatement.commitPurchaseOrders")}
              total={data.commitments.openPurchaseOrders.total}
              count={data.commitments.openPurchaseOrders.count}
              tone="amber" fmt={fmt}
            />
            <CommitmentCard
              title={t("forecastIncomeStatement.commitMaintenance")}
              total={data.commitments.openMaintenanceOrders.total}
              count={data.commitments.openMaintenanceOrders.count}
              tone="rose" fmt={fmt}
            />
          </div>

          {/* ── Scenario tabs (3 cards) ────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(["optimistic", "realistic", "conservative"] as ScenarioKey[]).map(k => {
              const m = SCENARIO_META[k];
              const Icon = m.icon;
              const last = data.scenarios[k][data.scenarios[k].length - 1];
              const isActive = active === k;
              return (
                <button
                  key={k}
                  onClick={() => setActive(k)}
                  className={cn(
                    "text-start rounded-xl border-2 px-4 py-4 transition-all",
                    isActive ? `ring-2 ${m.ringClass} border-${m.color}-400 shadow-md` : "border-transparent bg-white hover:bg-muted/30"
                  )}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <div className={cn("p-1.5 rounded-lg", `bg-${m.color}-100`)}>
                      <Icon className={cn("h-4 w-4", m.accent)} />
                    </div>
                    <span className={cn("font-bold text-sm", m.accent)}>
                      {t(`forecastIncomeStatement.${k}`)}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mb-1">
                    {t("forecastIncomeStatement.netIncomeIn", { year: last?.year })}
                  </div>
                  <div className={cn("font-mono text-lg font-bold", last?.netIncome >= 0 ? m.accent : "text-rose-700")}>
                    {fmt(Math.abs(last?.netIncome ?? 0))}
                    {(last?.netIncome ?? 0) < 0 && (
                      <span className="text-xs ms-1">({t("forecastIncomeStatement.loss")})</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* ── Net income trajectory chart (selected scenario) ─── */}
          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <FileBarChart2 className="h-5 w-5 text-violet-600" />
              <h3 className="font-bold">
                {t("forecastIncomeStatement.netIncomeTrajectory")} —{" "}
                <span className={meta.accent}>{t(`forecastIncomeStatement.${active}`)}</span>
              </h3>
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 24, left: 12, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="year" />
                  <YAxis tickFormatter={(v) => fmt(v)} width={90} />
                  <Tooltip formatter={(v: any) => (v === null ? "—" : fmt(Number(v)))} />
                  <Legend />
                  <Line
                    type="monotone" dataKey="historical" name={t("forecastIncomeStatement.actual")}
                    stroke="#475569" strokeWidth={2.5} dot={{ r: 4 }} connectNulls
                  />
                  <Line
                    type="monotone" dataKey="forecast" name={t("forecastIncomeStatement.forecast")}
                    stroke={active === "optimistic" ? "#10b981" : active === "realistic" ? "#0284c7" : "#d97706"}
                    strokeWidth={2.5} strokeDasharray="6 4" dot={{ r: 4 }} connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ── 3-scenario comparison chart ──────────────────────── */}
          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="h-5 w-5 text-fuchsia-600" />
              <h3 className="font-bold">{t("forecastIncomeStatement.scenarioComparison")}</h3>
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={comparisonData} margin={{ top: 10, right: 24, left: 12, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="year" />
                  <YAxis tickFormatter={(v) => fmt(v)} width={90} />
                  <Tooltip formatter={(v: any) => fmt(Number(v))} />
                  <Legend />
                  <Bar dataKey="optimistic"   name={t("forecastIncomeStatement.optimistic")}   fill="#10b981" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="realistic"    name={t("forecastIncomeStatement.realistic")}    fill="#0284c7" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="conservative" name={t("forecastIncomeStatement.conservative")} fill="#d97706" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ── Detail table for selected scenario ───────────────── */}
          <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
            <div className={cn("px-5 py-3 font-bold border-b flex items-center gap-2", meta.ringClass, meta.accent)}>
              <ScenarioIcon className="h-4 w-4" />
              {t("forecastIncomeStatement.detailedPL")} — {t(`forecastIncomeStatement.${active}`)}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="text-start px-4 py-2 font-medium">{t("forecastIncomeStatement.year")}</th>
                    <th className="text-end   px-4 py-2 font-medium">{t("incomeStatement.totalRevenues")}</th>
                    <th className="text-end   px-4 py-2 font-medium">{t("incomeStatement.totalExpenses")}</th>
                    <th className="text-end   px-4 py-2 font-medium">{t("forecastIncomeStatement.netIncome")}</th>
                    <th className="text-end   px-4 py-2 font-medium">{t("forecastIncomeStatement.growth")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.historical.map(h => (
                    <tr key={`h-${h.year}`} className="border-b bg-slate-50/40">
                      <td className="px-4 py-2 font-medium">
                        {h.year}
                        <span className="ms-2 text-[10px] uppercase tracking-wide text-muted-foreground bg-slate-200 px-1.5 py-0.5 rounded">
                          {t("forecastIncomeStatement.actual")}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-end font-mono">{fmt(h.revenue)}</td>
                      <td className="px-4 py-2 text-end font-mono">{fmt(h.expenses)}</td>
                      <td className={cn("px-4 py-2 text-end font-mono font-semibold", h.netIncome >= 0 ? "text-emerald-700" : "text-rose-700")}>
                        {fmt(h.netIncome)}
                      </td>
                      <td className="px-4 py-2 text-end text-muted-foreground">—</td>
                    </tr>
                  ))}
                  <tr className="border-b bg-amber-50/50">
                    <td className="px-4 py-2 font-medium">
                      {data.ytd.year}
                      <span className="ms-2 text-[10px] uppercase tracking-wide text-amber-800 bg-amber-200 px-1.5 py-0.5 rounded">
                        {t("forecastIncomeStatement.ytd")}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-end font-mono">{fmt(data.ytd.revenue)}</td>
                    <td className="px-4 py-2 text-end font-mono">{fmt(data.ytd.expenses)}</td>
                    <td className={cn("px-4 py-2 text-end font-mono font-semibold", data.ytd.netIncome >= 0 ? "text-emerald-700" : "text-rose-700")}>
                      {fmt(data.ytd.netIncome)}
                    </td>
                    <td className="px-4 py-2 text-end text-muted-foreground">—</td>
                  </tr>
                  {scenario.map(s => (
                    <tr key={`f-${s.year}`} className="border-b">
                      <td className="px-4 py-2 font-medium">
                        {s.year}
                        <span className={cn("ms-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded", `bg-${meta.color}-100`, meta.accent)}>
                          {t("forecastIncomeStatement.forecast")}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-end font-mono">{fmt(s.revenue)}</td>
                      <td className="px-4 py-2 text-end font-mono">{fmt(s.expenses)}</td>
                      <td className={cn("px-4 py-2 text-end font-mono font-semibold", s.netIncome >= 0 ? meta.accent : "text-rose-700")}>
                        {fmt(s.netIncome)}
                      </td>
                      <td className="px-4 py-2 text-end font-mono text-xs text-muted-foreground">
                        {s.growthPct !== undefined ? `${s.growthPct > 0 ? "+" : ""}${s.growthPct}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── AI insights ─────────────────────────────────────── */}
          {data.insights.length > 0 && (
            <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
              <div className="bg-amber-50 text-amber-900 px-5 py-3 font-bold flex items-center gap-2 border-b">
                <Lightbulb className="h-5 w-5 text-amber-600" />
                {t("forecastIncomeStatement.insights")}
              </div>
              <ul className="p-4 space-y-2.5">
                {data.insights.map((ins, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className="mt-0.5 h-5 w-5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold inline-flex items-center justify-center shrink-0">
                      {i + 1}
                    </span>
                    <span className="leading-relaxed">{ins}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="text-xs text-muted-foreground text-center pt-1">
            <Briefcase className="h-3 w-3 inline mb-0.5 me-1" />
            {t("forecastIncomeStatement.disclaimer")}
          </div>
        </>
      )}
    </div>
  );
}

function CommitmentCard({
  title, total, count, tone, fmt,
}: { title: string; total: number; count: number; tone: "emerald" | "sky" | "amber" | "rose"; fmt: (n: number) => string }) {
  const toneClass = {
    emerald: "from-emerald-50 to-emerald-100/40 text-emerald-800 border-emerald-200",
    sky:     "from-sky-50 to-sky-100/40 text-sky-800 border-sky-200",
    amber:   "from-amber-50 to-amber-100/40 text-amber-800 border-amber-200",
    rose:    "from-rose-50 to-rose-100/40 text-rose-800 border-rose-200",
  }[tone];
  return (
    <div className={cn("rounded-xl border p-3 bg-gradient-to-br shadow-sm", toneClass)}>
      <div className="text-xs font-medium opacity-80">{title}</div>
      <div className="font-mono text-lg font-bold mt-1">{fmt(total)}</div>
      <div className="text-[11px] opacity-70 mt-0.5">{count} عنصر</div>
    </div>
  );
}
