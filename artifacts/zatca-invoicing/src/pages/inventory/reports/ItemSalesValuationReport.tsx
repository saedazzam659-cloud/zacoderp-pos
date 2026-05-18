import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import { ReceiptText, Filter, X, PackageOpen, Coins, BadgePercent, Tags } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFmt } from "@/hooks/use-fmt";

const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

type Basis = "cost" | "excl_vat" | "incl_vat";

const BASIS_META: Record<Basis, { label: string; desc: string; icon: any; color: string; chip: string }> = {
  cost:     { label: "بسعر التكلفة",            desc: "تكلفة البضاعة المباعة الفعلية من دفتر المخزون", icon: Coins,        color: "from-indigo-50 to-indigo-100/40 text-indigo-700 border-indigo-200", chip: "bg-indigo-600 hover:bg-indigo-700" },
  excl_vat: { label: "بسعر البيع (بدون ضريبة)", desc: "صافي الإيرادات بعد استبعاد ضريبة القيمة المضافة", icon: BadgePercent, color: "from-sky-50 to-sky-100/40 text-sky-700 border-sky-200", chip: "bg-sky-600 hover:bg-sky-700" },
  incl_vat: { label: "بسعر البيع (شامل الضريبة)", desc: "إجمالي البيع شاملاً ضريبة القيمة المضافة",        icon: Tags,         color: "from-purple-50 to-purple-100/40 text-purple-700 border-purple-200", chip: "bg-purple-600 hover:bg-purple-700" },
};

const EXPORT_COLS = [
  { key: "itemCode",      header: "كود الصنف",    width: 16 },
  { key: "itemNameAr",    header: "اسم الصنف",    width: 30 },
  { key: "unitName",      header: "الوحدة",       width: 12 },
  { key: "soldQty",       header: "كمية البيع",   width: 14 },
  { key: "soldValue",     header: "قيمة البيع (مدين)", width: 18 },
  { key: "returnedQty",   header: "كمية المرتجع", width: 14 },
  { key: "returnedValue", header: "قيمة المرتجع (دائن)", width: 18 },
  { key: "netQty",        header: "صافي الكمية",  width: 14 },
  { key: "netValue",      header: "صافي القيمة",  width: 18 },
];

type Filters = {
  from: string; to: string;
  warehouseId: string; customerId: string; itemId: string; branchId: string;
};

