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
import { Plus, Pencil, Trash2, Search, UserSquare2, ArrowRightLeft } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Lead = {
  id: number; code: string; name: string;
  mobile: string | null; email: string | null;
  source: string | null; industry: string | null;
  interestLevel: string; status: string;
  conversionScore: string;
  convertedCustomerId: number | null;
  notes: string | null;
};

const STATUSES  = [["new","جديد"],["contacted","تم التواصل"],["qualified","مؤهل"],["rejected","مرفوض"],["converted","محوَّل"]] as const;
const INTERESTS = [["cold","بارد"],["warm","دافئ"],["hot","ساخن"]] as const;

const EMPTY = {
  code:"", name:"", mobile:"", email:"", source:"", industry:"",
  interestLevel:"warm", status:"new", conversionScore:"0", notes:"",
};

export default function CrmLeads() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Lead | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [del, setDel] = useState<Lead | null>(null);

  const { data: rows = [], isLoading } = useQuery<Lead[]>({
    queryKey: ["crm/leads", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/crm/leads?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل العملاء المحتملين");
      return r.json();
    },
    enabled: !!cid,
  });

  const filtered = rows.filter(l => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return l.name?.toLowerCase().includes(q) || l.code?.toLowerCase().includes(q) ||
           l.mobile?.includes(search) || l.email?.toLowerCase().includes(q);
  });

  function openNew() { setEditing(null); setForm(EMPTY); setShowForm(true); }
  function openEdit(l: Lead) {
    setEditing(l);
    setForm({
      code:l.code??"", name:l.name??"", mobile:l.mobile??"", email:l.email??"",
      source:l.source??"", industry:l.industry??"",
      interestLevel:l.interestLevel??"warm", status:l.status??"new",
      conversionScore:String(l.conversionScore??"0"), notes:l.notes??"",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error("الاسم مطلوب");
      const body = { ...form, companyId: cid };
      const url = editing ? `${API}/api/crm/leads/${editing.id}` : `${API}/api/crm/leads`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey:["crm/leads", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/crm/leads/${del.id}?companyId=${cid}`, { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey:["crm/leads", cid] });
      toast({ title:"تم الحذف" }); setDel(null);
    },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  const convertMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/crm/leads/${id}/convert`, {
        method:"POST", headers: { ...headers, "Content-Type":"application/json" },
        body: JSON.stringify({ companyId: cid }),
      });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل التحويل"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey:["crm/leads", cid] });
      toast({ title:"تم التحويل إلى عميل" });
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const statusLabel = (s:string) => STATUSES.find(x=>x[0]===s)?.[1] ?? s;
  const interestLabel = (s:string) => INTERESTS.find(x=>x[0]===s)?.[1] ?? s;
  const statusColor = (s:string) =>
    s==="converted" ? "bg-emerald-100 text-emerald-800" :
    s==="qualified" ? "bg-sky-100 text-sky-800" :
    s==="rejected"  ? "bg-rose-100 text-rose-800" :
    s==="contacted" ? "bg-amber-100 text-amber-800" :
                      "bg-slate-100 text-slate-700";
  const interestColor = (s:string) =>
    s==="hot" ? "bg-rose-100 text-rose-800" :
    s==="warm"? "bg-amber-100 text-amber-800" :
                "bg-slate-100 text-slate-700";

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <UserSquare2 className="h-6 w-6 text-pink-600" />
            العملاء المحتملون (Leads)
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            متابعة وتأهيل العملاء الجدد — {rows.length} عميل محتمل
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-lead" className="bg-pink-600 hover:bg-pink-700">
          <Plus className="h-4 w-4 ms-2" />عميل محتمل جديد
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث بالاسم، الكود، الجوال…" value={search}
            onChange={(e)=>setSearch(e.target.value)} className="pe-8" data-testid="input-search" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {rows.length}</span>
      </div>

      {showForm && (
        <FormPanel icon={editing?Pencil:Plus}
          title={editing?`تعديل: ${editing.name}`:"عميل محتمل جديد"}
          subtitle={editing?`الكود: ${editing.code}`:"الكود يُولَّد تلقائياً (LD0001)"}
          width="3xl"
          onClose={()=>{ setShowForm(false); setEditing(null); }}
          onSave={()=>saveMut.mutate()} saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>الكود</Label>
              <Input value={form.code} onChange={(e)=>setForm({...form, code:e.target.value})} placeholder="تلقائي LD0001" /></div>
            <div><Label>الاسم *</Label>
              <Input value={form.name} onChange={(e)=>setForm({...form, name:e.target.value})} data-testid="input-name" /></div>
            <div><Label>الجوال</Label>
              <Input value={form.mobile} onChange={(e)=>setForm({...form, mobile:e.target.value})} /></div>
            <div><Label>البريد الإلكتروني</Label>
              <Input type="email" value={form.email} onChange={(e)=>setForm({...form, email:e.target.value})} /></div>
            <div><Label>المصدر</Label>
              <Input value={form.source} onChange={(e)=>setForm({...form, source:e.target.value})} placeholder="Facebook / Google / Referral…" /></div>
            <div><Label>النشاط</Label>
              <Input value={form.industry} onChange={(e)=>setForm({...form, industry:e.target.value})} /></div>
            <div><Label>مستوى الاهتمام</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.interestLevel} onChange={(e)=>setForm({...form, interestLevel:e.target.value})}>
                {INTERESTS.map(([v,l])=> <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>الحالة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.status} onChange={(e)=>setForm({...form, status:e.target.value})}>
                {STATUSES.map(([v,l])=> <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div className="md:col-span-2"><Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e)=>setForm({...form, notes:e.target.value})} /></div>
          </div>
        </FormPanel>
      )}

      {/* Mobile cards (md-hidden) */}
      <div className="md:hidden space-y-3">
        {isLoading && <div className="text-center py-8 text-muted-foreground text-sm">جاري التحميل…</div>}
        {!isLoading && filtered.length === 0 && <div className="text-center py-8 text-muted-foreground text-sm">لا توجد بيانات</div>}
        {filtered.map(l => (
          <div key={l.id} className="rounded-2xl bg-white border border-pink-100 shadow-sm overflow-hidden">
            <div className="bg-gradient-to-r from-pink-500 to-pink-600 px-4 py-2.5 flex items-center justify-between">
              <span className="text-white font-mono text-sm font-bold">{l.code}</span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/95 ${statusColor(l.status).replace(/bg-\w+-\d+/g,'').trim()}`}>{statusLabel(l.status)}</span>
            </div>
            <div className="p-3 space-y-2">
              <div className="flex items-start gap-2">
                <div className="h-10 w-10 rounded-full bg-pink-100 grid place-items-center text-pink-700 font-bold shrink-0">{(l.name ?? "ع")[0]}</div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-sm truncate">{l.name}</p>
                  {l.mobile && <a href={`tel:${l.mobile}`} className="text-xs text-pink-600 font-mono">{l.mobile}</a>}
                </div>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${interestColor(l.interestLevel)}`}>{interestLabel(l.interestLevel)}</span>
              </div>
              {l.source && <div className="text-xs bg-slate-50 rounded p-1.5 px-2"><span className="text-muted-foreground">المصدر: </span><span className="font-semibold">{l.source}</span></div>}
            </div>
            <div className={`grid ${l.convertedCustomerId ? 'grid-cols-2' : 'grid-cols-3'} border-t divide-x divide-slate-100 [direction:ltr]`}>
              <button onClick={()=>setDel(l)} className="py-2.5 text-rose-600 text-xs font-semibold hover:bg-rose-50 flex items-center justify-center gap-1"><Trash2 className="h-3.5 w-3.5" />حذف</button>
              {!l.convertedCustomerId && (
                <button onClick={()=>convertMut.mutate(l.id)} className="py-2.5 text-emerald-700 text-xs font-semibold hover:bg-emerald-50 flex items-center justify-center gap-1"><ArrowRightLeft className="h-3.5 w-3.5" />تحويل</button>
              )}
              <button onClick={()=>openEdit(l)} className="py-2.5 text-pink-700 text-xs font-semibold hover:bg-pink-50 flex items-center justify-center gap-1"><Pencil className="h-3.5 w-3.5" />تعديل</button>
            </div>
          </div>
        ))}
      </div>

      {/* Mobile FAB */}
      <button onClick={openNew} className="md:hidden fixed bottom-6 end-6 z-40 group" aria-label="عميل محتمل جديد">
        <span className="absolute inset-0 rounded-full bg-pink-400/40 animate-ping" />
        <span className="relative h-14 w-14 rounded-full bg-gradient-to-br from-pink-500 to-pink-600 ring-4 ring-white shadow-2xl grid place-items-center text-white">
          <Plus className="h-7 w-7" />
        </span>
      </button>

      <div className="hidden md:block border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-pink-50 to-pink-100 text-pink-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">الكود</th>
                <th className="px-3 py-2 text-start font-semibold">الاسم</th>
                <th className="px-3 py-2 text-start font-semibold">الجوال</th>
                <th className="px-3 py-2 text-start font-semibold">المصدر</th>
                <th className="px-3 py-2 text-start font-semibold">الاهتمام</th>
                <th className="px-3 py-2 text-start font-semibold">الحالة</th>
                <th className="px-3 py-2 text-center font-semibold w-32">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && filtered.length===0 && <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">لا توجد بيانات</td></tr>}
              {filtered.map(l => (
                <tr key={l.id} className="hover:bg-pink-50/40" data-testid={`row-lead-${l.id}`}>
                  <td className="px-3 py-2 font-mono">{l.code}</td>
                  <td className="px-3 py-2 font-semibold">{l.name}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">{l.mobile || "—"}</td>
                  <td className="px-3 py-2">{l.source || "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${interestColor(l.interestLevel)}`}>
                      {interestLabel(l.interestLevel)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${statusColor(l.status)}`}>
                      {statusLabel(l.status)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      {!l.convertedCustomerId && (
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-emerald-600 hover:bg-emerald-50"
                          onClick={()=>convertMut.mutate(l.id)} title="تحويل إلى عميل" data-testid={`btn-convert-${l.id}`}>
                          <ArrowRightLeft className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={()=>openEdit(l)} data-testid={`btn-edit-${l.id}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={()=>setDel(l)} data-testid={`btn-delete-${l.id}`}>
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
            <AlertDialogTitle>حذف العميل المحتمل</AlertDialogTitle>
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
