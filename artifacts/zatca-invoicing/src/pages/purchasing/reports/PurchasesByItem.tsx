import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { purchaseAnalyticsApi } from "@/lib/purchaseAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import { Package, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

const EXPORT_COLS = [
  { key: "itemCode",       header: "كود الصنف",        width: 14 },
  { key: "itemName",       header: "اسم الصنف",        width: 30 },
  { key: "unit",           header: "الوحدة",           width: 10 },
  { key: "qty",            header: "الكمية المشتراة",  width: 14 },
  { key: "totalPurchases", header: "إجمالي الشراء",    width: 16 },
  { key: "invoiceCount",   header: "عدد الفواتير",     width: 14 },
  { key: "share",          header: "نسبة المساهمة",    width: 14 },
];

export default function PurchasesByItem() {
  const { fmt, fmtQty } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from, setFrom] = useState(firstDay);
  const [to, setTo] = useState(today);
  const [search, setSearch] = useState("");

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["purchases-by-item", cid, from, to],
    queryFn: () => purchaseAnalyticsApi.byItem(cid, from, to),
  });

  const filtered = (rows as any[]).filter(r =>
    !search || r.itemName?.includes(search) || r.itemCode?.includes(search)
  );

  const grandPurchases = filtered.reduce((s, r) => s + r.totalPurchases, 0);
  const grandQty       = filtered.reduce((s, r) => s + r.qty, 0);

  const exportRows = filtered.map(r => ({
    itemCode:       r.itemCode ?? "",
    itemName:       r.itemName,
    unit:           r.unit ?? "",
    qty:            fmtQty(r.qty),
    totalPurchases: fmt(r.totalPurchases),
    invoiceCount:   r.invoiceCount,
    share:          grandPurchases > 0 ? `${((r.totalPurchases / grandPurchases) * 100).toFixed(2)}%` : "0%",
  }));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Package className="h-6 w-6 text-primary" />المشتريات حسب الصنف</h1>
          <p className="text-muted-foreground text-sm mt-1">ترتيب الأصناف حسب قيمة المشتريات لتحديد الأعلى تكلفة</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`المشتريات-حسب-الصنف-${from}-${to}`}
          title="تقرير المشتريات حسب الصنف"
          subtitle={`من ${from} إلى ${to}  |  إجمالي ${fmt(grandPurchases)} ر.س`}
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border bg-purple-50 border-purple-200 p-3">
          <p className="text-[11px] text-purple-700">عدد الأصناف المشتراة</p>
          <p className="text-xl font-bold text-purple-700 tabular-nums mt-1">{filtered.length}</p>
        </div>
        <div className="rounded-xl border bg-card p-3">
          <p className="text-[11px] text-muted-foreground">إجمالي الكمية</p>
          <p className="text-xl font-bold tabular-nums mt-1">{fmtQty(grandQty)}</p>
        </div>
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-3">
          <p className="text-[11px] text-muted-foreground">إجمالي القيمة</p>
          <p className="text-xl font-bold tabular-nums mt-1">{fmt(grandPurchases)}</p>
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
            <Input className="pr-9" placeholder="بحث بالكود أو الاسم..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[800px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-3 py-3 text-right font-semibold text-muted-foreground">الصنف</th>
                <th className="px-3 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">الوحدة</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">الكمية</th>
                <th className="px-3 py-3 text-center font-semibold text-blue-700">إجمالي الشراء</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground hidden md:table-cell">عدد الفواتير</th>
                <th className="px-3 py-3 text-right font-semibold text-muted-foreground">نسبة المساهمة</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={6} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : filtered.length === 0
                ? <tr><td colSpan={6} className="py-12 text-center text-muted-foreground">لا توجد مشتريات في هذه الفترة</td></tr>
                : filtered.map((r: any, i: number) => {
                    const share = grandPurchases > 0 ? (r.totalPurchases / grandPurchases) * 100 : 0;
                    return (
                      <tr key={`${r.itemId ?? r.itemName}-${i}`} className="hover:bg-muted/20">
                        <td className="px-3 py-3">
                          <p className="font-medium text-sm">{r.itemName}</p>
                          {r.itemCode && <p className="text-[10px] text-muted-foreground font-mono">{r.itemCode}</p>}
                        </td>
                        <td className="px-3 py-3 hidden sm:table-cell text-xs text-muted-foreground">{r.unit ?? "—"}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-sm">{fmtQty(r.qty)}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-sm font-bold text-blue-600">{fmt(r.totalPurchases)}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-xs hidden md:table-cell">{r.invoiceCount}</td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                              <div className="h-full bg-primary" style={{ width: `${Math.min(100, share)}%` }} />
                            </div>
                            <span className="text-xs tabular-nums w-12 text-left">{share.toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
            {!isLoading && filtered.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={2} className="px-3 py-3 text-xs font-bold">الإجمالي</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums">{fmtQty(grandQty)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-blue-700">{fmt(grandPurchases)}</td>
                  <td className="px-3 py-3 hidden md:table-cell"></td>
                  <td className="px-3 py-3 text-center font-bold">100%</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
