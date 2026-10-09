import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDownRight,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  ChevronLeft,
  FileText,
  LoaderCircle,
  PackageCheck,
  Plus,
  ReceiptText,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { api, getStoredUser, type CreateReturnBody, type SalesInvoice, type SalesInvoiceLine } from "@/lib/api";

const money = (value: number | string | null | undefined, currency = "SAR") =>
  new Intl.NumberFormat("ar-SA", {
    style: "currency",
    currency: currency || "SAR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);

const number = (value: number | string | null | undefined) =>
  new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 3 }).format(Number(value) || 0);

const dateLabel = (value?: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("ar-SA", { year: "numeric", month: "short", day: "numeric" }).format(date);
};

const posted = (status?: string | null) => /posted|ترحيل|مرحّل|مرحل/i.test(status || "");

type ReturnLine = SalesInvoiceLine & { returnQty: number };

export default function ReturnsPage({
  embedded = false,
  onClose,
}: {
  embedded?: boolean;
  onClose?: () => void;
} = {}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<number | null>(null);
  const [returnLines, setReturnLines] = useState<ReturnLine[]>([]);
  const [returnDate, setReturnDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const companyId = getStoredUser()?.companyId ?? null;

  const invoicesQuery = useQuery({
    queryKey: ["sales-invoices", companyId, "pos", search.trim()],
    queryFn: () => {
      if (!companyId) throw new Error("لا توجد شركة مرتبطة بحسابك.");
      return api.listSalesInvoices(companyId, search.trim() || undefined, "pos");
    },
    enabled: !!companyId,
  });
  const returnsQuery = useQuery({
    queryKey: ["sales-returns", companyId, "pos"],
    queryFn: () => {
      if (!companyId) throw new Error("لا توجد شركة مرتبطة بحسابك.");
      return api.listSalesReturns(companyId, "pos");
    },
    enabled: !!companyId,
  });
  const invoiceQuery = useQuery({
    queryKey: ["sales-invoice", selectedInvoiceId],
    queryFn: () => api.getSalesInvoice(selectedInvoiceId!),
    enabled: selectedInvoiceId !== null,
  });
  const returnedByItemQuery = useQuery({
    queryKey: ["sales-invoice-returned-by-item", selectedInvoiceId],
    queryFn: () => api.getSalesInvoiceReturnedByItem(selectedInvoiceId!),
    enabled: selectedInvoiceId !== null,
  });
  const posSettingsQuery = useQuery({
    queryKey: ["pos-settings", companyId],
    queryFn: () => api.getPosSettings(companyId!),
    enabled: !!companyId,
  });

  const invoice = invoiceQuery.data;
  const maxReturnQty = (line: SalesInvoiceLine) => {
    const soldQty = Number(line.qty) || 0;
    if (line.itemId == null) return soldQty;
    const conversionFactor = Math.max(Number(line.conversionFactor) || 1, Number.EPSILON);
    const alreadyReturnedBaseQty = Number(returnedByItemQuery.data?.byItem[String(line.itemId)] ?? 0);
    const invoiceItemLines = invoice?.lines?.filter((candidate) => candidate.itemId === line.itemId) ?? [line];
    const soldBaseQty = invoiceItemLines.reduce(
      (sum, candidate) => sum + (Number(candidate.qty) || 0) * Math.max(Number(candidate.conversionFactor) || 1, Number.EPSILON),
      0,
    );
    const selectedOnOtherLines = returnLines
      .filter((candidate) => candidate.itemId === line.itemId && candidate.id !== line.id)
      .reduce(
        (sum, candidate) => sum + candidate.returnQty * Math.max(Number(candidate.conversionFactor) || 1, Number.EPSILON),
        0,
      );
    return Math.max(0, Math.min(soldQty, (soldBaseQty - alreadyReturnedBaseQty - selectedOnOtherLines) / conversionFactor));
  };
  const availableInvoices = useMemo(
    () => (invoicesQuery.data || []).filter((item) => posted(item.status)),
    [invoicesQuery.data],
  );
  const selectedQty = returnLines.reduce((sum, line) => sum + line.returnQty, 0);
  const totals = useMemo(() => {
    let subtotal = 0;
    let discount = 0;
    let vat = 0;
    let total = 0;
    returnLines.forEach((line) => {
      const qty = Math.min(maxReturnQty(line), Math.max(0, line.returnQty));
      const originalQty = Number(line.qty) || 0;
      if (!qty || !originalQty) return;
      const ratio = qty / originalQty;
      const gross = (Number(line.unitPrice) || 0) * qty;
      const lineDiscount = (Number(line.discount) || 0) * ratio;
      const taxable = Math.max(0, gross - lineDiscount);
      const rate = Number(line.vatRate) || 0;
      const lineVat = invoice?.priceIncludesVat
        ? taxable - taxable / (1 + rate / 100)
        : taxable * rate / 100;
      subtotal += gross;
      discount += lineDiscount;
      vat += lineVat;
      const originalLineTotal = Number(line.lineTotal) || 0;
      total += originalLineTotal * ratio;
    });
    return { subtotal, discount, vat, total };
  }, [returnLines, invoice?.priceIncludesVat, returnedByItemQuery.data]);

  const mutation = useMutation({
    mutationFn: async (body: CreateReturnBody) => {
      const created = await api.createSalesReturn(body);
      try {
        await api.postSalesReturn(created.id);
        return { ...created, posted: true };
      } catch (error) {
        return { ...created, posted: false, postError: error instanceof Error ? error.message : "تعذّر ترحيل المرتجع" };
      }
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sales-returns", companyId] }),
        queryClient.invalidateQueries({ queryKey: ["sales-invoices", companyId] }),
        queryClient.invalidateQueries({ queryKey: ["sales-invoice", selectedInvoiceId] }),
        queryClient.invalidateQueries({ queryKey: ["sales-invoice-returned-by-item", selectedInvoiceId] }),
      ]);
      setFeedback(result.posted
        ? { kind: "success", text: `تم إنشاء المرتجع ${result.docNumber || `#${result.id}`} وترحيله بنجاح.` }
        : { kind: "error", text: `تم حفظ المرتجع ${result.docNumber || `#${result.id}`} كمسودة، لكن تعذّر ترحيله: ${"postError" in result ? result.postError : "تعذّر الترحيل"}` });
      if (result.posted) {
        setReturnLines((current) => current.map((line) => ({ ...line, returnQty: 0 })));
        setNotes("");
      }
    },
    onError: (error) => setFeedback({ kind: "error", text: error instanceof Error ? error.message : "تعذّر إنشاء المرتجع." }),
  });

  const selectInvoice = (id: number) => {
    setSelectedInvoiceId(id);
    setFeedback(null);
  };

  const setQty = (id: number, value: number) => {
    if (!invoice?.lines || !returnedByItemQuery.isSuccess) return;
    const lines = returnLines.length
      ? returnLines
      : invoice.lines.map((line) => ({ ...line, returnQty: 0 }));
    setReturnLines(lines.map((line) =>
      line.id === id ? { ...line, returnQty: Math.min(maxReturnQty(line), Math.max(0, value || 0)) } : line,
    ));
  };

  const startReturn = (selected: SalesInvoice) => {
    selectInvoice(selected.id);
    setReturnDate(new Date().toISOString().slice(0, 10));
    setNotes("");
    setReturnLines([]);
  };

  const submitReturn = () => {
    if (!invoice || !selectedQty || mutation.isPending || !returnedByItemQuery.isSuccess) return;
    const lines = returnLines.filter((line) => line.returnQty > 0).map((line) => {
      const qty = line.returnQty;
      const originalQty = Number(line.qty) || 0;
      const ratio = originalQty ? qty / originalQty : 0;
      const discount = (Number(line.discount) || 0) * ratio;
      const lineTotal = (Number(line.lineTotal) || 0) * ratio;
      return {
        itemId: line.itemId,
        itemName: line.itemName,
        itemCode: line.itemCode ?? null,
        unit: line.unit ?? null,
        unitId: line.unitId ?? null,
        conversionFactor: Number(line.conversionFactor) || 1,
        warehouseId: line.warehouseId ?? null,
        qty,
        unitPrice: Number(line.unitPrice) || 0,
        discount,
        vatRate: Number(line.vatRate) || 0,
        lineTotal,
      };
    });
    const paymentType = invoice.paymentType === "bank" ? "bank" : invoice.paymentType === "credit" ? "credit" : "cash";
    const cashBoxId = invoice.cashBoxId ?? posSettingsQuery.data?.posCashCashBoxId ?? null;
    // A bank invoice's stored account is the source of truth: the app does not
    // persist whether it was card, Apple Pay, or wallet, so guessing a fallback
    // could send the refund to a different account.
    const bankAccountId = invoice.bankAccountId ?? null;
    if (paymentType === "cash" && !cashBoxId) {
      setFeedback({ kind: "error", text: "لا يوجد صندوق نقدي مرتبط بالفاتورة أو إعدادات نقاط البيع. اضبط صندوق POS قبل رد المبلغ نقداً." });
      return;
    }
    if (paymentType === "bank" && !bankAccountId) {
      setFeedback({ kind: "error", text: "الفاتورة لا تسجل الحساب البنكي الأصلي، لذلك لم يُنشأ المرتجع لتجنب تحويل المبلغ إلى حساب غير صحيح. راجع بيانات الفاتورة في مسار المبيعات ثم أعد المحاولة." });
      return;
    }
    mutation.mutate({
      returnDate,
      customerId: invoice.customerId ?? null,
      branchId: invoice.branchId ?? null,
      invoiceId: invoice.id,
      paymentType,
      cashBoxId,
      bankAccountId,
      currencyCode: invoice.currencyCode || "SAR",
      totalAmount: totals.total,
      vatAmount: totals.vat,
      discountAmount: totals.discount,
      priceIncludesVat: !!invoice.priceIncludesVat,
      notes: notes.trim() || null,
      lines,
    });
  };

  return (
    <div
      className={embedded ? "fixed inset-0 z-[70] overflow-y-auto bg-slate-950/60 p-2 sm:p-5" : undefined}
      role={embedded ? "dialog" : undefined}
      aria-modal={embedded ? true : undefined}
      aria-label={embedded ? "إنشاء مرتجع من فاتورة نقاط البيع" : undefined}
      onMouseDown={embedded ? (event) => {
        if (event.target === event.currentTarget) onClose?.();
      } : undefined}
    >
    <main
      dir="rtl"
      className={`${embedded ? "mx-auto max-w-[1500px] overflow-hidden rounded-2xl shadow-2xl" : "min-h-[100dvh]"} bg-[#f2f7f5] text-slate-900`}
    >
      <header className="sticky top-0 z-20 border-b border-emerald-950/10 bg-[#f8fbf9]/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-4 py-3 md:px-7">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-2xl bg-[#087c68] text-white shadow-md shadow-emerald-900/15">
              <ArrowRightLeft size={21} strokeWidth={2.2} />
            </div>
            <div>
              <p className="text-xs font-bold tracking-wide text-[#087c68]">زاكود POS <span className="mx-1 text-slate-300">/</span> عمليات البيع</p>
              <h1 className="text-lg font-extrabold leading-tight md:text-xl">مرتجعات المبيعات</h1>
            </div>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-emerald-900/10 bg-white/70 px-3 py-2 text-xs font-bold text-slate-600 sm:flex">
            <ShieldCheck size={15} className="text-[#087c68]" />
            <span>مرتبطة بالفاتورة الأصلية</span>
          </div>
          <div className="flex size-9 items-center justify-center rounded-xl border border-emerald-950/10 bg-white text-[#087c68] sm:hidden">
            <ShieldCheck size={17} />
          </div>
          {embedded && onClose && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-emerald-950/10 bg-white px-3 text-xs font-bold text-slate-700 hover:bg-slate-50"
              aria-label="إغلاق نافذة المرتجع"
              data-testid="button-close-returns-dialog"
            >
              <X size={15} />
              إغلاق
            </button>
          )}
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] px-4 pb-8 pt-5 md:px-7 md:pt-7">
        <div className="mb-5 flex flex-col justify-between gap-3 md:flex-row md:items-end">
          <div>
            <p className="mb-1 text-xs font-extrabold uppercase tracking-[.14em] text-[#b16e23]">إجراء مضبوط • سجل قابل للتتبع</p>
            <h2 className="text-2xl font-black tracking-tight md:text-[30px]">ابدأ المرتجع من فاتورة مُرحّلة</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">اختر الفاتورة، حدّد الكميات المستردة، ثم احفظ المرتجع وارحّله ضمن دورة المبيعات.</p>
          </div>
          <div className="flex items-center gap-2 rounded-2xl border border-emerald-950/10 bg-white px-4 py-3 shadow-sm">
            <span className="grid size-9 place-items-center rounded-xl bg-[#e5f3ef] text-[#087c68]"><ReceiptText size={18} /></span>
            <div>
              <p className="text-[11px] font-bold text-slate-500">مرتجعات مسجلة</p>
              <p className="font-mono text-lg font-black tabular-nums" data-testid="text-returns-count">{number(returnsQuery.data?.length ?? 0)}</p>
            </div>
          </div>
        </div>

        {!companyId && (
          <div className="mb-4 flex items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900" data-testid="status-company-error">
            <AlertCircle size={18} /> لا توجد شركة مرتبطة بحسابك. يرجى تسجيل الدخول بحساب نقطة بيع تابع لشركة.
          </div>
        )}
        {feedback && (
          <div className={`mb-4 flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm font-bold ${feedback.kind === "success" ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-rose-300 bg-rose-50 text-rose-900"}`} role="status" data-testid="status-return-feedback">
            {feedback.kind === "success" ? <CheckCircle2 size={19} className="mt-0.5 shrink-0" /> : <AlertCircle size={19} className="mt-0.5 shrink-0" />}
            <span className="flex-1 leading-6">{feedback.text}</span>
            <button type="button" onClick={() => setFeedback(null)} aria-label="إغلاق التنبيه" className="rounded-lg p-1 opacity-70 hover:bg-black/5 hover:opacity-100" data-testid="button-dismiss-feedback"><X size={16} /></button>
          </div>
        )}

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="min-w-0 rounded-[24px] border border-emerald-950/10 bg-white shadow-[0_12px_40px_-28px_rgba(8,70,57,.35)]">
            <div className="flex flex-col gap-4 border-b border-slate-100 p-4 md:flex-row md:items-center md:justify-between md:px-6 md:py-5">
              <div>
                <div className="flex items-center gap-2">
                  <span className="grid size-8 place-items-center rounded-xl bg-[#e8f4f0] text-[#087c68]"><Search size={16} /></span>
                  <h3 className="font-extrabold">البحث عن فاتورة بيع</h3>
                </div>
                <p className="mt-1 text-xs text-slate-500">تظهر الفواتير المُرحّلة فقط لبدء عملية الإرجاع.</p>
              </div>
              <label className="relative block w-full md:max-w-[360px]">
                <Search size={17} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="رقم الفاتورة أو اسم العميل"
                  className="h-11 w-full rounded-xl border border-slate-200 bg-[#f9fbfa] pr-10 pl-4 text-sm outline-none transition focus:border-[#087c68] focus:ring-4 focus:ring-emerald-800/10"
                  aria-label="البحث عن فاتورة"
                  data-testid="input-invoice-search"
                />
                {search && <button type="button" onClick={() => setSearch("")} className="absolute left-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 hover:bg-slate-100" aria-label="مسح البحث" data-testid="button-clear-search"><X size={15} /></button>}
              </label>
            </div>
            <div className="p-3 md:p-5">
              {invoicesQuery.isLoading ? (
                <div className="space-y-3 py-2" data-testid="loading-invoices">
                  {[0, 1, 2].map((item) => <div key={item} className="h-[76px] animate-pulse rounded-2xl bg-slate-100" />)}
                </div>
              ) : invoicesQuery.isError ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50/70 px-5 py-8 text-center" data-testid="state-invoices-error">
                  <AlertCircle className="mx-auto mb-2 text-rose-600" size={24} />
                  <p className="font-extrabold text-rose-900">تعذّر تحميل الفواتير</p>
                  <p className="mt-1 text-sm text-rose-800">{invoicesQuery.error instanceof Error ? invoicesQuery.error.message : "تحقق من الاتصال ثم أعد المحاولة."}</p>
                  <button type="button" onClick={() => invoicesQuery.refetch()} className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-rose-700 px-4 text-sm font-bold text-white transition hover:bg-rose-800" data-testid="button-retry-invoices"><RefreshCw size={15} /> إعادة المحاولة</button>
                </div>
              ) : availableInvoices.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-[#f9fbfa] px-5 py-10 text-center" data-testid="state-invoices-empty">
                  <span className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-white text-[#087c68] shadow-sm"><FileText size={22} /></span>
                  <p className="font-extrabold">لا توجد فواتير مُرحّلة مطابقة</p>
                  <p className="mt-1 text-sm text-slate-500">{search ? "تحقق من رقم الفاتورة أو اسم العميل." : "ستظهر هنا الفواتير التي يمكن إنشاء مرتجع لها."}</p>
                </div>
              ) : (
                <div className="space-y-2" data-testid="list-posted-invoices">
                  {availableInvoices.map((item) => {
                    const active = selectedInvoiceId === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => startReturn(item)}
                        className={`group grid w-full grid-cols-[1fr_auto] items-center gap-3 rounded-2xl border p-3 text-right transition duration-150 hover:-translate-y-px hover:border-emerald-700/40 hover:shadow-sm sm:grid-cols-[minmax(160px,1fr)_minmax(120px,.8fr)_minmax(100px,.7fr)_auto] sm:px-4 ${active ? "border-[#087c68] bg-[#eff8f5] ring-2 ring-emerald-800/10" : "border-slate-200 bg-white"}`}
                        data-testid={`button-select-invoice-${item.id}`}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${active ? "bg-[#087c68] text-white" : "bg-slate-100 text-slate-600 group-hover:bg-[#e5f3ef] group-hover:text-[#087c68]"}`}><ReceiptText size={18} /></span>
                          <span className="min-w-0">
                            <span className="block truncate font-mono text-sm font-black" data-testid={`text-invoice-number-${item.id}`}>{item.docNumber || `#${item.id}`}</span>
                            <span className="mt-0.5 block truncate text-xs text-slate-500" data-testid={`text-invoice-customer-${item.id}`}>{item.customerName || "عميل نقدي"}</span>
                          </span>
                        </div>
                        <span className="hidden text-xs text-slate-500 sm:block" data-testid={`text-invoice-date-${item.id}`}>{dateLabel(item.invoiceDate)}</span>
                        <span className="hidden text-sm font-extrabold tabular-nums sm:block" data-testid={`text-invoice-total-${item.id}`}>{money(item.totalAmount, item.currencyCode)}</span>
                        <span className="flex items-center justify-end gap-2">
                          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-extrabold text-emerald-800">مُرحّلة</span>
                          <ChevronLeft size={17} className={`text-slate-400 transition-transform ${active ? "-translate-x-0.5 text-[#087c68]" : "group-hover:-translate-x-0.5"}`} />
                        </span>
                        <span className="col-span-2 -mt-1 text-xs font-bold text-slate-500 sm:hidden">{dateLabel(item.invoiceDate)} <span className="mx-1">·</span>{money(item.totalAmount, item.currencyCode)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <aside className="rounded-[24px] border border-emerald-950/10 bg-[#e9f3ef] p-4 md:p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-[11px] font-extrabold tracking-wide text-[#087c68]">مراجعة الاسترداد</p>
                <h3 className="mt-0.5 text-lg font-black">المرتجع الجديد</h3>
              </div>
              <span className="grid size-10 place-items-center rounded-xl bg-white text-[#087c68] shadow-sm"><PackageCheck size={19} /></span>
            </div>
            {!selectedInvoiceId ? (
              <div className="rounded-2xl border border-dashed border-emerald-900/20 bg-white/70 px-4 py-8 text-center" data-testid="state-return-unselected">
                <ArrowDownRight className="mx-auto mb-2 text-[#087c68]" size={24} />
                <p className="font-extrabold">اختر فاتورة للمتابعة</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">سيتم ربط المرتجع مباشرةً بالفاتورة المحددة.</p>
              </div>
            ) : invoiceQuery.isLoading ? (
              <div className="space-y-3 rounded-2xl bg-white p-4" data-testid="loading-invoice-detail">
                <div className="h-4 w-2/3 animate-pulse rounded bg-slate-100" />
                <div className="h-10 animate-pulse rounded-xl bg-slate-100" />
                <div className="h-10 animate-pulse rounded-xl bg-slate-100" />
              </div>
            ) : invoiceQuery.isError ? (
              <div className="rounded-2xl border border-rose-200 bg-white p-4 text-sm" data-testid="state-invoice-detail-error">
                <p className="font-bold text-rose-800">تعذّر تحميل تفاصيل الفاتورة.</p>
                <button type="button" onClick={() => invoiceQuery.refetch()} className="mt-3 text-sm font-extrabold text-[#087c68] underline underline-offset-4" data-testid="button-retry-invoice-detail">إعادة المحاولة</button>
              </div>
            ) : invoice ? (
              <div className="space-y-4" data-testid="panel-return-draft">
                <div className="rounded-2xl border border-emerald-900/10 bg-white p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div><p className="text-[10px] font-bold text-slate-500">الفاتورة الأصلية</p><p className="mt-0.5 font-mono text-sm font-black" data-testid="text-selected-invoice">{invoice.docNumber || `#${invoice.id}`}</p></div>
                    <span className="rounded-lg bg-emerald-50 px-2 py-1 text-[10px] font-extrabold text-emerald-800">مُرحّلة</span>
                  </div>
                  <div className="mt-3 flex justify-between border-t border-slate-100 pt-2.5 text-xs">
                    <span className="text-slate-500">{invoice.customerName || "عميل نقدي"}</span>
                    <span className="font-bold">{money(invoice.totalAmount, invoice.currencyCode)}</span>
                  </div>
                </div>

                {invoice.lines?.length ? (
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-sm font-extrabold">الأصناف والكميات</p>
                      <span className="text-[10px] font-bold text-slate-500">المتبقي بعد المرتجعات السابقة</span>
                    </div>
                    {!returnedByItemQuery.isSuccess && (
                      <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800" role="status" data-testid="status-return-quantity-check">
                        {returnedByItemQuery.isError ? "تعذّر التحقق من الكميات المرتجعة سابقاً؛ أعد المحاولة قبل المتابعة." : "جارٍ التحقق من الكميات المرتجعة سابقاً..."}
                        {returnedByItemQuery.isError && <button type="button" onClick={() => returnedByItemQuery.refetch()} className="ms-2 underline underline-offset-2" data-testid="button-retry-return-quantity">إعادة المحاولة</button>}
                      </p>
                    )}
                    <div className="max-h-[340px] space-y-2 overflow-y-auto pl-0.5">
                      {returnLines.length === 0 && invoice.lines.map((line) => ({ ...line, returnQty: 0 })).map((line) => (
                        <div key={line.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-white p-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-extrabold" data-testid={`text-return-item-${line.id}`}>{line.itemName}</p>
                            <p className="mt-0.5 text-[11px] text-slate-500">{line.itemCode || "—"} <span className="mx-1">·</span> المتبقي {number(maxReturnQty(line))} من {number(line.qty)} {line.unit || ""}</p>
                          </div>
                          <div className="flex h-9 shrink-0 items-center overflow-hidden rounded-lg border border-slate-200 bg-[#fafcfb]">
                          <button type="button" onClick={() => setQty(line.id, (returnLines.find((l) => l.id === line.id)?.returnQty ?? 0) - 1)} disabled={!returnedByItemQuery.isSuccess || !(returnLines.find((l) => l.id === line.id)?.returnQty ?? 0)} className="grid size-8 place-items-center text-slate-500 hover:bg-slate-100 disabled:opacity-30" aria-label={`تقليل كمية ${line.itemName}`} data-testid={`button-decrease-return-${line.id}`}><X size={14} /></button>
                            <input
                              type="number"
                              min="0"
                              max={maxReturnQty(line)}
                              step="any"
                              value={returnLines.find((l) => l.id === line.id)?.returnQty ?? ""}
                              onChange={(event) => setQty(line.id, Number(event.target.value))}
                              placeholder="0"
                              className="w-12 border-x border-slate-200 bg-transparent text-center font-mono text-sm font-black outline-none"
                              aria-label={`كمية إرجاع ${line.itemName}`}
                              data-testid={`input-return-qty-${line.id}`}
                              disabled={!returnedByItemQuery.isSuccess || maxReturnQty(line) <= 0}
                            />
                            <button type="button" onClick={() => setQty(line.id, (returnLines.find((l) => l.id === line.id)?.returnQty ?? 0) + 1)} disabled={!returnedByItemQuery.isSuccess || maxReturnQty(line) <= (returnLines.find((l) => l.id === line.id)?.returnQty ?? 0)} className="grid size-8 place-items-center text-[#087c68] hover:bg-emerald-50 disabled:opacity-30" aria-label={`زيادة كمية ${line.itemName}`} data-testid={`button-increase-return-${line.id}`}><Plus size={15} /></button>
                          </div>
                        </div>
                      ))}
                      {returnLines.length > 0 && returnLines.map((line) => (
                        <div key={line.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-white p-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-extrabold" data-testid={`text-return-item-${line.id}`}>{line.itemName}</p>
                            <p className="mt-0.5 text-[11px] text-slate-500">{line.itemCode || "—"} <span className="mx-1">·</span> المتبقي {number(maxReturnQty(line))} من {number(line.qty)} {line.unit || ""}</p>
                          </div>
                          <div className="flex h-9 shrink-0 items-center overflow-hidden rounded-lg border border-slate-200 bg-[#fafcfb]">
                            <button type="button" onClick={() => setQty(line.id, line.returnQty - 1)} disabled={!returnedByItemQuery.isSuccess || line.returnQty <= 0} className="grid size-8 place-items-center text-slate-500 hover:bg-slate-100 disabled:opacity-30" aria-label={`تقليل كمية ${line.itemName}`} data-testid={`button-decrease-return-${line.id}`}><X size={14} /></button>
                            <input type="number" min="0" max={maxReturnQty(line)} step="any" value={line.returnQty || ""} placeholder="0" onChange={(event) => setQty(line.id, Number(event.target.value))} className="w-12 border-x border-slate-200 bg-transparent text-center font-mono text-sm font-black outline-none" aria-label={`كمية إرجاع ${line.itemName}`} data-testid={`input-return-qty-${line.id}`} disabled={!returnedByItemQuery.isSuccess || maxReturnQty(line) <= 0} />
                            <button type="button" onClick={() => setQty(line.id, line.returnQty + 1)} disabled={!returnedByItemQuery.isSuccess || line.returnQty >= maxReturnQty(line)} className="grid size-8 place-items-center text-[#087c68] hover:bg-emerald-50 disabled:opacity-30" aria-label={`زيادة كمية ${line.itemName}`} data-testid={`button-increase-return-${line.id}`}><Plus size={15} /></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-500" data-testid="state-no-invoice-lines">لا تحتوي الفاتورة على تفاصيل أصناف متاحة.</div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[11px] font-bold text-slate-600">تاريخ المرتجع
                    <input type="date" value={returnDate} onChange={(event) => setReturnDate(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm font-bold text-slate-800 outline-none focus:border-[#087c68] focus:ring-2 focus:ring-emerald-800/10" data-testid="input-return-date" />
                  </label>
                  <label className="text-[11px] font-bold text-slate-600">الكمية المحددة
                    <span className="mt-1 flex h-10 items-center rounded-lg border border-slate-200 bg-white px-3 font-mono text-sm font-black text-[#087c68]" data-testid="text-selected-qty">{number(selectedQty)}</span>
                  </label>
                </div>
                <label className="block text-[11px] font-bold text-slate-600">ملاحظات
                  <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} placeholder="سبب الإرجاع أو ملاحظة للمراجعة" className="mt-1 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium outline-none placeholder:text-slate-400 focus:border-[#087c68] focus:ring-2 focus:ring-emerald-800/10" data-testid="input-return-notes" />
                </label>

                <div className="rounded-2xl bg-[#123d36] p-4 text-white">
                  <div className="flex items-center justify-between text-xs text-emerald-100/75"><span>قيمة الأصناف</span><span className="font-mono tabular-nums">{money(totals.subtotal, invoice.currencyCode)}</span></div>
                  <div className="mt-2 flex items-center justify-between text-xs text-emerald-100/75"><span>الخصم والضريبة</span><span className="font-mono tabular-nums">−{money(totals.discount, invoice.currencyCode)} <span className="mx-1">/</span> {money(totals.vat, invoice.currencyCode)}</span></div>
                  <div className="mt-3 flex items-end justify-between border-t border-white/15 pt-3">
                    <span className="text-sm font-bold">إجمالي المرتجع</span>
                    <strong className="font-mono text-xl font-black tabular-nums" data-testid="text-return-total">{money(totals.total, invoice.currencyCode)}</strong>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={submitReturn}
                  disabled={!selectedQty || mutation.isPending || !invoice.lines?.length || !returnedByItemQuery.isSuccess}
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#087c68] px-4 text-sm font-extrabold text-white shadow-md shadow-emerald-900/15 transition hover:bg-[#066a59] active:scale-[.99] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
                  data-testid="button-create-post-return"
                >
                  {mutation.isPending ? <><LoaderCircle size={17} className="animate-spin" /> جارٍ الحفظ والترحيل</> : <><Check size={18} /> إنشاء المرتجع وترحيله</>}
                </button>
                <p className="text-center text-[10px] leading-4 text-slate-500">سيُحفظ المرتجع مرتبطاً بالفاتورة الأصلية ثم يُرحّل عبر دورة المبيعات.</p>
              </div>
            ) : null}
          </aside>
        </div>

        <section className="mt-6 overflow-hidden rounded-[24px] border border-emerald-950/10 bg-white shadow-[0_12px_40px_-28px_rgba(8,70,57,.35)]">
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-4 md:px-6">
            <div>
              <div className="flex items-center gap-2">
                <span className="grid size-8 place-items-center rounded-xl bg-[#fff4e5] text-[#a96517]"><ReceiptText size={16} /></span>
                <h3 className="font-extrabold">سجل مرتجعات المبيعات</h3>
              </div>
              <p className="mt-1 text-xs text-slate-500">المرتجعات القائمة كما هي مسجلة في النظام.</p>
            </div>
            <button type="button" onClick={() => returnsQuery.refetch()} disabled={returnsQuery.isFetching} className="grid size-9 place-items-center rounded-xl border border-slate-200 text-slate-600 transition hover:bg-slate-50 disabled:opacity-50" title="تحديث السجل" aria-label="تحديث سجل المرتجعات" data-testid="button-refresh-returns"><RefreshCw size={16} className={returnsQuery.isFetching ? "animate-spin" : ""} /></button>
          </div>
          {returnsQuery.isLoading ? (
            <div className="space-y-2 p-4" data-testid="loading-returns">{[1, 2].map((n) => <div key={n} className="h-12 animate-pulse rounded-lg bg-slate-100" />)}</div>
          ) : returnsQuery.isError ? (
            <div className="px-5 py-8 text-center" data-testid="state-returns-error">
              <p className="font-bold text-rose-800">تعذّر تحميل سجل المرتجعات.</p>
              <button type="button" onClick={() => returnsQuery.refetch()} className="mt-2 text-sm font-extrabold text-[#087c68] underline underline-offset-4" data-testid="button-retry-returns">إعادة المحاولة</button>
            </div>
          ) : !returnsQuery.data?.length ? (
            <div className="px-5 py-9 text-center" data-testid="state-returns-empty">
              <span className="mx-auto mb-2 grid size-11 place-items-center rounded-2xl bg-[#f1f6f4] text-slate-400"><ReceiptText size={20} /></span>
              <p className="font-extrabold">لا توجد مرتجعات مسجلة بعد</p>
              <p className="mt-1 text-xs text-slate-500">ستظهر هنا المستندات المنشأة في النظام.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px] text-right text-sm">
                <thead className="bg-[#f8faf9] text-[11px] font-extrabold text-slate-500">
                  <tr><th className="px-5 py-3">رقم المستند</th><th className="px-5 py-3">الفاتورة المصدر</th><th className="px-5 py-3">التاريخ</th><th className="px-5 py-3">الحالة</th><th className="px-5 py-3">الإجمالي</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {returnsQuery.data.map((item) => (
                    <tr key={item.id} className="transition hover:bg-[#fafcfb]" data-testid={`row-return-${item.id}`}>
                      <td className="px-5 py-3.5 font-mono font-black" data-testid={`text-return-number-${item.id}`}>{item.docNumber || `#${item.id}`}</td>
                      <td className="px-5 py-3.5 font-mono font-semibold" data-testid={`text-return-source-invoice-${item.id}`}>{item.invoiceId ? `#${item.invoiceId}` : "—"}</td>
                      <td className="px-5 py-3.5 text-slate-600" data-testid={`text-return-date-${item.id}`}>{dateLabel(item.returnDate)}</td>
                      <td className="px-5 py-3.5"><span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-extrabold ${posted(item.status) ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`} data-testid={`status-return-${item.id}`}>{posted(item.status) ? <><CheckCircle2 size={12} /> مُرحّل</> : "مسودة"}</span></td>
                      <td className="px-5 py-3.5 font-mono font-bold tabular-nums">{money(item.totalAmount, item.currencyCode ?? undefined)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
    </div>
  );
}
