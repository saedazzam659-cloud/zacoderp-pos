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
import { TrendingUp, Trophy } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

const EXPORT_COLS = [
  { key: "rank",           header: "الترتيب",       width: 10 },
  { key: "customerNameAr", header: "العميل",        width: 30 },
  { key: "invoiceCount",   header: "عدد الفواتير",  width: 14 },
  { key: "netSales",       header: "صافي البيع",    width: 16 },
  { key: "share",          header: "نسبة المساهمة", width: 14 },
];

export default function TopCustomers() {
  const { fmt } = useFmt();
  const { t } = useTranslation();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from, setFrom] = useState(firstDay);
  const [to, setTo] = useState(today);
  const [topN, setTopN] = useState("10");
  const [branchId, setBranchId] = useState<number | undefined>(undefined);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["sales-by-customer", cid, from, to, branchId],
    queryFn: () => salesAnalyticsApi.byCustomer(cid, from, to, branchId),
  });

  const grandTotal = (rows as any[]).reduce((s, r) => s + r.netSales, 0);
  const limit = Math.max(1, Number(topN) || 10);
  const top = (rows as any[]).slice(0, limit).map((r, i) => ({
    ...r,
    rank: i + 1,
    share: grandTotal > 0 ? (r.netSales / grandTotal) * 100 : 0,
  }));

  const exportRows = top.map(r => ({
    rank:           r.rank,
    customerNameAr: r.customerNameAr,
    invoiceCount:   r.invoiceCount,
    netSales:       fmt(r.netSales),
    share:          `${r.share.toFixed(2)}%`,
  }));

  const medalColor = (rank: number) =>
    rank === 1 ? "bg-amber-100 text-amber-700 border-amber-300" :
    rank === 2 ? "bg-slate-100 text-slate-700 border-slate-300" :
    rank === 3 ? "bg-orange-100 text-orange-700 border-orange-300" :
    "bg-muted text-muted-foreground border-muted";

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><TrendingUp className="h-6 w-6 text-rose-500" />أفضل العملاء</h1>
          <p className="text-muted-foreground text-sm mt-1">ترتيب أعلى العملاء قيمةً خلال الفترة المحددة</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`افضل-العملاء-${from}-${to}`}
          title={`تقرير أفضل ${limit} عميل`}
          subtitle={`من ${from} إلى ${to}`}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
        <div className="space-y-1.5">
          <Label>من تاريخ</Label>
          <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>إلى تاريخ</Label>
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("common.branch")}</Label>
          <BranchFilter value={branchId} onChange={setBranchId} />
        </div>
        <div className="space-y-1.5">
          <Label>عدد العملاء</Label>
          <Input type="number" min={1} value={topN} onChange={e => setTopN(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="invisible">.</Label>
          <div className="rounded-md border bg-primary/5 border-primary/10 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">إجمالي مبيعات الفترة</p>
            <p className="text-sm font-bold tabular-nums">{fmt(grandTotal)}</p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground w-16">الترتيب</th>
                <th className="px-3 py-3 text-right font-semibold text-muted-foreground">العميل</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">عدد الفواتير</th>
                <th className="px-3 py-3 text-center font-semibold text-emerald-700">صافي البيع</th>
                <th className="px-3 py-3 text-right font-semibold text-muted-foreground">نسبة المساهمة</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={5} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : top.length === 0
                ? <tr><td colSpan={5} className="py-12 text-center text-muted-foreground">لا توجد مبيعات في هذه الفترة</td></tr>
                : top.map((r: any) => (
                    <tr key={r.customerId ?? `null-${r.rank}`} className="hover:bg-muted/20">
                      <td className="px-3 py-3 text-center">
                        <span className={`inline-flex items-center justify-center h-7 w-7 rounded-full border text-xs font-bold ${medalColor(r.rank)}`}>
                          {r.rank <= 3 ? <Trophy className="h-3.5 w-3.5" /> : r.rank}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <p className="font-medium text-sm">{r.customerNameAr}</p>
                        {r.customerNameEn && <p className="text-[10px] text-muted-foreground">{r.customerNameEn}</p>}
                      </td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm">{r.invoiceCount}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-base font-bold text-emerald-700">{fmt(r.netSales)}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-rose-500" style={{ width: `${Math.min(100, r.share)}%` }} />
                          </div>
                          <span className="text-xs tabular-nums w-12 text-left">{r.share.toFixed(1)}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
