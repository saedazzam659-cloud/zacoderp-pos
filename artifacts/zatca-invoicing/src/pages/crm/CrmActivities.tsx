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

type Activity = {
  id: number; type: string; relatedType: string; relatedId: number;
  subject: string; scheduledAt: string | null; completedAt: string | null;
  notes: string | null; createdAt: string;
};
type Lead = { id: number; name: string; code: string };
type Customer = { id: number; nameAr: string };
type Opp = { id: number; title: string; code: string };

const TYPES = [
  ["call","مكالمة"],["meeting","اجتماع"],["task","مهمة"],
  ["visit","زيارة"],["email","بريد"],["note","ملاحظة"],
] as const;
const RELS = [["lead","عميل محتمل"],["customer","عميل"],["opportunity","فرصة"]] as const;

const EMPTY = {
  type:"task", relatedType:"lead", relatedId:"",
  subject:"", scheduledAt:"", completedAt:"", notes:"",
};

export default function CrmActivities() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Activity | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [del, setDel] = useState<Activity | null>(null);

  const { data: rows = [], isLoading } = useQuery<Activity[]>({
    queryKey:["crm/activities", cid],
    queryFn: async () => (await fetch(`${API}/api/crm/activities?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: leads = [] }     = useQuery<Lead[]>({     queryKey:["crm/leads", cid],         queryFn: async () => (await fetch(`${API}/api/crm/leads?companyId=${cid}`, { headers })).json(),         enabled: !!cid });
  const { data: customers = [] } = useQuery<Customer[]>({ queryKey:["customers", cid],         queryFn: async () => (await fetch(`${API}/api/customers?companyId=${cid}`, { headers })).json(),         enabled: !!cid });
  const { data: opps = [] }      = useQuery<Opp[]>({      queryKey:["crm/opportunities", cid], queryFn: async () => (await fetch(`${API}/api/crm/opportunities?companyId=${cid}`, { headers })).json(), enabled: !!cid });

  const filtered = rows.filter(a => !search.trim() || a.subject?.toLowerCase().includes(search.toLowerCase()));

  function relatedOptions() {
    if (form.relatedType === "lead")     return leads.map(l => ({ id:l.id, label:`${l.code} — ${l.name}` }));
    if (form.relatedType === "customer") return customers.map(c => ({ id:c.id, label:c.nameAr }));
    return opps.map(o => ({ id:o.id, label:`${o.code} — ${o.title}` }));
  }

  function openNew()  { setEditing(null); setForm(EMPTY); setShowForm(true); }
  function openEdit(a: Activity) {
    setEditing(a);
    setForm({
      type:a.type, relatedType:a.relatedType, relatedId:String(a.relatedId),
      subject:a.subject, notes:a.notes??"",
      scheduledAt: a.scheduledAt ? a.scheduledAt.slice(0,16) : "",
      completedAt: a.completedAt ? a.completedAt.slice(0,16) : "",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.subject.trim()) throw new Error("الموضوع مطلوب");
      if (!form.relatedId) throw new Error("الجهة المرتبطة مطلوبة");
      const body = { ...form, companyId: cid,
        scheduledAt: form.scheduledAt || null, completedAt: form.completedAt || null };
      const url = editing ? `${API}/api/crm/activities/${editing.id}` : `${API}/api/crm/activities`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey:["crm/activities", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/crm/activities/${del.id}?companyId=${cid}`, { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey:["crm/activities", cid] }); toast({ title:"تم الحذف" }); setDel(null); },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  const typeLabel = (t:string) => TYPES.find(x=>x[0]===t)?.[1] ?? t;
  const relLabel  = (r:string) => RELS.find(x=>x[0]===r)?.[1] ?? r;

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarRange className="h-6 w-6 text-emerald-600" />
            الأنشطة (Activities)
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            مكالمات، اجتماعات، مهام وزيارات — {rows.length} نشاط
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-activity" className="bg-emerald-600 hover:bg-emerald-700">
          <Plus className="h-4 w-4 ms-2" />نشاط جديد
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث في الموضوع…" value={search}
            onChange={(e)=>setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {rows.length}</span>
      </div>

      {showForm && (
        <FormPanel icon={editing?Pencil:Plus}
          title={editing?`تعديل النشاط`:"نشاط جديد"}
          width="3xl"
          onClose={()=>{ setShowForm(false); setEditing(null); }}
          onSave={()=>saveMut.mutate()} saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>النوع</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.type} onChange={(e)=>setForm({...form, type:e.target.value})}>
                {TYPES.map(([v,l])=> <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>الموضوع *</Label>
              <Input value={form.subject} onChange={(e)=>setForm({...form, subject:e.target.value})} data-testid="input-subject" /></div>
            <div><Label>نوع الجهة المرتبطة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.relatedType} onChange={(e)=>setForm({...form, relatedType:e.target.value, relatedId:""})}>
                {RELS.map(([v,l])=> <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>الجهة المرتبطة *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.relatedId} onChange={(e)=>setForm({...form, relatedId:e.target.value})}>
                <option value="">— اختر —</option>
                {relatedOptions().map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select></div>
            <div><Label>موعد الجدولة</Label>
              <Input type="datetime-local" value={form.scheduledAt} onChange={(e)=>setForm({...form, scheduledAt:e.target.value})} /></div>
            <div><Label>تاريخ الإنجاز</Label>
              <Input type="datetime-local" value={form.completedAt} onChange={(e)=>setForm({...form, completedAt:e.target.value})} /></div>
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
                <th className="px-3 py-2 text-start font-semibold">النوع</th>
                <th className="px-3 py-2 text-start font-semibold">الموضوع</th>
                <th className="px-3 py-2 text-start font-semibold">الجهة</th>
                <th className="px-3 py-2 text-start font-semibold">جدولة</th>
                <th className="px-3 py-2 text-start font-semibold">إنجاز</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length===0 && <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">لا توجد بيانات</td></tr>}
              {filtered.map(a => (
                <tr key={a.id} className="hover:bg-emerald-50/40" data-testid={`row-act-${a.id}`}>
                  <td className="px-3 py-2">{typeLabel(a.type)}</td>
                  <td className="px-3 py-2 font-semibold">{a.subject}</td>
                  <td className="px-3 py-2 text-[11px]">{relLabel(a.relatedType)} #{a.relatedId}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">{a.scheduledAt ? a.scheduledAt.slice(0,16).replace("T"," ") : "—"}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">{a.completedAt ? a.completedAt.slice(0,16).replace("T"," ") : "—"}</td>
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
            <AlertDialogTitle>حذف النشاط</AlertDialogTitle>
            <AlertDialogDescription>هل تريد حذف «{del?.subject}» نهائياً؟</AlertDialogDescription>
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
