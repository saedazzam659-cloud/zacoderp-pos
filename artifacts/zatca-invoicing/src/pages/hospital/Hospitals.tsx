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
import { Plus, Pencil, Trash2, Search, Building2 } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Hospital = {
  id: number; code: string;
  nameAr: string; nameEn: string | null;
  type: string; status: string;
  crNumber: string | null; licenseNo: string | null;
  beds: number; address: string | null; city: string | null;
  contactPhone: string | null; contactEmail: string | null;
  notes: string | null;
};

const TYPES = [
  ["hospital","مستشفى"], ["clinic","عيادة"], ["dispensary","مستوصف"],
  ["medical_center","مركز طبي"], ["polyclinic","مجمع عيادات"],
] as const;

const STATUSES = [
  ["active","نشط"], ["inactive","موقوف"], ["under_renovation","قيد التطوير"],
] as const;

const EMPTY = {
  code:"", nameAr:"", nameEn:"", type:"clinic", status:"active",
  crNumber:"", licenseNo:"", beds:"0",
  address:"", city:"", contactPhone:"", contactEmail:"", notes:"",
};

export default function Hospitals() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Hospital | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [del, setDel] = useState<Hospital | null>(null);

  const { data: rows = [], isLoading } = useQuery<Hospital[]>({
    queryKey: ["hospital/hospitals", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital/hospitals?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل المنشآت");
      return r.json();
    },
    enabled: !!cid,
  });

  const filtered = rows.filter(h => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      h.nameAr?.includes(search) || h.nameEn?.toLowerCase().includes(q) ||
      h.code?.toLowerCase().includes(q) || h.licenseNo?.includes(search) || h.city?.includes(search)
    );
  });

  function openNew()  { setEditing(null); setForm(EMPTY); setShowForm(true); }
  function openEdit(h: Hospital) {
    setEditing(h);
    setForm({
      code: h.code ?? "", nameAr: h.nameAr ?? "", nameEn: h.nameEn ?? "",
      type: h.type ?? "clinic", status: h.status ?? "active",
      crNumber: h.crNumber ?? "", licenseNo: h.licenseNo ?? "",
      beds: String(h.beds ?? 0), address: h.address ?? "", city: h.city ?? "",
      contactPhone: h.contactPhone ?? "", contactEmail: h.contactEmail ?? "", notes: h.notes ?? "",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.nameAr.trim()) throw new Error("اسم المنشأة مطلوب");
      const body = { ...form, companyId: cid, beds: Number(form.beds || 0) };
      const url = editing ? `${API}/api/hospital/hospitals/${editing.id}` : `${API}/api/hospital/hospitals`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hospital/hospitals", cid] });
      qc.invalidateQueries({ queryKey: ["hospital/summary", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY);
    },
    onError: (e: any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/hospital/hospitals/${del.id}?companyId=${cid}`,
        { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hospital/hospitals", cid] });
      qc.invalidateQueries({ queryKey: ["hospital/summary", cid] });
      toast({ title:"تم الحذف" }); setDel(null);
    },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  const typeLabel    = (t: string) => TYPES.find(x => x[0] === t)?.[1] ?? t;
  const statusLabel  = (s: string) => STATUSES.find(x => x[0] === s)?.[1] ?? s;
  const statusColor  = (s: string) =>
    s === "active" ? "bg-emerald-100 text-emerald-800" :
    s === "under_renovation" ? "bg-amber-100 text-amber-800" :
    "bg-slate-100 text-slate-700";

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="h-6 w-6 text-sky-600" />
            المنشآت الطبية
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            مستشفيات، عيادات ومستوصفات — {rows.length} منشأة
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-hospital" className="bg-sky-600 hover:bg-sky-700">
          <Plus className="h-4 w-4 ms-2" />
          منشأة جديدة
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث بالاسم، الكود، الترخيص…" value={search}
            onChange={(e) => setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {rows.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل المنشأة: ${editing.nameAr}` : "إضافة منشأة جديدة"}
          subtitle={editing ? `الكود: ${editing.code}` : "املأ بيانات المنشأة — الكود يُولَّد تلقائياً إن تركته فارغاً"}
          width="3xl"
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>الكود</Label>
              <Input value={form.code} onChange={(e)=>setForm({...form, code:e.target.value})} placeholder="تلقائي HOS0001" /></div>
            <div><Label>الاسم بالعربية *</Label>
              <Input value={form.nameAr} onChange={(e)=>setForm({...form, nameAr:e.target.value})} data-testid="input-nameAr" /></div>
            <div><Label>الاسم بالإنجليزية</Label>
              <Input value={form.nameEn} onChange={(e)=>setForm({...form, nameEn:e.target.value})} /></div>
            <div><Label>النوع</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.type} onChange={(e)=>setForm({...form, type:e.target.value})}>
                {TYPES.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>الحالة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.status} onChange={(e)=>setForm({...form, status:e.target.value})}>
                {STATUSES.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>عدد الأسرّة</Label>
              <Input type="number" min={0} value={form.beds} onChange={(e)=>setForm({...form, beds:e.target.value})} /></div>
            <div><Label>السجل التجاري</Label>
              <Input value={form.crNumber} onChange={(e)=>setForm({...form, crNumber:e.target.value})} /></div>
            <div><Label>رقم الترخيص</Label>
              <Input value={form.licenseNo} onChange={(e)=>setForm({...form, licenseNo:e.target.value})} placeholder="رقم ترخيص وزارة الصحة" /></div>
            <div><Label>المدينة</Label>
              <Input value={form.city} onChange={(e)=>setForm({...form, city:e.target.value})} /></div>
            <div><Label>الهاتف</Label>
              <Input value={form.contactPhone} onChange={(e)=>setForm({...form, contactPhone:e.target.value})} /></div>
            <div className="md:col-span-2"><Label>العنوان</Label>
              <Input value={form.address} onChange={(e)=>setForm({...form, address:e.target.value})} /></div>
            <div className="md:col-span-2"><Label>البريد الإلكتروني</Label>
              <Input type="email" value={form.contactEmail} onChange={(e)=>setForm({...form, contactEmail:e.target.value})} /></div>
            <div className="md:col-span-2"><Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e)=>setForm({...form, notes:e.target.value})} /></div>
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-sky-50 to-sky-100 text-sky-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">الكود</th>
                <th className="px-3 py-2 text-start font-semibold">الاسم</th>
                <th className="px-3 py-2 text-start font-semibold">النوع</th>
                <th className="px-3 py-2 text-start font-semibold">المدينة</th>
                <th className="px-3 py-2 text-start font-semibold">الأسرّة</th>
                <th className="px-3 py-2 text-start font-semibold">الترخيص</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length === 0 && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">لا توجد منشآت</td></tr>}
              {filtered.map((h) => (
                <tr key={h.id} className="hover:bg-sky-50/40" data-testid={`row-hospital-${h.id}`}>
                  <td className="px-3 py-2 font-mono">{h.code}</td>
                  <td className="px-3 py-2 font-semibold">
                    {h.nameAr}
                    {h.nameEn && <span className="block text-[10px] text-muted-foreground font-normal">{h.nameEn}</span>}
                  </td>
                  <td className="px-3 py-2">{typeLabel(h.type)}</td>
                  <td className="px-3 py-2">{h.city || "—"}</td>
                  <td className="px-3 py-2 font-mono">{h.beds}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">{h.licenseNo || "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${statusColor(h.status)}`}>
                      {statusLabel(h.status)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEdit(h)} data-testid={`btn-edit-${h.id}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={() => setDel(h)} data-testid={`btn-delete-${h.id}`}>
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

      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف المنشأة</AlertDialogTitle>
            <AlertDialogDescription>هل تريد حذف المنشأة «{del?.nameAr}» نهائياً؟</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={() => delMut.mutate()} className="bg-rose-600 hover:bg-rose-700">حذف</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
