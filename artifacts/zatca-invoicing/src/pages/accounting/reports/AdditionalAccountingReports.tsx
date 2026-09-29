import { useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  BookOpenCheck,
  CalendarDays,
  Check,
  ChevronDown,
  FileSearch,
  Filter,
  Hash,
  LayoutList,
  Loader2,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  X,
} from "lucide-react";
import * as apiClient from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type ReportId =
  | "general_ledger"
  | "trial_balance_balances"
  | "expense_analysis"
  | "revenue_analysis"
  | "cost_center_report"
  | "comparative_profit_loss"
  | "changes_in_equity"
  | "journal_audit";
type GetReportParams = {
  companyId?: number;
  branchId?: number;
  accountId?: number;
  costCenterId?: string;
  fromDate?: string;
  toDate?: string;
  comparisonFromDate?: string;
  comparisonToDate?: string;
  includeZero?: boolean;
};
type ReportRow = Record<string, unknown>;
type AdditionalReportResponse = {
  reportId: ReportId;
  rows: ReportRow[];
  limitations?: string[];
};

// The workspace package's generated declaration snapshot can lag the generated
// source during an API regeneration. Keep the runtime call on the generated
// hook while allowing this page to typecheck against either snapshot.
const useAdditionalAccountingReport = (apiClient as any).useGetAdditionalAccountingReport as (
  reportId: ReportId,
  params?: GetReportParams,
  options?: { query?: { enabled?: boolean; queryKey: readonly unknown[] } },
) => {
  data?: AdditionalReportResponse;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
};
const getAdditionalAccountingReportQueryKey = (apiClient as any)
  .getGetAdditionalAccountingReportQueryKey as (reportId: ReportId, params?: GetReportParams) => readonly unknown[];

type ReportDefinition = {
  id: ReportId;
  name: string;
  englishName: string;
  description: string;
  category: string;
  icon: typeof BookOpenCheck;
  accent: string;
};

const REPORTS: ReportDefinition[] = [
  {
    id: "general_ledger",
    name: "دفتر الأستاذ العام",
    englishName: "General ledger",
    description: "تفصيل الحركات والقيود على مستوى الحساب",
    category: "الحركة اليومية",
    icon: BookOpenCheck,
    accent: "text-cyan-700 bg-cyan-50 border-cyan-200",
  },
  {
    id: "trial_balance_balances",
    name: "ميزان المراجعة بالأرصدة",
    englishName: "Trial balance balances",
    description: "الأرصدة الافتتاحية وحركة الفترة والختام",
    category: "الأرصدة",
    icon: Table2,
    accent: "text-indigo-700 bg-indigo-50 border-indigo-200",
  },
  {
    id: "expense_analysis",
    name: "تحليل المصروفات",
    englishName: "Expense analysis",
    description: "قراءة مصروفات الحسابات خلال الفترة",
    category: "التحليل المالي",
    icon: SlidersHorizontal,
    accent: "text-rose-700 bg-rose-50 border-rose-200",
  },
  {
    id: "revenue_analysis",
    name: "تحليل الإيرادات",
    englishName: "Revenue analysis",
    description: "تفصيل الإيرادات ومقارنتها بالأرصدة",
    category: "التحليل المالي",
    icon: LayoutList,
    accent: "text-emerald-700 bg-emerald-50 border-emerald-200",
  },
  {
    id: "cost_center_report",
    name: "تقرير مراكز التكلفة",
    englishName: "Cost center report",
    description: "المدين والدائن والرصيد لكل مركز تكلفة",
    category: "مراكز التكلفة",
    icon: Hash,
    accent: "text-amber-700 bg-amber-50 border-amber-200",
  },
  {
    id: "comparative_profit_loss",
    name: "قائمة الدخل المقارنة",
    englishName: "Comparative profit & loss",
    description: "الفترة الحالية والفترة المقارنة والانحراف",
    category: "التحليل المالي",
    icon: FileSearch,
    accent: "text-violet-700 bg-violet-50 border-violet-200",
  },
  {
    id: "changes_in_equity",
    name: "التغيرات في حقوق الملكية",
    englishName: "Changes in equity",
    description: "حركة حقوق الملكية من الافتتاح إلى الإقفال",
    category: "الأرصدة",
    icon: ChevronDown,
    accent: "text-sky-700 bg-sky-50 border-sky-200",
  },
  {
    id: "journal_audit",
    name: "تدقيق القيود",
    englishName: "Journal audit",
    description: "سجل تدقيق الإجراءات والطلبات على القيود",
    category: "التدقيق",
    icon: ShieldCheck,
    accent: "text-slate-700 bg-slate-100 border-slate-200",
  },
];

