import { useState, useEffect, useRef } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { journalEntriesApi } from "@/lib/journalEntriesApi";
import { branchesApi } from "@/lib/branchesApi";
import { safeLogoSrc } from "@/lib/export";
import { AccountCombobox } from "@/components/AccountCombobox";
import AccountBrowserDialog from "@/components/AccountBrowserDialog";
import { JournalPartyPicker } from "@/components/JournalPartyPicker";
import { JournalScanArchive } from "@/components/JournalScanArchive";
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
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import { useFieldPolicy } from "@/hooks/useInvoiceFieldPolicy";
import { Sparkles, AlertTriangle, CheckCircle2, Receipt, Copy, Check } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  Plus, Trash2, ArrowRight, BookOpen, AlertCircle,
  FileText, Printer, FileSpreadsheet, FileDown, Lock,
  ChevronRight, ChevronLeft, Search,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import * as XLSX from "xlsx";

const ENTRY_TYPES = [
  { value: "general",      label: "قيد عام" },
  { value: "opening",      label: "قيد افتتاحي" },
  { value: "closing",      label: "قيد إقفال" },
  { value: "adjustment",   label: "قيد تسوية" },
  { value: "depreciation", label: "قيد إهلاك" },
];

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
}

function newLine(): JournalLine {
  return { id: crypto.randomUUID(), accountId: "", costCenter: "", debit: "", credit: "", description: "" };
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

export default function JournalEntryForm() {
  const { user } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
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

  const [activeTab,    setActiveTab]    = useState("header");
  const [docNumber,    setDocNumber]    = useState("");
  const [entryDate,    setEntryDate]    = useState(today());
  const [currency,     setCurrency]     = useState("SAR");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [description,  setDescription]  = useState("");
  const [entryType,    setEntryType]    = useState("general");
  const [branchId,     setBranchId]     = useState("");
  const [lines,        setLines]        = useState<JournalLine[]>([newLine(), newLine()]);
  const [focusLineId, setFocusLineId] = useState<string>(() => "");
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
    queryKey: ["journal-entries", cid],
    queryFn:  () => journalEntriesApi.list(cid),
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
  const costCenterOptions = [
    { value: "", label: "— بدون مركز تكلفة —" },
    ...costCentersList
      .filter((c: any) => c.isActive !== false)
      .map((c: any) => ({ value: c.code, label: `${c.code} — ${c.nameAr}` })),
  ];
  const acctMap = new Map<number, any>(accountsList.map((a: any) => [a.id, a]));
  const acctLabel = (id: any) => {
    const a = acctMap.get(Number(id));
    return a ? `${a.code} — ${a.nameAr || a.nameEn || ""}` : "—";
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
    setLines(
      existing.lines?.length
        ? existing.lines.map((l: any) => ({
            id:          crypto.randomUUID(),
            accountId:   l.accountId ? String(l.accountId) : "",
            costCenter:  l.costCenter ?? "",
            debit:       l.debit  ? String(Number(l.debit))  : "",
            credit:      l.credit ? String(Number(l.credit)) : "",
            description: l.description ?? "",
          }))
        : [newLine(), newLine()]
    );
    setActiveTab("header");
  }, [existing]);

  const totalDebit  = lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  const diff        = Math.abs(totalDebit - totalCredit);
  const isBalanced  = diff < 0.001;

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
    setLines(prev => prev.map(l => l.id === id ? { ...l, [field]: value } : l));
  }
  function addLine() {
    // Inherit the general description so a newly-added line is consistent
    // with all the others — the user explicitly asked the البيان العام to
    // appear on every row, even when adding more rows after the fact.
    const l = { ...newLine(), description: description || "" };
    setLines(prev => [...prev, l]);
    setFocusLineId(l.id);
    return l;
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
    setLines(prev => prev.map(l => l.id === targetId ? { ...l, accountId: String(a.id) } : l));
    setFocusLineId(targetId);
    toast({ title: "✓ تم إدراج الحساب", description: "يمكنك الآن إدخال المبلغ في العمود المناسب." });
  }

  // ── قيد الضريبة (Tax Entry) ─────────────────────────────────────
  // Adds a 15% VAT line for EACH eligible existing line, on the same
  // side, WITHOUT modifying any original amount.
  //   • "input"  → ضريبة المدخلات: for every line with debit > 0,
  //                 append a new Dr line of 15% × debit using the
  //                 input-VAT account.
  //   • "output" → ضريبة المخرجات: for every line with credit > 0,
  //                 append a new Cr line of 15% × credit using the
  //                 output-VAT account.
  // Lines that are themselves previously-generated VAT lines (same
  // VAT account or description starting with "ضريبة …") are skipped
  // so re-clicking does not pyramid tax on tax.
  // NOTE: the original amounts are intentionally left untouched, so
  // the entry will become unbalanced by the total VAT amount — the
  // user is expected to add the offsetting payable/receivable side.
  const VAT_RATE = 0.15;
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
  const NET_MARKER = " (صافٍ من ضريبة 15%)";
  const taxEntryMutation = useMutation({
    mutationFn: (direction: "input" | "output") =>
      journalEntriesApi.suggestVatAccount({ direction, companyId: cid }),
  });

  async function applyTaxEntry(direction: "input" | "output") {
    if (isLockedSourceEntry) return;
    if (lines.length === 0) {
      toast({ title: "لا توجد سطور", description: "أضف سطراً أولاً قبل توليد قيد الضريبة.", variant: "destructive" });
      return;
    }
    const sideField: "debit" | "credit" = direction === "input" ? "debit" : "credit";

    // Pre-collect amounts that already have a generated VAT line for
    // the SAME direction (input/output). Re-clicking the button must
    // be fully idempotent: a source line of 1000 that already has a
    // "ضريبة المدخلات 15% على 1000.00" sibling must NOT get another
    // 150 appended.
    const directionPrefix = direction === "input" ? "ضريبة المدخلات" : "ضريبة المخرجات";
    // Count how many VAT lines already exist for each source amount.
    // We use a multiset (Map<amountKey, count>) instead of a Set so
    // that if the user has TWO source lines of 1000 but only ONE VAT
    // line was generated previously, the second 1000 still gets its
    // own VAT line on the next click. Bug fix: the old Set caused any
    // line sharing an amount with a previously-taxed line to be
    // silently skipped, even when it had no tax yet.
    const alreadyTaxedCounts = new Map<string, number>();
    for (const ln of lines) {
      const d = (ln.description || "").trim();
      if (!d.startsWith(directionPrefix)) continue;
      const m = d.match(/على\s+([0-9]+(?:\.[0-9]+)?)/);
      if (m) {
        const k = Number(m[1]).toFixed(2);
        alreadyTaxedCounts.set(k, (alreadyTaxedCounts.get(k) ?? 0) + 1);
      }
    }

    // Pick all lines with an account + a positive amount on the
    // relevant side. Skip prior VAT lines themselves AND consume one
    // unit from alreadyTaxedCounts per matching source line so the
    // remainder still gets a fresh VAT line.
    const remainingTaxed = new Map(alreadyTaxedCounts);
    const eligible = lines
      .map((ln, idx) => ({ ln, idx, amount: parseFloat(ln[sideField] || "0") || 0 }))
      .filter(({ ln, amount }) => {
        if (amount <= 0) return false;
        if (!ln.accountId) return false;
        const desc = (ln.description || "").trim();
        if (desc.startsWith("ضريبة المدخلات") || desc.startsWith("ضريبة المخرجات")) return false;
        // Inclusive mode marks net-extracted lines with NET_MARKER —
        // skip them on subsequent clicks so we don't re-tax the net.
        if (desc.endsWith(NET_MARKER.trim()) || desc.includes(NET_MARKER)) return false;
        const k = amount.toFixed(2);
        const left = remainingTaxed.get(k) ?? 0;
        if (left > 0) {
          remainingTaxed.set(k, left - 1);
          return false;
        }
        return true;
      });

    if (eligible.length === 0) {
      toast({
        title: direction === "input" ? "لا توجد سطور مدينة صالحة" : "لا توجد سطور دائنة صالحة",
        description: direction === "input"
          ? "أضف على الأقل سطراً واحداً فيه حساب ومبلغ مدين قبل توليد ضريبة المدخلات."
          : "أضف على الأقل سطراً واحداً فيه حساب ومبلغ دائن قبل توليد ضريبة المخرجات.",
        variant: "destructive",
      });
      return;
    }

    let suggestion: { accountId: number | null; accountLabel: string; reasoning: string; source: "ai" | "rules" };
    try {
      suggestion = await taxEntryMutation.mutateAsync(direction);
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
    const vatAccountId = String(suggestion.accountId);

    // Build one VAT line per eligible source line, preserving the
    // source's costCenter so the tax follows the same dimension.
    // In INCLUSIVE mode we additionally rewrite the source line's
    // amount down to the net (gross − VAT) so the journal stays
    // balanced — exactly the way invoice "السعر شامل الضريبة"
    // behaves on sales/purchase screens.
    const vatLines: JournalLine[] = [];
    const sourceUpdates = new Map<string, { amount: string; description: string }>();
    let totalVat = 0;
    for (const { ln, amount } of eligible) {
      // Skip lines that already use the chosen VAT account itself
      // (defensive — covers the case where description was edited).
      if (ln.accountId === vatAccountId) continue;

      let vatAmount: number;
      let baseForLabel: number;
      let pendingNet: number | null = null;
      if (vatInclusive) {
        // amount is the GROSS, extract VAT from inside it
        vatAmount = Math.round(amount * (VAT_RATE / (1 + VAT_RATE)) * 100) / 100;
        baseForLabel = amount;
        pendingNet = Math.round((amount - vatAmount) * 100) / 100;
      } else {
        // amount is the NET, add VAT on top (existing behaviour)
        vatAmount = Math.round(amount * VAT_RATE * 100) / 100;
        baseForLabel = amount;
      }
      if (vatAmount <= 0) continue;
      // Only mark the source line as net-extracted AFTER we are sure
      // a VAT line will actually be emitted — otherwise sub-cent rows
      // would be tagged with NET_MARKER and become non-taxable later.
      if (vatInclusive && pendingNet !== null) {
        sourceUpdates.set(ln.id, {
          amount: pendingNet.toFixed(2),
          description: ((ln.description || "") + NET_MARKER).trim(),
        });
      }
      totalVat += vatAmount;
      const incTag = vatInclusive ? " (شاملة)" : "";
      vatLines.push({
        id: crypto.randomUUID(),
        accountId: vatAccountId,
        costCenter: ln.costCenter ?? "",
        debit:  direction === "input"  ? vatAmount.toFixed(2) : "",
        credit: direction === "output" ? vatAmount.toFixed(2) : "",
        description: direction === "input"
          ? `ضريبة المدخلات 15%${incTag} ${vatInclusive ? "من" : "على"} ${baseForLabel.toFixed(2)}`
          : `ضريبة المخرجات 15%${incTag} ${vatInclusive ? "من" : "على"} ${baseForLabel.toFixed(2)}`,
      });
    }

    if (vatLines.length === 0) {
      toast({ title: "قيمة الضريبة صفر", description: "تحقّق من قيم السطور.", variant: "destructive" });
      return;
    }

    setLines(prev => {
      const updated = prev.map(l => {
        const u = sourceUpdates.get(l.id);
        if (!u) return l;
        return { ...l, [sideField]: u.amount, description: u.description };
      });
      return [...updated, ...vatLines];
    });
    setFocusLineId(vatLines[vatLines.length - 1].id);

    toast({
      title: direction === "input" ? "تمت إضافة سطور ضريبة المدخلات" : "تمت إضافة سطور ضريبة المخرجات",
      description: `${vatLines.length} سطر • إجمالي الضريبة ${totalVat.toFixed(2)} ${currency} • ${suggestion.accountLabel} • ${suggestion.source === "ai" ? "اقتراح ذكاء اصطناعي" : "قواعد محلية"}`,
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
      // Show the JUST-saved doc number prominently in the toast so the user
      // sees confirmation of what was just created/updated.
      const savedDoc = saved?.docNumber ?? docNumber;
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
        if (defaultCurrency?.code) setCurrency(defaultCurrency.code);
        setLines([newLine(), newLine()]);
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
      toast({ title: "القيد غير متوازن", description: `الفرق: ${diff.toFixed(2)}`, variant: "destructive" }); return;
    }
    const validLines = lines.filter(l => l.accountId);
    if (!isNew && validLines.length < 2) {
      toast({ title: "يجب أن يحتوي القيد على سطرين على الأقل", variant: "destructive" }); return;
    }
    saveMutation.mutate({
      companyId:    cid,
      docNumber:    docNumber || null,
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

  const handleExportEntryExcel = () => {
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
    XLSX.writeFile(wb, `journal-entry-${docLabel}.xlsx`);
  };

  // Build a compact 80 mm thermal-receipt HTML for the current entry.
  // Mirrors the A4 builder's data model but drops the wide table in
  // favour of a stacked per-line list so totals stay legible on the
  // narrower paper. Same `safeLogoSrc` defang for the company logo.
  const buildEntryThermalHtml = () => {
    const today = new Date().toLocaleDateString("ar-SA");
    const safeLogo = safeLogoSrc((user?.company as any)?.logo);
    const logoHtml = safeLogo
      ? `<div style="text-align:center;margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:48px;max-width:160px;object-fit:contain;display:inline-block;" /></div>`
      : "";
    const linesHtml = printableLines.map((l, i) => {
      const a = acctMap.get(Number(l.accountId));
      const debit  = Number(l.debit  || 0);
      const credit = Number(l.credit || 0);
      const side = debit > 0 ? `مدين ${debit.toFixed(2)}` : `دائن ${credit.toFixed(2)}`;
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
  <div class="row"><span>إجمالي المدين</span><span>${totalDebit.toFixed(2)}</span></div>
  <div class="row"><span>إجمالي الدائن</span><span>${totalCredit.toFixed(2)}</span></div>
</div>
<div class="balance" style="color:${isBalanced ? "#15803d" : "#b91c1c"};">${isBalanced ? "متوازن ✓" : `فرق: ${diff.toFixed(2)}`}</div>
<div class="center" style="font-size:9px;color:#555;margin-top:8px;">طُبع في ${today}</div>
<script>setTimeout(()=>window.print(),300);</script>
</body></html>`;
  };

  const buildEntryPrintHtml = () => {
    const today = new Date().toLocaleDateString("ar-SA");
    // Forward the configured company logo and Arabic name into the print
    // header so single-entry printouts carry the same branding as the
    // rest of the system's reports.  `safeLogoSrc` defangs any crafted
    // value before it is interpolated into the print HTML.
    const safeLogo = safeLogoSrc((user?.company as any)?.logo);
    const logoHtml = safeLogo
      ? `<div style="margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:54px;max-width:170px;object-fit:contain;display:block;margin:0 auto;" /></div>`
      : "";
    const companyNameHtml = user?.company?.nameAr
      ? `<div style="font-size:13px;font-weight:600;color:#1e3a8a;margin-bottom:2px;">${escapeHtml(user.company.nameAr)}</div>`
      : "";
    const lineRowsHtml = printableLines.map((l, i) => {
      const a = acctMap.get(Number(l.accountId));
      return `<tr>
        <td class="c">${i + 1}</td>
        <td class="num">${escapeHtml(a?.code ?? "")}</td>
        <td>${escapeHtml(a?.nameAr || a?.nameEn || "—")}</td>
        <td>${escapeHtml(ccLabel(l.costCenter))}</td>
        <td class="num">${Number(l.debit  || 0).toFixed(2)}</td>
        <td class="num">${Number(l.credit || 0).toFixed(2)}</td>
        <td>${escapeHtml(l.description || "—")}</td>
      </tr>`;
    }).join("");
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>قيد ${escapeHtml(docLabel)}</title>
<style>
@page {
  size: A4;
  margin: 12mm 12mm 22mm 12mm;
  @bottom-center {
    content: "صفحة " counter(page) " من " counter(pages);
    font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif;
    font-size: 9pt;
    color: #475569;
  }
}
@media print { thead { display: table-header-group; } }
* { box-sizing: border-box; }
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; padding:0; }
.head { text-align:center; border-bottom: 2px solid #1e3a8a; padding-bottom:10px; margin-bottom:12px; }
.head h1 { margin:0 0 4px; font-size:20px; color:#1e3a8a; }
.head .meta { font-size:11px; color:#555; }
.info { display:grid; grid-template-columns: repeat(3, 1fr); gap:6px 14px; font-size:12px; margin-bottom:14px; padding:10px; border:1px solid #e5e7eb; border-radius:6px; background:#fafbfd; }
.info .lbl { color:#6b7280; font-size:10px; }
.info .val { font-weight:600; }
.desc { font-size:12px; padding:8px 10px; border:1px dashed #cbd5e1; border-radius:6px; margin-bottom:12px; }
.desc .lbl { color:#6b7280; font-size:10px; display:block; margin-bottom:2px; }
table { width:100%; border-collapse:collapse; font-size:11px; }
thead th { background:#1e3a8a; color:#fff; padding:6px 8px; border:1px solid #1e3a8a; text-align:right; font-weight:600; }
tbody td { padding:6px 8px; border:1px solid #d1d5db; text-align:right; vertical-align: middle; }
tbody tr:nth-child(even) td { background:#f5f7fb; }
.c { text-align:center; }
.num { font-family:"Consolas",monospace; }
tfoot td { background:#eef2ff; font-weight:700; padding:8px; border:1px solid #1e3a8a; }
.balanced { color:#15803d; }
.unbalanced { color:#b91c1c; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة / حفظ PDF</button>
<div class="head">
  ${logoHtml}
  ${companyNameHtml}
  <h1>قيد محاسبي — ${escapeHtml(docLabel)}</h1>
  <div class="meta">طُبع في ${today}${isDraftPrint ? " — <span style=\"color:#b91c1c;font-weight:700;\">مسودة (غير محفوظ)</span>" : ""}</div>
</div>
${isDraftPrint ? `<div style="position:fixed;top:40%;left:0;right:0;text-align:center;font-size:90px;font-weight:900;color:rgba(185,28,28,0.10);transform:rotate(-22deg);pointer-events:none;letter-spacing:8px;z-index:0;">مسودة • DRAFT</div>` : ""}
<div class="info">
  <div><div class="lbl">رقم القيد</div><div class="val">${escapeHtml(docLabel)}</div></div>
  <div><div class="lbl">التاريخ</div><div class="val">${escapeHtml(entryDate)}</div></div>
  <div><div class="lbl">النوع</div><div class="val">${escapeHtml(typeLabel)}</div></div>
  <div><div class="lbl">العملة</div><div class="val">${escapeHtml(currency)} (سعر الصرف ${escapeHtml(exchangeRate)})</div></div>
  <div><div class="lbl">الفرع</div><div class="val">${escapeHtml(branchLabel)}</div></div>
  <div><div class="lbl">عدد السطور</div><div class="val">${printableLines.length}</div></div>
</div>
${description ? `<div class="desc"><span class="lbl">البيان العام</span>${escapeHtml(description)}</div>` : ""}
<table>
  <thead><tr>
    <th class="c">#</th><th>كود الحساب</th><th>اسم الحساب</th><th>مركز التكلفة</th><th>مدين</th><th>دائن</th><th>البيان</th>
  </tr></thead>
  <tbody>${lineRowsHtml}</tbody>
  <tfoot><tr>
    <td colspan="4" class="c">الإجمالي</td>
    <td class="num">${totalDebit.toFixed(2)}</td>
    <td class="num">${totalCredit.toFixed(2)}</td>
    <td class="${isBalanced ? "balanced" : "unbalanced"}">${isBalanced ? "متوازن ✓" : `فرق: ${diff.toFixed(2)}`}</td>
  </tr></tfoot>
</table>
<script>setTimeout(()=>window.print(),300);</script>
</body></html>`;
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
      className="p-6 space-y-5 max-w-5xl mx-auto"
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
          {isBalanced ? "القيد متوازن ✓" : `فرق: ${diff.toFixed(2)}`}
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
      <Tabs value={activeTab} onValueChange={setActiveTab} dir="rtl">

        {/* Tab headers */}
        <Card className="border-2">
          <CardHeader className="p-0">
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/20">
              {/* Left: context hint */}
              <p className="text-[11px] text-muted-foreground">
                {activeTab === "header"
                  ? "أدخل بيانات الرأسية ثم انتقل إلى سطور القيد"
                  : `${lines.filter(l => l.accountId).length} سطر — مدين: ${totalDebit.toFixed(2)} | دائن: ${totalCredit.toFixed(2)}`}
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
                        1 {currency} = {Number(exchangeRate) > 0 ? Number(exchangeRate).toFixed(4) : "—"} {defaultCurrency?.code ?? "SAR"}
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
                          jeKey={docNumber || (editId ? `JE-${editId}` : `new-draft`)}
                          companyName={user?.company?.nameAr ?? null}
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
                {/* المبلغ شامل الضريبة — when checked, "قيد الضريبة"
                    extracts 15% from inside each source amount instead
                    of adding it on top. Mirrors invoice behaviour. */}
                <label
                  className="flex items-center gap-1.5 text-xs cursor-pointer select-none ml-1"
                  title="عند التفعيل، يتم استخراج 15% من المبلغ الأصلي بدل إضافتها فوقه — مماثل لخيار (السعر شامل الضريبة) في الفواتير."
                >
                  <Checkbox
                    checked={vatInclusive}
                    onCheckedChange={(v) => setVatInclusive(v === true)}
                    disabled={isLockedSourceEntry || taxEntryMutation.isPending}
                    className="h-3.5 w-3.5"
                  />
                  <span className="font-medium">المبلغ شامل الضريبة</span>
                </label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline" size="sm"
                      disabled={isLockedSourceEntry || taxEntryMutation.isPending}
                      className="h-7 gap-1 text-xs shrink-0"
                      title={vatInclusive
                        ? "استخراج 15% ضريبة من داخل مبلغ السطر (المبلغ شامل الضريبة)"
                        : "إضافة 15% ضريبة قيمة مضافة فوق مبلغ السطر"}
                    >
                      <Receipt className="h-3.5 w-3.5" />
                      {taxEntryMutation.isPending ? "جارٍ التحليل..." : "قيد الضريبة"}
                      <Sparkles className="h-3 w-3 text-primary/70" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel className="text-xs">قيد ضريبة القيمة المضافة (15%)</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => applyTaxEntry("input")}
                      className="text-xs flex flex-col items-start gap-0.5"
                    >
                      <span className="font-semibold">مدين — ضريبة المدخلات</span>
                      <span className="text-[10px] text-muted-foreground">
                        {vatInclusive
                          ? "استخراج 15% من داخل كل مبلغ مدين (شامل الضريبة)"
                          : "إضافة 15% فوق كل مبلغ مدين"}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => applyTaxEntry("output")}
                      className="text-xs flex flex-col items-start gap-0.5"
                    >
                      <span className="font-semibold">دائن — ضريبة المخرجات</span>
                      <span className="text-[10px] text-muted-foreground">
                        {vatInclusive
                          ? "استخراج 15% من داخل كل مبلغ دائن (شامل الضريبة)"
                          : "إضافة 15% فوق كل مبلغ دائن"}
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
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
              <div className="grid grid-cols-[32px_2fr_1fr_1fr_1.5fr_1.2fr_32px] gap-2 px-4 py-2 border-b bg-muted/30 text-[11px] font-semibold text-muted-foreground">
                <span />
                <span>الحساب</span>
                <span>مدين</span>
                <span>دائن</span>
                <span>البيان</span>
                <span>مركز التكلفة</span>
                <span />
              </div>

              {/* Lines */}
              <div className="divide-y">
                {lines.map((line, idx) => (
                  <div
                    key={line.id}
                    className="grid grid-cols-[32px_2fr_1fr_1fr_1.5fr_1.2fr_32px] gap-2 px-4 py-2.5 items-center hover:bg-muted/10"
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
                      return (
                        <TooltipProvider delayDuration={250}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="w-full">
                                <AccountCombobox
                                  value={line.accountId}
                                  onValueChange={v => updateLine(line.id, "accountId", v)}
                                  placeholder="بحث بالكود أو الاسم..."
                                  grouped={false}
                                  allowEmpty
                                  emptyLabel="— اختر الحساب —"
                                  autoFocus={line.id === focusLineId}
                                />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="top" align="start" className="max-w-xs p-3">
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
                      return (
                        <TooltipProvider delayDuration={250}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="w-full">
                                <SearchCombobox
                                  items={costCenterOptions}
                                  value={line.costCenter}
                                  onValueChange={(v) => updateLine(line.id, "costCenter", v)}
                                  placeholder="— مركز التكلفة —"
                                />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="top" align="start" className="max-w-xs p-3">
                              {tip}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      );
                    })()}

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

              {/* Totals footer */}
              <div className="border-t bg-muted/20 px-4 py-3">
                <div className="grid grid-cols-[32px_2fr_1fr_1fr_1.5fr_1.2fr_32px] gap-2 items-center">
                  <span />
                  <span className="text-xs font-semibold text-muted-foreground">الإجماليات</span>
                  <span className={cn(
                    "font-mono font-bold text-sm text-left px-2",
                    totalDebit > 0 ? "text-green-700" : "text-muted-foreground"
                  )}>
                    {totalDebit.toFixed(2)}
                  </span>
                  <span className={cn(
                    "font-mono font-bold text-sm text-left px-2",
                    totalCredit > 0 ? "text-red-700" : "text-muted-foreground"
                  )}>
                    {totalCredit.toFixed(2)}
                  </span>
                  <div className={cn(
                    "flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium justify-self-start",
                    isBalanced ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                  )}>
                    {!isBalanced && <AlertCircle className="h-3.5 w-3.5 shrink-0" />}
                    {isBalanced ? "متوازن ✓" : `فرق: ${diff.toFixed(2)}`}
                  </div>
                  <span />
                  <span />
                </div>
              </div>
            </CardContent>
          </TabsContent>
        </Card>
      </Tabs>
      </fieldset>

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
                  ? `سيتم الحفظ كمسودة — القيد غير متوازن (الفرق ${diff.toFixed(2)} ${currency})`
                  : (!isNew && !isBalanced
                      ? `لا يمكن الحفظ — القيد غير متوازن (الفرق ${diff.toFixed(2)} ${currency})`
                      : undefined))
          }
        >
          {saveMutation.isPending
            ? "جارٍ الحفظ..."
            : (isNew && !isBalanced ? "حفظ كمسودة" : "حفظ")}
        </Button>
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
            القيد غير متوازن — الفرق {diff.toFixed(2)} {currency}
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
                  <div className="font-semibold mt-1">{validateMutation.data.totalDebit.toFixed(2)}</div>
                </div>
                <div className="p-2 rounded border bg-muted/40">
                  <div className="text-muted-foreground">إجمالي دائن</div>
                  <div className="font-semibold mt-1">{validateMutation.data.totalCredit.toFixed(2)}</div>
                </div>
                <div className={cn("p-2 rounded border",
                  validateMutation.data.isBalanced ? "bg-emerald-50 border-emerald-200" : "bg-destructive/10 border-destructive/30"
                )}>
                  <div className="text-muted-foreground">الفرق</div>
                  <div className="font-semibold mt-1">{Math.abs(validateMutation.data.diff).toFixed(2)}</div>
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
