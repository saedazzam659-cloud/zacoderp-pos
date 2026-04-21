import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { AccountCombobox } from "@/components/AccountCombobox";
import { ArrowUpCircle, Plus, Pencil, Trash2, Search, CheckCircle2, Clock, Send, Save, X, ListChecks } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);
const EMPTY = { date: today(), paymentType: "cash", cashBoxId: "", bankAccountId: "", entityType: "supplier", entityId: "", entityName: "", amount: "", exchangeRate: "1", refType: "", refNumber: "", description: "", notes: "" };
const ENTITY_LABELS: Record<string, string> = { customer: "عميل", supplier: "مورد", other: "أخرى" };

function Field({ label, required, children, className = "" }: { label: string; required?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <label className="text-xs font-medium text-muted-foreground">
        {label}{required && <span className="text-destructive mr-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

export default function PaymentVouchers() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const h = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search,  setSearch]  = useState("");
  const [editing, setEditing] = useState<any>(null);
  const [form,    setForm]    = useState<typeof EMPTY>(EMPTY);
  const [acctId,  setAcctId]  = useState("");
  const [postRow, setPostRow] = useState<any>(null);
  const [delRow,  setDelRow]  = useState<any>(null);

  const { data: vouchers = [],     isLoading } = useQuery({ queryKey: ["payment-vouchers", cid], queryFn: () => fetch(`${API}/api/payment-vouchers?companyId=${cid}`, { headers: h }).then(r => r.json()), enabled: !!cid });
  const { data: cashBoxes = [] }               = useQuery({ queryKey: ["cash-boxes", cid],       queryFn: () => fetch(`${API}/api/cash-boxes?companyId=${cid}`, { headers: h }).then(r => r.json()), enabled: !!cid });
  const { data: bankAccounts = [] }            = useQuery({ queryKey: ["bank-accounts", cid],    queryFn: () => fetch(`${API}/api/bank-accounts?companyId=${cid}`, { headers: h }).then(r => r.json()), enabled: !!cid });
  const { data: customers = [] }               = useQuery({ queryKey: ["customers", cid],        queryFn: () => fetch(`${API}/api/customers?companyId=${cid}`, { headers: h }).then(r => r.json()), enabled: !!cid });
  const { data: suppliers = [] }               = useQuery({ queryKey: ["suppliers", cid],        queryFn: () => fetch(`${API}/api/suppliers?companyId=${cid}`, { headers: h }).then(r => r.json()), enabled: !!cid });

  const filtered = (vouchers as any[]).filter((v: any) => v.code?.includes(search) || v.description?.includes(search) || v.entityName?.includes(search));
  const totalAmount = (vouchers as any[]).filter((v: any) => v.status === "posted").reduce((a: number, v: any) => a + parseFloat(v.amount || "0"), 0);

  function resetForm()  { setEditing(null); setForm({ ...EMPTY, date: today() }); setAcctId(""); }
  function loadEdit(r: any) { setEditing(r); setForm({ date: r.date, paymentType: r.paymentType || "cash", cashBoxId: r.cashBoxId ? String(r.cashBoxId) : "", bankAccountId: r.bankAccountId ? String(r.bankAccountId) : "", entityType: r.entityType || "supplier", entityId: r.entityId ? String(r.entityId) : "", entityName: r.entityName ?? "", amount: r.amount ?? "", exchangeRate: r.exchangeRate ?? "1", refType: r.refType ?? "", refNumber: r.refNumber ?? "", description: r.description ?? "", notes: r.notes ?? "" }); setAcctId(r.accountId ? String(r.accountId) : ""); }

  const saveMut = useMutation({
    mutationFn: async () => {
      const body = { ...form, companyId: cid, accountId: acctId ? parseInt(acctId) : null, cashBoxId: form.cashBoxId ? parseInt(form.cashBoxId) : null, bankAccountId: form.bankAccountId ? parseInt(form.bankAccountId) : null, entityId: form.entityId ? parseInt(form.entityId) : null };
      const url = editing ? `${API}/api/payment-vouchers/${editing.id}` : `${API}/api/payment-vouchers`;
      const res = await fetch(url, { method: editing ? "PUT" : "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => { toast({ title: editing ? "تم التحديث" : "تم إنشاء السند" }); qc.invalidateQueries({ queryKey: ["payment-vouchers"] }); resetForm(); },
    onError: (e: any) => toast({ title: e.message || "حدث خطأ", variant: "destructive" }),
  });

  const postMut = useMutation({
    mutationFn: async (id: number) => { const res = await fetch(`${API}/api/payment-vouchers/${id}/post`, { method: "POST", headers: h }); if (!res.ok) throw new Error((await res.json()).error); return res.json(); },
    onSuccess: () => { toast({ title: "تم ترحيل سند الصرف" }); qc.invalidateQueries({ queryKey: ["payment-vouchers"] }); setPostRow(null); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => { const res = await fetch(`${API}/api/payment-vouchers/${id}`, { method: "DELETE", headers: h }); if (!res.ok && res.status !== 204) throw new Error((await res.json()).error); },
    onSuccess: () => { toast({ title: "تم الحذف" }); qc.invalidateQueries({ queryKey: ["payment-vouchers"] }); setDelRow(null); if (editing && editing.id === delRow?.id) resetForm(); },
    onError: (e: any) => toast({ title: e.message || "تعذّر الحذف", variant: "destructive" }),
  });

  function f(name: keyof typeof EMPTY) { return { value: form[name] as string, onChange: (e: any) => setForm(p => ({ ...p, [name]: e.target.value })) }; }
  const entityList = form.entityType === "customer" ? customers : form.entityType === "supplier" ? suppliers : [];
  const formInvalid = !form.amount || !form.date;

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><ArrowUpCircle className="h-6 w-6 text-red-500" />سندات الصرف</h1>
          <p className="text-sm text-muted-foreground mt-1">تسجيل المبالغ الصادرة — نقداً أو بنكاً</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "إجمالي السندات", value: (vouchers as any[]).length, color: "text-primary" },
            { label: "المرحّلة",       value: (vouchers as any[]).filter((v: any) => v.status === "posted").length, color: "text-green-700" },
            { label: "إجمالي المصروفات", value: totalAmount.toLocaleString("ar-SA-u-nu-latn", { minimumFractionDigits: 2 }), color: "text-red-700" },
          ].map((s, i) => (
            <div key={i} className="rounded-lg border bg-card px-3 py-2 min-w-[110px]">
              <p className={`text-base font-bold tabular-nums ${s.color}`}>{isLoading ? "—" : s.value}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {/* RIGHT panel — Form */}
        <div className="rounded-xl border bg-card overflow-hidden flex flex-col lg:sticky lg:top-4">
          <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-3">
            <div className="flex items-center gap-2">
              <ArrowUpCircle className="h-4 w-4 text-red-500" />
              <p className="text-sm font-semibold">
                {editing ? `تعديل سند #${editing.code}` : "سند صرف جديد"}
              </p>
            </div>
            {editing && (
              <button onClick={resetForm} className="p-1 rounded hover:bg-background text-muted-foreground" title="جديد">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="p-4 space-y-3 max-h-[calc(100vh-220px)] overflow-y-auto">
            <div className="grid grid-cols-2 gap-3">
              <Field label="التاريخ" required>
                <Input type="date" {...f("date")} />
              </Field>
              <Field label="وسيلة الدفع">
                <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.paymentType} onChange={e => setForm(p => ({ ...p, paymentType: e.target.value, cashBoxId: "", bankAccountId: "" }))}>
                  <option value="cash">نقداً</option>
                  <option value="bank">بنك</option>
                </select>
              </Field>

              {form.paymentType === "cash" ? (
                <Field label="الخزنة" className="col-span-2">
                  <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.cashBoxId} onChange={e => setForm(p => ({ ...p, cashBoxId: e.target.value }))}>
                    <option value="">— اختر الخزنة —</option>
                    {(cashBoxes as any[]).map((c: any) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
                  </select>
                </Field>
              ) : (
                <Field label="الحساب البنكي" className="col-span-2">
                  <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.bankAccountId} onChange={e => setForm(p => ({ ...p, bankAccountId: e.target.value }))}>
                    <option value="">— اختر الحساب البنكي —</option>
                    {(bankAccounts as any[]).map((b: any) => <option key={b.id} value={b.id}>{b.nameAr}</option>)}
                  </select>
                </Field>
              )}

              <Field label="نوع الجهة">
                <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.entityType} onChange={e => setForm(p => ({ ...p, entityType: e.target.value, entityId: "", entityName: "" }))}>
                  <option value="customer">عميل</option>
                  <option value="supplier">مورد</option>
                  <option value="other">أخرى</option>
                </select>
              </Field>
              {form.entityType === "other" ? (
                <Field label="اسم الجهة">
                  <Input placeholder="..." {...f("entityName")} />
                </Field>
              ) : (
                <Field label={form.entityType === "customer" ? "العميل" : "المورد"}>
                  <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.entityId} onChange={e => { const found = (entityList as any[]).find((x: any) => String(x.id) === e.target.value); setForm(p => ({ ...p, entityId: e.target.value, entityName: found?.nameAr || "" })); }}>
                    <option value="">— اختر —</option>
                    {(entityList as any[]).map((e: any) => <option key={e.id} value={e.id}>{e.nameAr}</option>)}
                  </select>
                </Field>
              )}

              <Field label="الحساب المقابل" className="col-span-2">
                <AccountCombobox value={acctId} onValueChange={setAcctId} placeholder="— اختر الحساب —" grouped={false} />
              </Field>

              <Field label="المبلغ" required>
                <Input type="number" step="0.01" placeholder="0.00" dir="ltr" className="text-left font-mono" {...f("amount")} />
              </Field>
              <Field label="سعر الصرف">
                <Input type="number" step="0.000001" placeholder="1" dir="ltr" className="text-left font-mono" {...f("exchangeRate")} />
              </Field>
              <Field label="نوع المرجع">
                <Input placeholder="فاتورة / عقد..." {...f("refType")} />
              </Field>
              <Field label="رقم المرجع">
                <Input placeholder="INV-0001" dir="ltr" className="text-left" {...f("refNumber")} />
              </Field>
              <Field label="البيان" className="col-span-2">
                <Input placeholder="وصف المعاملة..." {...f("description")} />
              </Field>
              <Field label="ملاحظات" className="col-span-2">
                <Input placeholder="..." {...f("notes")} />
              </Field>
            </div>
          </div>

          <div className="border-t bg-muted/20 px-4 py-3 flex items-center justify-between gap-2">
            <Button variant="outline" size="sm" onClick={resetForm} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />جديد
            </Button>
            <Button size="sm" onClick={() => saveMut.mutate()} disabled={formInvalid || saveMut.isPending} className="gap-1.5">
              <Save className="h-3.5 w-3.5" />
              {saveMut.isPending ? "جاري الحفظ..." : editing ? "حفظ التعديل" : "حفظ السند"}
            </Button>
          </div>
        </div>

        {/* LEFT panel — List */}
        <div className="lg:col-span-3 rounded-xl border bg-card overflow-hidden">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm font-medium">قائمة سندات الصرف</p>
            </div>
            <div className="relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input className="pr-9 h-8 w-48 text-sm" placeholder="بحث..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/20 text-xs text-muted-foreground">
                  <th className="h-9 px-3 text-right font-medium">الكود / التاريخ</th>
                  <th className="h-9 px-3 text-right font-medium">الجهة / البيان</th>
                  <th className="h-9 px-3 text-right font-medium hidden lg:table-cell">الدفع</th>
                  <th className="h-9 px-3 text-right font-medium">المبلغ</th>
                  <th className="h-9 px-3 text-center font-medium">الحالة</th>
                  <th className="h-9 px-3 text-center font-medium w-24">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? Array.from({ length: 6 }).map((_, i) => (<tr key={i} className="border-b"><td colSpan={6} className="px-3 py-3"><Skeleton className="h-4 w-full" /></td></tr>))
                : filtered.length === 0 ? (
                  <tr><td colSpan={6} className="py-14 text-center text-muted-foreground">
                    <ArrowUpCircle className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">{search ? "لا توجد نتائج" : "لا توجد سندات صرف بعد"}</p>
                    <p className="text-xs text-muted-foreground/70 mt-1">ابدأ بتعبئة النموذج على اليمين</p>
                  </td></tr>
                ) : filtered.map((row: any) => (
                  <tr key={row.id} className={`border-b hover:bg-muted/20 transition-colors cursor-pointer ${editing?.id === row.id ? "bg-primary/5" : ""}`} onClick={() => row.status === "draft" && loadEdit(row)}>
                    <td className="px-3 py-2.5"><p className="font-mono text-xs font-medium">{row.code}</p><p className="text-[11px] text-muted-foreground">{row.date}</p></td>
                    <td className="px-3 py-2.5 max-w-48"><p className="text-xs font-medium truncate">{row.entityName || ENTITY_LABELS[row.entityType] || "—"}</p>{row.description && <p className="text-[11px] text-muted-foreground truncate">{row.description}</p>}</td>
                    <td className="px-3 py-2.5 hidden lg:table-cell">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${row.paymentType === "cash" ? "bg-amber-50 text-amber-700" : "bg-blue-50 text-blue-700"}`}>{row.paymentType === "cash" ? "نقداً" : "بنك"}</span>
                    </td>
                    <td className="px-3 py-2.5 font-medium text-red-600 tabular-nums text-xs">{parseFloat(row.amount || "0").toLocaleString("ar-SA-u-nu-latn", { minimumFractionDigits: 2 })}</td>
                    <td className="px-3 py-2.5 text-center">{row.status === "posted" ? <span className="inline-flex items-center gap-1 text-[10px] text-green-700 bg-green-50 border border-green-200 px-1.5 py-0.5 rounded-full"><CheckCircle2 className="h-3 w-3" />مرحّل</span> : <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full"><Clock className="h-3 w-3" />مسودة</span>}</td>
                    <td className="px-3 py-2.5 text-center" onClick={e => e.stopPropagation()}>
                      <div className="flex justify-center gap-0.5">
                        {row.status === "draft" && <>
                          <button onClick={() => loadEdit(row)} className="p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors" title="تعديل"><Pencil className="h-3.5 w-3.5" /></button>
                          <button onClick={() => setPostRow(row)} className="p-1.5 rounded hover:bg-green-50 text-muted-foreground hover:text-green-600 transition-colors" title="ترحيل"><Send className="h-3.5 w-3.5" /></button>
                          <button onClick={() => setDelRow(row)} className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors" title="حذف"><Trash2 className="h-3.5 w-3.5" /></button>
                        </>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!isLoading && filtered.length > 0 && (
            <div className="border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground flex items-center justify-between">
              <span>عدد النتائج: <strong>{filtered.length}</strong></span>
              <span className="text-[11px]">انقر على أي سند مسودة لتحميله في النموذج</span>
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={!!postRow} onOpenChange={v => { if (!v) setPostRow(null); }}>
        <AlertDialogContent dir="rtl"><AlertDialogHeader><AlertDialogTitle className="flex items-center gap-2"><Send className="h-5 w-5 text-green-600" />ترحيل سند الصرف</AlertDialogTitle><AlertDialogDescription>هل تريد ترحيل <strong>{postRow?.code}</strong> بمبلغ <strong>{parseFloat(postRow?.amount || "0").toLocaleString("ar-SA-u-nu-latn")}</strong>؟ لا يمكن التعديل بعد الترحيل.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>إلغاء</AlertDialogCancel><AlertDialogAction className="bg-green-600 hover:bg-green-700" onClick={() => postMut.mutate(postRow.id)} disabled={postMut.isPending}>{postMut.isPending ? "جاري الترحيل..." : "ترحيل"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!delRow} onOpenChange={v => { if (!v) setDelRow(null); }}>
        <AlertDialogContent dir="rtl"><AlertDialogHeader><AlertDialogTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5 text-destructive" />حذف سند الصرف</AlertDialogTitle><AlertDialogDescription>هل أنت متأكد من حذف <strong>{delRow?.code}</strong>؟</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>إلغاء</AlertDialogCancel><AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={() => delMut.mutate(delRow.id)} disabled={delMut.isPending}>{delMut.isPending ? "جاري الحذف..." : "تأكيد الحذف"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
