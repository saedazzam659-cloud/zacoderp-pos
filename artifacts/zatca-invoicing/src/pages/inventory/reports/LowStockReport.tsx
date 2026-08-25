import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import { AlertTriangle, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFmt } from "@/hooks/use-fmt";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";

export default function LowStockReport() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => (isRtl ? (ar ?? en) : (en ?? ar)) ?? "";
  const { fmtQty } = useFmt();
  const { user } = useAuth();

  const EXPORT_COLS = [
    { key: "itemCode",     header: t("inventoryReports.lowStock.cols.itemCode"),     width: 16 },
    { key: "itemNameAr",   header: t("inventoryReports.lowStock.cols.itemName"),     width: 30 },
    { key: "groupName",    header: t("inventoryReports.lowStock.cols.group"),        width: 20 },
    { key: "unitName",     header: t("inventoryReports.lowStock.cols.unit"),         width: 14 },
    { key: "qty",          header: t("inventoryReports.lowStock.cols.currentQty"),   width: 16 },
    { key: "reorderLevel", header: t("inventoryReports.lowStock.cols.reorderLevel"), width: 14 },
    { key: "shortage",     header: t("inventoryReports.lowStock.cols.shortage"),     width: 14 },
    { key: "status",       header: t("inventoryReports.lowStock.cols.status"),       width: 14 },
  ];
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
      !search || (r.nameAr ?? "").includes(search) || (r.nameEn ?? "").toLowerCase().includes(search.toLowerCase()) || r.code?.includes(search)
    )
    .sort((a, b) => a.qty - b.qty);

  const outCount = enriched.filter(r => r.status === "out").length;
  const lowCount = enriched.filter(r => r.status === "low").length;

  const exportRows = enriched.map((r: any) => ({
    itemCode:     r.code ?? "",
    itemNameAr:   pickName(r.nameAr, r.nameEn) || "",
    groupName:    pickName(r.group?.nameAr, r.group?.nameEn) || "",
    unitName:     pickName(r.unit?.nameAr, r.unit?.nameEn) || "",
    qty:          fmtQty(r.qty),
    reorderLevel: fmtQty(r.reorder),
    shortage:     fmtQty(r.shortage),
    status:       r.status === "out" ? t("inventoryReports.lowStock.status.out") : t("inventoryReports.lowStock.status.low"),
  }));

  const gridColumns = useMemo<GridColumn<any>[]>(() => [
    {
      key: "item",
      label: t("inventoryReports.lowStock.tableItem"),
      type: "text",
      width: 260,
      value: r => `${pickName(r.nameAr, r.nameEn)} ${r.code ?? ""}`,
      render: r => (
        <>
          <p className="font-medium text-sm">{pickName(r.nameAr, r.nameEn) || "—"}</p>
          <p className="text-[10px] text-muted-foreground font-mono">{r.code}</p>
        </>
      ),
    },
    {
      key: "group",
      label: t("inventoryReports.lowStock.cols.group"),
      type: "text",
      width: 170,
      className: "text-xs text-muted-foreground",
      value: r => pickName(r.group?.nameAr, r.group?.nameEn),
      render: r => pickName(r.group?.nameAr, r.group?.nameEn) || "—",
    },
    {
      key: "unit",
      label: t("inventoryReports.lowStock.cols.unit"),
      type: "text",
      width: 130,
      className: "text-xs text-muted-foreground",
      value: r => pickName(r.unit?.nameAr, r.unit?.nameEn),
      render: r => pickName(r.unit?.nameAr, r.unit?.nameEn) || "—",
    },
    {
      key: "qty",
      label: t("inventoryReports.lowStock.cols.currentQty"),
      type: "num",
      align: "center",
      width: 140,
      className: "tabular-nums font-bold",
      value: r => Number(r.qty),
      render: r => <span className={r.status === "out" ? "text-red-600" : "text-amber-600"}>{fmtQty(r.qty)}</span>,
    },
    {
      key: "reorder",
      label: t("inventoryReports.lowStock.cols.reorderLevel"),
      type: "num",
      align: "center",
      width: 140,
      className: "tabular-nums",
      value: r => Number(r.reorder),
      render: r => fmtQty(r.reorder),
    },
    {
      key: "shortage",
      label: t("inventoryReports.lowStock.cols.shortage"),
      type: "num",
      align: "center",
      width: 130,
      className: "tabular-nums font-bold text-amber-700",
      value: r => Number(r.shortage),
      render: r => fmtQty(r.shortage),
    },
    {
      key: "status",
      label: t("inventoryReports.lowStock.cols.status"),
      type: "text",
      align: "center",
      width: 130,
      value: r => r.status,
      render: r => r.status === "out"
        ? <span className="text-[10px] bg-red-50 text-red-600 rounded-full px-2 py-0.5 font-medium">{t("inventoryReports.lowStock.badge.out")}</span>
        : <span className="text-[10px] bg-amber-50 text-amber-700 rounded-full px-2 py-0.5 font-medium inline-flex items-center gap-1"><AlertTriangle className="h-2.5 w-2.5" />{t("inventoryReports.lowStock.badge.low")}</span>,
    },
  ], [isRtl, t, fmtQty]);

  return (
    <div className="w-full min-w-0 max-w-none space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><AlertTriangle className="h-6 w-6 text-amber-500" />{t("inventoryReports.lowStock.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("inventoryReports.lowStock.subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${t("inventoryReports.lowStock.exportFilename")}-${new Date().toISOString().slice(0, 10)}`}
          title={t("inventoryReports.lowStock.exportTitle")}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-red-50 border-red-200 p-4">
          <p className="text-xs text-red-700">{t("inventoryReports.lowStock.stats.out")}</p>
          <p className="text-2xl font-bold text-red-700 tabular-nums mt-1">{outCount}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-4">
          <p className="text-xs text-amber-700">{t("inventoryReports.lowStock.stats.low")}</p>
          <p className="text-2xl font-bold text-amber-700 tabular-nums mt-1">{lowCount}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">{t("inventoryReports.lowStock.stats.total")}</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{enriched.length}</p>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pr-9" placeholder={t("inventoryReports.lowStock.searchPh")} value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="w-full min-w-0 overflow-hidden rounded-xl shadow-sm">
        {isLoading ? (
          <div className="space-y-2 rounded-xl border bg-card p-4">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : (
          <AdvancedReportGrid
            slug="inventoryLowStockReportGrid"
            cid={cid}
            columns={gridColumns}
            rowKey={(row: any) => row.id}
            rows={enriched}
            unitLabel={isRtl ? "صنف" : "item"}
            emptyMessage={t("inventoryReports.lowStock.emptyState")}
            rowClassName={(r: any) => cn(r.status === "out" ? "bg-red-50/30" : "bg-amber-50/30")}
          />
        )}
      </div>
    </div>
  );
}
