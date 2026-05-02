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
import { Plus, Trash2, ArrowRightLeft } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Transfer = {
  id: number; code: string; assetId: number;
  fromBranchId: number | null; toBranchId: number | null;
  fromCostCenterId: number | null; toCostCenterId: number | null;
  transferDate: string; reason: string | null; approvedBy: string | null; notes: string | null;
};
type Asset = { id: number; code: string; nameAr: string };
type Branch = { id: number; nameAr?: string; name?: string };

const EMPTY = {
  code:"", assetId:"",
  fromBranchId:"", toBranchId:"",
  fromCostCenterId:"", toCostCenterId:"",
  transferDate: new Date().toISOString().slice(0,10),
  reason:"", approvedBy:"", notes:"",
};

export default function FaTransfers() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [del, setDel] = useState<Transfer | null>(null);

  const { data: rows = [], isLoading } = useQuery<Transfer[]>({
    queryKey:["fa/transfers", cid],
    queryFn: async () => (await fetch(`${API}/api/fixed-assets/transfers?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: assets = [] } = useQuery<Asset[]>({
    queryKey:["fa/assets", cid],
    queryFn: async () => (await fetch(`${API}/api/fixed-assets/assets?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey:["branches", cid],
    queryFn: async () => (await fetch(`${API}/api/branches?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });

  const assetName = (id:number) => {
    const a = assets.find(x=>x.id===id); return a ? `${a.code} — ${a.nameAr}` : `#${id}`;
  };
  const branchName = (id:number|null) => {
    if (!id) return "—";
    const b = branches.find(x=>x.id===id);
    return b ? (b.nameAr || b.name || `#${id}`) : `#${id}`;
  };

  function openNew() { setForm({...EMPTY, assetId: assets[0]?.id ? String(assets[0].id) : ""}); setShowForm(true); }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.assetId) throw new Error("اختر الأصل");
      if (!form.toBranchId && !form.toCostCenterId) throw new Error("حدد الجهة المستلمة");
      const body = { ...form, companyId: cid,
        assetId: Number(form.assetId),
        fromBranchId: form.fromBranchId ? Number(form.fromBranchId) : null,
        toBranchId:   form.toBranchId   ? Number(form.toBranchId)   : null,
        fromCostCenterId: form.fromCostCenterId ? Number(form.fromCostCenterId) : null,
        toCostCenterId:   form.toCostCenterId   ? Number(form.toCostCenterId)   : null,
      };
      const r = await fetch(`${API}/api/fixed-assets/transfers`, { method:"POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey:["fa/transfers", cid] });
      qc.invalidateQueries({ queryKey:["fa/assets", cid] });
      toast({ title: "تم نقل الأصل" });
      setShowForm(false); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/fixed-assets/transfers/${del.id}?companyId=${cid}`, { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey:["fa/transfers", cid] }); toast({ title:"تم الحذف" }); setDel(null); },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ArrowRightLeft className="h-6 w-6 text-indigo-600" />
            نقل الأصول
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            تحويل الأصول بين الفروع/الأقسام — {rows.length} عملية نقل
          </p>
        </div>
        <Button onClick={openNew} className="bg-indigo-600 hover:bg-indigo-700">
          <Plus className="h-4 w-4 ms-2" />نقل جديد
        </Button>
      </div>

      {showForm && (
        <FormPanel icon={Plus}
          title="نقل أصل جديد" width="3xl"
          onClose={()=>setShowForm(false)}
          onSave={()=>saveMut.mutate()} saving={saveMut.isPending}
          saveLabel="نقل" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>الأصل *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.assetId} onChange={(e)=>setForm({...form,assetId:e.target.value})}>
                <option value="">— اختر —</option>
                {assets.map(a => <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>)}
              </select></div>
            <div><Label>تاريخ النقل</Label>
              <Input type="date" value={form.transferDate} onChange={(e)=>setForm({...form,transferDate:e.target.value})} /></div>
            <div><Label>من فرع</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.fromBranchId} onChange={(e)=>setForm({...form,fromBranchId:e.target.value})}>
                <option value="">— بدون —</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.nameAr || b.name}</option>)}
              </select></div>
            <div><Label>إلى فرع *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.toBranchId} onChange={(e)=>setForm({...form,toBranchId:e.target.value})}>
                <option value="">— بدون —</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.nameAr || b.name}</option>)}
              </select></div>
            <div className="md:col-span-2"><Label>سبب النقل</Label>
              <Input value={form.reason} onChange={(e)=>setForm({...form,reason:e.target.value})} /></div>
            <div><Label>اعتماد المسؤول</Label>
              <Input value={form.approvedBy} onChange={(e)=>setForm({...form,approvedBy:e.target.value})} /></div>
            <div><Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e)=>setForm({...form,notes:e.target.value})} /></div>
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <table className="w-full text-xs" dir="rtl">
          <thead className="bg-gradient-to-b from-indigo-50 to-indigo-100 text-indigo-900 border-b">
            <tr>
              <th className="px-3 py-2 text-start font-semibold">الكود</th>
              <th className="px-3 py-2 text-start font-semibold">الأصل</th>
              <th className="px-3 py-2 text-start font-semibold">من فرع</th>
              <th className="px-3 py-2 text-start font-semibold">إلى فرع</th>
              <th className="px-3 py-2 text-start font-semibold">التاريخ</th>
              <th className="px-3 py-2 text-start font-semibold">السبب</th>
              <th className="px-3 py-2 text-center font-semibold w-16">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
            {!isLoading && rows.length===0 && <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">لا توجد سجلات</td></tr>}
            {rows.map(t => (
              <tr key={t.id} className="hover:bg-indigo-50/40">
                <td className="px-3 py-2 font-mono">{t.code}</td>
                <td className="px-3 py-2 font-semibold">{assetName(t.assetId)}</td>
                <td className="px-3 py-2">{branchName(t.fromBranchId)}</td>
                <td className="px-3 py-2">{branchName(t.toBranchId)}</td>
                <td className="px-3 py-2 font-mono">{t.transferDate}</td>
                <td className="px-3 py-2">{t.reason || "—"}</td>
                <td className="px-3 py-2 text-center">
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={()=>setDel(t)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AlertDialog open={!!del} onOpenChange={(o)=>!o && setDel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف سجل النقل</AlertDialogTitle>
            <AlertDialogDescription>سيتم حذف سجل النقل «{del?.code}» — لن يتم إرجاع الأصل تلقائياً.</AlertDialogDescription>
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
