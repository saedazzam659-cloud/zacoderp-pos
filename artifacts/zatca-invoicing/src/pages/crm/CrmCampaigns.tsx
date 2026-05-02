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
import { Plus, Pencil, Trash2, Search, Megaphone } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Campaign = {
  id: number; code: string; name: string; channel: string;
  budget: string; expectedRevenue: string; actualRevenue: string;
  startDate: string | null; endDate: string | null;
  isActive: boolean; notes: string | null;
};

const CHANNELS = [
  ["facebook","فيسبوك"],["google","جوجل"],["instagram","انستجرام"],
  ["tiktok","تيك توك"],["snapchat","سناب شات"],["email","بريد"],
  ["sms","رسائل SMS"],["referral","إحالة"],["event","فعالية"],["other","أخرى"],
] as const;

const EMPTY = {
  code:"", name:"", channel:"facebook", budget:"0",
  expectedRevenue:"0", actualRevenue:"0",
  startDate:"", endDate:"", isActive:true, notes:"",
};

export default function CrmCampaigns() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [del, setDel] = useState<Campaign | null>(null);

  const { data: rows = [], isLoading } = useQuery<Campaign[]>({
    queryKey:["crm/campaigns", cid],
    queryFn: async () => (await fetch(`${API}/api/crm/campaigns?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });

  const filtered = rows.filter(c => !search.trim() ||
    c.name?.toLowerCase().includes(search.toLowerCase()) ||
    c.code?.toLowerCase().includes(search.toLowerCase()));

  function openNew()  { setEditing(null); setForm(EMPTY); setShowForm(true); }
  function openEdit(c: Campaign) {
    setEditing(c);
    setForm({
      code:c.code??"", name:c.name??"", channel:c.channel??"other",
      budget:String(c.budget??"0"), expectedRevenue:String(c.expectedRevenue??"0"),
      actualRevenue:String(c.actualRevenue??"0"),
      startDate:c.startDate??"", endDate:c.endDate??"",
      isActive: c.isActive !== false, notes:c.notes??"",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error("اسم الحملة مطلوب");
      const body = { ...form, companyId: cid,
        startDate: form.startDate || null, endDate: form.endDate || null };
      const url = editing ? `${API}/api/crm/campaigns/${editing.id}` : `${API}/api/crm/campaigns`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey:["crm/campaigns", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/crm/campaigns/${del.id}?companyId=${cid}`, { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey:["crm/campaigns", cid] }); toast({ title:"تم الحذف" }); setDel(null); },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  const channelLabel = (c:string) => CHANNELS.find(x=>x[0]===c)?.[1] ?? c;

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Megaphone className="h-6 w-6 text-violet-600" />
            الحملات (Campaigns)
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            حملات تسويقية متعددة القنوات — {rows.length} حملة
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-campaign" className="bg-violet-600 hover:bg-violet-700">
          <Plus className="h-4 w-4 ms-2" />حملة جديدة
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث بالاسم أو الكود…" value={search}
            onChange={(e)=>setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {rows.length}</span>
      </div>

      {showForm && (
        <FormPanel icon={editing?Pencil:Plus}
          title={editing?`تعديل: ${editing.name}`:"حملة جديدة"}
          subtitle={editing?`الكود: ${editing.code}`:"الكود يُولَّد تلقائياً (CMP0001)"}
          width="3xl"
          onClose={()=>{ setShowForm(false); setEditing(null); }}
          onSave={()=>saveMut.mutate()} saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>الكود</Label>
              <Input value={form.code} onChange={(e)=>setForm({...form, code:e.target.value})} placeholder="تلقائي CMP0001" /></div>
            <div><Label>الاسم *</Label>
              <Input value={form.name} onChange={(e)=>setForm({...form, name:e.target.value})} data-testid="input-name" /></div>
            <div><Label>القناة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.channel} onChange={(e)=>setForm({...form, channel:e.target.value})}>
                {CHANNELS.map(([v,l])=> <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>الميزانية</Label>
              <Input type="number" step="0.01" value={form.budget} onChange={(e)=>setForm({...form, budget:e.target.value})} /></div>
            <div><Label>الإيراد المتوقع</Label>
              <Input type="number" step="0.01" value={form.expectedRevenue} onChange={(e)=>setForm({...form, expectedRevenue:e.target.value})} /></div>
            <div><Label>الإيراد الفعلي</Label>
              <Input type="number" step="0.01" value={form.actualRevenue} onChange={(e)=>setForm({...form, actualRevenue:e.target.value})} /></div>
            <div><Label>تاريخ البدء</Label>
              <Input type="date" value={form.startDate} onChange={(e)=>setForm({...form, startDate:e.target.value})} /></div>
            <div><Label>تاريخ الانتهاء</Label>
              <Input type="date" value={form.endDate} onChange={(e)=>setForm({...form, endDate:e.target.value})} /></div>
            <div className="flex items-center gap-2 mt-6">
              <input type="checkbox" id="active" checked={form.isActive}
                onChange={(e)=>setForm({...form, isActive:e.target.checked})} className="h-4 w-4" />
              <Label htmlFor="active">نشطة</Label>
            </div>
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
                <th className="px-3 py-2 text-start font-semibold">الكود</th>
                <th className="px-3 py-2 text-start font-semibold">الاسم</th>
                <th className="px-3 py-2 text-start font-semibold">القناة</th>
                <th className="px-3 py-2 text-start font-semibold">الميزانية</th>
                <th className="px-3 py-2 text-start font-semibold">الإيراد المتوقع</th>
                <th className="px-3 py-2 text-start font-semibold">الإيراد الفعلي</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length===0 && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">لا توجد بيانات</td></tr>}
              {filtered.map(c => (
                <tr key={c.id} className="hover:bg-violet-50/40" data-testid={`row-cmp-${c.id}`}>
                  <td className="px-3 py-2 font-mono">{c.code}</td>
                  <td className="px-3 py-2 font-semibold">{c.name}</td>
                  <td className="px-3 py-2">{channelLabel(c.channel)}</td>
                  <td className="px-3 py-2 font-mono">{Number(c.budget).toLocaleString("ar-EG")}</td>
                  <td className="px-3 py-2 font-mono">{Number(c.expectedRevenue).toLocaleString("ar-EG")}</td>
                  <td className="px-3 py-2 font-mono">{Number(c.actualRevenue).toLocaleString("ar-EG")}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${c.isActive ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>
                      {c.isActive ? "نشطة" : "متوقفة"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={()=>openEdit(c)} data-testid={`btn-edit-${c.id}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={()=>setDel(c)} data-testid={`btn-delete-${c.id}`}>
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
            <AlertDialogTitle>حذف الحملة</AlertDialogTitle>
            <AlertDialogDescription>هل تريد حذف «{del?.name}» نهائياً؟</AlertDialogDescription>
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
