import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import { IdCard, Search, Filter } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { useFmt } from "@/hooks/use-fmt";

const TX_LABEL: Record<string, string> = {
  transfer_out: "تحويل خارج",
  transfer_in:  "تحويل داخل",
  adjustment:   "تسوية",
  count_adj:    "تعديل جرد",
  sale:         "مبيعات",
  purchase:     "مشتريات",
  opening:      "رصيد افتتاحي",
  return_in:    "مرتجع وارد",
  return_out:   "مرتجع صادر",
};

const EXPORT_COLS = [
  { key: "txDate",       header: "التاريخ",        width: 14 },
  { key: "txType",       header: "نوع الحركة",     width: 18 },
  { key: "warehouseName", header: "المخزن",         width: 22 },
  { key: "qtyIn",        header: "وارد",            width: 12 },
  { key: "qtyOut",       header: "صادر",            width: 12 },
  { key: "balance",      header: "الرصيد التراكمي", width: 16 },
  { key: "costPrice",    header: "سعر التكلفة",     width: 14 },
  { key: "totalCost",    header: "إجمالي التكلفة",  width: 16 },
];

export default function ItemCard() {
  const { fmt, fmtQty } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [filters, setFilters] = useState({ from: firstDay, to: today, itemId: "", warehouseId: "" });
  const [applied, setApplied] = useState({ from: firstDay, to: today, itemId: "", warehouseId: "" });

  const { data: items = [] }      = useQuery({ queryKey: ["items", cid],      queryFn: () => inventoryApi.getItems(cid) });
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses", cid], queryFn: () => inventoryApi.getWarehouses(cid) });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["item-card", cid, applied],
    enabled: !!applied.itemId,
    queryFn: () => {
      const params: Record<string, string> = {};
      if (cid)                 params.companyId   = String(cid);
      if (applied.from)        params.from        = applied.from;
      if (applied.to)          params.to          = applied.to;
      if (applied.itemId)      params.itemId      = applied.itemId;
      if (applied.warehouseId) params.warehouseId = applied.warehouseId;
      return inventoryApi.getLedger(params);
    },
  });

  const item = (items as any[]).find((i: any) => String(i.id) === applied.itemId);

  // Sort ascending (oldest first) and compute running balance
  const augmented = useMemo(() => {
    const sorted = [...(rows as any[])].sort((a, b) => {
      const d = String(a.txDate).localeCompare(String(b.txDate));
      return d !== 0 ? d : Number(a.id) - Number(b.id);
    });
    let bal = 0;
    return sorted.map(r => {
      const q = Number(r.qty);
      bal += q;
      return {
        ...r,
        qtyIn:  q > 0 ? q : 0,
        qtyOut: q < 0 ? -q : 0,
        running: bal,
      };
    });
  }, [rows]);

  const totals = augmented.reduce((s, r) => ({ in: s.in + r.qtyIn, out: s.out + r.qtyOut }), { in: 0, out: 0 });

  const exportRows = augmented.map((r: any) => ({
    txDate:        r.txDate,
    txType:        TX_LABEL[r.txType] ?? r.txType,
    warehouseName: r.warehouse?.nameAr ?? "—",
    qtyIn:         r.qtyIn ? fmtQty(r.qtyIn) : "",
    qtyOut:        r.qtyOut ? fmtQty(r.qtyOut) : "",
    balance:       fmtQty(r.running),
    costPrice:     fmt(r.costPrice),
    totalCost:     fmt(r.totalCost),
  }));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><IdCard className="h-6 w-6 text-primary" />كارت الصنف</h1>
          <p className="text-muted-foreground text-sm mt-1">سجل حركة صنف واحد مع الرصيد التراكمي بعد كل عملية</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`كارت-صنف-${item?.code ?? "all"}-${applied.from}-${applied.to}`}
          title="كارت الصنف"
          subtitle={item ? `${item.code} - ${item.nameAr}  |  ${applied.from} → ${applied.to}` : "اختر صنفاً"}
        />
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">معطيات الكارت</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>الصنف <span className="text-red-500">*</span></Label>
            <SearchCombobox
              items={(items as any[]).map((it: any) => ({ value: String(it.id), code: it.code, label: it.nameAr, labelEn: it.nameEn }))}
              value={filters.itemId}
              onValueChange={v => setFilters(p => ({ ...p, itemId: v }))}
              placeholder="اختر الصنف"
            />
          </div>
          <div className="space-y-1.5">
            <Label>من تاريخ</Label>
            <Input type="date" value={filters.from} onChange={e => setFilters(p => ({ ...p, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>إلى تاريخ</Label>
            <Input type="date" value={filters.to} onChange={e => setFilters(p => ({ ...p, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>المخزن</Label>
            <SearchCombobox
              items={[{ value: "", label: "كل المخازن" }, ...(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr }))]}
              value={filters.warehouseId}
              onValueChange={v => setFilters(p => ({ ...p, warehouseId: v }))}
              placeholder="كل المخازن"
            />
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <Button size="sm" onClick={() => setApplied({ ...filters })} disabled={!filters.itemId} className="gap-2">
            <Search className="h-3.5 w-3.5" />عرض الكارت
          </Button>
        </div>
      </div>

      {/* Summary */}
      {applied.itemId && item && (
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-xl border bg-green-50 border-green-200 p-4">
            <p className="text-xs text-green-700">إجمالي الوارد</p>
            <p className="text-2xl font-bold text-green-700 tabular-nums mt-1">{fmtQty(totals.in)}</p>
          </div>
          <div className="rounded-xl border bg-red-50 border-red-200 p-4">
            <p className="text-xs text-red-700">إجمالي الصادر</p>
            <p className="text-2xl font-bold text-red-700 tabular-nums mt-1">{fmtQty(totals.out)}</p>
          </div>
          <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
            <p className="text-xs text-muted-foreground">الرصيد النهائي</p>
            <p className="text-2xl font-bold tabular-nums mt-1">{fmtQty(augmented.length ? augmented[augmented.length - 1].running : 0)}</p>
          </div>
        </div>
      )}

      {/* Table */}
      {applied.itemId ? (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[700px]">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="px-4 py-3 text-right font-semibold text-muted-foreground">التاريخ</th>
                  <th className="px-4 py-3 text-right font-semibold text-muted-foreground">نوع الحركة</th>
                  <th className="px-4 py-3 text-right font-semibold text-muted-foreground">المخزن</th>
                  <th className="px-4 py-3 text-center font-semibold text-green-700">وارد</th>
                  <th className="px-4 py-3 text-center font-semibold text-red-700">صادر</th>
                  <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الرصيد</th>
                  <th className="px-4 py-3 text-center font-semibold text-muted-foreground hidden md:table-cell">سعر التكلفة</th>
                  <th className="px-4 py-3 text-center font-semibold text-muted-foreground hidden md:table-cell">إجمالي التكلفة</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoading
                  ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={8} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                  : augmented.length === 0
                  ? <tr><td colSpan={8} className="py-12 text-center text-muted-foreground"><IdCard className="h-8 w-8 mx-auto mb-2 opacity-30" />لا توجد حركات لهذا الصنف في الفترة المحددة</td></tr>
                  : augmented.map((r: any) => (
                      <tr key={r.id} className="hover:bg-muted/20">
                        <td className="px-4 py-3 tabular-nums text-xs text-muted-foreground">{r.txDate}</td>
                        <td className="px-4 py-3 text-xs">{TX_LABEL[r.txType] ?? r.txType}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{r.warehouse?.nameAr ?? "—"}</td>
                        <td className={cn("px-4 py-3 text-center tabular-nums text-sm font-bold", r.qtyIn ? "text-green-600" : "text-muted-foreground/30")}>
                          {r.qtyIn ? fmtQty(r.qtyIn) : "—"}
                        </td>
                        <td className={cn("px-4 py-3 text-center tabular-nums text-sm font-bold", r.qtyOut ? "text-red-600" : "text-muted-foreground/30")}>
                          {r.qtyOut ? fmtQty(r.qtyOut) : "—"}
                        </td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm font-bold">{fmtQty(r.running)}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-xs hidden md:table-cell">{fmt(r.costPrice)}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-xs hidden md:table-cell">{fmt(r.totalCost)}</td>
                      </tr>
                    ))}
              </tbody>
              {!isLoading && augmented.length > 0 && (
                <tfoot className="bg-muted/30 border-t">
                  <tr>
                    <td colSpan={3} className="px-4 py-3 text-xs font-semibold text-muted-foreground">الإجمالي</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums text-green-700">{fmtQty(totals.in)}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums text-red-700">{fmtQty(totals.out)}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums">{fmtQty(augmented[augmented.length - 1].running)}</td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          <IdCard className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p>اختر صنفاً من القائمة لعرض كارت حركته</p>
        </div>
      )}
    </div>
  );
}
