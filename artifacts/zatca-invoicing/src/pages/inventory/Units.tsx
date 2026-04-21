import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, Ruler, Search, Save, X, Info, ArrowRight } from "lucide-react";

const EMPTY = { code: "", nameAr: "", nameEn: "", conversionFactor: "1" };

const PRESETS = [
  { code: "PCS",  nameAr: "قطعة",    nameEn: "Piece",   conversionFactor: "1" },
  { code: "BOX",  nameAr: "علبة",    nameEn: "Box",     conversionFactor: "1" },
  { code: "CTN",  nameAr: "كرتونة",  nameEn: "Carton",  conversionFactor: "1" },
  { code: "KG",   nameAr: "كيلو",    nameEn: "KG",      conversionFactor: "1" },
  { code: "LTR",  nameAr: "لتر",     nameEn: "Litre",   conversionFactor: "1" },
  { code: "MTR",  nameAr: "متر",     nameEn: "Metre",   conversionFactor: "1" },
  { code: "DZN",  nameAr: "درزينة",  nameEn: "Dozen",   conversionFactor: "12" },
  { code: "PAL",  nameAr: "بالية",   nameEn: "Pallet",  conversionFactor: "1" },
];

export default function Units() {
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<any>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);

  const { data = [], isLoading } = useQuery({
    queryKey: ["units", cid],
    queryFn: () => inventoryApi.getUnits(cid),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["units"] });
  const createMut = useMutation({ mutationFn: inventoryApi.createUnit, onSuccess: () => { invalidate(); reset(); toast({ title: "تم الحفظ" }); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => inventoryApi.updateUnit(id, data), onSuccess: () => { invalidate(); reset(); toast({ title: "تم التعديل" }); } });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteUnit, onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); } });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); }
  function handleEdit(u: any) { setForm({ ...u, conversionFactor: u.conversionFactor ?? "1" }); setEditId(u.id); setShowForm(true); }
  function handlePreset(p: typeof PRESETS[0]) {
    setForm({ code: p.code, nameAr: p.nameAr, nameEn: p.nameEn, conversionFactor: p.conversionFactor });
    setShowForm(true);
  }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editId) updateMut.mutate({ id: editId, data: form });
    else createMut.mutate(form);
  }

  const filtered = data.filter((u: any) =>
    u.nameAr.includes(search) || u.code.includes(search) || (u.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Ruler className="h-6 w-6 text-primary" />وحدات القياس</h1>
          <p className="text-muted-foreground text-sm mt-1">إدارة وحدات قياس الأصناف وربطها بمعاملات التحويل</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />وحدة جديدة
        </Button>
      </div>

      <div className="rounded-xl border bg-blue-50 border-blue-100 p-4">
        <div className="flex items-start gap-3">
          <Info className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
          <div className="space-y-2">
            <p className="text-sm font-semibold text-blue-800">كيف تعمل وحدات القياس المتعددة؟</p>
            <p className="text-xs text-blue-700">
              هنا تُعرِّف الوحدات العامة (قطعة، كرتونة، كيلو...). بعدها في صفحة الأصناف، تربط كل صنف بالوحدات التي يُباع بها مع تحديد معامل التحويل والسعر لكل وحدة.
            </p>
            <div className="flex flex-wrap gap-3 mt-1">
              <div className="bg-white border border-blue-200 rounded-lg px-3 py-2 text-xs">
                <p className="font-semibold text-blue-800 mb-1">مثال — صنف: سكر</p>
                <div className="space-y-1 text-blue-700">
                  <div className="flex items-center gap-2">
                    <span className="bg-green-100 text-green-700 rounded px-1.5 py-0.5 font-mono font-bold">واحدة</span>
                    <ArrowRight className="h-3 w-3" />
                    <span>معامل ×1 — تكلفة <b>5</b> ر.س</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="bg-purple-100 text-purple-700 rounded px-1.5 py-0.5 font-mono font-bold">كرتونة</span>
                    <ArrowRight className="h-3 w-3" />
                    <span>معامل ×12 — تكلفة <b>60</b> ر.س</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-4">
        <p className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wide">وحدات شائعة — انقر للإضافة السريعة</p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map(p => (
            <button
              key={p.code}
              onClick={() => handlePreset(p)}
              className="flex items-center gap-1.5 rounded-full border bg-muted/30 hover:bg-muted/70 px-3 py-1.5 text-xs transition-colors"
            >
              <span className="font-mono font-bold text-primary">{p.code}</span>
              <span className="text-muted-foreground">{p.nameAr}</span>
              {Number(p.conversionFactor) !== 1 && (
                <span className="text-[10px] bg-purple-100 text-purple-700 rounded px-1">×{p.conversionFactor}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {showForm && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <h2 className="font-semibold flex items-center gap-2">
              <Ruler className="h-5 w-5 text-primary" />
              {editId ? "تعديل وحدة قياس" : "إضافة وحدة جديدة"}
            </h2>
            <Button variant="ghost" size="icon" onClick={reset}><X className="h-4 w-4" /></Button>
          </div>
          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <div className="space-y-1.5">
              <Label>كود الوحدة <span className="text-destructive">*</span></Label>
              <Input placeholder="PCS" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value.toUpperCase() }))} required className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label>الاسم بالعربي <span className="text-destructive">*</span></Label>
              <Input placeholder="قطعة" value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label>الاسم بالإنجليزي</Label>
              <Input placeholder="Piece" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>معامل التحويل الافتراضي</Label>
              <Input type="number" step="any" min="0.000001" placeholder="1" value={form.conversionFactor} onChange={e => setForm((p: any) => ({ ...p, conversionFactor: e.target.value }))} />
              <p className="text-[10px] text-muted-foreground">مرجعي فقط — يُحدَّد التحويل الفعلي لكل صنف</p>
            </div>
            <div className="flex gap-2 pt-4 border-t">
              <Button type="button" variant="outline" className="gap-1" onClick={reset}><X className="h-4 w-4" />إلغاء</Button>
              <Button type="submit" className="gap-1 flex-1" disabled={createMut.isPending || updateMut.isPending}>
                <Save className="h-4 w-4" />{editId ? "حفظ التعديل" : "إضافة"}
              </Button>
            </div>
          </form>
        </div>
      )}

      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pr-9" placeholder="بحث..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الكود</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الاسم بالعربي</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">الاسم بالإنجليزي</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground hidden sm:table-cell">معامل افتراضي</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-24">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => <tr key={i}><td colSpan={5} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
              : filtered.length === 0
              ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                    <Ruler className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p>لا توجد وحدات قياس</p>
                    <p className="text-xs mt-1">استخدم الأزرار أعلاه لإضافة وحدات شائعة</p>
                  </td>
                </tr>
              )
              : filtered.map((u: any) => (
                <tr key={u.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-mono font-bold text-primary">{u.code}</td>
                  <td className="px-4 py-3 font-medium">{u.nameAr}</td>
                  <td className="px-4 py-3 hidden sm:table-cell text-muted-foreground">{u.nameEn ?? "—"}</td>
                  <td className="px-4 py-3 hidden sm:table-cell text-center">
                    <span className="text-xs bg-muted rounded px-2 py-0.5 tabular-nums">×{Number(u.conversionFactor).toFixed(Number(u.conversionFactor) % 1 === 0 ? 0 : 4)}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(u)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => { if (confirm("حذف الوحدة؟")) deleteMut.mutate(u.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {!isLoading && (
          <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">
            {filtered.length} وحدة
          </div>
        )}
      </div>
    </div>
  );
}
