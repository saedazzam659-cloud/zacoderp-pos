import { useState, useEffect, useRef, useMemo } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import { parseError } from "@/lib/parseError";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { JournalScanArchive } from "@/components/JournalScanArchive";
import { Switch } from "@/components/ui/switch";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import { AccountCascadePicker } from "@/components/ui/account-cascade-picker";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ArrowUpCircle, ArrowRight, ChevronLeft, Search,
  Loader2, Save, Send, Lock, FileText, Banknote,
  Wallet, Building2, Truck, Layers, Printer, Link2, X, Settings2,
  Trash2, Plus,
} from "lucide-react";
import { DateField } from "@/components/ui/date-field";
import {
  SupplierTaxDetailsMenu,
  type SupplierTaxDetails,
  hasSupplierTaxDetails,
} from "@/components/SupplierTaxDetailsDialog";
import { printCashVoucher } from "@/lib/cashVoucherPrint";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

// A single allocation line (multi-line model). Numeric fields are kept as
// strings for controlled inputs; the backend parses both strings & numbers.
interface PvLine {
  key: string;               // local React key only (never sent)
  accountId: string;         // DR GL account (required)
  description: string;
  amount: string;            // NET (pre-VAT)
  taxRate: string;           // percent, e.g. "15"
  taxAmount: string;         // VAT value (auto, user-editable)
  taxAccountId: string;      // optional input-VAT GL account override
  costCenter: string;        // inherits header default on add
  purchaseInvoiceId: string; // optional link to a purchase invoice
  // Per-line supplier tax metadata (entered via the ⋮ dialog). Used when no
  // header supplier is chosen so a consolidated voucher can attribute each tax
  // line to its own supplier. Flows into the VAT report + tax account statement.
  supplierName: string;
  supplierVatNumber: string;
  supplierInvoiceNumber: string;
  supplierInvoiceDate: string;
}

let _pvLineSeq = 0;
function newPvLine(init: Partial<PvLine> = {}): PvLine {
  return {
    key: `pvl_${Date.now()}_${_pvLineSeq++}`,
    accountId: "",
    description: "",
    amount: "",
    taxRate: "",
    taxAmount: "",
    taxAccountId: "",
    costCenter: "",
    purchaseInvoiceId: "",
    supplierName: "",
    supplierVatNumber: "",
    supplierInvoiceNumber: "",
    supplierInvoiceDate: "",
    ...init,
  };
}

interface FormState {
  date: string;
  paymentType: "cash" | "bank";
  branchId: string;
  cashBoxId: string;
  bankAccountId: string;
  entityId: string;          // supplier id (optional party context)
  entityName: string;        // cached name for JE preview
  currencyId: string;
  exchangeRate: string;
  refType: string;
  refNumber: string;
  description: string;
  notes: string;
  costCenter: string;        // header default inherited by new lines
  lines: PvLine[];           // multi-allocation grid
}

const EMPTY: FormState = {
  date: today(),
  paymentType: "cash",
  branchId: "",
  cashBoxId: "",
  bankAccountId: "",
  entityId: "",
  entityName: "",
  currencyId: "",
  exchangeRate: "1",
  refType: "",
  refNumber: "",
  description: "",
  notes: "",
  costCenter: "",
  lines: [],
};

// ── Branch matching for treasuries ───────────────────────────────
// A cash box belongs to the selected branch when its branchId matches, OR
// when it has NO branch (NULL = company-wide / shared, visible everywhere).
function boxMatchesBranch(c: any, bid: string): boolean {
  if (!bid) return true;
  if (c.branchId == null) return true;
  return String(c.branchId) === String(bid);
}
// A bank account may be linked via the legacy single branchId OR the
// multi-branch branchIds[] array (source of truth). No link at all = shared.
function bankMatchesBranch(b: any, bid: string): boolean {
  if (!bid) return true;
  const ids: any[] = Array.isArray(b.branchIds) ? b.branchIds : [];
  const shared = b.branchId == null && ids.length === 0;
  if (shared) return true;
  if (b.branchId != null && String(b.branchId) === String(bid)) return true;
  return ids.map(String).includes(String(bid));
}

