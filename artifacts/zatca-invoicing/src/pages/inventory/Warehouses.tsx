import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, Warehouse, Search, Save, X, CheckCircle2, XCircle, MapPin, BookMarked } from "lucide-react";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { AccountCombobox } from "@/components/AccountCombobox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const EMPTY = { code: "", nameAr: "", nameEn: "", groupId: "", city: "", region: "", allowNegative: false, negativeLimit: "", accountId: "" };

export default function Warehouses() {
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<any>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [activeTab, setActiveTab] = useState("basic");

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

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); setActiveTab("basic"); }
  function handleEdit(w: any) {
    setForm({ ...w, groupId: w.groupId ?? "", negativeLimit: w.negativeLimit ?? "", accountId: w.accountId ? String(w.accountId) : "" });
    setEditId(w.id);
    setShowForm(true);
  }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      ...form,
      groupId:       form.groupId  ? Number(form.groupId)  : null,
      negativeLimit: form.negativeLimit || null,
      accountId:     form.accountId ? Number(form.accountId) : null,
    };
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
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(w)}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => { if (confirm("حذف المخزن؟")) deleteMut.mutate(w.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {!isLoading && <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">{filtered.length} مخزن</div>}
      </div>

      <Sheet open={showForm} onOpenChange={v => { if (!v) reset(); }}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto" dir="rtl">
          <SheetHeader className="border-b pb-4 mb-5">
            <SheetTitle className="flex items-center gap-2">
              <Warehouse className="h-5 w-5 text-primary" />
              {editId ? "تعديل مخزن" : "إضافة مخزن جديد"}
            </SheetTitle>
          </SheetHeader>
          <form onSubmit={handleSubmit} className="space-y-5">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <TabsList className="w-full h-9 mb-4">
                <TabsTrigger value="basic"    className="flex-1 text-xs gap-1"><Warehouse  className="h-3.5 w-3.5" />الأساسية</TabsTrigger>
                <TabsTrigger value="location" className="flex-1 text-xs gap-1"><MapPin     className="h-3.5 w-3.5" />الموقع</TabsTrigger>
                <TabsTrigger value="accounts" className="flex-1 text-xs gap-1"><BookMarked className="h-3.5 w-3.5" />المحاسبة</TabsTrigger>
              </TabsList>

              <TabsContent value="basic" className="mt-0 space-y-4">
                <div className="space-y-1.5">
                  <Label>كود المخزن <span className="text-destructive">*</span></Label>
                  <Input placeholder="WH-01" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} required />
                </div>
                <div className="space-y-1.5">
                  <Label>الاسم بالعربي <span className="text-destructive">*</span></Label>
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
              </TabsContent>

              <TabsContent value="location" className="mt-0 space-y-4">
                <div className="space-y-1.5">
                  <Label>المدينة</Label>
                  <Input placeholder="الرياض" value={form.city} onChange={e => setForm((p: any) => ({ ...p, city: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>المنطقة</Label>
                  <Input placeholder="منطقة الرياض" value={form.region} onChange={e => setForm((p: any) => ({ ...p, region: e.target.value }))} />
                </div>
                <div className="flex items-center gap-3 pt-1">
                  <Switch checked={form.allowNegative} onCheckedChange={v => setForm((p: any) => ({ ...p, allowNegative: v }))} id="allow-neg" />
                  <Label htmlFor="allow-neg">السماح بالسحب على المكشوف</Label>
                </div>
                {form.allowNegative && (
                  <div className="space-y-1.5">
                    <Label>حد السحب (اختياري)</Label>
                    <Input type="number" placeholder="0.00" value={form.negativeLimit} onChange={e => setForm((p: any) => ({ ...p, negativeLimit: e.target.value }))} />
                  </div>
                )}
              </TabsContent>

              <TabsContent value="accounts" className="mt-0 space-y-4">
                <div className="space-y-1.5">
                  <Label>حساب المخزون</Label>
                  <AccountCombobox
                    value={form.accountId}
                    onValueChange={v => setForm((p: any) => ({ ...p, accountId: v }))}
                    placeholder="— اختر حساب المخزون —"
                    filterTypes={["asset"]}
                    grouped={false}
                  />
                  <p className="text-[10px] text-muted-foreground">الحساب المحاسبي الذي يُمثّل رصيد هذا المخزن في دفتر الأستاذ</p>
                </div>
              </TabsContent>
            </Tabs>

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
