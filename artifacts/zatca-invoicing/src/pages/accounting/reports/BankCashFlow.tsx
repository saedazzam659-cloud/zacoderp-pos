import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFmt } from "@/hooks/use-fmt";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SearchCombobox } from "@/components/ui/search-combobox";
import BranchFilter from "@/components/BranchFilter";
import ExportButtons from "@/components/ExportButtons";
import { type ExportColumn } from "@/lib/export";
import {
  Landmark, Search, Printer, ArrowDownToLine, ArrowUpFromLine,
  Wallet, CheckCircle2, AlertTriangle, BarChart3, TrendingUp,
  FileText, Layers, Inbox, ChevronLeft, Loader2,
} from "lucide-react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
} from "recharts";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Buckets = Record<string, number> & { total: number };
type CashFlowResponse = {
  banks: { id: number; code: string; nameAr: string; nameEn: string | null; bankName: string | null; accountId: number | null }[];
  opening: number;
  deposits: Buckets;
  outflows: Buckets;
  closing: number;
  bookClosing: number;
  monthly: { month: string; opening: number; deposits: Buckets; outflows: Buckets; closing: number }[];
};

// Drill-down target: which cash-flow figure the user clicked to inspect.
type DrillState = { direction: "deposit" | "outflow"; category: string; label: string; color: string; amount: number };

// Friendly Arabic labels for the source-document type of each contributing entry.
const ENTRY_TYPE_AR: Record<string, string> = {
  sales_invoice: "فاتورة مبيعات", pos_sale: "نقطة بيع",
  receipt: "سند قبض", receipt_voucher: "سند قبض",
  payment: "سند صرف", payment_voucher: "سند صرف",
  payroll_run: "مسير رواتب", eos_payment: "نهاية الخدمة", employee_loan: "سلفة موظف",
  general: "قيد يومية", opening_balance: "رصيد افتتاحي",
};
const entryTypeLabel = (t: string | null, isRtl: boolean) =>
  isRtl ? (ENTRY_TYPE_AR[t ?? ""] ?? (t || "قيد")) : (t || "Entry");

// Deposit categories (incoming) — order + label + tone for the analysis table.
const DEPOSIT_CATS: { key: string; ar: string; en: string; tone: string; color: string }[] = [
  { key: "sales",       ar: "إيداع مبيعات",        en: "Sales deposits",      tone: "text-sky-700",     color: "#0284c7" },
  { key: "customers",   ar: "إيداع من عملاء",       en: "Customer deposits",   tone: "text-emerald-700", color: "#059669" },
  { key: "partner",     ar: "إيداع من شريك / رأس المال", en: "Partner / capital", tone: "text-violet-700", color: "#7c3aed" },
  { key: "transfersIn", ar: "تحويلات واردة",        en: "Incoming transfers",  tone: "text-teal-700",    color: "#0d9488" },
  { key: "other",       ar: "إيداعات أخرى",         en: "Other deposits",      tone: "text-slate-600",   color: "#64748b" },
];
const OUTFLOW_CATS: { key: string; ar: string; en: string; tone: string; color: string }[] = [
  { key: "salaries",     ar: "سداد رواتب",          en: "Salaries",            tone: "text-rose-700",    color: "#e11d48" },
  { key: "suppliers",    ar: "سداد موردين",         en: "Suppliers",           tone: "text-amber-700",   color: "#d97706" },
  { key: "serviceBills", ar: "سداد فواتير خدمات",    en: "Service bills",       tone: "text-orange-700",  color: "#ea580c" },
  { key: "transfersOut", ar: "تحويلات صادرة",       en: "Outgoing transfers",  tone: "text-teal-700",    color: "#14b8a6" },
  { key: "other",        ar: "استخدامات أخرى",       en: "Other uses",          tone: "text-slate-600",   color: "#94a3b8" },
];

