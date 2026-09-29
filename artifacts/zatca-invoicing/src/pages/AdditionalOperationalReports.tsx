import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays, Check, ChevronDown, FileSearch, Filter, Loader2,
  Search, ShieldCheck, X,
} from "lucide-react";
import * as apiClient from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ADDITIONAL_SALES_REPORTS, ADDITIONAL_PURCHASE_REPORTS } from "@/lib/menuItems";
import AdditionalOperationalReportGrid from "@/components/AdditionalOperationalReportGrid";

type Domain = "sales" | "purchases";
type Report = { id: string; label: string; filters: string[] };
type ReportParams = Record<string, string | number | undefined>;
type ReportResponse = { reportId: string; rows: Record<string, unknown>[]; limitations?: string[] };

const salesReports: Report[] = ADDITIONAL_SALES_REPORTS.map(report => ({
  ...report,
  filters: ({
    sales_by_representative: ["branchId", "salesRepId"],
    sales_discounts: ["branchId", "customerId", "itemId"],
    inactive_customers: ["branchId", "customerId"],
    sales_by_warehouse: ["branchId", "warehouseId", "itemId"],
    invoice_status: ["branchId", "customerId", "status"],
    returns_detail: ["branchId", "customerId", "itemId", "warehouseId"],
  } as Record<string, string[]>)[report.id] ?? [],
}));

const purchaseReports: Report[] = ADDITIONAL_PURCHASE_REPORTS.map(report => ({
  ...report,
  filters: ({
    purchase_analysis: ["branchId", "supplierId", "itemId", "itemGroupId", "warehouseId", "groupBy"],
    purchase_cost_summary: ["branchId", "supplierId", "itemId", "itemGroupId", "warehouseId"],
    purchase_price_history: ["branchId", "supplierId", "itemId", "itemGroupId", "warehouseId"],
    purchase_discounts: ["branchId", "supplierId", "itemId", "itemGroupId"],
    inactive_suppliers: ["branchId", "supplierId"],
    purchases_by_location: ["branchId", "supplierId", "itemId", "itemGroupId", "warehouseId"],
    invoice_status: ["branchId", "supplierId", "status", "paymentType"],
    payment_methods: ["branchId", "supplierId", "paymentType"],
    item_movement: ["branchId", "supplierId", "itemId", "itemGroupId", "warehouseId"],
    returns_detail: ["branchId", "supplierId", "itemId", "warehouseId"],
  } as Record<string, string[]>)[report.id] ?? [],
}));

const filterLabels: Record<string, string> = {
  branchId: "معرّف الفرع",
  customerId: "معرّف العميل",
  supplierId: "معرّف المورد",
  itemId: "معرّف الصنف",
  itemGroupId: "معرّف مجموعة الأصناف",
  salesRepId: "معرّف مندوب المبيعات",
  warehouseId: "معرّف المستودع",
  status: "حالة المستند",
  paymentType: "طريقة الدفع",
  groupBy: "تجميع الفترة",
};

