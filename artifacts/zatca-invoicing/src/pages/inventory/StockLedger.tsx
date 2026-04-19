import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import { BookOpen, Search, Filter } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchCombobox } from "@/components/ui/search-combobox";

const TX_TYPE_LABEL: Record<string, { label: string; color: string }> = {
  transfer_out: { label: "تحويل خارج",  color: "bg-orange-50 text-orange-700" },
  transfer_in:  { label: "تحويل داخل",  color: "bg-blue-50 text-blue-700" },
  adjustment:   { label: "تسوية",        color: "bg-purple-50 text-purple-700" },
  count_adj:    { label: "تعديل جرد",   color: "bg-indigo-50 text-indigo-700" },
  sale:         { label: "مبيعات",       color: "bg-red-50 text-red-600" },
  purchase:     { label: "مشتريات",      color: "bg-green-50 text-green-700" },
  opening:      { label: "رصيد افتتاحي", color: "bg-slate-50 text-slate-600" },
};

const EXPORT_COLS = [
  { key: "txDate",       header: "التاريخ",        width: 14 },
  { key: "txType",       header: "نوع الحركة",     width: 18 },
  { key: "itemCode",     header: "كود الصنف",      width: 16 },
  { key: "itemNameAr",   header: "اسم الصنف",      width: 30 },
  { key: "warehouseName", header: "المخزن",         width: 22 },
  { key: "qty",          header: "الكمية",          width: 14 },
  { key: "costPrice",    header: "سعر التكلفة",     width: 16 },
  { key: "totalCost",    header: "إجمالي التكلفة",  width: 18 },
  { key: "balanceQty",   header: "رصيد الكمية",     width: 16 },
];

export default function StockLedger() {
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [filters, setFilters] = useState({ from: firstDay, to: today, itemId: "", warehouseId: "" });
  const [applied, setApplied] = useState({ from: firstDay, to: today, itemId: "", warehouseId: "" });

  const { data: items = [] }      = useQuery({ queryKey: ["items", cid],      queryFn: () => inventoryApi.getItems(cid) });
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses", cid], queryFn: () => inventoryApi.getWarehouses(cid) });
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["stock-ledger", cid, applied],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (cid)               params.companyId   = String(cid);
      if (applied.from)      params.from        = applied.from;
      if (applied.to)        params.to          = applied.to;
      if (applied.itemId)    params.itemId      = applied.itemId;
      if (applied.warehouseId) params.warehouseId = applied.warehouseId;
      return inventoryApi.getLedger(params);
    },
  });

  const exportRows = rows.map((r: any) => ({
    txDate:        r.txDate,
    txType:        TX_TYPE_LABEL[r.txType]?.label ?? r.txType,
    itemCode:      r.item?.code ?? "",
    itemNameAr:    r.item?.nameAr ?? "",
    warehouseName: r.warehouse?.nameAr ?? "",
    qty:           Number(r.qty).toFixed(2),
    costPrice:     Number(r.costPrice).toFixed(2),
    totalCost:     Number(r.totalCost).toFixed(2),
    balanceQty:    Number(r.balanceQty).toFixed(2),
  }));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><BookOpen className="h-6 w-6 text-primary" />دفتر حركة المخزون</h1>
          <p className="text-muted-foreground text-sm mt-1">سجل كامل لجميع حركات المخزون مع الأرصدة</p>
        </div>
        <ExportButtons rows={exportRows} columns={EXPORT_COLS} filename={`دفتر-حركة-${applied.from}-${applied.to}`} title="دفتر حركة المخزون" subtitle={`${applied.from} إلى ${applied.to}`} />
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">فلترة الحركات</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <Label>من تاريخ</Label>
            <Input type="date" value={filters.from} onChange={e => setFilters(p => ({ ...p, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>إلى تاريخ</Label>
            <Input type="date" value={filters.to} onChange={e => setFilters(p => ({ ...p, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>الصنف</Label>
            <SearchCombobox
              items={[{ value: "", label: "كل الأصناف" }, ...(items as any[]).map((it: any) => ({ value: String(it.id), code: it.code, label: it.nameAr, labelEn: it.nameEn }))]}
              value={filters.itemId}
              onValueChange={v => setFilters(p => ({ ...p, itemId: v }))}
              placeholder="كل الأصناف"
            />
          </div>
          <div className="space-y-1.5">
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
          <Button size="sm" onClick={() => setApplied({ ...filters })} className="gap-2">
            <Search className="h-3.5 w-3.5" />عرض الحركات
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{isLoading ? "..." : `${rows.length} حركة (آخر 500)`}</span>
          <span className="text-xs text-muted-foreground">{applied.from} ← {applied.to}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">التاريخ</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">نوع الحركة</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الصنف</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">المخزن</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الكمية</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">سعر التكلفة</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الإجمالي</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">رصيد الكمية</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(8)].map((_, i) => <tr key={i}><td colSpan={8} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : rows.length === 0
                ? <tr><td colSpan={8} className="py-12 text-center text-muted-foreground"><BookOpen className="h-8 w-8 mx-auto mb-2 opacity-30" />لا توجد حركات في هذه الفترة</td></tr>
                : rows.map((r: any) => {
                    const tx = TX_TYPE_LABEL[r.txType] ?? { label: r.txType, color: "bg-slate-50 text-slate-600" };
                    return (
                      <tr key={r.id} className="hover:bg-muted/20">
                        <td className="px-4 py-3 tabular-nums text-xs text-muted-foreground">{r.txDate}</td>
                        <td className="px-4 py-3">
                          <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5", tx.color)}>{tx.label}</span>
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-xs">{r.item?.nameAr ?? "—"}</p>
                          <p className="text-[10px] text-muted-foreground font-mono">{r.item?.code}</p>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{r.warehouse?.nameAr ?? "—"}</td>
                        <td className={cn("px-4 py-3 text-center tabular-nums text-sm font-bold", Number(r.qty) >= 0 ? "text-green-600" : "text-red-600")}>
                          {Number(r.qty) >= 0 ? "+" : ""}{Number(r.qty).toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-center tabular-nums text-xs">{Number(r.costPrice).toFixed(2)}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-xs">{Number(r.totalCost).toFixed(2)}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-xs font-medium">{Number(r.balanceQty).toFixed(2)}</td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
