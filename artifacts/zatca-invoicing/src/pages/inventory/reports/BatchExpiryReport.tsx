import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Layers3, Search, RotateCcw } from "lucide-react";
import { inventoryApi, type BatchRow } from "@/lib/inventoryApi";
import { useAuth } from "@/contexts/AuthContext";
import { useFmt } from "@/hooks/use-fmt";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type Filters = {
  itemId: string; warehouseId: string; batch: string; expiryFrom: string;
  expiryTo: string; status: string; nearDays: string; search: string; onHandOnly: "true" | "false";
};
const defaultFilters = (expiry: boolean): Filters => ({
  itemId: "", warehouseId: "", batch: "", expiryFrom: "", expiryTo: "",
  status: expiry ? "expiring_soon" : "", nearDays: "30", search: "",
  onHandOnly: expiry ? "true" : "false",
});

export default function BatchExpiryReport() {
  const [location] = useLocation();
  const expiry = location.endsWith("/expiry");
  const { user, actingCompanyId } = useAuth();
  const cid = user?.role === "superadmin" ? actingCompanyId : (user?.company?.id ?? user?.companyId);
  return <BatchExpiryReportContent key={`${expiry ? "expiry" : "batches"}-${user?.id ?? "none"}-${cid ?? "none"}`} expiry={expiry} />;
}

