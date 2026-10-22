import { useMemo, useState } from "react";
import { localizedName } from "@/lib/localizedName";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import { Hourglass, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { useTranslation } from "react-i18next";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";
import { InventoryBrandFilter, filterItemsForInventoryBrand, useInventoryReportBrandOptions } from "@/components/InventoryBrandFilter";
import { clothingVariantItemIds } from "@/lib/clothingStockReport";

export default function SlowMovingItems({ clothingOnly = false }: { clothingOnly?: boolean }) {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => localizedName(ar, en, isRtl ? "ar" : "en");
  const { fmt, fmtQty } = useFmt();
  const [brandId, setBrandId] = useState("");

  const EXPORT_COLS = [
    { key: "itemCode",     header: t("inventoryReports.slowMoving.exportItemCode"),       width: 16 },
    { key: "itemNameAr",   header: t("inventoryReports.slowMoving.exportItemName"),       width: 30 },
    ...(clothingOnly ? [
      { key: "modelName", header: t("inventoryReports.clothingSlowMoving.model"), width: 24 },
      { key: "color", header: t("inventoryReports.clothingSlowMoving.color"), width: 16 },
      { key: "size", header: t("inventoryReports.clothingSlowMoving.size"), width: 12 },
    ] : []),
    { key: "groupName",    header: t("inventoryReports.slowMoving.exportGroup"),          width: 20 },
    { key: "qty",          header: t("inventoryReports.slowMoving.exportCurrentBalance"), width: 16 },
    { key: "value",        header: t("inventoryReports.slowMoving.exportValue"),          width: 16 },
    { key: "lastMoveDate", header: t("inventoryReports.slowMoving.exportLastMove"),       width: 16 },
    { key: "daysIdle",     header: t("inventoryReports.slowMoving.exportDaysIdle"),       width: 16 },
  ];

  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const brandOptions = useInventoryReportBrandOptions(cid);
  const [days, setDays] = useState("90");
  const [search, setSearch] = useState("");

  const itemsQuery = useQuery({
    queryKey: ["items", cid],
    queryFn: () => inventoryApi.getItems(cid),
  });
  const items = itemsQuery.data ?? [];
  const { data: balances = [], isLoading: bLoad, isError: bError, refetch: refetchBalances } = useQuery({
    queryKey: ["stock-balance-all", cid],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (cid) params.companyId = String(cid);
      return inventoryApi.getBalance(params);
    },
  });
  // Backend-aggregated last movement date per item (handles >500 ledger rows correctly)
  const { data: lastMoves = [], isLoading: lLoad, isError: lError, refetch: refetchLastMoves } = useQuery({
    queryKey: ["last-movements", cid],
    queryFn: () => inventoryApi.getLastMovements(cid),
  });

  const isLoading = bLoad || lLoad || itemsQuery.isLoading;
  const hasLoadError = itemsQuery.isError || bError || lError;
  const clothingIds = useMemo(() => clothingVariantItemIds(items as any[]), [items]);
  const itemById = useMemo(() => new Map<number, any>((items as any[]).map((item) => [Number(item.id), item])), [items]);

  const lastMoveByItem: Record<number, string> = {};
  (lastMoves as { itemId: number; lastDate: string }[]).forEach(l => {
    if (l.lastDate) lastMoveByItem[Number(l.itemId)] = l.lastDate;
  });

  // Aggregate balance + value per item
  type Agg = { qty: number; value: number };
  const balByItem: Record<number, Agg> = {};
  (balances as any[]).forEach((b: any) => {
    const id = Number(b.itemId);
    if (!balByItem[id]) balByItem[id] = { qty: 0, value: 0 };
    balByItem[id].qty += Number(b.qty);
    balByItem[id].value += Number(b.qty) * Number(b.avgCost);
  });

  const today = new Date();
  const threshold = Number(days) || 90;

  const enriched = filterItemsForInventoryBrand(items as any[], brandId, brandOptions)
    .filter((it: any) => !clothingOnly || clothingIds.has(Number(it.id)))
    .filter((it: any) => it.itemType !== "service")
    .map((it: any) => {
      const bal = balByItem[it.id] ?? { qty: 0, value: 0 };
      const lastMove = lastMoveByItem[it.id];
      const model = it.parentItemId ? itemById.get(Number(it.parentItemId)) : null;
      const attributes = it.variantAttributes ?? {};
      const daysIdle = lastMove
        ? Math.floor((today.getTime() - new Date(lastMove).getTime()) / 86400000)
        : 9999; // Never moved
      return {
        ...it,
        modelName: String(model?.nameAr ?? model?.nameEn ?? ""),
        color: String(attributes["اللون"] ?? ""),
        size: String(attributes["المقاس"] ?? ""),
        qty: bal.qty,
        value: bal.value,
        lastMoveDate: lastMove ?? null,
        daysIdle,
      };
    })
    .filter((r: any) => r.qty > 0 && r.daysIdle >= threshold)
    .filter((r: any) =>
      !search || (r.nameAr ?? "").includes(search) || (r.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
        || r.code?.includes(search) || r.modelName?.includes(search) || r.color?.includes(search) || r.size?.includes(search)
    )
    .sort((a, b) => b.daysIdle - a.daysIdle);

  const totalLockedValue = enriched.reduce((s, r) => s + r.value, 0);

  const exportRows = enriched.map((r: any) => ({
    itemCode:     r.code ?? "",
    itemNameAr:   clothingOnly ? `${r.modelName} — ${r.color || "—"} — ${r.size || "—"}` : pickName(r.nameAr, r.nameEn),
    modelName: r.modelName ?? "",
    color: r.color ?? "",
    size: r.size ?? "",
    groupName:    pickName(r.group?.nameAr, r.group?.nameEn),
    qty:          fmtQty(r.qty),
    value:        fmt(r.value),
    lastMoveDate: r.lastMoveDate ?? t("inventoryReports.slowMoving.neverMoved"),
    daysIdle:     r.daysIdle === 9999 ? "—" : t("inventoryReports.slowMoving.dayUnit", { days: r.daysIdle }),
  }));

  const gridColumns = useMemo<GridColumn<any>[]>(() => [
    {
      key: "item",
      label: t("inventoryReports.common.item"),
      type: "text",
      width: 220,
      value: r => clothingOnly
        ? `${r.modelName ?? ""} ${r.color ?? ""} ${r.size ?? ""} ${r.code ?? ""}`
        : `${pickName(r.nameAr, r.nameEn)} ${r.code ?? ""}`,
      render: r => (
        <div>
          <p className="font-medium text-sm">{clothingOnly ? (r.modelName || pickName(r.nameAr, r.nameEn) || "—") : (pickName(r.nameAr, r.nameEn) || "—")}</p>
          <p className="text-[10px] text-muted-foreground">
            {clothingOnly ? `${r.color || "—"} / ${r.size || "—"} · ` : ""}
            <span className="font-mono">{r.code}</span>
          </p>
        </div>
      ),
    },
    {
      key: "group",
      label: t("inventoryReports.slowMoving.colGroup"),
      type: "text",
      width: 170,
      className: "text-xs text-muted-foreground",
      value: r => pickName(r.group?.nameAr, r.group?.nameEn),
      render: r => pickName(r.group?.nameAr, r.group?.nameEn) || "—",
    },
    {
      key: "qty",
      label: t("inventoryReports.slowMoving.colBalance"),
      type: "num",
      align: "center",
      width: 130,
      className: "tabular-nums",
      value: r => Number(r.qty),
      render: r => fmtQty(r.qty),
    },
    {
      key: "value",
      label: t("inventoryReports.slowMoving.colValue"),
      type: "num",
      align: "center",
      width: 140,
      className: "tabular-nums font-semibold",
      value: r => Number(r.value),
      render: r => fmt(r.value),
    },
    {
      key: "lastMoveDate",
      label: t("inventoryReports.slowMoving.colLastMove"),
      type: "text",
      align: "center",
      width: 150,
      className: "text-xs text-muted-foreground",
      value: r => r.lastMoveDate,
      render: r => r.lastMoveDate ?? t("inventoryReports.slowMoving.notMoved"),
    },
    {
      key: "daysIdle",
      label: t("inventoryReports.slowMoving.colDaysIdle"),
      type: "num",
      align: "center",
      width: 150,
      value: r => Number(r.daysIdle),
      render: r => (
        <span className={`text-xs tabular-nums font-bold rounded-full px-2 py-0.5 ${r.daysIdle >= 365 ? "bg-rose-100 text-rose-700" : r.daysIdle >= 180 ? "bg-amber-100 text-amber-700" : "bg-yellow-50 text-yellow-700"}`}>
          {r.daysIdle === 9999 ? t("inventoryReports.slowMoving.notMoved") : t("inventoryReports.slowMoving.dayUnit", { days: r.daysIdle })}
        </span>
      ),
    },
  ], [t, isRtl, fmt, fmtQty, clothingOnly]);

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Hourglass className="h-6 w-6 text-rose-500" />{clothingOnly ? t("inventoryReports.clothingSlowMoving.title") : t("inventoryReports.slowMoving.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{clothingOnly ? t("inventoryReports.clothingSlowMoving.subtitle") : t("inventoryReports.slowMoving.subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${clothingOnly ? t("inventoryReports.clothingSlowMoving.exportFilename") : t("inventoryReports.slowMoving.exportFilename", { days })}-${new Date().toISOString().slice(0, 10)}`}
          title={clothingOnly ? t("inventoryReports.clothingSlowMoving.title") : t("inventoryReports.slowMoving.exportTitle")}
          subtitle={clothingOnly
            ? t("inventoryReports.clothingSlowMoving.exportSubtitle", { days: threshold })
            : t("inventoryReports.slowMoving.exportSubtitle", { days: threshold })}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-rose-50 border-rose-200 p-4">
          <p className="text-xs text-rose-700">{t("inventoryReports.slowMoving.kpiCount")}</p>
          <p className="text-2xl font-bold text-rose-700 tabular-nums mt-1">{enriched.length}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-4">
          <p className="text-xs text-amber-700">{t("inventoryReports.slowMoving.kpiLockedValue")}</p>
          <p className="text-2xl font-bold text-amber-700 tabular-nums mt-1">{fmt(totalLockedValue)}</p>
          <p className="text-xs text-amber-600">{t("inventoryReports.slowMoving.sar")}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">{t("inventoryReports.slowMoving.kpiThreshold")}</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{threshold}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label>{t("inventoryReports.slowMoving.minDaysLabel")}</Label>
          <Input type="number" min={1} value={days} onChange={e => setDays(e.target.value)} placeholder="90" />
        </div>
        <div className="space-y-1.5">
          <Label>{t("inventoryReports.common.search")}</Label>
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pr-9" placeholder={t("inventoryReports.slowMoving.searchPh")} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
        <InventoryBrandFilter options={brandOptions} value={brandId} onChange={setBrandId} />
      </div>

      {clothingOnly && hasLoadError && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          {t("inventoryReports.clothingSlowMoving.loadError")}
          <button
            type="button"
            className="ms-3 font-semibold underline"
            onClick={() => void Promise.all([itemsQuery.refetch(), refetchBalances(), refetchLastMoves()])}
          >
            {t("inventoryReports.clothingSlowMoving.retry")}
          </button>
        </div>
      )}

      <div className="w-full min-w-0 overflow-hidden rounded-xl">
        {isLoading ? (
          <div className="space-y-2 rounded-xl border bg-card p-4">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : (
          <AdvancedReportGrid
            slug="slowMovingItemsGrid"
            cid={cid}
            columns={gridColumns}
            rowKey={(row: any) => row.id}
            rows={enriched}
            unitLabel={isRtl ? "صنف" : "item"}
            emptyMessage={t("inventoryReports.slowMoving.noItems")}
          />
        )}
      </div>
    </div>
  );
}
