import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Plus, Trash2, ArrowDownCircle, CheckCircle, Printer } from "lucide-react";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { cn } from "@/lib/utils";
import { buildVoucherPrintHtml, openVoucherPrintWindow } from "@/lib/voucherPrint";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const fmt = (n: any) => Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

const EMPTY = { docNumber: "", settlementDate: today(), customerId: "", paymentMethod: "bank", accountId: "", amount: "", currencyCode: "SAR", exchangeRate: "1", notes: "" };

export default function CustomerSettlement() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH   = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState<any>(EMPTY);

  const { data: settlements = [], isLoading } = useQuery<any[]>({
    queryKey: ["customer-settlements", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/sales/customer-settlements?companyId=${cid}` : `${API}/api/sales/customer-settlements`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["customer-settlements"] });

  // Pull the per-doc-type print preferences for receipt vouchers so
  // the form can auto-print after save and the row-level button can
  // honour the chosen template (A4 vs thermal).
  const autoPrintReceipt = !!(user as any)?.company?.printAutoAfterSaveReceipt;
  const receiptTemplate: "a4" | "thermal" =
    ((user as any)?.company?.printTemplateReceipt === "thermal") ? "thermal" : "a4";

  // Print one settlement (used by the row "Print" button and by the
  // post-save auto-print hook). Resolves the customer, account, and
  // company snapshots locally so the popup is fully self-contained.
  function printOne(s: any, template: "a4" | "thermal" = receiptTemplate) {
    const customer = customers.find((c: any) => Number(c.id) === Number(s.customerId)) || null;
    const account  = accounts.find((a: any) => Number(a.id) === Number(s.accountId)) || null;
    const html = buildVoucherPrintHtml({
      kind: "receipt",
      template,
      doc: s,
      counterparty: customer,
      account,
      company: user?.company ?? null,
    });
    openVoucherPrintWindow(html);
  }

  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`${API}/api/sales/customer-settlements`, { method: "POST", headers, body: JSON.stringify({ ...data, companyId: cid }) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: (saved: any) => {
      invalidate();
      // Open the print popup synchronously off the user-initiated save
      // click so popup blockers continue to allow it. We do this before
      // resetting the form so customer/account lookups still resolve.
      if (autoPrintReceipt && saved) {
        try { printOne(saved, receiptTemplate); } catch { /* ignore popup-blocker noise */ }
      }
      reset();
      toast({ title: "تم حفظ التحصيل" });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/customer-settlements/${id}/post`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "تم ترحيل التحصيل" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/customer-settlements/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function reset() { setForm(EMPTY); setShowForm(false); }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMut.mutate({ ...form, customerId: form.customerId || null, accountId: form.accountId || null });
  }

  const customerItems = [{ value: "", label: "— اختر العميل —" }, ...customers.map((c: any) => ({ value: String(c.id), label: c.nameAr ?? c.nameEn ?? `#${c.id}` }))];
  const accountItems  = [{ value: "", label: "— حساب البنك/الخزنة —" }, ...accounts.filter((a: any) => a.isPosting).map((a: any) => ({ value: String(a.id), label: `${a.code} — ${a.nameAr}` }))];
  const cusMap = Object.fromEntries(customers.map((c: any) => [c.id, c.nameAr ?? c.nameEn]));
  const accMap = Object.fromEntries(accounts.map((a: any) => [a.id, `${a.code} — ${a.nameAr}`]));

  const totalPosted = settlements.filter((s: any) => s.status === "posted").reduce((t: number, s: any) => t + Number(s.amount || 0), 0);

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><ArrowDownCircle className="h-6 w-6 text-primary" />تحصيل العملاء</h1>
          <p className="text-sm text-muted-foreground mt-1">قبض مستحقات العملاء وترحيل القيود</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />تحصيل جديد
        </Button>
      </div>

      {showForm && (
        <FormPanel
          icon={ArrowDownCircle}
          title="تحصيل جديد"
          subtitle="قبض مستحقات العميل عبر بنك أو نقد أو شيك"
          width="4xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={saveMut.isPending}
          saveDisabled={!form.settlementDate || !form.customerId || !form.amount}
          saveLabel="حفظ التحصيل"
        >
          <FormGrid>
            <Field label="رقم المستند"><Input placeholder="تلقائي" dir="ltr" className="text-left" value={form.docNumber} onChange={e => setForm((p: any) => ({ ...p, docNumber: e.target.value }))} /></Field>
            <Field label="التاريخ" required><Input type="date" value={form.settlementDate} onChange={e => setForm((p: any) => ({ ...p, settlementDate: e.target.value }))} /></Field>
            <Field label="العميل" required className="md:col-span-2">
              <SearchCombobox items={customerItems} value={form.customerId} onValueChange={v => setForm((p: any) => ({ ...p, customerId: v }))} placeholder="اختر العميل..." />
            </Field>
            <Field label="طريقة الدفع">
              <Select value={form.paymentMethod} onValueChange={v => setForm((p: any) => ({ ...p, paymentMethod: v }))}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="bank">تحويل بنكي</SelectItem><SelectItem value="cash">نقدي</SelectItem><SelectItem value="check">شيك</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label="حساب البنك / الخزنة">
              <SearchCombobox items={accountItems} value={form.accountId} onValueChange={v => setForm((p: any) => ({ ...p, accountId: v }))} placeholder="اختر الحساب..." />
            </Field>
            <Field label="المبلغ" required><Input type="text" inputMode="decimal" placeholder="0.00" dir="ltr" className="text-left" value={form.amount} onChange={e => setForm((p: any) => ({ ...p, amount: e.target.value.replace(/[^0-9.]/g, "") }))} /></Field>
            <Field label="العملة"><Input placeholder="SAR" dir="ltr" className="text-left" value={form.currencyCode} onChange={e => setForm((p: any) => ({ ...p, currencyCode: e.target.value }))} /></Field>
            <Field label="ملاحظات" className="md:col-span-2">
              <Textarea className="resize-none text-sm" rows={2} value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
            </Field>
          </FormGrid>
        </FormPanel>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground mb-1">إجمالي التحصيلات</p>
          <p className="text-xl font-bold text-primary">{settlements.length}</p>
        </div>
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground mb-1">المرحّلة</p>
          <p className="text-xl font-bold text-green-700">{settlements.filter((s: any) => s.status === "posted").length}</p>
        </div>
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground mb-1">إجمالي المُحصَّل</p>
          <p className="text-xl font-bold font-mono text-primary">{fmt(totalPosted)}</p>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? <div className="p-12 text-center text-muted-foreground text-sm">جاري التحميل...</div>
          : settlements.length === 0 ? <div className="p-12 text-center text-muted-foreground text-sm">لا توجد تحصيلات بعد</div>
          : (
          <table className="w-full text-sm">
            <thead><tr className="bg-muted/50 border-b">
              {["رقم المستند","التاريخ","العميل","طريقة الدفع","الحساب","المبلغ","العملة","الحالة","إجراءات"].map(h =>
                <th key={h} className="text-right px-3 py-3 font-semibold text-muted-foreground text-xs">{h}</th>)}
            </tr></thead>
            <tbody>
              {settlements.map((s: any) => (
                <tr key={s.id} className="border-b hover:bg-muted/30">
                  <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{s.docNumber ?? `CR-${s.id}`}</td>
                  <td className="px-3 py-2.5">{s.settlementDate}</td>
                  <td className="px-3 py-2.5">{cusMap[s.customerId] ?? "—"}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {s.paymentMethod === "bank" ? "تحويل بنكي" : s.paymentMethod === "cash" ? "نقدي" : "شيك"}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{accMap[s.accountId] ?? "—"}</td>
                  <td className="px-3 py-2.5 font-mono font-semibold">{fmt(s.amount)}</td>
                  <td className="px-3 py-2.5">{s.currencyCode}</td>
                  <td className="px-3 py-2.5">
                    <span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border",
                      s.status === "posted" ? "bg-green-50 text-green-700 border-green-200" : "bg-amber-50 text-amber-700 border-amber-200"
                    )}>{s.status === "posted" ? "مرحّلة" : "مسودة"}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-primary" title="طباعة سند القبض"
                        onClick={() => printOne(s)}>
                        <Printer className="h-3.5 w-3.5" />
                      </Button>
                      {s.status === "draft" && (
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-green-700" title="ترحيل"
                          onClick={() => { if (confirm("ترحيل التحصيل؟")) postMut.mutate(s.id); }}>
                          <CheckCircle className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {s.status === "draft" && (
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => { if (confirm("حذف التحصيل؟")) deleteMut.mutate(s.id); }}>
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
