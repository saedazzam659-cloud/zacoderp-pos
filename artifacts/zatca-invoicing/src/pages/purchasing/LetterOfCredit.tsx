import { useState } from "react";
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

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const fmt = (n: any) => Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  open:    { label: "مفتوح",  cls: "bg-green-50 text-green-700 border-green-200" },
  partial: { label: "جزئي",   cls: "bg-amber-50 text-amber-700 border-amber-200" },
  closed:  { label: "مغلق",   cls: "bg-muted text-muted-foreground border-border" },
};

const EMPTY_LC  = { lcNumber: "", lcDate: today(), supplierId: "", bankName: "", currencyCode: "SAR", totalAmount: "", notes: "" };
const EMPTY_EXP = { expenseType: "", accountId: "", amount: "", currencyCode: "SAR", notes: "" };

export default function LetterOfCredit() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const authH   = { Authorization: `Bearer ${token}` };

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

  const invalidate = () => qc.invalidateQueries({ queryKey: ["lc"] });

  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const url = editId ? `${API}/api/purchasing/letters-of-credit/${editId}` : `${API}/api/purchasing/letters-of-credit`;
      const res = await fetch(url, { method: editId ? "PUT" : "POST", headers, body: JSON.stringify({ ...data, companyId: cid }) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: () => { invalidate(); reset(); toast({ title: editId ? "تم التعديل" : "تم إنشاء الاعتماد" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/letters-of-credit/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); },
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
      if (!res.ok) throw new Error(j.error || "فشل الذكاء الاصطناعي");
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
      if (!res.ok) throw new Error(j.error || "فشل حفظ القيد");
      toast({ title: "تم إنشاء القيد المحاسبي", description: `رقم القيد: ${j.entryId}` });
      setAiLc(null); setAiPreview(null);
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
    } finally { setAiSaving(false); }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMut.mutate({ ...form, supplierId: form.supplierId || null, expenses });
  }

  const supplierItems = [{ value: "", label: "— بدون مورد —" }, ...suppliers.map((s: any) => ({ value: String(s.id), label: s.nameAr }))];
  const accountItems  = [{ value: "", label: "— بدون حساب —" }, ...accounts.filter((a: any) => a.isPosting).map((a: any) => ({ value: String(a.id), label: `${a.code} — ${a.nameAr}` }))];

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CreditCard className="h-6 w-6 text-primary" />الاعتمادات المستندية (L/C)
          </h1>
          <p className="text-sm text-muted-foreground mt-1">إدارة الاعتمادات المستندية ومصاريف الاستيراد</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />اعتماد جديد
        </Button>
      </div>

      {showForm && (
        <FormPanel
          icon={CreditCard}
          title={editId ? "تعديل الاعتماد" : "اعتماد مستندي جديد"}
          subtitle="بيانات الاعتماد المستندي ومصاريف الاستيراد المرتبطة به"
          width="4xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={saveMut.isPending}
          saveDisabled={!form.lcNumber || !form.lcDate || !form.totalAmount}
          saveLabel={editId ? "حفظ التعديل" : "إنشاء الاعتماد"}
        >
          <Tabs value={activeTab} onValueChange={setActiveTab} dir="rtl">
            <TabsList className="w-full h-9 mb-4">
              <TabsTrigger value="info" className="flex-1 text-xs gap-1.5"><FileText className="h-3.5 w-3.5" />البيانات الأساسية</TabsTrigger>
              <TabsTrigger value="expenses" className="flex-1 text-xs gap-1.5"><ListOrdered className="h-3.5 w-3.5" />المصاريف ({expenses.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="info" className="mt-0">
              <FormGrid>
                <Field label="رقم الاعتماد" required><Input placeholder="LC-2025-001" dir="ltr" className="text-left" value={form.lcNumber} onChange={e => setForm((p: any) => ({ ...p, lcNumber: e.target.value }))} /></Field>
                <Field label="التاريخ" required><Input type="date" value={form.lcDate} onChange={e => setForm((p: any) => ({ ...p, lcDate: e.target.value }))} /></Field>
                <Field label="المورد"><SearchCombobox items={supplierItems} value={form.supplierId} onValueChange={v => setForm((p: any) => ({ ...p, supplierId: v }))} placeholder="اختر المورد..." /></Field>
                <Field label="البنك"><Input placeholder="اسم البنك" value={form.bankName} onChange={e => setForm((p: any) => ({ ...p, bankName: e.target.value }))} /></Field>
                <Field label="قيمة الاعتماد" required><Input type="text" inputMode="decimal" placeholder="0.00" dir="ltr" className="text-left" value={form.totalAmount} onChange={e => setForm((p: any) => ({ ...p, totalAmount: e.target.value.replace(/[^0-9.]/g, "") }))} /></Field>
                <Field label="العملة"><Input placeholder="SAR" dir="ltr" className="text-left" value={form.currencyCode} onChange={e => setForm((p: any) => ({ ...p, currencyCode: e.target.value }))} /></Field>
                <Field label="ملاحظات" className="md:col-span-2">
                  <Textarea rows={2} className="resize-none text-sm" value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
                </Field>
              </FormGrid>
            </TabsContent>
            <TabsContent value="expenses" className="mt-0 space-y-3">
              {expenses.map((exp, idx) => (
                <div key={exp._id ?? idx} className="space-y-2 p-3 rounded-lg border bg-muted/20">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1"><Label className="text-xs">نوع المصروف</Label><Input className="h-8 text-xs" placeholder="شحن / جمارك..." value={exp.expenseType} onChange={e => updateExpense(idx, "expenseType", e.target.value)} /></div>
                    <div className="space-y-1"><Label className="text-xs">العملة</Label><Input className="h-8 text-xs" placeholder="SAR" value={exp.currencyCode} onChange={e => updateExpense(idx, "currencyCode", e.target.value)} /></div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 items-end">
                    <div className="space-y-1"><Label className="text-xs">الحساب</Label><SearchCombobox items={accountItems} value={String(exp.accountId ?? "")} onValueChange={v => updateExpense(idx, "accountId", v)} placeholder="الحساب..." /></div>
                    <div className="space-y-1"><Label className="text-xs">القيمة</Label>
                      <div className="flex gap-2">
                        <Input className="h-8 text-xs" type="text" inputMode="decimal" placeholder="0.00" value={exp.amount} onChange={e => updateExpense(idx, "amount", e.target.value.replace(/[^0-9.]/g, ""))} />
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive shrink-0" onClick={() => removeExpense(idx)}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="gap-2 w-full" onClick={addExpense}><Plus className="h-4 w-4" />إضافة مصروف</Button>
              {expenses.length > 0 && (
                <div className="rounded-xl border bg-muted/40 p-4 grid grid-cols-3 gap-4 text-sm text-center">
                  <div><span className="text-muted-foreground block text-xs mb-1">قيمة الاعتماد</span><span className="font-bold font-mono">{fmt(form.totalAmount)}</span></div>
                  <div><span className="text-muted-foreground block text-xs mb-1">إجمالي المصاريف</span><span className="font-bold font-mono text-amber-700">{fmt(totalExpenses)}</span></div>
                  <div><span className="text-muted-foreground block text-xs mb-1">المتبقي</span><span className={cn("font-bold font-mono", remaining >= 0 ? "text-green-700" : "text-destructive")}>{fmt(remaining)}</span></div>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </FormPanel>
      )}

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground text-sm">جاري التحميل...</div>
        ) : lcs.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground text-sm">لا توجد اعتمادات مستندية بعد</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                {["رقم الاعتماد","التاريخ","المورد","البنك","العملة","القيمة الكلية","المستخدم","المتبقي","الحالة","إجراءات"].map(h => (
                  <th key={h} className="text-right px-3 py-3 font-semibold text-muted-foreground text-xs">{h}</th>
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
                    <td className="px-3 py-2.5">{sup?.nameAr ?? "—"}</td>
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
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-primary" title="إنشاء قيد بالذكاء الاصطناعي"
                          onClick={() => runAiJournal(lc)} disabled={aiLoading && aiLc?.id === lc.id}>
                          {aiLoading && aiLc?.id === lc.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEdit(lc)}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => { if (confirm("حذف الاعتماد؟")) deleteMut.mutate(lc.id); }}>
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
        <DialogContent className="max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              قيد محاسبي مقترح للاعتماد {aiLc?.lcNumber}
            </DialogTitle>
          </DialogHeader>

          {aiLoading || !aiPreview ? (
            <div className="py-10 text-center text-sm text-muted-foreground flex flex-col items-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              جارٍ توليد القيد المحاسبي بالذكاء الاصطناعي...
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-sm">
                <div className="text-muted-foreground text-xs mb-1">الوصف</div>
                <div className="font-medium">{aiPreview.description}</div>
              </div>

              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="text-right px-3 py-2 font-semibold">الحساب</th>
                      <th className="text-right px-3 py-2 font-semibold">البيان</th>
                      <th className="text-left px-3 py-2 font-semibold">مدين</th>
                      <th className="text-left px-3 py-2 font-semibold">دائن</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aiPreview.lines.map((l: any, i: number) => (
                      <tr key={i} className="border-t">
                        <td className="px-3 py-2"><span className="font-mono text-xs text-muted-foreground">{l.accountCode}</span> — {l.accountNameAr}</td>
                        <td className="px-3 py-2 text-muted-foreground text-xs">{l.description}</td>
                        <td className="px-3 py-2 font-mono text-left">{l.debit > 0 ? fmt(l.debit) : "—"}</td>
                        <td className="px-3 py-2 font-mono text-left">{l.credit > 0 ? fmt(l.credit) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/40 border-t font-semibold">
                      <td colSpan={2} className="px-3 py-2 text-xs text-muted-foreground">الإجمالي</td>
                      <td className="px-3 py-2 font-mono text-left">{fmt(aiPreview.totalDebit)}</td>
                      <td className="px-3 py-2 font-mono text-left">{fmt(aiPreview.totalCredit)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {aiPreview.reasoning && (
                <div className="rounded-lg border bg-primary/5 p-3 text-xs leading-relaxed">
                  <div className="font-semibold text-primary mb-1 flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" />تفسير الذكاء الاصطناعي</div>
                  <div className="text-muted-foreground">{aiPreview.reasoning}</div>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" size="sm" onClick={() => { setAiLc(null); setAiPreview(null); }} disabled={aiSaving}>إلغاء</Button>
            <Button size="sm" className="gap-2" onClick={confirmAiJournal} disabled={!aiPreview || aiSaving}>
              {aiSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {aiSaving ? "جارٍ الحفظ..." : "اعتماد وحفظ القيد"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
