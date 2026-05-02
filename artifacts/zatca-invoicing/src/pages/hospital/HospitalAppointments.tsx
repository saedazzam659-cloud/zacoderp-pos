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
import { Plus, Pencil, Trash2, Search, CalendarRange } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Appt = {
  id: number; docNumber: string;
  patientId: number; doctorId: number; hospitalId: number | null;
  scheduledAt: string; status: string; visitType: string;
  chiefComplaint: string | null; diagnosis: string | null; icd10Code: string | null;
  treatment: string | null; prescriptions: string | null; vitals: string | null;
  estimatedCost: string; notes: string | null;
};

const STATUSES = [
  ["scheduled","مجدول"], ["checked_in","تسجيل دخول"], ["in_progress","قيد الكشف"],
  ["completed","مكتمل"], ["cancelled","ملغى"], ["no_show","لم يحضر"],
] as const;
const VISIT_TYPES = [
  ["consultation","كشف"], ["follow_up","متابعة"], ["emergency","طوارئ"],
  ["procedure","إجراء طبي"], ["lab","تحاليل"], ["imaging","أشعة"],
] as const;

function toLocalIso(d: string) {
  if (!d) return "";
  const dt = new Date(d);
  const tz = dt.getTimezoneOffset() * 60000;
  return new Date(dt.getTime() - tz).toISOString().slice(0, 16);
}

const EMPTY = {
  docNumber:"", patientId:"", doctorId:"", hospitalId:"",
  scheduledAt: toLocalIso(new Date().toISOString()),
  status:"scheduled", visitType:"consultation",
  chiefComplaint:"", diagnosis:"", icd10Code:"",
  treatment:"", prescriptions:"", vitals:"",
  estimatedCost:"0", notes:"",
};

