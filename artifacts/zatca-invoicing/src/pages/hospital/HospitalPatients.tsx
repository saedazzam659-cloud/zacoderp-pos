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
import { Plus, Pencil, Trash2, Search, UserSquare2 } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Patient = {
  id: number; code: string;
  fullNameAr: string; fullNameEn: string | null;
  nationalId: string | null; idType: string;
  dob: string | null; gender: string;
  phone: string | null; email: string | null;
  bloodType: string | null; address: string | null; city: string | null;
  insurerName: string | null; policyNo: string | null;
  policyExpires: string | null; coveragePct: string;
  customerId: number | null; notes: string | null;
};

const ID_TYPES = [
  ["national_id","هوية وطنية"], ["iqama","إقامة"], ["passport","جواز سفر"],
  ["gcc_id","هوية خليجية"], ["other","أخرى"],
] as const;
const GENDERS = [["male","ذكر"], ["female","أنثى"]] as const;

const EMPTY = {
  code:"", fullNameAr:"", fullNameEn:"", nationalId:"", idType:"national_id",
  dob:"", gender:"male", phone:"", email:"", bloodType:"",
  address:"", city:"", insurerName:"", policyNo:"", policyExpires:"",
  coveragePct:"0", customerId:"", notes:"",
};

export default function HospitalPatients() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Patient | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [del, setDel] = useState<Patient | null>(null);

  const { data: rows = [], isLoading } = useQuery<Patient[]>({
    queryKey: ["hospital/patients", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital/patients?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل المرضى");
      return r.json();
    },
    enabled: !!cid,
  });

  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/customers?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid, staleTime: 60_000,
  });

  const filtered = rows.filter(p => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      p.fullNameAr?.includes(search) || p.fullNameEn?.toLowerCase().includes(q) ||
      p.code?.toLowerCase().includes(q) || p.nationalId?.includes(search) ||
      p.phone?.includes(search) || p.policyNo?.includes(search)
    );
  });

  function openNew()  { setEditing(null); setForm(EMPTY); setShowForm(true); }
  function openEdit(p: Patient) {
    setEditing(p);
    setForm({
      code: p.code ?? "", fullNameAr: p.fullNameAr ?? "", fullNameEn: p.fullNameEn ?? "",
      nationalId: p.nationalId ?? "", idType: p.idType ?? "national_id",
      dob: p.dob ?? "", gender: p.gender ?? "male",
      phone: p.phone ?? "", email: p.email ?? "", bloodType: p.bloodType ?? "",
      address: p.address ?? "", city: p.city ?? "",
      insurerName: p.insurerName ?? "", policyNo: p.policyNo ?? "",
      policyExpires: p.policyExpires ?? "", coveragePct: String(p.coveragePct ?? "0"),
      customerId: p.customerId ? String(p.customerId) : "",
      notes: p.notes ?? "",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.fullNameAr.trim()) throw new Error("اسم المريض مطلوب");
      const body = { ...form, companyId: cid,
        customerId: form.customerId ? Number(form.customerId) : null,
        coveragePct: Number(form.coveragePct || 0),
        dob: form.dob || null, policyExpires: form.policyExpires || null };
      const url = editing ? `${API}/api/hospital/patients/${editing.id}` : `${API}/api/hospital/patients`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hospital/patients", cid] });
      qc.invalidateQueries({ queryKey: ["hospital/summary", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/hospital/patients/${del.id}?companyId=${cid}`,
        { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hospital/patients", cid] });
      qc.invalidateQueries({ queryKey: ["hospital/summary", cid] });
      toast({ title:"تم الحذف" }); setDel(null);
    },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  const idLabel  = (t: string) => ID_TYPES.find(x => x[0] === t)?.[1] ?? t;
  const sexLabel = (g: string) => GENDERS.find(x => x[0] === g)?.[1] ?? g;
  const ageOf = (dob: string | null) => {
    if (!dob) return "—";
    const d = new Date(dob); if (isNaN(d.getTime())) return "—";
    return String(Math.floor((Date.now() - d.getTime()) / (365.25 * 86400000)));
  };
  const policyClass = (p: Patient) => {
    if (!p.insurerName) return "bg-slate-100 text-slate-700";
    if (p.policyExpires && new Date(p.policyExpires) < new Date()) return "bg-rose-100 text-rose-800";
    return "bg-emerald-100 text-emerald-800";
  };
  const policyText = (p: Patient) => {
    if (!p.insurerName) return "بدون تأمين";
    if (p.policyExpires && new Date(p.policyExpires) < new Date()) return "بوليصة منتهية";
    return p.insurerName;
  };

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <UserSquare2 className="h-6 w-6 text-indigo-600" />
            المرضى
          </h1>
          <p className="text-sm text-muted-foreground mt-1">قاعدة بيانات المرضى وبيانات التأمين — {rows.length} مريض</p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-patient" className="bg-indigo-600 hover:bg-indigo-700">
          <Plus className="h-4 w-4 ms-2" />مريض جديد
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث بالاسم، الكود، الهوية، البوليصة…" value={search}
            onChange={(e)=>setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {rows.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل المريض: ${editing.fullNameAr}` : "إضافة مريض جديد"}
          subtitle={editing ? `الكود: ${editing.code}` : "املأ بيانات المريض — الكود يُولَّد تلقائياً"}
          width="3xl"
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>الكود</Label>
              <Input value={form.code} onChange={(e)=>setForm({...form, code:e.target.value})} placeholder="تلقائي PT0001" /></div>
            <div><Label>الاسم بالعربية *</Label>
              <Input value={form.fullNameAr} onChange={(e)=>setForm({...form, fullNameAr:e.target.value})} data-testid="input-fullNameAr" /></div>
            <div><Label>الاسم بالإنجليزية</Label>
              <Input value={form.fullNameEn} onChange={(e)=>setForm({...form, fullNameEn:e.target.value})} /></div>
            <div><Label>تاريخ الميلاد</Label>
              <Input type="date" value={form.dob} onChange={(e)=>setForm({...form, dob:e.target.value})} /></div>
            <div><Label>الجنس</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.gender} onChange={(e)=>setForm({...form, gender:e.target.value})}>
                {GENDERS.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>نوع الهوية</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.idType} onChange={(e)=>setForm({...form, idType:e.target.value})}>
                {ID_TYPES.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>رقم الهوية</Label>
              <Input value={form.nationalId} onChange={(e)=>setForm({...form, nationalId:e.target.value})} /></div>
            <div><Label>فصيلة الدم</Label>
              <Input value={form.bloodType} onChange={(e)=>setForm({...form, bloodType:e.target.value})} placeholder="O+, A-…" /></div>
            <div><Label>الهاتف</Label>
              <Input value={form.phone} onChange={(e)=>setForm({...form, phone:e.target.value})} /></div>
            <div><Label>البريد الإلكتروني</Label>
              <Input type="email" value={form.email} onChange={(e)=>setForm({...form, email:e.target.value})} /></div>
            <div><Label>المدينة</Label>
              <Input value={form.city} onChange={(e)=>setForm({...form, city:e.target.value})} /></div>
            <div><Label>العنوان</Label>
              <Input value={form.address} onChange={(e)=>setForm({...form, address:e.target.value})} /></div>
            <div className="md:col-span-2 mt-2 pt-3 border-t">
              <h3 className="text-sm font-semibold text-sky-700 mb-2">بيانات التأمين</h3>
            </div>
            <div><Label>شركة التأمين</Label>
              <Input value={form.insurerName} onChange={(e)=>setForm({...form, insurerName:e.target.value})} placeholder="بوبا، تعاونية، الراجحي…" /></div>
            <div><Label>رقم البوليصة</Label>
              <Input value={form.policyNo} onChange={(e)=>setForm({...form, policyNo:e.target.value})} /></div>
            <div><Label>تاريخ انتهاء البوليصة</Label>
              <Input type="date" value={form.policyExpires} onChange={(e)=>setForm({...form, policyExpires:e.target.value})} /></div>
            <div><Label>نسبة التغطية %</Label>
              <Input type="number" min={0} max={100} step="0.01" value={form.coveragePct}
                onChange={(e)=>setForm({...form, coveragePct:e.target.value})} /></div>
            <div className="md:col-span-2"><Label>ربط بعميل (CRM)</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.customerId} onChange={(e)=>setForm({...form, customerId:e.target.value})}>
                <option value="">— بدون ربط —</option>
                {customers.map((c:any) => <option key={c.id} value={c.id}>{c.nameAr || c.nameEn}</option>)}
              </select></div>
            <div className="md:col-span-2"><Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e)=>setForm({...form, notes:e.target.value})} /></div>
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-indigo-50 to-indigo-100 text-indigo-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">الكود</th>
                <th className="px-3 py-2 text-start font-semibold">الاسم</th>
                <th className="px-3 py-2 text-start font-semibold">الجنس</th>
                <th className="px-3 py-2 text-start font-semibold">العمر</th>
                <th className="px-3 py-2 text-start font-semibold">الهوية</th>
                <th className="px-3 py-2 text-start font-semibold">الهاتف</th>
                <th className="px-3 py-2 text-start font-semibold">التأمين</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length === 0 && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">لا يوجد مرضى</td></tr>}
              {filtered.map((p) => (
                <tr key={p.id} className="hover:bg-indigo-50/40" data-testid={`row-patient-${p.id}`}>
                  <td className="px-3 py-2 font-mono">{p.code}</td>
                  <td className="px-3 py-2 font-semibold">
                    {p.fullNameAr}
                    {p.fullNameEn && <span className="block text-[10px] text-muted-foreground font-normal">{p.fullNameEn}</span>}
                  </td>
                  <td className="px-3 py-2">{sexLabel(p.gender)}</td>
                  <td className="px-3 py-2 font-mono">{ageOf(p.dob)}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">
                    {p.nationalId || "—"}
                    <span className="block text-[9px] text-muted-foreground">{idLabel(p.idType)}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px]">{p.phone || "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${policyClass(p)}`}>
                      {policyText(p)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={()=>openEdit(p)} data-testid={`btn-edit-${p.id}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={()=>setDel(p)} data-testid={`btn-delete-${p.id}`}>
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
            <AlertDialogTitle>حذف المريض</AlertDialogTitle>
            <AlertDialogDescription>هل تريد حذف المريض «{del?.fullNameAr}» نهائياً؟</AlertDialogDescription>
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
