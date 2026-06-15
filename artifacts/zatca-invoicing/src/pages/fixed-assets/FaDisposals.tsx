import { useState, useMemo } from "react";
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
import { Plus, Trash2 } from "lucide-react";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Disposal = {
  id: number; code: string; assetId: number; type: string; disposalDate: string;
  salePrice: string; scrapValue: string; bookValueAtDisposal: string;
  gainLoss: string; buyerName: string | null; reason: string | null; notes: string | null;
};
type Asset = { id: number; code: string; nameAr: string; bookValue: string };

const TYPES = [
  ["sale","بيع"],["scrap","تخريد"],["full_depreciation","إهلاك كامل"],["write_off","شطب"],
] as const;

const EMPTY = {
  code:"", assetId:"", type:"sale",
  disposalDate: new Date().toISOString().slice(0,10),
  salePrice:"0", scrapValue:"0",
  buyerName:"", reason:"", notes:"",
};

export default function FaDisposals() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [del, setDel] = useState<Disposal | null>(null);

  const { data: rows = [], isLoading } = useQuery<Disposal[]>({
    queryKey:["fa/disposals", cid],
    queryFn: async () => (await fetch(`${API}/api/fixed-assets/disposals?companyId=${cid}`, { headers })).json(),
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
  const selectedAsset = useMemo(() => assets.find(a => a.id === Number(form.assetId)), [assets, form.assetId]);
  const bookVal = selectedAsset ? Number(selectedAsset.bookValue || 0) : 0;
  const proceeds = form.type === "sale" ? Number(form.salePrice||0)
                 : form.type === "scrap" ? Number(form.scrapValue||0) : 0;
  const projectedGainLoss = proceeds - bookVal;

  function openNew() { setForm({...EMPTY, assetId: assets[0]?.id ? String(assets[0].id) : ""}); setShowForm(true); }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.assetId) throw new Error("اختر الأصل");
      const body = { ...form, companyId: cid, assetId: Number(form.assetId) };
      const r = await fetch(`${API}/api/fixed-assets/disposals`, { method:"POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey:["fa/disposals", cid] });
      qc.invalidateQueries({ queryKey:["fa/assets", cid] });
      toast({ title: "تم تسجيل التخلص" });
      setShowForm(false); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/fixed-assets/disposals/${del.id}?companyId=${cid}`, { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey:["fa/disposals", cid] }); toast({ title:"تم الحذف" }); setDel(null); },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  const typeLabel = (t:string) => TYPES.find(x=>x[0]===t)?.[1] ?? t;

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Trash2 className="h-6 w-6 text-rose-600" />
            التخلص من الأصول (بيع/تخريد)
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            تسجيل عمليات البيع والتخريد مع حساب الربح/الخسارة وقيد محاسبي تلقائي — {rows.length} عملية
          </p>
        </div>
        <Button onClick={openNew} className="bg-rose-600 hover:bg-rose-700">
          <Plus className="h-4 w-4 ms-2" />تخلص جديد
        </Button>
      </div>

      {showForm && (
        <FormPanel icon={Plus}
          title="تخلص من أصل" width="3xl"
          onClose={()=>setShowForm(false)}
          onSave={()=>saveMut.mutate()} saving={saveMut.isPending}
          saveLabel="تسجيل التخلص" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>الأصل *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.assetId} onChange={(e)=>setForm({...form,assetId:e.target.value})}>
                <option value="">— اختر —</option>
                {assets.map(a => <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>)}
              </select></div>
            <div><Label>نوع العملية</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.type} onChange={(e)=>setForm({...form,type:e.target.value})}>
                {TYPES.map(([v,l])=> <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>التاريخ</Label>
              <DateField value={form.disposalDate} onChange={(e)=>setForm({...form,disposalDate:e.target.value})} /></div>
            {form.type === "sale" && <>
              <div><Label>سعر البيع</Label>
                <Input type="number" step="0.01" value={form.salePrice} onChange={(e)=>setForm({...form,salePrice:e.target.value})} /></div>
              <div className="md:col-span-2"><Label>المشتري</Label>
                <Input value={form.buyerName} onChange={(e)=>setForm({...form,buyerName:e.target.value})} /></div>
            </>}
            {form.type === "scrap" && (
              <div><Label>قيمة الخردة الفعلية</Label>
                <Input type="number" step="0.01" value={form.scrapValue} onChange={(e)=>setForm({...form,scrapValue:e.target.value})} /></div>
            )}
            <div className="md:col-span-2"><Label>سبب التخلص</Label>
              <Input value={form.reason} onChange={(e)=>setForm({...form,reason:e.target.value})} /></div>
            <div className="md:col-span-2"><Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e)=>setForm({...form,notes:e.target.value})} /></div>

            {selectedAsset && (
              <div className="md:col-span-2 grid grid-cols-3 gap-3 p-3 rounded-lg bg-slate-50 border">
                <div><div className="text-xs text-slate-500">القيمة الدفترية</div>
                  <div className="font-mono font-bold text-slate-800">{bookVal.toLocaleString("ar-EG")}</div></div>
                <div><div className="text-xs text-slate-500">المتحصل</div>
                  <div className="font-mono font-bold text-slate-800">{proceeds.toLocaleString("ar-EG")}</div></div>
                <div><div className="text-xs text-slate-500">الربح / الخسارة</div>
                  <div className={`font-mono font-bold ${projectedGainLoss >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                    {projectedGainLoss >= 0 ? "+" : ""}{projectedGainLoss.toLocaleString("ar-EG")}
                  </div></div>
              </div>
            )}
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <table className="w-full text-xs" dir="rtl">
          <thead className="bg-gradient-to-b from-rose-50 to-rose-100 text-rose-900 border-b">
            <tr>
              <th className="px-3 py-2 text-start font-semibold">الكود</th>
              <th className="px-3 py-2 text-start font-semibold">الأصل</th>
              <th className="px-3 py-2 text-start font-semibold">النوع</th>
              <th className="px-3 py-2 text-start font-semibold">التاريخ</th>
              <th className="px-3 py-2 text-start font-semibold">الدفترية</th>
              <th className="px-3 py-2 text-start font-semibold">المتحصل</th>
              <th className="px-3 py-2 text-start font-semibold">ربح/خسارة</th>
              <th className="px-3 py-2 text-center font-semibold w-16">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
            {!isLoading && rows.length===0 && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">لا توجد سجلات</td></tr>}
            {rows.map(d => {
              const proc = d.type === "sale" ? Number(d.salePrice) : d.type === "scrap" ? Number(d.scrapValue) : 0;
              const gl = Number(d.gainLoss);
              return (
                <tr key={d.id} className="hover:bg-rose-50/40">
                  <td className="px-3 py-2 font-mono">{d.code}</td>
                  <td className="px-3 py-2 font-semibold">{assetName(d.assetId)}</td>
                  <td className="px-3 py-2">{typeLabel(d.type)}</td>
                  <td className="px-3 py-2 font-mono">{d.disposalDate}</td>
                  <td className="px-3 py-2 font-mono">{Number(d.bookValueAtDisposal).toLocaleString("ar-EG")}</td>
                  <td className="px-3 py-2 font-mono">{proc.toLocaleString("ar-EG")}</td>
                  <td className={`px-3 py-2 font-mono font-bold ${gl >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                    {gl >= 0 ? "+" : ""}{gl.toLocaleString("ar-EG")}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={()=>setDel(d)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <AlertDialog open={!!del} onOpenChange={(o)=>!o && setDel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف سجل التخلص</AlertDialogTitle>
            <AlertDialogDescription>سيتم حذف السجل «{del?.code}». لن يتم استرجاع حالة الأصل تلقائياً.</AlertDialogDescription>
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