export default function ItemSalesValuationReport() {
  const { fmt, fmtQty } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const today    = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const empty: Filters = { from: firstDay, to: today, warehouseId: "", customerId: "", itemId: "", branchId: "" };
  const [filters, setFilters] = useState<Filters>(empty);
  const [applied, setApplied] = useState<Filters>(empty);
  const [basis,   setBasis]   = useState<Basis>("cost");

  // Lookups
  const { data: items = [] }      = useQuery({ queryKey: ["items", cid],      queryFn: () => inventoryApi.getItems(cid) });
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses", cid], queryFn: () => inventoryApi.getWarehouses(cid) });
  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`;
      const r = await fetch(url, { headers: authHeaders() });
      if (!r.ok) return [];
      return r.json();
    },
  });
  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["org-branches", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/org/branches?companyId=${cid}` : `${API}/api/org/branches`;
      const r = await fetch(url, { headers: authHeaders() });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const { data: rows = [], isLoading, isFetching } = useQuery({
    queryKey: ["item-sales-valuation", cid, applied, basis],
    queryFn: () => {
      const params: Record<string, string> = { basis };
      if (cid)                 params.companyId   = String(cid);
      if (applied.from)        params.from        = applied.from;
      if (applied.to)          params.to          = applied.to;
      if (applied.warehouseId) params.warehouseId = applied.warehouseId;
      if (applied.customerId)  params.customerId  = applied.customerId;
      if (applied.itemId)      params.itemId      = applied.itemId;
      if (applied.branchId)    params.branchId    = applied.branchId;
      return inventoryApi.getItemSalesValuationReport(params);
    },
  });

  const totals = (rows as any[]).reduce(
    (acc, r) => {
      acc.soldQty       += Number(r.soldQty)       || 0;
      acc.soldValue     += Number(r.soldValue)     || 0;
      acc.returnedQty   += Number(r.returnedQty)   || 0;
      acc.returnedValue += Number(r.returnedValue) || 0;
      acc.netQty        += Number(r.netQty)        || 0;
      acc.netValue      += Number(r.netValue)      || 0;
      return acc;
    },
    { soldQty: 0, soldValue: 0, returnedQty: 0, returnedValue: 0, netQty: 0, netValue: 0 },
  );

  const exportRows = (rows as any[]).map(r => ({
    itemCode:      r.itemCode ?? "",
    itemNameAr:    r.itemNameAr ?? "",
    unitName:      r.unitName ?? "",
    soldQty:       fmtQty(r.soldQty),
    soldValue:     fmt(r.soldValue),
    returnedQty:   fmtQty(r.returnedQty),
    returnedValue: fmt(r.returnedValue),
    netQty:        fmtQty(r.netQty),
    netValue:      fmt(r.netValue),
  }));

  const totalsRow = {
    itemCode: "الإجمالي", itemNameAr: "", unitName: "",
    soldQty:       fmtQty(totals.soldQty),
    soldValue:     fmt(totals.soldValue),
    returnedQty:   fmtQty(totals.returnedQty),
    returnedValue: fmt(totals.returnedValue),
    netQty:        fmtQty(totals.netQty),
    netValue:      fmt(totals.netValue),
  };

  const apply = () => setApplied(filters);
  const reset = () => { setFilters(empty); setApplied(empty); };
  const hasAnyFilter =
    !!applied.warehouseId || !!applied.customerId || !!applied.itemId || !!applied.branchId;

  const itemMap = new Map<number, any>((items as any[]).map(i => [i.id, i]));
  const whMap   = new Map<number, any>((warehouses as any[]).map(w => [w.id, w]));
  const cusMap  = new Map<number, any>((customers as any[]).map(c => [c.id, c]));
  const brMap   = new Map<number, any>((branches as any[]).map(b => [b.id, b]));
  const appliedItem = applied.itemId      ? itemMap.get(Number(applied.itemId))      : null;
  const appliedWh   = applied.warehouseId ? whMap.get(Number(applied.warehouseId))   : null;
  const appliedCus  = applied.customerId  ? cusMap.get(Number(applied.customerId))   : null;
  const appliedBr   = applied.branchId    ? brMap.get(Number(applied.branchId))      : null;

  const subtitle = [
    `الأساس: ${BASIS_META[basis].label}`,
    `الفترة: ${applied.from} → ${applied.to}`,
    appliedWh  && `المخزن: ${appliedWh.nameAr ?? appliedWh.name}`,
    appliedCus && `العميل: ${appliedCus.nameAr ?? appliedCus.name}`,
    appliedItem && `الصنف: ${appliedItem.nameAr ?? appliedItem.code}`,
    appliedBr  && `الفرع: ${appliedBr.nameAr ?? appliedBr.name}`,
  ].filter(Boolean).join("  •  ");

  const BasisIcon = BASIS_META[basis].icon;

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ReceiptText className="h-6 w-6 text-teal-600" />
            تقرير مبيعات الأصناف
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            إجمالي مبيعات الأصناف والمرتجعات والصافي — قابل للعرض بسعر التكلفة أو بسعر البيع (شامل/بدون ضريبة)
          </p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`مبيعات-الأصناف-${basis}-${applied.from}_${applied.to}`}
          title={`تقرير مبيعات الأصناف — ${BASIS_META[basis].label}`}
          subtitle={subtitle}
          totalsRow={totalsRow}
          disabled={(rows as any[]).length === 0}
        />
      </div>

      {/* Basis toggle — the star feature */}
      <div className="rounded-2xl border bg-gradient-to-br from-slate-50 to-slate-100/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <p className="text-xs text-muted-foreground">أساس الحساب</p>
            <p className="text-sm font-bold flex items-center gap-2 mt-0.5">
              <BasisIcon className="h-4 w-4 text-primary" /> {BASIS_META[basis].label}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">{BASIS_META[basis].desc}</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(BASIS_META) as Basis[]).map(k => {
            const Meta = BASIS_META[k];
            const Icon = Meta.icon;
            const active = basis === k;
            return (
              <button
                key={k}
                onClick={() => setBasis(k)}
                className={cn(
                  "rounded-xl border p-3 text-right transition-all",
                  active
                    ? "ring-2 ring-offset-1 ring-primary bg-white shadow-sm"
                    : "bg-white/60 hover:bg-white hover:shadow-sm border-muted",
                )}
              >
                <Icon className={cn("h-5 w-5 mb-1.5", active ? "text-primary" : "text-muted-foreground")} />
                <p className="text-xs font-bold">{Meta.label}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{Meta.desc}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Filter card */}
      <div className="rounded-2xl border bg-gradient-to-br from-teal-50/60 to-emerald-50/30 p-5 space-y-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold flex items-center gap-2 text-teal-700">
            <Filter className="h-4 w-4" /> الفلاتر
          </h3>
          {hasAnyFilter && (
            <Button size="sm" variant="ghost" className="text-xs h-7" onClick={reset}>
              <X className="h-3 w-3 ml-1" /> تفريغ الفلاتر
            </Button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">من تاريخ</Label>
            <Input type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">إلى تاريخ</Label>
            <Input type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">المخزن</Label>
            <SearchCombobox
              items={[{ value: "", label: "جميع المخازن" }, ...(warehouses as any[]).map(w => ({ value: String(w.id), label: `${w.nameAr ?? w.name} — ${w.code ?? ""}` }))]}
              value={filters.warehouseId}
              onValueChange={v => setFilters(f => ({ ...f, warehouseId: v }))}
              placeholder="جميع المخازن"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">الفرع</Label>
            <SearchCombobox
              items={[{ value: "", label: "جميع الفروع" }, ...(branches as any[]).map(b => ({ value: String(b.id), label: b.nameAr ?? b.name ?? "" }))]}
              value={filters.branchId}
              onValueChange={v => setFilters(f => ({ ...f, branchId: v }))}
              placeholder="جميع الفروع"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">العميل</Label>
            <SearchCombobox
              items={[{ value: "", label: "جميع العملاء" }, ...(customers as any[]).map(c => ({ value: String(c.id), label: `${c.nameAr ?? c.name ?? ""} ${c.code ? `— ${c.code}` : ""}` }))]}
              value={filters.customerId}
              onValueChange={v => setFilters(f => ({ ...f, customerId: v }))}
              placeholder="جميع العملاء"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">الصنف</Label>
            <SearchCombobox
              items={[{ value: "", label: "جميع الأصناف" }, ...(items as any[]).map(i => ({ value: String(i.id), label: `${i.nameAr ?? i.code} ${i.code ? `— ${i.code}` : ""}` }))]}
              value={filters.itemId}
              onValueChange={v => setFilters(f => ({ ...f, itemId: v }))}
              placeholder="جميع الأصناف"
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-2 flex items-end">
            <Button onClick={apply} className={cn("w-full text-white", BASIS_META[basis].chip)}>
              <Filter className="h-4 w-4 ml-2" /> عرض التقرير
            </Button>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-blue-50 border-blue-200 p-4">
          <p className="text-xs text-blue-700">قيمة البيع (مدين)</p>
          <p className="text-2xl font-bold text-blue-700 tabular-nums mt-1">{fmt(totals.soldValue)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">كمية: {fmtQty(totals.soldQty)}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-4">
          <p className="text-xs text-amber-700">قيمة المرتجع (دائن)</p>
          <p className="text-2xl font-bold text-amber-700 tabular-nums mt-1">{fmt(totals.returnedValue)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">كمية: {fmtQty(totals.returnedQty)}</p>
        </div>
        <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4">
          <p className="text-xs text-emerald-700">صافي القيمة</p>
          <p className="text-2xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totals.netValue)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">صافي الكمية: {fmtQty(totals.netQty)}</p>
        </div>
      </div>

      {/* Results table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[980px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الصنف</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">الوحدة</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">كمية البيع</th>
                <th className="px-4 py-3 text-center font-semibold text-blue-700">قيمة البيع (مدين)</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">كمية المرتجع</th>
                <th className="px-4 py-3 text-center font-semibold text-amber-700">قيمة المرتجع (دائن)</th>
                <th className="px-4 py-3 text-center font-semibold text-emerald-700">صافي الكمية</th>
                <th className="px-4 py-3 text-center font-semibold text-emerald-700">صافي القيمة</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {(isLoading || isFetching)
                ? [...Array(5)].map((_, i) => (
                    <tr key={i}><td colSpan={8} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>
                  ))
                : (rows as any[]).length === 0
                ? <tr><td colSpan={8} className="py-12 text-center text-muted-foreground">
                    <PackageOpen className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    لا توجد بيانات للفترة / الفلاتر المحددة
                  </td></tr>
                : (rows as any[]).map((r) => (
                    <tr key={r.itemId} className="hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <p className="font-medium text-sm">{r.itemNameAr ?? "—"}</p>
                        <p className="text-[10px] text-muted-foreground font-mono">{r.itemCode}</p>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground">{r.unitName ?? "—"}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-sm">{fmtQty(r.soldQty)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-blue-700 font-medium">{fmt(r.soldValue)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-sm">{fmtQty(r.returnedQty)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-amber-700 font-medium">{fmt(r.returnedValue)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-emerald-700 font-bold">{fmtQty(r.netQty)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-emerald-700 font-bold">{fmt(r.netValue)}</td>
                    </tr>
                  ))}
            </tbody>
            {(rows as any[]).length > 0 && (
              <tfoot className="bg-muted/40 border-t-2">
                <tr>
                  <td className="px-4 py-3 font-bold text-sm" colSpan={2}>الإجمالي</td>
                  <td className="px-4 py-3 text-center tabular-nums font-bold">{fmtQty(totals.soldQty)}</td>
                  <td className="px-4 py-3 text-center tabular-nums font-bold text-blue-700">{fmt(totals.soldValue)}</td>
                  <td className="px-4 py-3 text-center tabular-nums font-bold">{fmtQty(totals.returnedQty)}</td>
                  <td className="px-4 py-3 text-center tabular-nums font-bold text-amber-700">{fmt(totals.returnedValue)}</td>
                  <td className="px-4 py-3 text-center tabular-nums font-bold text-emerald-700">{fmtQty(totals.netQty)}</td>
                  <td className="px-4 py-3 text-center tabular-nums font-bold text-emerald-700">{fmt(totals.netValue)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
