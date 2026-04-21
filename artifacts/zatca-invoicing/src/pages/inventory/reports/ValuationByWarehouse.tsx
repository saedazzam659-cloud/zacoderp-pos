import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import { Wallet } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

const EXPORT_COLS = [
  { key: "warehouseCode", header: "كود المخزن",     width: 14 },
  { key: "warehouseName", header: "المخزن",           width: 28 },
  { key: "itemCount",     header: "عدد الأصناف",     width: 14 },
  { key: "totalQty",      header: "إجمالي الكمية",    width: 16 },
  { key: "totalValue",    header: "قيمة المخزون",     width: 18 },
  { key: "share",         header: "نسبة المساهمة",    width: 16 },
];

export default function ValuationByWarehouse() {
  const { fmt, fmtQty, fmtVal } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const { data: warehouses = [] } = useQuery({
    queryKey: ["warehouses", cid],
    queryFn: () => inventoryApi.getWarehouses(cid),
  });
  const { data: balances = [], isLoading } = useQuery({
    queryKey: ["stock-balance-all", cid],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (cid) params.companyId = String(cid);
      return inventoryApi.getBalance(params);
    },
  });

  // Group balances by warehouse
  type Agg = { whId: number; itemCount: number; totalQty: number; totalValue: number };
  const aggMap: Record<number, Agg> = {};
  (balances as any[]).forEach((b: any) => {
    const id = Number(b.warehouseId);
    if (!aggMap[id]) aggMap[id] = { whId: id, itemCount: 0, totalQty: 0, totalValue: 0 };
    if (Number(b.qty) !== 0) aggMap[id].itemCount += 1;
    aggMap[id].totalQty += Number(b.qty);
    aggMap[id].totalValue += Number(b.qty) * Number(b.avgCost);
  });

  const rows = (warehouses as any[]).map((w: any) => {
    const a = aggMap[w.id] ?? { whId: w.id, itemCount: 0, totalQty: 0, totalValue: 0 };
    return { ...w, ...a };
  });

  const grandValue = rows.reduce((s, r) => s + r.totalValue, 0);
  const grandQty   = rows.reduce((s, r) => s + r.totalQty, 0);
  const grandItems = rows.reduce((s, r) => s + r.itemCount, 0);

  const exportRows = rows.map((r: any) => ({
    warehouseCode: r.code ?? "",
    warehouseName: r.nameAr ?? "",
    itemCount:     r.itemCount,
    totalQty:      fmtQty(r.totalQty),
    totalValue:    fmt(r.totalValue),
    share:         grandValue > 0 ? `${((r.totalValue / grandValue) * 100).toFixed(2)}%` : "0%",
  }));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Wallet className="h-6 w-6 text-primary" />تقييم المخزون حسب المخزن</h1>
          <p className="text-muted-foreground text-sm mt-1">إجمالي قيمة المخزون لكل مخزن مع نسبة المساهمة في القيمة الإجمالية</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`تقييم-المخزون-${new Date().toISOString().slice(0, 10)}`}
          title="تقرير تقييم المخزون حسب المخزن"
          subtitle={`القيمة الإجمالية: ${fmt(grandValue)} ر.س`}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
          <p className="text-xs text-muted-foreground">إجمالي قيمة المخزون</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{fmtVal(grandValue)}</p>
          <p className="text-xs text-muted-foreground">ريال سعودي</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">إجمالي الكميات</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{fmtQty(grandQty)}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">عدد الأصناف بالمخازن</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{grandItems}</p>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">المخزن</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">عدد الأصناف</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">إجمالي الكمية</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">قيمة المخزون</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">نسبة المساهمة</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(4)].map((_, i) => <tr key={i}><td colSpan={5} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : rows.length === 0
                ? <tr><td colSpan={5} className="py-12 text-center text-muted-foreground"><Wallet className="h-8 w-8 mx-auto mb-2 opacity-30" />لا توجد مخازن</td></tr>
                : rows.map((r: any) => {
                    const share = grandValue > 0 ? (r.totalValue / grandValue) * 100 : 0;
                    return (
                      <tr key={r.id} className="hover:bg-muted/20">
                        <td className="px-4 py-3">
                          <p className="font-medium text-sm">{r.nameAr ?? "—"}</p>
                          <p className="text-[10px] text-muted-foreground font-mono">{r.code}</p>
                        </td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm">{r.itemCount}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm">{fmtQty(r.totalQty)}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm font-semibold">{fmt(r.totalValue)}</td>
                        <td className="px-4 py-3">
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
            {!isLoading && rows.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td className="px-4 py-3 text-xs font-bold">الإجمالي</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums">{grandItems}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums">{fmtQty(grandQty)}</td>
                  <td className="px-4 py-3 text-center font-bold tabular-nums">{fmt(grandValue)}</td>
                  <td className="px-4 py-3 text-center font-bold">100%</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
