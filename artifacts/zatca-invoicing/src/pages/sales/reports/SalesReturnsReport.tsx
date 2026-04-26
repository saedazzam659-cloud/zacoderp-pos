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
import { RotateCcw, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

export default function SalesReturnsReport() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`salesReports.salesReturns.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from, setFrom] = useState(firstDay);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState("");

  const EXPORT_COLS = [
    { key: "customerName", header: tr("exportColCustomer"),    width: 30 },
    { key: "returnCount",  header: tr("exportColReturnCount"), width: 14 },
    { key: "totalVat",     header: tr("exportColVat"),         width: 14 },
    { key: "totalAmount",  header: tr("exportColTotalAmount"), width: 18 },
  ];

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["returns-by-customer", cid, from, to, branchId],
    queryFn: () => salesAnalyticsApi.returnsByCustomer(cid, from, to, branchId),
  });

  const filtered = (rows as any[]).filter(r => !search || r.customerNameAr?.includes(search) || r.customerNameEn?.toLowerCase().includes(search.toLowerCase()));
  const totals = filtered.reduce((s, r) => ({
    returnCount: s.returnCount + r.returnCount,
    totalVat: s.totalVat + r.totalVat,
    totalAmount: s.totalAmount + r.totalAmount,
  }), { returnCount: 0, totalVat: 0, totalAmount: 0 });

  const exportRows = filtered.map(r => ({
    customerName: pickName(r.customerNameAr, r.customerNameEn),
    returnCount:  r.returnCount,
    totalVat:     fmt(r.totalVat),
    totalAmount:  fmt(r.totalAmount),
  }));

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><RotateCcw className="h-6 w-6 text-orange-500" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${tr("exportFilename")}-${from}-${to}`}
          title={tr("exportTitle")}
          subtitle={tr("exportSubtitle", { from, to, value: fmt(totals.totalAmount) })}
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border bg-orange-50 border-orange-200 p-3">
          <p className="text-[11px] text-orange-700">{tr("returnCount")}</p>
          <p className="text-xl font-bold text-orange-700 tabular-nums mt-1">{totals.returnCount}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-3">
          <p className="text-[11px] text-amber-700">{tr("vatReturned")}</p>
          <p className="text-xl font-bold text-amber-700 tabular-nums mt-1">{fmt(totals.totalVat)}</p>
        </div>
        <div className="rounded-xl border bg-rose-50 border-rose-200 p-3">
          <p className="text-[11px] text-rose-700">{tr("totalReturns")}</p>
          <p className="text-xl font-bold text-rose-700 tabular-nums mt-1">{fmt(totals.totalAmount)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="space-y-1.5">
          <Label>{t("salesReports.common.from")}</Label>
          <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("salesReports.common.to")}</Label>
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("common.branch")}</Label>
          <BranchFilter value={branchId} onChange={setBranchId} />
        </div>
        <div className="space-y-1.5">
          <Label>{tr("search")}</Label>
          <div className="relative">
            <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
            <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={tr("searchPh")} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colCustomer")}</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">{tr("colReturnCount")}</th>
                <th className="px-3 py-3 text-center font-semibold text-amber-700 hidden sm:table-cell">{tr("colVat")}</th>
                <th className="px-3 py-3 text-center font-semibold text-rose-700">{tr("colTotal")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={4} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : filtered.length === 0
                ? <tr><td colSpan={4} className="py-12 text-center text-muted-foreground">{tr("noRows")}</td></tr>
                : filtered.map((r: any, i: number) => (
                    <tr key={r.customerId ?? `null-${i}`} className="hover:bg-muted/20">
                      <td className="px-3 py-3">
                        <p className="font-medium text-sm">{pickName(r.customerNameAr, r.customerNameEn)}</p>
                        {(isRtl ? r.customerNameEn : r.customerNameAr) && <p className="text-[10px] text-muted-foreground">{isRtl ? r.customerNameEn : r.customerNameAr}</p>}
                      </td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm">{r.returnCount}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs hidden sm:table-cell">{fmt(r.totalVat)}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm font-bold text-rose-700">{fmt(r.totalAmount)}</td>
                    </tr>
                  ))}
            </tbody>
            {!isLoading && filtered.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td className="px-3 py-3 text-xs font-bold">{tr("footerLabel")}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums">{totals.returnCount}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums hidden sm:table-cell">{fmt(totals.totalVat)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-rose-700">{fmt(totals.totalAmount)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
