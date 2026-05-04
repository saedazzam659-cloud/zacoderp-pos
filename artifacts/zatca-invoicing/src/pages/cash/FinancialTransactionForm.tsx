import { useState, useEffect, useMemo } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { parseError } from "@/lib/parseError";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import {
  ArrowLeftRight, ArrowRight, ChevronRight, ChevronLeft, Search,
  Loader2, Save, Send, Lock, FileText, Banknote, Wallet, Landmark,
  Plus, Minus, RefreshCw, BookMarked, FolderTree, FolderOpen, Folder,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

// ─── User-friendly transaction types ─────────────────────────────────
// We expose 3 friendly types in the UI but persist them to the existing
// cash_transfers schema (which uses 4 internal `transferType` values).
// The mapping is straightforward:
//   deposit   → cash → bank   (cash_to_bank)
//   withdraw  → bank → cash   (bank_to_cash)
//   transfer  → cash↔cash OR bank↔bank (user picks via subType)
type TxKind = "deposit" | "withdraw" | "transfer";
type TransferSub = "cash_to_cash" | "bank_to_bank";

interface FormState {
  date: string;
  kind: TxKind;
  transferSub: TransferSub;          // only relevant when kind === "transfer"
  fromCashBoxId: string;
  fromBankId: string;
  toCashBoxId: string;
  toBankId: string;
  amount: string;
  currencyId: string;
  exchangeRate: string;
  description: string;
  notes: string;
}

const EMPTY: FormState = {
  date: today(),
  kind: "deposit",
  transferSub: "bank_to_bank",
  fromCashBoxId: "",
  fromBankId: "",
  toCashBoxId: "",
  toBankId: "",
  amount: "",
  currencyId: "",
  exchangeRate: "1",
  description: "",
  notes: "",
};

const NS = "financialTransactions";

// Map (kind, transferSub) → backend transferType column.
function backendTransferType(kind: TxKind, sub: TransferSub): string {
  if (kind === "deposit")  return "cash_to_bank";
  if (kind === "withdraw") return "bank_to_cash";
  return sub; // transfer: cash_to_cash or bank_to_bank
}
function frontendKind(transferType: string): { kind: TxKind; sub: TransferSub } {
  if (transferType === "cash_to_bank") return { kind: "deposit",  sub: "bank_to_bank" };
  if (transferType === "bank_to_cash") return { kind: "withdraw", sub: "bank_to_bank" };
  if (transferType === "cash_to_cash") return { kind: "transfer", sub: "cash_to_cash" };
  return { kind: "transfer", sub: "bank_to_bank" };
}

export default function FinancialTransactionForm() {
  const [, params] = useRoute("/cash/financial-transactions/:id");
  const [, navigate] = useLocation();
  // Wouter matches "/new" against ":id" → params.id === "new". Treat /new as
  // create mode; treat strictly-numeric ids as edit. For any other non-numeric
  // garbage (e.g. /cash/financial-transactions/abc), redirect to the listing
  // rather than silently entering create mode.
  const rawId = params?.id;
  const isCreatePath = !rawId || rawId === "new";
  const isNumericId = !!rawId && /^\d+$/.test(rawId);
  const editId = isNumericId ? Number(rawId) : null;
  const isNew = editId == null;
  useEffect(() => {
    if (rawId && !isCreatePath && !isNumericId) {
      navigate("/cash/financial-transactions");
    }
  }, [rawId, isCreatePath, isNumericId, navigate]);

  const { user, token } = useAuth();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const { fmt } = useFormatters();
  const qc = useQueryClient();
  const isRtl = i18n.language === "ar";
  const h = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [form, setForm] = useState<FormState>(EMPTY);
  const [tab, setTab] = useState<"info" | "parties" | "accounts">("info");
  const [pendingMode, setPendingMode] = useState<"draft" | "post" | null>(null);
  const [acctSearch, setAcctSearch] = useState("");
  const [acctTypeFilter, setAcctTypeFilter] = useState<string>("");

  // ── Reference data ─────────────────────────────────────────────
  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes", cid],
    queryFn: () => fetch(`${API}/api/cash-boxes?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: () => fetch(`${API}/api/bank-accounts?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: () => fetch(`${API}/api/accounts?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
    staleTime: 60_000,
  });
  const { data: transfers = [] } = useQuery<any[]>({
    queryKey: ["cash-transfers", cid],
    queryFn: () => fetch(`${API}/api/cash-transfers?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
    staleTime: 30_000,
  });
  const { data: currencies = [] } = useQuery<any[]>({
    queryKey: ["currencies", cid],
    queryFn: () => fetch(`${API}/api/currencies?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
    staleTime: 60_000,
  });
  const defaultCurrencyId =
    (currencies as any[]).find((c: any) => c.isDefault)?.id ??
    (currencies as any[])[0]?.id ?? null;
  // Sync the default currency into form state on new transactions so
  // that what the user sees pre-selected is actually what gets saved.
  useEffect(() => {
    if (isNew && !form.currencyId && defaultCurrencyId) {
      setForm(p => ({ ...p, currencyId: String(defaultCurrencyId) }));
    }
  }, [isNew, form.currencyId, defaultCurrencyId]);

  // ── Edit-mode load ─────────────────────────────────────────────
  const { data: existing } = useQuery<any>({
    queryKey: ["cash-transfer", editId],
    queryFn: () => fetch(`${API}/api/cash-transfers/${editId}`, { headers: h }).then(r => r.json()),
    enabled: !!editId,
  });
  useEffect(() => {
    if (!existing) return;
    const { kind, sub } = frontendKind(existing.transferType ?? "cash_to_bank");
    setForm({
      date: existing.date ?? today(),
      kind,
      transferSub: sub,
      fromCashBoxId: existing.fromCashBoxId ? String(existing.fromCashBoxId) : "",
      fromBankId:    existing.fromBankId    ? String(existing.fromBankId)    : "",
      toCashBoxId:   existing.toCashBoxId   ? String(existing.toCashBoxId)   : "",
      toBankId:      existing.toBankId      ? String(existing.toBankId)      : "",
      amount: existing.amount ?? "",
      currencyId: existing.currencyId ? String(existing.currencyId) : "",
      exchangeRate: existing.exchangeRate ?? "1",
      description: existing.description ?? "",
      notes: existing.notes ?? "",
    });
  }, [existing]);

  // ── Document code label ───────────────────────────────────────
  // The cash_transfers backend auto-generates the code on insert; we just
  // show "تلقائي" while creating, and the saved code while editing.
  const docLabel = isNew ? t(`${NS}.autoCode`, "تلقائي") : (existing?.code ?? "—");

  // ── Document navigation (prev/next/jump) ──────────────────────
  const navList = transfers as any[];
  const currentIndex = editId != null ? navList.findIndex(v => Number(v.id) === Number(editId)) : -1;
  const prevDoc = currentIndex >= 0 && currentIndex < navList.length - 1 ? navList[currentIndex + 1] : null;
  const nextDoc = currentIndex > 0 ? navList[currentIndex - 1] : null;

  const [navSearch, setNavSearch] = useState("");
  function jumpFromSearch() {
    const q = navSearch.trim().toLowerCase();
    if (!q) return;
    const hit =
      navList.find(v => String(v.code ?? "").toLowerCase() === q) ||
      navList.find(v => String(v.code ?? "").toLowerCase().includes(q)) ||
      navList.find(v => String(v.description ?? "").toLowerCase().includes(q));
    if (!hit) {
      toast({ title: t(`${NS}.searchNotFound`, "لم يتم العثور على معاملة مطابقة"), variant: "destructive" });
      return;
    }
    setNavSearch("");
    navigate(`/cash/financial-transactions/${hit.id}`);
  }

  // ── Build searchable combobox items ────────────────────────────
  const cashBoxItems: ComboboxItem[] = useMemo(() =>
    (cashBoxes as any[]).map(c => ({
      value: String(c.id),
      label: isRtl ? c.nameAr : (c.nameEn || c.nameAr),
      description: c.code ?? undefined,
    })), [cashBoxes, isRtl]);

  const bankItems: ComboboxItem[] = useMemo(() =>
    (bankAccounts as any[]).map(b => ({
      value: String(b.id),
      label: isRtl ? b.nameAr : (b.nameEn || b.nameAr),
      description: b.accountNumber ?? b.iban ?? b.code ?? undefined,
    })), [bankAccounts, isRtl]);

  // Helpers — compute which side is cash vs bank from kind/sub.
  const fromIsCash =
    form.kind === "deposit" ||
    (form.kind === "transfer" && form.transferSub === "cash_to_cash");
  const toIsCash =
    form.kind === "withdraw" ||
    (form.kind === "transfer" && form.transferSub === "cash_to_cash");

  // Reset side IDs when transaction type changes — otherwise leftover
  // values would still be sent to the backend and fail validation.
  function changeKind(k: TxKind) {
    setForm(p => ({
      ...p, kind: k,
      fromCashBoxId: "", fromBankId: "", toCashBoxId: "", toBankId: "",
    }));
  }
  function changeSub(s: TransferSub) {
    setForm(p => ({
      ...p, transferSub: s,
      fromCashBoxId: "", fromBankId: "", toCashBoxId: "", toBankId: "",
    }));
  }

  // ── Live JE preview ───────────────────────────────────────────
  function jePreview() {
    const amt = Number(form.amount || 0);
    if (!isFinite(amt) || amt <= 0) return null;

    const findCash = (id: string) => (cashBoxes as any[]).find(c => String(c.id) === id);
    const findBank = (id: string) => (bankAccounts as any[]).find(b => String(b.id) === id);
    const cashName = (c: any) => c ? (isRtl ? c.nameAr : (c.nameEn || c.nameAr)) : "";
    const bankName = (b: any) => b ? (isRtl ? b.nameAr : (b.nameEn || b.nameAr)) : "";

    const fromName = fromIsCash
      ? cashName(findCash(form.fromCashBoxId))
      : bankName(findBank(form.fromBankId));
    const toName = toIsCash
      ? cashName(findCash(form.toCashBoxId))
      : bankName(findBank(form.toBankId));

    return {
      drLabel: toName   || t(`${NS}.noTo`,   "لم يتم اختيار الوجهة"),
      crLabel: fromName || t(`${NS}.noFrom`, "لم يتم اختيار المصدر"),
      amount: amt,
    };
  }

  // ── Save / save-and-post mutation ──────────────────────────────
  // Per-doc-type auto-posting flag with global fallback. See
  // SalesDocumentForm for the full rationale on the legacy fallback.
  const _co = (user as any)?.company;
  const _gl = _co?.autoPostingEnabled !== false;
  const autoPostingEnabled = _co?.autoPostFinancial === undefined || _co?.autoPostFinancial === null
    ? _gl
    : _co.autoPostFinancial !== false;
  const isLocked = !isNew && existing?.status === "posted";

  const saveMut = useMutation({
    mutationFn: async (mode: "draft" | "post") => {
      const cleanAmt = String(form.amount).replace(/[^\d.\-]/g, "");
      const amtNum = Number(cleanAmt);
      if (!isFinite(amtNum) || amtNum <= 0) throw new Error(t(`${NS}.invalidAmount`, "المبلغ غير صحيح"));
      if (!form.date) throw new Error(t(`${NS}.dateRequired`, "التاريخ مطلوب"));

      const fromOk = fromIsCash ? !!form.fromCashBoxId : !!form.fromBankId;
      const toOk   = toIsCash   ? !!form.toCashBoxId   : !!form.toBankId;
      if (!fromOk) throw new Error(t(`${NS}.fromRequired`, "اختر مصدر التحويل"));
      if (!toOk)   throw new Error(t(`${NS}.toRequired`,   "اختر وجهة التحويل"));

      const transferType = backendTransferType(form.kind, form.transferSub);
      const body: any = {
        date: form.date,
        transferType,
        amount: amtNum.toFixed(2),
        currencyId:    form.currencyId    ? parseInt(form.currencyId)    : null,
        exchangeRate: form.exchangeRate,
        description: form.description,
        notes: form.notes,
        companyId: cid,
        fromCashBoxId: form.fromCashBoxId ? parseInt(form.fromCashBoxId) : null,
        fromBankId:    form.fromBankId    ? parseInt(form.fromBankId)    : null,
        toCashBoxId:   form.toCashBoxId   ? parseInt(form.toCashBoxId)   : null,
        toBankId:      form.toBankId      ? parseInt(form.toBankId)      : null,
      };

      const url = isNew
        ? `${API}/api/cash-transfers`
        : `${API}/api/cash-transfers/${editId}`;
      const res = await fetch(url, {
        method: isNew ? "POST" : "PUT",
        headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved = await res.json();

      if (mode === "post" && saved?.id && (saved.status ?? "draft") === "draft") {
        const pr = await fetch(`${API}/api/cash-transfers/${saved.id}/post`, { method: "POST", headers: h });
        const pj = await pr.json().catch(() => ({}));
        if (!pr.ok) return { ...saved, _posted: false, _postError: pj?.error || pr.statusText };
        return { ...pj, _posted: true };
      }
      return { ...saved, _posted: false };
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["cash-transfers"] });
      qc.invalidateQueries({ queryKey: ["cash-transfer", data.id] });
      if (data?._postError) {
        toast({
          variant: "destructive",
          title: t(`${NS}.savedButPostFailed`, "تم الحفظ كمسودة — لكن فشل الترحيل"),
          description: data._postError,
        });
      } else {
        toast({
          title: data?._posted
            ? (isNew ? t(`${NS}.saved_create`, "تم إنشاء المعاملة") : t(`${NS}.saved_update`, "تم تحديث المعاملة"))
            : t(`${NS}.savedDraft`, "تم الحفظ بنجاح"),
        });
      }
      navigate("/cash/financial-transactions");
    },
    onError: (e: any) => toast({ title: t(`${NS}.err_save`, "تعذّر الحفظ"), description: parseError(e), variant: "destructive" }),
    onSettled: () => setPendingMode(null),
  });

  function save(mode: "draft" | "post") {
    if (isLocked) {
      toast({
        title: t(`${NS}.cantEditPosted`, "لا يمكن تعديل معاملة مرحَّلة"),
        description: t(`${NS}.unpostFirst`, "افتح المعاملة من القائمة وقم بفك ترحيلها أولاً."),
        variant: "destructive",
      });
      return;
    }
    // Auto-switch to whichever tab contains the missing required field
    if (!form.date) {
      setTab("info");
    } else {
      const fromOk = fromIsCash ? !!form.fromCashBoxId : !!form.fromBankId;
      const toOk   = toIsCash   ? !!form.toCashBoxId   : !!form.toBankId;
      const cleanAmt = String(form.amount).replace(/[^\d.\-]/g, "");
      const amtNum = Number(cleanAmt);
      if (!fromOk || !toOk || !isFinite(amtNum) || amtNum <= 0) setTab("parties");
    }
    setPendingMode(mode);
    saveMut.mutate(mode);
  }

  // ── Chart-of-accounts tree (Tab 3) ────────────────────────────
  const accountTypes = ["asset", "liability", "equity", "revenue", "expense"] as const;
  const typeColors: Record<string, string> = {
    asset:     "bg-blue-50 text-blue-700 border-blue-200",
    liability: "bg-rose-50 text-rose-700 border-rose-200",
    equity:    "bg-purple-50 text-purple-700 border-purple-200",
    revenue:   "bg-green-50 text-green-700 border-green-200",
    expense:   "bg-amber-50 text-amber-700 border-amber-200",
  };

  // Index accounts by id and by parentId so we can render hierarchy.
  const accountById = useMemo(() => {
    const map = new Map<number, any>();
    (accounts as any[]).forEach(a => map.set(a.id, a));
    return map;
  }, [accounts]);

  // For each account, compute the linked cash box / bank account (if any)
  // — this is what makes Tab 3 actionable: clicking such a leaf preselects
  // that cash box / bank in the From or To slot.
  const cashBoxByAccountId = useMemo(() => {
    const map = new Map<number, any>();
    (cashBoxes as any[]).forEach(c => { if (c.accountId) map.set(c.accountId, c); });
    return map;
  }, [cashBoxes]);
  const bankByAccountId = useMemo(() => {
    const map = new Map<number, any>();
    (bankAccounts as any[]).forEach(b => { if (b.accountId) map.set(b.accountId, b); });
    return map;
  }, [bankAccounts]);

  const filteredAccounts = useMemo(() => {
    const q = acctSearch.trim().toLowerCase();
    return (accounts as any[])
      .filter(a => !acctTypeFilter || a.accountType === acctTypeFilter)
      .filter(a => {
        if (!q) return true;
        const code = String(a.code ?? "").toLowerCase();
        const nAr  = String(a.nameAr ?? "").toLowerCase();
        const nEn  = String(a.nameEn ?? "").toLowerCase();
        return code.includes(q) || nAr.includes(q) || nEn.includes(q);
      })
      .sort((a, b) => String(a.code ?? "").localeCompare(String(b.code ?? "")));
  }, [accounts, acctSearch, acctTypeFilter]);

  function pickFromAccountTree(account: any) {
    const cb = cashBoxByAccountId.get(account.id);
    const ba = bankByAccountId.get(account.id);

    // Linked to a cash box → prefer the side(s) that expect a cash asset.
    if (cb) {
      // Find compatible slots first, then pick the empty one (from-preferred).
      const fromCompatible = fromIsCash;
      const toCompatible = toIsCash;
      if (!fromCompatible && !toCompatible) {
        toast({
          title: t(`${NS}.tipCashFrom`, "غيّر نوع المعاملة لاستخدام خزنة"),
          variant: "destructive",
        });
        return;
      }
      const fromEmpty = !form.fromCashBoxId;
      const toEmpty = !form.toCashBoxId;
      let target: "from" | "to";
      if (fromCompatible && toCompatible) {
        target = fromEmpty ? "from" : (toEmpty ? "to" : "from");
      } else if (fromCompatible) {
        target = "from";
      } else {
        target = "to";
      }
      setForm(p =>
        target === "from"
          ? { ...p, fromCashBoxId: String(cb.id) }
          : { ...p, toCashBoxId: String(cb.id) },
      );
      toast({ title: t(`${NS}.pickedFromTree`, "تم اختيار الحساب"), description: cb.nameAr });
      setTab("parties");
      return;
    }

    // Linked to a bank account → prefer the side(s) that expect a bank asset.
    if (ba) {
      const fromCompatible = !fromIsCash;
      const toCompatible = !toIsCash;
      if (!fromCompatible && !toCompatible) {
        toast({
          title: t(`${NS}.tipBankFrom`, "غيّر نوع المعاملة لاستخدام بنك"),
          variant: "destructive",
        });
        return;
      }
      const fromEmpty = !form.fromBankId;
      const toEmpty = !form.toBankId;
      let target: "from" | "to";
      if (fromCompatible && toCompatible) {
        target = fromEmpty ? "from" : (toEmpty ? "to" : "from");
      } else if (fromCompatible) {
        target = "from";
      } else {
        target = "to";
      }
      setForm(p =>
        target === "from"
          ? { ...p, fromBankId: String(ba.id) }
          : { ...p, toBankId: String(ba.id) },
      );
      toast({ title: t(`${NS}.pickedFromTree`, "تم اختيار الحساب"), description: ba.nameAr });
      setTab("parties");
      return;
    }

    // Account not linked to any cash/bank — copy code to clipboard for reference.
    try {
      navigator.clipboard?.writeText(String(account.code ?? ""));
      toast({
        title: t(`${NS}.codeCopied`, "تم نسخ كود الحساب"),
        description: `${account.code} — ${account.nameAr}`,
      });
    } catch {/* ignore */}
  }

  // ── Render ─────────────────────────────────────────────────────
  const preview = jePreview();
  const txKindMeta: Record<TxKind, { label: string; color: string; icon: any; bg: string; activeBg: string; activeText: string }> = {
    deposit: {
      label: t(`${NS}.deposit`, "إيداع"),
      color: "text-green-700",
      icon: Plus,
      bg: "hover:bg-green-50",
      activeBg: "bg-green-100",
      activeText: "text-green-800",
    },
    withdraw: {
      label: t(`${NS}.withdraw`, "سحب"),
      color: "text-rose-700",
      icon: Minus,
      bg: "hover:bg-rose-50",
      activeBg: "bg-rose-100",
      activeText: "text-rose-800",
    },
    transfer: {
      label: t(`${NS}.transfer`, "تحويل"),
      color: "text-violet-700",
      icon: RefreshCw,
      bg: "hover:bg-violet-50",
      activeBg: "bg-violet-100",
      activeText: "text-violet-800",
    },
  };

  return (
    <div className="max-w-6xl mx-auto px-4 pb-28 pt-2 space-y-4" dir={isRtl ? "rtl" : "ltr"}>
      {/* ─── Top bar: back / title / nav ────────────────────────── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate("/cash/financial-transactions")} className="gap-1.5">
            {isRtl ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            {t(`${NS}.backToList`, "عودة للقائمة")}
          </Button>
          <div className="hidden sm:flex items-center gap-1.5 text-muted-foreground">
            <ArrowLeftRight className="h-4 w-4 text-violet-600" />
            <h1 className="text-base font-bold text-foreground">
              {isNew
                ? t(`${NS}.newTitle`, "معاملة مالية جديدة")
                : t(`${NS}.editingCode`, { code: docLabel, defaultValue: "تعديل المعاملة {{code}}" })}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={() => prevDoc && navigate(`/cash/financial-transactions/${prevDoc.id}`)} disabled={!prevDoc} className="gap-1 px-2">
            {isRtl ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
            <span className="hidden md:inline text-xs">{t(`${NS}.prev`, "السابق")}</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => nextDoc && navigate(`/cash/financial-transactions/${nextDoc.id}`)} disabled={!nextDoc} className="gap-1 px-2">
            <span className="hidden md:inline text-xs">{t(`${NS}.next`, "التالي")}</span>
            {isRtl ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </Button>
          <div className="relative">
            <Search className={cn("absolute top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none", isRtl ? "right-2" : "left-2")} />
            <Input
              value={navSearch}
              onChange={e => setNavSearch(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); jumpFromSearch(); } }}
              placeholder={t(`${NS}.searchPh`, "ابحث برقم أو وصف...")}
              className={cn("h-8 w-44 text-xs", isRtl ? "pr-7" : "pl-7")}
            />
          </div>
        </div>
      </div>

      {/* Locked banner — when the transfer is already posted */}
      {isLocked && (
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3">
          <Lock className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-900">
            <p className="font-semibold">{t(`${NS}.lockedTitle`, "المعاملة مرحَّلة — لا يمكن تعديلها")}</p>
            <p className="text-xs mt-0.5 text-amber-800">{t(`${NS}.lockedHint`, "للتعديل، عُد إلى القائمة وقم بفك الترحيل أولاً.")}</p>
          </div>
        </div>
      )}

      {/* ─── Two-column body ───────────────────────────────────── */}
      <fieldset disabled={isLocked} className="m-0 p-0 border-0 disabled:opacity-75">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5 items-start">
          {/* ── Left column: 3-tab form ──────────────────────── */}
          <div>
            <Tabs value={tab} onValueChange={(v) => setTab(v as "info" | "parties" | "accounts")} className="w-full">
              <TabsList className="grid grid-cols-3 w-full h-11">
                <TabsTrigger value="info" className="gap-2 data-[state=active]:bg-violet-50 data-[state=active]:text-violet-900 data-[state=active]:shadow-sm">
                  <FileText className="h-4 w-4" />
                  <span className="font-semibold text-xs sm:text-sm">{t(`${NS}.tabInfo`, "تفاصيل المعاملة")}</span>
                </TabsTrigger>
                <TabsTrigger value="parties" className="gap-2 data-[state=active]:bg-blue-50 data-[state=active]:text-blue-900 data-[state=active]:shadow-sm">
                  <ArrowLeftRight className="h-4 w-4" />
                  <span className="font-semibold text-xs sm:text-sm">{t(`${NS}.tabParties`, "الأطراف والمبلغ")}</span>
                </TabsTrigger>
                <TabsTrigger value="accounts" className="gap-2 data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-900 data-[state=active]:shadow-sm">
                  <FolderTree className="h-4 w-4" />
                  <span className="font-semibold text-xs sm:text-sm">{t(`${NS}.tabAccounts`, "شجرة الحسابات")}</span>
                </TabsTrigger>
              </TabsList>

              {/* ── Tab 1: transaction details ───────────────── */}
              <TabsContent value="info" className="mt-4 space-y-3">
                <Card className="border-2">
                  <CardContent className="pt-5 pb-5 space-y-5">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">{t(`${NS}.code`, "كود المعاملة")}</Label>
                        <Input value={docLabel} readOnly disabled className="h-9 font-mono text-sm bg-muted/30" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">
                          {t(`${NS}.date`, "التاريخ")} <span className="text-destructive">*</span>
                        </Label>
                        <Input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} className="h-9 text-sm" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">{t(`${NS}.currency`, "العملة")}</Label>
                        <select
                          value={form.currencyId || (defaultCurrencyId ? String(defaultCurrencyId) : "")}
                          onChange={e => setForm(p => ({ ...p, currencyId: e.target.value }))}
                          data-testid="ft-currency"
                          className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background"
                        >
                          <option value="">{t(`${NS}.selectCurrency`, "اختر العملة")}</option>
                          {(currencies as any[]).map((c: any) => (
                            <option key={c.id} value={c.id}>
                              {c.code} — {isRtl ? c.nameAr : (c.nameEn || c.nameAr)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium flex items-center justify-between gap-2">
                          <span>{t(`${NS}.exchangeRate`, "سعر الصرف")}</span>
                          {(() => {
                            const sel = (currencies as any[]).find((c: any) => String(c.id) === String(form.currencyId));
                            const base = (currencies as any[]).find((c: any) => c.isDefault) ?? (currencies as any[])[0];
                            if (!sel || !base || sel.id === base.id) return null;
                            const r = Number(form.exchangeRate);
                            return (
                              <span className="text-[10px] text-muted-foreground font-normal" dir="ltr">
                                1 {sel.code} = {r > 0 ? r.toFixed(4) : "—"} {base.code}
                              </span>
                            );
                          })()}
                        </Label>
                        <Input type="number" step="0.000001" value={form.exchangeRate} onChange={e => setForm(p => ({ ...p, exchangeRate: e.target.value }))} placeholder="1" dir="ltr" className="h-9 text-sm text-left font-mono" />
                        {(() => {
                          const sel = (currencies as any[]).find((c: any) => String(c.id) === String(form.currencyId));
                          const base = (currencies as any[]).find((c: any) => c.isDefault) ?? (currencies as any[])[0];
                          const amt = Number(form.amount || 0);
                          const r = Number(form.exchangeRate);
                          if (!sel || !base || sel.id === base.id || !(amt > 0) || !(r > 0)) return null;
                          return (
                            <p className="text-[11px] text-muted-foreground" data-testid="ft-equiv">
                              {t(`${NS}.equivalentIn`, "المكافئ بـ")} {base.code}: <span className="font-mono">{(amt * r).toFixed(2)}</span>
                            </p>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Transaction kind — 3 big visual cards */}
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">{t(`${NS}.kindLabel`, "نوع المعاملة")} <span className="text-destructive">*</span></Label>
                      <div className="grid grid-cols-3 gap-2">
                        {(Object.keys(txKindMeta) as TxKind[]).map(k => {
                          const meta = txKindMeta[k];
                          const Icon = meta.icon;
                          const active = form.kind === k;
                          return (
                            <button
                              key={k}
                              type="button"
                              onClick={() => changeKind(k)}
                              className={cn(
                                "rounded-lg border-2 p-3 text-center transition flex flex-col items-center gap-1.5",
                                active
                                  ? `${meta.activeBg} ${meta.activeText} border-current shadow-sm`
                                  : `bg-background border-border ${meta.bg} text-muted-foreground`,
                              )}
                            >
                              <Icon className={cn("h-5 w-5", active ? "" : meta.color)} />
                              <span className="text-xs font-semibold">{meta.label}</span>
                              <span className="text-[10px] leading-tight opacity-70">
                                {k === "deposit"  && t(`${NS}.depositHint`,  "نقدي → بنك")}
                                {k === "withdraw" && t(`${NS}.withdrawHint`, "بنك → نقدي")}
                                {k === "transfer" && t(`${NS}.transferHint`, "بين حسابين")}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Transfer sub-type picker — only visible for "transfer" */}
                    {form.kind === "transfer" && (
                      <div className="space-y-2">
                        <Label className="text-xs font-medium">{t(`${NS}.transferSubLabel`, "نوع التحويل")}</Label>
                        <div className="inline-flex rounded-lg border bg-muted/20 p-0.5">
                          <button type="button"
                            onClick={() => changeSub("bank_to_bank")}
                            className={cn(
                              "px-4 h-8 rounded-md text-xs font-medium flex items-center gap-1.5 transition",
                              form.transferSub === "bank_to_bank" ? "bg-blue-100 text-blue-800 shadow-sm" : "text-muted-foreground hover:text-foreground",
                            )}>
                            <Landmark className="h-3.5 w-3.5" /> {t(`${NS}.bankToBank`, "بين بنكين")}
                          </button>
                          <button type="button"
                            onClick={() => changeSub("cash_to_cash")}
                            className={cn(
                              "px-4 h-8 rounded-md text-xs font-medium flex items-center gap-1.5 transition",
                              form.transferSub === "cash_to_cash" ? "bg-amber-100 text-amber-800 shadow-sm" : "text-muted-foreground hover:text-foreground",
                            )}>
                            <Wallet className="h-3.5 w-3.5" /> {t(`${NS}.cashToCash`, "بين خزنتين")}
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">{t(`${NS}.description`, "البيان")}</Label>
                      <Input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder={t(`${NS}.descriptionPh`, "وصف مختصر للمعاملة...")} className="h-9 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">{t("cashCommon.notes")}</Label>
                      <Textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder={t("cashCommon.notesPlaceholder")} className="text-sm resize-none" rows={2} />
                    </div>
                  </CardContent>
                </Card>
                <div className="flex justify-end pt-1">
                  <Button type="button" onClick={() => setTab("parties")} className="gap-1.5 bg-blue-600 hover:bg-blue-700">
                    {t(`${NS}.nextStep`, "التالي: الأطراف والمبلغ")}
                    {isRtl ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </Button>
                </div>
              </TabsContent>

              {/* ── Tab 2: parties (from/to) + amount ────────── */}
              <TabsContent value="parties" className="mt-4 space-y-3">
                <Card className="border-2">
                  <CardContent className="pt-5 pb-5 space-y-5">
                    {/* Visual flow: From → To */}
                    <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-3 items-stretch">
                      {/* FROM side */}
                      <div className="rounded-lg border-2 border-rose-200 bg-rose-50/40 p-3 space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-800">
                          {fromIsCash ? <Wallet className="h-3.5 w-3.5" /> : <Landmark className="h-3.5 w-3.5" />}
                          {t(`${NS}.from`, "من")} ({fromIsCash ? t(`${NS}.cash`, "نقدي") : t(`${NS}.bank`, "بنكي")}) <span className="text-destructive">*</span>
                        </div>
                        {fromIsCash ? (
                          <SearchCombobox
                            items={cashBoxItems}
                            value={form.fromCashBoxId}
                            onValueChange={v => setForm(p => ({ ...p, fromCashBoxId: v }))}
                            placeholder={t(`${NS}.selectCashBox`, "اختر خزنة")}
                            searchPlaceholder={t(`${NS}.searchCashBox`, "ابحث عن خزنة...")}
                            emptyText={t(`${NS}.noResults`, "لا توجد نتائج")}
                          />
                        ) : (
                          <SearchCombobox
                            items={bankItems}
                            value={form.fromBankId}
                            onValueChange={v => setForm(p => ({ ...p, fromBankId: v }))}
                            placeholder={t(`${NS}.selectBank`, "اختر حساب بنكي")}
                            searchPlaceholder={t(`${NS}.searchBank`, "ابحث عن حساب بنكي...")}
                            emptyText={t(`${NS}.noResults`, "لا توجد نتائج")}
                          />
                        )}
                      </div>

                      {/* Arrow in the middle (RTL-aware) */}
                      <div className="flex items-center justify-center text-muted-foreground">
                        {isRtl ? <ArrowRight className="h-7 w-7 rotate-180 text-violet-600" /> : <ArrowRight className="h-7 w-7 text-violet-600" />}
                      </div>

                      {/* TO side */}
                      <div className="rounded-lg border-2 border-green-200 bg-green-50/40 p-3 space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-green-800">
                          {toIsCash ? <Wallet className="h-3.5 w-3.5" /> : <Landmark className="h-3.5 w-3.5" />}
                          {t(`${NS}.to`, "إلى")} ({toIsCash ? t(`${NS}.cash`, "نقدي") : t(`${NS}.bank`, "بنكي")}) <span className="text-destructive">*</span>
                        </div>
                        {toIsCash ? (
                          <SearchCombobox
                            items={cashBoxItems}
                            value={form.toCashBoxId}
                            onValueChange={v => setForm(p => ({ ...p, toCashBoxId: v }))}
                            placeholder={t(`${NS}.selectCashBox`, "اختر خزنة")}
                            searchPlaceholder={t(`${NS}.searchCashBox`, "ابحث عن خزنة...")}
                            emptyText={t(`${NS}.noResults`, "لا توجد نتائج")}
                          />
                        ) : (
                          <SearchCombobox
                            items={bankItems}
                            value={form.toBankId}
                            onValueChange={v => setForm(p => ({ ...p, toBankId: v }))}
                            placeholder={t(`${NS}.selectBank`, "اختر حساب بنكي")}
                            searchPlaceholder={t(`${NS}.searchBank`, "ابحث عن حساب بنكي...")}
                            emptyText={t(`${NS}.noResults`, "لا توجد نتائج")}
                          />
                        )}
                      </div>
                    </div>

                    {/* Big amount input */}
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">
                        {t(`${NS}.amount`, "المبلغ")} <span className="text-destructive">*</span>
                      </Label>
                      <div className="relative">
                        <Banknote className={cn("h-5 w-5 absolute top-1/2 -translate-y-1/2 text-violet-600 pointer-events-none", isRtl ? "right-3" : "left-3")} />
                        <Input
                          type="number" step="0.01" placeholder="0.00"
                          value={form.amount}
                          onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                          dir="ltr"
                          className={cn("h-12 text-xl font-mono font-bold text-left", isRtl ? "pr-11" : "pl-11")}
                        />
                      </div>
                    </div>

                    <div className="rounded-md bg-muted/20 border p-2.5 text-[11px] text-muted-foreground leading-relaxed">
                      <BookMarked className="h-3.5 w-3.5 inline align-middle mb-0.5 me-1" />
                      {t(`${NS}.tipUseAccountsTab`, "تقدر تختار الحساب من شجرة الحسابات في التبويب الثالث — يتم نسخ الخزنة/البنك المرتبط تلقائياً.")}
                    </div>
                  </CardContent>
                </Card>
                <div className="flex justify-between items-center pt-1">
                  <Button type="button" variant="ghost" onClick={() => setTab("info")} className="gap-1.5">
                    {isRtl ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                    {t(`${NS}.prevStep`, "السابق: تفاصيل المعاملة")}
                  </Button>
                  <Button type="button" onClick={() => setTab("accounts")} variant="outline" className="gap-1.5 border-emerald-300 text-emerald-700 hover:bg-emerald-50">
                    <FolderTree className="h-4 w-4" />
                    {t(`${NS}.openAccountsTab`, "تصفّح شجرة الحسابات")}
                    {isRtl ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </Button>
                </div>
              </TabsContent>

              {/* ── Tab 3: chart of accounts (selectable tree) ─ */}
              <TabsContent value="accounts" className="mt-4 space-y-3">
                <Card className="border-2 border-emerald-200">
                  <CardContent className="pt-4 pb-4 space-y-3">
                    {/* Helper banner */}
                    <div className="rounded-md bg-emerald-50 border border-emerald-200 p-2.5 text-[11px] text-emerald-900 leading-relaxed">
                      {t(`${NS}.treeHint`, "تصفّح شجرة الحسابات العامة. اضغط على حساب مرتبط بخزنة أو بنك ليتم اختياره تلقائياً في الخانة الفارغة (مصدر/وجهة).")}
                    </div>

                    {/* Search + type filter */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="relative flex-1 min-w-[180px]">
                        <Search className={cn("absolute top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none", isRtl ? "right-2.5" : "left-2.5")} />
                        <Input
                          value={acctSearch}
                          onChange={e => setAcctSearch(e.target.value)}
                          placeholder={t(`${NS}.searchAccount`, "ابحث برقم أو اسم الحساب...")}
                          className={cn("h-9 text-sm", isRtl ? "pr-8" : "pl-8")}
                        />
                      </div>
                      <div className="flex items-center gap-1 flex-wrap">
                        <button type="button" onClick={() => setAcctTypeFilter("")} className={cn(
                          "px-2.5 h-7 rounded-full border text-[11px] font-medium transition",
                          acctTypeFilter === "" ? "bg-foreground text-background border-foreground" : "bg-background hover:bg-muted",
                        )}>
                          {t(`${NS}.allTypes`, "الكل")}
                        </button>
                        {accountTypes.map(at => (
                          <button key={at} type="button" onClick={() => setAcctTypeFilter(at)} className={cn(
                            "px-2.5 h-7 rounded-full border text-[11px] font-medium transition",
                            acctTypeFilter === at ? typeColors[at] + " border-current" : "bg-background hover:bg-muted",
                          )}>
                            {t(`accountTypes.${at}`, at)}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Tree (flat list w/ indentation by level) */}
                    <div className="border rounded-lg overflow-hidden bg-card">
                      <div className="max-h-[60vh] overflow-y-auto divide-y">
                        {filteredAccounts.length === 0 ? (
                          <div className="py-10 text-center text-sm text-muted-foreground">
                            <FolderTree className="h-8 w-8 mx-auto mb-2 opacity-30" />
                            {t(`${NS}.noAccounts`, "لا توجد حسابات مطابقة")}
                          </div>
                        ) : filteredAccounts.map((a: any) => {
                          const cb = cashBoxByAccountId.get(a.id);
                          const ba = bankByAccountId.get(a.id);
                          const linked = cb || ba;
                          const isParent = !a.isPosting;
                          const indent = Math.min((a.level ?? 0), 6) * 16;
                          return (
                            <div
                              key={a.id}
                              onClick={() => pickFromAccountTree(a)}
                              className={cn(
                                "flex items-center gap-2 px-3 py-2 text-sm transition cursor-pointer",
                                linked ? "hover:bg-emerald-50" : "hover:bg-muted/40",
                                isParent && "bg-muted/10",
                              )}
                              style={{ paddingInlineStart: 12 + indent }}
                              title={linked ? t(`${NS}.clickToPick`, "اضغط للاختيار") : t(`${NS}.clickToCopyCode`, "اضغط لنسخ الكود")}
                            >
                              {isParent
                                ? <FolderOpen className="h-4 w-4 text-amber-600 shrink-0" />
                                : <Folder className="h-4 w-4 text-muted-foreground shrink-0" />}
                              <span className="font-mono text-xs text-muted-foreground shrink-0">{a.code}</span>
                              <span className={cn("flex-1 truncate", isParent && "font-semibold")}>{isRtl ? a.nameAr : (a.nameEn || a.nameAr)}</span>
                              <span className={cn("text-[10px] px-1.5 py-0.5 rounded border shrink-0", typeColors[a.accountType] ?? "bg-muted text-muted-foreground")}>
                                {String(t(`accountTypes.${a.accountType}`, a.accountType))}
                              </span>
                              {cb && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200 shrink-0 inline-flex items-center gap-0.5">
                                  <Wallet className="h-2.5 w-2.5" /> {t(`${NS}.linkedCash`, "خزنة")}
                                </span>
                              )}
                              {ba && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 border border-blue-200 shrink-0 inline-flex items-center gap-0.5">
                                  <Landmark className="h-2.5 w-2.5" /> {t(`${NS}.linkedBank`, "بنك")}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <div className="flex justify-start pt-1">
                  <Button type="button" variant="ghost" onClick={() => setTab("parties")} className="gap-1.5">
                    {isRtl ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                    {t(`${NS}.backToParties`, "عودة للأطراف والمبلغ")}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </div>

          {/* ── Right column: live JE preview + tips ──────────── */}
          <aside className="lg:sticky lg:top-4 space-y-4">
            <Card className="border-2 border-violet-200 bg-violet-50/40">
              <CardContent className="pt-4 pb-4">
                <p className="text-xs font-semibold text-violet-900 mb-2 flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5" />
                  {t(`${NS}.jePreview`, "معاينة القيد")}
                </p>
                {!preview ? (
                  <p className="text-xs text-muted-foreground text-center py-6">
                    {t(`${NS}.previewEmpty`, "أدخل المبلغ والأطراف لمعاينة القيد")}
                  </p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-violet-800/70 border-b border-violet-200/60">
                        <th className="text-start pb-1.5 font-medium">{t(`${NS}.jeCol`, "الحساب")}</th>
                        <th className={cn("pb-1.5 font-medium", isRtl ? "text-left" : "text-right")}>{t(`${NS}.jeDr`, "مدين")}</th>
                        <th className={cn("pb-1.5 font-medium", isRtl ? "text-left" : "text-right")}>{t(`${NS}.jeCr`, "دائن")}</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      <tr className="border-b border-violet-200/40">
                        <td className="py-1.5 text-start text-[11px]">{preview.drLabel}</td>
                        <td className={cn("text-green-700 font-semibold", isRtl ? "text-left" : "text-right")}>{fmt(preview.amount)}</td>
                        <td className={cn("text-muted-foreground", isRtl ? "text-left" : "text-right")}>—</td>
                      </tr>
                      <tr>
                        <td className="py-1.5 text-start text-[11px]">{preview.crLabel}</td>
                        <td className={cn("text-muted-foreground", isRtl ? "text-left" : "text-right")}>—</td>
                        <td className={cn("text-rose-700 font-semibold", isRtl ? "text-left" : "text-right")}>{fmt(preview.amount)}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            <div className="text-[11px] text-muted-foreground leading-relaxed bg-muted/20 border rounded-lg p-3">
              <p className="font-semibold mb-1">{t(`${NS}.tipsTitle`, "اختصارات سريعة")}</p>
              <ul className="space-y-0.5 list-disc list-inside">
                <li>{t(`${NS}.tip_kind`, "اختر نوع المعاملة من البطاقات الكبيرة")}</li>
                <li>{t(`${NS}.tip_search`, "اكتب في القوائم للبحث الفوري")}</li>
                <li>{t(`${NS}.tip_tree`, "تبويب «شجرة الحسابات» لاختيار سريع")}</li>
              </ul>
            </div>
          </aside>
        </div>
      </fieldset>

      {/* ─── Sticky bottom action bar ────────────────────────── */}
      {!isLocked && (
        <div className="fixed bottom-0 inset-x-0 bg-background/95 backdrop-blur border-t z-40">
          <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => navigate("/cash/financial-transactions")} disabled={saveMut.isPending}>
              {t("cashCommon.cancel")}
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => save("draft")} disabled={saveMut.isPending} className="gap-1.5">
                {pendingMode === "draft" && saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {t(`${NS}.saveDraft`, "حفظ كمسودة")}
              </Button>
              {autoPostingEnabled && (
                <Button onClick={() => save("post")} disabled={saveMut.isPending} className="gap-1.5 bg-violet-600 hover:bg-violet-700">
                  {pendingMode === "post" && saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {t(`${NS}.saveAndPost`, "حفظ وترحيل")}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
