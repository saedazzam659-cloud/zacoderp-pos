import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Plus, Pencil, Trash2, CreditCard, FileText, ListOrdered, Sparkles, Loader2 } from "lucide-react";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

const EMPTY_LC  = { lcNumber: "", lcDate: today(), supplierId: "", bankName: "", currencyCode: "SAR", totalAmount: "", notes: "" };
const EMPTY_EXP = { expenseType: "", accountId: "", amount: "", currencyCode: "SAR", notes: "" };

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
  const defaultCurrency = currencies.find((c: any) => c.isDefault) ?? currencies[0];

  useEffect(() => {
    if (editId || !defaultCurrency || !showForm) return;
    setForm((p: any) => p.currencyCode && p.currencyCode !== "SAR" ? p : { ...p, currencyCode: defaultCurrency.code });
  }, [defaultCurrency?.code, showForm, editId]);

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

  function reset() { setForm(EMPTY_LC); setExpenses([]); setEditId(null); setShowForm(false); setActiveTab("info"); }

  async function handleEdit(lc: any) {
    const res = await fetch(`${API}/api/purchasing/letters-of-credit/${lc.id}?companyId=${cid}`, { headers: authH });
    const data = await res.json();
    setForm({ lcNumber: data.lcNumber, lcDate: data.lcDate, supplierId: data.supplierId ? String(data.supplierId) : "",
              bankName: data.bankName ?? "", currencyCode: data.currencyCode, totalAmount: String(data.totalAmount), notes: data.notes ?? "" });
    setExpenses(data.expenses ?? []);
    setEditId(lc.id); setShowForm(true); setActiveTab("info");
  }

  function addExpense()    { setExpenses(prev => [...prev, { ...EMPTY_EXP, _id: Date.now() }]); }
  function removeExpense(idx: number) { setExpenses(prev => prev.filter((_, i) => i !== idx)); }
  function updateExpense(idx: number, field: string, value: string) {
    setExpenses(prev => prev.map((e, i) => i === idx ? { ...e, [field]: value } : e));
  }

  const totalExpenses = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const remaining     = Number(form.totalAmount || 0) - totalExpenses;

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
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="gap-2 w-full" onClick={addExpense}><Plus className="h-4 w-4" />{tr("addExpense")}</Button>
              {expenses.length > 0 && (
                <div className="rounded-xl border bg-muted/40 p-4 grid grid-cols-3 gap-4 text-sm text-center">
                  <div><span className="text-muted-foreground block text-xs mb-1">{tr("lcAmount")}</span><span className="font-bold font-mono">{fmt(form.totalAmount)}</span></div>
                  <div><span className="text-muted-foreground block text-xs mb-1">{tr("totalExpenses")}</span><span className="font-bold font-mono text-amber-700">{fmt(totalExpenses)}</span></div>
                  <div><span className="text-muted-foreground block text-xs mb-1">{tr("remaining")}</span><span className={cn("font-bold font-mono", remaining >= 0 ? "text-green-700" : "text-destructive")}>{fmt(remaining)}</span></div>
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
                {[tr("colNumber"), tr("colDate"), tr("colSupplier"), tr("colBank"), tr("colCurrency"), tr("colTotal"), tr("colUsed"), tr("colRemaining"), tr("colStatus"), tr("colActions")].map(h => (
                  <th key={h} className={`${align} px-3 py-3 font-semibold text-muted-foreground text-xs`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lcs.map((lc: any) => {
                const sup = suppliers.find((s: any) => s.id === lc.supplierId);
                const rem = Number(lc.totalAmount || 0) - Number(lc.usedAmount || 0);
                const st  = STATUS_MAP[lc.status] ?? STATUS_MAP.open;
                return (
                  <tr key={lc.id} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{lc.lcNumber}</td>
                    <td className="px-3 py-2.5">{lc.lcDate}</td>
                    <td className="px-3 py-2.5">{sup ? pickName(sup.nameAr, sup.nameEn) : "—"}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{lc.bankName ?? "—"}</td>
                    <td className="px-3 py-2.5">{lc.currencyCode}</td>
                    <td className="px-3 py-2.5 font-mono">{fmt(lc.totalAmount)}</td>
                    <td className="px-3 py-2.5 font-mono text-rose-700">{fmt(lc.usedAmount)}</td>
                    <td className="px-3 py-2.5 font-mono text-green-700">{fmt(rem)}</td>
                    <td className="px-3 py-2.5">
                      <span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border", st.cls)}>{st.label}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-primary" title={tr("aiTooltip")}
                          onClick={() => runAiJournal(lc)} disabled={aiLoading && aiLc?.id === lc.id}>
                          {aiLoading && aiLc?.id === lc.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEdit(lc)}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
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

    </div>
  );
}
