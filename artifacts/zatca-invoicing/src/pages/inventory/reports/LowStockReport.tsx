import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import { AlertTriangle, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFmt } from "@/hooks/use-fmt";

const EXPORT_COLS = [
  { key: "itemCode",     header: "كود الصنف",      width: 16 },
  { key: "itemNameAr",   header: "اسم الصنف",      width: 30 },
  { key: "groupName",    header: "المجموعة",        width: 20 },
  { key: "unitName",     header: "الوحدة",          width: 14 },
  { key: "qty",          header: "الرصيد الحالي",   width: 16 },
  { key: "reorderLevel", header: "حد الطلب",        width: 14 },
  { key: "shortage",     header: "النقص",           width: 14 },
  { key: "status",       header: "الحالة",          width: 14 },
];

export default function LowStockReport() {
  const { fmtQty } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const [search, setSearch] = useState("");

  const { data: items = [] } = useQuery({
    queryKey: ["items", cid],
    queryFn: () => inventoryApi.getItems(cid),
  });
  const { data: balances = [], isLoading } = useQuery({
    queryKey: ["stock-balance-all", cid],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (cid) params.companyId = String(cid);
      return inventoryApi.getBalance(params);
    },
  });

  // Aggregate balance per item across warehouses
  const qtyByItem: Record<number, number> = {};
  (balances as any[]).forEach((b: any) => {
    qtyByItem[b.itemId] = (qtyByItem[b.itemId] ?? 0) + Number(b.qty);
  });

  const enriched = (items as any[])
    .filter((it: any) => it.itemType !== "service")
    .map((it: any) => {
      const qty = qtyByItem[it.id] ?? 0;
      const reorder = Number(it.reorderLevel ?? 0);
      const shortage = Math.max(0, reorder - qty);
      let status: "out" | "low" | "ok" = "ok";
      if (qty <= 0) status = "out";
      else if (reorder > 0 && qty < reorder) status = "low";
      return { ...it, qty, reorder, shortage, status };
    })
    .filter((r: any) => r.status !== "ok")
    .filter((r: any) =>
      !search || r.nameAr?.includes(search) || r.code?.includes(search)
    )
    .sort((a, b) => a.qty - b.qty);

  const outCount = enriched.filter(r => r.status === "out").length;
  const lowCount = enriched.filter(r => r.status === "low").length;

  const exportRows = enriched.map((r: any) => ({
    itemCode:     r.code ?? "",
    itemNameAr:   r.nameAr ?? "",
    groupName:    r.group?.nameAr ?? "",
    unitName:     r.unit?.nameAr ?? "",
    qty:          fmtQty(r.qty),
    reorderLevel: fmtQty(r.reorder),
    shortage:     fmtQty(r.shortage),
    status:       r.status === "out" ? "نفاد" : "تحت حد الطلب",
  }));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><AlertTriangle className="h-6 w-6 text-amber-500" />الأصناف منخفضة المخزون</h1>
          <p className="text-muted-foreground text-sm mt-1">قائمة الأصناف التي وصلت لحد إعادة الطلب أو نفدت من المخازن</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`أصناف-منخفضة-${new Date().toISOString().slice(0, 10)}`}
          title="تقرير الأصناف منخفضة المخزون"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-red-50 border-red-200 p-4">
          <p className="text-xs text-red-700">أصناف نافدة</p>
          <p className="text-2xl font-bold text-red-700 tabular-nums mt-1">{outCount}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-4">
          <p className="text-xs text-amber-700">تحت حد الطلب</p>
          <p className="text-2xl font-bold text-amber-700 tabular-nums mt-1">{lowCount}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">إجمالي يستوجب الانتباه</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{enriched.length}</p>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pr-9" placeholder="بحث بالكود أو الاسم..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الصنف</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">المجموعة</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">الوحدة</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الرصيد الحالي</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">حد الطلب</th>
                <th className="px-4 py-3 text-center font-semibold text-amber-700">النقص</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={7} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : enriched.length === 0
                ? <tr><td colSpan={7} className="py-12 text-center text-muted-foreground">
                    <AlertTriangle className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    رائع! لا توجد أصناف تحت حد الطلب
                  </td></tr>
                : enriched.map((r: any) => (
                    <tr key={r.id} className={cn("hover:bg-muted/20", r.status === "out" ? "bg-red-50/30" : "bg-amber-50/30")}>
                      <td className="px-4 py-3">
                        <p className="font-medium text-sm">{r.nameAr ?? "—"}</p>
                        <p className="text-[10px] text-muted-foreground font-mono">{r.code}</p>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground">{r.group?.nameAr ?? "—"}</td>
                      <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">{r.unit?.nameAr ?? "—"}</td>
                      <td className={cn("px-4 py-3 text-center tabular-nums font-bold", r.status === "out" ? "text-red-600" : "text-amber-600")}>
                        {fmtQty(r.qty)}
                      </td>
                      <td className="px-4 py-3 text-center tabular-nums text-sm">{fmtQty(r.reorder)}</td>
                      <td className="px-4 py-3 text-center tabular-nums font-bold text-amber-700">{fmtQty(r.shortage)}</td>
                      <td className="px-4 py-3 text-center">
                        {r.status === "out"
                          ? <span className="text-[10px] bg-red-50 text-red-600 rounded-full px-2 py-0.5 font-medium">نفاد</span>
                          : <span className="text-[10px] bg-amber-50 text-amber-700 rounded-full px-2 py-0.5 font-medium flex items-center gap-1 w-fit mx-auto"><AlertTriangle className="h-2.5 w-2.5" />تحت الحد</span>
                        }
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
