import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Plus, Pencil, Trash2, Tag, Search, BookMarked } from "lucide-react";
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
        <FormPanel
          icon={Tag}
          title={editId ? "تعديل مجموعة أصناف" : "إضافة مجموعة جديدة"}
          subtitle="تصنيف الأصناف وربطها بالحسابات المحاسبية الافتراضية"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending || updateMut.isPending}
          saveDisabled={!form.code || !form.nameAr}
          saveLabel={editId ? "حفظ التعديل" : "إضافة"}
        >
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="w-full h-9 mb-5">
              <TabsTrigger value="basic"    className="flex-1 text-xs gap-1.5"><Tag        className="h-3.5 w-3.5" />البيانات الأساسية</TabsTrigger>
              <TabsTrigger value="accounts" className="flex-1 text-xs gap-1.5"><BookMarked className="h-3.5 w-3.5" />الربط المحاسبي</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="mt-0">
              <FormGrid>
                <Field label="كود المجموعة" required>
                  <Input placeholder="GRP-01" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} />
                </Field>
                <Field label="الاسم بالعربي" required>
                  <Input placeholder="إلكترونيات" value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} />
                </Field>
                <Field label="الاسم بالإنجليزي" className="md:col-span-2">
                  <Input placeholder="Electronics" dir="ltr" className="text-left" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
                </Field>
              </FormGrid>
            </TabsContent>

            <TabsContent value="accounts" className="mt-0">
              <FormGrid>
                <Field label="حساب التكلفة الافتراضي" hint="يُورَث لكل صنف ينتمي لهذه المجموعة إذا لم يُحدَّد له حساب">
                  <AccountCombobox
                    value={form.costAccountId}
                    onValueChange={v => setForm((p: any) => ({ ...p, costAccountId: v }))}
                    placeholder="— اختر حساب التكلفة —"
                    filterTypes={["expense", "asset"]}
                    grouped={false}
                  />
                </Field>
                <Field label="حساب الإيراد الافتراضي" hint="يُورَث لكل صنف ينتمي لهذه المجموعة إذا لم يُحدَّد له حساب">
                  <AccountCombobox
                    value={form.revenueAccountId}
                    onValueChange={v => setForm((p: any) => ({ ...p, revenueAccountId: v }))}
                    placeholder="— اختر حساب الإيراد —"
                    filterTypes={["revenue"]}
                    grouped={false}
                  />
                </Field>
              </FormGrid>
            </TabsContent>
          </Tabs>
        </FormPanel>
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
