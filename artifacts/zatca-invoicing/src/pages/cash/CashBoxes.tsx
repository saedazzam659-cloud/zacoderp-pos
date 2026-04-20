import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { AccountCombobox } from "@/components/AccountCombobox";
import {
  Wallet, Plus, Pencil, Trash2, Save, X, AlertTriangle,
  TrendingUp, TrendingDown, Search, CheckCircle2, XCircle,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const EMPTY = { code: "", nameAr: "", nameEn: "", currencyId: "", accountId: "", minBalance: "", maxBalance: "", notes: "", isActive: true };

export default function CashBoxes() {
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
  const [delRow,  setDelRow]  = useState<any>(null);

  const { data: boxes = [], isLoading } = useQuery({
    queryKey: ["cash-boxes", cid],
    queryFn: () => fetch(`${API}/api/cash-boxes?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: balances = [] } = useQuery({
    queryKey: ["cash-boxes-bal", cid],
    queryFn: () => fetch(`${API}/api/cash-boxes/balances?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: currencies = [] } = useQuery({
    queryKey: ["currencies"],
    queryFn: () => fetch(`${API}/api/currencies`, { headers: h }).then(r => r.json()),
    enabled: !!user,
  });

  const balMap: Record<number, number> = Object.fromEntries((balances as any[]).map((b: any) => [b.cashBoxId, b.balance]));
  const filtered = (boxes as any[]).filter((b: any) => b.nameAr?.includes(search) || b.code?.includes(search));

  function openAdd()  { setEditing(null); setForm(EMPTY); setAcctId(""); setPanel(true); }
  function openEdit(r: any) {
    setEditing(r);
    setForm({ code: r.code ?? "", nameAr: r.nameAr ?? "", nameEn: r.nameEn ?? "", currencyId: r.currencyId ? String(r.currencyId) : "", accountId: "", minBalance: r.minBalance ?? "", maxBalance: r.maxBalance ?? "", notes: r.notes ?? "", isActive: r.isActive ?? true });
    setAcctId(r.accountId ? String(r.accountId) : "");
    setPanel(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const body = { ...form, companyId: cid, accountId: acctId ? parseInt(acctId) : null, currencyId: form.currencyId ? parseInt(form.currencyId) : null };
      const url  = editing ? `${API}/api/cash-boxes/${editing.id}` : `${API}/api/cash-boxes`;
      const res  = await fetch(url, { method: editing ? "PUT" : "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      toast({ title: editing ? "تم تحديث الخزنة" : "تمت إضافة الخزنة" });
      qc.invalidateQueries({ queryKey: ["cash-boxes"] });
      qc.invalidateQueries({ queryKey: ["cash-boxes-bal"] });
      setPanel(false);
    },
    onError: () => toast({ title: "حدث خطأ", variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => {
      await fetch(`${API}/api/cash-boxes/${id}`, { method: "DELETE", headers: h });
    },
    onSuccess: () => { toast({ title: "تم حذف الخزنة" }); qc.invalidateQueries({ queryKey: ["cash-boxes"] }); setDelRow(null); },
    onError: () => toast({ title: "تعذّر الحذف", variant: "destructive" }),
  });

  function f(name: keyof typeof EMPTY) {
    return { value: form[name] as string, onChange: (e: any) => setForm(p => ({ ...p, [name]: e.target.value })) };
  }

  const totalBalance = Object.values(balMap).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Wallet className="h-6 w-6 text-primary" />إدارة الخزن</h1>
          <p className="text-sm text-muted-foreground mt-1">إدارة صناديق النقد وأرصدتها</p>
        </div>
        <Button onClick={openAdd} className="gap-2"><Plus className="h-4 w-4" />إضافة خزنة</Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "إجمالي الخزن", value: (boxes as any[]).length, icon: Wallet, color: "text-primary bg-primary/10" },
          { label: "إجمالي الرصيد", value: totalBalance.toLocaleString("ar-SA-u-nu-latn", { minimumFractionDigits: 2 }), icon: TrendingUp, color: "text-green-700 bg-green-100" },
          { label: "خزن نشطة", value: (boxes as any[]).filter((b: any) => b.isActive).length, icon: CheckCircle2, color: "text-blue-700 bg-blue-100" },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 flex items-center gap-3">
            <div className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${s.color}`}>
              <s.icon className="h-5 w-5" />
            </div>
            <div><p className="text-xl font-bold">{isLoading ? "—" : s.value}</p><p className="text-xs text-muted-foreground">{s.label}</p></div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-medium">قائمة الخزن</p>
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pr-9 h-8 w-56 text-sm" placeholder="بحث..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20 text-xs text-muted-foreground">
                <th className="h-9 px-4 text-right font-medium">الكود</th>
                <th className="h-9 px-4 text-right font-medium">الاسم</th>
                <th className="h-9 px-4 text-right font-medium hidden md:table-cell">العملة</th>
                <th className="h-9 px-4 text-right font-medium">الرصيد الحالي</th>
                <th className="h-9 px-4 text-right font-medium hidden sm:table-cell">الحد الأدنى</th>
                <th className="h-9 px-4 text-right font-medium hidden sm:table-cell">الحد الأقصى</th>
                <th className="h-9 px-4 text-center font-medium">الحالة</th>
                <th className="h-9 px-4 text-center font-medium w-20">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? Array.from({ length: 3 }).map((_, i) => (
                <tr key={i} className="border-b"><td colSpan={8} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td></tr>
              )) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="py-14 text-center text-muted-foreground">
                  <Wallet className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">{search ? "لا توجد نتائج" : "لا توجد خزن بعد"}</p>
                  {!search && <Button variant="outline" size="sm" className="mt-3" onClick={openAdd}><Plus className="h-3.5 w-3.5 mr-1" />إضافة خزنة</Button>}
                </td></tr>
              ) : filtered.map((row: any) => {
                const bal = balMap[row.id] ?? 0;
                const min = parseFloat(row.minBalance ?? "0");
                const low = bal < min && min > 0;
                const max = parseFloat(row.maxBalance ?? "0");
                const high = max > 0 && bal > max;
                return (
                  <tr key={row.id} className="border-b hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{row.code}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-7 w-7 rounded-lg bg-primary/10 text-primary font-bold text-xs flex items-center justify-center">{row.nameAr?.[0] ?? "خ"}</div>
                        <div>
                          <p className="font-medium">{row.nameAr}</p>
                          {row.nameEn && <p className="text-xs text-muted-foreground">{row.nameEn}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">
                      {currencies.find((c: any) => c.id === row.currencyId)?.code ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium ${low ? "text-red-600" : high ? "text-orange-600" : "text-foreground"}`}>
                        {low && <AlertTriangle className="h-3 w-3" />}
                        {high && <AlertTriangle className="h-3 w-3" />}
                        {bal.toLocaleString("ar-SA-u-nu-latn", { minimumFractionDigits: 2 })}
                      </span>
                      {low  && <p className="text-xs text-red-500">أقل من الحد الأدنى</p>}
                      {high && <p className="text-xs text-orange-500">تجاوز الحد الأقصى</p>}
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground">{row.minBalance || "—"}</td>
                    <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground">{row.maxBalance || "—"}</td>
                    <td className="px-4 py-3 text-center">
                      {row.isActive
                        ? <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full"><CheckCircle2 className="h-3 w-3" />نشط</span>
                        : <span className="inline-flex items-center gap-1 text-xs text-gray-500 bg-gray-50 border border-gray-200 px-2 py-0.5 rounded-full"><XCircle className="h-3 w-3" />موقوف</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex justify-center gap-1">
                        <button onClick={() => openEdit(row)} className="p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => setDelRow(row)} className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!isLoading && filtered.length > 0 && (
          <div className="border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground">عدد النتائج: <strong>{filtered.length}</strong></div>
        )}
      </div>

      {/* Sheet */}
      <Sheet open={panel} onOpenChange={v => { if (!v) setPanel(false); }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto" dir="rtl">
          <SheetHeader className="border-b pb-4 mb-5">
            <SheetTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-primary" />
              {editing ? "تعديل الخزنة" : "إضافة خزنة جديدة"}
            </SheetTitle>
          </SheetHeader>
          <div className="space-y-4 pb-6">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><label className="text-sm font-medium">الكود *</label><Input placeholder="C001" {...f("code")} /></div>
              <div className="space-y-1.5"><label className="text-sm font-medium">الاسم العربي *</label><Input placeholder="الخزنة الرئيسية" {...f("nameAr")} /></div>
            </div>
            <div className="space-y-1.5"><label className="text-sm font-medium">الاسم الإنجليزي</label><Input placeholder="Main Cash Box" dir="ltr" className="text-left" {...f("nameEn")} /></div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">العملة</label>
              <select className="w-full h-9 border rounded-md px-3 text-sm bg-background" value={form.currencyId} onChange={e => setForm(p => ({ ...p, currencyId: e.target.value }))}>
                <option value="">— اختر العملة —</option>
                {(currencies as any[]).map((c: any) => <option key={c.id} value={c.id}>{c.code} — {c.nameAr}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">الحساب (شجرة الحسابات)</label>
              <AccountCombobox value={acctId} onValueChange={setAcctId} placeholder="— اختر الحساب —" filterTypes={["asset"]} grouped={false} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><label className="text-sm font-medium">الحد الأدنى</label><Input type="number" placeholder="0" {...f("minBalance")} /></div>
              <div className="space-y-1.5"><label className="text-sm font-medium">الحد الأقصى</label><Input type="number" placeholder="—" {...f("maxBalance")} /></div>
            </div>
            <div className="space-y-1.5"><label className="text-sm font-medium">ملاحظات</label><Input placeholder="..." {...f("notes")} /></div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.isActive} onChange={e => setForm(p => ({ ...p, isActive: e.target.checked }))} className="rounded" />
              <span className="text-sm">الخزنة نشطة</span>
            </label>
          </div>
          <SheetFooter className="border-t pt-4 flex flex-row gap-2 justify-end">
            <Button variant="outline" onClick={() => setPanel(false)}><X className="h-4 w-4 ml-1" />إلغاء</Button>
            <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending || !form.nameAr || !form.code}>
              <Save className="h-4 w-4 ml-1" />{saveMut.isPending ? "جاري الحفظ..." : "حفظ"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Delete Confirm */}
      <AlertDialog open={!!delRow} onOpenChange={v => { if (!v) setDelRow(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5 text-destructive" />حذف الخزنة</AlertDialogTitle>
            <AlertDialogDescription>هل أنت متأكد من حذف خزنة <strong>{delRow?.nameAr}</strong>؟ لا يمكن التراجع.</AlertDialogDescription>
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