function BatchExpiryReportContent({ expiry }: { expiry: boolean }) {
  const { i18n } = useTranslation();
  const ar = i18n.language === "ar";
  const label = (arabic: string, english: string) => ar ? arabic : english;
  const { user, actingCompanyId } = useAuth();
  const cid = user?.role === "superadmin" ? actingCompanyId : (user?.company?.id ?? user?.companyId);
  const { fmtQty } = useFmt();
  const [filters, setFilters] = useState<Filters>(() => defaultFilters(expiry));
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<BatchRow | null>(null);
  const [detailPage, setDetailPage] = useState(1);
  const update = (name: keyof Filters, value: string) => { setFilters(prev => ({ ...prev, [name]: value } as Filters)); setPage(1); setSelected(null); };
  const itemsQuery = useQuery({ queryKey: ["items", user?.id, cid], queryFn: () => inventoryApi.getItems(cid!), enabled: !!cid });
  const warehousesQuery = useQuery({ queryKey: ["warehouses", user?.id, cid], queryFn: () => inventoryApi.getWarehouses(cid!), enabled: !!cid });
  const items = itemsQuery.data ?? [];
  const warehouses = warehousesQuery.data ?? [];
  // Report and item detail consume the same server-side batch ledger aggregation.
  const query = useQuery({
    queryKey: ["inventory-batches-report", user?.id, cid, expiry, filters, page],
    queryFn: () => inventoryApi.getBatchReport({
      ...Object.fromEntries(Object.entries(filters).filter(([key, value]) => key !== "search" && value !== "")),
      page, pageSize: 25,
    }),
    enabled: !!cid,
  });
  // Search is explicitly limited to this page; server-side batch/item/warehouse filters apply across all pages.
  const rows = (query.data?.rows ?? []).filter(row => !filters.search || [
    row.item?.nameAr, row.item?.nameEn, row.item?.code, row.batchNumber, row.warehouse?.nameAr, row.warehouse?.nameEn,
  ].some(value => value?.toLowerCase().includes(filters.search.toLowerCase())));
  const detail = useQuery({
    queryKey: ["inventory-batch-movements", user?.id, cid, selected?.itemId, selected?.warehouseId, selected?.batchNumber, selected?.expiryDate, detailPage],
    queryFn: () => inventoryApi.getBatchMovements({
      itemId: selected!.itemId, warehouseId: selected!.warehouseId,
      batch: selected!.batchNumber ?? "__unattributed__",
      expiryDate: selected!.expiryDate ?? "__no_expiry__",
      page: detailPage, pageSize: 25,
    }),
    enabled: !!cid && selected !== null,
  });
  const statusLabel = (status: string) => ({
    expired: label("منتهية", "Expired"),
    expiring_soon: label("قريبة الانتهاء", "Expiring soon"),
    active: label("صالحة", "Active"),
    no_expiry: label("بلا تاريخ انتهاء", "No expiry"),
  }[status] ?? status);

  return <div className="space-y-5" dir={ar ? "rtl" : "ltr"}>
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          {expiry ? <CalendarClock className="text-amber-600" /> : <Layers3 className="text-cyan-600" />}
          {expiry ? label("تقرير انتهاء الصلاحية", "Expiry report") : label("تقرير الدفعات", "Batches report")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{label("الرصيد حسب حركات المخزون المنسوبة للدفعات. الرصيد غير المنسوب يظهر منفصلاً بتاريخ انتهاء غير معروف.", "Balances reflect movements attributed to batches. Unattributed stock is listed separately with unknown expiry.")}</p>
      </div>
      <nav className="flex gap-2" aria-label={label("تقارير الدفعات", "Batch reports")}>
        <Link href="/inventory/reports/batches" data-testid="link-batches-report" className="text-sm underline">{label("الدفعات", "Batches")}</Link>
        <Link href="/inventory/reports/expiry" data-testid="link-expiry-report" className="text-sm underline">{label("انتهاء الصلاحية", "Expiry")}</Link>
      </nav>
    </header>
    {query.data && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label={label("ملخص التقرير", "Report summary")}>
      {([
        [label("المستلم", "Received"), fmtQty(query.data.summary.totalReceivedQty)],
        [label("المصروف", "Issued"), fmtQty(query.data.summary.totalIssuedQty)],
        [label("المتبقي", "Remaining"), fmtQty(query.data.summary.totalRemainingQty)],
        [label("منتهية / قريبة الانتهاء", "Expired / expiring soon"), `${query.data.summary.expiredCount} / ${query.data.summary.expiringSoonCount}`],
      ] as const).map(([name, value], i) => <div key={name} className="rounded-xl border bg-card p-3"><p className="text-xs text-muted-foreground">{name}</p><p data-testid={`text-batch-summary-${i}`} className="font-bold text-lg tabular-nums">{value}</p></div>)}
    </div>}
    <section className="rounded-xl border bg-card p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3" aria-label={label("مرشحات التقرير", "Report filters")}>
      <label className="text-sm space-y-1">{label("الصنف", "Item")}
        <select data-testid="select-batch-item" className="w-full h-10 rounded-md border bg-background px-2" value={filters.itemId} onChange={e => update("itemId", e.target.value)}>
          <option value="">{label("كل الأصناف", "All items")}</option>
          {(items as any[]).map((item: any) => <option key={item.id} value={item.id}>{ar ? item.nameAr : item.nameEn || item.nameAr} ({item.code})</option>)}
        </select>
      </label>
      <label className="text-sm space-y-1">{label("المستودع", "Warehouse")}
        <select data-testid="select-batch-warehouse" className="w-full h-10 rounded-md border bg-background px-2" value={filters.warehouseId} onChange={e => update("warehouseId", e.target.value)}>
          <option value="">{label("كل المستودعات", "All warehouses")}</option>
          {(warehouses as any[]).map((wh: any) => <option key={wh.id} value={wh.id}>{ar ? wh.nameAr : wh.nameEn || wh.nameAr}</option>)}
        </select>
      </label>
      <label className="text-sm space-y-1">{label("رقم الدفعة", "Batch number")}
        <Input data-testid="input-batch-number" value={filters.batch} onChange={e => update("batch", e.target.value)} />
      </label>
      <label className="text-sm space-y-1">{label("رصيد غير منسوب", "Unattributed stock")}
        <select data-testid="select-unattributed-batch" className="w-full h-10 rounded-md border bg-background px-2" value={filters.batch === "__unattributed__" ? "yes" : "no"} onChange={e => update("batch", e.target.value === "yes" ? "__unattributed__" : "")}>
          <option value="no">{label("كل الدفعات", "All batches")}</option><option value="yes">{label("غير منسوب فقط", "Unattributed only")}</option>
        </select>
      </label>
      <label className="text-sm space-y-1">{label("الحالة", "Status")}
        <select data-testid="select-batch-status" className="w-full h-10 rounded-md border bg-background px-2" value={filters.status} onChange={e => update("status", e.target.value)}>
          <option value="">{label("كل الحالات", "All statuses")}</option>
          {["expired", "expiring_soon", "active", "no_expiry"].map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm self-end min-h-10">
        <input data-testid="checkbox-batches-on-hand" type="checkbox" className="h-4 w-4 accent-primary" checked={filters.onHandOnly === "true"} onChange={e => update("onHandOnly", e.target.checked ? "true" : "false")} />
        {label("المتبقي بالمخزون فقط", "Remaining stock only")}
      </label>
      <label className="text-sm space-y-1">{label("الانتهاء من", "Expiry from")}
        <Input data-testid="input-expiry-from" type="date" value={filters.expiryFrom} onChange={e => update("expiryFrom", e.target.value)} />
      </label>
      <label className="text-sm space-y-1">{label("الانتهاء إلى", "Expiry to")}
        <Input data-testid="input-expiry-to" type="date" value={filters.expiryTo} onChange={e => update("expiryTo", e.target.value)} />
      </label>
      <label className="text-sm space-y-1">{label("قريب الانتهاء خلال (أيام)", "Near expiry (days)")}
        <Input data-testid="input-near-days" type="number" min="0" max="3650" value={filters.nearDays} onChange={e => update("nearDays", e.target.value)} />
      </label>
      <label className="text-sm space-y-1">{label("بحث في الصفحة الحالية", "Search current page")}
        <span className="relative block"><Search className="absolute start-2 top-3 h-4 w-4 text-muted-foreground" /><Input data-testid="input-batch-search" className="ps-8" value={filters.search} onChange={e => update("search", e.target.value)} /></span>
      </label>
      <Button data-testid="button-clear-batch-filters" variant="outline" className="w-fit" onClick={() => { setFilters(defaultFilters(expiry)); setPage(1); setSelected(null); }}><RotateCcw className="h-4 w-4 me-2" />{label("مسح المرشحات", "Clear filters")}</Button>
    </section>
    {(itemsQuery.isError || warehousesQuery.isError) && <p role="alert" className="text-destructive">{label("تعذر تحميل خيارات الأصناف أو المستودعات.", "Unable to load item or warehouse options.")}</p>}
    {!cid ? <p role="alert" data-testid="error-batches-company" className="text-destructive">{label("اختر شركة لعرض التقرير.", "Select a company to view this report.")}</p>
      : query.isLoading ? <div aria-live="polite" className="space-y-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-11 w-full" />)}</div>
      : query.isError ? <p role="alert" data-testid="error-batches-report" className="text-destructive">{label("تعذر تحميل التقرير:", "Could not load report:")} {query.error instanceof Error ? query.error.message : String(query.error)}</p>
      : <section className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm text-start">
          <thead className="bg-muted/50"><tr>{[label("الصنف", "Item"), label("المستودع", "Warehouse"), label("الدفعة", "Batch"), label("الانتهاء", "Expiry"), label("الحالة", "Status"), label("المستلم", "Received"), label("المصروف", "Issued"), label("المتبقي", "Remaining"), label("الحركات", "Movements")].map(h => <th key={h} scope="col" className="p-3 text-start whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody className="divide-y">{rows.map((row, index) => <tr key={`${row.itemId}-${row.warehouseId}-${row.batchNumber}-${row.expiryDate}`} data-testid={`row-batch-${index}`}>
            <td className="p-3">{ar ? row.item?.nameAr : row.item?.nameEn || row.item?.nameAr}<span className="block text-xs text-muted-foreground">{row.item?.code}</span></td>
            <td className="p-3">{ar ? row.warehouse?.nameAr : row.warehouse?.nameEn || row.warehouse?.nameAr}</td>
            <td className="p-3">{row.batchNumber || label("مخزون غير منسوب", "Unattributed stock")}</td>
            <td className="p-3">{row.expiryDate ?? label("انتهاء غير معروف", "Unknown expiry")}</td>
            <td className="p-3">{statusLabel(row.status)}</td>
            <td className="p-3 tabular-nums">{fmtQty(row.receivedQty)}</td>
            <td className="p-3 tabular-nums">{fmtQty(row.issuedQty)}</td>
            <td className="p-3 font-semibold tabular-nums">{fmtQty(row.remainingQty)}</td>
            <td className="p-3"><Button data-testid={`button-batch-movements-${index}`} variant="link" onClick={() => { setDetailPage(1); setSelected(selected === row ? null : row); }}>{label("عرض الحركات", "View movements")}</Button></td>
          </tr>)}</tbody>
        </table>
        {!rows.length && <p data-testid="empty-batches-report" className="p-8 text-center text-muted-foreground">{label("لا توجد دفعات مطابقة للمرشحات.", "No batches match these filters.")}</p>}
      </section>}
    {selected && <section className="rounded-xl border p-4 space-y-3" aria-live="polite">
      <h2 className="font-semibold">{label("حركات الدفعة", "Batch movements")}</h2>
      <p className="text-xs text-muted-foreground">{label("المستلم والمصروف من الحركات المنسوبة فقط؛ رصيد دفتر المخزون الإجمالي للمستودع ليس رصيداً تراكمياً لهذه الدفعة.", "Received and issued reflect attributed movements only. The warehouse-wide ledger balance is not a running balance for this batch.")}</p>
      {detail.isLoading ? <Skeleton className="h-20 w-full" /> : detail.isError
        ? <p role="alert" className="text-destructive">{detail.error instanceof Error ? detail.error.message : String(detail.error)}</p>
        : !detail.data?.rows.length ? <p className="text-muted-foreground">{label("لا توجد حركات منسوبة.", "No attributed movements.")}</p>
        : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{[label("التاريخ", "Date"), label("المصدر", "Source"), label("المستلم", "Received"), label("المصروف", "Issued")].map(h => <th key={h} className="p-2 text-start">{h}</th>)}</tr></thead><tbody>{detail.data.rows.map(m => <tr key={m.id} className="border-t"><td className="p-2">{m.txDate}</td><td className="p-2">{m.txType} {m.refType ?? ""} {m.refId ?? ""}</td><td className="p-2">{fmtQty(m.receivedQty)}</td><td className="p-2">{fmtQty(m.issuedQty)}</td></tr>)}</tbody></table>
          <div className="flex justify-between items-center p-2"><span>{detail.data.total} {label("حركة", "movements")}</span><div className="flex gap-2"><Button data-testid="button-batch-movements-prev" variant="outline" disabled={detailPage <= 1} onClick={() => setDetailPage(detailPage - 1)}>{label("السابق", "Previous")}</Button><Button data-testid="button-batch-movements-next" variant="outline" disabled={detailPage >= detail.data.pageCount} onClick={() => setDetailPage(detailPage + 1)}>{label("التالي", "Next")}</Button></div></div>
        </div>}
    </section>}
    {query.data && <div className="flex justify-between items-center text-sm">
      <span data-testid="text-batches-total">{label("الإجمالي", "Total")}: {query.data.total}</span>
      <div className="flex gap-2 items-center"><Button data-testid="button-batches-prev" variant="outline" disabled={page <= 1} onClick={() => { setPage(page - 1); setSelected(null); }}>{label("السابق", "Previous")}</Button><span>{page} / {query.data.pageCount || 1}</span><Button data-testid="button-batches-next" variant="outline" disabled={page >= query.data.pageCount} onClick={() => { setPage(page + 1); setSelected(null); }}>{label("التالي", "Next")}</Button></div>
    </div>}
  </div>;
}