export default function BankCashFlow() {
  const { user, token } = useAuth() as any;
  const { fmt, isRtl } = useFormatters();
  const { dp } = useFmt();
  const moneyFmt = dp > 0 ? `#,##0.${"0".repeat(dp)}` : "#,##0";
  const { toast } = useToast();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}` };

  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = today.slice(0, 8) + "01";

  // mode = "treasury" (cash & banks) | "ledger" (any chart-of-accounts account).
  const [mode, setMode]         = useState<"treasury" | "ledger">("treasury");
  const [accountId, setAccountId] = useState(""); // GL account id ("" = all, treasury only)
  const [fromDate, setFromDate] = useState(firstOfMonth);
  const [toDate, setToDate]     = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [monthly, setMonthly]   = useState(false);
  const [searched, setSearched] = useState(false);
  const [drill, setDrill] = useState<DrillState | null>(null);

  const { data: banks = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/bank-accounts?companyId=${cid}` : `${API}/api/bank-accounts`;
      const res = await fetch(url, { headers });
      const j = await res.json();
      return Array.isArray(j) ? j : [];
    },
    enabled: !!user,
  });

  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/cash-boxes?companyId=${cid}` : `${API}/api/cash-boxes`;
      const res = await fetch(url, { headers });
      const j = await res.json();
      return Array.isArray(j) ? j : [];
    },
    enabled: !!user,
  });

  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["accounts-coa", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const res = await fetch(url, { headers });
      const j = await res.json();
      return Array.isArray(j) ? j : [];
    },
    enabled: !!user,
  });

  const { data, isLoading, refetch } = useQuery<CashFlowResponse>({
    queryKey: ["bank-cash-flow", cid, mode, accountId, fromDate, toDate, branchId, monthly],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid)        params.set("companyId", String(cid));
      params.set("mode", mode);
      if (accountId)  params.set("accountId", accountId);
      if (fromDate)   params.set("fromDate", fromDate);
      if (toDate)     params.set("toDate", toDate);
      if (branchId)   params.set("branchId", String(branchId));
      if (monthly)    params.set("monthly", "true");
      const res = await fetch(`${API}/api/accounting-reports/bank-cash-flow?${params}`, { headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    enabled: searched,
  });

  const opening   = data?.opening ?? 0;
  const deposits  = data?.deposits ?? ({ total: 0 } as Buckets);
  const outflows  = data?.outflows ?? ({ total: 0 } as Buckets);
  const closing   = data?.closing ?? 0;
  const monthlyRows = data?.monthly ?? [];
  // ── Account picker items ──────────────────────────────────────────────────
  // Treasury mode: registered bank accounts + cash boxes, each mapped to its GL
  // account id (deduped). Ledger mode: every posting account from the chart.
  const treasuryRaw = [
    ...banks.filter((b: any) => b.accountId).map((b: any) => ({
      value: String(b.accountId),
      label: `${b.code} — ${isRtl ? b.nameAr : (b.nameEn || b.nameAr)}`,
      badge: isRtl ? "بنك" : "Bank",
      badgeClass: "bg-blue-50 text-blue-700 border-blue-200",
    })),
    ...cashBoxes.filter((c: any) => c.accountId).map((c: any) => ({
      value: String(c.accountId),
      label: `${c.code} — ${isRtl ? c.nameAr : (c.nameEn || c.nameAr)}`,
      badge: isRtl ? "صندوق" : "Cash",
      badgeClass: "bg-emerald-50 text-emerald-700 border-emerald-200",
    })),
  ];
  const treasurySeen = new Set<string>();
  const treasuryItems = [
    { value: "", label: isRtl ? "كل حسابات النقد والبنوك" : "All cash & banks" },
    ...treasuryRaw.filter((it) => {
      if (treasurySeen.has(it.value)) return false;
      treasurySeen.add(it.value);
      return true;
    }),
  ];
  const ledgerItems = accounts
    .filter((a: any) => a.isPosting)
    .map((a: any) => ({
      value: String(a.id),
      label: `${a.code} — ${isRtl ? a.nameAr : (a.nameEn || a.nameAr)}`,
      badge: a.code,
      badgeClass: "bg-muted text-muted-foreground border",
    }));
  const pickerItems = mode === "treasury" ? treasuryItems : ledgerItems;
  const selectedItem = pickerItems.find((i) => i.value === accountId && i.value !== "");
  const selectedCode = selectedItem ? selectedItem.label.split(" — ")[0] : "all";
  const bankLabel = selectedItem
    ? selectedItem.label
    : mode === "treasury"
      ? (isRtl ? "كل حسابات النقد والبنوك" : "All cash & banks")
      : (isRtl ? "— لم يُحدَّد حساب —" : "— No account selected —");

  // Reconciliation: the waterfall closing (opening + deposits − outflows) must
  // equal the book balance summed independently from the ledger by the server
  // (`bookClosing`). A divergence means the classification loop dropped or
  // double-counted a line — surface it instead of giving a false "validated".
  const bookClosing = data?.bookClosing ?? closing;
  const reconciled = Math.abs(closing - bookClosing) < 0.01;

  // ── Chart datasets ───────────────────────────────────────────────────────
  const depositPie = DEPOSIT_CATS
    .map(c => ({ name: isRtl ? c.ar : c.en, value: deposits[c.key] ?? 0, color: c.color }))
    .filter(d => d.value > 0);
  const outflowPie = OUTFLOW_CATS
    .map(c => ({ name: isRtl ? c.ar : c.en, value: outflows[c.key] ?? 0, color: c.color }))
    .filter(d => d.value > 0);
  const monthlyChart = monthlyRows.map(m => ({
    month: m.month,
    deposits: m.deposits.total,
    outflows: m.outflows.total,
    closing: m.closing,
  }));
  const netFlow = deposits.total - outflows.total;

  function handleSearch() {
    if (mode === "ledger" && !accountId) {
      toast({
        title: isRtl ? "اختر حساباً من شجرة الحسابات أولاً" : "Select an account from the chart first",
        variant: "destructive",
      });
      return;
    }
    setSearched(true);
    refetch();
  }

  // ── Export rows: a flat ledger of the cash-flow waterfall. ────────────────
  const lbl = (c: { ar: string; en: string }) => isRtl ? c.ar : c.en;
  const exportRows: any[] = [
    { item: isRtl ? "رصيد البنك أول الفترة (دفترياً)" : "Opening book balance", amount: opening },
    ...DEPOSIT_CATS.map(c => ({ item: `(+) ${lbl(c)}`, amount: deposits[c.key] ?? 0 })),
    { item: isRtl ? "إجمالي الإيداعات الواردة" : "Total deposits", amount: deposits.total },
    ...OUTFLOW_CATS.map(c => ({ item: `(−) ${lbl(c)}`, amount: outflows[c.key] ?? 0 })),
    { item: isRtl ? "إجمالي استخدامات الأموال" : "Total uses of funds", amount: outflows.total },
    { item: isRtl ? "رصيد البنك آخر الفترة (دفترياً)" : "Closing book balance", amount: closing },
  ];
  const EXPORT_COLS = [
    { key: "item",   header: isRtl ? "البيان" : "Item", width: 38 },
    { key: "amount", header: isRtl ? "المبلغ" : "Amount", width: 18, numFmt: moneyFmt },
  ];

  const hasData = !!data && (opening !== 0 || deposits.total !== 0 || outflows.total !== 0);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Landmark className="h-6 w-6 text-primary" />
            {isRtl ? "تحليل حركة البنك (دفترياً)" : "Bank Cash-Flow Analysis (Book)"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isRtl
              ? "رصيد البنك أول الفترة + الإيداعات الواردة محللة حسب النوع − استخدامات الأموال = رصيد البنك آخر الفترة"
              : "Opening balance + deposits by source − uses of funds = closing book balance"}
          </p>
        </div>
        {hasData && (
          <div className="flex gap-2">
            <ExportButtons
              rows={exportRows}
              columns={EXPORT_COLS}
              filename={`bank-cash-flow-${selectedCode}-${fromDate}`}
              title={`${isRtl ? "تحليل حركة البنك" : "Bank Cash-Flow"} — ${bankLabel} (${fromDate} → ${toDate})`}
            />
            <Button variant="outline" size="sm" className="gap-2 print:hidden" onClick={() => window.print()}>
              <Printer className="h-4 w-4" />{isRtl ? "طباعة" : "Print"}
            </Button>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        {/* Account source toggle */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="text-sm text-muted-foreground">{isRtl ? "مصدر الحساب:" : "Account source:"}</span>
          <div className="inline-flex rounded-lg border bg-muted/40 p-0.5">
            <button
              type="button"
              data-testid="button-mode-treasury"
              onClick={() => { setMode("treasury"); setAccountId(""); }}
              className={`px-3 py-1.5 text-sm rounded-md transition ${mode === "treasury" ? "bg-background shadow-sm font-medium" : "text-muted-foreground"}`}
            >
              {isRtl ? "النقد والبنوك" : "Cash & Banks"}
            </button>
            <button
              type="button"
              data-testid="button-mode-ledger"
              onClick={() => { setMode("ledger"); setAccountId(""); }}
              className={`px-3 py-1.5 text-sm rounded-md transition ${mode === "ledger" ? "bg-background shadow-sm font-medium" : "text-muted-foreground"}`}
            >
              {isRtl ? "شجرة الحسابات" : "Chart of Accounts"}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
          <div className="space-y-1.5 lg:col-span-2">
            <Label>
              {mode === "treasury"
                ? (isRtl ? "حساب النقد / البنك" : "Cash / Bank account")
                : (isRtl ? "الحساب (من شجرة الحسابات)" : "Account (from chart)")}
            </Label>
            <SearchCombobox
              items={pickerItems}
              value={accountId}
              onValueChange={setAccountId}
              placeholder={mode === "treasury"
                ? (isRtl ? "كل حسابات النقد والبنوك" : "All cash & banks")
                : (isRtl ? "اختر حساباً" : "Select account")}
              searchPlaceholder={isRtl ? "بحث بالكود أو الاسم" : "Search by code or name"}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{isRtl ? "من تاريخ" : "From date"}</Label>
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{isRtl ? "إلى تاريخ" : "To date"}</Label>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{isRtl ? "الفرع" : "Branch"}</Label>
            <BranchFilter value={branchId} onChange={setBranchId} />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-4">
          <input
            id="bcf-monthly"
            type="checkbox"
            className="h-4 w-4"
            checked={monthly}
            onChange={e => setMonthly(e.target.checked)}
            data-testid="checkbox-monthly"
          />
          <Label htmlFor="bcf-monthly" className="cursor-pointer text-sm font-normal">
            {isRtl ? "تفصيل شهري" : "Monthly breakdown"}
          </Label>
        </div>
        <div className="mt-4 flex justify-end">
          <Button className="gap-2" onClick={handleSearch} disabled={isLoading}>
            <Search className="h-4 w-4" />
            {isLoading ? (isRtl ? "جارٍ التحميل..." : "Loading...") : (isRtl ? "عرض التقرير" : "Show report")}
          </Button>
        </div>
      </div>

      {/* Empty state */}
      {searched && !isLoading && !hasData && (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          {isRtl ? "لا توجد حركات بنكية في الفترة المحددة" : "No bank movements in the selected period"}
        </div>
      )}

      {searched && hasData && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              icon={<Wallet className="h-5 w-5" />}
              label={isRtl ? "رصيد أول الفترة" : "Opening balance"}
              value={fmt(opening)}
              gradient="from-slate-50 to-slate-100"
              ring="border-slate-200"
              text="text-slate-800"
            />
            <KpiCard
              icon={<ArrowDownToLine className="h-5 w-5" />}
              label={isRtl ? "إجمالي الإيداعات" : "Total deposits"}
              value={fmt(deposits.total)}
              gradient="from-emerald-50 to-teal-50"
              ring="border-emerald-200"
              text="text-emerald-800"
            />
            <KpiCard
              icon={<ArrowUpFromLine className="h-5 w-5" />}
              label={isRtl ? "إجمالي المسحوبات" : "Total uses"}
              value={fmt(outflows.total)}
              gradient="from-rose-50 to-pink-50"
              ring="border-rose-200"
              text="text-rose-800"
            />
            <KpiCard
              icon={<Landmark className="h-5 w-5" />}
              label={isRtl ? "رصيد آخر الفترة" : "Closing balance"}
              value={fmt(closing)}
              gradient="from-sky-50 to-cyan-50"
              ring="border-sky-300"
              text="text-sky-900"
            />
          </div>

          {/* Reconciliation banner */}
          <div className={cn(
            "rounded-xl border p-3 flex items-center gap-2 text-sm",
            reconciled ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800",
          )}>
            {reconciled
              ? <><CheckCircle2 className="h-4 w-4" />{isRtl ? "الرصيد الختامي مطابق لرصيد البنك دفترياً" : "Closing balance matches the bank book balance"}</>
              : <><AlertTriangle className="h-4 w-4" />{isRtl ? "تحقق من البيانات: الرصيد غير مطابق" : "Check data: balance does not reconcile"}</>}
          </div>

          {/* ── Visual dashboard ───────────────────────────────────────── */}
          <div className="rounded-2xl border bg-gradient-to-br from-slate-50 to-white p-4 sm:p-5 shadow-sm print:hidden">
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 className="h-5 w-5 text-primary" />
              <h2 className="font-bold text-base">{isRtl ? "لوحة التحليل البصري" : "Visual analytics dashboard"}</h2>
            </div>

            {/* Net-flow highlight strip */}
            <div className={cn(
              "rounded-xl px-4 py-3 mb-4 flex items-center justify-between gap-3 border",
              netFlow >= 0 ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50",
            )}>
              <div className={cn("flex items-center gap-2 text-sm font-semibold", netFlow >= 0 ? "text-emerald-800" : "text-rose-800")}>
                <TrendingUp className={cn("h-4 w-4", netFlow < 0 && "rotate-180")} />
                {isRtl ? "صافي التدفق النقدي للفترة" : "Net cash flow for the period"}
              </div>
              <div className={cn("text-xl font-bold tabular-nums", netFlow >= 0 ? "text-emerald-800" : "text-rose-800")}>
                {netFlow >= 0 ? "+" : "−"}{fmt(Math.abs(netFlow))}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <DonutCard
                title={isRtl ? "مصادر الإيداعات" : "Sources of deposits"}
                icon={<ArrowDownToLine className="h-4 w-4 text-emerald-600" />}
                data={depositPie}
                total={deposits.total}
                fmt={fmt}
                isRtl={isRtl}
              />
              <DonutCard
                title={isRtl ? "أوجه استخدام الأموال" : "Uses of funds"}
                icon={<ArrowUpFromLine className="h-4 w-4 text-rose-600" />}
                data={outflowPie}
                total={outflows.total}
                fmt={fmt}
                isRtl={isRtl}
              />
            </div>

            {/* Monthly trend chart (only when monthly breakdown produced rows) */}
            {monthly && monthlyChart.length > 0 && (
              <div className="mt-4 rounded-xl border bg-card p-4">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp className="h-4 w-4 text-sky-600" />
                  <h3 className="font-semibold text-sm">{isRtl ? "اتجاه التدفقات الشهرية" : "Monthly cash-flow trend"}</h3>
                </div>
                <div className="h-72 w-full" dir="ltr">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={monthlyChart} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={{ stroke: "#cbd5e1" }} />
                      <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                        tickFormatter={(v: number) => Intl.NumberFormat("en", { notation: "compact" }).format(v)} />
                      <Tooltip
                        formatter={(v: any, name: any) => [fmt(Number(v)), name]}
                        labelStyle={{ fontWeight: 600 }}
                        contentStyle={{ borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12 }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="deposits" name={isRtl ? "إيداعات" : "Deposits"} fill="#10b981" radius={[4, 4, 0, 0]} barSize={18} />
                      <Bar dataKey="outflows" name={isRtl ? "مسحوبات" : "Uses"} fill="#f43f5e" radius={[4, 4, 0, 0]} barSize={18} />
                      <Line dataKey="closing" name={isRtl ? "الرصيد آخر الشهر" : "Closing"} type="monotone"
                        stroke="#0ea5e9" strokeWidth={2.5} dot={{ r: 3 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>

          {/* Waterfall analysis */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <AnalysisTable
              title={isRtl ? "الإيداعات الواردة (حسب النوع)" : "Deposits (by source)"}
              headTone="bg-emerald-50 text-emerald-800"
              cats={DEPOSIT_CATS}
              buckets={deposits}
              totalLabel={isRtl ? "إجمالي الإيداعات" : "Total deposits"}
              isRtl={isRtl}
              fmt={fmt}
              direction="deposit"
              onDrill={(c, amt) => setDrill({ direction: "deposit", category: c.key, label: isRtl ? c.ar : c.en, color: c.color, amount: amt })}
            />
            <AnalysisTable
              title={isRtl ? "استخدامات الأموال (حسب النوع)" : "Uses of funds (by type)"}
              headTone="bg-rose-50 text-rose-800"
              cats={OUTFLOW_CATS}
              buckets={outflows}
              totalLabel={isRtl ? "إجمالي المسحوبات" : "Total uses"}
              isRtl={isRtl}
              fmt={fmt}
              direction="outflow"
              onDrill={(c, amt) => setDrill({ direction: "outflow", category: c.key, label: isRtl ? c.ar : c.en, color: c.color, amount: amt })}
            />
          </div>

          {/* Waterfall summary (the equation) */}
          <div className="rounded-xl border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                <WaterfallRow label={isRtl ? "رصيد البنك أول الفترة (دفترياً)" : "Opening book balance"} value={fmt(opening)} fmt strong />
                <WaterfallRow label={isRtl ? "(+) إجمالي الإيداعات الواردة" : "(+) Total deposits"} value={fmt(deposits.total)} tone="text-emerald-700" />
                <WaterfallRow label={isRtl ? "(−) إجمالي استخدامات الأموال" : "(−) Total uses of funds"} value={fmt(outflows.total)} tone="text-rose-700" />
                <WaterfallRow label={isRtl ? "= رصيد البنك آخر الفترة (دفترياً)" : "= Closing book balance"} value={fmt(closing)} strong highlight />
              </tbody>
            </table>
          </div>

          {/* Monthly breakdown */}
          {monthly && monthlyRows.length > 0 && (
            <div className="rounded-xl border bg-card overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead className="bg-muted/50">
                  <tr className="text-start">
                    <th className="px-3 py-2 text-start font-semibold">{isRtl ? "الشهر" : "Month"}</th>
                    <th className="px-3 py-2 text-end font-semibold">{isRtl ? "رصيد أول الشهر" : "Opening"}</th>
                    <th className="px-3 py-2 text-end font-semibold text-emerald-700">{isRtl ? "إيداعات" : "Deposits"}</th>
                    <th className="px-3 py-2 text-end font-semibold text-rose-700">{isRtl ? "مسحوبات" : "Uses"}</th>
                    <th className="px-3 py-2 text-end font-semibold">{isRtl ? "رصيد آخر الشهر" : "Closing"}</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyRows.map((m) => (
                    <tr key={m.month} className="border-t">
                      <td className="px-3 py-2 font-medium">{m.month}</td>
                      <td className="px-3 py-2 text-end tabular-nums">{fmt(m.opening)}</td>
                      <td className="px-3 py-2 text-end tabular-nums text-emerald-700">{fmt(m.deposits.total)}</td>
                      <td className="px-3 py-2 text-end tabular-nums text-rose-700">{fmt(m.outflows.total)}</td>
                      <td className="px-3 py-2 text-end tabular-nums font-semibold">{fmt(m.closing)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <DrillSheet
        drill={drill}
        onClose={() => setDrill(null)}
        params={{ cid, mode, accountId, fromDate, toDate, branchId }}
        headers={headers}
        isRtl={isRtl}
        fmt={fmt}
        moneyFmt={moneyFmt}
      />
    </div>
  );
}

function KpiCard({ icon, label, value, gradient, ring, text }: {
  icon: React.ReactNode; label: string; value: string; gradient: string; ring: string; text: string;
}) {
  return (
    <div className={cn("rounded-xl border bg-gradient-to-br p-4 shadow-sm", gradient, ring)}>
      <div className={cn("flex items-center gap-2 text-xs font-medium", text)}>{icon}{label}</div>
      <div className={cn("mt-2 text-2xl font-bold tabular-nums", text)}>{value}</div>
    </div>
  );
}

type AnalysisCat = { key: string; ar: string; en: string; tone: string; color: string };
function AnalysisTable({ title, headTone, cats, buckets, totalLabel, isRtl, fmt, direction, onDrill }: {
  title: string; headTone: string;
  cats: AnalysisCat[];
  buckets: Buckets; totalLabel: string; isRtl: boolean; fmt: (n: number) => string;
  direction: "deposit" | "outflow";
  onDrill: (cat: AnalysisCat, amt: number) => void;
}) {
  const total = buckets.total || 0;
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className={cn("px-4 py-2.5 font-semibold text-sm", headTone)}>{title}</div>
      <table className="w-full text-sm">
        <tbody>
          {cats.map((c) => {
            const amt = buckets[c.key] ?? 0;
            const pct = total > 0 ? (amt / total) * 100 : 0;
            const clickable = amt > 0;
            return (
              <tr
                key={c.key}
                className={cn("border-t transition-colors", clickable && "cursor-pointer hover:bg-muted/40")}
                onClick={clickable ? () => onDrill(c, amt) : undefined}
                title={clickable ? (isRtl ? "اضغط لعرض الحركات المكوّنة لهذا المبلغ" : "Click to see contributing transactions") : undefined}
              >
                <td className="px-4 py-2.5">
                  <div className={cn("font-medium flex items-center gap-1.5", c.tone)}>
                    {isRtl ? c.ar : c.en}
                    {clickable && <Search className="h-3 w-3 opacity-50" />}
                  </div>
                  <div className="mt-1 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-current opacity-40" style={{ width: `${pct}%` }} />
                  </div>
                </td>
                <td className="px-4 py-2.5 text-end tabular-nums font-semibold w-32">
                  {clickable ? (
                    <span className="underline decoration-dotted underline-offset-4 decoration-muted-foreground/40">{fmt(amt)}</span>
                  ) : fmt(amt)}
                </td>
                <td className="px-4 py-2.5 text-end tabular-nums text-xs text-muted-foreground w-16">{pct.toFixed(1)}%</td>
              </tr>
            );
          })}
          <tr className="border-t bg-muted/40 font-bold">
            <td className="px-4 py-2.5">{totalLabel}</td>
            <td className="px-4 py-2.5 text-end tabular-nums w-32">{fmt(total)}</td>
            <td className="px-4 py-2.5 text-end text-xs text-muted-foreground w-16">100%</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function DonutCard({ title, icon, data, total, fmt, isRtl }: {
  title: string; icon: React.ReactNode;
  data: { name: string; value: number; color: string }[];
  total: number; fmt: (n: number) => string; isRtl: boolean;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <h3 className="font-semibold text-sm">{title}</h3>
      </div>
      {data.length === 0 ? (
        <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">
          {isRtl ? "لا توجد بيانات" : "No data"}
        </div>
      ) : (
        <div className="h-56 w-full" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={52}
                outerRadius={78}
                paddingAngle={2}
                stroke="#fff"
                strokeWidth={2}
              >
                {data.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Pie>
              <Tooltip
                formatter={(v: any) => [fmt(Number(v)), total > 0 ? `${((Number(v) / total) * 100).toFixed(1)}%` : ""]}
                contentStyle={{ borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12 }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11 }}
                iconType="circle"
                layout="horizontal"
                verticalAlign="bottom"
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function WaterfallRow({ label, value, tone, strong, highlight }: {
  label: string; value: string; fmt?: boolean; tone?: string; strong?: boolean; highlight?: boolean;
}) {
  return (
    <tr className={cn("border-t", highlight && "bg-sky-50")}>
      <td className={cn("px-4 py-3", strong ? "font-bold" : "font-medium", tone)}>{label}</td>
      <td className={cn("px-4 py-3 text-end tabular-nums", strong ? "font-bold text-lg" : "", tone)}>{value}</td>
    </tr>
  );
}

// ── Drill-down slide-over ─────────────────────────────────────────────────────
// Lists the individual transactions that make up the clicked cash-flow figure.
// The server uses the SAME classification engine, so `data.total` always equals
// the figure shown on the report (we surface a tiny reconciliation tick to prove it).
type DrillRow = {
  entryId: number; date: string; amount: number; entryType: string | null;
  docNumber: string | null; description: string | null;
  counterpartAr: string | null; counterpartEn: string | null;
};
type DrillResponse = { direction: string; category: string; total: number; count: number; rows: DrillRow[] };

function DrillSheet({ drill, onClose, params, headers, isRtl, fmt, moneyFmt }: {
  drill: DrillState | null;
  onClose: () => void;
  params: { cid?: number; mode: string; accountId: string; fromDate: string; toDate: string; branchId?: number };
  headers: Record<string, string>;
  isRtl: boolean;
  fmt: (n: number) => string;
  moneyFmt: string;
}) {
  const isDeposit = drill?.direction === "deposit";
  const { data, isLoading, isError } = useQuery<DrillResponse>({
    queryKey: ["bank-cash-flow-breakdown", drill?.direction, drill?.category, params.cid, params.mode, params.accountId, params.fromDate, params.toDate, params.branchId],
    queryFn: async () => {
      const q = new URLSearchParams();
      if (params.cid)       q.set("companyId", String(params.cid));
      q.set("mode", params.mode);
      if (params.accountId) q.set("accountId", params.accountId);
      if (params.fromDate)  q.set("fromDate", params.fromDate);
      if (params.toDate)    q.set("toDate", params.toDate);
      if (params.branchId)  q.set("branchId", String(params.branchId));
      q.set("direction", drill!.direction);
      q.set("category", drill!.category);
      const res = await fetch(`${API}/api/accounting-reports/bank-cash-flow/breakdown?${q}`, { headers });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "failed"); }
      return res.json();
    },
    enabled: !!drill,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const reconciles = drill ? Math.abs(total - drill.amount) < 0.01 : true;
  const color = drill?.color ?? "#0284c7";

  // Export columns/rows for the drill-down breakdown (Excel / PDF / Print).
  const DRILL_COLS: ExportColumn[] = [
    { header: isRtl ? "التاريخ" : "Date",        key: "date",        width: 14 },
    { header: isRtl ? "الطرف" : "Counterpart",   key: "counterpart", width: 30 },
    { header: isRtl ? "النوع" : "Type",          key: "type",        width: 18 },
    { header: isRtl ? "رقم المستند" : "Document", key: "docNumber",   width: 16 },
    { header: isRtl ? "البيان" : "Description",   key: "description", width: 40 },
    { header: isRtl ? "المبلغ" : "Amount",        key: "amount",      width: 16, numFmt: moneyFmt },
  ];
  const drillExportRows = rows.map((r) => ({
    date: r.date,
    counterpart: (isRtl ? r.counterpartAr : (r.counterpartEn || r.counterpartAr)) || (isRtl ? "غير محدد" : "Unspecified"),
    type: entryTypeLabel(r.entryType, isRtl),
    docNumber: r.docNumber ?? "",
    description: r.description ?? "",
    amount: r.amount,
  }));
  const drillTotalsRow = { date: isRtl ? "الإجمالي" : "Total", amount: total };
  const drillTitle = `${drill?.label ?? ""} — ${isDeposit ? (isRtl ? "إيداعات" : "Deposits") : (isRtl ? "مسحوبات" : "Uses")}`;

  return (
    <Dialog open={!!drill} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        dir={isRtl ? "rtl" : "ltr"}
        className="w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[85vh] p-0 flex flex-col gap-0 overflow-hidden bg-white text-slate-900 border border-slate-200 shadow-2xl"
      >
        <DialogHeader className="p-5 border-b border-slate-200 bg-white space-y-0 text-start" style={{ borderTopWidth: 3, borderTopColor: color }}>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
            {drill?.label}
            <span className="text-xs font-normal text-muted-foreground">
              {isDeposit ? (isRtl ? "إيداعات" : "Deposits") : (isRtl ? "مسحوبات" : "Uses")}
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            {isRtl ? "الحركات المكوّنة للمبلغ" : "Transactions contributing to this figure"}
          </DialogDescription>
          <div className="flex items-end justify-between pt-2">
            <div className="text-2xl font-bold tabular-nums" style={{ color }}>{fmt(total)}</div>
            <div className="flex items-center gap-3">
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Layers className="h-3.5 w-3.5" />
                {data?.count ?? 0} {isRtl ? "حركة" : "items"}
              </div>
              <ExportButtons
                rows={drillExportRows}
                columns={DRILL_COLS}
                filename={`bank-cash-flow-${drill?.direction ?? ""}-${drill?.category ?? ""}-${params.fromDate}`}
                title={drillTitle}
                subtitle={`${params.fromDate} → ${params.toDate}`}
                totalsRow={drillTotalsRow}
                disabled={isLoading || rows.length === 0}
              />
            </div>
          </div>
          {!isLoading && !isError && (
            <div className={cn(
              "mt-2 inline-flex items-center gap-1 text-[11px] rounded-full px-2 py-0.5 w-fit",
              reconciles ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700",
            )}>
              {reconciles
                ? (<><CheckCircle2 className="h-3 w-3" />{isRtl ? "مطابق للمبلغ المعروض في التقرير" : "Matches the report figure"}</>)
                : (<><AlertTriangle className="h-3 w-3" />{isRtl ? `فرق ${fmt(Math.abs(total - (drill?.amount ?? 0)))}` : `Diff ${fmt(Math.abs(total - (drill?.amount ?? 0)))}`}</>)}
            </div>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-white">
          {isLoading && (
            <div className="h-40 flex items-center justify-center text-muted-foreground gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />{isRtl ? "جارٍ التحميل…" : "Loading…"}
            </div>
          )}
          {isError && (
            <div className="h-40 flex flex-col items-center justify-center text-rose-600 gap-2 text-sm">
              <AlertTriangle className="h-5 w-5" />{isRtl ? "تعذّر تحميل التفاصيل" : "Failed to load details"}
            </div>
          )}
          {!isLoading && !isError && rows.length === 0 && (
            <div className="h-40 flex flex-col items-center justify-center text-muted-foreground gap-2 text-sm">
              <Inbox className="h-6 w-6" />{isRtl ? "لا توجد حركات" : "No transactions"}
            </div>
          )}
          {!isLoading && rows.map((r, i) => {
            const counterpart = (isRtl ? r.counterpartAr : (r.counterpartEn || r.counterpartAr)) || (isRtl ? "غير محدد" : "Unspecified");
            return (
              <div key={`${r.entryId}-${i}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3 flex items-start justify-between gap-3 hover:bg-slate-100 transition-colors">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-900 truncate">{counterpart}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 whitespace-nowrap">
                      {entryTypeLabel(r.entryType, isRtl)}
                    </span>
                  </div>
                  <div className="text-xs text-slate-600 mt-1 flex items-center gap-2 flex-wrap">
                    <span className="tabular-nums">{r.date}</span>
                    {r.docNumber && (
                      <span className="inline-flex items-center gap-0.5">
                        <FileText className="h-3 w-3" />{r.docNumber}
                      </span>
                    )}
                  </div>
                  {r.description && <div className="text-xs text-slate-600 mt-1 line-clamp-2">{r.description}</div>}
                </div>
                <div className="text-end font-semibold tabular-nums whitespace-nowrap" style={{ color }}>
                  {fmt(r.amount)}
                </div>
              </div>
            );
          })}
        </div>

        {!isLoading && rows.length > 0 && (
          <div className="border-t border-slate-200 p-4 flex items-center justify-between bg-slate-50">
            <span className="text-sm font-semibold text-slate-700">{isRtl ? "الإجمالي" : "Total"}</span>
            <span className="text-base font-bold tabular-nums" style={{ color }}>{fmt(total)}</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
