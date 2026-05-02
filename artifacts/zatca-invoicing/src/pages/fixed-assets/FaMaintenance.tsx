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
import { Plus, Pencil, Trash2, Wrench, Search } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Maint = {
  id: number; code: string; assetId: number; type: string; serviceDate: string;
  cost: string; vendorName: string | null; technicianName: string | null;
  description: string | null; kmAtService: number | null; approved: boolean; notes: string | null;
};
type Asset = { id: number; code: string; nameAr: string };

const TYPES = [
  ["periodic","دورية"],["emergency","طارئة"],["preventive","وقائية"],["corrective","تصحيحية"],
] as const;

const EMPTY = { code:"", assetId:"", type:"periodic",
  serviceDate: new Date().toISOString().slice(0,10),
  cost:"0", vendorName:"", technicianName:"", description:"",
  kmAtService:"", approved:false, notes:"" };

export default function FaMaintenance() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Maint | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [del, setDel] = useState<Maint | null>(null);

  const { data: rows = [], isLoading } = useQuery<Maint[]>({
    queryKey:["fa/maintenance", cid],
    queryFn: async () => (await fetch(`${API}/api/fixed-assets/maintenance?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: assets = [] } = useQuery<Asset[]>({
    queryKey:["fa/assets", cid],
    queryFn: async () => (await fetch(`${API}/api/fixed-assets/assets?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });

  const assetName = (id:number) => {
    const a = assets.find(x=>x.id===id); return a ? `${a.code} — ${a.nameAr}` : `#${id}`;
  };
  const filtered = rows.filter(m => !search.trim() ||
    m.code?.toLowerCase().includes(search.toLowerCase()) ||
    assetName(m.assetId).toLowerCase().includes(search.toLowerCase()));

  function openNew() { setEditing(null); setForm({...EMPTY, assetId: assets[0]?.id ? String(assets[0].id) : ""}); setShowForm(true); }
  function openEdit(m: Maint) {
    setEditing(m);
    setForm({
      code:m.code, assetId:String(m.assetId), type:m.type,
      serviceDate:m.serviceDate, cost:String(m.cost),
      vendorName:m.vendorName??"", technicianName:m.technicianName??"",
      description:m.description??"", kmAtService:m.kmAtService?String(m.kmAtService):"",
      approved:m.approved, notes:m.notes??"",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.assetId) throw new Error("اختر الأصل");
      const body = { ...form, companyId: cid,
        assetId: Number(form.assetId),
        kmAtService: form.kmAtService ? Number(form.kmAtService) : null };
      const url = editing ? `${API}/api/fixed-assets/maintenance/${editing.id}` : `${API}/api/fixed-assets/maintenance`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey:["fa/maintenance", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/fixed-assets/maintenance/${del.id}?companyId=${cid}`, { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey:["fa/maintenance", cid] }); toast({ title:"تم الحذف" }); setDel(null); },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  const totalCost = rows.reduce((s,m)=>s+Number(m.cost||0), 0);
  const typeLabel = (t:string) => TYPES.find(x=>x[0]===t)?.[1] ?? t;

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Wrench className="h-6 w-6 text-orange-600" />
            صيانة الأصول
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            سجل الصيانة الدورية والطارئة — {rows.length} عملية بإجمالي {totalCost.toLocaleString("ar-EG")} ر.س
          </p>
        </div>
        <Button onClick={openNew} className="bg-orange-600 hover:bg-orange-700">
          <Plus className="h-4 w-4 ms-2" />صيانة جديدة
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="بحث بالكود أو الأصل…" value={search}
            onChange={(e)=>setSearch(e.target.value)} className="pe-8" />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} من {rows.length}</span>
      </div>

      {showForm && (
        <FormPanel icon={editing?Pencil:Plus}
          title={editing?`تعديل: ${editing.code}`:"عملية صيانة جديدة"}
          width="4xl"
          onClose={()=>{ setShowForm(false); setEditing(null); }}
          onSave={()=>saveMut.mutate()} saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>الكود</Label>
              <Input value={form.code} onChange={(e)=>setForm({...form,code:e.target.value})} placeholder="تلقائي FAM0001" /></div>
            <div><Label>الأصل *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.assetId} onChange={(e)=>setForm({...form,assetId:e.target.value})}>
                <option value="">— اختر —</option>
                {assets.map(a => <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>)}
              </select></div>
            <div><Label>نوع الصيانة</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.type} onChange={(e)=>setForm({...form,type:e.target.value})}>
                {TYPES.map(([v,l])=> <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>التاريخ</Label>
              <Input type="date" value={form.serviceDate} onChange={(e)=>setForm({...form,serviceDate:e.target.value})} /></div>
            <div><Label>التكلفة</Label>
              <Input type="number" step="0.01" value={form.cost} onChange={(e)=>setForm({...form,cost:e.target.value})} /></div>
            <div><Label>المورد / الورشة</Label>
              <Input value={form.vendorName} onChange={(e)=>setForm({...form,vendorName:e.target.value})} /></div>
            <div><Label>الفني</Label>
              <Input value={form.technicianName} onChange={(e)=>setForm({...form,technicianName:e.target.value})} /></div>
            <div><Label>كم وقت الصيانة</Label>
              <Input type="number" value={form.kmAtService} onChange={(e)=>setForm({...form,kmAtService:e.target.value})} /></div>
            <div className="md:col-span-2"><Label>وصف العطل / العمل المنجز</Label>
              <Input value={form.description} onChange={(e)=>setForm({...form,description:e.target.value})} /></div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="appr" checked={form.approved}
                onChange={(e)=>setForm({...form,approved:e.target.checked})} className="h-4 w-4" />
              <Label htmlFor="appr">معتمدة</Label>
            </div>
            <div><Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e)=>setForm({...form,notes:e.target.value})} /></div>
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <table className="w-full text-xs" dir="rtl">
          <thead className="bg-gradient-to-b from-orange-50 to-orange-100 text-orange-900 border-b">
            <tr>
              <th className="px-3 py-2 text-start font-semibold">الكود</th>
              <th className="px-3 py-2 text-start font-semibold">الأصل</th>
              <th className="px-3 py-2 text-start font-semibold">النوع</th>
              <th className="px-3 py-2 text-start font-semibold">التاريخ</th>
              <th className="px-3 py-2 text-start font-semibold">التكلفة</th>
              <th className="px-3 py-2 text-start font-semibold">المورد</th>
              <th className="px-3 py-2 text-start font-semibold">الحالة</th>
              <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
            {!isLoading && filtered.length===0 && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">لا توجد سجلات</td></tr>}
            {filtered.map(m => (
              <tr key={m.id} className="hover:bg-orange-50/40">
                <td className="px-3 py-2 font-mono">{m.code}</td>
                <td className="px-3 py-2 font-semibold">{assetName(m.assetId)}</td>
                <td className="px-3 py-2">{typeLabel(m.type)}</td>
                <td className="px-3 py-2 font-mono">{m.serviceDate}</td>
                <td className="px-3 py-2 font-mono">{Number(m.cost).toLocaleString("ar-EG")}</td>
                <td className="px-3 py-2">{m.vendorName || "—"}</td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${m.approved ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                    {m.approved ? "معتمدة" : "بانتظار اعتماد"}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-center gap-1">
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={()=>openEdit(m)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={()=>setDel(m)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AlertDialog open={!!del} onOpenChange={(o)=>!o && setDel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف سجل الصيانة</AlertDialogTitle>
            <AlertDialogDescription>هل تريد حذف «{del?.code}» نهائياً؟</AlertDialogDescription>
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
