import { useState, useEffect, useRef } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { journalEntriesApi } from "@/lib/journalEntriesApi";
import { branchesApi } from "@/lib/branchesApi";
import {
  buildDetailedJournalPrintHtml,
  JE_ONE_PER_PAGE_LS_KEY,
  type JournalPrintEntry,
} from "@/lib/journalPrint";
import { safeLogoSrc } from "@/lib/export";
import { AccountCombobox } from "@/components/AccountCombobox";
import AccountBrowserDialog from "@/components/AccountBrowserDialog";
import { JournalPartyPicker } from "@/components/JournalPartyPicker";
import { JournalScanArchive } from "@/components/JournalScanArchive";
import { renameArchivedKey } from "@/lib/localArchive";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SmartDateInput } from "@/components/ui/smart-date-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";
import { getSaveToastTitle } from "@/lib/saveToast";
import { useFormatters, fmt2, fmtNum } from "@/lib/format";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import { useFieldPolicy } from "@/hooks/useInvoiceFieldPolicy";
import { useCompanyTaxes } from "@/hooks/useCompanyTaxes";
import { Sparkles, AlertTriangle, CheckCircle2, Receipt, Copy, Check, Landmark } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  Plus, Trash2, ArrowRight, BookOpen, AlertCircle,
  FileText, Printer, FileSpreadsheet, FileDown, Lock,
  ChevronRight, ChevronLeft, Search, Wand2, RotateCcw,
} from "lucide-react";
import {
  SupplierTaxDetailsMenu,
  type SupplierTaxDetails,
} from "@/components/SupplierTaxDetailsDialog";
import * as XLSX from "xlsx";
import { saveWorkbook } from "@/lib/saveFile";
import { useDemoActionGate } from "@/hooks/use-demo-action-gate";

const ENTRY_TYPES = [
  { value: "general",      label: "قيد عام" },
  { value: "opening",      label: "قيد افتتاحي" },
  { value: "closing",      label: "قيد إقفال" },
  { value: "adjustment",   label: "قيد تسوية" },
  { value: "depreciation", label: "قيد إهلاك" },
];

// ── القيود الخاصة (نوع القيد) ──────────────────────────────────────
// A create-mode-only selector that turns the JE screen into the unified
// entry point for special manual entries. Each kind REUSES an existing
// module's endpoint after the JE saves — no business logic is duplicated:
//   opening        → entryType="opening" (نفس آلية الأرصدة الافتتاحية)
//   fixed_asset    → POST /fixed-assets/assets  (sourceType=journal_entry)
//   prepaid/…      → POST /adjustments type=prepaid (محرك التسويات الشهرية)
//   accrued/…      → POST /adjustments type=accrued (استحقاق بفترة واحدة)
const SPECIAL_KINDS = [
  { value: "normal",           label: "قيد عادي" },
  { value: "opening",          label: "قيد افتتاحي" },
  { value: "fixed_asset",      label: "قيد أصل ثابت" },
  { value: "prepaid_expense",  label: "قيد مصروف مقدم" },
  { value: "deferred_revenue", label: "قيد إيراد مقدم" },
  { value: "accrued_expense",  label: "قيد مصروف مستحق" },
  { value: "accrued_revenue",  label: "قيد إيراد مستحق" },
];
const ADJ_KINDS = ["prepaid_expense", "deferred_revenue", "accrued_expense", "accrued_revenue"];

// Auto-generated journal entries (created from sales/purchase invoices,
// vouchers, settlements, stock moves, payroll, etc.) MUST NOT be edited
// directly from this form — the source document is the single source of
// truth. The same allowlist lives on the server (LOCKED_ENTRY_TYPES in
// routes/journalEntries.ts) which returns HTTP 403 on PUT/DELETE; this
// table is a UX mirror only, so users see the lock immediately instead
// of after a failed save round-trip. Keep both lists in sync.
const LOCKED_ENTRY_TYPES: Record<string, { source: string; hint: string }> = {
  sales_invoice:        { source: "فاتورة مبيعات",       hint: "افتح الفاتورة وقم بفك ترحيلها لتعديل القيد." },
  sales_return:         { source: "مرتجع مبيعات",        hint: "افتح مرتجع المبيعات وقم بفك ترحيله." },
  purchase_invoice:     { source: "فاتورة مشتريات",      hint: "افتح فاتورة المشتريات وقم بفك ترحيلها." },
  purchase_return:      { source: "مرتجع مشتريات",       hint: "افتح مرتجع المشتريات وقم بفك ترحيله." },
  // Voucher routes today emit the legacy bare strings "receipt" /
  // "payment" — both the canonical and the legacy values are kept
  // here so the lock fires regardless of which writer produced the
  // entry. The server LOCKED_ENTRY_TYPES list mirrors this.
  receipt_voucher:      { source: "سند قبض",             hint: "افتح سند القبض وقم بفك ترحيله." },
  receipt:              { source: "سند قبض",             hint: "افتح سند القبض وقم بفك ترحيله." },
  payment_voucher:      { source: "سند صرف",             hint: "افتح سند الصرف وقم بفك ترحيله." },
  payment:              { source: "سند صرف",             hint: "افتح سند الصرف وقم بفك ترحيله." },
  customer_settlement:  { source: "تسوية عميل",          hint: "افتح تسوية العميل وقم بفك ترحيلها." },
  supplier_settlement:  { source: "تسوية مورد",          hint: "افتح تسوية المورد وقم بفك ترحيلها." },
  stock_transfer:       { source: "تحويل مخزني",         hint: "افتح أمر التحويل وقم بفك ترحيله." },
  stock_adjustment:     { source: "تسوية مخزون",         hint: "افتح تسوية المخزون وقم بفك ترحيلها." },
  payroll_run:          { source: "تشغيل رواتب",         hint: "افتح تشغيل الرواتب وقم بفك ترحيله." },
  employee_loan:        { source: "سلفة موظف",           hint: "افتح حركة السلفة وقم بفك ترحيلها." },
  eos_payment:          { source: "مكافأة نهاية خدمة",   hint: "افتح حركة نهاية الخدمة وقم بفك ترحيلها." },
};

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface JournalLine {
  id:          string;
  accountId:   string;
  costCenter:  string;
  debit:       string;
  credit:      string;
  description: string;
  // Per-line supplier tax metadata (entered via the ⋮ dialog) — surfaces in the
  // VAT declaration report + tax account statement for input/output-VAT lines.
  supplierName:          string;
  supplierVatNumber:     string;
  supplierInvoiceNumber: string;
  supplierInvoiceDate:   string;
  // UI-only link: id of the source JE line this VAT/zero-tax line was
  // generated from. Guarantees ONE tax line per source line — a re-click
  // REPLACES the existing linked tax line instead of appending a sibling.
  // Never sent to the backend (payload mapping picks explicit fields).
  taxOfLineId?: string;
}

