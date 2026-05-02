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
import { Plus, Pencil, Trash2, Search, Target } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Opp = {
  id: number; code: string; title: string;
  leadId: number | null; customerId: number | null; campaignId: number | null;
  stage: string; dealValue: string; successProbability: string;
  expectedCloseDate: string | null; notes: string | null;
};
type Lead     = { id: number; name: string; code: string };
type Customer = { id: number; nameAr: string };
type Campaign = { id: number; name: string; code: string };

const STAGES = [
  ["prospecting","استكشاف"], ["qualification","تأهيل"], ["proposal","عرض"],
  ["negotiation","تفاوض"],   ["closed_won","فوز"],     ["closed_lost","خسارة"],
] as const;

const EMPTY = {
  code:"", title:"", leadId:"", customerId:"", campaignId:"",
  stage:"prospecting", dealValue:"0", successProbability:"50",
  expectedCloseDate:"", notes:"",
};

export default function CrmOpportunities() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Opp | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [del, setDel] = useState<Opp | null>(null);

  const { data: rows = [], isLoading } = useQuery<Opp[]>({
    queryKey:["crm/opportunities", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/crm/opportunities?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الفرص");
      return r.json();
    }, enabled: !!cid,
  });
  const { data: leads = [] } = useQuery<Lead[]>({
    queryKey:["crm/leads", cid],
    queryFn: async () => (await fetch(`${API}/api/crm/leads?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey:["customers", cid],
    queryFn: async () => (await fetch(`${API}/api/customers?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey:["crm/campaigns", cid],
    queryFn: async () => (await fetch(`${API}/api/crm/campaigns?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });

  const filtered = rows.filter(o => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return o.title?.toLowerCase().includes(q) || o.code?.toLowerCase().includes(q);
  });

  function openNew()  { setEditing(null); setForm(EMPTY); setShowForm(true); }
  function openEdit(o: Opp) {
    setEditing(o);
    setForm({
      code:o.code??"", title:o.title??"",
      leadId: o.leadId?String(o.leadId):"", customerId:o.customerId?String(o.customerId):"",
      campaignId:o.campaignId?String(o.campaignId):"",
      stage:o.stage??"prospecting",
      dealValue:String(o.dealValue??"0"),
      successProbability:String(o.successProbability??"50"),
      expectedCloseDate:o.expectedCloseDate??"",
      notes:o.notes??"",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.title.trim()) throw new Error("عنوان الفرصة مطلوب");
      const body = {
        ...form, companyId: cid,
        leadId: form.leadId || null, customerId: form.customerId || null,
        campaignId: form.campaignId || null, expectedCloseDate: form.expectedCloseDate || null,
      };
      const url = editing ? `${API}/api/crm/opportunities/${editing.id}` : `${API}/api/crm/opportunities`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey:["crm/opportunities", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/crm/opportunities/${del.id}?companyId=${cid}`, { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey:["crm/opportunities", cid] }); toast({ title:"تم الحذف" }); setDel(null); },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  const stageLabel = (s:string) => STAGES.find(x=>x[0]===s)?.[1] ?? s;
  const stageColor = (s:string) =>
    s==="closed_won"  ? "bg-emerald-100 text-emerald-800" :
    s==="closed_lost" ? "bg-rose-100 text-rose-800" :
    s==="negotiation" ? "bg-amber-100 text-amber-800" :
    s==="proposal"    ? "bg-sky-100 text-sky-800" :
                        "bg-slate-100 text-slate-700";

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Target className="h-6 w-6 text-amber-600" />
            الفرص (Opportunities)
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            مراحل صفقات المبيعات — {rows.length} فرصة
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-opp" className="bg-amber-600 hover:bg-amber-700">
          <Plus className="h-4 w-4 ms-2" />فرصة جديدة
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث بالعنوان أو الكود…" value={search}
            onChange={(e)=>setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {rows.length}</span>
      </div>

      {showForm && (
        <FormPanel icon={editing?Pencil:Plus}
          title={editing?`تعديل: ${editing.title}`:"فرصة جديدة"}
          subtitle={editing?`الكود: ${editing.code}`:"الكود يُولَّد تلقائياً (OPP0001)"}
          width="3xl"
          onClose={()=>{ setShowForm(false); setEditing(null); }}
          onSave={()=>saveMut.mutate()} saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>الكود</Label>
              <Input value={form.code} onChange={(e)=>setForm({...form, code:e.target.value})} placeholder="تلقائي OPP0001" /></div>
            <div><Label>عنوان الفرصة *</Label>
              <Input value={form.title} onChange={(e)=>setForm({...form, title:e.target.value})} data-testid="input-title" /></div>
            <div><Label>عميل محتمل (Lead)</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.leadId} onChange={(e)=>setForm({...form, leadId:e.target.value})}>
                <option value="">— لا شيء —</option>
                {leads.map(l => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
              </select></div>
            <div><Label>عميل (Customer)</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.customerId} onChange={(e)=>setForm({...form, customerId:e.target.value})}>
                <option value="">— لا شيء —</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
              </select></div>
            <div><Label>الحملة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.campaignId} onChange={(e)=>setForm({...form, campaignId:e.target.value})}>
                <option value="">— لا شيء —</option>
                {campaigns.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
              </select></div>
            <div><Label>المرحلة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.stage} onChange={(e)=>setForm({...form, stage:e.target.value})}>
                {STAGES.map(([v,l])=> <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>قيمة الصفقة</Label>
              <Input type="number" step="0.01" value={form.dealValue} onChange={(e)=>setForm({...form, dealValue:e.target.value})} /></div>
            <div><Label>احتمالية النجاح %</Label>
              <Input type="number" min={0} max={100} value={form.successProbability} onChange={(e)=>setForm({...form, successProbability:e.target.value})} /></div>
            <div><Label>تاريخ الإغلاق المتوقع</Label>
              <Input type="date" value={form.expectedCloseDate} onChange={(e)=>setForm({...form, expectedCloseDate:e.target.value})} /></div>
            <div className="md:col-span-2"><Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e)=>setForm({...form, notes:e.target.value})} /></div>
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-amber-50 to-amber-100 text-amber-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">الكود</th>
                <th className="px-3 py-2 text-start font-semibold">العنوان</th>
                <th className="px-3 py-2 text-start font-semibold">المرحلة</th>
                <th className="px-3 py-2 text-start font-semibold">القيمة</th>
                <th className="px-3 py-2 text-start font-semibold">% النجاح</th>
                <th className="px-3 py-2 text-start font-semibold">إغلاق متوقع</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length===0 && <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">لا توجد بيانات</td></tr>}
              {filtered.map(o => (
                <tr key={o.id} className="hover:bg-amber-50/40" data-testid={`row-opp-${o.id}`}>
                  <td className="px-3 py-2 font-mono">{o.code}</td>
                  <td className="px-3 py-2 font-semibold">{o.title}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${stageColor(o.stage)}`}>
                      {stageLabel(o.stage)}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono">{Number(o.dealValue).toLocaleString("ar-EG")} ر.س</td>
                  <td className="px-3 py-2 font-mono">{o.successProbability}%</td>
                  <td className="px-3 py-2 font-mono text-[11px]">{o.expectedCloseDate || "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={()=>openEdit(o)} data-testid={`btn-edit-${o.id}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={()=>setDel(o)} data-testid={`btn-delete-${o.id}`}>
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
            <AlertDialogTitle>حذف الفرصة</AlertDialogTitle>
            <AlertDialogDescription>هل تريد حذف «{del?.title}» نهائياً؟</AlertDialogDescription>
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