const fieldLabels: Record<string, string> = {
  invoiceId: "رقم داخلي", returnId: "رقم المرتجع", documentNumber: "رقم المستند",
  docNumber: "رقم المستند", invoiceDate: "تاريخ الفاتورة", date: "التاريخ",
  returnDate: "تاريخ المرتجع", customerId: "رقم العميل", customerName: "العميل",
  supplierId: "رقم المورد", supplierName: "المورد", itemId: "رقم الصنف",
  itemName: "الصنف", itemCode: "كود الصنف", itemGroupId: "مجموعة الأصناف",
  branchId: "الفرع", warehouseId: "المستودع", warehouseName: "المستودع",
  salesRepId: "مندوب المبيعات", salesRepName: "مندوب المبيعات", status: "الحالة",
  invoiceStatus: "حالة الفاتورة", paymentType: "طريقة الدفع", value: "القيمة",
  total: "الإجمالي", totalAmount: "إجمالي المستند", totalValue: "إجمالي القيمة",
  invoiceValue: "قيمة الفاتورة", net: "الصافي", gross: "الإجمالي قبل الخصم",
  sales: "المبيعات", returns: "المرتجعات", discounts: "إجمالي الخصومات",
  postedReturns: "المرتجعات المرحلة",
  discount: "الخصم", headerDiscount: "خصم رأس الفاتورة",
  lineDiscount: "خصم السطور", lineDiscountAmount: "خصم السطر",
  lineDiscountPercent: "نسبة خصم السطر", vat: "الضريبة", headerVat: "ضريبة الفاتورة",
  quantity: "الكمية", qty: "الكمية", freeQty: "الكمية المجانية", invoiceCount: "عدد الفواتير",
  customerCount: "عدد العملاء", customers: "عدد العملاء", representative: "مندوب المبيعات",
  recordType: "نوع الخصم", lineGross: "إجمالي السطور قبل الخصم",
  lineNet: "صافي السطور قبل الضريبة", invoiceTotal: "إجمالي الفواتير المطابقة",
  netInvoiceTotal: "صافي الفواتير بعد المرتجعات", postedReturnTotal: "إجمالي المرتجعات المرحلة",
  postedReturnLineValue: "قيمة سطور المرتجعات المرحلة",
  lastInvoiceDate: "تاريخ آخر فاتورة", lastInvoiceValue: "قيمة آخر فاتورة",
  lastDate: "تاريخ آخر فاتورة", lastValue: "قيمة آخر فاتورة", historicalValue: "القيمة التاريخية",
  originalInvoiceId: "الفاتورة الأصلية", originalDocumentNumber: "رقم الفاتورة الأصلية",
  notes: "ملاحظات", headerNotes: "ملاحظات المستند", lineNotes: "ملاحظات السطر",
  source: "المصدر", createdById: "معرّف المنشئ", currencyCode: "العملة",
  unitPrice: "سعر الوحدة", finalCost: "التكلفة المحفوظة", averagePrice: "متوسط السعر",
  minPrice: "أقل سعر", maxPrice: "أعلى سعر", lastPrice: "آخر سعر",
  lineValue: "قيمة السطر", lineTotal: "إجمالي السطر", period: "الفترة",
  openingStock: "رصيد أول المدة", closingStock: "رصيد آخر المدة", movement: "الحركة",
  operations: "عدد الحركات", grossQuantity: "إجمالي الكمية الداخلة",
  netQuantity: "صافي الكمية", grossValue: "قيمة المشتريات",
  netValue: "صافي القيمة بعد المرتجعات", headerTotal: "إجمالي المستند",
};

const api = apiClient as any;
const useSalesReport = api.useGetAdditionalSalesReport as (
  reportId: string, params: ReportParams, options: { query: { enabled: boolean; queryKey: readonly unknown[] } }
) => { data?: ReportResponse; isLoading: boolean; isError: boolean; error?: unknown };
const usePurchaseReport = api.useGetAdditionalPurchaseReport as typeof useSalesReport;
const salesQueryKey = api.getGetAdditionalSalesReportQueryKey as (reportId: string, params: ReportParams) => readonly unknown[];
const purchaseQueryKey = api.getGetAdditionalPurchaseReportQueryKey as typeof salesQueryKey;

function parsePermissions(raw: unknown): Record<string, boolean> {
  if (typeof raw === "string") {
    try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed : {}; }
    catch { return {}; }
  }
  return raw && typeof raw === "object" ? raw as Record<string, boolean> : {};
}