function newLine(): JournalLine {
  return {
    id: crypto.randomUUID(), accountId: "", costCenter: "", debit: "", credit: "", description: "",
    supplierName: "", supplierVatNumber: "", supplierInvoiceNumber: "", supplierInvoiceDate: "",
  };
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function JournalEntryForm() {
    const gate = useDemoActionGate();
  const { user } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  // Company-wide "smart model" journal form. When ON, adding a line
  // auto-fills the opposite side with the remaining imbalance so the
  // entry stays balanced, and a "موازنة تلقائية" helper is exposed.
  const smartForm = !!user?.company?.journalSmartForm;
  const [, navigate] = useLocation();
  const [matchNew] = useRoute("/accounting/journals/new");
  const [matchEdit, params] = useRoute("/accounting/journals/:id");
  const isNew    = !!matchNew;
  const editId   = matchEdit ? Number((params as any).id) : null;
  // "Duplicate" support: `/new?from=123` loads entry #123 and copies it
  // into a brand-new draft. isNew stays true → save POSTs to create a
  // fresh entry with a freshly-issued doc number.
  const fromId = (() => {
    if (!isNew) return null;
    const q = typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("from")
      : null;
    return q && /^\d+$/.test(q) ? Number(q) : null;
  })();
  const sourceId = editId ?? fromId;
  const qc       = useQueryClient();
  const { toast } = useToast();
  const { t }     = useTranslation();
  // Same isRtl source as the LIST screen so both print paths stay in parity.
  const { isRtl } = useFormatters();

  const [activeTab,    setActiveTab]    = useState("header");
  const [docNumber,    setDocNumber]    = useState("");
  const [newArchiveKey, setNewArchiveKey] = useState(
    () => `JE-new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const [entryDate,    setEntryDate]    = useState(today());
  const [currency,     setCurrency]     = useState("SAR");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [description,  setDescription]  = useState("");
  const [entryType,    setEntryType]    = useState("general");
  const [branchId,     setBranchId]     = useState("");
  // ── نوع القيد (القيود الخاصة) — create mode only ──────────────────
  const [specialKind, setSpecialKind] = useState("normal");
  const [spec, setSpec] = useState<Record<string, string>>({});
  const setSpecF = (k: string, v: string) => setSpec(p => ({ ...p, [k]: v }));
  const [lines,        setLines]        = useState<JournalLine[]>([newLine(), newLine()]);
  // ── سداد فاتورة آجلة عن طريق القيد ────────────────────────────────
  // Seeded from query params when the user arrives from the invoice's
  // "السداد" tab (سداد بقيد محاسبي), or restored from the loaded entry on
  // edit. settlementAmount is in the ENTRY's currency; the server converts
  // to base and enforces the same overpayment policy as the vouchers.
  const settleSeed = (() => {
    if (!isNew || typeof window === "undefined") return null;
    const q = new URLSearchParams(window.location.search);
    const sid = q.get("salesInvoiceId");
    const pid = q.get("purchaseInvoiceId");
    if (!sid && !pid) return null;
    return {
      salesInvoiceId:    sid && /^\d+$/.test(sid) ? Number(sid) : null,
      purchaseInvoiceId: pid && /^\d+$/.test(pid) ? Number(pid) : null,
      amount:     q.get("amount") ?? "",
      entityName: q.get("entityName") ?? "",
      invoiceNo:  q.get("invoiceNo") ?? "",
    };
  })();
  const [settleSalesInvoiceId, setSettleSalesInvoiceId] =
    useState<number | null>(settleSeed?.salesInvoiceId ?? null);
  const [settlePurchaseInvoiceId, setSettlePurchaseInvoiceId] =
    useState<number | null>(settleSeed?.purchaseInvoiceId ?? null);
  const [settlementAmount, setSettlementAmount] = useState<string>(settleSeed?.amount ?? "");
  const settleLinked = settleSalesInvoiceId != null || settlePurchaseInvoiceId != null;
  // Display metadata when the link is picked from THIS screen (ربط بفاتورة)
  // instead of arriving via query params.
  const [settleMeta, setSettleMeta] = useState<{ invoiceNo: string; entityName: string; remaining?: number } | null>(null);
  // While TRUE, مبلغ السداد auto-follows the JE debit total (capped at the
  // invoice remaining). Manual typing in the field flips it off.
  const [settleAmountAuto, setSettleAmountAuto] = useState(false);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkKind, setLinkKind] = useState<"sales" | "purchase">("sales");
  const [focusLineId, setFocusLineId] = useState<string>(() => "");
  // Which line's per-line tax popover is currently open (null = none).
  const [taxPopoverLine, setTaxPopoverLine] = useState<string | null>(null);
  useEffect(() => {
    if (lines.length > 0 && !lines.some(l => l.id === focusLineId)) {
      setFocusLineId(lines[0].id);
    }
  }, [lines, focusLineId]);

  const { token } = useAuth() as any;
  const authHeaders = { Authorization: `Bearer ${token}` };

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", cid],
    queryFn: () => branchesApi.getBranches(cid),
    enabled: !!user,
  });

  // Auto-pick the main branch ONCE when creating a new entry. After that we
  // never touch branchId again, so picking "— بدون فرع —" (which sets it to
  // "") is preserved instead of being re-defaulted on the next render.
  const defaultBranch = (branches as any[]).find((b: any) => b.isMain) ?? (branches as any[])[0];
  const branchDefaultedRef = useRef(false);
  useEffect(() => {
    if (!isNew || branchDefaultedRef.current || !defaultBranch || branchId) return;
    setBranchId(String(defaultBranch.id));
    branchDefaultedRef.current = true;
  }, [isNew, defaultBranch?.id, branchId]);

  const { data: dbCurrencies = [] } = useQuery<any[]>({
    queryKey: ["currencies", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/currencies?companyId=${cid}` : `${API}/api/currencies`;
      const res = await fetch(url, { headers: authHeaders });
      return res.json();
    },
    enabled: !!user,
  });

  const { data: exchangeRates = [] } = useQuery<any[]>({
    queryKey: ["exchange-rates", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/currencies/rates?companyId=${cid}` : `${API}/api/currencies/rates`;
      const res = await fetch(url, { headers: authHeaders });
      return res.json();
    },
    enabled: !!user,
  });

  const hasCurrencies = dbCurrencies.length > 0;
  const defaultCurrency = dbCurrencies.find((c: any) => c.isDefault) ?? dbCurrencies[0];

  function getLatestRate(selectedCode: string): string {
    if (!hasCurrencies) return "1";
    const selected = dbCurrencies.find((c: any) => c.code === selectedCode);
    const base     = defaultCurrency;
    if (!selected || !base || selected.id === base.id) return "1";
    const rate = exchangeRates
      .filter((r: any) =>
        (r.fromCurrencyId === selected.id && r.toCurrencyId === base.id) ||
        (r.fromCurrencyId === base.id     && r.toCurrencyId === selected.id)
      )
      .sort((a: any, b: any) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
    if (!rate) return "1";
    if (rate.fromCurrencyId === selected.id) return String(rate.rate);
    return String((1 / Number(rate.rate)).toFixed(6));
  }

  function handleCurrencyChange(code: string) {
    setCurrency(code);
    setExchangeRate(getLatestRate(code));
  }

  useEffect(() => {
    if (!isNew || !hasCurrencies || !defaultCurrency) return;
    setCurrency(defaultCurrency.code);
    setExchangeRate("1");
  }, [isNew, defaultCurrency?.code]);

  const { data: existing, isLoading: loadingEdit } = useQuery({
    queryKey: ["journal-entry", sourceId],
    queryFn:  () => journalEntriesApi.get(sourceId!, cid),
    enabled:  !!sourceId,
  });

  // مجموعات الأصول الثابتة — تُحمَّل فقط عند اختيار "قيد أصل ثابت".
  const { data: faGroups = [] } = useQuery<any[]>({
    queryKey: ["fa-groups", cid],
    enabled: !!user && specialKind === "fixed_asset",
    queryFn: async () => {
      const url = `${API}/api/fixed-assets/groups${cid ? `?companyId=${cid}` : ""}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const j = r.ok ? await r.json() : [];
      return Array.isArray(j) ? j : [];
    },
  });

  // ── Document navigation (سابق / تالي / بحث) ──────────────────────
  // Pulls the journal-entry list (already cached when the user comes
  // from the listing page) and lets the user step from one entry to
  // its neighbour without going back to the table. The list is sorted
  // newest-first by the API, which we keep so "السابق" walks toward
  // older entries and "التالي" toward newer ones — matching how the
  // table is displayed.
  // Always fetch the entry list — even on a NEW form — so the predicted
  // QYD-XXXX badge reflects the most recent saved entry. With this query
  // disabled in new mode, the prediction had no data to compute from and
  // would stick to a stale value (e.g. seqPeek cache) until the form
  // remounted. Short staleTime keeps the next prediction fresh after each
  // save (qc.invalidateQueries fires in onSuccess).
  const { data: navList = [] } = useQuery<any[]>({
    queryKey: ["journal-entries", cid, "nav"],
    queryFn:  () => journalEntriesApi.listNav(cid),
    enabled:  !!user,
    staleTime: 5_000,
  });
  const currentIndex = editId != null
    ? navList.findIndex((e: any) => Number(e.id) === Number(editId))
    : -1;
  // "السابق" → older entry (further down in the newest-first list).
  const prevEntry = currentIndex >= 0 && currentIndex < navList.length - 1
    ? navList[currentIndex + 1] : null;
  // "التالي" → newer entry (further up in the newest-first list).
  const nextEntry = currentIndex > 0 ? navList[currentIndex - 1] : null;

  const [navSearch, setNavSearch] = useState("");
  function jumpFromSearch() {
    const q = navSearch.trim();
    if (!q) return;
    const lower = q.toLowerCase();
    // 1) exact doc-number match wins; 2) substring on doc-number;
    // 3) substring on description.
    const hit =
      navList.find((e: any) => String(e.docNumber ?? "").toLowerCase() === lower) ||
      navList.find((e: any) => String(e.docNumber ?? "").toLowerCase().includes(lower)) ||
      navList.find((e: any) => String(e.description ?? "").toLowerCase().includes(lower));
    if (!hit) {
      toast({ title: "لم يتم العثور على مستند مطابق", variant: "destructive" });
      return;
    }
    setNavSearch("");
    navigate(`/accounting/journals/${hit.id}`);
  }

  // ── Document number (next-estimated peek) ────────────────────
  // For new entries we PEEK the next number from the central sequence
  // engine (مسلسل الحركات) and show it in the badge so the user knows
  // what number THIS save will get. Nothing is consumed until the user
  // actually clicks Save — closing/cancelling the form leaves no row
  // and no number gap by design.
  //
  // The peek is read-only and is recomputed after each save so the badge
  // immediately advances to the next number for the user's next entry.
  // Pass the user-entered `entryDate` so the peek is resolved against the
  // fiscal period of THAT date. Without this, changing the date from today
  // (2026) to a backdated 2025 would still show the 2026-scoped sequence
  // number — and then on Save the server would correctly pick the 2025
  // sequence, leaving the user confused about why the badge didn't match.
  const seqPeek = useNextSequenceNumber("journal_entry", isNew, entryDate, branchId);

  // ── Field-level governance (شاشة "حوكمة حقول الفواتير") ─────────────
  // The SuperAdmin can hide / lock / require any header field on this form
  // per assigned profile. Admins & SuperAdmins bypass; everyone else honours
  // the bundle returned by /api/invoice-field-policies/me. See FIELD_CATALOGUE
  // for the registered field keys.
  const fp = useFieldPolicy("journal_entry");

  // Track the value we auto-filled from the central sequence so we can
  // clear it when the user picks a date that falls in a different fiscal
  // period (or no period at all). Without this, the docNumber state from
  // the previous date — e.g. "QU010001" auto-filled for a 2026 date —
  // would linger after the user switches to 2025-05-18 where the QU
  // sequence is out of scope, making it look like the system ignored the
  // date change. We only ever clear our OWN auto-filled value, never
  // anything the user typed manually.
  const lastAutoFilledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isNew) return;
    if (seqPeek.loading) return;
    if (seqPeek.hasSequence && seqPeek.number) {
      setDocNumber(seqPeek.number);
      lastAutoFilledRef.current = seqPeek.number;
    } else {
      setDocNumber(prev => (prev && prev === lastAutoFilledRef.current ? "" : prev));
      lastAutoFilledRef.current = null;
    }
  }, [isNew, seqPeek.loading, seqPeek.hasSequence, seqPeek.number]);

  const { data: accountsList = [] } = useQuery<any[]>({
    queryKey: ["accounts-flat", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const res = await fetch(url, { headers: authHeaders });
      return res.json();
    },
    enabled: !!user,
  });

  const { data: costCentersList = [] } = useQuery<any[]>({
    queryKey: ["cost-centers", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/cost-centers?companyId=${cid}` : `${API}/api/cost-centers`;
      const res = await fetch(url, { headers: authHeaders });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user,
  });
  // Open credit invoices with remaining due — for the "ربط بفاتورة" picker.
  const { data: openInvoices = [], isLoading: loadingOpenInvoices } = useQuery<any[]>({
    queryKey: ["je-open-invoices", cid, linkKind],
    queryFn: async () => {
      const url = `${API}/api/journal-entries/open-invoices?kind=${linkKind}${cid ? `&companyId=${cid}` : ""}`;
      const res = await fetch(url, { headers: authHeaders });
      if (!res.ok) return [];
      const body = await res.json();
      return Array.isArray(body) ? body : [];
    },
    enabled: !!user && linkPickerOpen,
  });

  const costCenterOptions = [
    { value: "", label: "— بدون مركز تكلفة —" },
    ...costCentersList
      .filter((c: any) => c.isActive !== false)
      .map((c: any) => ({ value: c.code, label: `${c.code} — ${c.nameAr}` })),
  ];
  const acctMap = new Map<number, any>(accountsList.map((a: any) => [a.id, a]));
  const bankAccountIds = new Set<number>();
  for (const account of accountsList) {
    if (account.accountType !== "asset") continue;
    let current: any = account;
    const visited = new Set<number>();
    while (current && !visited.has(Number(current.id))) {
      visited.add(Number(current.id));
      if (["1102", "11021"].includes(String(current.code))) {
        bankAccountIds.add(Number(account.id));
        break;
      }
      current = current.parentId == null ? null : acctMap.get(Number(current.parentId));
    }
    // Legacy/imported charts sometimes lose parent links. The established bank
    // ledger branch is 1102; keep the fallback limited to asset posting leaves.
    if (
      !bankAccountIds.has(Number(account.id))
      && account.isPosting !== false
      && (String(account.code || "").startsWith("1102") || String(account.code || "").startsWith("11021"))
      && String(account.code || "").length > 5
      && (account.parentId == null || !acctMap.has(Number(account.parentId)))
    ) {
      bankAccountIds.add(Number(account.id));
    }
  }
  const isBankAccountId = (accountId: string | number | null | undefined) =>
    accountId != null && accountId !== "" && bankAccountIds.has(Number(accountId));

  // Bank metadata may arrive after an existing/manual JE has loaded. Clear any
  // stale dimension as soon as the account is recognised; the database trigger
  // remains the authoritative guard for every non-UI producer.
  useEffect(() => {
    if (bankAccountIds.size === 0) return;
    setLines(prev => prev.map(line =>
      isBankAccountId(line.accountId) && line.costCenter
        ? { ...line, costCenter: "" }
        : line
    ));
  }, [accountsList]);
  const acctLabel = (id: any) => {
    const a = acctMap.get(Number(id));
    return a ? `${a.code} — ${a.nameAr || a.nameEn || ""}` : "—";
  };

  // A line is a "VAT line" when its selected account is a tax account. The
  // supplier-tax ⋮ menu shows ONLY on VAT lines so the user can't mistakenly
  // attach supplier details to a normal (non-tax) line. Detection is PRIMARILY
  // driven by the account IDs actually routed by the company's tax catalog
  // (sales/purchase/generic tax accounts — handles custom-mapped VAT accounts
  // that don't use the standard COA codes), then falls back to the standard COA
  // codes (11071 input / 21041 output) and an Arabic/English VAT name match.
  // NOTE: reads `jeTaxes` via closure — it is declared later in this component
  // but this helper is only invoked during render (after all consts init).
  const VAT_ACCOUNT_CODES = new Set(["11071", "21041"]);
  const isVatAccountLine = (line: JournalLine) => {
    if (!line.accountId) return false;
    const accId = String(line.accountId);
    for (const t of jeTaxes as any[]) {
      for (const id of [t?.salesTaxAccountId, t?.purchaseTaxAccountId, t?.accountId]) {
        if (id != null && String(id) === accId) return true;
      }
    }
    const a = acctMap.get(Number(line.accountId));
    if (!a) return false;
    const code = String(a.code ?? "");
    const name = String(a.nameAr ?? a.nameEn ?? "");
    return (
      VAT_ACCOUNT_CODES.has(code) ||
      /ضريبة\s+(القيمة المضافة|المدخلات|المخرجات)/.test(name) ||
      /\bVAT\b|value[\s-]?added tax/i.test(name)
    );
  };

  // Cost-center lookup: the value stored on a JE line MAY be either the
  // numeric id (system-generated JEs e.g. fa-journals, contracting,
  // production all stringify the id) OR the code (manual JEs created in
  // this form, where `costCenterOptions` uses `c.code` as the value).
  // Index by both so display logic and the print template can resolve
  // either format to a friendly "code — nameAr" label.
  const ccById = new Map<string, any>();
  const ccByCode = new Map<string, any>();
  for (const c of costCentersList) {
    if (c?.id != null)   ccById.set(String(c.id), c);
    if (c?.code != null) ccByCode.set(String(c.code), c);
  }
  const findCc = (value: any) => {
    if (value == null || value === "") return null;
    const v = String(value);
    return ccByCode.get(v) ?? ccById.get(v) ?? null;
  };
  /** Friendly "code — name" label for a cost-center value (id or code). */
  const ccLabel = (value: any) => {
    const c = findCc(value);
    if (!c) return value ? String(value) : "—";
    return `${c.code} — ${c.nameAr || c.nameEn || ""}`;
  };
  // The combobox options key off `c.code`, but system-generated JEs
  // (fa-journals depreciation, production, contracting) store the numeric
  // id on the line. Normalize whatever is stored to the CODE so the picker
  // shows the selected centre in view/edit mode too (it already resolved in
  // print + tooltip via findCc). Falls through unchanged when unresolved.
  const ccCode = (value: any) => {
    const c = findCc(value);
    return c ? String(c.code) : (value == null ? "" : String(value));
  };

  useEffect(() => {
    if (!existing) return;
    // When duplicating (fromId), keep the freshly-issued sequence number
    // and today's date — only copy the editable header & lines. When
    // editing, restore the original doc number and entry date.
    const isDuplicate = !editId && !!fromId;
    if (!isDuplicate) {
      setDocNumber(existing.docNumber ?? "");
      setEntryDate(existing.entryDate ?? today());
    }
    setCurrency(existing.currency ?? "SAR");
    setExchangeRate(String(existing.exchangeRate ?? "1"));
    setDescription(existing.description ?? "");
    setEntryType(existing.entryType ?? "general");
    setBranchId(existing.branchId ? String(existing.branchId) : "");
    // Restore the invoice-settlement link on EDIT only — a duplicate must
    // never silently re-settle the same invoice a second time.
    if (editId) {
      setSettleSalesInvoiceId(existing.salesInvoiceId ?? null);
      setSettlePurchaseInvoiceId(existing.purchaseInvoiceId ?? null);
      setSettlementAmount(
        existing.settlementAmount != null ? String(Number(existing.settlementAmount)) : ""
      );
    }
    setLines(
      existing.lines?.length
        ? existing.lines.map((l: any) => ({
            id:          crypto.randomUUID(),
            accountId:   l.accountId ? String(l.accountId) : "",
            costCenter:  l.costCenter ?? "",
            debit:       l.debit  ? String(Number(l.debit))  : "",
            credit:      l.credit ? String(Number(l.credit)) : "",
            description: l.description ?? "",
            supplierName:          l.supplierName ?? "",
            supplierVatNumber:     l.supplierVatNumber ?? "",
            supplierInvoiceNumber: l.supplierInvoiceNumber ?? "",
            supplierInvoiceDate:   l.supplierInvoiceDate ?? "",
          }))
        : [newLine(), newLine()]
    );
    setActiveTab("header");
  }, [existing]);

  const totalDebit  = lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  const diff        = Math.abs(totalDebit - totalCredit);
  const isBalanced  = diff < 0.001;

  // Invoice-settlement link: while the amount is in AUTO mode, مبلغ السداد
  // follows the JE debit total (partial payment = the entry's own amount),
  // capped at the invoice remaining. Typing in the field manually turns
  // auto mode off (handled at the input's onChange).
  useEffect(() => {
    if (!settleLinked || !settleAmountAuto || settleMeta?.remaining == null) return;
    const rate = parseFloat(exchangeRate) || 1;
    const remainingEntry = settleMeta.remaining / rate;
    const next = totalDebit > 0.005
      ? Math.min(totalDebit, remainingEntry)
      : remainingEntry;
    const nextStr = next.toFixed(2);
    if (nextStr !== settlementAmount) setSettlementAmount(nextStr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalDebit, exchangeRate, settleLinked, settleAmountAuto, settleMeta]);

  // ── Source-document lock ────────────────────────────────────────
  // If this entry was auto-generated by a sales/purchase invoice, a
  // receipt/payment voucher, a customer/supplier settlement, a stock
  // transfer, payroll, etc., editing or deleting it directly would
  // break the link with its source document. We disable the whole
  // form (header + lines + Save) and show a banner explaining where
  // to actually go. The server enforces the same rule with HTTP 403.
  const lockInfo = existing?.entryType ? LOCKED_ENTRY_TYPES[existing.entryType] : undefined;
  const isLockedSourceEntry = !isNew && !!lockInfo;

  function updateLine(id: string, field: keyof JournalLine, value: string) {
    setLines(prev => prev.map(l => {
      if (l.id !== id) return l;
      if (field === "accountId") {
        return { ...l, accountId: value, costCenter: isBankAccountId(value) ? "" : l.costCenter };
      }
      if (field === "costCenter" && isBankAccountId(l.accountId)) {
        return { ...l, costCenter: "" };
      }
      return { ...l, [field]: value };
    }));
  }
  // Multi-field patch (used by the supplier-tax ⋮ dialog which sets 4 fields
  // at once). Kept separate from the single-field updateLine signature.
  function patchLine(id: string, patch: Partial<JournalLine>) {
    setLines(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));
  }
  function addLine() {
    // Inherit the general description so a newly-added line is consistent
    // with all the others — the user explicitly asked the البيان العام to
    // appear on every row, even when adding more rows after the fact.
    const l = { ...newLine(), description: description || "" };
    // Each new line starts with EMPTY supplier tax metadata. A single entry can
    // record several purchases from DIFFERENT suppliers (one supplier per VAT
    // line), so inheriting the previous line's supplier would silently
    // mis-attribute the tax. The accountant fills the ⋮ supplier details fresh
    // on every line to avoid mistakes.
    // Smart "model" mode: pre-fill the OPPOSITE side with the remaining
    // imbalance so the entry stays balanced after each added line. The
    // user can still overwrite the suggested amount freely.
    if (smartForm) {
      const d = totalDebit - totalCredit;
      if (d > 0.001)      l.credit = d.toFixed(2);
      else if (d < -0.001) l.debit  = (-d).toFixed(2);
    }
    setLines(prev => [...prev, l]);
    setFocusLineId(l.id);
    return l;
  }
  // Smart helper: drop the remaining imbalance onto a suitable line so the
  // entry becomes balanced in one click. Prefers an empty-amount line
  // (focused first, then the first available), otherwise appends a new one.
  function autoBalance() {
    const d = totalDebit - totalCredit;
    if (Math.abs(d) < 0.001) {
      toast({ title: "القيد متوازن بالفعل", description: "لا يوجد فرق بين المدين والدائن." });
      return;
    }
    const isEmptyAmt = (l: JournalLine) => !(parseFloat(l.debit) > 0) && !(parseFloat(l.credit) > 0);
    const focused = lines.find(l => l.id === focusLineId && isEmptyAmt(l));
    const firstEmpty = lines.find(isEmptyAmt);
    const target = focused ?? firstEmpty;
    const value = Math.abs(d).toFixed(2);
    if (target) {
      setLines(prev => prev.map(l =>
        l.id === target.id
          ? { ...l, debit: d < 0 ? value : "", credit: d > 0 ? value : "" }
          : l));
      setFocusLineId(target.id);
    } else {
      const l = { ...newLine(), description: description || "" };
      if (d > 0) l.credit = value; else l.debit = value;
      setLines(prev => [...prev, l]);
      setFocusLineId(l.id);
    }
    toast({ title: "✓ تمت الموازنة", description: `تمت إضافة ${value} لإكمال موازنة القيد.` });
  }

  // ── Smart Account Browser ───────────────────────────────────────
  // Opens a polished modal that lets the user discover accounts by
  // category (مصروفات / إيرادات / أصول…) when they don't remember the
  // exact name. The picked account is dropped into the currently
  // focused line — or a new line is created if every line already
  // has an account.
  const [accountBrowserOpen, setAccountBrowserOpen] = useState(false);
  // Copy-feedback state for the doc-number badge.
  const [docNumCopied, setDocNumCopied] = useState(false);
  function pickAccountFromBrowser(a: { id: number }) {
    // Find a target line: prefer the focused one if it's still empty,
    // otherwise the first empty line, otherwise append a new one.
    const empty = lines.find(l => !l.accountId);
    const focused = lines.find(l => l.id === focusLineId);
    let targetId: string;
    if (focused && !focused.accountId) targetId = focused.id;
    else if (empty)                     targetId = empty.id;
    else                                targetId = addLine().id;
    setLines(prev => prev.map(l => l.id === targetId
      ? { ...l, accountId: String(a.id), costCenter: isBankAccountId(a.id) ? "" : l.costCenter }
      : l));
    setFocusLineId(targetId);
    toast({ title: "✓ تم إدراج الحساب", description: "يمكنك الآن إدخال المبلغ في العمود المناسب." });
  }

  // ── قيد الضريبة (Tax Entry) ─────────────────────────────────────
  // Adds ONE VAT line computed on the line the user is currently
  // standing on (the focused row), on the same side, WITHOUT modifying
  // the original amount — appended as the LAST row.
  //   • "input"  → ضريبة المدخلات: if the focused line has debit > 0,
  //                 append a new Dr line of 15% × debit using the
  //                 input-VAT account.
  //   • "output" → ضريبة المخرجات: if the focused line has credit > 0,
  //                 append a new Cr line of 15% × credit using the
  //                 output-VAT account.
  // The focused line is taxed regardless of what other lines hold, so
  // the user controls exactly which row gets a VAT sibling. A line that
  // is itself a previously-generated VAT line (description starting with
  // "ضريبة …") or an already-net-extracted line is rejected, so the
  // workflow never pyramids tax on tax. After insertion focus moves to
  // the new VAT line, so an accidental re-click targets that VAT row
  // (rejected) instead of double-taxing the source.
  // NOTE: in exclusive mode the original amount is left untouched, so
  // the entry becomes unbalanced by the VAT amount — the user adds the
  // offsetting payable/receivable side (or clicks موازنة تلقائية).
  // Dynamic VAT rate — sourced from the company's DEFAULT tax in the dynamic
  // tax catalog (الضرائب). Falls back to 0.15 (KSA standard) when no percent
  // default exists, so existing Saudi tenants keep behaving exactly as before.
  const { taxesPercent: jeTaxes, defaultPercentTax: jeDefaultTax, byId: jeTaxById, comboItemsPercent: jeTaxComboItems } = useCompanyTaxes();
  // The tax applied by "قيد الضريبة" is user-selectable from the company tax
  // catalog and defaults to the company's default tax. The selected tax drives
  // BOTH the percent rate AND the routed VAT account (sales/purchase/generic).
  const [jeTaxId, setJeTaxId] = useState<string>("");
  useEffect(() => {
    if (!jeTaxId && jeDefaultTax) setJeTaxId(String(jeDefaultTax.id));
  }, [jeDefaultTax?.id]);
  const selectedJeTax = (jeTaxId ? jeTaxById.get(Number(jeTaxId)) : null) ?? jeDefaultTax ?? null;
  const VAT_RATE = (() => {
    const n = selectedJeTax && selectedJeTax.rateType === "percent" ? Number(selectedJeTax.rate) : NaN;
    return Number.isFinite(n) && n > 0 ? n / 100 : 0.15;
  })();
  const ratePctLabel = `${Number((VAT_RATE * 100).toFixed(2))}%`;
  // When true, "قيد الضريبة" treats source amounts as VAT-INCLUSIVE
  // (gross). For a 1000 line: VAT = 1000×15/115 = 130.43, source line
  // is rewritten down to the net 869.57 and a sibling VAT line of 130.43
  // is appended → entry stays balanced. When false (default) the
  // existing exclusive behaviour is kept: source unchanged, VAT added
  // on top, user adds the offsetting payable/receivable side manually.
  const [vatInclusive, setVatInclusive] = useState(false);
  // Marker appended to the source line description after it has been
  // split into its net component, so a re-click of "قيد الضريبة" does
  // not extract VAT a second time from the already-net amount.
  const NET_MARKER = ` (صافٍ من ضريبة ${ratePctLabel})`;
  // Stable substring used ONLY for detecting an already-net line — must NOT
  // include the rate so lines tagged under a previous/different rate (e.g. an
  // older 15% tag) are still recognised and never double-taxed.
  const NET_MARKER_PREFIX = "صافٍ من ضريبة";
  const taxEntryMutation = useMutation({
    mutationFn: (direction: "input" | "output") =>
      journalEntriesApi.suggestVatAccount({ direction, companyId: cid }),
  });
  // suggestVatAccount can be slow (AI/rules server round-trip). Cache the
  // per-direction result for the session AND prefetch both directions once
  // when the company tax has no routed account, so the per-line tax button
  // resolves instantly (<1s) on every click.
  type VatSuggestion = { accountId: number | null; accountLabel: string; reasoning: string; source: "ai" | "rules" };
  const vatSuggestCache = useRef<Partial<Record<"input" | "output", VatSuggestion>>>({});
  const vatSuggestInflight = useRef<Partial<Record<"input" | "output", Promise<VatSuggestion>>>>({});
  const fetchVatSuggestion = (direction: "input" | "output"): Promise<VatSuggestion> => {
    const cached = vatSuggestCache.current[direction];
    if (cached) return Promise.resolve(cached);
    let p = vatSuggestInflight.current[direction];
    if (!p) {
      p = taxEntryMutation.mutateAsync(direction).then((s: VatSuggestion) => {
        vatSuggestCache.current[direction] = s;
        return s;
      }).finally(() => { delete vatSuggestInflight.current[direction]; });
      vatSuggestInflight.current[direction] = p;
    }
    return p;
  };
  const taxNeedsSuggestion = (direction: "input" | "output") => {
    if (!selectedJeTax) return true;
    const routed = direction === "output"
      ? (selectedJeTax.salesTaxAccountId ?? selectedJeTax.accountId)
      : (selectedJeTax.purchaseTaxAccountId ?? selectedJeTax.accountId);
    return !routed;
  };
  // The suggestion is company-specific — a company/context switch must never
  // reuse the previous company's cached VAT account.
  useEffect(() => {
    vatSuggestCache.current = {};
    vatSuggestInflight.current = {};
  }, [cid]);
  useEffect(() => {
    // Fire-and-forget prefetch once the tax catalog resolves; errors are
    // swallowed here — the real click path re-tries and surfaces them.
    for (const d of ["input", "output"] as const) {
      if (taxNeedsSuggestion(d) && !vatSuggestCache.current[d]) {
        fetchVatSuggestion(d).catch(() => {});
      }
    }
  }, [cid, selectedJeTax?.id, selectedJeTax?.accountId, selectedJeTax?.salesTaxAccountId, selectedJeTax?.purchaseTaxAccountId, jeTaxes.length]);

  // A generated tax line is recognised either by its in-session link
  // (`taxOfLineId`) or — for entries reloaded from the server, where the link
  // is not persisted — by being the row DIRECTLY BELOW its source with the
  // generated description prefix. This keeps the ONE-tax-line-per-source
  // guarantee across edit sessions.
  const GENERATED_TAX_DESC = /^ضريبة (المدخلات|المخرجات|صفرية)/;
  const isGeneratedTaxLine = (l: JournalLine) =>
    !!l.taxOfLineId || (isVatAccountLine(l) && GENERATED_TAX_DESC.test((l.description || "").trim()));
  const findLinkedTaxIdx = (list: JournalLine[], sourceId: string) => {
    const byLink = list.findIndex(l => l.taxOfLineId === sourceId);
    if (byLink >= 0) return byLink;
    const srcIdx = list.findIndex(l => l.id === sourceId);
    if (srcIdx >= 0 && srcIdx + 1 < list.length) {
      const below = list[srcIdx + 1];
      if (!below.taxOfLineId && isGeneratedTaxLine(below)) return srcIdx + 1;
    }
    return -1;
  };

  async function applyTaxEntry(direction: "input" | "output", sourceLineId?: string) {
    if (isLockedSourceEntry) return;
    if (lines.length === 0) {
      toast({ title: "لا توجد سطور", description: "أضف سطراً أولاً قبل توليد قيد الضريبة.", variant: "destructive" });
      return;
    }
    const sideField: "debit" | "credit" = direction === "input" ? "debit" : "credit";

    // Tax EXACTLY the line whose per-line tax button was clicked. The explicit
    // `sourceLineId` removes any reliance on focus tracking (`focusLineId` was
    // only updated by the account combobox, never by typing an amount — so the
    // old toolbar button taxed the wrong row). A single VAT line is inserted
    // DIRECTLY BELOW that source row, computed on THAT row's amount. The
    // focus/last-row fallback is kept only for safety.
    const sourceLine =
      (sourceLineId ? lines.find(l => l.id === sourceLineId) : null)
      ?? lines.find(l => l.id === focusLineId)
      ?? lines[lines.length - 1];
    const amount = parseFloat(sourceLine[sideField] || "0") || 0;
    const srcDesc = (sourceLine.description || "").trim();
    const sourceIsVatLine =
      srcDesc.startsWith("ضريبة المدخلات") || srcDesc.startsWith("ضريبة المخرجات");
    // Inclusive mode marks already-net-extracted lines — never re-tax those.
    const sourceIsNetExtracted = srcDesc.includes(NET_MARKER_PREFIX);

    if (!sourceLine.accountId || amount <= 0 || sourceIsVatLine || sourceIsNetExtracted) {
      toast({
        title: direction === "input" ? "السطر الحالي غير صالح لضريبة المدخلات" : "السطر الحالي غير صالح لضريبة المخرجات",
        description: direction === "input"
          ? "قف على سطر فيه حساب ومبلغ مدين (وليس سطر ضريبة) ثم اضغط قيد الضريبة."
          : "قف على سطر فيه حساب ومبلغ دائن (وليس سطر ضريبة) ثم اضغط قيد الضريبة.",
        variant: "destructive",
      });
      return;
    }

    // Route the VAT line to the account configured on the company's
    // default tax FIRST: output VAT → salesTaxAccountId, input VAT →
    // purchaseTaxAccountId, both falling back to the tax's generic
    // accountId. The AI/rules suggestVatAccount endpoint is consulted
    // ONLY when the default tax has no routed account, so companies
    // that configured the tax catalog get deterministic routing while
    // legacy companies keep the prior AI-assisted behaviour.
    let resolvedAccountId: number | null = null;
    let resolvedAccountLabel = "";
    let resolvedSource: "tax" | "ai" | "rules" = "tax";
    if (selectedJeTax) {
      const routed = direction === "output"
        ? (selectedJeTax.salesTaxAccountId ?? selectedJeTax.accountId)
        : (selectedJeTax.purchaseTaxAccountId ?? selectedJeTax.accountId);
      if (routed) {
        resolvedAccountId = routed;
        resolvedAccountLabel = selectedJeTax.nameAr || "ضريبة الشركة الافتراضية";
      }
    }
    if (!resolvedAccountId) {
      let suggestion: VatSuggestion;
      try {
        suggestion = await fetchVatSuggestion(direction);
      } catch (e: any) {
        toast({
          title: "تعذر اقتراح حساب الضريبة",
          description: e?.message ?? "حدث خطأ أثناء الاتصال بخدمة الذكاء الاصطناعي.",
          variant: "destructive",
        });
        return;
      }
      if (!suggestion.accountId) {
        toast({
          title: direction === "input" ? "لم يتم العثور على حساب ضريبة المدخلات" : "لم يتم العثور على حساب ضريبة المخرجات",
          description: suggestion.reasoning || "أنشئ الحساب في دليل الحسابات أو حدّده يدوياً.",
          variant: "destructive",
        });
        return;
      }
      resolvedAccountId = suggestion.accountId;
      resolvedAccountLabel = suggestion.accountLabel;
      resolvedSource = suggestion.source;
    }
    const vatAccountId = String(resolvedAccountId);

    // Defensive: the focused line itself must not be the VAT account.
    if (sourceLine.accountId === vatAccountId) {
      toast({ title: "تعذّر توليد الضريبة", description: "السطر الحالي يستخدم حساب الضريبة نفسه.", variant: "destructive" });
      return;
    }

    // Build ONE VAT line on the same side as the focused line, preserving its
    // costCenter so the tax follows the same dimension. In INCLUSIVE mode we
    // additionally rewrite the focused line's amount down to the net
    // (gross − VAT) so the journal stays balanced — exactly the way invoice
    // "السعر شامل الضريبة" behaves on sales/purchase screens.
    let vatAmount: number;
    let pendingNet: number | null = null;
    if (vatInclusive) {
      // amount is the GROSS, extract VAT from inside it
      vatAmount = Math.round(amount * (VAT_RATE / (1 + VAT_RATE)) * 100) / 100;
      pendingNet = Math.round((amount - vatAmount) * 100) / 100;
    } else {
      // amount is the NET, add VAT on top (existing behaviour)
      vatAmount = Math.round(amount * VAT_RATE * 100) / 100;
    }
    if (vatAmount <= 0) {
      toast({ title: "قيمة الضريبة صفر", description: "تحقّق من قيمة السطر.", variant: "destructive" });
      return;
    }

    const incTag = vatInclusive ? " (شاملة)" : "";
    const vatLine: JournalLine = {
      id: crypto.randomUUID(),
      accountId: vatAccountId,
      // Tax lines never carry a cost centre — the dimension belongs to the
      // expense/revenue source line only (matches auto-JE VAT behaviour).
      costCenter: "",
      taxOfLineId: sourceLine.id,
      debit:  direction === "input"  ? vatAmount.toFixed(2) : "",
      credit: direction === "output" ? vatAmount.toFixed(2) : "",
      description: direction === "input"
        ? `ضريبة المدخلات ${ratePctLabel}${incTag} ${vatInclusive ? "من" : "على"} ${amount.toFixed(2)}`
        : `ضريبة المخرجات ${ratePctLabel}${incTag} ${vatInclusive ? "من" : "على"} ${amount.toFixed(2)}`,
      supplierName:          sourceLine.supplierName ?? "",
      supplierVatNumber:     sourceLine.supplierVatNumber ?? "",
      supplierInvoiceNumber: sourceLine.supplierInvoiceNumber ?? "",
      supplierInvoiceDate:   sourceLine.supplierInvoiceDate ?? "",
    };

    setLines(prev => {
      const updated = (vatInclusive && pendingNet !== null)
        ? prev.map(l => l.id === sourceLine.id
            ? { ...l, [sideField]: pendingNet!.toFixed(2), description: ((l.description || "") + NET_MARKER).trim() }
            : l)
        : prev;
      // ONE tax line per source line: if a tax line linked to this source
      // already exists (VAT or zero-rated, incl. reloaded entries detected
      // positionally), REPLACE it in place instead of inserting a duplicate.
      const existingIdx = findLinkedTaxIdx(updated, sourceLine.id);
      if (existingIdx >= 0) {
        const next = [...updated];
        next[existingIdx] = { ...vatLine, id: next[existingIdx].id };
        return next;
      }
      // Insert the VAT line DIRECTLY BELOW its source row (not appended last).
      const idx = updated.findIndex(l => l.id === sourceLine.id);
      if (idx < 0) return [...updated, vatLine];
      return [...updated.slice(0, idx + 1), vatLine, ...updated.slice(idx + 1)];
    });
    setFocusLineId(vatLine.id);

    toast({
      title: direction === "input" ? "تمت إضافة سطر ضريبة المدخلات" : "تمت إضافة سطر ضريبة المخرجات",
      description: `إجمالي الضريبة ${vatAmount.toFixed(2)} ${currency} • ${resolvedAccountLabel} • ${resolvedSource === "tax" ? "حساب الضريبة المعرّف" : resolvedSource === "ai" ? "اقتراح ذكاء اصطناعي" : "قواعد محلية"}`,
    });
  }

  // ── ضريبة صفرية (Zero-rated Tax Entry) ──────────────────────────
  // Exposed from the per-line tax popover. Inserts ONE VAT line with a 0.00
  // amount (zero-rated treatment) to the company tax account on the chosen
  // side, DIRECTLY BELOW the clicked source line, referencing that line's base
  // amount in its description so it surfaces in the VAT declaration as a
  // zero-rated sale/purchase. Unlike applyTaxEntry it never rewrites the
  // source line (nothing to extract) and ignores the inclusive toggle.
  async function applyZeroTaxEntry(direction: "input" | "output", sourceLineId?: string) {
    if (isLockedSourceEntry) return;
    if (lines.length === 0) {
      toast({ title: "لا توجد سطور", description: "أضف سطراً أولاً قبل إضافة سطر ضريبة صفرية.", variant: "destructive" });
      return;
    }
    const sideField: "debit" | "credit" = direction === "input" ? "debit" : "credit";
    const sourceLine =
      (sourceLineId ? lines.find(l => l.id === sourceLineId) : null)
      ?? lines.find(l => l.id === focusLineId)
      ?? lines[lines.length - 1];
    const amount = parseFloat(sourceLine[sideField] || "0") || 0;
    const srcDesc = (sourceLine.description || "").trim();
    const sourceIsVatLine =
      srcDesc.startsWith("ضريبة المدخلات") || srcDesc.startsWith("ضريبة المخرجات") || srcDesc.startsWith("ضريبة صفرية");
    // A source already split into its net component (inclusive-mode VAT was
    // extracted) must NOT be switched to zero-rated — the source amount is no
    // longer the gross and replacing its VAT line with 0.00 would silently
    // lose the extracted VAT and unbalance the entry.
    const sourceIsNetExtracted = srcDesc.includes(NET_MARKER_PREFIX);
    if (sourceIsNetExtracted) {
      toast({
        title: "لا يمكن تحويل السطر إلى ضريبة صفرية",
        description: "تم استخراج الضريبة من مبلغ هذا السطر (شامل الضريبة). احذف سطر الضريبة وأعد المبلغ الأصلي أولاً.",
        variant: "destructive",
      });
      return;
    }

    if (!sourceLine.accountId || amount <= 0 || sourceIsVatLine) {
      toast({
        title: direction === "input" ? "السطر الحالي غير صالح لضريبة صفرية مدين" : "السطر الحالي غير صالح لضريبة صفرية دائن",
        description: direction === "input"
          ? "قف على سطر فيه حساب ومبلغ مدين (وليس سطر ضريبة) ثم اختر ضريبة صفرية."
          : "قف على سطر فيه حساب ومبلغ دائن (وليس سطر ضريبة) ثم اختر ضريبة صفرية.",
        variant: "destructive",
      });
      return;
    }

    // Route the zero-rated VAT line to the same account "قيد الضريبة" would
    // use (default-tax routing first, AI/rules fallback second) so it lands
    // in the correct box of the VAT return.
    let resolvedAccountId: number | null = null;
    let resolvedAccountLabel = "";
    if (selectedJeTax) {
      const routed = direction === "output"
        ? (selectedJeTax.salesTaxAccountId ?? selectedJeTax.accountId)
        : (selectedJeTax.purchaseTaxAccountId ?? selectedJeTax.accountId);
      if (routed) {
        resolvedAccountId = routed;
        resolvedAccountLabel = selectedJeTax.nameAr || "ضريبة الشركة الافتراضية";
      }
    }
    if (!resolvedAccountId) {
      let suggestion: VatSuggestion;
      try {
        suggestion = await fetchVatSuggestion(direction);
      } catch (e: any) {
        toast({ title: "تعذر اقتراح حساب الضريبة", description: e?.message ?? "حدث خطأ أثناء الاتصال بالخدمة.", variant: "destructive" });
        return;
      }
      if (!suggestion.accountId) {
        toast({
          title: direction === "input" ? "لم يتم العثور على حساب ضريبة المدخلات" : "لم يتم العثور على حساب ضريبة المخرجات",
          description: suggestion.reasoning || "أنشئ الحساب في دليل الحسابات أو حدّده يدوياً.",
          variant: "destructive",
        });
        return;
      }
      resolvedAccountId = suggestion.accountId;
      resolvedAccountLabel = suggestion.accountLabel;
    }
    const vatAccountId = String(resolvedAccountId);

    if (sourceLine.accountId === vatAccountId) {
      toast({ title: "تعذّر إضافة الضريبة الصفرية", description: "السطر الحالي يستخدم حساب الضريبة نفسه.", variant: "destructive" });
      return;
    }

    const zeroLine: JournalLine = {
      id: crypto.randomUUID(),
      accountId: vatAccountId,
      // Tax lines never carry a cost centre (see applyTaxEntry).
      costCenter: "",
      taxOfLineId: sourceLine.id,
      debit:  direction === "input"  ? "0.00" : "",
      credit: direction === "output" ? "0.00" : "",
      description: direction === "input"
        ? `ضريبة صفرية — مدخلات (0%) على ${amount.toFixed(2)}`
        : `ضريبة صفرية — مخرجات (0%) على ${amount.toFixed(2)}`,
      supplierName:          sourceLine.supplierName ?? "",
      supplierVatNumber:     sourceLine.supplierVatNumber ?? "",
      supplierInvoiceNumber: sourceLine.supplierInvoiceNumber ?? "",
      supplierInvoiceDate:   sourceLine.supplierInvoiceDate ?? "",
    };

    setLines(prev => {
      // ONE tax line per source line — replace any existing linked tax line
      // (incl. reloaded entries detected positionally).
      const existingIdx = findLinkedTaxIdx(prev, sourceLine.id);
      if (existingIdx >= 0) {
        const next = [...prev];
        next[existingIdx] = { ...zeroLine, id: next[existingIdx].id };
        return next;
      }
      // Insert the zero-rated line DIRECTLY BELOW its source row.
      const idx = prev.findIndex(l => l.id === sourceLine.id);
      if (idx < 0) return [...prev, zeroLine];
      return [...prev.slice(0, idx + 1), zeroLine, ...prev.slice(idx + 1)];
    });
    setFocusLineId(zeroLine.id);

    toast({
      title: direction === "input" ? "تمت إضافة سطر ضريبة صفرية (مدين)" : "تمت إضافة سطر ضريبة صفرية (دائن)",
      description: `ضريبة صفرية 0.00 ${currency} • ${resolvedAccountLabel}`,
    });
  }

  // ── Form-wide Enter-key navigation ──────────────────────────────
  // Enter advances focus through every editable field on the form
  // (text inputs, date inputs, dropdowns, comboboxes, textarea) in
  // visual DOM order until reaching the end → then triggers Save.
  //   • Shift+Enter on the description textarea inserts a newline.
  //   • Enter on a Radix Select trigger advances (does NOT open). Use
  //     Space / ArrowDown / click to open a Select.
  //   • SearchCombobox handles Enter itself only when the user has typed
  //     or arrowed; otherwise Enter falls through to advance focus.
  const formRef = useRef<HTMLDivElement>(null);

  function getNavList(): HTMLElement[] {
    const root = formRef.current;
    if (!root) return [];
    const SEL = [
      'input:not([type="hidden"]):not([disabled])',
      'textarea:not([disabled])',
      'button[role="combobox"]:not([disabled])',
    ].join(", ");
    return Array.from(root.querySelectorAll<HTMLElement>(SEL))
      .filter(el => el.offsetParent !== null && el.tabIndex !== -1);
  }

  function advanceFromTarget(target: HTMLElement) {
    const all = getNavList();
    const i = all.indexOf(target);
    if (i === -1) return false;
    if (i + 1 < all.length) {
      const next = all[i + 1];
      next.focus();
      if (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) {
        try { next.select(); } catch { /* date inputs don't support select */ }
      }
    } else {
      // Last navigable field → save the entry (guard against double-fire,
      // and never auto-submit a locked source-document entry).
      if (!saveMutation.isPending && !isLockedSourceEntry) handleSave();
    }
    return true;
  }

  // Capture-phase handler: ONLY hijacks Enter on Radix Select triggers
  // (button[role="combobox"]) so the dropdown does not open. Everything
  // else is left to bubble up so descendant components (SearchCombobox,
  // etc.) get a chance to handle Enter first.
  function handleFormKeyDownCapture(e: React.KeyboardEvent) {
    if (e.key !== "Enter") return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if ((e.nativeEvent as any).isComposing) return;
    const target = e.target as HTMLElement;
    if (!target || target.tagName !== "BUTTON") return;
    if (target.getAttribute("role") !== "combobox") return;
    e.preventDefault();
    e.stopPropagation();
    advanceFromTarget(target);
  }

  // Bubble-phase handler: advances focus on Enter for inputs, textareas
  // and combobox-inputs. We deliberately do NOT bail on
  // `e.defaultPrevented` — when a SearchCombobox descendant just
  // selected an item with Enter, the user still expects focus to move
  // to the next field. So selection + advance happen together.
  function handleFormKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Enter") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.nativeEvent as any).isComposing) return;

    const target = e.target as HTMLElement;
    if (!target) return;

    // Shift+Enter inside a textarea → allow newline as usual
    if (target.tagName === "TEXTAREA" && e.shiftKey) return;

    e.preventDefault();
    advanceFromTarget(target);
  }
  function removeLine(id: string) {
    if (lines.length <= 2) return;
    setLines(prev => prev.filter(l => l.id !== id));
  }

  // ── AI validation ───────────────────────────────────────────────
  const [aiValidationOpen, setAiValidationOpen] = useState(false);
  const validateMutation = useMutation({
    mutationFn: () => journalEntriesApi.aiValidate({
      entry: { entryDate, description, entryType, currency },
      lines: lines.map(l => {
        const a = acctMap.get(Number(l.accountId));
        return {
          accountCode: a?.code ?? "",
          accountName: a?.nameAr || a?.nameEn || "",
          accountType: a?.accountType ?? a?.type ?? "",
          debit:  Number(l.debit  || 0),
          credit: Number(l.credit || 0),
          description: l.description || "",
        };
      }),
    }),
    onError: (e: any) => toast({ title: "تعذّر تشغيل الفحص", description: e?.message ?? "خطأ غير معروف", variant: "destructive" }),
  });
  function runAiValidation() {
    setAiValidationOpen(true);
    validateMutation.mutate();
  }

  // Pull the company-wide auto-print preferences for journal entries.
  // When `printAutoAfterSaveJournal` is on, the save flow opens the
  // print popup before navigating back to the list — using the chosen
  // template (a4 vs thermal). The button below the form is unchanged
  // and always available regardless of these settings.
  const autoPrintJournal = !!(user as any)?.company?.printAutoAfterSaveJournal;
  const journalTemplate: "a4" | "thermal" =
    ((user as any)?.company?.printTemplateJournal === "thermal") ? "thermal" : "a4";

  // Same-tick double-submit guard (Enter + click can both fire before the
  // isPending re-render lands). Reset in onSettled.
  const savingRef = useRef(false);
  // Transient per-line account-info flash (replaces the old blocking hover
  // tooltip on the account picker) — cleared automatically after ~2.6s.
  const [accountFlash, setAccountFlash] = useState<{ lineId: string; field: "account" | "cc" } | null>(null);
  const accountFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ── فك الترحيل والتحويل إلى مسودة — flips the posted JE back to draft
  //    KEEPING the same document number (unpost→edit→re-post cycle). The
  //    server cascades adjustment-run bookkeeping etc.; source-document JEs
  //    are rejected there with a clear Arabic message.
  const unpostMutation = useMutation({
    mutationFn: () => journalEntriesApi.unpost(editId!),
    onSuccess: () => {
      toast({
        title: "تم فك الترحيل",
        description: "تحوّل القيد إلى مسودة بنفس الرقم — عدّله ثم أعد ترحيله وسيحتفظ بنفس رقم التسلسل.",
      });
      qc.invalidateQueries({ queryKey: ["journal-entry", sourceId] });
      qc.invalidateQueries({ queryKey: ["journal-entries", cid] });
    },
    onError: (e: any) => toast({
      title: "فشل فك الترحيل",
      description: e?.message ?? "قد يكون القيد مصدره مستند أو داخل فترة مقفلة",
      variant: "destructive",
    }),
  });

  // ── تنفيذ خطوة القيد الخاص بعد الحفظ ────────────────────────────────
  // يعيد استخدام نقاط النهاية الحالية كما هي:
  //   fixed_asset → POST /api/fixed-assets/assets (sourceType=journal_entry،
  //                 الخادم يفرض skipAcquisitionJe فلا يتكرر قيد الاقتناء)
  //   prepaid/deferred/accrued → POST /api/adjustments (محرك التسويات)
  async function runSpecialAfterSave(jeId: number, jeDoc: string, kind: string, s: Record<string, string>) {
    const post = async (path: string, body: any) => {
      const r = await fetch(`${API}${path}${cid ? `?companyId=${cid}` : ""}`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `فشل الطلب (${r.status})`);
      return j;
    };
    try {
      if (kind === "fixed_asset") {
        const asset = await post("/api/fixed-assets/assets", {
          companyId: cid,
          nameAr: s.faName.trim(),
          code: (s.faCode ?? "").trim() || undefined,
          groupId: s.faGroupId ? Number(s.faGroupId) : null,
          purchaseDate: s.faPurchaseDate || entryDate,
          depreciationStart: s.faDepStart || entryDate,
          lifeYears: s.faLifeYears || "5",
          depreciationMethod: s.faMethod || "straight_line",
          scrapValue: s.faScrap || "0",
          purchaseValue: String(totalDebit || 0),
          branchId: branchId ? Number(branchId) : null,
          costCenterId: s.faCostCenterId ? Number(s.faCostCenterId) : null,
          sourceType: "journal_entry",
          sourceDocumentId: jeId,
          acquisitionJeNo: jeDoc || null,
        });
        toast({ title: "تم إنشاء الأصل الثابت", description: `الأصل ${asset?.code ?? ""} مرتبط بالقيد ${jeDoc || `#${jeId}`}` });
      } else if (ADJ_KINDS.includes(kind)) {
        const isPrepaid = kind === "prepaid_expense" || kind === "deferred_revenue";
        const start = (isPrepaid ? s.adjStart : s.adjDue) || entryDate;
        let end = start;
        if (isPrepaid) {
          // حساب تاريخ النهاية بإضافة (الأشهر−1) مع تثبيت اليوم داخل الشهر
          // الناتج — تفادياً لقفزة نهاية الشهر (31 → الشهر التالي).
          const months = Number(s.adjMonths ?? "12");
          const [y, m, dd] = start.split("-").map(Number);
          const total = (m - 1) + (months - 1);
          const ny = y + Math.floor(total / 12);
          const nm = total % 12;                      // 0-based
          const lastDay = new Date(ny, nm + 1, 0).getDate();
          const day = Math.min(dd, lastDay);
          end = `${ny}-${String(nm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        }
        const label = SPECIAL_KINDS.find(k => k.value === kind)?.label ?? kind;
        await post("/api/adjustments", {
          type: isPrepaid ? "prepaid" : "accrued",
          name: `${label} — قيد ${jeDoc || `#${jeId}`}`,
          expenseAccountId: Number(s.adjDebitAccountId),
          contraAccountId: Number(s.adjCreditAccountId),
          totalAmount: s.adjAmount ? Number(s.adjAmount) : totalDebit,
          startDate: start,
          endDate: end,
          costCenterId: s.adjCostCenterId ? Number(s.adjCostCenterId) : null,
          notes: `مرتبط بالقيد المحاسبي رقم ${jeDoc || jeId} (#${jeId})`,
        });
        toast({ title: "تم إنشاء جدول التسويات", description: `مرتبط بالقيد ${jeDoc || `#${jeId}`} — الترحيل الشهري تلقائي.` });
      }
    } catch (e: any) {
      toast({
        title: "حُفظ القيد لكن خطوة الربط فشلت",
        description: `${e?.message ?? "خطأ غير متوقع"} — يمكنك إنشاءها يدوياً من الموديول المعني.`,
        variant: "destructive",
      });
    }
  }

  const saveMutation = useMutation({
    mutationFn: async (data: any) => {
      // Single-shot create on Save for new entries. The server consumes the
      // sequence number atomically here — no number is reserved beforehand —
      // and decides status='posted' vs 'draft' based on balance + line count.
      // Closing the form without saving leaves no row and no number gap.
      return isNew ? journalEntriesApi.create(data) : journalEntriesApi.update(editId!, data);
    },
    onSuccess: (saved: any) => {
      qc.invalidateQueries({ queryKey: ["journal-entries", cid] });
      // ── القيود الخاصة: تنفيذ خطوة الربط بعد حفظ القيد ──────────────
      // نلتقط القيم الآن (قبل إعادة تهيئة النموذج أدناه) ثم ننادي نقطة
      // النهاية الحالية للموديول المعني — لا تكرار لأي منطق عمل.
      if (isNew && saved?.id && specialKind !== "normal" && specialKind !== "opening") {
        void runSpecialAfterSave(Number(saved.id), saved?.docNumber ?? docNumber, specialKind, { ...spec });
      }
      // Show the JUST-saved doc number prominently in the toast so the user
      // sees confirmation of what was just created/updated.
      const savedDoc = saved?.docNumber ?? docNumber;
      if (isNew && savedDoc) {
        renameArchivedKey(newArchiveKey, savedDoc);
        fetch(`${import.meta.env.VITE_API_URL ?? ""}/api/document-archives/rekey`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            screenKey: "journal_entries",
            oldDocKey: newArchiveKey,
            newDocKey: savedDoc,
          }),
        }).catch(() => {});
        setNewArchiveKey(`JE-new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      }
      const wasPosted = saved?.status
        ? saved.status === "posted"
        : true; // legacy update paths return no status — assume posted
      const baseTitle = wasPosted
        ? getSaveToastTitle(t, { posted: false, printed: autoPrintJournal })
        : "تم الحفظ كمسودة";
      toast({
        title: baseTitle,
        description: savedDoc
          ? (wasPosted
              ? `رقم القيد: ${savedDoc}`
              : `رقم القيد ${savedDoc} محفوظ كمسودة — أكمل البيانات لاحقاً وقم بترحيله`)
          : undefined,
      });
      if (wasPosted && autoPrintJournal) {
        // Fire the print popup synchronously off the user-initiated save
        // click so the browser's pop-up blocker still treats it as
        // user-allowed.
        try { openEntryPrintWindow(journalTemplate); } catch { /* swallow popup-blocker noise */ }
      }
      // Per-company form-mode preference (set in General Settings → "نظام
      // إدخال القيود"):
      //   "manual" → close the form and go back to the journal-entries list
      //              (legacy behavior some accountants prefer).
      //   "auto"   → stay on the form and reset to a fresh draft so the user
      //              can immediately start the next entry (default).
      const formMode = (user as any)?.company?.journalEntryFormMode === "manual"
        ? "manual" : "auto";
      if (isNew && formMode === "manual") {
        navigate("/accounting/journals");
        return;
      }
      // AUTO mode: stay on the form and reset to a brand-new draft. The next
      // sequence number is re-peeked from the server and shown in رقم المستند.
      if (isNew) {
        setDescription("");
        setEntryDate(today());
        setExchangeRate("1");
        setEntryType("general");
        // Clear the invoice-settlement link — the NEXT entry must never
        // silently settle the same invoice again.
        setSettleSalesInvoiceId(null);
        setSettlePurchaseInvoiceId(null);
        setSettlementAmount("");
        setSettleMeta(null);
        setSettleAmountAuto(false);
        if (defaultCurrency?.code) setCurrency(defaultCurrency.code);
        setLines([newLine(), newLine()]);
        setSpecialKind("normal");
        setSpec({});
        setActiveTab("header");
        setDocNumber("");
        // Re-peek the next sequence number so the badge instantly shows
        // the NEXT number the user's next save will consume.
        seqPeek.refetch();
      }
    },
    onError: (e: any) => {
      // 423 → period is locked. Show a dedicated, action-oriented title so
      // the user immediately knows the date falls inside a closed fiscal
      // period and what to do (re-open the period first).
      if (e?.status === 423) {
        toast({
          title: "لا يمكن الترحيل في فترة مقفلة",
          description: e.message ?? "هذا التاريخ يقع داخل فترة مالية مقفلة. أعد فتح الفترة من شاشة \"الفترات المالية\" ثم حاول مجدداً.",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "خطأ", description: e.message, variant: "destructive" });
    },
    onSettled: () => {
      savingRef.current = false;
    },
  });

  function handleSave() {
    if (isLockedSourceEntry) {
      toast({
        title: "لا يمكن تعديل هذا القيد",
        description: `هذا القيد مُولَّد تلقائياً من ${lockInfo!.source}. ${lockInfo!.hint}`,
        variant: "destructive",
      });
      return;
    }
    if (!entryDate) {
      toast({ title: "التاريخ مطلوب", variant: "destructive" }); return;
    }
    // Explicit-save model: for NEW entries we always allow Save — even an
    // unbalanced or partially-filled entry — and the server decides on the
    // status (balanced + ≥2 valid lines → "posted", anything else → "draft").
    // The sequence number is consumed exactly once, on this Save click; if
    // the user closes the form without clicking Save, NO row is inserted
    // and NO gap is left in the JE numbering. For EDITS we keep the
    // pre-existing safety rails (must be balanced, ≥2 lines) because an
    // edit that breaks an already-posted entry would corrupt the books.
    if (!isNew && !isBalanced) {
      toast({ title: "القيد غير متوازن", description: `الفرق: ${fmt2(diff)}`, variant: "destructive" }); return;
    }
    const validLines = lines.filter(l => l.accountId);
    if (!isNew && validLines.length < 2) {
      toast({ title: "يجب أن يحتوي القيد على سطرين على الأقل", variant: "destructive" }); return;
    }
    if (settleLinked && !(parseFloat(settlementAmount) > 0)) {
      toast({ title: "مبلغ السداد مطلوب", description: "القيد مرتبط بسداد فاتورة — أدخل مبلغ السداد أو أزل الربط.", variant: "destructive" });
      return;
    }
    if (settleLinked) {
      const amt = parseFloat(settlementAmount) || 0;
      // مبلغ السداد never exceeds the JE's own debit total — the invoice
      // can't be "paid" more than the entry actually posts. Unconditional:
      // a zero-line linked entry can't carry a positive settlement either.
      if (amt > totalDebit + 0.01) {
        toast({
          title: "مبلغ السداد أكبر من إجمالي القيد",
          description: `مبلغ السداد ${fmt2(amt)} يتجاوز إجمالي مدين القيد ${fmt2(totalDebit)}. عدِّل المبلغ أو سطور القيد.`,
          variant: "destructive",
        });
        return;
      }
      // …and never exceeds the invoice remaining (base currency). The
      // server enforces this too (409), this is the friendly early stop.
      if (settleMeta?.remaining != null) {
        const rate = parseFloat(exchangeRate) || 1;
        if (amt * rate > settleMeta.remaining + 0.01) {
          toast({
            title: "مبلغ السداد أكبر من المتبقي من الفاتورة",
            description: `المتبقي من الفاتورة ${fmt2(settleMeta.remaining)} فقط. لا يمكن حفظ قيد سداد أكبر من المتبقي.`,
            variant: "destructive",
          });
          return;
        }
      }
    }
    // Double-submit guard: Enter key + the save button can both fire before
    // React re-renders with isPending=true → the entry saves TWICE. The
    // mutation's own isPending is the render-time guard; this is the
    // same-tick guard.
    if (saveMutation.isPending || savingRef.current) return;
    // ── التحقق من بيانات القيد الخاص قبل الحفظ (حتى لا يُحفظ القيد
    //    بينما تفشل خطوة الربط بعده) ─────────────────────────────────
    if (isNew && specialKind === "fixed_asset") {
      if (!(spec.faName ?? "").trim()) {
        toast({ title: "اسم الأصل مطلوب", description: "أدخل اسم الأصل الثابت في لوحة «قيد أصل ثابت» أو غيّر نوع القيد إلى عادي.", variant: "destructive" });
        return;
      }
      if (!(totalDebit > 0)) {
        toast({ title: "قيمة الشراء غير صالحة", description: "قيمة الأصل تُؤخذ من إجمالي مدين القيد — أدخل سطور القيد أولاً.", variant: "destructive" });
        return;
      }
      const life = Number(spec.faLifeYears ?? "5");
      if (!(life > 0)) {
        toast({ title: "العمر الإنتاجي غير صالح", variant: "destructive" });
        return;
      }
      const scrap = Number(spec.faScrap ?? "0");
      if (!(scrap >= 0) || scrap >= totalDebit) {
        toast({ title: "القيمة التخريدية غير صالحة", description: "يجب أن تكون صفراً أو أكبر وأقل من قيمة الأصل.", variant: "destructive" });
        return;
      }
    }
    if (isNew && ADJ_KINDS.includes(specialKind)) {
      if (!spec.adjDebitAccountId || !spec.adjCreditAccountId) {
        toast({ title: "حسابا التسوية مطلوبان", description: "اختر الحسابين في لوحة القيد الخاص أو غيّر نوع القيد إلى عادي.", variant: "destructive" });
        return;
      }
      if (spec.adjDebitAccountId === spec.adjCreditAccountId) {
        toast({ title: "الحسابان متطابقان", description: "يجب أن يختلف الحساب المدين عن الدائن.", variant: "destructive" });
        return;
      }
      const months = Number(spec.adjMonths ?? "12");
      if ((specialKind === "prepaid_expense" || specialKind === "deferred_revenue") &&
          (!Number.isInteger(months) || months < 1 || months > 120)) {
        toast({ title: "عدد الأشهر غير صالح", description: "أدخل عدداً صحيحاً من 1 إلى 120.", variant: "destructive" });
        return;
      }
      const amt = spec.adjAmount ? Number(spec.adjAmount) : totalDebit;
      if (!(amt > 0)) {
        toast({ title: "مبلغ التسوية غير صالح", variant: "destructive" });
        return;
      }
    }
    savingRef.current = true;
    saveMutation.mutate({
      companyId:    cid,
      docNumber:    docNumber || null,
      salesInvoiceId:    settleSalesInvoiceId,
      purchaseInvoiceId: settlePurchaseInvoiceId,
      settlementAmount:  settleLinked ? settlementAmount : null,
      entryDate,
      currency,
      exchangeRate,
      description:  description || null,
      entryType,
      branchId:     branchId ? Number(branchId) : null,
      lines:        validLines.map(l => ({
        accountId:   l.accountId ? Number(l.accountId) : null,
        costCenter:  l.costCenter || null,
        debit:       l.debit  || "0",
        credit:      l.credit || "0",
        description: l.description || null,
        supplierName:          l.supplierName?.trim() || null,
        supplierVatNumber:     l.supplierVatNumber?.trim() || null,
        supplierInvoiceNumber: l.supplierInvoiceNumber?.trim() || null,
        supplierInvoiceDate:   l.supplierInvoiceDate?.trim() || null,
      })),
    });
  }

  const escapeHtml = (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

  const printableLines = lines.filter(l => l.accountId);
  // For new (unsaved) entries we still want a meaningful label on the
  // printout — fall back to the manually-typed docNumber, the central
  // sequence peek, or the predicted QYD-XXXX from the loaded list, in
  // that order. Only when none of these exist do we show "(غير محفوظ)".
  // Predict from MAX(numeric part of docNumber) — NOT from MAX(id) — so
  // backfilled placeholder rows (with low QYD numbers but freshly-allocated
  // global ids) don't push the prediction into a wrong high range.
  const _maxQydNum = navList.reduce((m: number, e: any) => {
    const dn = String(e?.docNumber ?? "");
    const match = dn.match(/^QYD-(\d+)$/);
    const n = match ? Number(match[1]) : 0;
    return n > m ? n : m;
  }, 0);
  const _predictedQyd = _maxQydNum > 0 ? `QYD-${String(_maxQydNum + 1).padStart(4, "0")}` : null;
  const docLabel =
    existing?.docNumber
    ?? (editId ? `QYD-${String(editId).padStart(4, "0")}` : null)
    ?? (docNumber || null)
    ?? _predictedQyd
    ?? "(غير محفوظ)";
  // Visual marker so the printed copy clearly says it's a draft when
  // the JE hasn't been saved yet — protects against using it as a
  // formal accounting record before it's persisted.
  const isDraftPrint = isNew;
  const typeLabel = ENTRY_TYPES.find(t => t.value === entryType)?.label ?? entryType;
  const branchLabel = branches.find((b: any) => String(b.id) === String(branchId))?.nameAr ?? "—";

  const handleExportEntryExcel = async () => {
      if (!(await gate('export'))) return;
    const headerRows = [
      ["رقم القيد", docLabel],
      ["التاريخ",   entryDate],
      ["النوع",     typeLabel],
      ["العملة",    `${currency} (سعر الصرف ${exchangeRate})`],
      ["الفرع",     branchLabel],
      ["البيان",    description || "—"],
      [],
    ];
    const lineHeader = ["#", "كود الحساب", "اسم الحساب", "مركز التكلفة", "مدين", "دائن", "البيان"];
    const lineRows = printableLines.map((l, i) => {
      const a = acctMap.get(Number(l.accountId));
      return [
        i + 1,
        a?.code ?? "",
        a?.nameAr || a?.nameEn || "",
        ccLabel(l.costCenter),
        Number(l.debit  || 0).toFixed(2),
        Number(l.credit || 0).toFixed(2),
        l.description || "",
      ];
    });
    const totalsRow = ["", "", "", "الإجمالي", totalDebit.toFixed(2), totalCredit.toFixed(2), isBalanced ? "متوازن ✓" : `فرق: ${diff.toFixed(2)}`];
    const aoa = [...headerRows, lineHeader, ...lineRows, totalsRow];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 6 }, { wch: 12 }, { wch: 28 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 28 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `قيد ${docLabel}`);
    void saveWorkbook(wb, `journal-entry-${docLabel}.xlsx`);
  };

  // Build a compact 80 mm thermal-receipt HTML for the current entry.
  // Mirrors the A4 builder's data model but drops the wide table in
  // favour of a stacked per-line list so totals stay legible on the
  // narrower paper. Same `safeLogoSrc` defang for the company logo.
  const buildEntryThermalHtml = () => {
    const today = new Date().toLocaleDateString("ar-SA-u-ca-gregory-nu-latn");
    const safeLogo = safeLogoSrc((user?.company as any)?.logo);
    const logoHtml = safeLogo
      ? `<div style="text-align:center;margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:48px;max-width:160px;object-fit:contain;display:inline-block;" /></div>`
      : "";
    const linesHtml = printableLines.map((l, i) => {
      const a = acctMap.get(Number(l.accountId));
      const debit  = Number(l.debit  || 0);
      const credit = Number(l.credit || 0);
      const side = debit > 0 ? `مدين ${fmt2(debit)}` : `دائن ${fmt2(credit)}`;
      const ccInline = l.costCenter
        ? `<div class="desc">مركز التكلفة: ${escapeHtml(ccLabel(l.costCenter))}</div>`
        : "";
      return `<div class="line">
        <div class="acc">${i + 1}. ${escapeHtml(a?.code ?? "")} — ${escapeHtml(a?.nameAr || a?.nameEn || "—")}</div>
        <div class="amt">${side}</div>
        ${ccInline}
        ${l.description ? `<div class="desc">${escapeHtml(l.description)}</div>` : ""}
      </div>`;
    }).join("");
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>قيد ${escapeHtml(docLabel)}</title>
<style>
@page { size: 80mm auto; margin: 3mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#000; margin:0; padding:0; width:74mm; font-size:11px; line-height:1.4; }
.center { text-align:center; }
.bold { font-weight:700; }
.h1 { font-size:13px; font-weight:700; margin:6px 0 2px; }
.h2 { font-size:13px; font-weight:700; margin:6px 0; padding:4px 0; border-top:1px dashed #000; border-bottom:1px dashed #000; text-align:center; }
.row { display:flex; justify-content:space-between; padding:1px 0; }
.line { padding:4px 0; border-bottom:1px dashed #999; }
.line .acc { font-size:11px; }
.line .amt { font-family:"Consolas",monospace; font-size:11px; font-weight:700; }
.line .desc { font-size:10px; color:#333; margin-top:2px; }
.totals { margin-top:6px; padding:4px 0; border-top:2px solid #000; border-bottom:2px solid #000; font-weight:700; }
.balance { text-align:center; padding:4px 0; font-size:12px; font-weight:700; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } body { width:auto; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة / حفظ PDF</button>
${logoHtml}
${user?.company?.nameAr ? `<div class="center bold" style="font-size:13px;">${escapeHtml(user.company.nameAr)}</div>` : ""}
<div class="h2">قيد محاسبي${isDraftPrint ? " — مسودة" : ""}</div>
<div class="row"><span>رقم القيد</span><span class="bold">${escapeHtml(docLabel)}</span></div>
<div class="row"><span>التاريخ</span><span class="bold">${escapeHtml(entryDate)}</span></div>
<div class="row"><span>النوع</span><span class="bold">${escapeHtml(typeLabel)}</span></div>
<div class="row"><span>العملة</span><span class="bold">${escapeHtml(currency)}</span></div>
${description ? `<div style="font-size:10px;padding:4px 0;color:#333;border-top:1px dashed #000;margin-top:4px;"><span class="bold">البيان: </span>${escapeHtml(description)}</div>` : ""}
<div style="margin-top:6px;">${linesHtml}</div>
<div class="totals">
  <div class="row"><span>إجمالي المدين</span><span>${fmt2(totalDebit)}</span></div>
  <div class="row"><span>إجمالي الدائن</span><span>${fmt2(totalCredit)}</span></div>
</div>
<div class="balance" style="color:${isBalanced ? "#15803d" : "#b91c1c"};">${isBalanced ? "متوازن ✓" : `فرق: ${fmt2(diff)}`}</div>
<div style="margin-top:10px;border-top:1px dashed #000;padding-top:8px;">
  <div class="row" style="margin-bottom:14px;"><span class="bold">إعداد</span><span>....................</span></div>
  <div class="row" style="margin-bottom:14px;"><span class="bold">مراجعة</span><span>....................</span></div>
  <div class="row" style="margin-bottom:6px;"><span class="bold">اعتماد</span><span>....................</span></div>
</div>
<div class="center" style="font-size:9px;color:#555;margin-top:8px;">طُبع في ${today}</div>
<script>setTimeout(()=>window.print(),300);</script>
</body></html>`;
  };

  // A4 print — delegates to the SHARED detailed template (lib/journalPrint.ts),
  // the exact same builder the journal-entries LIST screen's blue print button
  // uses, so printing from inside the entry and from the list always produces
  // identical sheets. Unsaved entries additionally get a DRAFT watermark.
  const buildEntryPrintHtml = () => {
    const statusLabel = isDraftPrint
      ? t("journalEntries.statusDraft")
      : (existing?.status === "posted"
          ? t("journalEntries.statusPosted")
          : existing?.status === "voided"
            ? t("journalEntries.statusVoided")
            : t("journalEntries.statusDraft"));
    const entry: JournalPrintEntry = {
      docNo:       docLabel,
      entryDate:   entryDate,
      typeLabel:   typeLabel,
      statusLabel,
      description: description || null,
      lines: printableLines.map((l) => {
        const a = acctMap.get(Number(l.accountId));
        return {
          accountLabel: a ? `${a.code ?? ""} — ${a.nameAr || a.nameEn || ""}` : `#${l.accountId}`,
          description: l.description || null,
          debit:  Number(l.debit  || 0),
          credit: Number(l.credit || 0),
          costCenterLabel: ccLabel(l.costCenter) || null,
        };
      }),
    };
    let oneEntryPerPage = false;
    try { oneEntryPerPage = localStorage.getItem(JE_ONE_PER_PAGE_LS_KEY) === "1"; } catch { /* SSR/no-LS */ }
    // Labels mirror the LIST screen's journalPrintLabels() 1:1 (same t()
    // keys, same isRtl-conditional literals) so both entry points always
    // print byte-identical sheets in either language.
    return buildDetailedJournalPrintHtml([entry], {
      company: user?.company as any,
      isRtl,
      oneEntryPerPage,
      draftWatermark: isDraftPrint,
      labels: {
        sheetTitle: t("journalEntries.printSheetTitle"),
        doc:        t("journalEntries.docNumber"),
        date:       t("journalEntries.date"),
        type:       t("journalEntries.type"),
        desc:       t("journalEntries.description"),
        debit:      t("journalEntries.debit"),
        credit:     t("journalEntries.credit"),
        status:     t("journalEntries.status"),
        account:    isRtl ? "الحساب" : "Account",
        lineDesc:   isRtl ? "البيان"  : "Description",
        costCenter: isRtl ? "مركز التكلفة" : "Cost Center",
        lineNo:     isRtl ? "م" : "#",
        subtotal:   isRtl ? "الإجمالي" : "Subtotal",
        noLines:    isRtl ? "لا توجد أطراف لهذا القيد." : "No lines for this entry.",
        grandTotal: isRtl ? "الإجمالي العام" : "Grand Total",
        totalDebit:  t("journalEntries.totalDebit"),
        totalCredit: t("journalEntries.totalCredit"),
        printBtn:    t("journalEntries.printPdf"),
      },
    });
  };

  // Open the print popup using either the A4 layout (default) or the
  // 80 mm thermal layout. Called by the "Print" button (A4) and by the
  // post-save auto-print hook (whichever template the user picked).
  const openEntryPrintWindow = (template: "a4" | "thermal" = journalTemplate) => {
    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) {
      // Browser blocked the popup. Surface a clear message so the user
      // knows to allow popups for this site instead of seeing nothing.
      toast({
        title: "تم منع النوافذ المنبثقة",
        description: "اسمح بفتح النوافذ المنبثقة من هذا الموقع لإجراء الطباعة.",
        variant: "destructive",
      });
      return;
    }
    const html = template === "thermal" ? buildEntryThermalHtml() : buildEntryPrintHtml();
    w.document.open(); w.document.write(html); w.document.close();
  };

  if (!isNew && loadingEdit) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">جارٍ التحميل...</div>;
  }

  return (
    <div
      ref={formRef}
      onKeyDownCapture={handleFormKeyDownCapture}
      onKeyDown={handleFormKeyDown}
      className="p-6 space-y-5 w-full"
      dir="rtl"
    >

      {/* ─── Page title ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/accounting/journals")} className="h-8 w-8">
            <ArrowRight className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
              <BookOpen className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-bold">{isNew ? "قيد جديد" : "تعديل القيد"}</h1>
              <p className="text-xs text-muted-foreground">
                {isNew ? "إنشاء قيد يومية جديد" : `تعديل القيد رقم ${existing?.docNumber ?? editId}`}
              </p>
            </div>
          </div>

          {/* ── Big doc-number panel ─────────────────────────────
              Always-visible, prominent display of the current /
              upcoming journal-entry number with one-click copy.
              This is what the user references when transcribing
              the JE number onto paper documents. */}
          {(() => {
            // Predict the next QYD-XXXX from the loaded entry list when
            // no central sequence is configured. Use MAX(numeric part of
            // docNumber) instead of MAX(id) so backfilled placeholder rows
            // (low QYD number but high global id) do not skew the
            // prediction into the wrong range.
            const maxQyd = navList.reduce((m: number, e: any) => {
              const match = String(e?.docNumber ?? "").match(/^QYD-(\d+)$/);
              const n = match ? Number(match[1]) : 0;
              return n > m ? n : m;
            }, 0);
            const predictedQyd = maxQyd > 0 ? `QYD-${String(maxQyd + 1).padStart(4, "0")}` : null;
            const num = !isNew
              ? (existing?.docNumber ?? (editId ? `QYD-${String(editId).padStart(4, "0")}` : null))
              : (docNumber
                  || (seqPeek.loading ? "…" : null)
                  || predictedQyd
                  || (seqPeek.hasSequence ? "…" : "تلقائي"));
            if (!num) return null;
            // Mark predicted numbers visually so the user knows it's an
            // estimate (the server has the final word at save time).
            const isPredicted = isNew && !docNumber && num === predictedQyd;
            const copyable = num !== "…" && num !== "تلقائي";
            const onCopy = async () => {
              if (!copyable) return;
              try {
                await navigator.clipboard.writeText(num);
                setDocNumCopied(true);
                setTimeout(() => setDocNumCopied(false), 1800);
                toast({ title: "✓ تم النسخ", description: `رقم القيد: ${num}` });
              } catch { /* ignore */ }
            };
            return (
              <div
                className={cn(
                  "flex items-center gap-2 rounded-xl border-2 px-3 py-2 shadow-sm",
                  isNew
                    ? "bg-gradient-to-l from-emerald-50 via-teal-50 to-cyan-50 border-emerald-300 dark:from-emerald-950/40 dark:via-teal-950/40 dark:to-cyan-950/40 dark:border-emerald-800"
                    : "bg-gradient-to-l from-blue-50 via-indigo-50 to-violet-50 border-blue-300 dark:from-blue-950/40 dark:via-indigo-950/40 dark:to-violet-950/40 dark:border-blue-800",
                )}
                data-testid="panel-doc-number"
              >
                <div className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-lg",
                  isNew ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        : "bg-blue-500/15 text-blue-700 dark:text-blue-300",
                )}>
                  {isNew ? <Sparkles className="h-4 w-4" /> : <BookOpen className="h-4 w-4" />}
                </div>
                <div className="flex flex-col leading-tight">
                  <span className={cn(
                    "text-[10px] font-medium uppercase tracking-wide",
                    isNew ? "text-emerald-600 dark:text-emerald-400"
                          : "text-blue-600 dark:text-blue-400",
                  )}>
                    {isNew
                      ? (isPredicted ? "الرقم القادم (تقديري)" : "الرقم القادم")
                      : "رقم القيد"}
                  </span>
                  <span
                    className={cn(
                      "font-mono text-base font-bold tabular-nums leading-tight",
                      isNew ? "text-emerald-800 dark:text-emerald-200"
                            : "text-blue-800 dark:text-blue-200",
                    )}
                    data-testid="text-doc-number"
                  >
                    {num}
                  </span>
                </div>
                {copyable && (
                  <button
                    type="button"
                    onClick={onCopy}
                    className={cn(
                      "ms-1 rounded-md p-1.5 transition-colors print:hidden",
                      isNew
                        ? "hover:bg-emerald-200/60 text-emerald-700 dark:hover:bg-emerald-800/40 dark:text-emerald-300"
                        : "hover:bg-blue-200/60 text-blue-700 dark:hover:bg-blue-800/40 dark:text-blue-300",
                    )}
                    title="نسخ رقم القيد"
                    aria-label="نسخ رقم القيد"
                    data-testid="btn-copy-doc-number"
                  >
                    {docNumCopied
                      ? <Check className="h-4 w-4 text-emerald-600" />
                      : <Copy className="h-4 w-4" />}
                  </button>
                )}
              </div>
            );
          })()}
        </div>

        <div className="flex items-center gap-2">
          {/* ── Document navigation (السابق / التالي / بحث) ───────
              Renders only on edit views (isNew has no current
              position to step from). The cluster mirrors the
              control bar shown in the design: Previous, position
              indicator, Next, search-by-doc-number/description.
              All buttons are RTL-aware. */}
          {!isNew && navList.length > 0 && (
            <div
              className="flex items-center gap-1 rounded-md border bg-background px-1 py-0.5 print:hidden"
              data-testid="journal-doc-nav"
            >
              <Button
                type="button" variant="ghost" size="sm"
                className="h-7 px-2 gap-1 text-xs"
                disabled={!prevEntry}
                onClick={() => { if (prevEntry) navigate(`/accounting/journals/${prevEntry.id}`); }}
                title={prevEntry ? `الانتقال إلى ${prevEntry.docNumber ?? `#${prevEntry.id}`}` : "لا يوجد قيد سابق"}
                data-testid="button-doc-prev"
              >
                <ChevronRight className="h-3.5 w-3.5" />
                السابق
              </Button>
              <span className="text-[11px] tabular-nums px-1.5 text-muted-foreground select-none" data-testid="doc-position">
                {currentIndex >= 0
                  ? `${currentIndex + 1} / ${navList.length} مستند`
                  : `${navList.length} مستند`}
              </span>
              <Button
                type="button" variant="ghost" size="sm"
                className="h-7 px-2 gap-1 text-xs"
                disabled={!nextEntry}
                onClick={() => { if (nextEntry) navigate(`/accounting/journals/${nextEntry.id}`); }}
                title={nextEntry ? `الانتقال إلى ${nextEntry.docNumber ?? `#${nextEntry.id}`}` : "لا يوجد قيد تالٍ"}
                data-testid="button-doc-next"
              >
                التالي
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <div className="relative">
                <Search className="h-3.5 w-3.5 absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  value={navSearch}
                  onChange={e => setNavSearch(e.target.value)}
                  onKeyDown={e => {
                    // Stop the form-wide Enter handler from also advancing
                    // focus — Enter here is a "jump to that document" action.
                    // IME composition (Arabic candidate selection, etc.)
                    // also fires Enter, which we must let through.
                    if (e.key !== "Enter") return;
                    if ((e.nativeEvent as any).isComposing) return;
                    e.preventDefault(); e.stopPropagation(); jumpFromSearch();
                  }}
                  placeholder="اكتب رقم المستند أو البيان..."
                  className="h-7 pe-7 ps-2 text-xs w-56"
                  data-testid="input-doc-search"
                />
              </div>
            </div>
          )}

          {!isNew && (
            <>
              <Button variant="outline" size="sm" onClick={() => openEntryPrintWindow()} className="gap-1.5 print:hidden">
                <Printer className="h-4 w-4" /> طباعة
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportEntryExcel} className="gap-1.5 text-green-700 border-green-200 hover:bg-green-50 print:hidden">
                <FileSpreadsheet className="h-4 w-4" /> Excel
              </Button>
              <Button variant="outline" size="sm" onClick={() => openEntryPrintWindow()} className="gap-1.5 text-red-700 border-red-200 hover:bg-red-50 print:hidden">
                <FileDown className="h-4 w-4" /> PDF
              </Button>
            </>
          )}
        </div>

        {/* Balance indicator in header */}
        <div className={cn(
          "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border",
          isBalanced
            ? "bg-green-50 text-green-700 border-green-200"
            : "bg-red-50 text-red-700 border-red-200"
        )}>
          {!isBalanced && <AlertCircle className="h-3.5 w-3.5" />}
          {isBalanced ? "القيد متوازن ✓" : `فرق: ${fmt2(diff)}`}
        </div>
      </div>

      {/* ─── Locked-source banner ─────────────────────────────────
          Shown only when this journal entry was auto-generated by a
          source document (invoice, voucher, settlement, stock move,
          payroll). Editing is disabled both client- and server-side. */}
      {isLockedSourceEntry && (
        <div
          className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900"
          data-testid="locked-source-banner"
          role="alert"
        >
          <Lock className="h-5 w-5 mt-0.5 shrink-0 text-amber-700" />
          <div className="flex-1 text-sm leading-relaxed">
            <div className="font-semibold">
              قيد مُولَّد تلقائياً — لا يمكن تعديله
            </div>
            <div className="mt-0.5 text-amber-800">
              مصدر القيد: <span className="font-medium">{lockInfo!.source}</span>.
              {" "}{lockInfo!.hint}
            </div>
          </div>
        </div>
      )}

      {/* ─── Tabs ─────────────────────────────────────────────────
          The whole form (header + lines + add/remove-line buttons)
          is wrapped in a native <fieldset disabled> when the entry
          is locked. This single attribute deactivates every nested
          input, textarea, select trigger, combobox, and button —
          including Radix UI controls — without touching each one
          individually. The `m-0 p-0 border-0` resets the default
          fieldset styling so layout is preserved. */}
      <fieldset
        disabled={isLockedSourceEntry}
        className="m-0 p-0 border-0 disabled:opacity-75"
        data-testid="journal-form-fieldset"
      >
      {/* ── سداد فاتورة مرتبط ─────────────────────────────────────
          Shown when this entry settles a credit invoice (arrived via
          "سداد بقيد محاسبي" from the invoice's السداد tab, or loaded on
          edit). The amount counts toward the invoice's paid total under
          the same overpayment policy as the vouchers. */}
      {!settleLinked && !isLockedSourceEntry && entryType === "general" && (
        <div className="mb-4" data-testid="panel-invoice-link-picker">
          {!linkPickerOpen ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setLinkPickerOpen(true)}
              data-testid="btn-open-invoice-link"
            >
              <Receipt className="h-4 w-4" />
              ربط بفاتورة (سداد)
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-dashed border-amber-300 bg-amber-50/50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/20">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-300">
                <Receipt className="h-5 w-5" />
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-xs font-medium whitespace-nowrap">نوع الفاتورة</Label>
                <Select value={linkKind} onValueChange={(v) => setLinkKind(v as any)}>
                  <SelectTrigger className="h-8 w-32 text-xs" data-testid="select-link-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sales">مبيعات آجلة</SelectItem>
                    <SelectItem value="purchase">مشتريات آجلة</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2 min-w-[280px] flex-1">
                <Label className="text-xs font-medium whitespace-nowrap">الفاتورة</Label>
                <SearchCombobox
                  value=""
                  onValueChange={(v: string) => {
                    const inv = (openInvoices as any[]).find((i) => String(i.id) === v);
                    if (!inv) return;
                    if (linkKind === "sales") { setSettleSalesInvoiceId(inv.id); setSettlePurchaseInvoiceId(null); }
                    else { setSettlePurchaseInvoiceId(inv.id); setSettleSalesInvoiceId(null); }
                    // remaining is in BASE currency; settlementAmount is in
                    // the ENTRY's currency (server multiplies by exchangeRate
                    // on save) — convert before seeding. Seed = the JE debit
                    // total if lines are already entered (partial payment =
                    // مبلغ القيد), otherwise the invoice remaining; either
                    // way capped at the remaining.
                    const rate = parseFloat(exchangeRate) || 1;
                    const remainingEntry = Number(inv.remaining) / rate;
                    const seed = totalDebit > 0.005
                      ? Math.min(totalDebit, remainingEntry)
                      : remainingEntry;
                    setSettlementAmount(seed.toFixed(2));
                    setSettleAmountAuto(true);
                    setSettleMeta({
                      invoiceNo: inv.docNumber ?? `#${inv.id}`,
                      entityName: inv.partyName ?? "",
                      remaining: Number(inv.remaining),
                    });
                    setLinkPickerOpen(false);
                  }}
                  items={(openInvoices as any[]).map((i) => ({
                    value: String(i.id),
                    label: `${i.docNumber ?? `#${i.id}`}${i.partyName ? ` — ${i.partyName}` : ""} (المتبقي ${fmt2(Number(i.remaining))})`,
                  }))}
                  placeholder={loadingOpenInvoices ? "جارٍ التحميل…" : "اختر فاتورة آجلة مفتوحة…"}
                  data-testid="combobox-link-invoice"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                onClick={() => setLinkPickerOpen(false)}
                data-testid="btn-cancel-invoice-link"
              >
                إلغاء
              </Button>
            </div>
          )}
        </div>
      )}
      {settleLinked && (
        <div
          className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border-2 border-amber-300 bg-gradient-to-l from-amber-50 via-orange-50 to-yellow-50 px-4 py-3 dark:border-amber-800 dark:from-amber-950/40 dark:via-orange-950/40 dark:to-yellow-950/40"
          data-testid="panel-invoice-settlement"
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-300">
            <Receipt className="h-5 w-5" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
              {settleSalesInvoiceId != null ? "سداد فاتورة مبيعات آجلة" : "سداد فاتورة مشتريات آجلة"}
            </span>
            <span className="text-sm font-bold">
              {(settleMeta?.invoiceNo || settleSeed?.invoiceNo)
                ? `فاتورة ${settleMeta?.invoiceNo || settleSeed?.invoiceNo}`
                : `فاتورة #${settleSalesInvoiceId ?? settlePurchaseInvoiceId}`}
              {(settleMeta?.entityName || settleSeed?.entityName) ? ` — ${settleMeta?.entityName || settleSeed?.entityName}` : ""}
            </span>
          </div>
          <div className="ms-auto flex items-center gap-2">
            <Label className="text-xs font-medium whitespace-nowrap">مبلغ السداد</Label>
            <Input
              inputMode="decimal"
              dir="ltr"
              className="h-8 w-36 text-sm font-bold tabular-nums"
              value={settlementAmount}
              onChange={(e) => {
                setSettleAmountAuto(false);
                setSettlementAmount(e.target.value.replace(/[^\d.]/g, ""));
              }}
              data-testid="input-settlement-amount"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-destructive hover:text-destructive"
              onClick={() => {
                setSettleSalesInvoiceId(null);
                setSettlePurchaseInvoiceId(null);
                setSettlementAmount("");
                setSettleMeta(null);
                setSettleAmountAuto(false);
              }}
              title="إزالة ربط الفاتورة"
              data-testid="btn-remove-settlement-link"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
      <Tabs value={activeTab} onValueChange={setActiveTab} dir="rtl">

        {/* Tab headers */}
        <Card className="border-2">
          <CardHeader className="p-0">
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/20">
              {/* Left: context hint */}
              <p className="text-[11px] text-muted-foreground">
                {activeTab === "header"
                  ? "أدخل بيانات الرأسية ثم انتقل إلى سطور القيد"
                  : `${lines.filter(l => l.accountId).length} سطر — مدين: ${fmt2(totalDebit)} | دائن: ${fmt2(totalCredit)}`}
              </p>

              {/* Right: tabs */}
              <TabsList className="h-8 bg-background border gap-1">
                <TabsTrigger
                  value="header"
                  className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  <FileText className="h-3.5 w-3.5" />
                  البيانات الرأسية
                </TabsTrigger>
              </TabsList>
            </div>
          </CardHeader>

          {/* ── Tab 1: Header data ────────────────────────── */}
          <TabsContent value="header" className="mt-0">
            <CardContent className="pt-5 pb-5">
              {/* Row 1 */}
              <div className="grid grid-cols-3 gap-4 mb-4">
                {fp.isVisible("docNumber") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      رقم المستند
                      {fp.isRequired("docNumber") && <span className="text-destructive"> *</span>}
                    </Label>
                    {(() => {
                      const lockOnEdit = !isNew;
                      const lockOnSeq  = isNew && seqPeek.hasSequence;
                      const lockOnFp   = fp.isReadOnly("docNumber");
                      const locked     = lockOnEdit || lockOnSeq || lockOnFp;
                      return (
                        <Input
                          value={docNumber}
                          onChange={e => { if (!locked) setDocNumber(e.target.value); }}
                          placeholder={isNew && seqPeek.loading ? "…" : "تلقائي"}
                          className={cn("h-9 text-sm", locked && "bg-muted/40 cursor-not-allowed")}
                          readOnly={locked}
                          required={fp.isRequired("docNumber")}
                          title={lockOnEdit ? "الرقم محفوظ — لا يمكن تعديله"
                            : (lockOnSeq ? `مسلسل: ${seqPeek.sequenceCode ?? ""}`
                            : (lockOnFp ? "للقراءة فقط — حسب صلاحيات قالبك" : undefined))}
                        />
                      );
                    })()}
                  </div>
                )}
                {fp.isVisible("date") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      التاريخ <span className="text-destructive">*</span>
                    </Label>
                    <SmartDateInput
                      value={entryDate}
                      onChange={v => { if (!fp.isReadOnly("date")) setEntryDate(v); }}
                      className={cn("h-9 text-sm", fp.isReadOnly("date") && "bg-muted/40 cursor-not-allowed")}
                      readOnly={fp.isReadOnly("date")}
                      required
                      {...(fp.dateBounds("date") ?? {})}
                      title={fp.isReadOnly("date") ? "للقراءة فقط — حسب صلاحيات قالبك" : undefined}
                    />
                  </div>
                )}
                {fp.isVisible("currency") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      العملة
                      {fp.isRequired("currency") && <span className="text-destructive"> *</span>}
                    </Label>
                    <Select value={currency} onValueChange={handleCurrencyChange} disabled={fp.isReadOnly("currency")}>
                      <SelectTrigger className={cn("h-9 text-sm", fp.isReadOnly("currency") && "bg-muted/40")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {hasCurrencies
                          ? dbCurrencies
                              .filter((c: any) => c.isActive)
                              .map((c: any) => (
                                <SelectItem key={c.code} value={c.code}>
                                  {c.symbol ? `${c.symbol} ` : ""}{c.nameAr} ({c.code})
                                  {c.isDefault ? " ★" : ""}
                                </SelectItem>
                              ))
                          : <SelectItem value="SAR">ريال سعودي (SAR)</SelectItem>
                        }
                      </SelectContent>
                    </Select>
                    {!hasCurrencies && (
                      <p className="text-[10px] text-amber-600 mt-0.5">
                        أضف عملات من شاشة العملات لتظهر هنا
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Row 2 */}
              <div className="grid grid-cols-3 gap-4 mb-4">
                {fp.isVisible("exchangeRate") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      سعر الصرف
                      {fp.isRequired("exchangeRate") && <span className="text-destructive"> *</span>}
                    </Label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={exchangeRate}
                      onChange={e => {
                        if (fp.isReadOnly("exchangeRate")) return;
                        const v = e.target.value.replace(/[^0-9.]/g, "").replace(/^(\d*\.?\d*).*/, "$1");
                        setExchangeRate(v);
                      }}
                      className={cn("h-9 text-sm", fp.isReadOnly("exchangeRate") && "bg-muted/40 cursor-not-allowed")}
                      readOnly={fp.isReadOnly("exchangeRate")}
                      dir="ltr"
                    />
                    {hasCurrencies && currency && (
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        1 {currency} = {Number(exchangeRate) > 0 ? fmtNum(Number(exchangeRate), 4) : "—"} {defaultCurrency?.code ?? "SAR"}
                      </p>
                    )}
                  </div>
                )}
                {fp.isVisible("entryType") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      النوع
                      {fp.isRequired("entryType") && <span className="text-destructive"> *</span>}
                    </Label>
                    <Select value={entryType} onValueChange={setEntryType} disabled={fp.isReadOnly("entryType")}>
                      <SelectTrigger className={cn("h-9 text-sm", fp.isReadOnly("entryType") && "bg-muted/40")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ENTRY_TYPES.map(t => (
                          <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {isNew && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">نوع القيد</Label>
                    <Select
                      value={specialKind}
                      onValueChange={v => {
                        setSpecialKind(v);
                        setSpec({});
                        // القيد الافتتاحي يعاد استخدام نوعه الحالي "opening"
                        // (نفس آلية شاشة الأرصدة الافتتاحية) — بقية الأنواع
                        // لا تغيّر نوع القيد المحاسبي نفسه.
                        if (v === "opening") setEntryType("opening");
                        else if (entryType === "opening") setEntryType("general");
                      }}
                    >
                      <SelectTrigger className="h-9 text-sm" data-testid="select-special-kind">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SPECIAL_KINDS.map(k => (
                          <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {fp.isVisible("branch") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      الفرع
                      {fp.isRequired("branch") && <span className="text-destructive"> *</span>}
                    </Label>
                    <Select
                      value={branchId || "__none"}
                      onValueChange={v => setBranchId(v === "__none" ? "" : v)}
                      disabled={fp.isReadOnly("branch")}
                    >
                      <SelectTrigger className={cn("h-9 text-sm", fp.isReadOnly("branch") && "bg-muted/40")}>
                        <SelectValue placeholder="— اختر الفرع —" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">— بدون فرع —</SelectItem>
                        {branches.map((b: any) => (
                          <SelectItem key={b.id} value={String(b.id)}>{b.nameAr}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              {/* Row 3 – description */}
              {fp.isVisible("description") && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs font-medium">
                      البيان العام
                      {fp.isRequired("description") && <span className="text-destructive"> *</span>}
                    </Label>
                    {/* Quick-pick: pull a customer or supplier and inject its
                        key data (name, CR, VAT, national address) so the
                        printed قيد carries a complete party reference for
                        Zakat & Income Tax compliance. */}
                    <div className="flex items-center gap-2">
                      {fp.isVisible("attachments") && (
                        <JournalScanArchive
                          jeKey={isNew ? newArchiveKey : (existing?.docNumber ?? `JE-${editId}`)}
                          screenKey="journal_entries"
                          companyName={user?.company?.nameAr ?? null}
                          sourceJournalEntryId={!isNew && editId ? editId : undefined}
                        />
                      )}
                      {fp.isVisible("partyPicker") && !fp.isReadOnly("partyPicker") && (
                        <JournalPartyPicker
                          onInsert={(text) => {
                            const prev = description;
                            const next = prev.trim() ? `${prev.trimEnd()}\n${text}` : text;
                            // Mirror into lines that still match the prev description
                            // OR are empty — same behaviour as the manual textarea
                            // above so the user gets a single source of truth.
                            setLines(ls => ls.map(l => {
                              if (!l.description || l.description === prev) {
                                return { ...l, description: next };
                              }
                              return l;
                            }));
                            setDescription(next);
                          }}
                        />
                      )}
                    </div>
                  </div>
                  <Textarea
                    value={description}
                    onChange={e => {
                      if (fp.isReadOnly("description")) return;
                      const next = e.target.value;
                      const prev = description;
                      // Mirror into each line's description IF the line is empty
                      // or still equals the previous general description (i.e. the
                      // user hasn't customised that line yet). Lines with their
                      // own custom text are left alone.
                      setLines(ls => ls.map(l => {
                        if (!l.description || l.description === prev) {
                          return { ...l, description: next };
                        }
                        return l;
                      }));
                      setDescription(next);
                    }}
                    placeholder="وصف القيد..."
                    className={cn("text-sm resize-none", fp.isReadOnly("description") && "bg-muted/40 cursor-not-allowed")}
                    readOnly={fp.isReadOnly("description")}
                    required={fp.isRequired("description")}
                    rows={3}
                  />
                </div>
              )}

            </CardContent>
          </TabsContent>

          {/* ── Lines (rendered under same header tab) ─── */}
          <TabsContent value="header" className="mt-0">
            <CardContent className="p-0">
              {/* Toolbar */}
              <div className="flex items-center justify-end gap-2 px-4 py-2 border-b bg-muted/10">
                {/* الضريبة — user-selectable tax from the company catalog,
                    defaulting to the company default. Drives both the percent
                    rate and the routed VAT account used by "قيد الضريبة". */}
                {jeTaxes.length > 0 && (
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="font-medium text-muted-foreground">الضريبة</span>
                    <div className="w-44">
                      <SearchCombobox
                        items={jeTaxComboItems}
                        value={jeTaxId}
                        onValueChange={setJeTaxId}
                        placeholder="اختر الضريبة"
                        disabled={isLockedSourceEntry || taxEntryMutation.isPending}
                      />
                    </div>
                  </div>
                )}
                {/* Per-action tax controls (قيد الضريبة / شامل الضريبة /
                    ضريبة سريعة / ضريبة صفرية) were MOVED out of this toolbar
                    onto EACH journal line — see the per-line "قيد الضريبة"
                    button in the line row. This removes the ambiguity where the
                    old toolbar button taxed the focused/first row instead of the
                    row the user was actually filling. The الضريبة picker above
                    stays here because it selects WHICH company tax (rate +
                    routed account) all per-line actions use. */}
                <Button
                  type="button"
                  variant="outline" size="sm"
                  onClick={() => setAccountBrowserOpen(true)}
                  disabled={isLockedSourceEntry}
                  className="h-7 gap-1 text-xs shrink-0 border-violet-300 bg-gradient-to-br from-violet-50 to-fuchsia-50 hover:from-violet-100 hover:to-fuchsia-100 text-violet-700 dark:from-violet-950/30 dark:to-fuchsia-950/30 dark:border-violet-800 dark:text-violet-300"
                  title="استكشف الحسابات حسب الفئة (مصروفات/إيرادات/أصول…) — مفيد عندما لا تتذكر الاسم بالضبط"
                  data-testid="btn-account-browser"
                >
                  <Search className="h-3.5 w-3.5" />
                  بحث ذكي
                  <Sparkles className="h-3 w-3 text-fuchsia-500" />
                </Button>
                <Button
                  variant="outline" size="sm"
                  onClick={addLine}
                  className="h-7 gap-1 text-xs shrink-0"
                >
                  <Plus className="h-3.5 w-3.5" />
                  إضافة سطر
                </Button>
              </div>

              <AccountBrowserDialog
                open={accountBrowserOpen}
                onOpenChange={setAccountBrowserOpen}
                onPick={pickAccountFromBrowser}
                initialType="all"
              />

              {/* Column headers — same grid template as line rows */}
              <div className="grid grid-cols-[32px_2fr_1fr_1fr_1.5fr_1.2fr_32px_32px_32px] gap-2 px-4 py-2 border-b bg-muted/30 text-[11px] font-semibold text-muted-foreground">
                <span />
                <span>الحساب</span>
                <span>مدين</span>
                <span>دائن</span>
                <span>البيان</span>
                <span>مركز التكلفة</span>
                <span />
                <span />
                <span />
              </div>

              {/* Lines */}
              <div className="divide-y">
                {lines.map((line, idx) => (
                  <div
                    key={line.id}
                    className="grid grid-cols-[32px_2fr_1fr_1fr_1.5fr_1.2fr_32px_32px_32px] gap-2 px-4 py-2.5 items-center hover:bg-muted/10"
                  >
                    <span className="text-[10px] text-muted-foreground text-center font-mono">{idx + 1}</span>

                    {/* Wrap the account picker in a tooltip that surfaces
                        the FULL account context (code + Ar/En name + type
                        + parent header) on hover. Helps verify the right
                        account is selected before posting without having
                        to re-open the combobox or the chart-of-accounts. */}
                    {(() => {
                      const a = acctMap.get(Number(line.accountId));
                      const parent = a?.parentId != null ? acctMap.get(Number(a.parentId)) : null;
                      const typeLbl: Record<string, string> = {
                        asset: "أصول", liability: "التزامات", equity: "حقوق ملكية",
                        revenue: "إيرادات", expense: "مصروفات",
                      };
                      const tip = a ? (
                        <div className="space-y-1 text-xs leading-5">
                          <div className="font-semibold flex items-center gap-2">
                            <span className="font-mono text-[10px] bg-primary/15 text-primary px-1.5 py-0.5 rounded">{a.code}</span>
                            <span>{a.nameAr || "—"}</span>
                          </div>
                          {a.nameEn && <div className="text-muted-foreground">{a.nameEn}</div>}
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <span>النوع:</span>
                            <span className="font-medium text-foreground">{typeLbl[a.accountType] ?? a.accountType ?? "—"}</span>
                          </div>
                          {parent && (
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <span>الحساب الرئيسي:</span>
                              <span className="font-medium text-foreground">{parent.code} — {parent.nameAr || parent.nameEn}</span>
                            </div>
                          )}
                          {a.isPosting === false && (
                            <div className="text-amber-600 font-medium">حساب رئيسي — غير قابل للترحيل</div>
                          )}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">لم يتم اختيار حساب بعد</div>
                      );
                      // Non-blocking hint: the old hover Tooltip opened OVER the
                      // picker while the user was still choosing and got in the
                      // way. Instead we flash a small info card above the field
                      // for a moment AFTER an account is picked — it ignores the
                      // mouse entirely (pointer-events-none) and fades out on
                      // its own, so it never interrupts data entry.
                      // Two complementary hints, neither blocks data entry:
                      //  1. post-pick flash (auto-fades, ignores the mouse)
                      //  2. delayed HOVER tooltip — renders ONLY when an
                      //     account is already selected, after a 500ms rest
                      //     on the field, so it never pops up while the user
                      //     is still searching/typing inside the combobox
                      //     (Radix dismisses it on click/focus anyway).
                      const picker = (
                        <div className="relative w-full">
                          {accountFlash?.lineId === line.id && accountFlash.field === "account" && a && (
                            <div
                              className="pointer-events-none absolute bottom-full right-0 z-30 mb-1.5 max-w-xs rounded-lg border border-primary/20 bg-popover/95 p-3 shadow-lg backdrop-blur-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-200"
                              data-testid={`account-flash-${line.id}`}
                            >
                              {tip}
                            </div>
                          )}
                          <AccountCombobox
                            value={line.accountId}
                            onValueChange={v => {
                              updateLine(line.id, "accountId", v);
                              // Flash the picked account's details briefly.
                              if (accountFlashTimer.current) clearTimeout(accountFlashTimer.current);
                              if (v) {
                                setAccountFlash({ lineId: line.id, field: "account" });
                                accountFlashTimer.current = setTimeout(() => setAccountFlash(null), 2600);
                              } else {
                                setAccountFlash(null);
                              }
                            }}
                            placeholder="بحث بالكود أو الاسم..."
                            grouped={false}
                            allowEmpty
                            emptyLabel="— اختر الحساب —"
                            autoFocus={line.id === focusLineId}
                          />
                        </div>
                      );
                      if (!a) return picker;
                      return (
                        <TooltipProvider delayDuration={500}>
                          <Tooltip>
                            <TooltipTrigger asChild>{picker}</TooltipTrigger>
                            <TooltipContent side="top" align="end" className="max-w-xs p-3">
                              {tip}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      );
                    })()}

                    {/* Debit / Credit inputs use type="text" with a strict
                        decimal sanitizer instead of type="number". The native
                        number input snaps to `step` on blur/scroll/arrow-keys,
                        which produced floating-point artifacts (e.g. 1000 →
                        999.99 → "999.9" after trailing-zero stripping). The
                        text+inputMode="decimal" combo keeps the mobile decimal
                        keypad and forbids non-numeric chars while preserving
                        the EXACT digits the user typed. */}
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={line.debit}
                      onChange={e => {
                        const v = e.target.value
                          .replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
                          .replace(/[^0-9.]/g, "")
                          .replace(/^(\d*\.?\d*).*/, "$1");
                        updateLine(line.id, "debit", v);
                        if (v) updateLine(line.id, "credit", "");
                      }}
                      placeholder="0.00"
                      className={cn(
                        "h-8 text-sm text-left font-mono",
                        parseFloat(line.debit) > 0 && "border-green-400 bg-green-50/50"
                      )}
                      dir="ltr"
                    />

                    <Input
                      type="text"
                      inputMode="decimal"
                      value={line.credit}
                      onChange={e => {
                        const v = e.target.value
                          .replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
                          .replace(/[^0-9.]/g, "")
                          .replace(/^(\d*\.?\d*).*/, "$1");
                        updateLine(line.id, "credit", v);
                        if (v) updateLine(line.id, "debit", "");
                      }}
                      placeholder="0.00"
                      className={cn(
                        "h-8 text-sm text-left font-mono",
                        parseFloat(line.credit) > 0 && "border-red-400 bg-red-50/50"
                      )}
                      dir="ltr"
                    />

                    <Input
                      value={line.description}
                      onChange={e => updateLine(line.id, "description", e.target.value)}
                      placeholder="بيان السطر..."
                      className="h-8 text-sm"
                    />

                    {/* Cost-center picker. The textbox already shows
                        "code — nameAr" via `costCenterOptions.label`.
                        The tooltip on hover repeats the full context so
                        the user can confirm the centre before saving and
                        works the same way the account tooltip does. */}
                    {(() => {
                      // GENERATED tax lines never carry a cost centre — hide
                      // the picker (the dimension belongs to the source line).
                      // Manually-entered VAT-account lines keep the picker so
                      // deliberate VAT adjustments can still be dimensioned.
                      if (isGeneratedTaxLine(line)) {
                        return (
                          <div
                            className="flex h-8 items-center px-2 text-xs text-muted-foreground select-none"
                            data-testid={`cc-hidden-vat-${line.id}`}
                          >
                            —
                          </div>
                        );
                      }
                      if (isBankAccountId(line.accountId)) {
                        return (
                          <div
                            className="flex h-8 items-center px-2 text-xs text-muted-foreground select-none"
                            title="الحسابات البنكية لا تقبل مركز تكلفة"
                            data-testid={`cc-disabled-bank-${line.id}`}
                          >
                            — حساب بنكي —
                          </div>
                        );
                      }
                      const c = findCc(line.costCenter);
                      const tip = c ? (
                        <div className="space-y-1 text-xs leading-5">
                          <div className="font-semibold flex items-center gap-2">
                            <span className="font-mono text-[10px] bg-primary/15 text-primary px-1.5 py-0.5 rounded">{c.code}</span>
                            <span>{c.nameAr || "—"}</span>
                          </div>
                          {c.nameEn && <div className="text-muted-foreground">{c.nameEn}</div>}
                          {c.isPosting === false && (
                            <div className="text-amber-600 font-medium">مركز رئيسي — غير قابل للترحيل</div>
                          )}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">بدون مركز تكلفة</div>
                      );
                      // Same non-blocking flash treatment as the account picker.
                      const ccPicker = (
                        <div className="relative w-full">
                          {accountFlash?.lineId === line.id && accountFlash.field === "cc" && c && (
                            <div
                              className="pointer-events-none absolute bottom-full right-0 z-30 mb-1.5 max-w-xs rounded-lg border border-primary/20 bg-popover/95 p-3 shadow-lg backdrop-blur-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-200"
                              data-testid={`cc-flash-${line.id}`}
                            >
                              {tip}
                            </div>
                          )}
                          <SearchCombobox
                            items={costCenterOptions}
                            value={ccCode(line.costCenter)}
                            onValueChange={(v) => {
                              updateLine(line.id, "costCenter", v);
                              if (accountFlashTimer.current) clearTimeout(accountFlashTimer.current);
                              if (v) {
                                setAccountFlash({ lineId: line.id, field: "cc" });
                                accountFlashTimer.current = setTimeout(() => setAccountFlash(null), 2600);
                              } else {
                                setAccountFlash(null);
                              }
                            }}
                            placeholder="— مركز التكلفة —"
                          />
                        </div>
                      );
                      if (!c) return ccPicker;
                      return (
                        <TooltipProvider delayDuration={500}>
                          <Tooltip>
                            <TooltipTrigger asChild>{ccPicker}</TooltipTrigger>
                            <TooltipContent side="top" align="end" className="max-w-xs p-3">
                              {tip}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      );
                    })()}

                    {/* Per-line tax button — generates a VAT (or zero-rated)
                        line DIRECTLY BELOW THIS row, computed on THIS row's
                        amount and honoring the per-action "شامل الضريبة" toggle.
                        Hidden on VAT lines themselves (can't tax a tax line). */}
                    {isVatAccountLine(line) ? (
                      <div className="h-7 w-7 shrink-0" aria-hidden />
                    ) : (
                      <Popover
                        open={taxPopoverLine === line.id}
                        onOpenChange={(o) => setTaxPopoverLine(o ? line.id : null)}
                      >
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost" size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-primary"
                            disabled={isLockedSourceEntry || taxEntryMutation.isPending}
                            title={`قيد الضريبة (${ratePctLabel}) على هذا السطر`}
                            data-testid={`btn-line-tax-${idx}`}
                          >
                            <Receipt className="h-3.5 w-3.5" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-64 p-2 text-xs space-y-1.5">
                          <div className="flex items-center gap-1.5 font-semibold px-1">
                            <Receipt className="h-3.5 w-3.5 text-primary" />
                            <span>{`قيد ضريبة القيمة المضافة (${ratePctLabel})`}</span>
                          </div>
                          <label
                            className="flex items-center gap-1.5 px-1 py-1 cursor-pointer select-none rounded hover:bg-muted/50"
                            title={`عند التفعيل، يتم استخراج ${ratePctLabel} من داخل مبلغ السطر بدل إضافتها فوقه — مماثل لخيار (السعر شامل الضريبة) في الفواتير.`}
                          >
                            <Checkbox
                              checked={vatInclusive}
                              onCheckedChange={(v) => setVatInclusive(v === true)}
                              className="h-3.5 w-3.5"
                            />
                            <span className="font-medium">المبلغ شامل الضريبة</span>
                          </label>
                          {/* الترتيب المطلوب: مدين مدخلات → مدين صفرية → دائن مخرجات → دائن صفرية */}
                          <div className="border-t pt-1.5 space-y-1">
                            <Button
                              type="button" variant="ghost" size="sm"
                              className="w-full h-auto py-1.5 flex flex-col items-start gap-0.5"
                              onClick={() => { applyTaxEntry("input", line.id); setTaxPopoverLine(null); }}
                            >
                              <span className="font-semibold">مدين — ضريبة المدخلات</span>
                              <span className="text-[10px] text-muted-foreground font-normal">
                                {vatInclusive
                                  ? `استخراج ${ratePctLabel} من داخل مبلغ هذا السطر (شامل الضريبة)`
                                  : `إضافة ${ratePctLabel} فوق مبلغ هذا السطر المدين`}
                              </span>
                            </Button>
                            <Button
                              type="button" variant="ghost" size="sm"
                              className="w-full h-auto py-1.5 flex flex-col items-start gap-0.5"
                              onClick={() => { applyZeroTaxEntry("input", line.id); setTaxPopoverLine(null); }}
                            >
                              <span className="font-semibold">مدين — ضريبة صفرية (0%)</span>
                              <span className="text-[10px] text-muted-foreground font-normal">إضافة سطر ضريبة بقيمة 0.00 على الجانب المدين</span>
                            </Button>
                          </div>
                          <div className="border-t pt-1.5 space-y-1">
                            <Button
                              type="button" variant="ghost" size="sm"
                              className="w-full h-auto py-1.5 flex flex-col items-start gap-0.5"
                              onClick={() => { applyTaxEntry("output", line.id); setTaxPopoverLine(null); }}
                            >
                              <span className="font-semibold">دائن — ضريبة المخرجات</span>
                              <span className="text-[10px] text-muted-foreground font-normal">
                                {vatInclusive
                                  ? `استخراج ${ratePctLabel} من داخل مبلغ هذا السطر (شامل الضريبة)`
                                  : `إضافة ${ratePctLabel} فوق مبلغ هذا السطر الدائن`}
                              </span>
                            </Button>
                            <Button
                              type="button" variant="ghost" size="sm"
                              className="w-full h-auto py-1.5 flex flex-col items-start gap-0.5"
                              onClick={() => { applyZeroTaxEntry("output", line.id); setTaxPopoverLine(null); }}
                            >
                              <span className="font-semibold">دائن — ضريبة صفرية (0%)</span>
                              <span className="text-[10px] text-muted-foreground font-normal">إضافة سطر ضريبة بقيمة 0.00 على الجانب الدائن</span>
                            </Button>
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}

                    {/* Supplier-tax ⋮ menu ONLY on VAT lines — hidden on
                        normal lines so the user can't mistakenly attach
                        supplier details to a non-tax line. A same-size spacer
                        keeps the row columns aligned. */}
                    {isVatAccountLine(line) ? (
                      <SupplierTaxDetailsMenu
                        testId={`je-line-${idx}`}
                        value={{
                          supplierName: line.supplierName,
                          supplierVatNumber: line.supplierVatNumber,
                          supplierInvoiceNumber: line.supplierInvoiceNumber,
                          supplierInvoiceDate: line.supplierInvoiceDate,
                        }}
                        onChange={(v: SupplierTaxDetails) => patchLine(line.id, v)}
                      />
                    ) : (
                      <div className="h-7 w-7 shrink-0" aria-hidden />
                    )}

                    <Button
                      variant="ghost" size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => removeLine(line.id)}
                      disabled={lines.length <= 2}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>

              {/* Bottom add-line bar — mirrors the toolbar button so the user
                  doesn't have to scroll back up. In smart mode it also exposes
                  a live difference indicator + one-click "موازنة تلقائية". */}
              <div className="border-t bg-muted/10 px-4 py-2.5 flex flex-wrap items-center gap-2">
                <Button
                  variant="outline" size="sm"
                  onClick={addLine}
                  disabled={isLockedSourceEntry}
                  className="h-7 gap-1 text-xs"
                  data-testid="btn-add-line-bottom"
                >
                  <Plus className="h-3.5 w-3.5" />
                  إضافة سطر
                </Button>
                {smartForm && (
                  <>
                    <Button
                      type="button"
                      variant="outline" size="sm"
                      onClick={autoBalance}
                      disabled={isLockedSourceEntry || isBalanced}
                      className="h-7 gap-1 text-xs border-violet-300 bg-gradient-to-br from-violet-50 to-fuchsia-50 hover:from-violet-100 hover:to-fuchsia-100 text-violet-700 dark:from-violet-950/30 dark:to-fuchsia-950/30 dark:border-violet-800 dark:text-violet-300"
                      title="إكمال موازنة القيد تلقائياً بإضافة الفرق المتبقي"
                      data-testid="btn-auto-balance"
                    >
                      <Wand2 className="h-3.5 w-3.5" />
                      موازنة تلقائية
                    </Button>
                    <span
                      className={cn(
                        "text-[11px] font-medium px-2 py-1 rounded-md inline-flex items-center gap-1",
                        isBalanced
                          ? "bg-green-50 text-green-700"
                          : "bg-amber-50 text-amber-700"
                      )}
                      data-testid="text-smart-diff"
                    >
                      {isBalanced
                        ? "متوازن ✓"
                        : `الفرق المتبقي: ${fmt2(diff)} — سيُملأ تلقائياً عند إضافة سطر`}
                    </span>
                  </>
                )}
              </div>

              {/* Totals footer */}
              <div className="border-t bg-muted/20 px-4 py-3">
                <div className="grid grid-cols-[32px_2fr_1fr_1fr_1.5fr_1.2fr_32px_32px_32px] gap-2 items-center">
                  <span />
                  <span className="text-xs font-semibold text-muted-foreground">الإجماليات</span>
                  <span className={cn(
                    "font-mono font-bold text-sm text-left px-2",
                    totalDebit > 0 ? "text-green-700" : "text-muted-foreground"
                  )}>
                    {fmt2(totalDebit)}
                  </span>
                  <span className={cn(
                    "font-mono font-bold text-sm text-left px-2",
                    totalCredit > 0 ? "text-red-700" : "text-muted-foreground"
                  )}>
                    {fmt2(totalCredit)}
                  </span>
                  <div className={cn(
                    "flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium justify-self-start",
                    isBalanced ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                  )}>
                    {!isBalanced && <AlertCircle className="h-3.5 w-3.5 shrink-0" />}
                    {isBalanced ? "متوازن ✓" : `فرق: ${fmt2(diff)}`}
                  </div>
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </CardContent>
          </TabsContent>
        </Card>
      </Tabs>
      </fieldset>

      {/* ─── القيود الخاصة: لوحة نوع القيد (وضع الإنشاء فقط) ──────────
          الأصول/التسويات تُنشأ عبر نقاط النهاية الحالية بعد حفظ القيد —
          لا تكرار لأي منطق. لوحة "الأصول المرتبطة" القديمة في وضع
          التعديل أُزيلت بناءً على طلب المستخدم. */}
      {isNew && specialKind !== "normal" && (
        <div className="rounded-xl border-2 border-teal-200 bg-teal-50/40 p-3 space-y-3" data-testid="panel-special-kind">
          <div className="flex items-center gap-2">
            <Landmark className="h-4 w-4 text-teal-700" />
            <span className="text-sm font-bold text-teal-800">
              {SPECIAL_KINDS.find(k => k.value === specialKind)?.label}
            </span>
            <span className="text-[11px] text-teal-600">
              {specialKind === "opening"
                ? "سيُحفظ القيد بنوع «قيد افتتاحي» بنفس آلية الأرصدة الافتتاحية الحالية."
                : specialKind === "fixed_asset"
                  ? "بعد حفظ القيد يُنشأ الأصل في موديول الأصول الثابتة مرتبطاً بالقيد — دون قيد اقتناء جديد."
                  : "بعد حفظ القيد يُنشأ جدول التسويات في محرك التسويات الحالي مرتبطاً بالقيد."}
            </span>
          </div>

          {specialKind === "fixed_asset" && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">اسم الأصل *</Label>
                <Input className="h-8 text-sm" value={spec.faName ?? ""} onChange={e => setSpecF("faName", e.target.value)} data-testid="input-fa-name" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">كود الأصل (اختياري)</Label>
                <Input className="h-8 text-sm" value={spec.faCode ?? ""} onChange={e => setSpecF("faCode", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">المجموعة</Label>
                <Select value={spec.faGroupId ?? "__none"} onValueChange={v => setSpecF("faGroupId", v === "__none" ? "" : v)}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">— بدون —</SelectItem>
                    {(faGroups as any[]).map((g: any) => (
                      <SelectItem key={g.id} value={String(g.id)}>{g.nameAr ?? g.name ?? `#${g.id}`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">تاريخ الشراء</Label>
                <SmartDateInput value={spec.faPurchaseDate ?? entryDate} onChange={v => setSpecF("faPurchaseDate", v)} className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">تاريخ بدء الإهلاك</Label>
                <SmartDateInput value={spec.faDepStart ?? entryDate} onChange={v => setSpecF("faDepStart", v)} className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">العمر الإنتاجي (سنوات)</Label>
                <Input className="h-8 text-sm" dir="ltr" inputMode="decimal" value={spec.faLifeYears ?? "5"} onChange={e => setSpecF("faLifeYears", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">طريقة الإهلاك</Label>
                <Select value={spec.faMethod ?? "straight_line"} onValueChange={v => setSpecF("faMethod", v)}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="straight_line">قسط ثابت</SelectItem>
                    <SelectItem value="declining_balance">قسط متناقص</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">القيمة التخريدية</Label>
                <Input className="h-8 text-sm" dir="ltr" inputMode="decimal" value={spec.faScrap ?? "0"} onChange={e => setSpecF("faScrap", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">مركز التكلفة</Label>
                <Select value={spec.faCostCenterId ?? "__none"} onValueChange={v => setSpecF("faCostCenterId", v === "__none" ? "" : v)}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">— بدون —</SelectItem>
                    {(costCentersList as any[]).filter((c: any) => c.isActive !== false).map((c: any) => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.nameAr ?? c.name ?? `#${c.id}`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1 col-span-2">
                <Label className="text-xs">قيمة الشراء</Label>
                <Input className="h-8 text-sm bg-muted/40" dir="ltr" readOnly value={fmt2(totalDebit)} title="تُؤخذ تلقائياً من إجمالي مدين القيد" />
              </div>
            </div>
          )}

          {ADJ_KINDS.includes(specialKind) && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="space-y-1 col-span-2">
                <Label className="text-xs">
                  {/* هذا الحساب يُقيَّد مديناً في قيود التسوية الشهرية */}
                  {specialKind === "prepaid_expense" ? "حساب المصروف (يُحمَّل شهرياً — مدين) *"
                    : specialKind === "deferred_revenue" ? "حساب الإيراد المقدم (يُخفَّض شهرياً — مدين) *"
                    : specialKind === "accrued_expense" ? "حساب المصروف (مدين) *"
                    : "حساب الإيراد المستحق (مدين) *"}
                </Label>
                <AccountCombobox value={spec.adjDebitAccountId ?? ""} onValueChange={v => setSpecF("adjDebitAccountId", v)} />
              </div>
              <div className="space-y-1 col-span-2">
                <Label className="text-xs">
                  {/* وهذا الحساب يُقيَّد دائناً في قيود التسوية الشهرية */}
                  {specialKind === "prepaid_expense" ? "حساب المصروف المقدم (يُخفَّض شهرياً — دائن) *"
                    : specialKind === "deferred_revenue" ? "حساب الإيراد (يُعترف به شهرياً — دائن) *"
                    : specialKind === "accrued_expense" ? "حساب المصروف المستحق (دائن) *"
                    : "حساب الإيراد (دائن) *"}
                </Label>
                <AccountCombobox value={spec.adjCreditAccountId ?? ""} onValueChange={v => setSpecF("adjCreditAccountId", v)} />
              </div>
              {(specialKind === "prepaid_expense" || specialKind === "deferred_revenue") ? (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs">تاريخ بداية الاستهلاك *</Label>
                    <SmartDateInput value={spec.adjStart ?? entryDate} onChange={v => setSpecF("adjStart", v)} className="h-8 text-sm" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">عدد الأشهر *</Label>
                    <Input className="h-8 text-sm" dir="ltr" inputMode="numeric" value={spec.adjMonths ?? "12"} onChange={e => setSpecF("adjMonths", e.target.value)} />
                  </div>
                </>
              ) : (
                <div className="space-y-1">
                  <Label className="text-xs">تاريخ الاستحقاق *</Label>
                  <SmartDateInput value={spec.adjDue ?? entryDate} onChange={v => setSpecF("adjDue", v)} className="h-8 text-sm" />
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-xs">المبلغ (افتراضياً إجمالي المدين)</Label>
                <Input className="h-8 text-sm" dir="ltr" inputMode="decimal" placeholder={fmt2(totalDebit)} value={spec.adjAmount ?? ""} onChange={e => setSpecF("adjAmount", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">مركز التكلفة</Label>
                <Select value={spec.adjCostCenterId ?? "__none"} onValueChange={v => setSpecF("adjCostCenterId", v === "__none" ? "" : v)}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">— بدون —</SelectItem>
                    {(costCentersList as any[]).filter((c: any) => c.isActive !== false).map((c: any) => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.nameAr ?? c.name ?? `#${c.id}`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── Action buttons ─────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3 justify-start items-center pb-4">
        <Button
          onClick={handleSave}
          disabled={saveMutation.isPending || isLockedSourceEntry || (!isNew && !isBalanced)}
          className="min-w-[120px]"
          data-testid="button-save"
          title={
            isLockedSourceEntry
              ? `لا يمكن تعديل هذا القيد — مُولَّد تلقائياً من ${lockInfo!.source}`
              : (isNew && !isBalanced
                  ? `سيتم الحفظ كمسودة — القيد غير متوازن (الفرق ${fmt2(diff)} ${currency})`
                  : (!isNew && !isBalanced
                      ? `لا يمكن الحفظ — القيد غير متوازن (الفرق ${fmt2(diff)} ${currency})`
                      : undefined))
          }
        >
          {saveMutation.isPending
            ? "جارٍ الحفظ..."
            : (isNew && !isBalanced ? "حفظ كمسودة" : "حفظ")}
        </Button>
        {!isNew && existing?.status === "posted" && !isLockedSourceEntry && (
          <Button
            type="button"
            onClick={() => {
              if (!window.confirm(
                `فك ترحيل القيد ${existing?.docNumber ?? `#${editId}`} وتحويله إلى مسودة؟\n` +
                `سيُلغى أثره من كل التقارير حتى يُعاد ترحيله — وسيحتفظ بنفس رقم التسلسل عند إعادة الترحيل.`
              )) return;
              unpostMutation.mutate();
            }}
            disabled={unpostMutation.isPending}
            className="min-w-[120px] gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
            data-testid="button-unpost"
          >
            <RotateCcw className="h-4 w-4" />
            {unpostMutation.isPending ? "جارٍ فك الترحيل..." : "فك الترحيل"}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            // Print-only path: never touches saveMutation. The print
            // window builds its layout from current form state, so it
            // works for unsaved entries too — a "مسودة" watermark is
            // added so the user can't mistake it for a posted record.
            // We only require at least one line with an account.
            if (printableLines.length === 0) {
              toast({
                title: "لا يمكن الطباعة",
                description: "أضف سطراً واحداً على الأقل واختر له حساباً قبل الطباعة.",
                variant: "destructive",
              });
              return;
            }
            try { openEntryPrintWindow(); } catch { /* popup-blocker noise */ }
          }}
          className="gap-1.5"
          data-testid="button-print"
        >
          <Printer className="h-4 w-4" />
          طباعة
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={runAiValidation}
          disabled={validateMutation.isPending}
          className="gap-2"
        >
          <Sparkles className="h-4 w-4" />
          {validateMutation.isPending ? "جارٍ الفحص..." : "فحص بالذكاء الاصطناعي"}
        </Button>
        <Button variant="outline" onClick={() => navigate("/accounting/journals")}>
          إلغاء
        </Button>
        {!isBalanced && (
          <span className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="h-3.5 w-3.5" />
            القيد غير متوازن — الفرق {fmt2(diff)} {currency}
          </span>
        )}
      </div>

      {/* ─── AI validation dialog ───────────────────────────────── */}
      <Dialog open={aiValidationOpen} onOpenChange={setAiValidationOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              فحص القيد بالذكاء الاصطناعي
            </DialogTitle>
            <DialogDescription>
              مراجعة آلية للتوازن وللحسابات والمبالغ قبل الحفظ.
            </DialogDescription>
          </DialogHeader>

          {validateMutation.isPending ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              جارٍ تحليل القيد…
            </div>
          ) : validateMutation.data ? (
            <div className="space-y-4">
              <div className={cn(
                "flex items-start gap-2 p-3 rounded-md border text-sm",
                validateMutation.data.isBalanced && validateMutation.data.issues.length === 0
                  ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                  : "bg-amber-50 border-amber-200 text-amber-900"
              )}>
                {validateMutation.data.isBalanced && validateMutation.data.issues.length === 0
                  ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                  : <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />}
                <span className="font-medium">{validateMutation.data.summary}</span>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="p-2 rounded border bg-muted/40">
                  <div className="text-muted-foreground">إجمالي مدين</div>
                  <div className="font-semibold mt-1">{fmt2(validateMutation.data.totalDebit)}</div>
                </div>
                <div className="p-2 rounded border bg-muted/40">
                  <div className="text-muted-foreground">إجمالي دائن</div>
                  <div className="font-semibold mt-1">{fmt2(validateMutation.data.totalCredit)}</div>
                </div>
                <div className={cn("p-2 rounded border",
                  validateMutation.data.isBalanced ? "bg-emerald-50 border-emerald-200" : "bg-destructive/10 border-destructive/30"
                )}>
                  <div className="text-muted-foreground">الفرق</div>
                  <div className="font-semibold mt-1">{fmt2(Math.abs(validateMutation.data.diff))}</div>
                </div>
              </div>

              {validateMutation.data.issues.length > 0 && (
                <div>
                  <div className="text-sm font-semibold mb-1.5">الملاحظات:</div>
                  <ul className="space-y-1 text-sm list-disc pe-5">
                    {validateMutation.data.issues.map((it, i) => (
                      <li key={i}>{it}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="p-3 rounded-md border bg-primary/5 border-primary/20 text-sm">
                <div className="font-semibold mb-1">الاقتراح:</div>
                <div>{validateMutation.data.suggestion}</div>
              </div>

              <div className="text-[10px] text-muted-foreground text-end">
                المصدر: {validateMutation.data.source === "ai" ? "ذكاء اصطناعي" : "قواعد محلية"}
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setAiValidationOpen(false)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
