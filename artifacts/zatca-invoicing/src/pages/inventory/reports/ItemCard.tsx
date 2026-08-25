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
import { useTranslation } from "react-i18next";
import { DateField } from "@/components/ui/date-field";
import { Link } from "wouter";
import { TablePagination, type PageSize } from "@/components/TablePagination";

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
        <div className="w-full min-w-0 rounded-xl border border-border/80 bg-card overflow-hidden shadow-sm">
          <div className="w-full overflow-x-auto overscroll-x-contain">
            <table className="w-full min-w-[1540px] table-fixed border-separate border-spacing-0 text-xs
              [&_tr>*]:border-e [&_tr>*]:border-border/60 [&_tr>*:last-child]:border-e-0
              [&_tbody_td]:border-t [&_tbody_td]:border-border/50
              [&_tr>*:nth-child(3)]:border-e-2 [&_tr>*:nth-child(3)]:border-e-primary/25
              [&_tr>*:nth-child(9)]:border-e-2 [&_tr>*:nth-child(9)]:border-e-primary/25
              [&_tr>*:nth-child(15)]:border-e-2 [&_tr>*:nth-child(15)]:border-e-primary/25">
              <colgroup>
                <col className="w-[82px]" />
                <col className="w-[86px]" />
                <col className="w-[100px]" />
                <col className="w-[94px]" />
                <col className="w-[94px]" />
                <col className="w-[94px]" />
                <col className="w-[68px]" />
                <col className="w-[86px]" />
                <col className="w-[86px]" />
                <col className="w-[82px]" />
                <col className="w-[66px]" />
                <col className="w-[66px]" />
                <col className="w-[82px]" />
                <col className="w-[76px]" />
                <col className="w-[82px]" />
                <col className="w-[82px]" />
                <col className="w-[84px]" />
                <col className="w-[126px]" />
                <col className="w-[170px]" />
              </colgroup>
              <thead className="bg-muted/70">
                <tr>
                  <th className="px-2 py-3 text-start font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.date")}</th>
                  <th className="px-2 py-3 text-start font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.txType")}</th>
                  <th className="px-2 py-3 text-start font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.documentNumber")}</th>
                  <th className="px-2 py-3 text-start font-semibold leading-4 text-foreground/70">{t("inventoryReports.common.warehouse")}</th>
                  <th className="px-2 py-3 text-start font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.sourceWarehouse")}</th>
                  <th className="px-2 py-3 text-start font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.targetWarehouse")}</th>
                  <th className="px-2 py-3 text-start font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.unit")}</th>
                  <th className="px-2 py-3 text-start font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.costCenter")}</th>
                  <th className="px-2 py-3 text-start font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.project")}</th>
                  <th className="px-2 py-3 text-center font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.balanceBefore")}</th>
                  <th className="px-2 py-3 text-center font-semibold leading-4 text-green-700">{t("inventoryReports.itemCard.cols.qtyIn")}</th>
                  <th className="px-2 py-3 text-center font-semibold leading-4 text-red-700">{t("inventoryReports.itemCard.cols.qtyOut")}</th>
                  <th className="px-2 py-3 text-center font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.balanceAfter")}</th>
                  <th className="px-2 py-3 text-center font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.costPrice")}</th>
                  <th className="px-2 py-3 text-center font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.totalCost")}</th>
                  <th className="px-2 py-3 text-start font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.batchNumber")}</th>
                  <th className="px-2 py-3 text-start font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.expiryDate")}</th>
                  <th className="px-2 py-3 text-start font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.createdAt")}</th>
                  <th className="px-2 py-3 text-start font-semibold leading-4 text-foreground/70">{t("inventoryReports.itemCard.cols.notes")}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading
                  ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={19} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                  : augmented.length === 0
                  ? <tr><td colSpan={19} className="py-12 text-center text-muted-foreground"><IdCard className="h-8 w-8 mx-auto mb-2 opacity-30" />{t("inventoryReports.itemCard.noMoves")}</td></tr>
                  : augmented.map((r: any) => (
                      <tr key={r.id} className="border-t border-border/60 even:bg-muted/10 hover:bg-primary/[0.045] transition-colors">
                        <td className="px-4 py-3 tabular-nums text-xs text-muted-foreground">{r.txDate}</td>
                        <td className="px-4 py-3 text-xs">{txLabel(r.txType)}</td>
                        <td className="px-4 py-3 text-xs" dir="ltr">
                          {r.documentNumber && r.documentPath ? (
                            <Link
                              href={r.documentPath}
                              className="font-semibold text-primary underline underline-offset-4 hover:text-primary/80"
                            >
                              {r.documentNumber}
                            </Link>
                          ) : "—"}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{pickName(r.warehouse?.nameAr, r.warehouse?.nameEn) || "—"}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{pickName(r.sourceWarehouse?.nameAr, r.sourceWarehouse?.nameEn) || "—"}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{pickName(r.targetWarehouse?.nameAr, r.targetWarehouse?.nameEn) || "—"}</td>
                        <td className="px-4 py-3 text-xs">{pickName(r.unit?.nameAr, r.unit?.nameEn) || r.unit?.code || "—"}</td>
                        <td className="px-4 py-3 text-xs">{r.costCenter || "—"}</td>
                        <td className="px-4 py-3 text-xs">{r.project?.nameAr ?? r.project?.nameEn ?? r.project ?? "—"}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm font-semibold">{fmtQty(r.balanceBefore)}</td>
                        <td className={cn("px-4 py-3 text-center tabular-nums text-sm font-bold", r.qtyIn ? "text-green-600" : "text-muted-foreground/30")}>
                          {r.qtyIn ? fmtQty(r.qtyIn) : "—"}
                        </td>
                        <td className={cn("px-4 py-3 text-center tabular-nums text-sm font-bold", r.qtyOut ? "text-red-600" : "text-muted-foreground/30")}>
                          {r.qtyOut ? fmtQty(r.qtyOut) : "—"}
                        </td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm font-bold">{fmtQty(r.balanceAfter)}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-xs">{fmt(r.costPrice)}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-xs">{fmt(r.totalCost)}</td>
                        <td className="px-4 py-3 text-xs">{r.batchNumber || "—"}</td>
                        <td className="px-4 py-3 text-xs tabular-nums">{r.expiryDate || "—"}</td>
                        <td className="px-4 py-3 text-xs tabular-nums">{r.createdAt ? new Date(r.createdAt).toLocaleString(isRtl ? "ar-SA" : "en-US") : "—"}</td>
                        <td className="px-4 py-3 text-xs max-w-72 whitespace-normal">{r.movementNotes || "—"}</td>
                      </tr>
                    ))}
              </tbody>
              {!isLoading && augmented.length > 0 && (
                <tfoot className="bg-muted/30 border-t">
                  <tr>
                    <td colSpan={9} className="px-4 py-3 text-xs font-semibold text-muted-foreground">{t("inventoryReports.itemCard.grandTotal")}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums">{fmtQty(balanceSummary.opening)}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums text-green-700">{fmtQty(totals.in)}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums text-red-700">{fmtQty(totals.out)}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums">{fmtQty(balanceSummary.final)}</td>
                    <td colSpan={6}></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
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
