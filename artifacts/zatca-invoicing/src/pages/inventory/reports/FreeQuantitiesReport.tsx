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
import { Gift, Filter, X, PackageOpen } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { useTranslation } from "react-i18next";

const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

type Filters = {
  from: string; to: string;
  warehouseId: string; customerId: string; itemId: string; branchId: string;
};

export default function FreeQuantitiesReport() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => (isRtl ? (ar ?? en) : (en ?? ar)) ?? "";
  const { fmtQty } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const EXPORT_COLS = [
    { key: "itemCode",      header: t("inventoryReports.freeQuantities.itemCode"), width: 16 },
    { key: "itemNameAr",    header: t("inventoryReports.freeQuantities.itemName"), width: 30 },
    { key: "unitName",      header: t("inventoryReports.freeQuantities.unit"),     width: 12 },
    { key: "soldFreeQty",   header: t("inventoryReports.freeQuantities.soldFree"), width: 18 },
    { key: "returnedFreeQty", header: t("inventoryReports.freeQuantities.returnedFree"), width: 18 },
    { key: "netFreeQty",    header: t("inventoryReports.freeQuantities.net"),      width: 14 },
  ];

  const today    = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const empty: Filters = { from: firstDay, to: today, warehouseId: "", customerId: "", itemId: "", branchId: "" };
  const [filters, setFilters] = useState<Filters>(empty);
  const [applied, setApplied] = useState<Filters>(empty);

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
    queryKey: ["free-qty-report", cid, applied],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (cid)                 params.companyId   = String(cid);
      if (applied.from)        params.from        = applied.from;
      if (applied.to)          params.to          = applied.to;
      if (applied.warehouseId) params.warehouseId = applied.warehouseId;
      if (applied.customerId)  params.customerId  = applied.customerId;
      if (applied.itemId)      params.itemId      = applied.itemId;
      if (applied.branchId)    params.branchId    = applied.branchId;
      return inventoryApi.getFreeQuantitiesReport(params);
    },
  });

  // Totals across rows
  const totals = (rows as any[]).reduce(
    (acc, r) => {
      acc.sold     += Number(r.soldFreeQty)     || 0;
      acc.returned += Number(r.returnedFreeQty) || 0;
      acc.net      += Number(r.netFreeQty)      || 0;
      return acc;
    },
    { sold: 0, returned: 0, net: 0 },
  );

  const exportRows = (rows as any[]).map(r => ({
    itemCode:        r.itemCode ?? "",
    itemNameAr:      pickName(r.itemNameAr, r.itemNameEn),
    unitName:        pickName(r.unitName, r.unitNameEn),
    soldFreeQty:     fmtQty(r.soldFreeQty),
    returnedFreeQty: fmtQty(r.returnedFreeQty),
    netFreeQty:      fmtQty(r.netFreeQty),
  }));

  const totalsRow = {
    itemCode: t("inventoryReports.freeQuantities.total"), itemNameAr: "", unitName: "",
    soldFreeQty:     fmtQty(totals.sold),
    returnedFreeQty: fmtQty(totals.returned),
    netFreeQty:      fmtQty(totals.net),
  };

  const apply  = () => setApplied(filters);
  const reset  = () => { setFilters(empty); setApplied(empty); };
  const hasAnyFilter =
    !!applied.warehouseId || !!applied.customerId || !!applied.itemId || !!applied.branchId;

  // Build pretty filter chips for the report subtitle
  const itemMap     = new Map<number, any>((items as any[]).map(i => [i.id, i]));
  const whMap       = new Map<number, any>((warehouses as any[]).map(w => [w.id, w]));
  const cusMap      = new Map<number, any>((customers as any[]).map(c => [c.id, c]));
  const brMap       = new Map<number, any>((branches as any[]).map(b => [b.id, b]));
  const appliedItem = applied.itemId     ? itemMap.get(Number(applied.itemId)) : null;
  const appliedWh   = applied.warehouseId ? whMap.get(Number(applied.warehouseId)) : null;
  const appliedCus  = applied.customerId ? cusMap.get(Number(applied.customerId)) : null;
  const appliedBr   = applied.branchId   ? brMap.get(Number(applied.branchId)) : null;

  const subtitle = [
    `${t("inventoryReports.freeQuantities.period")}: ${applied.from} → ${applied.to}`,
    appliedWh  && `${t("inventoryReports.common.warehouse")}: ${pickName(appliedWh.nameAr, appliedWh.nameEn) || appliedWh.name}`,
    appliedCus && `${t("inventoryReports.freeQuantities.customer")}: ${pickName(appliedCus.nameAr, appliedCus.nameEn) || appliedCus.name}`,
    appliedItem && `${t("inventoryReports.common.item")}: ${pickName(appliedItem.nameAr, appliedItem.nameEn) || appliedItem.code}`,
    appliedBr  && `${t("inventoryReports.freeQuantities.branch")}: ${pickName(appliedBr.nameAr, appliedBr.nameEn) || appliedBr.name}`,
  ].filter(Boolean).join("  •  ");

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Gift className="h-6 w-6 text-pink-500" />
            {t("inventoryReports.freeQuantities.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t("inventoryReports.freeQuantities.subtitle")}
          </p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${t("inventoryReports.freeQuantities.exportFilename")}-${applied.from}_${applied.to}`}
          title={t("inventoryReports.freeQuantities.title")}
          subtitle={subtitle}
          totalsRow={totalsRow}
          disabled={(rows as any[]).length === 0}
        />
      </div>

      {/* Filter card */}
      <div className="rounded-2xl border bg-gradient-to-br from-pink-50/60 to-rose-50/30 p-5 space-y-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold flex items-center gap-2 text-pink-700">
            <Filter className="h-4 w-4" /> {t("inventoryReports.common.filters")}
          </h3>
          {hasAnyFilter && (
            <Button size="sm" variant="ghost" className="text-xs h-7" onClick={reset}>
              <X className="h-3 w-3 ml-1" /> {t("inventoryReports.freeQuantities.clearFilters")}
            </Button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("inventoryReports.common.from")}</Label>
            <Input type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("inventoryReports.common.to")}</Label>
            <Input type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("inventoryReports.common.warehouse")}</Label>
            <SearchCombobox
              items={[{ value: "", label: t("inventoryReports.common.allWarehouses") }, ...(warehouses as any[]).map(w => ({ value: String(w.id), label: `${pickName(w.nameAr, w.nameEn) || w.name} — ${w.code ?? ""}` }))]}
              value={filters.warehouseId}
              onValueChange={v => setFilters(f => ({ ...f, warehouseId: v }))}
              placeholder={t("inventoryReports.common.allWarehouses")}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("inventoryReports.freeQuantities.branch")}</Label>
            <SearchCombobox
              items={[{ value: "", label: t("inventoryReports.freeQuantities.allBranches") }, ...(branches as any[]).map(b => ({ value: String(b.id), label: pickName(b.nameAr, b.nameEn) || b.name || "" }))]}
              value={filters.branchId}
              onValueChange={v => setFilters(f => ({ ...f, branchId: v }))}
              placeholder={t("inventoryReports.freeQuantities.allBranches")}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("inventoryReports.freeQuantities.customer")}</Label>
            <SearchCombobox
              items={[{ value: "", label: t("inventoryReports.freeQuantities.allCustomers") }, ...(customers as any[]).map(c => ({ value: String(c.id), label: `${pickName(c.nameAr, c.nameEn) || c.name || ""} ${c.code ? `— ${c.code}` : ""}` }))]}
              value={filters.customerId}
              onValueChange={v => setFilters(f => ({ ...f, customerId: v }))}
              placeholder={t("inventoryReports.freeQuantities.allCustomers")}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("inventoryReports.common.item")}</Label>
            <SearchCombobox
              items={[{ value: "", label: t("inventoryReports.freeQuantities.allItems") }, ...(items as any[]).map(i => ({ value: String(i.id), label: `${pickName(i.nameAr, i.nameEn) || i.code} ${i.code ? `— ${i.code}` : ""}` }))]}
              value={filters.itemId}
              onValueChange={v => setFilters(f => ({ ...f, itemId: v }))}
              placeholder={t("inventoryReports.freeQuantities.allItems")}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-2 flex items-end">
            <Button onClick={apply} className="w-full bg-pink-600 hover:bg-pink-700">
              <Filter className="h-4 w-4 ml-2" /> {t("inventoryReports.freeQuantities.showReport")}
            </Button>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-blue-50 border-blue-200 p-4">
          <p className="text-xs text-blue-700">{t("inventoryReports.freeQuantities.soldFree")}</p>
          <p className="text-2xl font-bold text-blue-700 tabular-nums mt-1">{fmtQty(totals.sold)}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-4">
          <p className="text-xs text-amber-700">{t("inventoryReports.freeQuantities.returnedFree")}</p>
          <p className="text-2xl font-bold text-amber-700 tabular-nums mt-1">{fmtQty(totals.returned)}</p>
        </div>
        <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4">
          <p className="text-xs text-emerald-700">{t("inventoryReports.freeQuantities.netSummary")}</p>
          <p className="text-2xl font-bold text-emerald-700 tabular-nums mt-1">{fmtQty(totals.net)}</p>
        </div>
      </div>

      {/* Results table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{t("inventoryReports.common.item")}</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">{t("inventoryReports.freeQuantities.unit")}</th>
                <th className="px-4 py-3 text-center font-semibold text-blue-700">{t("inventoryReports.freeQuantities.soldFree")}</th>
                <th className="px-4 py-3 text-center font-semibold text-amber-700">{t("inventoryReports.freeQuantities.returnedFree")}</th>
                <th className="px-4 py-3 text-center font-semibold text-emerald-700">{t("inventoryReports.freeQuantities.net")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {(isLoading || isFetching)
                ? [...Array(5)].map((_, i) => (
                    <tr key={i}><td colSpan={5} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>
                  ))
                : (rows as any[]).length === 0
                ? <tr><td colSpan={5} className="py-12 text-center text-muted-foreground">
                    <PackageOpen className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    {t("inventoryReports.freeQuantities.noData")}
                  </td></tr>
                : (rows as any[]).map((r) => (
                    <tr key={r.itemId} className="hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <p className="font-medium text-sm">{pickName(r.itemNameAr, r.itemNameEn) || "—"}</p>
                        <p className="text-[10px] text-muted-foreground font-mono">{r.itemCode}</p>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground">{pickName(r.unitName, r.unitNameEn) || "—"}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-blue-700 font-medium">{fmtQty(r.soldFreeQty)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-amber-700 font-medium">{fmtQty(r.returnedFreeQty)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-emerald-700 font-bold">{fmtQty(r.netFreeQty)}</td>
                    </tr>
                  ))}
            </tbody>
            {(rows as any[]).length > 0 && (
              <tfoot className="bg-muted/40 border-t-2">
                <tr>
                  <td className="px-4 py-3 font-bold text-sm" colSpan={2}>{t("inventoryReports.freeQuantities.total")}</td>
                  <td className="px-4 py-3 text-center tabular-nums font-bold text-blue-700">{fmtQty(totals.sold)}</td>
                  <td className="px-4 py-3 text-center tabular-nums font-bold text-amber-700">{fmtQty(totals.returned)}</td>
                  <td className="px-4 py-3 text-center tabular-nums font-bold text-emerald-700">{fmtQty(totals.net)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
