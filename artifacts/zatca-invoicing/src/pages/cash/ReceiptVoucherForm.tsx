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
  ArrowDownCircle, ArrowRight, ChevronLeft, Search,
  Loader2, Save, Send, Lock, FileText, Banknote,
  Wallet, Building2, User2, Layers, Printer, Link2, X, Settings2,
  Plus, Trash2,
} from "lucide-react";
import { DateField } from "@/components/ui/date-field";
import { useFieldPolicy } from "@/hooks/useInvoiceFieldPolicy";
import { printCashVoucher } from "@/lib/cashVoucherPrint";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

// A single allocation line (multi-line model). Receipt lines carry NO VAT.
// Numeric fields stay strings for controlled inputs; backend parses both.
interface RvLine {
  key: string;            // local React key only (never sent)
  accountId: string;      // CR GL account (required)
  description: string;
  amount: string;         // credited amount
  costCenter: string;     // inherits header default on add
  salesInvoiceId: string; // optional link to a sales invoice
}

let _rvLineSeq = 0;
function newRvLine(init: Partial<RvLine> = {}): RvLine {
  return {
    key: `rvl_${Date.now()}_${_rvLineSeq++}`,
    accountId: "",
    description: "",
    amount: "",
    costCenter: "",
    salesInvoiceId: "",
    ...init,
  };
}

