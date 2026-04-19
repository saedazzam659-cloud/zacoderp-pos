import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, Warehouse, Search, X, CheckCircle2, XCircle } from "lucide-react";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { cn } from "@/lib/utils";

const EMPTY = { code: "", nameAr: "", nameEn: "", groupId: "", city: "", region: "", allowNegative: false, negativeLimit: "" };

export default function Warehouses() {
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<any>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);

  const { data: warehouses = [], isLoading } = useQuery({
    queryKey: ["warehouses", cid],
    queryFn: () => inventoryApi.getWarehouses(cid),
  });
  const { data: groups = [] } = useQuery({
    queryKey: ["warehouse-groups", cid],
    queryFn: () => inventoryApi.getWarehouseGroups(cid),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["warehouses"] });
  const createMut = useMutation({ mutationFn: inventoryApi.createWarehouse, onSuccess: () => { invalidate(); reset(); toast({ title: "تم الحفظ" }); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => inventoryApi.updateWarehouse(id, data), onSuccess: () => { invalidate(); reset(); toast({ title: "تم التعديل" }); } });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteWarehouse, onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); } });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); }
  function handleEdit(w: any) { setForm({ ...w, groupId: w.groupId ?? "", negativeLimit: w.negativeLimit ?? "" }); setEditId(w.id); setShowForm(true); }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = { ...form, groupId: form.groupId ? Number(form.groupId) : null, negativeLimit: form.negativeLimit || null };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else        createMut.mutate(payload);
  }

  const filtered = warehouses.filter((w: any) =>
    w.nameAr.includes(search) || w.code.includes(search) || (w.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Warehouse className="h-6 w-6 text-primary" />المخازن</h1>
          <p className="text-muted-foreground text-sm mt-1">إدارة المخازن وبياناتها</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />إضافة مخزن
        </Button>
      </div>

      {showForm && (
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">{editId ? "تعديل مخزن" : "مخزن جديد"}</h2>
            <Button variant="ghost" size="icon" onClick={reset}><X className="h-4 w-4" /></Button>
          </div>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label>كود المخزن *</Label>
              <Input placeholder="WH-01" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label>الاسم بالعربي *</Label>
              <Input placeholder="المخزن الرئيسي" value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label>الاسم بالإنجليزي</Label>
              <Input placeholder="Main Warehouse" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>مجموعة المخزن</Label>
              <SearchCombobox
                items={[{ value: "", label: "بدون مجموعة" }, ...(groups as any[]).map((g: any) => ({ value: String(g.id), code: g.code, label: g.nameAr, labelEn: g.nameEn }))]}
                value={form.groupId}
                onValueChange={v => setForm((p: any) => ({ ...p, groupId: v }))}
                placeholder="— اختر مجموعة —"
              />
            </div>
            <div className="space-y-1.5">
              <Label>المدينة</Label>
              <Input placeholder="الرياض" value={form.city} onChange={e => setForm((p: any) => ({ ...p, city: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>المنطقة</Label>
              <Input placeholder="منطقة الرياض" value={form.region} onChange={e => setForm((p: any) => ({ ...p, region: e.target.value }))} />
            </div>
            <div className="space-y-1.5 flex items-center gap-3 pt-4">
              <Switch checked={form.allowNegative} onCheckedChange={v => setForm((p: any) => ({ ...p, allowNegative: v }))} id="allow-neg" />
              <Label htmlFor="allow-neg">السماح بالسحب على المكشوف</Label>
            </div>
            {form.allowNegative && (
              <div className="space-y-1.5">
                <Label>حد السحب (اختياري)</Label>
                <Input type="number" placeholder="0.00" value={form.negativeLimit} onChange={e => setForm((p: any) => ({ ...p, negativeLimit: e.target.value }))} />
              </div>
            )}
            <div className="sm:col-span-2 lg:col-span-3 flex gap-2 justify-end pt-2 border-t">
              <Button type="button" variant="outline" onClick={reset}>إلغاء</Button>
              <Button type="submit" disabled={createMut.isPending || updateMut.isPending}>
                {editId ? "حفظ التعديل" : "إضافة"}
              </Button>
            </div>
          </form>
        </div>
      )}

      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pr-9" placeholder="بحث بالكود أو الاسم..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الكود</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الاسم</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">المجموعة</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">المدينة</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-24">مكشوف</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-24">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => <tr key={i}><td colSpan={6} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
              : filtered.length === 0
              ? <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground"><Warehouse className="h-8 w-8 mx-auto mb-2 opacity-30" />لا توجد مخازن</td></tr>
              : filtered.map((w: any) => (
                  <tr key={w.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono text-xs">{w.code}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{w.nameAr}</p>
                      {w.nameEn && <p className="text-xs text-muted-foreground">{w.nameEn}</p>}
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell text-muted-foreground text-xs">{w.group?.nameAr ?? "—"}</td>
                    <td className="px-4 py-3 hidden md:table-cell text-muted-foreground text-xs">{w.city ?? "—"}</td>
                    <td className="px-4 py-3 text-center">
                      {w.allowNegative ? <CheckCircle2 className="h-4 w-4 text-green-500 mx-auto" /> : <XCircle className="h-4 w-4 text-muted-foreground/30 mx-auto" />}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(w)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => { if (confirm("حذف المخزن؟")) deleteMut.mutate(w.id); }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {!isLoading && (
          <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">
            {filtered.length} مخزن
          </div>
        )}
      </div>
    </div>
  );
}
