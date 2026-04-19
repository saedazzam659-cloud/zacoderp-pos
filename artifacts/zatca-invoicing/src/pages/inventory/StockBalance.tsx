import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import ExportButtons from "@/components/ExportButtons";
import { BarChart2, AlertTriangle, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchCombobox } from "@/components/ui/search-combobox";

const EXPORT_COLS = [
  { key: "itemCode",     header: "كود الصنف",      width: 16 },
  { key: "itemNameAr",   header: "اسم الصنف",      width: 30 },
  { key: "groupName",    header: "المجموعة",        width: 20 },
  { key: "unitName",     header: "الوحدة",          width: 14 },
  { key: "warehouseName", header: "المخزن",         width: 22 },
  { key: "qty",          header: "الكمية",          width: 14 },
  { key: "avgCost",      header: "متوسط التكلفة",   width: 18 },
  { key: "totalValue",   header: "إجمالي القيمة",   width: 20 },
  { key: "reorderLevel", header: "حد الطلب",        width: 14 },
  { key: "status",       header: "الحالة",          width: 14 },
];

export default function StockBalance() {
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const [warehouseId, setWarehouseId] = useState("");
  const [search, setSearch] = useState("");
  const [showBelowReorder, setShowBelowReorder] = useState(false);

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses", cid], queryFn: () => inventoryApi.getWarehouses(cid) });
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["stock-balance", cid, warehouseId],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (cid)          params.companyId   = String(cid);
      if (warehouseId)  params.warehouseId = warehouseId;
      return inventoryApi.getBalance(params);
    },
  });

  const filtered = rows.filter((r: any) => {
    const matchText = !search || r.item?.nameAr?.includes(search) || r.item?.code?.includes(search);
    const matchReorder = !showBelowReorder || Number(r.qty) < Number(r.item?.reorderLevel ?? 0);
    return matchText && matchReorder;
  });

  const totalValue = filtered.reduce((s: number, r: any) => s + Number(r.qty) * Number(r.avgCost), 0);
  const belowReorderCount = rows.filter((r: any) => Number(r.item?.reorderLevel) > 0 && Number(r.qty) < Number(r.item?.reorderLevel)).length;

  const exportRows = filtered.map((r: any) => ({
    itemCode:      r.item?.code ?? "",
    itemNameAr:    r.item?.nameAr ?? "",
    groupName:     r.group?.nameAr ?? "",
    unitName:      r.unit?.nameAr ?? "",
    warehouseName: r.warehouse?.nameAr ?? "",
    qty:           Number(r.qty).toFixed(2),
    avgCost:       Number(r.avgCost).toFixed(4),
    totalValue:    (Number(r.qty) * Number(r.avgCost)).toFixed(2),
    reorderLevel:  Number(r.item?.reorderLevel ?? 0).toFixed(2),
    status:        Number(r.qty) === 0 ? "نفاد" : (Number(r.item?.reorderLevel) > 0 && Number(r.qty) < Number(r.item?.reorderLevel) ? "تحت حد الطلب" : "عادي"),
  }));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><BarChart2 className="h-6 w-6 text-primary" />رصيد المخزون</h1>
          <p className="text-muted-foreground text-sm mt-1">أرصدة الأصناف التفصيلية بالتكلفة المتوسطة</p>
        </div>
        <ExportButtons rows={exportRows} columns={EXPORT_COLS} filename={`رصيد-مخزون-${new Date().toISOString().slice(0,10)}`} title="تقرير رصيد المخزون" subtitle={warehouseId ? warehouses.find((w: any) => String(w.id) === warehouseId)?.nameAr : "جميع المخازن"} />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
          <p className="text-xs text-muted-foreground">إجمالي قيمة المخزون</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{totalValue.toLocaleString("ar-SA-u-nu-latn", { minimumFractionDigits: 2 })}</p>
          <p className="text-xs text-muted-foreground">ريال سعودي</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">عدد السجلات</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{filtered.length}</p>
          <p className="text-xs text-muted-foreground">صنف × مخزن</p>
        </div>
        {belowReorderCount > 0 && (
          <div className="rounded-xl border bg-amber-50 border-amber-200 p-4">
            <p className="text-xs text-amber-700 flex items-center gap-1"><AlertTriangle className="h-3 w-3" />أصناف تحت حد الطلب</p>
            <p className="text-2xl font-bold text-amber-700 tabular-nums mt-1">{belowReorderCount}</p>
            <button onClick={() => setShowBelowReorder(p => !p)} className="text-xs text-amber-600 underline">
              {showBelowReorder ? "إظهار الكل" : "عرض فقط"}
            </button>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pr-9" placeholder="بحث بالكود أو الاسم..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="w-full sm:w-72">
          <SearchCombobox
            items={[{ value: "", label: "كل المخازن" }, ...(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr }))]}
            value={warehouseId}
            onValueChange={setWarehouseId}
            placeholder="كل المخازن"
          />
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الصنف</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">المجموعة</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">المخزن</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الكمية</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden lg:table-cell">الوحدة</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground hidden md:table-cell">متوسط التكلفة</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">إجمالي القيمة</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(8)].map((_, i) => <tr key={i}><td colSpan={8} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : filtered.length === 0
                ? <tr><td colSpan={8} className="py-12 text-center text-muted-foreground"><BarChart2 className="h-8 w-8 mx-auto mb-2 opacity-30" />لا توجد أرصدة</td></tr>
                : filtered.map((r: any) => {
                    const qty = Number(r.qty);
                    const reorder = Number(r.item?.reorderLevel ?? 0);
                    const isZero  = qty === 0;
                    const isLow   = reorder > 0 && qty < reorder;
                    const totalVal = qty * Number(r.avgCost);
                    return (
                      <tr key={r.id} className={cn("hover:bg-muted/20", isZero ? "bg-red-50/30" : isLow ? "bg-amber-50/30" : "")}>
                        <td className="px-4 py-3">
                          <p className="font-medium text-sm">{r.item?.nameAr ?? "—"}</p>
                          <p className="text-[10px] text-muted-foreground font-mono">{r.item?.code}</p>
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground">{r.group?.nameAr ?? "—"}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-xs">{r.warehouse?.nameAr ?? "—"}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn("font-bold tabular-nums", isZero ? "text-red-600" : isLow ? "text-amber-600" : "")}>
                            {qty.toFixed(2)}
                          </span>
                        </td>
                        <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted-foreground text-center">{r.unit?.nameAr ?? "—"}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-xs tabular-nums text-center">{Number(r.avgCost).toFixed(4)}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm font-semibold">{totalVal.toFixed(2)}</td>
                        <td className="px-4 py-3 text-center">
                          {isZero
                            ? <span className="text-[10px] bg-red-50 text-red-600 rounded-full px-2 py-0.5 font-medium">نفاد</span>
                            : isLow
                            ? <span className="text-[10px] bg-amber-50 text-amber-700 rounded-full px-2 py-0.5 font-medium flex items-center gap-1 w-fit mx-auto"><AlertTriangle className="h-2.5 w-2.5" />تحت الحد</span>
                            : <span className="text-[10px] bg-green-50 text-green-700 rounded-full px-2 py-0.5 font-medium">عادي</span>
                          }
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
            {!isLoading && filtered.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={6} className="px-4 py-3 text-xs font-semibold text-muted-foreground">إجمالي قيمة المخزون</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums">
                    {totalValue.toLocaleString("ar-SA-u-nu-latn", { minimumFractionDigits: 2 })} ر.س
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
