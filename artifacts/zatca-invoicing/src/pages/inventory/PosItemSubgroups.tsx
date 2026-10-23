import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ImagePlus, Pencil, Plus, Power, Trash2, X } from "lucide-react";
import { useListPosItemGroups } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { localizeUiText } from "@/lib/localizedUiText";
import { useToast } from "@/hooks/use-toast";
import { createPosItemSubgroup, deletePosItemSubgroup, getPosItemSubgroups, updatePosItemSubgroup, uploadPosItemGroupImage } from "@/lib/inventoryApi";

const EMPTY = { parentPosGroupId: "", code: "", nameAr: "", nameEn: "", imageUrl: "", isActive: true, sortOrder: "0" };
const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function PosItemSubgroups() {
  const { user, actingCompanyId, token } = useAuth() as any;
  const cid = actingCompanyId ?? user?.company?.id;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<any>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const { data: groups = [] } = useListPosItemGroups();
  const key = ["pos-item-subgroups", cid];
  const rowsQuery = useQuery({ queryKey: key, queryFn: getPosItemSubgroups, enabled: Boolean(cid) });
  const rows = rowsQuery.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const save = useMutation({
    mutationFn: () => editId
      ? updatePosItemSubgroup(editId, { ...form, parentPosGroupId: Number(form.parentPosGroupId), sortOrder: Number(form.sortOrder) })
      : createPosItemSubgroup({ ...form, parentPosGroupId: Number(form.parentPosGroupId), sortOrder: Number(form.sortOrder) }),
    onSuccess: () => { void refresh(); setForm(EMPTY); setEditId(null); toast({ title: localizeUiText("تم حفظ المجموعة الفرعية") }); },
    onError: (error: any) => toast({ title: error.message || localizeUiText("تعذر حفظ المجموعة الفرعية"), variant: "destructive" }),
  });
  const update = useMutation({
    mutationFn: ({ id, data }: any) => updatePosItemSubgroup(id, data),
    onSuccess: () => { void refresh(); },
    onError: (error: any) => toast({ title: error.message || localizeUiText("تعذر تحديث المجموعة"), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: deletePosItemSubgroup,
    onSuccess: () => { void refresh(); toast({ title: localizeUiText("تم حذف المجموعة الفرعية") }); },
    onError: (error: any) => toast({ title: error.message || localizeUiText("تعذر حذف المجموعة"), variant: "destructive" }),
  });
  const imageSrc = (path: string) => path?.startsWith("/objects/")
    ? `${API_BASE}/api/storage${path}${token ? `?token=${encodeURIComponent(token)}` : ""}` : path;
  const reset = () => { setForm(EMPTY); setEditId(null); };

  return <main dir="rtl" className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
    <header>
      <Link href="/inventory/pos-item-groups" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground"><ArrowRight className="h-4 w-4" /> {localizeUiText("مجموعات عرض نقاط البيع")}</Link>
      <h1 className="text-2xl font-bold">{localizeUiText("المجموعات الفرعية لمجموعات العرض")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{localizeUiText("هذه المجموعات تظهر للكاشير تحت مجموعة العرض المختارة، ولا تغيّر فئات الأصناف المحاسبية.")}</p>
    </header>
    <form className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <label className="grid gap-1 text-sm">{localizeUiText("مجموعة العرض الرئيسية")} *
        <select required className="h-10 rounded-md border bg-background px-3" value={form.parentPosGroupId} onChange={(event) => setForm((p: any) => ({ ...p, parentPosGroupId: event.target.value }))}>
          <option value="">{localizeUiText("اختر مجموعة العرض")}</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.nameAr}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">{localizeUiText("الاسم بالعربية")} *
        <Input required maxLength={120} value={form.nameAr} onChange={(event) => setForm((p: any) => ({ ...p, nameAr: event.target.value }))} placeholder={localizeUiText("مثال: مشروبات ساخنة")} />
      </label>
      <label className="grid gap-1 text-sm">{localizeUiText("الاسم بالإنجليزية")}
        <Input dir="ltr" maxLength={120} value={form.nameEn} onChange={(event) => setForm((p: any) => ({ ...p, nameEn: event.target.value }))} />
      </label>
      <label className="grid gap-1 text-sm">{localizeUiText("ترتيب العرض")}
        <Input type="number" min="0" value={form.sortOrder} onChange={(event) => setForm((p: any) => ({ ...p, sortOrder: event.target.value }))} />
      </label>
      <label className="grid gap-1 text-sm md:col-span-2">{localizeUiText("صورة المجموعة الفرعية (اختيارية)")}
        <span className="flex flex-wrap items-center gap-3">
          <Input type="file" accept="image/*" disabled={uploading} onChange={async (event) => {
            const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
            if (!file) return;
            setUploading(true);
            try { const imageUrl = await uploadPosItemGroupImage(file); setForm((p: any) => ({ ...p, imageUrl })); }
            catch (error: any) { toast({ title: error.message || localizeUiText("تعذر رفع الصورة"), variant: "destructive" }); }
            finally { setUploading(false); }
          }} />
          {form.imageUrl && <span className="inline-flex items-center gap-2"><img src={imageSrc(form.imageUrl)} alt="" className="h-12 w-12 rounded-md object-cover" /><Button type="button" size="icon" variant="ghost" aria-label={localizeUiText("إزالة الصورة")} onClick={() => setForm((p: any) => ({ ...p, imageUrl: "" }))}><X className="h-4 w-4" /></Button></span>}
          {uploading && <span className="text-xs text-muted-foreground">{localizeUiText("جارٍ رفع الصورة…")}</span>}
        </span>
      </label>
      <div className="flex gap-2 md:col-span-2"><Button type="submit" disabled={save.isPending || uploading || !form.parentPosGroupId || !form.nameAr}><Plus className="me-1 h-4 w-4" />{localizeUiText(editId ? "حفظ التعديل" : "إضافة مجموعة فرعية")}</Button>{editId && <Button type="button" variant="outline" onClick={reset}>{localizeUiText("إلغاء")}</Button>}</div>
    </form>
    <section className="overflow-hidden rounded-xl border bg-card">
      {rowsQuery.isLoading ? <p className="p-5 text-sm text-muted-foreground">{localizeUiText("جارٍ تحميل المجموعات…")}</p> : rows.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{localizeUiText("لا توجد مجموعات فرعية بعد.")}</p> : <div className="divide-y">
        {rows.map((row: any) => <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            {row.imageUrl ? <img src={imageSrc(row.imageUrl)} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <span className="grid h-12 w-12 place-items-center rounded-lg bg-muted"><ImagePlus className="h-5 w-5" /></span>}
            <div><div className="font-semibold">{row.nameAr} <span className="text-xs text-muted-foreground">({row.code})</span></div><div className="text-xs text-muted-foreground">{groups.find((group) => group.id === row.parentPosGroupId)?.nameAr ?? localizeUiText("مجموعة عرض غير متاحة")} · {localizeUiText(row.isActive ? "نشطة" : "غير نشطة")}</div></div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => { setEditId(row.id); setForm({ parentPosGroupId: String(row.parentPosGroupId), code: row.code, nameAr: row.nameAr, nameEn: row.nameEn ?? "", imageUrl: row.imageUrl ?? "", isActive: row.isActive, sortOrder: String(row.sortOrder ?? 0) }); }}><Pencil className="me-1 h-4 w-4" />{localizeUiText("تعديل")}</Button>
            <Button size="sm" variant="outline" onClick={() => update.mutate({ id: row.id, data: { isActive: !row.isActive } })}><Power className="me-1 h-4 w-4" />{localizeUiText(row.isActive ? "تعطيل" : "تفعيل")}</Button>
            <Button size="sm" variant="destructive" onClick={() => remove.mutate(row.id)}><Trash2 className="me-1 h-4 w-4" />{localizeUiText("حذف")}</Button>
          </div>
        </div>)}
      </div>}
    </section>
  </main>;
}
