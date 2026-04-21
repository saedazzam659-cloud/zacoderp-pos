import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { ArrowLeftRight, Plus, Pencil, Trash2, Search, CheckCircle2, Clock, Send, Wallet, Landmark } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);
const EMPTY = { date: today(), transferType: "cash_to_bank", fromCashBoxId: "", fromBankId: "", toCashBoxId: "", toBankId: "", amount: "", exchangeRate: "1", description: "", notes: "" };

const TRANSFER_LABELS: Record<string, string> = {
  cash_to_cash: "خزنة ← خزنة",
  cash_to_bank: "خزنة ← بنك",
  bank_to_cash: "بنك ← خزنة",
  bank_to_bank: "بنك ← بنك",
};

export default function CashTransfers() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const h = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search,  setSearch]  = useState("");
  const [panel,   setPanel]   = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form,    setForm]    = useState<typeof EMPTY>(EMPTY);
  const [postRow, setPostRow] = useState<any>(null);
  const [delRow,  setDelRow]  = useState<any>(null);

  const { data: transfers = [], isLoading } = useQuery({ queryKey: ["cash-transfers", cid], queryFn: () => fetch(`${API}/api/cash-transfers?companyId=${cid}`, { headers: h }).then(r => r.json()), enabled: !!cid });
  const { data: cashBoxes = [] }            = useQuery({ queryKey: ["cash-boxes", cid],     queryFn: () => fetch(`${API}/api/cash-boxes?companyId=${cid}`, { headers: h }).then(r => r.json()), enabled: !!cid });
  const { data: bankAccounts = [] }         = useQuery({ queryKey: ["bank-accounts", cid],  queryFn: () => fetch(`${API}/api/bank-accounts?companyId=${cid}`, { headers: h }).then(r => r.json()), enabled: !!cid });

  const filtered = (transfers as any[]).filter((v: any) => v.code?.includes(search) || v.description?.includes(search));
  const totalAmount = (transfers as any[]).filter((v: any) => v.status === "posted").reduce((a: number, v: any) => a + parseFloat(v.amount || "0"), 0);

  function openAdd()  { setEditing(null); setForm({ ...EMPTY, date: today() }); setPanel(true); }
  function openEdit(r: any) { setEditing(r); setForm({ date: r.date, transferType: r.transferType || "cash_to_bank", fromCashBoxId: r.fromCashBoxId ? String(r.fromCashBoxId) : "", fromBankId: r.fromBankId ? String(r.fromBankId) : "", toCashBoxId: r.toCashBoxId ? String(r.toCashBoxId) : "", toBankId: r.toBankId ? String(r.toBankId) : "", amount: r.amount ?? "", exchangeRate: r.exchangeRate ?? "1", description: r.description ?? "", notes: r.notes ?? "" }); setPanel(true); }

  const saveMut = useMutation({
    mutationFn: async () => {
      const body = { ...form, companyId: cid, fromCashBoxId: form.fromCashBoxId ? parseInt(form.fromCashBoxId) : null, fromBankId: form.fromBankId ? parseInt(form.fromBankId) : null, toCashBoxId: form.toCashBoxId ? parseInt(form.toCashBoxId) : null, toBankId: form.toBankId ? parseInt(form.toBankId) : null };
      const url = editing ? `${API}/api/cash-transfers/${editing.id}` : `${API}/api/cash-transfers`;
      const res = await fetch(url, { method: editing ? "PUT" : "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => { toast({ title: editing ? "تم التحديث" : "تم إنشاء التحويل" }); qc.invalidateQueries({ queryKey: ["cash-transfers"] }); setPanel(false); },
    onError: (e: any) => toast({ title: e.message || "حدث خطأ", variant: "destructive" }),
  });

  const postMut = useMutation({
    mutationFn: async (id: number) => { const res = await fetch(`${API}/api/cash-transfers/${id}/post`, { method: "POST", headers: h }); if (!res.ok) throw new Error((await res.json()).error); return res.json(); },
    onSuccess: () => { toast({ title: "تم ترحيل التحويل" }); qc.invalidateQueries({ queryKey: ["cash-transfers"] }); setPostRow(null); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => { const res = await fetch(`${API}/api/cash-transfers/${id}`, { method: "DELETE", headers: h }); if (!res.ok && res.status !== 204) throw new Error((await res.json()).error); },
    onSuccess: () => { toast({ title: "تم الحذف" }); qc.invalidateQueries({ queryKey: ["cash-transfers"] }); setDelRow(null); },
    onError: (e: any) => toast({ title: e.message || "تعذّر الحذف", variant: "destructive" }),
  });

  function f(name: keyof typeof EMPTY) { return { value: form[name] as string, onChange: (e: any) => setForm(p => ({ ...p, [name]: e.target.value })) }; }

  const fromIsCash = form.transferType === "cash_to_cash" || form.transferType === "cash_to_bank";
  const toIsCash   = form.transferType === "cash_to_cash" || form.transferType === "bank_to_cash";

  function getSourceName(row: any) {
    if (row.fromCashBoxId) return (cashBoxes as any[]).find((b: any) => b.id === row.fromCashBoxId)?.nameAr || `خزنة ${row.fromCashBoxId}`;
    if (row.fromBankId)    return (bankAccounts as any[]).find((b: any) => b.id === row.fromBankId)?.nameAr || `بنك ${row.fromBankId}`;
    return "—";
  }
  function getTargetName(row: any) {
    if (row.toCashBoxId) return (cashBoxes as any[]).find((b: any) => b.id === row.toCashBoxId)?.nameAr || `خزنة ${row.toCashBoxId}`;
    if (row.toBankId)    return (bankAccounts as any[]).find((b: any) => b.id === row.toBankId)?.nameAr || `بنك ${row.toBankId}`;
    return "—";
  }

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-bold flex items-center gap-2"><ArrowLeftRight className="h-6 w-6 text-violet-600" />التحويلات</h1><p className="text-sm text-muted-foreground mt-1">التحويل بين الخزن والبنوك</p></div>
        <Button onClick={openAdd} className="gap-2"><Plus className="h-4 w-4" />تحويل جديد</Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "إجمالي التحويلات", value: (transfers as any[]).length, color: "text-primary bg-primary/10" },
          { label: "المرحّلة", value: (transfers as any[]).filter((v: any) => v.status === "posted").length, color: "text-green-700 bg-green-100" },
          { label: "إجمالي المحوّل", value: totalAmount.toLocaleString("ar-SA-u-nu-latn", { minimumFractionDigits: 2 }), color: "text-violet-700 bg-violet-50" },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border bg-card p-4">
            <p className="text-xl font-bold">{isLoading ? "—" : s.value}</p>
            <p className={`text-xs mt-1 font-medium px-2 py-0.5 rounded-full inline-block ${s.color}`}>{s.label}</p>
          </div>
        ))}
      </div>

      {panel && (
        <FormPanel
          icon={ArrowLeftRight}
          title={editing ? "تعديل التحويل" : "تحويل جديد"}
          subtitle="حدّد نوع التحويل والمصدر والوجهة والمبلغ"
          width="4xl"
          onClose={() => setPanel(false)}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveDisabled={!form.amount || !form.date}
        >
          <FormGrid>
            <Field label="التاريخ" required><Input type="date" {...f("date")} /></Field>
            <Field label="نوع التحويل">
              <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.transferType} onChange={e => setForm(p => ({ ...p, transferType: e.target.value, fromCashBoxId: "", fromBankId: "", toCashBoxId: "", toBankId: "" }))}>
                <option value="cash_to_cash">خزنة إلى خزنة</option>
                <option value="cash_to_bank">خزنة إلى بنك</option>
                <option value="bank_to_cash">بنك إلى خزنة</option>
                <option value="bank_to_bank">بنك إلى بنك</option>
              </select>
            </Field>
            <div className="md:col-span-2 grid md:grid-cols-2 gap-4">
              <div className="rounded-lg border p-4 space-y-2 bg-muted/10">
                <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">{fromIsCash ? <Wallet className="h-3.5 w-3.5" /> : <Landmark className="h-3.5 w-3.5" />}من ({fromIsCash ? "خزنة" : "بنك"})</p>
                {fromIsCash ? (
                  <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.fromCashBoxId} onChange={e => setForm(p => ({ ...p, fromCashBoxId: e.target.value }))}>
                    <option value="">— اختر الخزنة —</option>{(cashBoxes as any[]).map((c: any) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
                  </select>
                ) : (
                  <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.fromBankId} onChange={e => setForm(p => ({ ...p, fromBankId: e.target.value }))}>
                    <option value="">— اختر البنك —</option>{(bankAccounts as any[]).map((b: any) => <option key={b.id} value={b.id}>{b.nameAr}</option>)}
                  </select>
                )}
              </div>
              <div className="rounded-lg border p-4 space-y-2 bg-muted/10">
                <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">{toIsCash ? <Wallet className="h-3.5 w-3.5" /> : <Landmark className="h-3.5 w-3.5" />}إلى ({toIsCash ? "خزنة" : "بنك"})</p>
                {toIsCash ? (
                  <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.toCashBoxId} onChange={e => setForm(p => ({ ...p, toCashBoxId: e.target.value }))}>
                    <option value="">— اختر الخزنة —</option>{(cashBoxes as any[]).map((c: any) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
                  </select>
                ) : (
                  <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.toBankId} onChange={e => setForm(p => ({ ...p, toBankId: e.target.value }))}>
                    <option value="">— اختر البنك —</option>{(bankAccounts as any[]).map((b: any) => <option key={b.id} value={b.id}>{b.nameAr}</option>)}
                  </select>
                )}
              </div>
            </div>
            <Field label="المبلغ" required><Input type="number" step="0.01" placeholder="0.00" dir="ltr" className="text-left" {...f("amount")} /></Field>
            <Field label="سعر الصرف"><Input type="number" step="0.000001" placeholder="1" dir="ltr" className="text-left" {...f("exchangeRate")} /></Field>
            <Field label="البيان" className="md:col-span-2"><Input placeholder="سبب التحويل..." {...f("description")} /></Field>
            <Field label="ملاحظات" className="md:col-span-2"><Input placeholder="..." {...f("notes")} /></Field>
          </FormGrid>
        </FormPanel>
      )}

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-medium">سجل التحويلات</p>
          <div className="relative"><Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" /><Input className="pr-9 h-8 w-56 text-sm" placeholder="بحث..." value={search} onChange={e => setSearch(e.target.value)} /></div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/20 text-xs text-muted-foreground">
              <th className="h-9 px-4 text-right font-medium">الكود / التاريخ</th>
              <th className="h-9 px-4 text-right font-medium">نوع التحويل</th>
              <th className="h-9 px-4 text-right font-medium hidden md:table-cell">من</th>
              <th className="h-9 px-4 text-right font-medium hidden md:table-cell">إلى</th>
              <th className="h-9 px-4 text-right font-medium">المبلغ</th>
              <th className="h-9 px-4 text-center font-medium">الحالة</th>
              <th className="h-9 px-4 text-center font-medium w-28">إجراء</th>
            </tr></thead>
            <tbody>
              {isLoading ? Array.from({ length: 4 }).map((_, i) => (<tr key={i} className="border-b"><td colSpan={7} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td></tr>))
              : filtered.length === 0 ? (
                <tr><td colSpan={7} className="py-14 text-center text-muted-foreground">
                  <ArrowLeftRight className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">{search ? "لا توجد نتائج" : "لا توجد تحويلات بعد"}</p>
                  {!search && <Button variant="outline" size="sm" className="mt-3" onClick={openAdd}><Plus className="h-3.5 w-3.5 mr-1" />تحويل جديد</Button>}
                </td></tr>
              ) : filtered.map((row: any) => (
                <tr key={row.id} onDoubleClick={() => row.status === "draft" ? openEdit(row) : null} className="border-b hover:bg-muted/20 transition-colors cursor-pointer" title={row.status === "draft" ? "انقر مرتين للتعديل" : "السند مرحّل"}>
                  <td className="px-4 py-3"><p className="font-mono text-xs font-medium">{row.code}</p><p className="text-xs text-muted-foreground">{row.date}</p></td>
                  <td className="px-4 py-3"><span className="text-xs bg-violet-50 text-violet-700 border border-violet-200 px-2 py-0.5 rounded-full">{TRANSFER_LABELS[row.transferType] || row.transferType}</span></td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      {(row.fromCashBoxId || !row.fromBankId) ? <Wallet className="h-3 w-3 shrink-0" /> : <Landmark className="h-3 w-3 shrink-0" />}
                      {getSourceName(row)}
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      {(row.toCashBoxId || !row.toBankId) ? <Wallet className="h-3 w-3 shrink-0" /> : <Landmark className="h-3 w-3 shrink-0" />}
                      {getTargetName(row)}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-medium text-violet-700">{parseFloat(row.amount || "0").toLocaleString("ar-SA-u-nu-latn", { minimumFractionDigits: 2 })}</td>
                  <td className="px-4 py-3 text-center">{row.status === "posted" ? <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full"><CheckCircle2 className="h-3 w-3" />مرحّل</span> : <span className="inline-flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full"><Clock className="h-3 w-3" />مسودة</span>}</td>
                  <td className="px-4 py-3 text-center"><div className="flex justify-center gap-1">{row.status === "draft" && <><button onClick={() => openEdit(row)} className="p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"><Pencil className="h-3.5 w-3.5" /></button><button onClick={() => setPostRow(row)} className="p-1.5 rounded hover:bg-green-50 text-muted-foreground hover:text-green-600 transition-colors" title="ترحيل"><Send className="h-3.5 w-3.5" /></button><button onClick={() => setDelRow(row)} className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors"><Trash2 className="h-3.5 w-3.5" /></button></>}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!isLoading && filtered.length > 0 && <div className="border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground">عدد النتائج: <strong>{filtered.length}</strong></div>}
      </div>


      <AlertDialog open={!!postRow} onOpenChange={v => { if (!v) setPostRow(null); }}>
        <AlertDialogContent dir="rtl"><AlertDialogHeader><AlertDialogTitle className="flex items-center gap-2"><Send className="h-5 w-5 text-green-600" />ترحيل التحويل</AlertDialogTitle><AlertDialogDescription>هل تريد ترحيل التحويل <strong>{postRow?.code}</strong> بمبلغ <strong>{parseFloat(postRow?.amount || "0").toLocaleString("ar-SA-u-nu-latn")}</strong>؟</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>إلغاء</AlertDialogCancel><AlertDialogAction className="bg-green-600 hover:bg-green-700" onClick={() => postMut.mutate(postRow.id)} disabled={postMut.isPending}>{postMut.isPending ? "جاري الترحيل..." : "ترحيل"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!delRow} onOpenChange={v => { if (!v) setDelRow(null); }}>
        <AlertDialogContent dir="rtl"><AlertDialogHeader><AlertDialogTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5 text-destructive" />حذف التحويل</AlertDialogTitle><AlertDialogDescription>هل أنت متأكد من حذف <strong>{delRow?.code}</strong>؟</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>إلغاء</AlertDialogCancel><AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={() => delMut.mutate(delRow.id)} disabled={delMut.isPending}>{delMut.isPending ? "جاري الحذف..." : "تأكيد الحذف"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
