import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import ExportButtons from "@/components/ExportButtons";
import {
  Plus, Pencil, Trash2, Package, Search, X,
  ChevronDown, ChevronUp, Warehouse, BarChart2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const EMPTY = {
  code: "", nameAr: "", nameEn: "", barcode: "", itemType: "stock",
  groupId: "", unitId: "", costPrice: "0", salePrice: "0", vatRate: "15",
  reorderLevel: "0", maxLevel: "", costMethod: "weighted_avg", description: "", status: "active",
};

const ITEM_EXPORT_COLS = [
  { key: "code",          header: "كود الصنف",       width: 16 },
  { key: "nameAr",        header: "الاسم بالعربي",   width: 30 },
  { key: "nameEn",        header: "الاسم بالإنجليزي", width: 30 },
  { key: "barcode",       header: "باركود",           width: 18 },
  { key: "itemType",      header: "النوع",             width: 12 },
  { key: "groupName",     header: "المجموعة",          width: 20 },
  { key: "unitName",      header: "الوحدة",            width: 14 },
  { key: "costPrice",     header: "سعر التكلفة",       width: 16 },
  { key: "salePrice",     header: "سعر البيع",         width: 16 },
  { key: "reorderLevel",  header: "حد الطلب",          width: 14 },
  { key: "status",        header: "الحالة",             width: 12 },
];

export default function Items() {
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<"all" | "stock" | "service">("all");
  const [form, setForm] = useState<any>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["items", cid],
    queryFn: () => inventoryApi.getItems(cid),
  });
  const { data: groups = [] } = useQuery({
    queryKey: ["item-groups", cid],
    queryFn: () => inventoryApi.getItemGroups(cid),
  });
  const { data: units = [] } = useQuery({
    queryKey: ["units", cid],
    queryFn: () => inventoryApi.getUnits(cid),
  });
  const { data: itemDetail } = useQuery({
    queryKey: ["item-detail", expandedId],
    queryFn: () => inventoryApi.getItem(expandedId!),
    enabled: expandedId !== null,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["items"] });
  const createMut = useMutation({ mutationFn: inventoryApi.createItem, onSuccess: () => { invalidate(); reset(); toast({ title: "تم حفظ الصنف" }); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => inventoryApi.updateItem(id, data), onSuccess: () => { invalidate(); reset(); toast({ title: "تم تعديل الصنف" }); } });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteItem, onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); } });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); }
  function handleEdit(item: any) {
    setForm({
      ...item,
      groupId: item.groupId ?? "", unitId: item.unitId ?? "",
      costPrice: item.costPrice ?? "0", salePrice: item.salePrice ?? "0",
      vatRate: item.vatRate ?? "15", reorderLevel: item.reorderLevel ?? "0",
      maxLevel: item.maxLevel ?? "",
    });
    setEditId(item.id);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = { ...form, groupId: form.groupId ? Number(form.groupId) : null, unitId: form.unitId ? Number(form.unitId) : null };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else        createMut.mutate(payload);
  }

  const filtered = items.filter((it: any) => {
    const matchText = it.nameAr.includes(search) || it.code.includes(search) || (it.nameEn ?? "").toLowerCase().includes(search.toLowerCase()) || (it.barcode ?? "").includes(search);
    const matchType = filterType === "all" || it.itemType === filterType;
    return matchText && matchType;
  });

  const exportRows = filtered.map((it: any) => ({
    code:         it.code,
    nameAr:       it.nameAr,
    nameEn:       it.nameEn ?? "",
    barcode:      it.barcode ?? "",
    itemType:     it.itemType === "stock" ? "مخزني" : "خدمي",
    groupName:    it.group?.nameAr ?? "",
    unitName:     it.unit?.nameAr ?? "",
    costPrice:    Number(it.costPrice).toFixed(2),
    salePrice:    Number(it.salePrice).toFixed(2),
    reorderLevel: Number(it.reorderLevel).toFixed(2),
    status:       it.status === "active" ? "نشط" : "موقوف",
  }));

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Package className="h-6 w-6 text-primary" />الأصناف</h1>
          <p className="text-muted-foreground text-sm mt-1">إدارة الأصناف المخزنية والخدمية</p>
        </div>
        <div className="flex gap-2">
          <ExportButtons rows={exportRows} columns={ITEM_EXPORT_COLS} filename={`أصناف-${new Date().toISOString().slice(0,10)}`} title="قائمة الأصناف" />
          <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
            <Plus className="h-4 w-4" />صنف جديد
          </Button>
        </div>
      </div>

      {/* Form */}
      {showForm && (
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">{editId ? "تعديل صنف" : "صنف جديد"}</h2>
            <Button variant="ghost" size="icon" onClick={reset}><X className="h-4 w-4" /></Button>
          </div>
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Basic Info */}
            <div>
              <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-3 tracking-wider">البيانات الأساسية</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label>كود الصنف *</Label>
                  <Input placeholder="ITM-001" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} required />
                </div>
                <div className="space-y-1.5">
                  <Label>الاسم بالعربي *</Label>
                  <Input placeholder="اسم الصنف" value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} required />
                </div>
                <div className="space-y-1.5">
                  <Label>الاسم بالإنجليزي</Label>
                  <Input placeholder="Item Name" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>باركود</Label>
                  <Input placeholder="1234567890" value={form.barcode} onChange={e => setForm((p: any) => ({ ...p, barcode: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>نوع الصنف</Label>
                  <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={form.itemType} onChange={e => setForm((p: any) => ({ ...p, itemType: e.target.value }))}>
                    <option value="stock">مخزني</option>
                    <option value="service">خدمي</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>المجموعة</Label>
                  <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={form.groupId} onChange={e => setForm((p: any) => ({ ...p, groupId: e.target.value }))}>
                    <option value="">— بدون مجموعة —</option>
                    {groups.map((g: any) => <option key={g.id} value={g.id}>[{g.code}] {g.nameAr}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>وحدة القياس</Label>
                  <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={form.unitId} onChange={e => setForm((p: any) => ({ ...p, unitId: e.target.value }))}>
                    <option value="">— اختر وحدة —</option>
                    {units.map((u: any) => <option key={u.id} value={u.id}>[{u.code}] {u.nameAr}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>الحالة</Label>
                  <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={form.status} onChange={e => setForm((p: any) => ({ ...p, status: e.target.value }))}>
                    <option value="active">نشط</option>
                    <option value="inactive">موقوف</option>
                  </select>
                </div>
              </div>
            </div>
            {/* Pricing */}
            <div>
              <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-3 tracking-wider">التسعير والتكلفة</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label>سعر التكلفة</Label>
                  <Input type="number" step="any" value={form.costPrice} onChange={e => setForm((p: any) => ({ ...p, costPrice: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>سعر البيع</Label>
                  <Input type="number" step="any" value={form.salePrice} onChange={e => setForm((p: any) => ({ ...p, salePrice: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>نسبة الضريبة %</Label>
                  <Input type="number" step="any" value={form.vatRate} onChange={e => setForm((p: any) => ({ ...p, vatRate: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>طريقة احتساب التكلفة</Label>
                  <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={form.costMethod} onChange={e => setForm((p: any) => ({ ...p, costMethod: e.target.value }))}>
                    <option value="weighted_avg">متوسط مرجح</option>
                    <option value="last_cost">آخر سعر</option>
                  </select>
                </div>
              </div>
            </div>
            {/* Stock Controls */}
            <div>
              <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-3 tracking-wider">بيانات التحكم</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label>حد الطلب (نقطة إعادة الطلب)</Label>
                  <Input type="number" step="any" value={form.reorderLevel} onChange={e => setForm((p: any) => ({ ...p, reorderLevel: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>الحد الأقصى للمخزون</Label>
                  <Input type="number" step="any" placeholder="اختياري" value={form.maxLevel} onChange={e => setForm((p: any) => ({ ...p, maxLevel: e.target.value }))} />
                </div>
                <div className="space-y-1.5 sm:col-span-1">
                  <Label>ملاحظات / وصف</Label>
                  <Input placeholder="وصف الصنف" value={form.description} onChange={e => setForm((p: any) => ({ ...p, description: e.target.value }))} />
                </div>
              </div>
            </div>
            <div className="flex gap-2 justify-end pt-2 border-t">
              <Button type="button" variant="outline" onClick={reset}>إلغاء</Button>
              <Button type="submit" disabled={createMut.isPending || updateMut.isPending}>
                {editId ? "حفظ التعديل" : "إضافة الصنف"}
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pr-9" placeholder="بحث بالكود أو الاسم أو الباركود..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1 bg-muted/50 p-1 rounded-lg border">
          {(["all", "stock", "service"] as const).map(t => (
            <button key={t} onClick={() => setFilterType(t)} className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-all", filterType === t ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {t === "all" ? "الكل" : t === "stock" ? "مخزني" : "خدمي"}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-8"></th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الكود</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">الصنف</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">المجموعة</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">الوحدة</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden lg:table-cell">التكلفة</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden lg:table-cell">سعر البيع</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">النوع</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الحالة</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-24">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={10} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
              : filtered.length === 0
              ? <tr><td colSpan={10} className="px-4 py-12 text-center text-muted-foreground"><Package className="h-8 w-8 mx-auto mb-2 opacity-30" />لا توجد أصناف{search ? " مطابقة للبحث" : ""}</td></tr>
              : filtered.map((it: any) => (
                  <>
                    <tr key={it.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <button onClick={() => setExpandedId(expandedId === it.id ? null : it.id)} className="text-muted-foreground hover:text-foreground">
                          {expandedId === it.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </button>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs font-bold">{it.code}</td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{it.nameAr}</p>
                        {it.nameEn && <p className="text-xs text-muted-foreground">{it.nameEn}</p>}
                        {it.barcode && <p className="text-[10px] text-muted-foreground/70 font-mono">🔖 {it.barcode}</p>}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-muted-foreground text-xs">{it.group?.nameAr ?? "—"}</td>
                      <td className="px-4 py-3 hidden md:table-cell text-muted-foreground text-xs">{it.unit?.nameAr ?? "—"}</td>
                      <td className="px-4 py-3 hidden lg:table-cell tabular-nums text-xs">{Number(it.costPrice).toFixed(2)}</td>
                      <td className="px-4 py-3 hidden lg:table-cell tabular-nums text-xs font-medium">{Number(it.salePrice).toFixed(2)}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5", it.itemType === "stock" ? "bg-blue-50 text-blue-700" : "bg-purple-50 text-purple-700")}>
                          {it.itemType === "stock" ? "مخزني" : "خدمي"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5", it.status === "active" ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-500")}>
                          {it.status === "active" ? "نشط" : "موقوف"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(it)}><Pencil className="h-3.5 w-3.5" /></Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => { if (confirm("حذف الصنف؟")) deleteMut.mutate(it.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </div>
                      </td>
                    </tr>
                    {/* Expanded row: warehouse balances */}
                    {expandedId === it.id && (
                      <tr key={`exp-${it.id}`} className="bg-muted/20">
                        <td colSpan={10} className="px-6 py-4">
                          <div className="flex items-center gap-2 mb-3">
                            <Warehouse className="h-4 w-4 text-primary" />
                            <span className="text-xs font-semibold">أرصدة المخازن</span>
                          </div>
                          {!itemDetail?.balances?.length
                            ? <p className="text-xs text-muted-foreground">لا توجد أرصدة مسجّلة</p>
                            : (
                              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                                {itemDetail.balances.map((b: any) => (
                                  <div key={b.id} className="rounded-lg border bg-background p-3">
                                    <p className="text-xs font-medium truncate">{b.warehouse?.nameAr ?? "—"}</p>
                                    <div className="flex items-end gap-1 mt-1">
                                      <span className="text-lg font-bold tabular-nums">{Number(b.qty).toFixed(2)}</span>
                                      <span className="text-xs text-muted-foreground mb-0.5">{it.unit?.code ?? ""}</span>
                                    </div>
                                    <p className="text-[10px] text-muted-foreground">متوسط التكلفة: {Number(b.avgCost).toFixed(2)} ر.س</p>
                                  </div>
                                ))}
                              </div>
                            )}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
          </tbody>
        </table>
        {!isLoading && (
          <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">
            {filtered.length} صنف من {items.length}
          </div>
        )}
      </div>
    </div>
  );
}