interface FormState {
  date: string;
  paymentType: "cash" | "bank";
  branchId: string;
  cashBoxId: string;
  bankAccountId: string;
  entityId: string;       // customer id (optional party context)
  entityName: string;     // cached name for JE preview
  currencyId: string;
  exchangeRate: string;
  refType: string;
  refNumber: string;
  description: string;
  notes: string;
  costCenter: string;     // header default inherited by new lines
  lines: RvLine[];        // multi-allocation grid
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

export default function ReceiptVoucherForm() {
  const { user, token } = useAuth();
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const [matchNew] = useRoute("/cash/receipt-vouchers/new");
  const [matchEdit, params] = useRoute("/cash/receipt-vouchers/:id");
  const isNew  = !!matchNew;
  // Wouter matches "/new" against ":id" too — guard against opening the
  // create-mode URL in edit mode.
  const rawId  = matchEdit && !isNew ? (params as any).id : null;
  const editId = rawId && /^\d+$/.test(String(rawId)) ? Number(rawId) : null;
  // "Duplicate" support: `/new?from=123` loads voucher #123, copies its
  // values into the form, but stays in NEW mode so saving creates a fresh
  // voucher (server gets POST, not PUT). isNew stays true → docNumber will
  // be re-issued from the sequence engine, status starts as draft.
  const fromId = useMemo(() => {
    if (!isNew) return null;
    const q = new URLSearchParams(window.location.search).get("from");
    return q && /^\d+$/.test(q) ? Number(q) : null;
  }, [isNew]);
  const sourceId = editId ?? fromId;

  // Query-param prefill (additive): `/cash/receipt-vouchers/new?salesInvoiceId=..`
  // seeds a fresh voucher linked to a sales invoice. Used by the sales-invoice
  // «المدفوعات» tab so the user collects a payment against the invoice without
  // re-keying party/amount. Only active in NEW mode with a valid invoice id;
  // with no params the form behaves exactly as before.
  const prefill = useMemo(() => {
    if (!isNew) return null;
    const q = new URLSearchParams(window.location.search);
    const si = q.get("salesInvoiceId");
    if (!si || !/^\d+$/.test(si)) return null;
    return {
      salesInvoiceId: si,
      entityId:      q.get("entityId") || "",
      entityName:    q.get("entityName") || "",
      amount:        q.get("amount") || "",
      paymentType:   (q.get("paymentType") === "bank" ? "bank" : "cash") as "cash" | "bank",
      cashBoxId:     q.get("cashBoxId") || "",
      bankAccountId: q.get("bankAccountId") || "",
    };
  }, [isNew]);

  const NS = "receiptVouchers";
  const cid = user?.companyId;
  const h = { Authorization: `Bearer ${token}` };

  const [form, setForm] = useState<FormState>(() => ({ ...EMPTY, lines: [newRvLine()] }));

  // ── Field-level governance (شاشة «سياسات حقول الفواتير» → tab «سند قبض») ──
  // Mirrors the sales/JE forms: hide/lock/require header fields per the
  // company's active policy profile. Fail-open (missing key = editable).
  const fp = useFieldPolicy("receipt_voucher");

  // ── Sequence preview for new vouchers ───────────────────────────
  const seqPeek = useNextSequenceNumber("receipt_voucher", isNew, undefined, undefined, form.paymentType);

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
  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: () => fetch(`${API}/api/customers?companyId=${cid}`, { headers: h }).then(r => r.json()),
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
  // Sales invoices for the optional link picker. We pull the full list
  // for this tenant once and filter client-side per selected customer —
  // simpler than maintaining a per-customer endpoint and the data is
  // small (already used elsewhere in the UI).
  const { data: salesInvoices = [] } = useQuery<any[]>({
    queryKey: ["sales-invoices", cid],
    queryFn: () => fetch(`${API}/api/sales/sales-invoices?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
    staleTime: 30_000,
  });

  // ── Voucher list (used both for prev/next nav and for edit-mode load) ─
  const { data: vouchers = [] } = useQuery<any[]>({
    queryKey: ["receipt-vouchers", cid],
    queryFn: () => fetch(`${API}/api/receipt-vouchers?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
    staleTime: 30_000,
  });

  // ── Edit-mode (or duplicate-from): load the single voucher ────
  // We use the same query for both editing and duplicating; only the
  // save path differs (POST when fromId, PUT when editId).
  const { data: existing, isLoading: loadingEdit } = useQuery<any>({
    queryKey: ["receipt-voucher", sourceId],
    queryFn: () => fetch(`${API}/api/receipt-vouchers/${sourceId}`, { headers: h }).then(r => r.json()),
    enabled: !!sourceId,
  });

  useEffect(() => {
    if (!existing) return;
    const headerCostCenter = existing.costCenter ?? "";
    // Hydrate the allocation grid from the returned lines. Old vouchers have
    // no lines[] → synthesize ONE line from the legacy header so they remain
    // editable and re-saveable under the multi-line model.
    const rawLines: any[] = Array.isArray(existing.lines) ? existing.lines : [];
    let lines: RvLine[];
    if (rawLines.length > 0) {
      lines = rawLines.map((ln: any) => newRvLine({
        accountId: ln.accountId != null ? String(ln.accountId) : "",
        description: ln.description ?? "",
        amount: ln.amount != null ? String(ln.amount) : "",
        costCenter: ln.costCenter ?? headerCostCenter,
        salesInvoiceId: ln.salesInvoiceId != null ? String(ln.salesInvoiceId) : "",
      }));
    } else {
      lines = [newRvLine({
        accountId: existing.accountId != null ? String(existing.accountId) : "",
        description: existing.description ?? "",
        amount: existing.amount != null ? String(existing.amount) : "",
        costCenter: headerCostCenter,
        salesInvoiceId: existing.salesInvoiceId != null ? String(existing.salesInvoiceId) : "",
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
      costCenter: headerCostCenter,
      lines,
    });
  }, [existing]);

  // Apply the sales-invoice prefill exactly once, after customers resolve so
  // we can look up the party's receivable (AR) account for the allocation
  // line. No-op when there is no `?salesInvoiceId=` param.
  const prefillDone = useRef(false);
  useEffect(() => {
    if (!prefill || prefillDone.current) return;
    // If a party was supplied, wait for the customer list so we can resolve
    // its AR account; otherwise proceed immediately.
    if (prefill.entityId && (customers as any[]).length === 0) return;
    const cust = prefill.entityId
      ? (customers as any[]).find((c: any) => String(c.id) === prefill.entityId)
      : null;
    prefillDone.current = true;
    setForm(p => ({
      ...p,
      paymentType:   prefill.paymentType,
      cashBoxId:     prefill.paymentType === "cash" ? prefill.cashBoxId : "",
      bankAccountId: prefill.paymentType === "bank" ? prefill.bankAccountId : "",
      entityId:      prefill.entityId,
      entityName:    prefill.entityName || cust?.nameAr || cust?.nameEn || p.entityName,
      refType:       "sales_invoice",
      lines: [newRvLine({
        accountId:      cust?.accountId != null ? String(cust.accountId) : "",
        amount:         prefill.amount || "",
        salesInvoiceId: prefill.salesInvoiceId,
        description:    "تحصيل من فاتورة مبيعات",
      })],
    }));
  }, [prefill, customers]);

  // ── Allocation-line helpers ────────────────────────────────────
  function addLine() {
    setForm(p => ({ ...p, lines: [...p.lines, newRvLine({ costCenter: p.costCenter })] }));
  }
  function removeLine(key: string) {
    setForm(p => {
      const next = p.lines.filter(l => l.key !== key);
      return { ...p, lines: next.length ? next : [newRvLine({ costCenter: p.costCenter })] };
    });
  }
  function updateLine(key: string, patch: Partial<RvLine>) {
    setForm(p => ({
      ...p,
      lines: p.lines.map(l => (l.key === key ? { ...l, ...patch } : l)),
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
    navigate(`/cash/receipt-vouchers/${hit.id}`);
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

  const customerItems: ComboboxItem[] = useMemo(() =>
    (customers as any[]).map(c => ({
      value: String(c.id),
      label: isRtl ? c.nameAr : (c.nameEn || c.nameAr),
      code: c.code ?? undefined,
      description: c.phone ?? c.email ?? undefined,
    })), [customers, isRtl]);

  // Sales invoices the picked customer still has open / payable. We
  // include posted invoices (most common case — settle a credit invoice)
  // and exclude cancelled ones; if the form is editing an existing
  // voucher whose linked invoice was since cancelled, we still surface
  // it so the user can see the (stale) link.
  const invoiceItems: ComboboxItem[] = useMemo(() => {
    if (!form.entityId) return [];
    const cid_filter = Number(form.entityId);
    return (salesInvoices as any[])
      .filter((inv: any) => Number(inv.customerId) === cid_filter && inv.status !== "cancelled")
      .map((inv: any) => ({
        value: String(inv.id),
        label: inv.docNumber ?? `SI-${inv.id}`,
        description: `${inv.invoiceDate} • ${Number(inv.totalAmount || 0).toFixed(2)} ${inv.currencyCode || "SAR"}`,
        code: inv.status,
      }));
  }, [salesInvoices, form.entityId]);

  // Account name lookup for JE preview line labels.
  function accountName(aid: string): string {
    const a = (accounts as any[]).find((x: any) => String(x.id) === aid);
    if (!a) return "";
    return (isRtl ? (a.nameAr || a.nameEn) : (a.nameEn || a.nameAr)) || "";
  }

  // Live grand total (treasury debit) = Σ line amounts.
  const totals = useMemo(() => {
    const grand = form.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    return { grand };
  }, [form.lines]);

  // ── Live Journal-Entry preview (mirrors backend posting logic) ──
  // Single DR treasury = Σ(amount); one CR row per valid allocation line.
  function jePreview() {
    const validLines = form.lines.filter(l => l.accountId && (Number(l.amount) || 0) > 0);
    if (validLines.length === 0) return null;
    const total = validLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    if (!isFinite(total) || total <= 0) return null;
    const cb = (cashBoxes as any[]).find((c: any) => String(c.id) === form.cashBoxId);
    const ba = (bankAccounts as any[]).find((b: any) => String(b.id) === form.bankAccountId);
    const cbName = cb ? (isRtl ? cb.nameAr : (cb.nameEn || cb.nameAr)) : "";
    const baName = ba ? (isRtl ? ba.nameAr : (ba.nameEn || ba.nameAr)) : "";
    const drLabel = form.paymentType === "bank"
      ? (ba ? t(`${NS}.bankPrefix`, { name: baName }) : t(`${NS}.noBankSelected`))
      : (cb ? t(`${NS}.cashPrefix`, { name: cbName }) : t(`${NS}.noCashSelected`));
    const crRows = validLines.map(l => ({
      label: accountName(l.accountId) || t(`${NS}.noAccountSelected`, "— لم يتم اختيار الحساب —"),
      amount: Number(l.amount) || 0,
    }));
    return { drLabel, crRows, total };
  }

  // ── Save / Save-and-post mutation ──────────────────────────────
  const [pendingMode, setPendingMode] = useState<"draft" | "post" | null>(null);
  const isLockedSourceEntry = !isNew && existing?.status === "posted";

  const saveMut = useMutation({
    mutationFn: async (mode: "draft" | "post") => {
      // Build the allocation payload — drop rows with no account AND zero amount.
      const cleanLines = form.lines.filter(l => l.accountId || (Number(l.amount) || 0) > 0);
      if (cleanLines.length === 0) throw new Error(t(`${NS}.noLines`, "أضف بنداً واحداً على الأقل"));
      for (const l of cleanLines) {
        if (!l.accountId) throw new Error(t(`${NS}.lineAccountRequired`, "كل بند يجب أن يحتوي على حساب"));
        if (!((Number(l.amount) || 0) > 0)) throw new Error(t(`${NS}.lineAmountRequired`, "كل بند يجب أن يحتوي على مبلغ أكبر من صفر"));
      }
      const grandTotal = cleanLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
      if (!isFinite(grandTotal) || grandTotal <= 0) throw new Error(t(`${NS}.invalidAmount`));

      if (fp.isVisible("date") && !form.date) throw new Error(t(`${NS}.dateRequired`, "التاريخ مطلوب"));
      if (fp.isVisible("branch") && !form.branchId) throw new Error(t(`${NS}.branchRequired`, "الرجاء اختيار الفرع"));
      if (fp.isVisible("treasury")) {
        if (form.paymentType === "cash" && !form.cashBoxId)
          throw new Error(t(`${NS}.cashBoxRequired`, "الخزنة مطلوبة عند الدفع نقداً"));
        if (form.paymentType === "bank" && !form.bankAccountId)
          throw new Error(t(`${NS}.bankRequired`, "الحساب البنكي مطلوب عند الدفع بنكاً"));
      }
      // Policy-driven required checks for the optional textual fields.
      const reqMsg = (label: string) =>
        t(`${NS}.fieldRequired`, "هذا الحقل مطلوب") + ": " + label;
      if (fp.isVisible("refType") && fp.isRequired("refType") && !form.refType.trim())
        throw new Error(reqMsg(t(`${NS}.refType`)));
      if (fp.isVisible("refNumber") && fp.isRequired("refNumber") && !form.refNumber.trim())
        throw new Error(reqMsg(t(`${NS}.refNumber`)));
      if (fp.isVisible("description") && fp.isRequired("description") && !form.description.trim())
        throw new Error(reqMsg(t(`${NS}.description`)));
      if (fp.isVisible("costCenter") && fp.isRequired("costCenter") && !form.costCenter)
        throw new Error(reqMsg("مركز التكلفة"));
      if (fp.isVisible("notes") && fp.isRequired("notes") && !form.notes.trim())
        throw new Error(reqMsg(t("cashCommon.notes")));

      const linesPayload = cleanLines.map(l => ({
        accountId:      l.accountId ? parseInt(l.accountId) : null,
        description:    l.description || null,
        amount:         String(Number(l.amount) || 0),
        costCenter:     l.costCenter || form.costCenter || null,
        branchId:       form.branchId ? parseInt(form.branchId) : null,
        salesInvoiceId: l.salesInvoiceId ? parseInt(l.salesInvoiceId) : null,
      }));

      const { lines: _omitLines, ...formRest } = form;
      const body = {
        ...formRest,
        amount: grandTotal.toFixed(2),
        companyId: cid,
        // Server force-overrides to "customer" but we send it for clarity.
        entityType: "customer",
        branchId:     form.branchId     ? parseInt(form.branchId)     : null,
        cashBoxId:    form.cashBoxId    ? parseInt(form.cashBoxId)    : null,
        bankAccountId:form.bankAccountId? parseInt(form.bankAccountId): null,
        // Multi-line model: header account is nulled server-side from lines.
        accountId:    null,
        entityId:     form.entityId ? parseInt(form.entityId) : null,
        currencyId:   form.currencyId   ? parseInt(form.currencyId)   : null,
        lines: linesPayload,
      };

      const url = isNew
        ? `${API}/api/receipt-vouchers`
        : `${API}/api/receipt-vouchers/${editId}`;
      const res = await fetch(url, {
        method: isNew ? "POST" : "PUT",
        headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved = await res.json();

      if (mode === "post" && saved?.id && (saved.status ?? "draft") === "draft") {
        const pr = await fetch(`${API}/api/receipt-vouchers/${saved.id}/post`, { method: "POST", headers: h });
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
      qc.invalidateQueries({ queryKey: ["receipt-vouchers"] });
      qc.invalidateQueries({ queryKey: ["receipt-voucher", data.id] });
      // The sales-invoices listing surfaces the linked payment, so make
      // sure it refetches after a save that touches a link.
      qc.invalidateQueries({ queryKey: ["sales-invoices"] });
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
      navigate("/cash/receipt-vouchers");
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
    // Counterparty shown in the account row: customer (party mode) or GL
    // account (general-account mode).
    const cust = existing.entityId
      ? (customers as any[]).find((c: any) => String(c.id) === String(existing.entityId))
      : null;
    const acct = existing.accountId
      ? (accounts as any[]).find((a: any) => String(a.id) === String(existing.accountId))
      : null;
    // Customer's linked AR (ذمم العملاء) GL account → its code is what the
    // voucher row should display for the رمز الحساب field.
    const custAcct = cust?.accountId
      ? (accounts as any[]).find((a: any) => String(a.id) === String(cust.accountId))
      : null;
    const account = {
      code: custAcct?.code ?? cust?.code ?? acct?.code ?? "",
      name: existing.entityName
        || (cust ? (isRtl ? cust.nameAr : (cust.nameEn || cust.nameAr)) : "")
        || (acct ? (isRtl ? acct.nameAr : (acct.nameEn || acct.nameAr)) : ""),
    };
    const linkedInv = existing.salesInvoiceId
      ? (salesInvoices as any[]).find((x: any) => String(x.id) === String(existing.salesInvoiceId))
      : null;
    // Multi-allocation lines (each CR side). Resolve account code/name for print.
    const printLines = ((existing.lines as any[]) ?? []).map((l: any) => {
      const a = (accounts as any[]).find((x: any) => String(x.id) === String(l.accountId));
      return {
        code: a?.code ?? "",
        name: a ? (isRtl ? a.nameAr : (a.nameEn || a.nameAr)) : "—",
        description: l.description ?? "",
        amount: l.amount,
      };
    });
    printCashVoucher({
      kind: "receipt",
      doc: {
        code: existing.code,
        date: existing.date,
        amount: existing.amount,
        currency: existing.currency,
        description: existing.description,
        invoiceNumber: linkedInv?.docNumber ?? (existing.salesInvoiceId ? `SI-${existing.salesInvoiceId}` : null),
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
  const autoPostingEnabled = _co?.autoPostReceipt === undefined || _co?.autoPostReceipt === null
    ? _gl
    : _co.autoPostReceipt !== false;

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div
      ref={formRef}
      onKeyDownCapture={handleFormKeyDownCapture}
      onKeyDown={handleFormKeyDown}
      className="p-6 space-y-5 max-w-6xl mx-auto pb-24"
      dir={isRtl ? "rtl" : "ltr"}
      data-testid="receipt-voucher-form"
    >
      {/* ─── Header bar ────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/cash/receipt-vouchers")} className="h-8 w-8" title={t(`${NS}.backToList`, "عودة للقائمة")}>
            <ArrowRight className={cn("h-4 w-4", !isRtl && "rotate-180")} />
          </Button>
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-green-100 text-green-700">
              <ArrowDownCircle className="h-5 w-5" />
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
            jeKey={existing?.code ?? (editId ? `RV-${editId}` : "RV-new-draft")}
            screenKey="receipt_vouchers"
            companyName={user?.company?.nameAr ?? null}
          />
          {!isNew && navList.length > 0 && (
            <div className="flex items-center gap-1 rounded-md border bg-background px-1 py-0.5 print:hidden">
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs"
                disabled={!prevVoucher}
                onClick={() => prevVoucher && navigate(`/cash/receipt-vouchers/${prevVoucher.id}`)}
                title={prevVoucher ? `${prevVoucher.code}` : ""}>
                <ChevronLeft className={cn("h-3.5 w-3.5", isRtl && "rotate-180")} />
                {t(`${NS}.prev`, "السابق")}
              </Button>
              <span className="text-[11px] tabular-nums px-1.5 text-muted-foreground select-none">
                {currentIndex >= 0 ? `${currentIndex + 1} / ${navList.length}` : navList.length}
              </span>
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs"
                disabled={!nextVoucher}
                onClick={() => nextVoucher && navigate(`/cash/receipt-vouchers/${nextVoucher.id}`)}
                title={nextVoucher ? `${nextVoucher.code}` : ""}>
                {t(`${NS}.next`, "التالي")}
                <ChevronLeft className={cn("h-3.5 w-3.5", !isRtl && "rotate-180")} />
              </Button>
              <div className="relative">
                <Search className={cn("h-3.5 w-3.5 absolute top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none", isRtl ? "right-2" : "left-2")} />
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
              <TabsTrigger value="party" className="py-2.5 text-sm md:text-base">{t(`${NS}.tab_party`, "العميل والمبلغ")}</TabsTrigger>
              <TabsTrigger value="lines" className="py-2.5 text-sm md:text-base">{t(`${NS}.section_lines`, "بنود القبض")}</TabsTrigger>
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
                  {fp.isVisible("date") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      {t(`${NS}.date`)}{fp.isRequired("date") && <span className="text-destructive"> *</span>}
                    </Label>
                    <DateField
                      value={form.date}
                      onChange={e => { if (!fp.isReadOnly("date")) setForm(p => ({ ...p, date: e.target.value })); }}
                      className={cn("h-9 text-sm", fp.isReadOnly("date") && "bg-muted/40 cursor-not-allowed")}
                      readOnly={fp.isReadOnly("date")}
                      {...(fp.dateBounds("date") ?? {})}
                      data-testid="rv-date"
                    />
                  </div>
                  )}
                  {fp.isVisible("branch") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      {t(`${NS}.branch`, "الفرع")} <span className="text-destructive">*</span>
                    </Label>
                    <select
                      value={form.branchId}
                      onChange={e => setForm(p => ({ ...p, branchId: e.target.value }))}
                      disabled={fp.isReadOnly("branch")}
                      data-testid="rv-branch"
                      className={cn("w-full h-9 border border-input rounded-md px-3 text-sm bg-background", fp.isReadOnly("branch") && "bg-muted/40 cursor-not-allowed")}
                    >
                      <option value="">{t(`${NS}.selectBranch`, "اختر الفرع")}</option>
                      {(branches as any[]).map((b: any) => (
                        <option key={b.id} value={b.id}>
                          {b.code} — {isRtl ? b.nameAr : (b.nameEn || b.nameAr)}
                        </option>
                      ))}
                    </select>
                  </div>
                  )}
                  {fp.isVisible("currency") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.currency`, "العملة")}{fp.isRequired("currency") && <span className="text-destructive"> *</span>}</Label>
                    <select
                      value={form.currencyId || (defaultCurrencyId ? String(defaultCurrencyId) : "")}
                      onChange={e => setForm(p => ({ ...p, currencyId: e.target.value }))}
                      disabled={fp.isReadOnly("currency")}
                      data-testid="rv-currency"
                      className={cn("w-full h-9 border border-input rounded-md px-3 text-sm bg-background", fp.isReadOnly("currency") && "bg-muted/40 cursor-not-allowed")}
                    >
                      <option value="">{t(`${NS}.selectCurrency`, "اختر العملة")}</option>
                      {(currencies as any[]).map((c: any) => (
                        <option key={c.id} value={c.id}>
                          {c.code} — {isRtl ? c.nameAr : (c.nameEn || c.nameAr)}
                        </option>
                      ))}
                    </select>
                  </div>
                  )}
                  {fp.isVisible("exchangeRate") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium flex items-center justify-between gap-2">
                      <span>{t(`${NS}.exchangeRate`)}{fp.isRequired("exchangeRate") && <span className="text-destructive"> *</span>}</span>
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
                    <Input type="number" step="0.000001" value={form.exchangeRate} onChange={e => { if (!fp.isReadOnly("exchangeRate")) setForm(p => ({ ...p, exchangeRate: e.target.value })); }} readOnly={fp.isReadOnly("exchangeRate")} placeholder="1" dir="ltr" className={cn("h-9 text-sm text-left font-mono", fp.isReadOnly("exchangeRate") && "bg-muted/40 cursor-not-allowed")} />
                    {(() => {
                      const sel = (currencies as any[]).find((c: any) => String(c.id) === String(form.currencyId));
                      const base = (currencies as any[]).find((c: any) => c.isDefault) ?? (currencies as any[])[0];
                      const amt = totals.grand;
                      const r = Number(form.exchangeRate);
                      if (!sel || !base || sel.id === base.id || !(amt > 0) || !(r > 0)) return null;
                      return (
                        <p className="text-[11px] text-muted-foreground" data-testid="rv-equiv">
                          {t(`${NS}.equivalentIn`, "المكافئ بـ")} {base.code}: <span className="font-mono">{(amt * r).toFixed(2)}</span>
                        </p>
                      );
                    })()}
                  </div>
                  )}
                </div>
              </CardContent>
            </Card>
            </TabsContent>

            <TabsContent value="party" className="mt-0 space-y-4">
            {/* Section: Payment method + treasury (money source) */}
            <Card className="border-2 border-green-100">
              <CardHeader className="py-3 px-4 border-b bg-green-50/40">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-green-900">
                  <Wallet className="h-4 w-4" />
                  {t(`${NS}.tab_party`, "العميل والمبلغ")}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 pb-4 space-y-4">
                {/* Payment method as visual segmented buttons (cash | bank) */}
                {fp.isVisible("paymentType") && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t(`${NS}.paymentMethod`)} <span className="text-destructive">*</span></Label>
                  <div className="inline-flex rounded-lg border bg-muted/20 p-0.5">
                    <button type="button"
                      onClick={() => setForm(p => ({ ...p, paymentType: "cash", bankAccountId: "" }))}
                      data-testid="rv-paytype-cash"
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
                      data-testid="rv-paytype-bank"
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
                    {t(`${NS}.jeHintDr`, "هذا الجانب سيكون مديناً في القيد المحاسبي")}
                  </p>
                </div>
                )}

                {/* Cash box / bank account — searchable comboboxes */}
                {fp.isVisible("treasury") && (form.paymentType === "cash" ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      {t(`${NS}.cashBox`)} <span className="text-destructive">*</span>
                    </Label>
                    <SearchCombobox
                      items={cashBoxItems}
                      value={form.cashBoxId}
                      onValueChange={v => setForm(p => ({ ...p, cashBoxId: v }))}
                      disabled={fp.isReadOnly("treasury")}
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
                      disabled={fp.isReadOnly("treasury")}
                      placeholder={t(`${NS}.selectBank`)}
                      searchPlaceholder={t(`${NS}.searchBank`, "ابحث عن حساب...")}
                      emptyText={t(`${NS}.noResults`, "لا توجد نتائج")}
                    />
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Section: Customer (optional party context for per-line invoice links) */}
            {fp.isVisible("customer") && (
            <Card className="border-2 border-blue-100">
              <CardHeader className="py-3 px-4 border-b bg-blue-50/40">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-blue-900">
                  <User2 className="h-4 w-4" />
                  {t(`${NS}.section_customer`, "العميل")}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 pb-4 space-y-2">
                <Label className="text-xs font-medium">{t(`${NS}.customer`)}</Label>
                <SearchCombobox
                  items={customerItems}
                  value={form.entityId}
                  disabled={fp.isReadOnly("customer")}
                  onValueChange={v => {
                    const found = (customers as any[]).find((x: any) => String(x.id) === v);
                    setForm(p => ({
                      ...p,
                      entityId: v,
                      entityName: (isRtl ? found?.nameAr : (found?.nameEn || found?.nameAr)) || "",
                      // Changing the customer invalidates any per-line invoice links.
                      lines: p.lines.map(l => ({ ...l, salesInvoiceId: "" })),
                    }));
                  }}
                  placeholder={t(`${NS}.selectCustomer`, "— اختر العميل —")}
                  searchPlaceholder={t(`${NS}.searchEntity`, "ابحث بالاسم أو الكود...")}
                  emptyText={t(`${NS}.noResults`, "لا توجد نتائج")}
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t(`${NS}.customerHintOptional`, "اختياري — يُستخدم لتصفية فواتير المبيعات القابلة للربط في البنود.")}
                </p>
              </CardContent>
            </Card>
            )}
            </TabsContent>

            <TabsContent value="lines" className="mt-0">
            {/* Section: Allocation lines (multi-line receipt, no VAT) */}
            <Card className="border-2 border-green-100">
              <CardHeader className="py-3 px-4 border-b bg-green-50/40">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-green-900">
                  <Layers className="h-4 w-4" />
                  {t(`${NS}.section_lines`, "بنود القبض")}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 pb-4 space-y-3">
                <div className="space-y-4">
                  {form.lines.map((l, idx) => (
                    <div
                      key={l.key}
                      className="rounded-xl border-2 border-green-100 bg-green-50/20 p-4 md:p-5 space-y-4"
                      data-testid={`rv-line-${idx}`}
                    >
                      {/* Row 1: line number + main account + remove */}
                      <div className="flex items-start gap-3">
                        <span className="mt-7 shrink-0 h-8 w-8 rounded-full bg-green-100 text-green-800 text-sm font-bold flex items-center justify-center tabular-nums">{idx + 1}</span>
                        <div className="flex-1 space-y-1.5 min-w-0">
                          <Label className="text-sm font-semibold">{t(`${NS}.colAccount`, "الحساب")} <span className="text-destructive">*</span></Label>
                          <AccountCascadePicker
                            accounts={accounts as any[]}
                            value={l.accountId}
                            isRtl={isRtl}
                            onValueChange={(aid) => updateLine(l.key, { accountId: aid })}
                          />
                        </div>
                        <Button
                          type="button" variant="ghost" size="icon"
                          className="mt-7 h-10 w-10 text-muted-foreground hover:text-destructive shrink-0"
                          onClick={() => removeLine(l.key)}
                          title={t(`${NS}.removeLine`, "حذف البند")}
                          data-testid={`rv-line-remove-${idx}`}
                        >
                          <Trash2 className="h-5 w-5" />
                        </Button>
                      </div>

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

                      {/* Row 3: amount — enlarged */}
                      <div className="space-y-1.5 rounded-lg bg-background/70 border border-green-100 p-3 md:p-4">
                        <Label className="text-sm font-semibold">{t(`${NS}.colAmount`, "المبلغ")} <span className="text-destructive">*</span></Label>
                        <Input
                          type="number" step="0.01" placeholder="0.00" dir="ltr"
                          value={l.amount}
                          onChange={e => updateLine(l.key, { amount: e.target.value })}
                          onWheel={e => (e.currentTarget as HTMLInputElement).blur()}
                          className="h-14 text-lg text-left font-mono font-semibold"
                          data-testid={`rv-line-amount-${idx}`}
                        />
                      </div>

                      {/* Row 4: cost center + sales-invoice link */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
                        {fp.isVisible("settleSalesInvoice") && (
                        <div className="space-y-1.5">
                          <Label className="text-sm font-semibold inline-flex items-center gap-1"><Link2 className="h-4 w-4" />{t(`${NS}.colSalesInvoice`, "ربط فاتورة مبيعات")}</Label>
                          <SearchCombobox
                            items={invoiceItems}
                            value={l.salesInvoiceId}
                            onValueChange={v => updateLine(l.key, { salesInvoiceId: v })}
                            placeholder={form.entityId
                              ? t(`${NS}.selectInvoicePh`, "— اختر فاتورة —")
                              : t(`${NS}.pickCustomerFirst`, "اختر العميل أولاً")}
                            searchPlaceholder={t(`${NS}.searchInvoice`, "ابحث برقم الفاتورة...")}
                            emptyText={form.entityId
                              ? t(`${NS}.noOpenInvoices`, "لا توجد فواتير لهذا العميل")
                              : t(`${NS}.pickCustomerFirst`, "اختر العميل أولاً")}
                          />
                        </div>
                        )}
                      </div>

                      {/* Line total — prominent, always visible */}
                      <div className="flex items-center justify-between border-t border-green-200/60 pt-3">
                        <span className="text-sm font-semibold text-muted-foreground">{t(`${NS}.colLineTotal`, "إجمالي البند")}</span>
                        <span className="font-mono font-bold text-xl tabular-nums text-green-700" data-testid={`rv-line-total-${idx}`}>{fmt(Number(l.amount) || 0)}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <Button
                  type="button" variant="outline" size="sm"
                  onClick={addLine}
                  className="gap-1.5"
                  data-testid="rv-add-line"
                >
                  <Plus className="h-4 w-4" />
                  {t(`${NS}.addLine`, "إضافة بند")}
                </Button>

                {/* Totals footer */}
                <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-1 border-t pt-3 mt-1 text-sm">
                  <div className="flex items-center gap-2">
                    <Banknote className="h-4 w-4 text-green-600" />
                    <span className="text-muted-foreground text-xs">{t(`${NS}.grandTotal`, "الإجمالي")}</span>
                    <span className="font-mono font-bold text-base tabular-nums text-green-700" data-testid="rv-grand-total">{fmt(totals.grand)}</span>
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
                {(fp.isVisible("refType") || fp.isVisible("refNumber")) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {fp.isVisible("refType") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.refType`)}{fp.isRequired("refType") && <span className="text-destructive"> *</span>}</Label>
                    <Input value={form.refType} onChange={e => { if (!fp.isReadOnly("refType")) setForm(p => ({ ...p, refType: e.target.value })); }} readOnly={fp.isReadOnly("refType")} placeholder={t(`${NS}.refTypePh`)} className={cn("h-9 text-sm", fp.isReadOnly("refType") && "bg-muted/40 cursor-not-allowed")} />
                  </div>
                  )}
                  {fp.isVisible("refNumber") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.refNumber`)}{fp.isRequired("refNumber") && <span className="text-destructive"> *</span>}</Label>
                    <Input value={form.refNumber} onChange={e => { if (!fp.isReadOnly("refNumber")) setForm(p => ({ ...p, refNumber: e.target.value })); }} readOnly={fp.isReadOnly("refNumber")} placeholder="INV-0001" dir="ltr" className={cn("h-9 text-sm text-left font-mono", fp.isReadOnly("refNumber") && "bg-muted/40 cursor-not-allowed")} />
                  </div>
                  )}
                </div>
                )}
                {fp.isVisible("description") && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t(`${NS}.description`)}{fp.isRequired("description") && <span className="text-destructive"> *</span>}</Label>
                  <Input value={form.description} onChange={e => { if (!fp.isReadOnly("description")) setForm(p => ({ ...p, description: e.target.value })); }} readOnly={fp.isReadOnly("description")} placeholder={t(`${NS}.descriptionPh`)} className={cn("h-9 text-sm", fp.isReadOnly("description") && "bg-muted/40 cursor-not-allowed")} />
                </div>
                )}
                {fp.isVisible("costCenter") && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">مركز التكلفة{fp.isRequired("costCenter") && <span className="text-destructive"> *</span>}</Label>
                  <select
                    value={form.costCenter}
                    onChange={e => setForm(p => ({ ...p, costCenter: e.target.value }))}
                    disabled={fp.isReadOnly("costCenter")}
                    data-testid="rv-cost-center"
                    className={cn("w-full h-9 border border-input rounded-md px-3 text-sm bg-background", fp.isReadOnly("costCenter") && "bg-muted/40 cursor-not-allowed")}
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
                )}
                {fp.isVisible("notes") && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t("cashCommon.notes")}{fp.isRequired("notes") && <span className="text-destructive"> *</span>}</Label>
                  <Textarea value={form.notes} onChange={e => { if (!fp.isReadOnly("notes")) setForm(p => ({ ...p, notes: e.target.value })); }} readOnly={fp.isReadOnly("notes")} placeholder={t("cashCommon.notesPlaceholder")} className={cn("text-sm resize-none", fp.isReadOnly("notes") && "bg-muted/40 cursor-not-allowed")} rows={2} />
                </div>
                )}
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
                    {t(`${NS}.previewEmpty`, "أدخل المبلغ لمعاينة القيد")}
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
                      <tr className="border-b border-blue-200/40">
                        <td className="py-1.5 text-start text-[11px]">{preview.drLabel}</td>
                        <td className={cn("text-green-700 font-semibold", isRtl ? "text-left" : "text-right")}>{fmt(preview.total)}</td>
                        <td className={cn("text-muted-foreground", isRtl ? "text-left" : "text-right")}>—</td>
                      </tr>
                      {preview.crRows.map((r, i) => (
                      <tr key={i} className="border-b border-blue-200/40 last:border-0">
                        <td className="py-1.5 text-start text-[11px]">{r.label}</td>
                        <td className={cn("text-muted-foreground", isRtl ? "text-left" : "text-right")}>—</td>
                        <td className={cn("text-red-700 font-semibold", isRtl ? "text-left" : "text-right")}>{fmt(r.amount)}</td>
                      </tr>
                      ))}
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
                    {t(`${NS}.mappingsHintBody`, "حسابات الخزينة/البنك/العميل الافتراضية تُدار الآن من شاشة «ربط القيود المحاسبية» في لوحة التحكم — قسم «تسوية العملاء (سندات القبض)».")}
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
                <li>{t(`${NS}.tip_link`, "فعّل الربط لربط السند بفاتورة مبيعات")}</li>
              </ul>
            </div>
          </aside>
        </div>
      </fieldset>

      {/* ─── Sticky bottom action bar ──────────────────────────── */}
      {!isLockedSourceEntry && (
        <div className="fixed bottom-0 inset-x-0 bg-background/95 backdrop-blur border-t z-40 print:hidden">
          <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => navigate("/cash/receipt-vouchers")} disabled={saveMut.isPending}>
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
                      title: "احفظ سند القبض أولاً قبل الطباعة",
                      description: "يصبح زر الطباعة فعّالاً بعد حفظ السند مرة واحدة.",
                    });
                    return;
                  }
                  try { openPrintWindow(); } catch { /* popup-blocker noise */ }
                }}
                disabled={saveMut.isPending}
                className="gap-1.5"
                data-testid="rv-print"
              >
                <Printer className="h-4 w-4" />
                {t(`${NS}.print`, "طباعة")}
              </Button>
              <Button variant="outline" onClick={() => save("draft")} disabled={saveMut.isPending} className="gap-1.5" data-testid="rv-save-draft">
                {pendingMode === "draft" && saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {t(`${NS}.saveDraft`, "حفظ كمسودة")}
              </Button>
              {autoPostingEnabled && (
                <Button onClick={() => save("post")} disabled={saveMut.isPending} className="gap-1.5 bg-green-600 hover:bg-green-700" data-testid="rv-save-post">
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
