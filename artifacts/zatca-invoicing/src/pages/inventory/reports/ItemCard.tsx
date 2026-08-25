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
import { SearchCombobox } from "@/components/ui/search-combobox";
import { useFmt } from "@/hooks/use-fmt";
import { useTranslation } from "react-i18next";
import { DateField } from "@/components/ui/date-field";
import { Link } from "wouter";
import { TablePagination, type PageSize } from "@/components/TablePagination";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";

const API = import.meta.env.VITE_API_URL ?? "";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  const actingCompanyId = localStorage.getItem("zatca_acting_company_id");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (actingCompanyId) headers["x-acting-company-id"] = actingCompanyId;
  return headers;
}

export default function ItemCard() {
  const { fmt, fmtQty } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => (isRtl ? (ar ?? en) : (en ?? ar)) ?? "";

  const txLabel = (tx: string) => t(`inventoryReports.itemCard.txType.${tx}`, { defaultValue: tx });

  const EXPORT_COLS = [
    { key: "txDate",       header: t("inventoryReports.itemCard.cols.date"),             width: 14 },
    { key: "txType",       header: t("inventoryReports.itemCard.cols.txType"),           width: 18 },
    { key: "documentNumber", header: t("inventoryReports.itemCard.cols.documentNumber"),   width: 20 },
    { key: "warehouseName", header: t("inventoryReports.common.warehouse"),              width: 22 },
    { key: "sourceWarehouse", header: t("inventoryReports.itemCard.cols.sourceWarehouse"), width: 22 },
    { key: "targetWarehouse", header: t("inventoryReports.itemCard.cols.targetWarehouse"), width: 22 },
    { key: "unitName",      header: t("inventoryReports.itemCard.cols.unit"),             width: 14 },
    { key: "costCenter",    header: t("inventoryReports.itemCard.cols.costCenter"),       width: 16 },
    { key: "project",       header: t("inventoryReports.itemCard.cols.project"),          width: 18 },
    { key: "balanceBefore", header: t("inventoryReports.itemCard.cols.balanceBefore"),    width: 16 },
    { key: "qtyIn",        header: t("inventoryReports.itemCard.cols.qtyIn"),            width: 12 },
    { key: "qtyOut",       header: t("inventoryReports.itemCard.cols.qtyOut"),           width: 12 },
    { key: "balanceAfter", header: t("inventoryReports.itemCard.cols.balanceAfter"),     width: 16 },
    { key: "costPrice",    header: t("inventoryReports.itemCard.cols.costPrice"),        width: 14 },
    { key: "totalCost",    header: t("inventoryReports.itemCard.cols.totalCost"),        width: 16 },
    { key: "batchNumber",  header: t("inventoryReports.itemCard.cols.batchNumber"),       width: 16 },
    { key: "expiryDate",   header: t("inventoryReports.itemCard.cols.expiryDate"),        width: 15 },
    { key: "createdAt",    header: t("inventoryReports.itemCard.cols.createdAt"),         width: 20 },
    { key: "notes",        header: t("inventoryReports.itemCard.cols.notes"),             width: 28 },
  ];

  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const emptyFilters = {
    from: firstDay,
    to: today,
    itemId: "",
    warehouseId: "",
    customerId: "",
    txType: "",
    costCenter: "",
  };
  const [filters, setFilters] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(25);

  const { data: items = [] }      = useQuery({ queryKey: ["items", cid],      queryFn: () => inventoryApi.getItems(cid) });
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses", cid], queryFn: () => inventoryApi.getWarehouses(cid) });
  const { data: customers = [] } = useQuery({
    queryKey: ["customers", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authHeaders() });
      return r.json();
    },
  });
  const customerOptions = useMemo(
    () => [
      { value: "", label: t("inventoryReports.itemCard.allCustomers") },
      ...(customers as any[]).map((c: any) => ({
        value: String(c.id),
        label: isRtl ? (c.nameAr ?? c.nameEn ?? `#${c.id}`) : (c.nameEn ?? c.nameAr ?? `#${c.id}`),
      })),
    ],
    [customers, isRtl],
  );
  const movementTypeOptions = useMemo(
    () => [
      { value: "", label: t("inventoryReports.itemCard.allMovementTypes") },
      ...[
        "opening", "purchase", "sale", "purchase_return", "sales_return",
        "transfer_in", "transfer_out", "adjustment", "count_adj",
        "goods_receipt", "goods_delivery", "production_issue", "production_receipt",
      ].map(value => ({ value, label: txLabel(value) })),
    ],
    [t, i18n.language],
  );

  const ledgerParams = (pageNumber: number, size: number) => {
    const params: Record<string, string> = {
      page: String(pageNumber),
      pageSize: String(size),
    };
    if (cid)                 params.companyId   = String(cid);
    if (applied.from)        params.from        = applied.from;
    if (applied.to)          params.to          = applied.to;
    if (applied.itemId)      params.itemId      = applied.itemId;
    if (applied.warehouseId) params.warehouseId = applied.warehouseId;
    if (applied.customerId)  params.customerId  = applied.customerId;
    if (applied.txType)      params.txType      = applied.txType;
    if (applied.costCenter)  params.costCenter  = applied.costCenter;
    return params;
  };
  const emptyLedgerPage = {
    rows: [] as any[],
    total: 0,
    page: 1,
    pageSize,
    pageCount: 1,
    summary: { opening: 0, totalIn: 0, totalOut: 0, final: 0 },
  };
  const { data: ledgerPage = emptyLedgerPage, isLoading } = useQuery({
    queryKey: ["item-card", cid, applied, page, pageSize],
    enabled: !!applied.itemId,
    queryFn: () => inventoryApi.getLedgerPage(ledgerParams(page, pageSize)),
  });
  const rows = ledgerPage.rows;

  const item = (items as any[]).find((i: any) => String(i.id) === applied.itemId);
  const selectedCustomer = (customers as any[]).find((c: any) => String(c.id) === applied.customerId);
  const selectedCustomerName = selectedCustomer
    ? (isRtl ? (selectedCustomer.nameAr ?? selectedCustomer.nameEn) : (selectedCustomer.nameEn ?? selectedCustomer.nameAr))
    : null;

  // Sort ascending and use the stock ledger's persisted per-warehouse balance.
  // This preserves the same inventory logic used when the movement was posted;
  // no separate report-only stock calculation is introduced.
  const augmented = useMemo(() => {
    const sorted = [...(rows as any[])].sort((a, b) => {
      const d = String(a.txDate).localeCompare(String(b.txDate));
      return d !== 0 ? d : Number(a.id) - Number(b.id);
    });
    const fallbackByWarehouse = new Map<string, number>();
    return sorted.map(r => {
      const q = Number(r.qty);
      const warehouseKey = String(r.warehouseId ?? "");
      const fallbackBefore = fallbackByWarehouse.get(warehouseKey) ?? 0;
      const balanceBefore = r.balanceBefore != null ? Number(r.balanceBefore) : fallbackBefore;
      const balanceAfter = r.balanceAfter != null ? Number(r.balanceAfter) : balanceBefore + q;
      fallbackByWarehouse.set(warehouseKey, balanceAfter);
      return {
        ...r,
        qtyIn:  q > 0 ? q : 0,
        qtyOut: q < 0 ? -q : 0,
        balanceBefore,
        balanceAfter,
        running: balanceAfter,
      };
    });
  }, [rows]);

  const totals = { in: Number(ledgerPage.summary.totalIn) || 0, out: Number(ledgerPage.summary.totalOut) || 0 };
  const balanceSummary = {
    opening: Number(ledgerPage.summary.opening) || 0,
    final: Number(ledgerPage.summary.final) || 0,
  };

  const toExportRow = (r: any) => ({
    txDate:        r.txDate,
    txType:        txLabel(r.txType),
    documentNumber: r.documentNumber ?? "",
    warehouseName: pickName(r.warehouse?.nameAr, r.warehouse?.nameEn) || "—",
    sourceWarehouse: pickName(r.sourceWarehouse?.nameAr, r.sourceWarehouse?.nameEn) || "",
    targetWarehouse: pickName(r.targetWarehouse?.nameAr, r.targetWarehouse?.nameEn) || "",
    unitName:       pickName(r.unit?.nameAr, r.unit?.nameEn) || r.unit?.code || "",
    costCenter:     r.costCenter ?? "",
    project:        r.project?.nameAr ?? r.project?.nameEn ?? r.project ?? "",
    balanceBefore:  fmtQty(r.balanceBefore),
    qtyIn:         r.qtyIn ? fmtQty(r.qtyIn) : "",
    qtyOut:        r.qtyOut ? fmtQty(r.qtyOut) : "",
    balanceAfter:  fmtQty(r.balanceAfter),
    costPrice:     fmt(r.costPrice),
    totalCost:     fmt(r.totalCost),
    batchNumber:   r.batchNumber ?? "",
    expiryDate:    r.expiryDate ?? "",
    createdAt:     r.createdAt ? new Date(r.createdAt).toLocaleString(isRtl ? "ar-SA" : "en-US") : "",
    notes:         r.movementNotes ?? "",
  });
  const exportRows = augmented.map(toExportRow);
  const loadAllExportRows = async () => {
    const first = await inventoryApi.getLedgerPage(ledgerParams(1, 1000));
    const remaining = first.pageCount > 1
      ? await Promise.all(
          Array.from(
            { length: first.pageCount - 1 },
            (_, index) => inventoryApi.getLedgerPage(ledgerParams(index + 2, 1000)),
          ),
        )
      : [];
    return [first, ...remaining]
      .flatMap(result => result.rows)
      .sort((a, b) => {
        const dateOrder = String(a.txDate).localeCompare(String(b.txDate));
        return dateOrder !== 0 ? dateOrder : Number(a.id) - Number(b.id);
      })
      .map((r: any) => {
        const qty = Number(r.qty) || 0;
        return toExportRow({
          ...r,
          qtyIn: qty > 0 ? qty : 0,
          qtyOut: qty < 0 ? -qty : 0,
        });
      });
  };

  const gridColumns = useMemo<GridColumn<any>[]>(() => [
    { key: "txDate", label: t("inventoryReports.itemCard.cols.date"), type: "text", width: 96, value: r => r.txDate },
    { key: "txType", label: t("inventoryReports.itemCard.cols.txType"), type: "text", width: 118, value: r => txLabel(r.txType) },
    {
      key: "documentNumber", label: t("inventoryReports.itemCard.cols.documentNumber"), type: "text", width: 130,
      value: r => r.documentNumber ?? "",
      render: r => r.documentNumber && r.documentPath
        ? <Link href={r.documentPath} className="font-semibold text-primary underline underline-offset-4 hover:text-primary/80">{r.documentNumber}</Link>
        : "—",
    },
    { key: "warehouse", label: t("inventoryReports.common.warehouse"), type: "text", width: 130, value: r => pickName(r.warehouse?.nameAr, r.warehouse?.nameEn), render: r => pickName(r.warehouse?.nameAr, r.warehouse?.nameEn) || "—" },
    { key: "sourceWarehouse", label: t("inventoryReports.itemCard.cols.sourceWarehouse"), type: "text", width: 130, value: r => pickName(r.sourceWarehouse?.nameAr, r.sourceWarehouse?.nameEn), render: r => pickName(r.sourceWarehouse?.nameAr, r.sourceWarehouse?.nameEn) || "—" },
    { key: "targetWarehouse", label: t("inventoryReports.itemCard.cols.targetWarehouse"), type: "text", width: 130, value: r => pickName(r.targetWarehouse?.nameAr, r.targetWarehouse?.nameEn), render: r => pickName(r.targetWarehouse?.nameAr, r.targetWarehouse?.nameEn) || "—" },
    { key: "unit", label: t("inventoryReports.itemCard.cols.unit"), type: "text", width: 90, value: r => pickName(r.unit?.nameAr, r.unit?.nameEn) || r.unit?.code, render: r => pickName(r.unit?.nameAr, r.unit?.nameEn) || r.unit?.code || "—" },
    { key: "costCenter", label: t("inventoryReports.itemCard.cols.costCenter"), type: "text", width: 120, value: r => r.costCenter, render: r => r.costCenter || "—" },
    { key: "project", label: t("inventoryReports.itemCard.cols.project"), type: "text", width: 120, value: r => r.project?.nameAr ?? r.project?.nameEn ?? r.project, render: r => r.project?.nameAr ?? r.project?.nameEn ?? r.project ?? "—" },
    { key: "balanceBefore", label: t("inventoryReports.itemCard.cols.balanceBefore"), type: "num", align: "center", width: 110, className: "tabular-nums font-semibold", value: r => r.balanceBefore, render: r => fmtQty(r.balanceBefore) },
    { key: "qtyIn", label: t("inventoryReports.itemCard.cols.qtyIn"), type: "num", align: "center", width: 90, className: "tabular-nums font-bold text-green-700", value: r => r.qtyIn, render: r => r.qtyIn ? fmtQty(r.qtyIn) : "—" },
    { key: "qtyOut", label: t("inventoryReports.itemCard.cols.qtyOut"), type: "num", align: "center", width: 90, className: "tabular-nums font-bold text-red-700", value: r => r.qtyOut, render: r => r.qtyOut ? fmtQty(r.qtyOut) : "—" },
    { key: "balanceAfter", label: t("inventoryReports.itemCard.cols.balanceAfter"), type: "num", align: "center", width: 110, className: "tabular-nums font-bold", value: r => r.balanceAfter, render: r => fmtQty(r.balanceAfter) },
    { key: "costPrice", label: t("inventoryReports.itemCard.cols.costPrice"), type: "num", align: "center", width: 100, className: "tabular-nums", value: r => r.costPrice, render: r => fmt(r.costPrice) },
    { key: "totalCost", label: t("inventoryReports.itemCard.cols.totalCost"), type: "num", align: "center", width: 110, className: "tabular-nums", value: r => r.totalCost, render: r => fmt(r.totalCost) },
    { key: "batchNumber", label: t("inventoryReports.itemCard.cols.batchNumber"), type: "text", width: 110, value: r => r.batchNumber, render: r => r.batchNumber || "—" },
    { key: "expiryDate", label: t("inventoryReports.itemCard.cols.expiryDate"), type: "text", width: 110, value: r => r.expiryDate, render: r => r.expiryDate || "—" },
    { key: "createdAt", label: t("inventoryReports.itemCard.cols.createdAt"), type: "text", width: 170, value: r => r.createdAt, render: r => r.createdAt ? new Date(r.createdAt).toLocaleString(isRtl ? "ar-SA" : "en-US") : "—" },
    { key: "notes", label: t("inventoryReports.itemCard.cols.notes"), type: "text", width: 220, className: "whitespace-normal", value: r => r.movementNotes, render: r => r.movementNotes || "—" },
  ], [t, isRtl, fmt, fmtQty]);

  // Grand-totals row appended to Excel and printed/PDF view (renders on the
  // last page only via the centralized exporter).
  const exportTotalsRow = (applied.itemId && !isLoading && augmented.length > 0)
    ? {
        txDate:        t("inventoryReports.itemCard.grandTotal"),
        txType:        "",
        documentNumber: "",
        warehouseName: "",
        sourceWarehouse: "",
        targetWarehouse: "",
        unitName: "",
        costCenter: "",
        project: "",
        balanceBefore: fmtQty(balanceSummary.opening),
        qtyIn:         fmtQty(totals.in),
        qtyOut:        fmtQty(totals.out),
        balanceAfter:  fmtQty(balanceSummary.final),
        costPrice:     "",
        totalCost:     "",
        batchNumber:   "",
        expiryDate:    "",
        createdAt:     "",
        notes:         "",
      }
    : null;

  return (
    <div className="w-full min-w-0 max-w-none space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><IdCard className="h-6 w-6 text-primary" />{t("inventoryReports.itemCard.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("inventoryReports.itemCard.subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          loadRows={loadAllExportRows}
          columns={EXPORT_COLS}
          filename={`${t("inventoryReports.itemCard.exportFilenamePrefix")}-${item?.code ?? "all"}-${applied.from}-${applied.to}${selectedCustomerName ? `-${selectedCustomerName}` : ""}`}
          title={t("inventoryReports.itemCard.title")}
          subtitle={item
            ? `${item.code} - ${pickName(item.nameAr, item.nameEn) || item.nameAr}  |  ${applied.from} → ${applied.to}${selectedCustomerName ? `  |  ${t("inventoryReports.itemCard.customer")}: ${selectedCustomerName}` : ""}`
            : t("inventoryReports.itemCard.selectItemPrompt")}
          totalsRow={exportTotalsRow}
        />
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("inventoryReports.itemCard.cardParams")}</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t("inventoryReports.common.item")} <span className="text-red-500">*</span></Label>
            <SearchCombobox
              items={(items as any[]).map((it: any) => ({ value: String(it.id), code: it.code, label: pickName(it.nameAr, it.nameEn), labelEn: it.nameEn }))}
              value={filters.itemId}
              onValueChange={v => setFilters(p => ({ ...p, itemId: v }))}
              placeholder={t("inventoryReports.common.selectItem")}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t("inventoryReports.itemCard.movementType")}</Label>
            <SearchCombobox
              items={movementTypeOptions}
              value={filters.txType}
              onValueChange={v => setFilters(p => ({ ...p, txType: v }))}
              placeholder={t("inventoryReports.itemCard.allMovementTypes")}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t("inventoryReports.itemCard.cols.costCenter")}</Label>
            <Input
              value={filters.costCenter}
              onChange={e => setFilters(p => ({ ...p, costCenter: e.target.value }))}
              placeholder={t("inventoryReports.itemCard.costCenterPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("inventoryReports.common.from")}</Label>
            <DateField value={filters.from} onChange={e => setFilters(p => ({ ...p, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("inventoryReports.common.to")}</Label>
            <DateField value={filters.to} onChange={e => setFilters(p => ({ ...p, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t("inventoryReports.common.warehouse")}</Label>
            <SearchCombobox
              items={[{ value: "", label: t("inventoryReports.common.allWarehouses") }, ...(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: pickName(w.nameAr, w.nameEn) }))]}
              value={filters.warehouseId}
              onValueChange={v => setFilters(p => ({ ...p, warehouseId: v }))}
              placeholder={t("inventoryReports.common.allWarehouses")}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t("inventoryReports.itemCard.customer")}</Label>
            <SearchCombobox
              items={customerOptions}
              value={filters.customerId}
              onValueChange={v => setFilters(p => ({ ...p, customerId: v }))}
              placeholder={t("inventoryReports.itemCard.allCustomers")}
            />
          </div>
        </div>
        {filters.customerId && (
          <p className="text-xs text-muted-foreground mt-3">
            {t("inventoryReports.itemCard.customerNote")}
          </p>
        )}
        <div className="flex justify-end mt-4">
          <Button size="sm" onClick={() => { setPage(1); setApplied({ ...filters }); }} disabled={!filters.itemId} className="gap-2">
            <Search className="h-3.5 w-3.5" />{t("inventoryReports.itemCard.showCard")}
          </Button>
        </div>
      </div>

      {/* Summary */}
      {applied.itemId && item && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-xl border bg-slate-50 border-slate-200 p-4">
            <p className="text-xs text-slate-700">{t("inventoryReports.itemCard.openingBalance")}</p>
            <p className="text-2xl font-bold text-slate-700 tabular-nums mt-1">{fmtQty(balanceSummary.opening)}</p>
          </div>
          <div className="rounded-xl border bg-green-50 border-green-200 p-4">
            <p className="text-xs text-green-700">{t("inventoryReports.itemCard.totalIn")}</p>
            <p className="text-2xl font-bold text-green-700 tabular-nums mt-1">{fmtQty(totals.in)}</p>
          </div>
          <div className="rounded-xl border bg-red-50 border-red-200 p-4">
            <p className="text-xs text-red-700">{t("inventoryReports.itemCard.totalOut")}</p>
            <p className="text-2xl font-bold text-red-700 tabular-nums mt-1">{fmtQty(totals.out)}</p>
          </div>
          <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
            <p className="text-xs text-muted-foreground">{t("inventoryReports.itemCard.finalBalance")}</p>
            <p className="text-2xl font-bold tabular-nums mt-1">{fmtQty(balanceSummary.final)}</p>
          </div>
        </div>
      )}

      {/* Table */}
      {applied.itemId ? (
        <div className="w-full min-w-0 overflow-hidden rounded-xl shadow-sm">
          {isLoading ? (
            <div className="space-y-2 rounded-xl border bg-card p-4">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          ) : (
            <AdvancedReportGrid
              slug="itemCardGrid"
              cid={cid}
              columns={gridColumns}
              rowKey={(row: any) => row.id}
              rows={augmented}
              paginate={false}
              unitLabel={t("inventoryReports.itemCard.movement", { defaultValue: "حركة" })}
              emptyMessage={t("inventoryReports.itemCard.noMoves")}
              totalsRow={augmented.length > 0 ? {
                __label: t("inventoryReports.itemCard.grandTotal"),
                balanceBefore: fmtQty(balanceSummary.opening),
                qtyIn: fmtQty(totals.in),
                qtyOut: fmtQty(totals.out),
                balanceAfter: fmtQty(balanceSummary.final),
              } : null}
            />
          )}
          {!isLoading && augmented.length > 0 && (
            <TablePagination
              page={page}
              pageSize={pageSize}
              pageCount={ledgerPage.pageCount}
              total={ledgerPage.total}
              onPageChange={setPage}
              onPageSizeChange={(nextSize) => {
                setPageSize(nextSize);
                setPage(1);
              }}
              pageSizeOptions={[10, 25, 50, 100, 1000]}
              className="border-t border-border/80 bg-gradient-to-b from-muted/20 to-muted/40 px-3 py-3"
            />
          )}
        </div>
      ) : (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          <IdCard className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p>{t("inventoryReports.itemCard.emptyState")}</p>
        </div>
      )}
    </div>
  );
}
