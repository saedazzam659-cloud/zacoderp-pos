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
import { Plus, Pencil, Trash2, TrendingUp } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Stage = { id: number; name: string; orderNo: number; probability: string; isActive: boolean };
type Opp   = { id: number; title: string; stage: string; pipelineStageId: number | null; dealValue: string };

const EMPTY = { name:"", orderNo:"0", probability:"50", isActive:true };

export default function CrmPipeline() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [editing, setEditing] = useState<Stage | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [del, setDel] = useState<Stage | null>(null);

  const { data: stages = [], isLoading } = useQuery<Stage[]>({
    queryKey:["crm/pipeline", cid],
    queryFn: async () => (await fetch(`${API}/api/crm/pipeline?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: opps = [] } = useQuery<Opp[]>({
    queryKey:["crm/opportunities", cid],
    queryFn: async () => (await fetch(`${API}/api/crm/opportunities?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });

  function openNew()  { setEditing(null); setForm(EMPTY); setShowForm(true); }
  function openEdit(s: Stage) {
    setEditing(s);
    setForm({ name:s.name, orderNo:String(s.orderNo), probability:String(s.probability), isActive: s.isActive !== false });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error("اسم المرحلة مطلوب");
      const body = { ...form, companyId: cid };
      const url = editing ? `${API}/api/crm/pipeline/${editing.id}` : `${API}/api/crm/pipeline`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey:["crm/pipeline", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/crm/pipeline/${del.id}?companyId=${cid}`, { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey:["crm/pipeline", cid] }); toast({ title:"تم الحذف" }); setDel(null); },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  // Group opportunities by built-in stage for visual board
  const STAGES = ["prospecting","qualification","proposal","negotiation","closed_won","closed_lost"];
  const STAGE_LABELS: Record<string,string> = {
    prospecting:"استكشاف", qualification:"تأهيل", proposal:"عرض",
    negotiation:"تفاوض", closed_won:"فوز", closed_lost:"خسارة",
  };
  const grouped = STAGES.map(s => ({
    key: s,
    label: STAGE_LABELS[s],
    opps: opps.filter(o => o.stage === s),
  }));

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-indigo-600" />
            خط الأنابيب (Pipeline)
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            عرض مراحل الفرص + إدارة المراحل المخصصة
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-stage" className="bg-indigo-600 hover:bg-indigo-700">
          <Plus className="h-4 w-4 ms-2" />مرحلة جديدة
        </Button>
      </div>

      {/* Pipeline board */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {grouped.map(g => {
          const total = g.opps.reduce((s,o) => s + Number(o.dealValue||0), 0);
          return (
            <div key={g.key} className="border rounded-lg bg-white p-2 shadow-sm">
              <div className="text-xs font-bold text-indigo-700 border-b pb-1 mb-2">
                {g.label} <span className="text-muted-foreground">({g.opps.length})</span>
              </div>
              <div className="text-[10px] text-muted-foreground mb-2 font-mono">
                {total.toLocaleString("ar-EG")} ر.س
              </div>
              <div className="space-y-1 max-h-72 overflow-y-auto">
                {g.opps.map(o => (
                  <div key={o.id} className="text-[11px] bg-indigo-50 rounded p-1.5 border border-indigo-100">
                    <div className="font-semibold truncate">{o.title}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{Number(o.dealValue||0).toLocaleString("ar-EG")}</div>
                  </div>
                ))}
                {g.opps.length === 0 && (
                  <div className="text-[10px] text-muted-foreground text-center py-3">— لا توجد —</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Custom stages management */}
      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="px-3 py-2 bg-indigo-50 border-b font-semibold text-indigo-900 text-sm">
          مراحل مخصصة (إضافية)
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-indigo-50 to-indigo-100 text-indigo-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">الترتيب</th>
                <th className="px-3 py-2 text-start font-semibold">الاسم</th>
                <th className="px-3 py-2 text-start font-semibold">احتمالية النجاح</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={5} className="text-center py-6 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && stages.length===0 && <tr><td colSpan={5} className="text-center py-6 text-muted-foreground">لا توجد مراحل مخصصة</td></tr>}
              {stages.map(s => (
                <tr key={s.id} className="hover:bg-indigo-50/40">
                  <td className="px-3 py-2 font-mono">{s.orderNo}</td>
                  <td className="px-3 py-2 font-semibold">{s.name}</td>
                  <td className="px-3 py-2 font-mono">{s.probability}%</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${s.isActive ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>
                      {s.isActive ? "مفعّلة" : "موقوفة"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={()=>openEdit(s)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={()=>setDel(s)}>
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

      {showForm && (
        <FormPanel icon={editing?Pencil:Plus}
          title={editing?`تعديل: ${editing.name}`:"مرحلة جديدة"}
          width="md"
          onClose={()=>{ setShowForm(false); setEditing(null); }}
          onSave={()=>saveMut.mutate()} saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2"><Label>الاسم *</Label>
              <Input value={form.name} onChange={(e)=>setForm({...form, name:e.target.value})} /></div>
            <div><Label>الترتيب</Label>
              <Input type="number" value={form.orderNo} onChange={(e)=>setForm({...form, orderNo:e.target.value})} /></div>
            <div><Label>احتمالية النجاح %</Label>
              <Input type="number" min={0} max={100} value={form.probability} onChange={(e)=>setForm({...form, probability:e.target.value})} /></div>
            <div className="flex items-center gap-2 mt-6">
              <input type="checkbox" id="active2" checked={form.isActive}
                onChange={(e)=>setForm({...form, isActive:e.target.checked})} className="h-4 w-4" />
              <Label htmlFor="active2">مفعّلة</Label>
            </div>
          </div>
        </FormPanel>
      )}

      <AlertDialog open={!!del} onOpenChange={(o)=>!o && setDel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف المرحلة</AlertDialogTitle>
            <AlertDialogDescription>حذف «{del?.name}» نهائياً؟</AlertDialogDescription>
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
