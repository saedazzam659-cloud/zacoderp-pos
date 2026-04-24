import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { cashAnalyticsApi } from "@/lib/cashAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { useTranslation } from "react-i18next";
import { CalendarRange, Filter } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

const COLS = [
  { key: "date",         header: "التاريخ",          width: 14 },
  { key: "receiptCount", header: "عدد المقبوضات",     width: 14 },
  { key: "totalIn",      header: "إجمالي المقبوضات",  width: 18 },
  { key: "paymentCount", header: "عدد المدفوعات",     width: 14 },
  { key: "totalOut",     header: "إجمالي المدفوعات",  width: 18 },
  { key: "net",          header: "الصافي",           width: 16 },
];

export default function CashFlowReport() {
  const { fmt } = useFmt();
  const { t } = useTranslation();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from,  setFrom]  = useState(firstDay);
  const [to,    setTo]    = useState(today);
  const [scope, setScope] = useState<"all" | "cash" | "bank">("all");
  const [branchId, setBranchId] = useState<number | undefined>(undefined);

  const { data = [], isLoading } = useQuery({
    queryKey: ["daily-summary", cid, from, to, scope, branchId],
    queryFn: () => cashAnalyticsApi.dailySummary(cid, from, to, scope, branchId),
  });

  const totals = data.reduce((s, r) => ({
    receiptCount: s.receiptCount + r.receiptCount,
    paymentCount: s.paymentCount + r.paymentCount,
    totalIn:  s.totalIn + r.totalIn,
    totalOut: s.totalOut + r.totalOut,
    net:      s.net + r.net,
  }), { receiptCount: 0, paymentCount: 0, totalIn: 0, totalOut: 0, net: 0 });

  const exportRows = data.map(r => ({
    date: r.date,
    receiptCount: r.receiptCount,
    totalIn: fmt(r.totalIn),
    paymentCount: r.paymentCount,
    totalOut: fmt(r.totalOut),
    net: fmt(r.net),
  }));

  const scopeLabel = scope === "all" ? "الكل" : scope === "cash" ? "نقدي" : "بنكي";

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><CalendarRange className="h-6 w-6 text-primary" />الحركة اليومية للنقدية</h1>
          <p className="text-muted-foreground text-sm mt-1">ملخص يومي لإجمالي المقبوضات والمدفوعات وصافي التدفق النقدي</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={COLS}
          filename={`الحركة-اليومية-${from}-${to}`}
          title="الحركة اليومية للنقدية"
          subtitle={`النطاق: ${scopeLabel}  |  ${from} → ${to}`}
        />
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">معطيات التقرير</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
            <Label>النطاق</Label>
            <Select value={scope} onValueChange={v => setScope(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل (نقدي + بنكي)</SelectItem>
                <SelectItem value="cash">نقدي فقط</SelectItem>
                <SelectItem value="bank">بنكي فقط</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4">
          <p className="text-xs text-emerald-700">إجمالي المقبوضات</p>
          <p className="text-xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totals.totalIn)}</p>
          <p className="text-xs text-emerald-600/70 mt-1">{totals.receiptCount} سند قبض</p>
        </div>
        <div className="rounded-xl border bg-rose-50 border-rose-200 p-4">
          <p className="text-xs text-rose-700">إجمالي المدفوعات</p>
          <p className="text-xl font-bold text-rose-700 tabular-nums mt-1">{fmt(totals.totalOut)}</p>
          <p className="text-xs text-rose-600/70 mt-1">{totals.paymentCount} سند صرف</p>
        </div>
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
          <p className="text-xs text-muted-foreground">صافي التدفق النقدي</p>
          <p className={`text-xl font-bold tabular-nums mt-1 ${totals.net < 0 ? "text-rose-700" : ""}`}>{fmt(totals.net)}</p>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">التاريخ</th>
                <th className="px-4 py-3 text-center font-semibold text-emerald-700">عدد المقبوضات</th>
                <th className="px-4 py-3 text-center font-semibold text-emerald-700">إجمالي المقبوضات</th>
                <th className="px-4 py-3 text-center font-semibold text-rose-700">عدد المدفوعات</th>
                <th className="px-4 py-3 text-center font-semibold text-rose-700">إجمالي المدفوعات</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الصافي</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={6} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : data.length === 0
                ? <tr><td colSpan={6} className="py-12 text-center text-muted-foreground">لا توجد بيانات في الفترة المحددة</td></tr>
                : data.map(r => (
                    <tr key={r.date} className="hover:bg-muted/20">
                      <td className="px-4 py-3 tabular-nums text-xs">{r.date}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-xs">{r.receiptCount}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-emerald-600">{fmt(r.totalIn)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-xs">{r.paymentCount}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-rose-600">{fmt(r.totalOut)}</td>
                      <td className={`px-4 py-3 text-center tabular-nums text-sm font-bold ${r.net < 0 ? "text-rose-700" : ""}`}>{fmt(r.net)}</td>
                    </tr>
                  ))}
            </tbody>
            {!isLoading && data.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td className="px-4 py-3 text-xs font-semibold text-muted-foreground">الإجمالي</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums">{totals.receiptCount}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums text-emerald-700">{fmt(totals.totalIn)}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums">{totals.paymentCount}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums text-rose-700">{fmt(totals.totalOut)}</td>
                  <td className={`px-4 py-3 text-center font-bold tabular-nums ${totals.net < 0 ? "text-rose-700" : ""}`}>{fmt(totals.net)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
