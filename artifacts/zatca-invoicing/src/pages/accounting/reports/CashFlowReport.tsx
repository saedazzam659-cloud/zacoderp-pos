import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useSearch, useLocation } from "wouter";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import { exportStatementToPDF } from "@/lib/export";
import { useFmt } from "@/hooks/use-fmt";
import BranchFilter from "@/components/BranchFilter";
import CostCenterFilter from "@/components/CostCenterFilter";
import AdvancedReportGrid from "@/components/auditGrid/AdvancedReportGrid";
import {
  Waves, Search, Printer, ExternalLink, Wallet, Landmark,
  ArrowDownToLine, ArrowUpFromLine, Scale, PiggyBank,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// نوع الحركة — friendly Arabic label per JE entryType (subset that can touch
// treasury accounts + safe fallback for anything else).
const ENTRY_TYPE_LABEL: Record<string, string> = {
  sales_invoice:    "فاتورة مبيعات",
  sales_return:     "مرتجع مبيعات",
  purchase_invoice: "فاتورة مشتريات",
  purchase_return:  "مرتجع مشتريات",
  receipt:          "سند قبض",
  receipt_cash:     "سند قبض نقدي",
  receipt_bank:     "سند قبض بنكي",
  payment:          "سند صرف",
  payment_cash:     "سند صرف نقدي",
  payment_bank:     "سند صرف بنكي",
  pos_sale:         "بيع نقاط بيع",
  pos_return:       "مرتجع نقاط بيع",
  payroll_run:      "مسير رواتب",
  employee_loan:    "سلفة موظف",
  eos_payment:      "تسوية نهاية خدمة",
  cash_transfer:    "تحويل نقدي",
  opening:          "رصيد افتتاحي",
  lc_funding:       "تمويل اعتماد مستندي",
  lc_expense_payment: "دفع مصروف اعتماد",
  fa_acquisition:   "اقتناء أصل ثابت",
  fa_disposal:      "استبعاد أصل ثابت",
  sister_settlement: "تسوية شركة شقيقة",
  general:          "قيد يومية",
  manual:           "قيد يدوي",
};
const typeLabel = (k?: string | null) => (k && ENTRY_TYPE_LABEL[k]) || "قيد يومية";

// ── بنود ملخص التدفقات النقدية (نموذج الشركاء — جدول رقم 3) ────────────────
// Same 16 notes as the partner "Guidelines for filling the Cash Flow
// Statements" schedule; note 1 is the beginning balance, rendered separately.
const SUMMARY_NOTE_META: Record<string, { label: string; labelEn: string; desc: string }> = {
  in_sales:         { label: "المتحصلات من بيع السلع والخدمات (نقدي وآجل)",            labelEn: "Collection received from Sale of Goods/Services in trade (Cash and Credit)", desc: "متحصلات أي عملية بيع لنشاط الشركة الرئيسي (بضاعة تامة، خدمات، صيانة...)" },
  in_interest:      { label: "الفوائد والعوائد على الودائع والاستثمارات المحلية",        labelEn: "Interest on deposits on local investment made by the Entity", desc: "العوائد الدورية للأدوات المالية المستثمرة والمسجلة في السجلات المالية (أسهم، سندات، أوراق حكومية، فوائد ودائع بنكية...)" },
  in_other:         { label: "متحصلات أخرى من الأنشطة التشغيلية",                        labelEn: "Other Collection made from Operating Activities", desc: "متحصلات قضايا وتعويضات، متحصلات تأمين، تراخيص، إيجارات، وأخرى" },
  in_fixed_assets:  { label: "المتحصلات من بيع الأصول الثابتة والأصول طويلة الأجل",      labelEn: "Collection from Sale of Fixed Assets and long term assets", desc: "متحصلات بيع أي أصل ثابت أو أصول طويلة الأجل (بما فيها حقوق الملكية الفكرية والعلامات التجارية)" },
  in_investments:   { label: "المتحصلات من بيع الاستثمارات (أسهم وأوراق مالية)",         labelEn: "Collection from Sale of Investment (shares, securities or other investments)", desc: "متحصلات بيع أي أداة مالية كليًا أو جزئيًا مسجلة في السجلات المالية" },
  in_debt:          { label: "المتحصلات من القروض قصيرة أو طويلة الأجل",                 labelEn: "Collection - Proceeds from short-term or long-term debt", desc: "النقد الداخل من أي اقتراض أو تمويل وفق شروط سداد متفق عليها" },
  out_suppliers:    { label: "المدفوعات للموردين (سلع وخدمات)",                          labelEn: "Payments to Suppliers (Goods and Services)", desc: "كل المدفوعات للموردين لشراء الخامات والبضائع والخدمات (نقل، مرافق، تأمين، جمارك...)" },
  out_payroll:      { label: "مدفوعات الرواتب والأجور والعمولات والحوافز",               labelEn: "Payments to Payroll Activities (Wages, Commission, Incentive, etc)", desc: "كل المدفوعات للموظفين (رواتب، مواصلات، سكن، عمولات، حوافز...) وما يُدفع نيابة عنهم لجهات خارجية" },
  out_tax:          { label: "المدفوعات الضريبية (هيئة الزكاة والضريبة والجمارك)",        labelEn: "Tax Payments", desc: "كل المدفوعات للهيئة (ضريبة القيمة المضافة، الاستقطاع، الزكاة، الضريبة الانتقائية...)" },
  out_government:   { label: "مدفوعات الجهات الحكومية الأخرى",                           labelEn: "Payments for Governmental Institutions", desc: "المدفوعات للجهات الحكومية غير الهيئة والتأمينات الاجتماعية (مكتب العمل، الجوازات، الوزارات...)" },
  out_fixed_assets: { label: "مدفوعات شراء الأصول الثابتة والأصول طويلة الأجل",          labelEn: "Payments for Purchase of Fixed Assets and long term assets", desc: "كل المدفوعات لشراء أي أصل ثابت أو أصول طويلة الأجل (بما فيها حقوق الملكية والعلامات التجارية)" },
  out_investments:  { label: "مدفوعات شراء الأسهم والأوراق المالية والاستثمارات",        labelEn: "Payments for Purchase of shares, securities and current/new investments", desc: "المدفوعات لشراء أي أداة مالية كليًا أو جزئيًا تُسجل في السجلات المالية" },
  out_loans:        { label: "مدفوعات أقساط القروض والتمويل (مرابحة)",                   labelEn: "Payments for Murabaha Loans", desc: "المدفوعات لسداد أقساط القروض حسب الاتفاق بين الشركة والبنك أو أي طرف خارجي" },
  out_dividends:    { label: "توزيعات الأرباح المدفوعة",                                 labelEn: "Dividend Payments", desc: "توزيعات الأرباح المدفوعة" },
  out_shareholders: { label: "المدفوعات للمساهمين والشركاء",                             labelEn: "Payments for Shareholders", desc: "أي مدفوعات تتم لأي من المساهمين أو الشركاء شخصيًا" },
  out_other:        { label: "مدفوعات أخرى من الأنشطة التشغيلية",                        labelEn: "Other Payments made from Operating Activities", desc: "أي مدفوعات تشغيلية أخرى لم تُدرج في البنود السابقة" },
};

function typeTone(k?: string | null): string {
  const key = k ?? "";
  if (key.startsWith("sales") || key === "pos_sale")
    return "border-sky-200 from-sky-50 to-cyan-50 text-sky-800";
  if (key.startsWith("purchase") || key.startsWith("lc_"))
    return "border-amber-200 from-amber-50 to-orange-50 text-amber-800";
  if (key.startsWith("receipt"))
    return "border-emerald-200 from-emerald-50 to-teal-50 text-emerald-800";
  if (key.startsWith("payment") || key === "payroll_run")
    return "border-rose-200 from-rose-50 to-pink-50 text-rose-800";
  if (key === "opening")
    return "border-slate-300 from-slate-50 to-zinc-50 text-slate-700";
  return "border-slate-200 from-slate-50 to-slate-100 text-slate-700";
}

type CashFlowLine = {
  lineId: number;
  entryId: number;
  entryType: string | null;
  docNumber: string | null;
  date: string;
  description: string;
  accountId: number;
  accountKind: "cashbox" | "bank";
  accountName: string;
  accountNameEn: string | null;
  counterAccounts: string[];
  category?: string;
  inflow: number;
  outflow: number;
};
type SummaryNote = { no: number; key: string; side: "in" | "out"; amount: number; count: number };
type CashFlowResponse = {
  opening: number;
  lines: CashFlowLine[];
  totals: { inflows: number; outflows: number; net: number; closing: number };
  summary?: SummaryNote[];
  internalTransfers?: number;
  accounts: { accountId: number; kind: string; nameAr: string; nameEn: string | null }[];
};

export default function CashFlowReport() {
  const { user, token } = useAuth() as any;
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const { dp } = useFmt();
  const moneyFmt = dp > 0 ? `#,##0.${"0".repeat(dp)}` : "#,##0";
  const { toast } = useToast();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}` };

  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = today.slice(0, 8) + "01";

  const [fromDate, setFromDate] = useState(firstOfMonth);
  const [toDate, setToDate]     = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [accountId, setAccountId]   = useState(""); // treasury GL account id ("" = all)
  const [currencyId, setCurrencyId] = useState(""); // "" = all currencies
  const [costCenterIds, setCostCenterIds] = useState<number[]>([]);
  const ccCsv = costCenterIds.length ? [...costCenterIds].sort((a, b) => a - b).join(",") : "";
  const [searched, setSearched] = useState(false);
  // "summary" = one-page partner schedule (نموذج جدول رقم 3); "detail" = full movement grid.
  const [view, setView] = useState<"summary" | "detail">("summary");

  // Deep-link + browser-back re-hydration (same pattern as AccountStatement).
  const searchString = useSearch();
  const [, setLocation] = useLocation();
  useEffect(() => {
    if (!searchString) return;
    const p = new URLSearchParams(searchString);
    const f = p.get("fromDate"); const tt = p.get("toDate");
    const b = p.get("branchId"); const a = p.get("accountId");
    const cur = p.get("currencyId"); const cc = p.get("costCenterId");
    const v = p.get("view");
    if (v === "detail" || v === "summary") setView(v);
    if (f) setFromDate(f);
    if (tt) setToDate(tt);
    if (b) setBranchId(Number(b));
    if (a) setAccountId(a);
    if (cur) setCurrencyId(cur);
    if (cc) {
      const ids = cc.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
      if (ids.length) setCostCenterIds(ids);
    }
    if (f || tt || a) setSearched(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchString]);
  useEffect(() => {
    if (!searched) return;
    const next = new URLSearchParams();
    if (fromDate)   next.set("fromDate", fromDate);
    if (toDate)     next.set("toDate", toDate);
    if (branchId)   next.set("branchId", String(branchId));
    if (accountId)  next.set("accountId", accountId);
    if (currencyId) next.set("currencyId", currencyId);
    if (ccCsv)      next.set("costCenterId", ccCsv);
    if (view !== "summary") next.set("view", view);
    const nextStr = next.toString();
    const currentStr = new URLSearchParams(searchString || "").toString();
    if (nextStr !== currentStr) {
      setLocation(`/accounting/reports/cash-flow?${nextStr}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searched, fromDate, toDate, branchId, accountId, currencyId, ccCsv, view]);

  // ── Filter sources ─────────────────────────────────────────────────────
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
  const { data: currencies = [] } = useQuery<any[]>({
    queryKey: ["currencies", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/currencies?companyId=${cid}` : `${API}/api/currencies`;
      const res = await fetch(url, { headers });
      const j = await res.json();
      return Array.isArray(j) ? j : [];
    },
    enabled: !!user,
  });

  const treasuryItems = useMemo(() => {
    const seen = new Set<string>();
    const items: any[] = [];
    for (const c of cashBoxes) {
      if (!c.accountId || seen.has(String(c.accountId))) continue;
      seen.add(String(c.accountId));
      items.push({
        value: String(c.accountId),
        label: `${c.code} — ${isRtl ? c.nameAr : (c.nameEn || c.nameAr)}`,
        badge: isRtl ? "صندوق" : "Cash",
        badgeClass: "bg-emerald-50 text-emerald-700 border-emerald-200",
      });
    }
    for (const b of banks) {
      if (!b.accountId || seen.has(String(b.accountId))) continue;
      seen.add(String(b.accountId));
      items.push({
        value: String(b.accountId),
        label: `${b.code} — ${isRtl ? b.nameAr : (b.nameEn || b.nameAr)}`,
        badge: isRtl ? "بنك" : "Bank",
        badgeClass: "bg-blue-50 text-blue-700 border-blue-200",
      });
    }
    return items;
  }, [banks, cashBoxes, isRtl]);

  // ── Report query ───────────────────────────────────────────────────────
  const { data, isLoading, refetch } = useQuery<CashFlowResponse>({
    queryKey: ["cash-flow-report", cid, fromDate, toDate, branchId, accountId, currencyId, ccCsv],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid)        params.set("companyId", String(cid));
      if (fromDate)   params.set("fromDate", fromDate);
      if (toDate)     params.set("toDate", toDate);
      if (branchId)   params.set("branchId", String(branchId));
      if (accountId)  params.set("accountId", accountId);
      if (currencyId) params.set("currencyId", currencyId);
      if (ccCsv)      params.set("costCenterId", ccCsv);
      const res = await fetch(`${API}/api/accounting-reports/cash-flow?${params}`, { headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    enabled: searched,
  });

  const opening  = data?.opening ?? 0;
  const inflows  = data?.totals?.inflows  ?? 0;
  const outflows = data?.totals?.outflows ?? 0;
  const net      = data?.totals?.net      ?? 0;
  const closing  = data?.totals?.closing  ?? 0;

  // Running balance computed client-side on the server-sorted lines.
  const rows = useMemo(() => {
    let bal = opening;
    return (data?.lines ?? []).map(l => {
      bal += (l.inflow || 0) - (l.outflow || 0);
      return { ...l, balance: bal };
    });
  }, [data, opening]);

  // ── Partner-schedule summary (نموذج جدول رقم 3) ────────────────────────
  const summaryNotes = data?.summary ?? [];
  const internalTransfers = data?.internalTransfers ?? 0;
  const summaryInflowRows  = summaryNotes.filter(n => n.side === "in");
  const summaryOutflowRows = summaryNotes.filter(n => n.side === "out");
  const summaryInTotal  = summaryInflowRows.reduce((s, n) => s + n.amount, 0);
  const summaryOutTotal = summaryOutflowRows.reduce((s, n) => s + n.amount, 0);
  // Summary excludes internal treasury transfers (net zero), so its closing
  // still equals opening + (summaryIn − summaryOut) because transfers cancel.
  const summaryNet     = summaryInTotal - summaryOutTotal;
  const summaryClosing = opening + summaryNet;

  const SUMMARY_EXPORT_COLS = [
    { key: "no",     header: "م", width: 6 },
    { key: "label",  header: "البيان", width: 52 },
    { key: "desc",   header: "الوصف", width: 60 },
    { key: "count",  header: "عدد الحركات", width: 12 },
    { key: "inflow",  header: "وارد", width: 16, numFmt: moneyFmt },
    { key: "outflow", header: "منصرف", width: 16, numFmt: moneyFmt },
  ];
  const summaryExportRows = [
    { no: 1, label: "النقدية المتاحة — رصيد أول المدة", desc: `الرصيد الفعلي للنقدية والبنوك في ${fromDate}`, count: "", inflow: opening, outflow: "" },
    ...summaryNotes.map(n => ({
      no: n.no,
      label: SUMMARY_NOTE_META[n.key]?.label ?? n.key,
      desc:  SUMMARY_NOTE_META[n.key]?.desc ?? "",
      count: n.count || 0,
      inflow:  n.side === "in"  ? n.amount : "",
      outflow: n.side === "out" ? n.amount : "",
    })),
  ];
  const summaryExportTotalsRow = {
    no: "", label: "صافي التدفق النقدي / رصيد آخر المدة",
    desc: `صافي: ${fmt(summaryNet)} — رصيد آخر المدة: ${fmt(summaryClosing)}`,
    count: "", inflow: summaryInTotal, outflow: summaryOutTotal,
  };

  const handlePrintSummary = () => {
    let bal = opening;
    const printLines = summaryNotes.map(n => {
      const inAmt  = n.side === "in"  ? n.amount : 0;
      const outAmt = n.side === "out" ? n.amount : 0;
      bal += inAmt - outAmt;
      return {
        id: n.no,
        date: "",
        docType: n.side === "in" ? "متحصلات" : "مدفوعات",
        type: n.side === "in" ? "متحصلات" : "مدفوعات",
        docNumber: String(n.no),
        journalEntryNumber: null,
        description: SUMMARY_NOTE_META[n.key]?.label ?? n.key,
        debit: inAmt,
        credit: outAmt,
        balance: bal,
      };
    });
    exportStatementToPDF({
      mode: "general",
      company: (user?.company as any) ?? null,
      account: {
        code: "",
        nameAr: "قائمة التدفقات النقدية — ملخص",
        nameEn: "Cash Flow Statement — Summary",
        partyNameAr: "النقدية وما في حكمها (الصناديق والبنوك)",
        partyNameEn: "Cash & cash equivalents",
      },
      from: fromDate,
      to: toDate,
      opening,
      lines: printLines,
      totals: { debit: summaryInTotal, credit: summaryOutTotal },
      closing: summaryClosing,
      filename: `cash-flow-summary-${fromDate}-${toDate}`,
      autoPrint: true,
      fmt,
      userName: user?.username ?? null,
    } as any);
  };

  // ── Export shapes ──────────────────────────────────────────────────────
  const EXPORT_COLS = [
    { key: "date",        header: "التاريخ", width: 14 },
    { key: "docNumber",   header: "رقم القيد", width: 14 },
    { key: "type",        header: "نوع الحركة", width: 18 },
    { key: "account",     header: "الخزينة / البنك", width: 22 },
    { key: "description", header: "البيان", width: 36 },
    { key: "category",    header: "التصنيف", width: 30 },
    { key: "counter",     header: "الحساب المقابل", width: 28 },
    { key: "inflow",      header: "وارد", width: 14, numFmt: moneyFmt },
    { key: "outflow",     header: "منصرف", width: 14, numFmt: moneyFmt },
    { key: "balance",     header: "الرصيد", width: 14, numFmt: moneyFmt },
  ];
  const exportRows = [
    {
      date: fromDate || "", docNumber: "", type: "رصيد افتتاحي",
      account: "", description: "الرصيد الافتتاحي للفترة", counter: "",
      inflow: "", outflow: "", balance: opening,
    },
    ...rows.map(r => ({
      date:        r.date,
      docNumber:   r.docNumber || `JE-${r.entryId}`,
      type:        typeLabel(r.entryType),
      account:     r.accountName,
      description: r.description || "",
      category:    r.category === "internal_transfer" ? "تحويل داخلي" : (SUMMARY_NOTE_META[r.category as string]?.label ?? ""),
      counter:     (r.counterAccounts || []).join("، "),
      inflow:      r.inflow  || "",
      outflow:     r.outflow || "",
      balance:     r.balance,
    })),
  ];
  const exportTotalsRow = rows.length > 0 ? {
    date: "", docNumber: "", type: "", account: "",
    description: "الإجمالي", counter: "",
    inflow: inflows, outflow: outflows, balance: closing,
  } : null;

  // PDF print via the shared unified statement renderer: inflow→debit,
  // outflow→credit so the standard مدين/دائن statement layout carries the
  // cash-flow figures with the company header, logo, and totals.
  const handlePrint = () => {
    exportStatementToPDF({
      mode: "general",
      company: (user?.company as any) ?? null,
      account: {
        code: "",
        nameAr: "تقرير التدفقات النقدية",
        nameEn: "Cash Flow Report",
        partyNameAr: "النقدية وما في حكمها (الصناديق والبنوك)",
        partyNameEn: "Cash & cash equivalents",
      },
      from: fromDate,
      to: toDate,
      opening,
      lines: rows.map(r => ({
        id: r.lineId,
        journalEntryId: r.entryId,
        date: r.date,
        docType: typeLabel(r.entryType),
        type: typeLabel(r.entryType),
        docNumber: r.docNumber || `JE-${r.entryId}`,
        journalEntryNumber: r.docNumber ?? null,
        description: [r.description, (r.counterAccounts || []).length ? `مقابل: ${r.counterAccounts.join("، ")}` : ""].filter(Boolean).join(" — "),
        debit: r.inflow || 0,
        credit: r.outflow || 0,
        balance: r.balance,
      })),
      totals: { debit: inflows, credit: outflows },
      closing,
      filename: `cash-flow-${fromDate}-${toDate}`,
      autoPrint: true,
      fmt,
      userName: user?.username ?? null,
    } as any);
  };

  function handleSearch() {
    if (fromDate && toDate && fromDate > toDate) {
      toast({ title: "تاريخ البداية بعد تاريخ النهاية", variant: "destructive" });
      return;
    }
    setSearched(true);
    refetch();
  }

  const summaryCards = [
    { label: "الرصيد الافتتاحي", value: opening, icon: PiggyBank, tone: "text-slate-700",   bg: "from-slate-50 to-zinc-50 border-slate-200" },
    { label: "إجمالي الوارد",    value: inflows, icon: ArrowDownToLine, tone: "text-emerald-700", bg: "from-emerald-50 to-teal-50 border-emerald-200" },
    { label: "إجمالي المنصرف",   value: outflows, icon: ArrowUpFromLine, tone: "text-rose-700",   bg: "from-rose-50 to-pink-50 border-rose-200" },
    { label: "صافي التدفق",      value: net, icon: Scale, tone: net >= 0 ? "text-emerald-700" : "text-rose-700", bg: net >= 0 ? "from-emerald-50 to-teal-50 border-emerald-200" : "from-rose-50 to-pink-50 border-rose-200", signed: true },
    { label: "الرصيد الختامي",   value: closing, icon: Wallet, tone: closing >= 0 ? "text-primary" : "text-destructive", bg: "from-blue-50 to-indigo-50 border-blue-200" },
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Waves className="h-6 w-6 text-primary" />
            تقرير التدفقات النقدية
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            حركة النقدية الفعلية (الصناديق والبنوك) من واقع قيود اليومية المرحّلة — وارد، منصرف، ورصيد جارٍ
          </p>
        </div>
        <div className="flex gap-2">
          {searched && (view === "summary" ? !!data : rows.length > 0) && (view === "summary" ? (
            <>
              <ExportButtons
                rows={summaryExportRows}
                columns={SUMMARY_EXPORT_COLS}
                filename={`cash-flow-summary-${fromDate}-${toDate}`}
                title={`قائمة التدفقات النقدية (ملخص) من ${fromDate} إلى ${toDate}`}
                totalsRow={summaryExportTotalsRow}
              />
              <Button variant="outline" size="sm" className="gap-2 print:hidden" onClick={handlePrintSummary} data-testid="button-print-cashflow-summary">
                <Printer className="h-4 w-4" />طباعة
              </Button>
            </>
          ) : (
            <>
              <ExportButtons
                rows={exportRows}
                columns={EXPORT_COLS}
                filename={`cash-flow-${fromDate}-${toDate}`}
                title={`تقرير التدفقات النقدية من ${fromDate} إلى ${toDate}`}
                totalsRow={exportTotalsRow}
              />
              <Button variant="outline" size="sm" className="gap-2 print:hidden" onClick={handlePrint} data-testid="button-print-cashflow">
                <Printer className="h-4 w-4" />طباعة
              </Button>
            </>
          ))}
        </div>
      </div>

      {/* View toggle: ملخص الشركاء (صفحة واحدة) / تفصيلي */}
      <div className="inline-flex rounded-lg border bg-card p-1 shadow-sm">
        <button
          type="button"
          onClick={() => setView("summary")}
          data-testid="tab-cashflow-summary"
          className={cn(
            "px-4 py-1.5 rounded-md text-sm font-semibold transition-colors",
            view === "summary" ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground",
          )}
        >
          ملخص (نموذج الشركاء)
        </button>
        <button
          type="button"
          onClick={() => setView("detail")}
          data-testid="tab-cashflow-detail"
          className={cn(
            "px-4 py-1.5 rounded-md text-sm font-semibold transition-colors",
            view === "detail" ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground",
          )}
        >
          تفصيلي (كل الحركات)
        </button>
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
          <div className="space-y-1.5">
            <Label>من تاريخ</Label>
            <DateField value={fromDate} onChange={e => setFromDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>إلى تاريخ</Label>
            <DateField value={toDate} onChange={e => setToDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common.branch", { defaultValue: "الفرع" })}</Label>
            <BranchFilter value={branchId} onChange={setBranchId} />
          </div>
          <div className="space-y-1.5">
            <Label>حساب الخزينة / البنك</Label>
            <SearchCombobox
              items={[
                { value: "", label: isRtl ? "كل الصناديق والبنوك" : "All cash & banks" },
                ...treasuryItems,
              ]}
              value={accountId}
              onValueChange={setAccountId}
              placeholder="كل الصناديق والبنوك"
              searchPlaceholder="بحث بالكود أو الاسم…"
            />
          </div>
          <div className="space-y-1.5">
            <Label>العملة</Label>
            <SearchCombobox
              items={[
                { value: "", label: isRtl ? "كل العملات" : "All currencies" },
                ...currencies.map((c: any) => ({
                  value: String(c.id),
                  label: `${c.code} — ${isRtl ? (c.nameAr ?? c.code) : (c.nameEn || c.nameAr || c.code)}`,
                })),
              ]}
              value={currencyId}
              onValueChange={setCurrencyId}
              placeholder="كل العملات"
              searchPlaceholder="بحث…"
            />
          </div>
          <div className="space-y-1.5">
            <CostCenterFilter value={costCenterIds} onChange={setCostCenterIds} />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button className="gap-2" onClick={handleSearch} disabled={isLoading} data-testid="button-show-cashflow">
            <Search className="h-4 w-4" />
            {isLoading ? "جارِ التحميل…" : "عرض التقرير"}
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      {searched && !isLoading && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {summaryCards.map(c => (
            <div key={c.label} className={cn("rounded-xl border bg-gradient-to-l p-4 shadow-sm", c.bg)}>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{c.label}</span>
                <c.icon className={cn("h-4 w-4", c.tone)} />
              </div>
              <div className={cn("mt-1.5 font-mono text-lg font-bold tabular-nums", c.tone)} data-testid={`card-${c.label}`}>
                {(c as any).signed && c.value > 0 ? "+" : ""}{fmt(c.value)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state (detail view only — the summary form is required even with zeros) */}
      {searched && !isLoading && view === "detail" && rows.length === 0 && (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          لا توجد حركات نقدية في الفترة المحددة
        </div>
      )}

      {/* Partner-schedule summary (نموذج جدول رقم 3) — one printable page */}
      {searched && !isLoading && view === "summary" && data && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="border-b bg-muted/40 px-4 py-3">
            <h2 className="font-bold">قائمة التدفقات النقدية — ملخص ({fromDate} إلى {toDate})</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              مصنفة آليًا حسب الحساب المقابل ونوع القيد — التحويلات الداخلية بين الصناديق والبنوك مستبعدة
              {internalTransfers > 0 && <> (إجمالي التحويلات الداخلية المستبعدة: {fmt(internalTransfers)})</>}
            </p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/60 text-xs text-muted-foreground">
                <th className="px-3 py-2 text-start w-10">م</th>
                <th className="px-3 py-2 text-start">البيان</th>
                <th className="px-3 py-2 text-end w-28">عدد الحركات</th>
                <th className="px-3 py-2 text-end w-36">وارد</th>
                <th className="px-3 py-2 text-end w-36">منصرف</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b bg-amber-50/50 font-semibold">
                <td className="px-3 py-2">1</td>
                <td className="px-3 py-2">النقدية المتاحة — رصيد أول المدة</td>
                <td className="px-3 py-2 text-end text-muted-foreground">—</td>
                <td className={cn("px-3 py-2 text-end font-mono tabular-nums", opening >= 0 ? "text-primary" : "text-destructive")}>{fmt(opening)}</td>
                <td className="px-3 py-2" />
              </tr>
              {summaryNotes.map(n => {
                const meta = SUMMARY_NOTE_META[n.key];
                return (
                  <tr key={n.key} className={cn("border-b", n.amount === 0 && "text-muted-foreground/70")} data-testid={`summary-row-${n.key}`}>
                    <td className="px-3 py-2">{n.no}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{meta?.label ?? n.key}</div>
                      {meta?.desc && <div className="text-[11px] text-muted-foreground mt-0.5">{meta.desc}</div>}
                    </td>
                    <td className="px-3 py-2 text-end font-mono tabular-nums">
                      {n.count > 0 ? (
                        <button
                          type="button"
                          className="text-primary hover:underline"
                          title="عرض الحركات التفصيلية"
                          onClick={() => setView("detail")}
                        >
                          {n.count}
                        </button>
                      ) : "0"}
                    </td>
                    <td className="px-3 py-2 text-end font-mono tabular-nums text-emerald-700">{n.side === "in"  ? fmt(n.amount) : ""}</td>
                    <td className="px-3 py-2 text-end font-mono tabular-nums text-rose-700">{n.side === "out" ? fmt(n.amount) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t bg-muted/50 font-bold">
                <td className="px-3 py-2" colSpan={2}>الإجمالي</td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2 text-end font-mono tabular-nums text-emerald-700">{fmt(summaryInTotal)}</td>
                <td className="px-3 py-2 text-end font-mono tabular-nums text-rose-700">{fmt(summaryOutTotal)}</td>
              </tr>
              <tr className="bg-muted/30 font-semibold">
                <td className="px-3 py-2" colSpan={2}>صافي التدفق النقدي للفترة</td>
                <td className="px-3 py-2" />
                <td colSpan={2} className={cn("px-3 py-2 text-end font-mono tabular-nums", summaryNet >= 0 ? "text-emerald-700" : "text-rose-700")}>
                  {summaryNet > 0 ? "+" : ""}{fmt(summaryNet)}
                </td>
              </tr>
              <tr className="bg-blue-50/60 font-bold">
                <td className="px-3 py-2" colSpan={2}>النقدية المتاحة — رصيد آخر المدة</td>
                <td className="px-3 py-2" />
                <td colSpan={2} className={cn("px-3 py-2 text-end font-mono tabular-nums", summaryClosing >= 0 ? "text-primary" : "text-destructive")}>
                  {fmt(summaryClosing)}
                </td>
              </tr>
            </tfoot>
          </table>
          <div className="border-t px-4 py-2 text-[11px] text-muted-foreground">
            ملاحظة عامة: البنود غير المنطبقة تظهر بقيمة صفر وفق متطلبات النموذج — وتُراجع نتيجة التصنيف الآلي من العرض التفصيلي قبل الإرسال.
          </div>
        </div>
      )}

      {/* Grid */}
      {searched && view === "detail" && rows.length > 0 && (
        <AdvancedReportGrid
          slug="cashFlowReportGrid"
          cid={cid}
          rowKey={(r: any, i) => r.lineId ?? i}
          rows={rows}
          unitLabel="حركة"
          emptyMessage="لا توجد حركات"
          leadingRows={[{
            __className: "bg-amber-50/40 font-semibold",
            date:        fromDate || "—",
            docNumber:   <span className="text-muted-foreground">—</span>,
            type: (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-gradient-to-l from-slate-50 to-zinc-50 px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm">
                رصيد افتتاحي
              </span>
            ),
            description: <span className="italic text-muted-foreground">الرصيد الافتتاحي للفترة</span>,
            counter:     <span className="text-xs text-muted-foreground">—</span>,
            account:     <span className="text-xs text-muted-foreground">—</span>,
            inflow:      "",
            outflow:     "",
            balance: (
              <span className={cn("font-mono", opening >= 0 ? "text-primary" : "text-destructive")}>
                {fmt(opening)}
              </span>
            ),
          }]}
          totalsRow={{
            __label: <span>الإجمالي</span>,
            inflow:  <span className="font-mono text-emerald-700">{fmt(inflows)}</span>,
            outflow: <span className="font-mono text-rose-700">{fmt(outflows)}</span>,
            balance: (
              <span className={cn("font-mono font-semibold", closing >= 0 ? "text-primary" : "text-destructive")}>
                {fmt(closing)}
              </span>
            ),
          }}
          columns={[
            { key: "date", label: "التاريخ", type: "text",
              className: "font-mono tabular-nums text-slate-600",
              value: (r: any) => r.date,
            },
            { key: "docNumber", label: "رقم القيد", type: "text",
              className: "font-mono tabular-nums",
              value: (r: any) => r.docNumber ?? `JE-${r.entryId}`,
              render: (r: any) => (
                <Link
                  href={`/accounting/journals/${r.entryId}`}
                  className="inline-flex items-center gap-1 text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary/40 rounded font-semibold"
                  data-testid={`link-je-${r.entryId}`}
                  title="فتح القيد"
                >
                  {r.docNumber || `JE-${r.entryId}`}
                  <ExternalLink className="h-3 w-3 opacity-60" />
                </Link>
              ),
            },
            { key: "type", label: "نوع الحركة", type: "text",
              value: (r: any) => typeLabel(r.entryType),
              render: (r: any) => (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border bg-gradient-to-l px-2.5 py-1 text-xs font-medium shadow-sm whitespace-nowrap",
                    typeTone(r.entryType),
                  )}
                  title={r.entryType ?? "general"}
                >
                  {typeLabel(r.entryType)}
                </span>
              ),
            },
            { key: "account", label: "الخزينة / البنك", type: "text",
              value: (r: any) => r.accountName,
              render: (r: any) => (
                <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
                  {r.accountKind === "bank"
                    ? <Landmark className="h-3.5 w-3.5 text-blue-600" />
                    : <Wallet className="h-3.5 w-3.5 text-emerald-600" />}
                  {isRtl ? r.accountName : (r.accountNameEn || r.accountName)}
                </span>
              ),
            },
            { key: "description", label: "البيان", type: "text",
              className: "text-muted-foreground",
              value: (r: any) => r.description ?? "",
              render: (r: any) => <span className="max-w-xs truncate inline-block align-middle" title={r.description || ""}>{r.description || "—"}</span>,
            },
            { key: "category", label: "التصنيف", type: "text",
              value: (r: any) => r.category === "internal_transfer"
                ? "تحويل داخلي (مستبعد من الملخص)"
                : (SUMMARY_NOTE_META[r.category as string]?.label ?? "—"),
              render: (r: any) => (
                <span
                  className={cn(
                    "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium max-w-[220px] truncate",
                    r.category === "internal_transfer"
                      ? "border-slate-300 bg-slate-50 text-slate-600"
                      : r.category?.startsWith("in_")
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-rose-200 bg-rose-50 text-rose-800",
                  )}
                  title={r.category === "internal_transfer" ? "تحويل داخلي بين الصناديق والبنوك — مستبعد من الملخص" : (SUMMARY_NOTE_META[r.category as string]?.label ?? "")}
                >
                  {r.category === "internal_transfer" ? "تحويل داخلي" : (SUMMARY_NOTE_META[r.category as string]?.label ?? "—")}
                </span>
              ),
            },
            { key: "counter", label: "الحساب المقابل", type: "text",
              value: (r: any) => (r.counterAccounts || []).join("، "),
              render: (r: any) => {
                const list: string[] = r.counterAccounts || [];
                if (!list.length) return <span className="text-xs text-muted-foreground">—</span>;
                return (
                  <span className="inline-flex flex-wrap gap-1 max-w-sm" title={list.join("، ")}>
                    {list.slice(0, 2).map(c => (
                      <span key={c} className="inline-flex items-center rounded-full border border-indigo-200 bg-gradient-to-l from-indigo-50 to-blue-50 px-2 py-0.5 text-[11px] font-medium text-indigo-800 shadow-sm truncate max-w-[180px]">
                        {c}
                      </span>
                    ))}
                    {list.length > 2 && (
                      <span className="text-[11px] text-muted-foreground">+{list.length - 2}</span>
                    )}
                  </span>
                );
              },
            },
            { key: "inflow", label: "وارد", type: "num",
              align: "end", totalable: true,
              className: "font-mono tabular-nums",
              value: (r: any) => r.inflow ?? 0,
              render: (r: any) => <span className="text-emerald-700 font-semibold">{r.inflow > 0 ? fmt(r.inflow) : ""}</span>,
            },
            { key: "outflow", label: "منصرف", type: "num",
              align: "end", totalable: true,
              className: "font-mono tabular-nums",
              value: (r: any) => r.outflow ?? 0,
              render: (r: any) => <span className="text-rose-700 font-semibold">{r.outflow > 0 ? fmt(r.outflow) : ""}</span>,
            },
            { key: "balance", label: "الرصيد", type: "num",
              align: "end",
              className: "font-mono tabular-nums",
              value: (r: any) => r.balance ?? 0,
              render: (r: any) => (
                <span className={cn("font-mono", r.balance >= 0 ? "text-primary" : "text-destructive")}>
                  {fmt(r.balance)}
                </span>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
