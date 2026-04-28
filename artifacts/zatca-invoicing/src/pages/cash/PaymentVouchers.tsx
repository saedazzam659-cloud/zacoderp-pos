import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { AccountCombobox } from "@/components/AccountCombobox";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { TablePagination, usePagination } from "@/components/TablePagination";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import { ArrowUpCircle, Plus, Pencil, Trash2, Search, CheckCircle2, Clock, Send, Undo2, Sparkles, Loader2 } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);
const EMPTY = { date: today(), paymentType: "cash", cashBoxId: "", bankAccountId: "", entityType: "supplier", entityId: "", entityName: "", amount: "", exchangeRate: "1", refType: "", refNumber: "", description: "", notes: "" };

export default function PaymentVouchers() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const qc = useQueryClient();
  const h = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;
  const NS = "paymentVouchers";

  const ENTITY_LABELS: Record<string, string> = {
    customer: t(`${NS}.customer`),
    supplier: t(`${NS}.supplier`),
    other: t(`${NS}.other`),
  };

  const [search,  setSearch]  = useState("");
  const [panel,   setPanel]   = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form,    setForm]    = useState<typeof EMPTY>(EMPTY);
  // Peek the next code from the central sequence engine while the form panel
  // is open and we are creating (not editing) a voucher.
  const nextCode = useNextSequenceNumber("payment_voucher", panel && !editing);
  const [acctId,  setAcctId]  = useState("");
  const [postRow,   setPostRow]   = useState<any>(null);
  const [delRow,    setDelRow]    = useState<any>(null);
  const [unpostRow, setUnpostRow] = useState<any>(null);
  const [aiBusy,    setAiBusy]    = useState(false);
  const [aiReason,  setAiReason]  = useState("");

  const { data: vouchers = [],     isLoading } = useQuery({ queryKey: ["payment-vouchers", cid], queryFn: () => fetch(`${API}/api/payment-vouchers?companyId=${cid}`, { headers: h }).then(r => r.json()), enabled: !!cid });
  const { data: cashBoxes = [] }               = useQuery({ queryKey: ["cash-boxes", cid],       queryFn: () => fetch(`${API}/api/cash-boxes?companyId=${cid}`, { headers: h }).then(r => r.json()), enabled: !!cid });
  const { data: bankAccounts = [] }            = useQuery({ queryKey: ["bank-accounts", cid],    queryFn: () => fetch(`${API}/api/bank-accounts?companyId=${cid}`, { headers: h }).then(r => r.json()), enabled: !!cid });
  const { data: customers = [] }               = useQuery({ queryKey: ["customers", cid],        queryFn: () => fetch(`${API}/api/customers?companyId=${cid}`, { headers: h }).then(r => r.json()), enabled: !!cid });
  const { data: suppliers = [] }               = useQuery({ queryKey: ["suppliers", cid],        queryFn: () => fetch(`${API}/api/suppliers?companyId=${cid}`, { headers: h }).then(r => r.json()), enabled: !!cid });

  const filtered = (vouchers as any[]).filter((v: any) => v.code?.includes(search) || v.description?.includes(search) || v.entityName?.includes(search));

  const pager = usePagination(filtered);
  const totalAmount = (vouchers as any[]).filter((v: any) => v.status === "posted").reduce((a: number, v: any) => a + parseFloat(v.amount || "0"), 0);

  const ACCT_KEY = `pv:lastAccountId:${cid}`;
  function openAdd()  {
    const last = typeof window !== "undefined" ? localStorage.getItem(ACCT_KEY) || "" : "";
    setEditing(null); setForm({ ...EMPTY, date: today() }); setAcctId(last); setAiReason(""); setPanel(true);
  }
  function openEdit(r: any) { setEditing(r); setForm({ date: r.date, paymentType: r.paymentType || "cash", cashBoxId: r.cashBoxId ? String(r.cashBoxId) : "", bankAccountId: r.bankAccountId ? String(r.bankAccountId) : "", entityType: r.entityType || "supplier", entityId: r.entityId ? String(r.entityId) : "", entityName: r.entityName ?? "", amount: r.amount ?? "", exchangeRate: r.exchangeRate ?? "1", refType: r.refType ?? "", refNumber: r.refNumber ?? "", description: r.description ?? "", notes: r.notes ?? "" }); setAcctId(r.accountId ? String(r.accountId) : ""); setAiReason(""); setPanel(true); }

  async function suggestAccount() {
    setAiBusy(true); setAiReason("");
    try {
      const res = await fetch(`${API}/api/ai/suggest-payment-account?companyId=${cid}`, {
        method: "POST",
        headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: form.entityType,
          entityId: form.entityId ? parseInt(form.entityId) : null,
          entityName: form.entityName,
          description: form.description,
          refType: form.refType,
          refNumber: form.refNumber,
          notes: form.notes,
          amount: Number(form.amount || 0),
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || t(`${NS}.aiFailed`));
      if (j.accountId) {
        setAcctId(String(j.accountId));
        setAiReason(j.reasoning || "");
        toast({ title: t(`${NS}.aiSuggested`), description: j.accountLabel });
      } else {
        toast({ title: t(`${NS}.aiNotFound`), description: j.reasoning, variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: t(`${NS}.aiFailed`), description: parseError(e), variant: "destructive" });
    } finally { setAiBusy(false); }
  }

  function jePreview() {
    const amt = Number(form.amount || 0);
    if (!isFinite(amt) || amt <= 0) return null;
    const cb = (cashBoxes as any[]).find((c: any) => String(c.id) === form.cashBoxId);
    const ba = (bankAccounts as any[]).find((b: any) => String(b.id) === form.bankAccountId);
    const cbName = cb ? (isRtl ? cb.nameAr : (cb.nameEn || cb.nameAr)) : "";
    const baName = ba ? (isRtl ? ba.nameAr : (ba.nameEn || ba.nameAr)) : "";
    const crLabel = form.paymentType === "bank"
      ? (ba ? t(`${NS}.bankPrefix`, { name: baName }) : t(`${NS}.noBankSelected`))
      : (cb ? t(`${NS}.cashPrefix`, { name: cbName }) : t(`${NS}.noCashSelected`));
    const drLabel = acctId ? t(`${NS}.pickedAccount`) :
      (form.entityType === "supplier" && form.entityName) ? t(`${NS}.supplierPrefix`, { name: form.entityName }) :
      (form.entityType === "customer" && form.entityName) ? t(`${NS}.customerPrefix`, { name: form.entityName }) :
      t(`${NS}.noCounter`);
    return { drLabel, crLabel, amount: amt };
  }

  // Honour the company-level "auto-post on save" toggle. When the tenant
  // chose manual posting (autoPostingEnabled === false) the voucher is
  // saved as a draft and the user must explicitly click "اعتماد"; when
  // automatic, we chain the /post call right after the create succeeds —
  // same contract sales/purchase invoices use.
  const autoPostingEnabled = (user as any)?.company?.autoPostingEnabled !== false;
  const saveMut = useMutation({
    mutationFn: async () => {
      const cleanAmt = String(form.amount).replace(/[^\d.\-]/g, "");
      const amtNum = Number(cleanAmt);
      if (!isFinite(amtNum) || amtNum <= 0) throw new Error(t(`${NS}.invalidAmount`));
      const body = { ...form, amount: amtNum.toFixed(2), companyId: cid, accountId: acctId ? parseInt(acctId) : null, cashBoxId: form.cashBoxId ? parseInt(form.cashBoxId) : null, bankAccountId: form.bankAccountId ? parseInt(form.bankAccountId) : null, entityId: form.entityId ? parseInt(form.entityId) : null };
      const url = editing ? `${API}/api/payment-vouchers/${editing.id}` : `${API}/api/payment-vouchers`;
      const res = await fetch(url, { method: editing ? "PUT" : "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      const j = await res.json();
      if (autoPostingEnabled && j?.id && (j.status ?? "draft") === "draft") {
        // The voucher itself is already in the DB; treat a post failure
        // as "saved as draft, posting failed" instead of throwing — that
        // way the panel still closes and the user doesn't accidentally
        // re-submit and create a duplicate voucher.
        const pr = await fetch(`${API}/api/payment-vouchers/${j.id}/post`, { method: "POST", headers: h });
        const pj = await pr.json().catch(() => ({}));
        if (!pr.ok) return { ...j, _posted: false, _postError: pj?.error || pr.statusText };
        return { ...pj, _posted: true };
      }
      return { ...j, _posted: false };
    },
    onSuccess: (data: any) => {
      try { if (acctId) localStorage.setItem(ACCT_KEY, acctId); } catch {}
      qc.invalidateQueries({ queryKey: ["payment-vouchers"] });
      setPanel(false);
      if (data?._postError) {
        toast({
          variant: "destructive",
          title: t(`${NS}.savedButPostFailed`, "تم الحفظ كمسودة — لكن فشل الترحيل"),
          description: data._postError,
        });
      } else {
        toast({
          title: editing ? t(`${NS}.saved_update`) : t(`${NS}.saved_create`),
          description: data?._posted === false ? t(`${NS}.savedDraftHint`, "تم الحفظ كمسودة — الترحيل يدوي") : undefined,
        });
      }
    },
    onError: (e: any) => toast({ title: t(`${NS}.err_save`), description: parseError(e), variant: "destructive" }),
  });

  const postMut = useMutation({
    mutationFn: async (id: number) => { const res = await fetch(`${API}/api/payment-vouchers/${id}/post`, { method: "POST", headers: h }); if (!res.ok) throw new Error((await res.json()).error); return res.json(); },
    onSuccess: () => { toast({ title: t(`${NS}.posted_toast`) }); qc.invalidateQueries({ queryKey: ["payment-vouchers"] }); setPostRow(null); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => { const res = await fetch(`${API}/api/payment-vouchers/${id}`, { method: "DELETE", headers: h }); if (!res.ok && res.status !== 204) throw new Error((await res.json()).error); },
    onSuccess: () => { toast({ title: t(`${NS}.deleted_toast`) }); qc.invalidateQueries({ queryKey: ["payment-vouchers"] }); setDelRow(null); },
    onError: (e: any) => toast({ title: e.message || t(`${NS}.err_delete`), variant: "destructive" }),
  });

  const unpostMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/payment-vouchers/${id}/unpost`, { method: "POST", headers: h });
      if (!res.ok) throw new Error((await res.json()).error || t(`${NS}.err_unpost`));
      return res.json();
    },
    onSuccess: () => { toast({ title: t(`${NS}.unposted_toast`) }); qc.invalidateQueries({ queryKey: ["payment-vouchers"] }); setUnpostRow(null); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function f(name: keyof typeof EMPTY) { return { value: form[name] as string, onChange: (e: any) => setForm(p => ({ ...p, [name]: e.target.value })) }; }
  const entityList = form.entityType === "customer" ? customers : form.entityType === "supplier" ? suppliers : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-bold flex items-center gap-2"><ArrowUpCircle className="h-6 w-6 text-red-500" />{t(`${NS}.title`)}</h1><p className="text-sm text-muted-foreground mt-1">{t(`${NS}.subtitle`)}</p></div>
        <Button onClick={openAdd} className="gap-2"><Plus className="h-4 w-4" />{t(`${NS}.newVoucher`)}</Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: t(`${NS}.totalVouchers`), value: (vouchers as any[]).length, color: "text-primary bg-primary/10" },
          { label: t(`${NS}.posted`),         value: (vouchers as any[]).filter((v: any) => v.status === "posted").length, color: "text-green-700 bg-green-100" },
          { label: t(`${NS}.totalAmount`),    value: fmt(totalAmount), color: "text-red-700 bg-red-50" },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border bg-card p-4">
            <p className="text-xl font-bold">{isLoading ? "—" : s.value}</p>
            <p className={`text-xs mt-1 font-medium px-2 py-0.5 rounded-full inline-block ${s.color}`}>{s.label}</p>
          </div>
        ))}
      </div>

      {panel && (
        <FormPanel
          icon={ArrowUpCircle}
          title={editing ? t(`${NS}.editVoucher`) : t(`${NS}.newLong`)}
          subtitle={t(`${NS}.formSubtitle`)}
          width="4xl"
          onClose={() => setPanel(false)}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveDisabled={!form.amount || !form.date}
        >
          <FormGrid>
            <Field label={t(`${NS}.code`)}>
              <Input
                value={editing ? (editing.code ?? "") : (nextCode.number ?? (nextCode.loading ? "..." : t(`${NS}.autoCode`)))}
                readOnly
                disabled
                className="font-mono text-sm bg-muted/30"
                data-testid="input-payment-code"
              />
            </Field>
            <Field label={t(`${NS}.date`)} required><Input type="date" {...f("date")} /></Field>
            <Field label={t(`${NS}.paymentMethod`)}>
              <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.paymentType} onChange={e => setForm(p => ({ ...p, paymentType: e.target.value, cashBoxId: "", bankAccountId: "" }))}>
                <option value="cash">{t(`${NS}.cash`)}</option><option value="bank">{t(`${NS}.bank`)}</option>
              </select>
            </Field>
            {form.paymentType === "cash" ? (
              <Field label={t(`${NS}.cashBox`)} className="md:col-span-2">
                <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.cashBoxId} onChange={e => setForm(p => ({ ...p, cashBoxId: e.target.value }))}>
                  <option value="">{t(`${NS}.selectCashBox`)}</option>{(cashBoxes as any[]).map((c: any) => <option key={c.id} value={c.id}>{isRtl ? c.nameAr : (c.nameEn || c.nameAr)}</option>)}
                </select>
              </Field>
            ) : (
              <Field label={t(`${NS}.bankAccount`)} className="md:col-span-2">
                <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.bankAccountId} onChange={e => setForm(p => ({ ...p, bankAccountId: e.target.value }))}>
                  <option value="">{t(`${NS}.selectBank`)}</option>{(bankAccounts as any[]).map((b: any) => <option key={b.id} value={b.id}>{isRtl ? b.nameAr : (b.nameEn || b.nameAr)}</option>)}
                </select>
              </Field>
            )}
            <Field label={t(`${NS}.entityType`)}>
              <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.entityType} onChange={e => setForm(p => ({ ...p, entityType: e.target.value, entityId: "", entityName: "" }))}>
                <option value="customer">{t(`${NS}.customer`)}</option><option value="supplier">{t(`${NS}.supplier`)}</option><option value="other">{t(`${NS}.other`)}</option>
              </select>
            </Field>
            {form.entityType === "other" ? (
              <Field label={t(`${NS}.entityName`)}><Input placeholder="..." {...f("entityName")} /></Field>
            ) : (
              <Field label={form.entityType === "customer" ? t(`${NS}.customer`) : t(`${NS}.supplier`)}>
                <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.entityId} onChange={e => { const found = (entityList as any[]).find((x: any) => String(x.id) === e.target.value); setForm(p => ({ ...p, entityId: e.target.value, entityName: (isRtl ? found?.nameAr : (found?.nameEn || found?.nameAr)) || "" })); }}>
                  <option value="">{t(`${NS}.selectEntity`)}</option>{(entityList as any[]).map((e: any) => <option key={e.id} value={e.id}>{isRtl ? e.nameAr : (e.nameEn || e.nameAr)}</option>)}
                </select>
              </Field>
            )}
            <Field label={t(`${NS}.counterAccount`)} className="md:col-span-2">
              <div className="flex gap-2 items-stretch">
                <div className="flex-1"><AccountCombobox value={acctId} onValueChange={setAcctId} placeholder={t("cashCommon.selectAccount")} grouped={false} /></div>
                <Button type="button" variant="outline" size="sm" onClick={suggestAccount} disabled={aiBusy} className="gap-1.5 shrink-0 text-purple-700 border-purple-300 hover:bg-purple-50" title={t(`${NS}.aiTitle`)}>
                  {aiBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {t(`${NS}.aiSuggest`)}
                </Button>
              </div>
              {aiReason && <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed bg-purple-50/50 border border-purple-100 rounded p-2">{aiReason}</p>}
            </Field>
            <Field label={t(`${NS}.amount`)} required><Input type="number" step="0.01" placeholder="0.00" dir="ltr" className="text-left" {...f("amount")} /></Field>
            <Field label={t(`${NS}.exchangeRate`)}><Input type="number" step="0.000001" placeholder="1" dir="ltr" className="text-left" {...f("exchangeRate")} /></Field>
            <Field label={t(`${NS}.refType`)}><Input placeholder={t(`${NS}.refTypePh`)} {...f("refType")} /></Field>
            <Field label={t(`${NS}.refNumber`)}><Input placeholder="INV-0001" dir="ltr" className="text-left" {...f("refNumber")} /></Field>
            <Field label={t(`${NS}.description`)} className="md:col-span-2"><Input placeholder={t(`${NS}.descriptionPh`)} {...f("description")} /></Field>
            <Field label={t("cashCommon.notes")} className="md:col-span-2"><Input placeholder={t("cashCommon.notesPlaceholder")} {...f("notes")} /></Field>
          </FormGrid>

          {(() => {
            const p = jePreview();
            if (!p) return null;
            return (
              <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50/40 p-3">
                <p className="text-xs font-semibold text-blue-900 mb-2">{t(`${NS}.jePreview`)}</p>
                <table className="w-full text-xs">
                  <thead><tr className="text-blue-800/70"><th className="text-start pb-1">{t(`${NS}.jeCol`)}</th><th className={`${isRtl ? "text-left pl-2" : "text-right pr-2"} pb-1`}>{t(`${NS}.jeDr`)}</th><th className={`${isRtl ? "text-left" : "text-right"} pb-1`}>{t(`${NS}.jeCr`)}</th></tr></thead>
                  <tbody className="font-mono">
                    <tr className="border-t border-blue-200/60"><td className="py-1 text-start">{p.drLabel}</td><td className={`${isRtl ? "text-left pl-2" : "text-right pr-2"}`}>{fmt(p.amount)}</td><td className={`${isRtl ? "text-left" : "text-right"}`}>—</td></tr>
                    <tr className="border-t border-blue-200/60"><td className="py-1 text-start">{p.crLabel}</td><td className={`${isRtl ? "text-left pl-2" : "text-right pr-2"}`}>—</td><td className={`${isRtl ? "text-left" : "text-right"}`}>{fmt(p.amount)}</td></tr>
                  </tbody>
                </table>
              </div>
            );
          })()}
        </FormPanel>
      )}

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-medium">{t(`${NS}.list`)}</p>
          <div className="relative">
            <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
            <Input className={`${isRtl ? "pr-9" : "pl-9"} h-8 w-56 text-sm`} placeholder={t("cashCommon.search")} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/20 text-xs text-muted-foreground">
              <th className="h-9 px-4 text-start font-medium">{t(`${NS}.colCodeDate`)}</th>
              <th className="h-9 px-4 text-start font-medium">{t(`${NS}.colDescription`)}</th>
              <th className="h-9 px-4 text-start font-medium hidden md:table-cell">{t(`${NS}.colEntity`)}</th>
              <th className="h-9 px-4 text-start font-medium hidden md:table-cell">{t(`${NS}.colMethod`)}</th>
              <th className="h-9 px-4 text-start font-medium">{t(`${NS}.colAmount`)}</th>
              <th className="h-9 px-4 text-center font-medium hidden lg:table-cell">{t(`${NS}.colJournalNo`)}</th>
              <th className="h-9 px-4 text-center font-medium">{t(`${NS}.colStatus`)}</th>
              <th className="h-9 px-4 text-center font-medium w-28">{t(`${NS}.colActions`)}</th>
            </tr></thead>
            <tbody>
              {isLoading ? Array.from({ length: 4 }).map((_, i) => (<tr key={i} className="border-b"><td colSpan={8} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td></tr>))
              : filtered.length === 0 ? (
                <tr><td colSpan={8} className="py-14 text-center text-muted-foreground">
                  <ArrowUpCircle className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">{search ? t("cashCommon.noResults") : t(`${NS}.noVouchers`)}</p>
                  {!search && <Button variant="outline" size="sm" className="mt-3" onClick={openAdd}><Plus className={`h-3.5 w-3.5 ${isRtl ? "ml-1" : "mr-1"}`} />{t(`${NS}.newVoucher`)}</Button>}
                </td></tr>
              ) : pager.pagedItems.map((row: any) => (
                <tr key={row.id} onDoubleClick={() => openEdit(row)} className="border-b hover:bg-muted/20 transition-colors cursor-pointer" title={t("cashCommon.doubleClickEdit")}>
                  <td className="px-4 py-3"><p className="font-mono text-xs font-medium">{row.code}</p><p className="text-xs text-muted-foreground">{row.date}</p></td>
                  <td className="px-4 py-3 max-w-48"><p className="text-sm truncate">{row.description || "—"}</p>{row.refNumber && <p className="text-xs text-muted-foreground">{t(`${NS}.ref`, { value: row.refNumber })}</p>}</td>
                  <td className="px-4 py-3 hidden md:table-cell"><span className="text-xs bg-muted px-2 py-0.5 rounded-full">{ENTITY_LABELS[row.entityType] || "—"}</span>{row.entityName && <p className="text-xs text-muted-foreground mt-0.5">{row.entityName}</p>}</td>
                  <td className="px-4 py-3 hidden md:table-cell"><span className={`text-xs px-2 py-0.5 rounded-full ${row.paymentType === "cash" ? "bg-amber-50 text-amber-700" : "bg-blue-50 text-blue-700"}`}>{row.paymentType === "cash" ? t(`${NS}.cash`) : t(`${NS}.bank`)}</span></td>
                  <td className="px-4 py-3 font-medium text-red-600">{fmt(row.amount)}</td>
                  <td className="px-4 py-3 text-center hidden lg:table-cell">{row.journalEntryId ? <a href={`${import.meta.env.BASE_URL}accounting/journals/${row.journalEntryId}?tab=lines`} className="text-xs font-mono text-primary hover:underline" title={t(`${NS}.viewJournal`)}>JE-{row.journalEntryId}</a> : <span className="text-xs text-muted-foreground">—</span>}</td>
                  <td className="px-4 py-3 text-center">{row.status === "posted" ? <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full"><CheckCircle2 className="h-3 w-3" />{t("cashCommon.posted")}</span> : <span className="inline-flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full"><Clock className="h-3 w-3" />{t("cashCommon.draft")}</span>}</td>
                  <td className="px-4 py-3 text-center"><div className="flex justify-center gap-1">{row.status === "draft" ? <><button onClick={() => openEdit(row)} className="p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors" title={t("cashCommon.edit")}><Pencil className="h-3.5 w-3.5" /></button><button onClick={() => setPostRow(row)} className="p-1.5 rounded hover:bg-green-50 text-muted-foreground hover:text-green-600 transition-colors" title={t(`${NS}.postBtn`)}><Send className="h-3.5 w-3.5" /></button><button onClick={() => setDelRow(row)} className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors" title={t("cashCommon.delete")}><Trash2 className="h-3.5 w-3.5" /></button></> : <button onClick={() => setUnpostRow(row)} className="p-1.5 rounded hover:bg-amber-50 text-muted-foreground hover:text-amber-600 transition-colors" title={t(`${NS}.unpostBtn`)}><Undo2 className="h-3.5 w-3.5" /></button>}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!isLoading && filtered.length > 0 && (
          <TablePagination
            page={pager.page}
            pageSize={pager.pageSize}
            pageCount={pager.pageCount}
            total={pager.total}
            onPageChange={pager.setPage}
            onPageSizeChange={pager.setPageSize}
            itemLabel={t("paymentVouchers.itemLabel", { defaultValue: "سند" })}
          />
        )}
      </div>


      <AlertDialog open={!!postRow} onOpenChange={v => { if (!v) setPostRow(null); }}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader><AlertDialogTitle className="flex items-center gap-2"><Send className="h-5 w-5 text-green-600" />{t(`${NS}.postTitle`)}</AlertDialogTitle><AlertDialogDescription>{t(`${NS}.postBody`, { code: postRow?.code, amount: fmt(postRow?.amount || 0) })}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>{t("cashCommon.cancel")}</AlertDialogCancel><AlertDialogAction className="bg-green-600 hover:bg-green-700" onClick={() => postMut.mutate(postRow.id)} disabled={postMut.isPending}>{postMut.isPending ? t(`${NS}.posting`) : t(`${NS}.postBtn`)}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!unpostRow} onOpenChange={v => { if (!v) setUnpostRow(null); }}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader><AlertDialogTitle className="flex items-center gap-2"><Undo2 className="h-5 w-5 text-amber-600" />{t(`${NS}.unpostTitle`)}</AlertDialogTitle><AlertDialogDescription>{t(`${NS}.unpostBody`, { code: unpostRow?.code })}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>{t("cashCommon.cancel")}</AlertDialogCancel><AlertDialogAction className="bg-amber-600 hover:bg-amber-700" onClick={() => unpostMut.mutate(unpostRow.id)} disabled={unpostMut.isPending}>{unpostMut.isPending ? t(`${NS}.unposting`) : t(`${NS}.unpostBtn`)}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!delRow} onOpenChange={v => { if (!v) setDelRow(null); }}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader><AlertDialogTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5 text-destructive" />{t(`${NS}.delTitle`)}</AlertDialogTitle><AlertDialogDescription>{t(`${NS}.delBody`, { code: delRow?.code })}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>{t("cashCommon.cancel")}</AlertDialogCancel><AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={() => delMut.mutate(delRow.id)} disabled={delMut.isPending}>{delMut.isPending ? t(`${NS}.deleting`) : t(`${NS}.delBtn`)}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
