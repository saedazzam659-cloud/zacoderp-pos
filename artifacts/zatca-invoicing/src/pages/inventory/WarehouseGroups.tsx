import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, Layers, Search, Save, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Group = { id: number; code: string; nameAr: string; nameEn?: string };
const EMPTY: Omit<Group, "id"> = { code: "", nameAr: "", nameEn: "" };

export default function WarehouseGroups() {
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<Partial<Group>>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);

  const { data = [], isLoading } = useQuery({
    queryKey: ["warehouse-groups", cid],
    queryFn: () => inventoryApi.getWarehouseGroups(cid),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["warehouse-groups"] });
  const createMut = useMutation({ mutationFn: inventoryApi.createWarehouseGroup, onSuccess: () => { invalidate(); reset(); toast({ title: "تم الحفظ" }); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => inventoryApi.updateWarehouseGroup(id, data), onSuccess: () => { invalidate(); reset(); toast({ title: "تم التعديل" }); } });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteWarehouseGroup, onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); } });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); }
  function handleEdit(g: Group) { setForm(g); setEditId(g.id); setShowForm(true); }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editId) updateMut.mutate({ id: editId, data: form });
    else        createMut.mutate(form);
  }

  const filtered = data.filter((g: Group) =>
    g.nameAr.includes(search) || g.code.includes(search) || (g.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Layers className="h-6 w-6 text-primary" />مجموعات المخازن
          </h1>
          <p className="text-muted-foreground text-sm mt-1">تصنيف وتجميع المخازن في فئات</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />إضافة مجموعة
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pr-9" placeholder="بحث بالكود أو الاسم..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-28">الكود</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الاسم بالعربي</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">الاسم بالإنجليزي</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-24">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => (
                  <tr key={i}><td colSpan={4} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>
                ))
              : filtered.length === 0
              ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center text-muted-foreground">
                      <Layers className="h-10 w-10 mx-auto mb-3 opacity-20" />
                      <p className="font-medium">لا توجد مجموعات بعد</p>
                      <p className="text-xs mt-1">أضف مجموعة لتنظيم مخازنك</p>
                    </td>
                  </tr>
                )
              : filtered.map((g: Group) => (
                  <tr key={g.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded font-medium">{g.code}</span>
                    </td>
                    <td className="px-4 py-3 font-medium">{g.nameAr}</td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{g.nameEn ?? "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-primary/10 hover:text-primary" onClick={() => handleEdit(g)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className={cn("h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10")} onClick={() => { if (confirm("حذف المجموعة؟")) deleteMut.mutate(g.id); }}>
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
            {filtered.length} مجموعة
          </div>
        )}
      </div>

      <Sheet open={showForm} onOpenChange={v => { if (!v) reset(); }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto" dir="rtl">
          <SheetHeader className="border-b pb-4 mb-5">
            <SheetTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-primary" />
              {editId ? "تعديل مجموعة مخازن" : "إضافة مجموعة جديدة"}
            </SheetTitle>
          </SheetHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label>كود المجموعة <span className="text-destructive">*</span></Label>
              <Input placeholder="GRP-01" value={form.code ?? ""} onChange={e => setForm(p => ({ ...p, code: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label>الاسم بالعربي <span className="text-destructive">*</span></Label>
              <Input placeholder="مجموعة رئيسية" value={form.nameAr ?? ""} onChange={e => setForm(p => ({ ...p, nameAr: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label>الاسم بالإنجليزي</Label>
              <Input placeholder="Main Group" value={form.nameEn ?? ""} onChange={e => setForm(p => ({ ...p, nameEn: e.target.value }))} />
            </div>
            <SheetFooter className="flex gap-2 pt-4 border-t">
              <Button type="button" variant="outline" className="gap-1" onClick={reset}><X className="h-4 w-4" />إلغاء</Button>
              <Button type="submit" className="gap-1 flex-1" disabled={createMut.isPending || updateMut.isPending}>
                <Save className="h-4 w-4" />{editId ? "حفظ التعديل" : "إضافة"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}