export default function PaymentVoucherForm() {
  const { user, token } = useAuth();
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const [matchNew] = useRoute("/cash/payment-vouchers/new");
  const [matchEdit, params] = useRoute("/cash/payment-vouchers/:id");
  const isNew  = !!matchNew;
  // Wouter matches "/new" against ":id" too — guard against opening the
  // create-mode URL in edit mode.
  const rawId  = matchEdit && !isNew ? (params as any).id : null;
  const editId = rawId && /^\d+$/.test(String(rawId)) ? Number(rawId) : null;
  // "Duplicate" support: `/new?from=123` loads voucher #123 and copies it
  // into a brand-new draft (POST on save, fresh sequence number).
  const fromId = useMemo(() => {
    if (!isNew) return null;
    const q = new URLSearchParams(window.location.search).get("from");
    return q && /^\d+$/.test(q) ? Number(q) : null;
  }, [isNew]);
  const sourceId = editId ?? fromId;

  const NS = "paymentVouchers";
  const cid = user?.companyId;
  const h = { Authorization: `Bearer ${token}` };

  const [form, setForm] = useState<FormState>(() => ({ ...EMPTY, lines: [newPvLine()] }));

  // ── Sequence preview for new vouchers ───────────────────────────
  const seqPeek = useNextSequenceNumber("payment_voucher", isNew, undefined, undefined, form.paymentType);

  // ── Data fetches ─────────────────────────────────────────────────
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
  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", cid],
    queryFn: () => fetch(`${API}/api/org/branches?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
    staleTime: 60_000,
  });
  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers", cid],
    queryFn: () => fetch(`${API}/api/suppliers?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  // Chart of accounts — feeds the general-account cascade picker.
  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: () => fetch(`${API}/api/accounts?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
    staleTime: 60_000,
  });
  const { data: currencies = [] } = useQuery<any[]>({
    queryKey: ["currencies", cid],
    queryFn: () => fetch(`${API}/api/currencies?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
    staleTime: 60_000,
  });
  // Cost-centers list — used to populate the header-level "مركز التكلفة"
  // select. Selected code propagates to every JE line on /post.
  const { data: costCentersList = [] } = useQuery<any[]>({
    queryKey: ["cost-centers", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/cost-centers?companyId=${cid}`, { headers: h });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!cid,
    staleTime: 60_000,
  });
  const defaultCurrencyId =
    (currencies as any[]).find((c: any) => c.isDefault)?.id ??
    (currencies as any[])[0]?.id ?? null;
  // Sync the default currency into form state on new vouchers so that
  // what the user sees pre-selected is actually what gets saved.
  useEffect(() => {
    if (isNew && !form.currencyId && defaultCurrencyId) {
      setForm(p => ({ ...p, currencyId: String(defaultCurrencyId) }));
    }
  }, [isNew, form.currencyId, defaultCurrencyId]);
  // Auto-pick the main/first branch on new vouchers so the mandatory
  // branch field is pre-filled with a sensible default.
  const defaultBranchId =
    (branches as any[]).find((b: any) => b.isMain)?.id ??
    (branches as any[])[0]?.id ?? null;
  useEffect(() => {
    if (isNew && !form.branchId && defaultBranchId) {
      setForm(p => ({ ...p, branchId: String(defaultBranchId) }));
    }
  }, [isNew, form.branchId, defaultBranchId]);
  // When the user changes the branch, drop any selected cash box / bank
  // that is not linked to the new branch (shared NULL-branch ones are kept).
  const prevBranchRef = useRef<string>("");
  useEffect(() => {
    const bid = form.branchId;
    const prev = prevBranchRef.current;
    prevBranchRef.current = bid;
    if (!prev || prev === bid) return;
    setForm(p => {
      let next = p;
      if (p.cashBoxId) {
        const c = (cashBoxes as any[]).find((x: any) => String(x.id) === p.cashBoxId);
        if (c && !boxMatchesBranch(c, bid)) next = { ...next, cashBoxId: "" };
      }
      if (p.bankAccountId) {
        const b = (bankAccounts as any[]).find((x: any) => String(x.id) === p.bankAccountId);
        if (b && !bankMatchesBranch(b, bid)) next = { ...next, bankAccountId: "" };
      }
      return next;
    });
  }, [form.branchId, cashBoxes, bankAccounts]);
  // Purchase invoices for the optional link picker. We pull the full list
  // for this tenant once and filter client-side per selected supplier —
  // simpler than maintaining a per-supplier endpoint and the data is
  // small (already used elsewhere in the UI).
  const { data: purchaseInvoices = [] } = useQuery<any[]>({
    queryKey: ["purchase-invoices", cid],
    queryFn: () => fetch(`${API}/api/purchasing/purchase-invoices?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
    staleTime: 30_000,
  });

  // ── Voucher list (used both for prev/next nav and for edit-mode load) ─
  const { data: vouchers = [] } = useQuery<any[]>({
    queryKey: ["payment-vouchers", cid],
    queryFn: () => fetch(`${API}/api/payment-vouchers?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
    staleTime: 30_000,
  });

  // ── Edit-mode (or duplicate-from): load the single voucher ────
  const { data: existing, isLoading: loadingEdit } = useQuery<any>({
    queryKey: ["payment-voucher", sourceId],
    queryFn: () => fetch(`${API}/api/payment-vouchers/${sourceId}`, { headers: h }).then(r => r.json()),
    enabled: !!sourceId,
  });

  useEffect(() => {
    if (!existing) return;
    // Hydrate the allocation grid: prefer the persisted `lines` array; fall
    // back to synthesizing ONE line from the legacy single-amount header so
    // pre-migration vouchers stay editable and re-saveable as lines.
    const rawLines: any[] = Array.isArray(existing.lines) ? existing.lines : [];
    let lines: PvLine[];
    if (rawLines.length > 0) {
      lines = rawLines.map((l: any) => newPvLine({
        accountId: l.accountId != null ? String(l.accountId) : "",
        description: l.description ?? "",
        amount: l.amount != null ? String(l.amount) : "",
        taxRate: l.taxRate != null ? String(l.taxRate) : "",
        taxAmount: l.taxAmount != null ? String(l.taxAmount) : "",
        taxAccountId: l.taxAccountId != null ? String(l.taxAccountId) : "",
        costCenter: l.costCenter ?? "",
        purchaseInvoiceId: l.purchaseInvoiceId != null ? String(l.purchaseInvoiceId) : "",
        supplierName: l.supplierName ?? "",
        supplierVatNumber: l.supplierVatNumber ?? "",
        supplierInvoiceNumber: l.supplierInvoiceNumber ?? "",
        supplierInvoiceDate: l.supplierInvoiceDate ?? "",
      }));
    } else {
      lines = [newPvLine({
        accountId: existing.accountId != null ? String(existing.accountId) : "",
        description: existing.description ?? "",
        amount: existing.amount != null ? String(existing.amount) : "",
        taxRate: existing.taxRate != null ? String(existing.taxRate) : "",
        taxAmount: (existing.vatAmount ?? existing.taxAmount) != null
          ? String(existing.vatAmount ?? existing.taxAmount) : "",
        taxAccountId: "",
        costCenter: existing.costCenter ?? "",
        purchaseInvoiceId: existing.purchaseInvoiceId != null ? String(existing.purchaseInvoiceId) : "",
      })];
    }
    setForm({
      date: existing.date ?? today(),
      paymentType: (existing.paymentType ?? "cash") as "cash" | "bank",
      branchId: existing.branchId ? String(existing.branchId) : "",
      cashBoxId: existing.cashBoxId ? String(existing.cashBoxId) : "",
      bankAccountId: existing.bankAccountId ? String(existing.bankAccountId) : "",
      entityId: existing.entityId ? String(existing.entityId) : "",
      entityName: existing.entityName ?? "",
      currencyId: existing.currencyId ? String(existing.currencyId) : "",
      exchangeRate: existing.exchangeRate ?? "1",
      refType: existing.refType ?? "",
      refNumber: existing.refNumber ?? "",
      description: existing.description ?? "",
      notes: existing.notes ?? "",
      costCenter: existing.costCenter ?? "",
      lines,
    });
  }, [existing]);

  // ── Default input-VAT account (optional per-line override prefill) ──
  // If a chart account with code "11071" exists we offer it as the default
  // tax account for new lines; otherwise we leave it empty and let the
  // backend resolve the company vat_input mapping.
  const defaultTaxAccountId = useMemo(() => {
    const a = (accounts as any[]).find((x: any) => String(x.code) === "11071");
    return a ? String(a.id) : "";
  }, [accounts]);

  // ── Allocation-line helpers ────────────────────────────────────
  function addLine() {
    setForm(p => {
      // Inherit supplier tax metadata from the last line so a consolidated
      // (multi-tax) voucher for the same supplier never re-types the details.
      const prev = p.lines[p.lines.length - 1];
      const inherit = prev && hasSupplierTaxDetails(prev)
        ? {
            supplierName: prev.supplierName,
            supplierVatNumber: prev.supplierVatNumber,
            supplierInvoiceNumber: prev.supplierInvoiceNumber,
            supplierInvoiceDate: prev.supplierInvoiceDate,
          }
        : {};
      return {
        ...p,
        lines: [...p.lines, newPvLine({ taxAccountId: defaultTaxAccountId, costCenter: p.costCenter, ...inherit })],
      };
    });
  }
  function removeLine(key: string) {
    setForm(p => {
      const rest = p.lines.filter(l => l.key !== key);
      return {
        ...p,
        lines: rest.length ? rest : [newPvLine({ taxAccountId: defaultTaxAccountId, costCenter: p.costCenter })],
      };
    });
  }
  function updateLine(key: string, patch: Partial<PvLine>) {
    setForm(p => ({
      ...p,
      lines: p.lines.map(l => {
        if (l.key !== key) return l;
        const next = { ...l, ...patch };
        // Auto-recompute VAT when the net amount or rate changes; the field
        // stays editable so users can override the computed value afterwards.
        if ("amount" in patch || "taxRate" in patch) {
          const amt = Number(next.amount) || 0;
          const rate = Number(next.taxRate) || 0;
          next.taxAmount = amt > 0 && rate > 0
            ? (Math.round(amt * rate) / 100).toFixed(2)
            : "0.00";
          // Auto-pick the default input-VAT account the moment a rate is
          // entered so the user isn't forced to choose it manually. Stays
          // overridable, and we never clobber an existing choice.
          if (rate > 0 && !next.taxAccountId && defaultTaxAccountId) {
            next.taxAccountId = defaultTaxAccountId;
          }
        }
        return next;
      }),
    }));
  }

  // ── Document navigation (prev/next/jump-by-search) ─────────────
  const navList = vouchers as any[];
  const currentIndex = editId != null
    ? navList.findIndex(v => Number(v.id) === Number(editId))
    : -1;
  const prevVoucher = currentIndex >= 0 && currentIndex < navList.length - 1
    ? navList[currentIndex + 1] : null;
  const nextVoucher = currentIndex > 0 ? navList[currentIndex - 1] : null;

  const [navSearch, setNavSearch] = useState("");
  function jumpFromSearch() {
    const q = navSearch.trim().toLowerCase();
    if (!q) return;
    const hit =
      navList.find(v => String(v.code ?? "").toLowerCase() === q) ||
      navList.find(v => String(v.code ?? "").toLowerCase().includes(q)) ||
      navList.find(v => String(v.description ?? "").toLowerCase().includes(q)) ||
      navList.find(v => String(v.entityName ?? "").toLowerCase().includes(q));
    if (!hit) {
      toast({ title: t(`${NS}.searchNotFound`, "لم يتم العثور على سند مطابق"), variant: "destructive" });
      return;
    }
    setNavSearch("");
    navigate(`/cash/payment-vouchers/${hit.id}`);
  }

  // ── Build searchable combobox items ────────────────────────────
  const cashBoxItems: ComboboxItem[] = useMemo(() =>
    (cashBoxes as any[]).filter(c => boxMatchesBranch(c, form.branchId)).map(c => ({
      value: String(c.id),
      label: isRtl ? c.nameAr : (c.nameEn || c.nameAr),
    })), [cashBoxes, isRtl, form.branchId]);

  const bankAccountItems: ComboboxItem[] = useMemo(() =>
    (bankAccounts as any[]).filter(b => bankMatchesBranch(b, form.branchId)).map(b => ({
      value: String(b.id),
      label: isRtl ? b.nameAr : (b.nameEn || b.nameAr),
      description: b.accountNumber ?? b.iban ?? undefined,
    })), [bankAccounts, isRtl, form.branchId]);

  const supplierItems: ComboboxItem[] = useMemo(() =>
    (suppliers as any[]).map(s => ({
      value: String(s.id),
      label: isRtl ? s.nameAr : (s.nameEn || s.nameAr),
      code: s.code ?? undefined,
      description: s.phone ?? s.email ?? undefined,
    })), [suppliers, isRtl]);

  // Purchase invoices the picked supplier still has open / payable. We
  // include posted invoices (most common case — settle a credit invoice)
  // and exclude cancelled ones; if the form is editing an existing
  // voucher whose linked invoice was since cancelled, we still surface
  // it so the user can see the (stale) link.
  const invoiceItems: ComboboxItem[] = useMemo(() => {
    // Purchase-invoice linking works even without a chosen supplier: when no
    // supplier is selected we surface ALL non-cancelled invoices; once a
    // supplier is picked we narrow to that supplier's invoices only.
    const sid = form.entityId ? Number(form.entityId) : null;
    return (purchaseInvoices as any[])
      .filter((inv: any) => inv.status !== "cancelled" && (sid == null || Number(inv.supplierId) === sid))
      .map((inv: any) => ({
        value: String(inv.id),
        label: inv.docNumber ?? `PI-${inv.id}`,
        description: `${inv.invoiceDate} • ${Number(inv.totalAmount || 0).toFixed(2)} ${inv.currencyCode || "SAR"}`,
        code: inv.status,
      }));
  }, [purchaseInvoices, form.entityId]);

  // ── Account-name lookup (for JE preview line labels) ───────────
  const accountName = (id: string) => {
    const a = (accounts as any[]).find((x: any) => String(x.id) === String(id));
    return a ? ((isRtl ? (a.nameAr || a.nameEn) : (a.nameEn || a.nameAr)) || "") : "";
  };

  // ── Live totals derived from the allocation grid ───────────────
  const totals = useMemo(() => {
    let net = 0, tax = 0;
    for (const l of form.lines) {
      const a = Number(l.amount) || 0;
      const tx = Number(l.taxAmount) || 0;
      if (a > 0 || l.accountId) { net += a; tax += tx; }
    }
    return { net, tax, grand: net + tax };
  }, [form.lines]);

  // ── Live Journal-Entry preview (mirrors backend posting logic) ──
  function jePreview() {
    const valid = form.lines.filter(l => l.accountId && (Number(l.amount) || 0) > 0);
    if (valid.length === 0) return null;
    const cb = (cashBoxes as any[]).find((c: any) => String(c.id) === form.cashBoxId);
    const ba = (bankAccounts as any[]).find((b: any) => String(b.id) === form.bankAccountId);
    const cbName = cb ? (isRtl ? cb.nameAr : (cb.nameEn || cb.nameAr)) : "";
    const baName = ba ? (isRtl ? ba.nameAr : (ba.nameEn || ba.nameAr)) : "";
    const crLabel = form.paymentType === "bank"
      ? (ba ? t(`${NS}.bankPrefix`, { name: baName }) : t(`${NS}.noBankSelected`))
      : (cb ? t(`${NS}.cashPrefix`, { name: cbName }) : t(`${NS}.noCashSelected`));
    const drRows: { label: string; amount: number }[] = [];
    let total = 0;
    for (const l of valid) {
      const net = Number(l.amount) || 0;
      const tax = Number(l.taxAmount) || 0;
      total += net + tax;
      drRows.push({
        label: accountName(l.accountId) || t(`${NS}.noAccountSelected`, "— لم يتم اختيار الحساب —"),
        amount: net,
      });
      if (tax > 0) {
        const taxName = l.taxAccountId
          ? accountName(l.taxAccountId)
          : t(`${NS}.vatInputDefault`, "ضريبة القيمة المضافة (مدخلات)");
        drRows.push({ label: `${t(`${NS}.vatLabel`, "ضريبة مدخلات")} — ${taxName}`, amount: tax });
      }
    }
    return { drRows, crLabel, total };
  }

  // ── Save / Save-and-post mutation ──────────────────────────────
  const [pendingMode, setPendingMode] = useState<"draft" | "post" | null>(null);
  const isLockedSourceEntry = !isNew && existing?.status === "posted";

  const saveMut = useMutation({
    mutationFn: async (mode: "draft" | "post") => {
      if (!form.date) throw new Error(t(`${NS}.dateRequired`, "التاريخ مطلوب"));
      if (!form.branchId) throw new Error(t(`${NS}.branchRequired`, "الرجاء اختيار الفرع"));
      if (form.paymentType === "cash" && !form.cashBoxId)
        throw new Error(t(`${NS}.cashBoxRequired`, "الخزنة مطلوبة عند الدفع نقداً"));
      if (form.paymentType === "bank" && !form.bankAccountId)
        throw new Error(t(`${NS}.bankRequired`, "الحساب البنكي مطلوب عند الدفع بنكاً"));

      // Build allocation lines: drop fully-empty rows (no account AND zero
      // amount), then validate each remaining row needs an account + amount>0.
      const kept = form.lines.filter(l => l.accountId || (Number(l.amount) || 0) > 0);
      if (kept.length === 0)
        throw new Error(t(`${NS}.linesRequired`, "يجب إضافة بند واحد على الأقل"));
      for (const l of kept) {
        if (!l.accountId)
          throw new Error(t(`${NS}.lineAccountRequired`, "كل بند يجب أن يحتوي على حساب محاسبي"));
        if (!((Number(l.amount) || 0) > 0))
          throw new Error(t(`${NS}.lineAmountRequired`, "مبلغ البند يجب أن يكون أكبر من صفر"));
      }
      const linesPayload = kept.map(l => ({
        accountId:         l.accountId ? parseInt(l.accountId) : null,
        description:       l.description || null,
        amount:            String(Number(l.amount) || 0),
        taxRate:           String(Number(l.taxRate) || 0),
        taxAmount:         String(Number(l.taxAmount) || 0),
        taxAccountId:      l.taxAccountId ? parseInt(l.taxAccountId) : null,
        costCenter:        l.costCenter || null,
        branchId:          form.branchId ? parseInt(form.branchId) : null,
        purchaseInvoiceId: l.purchaseInvoiceId ? parseInt(l.purchaseInvoiceId) : null,
        supplierName:          l.supplierName?.trim() || null,
        supplierVatNumber:     l.supplierVatNumber?.trim() || null,
        supplierInvoiceNumber: l.supplierInvoiceNumber?.trim() || null,
        supplierInvoiceDate:   l.supplierInvoiceDate?.trim() || null,
      }));
      const grandTotal = kept.reduce(
        (s, l) => s + (Number(l.amount) || 0) + (Number(l.taxAmount) || 0), 0);

      const { lines: _drop, ...header } = form;
      const body = {
        ...header,
        lines: linesPayload,
        // Header amount kept for back-compat; server re-derives from lines.
        amount: grandTotal.toFixed(2),
        companyId: cid,
        // Server force-overrides to "supplier" but we send it for clarity.
        entityType: "supplier",
        branchId:     form.branchId     ? parseInt(form.branchId)     : null,
        cashBoxId:    form.cashBoxId    ? parseInt(form.cashBoxId)    : null,
        bankAccountId:form.bankAccountId? parseInt(form.bankAccountId): null,
        // Multi-line vouchers null the header account (lines carry accounts).
        accountId:    null,
        entityId:     form.entityId ? parseInt(form.entityId) : null,
        currencyId:   form.currencyId   ? parseInt(form.currencyId)   : null,
      };

      const url = isNew
        ? `${API}/api/payment-vouchers`
        : `${API}/api/payment-vouchers/${editId}`;
      const res = await fetch(url, {
        method: isNew ? "POST" : "PUT",
        headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved = await res.json();

      if (mode === "post" && saved?.id && (saved.status ?? "draft") === "draft") {
        const pr = await fetch(`${API}/api/payment-vouchers/${saved.id}/post`, { method: "POST", headers: h });
        const pj = await pr.json().catch(() => ({}));
        if (!pr.ok) {
          // Saved as draft, posting failed — surface the partial success
          // to the toast so the user knows the voucher already exists
          // and won't accidentally re-create it.
          return { ...saved, _posted: false, _postError: pj?.error || pr.statusText };
        }
        return { ...pj, _posted: true };
      }
      return { ...saved, _posted: false };
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["payment-vouchers"] });
      qc.invalidateQueries({ queryKey: ["payment-voucher", data.id] });
      // The purchase-invoices listing surfaces the linked payment, so
      // make sure it refetches after a save that touches a link.
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
      if (data?._postError) {
        toast({
          variant: "destructive",
          title: t(`${NS}.savedButPostFailed`, "تم الحفظ كمسودة — لكن فشل الترحيل"),
          description: data._postError,
        });
      } else {
        toast({
          title: data?._posted
            ? (isNew ? t(`${NS}.saved_create`) : t(`${NS}.saved_update`))
            : t(`${NS}.savedDraft`, "تم الحفظ بنجاح"),
        });
      }
      navigate("/cash/payment-vouchers");
    },
    onError: (e: any) => toast({ title: t(`${NS}.err_save`), description: parseError(e), variant: "destructive" }),
    onSettled: () => setPendingMode(null),
  });

  function save(mode: "draft" | "post") {
    if (isLockedSourceEntry) {
      toast({
        title: t(`${NS}.cantEditPosted`, "لا يمكن تعديل سند مرحَّل"),
        description: t(`${NS}.unpostFirst`, "افتح السند من القائمة وقم بفك ترحيله أولاً."),
        variant: "destructive",
      });
      return;
    }
    setPendingMode(mode);
    saveMut.mutate(mode);
  }

  // ── Form-wide Enter-key navigation ─────────────────────────────
  const formRef = useRef<HTMLDivElement>(null);

  function getNavList(): HTMLElement[] {
    const root = formRef.current;
    if (!root) return [];
    const SEL = [
      'input:not([type="hidden"]):not([disabled])',
      'textarea:not([disabled])',
      'button[role="combobox"]:not([disabled])',
      'select:not([disabled])',
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
      if (!saveMut.isPending && !isLockedSourceEntry) save("draft");
    }
    return true;
  }
  function handleFormKeyDownCapture(e: React.KeyboardEvent) {
    if (e.key !== "Enter") return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if ((e.nativeEvent as any).isComposing) return;
    const target = e.target as HTMLElement;
    if (!target || target.tagName !== "BUTTON") return;
    if (target.getAttribute("role") !== "combobox") return;
    e.preventDefault(); e.stopPropagation();
    advanceFromTarget(target);
  }
  function handleFormKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Enter") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.nativeEvent as any).isComposing) return;
    const target = e.target as HTMLElement;
    if (!target) return;
    if (target.tagName === "TEXTAREA" && e.shiftKey) return;
    e.preventDefault();
    advanceFromTarget(target);
  }

  // ── Print (single voucher, RAGM layout) ────────────────────────
  function openPrintWindow() {
    if (!existing) return;
    const cb = (cashBoxes as any[]).find((c: any) => String(c.id) === String(existing.cashBoxId));
    const ba = (bankAccounts as any[]).find((b: any) => String(b.id) === String(existing.bankAccountId));
    const treasury = existing.paymentType === "bank"
      ? (ba ? { code: ba.code, name: (isRtl ? ba.nameAr : (ba.nameEn || ba.nameAr)) } : null)
      : (cb ? { code: cb.code, name: (isRtl ? cb.nameAr : (cb.nameEn || cb.nameAr)) } : null);
    // Counterparty shown in the account row: supplier (party mode) or GL
    // account (general-account mode).
    const supp = existing.entityId
      ? (suppliers as any[]).find((s: any) => String(s.id) === String(existing.entityId))
      : null;
    const acct = existing.accountId
      ? (accounts as any[]).find((a: any) => String(a.id) === String(existing.accountId))
      : null;
    // Supplier's linked AP (ذمم الموردين) GL account → its code is what the
    // voucher row should display for the رمز الحساب field.
    const suppAcct = supp?.accountId
      ? (accounts as any[]).find((a: any) => String(a.id) === String(supp.accountId))
      : null;
    const account = {
      code: suppAcct?.code ?? supp?.code ?? acct?.code ?? "",
      name: existing.entityName
        || (supp ? (isRtl ? supp.nameAr : (supp.nameEn || supp.nameAr)) : "")
        || (acct ? (isRtl ? acct.nameAr : (acct.nameEn || acct.nameAr)) : ""),
    };
    const linkedInv = existing.purchaseInvoiceId
      ? (purchaseInvoices as any[]).find((x: any) => String(x.id) === String(existing.purchaseInvoiceId))
      : null;
    // Multi-allocation lines (each DR side) with per-line input VAT.
    const printLines = ((existing.lines as any[]) ?? []).map((l: any) => {
      const a = (accounts as any[]).find((x: any) => String(x.id) === String(l.accountId));
      return {
        code: a?.code ?? "",
        name: a ? (isRtl ? a.nameAr : (a.nameEn || a.nameAr)) : "—",
        description: l.description ?? "",
        amount: l.amount,
        tax: l.taxAmount,
      };
    });
    printCashVoucher({
      kind: "payment",
      doc: {
        code: existing.code,
        date: existing.date,
        amount: existing.amount,
        currency: existing.currency,
        description: existing.description,
        invoiceNumber: linkedInv?.docNumber ?? (existing.purchaseInvoiceId ? `PI-${existing.purchaseInvoiceId}` : null),
      },
      treasury,
      account,
      lines: printLines.length ? printLines : null,
      company: (user as any)?.company ?? null,
      preparedBy: user?.username ?? null,
      onError: (msg) =>
        toast({ title: "تم منع النوافذ المنبثقة", description: msg, variant: "destructive" }),
    });
  }

  // ── Loading state ──────────────────────────────────────────────
  if (!isNew && loadingEdit) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">جارٍ التحميل...</div>;
  }

  const preview = jePreview();
  const docLabel = existing?.code ?? (isNew && seqPeek.number ? seqPeek.number : (seqPeek.loading ? "..." : t(`${NS}.autoCode`)));
  // Per-doc-type auto-posting flag with global fallback. See
  // SalesDocumentForm for the full rationale on the legacy fallback.
  const _co = (user as any)?.company;
  const _gl = _co?.autoPostingEnabled !== false;
  const autoPostingEnabled = _co?.autoPostPayment === undefined || _co?.autoPostPayment === null
    ? _gl
    : _co.autoPostPayment !== false;

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div
      ref={formRef}
      onKeyDownCapture={handleFormKeyDownCapture}
      onKeyDown={handleFormKeyDown}
      className="p-6 space-y-5 max-w-6xl mx-auto pb-24"
      dir={isRtl ? "rtl" : "ltr"}
      data-testid="payment-voucher-form"
    >
      {/* ─── Header bar ────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/cash/payment-vouchers")} className="h-8 w-8" title={t(`${NS}.backToList`, "عودة للقائمة")}>
            <ArrowRight className={cn("h-4 w-4", !isRtl && "rotate-180")} />
          </Button>
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-100 text-red-700">
              <ArrowUpCircle className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold">{isNew ? t(`${NS}.newLong`) : t(`${NS}.editVoucher`)}</h1>
              <p className="text-xs text-muted-foreground">
                {isNew
                  ? t(`${NS}.subtitle`)
                  : t(`${NS}.editingCode`, { code: existing?.code ?? `#${editId}`, defaultValue: `تعديل السند ${existing?.code ?? `#${editId}`}` })}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <JournalScanArchive
            jeKey={existing?.code ?? (editId ? `PV-${editId}` : "PV-new-draft")}
            screenKey="payment_vouchers"
            companyName={user?.company?.nameAr ?? null}
          />
          {!isNew && navList.length > 0 && (
            <div className="flex items-center gap-1 rounded-md border bg-background px-1 py-0.5 print:hidden">
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs"
                disabled={!prevVoucher}
                onClick={() => prevVoucher && navigate(`/cash/payment-vouchers/${prevVoucher.id}`)}
                title={prevVoucher ? `${prevVoucher.code}` : ""}>
                <ChevronLeft className={cn("h-3.5 w-3.5", isRtl && "rotate-180")} />
                {t(`${NS}.prev`, "السابق")}
              </Button>
              <span className="text-[11px] tabular-nums px-1.5 text-muted-foreground select-none">
                {currentIndex >= 0 ? `${currentIndex + 1} / ${navList.length}` : navList.length}
              </span>
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs"
                disabled={!nextVoucher}
                onClick={() => nextVoucher && navigate(`/cash/payment-vouchers/${nextVoucher.id}`)}
                title={nextVoucher ? `${nextVoucher.code}` : ""}>
                {t(`${NS}.next`, "التالي")}
                <ChevronLeft className={cn("h-3.5 w-3.5", !isRtl && "rotate-180")} />
              </Button>
              <div className="relative">
                <Search className={cn("absolute top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground", isRtl ? "right-2" : "left-2")} />
                <Input
                  value={navSearch}
                  onChange={e => setNavSearch(e.target.value)}
                  onKeyDown={e => {
                    if (e.key !== "Enter") return;
                    if ((e.nativeEvent as any).isComposing) return;
                    e.preventDefault(); e.stopPropagation(); jumpFromSearch();
                  }}
                  placeholder={t(`${NS}.searchPh`, "ابحث برقم السند...")}
                  className={cn("h-7 text-xs w-48", isRtl ? "pe-7 ps-2" : "ps-7 pe-2")}
                />
              </div>
            </div>
          )}

          {!isNew && existing && (
            <Button variant="outline" size="sm" onClick={openPrintWindow} className="gap-1.5 print:hidden">
              <Printer className="h-4 w-4" /> {t(`${NS}.print`, "طباعة")}
            </Button>
          )}

          {!isNew && existing && (
            <span className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border",
              existing.status === "posted"
                ? "bg-green-50 text-green-700 border-green-200"
                : "bg-amber-50 text-amber-700 border-amber-200",
            )}>
              {existing.status === "posted" ? t("cashCommon.posted") : t("cashCommon.draft")}
            </span>
          )}
        </div>
      </div>

      {/* ─── Locked banner (for posted vouchers) ──────────────── */}
      {isLockedSourceEntry && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900" role="alert">
          <Lock className="h-5 w-5 mt-0.5 shrink-0 text-amber-700" />
          <div className="flex-1 text-sm leading-relaxed">
            <div className="font-semibold">{t(`${NS}.lockedTitle`, "السند مرحَّل — لا يمكن تعديله")}</div>
            <div className="mt-0.5 text-amber-800">{t(`${NS}.lockedHint`, "للتعديل، عُد إلى القائمة وقم بفك الترحيل أولاً.")}</div>
          </div>
        </div>
      )}

      {/* ─── Two-column body: form + live preview ─────────────── */}
      <fieldset disabled={isLockedSourceEntry} className="m-0 p-0 border-0 disabled:opacity-75">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5 items-start">
          {/* ── Left column: TABBED form ──────────────────── */}
          <Tabs defaultValue="voucher" dir={isRtl ? "rtl" : "ltr"} className="space-y-4">
            <TabsList className="grid grid-cols-2 sm:grid-cols-4 w-full h-auto gap-1 p-1">
              <TabsTrigger value="voucher" className="py-2.5 text-sm md:text-base">{t(`${NS}.section_header`, "بيانات السند")}</TabsTrigger>
              <TabsTrigger value="party" className="py-2.5 text-sm md:text-base">{t(`${NS}.tab_party`, "المورد والمبلغ")}</TabsTrigger>
              <TabsTrigger value="lines" className="py-2.5 text-sm md:text-base">{t(`${NS}.section_lines`, "بنود الصرف")}</TabsTrigger>
              <TabsTrigger value="refs" className="py-2.5 text-sm md:text-base">{t(`${NS}.section_refs`, "المراجع والبيان")}</TabsTrigger>
            </TabsList>

            <TabsContent value="voucher" className="mt-0">
            {/* Section: Header */}
            <Card className="border-2">
              <CardHeader className="py-3 px-4 border-b bg-muted/30">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <FileText className="h-4 w-4 text-amber-700" />
                  {t(`${NS}.section_header`, "بيانات السند")}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 pb-4 space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.code`)}</Label>
                    <Input value={docLabel} readOnly disabled className="h-9 font-mono text-sm bg-muted/30" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      {t(`${NS}.date`)} <span className="text-destructive">*</span>
                    </Label>
                    <DateField value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} className="h-9 text-sm" data-testid="pv-date" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      {t(`${NS}.branch`, "الفرع")} <span className="text-destructive">*</span>
                    </Label>
                    <select
                      value={form.branchId}
                      onChange={e => setForm(p => ({ ...p, branchId: e.target.value }))}
                      data-testid="pv-branch"
                      className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background"
                    >
                      <option value="">{t(`${NS}.selectBranch`, "اختر الفرع")}</option>
                      {(branches as any[]).map((b: any) => (
                        <option key={b.id} value={b.id}>
                          {b.code} — {isRtl ? b.nameAr : (b.nameEn || b.nameAr)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.currency`, "العملة")}</Label>
                    <select
                      value={form.currencyId || (defaultCurrencyId ? String(defaultCurrencyId) : "")}
                      onChange={e => setForm(p => ({ ...p, currencyId: e.target.value }))}
                      data-testid="pv-currency"
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
                      <span>{t(`${NS}.exchangeRate`)}</span>
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
                      const amt = totals.grand;
                      const r = Number(form.exchangeRate);
                      if (!sel || !base || sel.id === base.id || !(amt > 0) || !(r > 0)) return null;
                      return (
                        <p className="text-[11px] text-muted-foreground" data-testid="pv-equiv">
                          {t(`${NS}.equivalentIn`, "المكافئ بـ")} {base.code}: <span className="font-mono">{(amt * r).toFixed(2)}</span>
                        </p>
                      );
                    })()}
                  </div>
                </div>
              </CardContent>
            </Card>
            </TabsContent>

            <TabsContent value="party" className="mt-0 space-y-4">
            {/* Section: Payment method + treasury (money source) */}
            <Card className="border-2 border-red-100">
              <CardHeader className="py-3 px-4 border-b bg-red-50/40">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-red-900">
                  <Wallet className="h-4 w-4" />
                  {t(`${NS}.tab_party`, "المورد والمبلغ")}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 pb-4 space-y-4">
                {/* Payment method as visual segmented buttons (cash | bank) */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t(`${NS}.paymentMethod`)} <span className="text-destructive">*</span></Label>
                  <div className="inline-flex rounded-lg border bg-muted/20 p-0.5">
                    <button type="button"
                      onClick={() => setForm(p => ({ ...p, paymentType: "cash", bankAccountId: "" }))}
                      data-testid="pv-paytype-cash"
                      className={cn(
                        "px-4 h-8 rounded-md text-xs font-medium flex items-center gap-1.5 transition",
                        form.paymentType === "cash"
                          ? "bg-amber-100 text-amber-800 shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}>
                      <Wallet className="h-3.5 w-3.5" /> {t(`${NS}.cash`)}
                    </button>
                    <button type="button"
                      onClick={() => setForm(p => ({ ...p, paymentType: "bank", cashBoxId: "" }))}
                      data-testid="pv-paytype-bank"
                      className={cn(
                        "px-4 h-8 rounded-md text-xs font-medium flex items-center gap-1.5 transition",
                        form.paymentType === "bank"
                          ? "bg-blue-100 text-blue-800 shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}>
                      <Building2 className="h-3.5 w-3.5" /> {t(`${NS}.bank`)}
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {t(`${NS}.jeHintCash`, "هذا الجانب سيكون دائناً في القيد المحاسبي")}
                  </p>
                </div>

                {/* Cash box / bank account — searchable comboboxes */}
                {form.paymentType === "cash" ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      {t(`${NS}.cashBox`)} <span className="text-destructive">*</span>
                    </Label>
                    <SearchCombobox
                      items={cashBoxItems}
                      value={form.cashBoxId}
                      onValueChange={v => setForm(p => ({ ...p, cashBoxId: v }))}
                      placeholder={t(`${NS}.selectCashBox`)}
                      searchPlaceholder={t(`${NS}.searchCashBox`, "ابحث عن خزنة...")}
                      emptyText={t(`${NS}.noResults`, "لا توجد نتائج")}
                    />
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      {t(`${NS}.bankAccount`)} <span className="text-destructive">*</span>
                    </Label>
                    <SearchCombobox
                      items={bankAccountItems}
                      value={form.bankAccountId}
                      onValueChange={v => setForm(p => ({ ...p, bankAccountId: v }))}
                      placeholder={t(`${NS}.selectBank`)}
                      searchPlaceholder={t(`${NS}.searchBank`, "ابحث عن حساب...")}
                      emptyText={t(`${NS}.noResults`, "لا توجد نتائج")}
                    />
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Section: Supplier (optional header context) */}
            <Card className="border-2 border-red-100">
              <CardHeader className="py-3 px-4 border-b bg-red-50/40">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-red-900">
                  <Truck className="h-4 w-4" />
                  {t(`${NS}.section_supplier`, "المورد")}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 pb-4 space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    {t(`${NS}.supplier`)} <span className="text-muted-foreground font-normal">({t(`${NS}.optional`, "اختياري")})</span>
                  </Label>
                  <div className="flex gap-2 items-stretch">
                    <div className="flex-1">
                      <SearchCombobox
                        items={supplierItems}
                        value={form.entityId}
                        onValueChange={v => {
                          const found = (suppliers as any[]).find((x: any) => String(x.id) === v);
                          setForm(p => ({
                            ...p,
                            entityId: v,
                            entityName: (isRtl ? found?.nameAr : (found?.nameEn || found?.nameAr)) || "",
                            // Switching supplier invalidates every per-line invoice link.
                            lines: p.lines.map(l => ({ ...l, purchaseInvoiceId: "" })),
                          }));
                        }}
                        placeholder={t(`${NS}.selectSupplier`, "— اختر المورد —")}
                        searchPlaceholder={t(`${NS}.searchEntity`, "ابحث بالاسم أو الكود...")}
                        emptyText={t(`${NS}.noResults`, "لا توجد نتائج")}
                      />
                    </div>
                    {form.entityId && (
                      <Button
                        type="button" variant="ghost" size="icon"
                        className="h-9 w-9 text-muted-foreground hover:text-destructive"
                        onClick={() => setForm(p => ({ ...p, entityId: "", entityName: "", lines: p.lines.map(l => ({ ...l, purchaseInvoiceId: "" })) }))}
                        title={t(`${NS}.clearSupplier`, "إزالة المورد")}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {t(`${NS}.supplierHint`, "المورد اختياري — يُستخدم لتصفية ربط فواتير الشراء في البنود.")}
                  </p>
                </div>
              </CardContent>
            </Card>
            </TabsContent>

            <TabsContent value="lines" className="mt-0">
            {/* Section: Allocation lines grid */}
            <Card className="border-2 border-red-100">
              <CardHeader className="py-3 px-4 border-b bg-red-50/40">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-red-900">
                  <Layers className="h-4 w-4" />
                  {t(`${NS}.section_lines`, "بنود الصرف")}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 pb-4 space-y-3">
                <div className="space-y-4">
                  {form.lines.map((l, idx) => {
                    const lineTotal = (Number(l.amount) || 0) + (Number(l.taxAmount) || 0);
                    return (
                      <div
                        key={l.key}
                        className="rounded-xl border-2 border-red-100 bg-red-50/20 p-4 md:p-5 space-y-4"
                        data-testid={`pv-line-${idx}`}
                      >
                        {/* Row 1: line number + main account + remove */}
                        <div className="flex items-start gap-3">
                          <span className="mt-7 shrink-0 h-8 w-8 rounded-full bg-red-100 text-red-800 text-sm font-bold flex items-center justify-center tabular-nums">{idx + 1}</span>
                          <div className="flex-1 space-y-1.5 min-w-0">
                            <Label className="text-sm font-semibold">{t(`${NS}.colAccount`, "الحساب")} <span className="text-destructive">*</span></Label>
                            <AccountCascadePicker
                              accounts={accounts as any[]}
                              value={l.accountId}
                              isRtl={isRtl}
                              onValueChange={(aid) => updateLine(l.key, { accountId: aid })}
                            />
                          </div>
                          <div className="mt-6 shrink-0 flex items-center">
                            <SupplierTaxDetailsMenu
                              testId={`pv-line-${idx}`}
                              value={{
                                supplierName: l.supplierName,
                                supplierVatNumber: l.supplierVatNumber,
                                supplierInvoiceNumber: l.supplierInvoiceNumber,
                                supplierInvoiceDate: l.supplierInvoiceDate,
                              }}
                              onChange={(v: SupplierTaxDetails) => updateLine(l.key, v)}
                            />
                          </div>
                          <Button
                            type="button" variant="ghost" size="icon"
                            className="mt-6 h-10 w-10 text-muted-foreground hover:text-destructive shrink-0"
                            onClick={() => removeLine(l.key)}
                            title={t(`${NS}.removeLine`, "حذف البند")}
                            data-testid={`pv-line-remove-${idx}`}
                          >
                            <Trash2 className="h-5 w-5" />
                          </Button>
                        </div>
                        {hasSupplierTaxDetails(l) && (
                          <div className="flex flex-wrap items-center gap-2 -mt-1 text-xs">
                            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 font-medium">
                              <FileText className="h-3 w-3" />
                              {l.supplierName || t(`${NS}.supplierUnnamed`, "مورد")}
                            </span>
                            {l.supplierVatNumber && (
                              <span className="text-muted-foreground font-mono" dir="ltr">{l.supplierVatNumber}</span>
                            )}
                            {l.supplierInvoiceNumber && (
                              <span className="text-muted-foreground">#{l.supplierInvoiceNumber}</span>
                            )}
                          </div>
                        )}

                        {/* Row 2: description */}
                        <div className="space-y-1.5">
                          <Label className="text-sm font-semibold">{t(`${NS}.colDescription`, "البيان")}</Label>
                          <Input
                            value={l.description}
                            onChange={e => updateLine(l.key, { description: e.target.value })}
                            placeholder={t(`${NS}.colDescription`, "البيان")}
                            className="h-12 text-base"
                          />
                        </div>

                        {/* Row 3: amount + tax rate + tax amount — stacked vertically, enlarged */}
                        <div className="space-y-3 rounded-lg bg-background/70 border border-red-100 p-3 md:p-4">
                          <div className="space-y-1.5">
                            <Label className="text-sm font-semibold">{t(`${NS}.colTaxRate`, "نسبة الضريبة %")}</Label>
                            <Input
                              type="number" step="0.01" placeholder="0" dir="ltr"
                              value={l.taxRate}
                              onChange={e => updateLine(l.key, { taxRate: e.target.value })}
                              onWheel={e => (e.currentTarget as HTMLInputElement).blur()}
                              className="h-14 text-lg text-left font-mono"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-sm font-semibold">{t(`${NS}.colTaxAmount`, "مبلغ الضريبة")}</Label>
                            <Input
                              type="number" step="0.01" placeholder="0.00" dir="ltr"
                              value={l.taxAmount}
                              onChange={e => updateLine(l.key, { taxAmount: e.target.value })}
                              onWheel={e => (e.currentTarget as HTMLInputElement).blur()}
                              className="h-14 text-lg text-left font-mono"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-sm font-semibold">{t(`${NS}.colAmount`, "المبلغ")} <span className="text-destructive">*</span></Label>
                            <Input
                              type="number" step="0.01" placeholder="0.00" dir="ltr"
                              value={l.amount}
                              onChange={e => updateLine(l.key, { amount: e.target.value })}
                              onWheel={e => (e.currentTarget as HTMLInputElement).blur()}
                              className="h-14 text-lg text-left font-mono font-semibold"
                              data-testid={`pv-line-amount-${idx}`}
                            />
                          </div>
                        </div>

                        {/* Row 4: tax account + cost center + purchase-invoice link */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <Label className="text-sm font-semibold">{t(`${NS}.colTaxAccount`, "حساب الضريبة")}</Label>
                            <AccountCascadePicker
                              accounts={accounts as any[]}
                              value={l.taxAccountId}
                              isRtl={isRtl}
                              mainLabel={t(`${NS}.taxMainLabel`, "حساب الضريبة الرئيسي")}
                              subLabel={t(`${NS}.taxSubLabel`, "حساب الضريبة الفرعي")}
                              onValueChange={(aid) => updateLine(l.key, { taxAccountId: aid })}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-sm font-semibold">{t(`${NS}.colCostCenter`, "مركز التكلفة")}</Label>
                            <select
                              value={l.costCenter}
                              onChange={e => updateLine(l.key, { costCenter: e.target.value })}
                              className="w-full h-12 border border-input rounded-md px-3 text-base bg-background"
                            >
                              <option value="">— {t(`${NS}.noCostCenter`, "بدون")} —</option>
                              {(costCentersList as any[])
                                .filter((c: any) => c.isActive !== false)
                                .map((c: any) => (
                                  <option key={c.id} value={c.code}>{c.code} — {c.nameAr}</option>
                                ))}
                            </select>
                          </div>
                          <div className="space-y-1.5 md:col-span-2">
                            <Label className="text-sm font-semibold inline-flex items-center gap-1"><Link2 className="h-4 w-4" />{t(`${NS}.colPurchaseInvoice`, "ربط فاتورة شراء")}</Label>
                            <SearchCombobox
                              items={invoiceItems}
                              value={l.purchaseInvoiceId}
                              onValueChange={v => {
                                updateLine(l.key, { purchaseInvoiceId: v });
                                // Linking an invoice while no supplier is chosen back-fills
                                // the supplier from the invoice so the JE party stays correct.
                                if (v && !form.entityId) {
                                  const inv = (purchaseInvoices as any[]).find((x: any) => String(x.id) === String(v));
                                  const sup = inv?.supplierId
                                    ? (suppliers as any[]).find((x: any) => String(x.id) === String(inv.supplierId))
                                    : null;
                                  if (sup) setForm(p => ({ ...p, entityId: String(sup.id), entityName: (isRtl ? sup.nameAr : (sup.nameEn || sup.nameAr)) || "" }));
                                }
                              }}
                              placeholder={t(`${NS}.selectInvoicePh`, "— اختر فاتورة —")}
                              searchPlaceholder={t(`${NS}.searchInvoice`, "ابحث برقم الفاتورة...")}
                              emptyText={t(`${NS}.noOpenInvoices`, "لا توجد فواتير")}
                            />
                          </div>
                        </div>

                        {/* Line total — prominent, always visible */}
                        <div className="flex items-center justify-between border-t border-red-200/60 pt-3">
                          <span className="text-sm font-semibold text-muted-foreground">{t(`${NS}.colLineTotal`, "إجمالي البند")}</span>
                          <span className="font-mono font-bold text-xl tabular-nums text-red-700" data-testid={`pv-line-total-${idx}`}>{fmt(lineTotal)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <Button
                  type="button" variant="outline" size="sm"
                  onClick={addLine}
                  className="gap-1.5"
                  data-testid="pv-add-line"
                >
                  <Plus className="h-4 w-4" />
                  {t(`${NS}.addLine`, "إضافة بند")}
                </Button>

                {/* Totals footer */}
                <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-1 border-t pt-3 mt-1 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs">{t(`${NS}.totalNet`, "إجمالي الصافي")}</span>
                    <span className="font-mono font-semibold tabular-nums">{fmt(totals.net)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs">{t(`${NS}.totalTax`, "إجمالي الضريبة")}</span>
                    <span className="font-mono font-semibold tabular-nums">{fmt(totals.tax)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Banknote className="h-4 w-4 text-red-600" />
                    <span className="text-muted-foreground text-xs">{t(`${NS}.grandTotal`, "الإجمالي")}</span>
                    <span className="font-mono font-bold text-base tabular-nums text-red-700" data-testid="pv-grand-total">{fmt(totals.grand)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
            </TabsContent>

            <TabsContent value="refs" className="mt-0">
            {/* Section: References & Notes */}
            <Card className="border-2 border-slate-100">
              <CardHeader className="py-3 px-4 border-b bg-slate-50/40">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <FileText className="h-4 w-4 text-slate-700" />
                  {t(`${NS}.section_refs`, "المراجع والبيان")}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 pb-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.refType`)}</Label>
                    <Input value={form.refType} onChange={e => setForm(p => ({ ...p, refType: e.target.value }))} placeholder={t(`${NS}.refTypePh`)} className="h-9 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.refNumber`)}</Label>
                    <Input value={form.refNumber} onChange={e => setForm(p => ({ ...p, refNumber: e.target.value }))} placeholder="INV-0001" dir="ltr" className="h-9 text-sm text-left font-mono" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t(`${NS}.description`)}</Label>
                  <Input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder={t(`${NS}.descriptionPh`)} className="h-9 text-sm" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">مركز التكلفة</Label>
                  <select
                    value={form.costCenter}
                    onChange={e => setForm(p => ({ ...p, costCenter: e.target.value }))}
                    data-testid="pv-cost-center"
                    className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background"
                  >
                    <option value="">— بدون مركز تكلفة —</option>
                    {(costCentersList as any[])
                      .filter((c: any) => c.isActive !== false)
                      .map((c: any) => (
                        <option key={c.id} value={c.code}>
                          {c.code} — {c.nameAr}
                        </option>
                      ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    سيُسند هذا المركز إلى كل سطور القيد عند الترحيل ليظهر في تقارير مراكز التكلفة.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t("cashCommon.notes")}</Label>
                  <Textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder={t("cashCommon.notesPlaceholder")} className="text-sm resize-none" rows={2} />
                </div>
              </CardContent>
            </Card>
            </TabsContent>
          </Tabs>

          {/* ── Right column: live JE preview (sticky on desktop) ── */}
          <aside className="lg:sticky lg:top-4 space-y-4">
            <Card className="border-2 border-blue-200 bg-blue-50/40">
              <CardHeader className="py-3 px-4 border-b border-blue-200/60">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-blue-900">
                  <FileText className="h-4 w-4" />
                  {t(`${NS}.jePreview`)}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-3 pb-3">
                {!preview ? (
                  <p className="text-xs text-muted-foreground text-center py-6">
                    {t(`${NS}.previewEmpty`, "أدخل بنود الصرف لمعاينة القيد")}
                  </p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-blue-800/70 border-b border-blue-200/60">
                        <th className="text-start pb-1.5 font-medium">{t(`${NS}.jeCol`)}</th>
                        <th className={cn("pb-1.5 font-medium", isRtl ? "text-left" : "text-right")}>{t(`${NS}.jeDr`)}</th>
                        <th className={cn("pb-1.5 font-medium", isRtl ? "text-left" : "text-right")}>{t(`${NS}.jeCr`)}</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {preview.drRows.map((r, i) => (
                        <tr key={`dr-${i}`} className="border-b border-blue-200/40">
                          <td className="py-1.5 text-start text-[11px]">{r.label}</td>
                          <td className={cn("text-red-700 font-semibold", isRtl ? "text-left" : "text-right")}>{fmt(r.amount)}</td>
                          <td className={cn("text-muted-foreground", isRtl ? "text-left" : "text-right")}>—</td>
                        </tr>
                      ))}
                      <tr>
                        <td className="py-1.5 text-start text-[11px]">{preview.crLabel}</td>
                        <td className={cn("text-muted-foreground", isRtl ? "text-left" : "text-right")}>—</td>
                        <td className={cn("text-green-700 font-semibold", isRtl ? "text-left" : "text-right")}>{fmt(preview.total)}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            <div className="text-[11px] text-blue-900/80 leading-relaxed bg-blue-50/40 border border-blue-200 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <Settings2 className="h-4 w-4 mt-0.5 text-blue-700 shrink-0" />
                <div className="space-y-1.5">
                  <p className="font-semibold">{t(`${NS}.mappingsHintTitle`, "روابط الحسابات العامة")}</p>
                  <p>
                    {t(`${NS}.mappingsHintBody`, "حسابات الخزينة/البنك/المورد الافتراضية تُدار الآن من شاشة «ربط القيود المحاسبية» في لوحة التحكم — قسم «تسوية الموردين (سندات الصرف)».")}
                  </p>
                  <button
                    type="button"
                    className="text-[11px] text-blue-700 hover:text-blue-900 underline underline-offset-2"
                    onClick={() => navigate("/settings/accounting-mappings")}
                  >
                    {t(`${NS}.openMappings`, "فتح شاشة ربط القيود المحاسبية")}
                  </button>
                </div>
              </div>
            </div>

            <div className="text-[11px] text-muted-foreground leading-relaxed bg-muted/20 border rounded-lg p-3">
              <p className="font-semibold mb-1">{t(`${NS}.tipsTitle`, "اختصارات سريعة")}</p>
              <ul className="space-y-0.5 list-disc list-inside">
                <li>{t(`${NS}.tip_enter`, "Enter للانتقال للحقل التالي")}</li>
                <li>{t(`${NS}.tip_search`, "اكتب في القوائم للبحث الفوري")}</li>
                <li>{t(`${NS}.tip_link`, "فعّل الربط لربط السند بفاتورة شراء")}</li>
              </ul>
            </div>
          </aside>
        </div>
      </fieldset>

      {/* ─── Sticky bottom action bar ──────────────────────────── */}
      {!isLockedSourceEntry && (
        <div className="fixed bottom-0 inset-x-0 bg-background/95 backdrop-blur border-t z-40 print:hidden">
          <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => navigate("/cash/payment-vouchers")} disabled={saveMut.isPending}>
              {t("cashCommon.cancel")}
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  // Print-only path: opens the same print window the
                  // top toolbar uses, but disables itself for unsaved
                  // drafts since openPrintWindow() relies on `existing`.
                  if (!existing) {
                    toast({
                      title: "احفظ سند الصرف أولاً قبل الطباعة",
                      description: "يصبح زر الطباعة فعّالاً بعد حفظ السند مرة واحدة.",
                    });
                    return;
                  }
                  try { openPrintWindow(); } catch { /* popup-blocker noise */ }
                }}
                disabled={saveMut.isPending}
                className="gap-1.5"
                data-testid="pv-print"
              >
                <Printer className="h-4 w-4" />
                {t(`${NS}.print`, "طباعة")}
              </Button>
              <Button variant="outline" onClick={() => save("draft")} disabled={saveMut.isPending} className="gap-1.5" data-testid="pv-save-draft">
                {pendingMode === "draft" && saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {t(`${NS}.saveDraft`, "حفظ كمسودة")}
              </Button>
              {autoPostingEnabled && (
                <Button onClick={() => save("post")} disabled={saveMut.isPending} className="gap-1.5 bg-red-600 hover:bg-red-700" data-testid="pv-save-post">
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
