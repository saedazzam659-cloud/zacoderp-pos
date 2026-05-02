import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormPanel } from "@/components/FormPanel";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, Search, Stethoscope } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Doctor = {
  id: number; code: string;
  nameAr: string; nameEn: string | null;
  specialty: string | null; licenseNo: string | null;
  phone: string | null; email: string | null;
  consultationFee: string; isActive: boolean;
  hospitalId: number | null; notes: string | null;
};

const EMPTY = {
  code:"", nameAr:"", nameEn:"", specialty:"", licenseNo:"",
  phone:"", email:"", consultationFee:"0", isActive:true,
  hospitalId:"", notes:"",
};

export default function HospitalDoctors() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Doctor | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<typeof EMPTY>(EMPTY);
  const [del, setDel] = useState<Doctor | null>(null);

  const { data: rows = [], isLoading } = useQuery<Doctor[]>({
    queryKey: ["hospital/doctors", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital/doctors?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الأطباء");
      return r.json();
    },
    enabled: !!cid,
  });

  const { data: hospitals = [] } = useQuery<any[]>({
    queryKey: ["hospital/hospitals", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital/hospitals?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid, staleTime: 60_000,
  });

  const filtered = rows.filter(d => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      d.nameAr?.includes(search) || d.nameEn?.toLowerCase().includes(q) ||
      d.code?.toLowerCase().includes(q) || d.specialty?.includes(search) ||
      d.phone?.includes(search) || d.licenseNo?.toLowerCase().includes(q)
    );
  });

  function openNew()  { setEditing(null); setForm(EMPTY); setShowForm(true); }
  function openEdit(d: Doctor) {
    setEditing(d);
    setForm({
      code: d.code ?? "", nameAr: d.nameAr ?? "", nameEn: d.nameEn ?? "",
      specialty: d.specialty ?? "", licenseNo: d.licenseNo ?? "",
      phone: d.phone ?? "", email: d.email ?? "",
      consultationFee: String(d.consultationFee ?? "0"),
      isActive: d.isActive !== false,
      hospitalId: d.hospitalId ? String(d.hospitalId) : "",
      notes: d.notes ?? "",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.nameAr.trim()) throw new Error("اسم الطبيب مطلوب");
      const body = { ...form, companyId: cid,
        hospitalId: form.hospitalId ? Number(form.hospitalId) : null,
        consultationFee: Number(form.consultationFee || 0) };
      const url = editing ? `${API}/api/hospital/doctors/${editing.id}` : `${API}/api/hospital/doctors`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hospital/doctors", cid] });
      qc.invalidateQueries({ queryKey: ["hospital/summary", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/hospital/doctors/${del.id}?companyId=${cid}`,
        { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hospital/doctors", cid] });
      qc.invalidateQueries({ queryKey: ["hospital/summary", cid] });
      toast({ title:"تم الحذف" }); setDel(null);
    },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  const fmtSAR = (v: any) => Number(v || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2 });
  const hospName = (id: number | null) => hospitals.find((h:any) => h.id === id)?.nameAr || "—";

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Stethoscope className="h-6 w-6 text-emerald-600" />
            الأطباء
          </h1>
          <p className="text-sm text-muted-foreground mt-1">ملفات الأطباء وتخصصاتهم — {rows.length} طبيب</p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-doctor" className="bg-emerald-600 hover:bg-emerald-700">
          <Plus className="h-4 w-4 ms-2" />طبيب جديد
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث بالاسم، الكود، التخصص…" value={search}
            onChange={(e)=>setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {rows.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل الطبيب: ${editing.nameAr}` : "إضافة طبيب جديد"}
          subtitle={editing ? `الكود: ${editing.code}` : "املأ بيانات الطبيب — الكود يُولَّد تلقائياً إن تركته فارغاً"}
          width="3xl"
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>الكود</Label>
              <Input value={form.code} onChange={(e)=>setForm({...form, code:e.target.value})} placeholder="تلقائي DR0001" /></div>
            <div><Label>الاسم بالعربية *</Label>
              <Input value={form.nameAr} onChange={(e)=>setForm({...form, nameAr:e.target.value})} data-testid="input-nameAr" /></div>
            <div><Label>الاسم بالإنجليزية</Label>
              <Input value={form.nameEn} onChange={(e)=>setForm({...form, nameEn:e.target.value})} /></div>
            <div><Label>التخصص</Label>
              <Input value={form.specialty} onChange={(e)=>setForm({...form, specialty:e.target.value})} placeholder="باطنة، أطفال، جلدية…" /></div>
            <div><Label>المنشأة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.hospitalId} onChange={(e)=>setForm({...form, hospitalId:e.target.value})}>
                <option value="">— غير محدد —</option>
                {hospitals.map((h:any) => <option key={h.id} value={h.id}>{h.nameAr}</option>)}
              </select></div>
            <div><Label>رقم ترخيص الهيئة السعودية للتخصصات الصحية</Label>
              <Input value={form.licenseNo} onChange={(e)=>setForm({...form, licenseNo:e.target.value})} /></div>
            <div><Label>الهاتف</Label>
              <Input value={form.phone} onChange={(e)=>setForm({...form, phone:e.target.value})} /></div>
            <div><Label>البريد الإلكتروني</Label>
              <Input type="email" value={form.email} onChange={(e)=>setForm({...form, email:e.target.value})} /></div>
            <div><Label>سعر الكشف (ر.س)</Label>
              <Input type="number" min={0} step="0.01" value={form.consultationFee}
                onChange={(e)=>setForm({...form, consultationFee:e.target.value})} /></div>
            <div className="flex items-center gap-2 mt-7">
              <input type="checkbox" id="isActive" checked={form.isActive}
                onChange={(e)=>setForm({...form, isActive:e.target.checked})} />
              <Label htmlFor="isActive">نشط (يقبل المواعيد)</Label>
            </div>
            <div className="md:col-span-2"><Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e)=>setForm({...form, notes:e.target.value})} /></div>
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-emerald-50 to-emerald-100 text-emerald-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">الكود</th>
                <th className="px-3 py-2 text-start font-semibold">الاسم</th>
                <th className="px-3 py-2 text-start font-semibold">التخصص</th>
                <th className="px-3 py-2 text-start font-semibold">المنشأة</th>
                <th className="px-3 py-2 text-start font-semibold">الترخيص</th>
                <th className="px-3 py-2 text-start font-semibold">الكشف (ر.س)</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length === 0 && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">لا يوجد أطباء</td></tr>}
              {filtered.map((d) => (
                <tr key={d.id} className="hover:bg-emerald-50/40" data-testid={`row-doctor-${d.id}`}>
                  <td className="px-3 py-2 font-mono">{d.code}</td>
                  <td className="px-3 py-2 font-semibold">
                    {d.nameAr}
                    {d.nameEn && <span className="block text-[10px] text-muted-foreground font-normal">{d.nameEn}</span>}
                  </td>
                  <td className="px-3 py-2">{d.specialty || "—"}</td>
                  <td className="px-3 py-2">{hospName(d.hospitalId)}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">{d.licenseNo || "—"}</td>
                  <td className="px-3 py-2 font-mono">{fmtSAR(d.consultationFee)}</td>
                  <td className="px-3 py-2">
                    {d.isActive
                      ? <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-800">نشط</span>
                      : <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700">موقوف</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={()=>openEdit(d)} data-testid={`btn-edit-${d.id}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={()=>setDel(d)} data-testid={`btn-delete-${d.id}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <AlertDialog open={!!del} onOpenChange={(o)=>!o && setDel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف الطبيب</AlertDialogTitle>
            <AlertDialogDescription>هل تريد حذف الطبيب «{del?.nameAr}» نهائياً؟</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={()=>delMut.mutate()} className="bg-rose-600 hover:bg-rose-700">حذف</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
