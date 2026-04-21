import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { purchaseAnalyticsApi } from "@/lib/purchaseAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import { CalendarRange } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

const EXPORT_COLS = [
  { key: "period",       header: "الفترة",          width: 16 },
  { key: "invoiceCount", header: "عدد الفواتير",    width: 14 },
  { key: "subtotal",     header: "صافي قبل ض.ق.م",  width: 16 },
  { key: "vatAmount",    header: "ض.ق.م",           width: 14 },
  { key: "totalAmount",  header: "إجمالي المشتريات", width: 16 },
];

export default function PurchasesByPeriod() {
  const { fmt } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from, setFrom] = useState(firstDay);
  const [to, setTo] = useState(today);
  const [groupBy, setGroupBy] = useState<"day" | "month">("day");

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["purchases-by-period", cid, from, to, groupBy],
    queryFn: () => purchaseAnalyticsApi.byPeriod(cid, from, to, groupBy),
  });

  const totals = (rows as any[]).reduce((s, r) => ({
    invoiceCount: s.invoiceCount + r.invoiceCount,
    subtotal: s.subtotal + r.subtotal,
    vatAmount: s.vatAmount + r.vatAmount,
    totalAmount: s.totalAmount + r.totalAmount,
  }), { invoiceCount: 0, subtotal: 0, vatAmount: 0, totalAmount: 0 });

  const maxAmount = Math.max(0, ...(rows as any[]).map(r => r.totalAmount));

  const exportRows = (rows as any[]).map(r => ({
    period:       r.period,
    invoiceCount: r.invoiceCount,
    subtotal:     fmt(r.subtotal),
    vatAmount:    fmt(r.vatAmount),
    totalAmount:  fmt(r.totalAmount),
  }));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><CalendarRange className="h-6 w-6 text-primary" />المشتريات حسب الفترة</h1>
          <p className="text-muted-foreground text-sm mt-1">ملخص المشتريات وضريبة المدخلات موزعة على الأيام أو الأشهر</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`المشتريات-${groupBy === "day" ? "اليومية" : "الشهرية"}-${from}-${to}`}
          title={`تقرير المشتريات ${groupBy === "day" ? "اليومية" : "الشهرية"}`}
          subtitle={`من ${from} إلى ${to}  |  إجمالي ${fmt(totals.totalAmount)} ر.س`}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border bg-blue-50 border-blue-200 p-3">
          <p className="text-[11px] text-blue-700">عدد الفترات</p>
          <p className="text-xl font-bold text-blue-700 tabular-nums mt-1">{(rows as any[]).length}</p>
        </div>
        <div className="rounded-xl border bg-card p-3">
          <p className="text-[11px] text-muted-foreground">عدد الفواتير</p>
          <p className="text-xl font-bold tabular-nums mt-1">{totals.invoiceCount}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-3">
          <p className="text-[11px] text-amber-700">إجمالي ض.ق.م</p>
          <p className="text-xl font-bold text-amber-700 tabular-nums mt-1">{fmt(totals.vatAmount)}</p>
        </div>
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-3">
          <p className="text-[11px] text-muted-foreground">إجمالي المشتريات</p>
          <p className="text-xl font-bold tabular-nums mt-1">{fmt(totals.totalAmount)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label>من تاريخ</Label>
          <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>إلى تاريخ</Label>
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>التجميع</Label>
          <select className="border rounded-md px-3 py-2 text-sm bg-card w-full" value={groupBy} onChange={e => setGroupBy(e.target.value as any)}>
            <option value="day">يومي</option>
            <option value="month">شهري</option>
          </select>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-3 py-3 text-right font-semibold text-muted-foreground">الفترة</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">عدد الفواتير</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground hidden md:table-cell">صافي قبل ض.ق.م</th>
                <th className="px-3 py-3 text-center font-semibold text-amber-700 hidden md:table-cell">ض.ق.م</th>
                <th className="px-3 py-3 text-center font-semibold text-blue-700">إجمالي المشتريات</th>
                <th className="px-3 py-3 text-right font-semibold text-muted-foreground hidden lg:table-cell">المؤشر</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={6} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : (rows as any[]).length === 0
                ? <tr><td colSpan={6} className="py-12 text-center text-muted-foreground">لا توجد مشتريات في هذه الفترة</td></tr>
                : (rows as any[]).map(r => {
                    const pct = maxAmount > 0 ? (r.totalAmount / maxAmount) * 100 : 0;
                    return (
                      <tr key={r.period} className="hover:bg-muted/20">
                        <td className="px-3 py-3 tabular-nums text-sm font-medium">{r.period}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-sm">{r.invoiceCount}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-xs hidden md:table-cell">{fmt(r.subtotal)}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-xs hidden md:table-cell">{fmt(r.vatAmount)}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-sm font-bold text-blue-600">{fmt(r.totalAmount)}</td>
                        <td className="px-3 py-3 hidden lg:table-cell">
                          <div className="h-2 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
            {!isLoading && (rows as any[]).length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td className="px-3 py-3 text-xs font-bold">الإجمالي</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums">{totals.invoiceCount}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums hidden md:table-cell">{fmt(totals.subtotal)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums hidden md:table-cell">{fmt(totals.vatAmount)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-blue-700">{fmt(totals.totalAmount)}</td>
                  <td className="hidden lg:table-cell"></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