export default function HospitalAppointments() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Appt | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<typeof EMPTY>(EMPTY);
  const [del, setDel] = useState<Appt | null>(null);

  const { data: rows = [], isLoading } = useQuery<Appt[]>({
    queryKey: ["hospital/appointments", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital/appointments?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل المواعيد");
      return r.json();
    },
    enabled: !!cid,
  });

  const { data: patients = [] } = useQuery<any[]>({
    queryKey: ["hospital/patients", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital/patients?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid, staleTime: 60_000,
  });

  const { data: doctors = [] } = useQuery<any[]>({
    queryKey: ["hospital/doctors", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital/doctors?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid, staleTime: 60_000,
  });

  const { data: hospitals = [] } = useQuery<any[]>({
    queryKey: ["hospital/hospitals", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital/hospitals?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid, staleTime: 60_000,
  });

  const patientName = (id: number) => patients.find((p:any) => p.id === id)?.fullNameAr || `#${id}`;
  const doctorName  = (id: number) => doctors.find((d:any) => d.id === id)?.nameAr     || `#${id}`;
  const statusLabel = (s: string) => STATUSES.find(x => x[0] === s)?.[1]    ?? s;
  const visitLabel  = (v: string) => VISIT_TYPES.find(x => x[0] === v)?.[1] ?? v;
  const statusColor = (s: string) =>
    s === "completed"    ? "bg-emerald-100 text-emerald-800" :
    s === "cancelled"    ? "bg-rose-100 text-rose-800" :
    s === "no_show"      ? "bg-slate-200 text-slate-700" :
    s === "in_progress"  ? "bg-amber-100 text-amber-800" :
    s === "checked_in"   ? "bg-sky-100 text-sky-800" :
                           "bg-violet-100 text-violet-800";

  const filtered = rows.filter(a => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      a.docNumber?.toLowerCase().includes(q) ||
      patientName(a.patientId).includes(search) ||
      doctorName(a.doctorId).includes(search) ||
      a.diagnosis?.includes(search) ||
      a.chiefComplaint?.includes(search)
    );
  });

  function openNew()  { setEditing(null); setForm(EMPTY); setShowForm(true); }
  function openEdit(a: Appt) {
    setEditing(a);
    setForm({
      docNumber: a.docNumber ?? "",
      patientId: String(a.patientId),
      doctorId:  String(a.doctorId),
      hospitalId: a.hospitalId ? String(a.hospitalId) : "",
      scheduledAt: toLocalIso(a.scheduledAt),
      status: a.status, visitType: a.visitType,
      chiefComplaint: a.chiefComplaint ?? "", diagnosis: a.diagnosis ?? "",
      icd10Code: a.icd10Code ?? "", treatment: a.treatment ?? "",
      prescriptions: a.prescriptions ?? "", vitals: a.vitals ?? "",
      estimatedCost: String(a.estimatedCost ?? "0"), notes: a.notes ?? "",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.patientId) throw new Error("المريض مطلوب");
      if (!form.doctorId)  throw new Error("الطبيب مطلوب");
      if (!form.scheduledAt) throw new Error("تاريخ ووقت الموعد مطلوب");
      const body = { ...form, companyId: cid,
        patientId: Number(form.patientId), doctorId: Number(form.doctorId),
        hospitalId: form.hospitalId ? Number(form.hospitalId) : null,
        estimatedCost: Number(form.estimatedCost || 0),
        scheduledAt: new Date(form.scheduledAt).toISOString() };
      const url = editing ? `${API}/api/hospital/appointments/${editing.id}` : `${API}/api/hospital/appointments`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hospital/appointments", cid] });
      qc.invalidateQueries({ queryKey: ["hospital/summary", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/hospital/appointments/${del.id}?companyId=${cid}`,
        { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hospital/appointments", cid] });
      qc.invalidateQueries({ queryKey: ["hospital/summary", cid] });
      toast({ title:"تم الحذف" }); setDel(null);
    },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  const fmtDt = (s: string) => {
    if (!s) return "—";
    const d = new Date(s);
    return d.toLocaleString("ar-SA", { dateStyle: "short", timeStyle: "short" });
  };

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarRange className="h-6 w-6 text-violet-600" />
            المواعيد والكشوفات
          </h1>
          <p className="text-sm text-muted-foreground mt-1">جدول المواعيد والكشف والتشخيص — {rows.length} موعد</p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-appointment" className="bg-violet-600 hover:bg-violet-700">
          <Plus className="h-4 w-4 ms-2" />موعد جديد
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث برقم الموعد، المريض، الطبيب…" value={search}
            onChange={(e)=>setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {rows.length}</span>
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل الموعد: ${editing.docNumber}` : "موعد جديد"}
          subtitle={editing ? `الكود: ${editing.docNumber}` : "املأ بيانات الموعد — رقم المستند يُولَّد تلقائياً"}
          width="3xl"
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>رقم الموعد</Label>
              <Input value={form.docNumber} onChange={(e)=>setForm({...form, docNumber:e.target.value})} placeholder="تلقائي APT0001" /></div>
            <div><Label>تاريخ ووقت الموعد *</Label>
              <Input type="datetime-local" value={form.scheduledAt}
                onChange={(e)=>setForm({...form, scheduledAt:e.target.value})} /></div>
            <div><Label>المريض *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.patientId} onChange={(e)=>setForm({...form, patientId:e.target.value})} data-testid="select-patient">
                <option value="">— اختر المريض —</option>
                {patients.map((p:any) => <option key={p.id} value={p.id}>{p.fullNameAr} ({p.code})</option>)}
              </select></div>
            <div><Label>الطبيب *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.doctorId} onChange={(e)=>setForm({...form, doctorId:e.target.value})} data-testid="select-doctor">
                <option value="">— اختر الطبيب —</option>
                {doctors.filter((d:any)=>d.isActive).map((d:any) => <option key={d.id} value={d.id}>{d.nameAr} — {d.specialty || "—"}</option>)}
              </select></div>
            <div><Label>المنشأة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.hospitalId} onChange={(e)=>setForm({...form, hospitalId:e.target.value})}>
                <option value="">— غير محدد —</option>
                {hospitals.map((h:any) => <option key={h.id} value={h.id}>{h.nameAr}</option>)}
              </select></div>
            <div><Label>نوع الزيارة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.visitType} onChange={(e)=>setForm({...form, visitType:e.target.value})}>
                {VISIT_TYPES.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>الحالة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.status} onChange={(e)=>setForm({...form, status:e.target.value})}>
                {STATUSES.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>التكلفة المقدرة (ر.س)</Label>
              <Input type="number" min={0} step="0.01" value={form.estimatedCost}
                onChange={(e)=>setForm({...form, estimatedCost:e.target.value})} /></div>
            <div className="md:col-span-2"><Label>الشكوى الرئيسية</Label>
              <Input value={form.chiefComplaint} onChange={(e)=>setForm({...form, chiefComplaint:e.target.value})} placeholder="حرارة منذ يومين، صداع…" /></div>
            <div className="md:col-span-2"><Label>التشخيص</Label>
              <Input value={form.diagnosis} onChange={(e)=>setForm({...form, diagnosis:e.target.value})} /></div>
            <div><Label>كود ICD-10</Label>
              <Input value={form.icd10Code} onChange={(e)=>setForm({...form, icd10Code:e.target.value})} placeholder="J11.1" /></div>
            <div><Label>المؤشرات الحيوية (Vitals)</Label>
              <Input value={form.vitals} onChange={(e)=>setForm({...form, vitals:e.target.value})} placeholder="BP 120/80، نبض 72، حرارة 37.5" /></div>
            <div className="md:col-span-2"><Label>العلاج / الإجراءات</Label>
              <Input value={form.treatment} onChange={(e)=>setForm({...form, treatment:e.target.value})} /></div>
            <div className="md:col-span-2"><Label>الوصفة الطبية</Label>
              <Input value={form.prescriptions} onChange={(e)=>setForm({...form, prescriptions:e.target.value})} placeholder="باراسيتامول 500mg كل 8 ساعات…" /></div>
            <div className="md:col-span-2"><Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e)=>setForm({...form, notes:e.target.value})} /></div>
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-violet-50 to-violet-100 text-violet-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">الرقم</th>
                <th className="px-3 py-2 text-start font-semibold">التاريخ والوقت</th>
                <th className="px-3 py-2 text-start font-semibold">المريض</th>
                <th className="px-3 py-2 text-start font-semibold">الطبيب</th>
                <th className="px-3 py-2 text-start font-semibold">النوع</th>
                <th className="px-3 py-2 text-start font-semibold">التشخيص</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length === 0 && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">لا توجد مواعيد</td></tr>}
              {filtered.map((a) => (
                <tr key={a.id} className="hover:bg-violet-50/40" data-testid={`row-appointment-${a.id}`}>
                  <td className="px-3 py-2 font-mono">{a.docNumber}</td>
                  <td className="px-3 py-2 text-[11px]">{fmtDt(a.scheduledAt)}</td>
                  <td className="px-3 py-2 font-semibold">{patientName(a.patientId)}</td>
                  <td className="px-3 py-2">{doctorName(a.doctorId)}</td>
                  <td className="px-3 py-2">{visitLabel(a.visitType)}</td>
                  <td className="px-3 py-2 max-w-[18ch] truncate" title={a.diagnosis ?? ""}>{a.diagnosis || "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${statusColor(a.status)}`}>
                      {statusLabel(a.status)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={()=>openEdit(a)} data-testid={`btn-edit-${a.id}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={()=>setDel(a)} data-testid={`btn-delete-${a.id}`}>
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
            <AlertDialogTitle>حذف الموعد</AlertDialogTitle>
            <AlertDialogDescription>هل تريد حذف الموعد «{del?.docNumber}» نهائياً؟</AlertDialogDescription>
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
