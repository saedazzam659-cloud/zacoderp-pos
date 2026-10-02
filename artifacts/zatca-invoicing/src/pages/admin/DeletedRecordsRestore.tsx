import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import {
  AlertTriangle, ArchiveRestore, Check, ChevronsUpDown, ChevronLeft, ChevronRight, CircleAlert,
  Clock3, Database, FileJson2, Layers3, Loader2, RefreshCw, Search, ShieldCheck,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const PAGE_SIZE = 100;
type SearchableOption = {
  value: string;
  label: string;
  description?: string;
  searchText?: string;
  testId?: string;
};

const TABLE_FILTER_OPTIONS = [
  { value: "customers", label: "العملاء" },
  { value: "suppliers", label: "الموردون" },
  { value: "items", label: "الأصناف" },
  { value: "accounts", label: "شجرة الحسابات" },
  { value: "branches", label: "الفروع" },
  { value: "warehouses", label: "المخازن" },
  { value: "cash_boxes", label: "الخزن النقدية" },
  { value: "bank_accounts", label: "الحسابات البنكية" },
  { value: "invoices", label: "فواتير المبيعات" },
  { value: "purchase_invoices", label: "فواتير المشتريات" },
  { value: "journal_entries", label: "قيود اليومية" },
  { value: "sales_returns", label: "مرتجعات المبيعات" },
];
const TABLE_FILTER_COMBOBOX_OPTIONS: SearchableOption[] = [
  { value: "all", label: "كل أنواع السجلات", testId: "option-table-filter-all" },
  ...TABLE_FILTER_OPTIONS.map((option) => ({
    ...option,
    testId: `option-table-filter-${option.value}`,
  })),
];

type Company = {
  id: number;
  nameAr: string;
  vatNumber?: string | null;
  agentInstanceId?: number | string | null;
  agentName?: string | null;
};

type DeletedRecord = {
  id: number;
  companyId: number;
  recordId: number;
  tableName: string;
  tableLabel: string;
  summary: string;
  payload: unknown;
  deletedAt: string;
  deletedByUsername?: string | null;
  reason?: string | null;
  source?: string | null;
  restoredAt?: string | null;
  restoreAllowed: boolean;
  restoreReason?: string | null;
  lineCount?: number | null;
};

type RecycleResponse = { rows: DeletedRecord[]; total: number; limit: number; offset: number };
type RestoreResponse = {
  summary: { requested: number; ok: number; failed: number };
  results: Array<{ id: number; ok: boolean; reason?: string }>;
};

function companyKey(company: Company) {
  return `${company.agentInstanceId == null ? "central" : `agent-${company.agentInstanceId}`}::${company.id}`;
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ar-SA-u-ca-gregory", { dateStyle: "medium", timeStyle: "short" });
}

function eligibilityReason(reason?: string | null) {
  if (!reason) return "هذا السجل غير مؤهل للاستعادة.";
  const known: Record<string, string> = {
    already_restored: "تمت استعادة هذا السجل مسبقاً.",
    record_exists: "يوجد سجل نشط بنفس المعرّف بالفعل.",
    incomplete_payload: "النسخة المحفوظة غير مكتملة ولا يمكن استعادتها بأمان.",
    unsupported_table: "نوع الجدول هذا غير مدعوم للاستعادة.",
    missing_company: "تعذر العثور على الشركة المرتبطة بالسجل.",
    missing_record_id: "معرّف السجل الأصلي غير متوفر.",
    invalid_snapshot: "بيانات النسخة المحفوظة غير صالحة.",
    record_id_mismatch: "معرّف السجل لا يطابق النسخة المحفوظة.",
    company_id_mismatch: "الشركة في النسخة لا تطابق الشركة المحددة.",
    not_draft: "لا يمكن استعادة مستند غير مسودة.",
    posted_document: "المستند مرتبط بقيد مرحّل.",
    zatca_artifacts: "المستند يحتوي على بيانات أو آثار ZATCA.",
    missing_return_lines: "النسخة لا تحتوي على بنود المرتجع كاملة.",
    incomplete_return_lines: "بعض بنود المرتجع غير مكتملة.",
    incomplete_snapshot: "النسخة المحفوظة لا تحتوي على بيانات أساسية كافية.",
    document_child_snapshot_not_supported: "لا يمكن استعادة المستند دون نسخة كاملة من تفاصيله.",
    unknown_table: "نوع الجدول غير معروف أو غير مدعوم.",
    conflict_doc_number: "يوجد مستند نشط يحمل رقم المستند نفسه.",
    conflict_pk_or_unique_in_use: "يوجد تعارض في المعرّف أو قيمة فريدة.",
    not_found_or_company_mismatch: "لم يُعثر على النسخة ضمن قاعدة البيانات والشركة المحددتين.",
    insert_failed: "تعذر إدخال السجل؛ لم تُعتمد الاستعادة.",
  };
  return known[reason] ?? reason;
}

function SearchableCombobox({
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled = false,
  testId,
  id,
  className = "",
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SearchableOption[];
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  disabled?: boolean;
  testId: string;
  id?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={placeholder}
          disabled={disabled}
          className={cn("h-10 w-full justify-between text-right font-normal", className)}
          data-testid={testId}
        >
          <span className="min-w-0 flex-1 truncate text-right" title={selected?.label}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronsUpDown className="me-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        dir="rtl"
        align="start"
        className="z-50 p-0"
        style={{ width: "var(--radix-popover-trigger-width)" }}
      >
        <Command
          dir="rtl"
          filter={(itemValue, search) =>
            itemValue.toLocaleLowerCase().includes(search.toLocaleLowerCase()) ? 1 : 0
          }
        >
          <CommandInput dir="rtl" placeholder={searchPlaceholder} className="h-10" />
          <CommandList className="max-h-64">
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.description ?? ""} ${option.searchText ?? ""} ${option.value}`}
                  onSelect={() => {
                    onValueChange(option.value);
                    setOpen(false);
                  }}
                  data-testid={option.testId}
                  className="gap-2"
                >
                  <Check className={`h-4 w-4 shrink-0 ${value === option.value ? "opacity-100" : "opacity-0"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {option.description && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default function DeletedRecordsRestore() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const [selectedCompanyKey, setSelectedCompanyKey] = useState("");
  const [tableFilter, setTableFilter] = useState("all");
  const [offset, setOffset] = useState(0);
  const [inspectRow, setInspectRow] = useState<DeletedRecord | null>(null);
  const [restoreRow, setRestoreRow] = useState<DeletedRecord | null>(null);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const headers = useMemo(() => ({
    Authorization: `Bearer ${token ?? ""}`,
    "Content-Type": "application/json",
  }), [token]);

  const companiesQuery = useQuery({
    queryKey: ["deleted-record-restore", "companies"],
    queryFn: async () => {
      const response = await fetch(`${API}/api/companies`, { headers });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error ?? "تعذر تحميل الشركات");
      return (Array.isArray(data) ? data : data.companies ?? []) as Company[];
    },
  });
  const companies = companiesQuery.data ?? [];
  const companyOptions = useMemo<SearchableOption[]>(
    () => companies.map((company) => {
      const databaseLabel = company.agentInstanceId != null
        ? `قاعدة الوكيل · ${company.agentName || company.agentInstanceId}`
        : "القاعدة المركزية";
      return {
        value: companyKey(company),
        label: company.nameAr || `شركة ${company.id}`,
        description: `${databaseLabel}${company.vatNumber ? ` · ${company.vatNumber}` : ""}`,
        searchText: [
          company.nameAr,
          company.nameEn,
          company.vatNumber,
          company.agentName,
          company.agentInstanceId,
          company.id,
          databaseLabel,
        ].filter(Boolean).join(" "),
        testId: `option-company-${companyKey(company)}`,
      };
    }),
    [companies],
  );
  const selectedCompany = companies.find((company) => companyKey(company) === selectedCompanyKey) ?? null;

  const recordsQuery = useQuery<RecycleResponse>({
    queryKey: ["deleted-record-restore", "records", selectedCompanyKey, tableFilter, offset],
    enabled: !!selectedCompany,
    queryFn: async () => {
      if (!selectedCompany) throw new Error("اختر الشركة أولاً");
      const params = new URLSearchParams({
        companyId: String(selectedCompany.id),
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (selectedCompany.agentInstanceId != null) params.set("agent", String(selectedCompany.agentInstanceId));
      if (tableFilter !== "all") params.set("table", tableFilter);
      const response = await fetch(`${API}/api/admin/data-doctor/recycle-bin?${params.toString()}`, { headers });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error ?? "تعذر تحميل السجلات المحذوفة");
      return data as RecycleResponse;
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (row: DeletedRecord) => {
      if (!selectedCompany || !row.restoreAllowed) throw new Error("لا يمكن استعادة هذا السجل");
      const params = new URLSearchParams();
      if (selectedCompany.agentInstanceId != null) params.set("agent", String(selectedCompany.agentInstanceId));
      const suffix = params.size ? `?${params.toString()}` : "";
      const response = await fetch(`${API}/api/admin/data-doctor/restore${suffix}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ids: [row.id], companyId: selectedCompany.id }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error ?? "فشلت استعادة السجل");
      return data as RestoreResponse;
    },
    onSuccess: async (data) => {
      const result = data.results?.[0];
      if (data.summary?.ok > 0 && result?.ok) {
        setNotice({ kind: "success", text: `تمت استعادة السجل ${restoreRow?.recordId ?? ""} بنجاح.` });
      } else {
        setNotice({ kind: "error", text: result?.reason ? eligibilityReason(result.reason) : "تعذرت استعادة السجل. لم يتم إجراء أي تغيير." });
      }
      setRestoreRow(null);
      await queryClient.invalidateQueries({ queryKey: ["deleted-record-restore", "records", selectedCompanyKey] });
    },
    onError: (error: Error) => setNotice({ kind: "error", text: error.message || "فشلت الاستعادة." }),
  });

  const rows = recordsQuery.data?.rows ?? [];
  const total = recordsQuery.data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const chooseCompany = (value: string) => {
    setSelectedCompanyKey(value);
    setTableFilter("all");
    setOffset(0);
    setNotice(null);
  };

  return (
    <main dir="rtl" className="min-h-[100dvh] bg-[#f2f5f3] px-4 py-6 text-[#18332f] sm:px-6 lg:px-9" data-testid="page-deleted-records-restore">
      <div className="mx-auto max-w-[1440px] space-y-5">
        <header className="relative overflow-hidden rounded-2xl border border-[#d5e2dd] bg-[#fbfdfb] px-5 py-6 shadow-[0_10px_30px_-24px_rgba(14,64,54,.45)] sm:px-7">
          <div className="absolute inset-y-0 right-0 w-1.5 bg-[#087e70]" />
          <div className="flex flex-col justify-between gap-5 md:flex-row md:items-center">
            <div className="flex items-start gap-4">
              <div className="mt-1 grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[#e3f1ec] text-[#087e70]">
                <ArchiveRestore className="h-6 w-6" />
              </div>
              <div>
                <div className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.16em] text-[#668078]">
                  <ShieldCheck className="h-3.5 w-3.5" /> وحدة استعادة المشرف العام
                </div>
                <h1 className="text-2xl font-extrabold tracking-tight sm:text-[28px]">استعادة السجلات المحذوفة</h1>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-[#60756e]">
                  ابحث في النسخ المحفوظة من قواعد البيانات المركزية وقواعد الوكلاء، وافحص سلامة السجل قبل استعادته.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 self-start rounded-lg border border-[#dce7e2] bg-[#f5f9f7] px-3 py-2 text-xs font-semibold text-[#55736a] md:self-auto">
              <Database className="h-4 w-4 text-[#087e70]" />
              قاعدة مركزية وقواعد الوكلاء
            </div>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]">
          <div className="rounded-xl border border-[#d9e4df] bg-[#fbfdfb] p-4 shadow-sm sm:p-5">
            <div className="mb-3 flex items-center justify-between">
              <label htmlFor="restore-company" className="text-sm font-bold">نطاق البحث</label>
              <span className="text-[11px] font-medium text-[#71857e]">مطلوب</span>
            </div>
            {companiesQuery.isLoading ? (
              <div className="h-10 animate-pulse rounded-md bg-[#e9f0ec]" />
            ) : companiesQuery.isError ? (
              <div className="rounded-lg border border-[#f0d3c9] bg-[#fff6f2] p-3 text-sm text-[#9c4d39]">
                <p className="mb-2">{(companiesQuery.error as Error).message}</p>
                <Button size="sm" variant="outline" onClick={() => void companiesQuery.refetch()} data-testid="button-retry-companies">
                  <RefreshCw className="ml-2 h-4 w-4" /> إعادة المحاولة
                </Button>
              </div>
            ) : (
              <SearchableCombobox
                id="restore-company"
                value={selectedCompanyKey}
                onValueChange={chooseCompany}
                options={companyOptions}
                placeholder="اختر الشركة وقاعدة البيانات"
                searchPlaceholder="ابحث باسم الشركة أو الرقم الضريبي أو قاعدة البيانات..."
                emptyText="لا توجد شركة مطابقة"
                disabled={companiesQuery.isLoading || companies.length === 0}
                className="h-11 border-[#cbdcd4] bg-white"
                testId="select-restore-company"
              />
            )}
            {selectedCompany && (
              <div className="mt-3 flex items-start gap-2 rounded-lg bg-[#f0f6f3] px-3 py-2.5 text-xs text-[#55736a]" data-testid="text-selected-database">
                <Database className="mt-0.5 h-4 w-4 shrink-0 text-[#087e70]" />
                <span><strong className="text-[#234b41]">{selectedCompany.nameAr}</strong><br />
                  {selectedCompany.agentInstanceId != null ? `قاعدة الوكيل: ${selectedCompany.agentName || selectedCompany.agentInstanceId}` : "قاعدة Zacode المركزية"}
                  <span className="mr-2 font-mono" dir="ltr">ID {selectedCompany.id}</span>
                </span>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-[#d9e4df] bg-[#fbfdfb] p-4 shadow-sm sm:p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold">تصفية السجلات</h2>
                <p className="mt-1 text-xs text-[#71857e]">يُحفظ نطاق الشركة مع معرّف قاعدة البيانات لتجنّب تعارض المعرّفات.</p>
              </div>
              <div className="hidden h-9 w-9 place-items-center rounded-lg bg-[#edf4f0] text-[#668078] sm:grid">
                <Search className="h-4 w-4" />
              </div>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <SearchableCombobox
                  value={tableFilter}
                  onValueChange={(value) => { setTableFilter(value); setOffset(0); }}
                  options={TABLE_FILTER_COMBOBOX_OPTIONS}
                  placeholder="كل أنواع السجلات"
                  searchPlaceholder="ابحث عن نوع السجل..."
                  emptyText="لا توجد أنواع سجلات مطابقة"
                  disabled={!selectedCompany}
                  className="border-[#cbdcd4] bg-white"
                  testId="select-table-filter"
                />
              </div>
              <Button variant="outline" className="h-10 border-[#cbdcd4] bg-white" disabled={!selectedCompany || recordsQuery.isFetching} onClick={() => void recordsQuery.refetch()} data-testid="button-refresh-records">
                {recordsQuery.isFetching ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <RefreshCw className="ml-2 h-4 w-4" />}
                تحديث النتائج
              </Button>
            </div>
          </div>
        </section>

        {notice && (
          <div role="status" data-testid="status-restore-result" className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${notice.kind === "success" ? "border-[#c5e2d2] bg-[#eef8f1] text-[#286747]" : "border-[#efd2c8] bg-[#fff5f1] text-[#9c4d39]"}`}>
            {notice.kind === "success" ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{notice.text}</span>
            <button type="button" className="mr-auto text-xs underline underline-offset-2" onClick={() => setNotice(null)} data-testid="button-dismiss-notice">إخفاء</button>
          </div>
        )}

        <section className="overflow-hidden rounded-xl border border-[#d9e4df] bg-[#fbfdfb] shadow-sm">
          <div className="flex flex-col justify-between gap-3 border-b border-[#e2ebe6] px-4 py-4 sm:flex-row sm:items-center sm:px-5">
            <div>
              <div className="flex items-center gap-2">
                <Layers3 className="h-4 w-4 text-[#087e70]" />
                <h2 className="text-base font-bold">سجل الاستعادة</h2>
                {selectedCompany && <Badge variant="outline" className="border-[#cbdcd4] bg-[#f2f7f4] text-[#55736a]">{total.toLocaleString("ar-SA-u-ca-gregory-nu-latn")} سجل</Badge>}
              </div>
              <p className="mt-1 text-xs text-[#71857e]">لا تظهر إجراءات الاستعادة إلا للسجلات المكتملة والمؤهلة.</p>
            </div>
            {selectedCompany && recordsQuery.data && total > 0 && (
              <div className="text-xs font-medium text-[#71857e]" data-testid="text-pagination-summary">
                عرض {offset + 1}–{Math.min(offset + rows.length, total)} من {total}
              </div>
            )}
          </div>

          {!selectedCompany ? (
            <div className="flex min-h-[300px] flex-col items-center justify-center px-5 text-center">
              <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-[#edf4f0] text-[#668078]"><Search className="h-6 w-6" /></div>
              <h3 className="font-bold">ابدأ باختيار قاعدة البيانات</h3>
              <p className="mt-1 max-w-md text-sm leading-6 text-[#71857e]">حدد الشركة أولاً لعرض سجلات سلة المحذوفات الخاصة بها فقط.</p>
            </div>
          ) : recordsQuery.isLoading ? (
            <div className="space-y-3 p-5" aria-label="جاري تحميل السجلات">
              {[0, 1, 2, 3].map((item) => <div key={item} className="h-[74px] animate-pulse rounded-lg bg-[#edf3ef]" />)}
            </div>
          ) : recordsQuery.isError ? (
            <div className="flex min-h-[260px] flex-col items-center justify-center px-5 text-center" data-testid="state-records-error">
              <div className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-[#fff0ea] text-[#b75a41]"><AlertTriangle className="h-5 w-5" /></div>
              <h3 className="font-bold">تعذر تحميل السجلات</h3>
              <p className="mt-1 max-w-md text-sm text-[#71857e]">{(recordsQuery.error as Error).message}</p>
              <Button className="mt-4" variant="outline" onClick={() => void recordsQuery.refetch()} data-testid="button-retry-records"><RefreshCw className="ml-2 h-4 w-4" /> حاول مرة أخرى</Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex min-h-[290px] flex-col items-center justify-center px-5 text-center" data-testid="state-records-empty">
              <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-[#edf4f0] text-[#668078]"><ArchiveRestore className="h-6 w-6" /></div>
              <h3 className="font-bold">لا توجد سجلات محذوفة هنا</h3>
              <p className="mt-1 max-w-md text-sm leading-6 text-[#71857e]">{tableFilter === "all" ? "لم يتم العثور على سجلات محذوفة لهذه الشركة." : "لا توجد سجلات من هذا النوع. جرّب اختيار نوع آخر."}</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] border-collapse text-right">
                  <thead className="bg-[#f3f7f4] text-[11px] font-bold text-[#698078]">
                    <tr>
                      <th className="px-5 py-3">السجل المحفوظ</th>
                      <th className="px-4 py-3">هوية المستند</th>
                      <th className="px-4 py-3">تاريخ الحذف</th>
                      <th className="px-4 py-3">بواسطة / المصدر</th>
                      <th className="px-4 py-3">سلامة الاستعادة</th>
                      <th className="px-5 py-3 text-center">الإجراء</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#e8efeb]">
                    {rows.map((row) => (
                      <tr key={row.id} className="transition-colors hover:bg-[#f7faf8]" data-testid={`row-deleted-record-${row.id}`}>
                        <td className="px-5 py-4">
                          <div className="font-bold text-[#294b42]">{row.tableLabel || row.tableName}</div>
                          <div className="mt-1 max-w-[350px] truncate text-xs text-[#71857e]" title={row.summary}>{row.summary || "بدون وصف محفوظ"}</div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#82948d]">
                            <span className="font-mono" dir="ltr">bin #{row.id}</span>
                            {row.lineCount != null && <span>{row.lineCount} بند</span>}
                            {row.restoredAt && <span>استعيد في {formatDate(row.restoredAt)}</span>}
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="font-semibold text-[#355b50]">{selectedCompany.nameAr}</div>
                          <div className="mt-1 text-xs text-[#71857e]">{row.tableLabel || row.tableName} <span className="mx-1">·</span> <span className="font-mono" dir="ltr">#{row.recordId}</span></div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-1.5 text-xs text-[#4f6b62]"><Clock3 className="h-3.5 w-3.5 text-[#81958d]" />{formatDate(row.deletedAt)}</div>
                          {row.reason && <div className="mt-1 max-w-[180px] truncate text-[10px] text-[#82948d]" title={row.reason}>{row.reason}</div>}
                        </td>
                        <td className="px-4 py-4 text-xs text-[#60756e]">
                          <div>{row.deletedByUsername || "غير محدد"}</div>
                          <div className="mt-1 text-[10px] text-[#82948d]">{row.source || "—"}</div>
                        </td>
                        <td className="px-4 py-4">
                          {row.restoreAllowed ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#c8e5d4] bg-[#eff8f2] px-2.5 py-1 text-[11px] font-bold text-[#28704a]"><ShieldCheck className="h-3.5 w-3.5" /> مؤهل للاستعادة</span>
                          ) : (
                            <div className="max-w-[230px]">
                              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#ead8b4] bg-[#fbf5e8] px-2.5 py-1 text-[11px] font-bold text-[#8c6827]"><AlertTriangle className="h-3.5 w-3.5" /> غير مؤهل</span>
                              <p className="mt-1.5 text-[11px] leading-5 text-[#806b45]" data-testid={`text-restore-reason-${row.id}`}>{eligibilityReason(row.restoreReason)}</p>
                            </div>
                          )}
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex justify-center gap-2">
                            <Button size="sm" variant="outline" className="h-8 border-[#d2e0d9] bg-white px-2.5 text-xs" onClick={() => setInspectRow(row)} data-testid={`button-inspect-${row.id}`}>
                              <FileJson2 className="ml-1.5 h-3.5 w-3.5" /> فحص النسخة
                            </Button>
                            {row.restoreAllowed && (
                              <Button size="sm" className="h-8 bg-[#087e70] px-2.5 text-xs text-white hover:bg-[#066b60]" disabled={restoreMutation.isPending} onClick={() => setRestoreRow(row)} data-testid={`button-restore-${row.id}`}>
                                <ArchiveRestore className="ml-1.5 h-3.5 w-3.5" /> استعادة
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <footer className="flex flex-col items-center justify-between gap-3 border-t border-[#e2ebe6] px-4 py-3 sm:flex-row sm:px-5">
                <span className="text-xs text-[#71857e]">الحد الأقصى للصفحة {PAGE_SIZE} سجل</span>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled={offset === 0 || recordsQuery.isFetching} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} data-testid="button-previous-page"><ChevronRight className="ml-1 h-4 w-4" /> السابق</Button>
                  <span className="min-w-[90px] text-center text-xs font-semibold text-[#60756e]" data-testid="text-page-number">صفحة {page} من {pageCount}</span>
                  <Button variant="outline" size="sm" disabled={offset + PAGE_SIZE >= total || recordsQuery.isFetching} onClick={() => setOffset(offset + PAGE_SIZE)} data-testid="button-next-page">التالي <ChevronLeft className="mr-1 h-4 w-4" /></Button>
                </div>
              </footer>
            </>
          )}
        </section>
      </div>

      <Dialog open={!!inspectRow} onOpenChange={(open) => { if (!open) setInspectRow(null); }}>
        <DialogContent dir="rtl" className="max-h-[88dvh] max-w-3xl overflow-hidden border-[#d5e2dd] bg-[#fbfdfb] p-0">
          <DialogHeader className="border-b border-[#e2ebe6] px-5 py-4 text-right">
            <DialogTitle className="flex items-center gap-2 text-[#254b41]"><FileJson2 className="h-5 w-5 text-[#087e70]" /> نسخة السجل المحفوظة</DialogTitle>
            <DialogDescription>
              {inspectRow && `${selectedCompany?.nameAr ?? "الشركة"} · ${inspectRow.tableLabel || inspectRow.tableName} · سجل #${inspectRow.recordId}`}
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-auto px-5 py-4">
            <div className="mb-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[#698078]">
              <span>حُذف في: {formatDate(inspectRow?.deletedAt)}</span>
              <span>بواسطة: {inspectRow?.deletedByUsername || "غير محدد"}</span>
              <span>المصدر: {inspectRow?.source || "—"}</span>
            </div>
            <pre dir="ltr" className="max-h-[55dvh] overflow-auto rounded-lg border border-[#dce7e2] bg-[#f0f5f2] p-4 text-left font-mono text-xs leading-6 text-[#294b42]" data-testid="payload-json">
              {inspectRow ? JSON.stringify(inspectRow.payload, null, 2) ?? "null" : ""}
            </pre>
          </div>
          <DialogFooter className="border-t border-[#e2ebe6] px-5 py-3">
            <Button variant="outline" onClick={() => setInspectRow(null)} data-testid="button-close-payload">إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!restoreRow} onOpenChange={(open) => { if (!open && !restoreMutation.isPending) setRestoreRow(null); }}>
        <DialogContent dir="rtl" className="max-w-lg border-[#d5e2dd] bg-[#fbfdfb]">
          <DialogHeader className="text-right">
            <div className="mb-1 grid h-10 w-10 place-items-center rounded-xl bg-[#e8f3ed] text-[#087e70]"><ArchiveRestore className="h-5 w-5" /></div>
            <DialogTitle>تأكيد استعادة سجل واحد</DialogTitle>
            <DialogDescription className="leading-6">
              ستتم محاولة استعادة سجل واحد فقط إلى قاعدة البيانات المحددة. تأكد من هوية الشركة والمستند قبل المتابعة.
            </DialogDescription>
          </DialogHeader>
          {restoreRow && selectedCompany && (
            <div className="space-y-2 rounded-lg border border-[#dce7e2] bg-[#f3f8f5] p-4 text-sm" data-testid="restore-confirm-identity">
              <div className="flex justify-between gap-3"><span className="text-[#71857e]">الشركة</span><strong>{selectedCompany.nameAr}</strong></div>
              <div className="flex justify-between gap-3"><span className="text-[#71857e]">قاعدة البيانات</span><strong>{selectedCompany.agentInstanceId != null ? `وكيل · ${selectedCompany.agentName || selectedCompany.agentInstanceId}` : "Zacode المركزية"}</strong></div>
              <div className="flex justify-between gap-3"><span className="text-[#71857e]">نوع المستند</span><strong>{restoreRow.tableLabel || restoreRow.tableName}</strong></div>
              <div className="flex justify-between gap-3"><span className="text-[#71857e]">معرّف المستند</span><strong className="font-mono" dir="ltr">#{restoreRow.recordId}</strong></div>
              <div className="flex justify-between gap-3"><span className="text-[#71857e]">وصف النسخة</span><strong className="max-w-[65%] text-left">{restoreRow.summary || "بدون وصف"}</strong></div>
              {restoreRow.lineCount != null && <div className="flex justify-between gap-3"><span className="text-[#71857e]">عدد البنود</span><strong>{restoreRow.lineCount}</strong></div>}
              <div className="flex justify-between gap-3"><span className="text-[#71857e]">معرّف النسخة</span><strong className="font-mono" dir="ltr">#{restoreRow.id}</strong></div>
            </div>
          )}
          <div className="flex items-start gap-2 rounded-lg border border-[#e9dfc5] bg-[#fbf7ec] p-3 text-xs leading-5 text-[#79683e]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            لن يتم تنفيذ الاستعادة إلا لهذا السجل، وبعد تحقق الخادم من إمكانية استعادته.
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={restoreMutation.isPending} onClick={() => setRestoreRow(null)} data-testid="button-cancel-restore">إلغاء</Button>
            <Button className="bg-[#087e70] text-white hover:bg-[#066b60]" disabled={!restoreRow?.restoreAllowed || restoreMutation.isPending} onClick={() => restoreRow && restoreMutation.mutate(restoreRow)} data-testid="button-confirm-restore">
              {restoreMutation.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <ArchiveRestore className="ml-2 h-4 w-4" />}
              تأكيد الاستعادة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}