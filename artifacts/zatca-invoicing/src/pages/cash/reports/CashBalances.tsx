import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { cashAnalyticsApi } from "@/lib/cashAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { useTranslation } from "react-i18next";
import { Wallet, Filter } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

const COLS = [
  { key: "code",     header: "الكود",       width: 12 },
  { key: "nameAr",   header: "اسم الخزينة", width: 24 },
  { key: "totalIn",  header: "إجمالي الوارد", width: 16 },
  { key: "totalOut", header: "إجمالي الصادر", width: 16 },
  { key: "balance",  header: "الرصيد",      width: 16 },
];

export default function CashBalances() {
  const { fmt } = useFmt();
  const { t } = useTranslation();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);

  const { data = [], isLoading } = useQuery({
    queryKey: ["cash-balances", cid, asOf, branchId],
    queryFn: () => cashAnalyticsApi.cashBalances(cid, asOf, branchId),
  });

  const totals = data.reduce((s, r) => ({
    totalIn: s.totalIn + r.totalIn,
    totalOut: s.totalOut + r.totalOut,
    balance: s.balance + r.balance,
  }), { totalIn: 0, totalOut: 0, balance: 0 });

  const exportRows = data.map(r => ({
    code: r.code, nameAr: r.nameAr,
    totalIn: fmt(r.totalIn), totalOut: fmt(r.totalOut), balance: fmt(r.balance),
  }));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Wallet className="h-6 w-6 text-primary" />أرصدة الخزائن</h1>
          <p className="text-muted-foreground text-sm mt-1">رصيد كل خزينة نقدية بتاريخ محدد</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={COLS}
          filename={`أرصدة-الخزائن-${asOf}`}
          title="أرصدة الخزائن"
          subtitle={`بتاريخ ${asOf}`}
        />
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">معطيات التقرير</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label>بتاريخ</Label>
            <Input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common.branch")}</Label>
            <BranchFilter value={branchId} onChange={setBranchId} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4">
          <p className="text-xs text-emerald-700">إجمالي الوارد</p>
          <p className="text-xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totals.totalIn)}</p>
        </div>
        <div className="rounded-xl border bg-rose-50 border-rose-200 p-4">
          <p className="text-xs text-rose-700">إجمالي الصادر</p>
          <p className="text-xl font-bold text-rose-700 tabular-nums mt-1">{fmt(totals.totalOut)}</p>
        </div>
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
          <p className="text-xs text-muted-foreground">صافي الرصيد</p>
          <p className="text-xl font-bold tabular-nums mt-1">{fmt(totals.balance)}</p>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الكود</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">اسم الخزينة</th>
                <th className="px-4 py-3 text-center font-semibold text-emerald-700">إجمالي الوارد</th>
                <th className="px-4 py-3 text-center font-semibold text-rose-700">إجمالي الصادر</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الرصيد</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={5} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : data.length === 0
                ? <tr><td colSpan={5} className="py-12 text-center text-muted-foreground">لا توجد خزائن</td></tr>
                : data.map(r => (
                    <tr key={r.id} className="hover:bg-muted/20">
                      <td className="px-4 py-3 text-xs font-mono text-muted-foreground">{r.code}</td>
                      <td className="px-4 py-3">{r.nameAr}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-emerald-600">{fmt(r.totalIn)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-rose-600">{fmt(r.totalOut)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-sm font-bold">{fmt(r.balance)}</td>
                    </tr>
                  ))}
            </tbody>
            {!isLoading && data.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={2} className="px-4 py-3 text-xs font-semibold text-muted-foreground">الإجمالي</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums text-emerald-700">{fmt(totals.totalIn)}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums text-rose-700">{fmt(totals.totalOut)}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums">{fmt(totals.balance)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
