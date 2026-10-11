import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import {
  mapClothingStockRows,
  type ClothingStockBalance,
  type ClothingStockItem,
} from "@/lib/clothingStockReport";
import ExportButtons from "@/components/ExportButtons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { useFmt } from "@/hooks/use-fmt";
import { ArrowRight, ChevronLeft, Shirt } from "lucide-react";

const PAGE_SIZE = 25;

export default function ClothingStockReport() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { fmtQty, fmtCost, fmtVal } = useFmt();
  const isRtl = i18n.language === "ar";
  const tr = (key: string) => t(`inventoryReports.clothingStock.${key}`) as string;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const [warehouseId, setWarehouseId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const itemsQuery = useQuery({
    queryKey: ["items", cid],
    queryFn: () => inventoryApi.getItems(cid),
  });
  const warehousesQuery = useQuery({
    queryKey: ["warehouses", cid],
    queryFn: () => inventoryApi.getWarehouses(cid),
  });
  const balanceQuery = useQuery({
    queryKey: ["stock-balance", cid, warehouseId],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (cid) params.companyId = String(cid);
      if (warehouseId) params.warehouseId = warehouseId;
      return inventoryApi.getBalance(params);
    },
  });

  const rows = useMemo(
    () => mapClothingStockRows(
      (itemsQuery.data ?? []) as ClothingStockItem[],
      (balanceQuery.data ?? []) as ClothingStockBalance[],
    ),
    [itemsQuery.data, balanceQuery.data],
  );
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return rows;
    return rows.filter((row) =>
      [row.modelCode, row.modelNameAr, row.code, row.nameAr, row.barcode, row.color, row.size, row.warehouseNameAr]
        .some((value) => value.toLocaleLowerCase().includes(term)),
    );
  }, [rows, search]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const totalQty = filtered.reduce((total, row) => total + row.qty, 0);
  const totalValue = filtered.reduce((total, row) => total + row.inventoryValue, 0);
  const loading = itemsQuery.isLoading || warehousesQuery.isLoading || balanceQuery.isLoading;
  const error = itemsQuery.isError || warehousesQuery.isError || balanceQuery.isError;
  const selectedWarehouse = (warehousesQuery.data ?? []).find(
    (warehouse: any) => String(warehouse.id) === warehouseId,
  );
  const exportColumns = [
    { key: "modelCode", header: tr("modelCode"), width: 16 },
    { key: "modelNameAr", header: tr("model"), width: 24 },
    { key: "code", header: tr("sku"), width: 20 },
    { key: "barcode", header: tr("barcode"), width: 20 },
    { key: "color", header: tr("color"), width: 16 },
    { key: "size", header: tr("size"), width: 12 },
    { key: "warehouseNameAr", header: tr("warehouse"), width: 22 },
    { key: "qty", header: tr("quantity"), width: 14 },
    { key: "avgCost", header: tr("unitCost"), width: 16 },
    { key: "inventoryValue", header: tr("value"), width: 18 },
  ];

  const retry = () => {
    void Promise.all([itemsQuery.refetch(), warehousesQuery.refetch(), balanceQuery.refetch()]);
  };

  return (
    <main className="space-y-6" dir={isRtl ? "rtl" : "ltr"} data-testid="page-clothing-stock-report">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
            <Link href="/inventory/reports" className="hover:text-foreground">{t("inventoryReports.hub.title")}</Link>
            <ChevronLeft className="h-4 w-4" />
            <span>{tr("title")}</span>
          </div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Shirt className="h-6 w-6 text-primary" />
            {tr("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={filtered}
          columns={exportColumns}
          filename={`${tr("exportFilename")}-${new Date().toISOString().slice(0, 10)}`}
          title={tr("title")}
          subtitle={selectedWarehouse?.nameAr ?? t("inventoryReports.common.allWarehouses")}
        />
      </div>

      <section className="grid gap-3 sm:grid-cols-3" aria-label={tr("summary")}>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">{tr("variantCount")}</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{filtered.length.toLocaleString(i18n.language)}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">{tr("totalQty")}</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{fmtQty(totalQty)}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">{tr("totalValue")}</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{fmtVal(totalValue)}</p>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-end">
        <label className="flex-1 space-y-1.5">
          <span className="text-sm font-medium">{tr("search")}</span>
          <Input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder={tr("searchPlaceholder")} />
        </label>
        <div className="w-full space-y-1.5 sm:max-w-xs">
          <span className="text-sm font-medium">{tr("warehouse")}</span>
          <SearchCombobox
            items={[
              { value: "", label: t("inventoryReports.common.allWarehouses") as string },
              ...(warehousesQuery.data ?? []).map((warehouse: any) => ({
                value: String(warehouse.id),
                code: warehouse.code,
                label: warehouse.nameAr ?? warehouse.nameEn ?? String(warehouse.id),
                labelEn: warehouse.nameEn ?? undefined,
              })),
            ]}
            value={warehouseId}
            onValueChange={(value) => { setWarehouseId(value); setPage(1); }}
            placeholder={t("inventoryReports.common.allWarehouses") as string}
            searchPlaceholder={tr("warehouse")}
            loading={warehousesQuery.isLoading}
            testId="select-clothing-stock-warehouse"
          />
        </div>
      </section>

      {error && (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">{tr("loadError")}</p>
          <Button variant="outline" onClick={retry}>{tr("retry")}</Button>
        </div>
      )}

      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1050px] text-sm">
            <thead className="bg-muted/60 text-muted-foreground">
              <tr>
                {[tr("modelCode"), tr("model"), tr("sku"), tr("barcode"), tr("color"), tr("size"), tr("warehouse"), tr("quantity"), tr("unitCost"), tr("value")].map((label) => (
                  <th key={label} className="whitespace-nowrap px-3 py-3 text-start font-semibold">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading ? (
                Array.from({ length: 5 }, (_, index) => (
                  <tr key={index}><td colSpan={10} className="px-3 py-3"><Skeleton className="h-5 w-full" /></td></tr>
                ))
              ) : visible.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-12 text-center text-muted-foreground">{tr("empty")}</td></tr>
              ) : visible.map((row) => (
                <tr key={`${row.itemId}:${row.warehouseId ?? "all"}`} className="hover:bg-muted/30">
                  <td className="whitespace-nowrap px-3 py-3" dir="ltr">{row.modelCode || "—"}</td>
                  <td className="px-3 py-3 font-medium">{row.modelNameAr || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-3" dir="ltr">{row.code || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-3" dir="ltr">{row.barcode || "—"}</td>
                  <td className="px-3 py-3">{row.color || "—"}</td>
                  <td className="px-3 py-3">{row.size || "—"}</td>
                  <td className="px-3 py-3">{row.warehouseNameAr || selectedWarehouse?.nameAr || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-3 tabular-nums">{fmtQty(row.qty)}</td>
                  <td className="whitespace-nowrap px-3 py-3 tabular-nums">{fmtCost(row.avgCost)}</td>
                  <td className="whitespace-nowrap px-3 py-3 tabular-nums">{fmtVal(row.inventoryValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer className="flex items-center justify-between border-t px-4 py-3 text-sm">
          <span className="text-muted-foreground">{tr("page")} {currentPage} / {pageCount}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              <ArrowRight className={`h-4 w-4 ${isRtl ? "" : "rotate-180"}`} /> {tr("previous")}
            </Button>
            <Button variant="outline" size="sm" disabled={currentPage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>
              {tr("next")} <ArrowRight className={`h-4 w-4 ${isRtl ? "rotate-180" : ""}`} />
            </Button>
          </div>
        </footer>
      </section>
    </main>
  );
}
