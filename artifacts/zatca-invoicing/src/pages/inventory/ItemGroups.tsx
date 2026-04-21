import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, Tag, Search, Save, X, BookMarked } from "lucide-react";
import { AccountCombobox } from "@/components/AccountCombobox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const EMPTY = { code: "", nameAr: "", nameEn: "", costAccountId: "", revenueAccountId: "" };

export default function ItemGroups() {
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<any>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [activeTab, setActiveTab] = useState("basic");

  const { data = [], isLoading } = useQuery({
    queryKey: ["item-groups", cid],
    queryFn: () => inventoryApi.getItemGroups(cid),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["item-groups"] });
  const createMut = useMutation({ mutationFn: inventoryApi.createItemGroup, onSuccess: () => { invalidate(); reset(); toast({ title: "تم الحفظ" }); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => inventoryApi.updateItemGroup(id, data), onSuccess: () => { invalidate(); reset(); toast({ title: "تم التعديل" }); } });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteItemGroup, onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); } });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); setActiveTab("basic"); }
  function handleEdit(g: any) {
    setForm({
      ...g,
      costAccountId:    g.costAccountId    ? String(g.costAccountId)    : "",
      revenueAccountId: g.revenueAccountId ? String(g.revenueAccountId) : "",
    });
    setEditId(g.id);
    setShowForm(true);
  }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      ...form,
      costAccountId:    form.costAccountId    ? Number(form.costAccountId)    : null,
      revenueAccountId: form.revenueAccountId ? Number(form.revenueAccountId) : null,
    };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else        createMut.mutate(payload);
  }

  const filtered = data.filter((g: any) =>
    g.nameAr.includes(search) || g.code.includes(search) || (g.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Tag className="h-6 w-6 text-primary" />مجموعات الأصناف</h1>
          <p className="text-muted-foreground text-sm mt-1">تصنيف الأصناف وتجميعها</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />إضافة مجموعة
        </Button>
      </div>

      {showForm && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <h2 className="font-semibold flex items-center gap-2">
              <Tag className="h-5 w-5 text-primary" />
              {editId ? "تعديل مجموعة أصناف" : "إضافة مجموعة جديدة"}
            </h2>
            <Button variant="ghost" size="icon" onClick={reset}><X className="h-4 w-4" /></Button>
          </div>
          <form onSubmit={handleSubmit} className="p-5 space-y-5">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <TabsList className="w-full h-9 mb-4">
                <TabsTrigger value="basic"    className="flex-1 text-xs gap-1.5"><Tag        className="h-3.5 w-3.5" />البيانات الأساسية</TabsTrigger>
                <TabsTrigger value="accounts" className="flex-1 text-xs gap-1.5"><BookMarked className="h-3.5 w-3.5" />الربط المحاسبي</TabsTrigger>
              </TabsList>

              <TabsContent value="basic" className="mt-0 space-y-4">
                <div className="space-y-1.5">
                  <Label>كود المجموعة <span className="text-destructive">*</span></Label>
                  <Input placeholder="GRP-01" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} required />
                </div>
                <div className="space-y-1.5">
                  <Label>الاسم بالعربي <span className="text-destructive">*</span></Label>
                  <Input placeholder="إلكترونيات" value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} required />
                </div>
                <div className="space-y-1.5">
                  <Label>الاسم بالإنجليزي</Label>
                  <Input placeholder="Electronics" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
                </div>
              </TabsContent>

              <TabsContent value="accounts" className="mt-0 space-y-4">
                <div className="space-y-1.5">
                  <Label>حساب التكلفة الافتراضي</Label>
                  <AccountCombobox
                    value={form.costAccountId}
                    onValueChange={v => setForm((p: any) => ({ ...p, costAccountId: v }))}
                    placeholder="— اختر حساب التكلفة —"
                    filterTypes={["expense", "asset"]}
                    grouped={false}
                  />
                  <p className="text-[10px] text-muted-foreground">يُورَث لكل صنف ينتمي لهذه المجموعة إذا لم يُحدَّد له حساب</p>
                </div>
                <div className="space-y-1.5">
                  <Label>حساب الإيراد الافتراضي</Label>
                  <AccountCombobox
                    value={form.revenueAccountId}
                    onValueChange={v => setForm((p: any) => ({ ...p, revenueAccountId: v }))}
                    placeholder="— اختر حساب الإيراد —"
                    filterTypes={["revenue"]}
                    grouped={false}
                  />
                  <p className="text-[10px] text-muted-foreground">يُورَث لكل صنف ينتمي لهذه المجموعة إذا لم يُحدَّد له حساب</p>
                </div>
              </TabsContent>
            </Tabs>

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
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الاسم بالإنجليزي</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-24">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => <tr key={i}><td colSpan={4} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
              : filtered.length === 0
              ? <tr><td colSpan={4} className="px-4 py-10 text-center text-muted-foreground"><Tag className="h-8 w-8 mx-auto mb-2 opacity-30" />لا توجد مجموعات</td></tr>
              : filtered.map((g: any) => (
                  <tr key={g.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono text-xs">{g.code}</td>
                    <td className="px-4 py-3 font-medium">{g.nameAr}</td>
                    <td className="px-4 py-3 text-muted-foreground">{g.nameEn ?? "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(g)}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => { if (confirm("حذف المجموعة؟")) deleteMut.mutate(g.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {!isLoading && <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">{filtered.length} مجموعة</div>}
      </div>
    </div>
  );
}
