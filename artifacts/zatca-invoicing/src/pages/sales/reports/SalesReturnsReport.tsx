import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { salesAnalyticsApi } from "@/lib/salesAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import { RotateCcw, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

const EXPORT_COLS = [
  { key: "customerNameAr", header: "العميل",         width: 30 },
  { key: "returnCount",    header: "عدد المرتجعات",   width: 14 },
  { key: "totalVat",       header: "ض.ق.م",          width: 14 },
  { key: "totalAmount",    header: "إجمالي المرتجعات", width: 18 },
];

export default function SalesReturnsReport() {
  const { fmt } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from, setFrom] = useState(firstDay);
  const [to, setTo] = useState(today);
  const [search, setSearch] = useState("");

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["returns-by-customer", cid, from, to],
    queryFn: () => salesAnalyticsApi.returnsByCustomer(cid, from, to),
  });

  const filtered = (rows as any[]).filter(r => !search || r.customerNameAr?.includes(search));
  const totals = filtered.reduce((s, r) => ({
    returnCount: s.returnCount + r.returnCount,
    totalVat: s.totalVat + r.totalVat,
    totalAmount: s.totalAmount + r.totalAmount,
  }), { returnCount: 0, totalVat: 0, totalAmount: 0 });

  const exportRows = filtered.map(r => ({
    customerNameAr: r.customerNameAr,
    returnCount:    r.returnCount,
    totalVat:       fmt(r.totalVat),
    totalAmount:    fmt(r.totalAmount),
  }));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><RotateCcw className="h-6 w-6 text-orange-500" />تقرير مرتجعات المبيعات</h1>
          <p className="text-muted-foreground text-sm mt-1">ملخص مرتجعات المبيعات لكل عميل خلال الفترة المحددة</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`مرتجعات-المبيعات-${from}-${to}`}
          title="تقرير مرتجعات المبيعات"
          subtitle={`من ${from} إلى ${to}  |  إجمالي ${fmt(totals.totalAmount)} ر.س`}
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border bg-orange-50 border-orange-200 p-3">
          <p className="text-[11px] text-orange-700">عدد المرتجعات</p>
          <p className="text-xl font-bold text-orange-700 tabular-nums mt-1">{totals.returnCount}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-3">
          <p className="text-[11px] text-amber-700">ض.ق.م المردودة</p>
          <p className="text-xl font-bold text-amber-700 tabular-nums mt-1">{fmt(totals.totalVat)}</p>
        </div>
        <div className="rounded-xl border bg-rose-50 border-rose-200 p-3">
          <p className="text-[11px] text-rose-700">إجمالي المرتجعات</p>
          <p className="text-xl font-bold text-rose-700 tabular-nums mt-1">{fmt(totals.totalAmount)}</p>
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
          <Label>بحث</Label>
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pr-9" placeholder="بحث باسم العميل..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-3 py-3 text-right font-semibold text-muted-foreground">العميل</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">عدد المرتجعات</th>
                <th className="px-3 py-3 text-center font-semibold text-amber-700 hidden sm:table-cell">ض.ق.م</th>
                <th className="px-3 py-3 text-center font-semibold text-rose-700">إجمالي المرتجعات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={4} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : filtered.length === 0
                ? <tr><td colSpan={4} className="py-12 text-center text-muted-foreground">لا توجد مرتجعات في هذه الفترة</td></tr>
                : filtered.map((r: any, i: number) => (
                    <tr key={r.customerId ?? `null-${i}`} className="hover:bg-muted/20">
                      <td className="px-3 py-3">
                        <p className="font-medium text-sm">{r.customerNameAr}</p>
                        {r.customerNameEn && <p className="text-[10px] text-muted-foreground">{r.customerNameEn}</p>}
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
                  <td className="px-3 py-3 text-xs font-bold">الإجمالي</td>
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
