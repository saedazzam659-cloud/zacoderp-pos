import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { purchaseAnalyticsApi } from "@/lib/purchaseAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import { Truck, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

const EXPORT_COLS = [
  { key: "supplierNameAr", header: "المورد",          width: 30 },
  { key: "invoiceCount",   header: "عدد الفواتير",    width: 14 },
  { key: "subtotal",       header: "صافي المشتريات",  width: 16 },
  { key: "vatAmount",      header: "ض.ق.م",           width: 14 },
  { key: "totalPurchases", header: "إجمالي المشتريات", width: 16 },
  { key: "totalReturns",   header: "المرتجعات",       width: 14 },
  { key: "netPurchases",   header: "الصافي بعد المرتجع", width: 18 },
  { key: "totalPaid",      header: "المدفوع",         width: 14 },
];

export default function PurchasesBySupplier() {
  const { fmt } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from, setFrom] = useState(firstDay);
  const [to, setTo] = useState(today);
  const [search, setSearch] = useState("");

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["purchases-by-supplier", cid, from, to],
    queryFn: () => purchaseAnalyticsApi.bySupplier(cid, from, to),
  });

  const filtered = (rows as any[]).filter(r => !search || r.supplierNameAr?.includes(search));

  const totals = filtered.reduce((s, r) => ({
    invoiceCount: s.invoiceCount + r.invoiceCount,
    subtotal: s.subtotal + r.subtotal,
    vatAmount: s.vatAmount + r.vatAmount,
    totalPurchases: s.totalPurchases + r.totalPurchases,
    totalReturns: s.totalReturns + r.totalReturns,
    netPurchases: s.netPurchases + r.netPurchases,
    totalPaid: s.totalPaid + r.totalPaid,
  }), { invoiceCount: 0, subtotal: 0, vatAmount: 0, totalPurchases: 0, totalReturns: 0, netPurchases: 0, totalPaid: 0 });

  const exportRows = filtered.map(r => ({
    supplierNameAr: r.supplierNameAr,
    invoiceCount:   r.invoiceCount,
    subtotal:       fmt(r.subtotal),
    vatAmount:      fmt(r.vatAmount),
    totalPurchases: fmt(r.totalPurchases),
    totalReturns:   fmt(r.totalReturns),
    netPurchases:   fmt(r.netPurchases),
    totalPaid:      fmt(r.totalPaid),
  }));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Truck className="h-6 w-6 text-primary" />المشتريات حسب المورد</h1>
          <p className="text-muted-foreground text-sm mt-1">إجمالي المشتريات والمرتجعات والمدفوع لكل مورد خلال الفترة</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`المشتريات-حسب-المورد-${from}-${to}`}
          title="تقرير المشتريات حسب المورد"
          subtitle={`من ${from} إلى ${to}`}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border bg-blue-50 border-blue-200 p-3">
          <p className="text-[11px] text-blue-700">عدد الفواتير</p>
          <p className="text-xl font-bold text-blue-700 tabular-nums mt-1">{totals.invoiceCount}</p>
        </div>
        <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-3">
          <p className="text-[11px] text-emerald-700">صافي المشتريات</p>
          <p className="text-xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totals.netPurchases)}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-3">
          <p className="text-[11px] text-amber-700">المرتجعات</p>
          <p className="text-xl font-bold text-amber-700 tabular-nums mt-1">{fmt(totals.totalReturns)}</p>
        </div>
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-3">
          <p className="text-[11px] text-muted-foreground">المدفوع</p>
          <p className="text-xl font-bold tabular-nums mt-1">{fmt(totals.totalPaid)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="space-y-1.5">
          <Label>من تاريخ</Label>
          <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>إلى تاريخ</Label>
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>بحث</Label>
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pr-9" placeholder="بحث باسم المورد..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-3 py-3 text-right font-semibold text-muted-foreground">المورد</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">عدد الفواتير</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground hidden md:table-cell">صافي قبل ض.ق.م</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground hidden lg:table-cell">ض.ق.م</th>
                <th className="px-3 py-3 text-center font-semibold text-blue-700">إجمالي المشتريات</th>
                <th className="px-3 py-3 text-center font-semibold text-amber-700">المرتجعات</th>
                <th className="px-3 py-3 text-center font-semibold text-emerald-700">صافي الشراء</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">المدفوع</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={8} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : filtered.length === 0
                ? <tr><td colSpan={8} className="py-12 text-center text-muted-foreground">لا توجد مشتريات في هذه الفترة</td></tr>
                : filtered.map((r: any, i: number) => (
                    <tr key={r.supplierId ?? `null-${i}`} className="hover:bg-muted/20">
                      <td className="px-3 py-3">
                        <p className="font-medium text-sm">{r.supplierNameAr}</p>
                        {r.supplierNameEn && <p className="text-[10px] text-muted-foreground">{r.supplierNameEn}</p>}
                      </td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm">{r.invoiceCount}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs hidden md:table-cell">{fmt(r.subtotal)}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs hidden lg:table-cell">{fmt(r.vatAmount)}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm font-semibold text-blue-600">{fmt(r.totalPurchases)}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs text-amber-600">{r.totalReturns ? fmt(r.totalReturns) : "—"}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm font-bold text-emerald-700">{fmt(r.netPurchases)}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs">{fmt(r.totalPaid)}</td>
                    </tr>
                  ))}
            </tbody>
            {!isLoading && filtered.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td className="px-3 py-3 text-xs font-bold">الإجمالي</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums">{totals.invoiceCount}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums hidden md:table-cell">{fmt(totals.subtotal)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums hidden lg:table-cell">{fmt(totals.vatAmount)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-blue-700">{fmt(totals.totalPurchases)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-amber-700">{fmt(totals.totalReturns)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-emerald-700">{fmt(totals.netPurchases)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums">{fmt(totals.totalPaid)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
