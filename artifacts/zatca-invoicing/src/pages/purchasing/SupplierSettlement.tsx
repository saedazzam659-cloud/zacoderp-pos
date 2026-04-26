import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Plus, Trash2, Banknote, CheckCircle } from "lucide-react";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

const EMPTY = { docNumber: "", settlementDate: today(), supplierId: "", paymentMethod: "bank", accountId: "", amount: "", currencyCode: "SAR", exchangeRate: "1", notes: "" };

export default function SupplierSettlement() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const fmt = (n: any) => Number(n || 0).toLocaleString(isRtl ? "ar-SA" : "en-US", { minimumFractionDigits: 2 });
  const supName = (s: any) => isRtl ? (s?.nameAr ?? s?.nameEn ?? "") : (s?.nameEn ?? s?.nameAr ?? "");
  const accName = (a: any) => isRtl ? (a?.nameAr ?? a?.nameEn ?? "") : (a?.nameEn ?? a?.nameAr ?? "");

  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH   = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState<any>(EMPTY);

  const { data: settlements = [], isLoading } = useQuery<any[]>({
    queryKey: ["supplier-settlements", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/purchasing/supplier-settlements?companyId=${cid}` : `${API}/api/purchasing/supplier-settlements`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["supplier-settlements"] });

  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`${API}/api/purchasing/supplier-settlements`, { method: "POST", headers, body: JSON.stringify({ ...data, companyId: cid }) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: () => { invalidate(); reset(); toast({ title: t("purchasingPages.supplierSettlement.toasts.saved") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/supplier-settlements/${id}/post`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("purchasingPages.supplierSettlement.toasts.posted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/supplier-settlements/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: t("purchasingPages.supplierSettlement.toasts.deleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function reset() { setForm(EMPTY); setShowForm(false); }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMut.mutate({ ...form, supplierId: form.supplierId || null, accountId: form.accountId || null });
  }

  const supplierItems = [{ value: "", label: t("purchasingPages.supplierSettlement.selectSupplierOpt") }, ...suppliers.map((s: any) => ({ value: String(s.id), label: supName(s) }))];
  const accountItems  = [{ value: "", label: t("purchasingPages.supplierSettlement.selectAccountOpt") }, ...accounts.filter((a: any) => a.isPosting).map((a: any) => ({ value: String(a.id), label: `${a.code} — ${accName(a)}` }))];
  const supMap = Object.fromEntries(suppliers.map((s: any) => [s.id, supName(s)]));
  const accMap = Object.fromEntries(accounts.map((a: any) => [a.id, `${a.code} — ${accName(a)}`]));

  const totalPosted = settlements.filter((s: any) => s.status === "posted").reduce((t: number, s: any) => t + Number(s.amount || 0), 0);

  const cols = [
    t("purchasingPages.supplierSettlement.cols.docNumber"),
    t("purchasingPages.supplierSettlement.cols.date"),
    t("purchasingPages.supplierSettlement.cols.supplier"),
    t("purchasingPages.supplierSettlement.cols.method"),
    t("purchasingPages.supplierSettlement.cols.account"),
    t("purchasingPages.supplierSettlement.cols.amount"),
    t("purchasingPages.supplierSettlement.cols.currency"),
    t("purchasingPages.supplierSettlement.cols.status"),
    t("purchasingPages.supplierSettlement.cols.actions"),
  ];

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Banknote className="h-6 w-6 text-primary" />{t("purchasingPages.supplierSettlement.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("purchasingPages.supplierSettlement.subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />{t("purchasingPages.supplierSettlement.newSettlement")}
        </Button>
      </div>

      {showForm && (
        <FormPanel
          icon={Banknote}
          title={t("purchasingPages.supplierSettlement.newDialogTitle")}
          subtitle={t("purchasingPages.supplierSettlement.newDialogSubtitle")}
          width="4xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={saveMut.isPending}
          saveDisabled={!form.settlementDate || !form.supplierId || !form.amount}
          saveLabel={t("purchasingPages.supplierSettlement.saveLabel")}
        >
          <FormGrid>
            <Field label={t("purchasingPages.supplierSettlement.fields.docNumber")}><Input placeholder={t("purchasingPages.supplierSettlement.fields.docNumberPh")} value={form.docNumber} onChange={e => setForm((p: any) => ({ ...p, docNumber: e.target.value }))} /></Field>
            <Field label={t("purchasingPages.supplierSettlement.fields.date")} required><Input type="date" value={form.settlementDate} onChange={e => setForm((p: any) => ({ ...p, settlementDate: e.target.value }))} /></Field>
            <Field label={t("purchasingPages.supplierSettlement.fields.supplier")} required className="md:col-span-2">
              <SearchCombobox items={supplierItems} value={form.supplierId} onValueChange={v => setForm((p: any) => ({ ...p, supplierId: v }))} placeholder={t("purchasingPages.supplierSettlement.fields.supplierPh")} />
            </Field>
            <Field label={t("purchasingPages.supplierSettlement.fields.paymentMethod")}>
              <Select value={form.paymentMethod} onValueChange={v => setForm((p: any) => ({ ...p, paymentMethod: v }))}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank">{t("purchasingPages.supplierSettlement.methods.bank")}</SelectItem>
                  <SelectItem value="cash">{t("purchasingPages.supplierSettlement.methods.cash")}</SelectItem>
                  <SelectItem value="check">{t("purchasingPages.supplierSettlement.methods.check")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("purchasingPages.supplierSettlement.fields.bankAccount")}>
              <SearchCombobox items={accountItems} value={form.accountId} onValueChange={v => setForm((p: any) => ({ ...p, accountId: v }))} placeholder={t("purchasingPages.supplierSettlement.fields.accountPh")} />
            </Field>
            <Field label={t("purchasingPages.supplierSettlement.fields.amount")} required><Input type="text" inputMode="decimal" placeholder="0.00" dir="ltr" className="text-left" value={form.amount} onChange={e => setForm((p: any) => ({ ...p, amount: e.target.value.replace(/[^0-9.]/g, "") }))} /></Field>
            <Field label={t("purchasingPages.supplierSettlement.fields.currency")}><Input placeholder="SAR" dir="ltr" className="text-left" value={form.currencyCode} onChange={e => setForm((p: any) => ({ ...p, currencyCode: e.target.value }))} /></Field>
            <Field label={t("purchasingPages.supplierSettlement.fields.notes")} className="md:col-span-2">
              <Textarea className="resize-none text-sm" rows={2} value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
            </Field>
          </FormGrid>
        </FormPanel>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground mb-1">{t("purchasingPages.supplierSettlement.stats.total")}</p>
          <p className="text-xl font-bold text-primary">{settlements.length}</p>
        </div>
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground mb-1">{t("purchasingPages.supplierSettlement.stats.posted")}</p>
          <p className="text-xl font-bold text-green-700">{settlements.filter((s: any) => s.status === "posted").length}</p>
        </div>
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground mb-1">{t("purchasingPages.supplierSettlement.stats.totalPaid")}</p>
          <p className="text-xl font-bold font-mono text-primary">{fmt(totalPosted)}</p>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? <div className="p-12 text-center text-muted-foreground text-sm">{t("purchasingPages.supplierSettlement.loading")}</div>
          : settlements.length === 0 ? <div className="p-12 text-center text-muted-foreground text-sm">{t("purchasingPages.supplierSettlement.noSettlements")}</div>
          : (
          <table className="w-full text-sm">
            <thead><tr className="bg-muted/50 border-b">
              {cols.map(h =>
                <th key={h} className={cn("px-3 py-3 font-semibold text-muted-foreground text-xs", isRtl ? "text-right" : "text-left")}>{h}</th>)}
            </tr></thead>
            <tbody>
              {settlements.map((s: any) => (
                <tr key={s.id} className="border-b hover:bg-muted/30">
                  <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{s.docNumber ?? `SS-${s.id}`}</td>
                  <td className="px-3 py-2.5">{s.settlementDate}</td>
                  <td className="px-3 py-2.5">{supMap[s.supplierId] ?? "—"}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {s.paymentMethod === "bank"
                      ? t("purchasingPages.supplierSettlement.methods.bank")
                      : s.paymentMethod === "cash"
                        ? t("purchasingPages.supplierSettlement.methods.cash")
                        : t("purchasingPages.supplierSettlement.methods.check")}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{accMap[s.accountId] ?? "—"}</td>
                  <td className="px-3 py-2.5 font-mono font-semibold">{fmt(s.amount)}</td>
                  <td className="px-3 py-2.5">{s.currencyCode}</td>
                  <td className="px-3 py-2.5">
                    <span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border",
                      s.status === "posted" ? "bg-green-50 text-green-700 border-green-200" : "bg-amber-50 text-amber-700 border-amber-200"
                    )}>{s.status === "posted" ? t("purchasingPages.supplierSettlement.postedF") : t("purchasingPages.supplierSettlement.draft")}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex gap-1">
                      {s.status === "draft" && (
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-green-700" title={t("purchasingPages.supplierSettlement.postTip")}
                          onClick={() => { if (confirm(t("purchasingPages.supplierSettlement.confirmPost"))) postMut.mutate(s.id); }}>
                          <CheckCircle className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {s.status === "draft" && (
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => { if (confirm(t("purchasingPages.supplierSettlement.confirmDelete"))) deleteMut.mutate(s.id); }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}