const amountFields = [
  "debit",
  "credit",
  "balance",
  "openingDebit",
  "openingCredit",
  "openingBalance",
  "periodDebit",
  "periodCredit",
  "periodBalance",
  "closingBalance",
  "comparisonPeriodDebit",
  "comparisonPeriodCredit",
  "variance",
];

const isNumberLike = (value: unknown): value is number | string =>
  typeof value === "number" ||
  (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));

const toNumber = (value: unknown) => (isNumberLike(value) ? Number(value) : 0);

const formatAmount = (value: unknown) =>
  isNumberLike(value)
    ? new Intl.NumberFormat("ar-SA", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(Number(value))
    : "—";

const displayValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "—";
    }
  }
  return String(value);
};

const dateLabel = (value: unknown) => {
  if (!value) return "—";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("ar-SA", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(date);
};

function parseMenuPermissions(raw: unknown): Record<string, boolean> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, boolean>) : {};
}

function getReportColumns(reportId: ReportId) {
  if (reportId === "general_ledger") {
    return [
      ["lineId", "معرّف السطر"],
      ["entryId", "معرّف القيد"],
      ["entryDate", "التاريخ"],
      ["docNumber", "رقم المستند"],
      ["entryType", "نوع القيد"],
      ["accountId", "معرّف الحساب"],
      ["accountCode", "رمز الحساب"],
      ["accountNameAr", "الحساب"],
      ["costCenter", "مركز التكلفة"],
      ["debit", "مدين"],
      ["credit", "دائن"],
      ["description", "البيان"],
    ] as const;
  }
  if (reportId === "cost_center_report") {
    return [
      ["costCenter", "مركز التكلفة"],
      ["debit", "مدين"],
      ["credit", "دائن"],
      ["balance", "الرصيد"],
    ] as const;
  }
  if (reportId === "journal_audit") {
    return [
      ["id", "معرّف السجل"],
      ["userId", "معرّف المستخدم"],
      ["createdAt", "وقت الإجراء"],
      ["username", "المستخدم"],
      ["action", "الإجراء"],
      ["method", "الطريقة"],
      ["path", "المسار"],
      ["entityType", "نوع الكيان"],
      ["entityId", "معرّف الكيان"],
      ["statusCode", "الحالة"],
      ["metadata", "البيانات الوصفية"],
    ] as const;
  }
  const base = [
    ["accountId", "معرّف الحساب"],
    ["code", "رمز الحساب"],
    ["nameAr", "اسم الحساب"],
    ["accountType", "نوع الحساب"],
    ["openingDebit", "مدين افتتاحي"],
    ["openingCredit", "دائن افتتاحي"],
    ["openingBalance", "الرصيد الافتتاحي"],
    ["periodDebit", "مدين الفترة"],
    ["periodCredit", "دائن الفترة"],
    ["periodBalance", "رصيد الفترة"],
    ["closingBalance", "الرصيد الختامي"],
  ] as const;
  if (reportId === "comparative_profit_loss") {
    return [
      ...base,
      ["comparisonPeriodDebit", "مدين الفترة المقارنة"],
      ["comparisonPeriodCredit", "دائن الفترة المقارنة"],
      ["variance", "الانحراف"],
    ] as const;
  }
  return base;
}

