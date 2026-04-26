import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { salesAnalyticsApi } from "@/lib/salesAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

export default function AgingReport() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`salesReports.agingAnalysis.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState("");

  const EXPORT_COLS = [
    { key: "customerName", header: tr("exportColCustomer"), width: 28 },
    { key: "phone",        header: tr("exportColPhone"),    width: 16 },
    { key: "current",      header: tr("exportColCurrent"),  width: 14 },
    { key: "d30",          header: tr("exportColD30"),      width: 14 },
    { key: "d60",          header: tr("exportColD60"),      width: 14 },
    { key: "d90",          header: tr("exportColD90"),      width: 14 },
    { key: "d90plus",      header: tr("exportColD90plus"),  width: 18 },
    { key: "total",        header: tr("exportColTotal"),    width: 16 },
  ];

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["aging", cid, asOf, branchId],
    queryFn: () => salesAnalyticsApi.aging(cid, asOf, branchId),
  });

  const filtered = (rows as any[]).filter(r =>
    !search || r.customerNameAr?.includes(search) || r.customerNameEn?.toLowerCase().includes(search.toLowerCase()) || r.phone?.includes(search)
  );

  const totals = filtered.reduce((s, r) => ({
    current: s.current + r.current, d30: s.d30 + r.d30, d60: s.d60 + r.d60,
    d90: s.d90 + r.d90, d90plus: s.d90plus + r.d90plus, total: s.total + r.total,
  }), { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0, total: 0 });

  const exportRows = filtered.map(r => ({
    customerName: pickName(r.customerNameAr, r.customerNameEn),
    phone:        r.phone ?? "",
    current:      fmt(r.current),
    d30:          fmt(r.d30),
    d60:          fmt(r.d60),
    d90:          fmt(r.d90),
    d90plus:      fmt(r.d90plus),
    total:        fmt(r.total),
  }));

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><AlertTriangle className="h-6 w-6 text-amber-500" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${tr("exportFilename")}-${asOf}`}
          title={tr("exportTitle")}
          subtitle={tr("exportSubtitle", { date: asOf, value: fmt(totals.total) })}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-3">
          <p className="text-[11px] text-emerald-700">{tr("current")}</p>
          <p className="text-base font-bold text-emerald-700 tabular-nums mt-1">{fmt(totals.current)}</p>
        </div>
        <div className="rounded-xl border bg-yellow-50 border-yellow-200 p-3">
          <p className="text-[11px] text-yellow-700">{tr("d30")}</p>
          <p className="text-base font-bold text-yellow-700 tabular-nums mt-1">{fmt(totals.d30)}</p>
        </div>
        <div className="rounded-xl border bg-orange-50 border-orange-200 p-3">
          <p className="text-[11px] text-orange-700">{tr("d60")}</p>
          <p className="text-base font-bold text-orange-700 tabular-nums mt-1">{fmt(totals.d60)}</p>
        </div>
        <div className="rounded-xl border bg-red-50 border-red-200 p-3">
          <p className="text-[11px] text-red-700">{tr("d90")}</p>
          <p className="text-base font-bold text-red-700 tabular-nums mt-1">{fmt(totals.d90)}</p>
        </div>
        <div className="rounded-xl border bg-rose-100 border-rose-300 p-3">
          <p className="text-[11px] text-rose-800">{tr("d90plus")}</p>
          <p className="text-base font-bold text-rose-800 tabular-nums mt-1">{fmt(totals.d90plus)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="space-y-1.5">
          <Label>{tr("asOf")}</Label>
          <Input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("common.branch")}</Label>
          <BranchFilter value={branchId} onChange={setBranchId} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>{tr("search")}</Label>
          <div className="relative">
            <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
            <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={tr("searchPh")} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colCustomer")}</th>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground hidden sm:table-cell`}>{tr("colPhone")}</th>
                <th className="px-3 py-3 text-center font-semibold text-emerald-700">{tr("currentShort")}</th>
                <th className="px-3 py-3 text-center font-semibold text-yellow-700">31-60</th>
                <th className="px-3 py-3 text-center font-semibold text-orange-700">61-90</th>
                <th className="px-3 py-3 text-center font-semibold text-red-700">91-120</th>
                <th className="px-3 py-3 text-center font-semibold text-rose-800">+120</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">{tr("colTotal")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={8} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : filtered.length === 0
                ? <tr><td colSpan={8} className="py-12 text-center text-muted-foreground">{tr("noRows")}</td></tr>
                : filtered.map((r: any) => (
                    <tr key={r.customerId} className="hover:bg-muted/20">
                      <td className="px-3 py-3">
                        <p className="font-medium text-sm">{pickName(r.customerNameAr, r.customerNameEn)}</p>
                        {(isRtl ? r.customerNameEn : r.customerNameAr) && <p className="text-[10px] text-muted-foreground">{isRtl ? r.customerNameEn : r.customerNameAr}</p>}
                      </td>
                      <td className="px-3 py-3 hidden sm:table-cell text-xs text-muted-foreground font-mono">{r.phone ?? "—"}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs">{r.current ? fmt(r.current) : "—"}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs">{r.d30 ? fmt(r.d30) : "—"}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs">{r.d60 ? fmt(r.d60) : "—"}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs">{r.d90 ? fmt(r.d90) : "—"}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs font-semibold text-rose-800">{r.d90plus ? fmt(r.d90plus) : "—"}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm font-bold">{fmt(r.total)}</td>
                    </tr>
                  ))}
            </tbody>
            {!isLoading && filtered.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={2} className="px-3 py-3 text-xs font-bold">{tr("footerLabel", { count: filtered.length })}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-emerald-700">{fmt(totals.current)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-yellow-700">{fmt(totals.d30)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-orange-700">{fmt(totals.d60)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-red-700">{fmt(totals.d90)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-rose-800">{fmt(totals.d90plus)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums">{fmt(totals.total)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
