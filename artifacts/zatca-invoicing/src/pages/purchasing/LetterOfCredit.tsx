import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Plus, Pencil, Trash2, CreditCard, Save, X, FileText, ListOrdered } from "lucide-react";
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

      <Sheet open={showForm} onOpenChange={v => { if (!v) reset(); }}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto" dir="rtl">
          <SheetHeader className="border-b pb-4 mb-5">
            <SheetTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-primary" />
              {editId ? "تعديل الاعتماد" : "اعتماد مستندي جديد"}
            </SheetTitle>
          </SheetHeader>
          <form onSubmit={handleSubmit} className="space-y-5">
            <Tabs value={activeTab} onValueChange={setActiveTab} dir="rtl">
              <TabsList className="w-full h-9 mb-4">
                <TabsTrigger value="info"     className="flex-1 text-xs gap-1.5"><FileText     className="h-3.5 w-3.5" />البيانات الأساسية</TabsTrigger>
                <TabsTrigger value="expenses" className="flex-1 text-xs gap-1.5"><ListOrdered className="h-3.5 w-3.5" />المصاريف ({expenses.length})</TabsTrigger>
              </TabsList>

              <TabsContent value="info" className="mt-0 space-y-4">
                <div className="space-y-1.5">
                  <Label>رقم الاعتماد <span className="text-destructive">*</span></Label>
                  <Input placeholder="LC-2025-001" value={form.lcNumber} onChange={e => setForm((p: any) => ({ ...p, lcNumber: e.target.value }))} required />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>التاريخ <span className="text-destructive">*</span></Label>
                    <Input type="date" value={form.lcDate} onChange={e => setForm((p: any) => ({ ...p, lcDate: e.target.value }))} required />
                  </div>
                  <div className="space-y-1.5">
                    <Label>العملة</Label>
                    <Input placeholder="SAR" value={form.currencyCode} onChange={e => setForm((p: any) => ({ ...p, currencyCode: e.target.value }))} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>المورد</Label>
                  <SearchCombobox items={supplierItems} value={form.supplierId} onValueChange={v => setForm((p: any) => ({ ...p, supplierId: v }))} placeholder="اختر المورد..." />
                </div>
                <div className="space-y-1.5">
                  <Label>البنك</Label>
                  <Input placeholder="اسم البنك" value={form.bankName} onChange={e => setForm((p: any) => ({ ...p, bankName: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>قيمة الاعتماد <span className="text-destructive">*</span></Label>
                  <Input type="text" inputMode="decimal" placeholder="0.00" value={form.totalAmount}
                    onChange={e => setForm((p: any) => ({ ...p, totalAmount: e.target.value.replace(/[^0-9.]/g, "") }))} required />
                </div>
                <div className="space-y-1.5">
                  <Label>ملاحظات</Label>
                  <Textarea rows={2} className="resize-none text-sm" value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
                </div>
              </TabsContent>

              <TabsContent value="expenses" className="mt-0 space-y-3">
                {expenses.map((exp, idx) => (
                  <div key={exp._id ?? idx} className="space-y-2 p-3 rounded-lg border bg-muted/20">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">نوع المصروف</Label>
                        <Input className="h-8 text-xs" placeholder="شحن / جمارك..." value={exp.expenseType}
                          onChange={e => updateExpense(idx, "expenseType", e.target.value)} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">العملة</Label>
                        <Input className="h-8 text-xs" placeholder="SAR" value={exp.currencyCode}
                          onChange={e => updateExpense(idx, "currencyCode", e.target.value)} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 items-end">
                      <div className="space-y-1">
                        <Label className="text-xs">الحساب</Label>
                        <SearchCombobox items={accountItems} value={String(exp.accountId ?? "")}
                          onValueChange={v => updateExpense(idx, "accountId", v)} placeholder="الحساب..." />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">القيمة</Label>
                        <div className="flex gap-2">
                          <Input className="h-8 text-xs" type="text" inputMode="decimal" placeholder="0.00" value={exp.amount}
                            onChange={e => updateExpense(idx, "amount", e.target.value.replace(/[^0-9.]/g, ""))} />
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive shrink-0" onClick={() => removeExpense(idx)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" className="gap-2 w-full" onClick={addExpense}>
                  <Plus className="h-4 w-4" />إضافة مصروف
                </Button>
                {expenses.length > 0 && (
                  <div className="rounded-xl border bg-muted/40 p-4 grid grid-cols-3 gap-4 text-sm text-center">
                    <div>
                      <span className="text-muted-foreground block text-xs mb-1">قيمة الاعتماد</span>
                      <span className="font-bold font-mono">{fmt(form.totalAmount)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-xs mb-1">إجمالي المصاريف</span>
                      <span className="font-bold font-mono text-amber-700">{fmt(totalExpenses)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-xs mb-1">المتبقي</span>
                      <span className={cn("font-bold font-mono", remaining >= 0 ? "text-green-700" : "text-destructive")}>{fmt(remaining)}</span>
                    </div>
                  </div>
                )}
              </TabsContent>
            </Tabs>

            <SheetFooter className="flex gap-2 pt-4 border-t">
              <Button type="button" variant="outline" className="gap-1" onClick={reset}><X className="h-4 w-4" />إلغاء</Button>
              <Button type="submit" className="gap-1 flex-1" disabled={saveMut.isPending}>
                <Save className="h-4 w-4" />{editId ? "حفظ التعديل" : "إنشاء الاعتماد"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}
