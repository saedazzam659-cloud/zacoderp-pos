import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { AccountCombobox } from "@/components/AccountCombobox";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { ArrowDownCircle, Plus, Pencil, Trash2, Search, CheckCircle2, Clock, Send, Undo2 } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);
const EMPTY = { date: today(), paymentType: "cash", cashBoxId: "", bankAccountId: "", entityType: "customer", entityId: "", entityName: "", accountId: "", amount: "", exchangeRate: "1", refType: "", refNumber: "", description: "", notes: "" };

const ENTITY_LABELS: Record<string, string> = { customer: "عميل", supplier: "مورد", other: "أخرى" };

export default function ReceiptVouchers() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const h = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search,  setSearch]  = useState("");
  const [panel,   setPanel]   = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form,    setForm]    = useState<typeof EMPTY>(EMPTY);
  const [acctId,  setAcctId]  = useState("");
  const [postRow,   setPostRow]   = useState<any>(null);
  const [delRow,    setDelRow]    = useState<any>(null);
  const [unpostRow, setUnpostRow] = useState<any>(null);

  const { data: vouchers = [], isLoading } = useQuery({
    queryKey: ["receipt-vouchers", cid],
    queryFn: () => fetch(`${API}/api/receipt-vouchers?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: cashBoxes = [] } = useQuery({
    queryKey: ["cash-boxes", cid],
    queryFn: () => fetch(`${API}/api/cash-boxes?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: bankAccounts = [] } = useQuery({
    queryKey: ["bank-accounts", cid],
    queryFn: () => fetch(`${API}/api/bank-accounts?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: customers = [] } = useQuery({
    queryKey: ["customers", cid],
    queryFn: () => fetch(`${API}/api/customers?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: suppliers = [] } = useQuery({
    queryKey: ["suppliers", cid],
    queryFn: () => fetch(`${API}/api/suppliers?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });

  const filtered = (vouchers as any[]).filter((v: any) =>
    v.code?.includes(search) || v.description?.includes(search) || v.entityName?.includes(search)
  );
  const totalAmount = (vouchers as any[]).filter((v: any) => v.status === "posted").reduce((a: number, v: any) => a + parseFloat(v.amount || "0"), 0);

  const ACCT_KEY = `rv:lastAccountId:${cid}`;
  function openAdd()  {
    const last = typeof window !== "undefined" ? localStorage.getItem(ACCT_KEY) || "" : "";
    setEditing(null);
    setForm({ ...EMPTY, date: today() });
    setAcctId(last);
    setPanel(true);
  }
  function openEdit(r: any) {
    setEditing(r);
    setForm({ date: r.date, paymentType: r.paymentType || "cash", cashBoxId: r.cashBoxId ? String(r.cashBoxId) : "", bankAccountId: r.bankAccountId ? String(r.bankAccountId) : "", entityType: r.entityType || "customer", entityId: r.entityId ? String(r.entityId) : "", entityName: r.entityName ?? "", accountId: "", amount: r.amount ?? "", exchangeRate: r.exchangeRate ?? "1", refType: r.refType ?? "", refNumber: r.refNumber ?? "", description: r.description ?? "", notes: r.notes ?? "" });
    setAcctId(r.accountId ? String(r.accountId) : "");
    setPanel(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const cleanAmt = String(form.amount).replace(/[^\d.\-]/g, "");
      const amtNum = Number(cleanAmt);
      if (!isFinite(amtNum) || amtNum <= 0) throw new Error("المبلغ غير صحيح");
      const body = { ...form, amount: amtNum.toFixed(2), companyId: cid, accountId: acctId ? parseInt(acctId) : null, cashBoxId: form.cashBoxId ? parseInt(form.cashBoxId) : null, bankAccountId: form.bankAccountId ? parseInt(form.bankAccountId) : null, entityId: form.entityId ? parseInt(form.entityId) : null };
      const url = editing ? `${API}/api/receipt-vouchers/${editing.id}` : `${API}/api/receipt-vouchers`;
      const res = await fetch(url, { method: editing ? "PUT" : "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      const j = await res.json();
      if (j?.id && (j.status ?? "draft") === "draft") {
        const pr = await fetch(`${API}/api/receipt-vouchers/${j.id}/post`, { method: "POST", headers: h });
        const pj = await pr.json().catch(() => ({}));
        if (!pr.ok) throw new Error(`تم الحفظ ولكن فشل الترحيل: ${pj.error || pr.statusText}`);
        return pj;
      }
      return j;
    },
    onSuccess: () => { try { if (acctId) localStorage.setItem(ACCT_KEY, acctId); } catch {} toast({ title: editing ? "تم التحديث والترحيل" : "تم إنشاء السند وترحيله" }); qc.invalidateQueries({ queryKey: ["receipt-vouchers"] }); setPanel(false); },
    onError: (e: any) => toast({ title: e.message || "حدث خطأ", variant: "destructive" }),
  });

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/receipt-vouchers/${id}/post`, { method: "POST", headers: h });
      if (!res.ok) throw new Error((await res.json()).error || "فشل الترحيل");
      return res.json();
    },
    onSuccess: () => { toast({ title: "تم ترحيل سند القبض" }); qc.invalidateQueries({ queryKey: ["receipt-vouchers"] }); setPostRow(null); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => { const res = await fetch(`${API}/api/receipt-vouchers/${id}`, { method: "DELETE", headers: h }); if (!res.ok && res.status !== 204) throw new Error((await res.json()).error); },
    onSuccess: () => { toast({ title: "تم الحذف" }); qc.invalidateQueries({ queryKey: ["receipt-vouchers"] }); setDelRow(null); },
    onError: (e: any) => toast({ title: e.message || "تعذّر الحذف", variant: "destructive" }),
  });

  const unpostMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/receipt-vouchers/${id}/unpost`, { method: "POST", headers: h });
      if (!res.ok) throw new Error((await res.json()).error || "فشل فك الترحيل");
      return res.json();
    },
    onSuccess: () => { toast({ title: "تم فك الترحيل وحذف القيد المحاسبي" }); qc.invalidateQueries({ queryKey: ["receipt-vouchers"] }); setUnpostRow(null); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function f(name: keyof typeof EMPTY) {
    return { value: form[name] as string, onChange: (e: any) => setForm(p => ({ ...p, [name]: e.target.value })) };
  }

  const entityList = form.entityType === "customer" ? customers : form.entityType === "supplier" ? suppliers : [];

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><ArrowDownCircle className="h-6 w-6 text-green-600" />سندات القبض</h1>
          <p className="text-sm text-muted-foreground mt-1">تسجيل المبالغ الواردة — نقداً أو بنكاً</p>
        </div>
        <Button onClick={openAdd} className="gap-2"><Plus className="h-4 w-4" />سند قبض جديد</Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "إجمالي السندات", value: (vouchers as any[]).length, color: "text-primary bg-primary/10" },
          { label: "المرحّلة", value: (vouchers as any[]).filter((v: any) => v.status === "posted").length, color: "text-green-700 bg-green-100" },
          { label: "إجمالي المقبوضات", value: totalAmount.toLocaleString("ar-SA-u-nu-latn", { minimumFractionDigits: 2 }), color: "text-emerald-700 bg-emerald-100" },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border bg-card p-4">
            <p className="text-xl font-bold">{isLoading ? "—" : s.value}</p>
            <p className={`text-xs mt-1 font-medium px-2 py-0.5 rounded-full inline-block ${s.color}`}>{s.label}</p>
          </div>
        ))}
      </div>

      {panel && (
        <FormPanel
          icon={ArrowDownCircle}
          title={editing ? "تعديل سند القبض" : "سند قبض جديد"}
          subtitle="بيانات سند القبض ووسيلة الدفع والجهة المستفيدة"
          width="4xl"
          onClose={() => setPanel(false)}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveDisabled={!form.amount || !form.date}
        >
          <FormGrid>
            <Field label="التاريخ" required><Input type="date" {...f("date")} /></Field>
            <Field label="وسيلة الدفع">
              <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.paymentType} onChange={e => setForm(p => ({ ...p, paymentType: e.target.value, cashBoxId: "", bankAccountId: "" }))}>
                <option value="cash">نقداً</option>
                <option value="bank">بنك</option>
              </select>
            </Field>
            {form.paymentType === "cash" ? (
              <Field label="الخزنة" className="md:col-span-2">
                <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.cashBoxId} onChange={e => setForm(p => ({ ...p, cashBoxId: e.target.value }))}>
                  <option value="">— اختر الخزنة —</option>
                  {(cashBoxes as any[]).map((c: any) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
                </select>
              </Field>
            ) : (
              <Field label="الحساب البنكي" className="md:col-span-2">
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
              <Field label="اسم الجهة"><Input placeholder="..." {...f("entityName")} /></Field>
            ) : (
              <Field label={form.entityType === "customer" ? "العميل" : "المورد"}>
                <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.entityId} onChange={e => { const found = (entityList as any[]).find((x: any) => String(x.id) === e.target.value); setForm(p => ({ ...p, entityId: e.target.value, entityName: found?.nameAr || "" })); }}>
                  <option value="">— اختر —</option>
                  {(entityList as any[]).map((e: any) => <option key={e.id} value={e.id}>{e.nameAr}</option>)}
                </select>
              </Field>
            )}
            <Field label="الحساب المقابل" className="md:col-span-2">
              <AccountCombobox value={acctId} onValueChange={setAcctId} placeholder="— اختر الحساب —" grouped={false} />
            </Field>
            <Field label="المبلغ" required><Input type="number" step="0.01" placeholder="0.00" dir="ltr" className="text-left" {...f("amount")} /></Field>
            <Field label="سعر الصرف"><Input type="number" step="0.000001" placeholder="1" dir="ltr" className="text-left" {...f("exchangeRate")} /></Field>
            <Field label="نوع المرجع"><Input placeholder="فاتورة / عقد..." {...f("refType")} /></Field>
            <Field label="رقم المرجع"><Input placeholder="INV-0001" dir="ltr" className="text-left" {...f("refNumber")} /></Field>
            <Field label="البيان" className="md:col-span-2"><Input placeholder="وصف المعاملة..." {...f("description")} /></Field>
            <Field label="ملاحظات" className="md:col-span-2"><Input placeholder="..." {...f("notes")} /></Field>
          </FormGrid>
        </FormPanel>
      )}

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-medium">قائمة سندات القبض</p>
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pr-9 h-8 w-56 text-sm" placeholder="بحث..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20 text-xs text-muted-foreground">
                <th className="h-9 px-4 text-right font-medium">الكود / التاريخ</th>
                <th className="h-9 px-4 text-right font-medium">البيان</th>
                <th className="h-9 px-4 text-right font-medium hidden md:table-cell">الجهة</th>
                <th className="h-9 px-4 text-right font-medium hidden md:table-cell">وسيلة الدفع</th>
                <th className="h-9 px-4 text-right font-medium">المبلغ</th>
                <th className="h-9 px-4 text-center font-medium hidden lg:table-cell">رقم القيد</th>
                <th className="h-9 px-4 text-center font-medium">الحالة</th>
                <th className="h-9 px-4 text-center font-medium w-28">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? Array.from({ length: 4 }).map((_, i) => (
                <tr key={i} className="border-b"><td colSpan={8} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td></tr>
              )) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="py-14 text-center text-muted-foreground">
                  <ArrowDownCircle className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">{search ? "لا توجد نتائج" : "لا توجد سندات قبض بعد"}</p>
                  {!search && <Button variant="outline" size="sm" className="mt-3" onClick={openAdd}><Plus className="h-3.5 w-3.5 mr-1" />سند قبض جديد</Button>}
                </td></tr>
              ) : filtered.map((row: any) => (
                <tr key={row.id} onDoubleClick={() => openEdit(row)} className="border-b hover:bg-muted/20 transition-colors cursor-pointer" title="انقر مرتين للتعديل">
                  <td className="px-4 py-3">
                    <p className="font-mono text-xs font-medium">{row.code}</p>
                    <p className="text-xs text-muted-foreground">{row.date}</p>
                  </td>
                  <td className="px-4 py-3 max-w-48">
                    <p className="text-sm truncate">{row.description || "—"}</p>
                    {row.refNumber && <p className="text-xs text-muted-foreground">مرجع: {row.refNumber}</p>}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <span className="text-xs bg-muted px-2 py-0.5 rounded-full">{ENTITY_LABELS[row.entityType] || "—"}</span>
                    {row.entityName && <p className="text-xs text-muted-foreground mt-0.5">{row.entityName}</p>}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${row.paymentType === "cash" ? "bg-amber-50 text-amber-700" : "bg-blue-50 text-blue-700"}`}>
                      {row.paymentType === "cash" ? "نقداً" : "بنك"}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium text-green-700">
                    {parseFloat(row.amount || "0").toLocaleString("ar-SA-u-nu-latn", { minimumFractionDigits: 2 })}
                  </td>
                  <td className="px-4 py-3 text-center hidden lg:table-cell">
                    {row.journalEntryId
                      ? <a href={`${import.meta.env.BASE_URL}accounting/journals/${row.journalEntryId}?tab=lines`} className="text-xs font-mono text-primary hover:underline" title="عرض سطور القيد المحاسبي">JE-{row.journalEntryId}</a>
                      : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {row.status === "posted"
                      ? <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full"><CheckCircle2 className="h-3 w-3" />مرحّل</span>
                      : <span className="inline-flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full"><Clock className="h-3 w-3" />مسودة</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex justify-center gap-1">
                      {row.status === "draft" ? <>
                        <button onClick={() => openEdit(row)} className="p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors" title="تعديل"><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => setPostRow(row)} className="p-1.5 rounded hover:bg-green-50 text-muted-foreground hover:text-green-600 transition-colors" title="ترحيل"><Send className="h-3.5 w-3.5" /></button>
                        <button onClick={() => setDelRow(row)} className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors" title="حذف"><Trash2 className="h-3.5 w-3.5" /></button>
                      </> : <>
                        <button onClick={() => setUnpostRow(row)} className="p-1.5 rounded hover:bg-amber-50 text-muted-foreground hover:text-amber-600 transition-colors" title="فك الترحيل"><Undo2 className="h-3.5 w-3.5" /></button>
                      </>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!isLoading && filtered.length > 0 && (
          <div className="border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground">عدد النتائج: <strong>{filtered.length}</strong></div>
        )}
      </div>


      <AlertDialog open={!!postRow} onOpenChange={v => { if (!v) setPostRow(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2"><Send className="h-5 w-5 text-green-600" />ترحيل سند القبض</AlertDialogTitle>
            <AlertDialogDescription>هل تريد ترحيل سند القبض <strong>{postRow?.code}</strong> بمبلغ <strong>{parseFloat(postRow?.amount || "0").toLocaleString("ar-SA-u-nu-latn")}</strong>؟ لا يمكن التعديل بعد الترحيل.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction className="bg-green-600 hover:bg-green-700" onClick={() => postMut.mutate(postRow.id)} disabled={postMut.isPending}>
              {postMut.isPending ? "جاري الترحيل..." : "ترحيل"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!unpostRow} onOpenChange={v => { if (!v) setUnpostRow(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2"><Undo2 className="h-5 w-5 text-amber-600" />فك ترحيل سند القبض</AlertDialogTitle>
            <AlertDialogDescription>
              سيتم إعادة السند <strong>{unpostRow?.code}</strong> إلى مسودة وحذف القيد المحاسبي المرتبط به. هل أنت متأكد؟
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction className="bg-amber-600 hover:bg-amber-700" onClick={() => unpostMut.mutate(unpostRow.id)} disabled={unpostMut.isPending}>
              {unpostMut.isPending ? "جاري فك الترحيل..." : "فك الترحيل"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!delRow} onOpenChange={v => { if (!v) setDelRow(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5 text-destructive" />حذف سند القبض</AlertDialogTitle>
            <AlertDialogDescription>هل أنت متأكد من حذف السند <strong>{delRow?.code}</strong>؟</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={() => delMut.mutate(delRow.id)} disabled={delMut.isPending}>
              {delMut.isPending ? "جاري الحذف..." : "تأكيد الحذف"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
