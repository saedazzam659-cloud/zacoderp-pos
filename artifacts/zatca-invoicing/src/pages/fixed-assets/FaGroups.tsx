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
import { Plus, Pencil, Trash2, FolderTree, CornerDownRight } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Group = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  parentId: number | null; isActive: boolean;
};

const EMPTY = { code:"", nameAr:"", nameEn:"", parentId:"", isActive:true };

// Order groups as a tree (parents first, children indented) and compute a depth
// for each row so the table can render the hierarchy visually.
function toTree(rows: Group[]): { row: Group; depth: number }[] {
  const byParent = new Map<number | null, Group[]>();
  for (const g of rows) {
    const key = g.parentId ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(g);
  }
  const ids = new Set(rows.map(r => r.id));
  const out: { row: Group; depth: number }[] = [];
  const seen = new Set<number>();
  const walk = (parent: number | null, depth: number) => {
    const kids = (byParent.get(parent) ?? []).slice().sort((a, b) => a.nameAr.localeCompare(b.nameAr, "ar"));
    for (const g of kids) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      out.push({ row: g, depth });
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  // Orphans (parentId points to a missing/foreign row) — surface at root level.
  for (const g of rows) {
    if (!seen.has(g.id) && (g.parentId == null || !ids.has(g.parentId))) {
      seen.add(g.id); out.push({ row: g, depth: 0 });
    }
  }
  for (const g of rows) if (!seen.has(g.id)) { seen.add(g.id); out.push({ row: g, depth: 0 }); }
  return out;
}

export default function FaGroups() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [editing, setEditing] = useState<Group | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [del, setDel] = useState<Group | null>(null);

  const { data: rows = [], isLoading } = useQuery<Group[]>({
    queryKey:["fa/groups", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/fixed-assets/groups?companyId=${cid}`, { headers });
      const j = await r.json();
      return Array.isArray(j) ? j : [];
    },
    enabled: !!cid,
  });

  const nameById = new Map(rows.map(g => [g.id, g.nameAr]));
  const tree = toTree(rows);

  // Parent options exclude the group being edited (can't parent itself).
  const parentOptions = rows.filter(g => !editing || g.id !== editing.id);

  function openNew() { setEditing(null); setForm(EMPTY); setShowForm(true); }
  function openEdit(g: Group) {
    setEditing(g);
    setForm({
      code:g.code??"", nameAr:g.nameAr??"", nameEn:g.nameEn??"",
      parentId: g.parentId ? String(g.parentId) : "",
      isActive: g.isActive !== false,
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.nameAr.trim()) throw new Error("الاسم مطلوب");
      const body = { ...form, companyId: cid,
        parentId: form.parentId ? Number(form.parentId) : null };
      const url = editing ? `${API}/api/fixed-assets/groups/${editing.id}` : `${API}/api/fixed-assets/groups`;
      const r = await fetch(url, { method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الحفظ"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey:["fa/groups", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false); setEditing(null); setForm(EMPTY);
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      const r = await fetch(`${API}/api/fixed-assets/groups/${del.id}?companyId=${cid}`, { method:"DELETE", headers });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "تعذّر الحذف"); }
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey:["fa/groups", cid] }); toast({ title:"تم الحذف" }); setDel(null); },
    onError: (e:any) => { toast({ title:"تعذّر الحذف", description: e?.message, variant:"destructive" }); setDel(null); },
  });

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FolderTree className="h-6 w-6 text-cyan-600" />
            مجموعات الأصول
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            تصنيف هرمي للأصول (مجموعة رئيسية ← مجموعة فرعية) على المنوال العالمي — {rows.length} مجموعة
          </p>
        </div>
        <Button onClick={openNew} className="bg-cyan-600 hover:bg-cyan-700">
          <Plus className="h-4 w-4 ms-2" />مجموعة جديدة
        </Button>
      </div>

      {showForm && (
        <FormPanel icon={editing?Pencil:Plus}
          title={editing?`تعديل: ${editing.nameAr}`:"مجموعة جديدة"} width="2xl"
          onClose={()=>{ setShowForm(false); setEditing(null); }}
          onSave={()=>saveMut.mutate()} saving={saveMut.isPending}
          saveLabel="حفظ" cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>الكود</Label>
              <Input value={form.code} onChange={(e)=>setForm({...form,code:e.target.value})} placeholder="تلقائي FAG0001" /></div>
            <div><Label>الاسم (عربي) *</Label>
              <Input value={form.nameAr} onChange={(e)=>setForm({...form,nameAr:e.target.value})} placeholder="أصول ثابتة، عقارات…" /></div>
            <div><Label>الاسم (إنجليزي)</Label>
              <Input value={form.nameEn} onChange={(e)=>setForm({...form,nameEn:e.target.value})} /></div>
            <div><Label>المجموعة الرئيسية</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.parentId} onChange={(e)=>setForm({...form,parentId:e.target.value})}>
                <option value="">— بدون (مجموعة رئيسية) —</option>
                {parentOptions.map(g => <option key={g.id} value={g.id}>{g.nameAr}</option>)}
              </select>
              <p className="text-[11px] text-muted-foreground mt-1">اتركها فارغة لتكون مجموعة رئيسية في أعلى الشجرة.</p></div>
            <div className="flex items-center gap-2 mt-6">
              <input type="checkbox" id="active-grp" checked={form.isActive}
                onChange={(e)=>setForm({...form,isActive:e.target.checked})} className="h-4 w-4" />
              <Label htmlFor="active-grp">نشطة</Label>
            </div>
          </div>
        </FormPanel>
      )}

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <table className="w-full text-xs" dir="rtl">
          <thead className="bg-gradient-to-b from-cyan-50 to-cyan-100 text-cyan-900 border-b">
            <tr>
              <th className="px-3 py-2 text-start font-semibold">الكود</th>
              <th className="px-3 py-2 text-start font-semibold">الاسم</th>
              <th className="px-3 py-2 text-start font-semibold">المجموعة الرئيسية</th>
              <th className="px-3 py-2 text-start font-semibold">الحالة</th>
              <th className="px-3 py-2 text-center font-semibold w-24">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && <tr><td colSpan={5} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
            {!isLoading && rows.length===0 && <tr><td colSpan={5} className="text-center py-8 text-muted-foreground">لا توجد مجموعات</td></tr>}
            {tree.map(({ row: g, depth }) => (
              <tr key={g.id} className="hover:bg-cyan-50/40">
                <td className="px-3 py-2 font-mono">{g.code}</td>
                <td className="px-3 py-2 font-semibold">
                  <span className="inline-flex items-center gap-1" style={{ paddingInlineStart: `${depth * 18}px` }}>
                    {depth > 0 && <CornerDownRight className="h-3.5 w-3.5 text-cyan-400 shrink-0" />}
                    {g.nameAr}
                  </span>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {g.parentId ? (nameById.get(g.parentId) ?? "—") : "—"}
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${g.isActive ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>
                    {g.isActive ? "نشطة" : "متوقفة"}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-center gap-1">
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={()=>openEdit(g)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50" onClick={()=>setDel(g)}>
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
            <AlertDialogTitle>حذف المجموعة</AlertDialogTitle>
            <AlertDialogDescription>هل تريد حذف المجموعة «{del?.nameAr}»؟</AlertDialogDescription>
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
