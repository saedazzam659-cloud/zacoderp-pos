import { useState, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Plus, Pencil, Trash2, CreditCard, FileText, ListOrdered, Sparkles, Loader2, Lock, Unlock, Banknote } from "lucide-react";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

const EMPTY_LC  = { lcNumber: "", lcDate: today(), supplierId: "", bankName: "", currencyCode: "SAR", exchangeRate: "1", totalAmount: "", settlementAccountId: "", notes: "" };
const EMPTY_EXP = { expenseType: "", accountId: "", amount: "", currencyCode: "SAR", exchangeRate: "1", notes: "" };

export default function LetterOfCredit() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`purchasingPages.lettersOfCredit.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");
  const numLocale = isRtl ? "ar-SA" : "en-US";
  const fmt = (n: any) => Number(n || 0).toLocaleString(numLocale, { minimumFractionDigits: 2 });
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const authH   = { Authorization: `Bearer ${token}` };

  const STATUS_MAP: Record<string, { label: string; cls: string }> = {
    open:    { label: tr("stOpen"),    cls: "bg-green-50 text-green-700 border-green-200" },
    partial: { label: tr("stPartial"), cls: "bg-amber-50 text-amber-700 border-amber-200" },
    closed:  { label: tr("stClosed"),  cls: "bg-muted text-muted-foreground border-border" },
  };

  const [showForm,  setShowForm]  = useState(false);
  const [editId,    setEditId]    = useState<number | null>(null);
  const [form,      setForm]      = useState<any>(EMPTY_LC);
  const [expenses,  setExpenses]  = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState("info");
  const [aiLc,      setAiLc]      = useState<any | null>(null);
  const [aiPreview, setAiPreview] = useState<any | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSaving,  setAiSaving]  = useState(false);

  // ─── Bank-transfer dialog state (records the funding of the LC) ─────
  // Opens from the row's Banknote button. Posts a balanced JE:
  //   Dr LC settlement account   (lcAmount × rate)
  //   Cr Bank / Cash             (lcAmount × rate)
  // The amount is in the LC's currency; the rate converts to base for the JE.
  const [transferLc, setTransferLc] = useState<any | null>(null);
  const [transferForm, setTransferForm] = useState<{
    target: "settlement" | "expense";  // what we are debiting
    expenseId: string;                  // when target = "expense"
    sourceType: "bank" | "cash";
    sourceId: string;
    date: string;
    amount: string;
    exchangeRate: string;
    description: string;
  }>({
    target: "settlement", expenseId: "",
    sourceType: "bank", sourceId: "",
    date: today(), amount: "", exchangeRate: "1", description: "",
  });

  const { data: lcs = [], isLoading } = useQuery<any[]>({
    queryKey: ["lc", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/purchasing/letters-of-credit?companyId=${cid}` : `${API}/api/purchasing/letters-of-credit`;
      const res = await fetch(url, { headers: authH }); return res.json();
    },
    enabled: !!user,
  });

  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`;
      const res = await fetch(url, { headers: authH }); return res.json();
    },
    enabled: !!user,
  });

  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const res = await fetch(url, { headers: authH }); return res.json();
    },
    enabled: !!user,
  });

  const { data: currencies = [] } = useQuery<any[]>({
    queryKey: ["currencies", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/currencies?companyId=${cid}` : `${API}/api/currencies`;
      const res = await fetch(url, { headers: authH }); return res.json();
    },
    enabled: !!user,
  });

  // Bank accounts and cash boxes — used by the "Bank transfer to L/C"
  // shortcut to debit the LC settlement account when funds are wired
  // (or paid in cash) to open / fund the letter of credit.
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/bank-accounts?companyId=${cid}` : `${API}/api/bank-accounts`;
      const res = await fetch(url, { headers: authH }); return res.json();
    },
    enabled: !!user,
  });
  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/cash-boxes?companyId=${cid}` : `${API}/api/cash-boxes`;
      const res = await fetch(url, { headers: authH }); return res.json();
    },
    enabled: !!user,
  });
  const defaultCurrency = currencies.find((c: any) => c.isDefault) ?? currencies[0];
  const baseCode = defaultCurrency?.code ?? "SAR";

  // Fetch the historical exchange rate for `code` → base on a given date.
  // Updates the target field via setter; falls back to "1" with a toast warning
  // when no rate is found, so users always know they should add one.
  async function fetchRateInto(code: string, asOf: string, apply: (r: string) => void) {
    if (!code || code === baseCode) { apply("1"); return; }
    try {
      const res = await fetch(`${API}/api/currencies/lookup-rate?fromCode=${encodeURIComponent(code)}&toCode=${encodeURIComponent(baseCode)}&asOf=${encodeURIComponent(asOf)}`, { headers: authH });
      const j = await res.json();
      const rate = j?.rate && Number(j.rate) > 0 ? String(j.rate) : "1";
      apply(rate);
      if (j?.fallback) toast({ title: tr("fetchRateMissing"), variant: "destructive" });
    } catch { apply("1"); }
  }

  useEffect(() => {
    if (editId || !defaultCurrency || !showForm) return;
    setForm((p: any) => p.currencyCode && p.currencyCode !== "SAR"
      ? p
      : { ...p, currencyCode: defaultCurrency.code, exchangeRate: "1" });
  }, [defaultCurrency?.code, showForm, editId]);

  // When the LC currency changes (and it's not the base), auto-fetch a rate
  // suggestion so the user does not have to think about it for the common case.
  useEffect(() => {
    if (!showForm || !form.currencyCode || !form.lcDate) return;
    if (form.currencyCode === baseCode) {
      if (form.exchangeRate !== "1") setForm((p: any) => ({ ...p, exchangeRate: "1" }));
      return;
    }
    fetchRateInto(form.currencyCode, form.lcDate, (r) =>
      setForm((p: any) => ({ ...p, exchangeRate: r })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.currencyCode, form.lcDate, showForm, baseCode]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["lc"] });

  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const url = editId ? `${API}/api/purchasing/letters-of-credit/${editId}` : `${API}/api/purchasing/letters-of-credit`;
      const res = await fetch(url, { method: editId ? "PUT" : "POST", headers, body: JSON.stringify({ ...data, companyId: cid }) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: () => { invalidate(); reset(); toast({ title: editId ? tr("toastUpdated") : tr("toastCreated") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/letters-of-credit/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: tr("toastDeleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // POSTs a balanced 2-line journal entry to record the LC funding:
  //   Dr LC settlement account  (= amount × rate, in base currency)
  //   Cr Bank / Cash             (= same)
  // Tagged `entryType: "lc_funding"` so it is editable by an admin from the
  // journal-entries page (not in LOCKED_ENTRY_TYPES). The LC's `usedAmount`
  // is intentionally *not* touched — that field tracks only goods drawn
  // down by posted purchase invoices, which is a separate accounting axis.
  const fundMut = useMutation({
    mutationFn: async () => {
      if (!transferLc) throw new Error("LC missing");
      const lc = transferLc;
      const amt  = Number(transferForm.amount || 0);
      const rate = Number(transferForm.exchangeRate || 1);
      if (!(amt > 0)) throw new Error(tr("transferAmtRequired"));
      if (!transferForm.sourceId) throw new Error(tr("transferSourceRequired"));

      // Resolve the DEBIT-side account based on target mode
      let debitAccountId: number | null = null;
      let debitLabel = "";
      let entryType = "lc_funding";
      if (transferForm.target === "settlement") {
        if (!lc.settlementAccountId) throw new Error(tr("transferLcMissingSettlement"));
        debitAccountId = Number(lc.settlementAccountId);
        debitLabel = tr("fSettlementAccount");
      } else {
        const exp = (lc.expenses ?? []).find((e: any) => String(e.id) === String(transferForm.expenseId));
        if (!exp) throw new Error(tr("transferExpenseRequired"));
        if (!exp.accountId) throw new Error(tr("transferExpenseAccMissing"));
        debitAccountId = Number(exp.accountId);
        debitLabel = exp.expenseType ?? tr("transferExpenseLabel");
        entryType = "lc_expense_payment";
      }

      // Resolve the CREDIT-side account: the bank account's GL account, or
      // the cash box's GL account. Both use the same `accountId` column.
      const list = transferForm.sourceType === "bank" ? bankAccounts : cashBoxes;
      const src  = list.find((b: any) => String(b.id) === String(transferForm.sourceId));
      const sourceAccountId = src?.accountId;
      if (!sourceAccountId) throw new Error(tr("transferSourceAccMissing"));
      const baseAmt = +(amt * rate).toFixed(2);
      const ccy     = (transferForm.target === "expense"
        ? ((lc.expenses ?? []).find((e: any) => String(e.id) === String(transferForm.expenseId))?.currencyCode ?? lc.currencyCode)
        : lc.currencyCode) ?? baseCode;
      const defaultDesc = transferForm.target === "settlement"
        ? tr("transferDefaultDesc", { lc: lc.lcNumber })
        : tr("transferDefaultDescExp", { lc: lc.lcNumber, exp: debitLabel });
      const userDesc = transferForm.description?.trim() || defaultDesc;
      // Stable, machine-readable tags so the LC Statement report can link
      // this funding/expense-payment JE back to its LC (and expense, if any)
      // and show the source bank/cash. Format: [LC#<id>] and [LCE#<id>].
      const tag = transferForm.target === "settlement"
        ? `[LC#${lc.id}]`
        : `[LC#${lc.id}][LCE#${transferForm.expenseId}]`;
      const desc = `${userDesc} ${tag}`;
      const body = {
        companyId:   cid,
        entryDate:   transferForm.date,
        currency:    ccy,
        exchangeRate: String(rate),
        description: desc,
        entryType,
        lines: [
          { accountId: debitAccountId,  debit: baseAmt, credit: 0,
            description: `${desc} — ${debitLabel}` },
          { accountId: sourceAccountId, debit: 0,        credit: baseAmt,
            description: `${desc} — ${pickName(src?.nameAr, src?.nameEn) ?? ""}` },
        ],
      };
      const res = await fetch(`${API}/api/journal-entries`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? tr("transferFailed"));
      return j;
    },
    onSuccess: (j) => {
      toast({ title: tr("transferDone"), description: tr("transferDoneDesc", { id: j.docNumber ?? j.id }) });
      setTransferLc(null);
      qc.invalidateQueries({ queryKey: ["journal-entries"] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function openTransfer(lc: any) {
    setTransferLc(lc);
    setTransferForm({
      target: "settlement",
      expenseId: "",
      sourceType: "bank",
      sourceId: "",
      date: today(),
      amount: String(lc.totalAmount ?? ""),                     // pre-fill with full LC value (the typical 100% deposit)
      exchangeRate: String(lc.exchangeRate ?? "1"),
      description: "",
    });
  }

  const toggleStatusMut = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "close" | "reopen" }) => {
      const res = await fetch(`${API}/api/purchasing/letters-of-credit/${id}/${action}`, { method: "PATCH", headers });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: (_, vars) => { invalidate(); toast({ title: vars.action === "close" ? tr("toastClosed") : tr("toastReopened") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function reset() { setForm(EMPTY_LC); setExpenses([]); setEditId(null); setShowForm(false); setActiveTab("info"); }

  async function handleEdit(lc: any) {
    const res = await fetch(`${API}/api/purchasing/letters-of-credit/${lc.id}?companyId=${cid}`, { headers: authH });
    const data = await res.json();
    setForm({ lcNumber: data.lcNumber, lcDate: data.lcDate, supplierId: data.supplierId ? String(data.supplierId) : "",
              bankName: data.bankName ?? "", currencyCode: data.currencyCode,
              exchangeRate: String(data.exchangeRate ?? "1"),
              totalAmount: String(data.totalAmount),
              settlementAccountId: data.settlementAccountId ? String(data.settlementAccountId) : "",
              notes: data.notes ?? "" });
    setExpenses((data.expenses ?? []).map((e: any) => ({ ...e, exchangeRate: String(e.exchangeRate ?? "1") })));
    setEditId(lc.id); setShowForm(true); setActiveTab("info");
  }

  function addExpense()    { setExpenses(prev => [...prev, { ...EMPTY_EXP, _id: Date.now() }]); }
  function removeExpense(idx: number) { setExpenses(prev => prev.filter((_, i) => i !== idx)); }
  function updateExpense(idx: number, field: string, value: string) {
    setExpenses(prev => prev.map((e, i) => {
      if (i !== idx) return e;
      const next = { ...e, [field]: value };
      // When the row's currency changes, snap the rate to 1 for base currency
      // and trigger an async lookup for foreign currencies. Done here instead
      // of in a useEffect to avoid stale-closure bugs across rows.
      if (field === "currencyCode") {
        if (value === baseCode) next.exchangeRate = "1";
        else fetchRateInto(value, form.lcDate || today(), (r) =>
          setExpenses(p => p.map((x, j) => j === idx ? { ...x, exchangeRate: r } : x)));
      }
      return next;
    }));
  }

  // ─── Totals are always computed in the company's base/functional currency.
  // For each row: amountBase = amount × exchangeRate. This is the IAS 21
  // historical-rate approach used everywhere foreign currency is summed.
  // NOTE: There is no "remaining = LC − expenses" because expenses are
  // ADDITIONAL landed costs loaded on top of the LC value (not a deduction
  // from it). The meaningful "remaining" is LC value − usedAmount (the
  // portion already drawn down by linked posted purchase invoices), which
  // is shown in the LC list/grid below and in the LC Statement report.
  const lcAmountBase    = (Number(form.totalAmount || 0)) * (Number(form.exchangeRate || 1));
  const totalExpenses   = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0); // raw sum — only meaningful when all currencies are identical
  const totalExpBase    = expenses.reduce((s, e) => s + (Number(e.amount) || 0) * (Number(e.exchangeRate) || 1), 0);
  // Detect mixed currencies: only when the LC and EVERY expense share the same
  // currency code can we safely display a sum in the "original currency" box.
  // Otherwise we hide the numeric total (USD + SAR has no meaning) and direct
  // the user to the base-currency box, where everything is FX-converted.
  const allSameCurrency = expenses.every(e => (e.currencyCode || form.currencyCode) === form.currencyCode);

  async function runAiJournal(lc: any) {
    setAiLc(lc); setAiPreview(null); setAiLoading(true);
    try {
      const res = await fetch(`${API}/api/purchasing/letters-of-credit/${lc.id}/ai-journal`, {
        method: "POST", headers, body: JSON.stringify({ save: false }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || tr("aiFailed"));
      setAiPreview(j);
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
      setAiLc(null);
    } finally { setAiLoading(false); }
  }

  async function confirmAiJournal() {
    if (!aiLc) return;
    setAiSaving(true);
    try {
      const res = await fetch(`${API}/api/purchasing/letters-of-credit/${aiLc.id}/ai-journal`, {
        method: "POST", headers, body: JSON.stringify({ save: true }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || tr("saveFailed"));
      toast({ title: tr("toastEntryCreated"), description: tr("toastEntryDesc", { id: j.entryId }) });
      setAiLc(null); setAiPreview(null);
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
    } finally { setAiSaving(false); }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMut.mutate({ ...form, supplierId: form.supplierId || null, expenses });
  }

  const supplierItems = [{ value: "", label: tr("supplierNone") }, ...suppliers.map((s: any) => ({ value: String(s.id), label: pickName(s.nameAr, s.nameEn) }))];
  const accountItems  = [{ value: "", label: tr("accountNone") }, ...accounts.filter((a: any) => a.isPosting).map((a: any) => ({ value: String(a.id), label: `${a.code} — ${pickName(a.nameAr, a.nameEn)}` }))];
  const currencyItems = currencies.length > 0
    ? currencies.map((c: any) => ({
        value: c.code,
        label: `${c.code} — ${pickName(c.nameAr, c.nameEn) || c.code}${c.isDefault ? " ★" : ""}`,
      }))
    : [{ value: "SAR", label: tr("currencyDefaultNone") }];

  const align = isRtl ? "text-right" : "text-left";
  const oppAlign = isRtl ? "text-left" : "text-right";

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CreditCard className="h-6 w-6 text-primary" />{tr("title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{tr("subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />{tr("addNew")}
        </Button>
      </div>

      {showForm && (
        <FormPanel
          icon={CreditCard}
          title={editId ? tr("formEdit") : tr("formNew")}
          subtitle={tr("formSubtitle")}
          width="4xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={saveMut.isPending}
          saveDisabled={!form.lcNumber || !form.lcDate || !form.totalAmount}
          saveLabel={editId ? tr("saveEdit") : tr("saveAdd")}
        >
          <Tabs value={activeTab} onValueChange={setActiveTab} dir={isRtl ? "rtl" : "ltr"}>
            <TabsList className="w-full h-9 mb-4">
              <TabsTrigger value="info" className="flex-1 text-xs gap-1.5"><FileText className="h-3.5 w-3.5" />{tr("tabInfo")}</TabsTrigger>
              <TabsTrigger value="expenses" className="flex-1 text-xs gap-1.5"><ListOrdered className="h-3.5 w-3.5" />{tr("tabExpenses", { count: expenses.length })}</TabsTrigger>
            </TabsList>
            <TabsContent value="info" className="mt-0">
              <FormGrid>
                <Field label={tr("fLcNumber")} required><Input placeholder={tr("fLcNumberPh")} dir="ltr" className="text-left" value={form.lcNumber} onChange={e => setForm((p: any) => ({ ...p, lcNumber: e.target.value }))} /></Field>
                <Field label={tr("fDate")} required><Input type="date" value={form.lcDate} onChange={e => setForm((p: any) => ({ ...p, lcDate: e.target.value }))} /></Field>
                <Field label={tr("fSupplier")}><SearchCombobox items={supplierItems} value={form.supplierId} onValueChange={v => setForm((p: any) => ({ ...p, supplierId: v }))} placeholder={tr("fSupplierPh")} /></Field>
                <Field label={tr("fBank")}><Input placeholder={tr("fBankPh")} value={form.bankName} onChange={e => setForm((p: any) => ({ ...p, bankName: e.target.value }))} /></Field>
                <Field label={tr("fAmount")} required><Input type="text" inputMode="decimal" placeholder="0.00" dir="ltr" className="text-left" value={form.totalAmount} onChange={e => setForm((p: any) => ({ ...p, totalAmount: e.target.value.replace(/[^0-9.]/g, "") }))} /></Field>
                <Field label={tr("fCurrency")}><SearchCombobox items={currencyItems} value={form.currencyCode} onValueChange={v => setForm((p: any) => ({ ...p, currencyCode: v }))} placeholder={tr("fCurrencyPh")} /></Field>
                {form.currencyCode && form.currencyCode !== baseCode && (
                  <Field label={`${tr("fExchangeRate")} — ${tr("fExchangeRateHint", { from: form.currencyCode, to: baseCode })}`} className="md:col-span-2">
                    <div className="flex gap-2">
                      <Input type="text" inputMode="decimal" dir="ltr" className="text-left font-mono" placeholder="3.75"
                        value={form.exchangeRate}
                        onChange={e => setForm((p: any) => ({ ...p, exchangeRate: e.target.value.replace(/[^0-9.]/g, "") }))} />
                      <Button type="button" variant="outline" size="sm" className="shrink-0"
                        onClick={() => fetchRateInto(form.currencyCode, form.lcDate || today(), (r) =>
                          setForm((p: any) => ({ ...p, exchangeRate: r })))}>
                        {tr("fetchRate")}
                      </Button>
                    </div>
                  </Field>
                )}
                <Field label={tr("fSettlementAccount")} required className="md:col-span-2">
                  <SearchCombobox items={accountItems}
                    value={String(form.settlementAccountId ?? "")}
                    onValueChange={v => setForm((p: any) => ({ ...p, settlementAccountId: v }))}
                    placeholder={tr("fSettlementAccountPh")} />
                  <p className="text-[11px] text-muted-foreground mt-1">{tr("fSettlementAccountHint")}</p>
                </Field>
                <Field label={tr("fNotes")} className="md:col-span-2">
                  <Textarea rows={2} className="resize-none text-sm" value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
                </Field>
              </FormGrid>
            </TabsContent>
            <TabsContent value="expenses" className="mt-0 space-y-3">
              {expenses.map((exp, idx) => (
                <div key={exp._id ?? idx} className="space-y-2 p-3 rounded-lg border bg-muted/20">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1"><Label className="text-xs">{tr("expenseType")}</Label><Input className="h-8 text-xs" placeholder={tr("expenseTypePh")} value={exp.expenseType} onChange={e => updateExpense(idx, "expenseType", e.target.value)} /></div>
                    <div className="space-y-1"><Label className="text-xs">{tr("expenseCurrency")}</Label><SearchCombobox items={currencyItems} value={exp.currencyCode} onValueChange={v => updateExpense(idx, "currencyCode", v)} placeholder={tr("fCurrencyPh")} /></div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 items-end">
                    <div className="space-y-1"><Label className="text-xs">{tr("expenseAccount")}</Label><SearchCombobox items={accountItems} value={String(exp.accountId ?? "")} onValueChange={v => updateExpense(idx, "accountId", v)} placeholder={tr("expenseAccountPh")} /></div>
                    <div className="space-y-1"><Label className="text-xs">{tr("expenseAmount")}</Label>
                      <div className="flex gap-2">
                        <Input className="h-8 text-xs" type="text" inputMode="decimal" placeholder="0.00" value={exp.amount} onChange={e => updateExpense(idx, "amount", e.target.value.replace(/[^0-9.]/g, ""))} />
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive shrink-0" onClick={() => removeExpense(idx)}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </div>
                    </div>
                  </div>
                  {exp.currencyCode && exp.currencyCode !== baseCode && (
                    <div className="grid grid-cols-[1fr_auto] gap-3 items-end pt-1">
                      <div className="space-y-1">
                        <Label className="text-xs">{tr("fExchangeRate")} — {tr("fExchangeRateHint", { from: exp.currencyCode, to: baseCode })}</Label>
                        <div className="flex gap-2">
                          <Input className="h-8 text-xs font-mono" type="text" inputMode="decimal" dir="ltr" placeholder="3.75"
                            value={exp.exchangeRate ?? "1"}
                            onChange={e => updateExpense(idx, "exchangeRate", e.target.value.replace(/[^0-9.]/g, ""))} />
                          <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 text-xs"
                            onClick={() => fetchRateInto(exp.currencyCode, form.lcDate || today(), (r) =>
                              setExpenses(p => p.map((x, j) => j === idx ? { ...x, exchangeRate: r } : x)))}>
                            {tr("fetchRate")}
                          </Button>
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground pb-2 font-mono whitespace-nowrap">
                        ≈ {fmt(Number(exp.amount || 0) * Number(exp.exchangeRate || 1))} {baseCode}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="gap-2 w-full" onClick={addExpense}><Plus className="h-4 w-4" />{tr("addExpense")}</Button>
              {expenses.length > 0 && (
                <div className="space-y-2">
                  {/* Original-currency totals — informational only when amounts mix currencies.
                      Expenses ADD to the LC value (landed-cost loading), so we show
                      `LC + expenses` as the loaded-cost total, not `LC − expenses`. */}
                  <div className="rounded-xl border bg-muted/30 p-3 grid grid-cols-3 gap-3 text-xs text-center">
                    <div className="col-span-3 text-[10px] text-muted-foreground font-semibold mb-1">{tr("totalsOriginal")}</div>
                    <div>
                      <span className="text-muted-foreground block text-[10px] mb-1">{tr("lcAmount")} ({form.currencyCode})</span>
                      <span className="font-semibold font-mono">{fmt(form.totalAmount)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-[10px] mb-1">{tr("totalExpenses")}</span>
                      {allSameCurrency ? (
                        <span className="font-semibold font-mono text-amber-700">+ {fmt(totalExpenses)} {form.currencyCode}</span>
                      ) : (
                        <span className="font-mono text-[11px] text-muted-foreground italic">{tr("mixedCurrencies")}</span>
                      )}
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-[10px] mb-1">{tr("loadedCostTotal")}</span>
                      {allSameCurrency ? (
                        <span className="font-semibold font-mono text-primary">{fmt(Number(form.totalAmount || 0) + totalExpenses)} {form.currencyCode}</span>
                      ) : (
                        <span className="font-mono text-[11px] text-muted-foreground italic">{tr("seeBaseTotal")}</span>
                      )}
                    </div>
                    {!allSameCurrency && (
                      <p className="col-span-3 text-[10px] text-muted-foreground italic mt-1 leading-relaxed">
                        {tr("mixedCurrenciesHint", { cur: baseCode })}
                      </p>
                    )}
                  </div>
                  {/* Base-currency totals — the authoritative IAS 21 view.
                      Grand total = LC base + expenses base (landed cost) — this
                      is the figure that flows into the linked purchase invoices. */}
                  <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-4 space-y-3 text-sm">
                    <div className="text-xs text-primary font-semibold text-center">{tr("totalsBase", { cur: baseCode })}</div>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div><span className="text-muted-foreground block text-xs mb-1">{tr("lcAmountBase")}</span><span className="font-bold font-mono">{fmt(lcAmountBase)}</span></div>
                      <div><span className="text-muted-foreground block text-xs mb-1">{tr("totalExpensesBase")}</span><span className="font-bold font-mono text-amber-700">+ {fmt(totalExpBase)}</span></div>
                      <div><span className="text-muted-foreground block text-xs mb-1">{tr("loadedCostTotalBase")}</span><span className="font-bold font-mono text-primary">{fmt(lcAmountBase + totalExpBase)}</span></div>
                    </div>
                    {/* Grand total = LC base + expenses base. This is the figure
                        used when the LC is loaded into a purchase invoice. */}
                    <div className="border-t border-primary/30 pt-3 flex items-center justify-between gap-3 px-2">
                      <span className="text-sm font-semibold text-primary">{tr("grandTotalBase")}</span>
                      <span className="font-bold font-mono text-base text-primary">{fmt(lcAmountBase + totalExpBase)} {baseCode}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground text-center leading-relaxed border-t border-primary/20 pt-2">
                      {tr("expensesAddedHint")}
                    </p>
                  </div>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </FormPanel>
      )}

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground text-sm">{tr("loading")}</div>
        ) : lcs.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground text-sm">{tr("noLcs")}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                {[tr("colNumber"), tr("colInvoice"), tr("colDate"), tr("colSupplier"), tr("colBank"), tr("colCurrency"), tr("colTotal"), tr("colUsed"), tr("colRemaining"), tr("colStatus"), tr("colActions")].map(h => (
                  <th key={h} className={`${align} px-3 py-3 font-semibold text-muted-foreground text-xs`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lcs.map((lc: any) => {
                const sup = suppliers.find((s: any) => s.id === lc.supplierId);
                // Prefer the server-computed base amounts (IAS 21). Fall back gracefully
                // for older rows that don't yet carry the conversion.
                const lcBase   = Number(lc.totalAmountBase   ?? lc.totalAmount   ?? 0);
                // "Used" now reflects the GOODS consumed by posted purchase invoices
                // linked to this LC (auto-maintained by the server). The expenses
                // column shows the load-cost expenses recorded on the LC itself.
                const usedBase = Number(lc.usedAmount ?? 0);
                const expBase  = Number(lc.totalExpensesBase ?? 0);
                const remBase  = lcBase - usedBase;
                const rate     = Number(lc.exchangeRate ?? 1);
                const isFx     = lc.currencyCode && lc.baseCurrency && lc.currencyCode !== lc.baseCurrency;
                const st  = STATUS_MAP[lc.status] ?? STATUS_MAP.open;
                const isClosed = lc.status === "closed";
                return (
                  <tr key={lc.id} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{lc.lcNumber}</td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      {(lc.linkedInvoices ?? []).length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {(lc.linkedInvoices as any[]).map((inv: any) => (
                            <Link key={inv.id} href={`/purchasing/invoices/${inv.id}`}
                              className="text-primary hover:underline" title={tr("colInvoice")}>
                              {inv.docNumber ?? `#${inv.id}`}
                            </Link>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5">{lc.lcDate}</td>
                    <td className="px-3 py-2.5">{sup ? pickName(sup.nameAr, sup.nameEn) : "—"}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{lc.bankName ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col gap-0.5">
                        <span>{lc.currencyCode}</span>
                        {isFx && <span className="text-[10px] text-muted-foreground font-mono">{tr("rateColon")} {rate}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono">
                      <div className="flex flex-col gap-0.5">
                        <span>{fmt(lc.totalAmount)}{isFx && <span className="text-[10px] text-muted-foreground"> {lc.currencyCode}</span>}</span>
                        {isFx && <span className="text-[10px] text-primary font-semibold">{fmt(lcBase)} {lc.baseCurrency}</span>}
                        {expBase > 0 && (
                          <span
                            className="text-[10px] text-amber-700"
                            title={tr("loadedCostTooltip", { lc: fmt(lcBase), exp: fmt(expBase), total: fmt(lcBase + expBase), cur: lc.baseCurrency || "" })}
                          >
                            + {fmt(expBase)} {tr("expensesShort")} = {fmt(lcBase + expBase)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono">
                      <span className="text-rose-700">{fmt(usedBase)}{isFx && <span className="text-[10px] text-muted-foreground"> {lc.baseCurrency}</span>}</span>
                    </td>
                    <td className="px-3 py-2.5 font-mono">
                      <span className={cn(remBase < 0 ? "text-red-700" : "text-green-700")}>
                        {fmt(remBase)}{isFx && <span className="text-[10px] text-muted-foreground"> {lc.baseCurrency}</span>}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border", st.cls)}>{st.label}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-primary" title={tr("aiTooltip")}
                          onClick={() => runAiJournal(lc)} disabled={aiLoading && aiLc?.id === lc.id}>
                          {aiLoading && aiLc?.id === lc.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-emerald-600"
                          title={isClosed ? tr("closedLockedTooltip") : tr("transferTooltip")}
                          disabled={!lc.settlementAccountId || isClosed}
                          onClick={() => openTransfer(lc)}>
                          <Banknote className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className={cn("h-7 w-7", isClosed ? "text-emerald-600" : "text-amber-600")}
                          title={isClosed ? tr("reopenTooltip") : tr("closeTooltip")}
                          disabled={toggleStatusMut.isPending}
                          onClick={() => {
                            const action: "close" | "reopen" = isClosed ? "reopen" : "close";
                            const confirmKey = isClosed ? "reopenConfirm" : "closeConfirm";
                            if (confirm(tr(confirmKey))) toggleStatusMut.mutate({ id: lc.id, action });
                          }}>
                          {isClosed ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7"
                          title={isClosed ? tr("closedLockedTooltip") : undefined}
                          disabled={isClosed}
                          onClick={() => handleEdit(lc)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                          title={isClosed ? tr("closedLockedTooltip") : undefined}
                          disabled={isClosed}
                          onClick={() => { if (confirm(tr("deleteConfirm"))) deleteMut.mutate(lc.id); }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <Dialog open={!!aiLc} onOpenChange={(o) => { if (!o) { setAiLc(null); setAiPreview(null); } }}>
        <DialogContent className="max-w-2xl" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              {tr("aiTitle", { n: aiLc?.lcNumber ?? "" })}
            </DialogTitle>
          </DialogHeader>

          {aiLoading || !aiPreview ? (
            <div className="py-10 text-center text-sm text-muted-foreground flex flex-col items-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              {tr("aiGenerating")}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-sm">
                <div className="text-muted-foreground text-xs mb-1">{tr("aiDescription")}</div>
                <div className="font-medium">{aiPreview.description}</div>
              </div>

              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className={`${align} px-3 py-2 font-semibold`}>{tr("aiColAccount")}</th>
                      <th className={`${align} px-3 py-2 font-semibold`}>{tr("aiColDescription")}</th>
                      <th className={`${oppAlign} px-3 py-2 font-semibold`}>{tr("aiColDebit")}</th>
                      <th className={`${oppAlign} px-3 py-2 font-semibold`}>{tr("aiColCredit")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aiPreview.lines.map((l: any, i: number) => (
                      <tr key={i} className="border-t">
                        <td className="px-3 py-2"><span className="font-mono text-xs text-muted-foreground">{l.accountCode}</span> — {pickName(l.accountNameAr, l.accountNameEn)}</td>
                        <td className="px-3 py-2 text-muted-foreground text-xs">{l.description}</td>
                        <td className={`px-3 py-2 font-mono ${oppAlign}`}>{l.debit > 0 ? fmt(l.debit) : "—"}</td>
                        <td className={`px-3 py-2 font-mono ${oppAlign}`}>{l.credit > 0 ? fmt(l.credit) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/40 border-t font-semibold">
                      <td colSpan={2} className="px-3 py-2 text-xs text-muted-foreground">{tr("aiTotal")}</td>
                      <td className={`px-3 py-2 font-mono ${oppAlign}`}>{fmt(aiPreview.totalDebit)}</td>
                      <td className={`px-3 py-2 font-mono ${oppAlign}`}>{fmt(aiPreview.totalCredit)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {aiPreview.reasoning && (
                <div className="rounded-lg border bg-primary/5 p-3 text-xs leading-relaxed">
                  <div className="font-semibold text-primary mb-1 flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" />{tr("aiReasoningTitle")}</div>
                  <div className="text-muted-foreground">{aiPreview.reasoning}</div>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" size="sm" onClick={() => { setAiLc(null); setAiPreview(null); }} disabled={aiSaving}>{tr("aiCancel")}</Button>
            <Button size="sm" className="gap-2" onClick={confirmAiJournal} disabled={!aiPreview || aiSaving}>
              {aiSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {aiSaving ? tr("aiSaving") : tr("aiApprove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Bank-transfer (LC funding) dialog ───────────────────────── */}
      <Dialog open={!!transferLc} onOpenChange={(o) => { if (!o) setTransferLc(null); }}>
        <DialogContent className="max-w-lg" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Banknote className="h-5 w-5 text-emerald-600" />
              {tr("transferTitle", { lc: transferLc?.lcNumber ?? "" })}
            </DialogTitle>
          </DialogHeader>
          {transferLc && (() => {
            const amt    = Number(transferForm.amount || 0);
            const rate   = Number(transferForm.exchangeRate || 1);
            const base   = +(amt * rate).toFixed(2);
            const lcExps = (transferLc.expenses ?? []) as any[];
            const selExp = transferForm.target === "expense"
              ? lcExps.find((e: any) => String(e.id) === String(transferForm.expenseId))
              : null;
            // Currency/rate context follows the chosen target: when paying an
            // expense, the dialog speaks in the expense's own currency.
            const ccy    = (transferForm.target === "expense"
              ? (selExp?.currencyCode ?? transferLc.currencyCode)
              : transferLc.currencyCode) ?? baseCode;
            const isFx   = ccy !== baseCode;
            const list   = transferForm.sourceType === "bank" ? bankAccounts : cashBoxes;
            // Debit-side label shown in the JE preview.
            const debitLbl = transferForm.target === "settlement"
              ? tr("fSettlementAccount")
              : (selExp?.expenseType ?? tr("transferExpenseLabel"));
            const targetMissing =
              (transferForm.target === "settlement" && !transferLc.settlementAccountId) ||
              (transferForm.target === "expense" && (!selExp || !selExp.accountId));
            return (
              <div className="space-y-3">
                <div className="text-xs text-muted-foreground p-2 rounded bg-muted/40">
                  {tr("transferHint")}
                </div>
                {/* Target picker — settlement (LC goods) vs a specific expense */}
                <div className="flex gap-2 p-1 rounded-lg bg-muted/40 border">
                  <button type="button"
                    className={cn(
                      "flex-1 text-xs font-medium py-2 px-3 rounded-md transition",
                      transferForm.target === "settlement"
                        ? "bg-emerald-600 text-white shadow"
                        : "text-muted-foreground hover:bg-background",
                    )}
                    onClick={() => setTransferForm(p => ({
                      ...p, target: "settlement", expenseId: "",
                      amount: String(transferLc.totalAmount ?? ""),
                      exchangeRate: String(transferLc.exchangeRate ?? "1"),
                    }))}>
                    {tr("transferTargetSettlement")}
                  </button>
                  <button type="button"
                    disabled={lcExps.length === 0}
                    className={cn(
                      "flex-1 text-xs font-medium py-2 px-3 rounded-md transition disabled:opacity-50 disabled:cursor-not-allowed",
                      transferForm.target === "expense"
                        ? "bg-amber-600 text-white shadow"
                        : "text-muted-foreground hover:bg-background",
                    )}
                    onClick={() => setTransferForm(p => ({
                      ...p, target: "expense", expenseId: "", amount: "", exchangeRate: "1",
                    }))}>
                    {tr("transferTargetExpense")}
                    {lcExps.length === 0 && <span className="text-[10px] block">({tr("transferNoExpenses")})</span>}
                  </button>
                </div>

                {transferForm.target === "expense" && (
                  <Field label={tr("transferExpensePick")}>
                    <SearchCombobox
                      value={transferForm.expenseId}
                      onValueChange={(v) => {
                        const e = lcExps.find((x: any) => String(x.id) === String(v));
                        setTransferForm(p => ({
                          ...p,
                          expenseId: v,
                          amount: e ? String(e.amount ?? "") : "",
                          exchangeRate: e ? String(e.exchangeRate ?? "1") : "1",
                        }));
                      }}
                      items={lcExps.map((e: any) => ({
                        value: String(e.id),
                        label: `${e.expenseType ?? "—"} • ${fmt(e.amount)} ${e.currencyCode ?? ""}`,
                      }))}
                      placeholder={tr("transferExpensePh")}
                    />
                  </Field>
                )}

                <FormGrid cols={2}>
                  <Field label={tr("transferDate")}>
                    <Input type="date" value={transferForm.date}
                      onChange={(e) => setTransferForm(p => ({ ...p, date: e.target.value }))} />
                  </Field>
                  <Field label={tr("transferSourceType")}>
                    <select className="h-9 px-2 rounded-md border bg-background text-sm w-full"
                      value={transferForm.sourceType}
                      onChange={(e) => setTransferForm(p => ({
                        ...p, sourceType: e.target.value as "bank" | "cash", sourceId: "",
                      }))}>
                      <option value="bank">{tr("transferSrcBank")}</option>
                      <option value="cash">{tr("transferSrcCash")}</option>
                    </select>
                  </Field>
                  <Field label={transferForm.sourceType === "bank" ? tr("transferBankAcc") : tr("transferCashBox")}>
                    <SearchCombobox
                      value={transferForm.sourceId}
                      onValueChange={(v) => setTransferForm(p => ({ ...p, sourceId: v }))}
                      items={list.filter((s: any) => s.isActive !== false).map((s: any) => ({
                        value: String(s.id),
                        label: `${pickName(s.nameAr, s.nameEn)}${s.bankName ? ` — ${s.bankName}` : ""}`,
                      }))}
                      placeholder={tr("transferSourcePh")}
                    />
                  </Field>
                  <Field label={tr("transferAmount", { ccy })}>
                    <Input type="number" step="0.01" value={transferForm.amount}
                      onChange={(e) => setTransferForm(p => ({ ...p, amount: e.target.value }))} />
                  </Field>
                  {isFx && (
                    <Field label={tr("transferRate", { from: ccy, to: baseCode })}>
                      <Input type="number" step="0.0001" value={transferForm.exchangeRate}
                        onChange={(e) => setTransferForm(p => ({ ...p, exchangeRate: e.target.value }))} />
                    </Field>
                  )}
                </FormGrid>
                <Field label={tr("transferDesc")}>
                  <Textarea rows={2} value={transferForm.description}
                    placeholder={transferForm.target === "settlement"
                      ? tr("transferDefaultDesc", { lc: transferLc.lcNumber })
                      : tr("transferDefaultDescExp", { lc: transferLc.lcNumber, exp: debitLbl })}
                    onChange={(e) => setTransferForm(p => ({ ...p, description: e.target.value }))} />
                </Field>

                {targetMissing && (
                  <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">
                    {transferForm.target === "settlement"
                      ? tr("transferLcMissingSettlement")
                      : tr("transferExpenseAccMissing")}
                  </div>
                )}

                {/* JE preview — Dr <target> / Cr Bank or Cash, in base currency */}
                <div className="rounded-lg border bg-emerald-50/50 border-emerald-200 p-3 text-xs space-y-1.5">
                  <div className="font-semibold text-emerald-800 mb-1">{tr("transferPreview")}</div>
                  <div className="grid grid-cols-3 gap-2 font-mono">
                    <span className="text-muted-foreground">{debitLbl}</span>
                    <span className="text-rose-700 text-end">{fmt(base)} {baseCode}</span>
                    <span className="text-muted-foreground text-end">{tr("transferDr")}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 font-mono">
                    <span className="text-muted-foreground">
                      {transferForm.sourceType === "bank" ? tr("transferSrcBank") : tr("transferSrcCash")}
                    </span>
                    <span className="text-emerald-700 text-end">{fmt(base)} {baseCode}</span>
                    <span className="text-muted-foreground text-end">{tr("transferCr")}</span>
                  </div>
                </div>
              </div>
            );
          })()}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" size="sm" onClick={() => setTransferLc(null)} disabled={fundMut.isPending}>
              {tr("aiCancel")}
            </Button>
            <Button size="sm" className="gap-2 bg-emerald-600 hover:bg-emerald-700"
              onClick={() => fundMut.mutate()} disabled={fundMut.isPending}>
              {fundMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
              {tr("transferConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