function ReportSelector({
  reports,
  selectedId,
  onSelect,
}: {
  reports: ReportDefinition[];
  selectedId: ReportId | null;
  onSelect: (id: ReportId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const filtered = reports.filter((report) =>
    `${report.name} ${report.englishName} ${report.description}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase()),
  );
  const selected = reports.find((report) => report.id === selectedId) ?? null;
  const SelectedIcon = selected?.icon;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_12px_35px_-24px_rgba(15,23,42,0.5)]" data-testid="panel-report-selector">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-slate-900">اختر التقرير</p>
          <p className="mt-0.5 text-xs text-slate-500">{reports.length} تقارير مفعّلة لهذا الحساب</p>
        </div>
        <span className="rounded-full bg-teal-50 px-2.5 py-1 text-[11px] font-bold text-teal-700">إضافة جديدة</span>
      </div>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            role="combobox"
            aria-expanded={open}
            data-testid="button-open-report-selector"
            className="h-auto min-h-11 w-full justify-between gap-3 border border-slate-200 bg-slate-50 px-3 py-2 text-start text-slate-800 shadow-none hover:bg-white"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              {SelectedIcon && (
                <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border", selected?.accent)}>
                  <SelectedIcon className="h-4 w-4" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold">{selected?.name ?? "اختر التقرير"}</span>
                {selected && <span className="block truncate text-[11px] text-slate-500" dir="ltr">{selected.englishName}</span>}
              </span>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0" dir="rtl">
          <Command shouldFilter={false}>
            <CommandInput
              data-testid="input-report-search"
              value={search}
              onValueChange={setSearch}
              placeholder="ابحث باسم التقرير..."
              aria-label="البحث في التقارير"
            />
            <CommandList className="max-h-80">
              <CommandEmpty data-testid="empty-report-search">لا توجد تقارير مطابقة للبحث</CommandEmpty>
              <CommandGroup>
                {filtered.map((report) => {
                  const Icon = report.icon;
                  const isSelected = report.id === selectedId;
                  return (
                    <CommandItem
                      key={report.id}
                      value={report.id}
                      data-testid={`button-select-report-${report.id}`}
                      onSelect={() => {
                        onSelect(report.id);
                        setSearch("");
                        setOpen(false);
                      }}
                      className="gap-3 px-3 py-2.5"
                    >
                      <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border", report.accent)}>
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold">{report.name}</span>
                        <span className="block truncate text-[11px] text-slate-500" dir="ltr">{report.englishName}</span>
                      </span>
                      {isSelected && <Check className="h-4 w-4 shrink-0 text-teal-700" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </section>
  );
}

function FilterField({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <label className="space-y-1.5" data-testid={testId}>
      <span className="text-xs font-bold text-slate-600">{label}</span>
      {children}
    </label>
  );
}

function ReportTable({ reportId, rows }: { reportId: ReportId; rows: ReportRow[] }) {
  const columns = getReportColumns(reportId);
  const totals = useMemo(() => {
    const result: Record<string, number> = {};
    columns.forEach(([key]) => {
      if (amountFields.includes(key)) result[key] = rows.reduce((sum, row) => sum + toNumber(row[key]), 0);
    });
    return result;
  }, [columns, rows]);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_14px_35px_-28px_rgba(15,23,42,0.65)]" data-testid="table-report-results">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <div className="flex items-center gap-2">
          <Table2 className="h-4 w-4 text-teal-700" />
          <span className="text-sm font-bold text-slate-800">نتائج التقرير</span>
        </div>
        <span className="font-mono text-xs text-slate-500" dir="ltr">{rows.length.toLocaleString("en-US")} rows</span>
      </div>
      <div className="max-h-[min(58vh,42rem)] overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-10 bg-slate-100/95 backdrop-blur">
            <tr>
              <th className="w-12 border-b border-slate-200 px-3 py-3 text-center text-[11px] font-bold text-slate-400">#</th>
              {columns.map(([key, label]) => (
                <th key={key} className={cn("whitespace-nowrap border-b border-slate-200 px-3 py-3 text-start text-[11px] font-bold text-slate-600", amountFields.includes(key) && "text-end")}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={String(row.lineId ?? row.id ?? row.accountId ?? index)} className="group hover:bg-teal-50/35" data-testid={`row-report-${index}`}>
                <td className="border-b border-slate-100 px-3 py-3 text-center font-mono text-xs text-slate-400">{index + 1}</td>
                {columns.map(([key]) => {
                  const value = row[key];
                  const isAmount = amountFields.includes(key);
                  const isDate = key === "entryDate" || key === "createdAt";
                  return (
                    <td
                      key={key}
                      className={cn(
                        "max-w-[18rem] border-b border-slate-100 px-3 py-3 text-slate-700",
                        isAmount && "whitespace-nowrap text-end font-mono tabular-nums",
                        isDate && "whitespace-nowrap text-xs text-slate-500",
                        key === "metadata" && "max-w-[16rem] font-mono text-[11px] text-slate-500",
                      )}
                      title={displayValue(value)}
                    >
                      <span className={cn("block truncate", isAmount && toNumber(value) < 0 && "text-rose-700")}>
                        {isAmount ? formatAmount(value) : isDate ? dateLabel(value) : displayValue(value)}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-50">
            <tr>
              <td className="px-3 py-3 text-center text-xs font-bold text-slate-500">Σ</td>
              {columns.map(([key], index) => (
                <td key={key} className={cn("px-3 py-3 text-sm font-bold text-slate-700", amountFields.includes(key) && "text-end font-mono tabular-nums")}>
                  {index === 0 ? "الإجمالي" : amountFields.includes(key) ? formatAmount(totals[key]) : ""}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

export default function AdditionalAccountingReports() {
  const { user, token, actingCompanyId } = useAuth();
  const permissions = useMemo(() => parseMenuPermissions(user?.company?.menuPermissions), [user?.company?.menuPermissions]);
  const allowedReports = useMemo(
    () => REPORTS.filter((report) => permissions.additional_accounting_reports === true && permissions[`aar:${report.id}`] === true),
    [permissions],
  );
  const [selectedId, setSelectedId] = useState<ReportId | null>(allowedReports[0]?.id ?? null);
  const [fromDate, setFromDate] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [comparisonFromDate, setComparisonFromDate] = useState("");
  const [comparisonToDate, setComparisonToDate] = useState("");
  const [branchId, setBranchId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [costCenterId, setCostCenterId] = useState("");
  const [includeZero, setIncludeZero] = useState(false);

  const selectedReport = allowedReports.find((report) => report.id === selectedId) ?? allowedReports[0] ?? null;
  const effectiveReportId = selectedReport?.id ?? "general_ledger";
  const companyId = actingCompanyId ?? user?.company?.id ?? user?.companyId;
  const params = useMemo<GetReportParams>(() => {
    const numeric = (value: string) => {
      const parsed = Number(value);
      return value.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    };
    return {
      companyId: typeof companyId === "number" ? companyId : undefined,
      branchId: selectedReport?.id === "journal_audit" ? undefined : numeric(branchId),
      accountId: numeric(accountId),
      costCenterId: costCenterId.trim() || undefined,
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
      comparisonFromDate: comparisonFromDate || undefined,
      comparisonToDate: comparisonToDate || undefined,
      includeZero,
    };
  }, [accountId, branchId, companyId, comparisonFromDate, comparisonToDate, costCenterId, fromDate, includeZero, selectedReport?.id, toDate]);

  const queryEnabled = Boolean(token && selectedReport && (companyId || user?.role === "superadmin"));
  const { data, isLoading, isError, error, refetch } = useAdditionalAccountingReport(effectiveReportId, params, {
    query: {
      enabled: queryEnabled,
      queryKey: getAdditionalAccountingReportQueryKey(effectiveReportId, params),
    },
  });
  const rows = (data?.rows ?? []) as ReportRow[];

  if (allowedReports.length === 0) {
    return (
      <main className="min-h-[calc(100dvh-4rem)] bg-[#f5f8f8] px-4 py-8 sm:px-6 lg:px-8" dir="rtl" data-testid="additional-accounting-reports-page">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-12 text-center shadow-sm" data-testid="empty-report-permissions">
          <ShieldCheck className="mx-auto h-10 w-10 text-slate-300" />
          <h1 className="mt-4 text-lg font-bold text-slate-800">لا توجد تقارير إضافية مفعّلة</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">لم يتم تفعيل صلاحيات تقارير المحاسبة الإضافية لهذه الشركة. يعرض هذا القسم التقارير المسموح بها فقط.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100dvh-4rem)] bg-[#f5f8f8] px-3 py-5 sm:px-5 lg:px-7" dir="rtl" data-testid="additional-accounting-reports-page">
      <div className="mx-auto max-w-[1800px] space-y-5">
        <header className="relative overflow-hidden rounded-2xl bg-[#123c42] px-5 py-6 text-white shadow-[0_18px_45px_-25px_rgba(18,60,66,0.8)] sm:px-7">
          <div className="absolute -left-12 -top-16 h-48 w-48 rounded-full border-[28px] border-white/5" />
          <div className="absolute -bottom-24 right-24 h-48 w-48 rounded-full border-[22px] border-teal-200/10" />
          <div className="relative flex flex-col justify-between gap-5 md:flex-row md:items-end">
            <div>
              <div className="mb-3 flex items-center gap-2 text-xs font-bold text-teal-200">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
                التقارير المحاسبية الإضافية
              </div>
              <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">مركز مراجعة البيانات المالية</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-teal-100/80">مساحة عمل موحّدة لفحص الأستاذ العام، الأرصدة، التحليلات، وسجل تدقيق القيود دون مغادرة الشاشة.</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-xs text-teal-50" data-testid="status-permitted-reports">
              <Check className="h-4 w-4 text-amber-300" />
              <span>{allowedReports.length} من 8 تقارير متاحة</span>
            </div>
          </div>
        </header>

        <div className="grid items-start gap-5 xl:grid-cols-[18rem_minmax(0,1fr)]">
          <ReportSelector reports={allowedReports} selectedId={selectedReport?.id ?? null} onSelect={setSelectedId} />

          <section className="min-w-0 space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_12px_35px_-24px_rgba(15,23,42,0.5)] sm:p-5" data-testid="panel-report-filters">
              <div className="mb-4 flex flex-col justify-between gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-center">
                <div className="flex items-center gap-3">
                  <span className={cn("flex h-10 w-10 items-center justify-center rounded-xl border", selectedReport?.accent)}>
                    {selectedReport && (() => {
                      const SelectedIcon = selectedReport.icon;
                      return <SelectedIcon className="h-5 w-5" />;
                    })()}
                  </span>
                  <div>
                    <h2 className="text-lg font-extrabold text-slate-900">{selectedReport?.name}</h2>
                    <p className="mt-0.5 text-xs text-slate-500">{selectedReport?.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <Filter className="h-3.5 w-3.5" />
                  <span>نطاق العرض والفلاتر</span>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <FilterField label="من تاريخ" testId="field-from-date">
                  <DateField data-testid="input-from-date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="h-9 w-full" />
                </FilterField>
                <FilterField label="إلى تاريخ" testId="field-to-date">
                  <DateField data-testid="input-to-date" value={toDate} onChange={(event) => setToDate(event.target.value)} className="h-9 w-full" />
                </FilterField>
                <FilterField label="من تاريخ المقارنة" testId="field-comparison-from-date">
                  <DateField data-testid="input-comparison-from-date" value={comparisonFromDate} onChange={(event) => setComparisonFromDate(event.target.value)} className="h-9 w-full" />
                </FilterField>
                <FilterField label="إلى تاريخ المقارنة" testId="field-comparison-to-date">
                  <DateField data-testid="input-comparison-to-date" value={comparisonToDate} onChange={(event) => setComparisonToDate(event.target.value)} className="h-9 w-full" />
                </FilterField>
                <FilterField label="الفرع" testId="field-branch-id">
                  <Input data-testid="input-branch-id" value={branchId} onChange={(event) => setBranchId(event.target.value)} placeholder="معرّف الفرع" inputMode="numeric" className="h-9" disabled={selectedReport?.id === "journal_audit"} />
                </FilterField>
                <FilterField label="الحساب" testId="field-account-id">
                  <Input data-testid="input-account-id" value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="معرّف الحساب" inputMode="numeric" className="h-9" />
                </FilterField>
                <FilterField label="مركز التكلفة" testId="field-cost-center-id">
                  <Input data-testid="input-cost-center-id" value={costCenterId} onChange={(event) => setCostCenterId(event.target.value)} placeholder="معرّف أو قائمة مراكز" className="h-9" dir="ltr" />
                </FilterField>
                <div className="flex items-end">
                  <label className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-100" data-testid="field-include-zero">
                    <Checkbox data-testid="checkbox-include-zero" checked={includeZero} onCheckedChange={(checked) => setIncludeZero(checked === true)} />
                    إظهار الحسابات الصفرية
                  </label>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
                <div className="flex items-center gap-2 text-[11px] text-slate-400">
                  <CalendarDays className="h-3.5 w-3.5" />
                  <span>تتحدث النتائج تلقائياً عند تغيير الفلاتر</span>
                </div>
                <Button type="button" variant="outline" size="sm" data-testid="button-refresh-report" onClick={() => void refetch()} disabled={isLoading} className="gap-2 border-teal-200 text-teal-800 hover:bg-teal-50">
                  {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  تحديث التقرير
                </Button>
              </div>
            </div>

            {data?.limitations && data.limitations.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3" data-testid="panel-report-limitations">
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                  <div>
                    <p className="text-xs font-extrabold text-amber-900">حدود مصدر البيانات</p>
                    <ul className="mt-1 space-y-1 text-xs leading-5 text-amber-800">
                      {data.limitations.map((limitation, index) => <li key={`${limitation}-${index}`}>{limitation}</li>)}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {isLoading && (
              <div className="rounded-2xl border border-slate-200 bg-white p-5" data-testid="state-report-loading" aria-live="polite">
                <div className="mb-4 flex items-center gap-3"><Loader2 className="h-5 w-5 animate-spin text-teal-700" /><span className="text-sm font-bold text-slate-700">جارٍ تحميل بيانات التقرير...</span></div>
                <div className="space-y-3">{[1, 2, 3, 4].map((item) => <div key={item} className="h-10 animate-pulse rounded-lg bg-slate-100" />)}</div>
              </div>
            )}

            {isError && !isLoading && (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 text-center" data-testid="state-report-error" role="alert">
                <AlertCircle className="mx-auto h-8 w-8 text-rose-600" />
                <h3 className="mt-3 text-sm font-extrabold text-rose-900">تعذر تحميل التقرير</h3>
                <p className="mt-1 text-xs text-rose-700">{error instanceof Error ? error.message : "حدث خطأ أثناء جلب بيانات التقرير."}</p>
                <Button type="button" variant="outline" size="sm" data-testid="button-retry-report" onClick={() => void refetch()} className="mt-4 border-rose-200 text-rose-800 hover:bg-rose-100">إعادة المحاولة</Button>
              </div>
            )}

            {!isLoading && !isError && rows.length === 0 && (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center" data-testid="state-report-empty">
                <FileSearch className="mx-auto h-9 w-9 text-slate-300" />
                <h3 className="mt-3 text-sm font-extrabold text-slate-700">لا توجد بيانات ضمن النطاق المحدد</h3>
                <p className="mt-1 text-xs text-slate-500">جرّب تعديل النطاق الزمني أو الفلاتر ثم حدّث التقرير.</p>
              </div>
            )}

            {!isLoading && !isError && rows.length > 0 && <ReportTable reportId={effectiveReportId} rows={rows} />}
          </section>
        </div>
      </div>
    </main>
  );
}