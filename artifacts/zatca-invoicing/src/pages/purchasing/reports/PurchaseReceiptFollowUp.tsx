import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  Boxes,
  Check,
  ClipboardList,
  Download,
  PackageCheck,
  Search,
  Truck,
} from "lucide-react";
import {
  getGetPurchaseReceiptFollowUpQueryKey,
  useGetPurchaseReceiptFollowUp,
  type GetPurchaseReceiptFollowUpParams,
  type PurchaseReceiptFollowUpRow,
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { useFmt } from "@/hooks/use-fmt";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import BranchFilter from "@/components/BranchFilter";
import ExportButtons from "@/components/ExportButtons";
import { cn } from "@/lib/utils";

type ReceiptState = "open" | "partial" | "received" | "over";
type FilterState = "all" | ReceiptState;
type SortKey =
  | "orderNumber"
  | "orderDate"
  | "supplier"
  | "item"
  | "orderedQuantity"
  | "receivedQuantity"
  | "remainingQuantity"
  | "receiptCount";

function receiptState(row: PurchaseReceiptFollowUpRow): ReceiptState {
  if (row.overReceivedQuantity > 0) return "over";
  if (row.remainingQuantity <= 0) return "received";
  if (row.receivedQuantity > 0) return "partial";
  return "open";
}

export default function PurchaseReceiptFollowUp() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { fmtQty, fmtTrim } = useFmt();
  const isRtl = i18n.language?.startsWith("ar") ?? false;
  const isAr = isRtl;
  const copy = (en: string, ar: string) => (isAr ? ar : en);
  const [search, setSearch] = useState("");
  const [branchId, setBranchId] = useState<number | undefined>();
  const [filter, setFilter] = useState<FilterState>("all");
  const [sortKey, setSortKey] = useState<SortKey>("orderDate");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  const companyId =
    user?.role === "superadmin" ? undefined : user?.company?.id ?? user?.companyId ?? undefined;
  const params = useMemo<GetPurchaseReceiptFollowUpParams>(
    () => ({
      ...(companyId ? { companyId } : {}),
      ...(branchId ? { branchId } : {}),
    }),
    [companyId, branchId],
  );
  const reportQuery = useGetPurchaseReceiptFollowUp(params, {
    query: { queryKey: getGetPurchaseReceiptFollowUpQueryKey(params) },
  });
  const report = reportQuery.data;
  const rows = report?.rows ?? [];

  const filteredRows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    const matched = rows.filter((row) => {
      const state = receiptState(row);
      const supplier = `${row.supplierNameAr ?? ""} ${row.supplierNameEn ?? ""}`;
      const haystack = [
        row.orderNumber ?? "",
        row.orderDate,
        supplier,
        row.itemName,
        row.itemCode ?? "",
        row.itemId ?? "",
      ].join(" ").toLocaleLowerCase();
      return (!term || haystack.includes(term)) && (filter === "all" || state === filter);
    });
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...matched].sort((a, b) => {
      let left: string | number;
      let right: string | number;
      switch (sortKey) {
        case "orderNumber":
          left = a.orderNumber ?? "";
          right = b.orderNumber ?? "";
          break;
        case "supplier":
          left = (isAr ? a.supplierNameAr ?? a.supplierNameEn : a.supplierNameEn ?? a.supplierNameAr) ?? "";
          right = (isAr ? b.supplierNameAr ?? b.supplierNameEn : b.supplierNameEn ?? b.supplierNameAr) ?? "";
          break;
        case "item":
          left = a.itemName;
          right = b.itemName;
          break;
        case "orderDate":
          left = new Date(a.orderDate).getTime() || 0;
          right = new Date(b.orderDate).getTime() || 0;
          break;
        default:
          left = Number(a[sortKey] ?? 0);
          right = Number(b[sortKey] ?? 0);
      }
      if (typeof left === "string" && typeof right === "string") {
        return left.localeCompare(right, isAr ? "ar" : "en", { numeric: true }) * direction;
      }
      return ((Number(left) || 0) - (Number(right) || 0)) * direction;
    });
  }, [rows, search, filter, sortKey, sortDirection, isAr]);

  const quantity = (value: number) => {
    const cleaned = fmtTrim(value);
    return cleaned === "0" ? fmtQty(0) : cleaned;
  };
  const dateLabel = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(isAr ? "ar-SA-u-nu-latn" : "en-GB", {
          year: "numeric",
          month: "short",
          day: "2-digit",
        }).format(date);
  };
  const supplierLabel = (row: PurchaseReceiptFollowUpRow) =>
    (isAr ? row.supplierNameAr ?? row.supplierNameEn : row.supplierNameEn ?? row.supplierNameAr) ??
    copy("Supplier not recorded", "لم يسجل المورد");
  const stateLabel = (state: ReceiptState) =>
    ({
      open: copy("Not received", "لم يستلم"),
      partial: copy("Partially received", "مستلم جزئياً"),
      received: copy("Fully received", "مستلم بالكامل"),
      over: copy("Over-received", "استلام زائد"),
    })[state];

  const exportColumns = [
    { key: "orderNumber", header: copy("Purchase order", "أمر الشراء"), width: 18 },
    { key: "orderDate", header: copy("Order date", "تاريخ الأمر"), width: 15 },
    { key: "supplier", header: copy("Supplier", "المورد"), width: 28 },
    { key: "status", header: copy("Order status", "حالة الأمر"), width: 16 },
    { key: "itemCode", header: copy("Item code", "رمز الصنف"), width: 15 },
    { key: "item", header: copy("Item", "الصنف"), width: 30 },
    { key: "ordered", header: copy("Ordered", "الكمية المطلوبة"), width: 14 },
    { key: "received", header: copy("Received", "الكمية المستلمة"), width: 14 },
    { key: "remaining", header: copy("Remaining", "المتبقي"), width: 14 },
    { key: "overReceived", header: copy("Over-received", "الزيادة المستلمة"), width: 14 },
    { key: "receipts", header: copy("Receipts", "إيصالات الاستلام"), width: 12 },
  ];
  const exportRows = filteredRows.map((row) => ({
    orderNumber: row.orderNumber ?? "—",
    orderDate: dateLabel(row.orderDate),
    supplier: supplierLabel(row),
    status: row.status === "confirmed" ? copy("Confirmed", "مؤكد") : copy("Converted", "محول"),
    itemCode: row.itemCode ?? "—",
    item: row.itemName,
    ordered: quantity(row.orderedQuantity),
    received: quantity(row.receivedQuantity),
    remaining: quantity(row.remainingQuantity),
    overReceived: quantity(row.overReceivedQuantity),
    receipts: row.receiptCount,
  }));

  const setSort = (key: SortKey) => {
    if (sortKey === key) setSortDirection((current) => current === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDirection(key === "orderDate" ? "desc" : "asc");
    }
  };
  const sortIcon = (key: SortKey) => sortKey !== key
    ? <ArrowDownUp className="h-3 w-3 opacity-40" aria-hidden="true" />
    : sortDirection === "asc"
      ? <ArrowUp className="h-3 w-3" aria-hidden="true" />
      : <ArrowDown className="h-3 w-3" aria-hidden="true" />;
  const sortButton = (key: SortKey, label: string, align: "left" | "right" | "center" = "left") => (
    <button
      type="button"
      onClick={() => setSort(key)}
      data-testid={`sort-${key}`}
      aria-label={copy(`Sort by ${label}`, `ترتيب حسب ${label}`)}
      className={cn(
        "inline-flex items-center gap-1.5 font-semibold text-muted-foreground hover:text-foreground transition-colors",
        align === "center" && "justify-center",
        align === "right" && "justify-end",
      )}
    >
      {label}{sortIcon(key)}
    </button>
  );

  const stateClass = (state: ReceiptState) => ({
    open: "border-amber-200 bg-amber-50 text-amber-800",
    partial: "border-sky-200 bg-sky-50 text-sky-800",
    received: "border-emerald-200 bg-emerald-50 text-emerald-800",
    over: "border-rose-200 bg-rose-50 text-rose-800",
  })[state];

  return (
    <main className="space-y-5 pb-8" dir={isRtl ? "rtl" : "ltr"}>
      <header className="flex flex-col gap-4 border-b border-border/70 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.13em] text-primary">
            <span className="h-px w-6 bg-primary/60" />
            {copy("PURCHASING · CONTROL REPORT", "المشتريات · تقرير رقابي")}
          </div>
          <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight text-foreground sm:text-[28px]">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/8 text-primary">
              <Truck className="h-5 w-5" />
            </span>
            {copy("Purchase receipt follow-up", "متابعة استلام المشتريات")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            {copy(
              "Track confirmed and converted orders against received goods, line by line.",
              "تابع أوامر الشراء المؤكدة والمحوّلة مقابل البضائع المستلمة، بنداً بنداً.",
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {report?.generatedAt && (
            <div className="hidden text-end text-[11px] leading-5 text-muted-foreground md:block">
              <span className="block">{copy("Report generated", "وقت إنشاء التقرير")}</span>
              <time data-testid="value-generated-at" dateTime={report.generatedAt} className="font-mono tabular-nums">
                {dateLabel(report.generatedAt)}
              </time>
            </div>
          )}
          <ExportButtons
            rows={exportRows}
            columns={exportColumns}
            filename={`purchase-receipt-follow-up-${new Date().toISOString().slice(0, 10)}`}
            title={copy("Purchase receipt follow-up", "متابعة استلام المشتريات")}
            subtitle={copy(
              `${filteredRows.length} matching lines`,
              `${filteredRows.length} بند مطابق`,
            )}
            disabled={reportQuery.isLoading || filteredRows.length === 0}
            label={copy("Export", "تصدير")}
            size="sm"
          />
        </div>
      </header>

      <section aria-label={copy("Report summary", "ملخص التقرير")} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          {
            label: copy("Purchase orders", "أوامر الشراء"),
            value: report?.orderCount,
            icon: ClipboardList,
            accent: "text-primary bg-primary/8 border-primary/15",
            testId: "value-order-count",
          },
          {
            label: copy("Open lines", "البنود المفتوحة"),
            value: report?.openLineCount,
            icon: Boxes,
            accent: "text-amber-700 bg-amber-50 border-amber-200",
            testId: "value-open-line-count",
          },
          {
            label: copy("Fully received", "بنود مستلمة بالكامل"),
            value: report?.fullyReceivedLineCount,
            icon: PackageCheck,
            accent: "text-emerald-700 bg-emerald-50 border-emerald-200",
            testId: "value-fully-received-line-count",
          },
          {
            label: copy("Visible lines", "البنود المعروضة"),
            value: report ? rows.length : undefined,
            icon: Download,
            accent: "text-slate-700 bg-slate-100/70 border-slate-200",
            testId: "value-row-count",
          },
        ].map((metric) => (
          <div key={metric.testId} className="relative overflow-hidden rounded-lg border bg-card px-4 py-3.5">
            <span className="absolute inset-y-0 start-0 w-[3px] bg-current opacity-20" />
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs font-medium text-muted-foreground">{metric.label}</p>
                {reportQuery.isLoading ? (
                  <Skeleton className="mt-2 h-7 w-16" />
                ) : (
                  <p data-testid={metric.testId} className="mt-1 font-mono text-2xl font-semibold tabular-nums tracking-tight">
                    {metric.value?.toLocaleString(isAr ? "ar-SA-u-nu-latn" : "en-US") ?? "—"}
                  </p>
                )}
              </div>
              <span className={cn("flex h-8 w-8 items-center justify-center rounded-md border", metric.accent)}>
                <metric.icon className="h-4 w-4" />
              </span>
            </div>
          </div>
        ))}
      </section>

      <section className="rounded-lg border bg-card p-3.5 sm:p-4" aria-label={copy("Report filters", "عوامل تصفية التقرير")}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(220px,1fr)_minmax(180px,230px)_minmax(170px,220px)] sm:items-end">
          <div className="space-y-1.5">
            <label htmlFor="receipt-follow-up-search" className="text-xs font-semibold text-muted-foreground">
              {copy("Find an order, supplier or item", "ابحث عن أمر أو مورد أو صنف")}
            </label>
            <div className="relative">
              <Search className={cn("absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground", isRtl ? "right-3" : "left-3")} />
              <Input
                id="receipt-follow-up-search"
                data-testid="input-report-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={copy("Order no., supplier, item code…", "رقم الأمر، المورد، رمز الصنف…")}
                className={cn("h-9 bg-background", isRtl ? "pr-9" : "pl-9")}
              />
            </div>
          </div>
          <div data-testid="filter-branch">
            <BranchFilter
              value={branchId}
              onChange={setBranchId}
              className="[&_button]:bg-background"
              showLabel
              size="md"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="receipt-follow-up-state" className="text-xs font-semibold text-muted-foreground">
              {copy("Receipt status", "حالة الاستلام")}
            </label>
            <select
              id="receipt-follow-up-state"
              data-testid="select-receipt-status"
              value={filter}
              onChange={(event) => setFilter(event.target.value as FilterState)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="all">{copy("All lines", "كل البنود")}</option>
              <option value="open">{copy("Not received", "لم يستلم")}</option>
              <option value="partial">{copy("Partially received", "مستلم جزئياً")}</option>
              <option value="received">{copy("Fully received", "مستلم بالكامل")}</option>
              <option value="over">{copy("Over-received", "استلام زائد")}</option>
            </select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
          <span data-testid="text-filtered-count">
            {copy("Showing", "المعروض")}{" "}
            <strong className="font-mono font-semibold text-foreground">{filteredRows.length}</strong>{" "}
            {copy("of", "من")}{" "}
            <strong className="font-mono font-semibold text-foreground">{rows.length}</strong>{" "}
            {copy("lines", "بند")}
          </span>
          {search || filter !== "all" || branchId !== undefined ? (
            <button
              type="button"
              data-testid="button-clear-filters"
              className="font-semibold text-primary underline-offset-4 hover:underline"
              onClick={() => {
                setSearch("");
                setFilter("all");
                setBranchId(undefined);
              }}
            >
              {copy("Clear filters", "مسح عوامل التصفية")}
            </button>
          ) : (
            <span>{copy("Source: purchase orders and goods receipts", "المصدر: أوامر الشراء وإيصالات الاستلام")}</span>
          )}
        </div>
      </section>

      {reportQuery.isError ? (
        <section role="alert" data-testid="state-report-error" className="flex flex-col items-center rounded-lg border border-rose-200 bg-rose-50/70 px-5 py-10 text-center">
          <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-rose-100 text-rose-700">
            <AlertCircle className="h-5 w-5" />
          </span>
          <h2 className="font-semibold text-rose-950">{copy("The report could not be loaded", "تعذر تحميل التقرير")}</h2>
          <p className="mt-1 max-w-md text-sm text-rose-800/80">
            {copy("Check your connection and try again. No report data has been changed.", "تحقق من الاتصال ثم أعد المحاولة. لم يتم تغيير بيانات التقرير.")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="button-retry-report"
            onClick={() => void reportQuery.refetch()}
            className="mt-4 border-rose-300 bg-transparent text-rose-900 hover:bg-rose-100"
          >
            {copy("Try again", "إعادة المحاولة")}
          </Button>
        </section>
      ) : (
        <section className="overflow-hidden rounded-lg border bg-card" aria-label={copy("Purchase receipt follow-up rows", "بنود متابعة استلام المشتريات")}>
          <div className="flex items-center justify-between gap-3 border-b bg-muted/35 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md border border-primary/15 bg-primary/8 text-primary">
                <ClipboardList className="h-3.5 w-3.5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold">{copy("Order lines", "بنود أوامر الشراء")}</h2>
                <p className="text-[11px] text-muted-foreground">{copy("Receipt coverage by item", "تغطية الاستلام حسب الصنف")}</p>
              </div>
            </div>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {filteredRows.length.toLocaleString(isAr ? "ar-SA-u-nu-latn" : "en-US")} {copy("rows", "صف")}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1120px] border-collapse text-sm">
              <thead className="border-b bg-muted/20 text-[11px]">
                <tr>
                  <th className={cn("whitespace-nowrap px-4 py-3", isRtl ? "text-right" : "text-left")}>{sortButton("orderNumber", copy("Purchase order", "أمر الشراء"))}</th>
                  <th className={cn("whitespace-nowrap px-3 py-3", isRtl ? "text-right" : "text-left")}>{sortButton("orderDate", copy("Order date", "التاريخ"))}</th>
                  <th className={cn("whitespace-nowrap px-3 py-3", isRtl ? "text-right" : "text-left")}>{sortButton("supplier", copy("Supplier", "المورد"))}</th>
                  <th className={cn("whitespace-nowrap px-3 py-3", isRtl ? "text-right" : "text-left")}>{copy("Order state", "حالة الأمر")}</th>
                  <th className={cn("whitespace-nowrap px-3 py-3", isRtl ? "text-right" : "text-left")}>{sortButton("item", copy("Item", "الصنف"))}</th>
                  <th className="whitespace-nowrap px-3 py-3 text-center">{sortButton("orderedQuantity", copy("Ordered", "مطلوب"), "center")}</th>
                  <th className="whitespace-nowrap px-3 py-3 text-center">{sortButton("receivedQuantity", copy("Received", "مستلم"), "center")}</th>
                  <th className="whitespace-nowrap px-3 py-3 text-center">{sortButton("remainingQuantity", copy("Remaining", "متبقي"), "center")}</th>
                  <th className="whitespace-nowrap px-3 py-3 text-center">{copy("Over", "زيادة")}</th>
                  <th className="whitespace-nowrap px-4 py-3 text-center">{sortButton("receiptCount", copy("Receipts", "إيصالات"), "center")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {reportQuery.isLoading ? (
                  Array.from({ length: 7 }, (_, index) => (
                    <tr key={index} data-testid={`skeleton-report-row-${index}`}>
                      {Array.from({ length: 10 }, (_, cell) => (
                        <td key={cell} className="px-3 py-3.5"><Skeleton className={cn("h-4", cell === 2 || cell === 4 ? "w-36" : "w-16")} /></td>
                      ))}
                    </tr>
                  ))
                ) : filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-14 text-center" data-testid="state-report-empty">
                      <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border bg-muted/50 text-muted-foreground">
                        <Search className="h-4 w-4" />
                      </span>
                      <p className="font-semibold text-foreground">
                        {rows.length === 0 ? copy("No purchase order lines to follow up", "لا توجد بنود أوامر شراء للمتابعة") : copy("No lines match these filters", "لا توجد بنود تطابق عوامل التصفية")}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {rows.length === 0
                          ? copy("Confirmed or converted orders will appear here when available.", "ستظهر هنا أوامر الشراء المؤكدة أو المحوّلة عند توفرها.")
                          : copy("Try another search term or clear the selected filters.", "جرّب عبارة بحث أخرى أو امسح عوامل التصفية المحددة.")}
                      </p>
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row, index) => {
                    const state = receiptState(row);
                    return (
                      <tr
                        key={`${row.purchaseOrderId}-${row.itemKey}-${index}`}
                        data-testid={`row-receipt-follow-up-${row.purchaseOrderId}-${index}`}
                        className="group transition-colors hover:bg-primary/[0.035]"
                      >
                        <td className="whitespace-nowrap px-4 py-3">
                          <span data-testid={`value-order-number-${row.purchaseOrderId}-${index}`} className="font-mono text-xs font-semibold text-primary">
                            {row.orderNumber ?? `#${row.purchaseOrderId}`}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 font-mono text-xs tabular-nums text-muted-foreground" data-testid={`value-order-date-${row.purchaseOrderId}-${index}`}>
                          {dateLabel(row.orderDate)}
                        </td>
                        <td className="max-w-[190px] px-3 py-3">
                          <span data-testid={`value-supplier-${row.purchaseOrderId}-${index}`} className="block truncate font-medium" title={supplierLabel(row)}>
                            {supplierLabel(row)}
                          </span>
                          {row.supplierId != null && (
                            <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">ID {row.supplierId}</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3">
                          <span className={cn(
                            "inline-flex rounded border px-2 py-0.5 text-[10px] font-semibold",
                            row.status === "confirmed" ? "border-sky-200 bg-sky-50 text-sky-800" : "border-violet-200 bg-violet-50 text-violet-800",
                          )} data-testid={`status-order-${row.purchaseOrderId}-${index}`}>
                            {row.status === "confirmed" ? copy("Confirmed", "مؤكد") : copy("Converted", "محول")}
                          </span>
                        </td>
                        <td className="max-w-[230px] px-3 py-3">
                          <span data-testid={`value-item-${row.purchaseOrderId}-${index}`} className="block truncate font-medium" title={row.itemName}>{row.itemName}</span>
                          <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                            {row.itemCode ?? (row.itemId != null ? `ID ${row.itemId}` : row.itemKey)}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-center">
                          <span data-testid={`value-ordered-${row.purchaseOrderId}-${index}`} className="font-mono text-xs tabular-nums">{quantity(row.orderedQuantity)}</span>
                          {row.unit && <span className="ms-1 text-[10px] text-muted-foreground">{row.unit}</span>}
                        </td>
                        <td className="px-3 py-3 text-center">
                          <span data-testid={`value-received-${row.purchaseOrderId}-${index}`} className="font-mono text-xs font-medium tabular-nums">{quantity(row.receivedQuantity)}</span>
                        </td>
                        <td className="px-3 py-3 text-center">
                          <span data-testid={`value-remaining-${row.purchaseOrderId}-${index}`} className={cn("font-mono text-xs font-semibold tabular-nums", row.remainingQuantity > 0 ? "text-amber-800" : "text-emerald-700")}>
                            {quantity(row.remainingQuantity)}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-center">
                          {row.overReceivedQuantity > 0 ? (
                            <span data-testid={`status-over-received-${row.purchaseOrderId}-${index}`} className="inline-flex rounded border border-rose-200 bg-rose-50 px-2 py-0.5 font-mono text-[11px] font-bold tabular-nums text-rose-800">
                              +{quantity(row.overReceivedQuantity)}
                            </span>
                          ) : <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <div className="flex flex-col items-center gap-1">
                            <span data-testid={`value-receipt-count-${row.purchaseOrderId}-${index}`} className="font-mono text-xs tabular-nums">{row.receiptCount}</span>
                            <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-semibold", stateClass(state))} data-testid={`status-receipt-${row.purchaseOrderId}-${index}`}>
                              {state === "received" ? <Check className="h-2.5 w-2.5" /> : null}
                              {stateLabel(state)}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-4 py-2.5 text-[11px] text-muted-foreground">
            <span>{copy("Quantities use the configured company precision.", "تعرض الكميات بدقة الشركة المحددة.")}</span>
            <span className="font-mono tabular-nums">
              {report?.generatedAt ? copy("Updated", "آخر تحديث") + " · " + dateLabel(report.generatedAt) : copy("Live report", "تقرير مباشر")}
            </span>
          </footer>
        </section>
      )}
    </main>
  );
}