function localDate(value: Date): string {
  const shifted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function positiveId(value: string): number | undefined {
  const parsed = Number(value);
  return value.trim() && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export default function AdditionalOperationalReportsPage({ domain }: { domain: Domain }) {
  const { user, token, actingCompanyId } = useAuth() as any;
  const definitions = domain === "sales" ? salesReports : purchaseReports;
  const prefix = domain === "sales" ? "asr" : "apr";
  const gate = domain === "sales" ? "additional_sales_reports" : "additional_purchase_reports";
  const rawPermissions = user?.company?.menuPermissions ?? user?.companyMenuPermissions;
  const permissions = useMemo(() => parsePermissions(rawPermissions), [rawPermissions]);
  const allowedReports = useMemo(
    () => permissions[gate] === true ? definitions.filter(report => permissions[`${prefix}:${report.id}`] === true) : [],
    [definitions, gate, permissions, prefix],
  );
  const [selectedId, setSelectedId] = useState<string | null>(allowedReports[0]?.id ?? null);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [toDate, setToDate] = useState(() => localDate(new Date()));
  const [draftFilters, setDraftFilters] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState<{ id: string; params: ReportParams } | null>(null);

  useEffect(() => {
    if (!allowedReports.some(report => report.id === selectedId)) {
      setSelectedId(allowedReports[0]?.id ?? null);
      setApplied(null);
    }
  }, [allowedReports, selectedId]);

  const selected = allowedReports.find(report => report.id === selectedId) ?? allowedReports[0] ?? null;
  const companyId = actingCompanyId ?? user?.company?.id ?? user?.companyId;
  const params = applied?.params ?? {};
  const effectiveId = selected?.id ?? "";
  const queryEnabled = Boolean(token && companyId && selected && applied?.id === selected.id);
  const salesQuery = useSalesReport(effectiveId, params, {
    query: { enabled: domain === "sales" && queryEnabled, queryKey: salesQueryKey(effectiveId, params) },
  });
  const purchaseQuery = usePurchaseReport(effectiveId, params, {
    query: { enabled: domain === "purchases" && queryEnabled, queryKey: purchaseQueryKey(effectiveId, params) },
  });
  const query = domain === "sales" ? salesQuery : purchaseQuery;
  const rows = (query.data?.rows ?? []) as Record<string, unknown>[];

  const buildParams = (): ReportParams => {
    const numericKeys = ["branchId", "customerId", "supplierId", "itemId", "itemGroupId", "salesRepId", "warehouseId"];
    const result: ReportParams = {
      companyId: typeof companyId === "number" ? companyId : undefined,
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
    };
    for (const key of selected?.filters ?? []) {
      const value = draftFilters[key] ?? "";
      if (!value.trim()) continue;
      result[key] = numericKeys.includes(key) ? positiveId(value) : value;
    }
    return result;
  };

  const applyFilters = () => {
    if (!selected) return;
    setApplied({ id: selected.id, params: buildParams() });
  };

  if (allowedReports.length === 0) {
    return (
      <main className="min-h-[calc(100dvh-4rem)] bg-[#f5f8f8] px-4 py-8 sm:px-6 lg:px-8" dir="rtl">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-12 text-center shadow-sm">
          <ShieldCheck className="mx-auto h-10 w-10 text-slate-300" />
          <h1 className="mt-4 text-lg font-bold text-slate-800">لا توجد تقارير إضافية مفعّلة</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
            لم يتم تفعيل شاشة التقارير الإضافية أو أي تقرير منها لهذه الشركة.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100dvh-4rem)] bg-[#f5f8f8] px-3 py-5 sm:px-5 lg:px-7" dir="rtl" data-testid={`additional-${domain}-reports-page`}>
      <div className="w-full space-y-5">
        <header className="relative overflow-hidden rounded-2xl bg-[#123c42] px-5 py-6 text-white shadow-[0_18px_45px_-25px_rgba(18,60,66,0.8)] sm:px-7">
          <div className="absolute -left-12 -top-16 h-48 w-48 rounded-full border-[28px] border-white/5" />
          <div className="relative flex flex-col justify-between gap-5 md:flex-row md:items-end">
            <div>
              <div className="mb-3 flex items-center gap-2 text-xs font-bold text-teal-200">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
                {domain === "sales" ? "تقارير المبيعات الإضافية" : "تقارير المشتريات الإضافية"}
              </div>
              <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">مركز التقارير التشغيلية</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-teal-100/80">
                شاشة بحث موحّدة للتقارير المفعّلة فقط، مع تصفية النتائج وتصديرها أو طباعتها.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-xs text-teal-50">
              <Check className="h-4 w-4 text-amber-300" />
              <span>{allowedReports.length} تقرير متاح</span>
            </div>
          </div>
        </header>

        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_12px_35px_-24px_rgba(15,23,42,0.5)] sm:p-5">
          <div className="flex flex-col justify-between gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-teal-100 bg-teal-50 text-teal-800">
                <FileSearch className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-lg font-extrabold text-slate-900">{selected?.label}</h2>
                <p className="mt-0.5 text-xs text-slate-500">اختر تقريراً ثم حدّد الفترة والفلاتر المناسبة.</p>
              </div>
            </div>
            <Popover open={selectorOpen} onOpenChange={setSelectorOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-between sm:w-[310px]" data-testid="additional-report-selector">
                  <span className="truncate">{selected?.label ?? "اختر تقريراً"}</span>
                  <ChevronDown className="ms-2 h-4 w-4 shrink-0 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[min(90vw,340px)] p-0" align="end">
                <Command>
                  <CommandInput placeholder="ابحث باسم التقرير..." />
                  <CommandList>
                    <CommandEmpty>لا توجد تقارير مطابقة.</CommandEmpty>
                    <CommandGroup>
                      {allowedReports.map(report => (
                        <CommandItem key={report.id} value={report.label} onSelect={() => {
                          setSelectedId(report.id);
                          setApplied(null);
                          setSelectorOpen(false);
                        }}>
                          <Check className={cn("ms-2 h-4 w-4", selected?.id === report.id ? "opacity-100" : "opacity-0")} />
                          {report.label}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1.5 text-xs font-semibold text-slate-600">
              <span className="flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" /> من تاريخ</span>
              <DateField value={fromDate} onChange={event => setFromDate(event.target.value)} className="h-9 w-full" />
            </label>
            <label className="space-y-1.5 text-xs font-semibold text-slate-600">
              <span className="flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" /> إلى تاريخ</span>
              <DateField value={toDate} onChange={event => setToDate(event.target.value)} className="h-9 w-full" />
            </label>
            {(selected?.filters ?? []).map(key => (
              <label key={key} className="space-y-1.5 text-xs font-semibold text-slate-600">
                <span>{filterLabels[key] ?? key}</span>
                {key === "groupBy" ? (
                  <select
                    value={draftFilters[key] ?? "month"}
                    onChange={event => setDraftFilters(old => ({ ...old, [key]: event.target.value }))}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-normal"
                  >
                    <option value="day">يومي</option><option value="week">أسبوعي</option>
                    <option value="month">شهري</option><option value="quarter">ربع سنوي</option>
                    <option value="year">سنوي</option>
                  </select>
                ) : (
                  <Input
                    value={draftFilters[key] ?? ""}
                    onChange={event => setDraftFilters(old => ({ ...old, [key]: event.target.value }))}
                    placeholder={key.endsWith("Id") ? "اكتب المعرّف" : `اكتب ${filterLabels[key] ?? key}`}
                    inputMode={key.endsWith("Id") ? "numeric" : undefined}
                    className="h-9 font-normal"
                  />
                )}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              <Filter className="h-3.5 w-3.5" />
              <span>تُحتسب النتائج من المستندات المرحلة حيث ينطبق ذلك.</span>
            </div>
            <Button onClick={applyFilters} disabled={!selected || !companyId} className="gap-2 bg-[#123c42] hover:bg-[#0d3035]" data-testid="run-additional-report">
              <Search className="h-4 w-4" /> عرض التقرير
            </Button>
          </div>
        </section>

        {queryEnabled && query.data?.limitations?.length ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">
            {query.data.limitations.map((limitation, index) => <p key={index}>{limitation}</p>)}
          </div>
        ) : null}
        {query.isError && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            تعذّر تحميل التقرير. تحقّق من الصلاحيات والفلاتر ثم أعد المحاولة.
          </div>
        )}

        {query.isLoading && (
          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <div className="mb-4 flex items-center gap-3 text-sm font-bold text-slate-700">
              <Loader2 className="h-5 w-5 animate-spin text-teal-700" /> جارٍ تحميل التقرير...
            </div>
            <div className="space-y-3">{[1, 2, 3, 4].map(item => <div key={item} className="h-10 animate-pulse rounded-lg bg-slate-100" />)}</div>
          </div>
        )}
        {!query.isLoading && !query.isError && !applied && (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
            <Search className="mx-auto h-7 w-7 text-slate-300" />
            <p className="mt-3">حدّد الفلاتر ثم اختر «عرض التقرير».</p>
          </div>
        )}
        {!query.isLoading && !query.isError && applied && rows.length === 0 && (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
            <X className="mx-auto h-7 w-7 text-slate-300" />
            <p className="mt-3">لا توجد نتائج للفلاتر المحددة.</p>
          </div>
        )}
        {!query.isLoading && !query.isError && applied && rows.length > 0 && selected && (
          <AdditionalOperationalReportGrid
            key={`${domain}:${selected.id}:${JSON.stringify(applied.params)}`}
            domain={domain}
            reportId={selected.id}
            reportTitle={selected.label}
            companyId={typeof companyId === "number" ? companyId : undefined}
            fromDate={String(applied.params.fromDate ?? "")}
            toDate={String(applied.params.toDate ?? "")}
            rows={rows}
            labels={fieldLabels}
          />
        )}
      </div>
    </main>
  );
}