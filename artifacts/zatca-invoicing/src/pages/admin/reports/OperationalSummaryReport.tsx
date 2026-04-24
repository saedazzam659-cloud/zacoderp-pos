import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Download, Loader2, Search, Activity, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { downloadCsv } from "./shared/downloadCsv";

interface OpsRow {
  companyId: number; companyName: string; companyStatus: string;
  customers: number; suppliers: number; items: number;
  openPosSessions: number;
  lastActivityAt: string | null; inactive: boolean;
  auditEvents7d: number; denied7d: number;
  latestBackupReason: string | null; latestBackupAt: string | null;
}
interface OpsResp { rows: OpsRow[] }

const fmtInt = new Intl.NumberFormat("ar-SA");

export default function OperationalSummaryReport() {
  const { token } = useAuth();
  const [search, setSearch] = useState("");
  const [onlyInactive, setOnlyInactive] = useState(false);

  // The KPIs on this report use fixed reporting windows per spec
  // (audit/denied = trailing 7 days, inactivity = trailing 30 days),
  // so there is no period selector — only search + inactive filter.
  const queryString = useMemo(() => {
    const qs = new URLSearchParams();
    if (search.trim()) qs.set("search", search.trim());
    if (onlyInactive) qs.set("onlyInactive", "true");
    return qs.toString();
  }, [search, onlyInactive]);

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
          onClick={() => downloadCsv(token, `/api/admin/reports/operational-summary?${queryString}&format=csv`, `operational-summary.csv`)}
          disabled={!data || rows.length === 0}
        >
          <Download className="h-4 w-4 ml-1" /> تصدير CSV
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 p-3 border rounded-lg bg-muted/20">
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs text-muted-foreground block mb-1">بحث باسم الشركة</label>
          <div className="relative">
            <Search className="h-4 w-4 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="اسم الشركة..." className="pr-9" />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer pb-2">
          <input type="checkbox" checked={onlyInactive} onChange={e => setOnlyInactive(e.target.checked)} />
          الراكدة فقط (>30 يوم بدون نشاط)
        </label>
        <p className="text-xs text-muted-foreground basis-full">
          أحداث التدقيق والمحاولات المرفوضة تُحسب للأيام السبعة الأخيرة. الشركة "راكدة" إذا لم يحدث أي نشاط خلال 30 يوماً.
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
                <TableHead className="text-right">أحداث التدقيق (7 أيام)</TableHead>
                <TableHead className="text-right">مرفوضة (7 أيام)</TableHead>
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
                  <TableCell className="tabular-nums">{fmtInt.format(r.auditEvents7d)}</TableCell>
                  <TableCell className="tabular-nums">
                    {r.denied7d > 0 ? <span className="text-rose-700 font-bold">{r.denied7d}</span> : <span className="text-muted-foreground">0</span>}
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
