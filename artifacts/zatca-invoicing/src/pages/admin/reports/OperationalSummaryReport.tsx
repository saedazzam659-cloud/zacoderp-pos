import { useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Download, Loader2, Search, Activity, AlertTriangle, CheckCircle2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { downloadCsv } from "./shared/downloadCsv";
import { PeriodSelector, periodToQuery, usePeriodState, useStoredBoolean, useStoredSearch } from "./shared/PeriodSelector";

interface OpsRow {
  companyId: number; companyName: string; companyStatus: string;
  customers: number; suppliers: number; items: number;
  openPosSessions: number;
  lastActivityAt: string | null; inactive: boolean;
  // Period-window counts. Backend also still emits the legacy `*7d`
  // aliases for one release window of compatibility.
  auditEventsPeriod: number; deniedPeriod: number;
  auditEvents7d?: number; denied7d?: number;
  latestBackupReason: string | null; latestBackupAt: string | null;
}
interface OpsResp {
  period: { from: string; to: string; prevFrom: string; prevTo: string };
  rows: OpsRow[];
}

const fmtInt = new Intl.NumberFormat("ar-SA");

export default function OperationalSummaryReport() {
  const { token } = useAuth();
  // Persist period + search + the inactive-only toggle across visits, so the
  // admin returns to the same view they left (e.g. month-end audit pass).
  const period = usePeriodState("this_month", "operational-summary");
  const [search, setSearch] = useStoredSearch("operational-summary");
  const [onlyInactive, setOnlyInactive] = useStoredBoolean("operational-summary:onlyInactive");

  const queryString = useMemo(() => {
    const qs = new URLSearchParams(periodToQuery(period));
    if (search.trim()) qs.set("search", search.trim());
    if (onlyInactive) qs.set("onlyInactive", "true");
    return qs.toString();
  }, [period.preset, period.from, period.to, search, onlyInactive]);

  const { data, isLoading, error } = useQuery<OpsResp>({
    queryKey: ["report-operational-summary", queryString],
    queryFn: async () => {
      const r = await fetch(`/api/admin/reports/operational-summary?${queryString}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "تعذر التحميل");
      return r.json();
    },
  });

  const rows = data?.rows ?? [];
  const periodLabel = data?.period
    ? `${data.period.from} → ${data.period.to}`
    : "";

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
            <Activity className="h-5 w-5 text-primary" /> الملخص التشغيلي
          </h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const fname = data?.period
              ? `operational-summary-${data.period.from}_${data.period.to}.csv`
              : `operational-summary.csv`;
            downloadCsv(token, `/api/admin/reports/operational-summary?${queryString}&format=csv`, fname);
          }}
          disabled={!data || rows.length === 0}
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
          <input type="checkbox" checked={onlyInactive} onChange={e => setOnlyInactive(e.target.checked)} />
          الراكدة فقط (أكثر من 30 يوم بدون نشاط)
        </label>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { period.reset(); setSearch(""); setOnlyInactive(false); }}
          title="إعادة الفترة الافتراضية ومسح البحث"
        >
          <RotateCcw className="h-4 w-4 ml-1" /> إعادة الضبط
        </Button>
        <p className="text-xs text-muted-foreground basis-full">
          أحداث التدقيق والمحاولات المرفوضة تُحسب ضمن الفترة المختارة
          {periodLabel && <> ({periodLabel})</>}.
          الشركة "راكدة" إذا لم يحدث أي نشاط خلال 30 يوماً (تنبيه ثابت بصرف النظر عن الفترة).
        </p>
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
                <TableHead className="text-right">عملاء</TableHead>
                <TableHead className="text-right">موردون</TableHead>
                <TableHead className="text-right">أصناف</TableHead>
                <TableHead className="text-right">جلسات POS</TableHead>
                <TableHead className="text-right">آخر نشاط</TableHead>
                <TableHead className="text-right">أحداث التدقيق (الفترة)</TableHead>
                <TableHead className="text-right">مرفوضة (الفترة)</TableHead>
                <TableHead className="text-right">نسخة احتياطية</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">لا توجد بيانات.</TableCell></TableRow>
              ) : rows.map(r => (
                <TableRow key={r.companyId} className={r.inactive ? "bg-amber-50/40" : ""}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {r.companyName}
                      {r.inactive && (
                        <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-700">
                          <AlertTriangle className="h-3 w-3 ml-0.5" /> راكدة
                        </Badge>
                      )}
                      {r.companyStatus !== "active" && (
                        <Badge variant="outline" className="text-[10px] border-rose-400 text-rose-700">
                          {r.companyStatus}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums">{fmtInt.format(r.customers)}</TableCell>
                  <TableCell className="tabular-nums">{fmtInt.format(r.suppliers)}</TableCell>
                  <TableCell className="tabular-nums">{fmtInt.format(r.items)}</TableCell>
                  <TableCell className="tabular-nums">
                    {r.openPosSessions > 0 ? (
                      <Badge variant="outline" className="text-[10px] border-emerald-400 text-emerald-700">{r.openPosSessions}</Badge>
                    ) : <span className="text-muted-foreground">0</span>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.lastActivityAt ? r.lastActivityAt.slice(0, 19).replace("T", " ") : "—"}</TableCell>
                  <TableCell className="tabular-nums">{fmtInt.format(r.auditEventsPeriod ?? r.auditEvents7d ?? 0)}</TableCell>
                  <TableCell className="tabular-nums">
                    {(r.deniedPeriod ?? r.denied7d ?? 0) > 0
                      ? <span className="text-rose-700 font-bold">{r.deniedPeriod ?? r.denied7d}</span>
                      : <span className="text-muted-foreground">0</span>}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.latestBackupAt == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-emerald-700">
                        <CheckCircle2 className="h-3 w-3" /> {r.latestBackupAt.slice(0, 10)}
                        {r.latestBackupReason && r.latestBackupReason !== "scheduled" && (
                          <span className="text-muted-foreground">({r.latestBackupReason})</span>
                        )}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
