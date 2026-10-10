import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

const EMPTY = { parentGroupId: "", nameAr: "", nameEn: "", description: "", isActive: true, sortOrder: "0" };

export default function ItemSubgroups() {
  const { user, actingCompanyId } = useAuth() as any;
  const cid = actingCompanyId ?? user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<any>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const groupsQuery = useQuery({ queryKey: ["item-groups", cid], queryFn: () => inventoryApi.getItemGroups(cid) });
  const subgroupQueryKey = ["item-subgroups", cid];
  const rowsQuery = useQuery({ queryKey: subgroupQueryKey, queryFn: () => inventoryApi.getItemSubgroups(), enabled: Boolean(cid) });
  const groups = (groupsQuery.data ?? []).filter((g: any) => !g.isPosGroup);
  const rows = rowsQuery.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: subgroupQueryKey });
  const save = useMutation({
    mutationFn: () => editId ? inventoryApi.updateItemSubgroup(editId, { ...form, parentGroupId: Number(form.parentGroupId), sortOrder: Number(form.sortOrder) }) : inventoryApi.createItemSubgroup({ ...form, parentGroupId: Number(form.parentGroupId), sortOrder: Number(form.sortOrder) }),
    onSuccess: () => { refresh(); setForm(EMPTY); setEditId(null); toast({ title: "تم حفظ المجموعة الفرعية" }); },
    onError: (e: any) => toast({ title: e.message || "تعذر الحفظ", variant: "destructive" }),
  });
  const update = useMutation({
    mutationFn: ({ id, data }: any) => inventoryApi.updateItemSubgroup(id, data),
    onSuccess: refresh,
    onError: (e: any) => toast({ title: e.message || "تعذر التحديث", variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: inventoryApi.deleteItemSubgroup,
    onSuccess: refresh,
    onError: (e: any) => toast({ title: e.message || "تعذر الحذف", variant: "destructive" }),
  });
  const reset = () => { setForm(EMPTY); setEditId(null); };

  return <main dir="rtl" className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <Link href="/inventory/item-groups" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground"><ArrowRight className="h-4 w-4" /> فئات الأصناف</Link>
        <h1 className="text-2xl font-bold">المجموعات الفرعية للأصناف</h1>
        <p className="mt-1 text-sm text-muted-foreground">تصنيف اختياري تحت فئة رئيسية، دون تغيير الحسابات أو حركات المخزون.</p>
      </div>
    </header>
    <form className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <label className="grid gap-1 text-sm">المجموعة الرئيسية *
        <select required className="h-10 rounded-md border bg-background px-3" value={form.parentGroupId} onChange={(e) => setForm((p: any) => ({ ...p, parentGroupId: e.target.value }))}>
          <option value="">اختر المجموعة الرئيسية</option>{groups.map((g: any) => <option key={g.id} value={g.id}>{g.nameAr}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">الاسم بالعربية *
        <Input required value={form.nameAr} onChange={(e) => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} placeholder="مثال: مشروبات ساخنة" />
      </label>
      <label className="grid gap-1 text-sm">الاسم بالإنجليزية
        <Input dir="ltr" value={form.nameEn} onChange={(e) => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
      </label>
      <label className="grid gap-1 text-sm">ترتيب العرض
        <Input type="number" min="0" value={form.sortOrder} onChange={(e) => setForm((p: any) => ({ ...p, sortOrder: e.target.value }))} />
      </label>
      <label className="grid gap-1 text-sm md:col-span-2">الوصف (اختياري)
        <Input value={form.description} onChange={(e) => setForm((p: any) => ({ ...p, description: e.target.value }))} />
      </label>
      <div className="flex gap-2 md:col-span-2"><Button type="submit" disabled={save.isPending || !form.parentGroupId || !form.nameAr}><Plus className="me-1 h-4 w-4" />{editId ? "حفظ التعديل" : "إضافة مجموعة فرعية"}</Button>{editId && <Button type="button" variant="outline" onClick={reset}>إلغاء</Button>}</div>
    </form>
    <section className="overflow-hidden rounded-xl border bg-card">
      {rowsQuery.isLoading ? <p className="p-5 text-sm text-muted-foreground">جارٍ تحميل المجموعات…</p> : rows.length === 0 ? <p className="p-5 text-sm text-muted-foreground">لا توجد مجموعات فرعية بعد.</p> : <div className="divide-y">
        {rows.map((row: any) => <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div><div className="font-semibold">{row.nameAr} <span className="text-xs text-muted-foreground">({row.code})</span></div><div className="text-xs text-muted-foreground">{groups.find((g: any) => g.id === row.parentGroupId)?.nameAr ?? "مجموعة رئيسية غير متاحة"} · {row.isActive ? "نشطة" : "غير نشطة"}</div>{row.description && <p className="mt-1 text-sm text-muted-foreground">{row.description}</p>}</div>
          <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => { setEditId(row.id); setForm({ parentGroupId: String(row.parentGroupId), nameAr: row.nameAr, nameEn: row.nameEn ?? "", description: row.description ?? "", isActive: row.isActive, sortOrder: String(row.sortOrder ?? 0) }); }}><Pencil className="me-1 h-4 w-4" />تعديل</Button><Button size="sm" variant="outline" onClick={() => update.mutate({ id: row.id, data: { isActive: !row.isActive } })}><Power className="me-1 h-4 w-4" />{row.isActive ? "تعطيل" : "تفعيل"}</Button><Button size="sm" variant="destructive" onClick={() => remove.mutate(row.id)}><Trash2 className="me-1 h-4 w-4" />حذف</Button></div>
        </div>)}
      </div>}
    </section>
  </main>;
}
