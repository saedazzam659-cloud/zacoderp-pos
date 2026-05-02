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
import { Plus, Pencil, Trash2, Tag } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Category = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  defaultLifeYears: number; defaultDepreciationMethod: string;
  defaultScrapRate: string; isActive: boolean;
};

const METHODS = [
  ["straight_line","قسط ثابت"],["declining_balance","قسط متناقص"],["units_of_production","وحدات الإنتاج"],
] as const;

const EMPTY = { code:"", nameAr:"", nameEn:"", defaultLifeYears:"5",
  defaultDepreciationMethod:"straight_line", defaultScrapRate:"10", isActive:true };

export default function FaCategories() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [editing, setEditing] = useState<Category | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [del, setDel] = useState<Category | null>(null);

  const { data: rows = [], isLoading } = useQuery<Category[]>({
    queryKey:["fa/categories", cid],
    queryFn: async () => (await fetch(`${API}/api/fixed-assets/categories?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });

  function openNew() { setEditing(null); setForm(EMPTY); setShowForm(true); }
  function openEdit(c: Category) {
    setEditing(c);
    setForm({
      code:c.code??"", nameAr:c.nameAr??"", nameEn:c.nameEn??"",
      defaultLifeYears:String(c.defaultLifeYears??5),
      defaultDepreciationMethod:c.defaultDepreciationMethod??"straight_line",
      defaultScrapRate:String(c.defaultScrapRate??"10"),
      isActive: c.isActive !== false,
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.nameAr.trim()) throw new Error("الاسم مطلوب");
      const body = { ...form, companyId: cid, defaultLifeYears: Number(form.defaultLifeYears||5) };
      const url = editing ? `${API}/api/fixed-assets/categories/${editing.id}` : `${API}/api/fixed-assets/categories`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey:["fa/categories", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/fixed-assets/categories/${del.id}?companyId=${cid}`, { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey:["fa/categories", cid] }); toast({ title:"تم الحذف" }); setDel(null); },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  const methodLabel = (m:string) => METHODS.find(x=>x[0]===m)?.[1] ?? m;

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Tag className="h-6 w-6 text-amber-600" />
            فئات الأصول الثابتة
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            تصنيف الأصول (سيارات، معدات، أثاث، حاسبات…) — {rows.length} فئة
          </p>
        </div>
        <Button onClick={openNew} className="bg-amber-600 hover:bg-amber-700">
          <Plus className="h-4 w-4 ms-2" />فئة جديدة
        </Button>
      </div>

      {showForm && (
        <FormPanel icon={editing?Pencil:Plus}
          title={editing?`تعديل: ${editing.nameAr}`:"فئة جديدة"} width="3xl"
          onClose={()=>{ setShowForm(false); setEditing(null); }}
          onSave={()=>saveMut.mutate()} saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>الكود</Label>
              <Input value={form.code} onChange={(e)=>setForm({...form,code:e.target.value})} placeholder="تلقائي FAC0001" /></div>
            <div><Label>الاسم (عربي) *</Label>
              <Input value={form.nameAr} onChange={(e)=>setForm({...form,nameAr:e.target.value})} placeholder="سيارات، معدات…" /></div>
            <div><Label>الاسم (إنجليزي)</Label>
              <Input value={form.nameEn} onChange={(e)=>setForm({...form,nameEn:e.target.value})} /></div>
            <div><Label>العمر الافتراضي (سنوات)</Label>
              <Input type="number" value={form.defaultLifeYears} onChange={(e)=>setForm({...form,defaultLifeYears:e.target.value})} /></div>
            <div><Label>طريقة الإهلاك الافتراضية</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.defaultDepreciationMethod} onChange={(e)=>setForm({...form,defaultDepreciationMethod:e.target.value})}>
                {METHODS.map(([v,l])=> <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><Label>نسبة الخردة الافتراضية (%)</Label>
              <Input type="number" step="0.01" value={form.defaultScrapRate} onChange={(e)=>setForm({...form,defaultScrapRate:e.target.value})} /></div>
            <div className="flex items-center gap-2 mt-6">
              <input type="checkbox" id="active-cat" checked={form.isActive}
                onChange={(e)=>setForm({...form,isActive:e.target.checked})} className="h-4 w-4" />
              <Label htmlFor="active-cat">نشطة</Label>
            </div>
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <table className="w-full text-xs" dir="rtl">
          <thead className="bg-gradient-to-b from-amber-50 to-amber-100 text-amber-900 border-b">
            <tr>
              <th className="px-3 py-2 text-start font-semibold">الكود</th>
              <th className="px-3 py-2 text-start font-semibold">الاسم</th>
              <th className="px-3 py-2 text-start font-semibold">العمر (سنوات)</th>
              <th className="px-3 py-2 text-start font-semibold">طريقة الإهلاك</th>
              <th className="px-3 py-2 text-start font-semibold">نسبة الخردة</th>
              <th className="px-3 py-2 text-start font-semibold">الحالة</th>
              <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
            {!isLoading && rows.length===0 && <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">لا توجد فئات</td></tr>}
            {rows.map(c => (
              <tr key={c.id} className="hover:bg-amber-50/40">
                <td className="px-3 py-2 font-mono">{c.code}</td>
                <td className="px-3 py-2 font-semibold">{c.nameAr}</td>
                <td className="px-3 py-2">{c.defaultLifeYears}</td>
                <td className="px-3 py-2">{methodLabel(c.defaultDepreciationMethod)}</td>
                <td className="px-3 py-2">{c.defaultScrapRate}%</td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${c.isActive ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>
                    {c.isActive ? "نشطة" : "متوقفة"}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-center gap-1">
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={()=>openEdit(c)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={()=>setDel(c)}>
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
            <AlertDialogTitle>حذف الفئة</AlertDialogTitle>
            <AlertDialogDescription>هل تريد حذف الفئة «{del?.nameAr}»؟</AlertDialogDescription>
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
