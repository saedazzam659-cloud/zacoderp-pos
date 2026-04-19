import { useState, Fragment } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import ExportButtons from "@/components/ExportButtons";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { AccountCombobox } from "@/components/AccountCombobox";
import { useFmt } from "@/hooks/use-fmt";
import {
  Plus, Pencil, Trash2, Package, Search, X,
  ChevronDown, ChevronUp, Warehouse, Ruler, Star,
  AlertTriangle, BookMarked,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const EMPTY = {
  code: "", nameAr: "", nameEn: "", barcode: "", itemType: "stock",
  groupId: "", unitId: "", costPrice: "0", salePrice: "0", vatRate: "15",
  reorderLevel: "0", maxLevel: "", costMethod: "weighted_avg", description: "", status: "active",
  costAccountId: "", revenueAccountId: "",
};
const UNIT_EMPTY = { unitId: "", conversionFactor: "1", costPrice: "0", salePrice: "0", isBase: false };

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

// ─── Item Unit Prices Panel ──────────────────────────────────────────────────
function ItemUnitPricesPanel({ itemId }: { itemId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const { fmt } = useFmt();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const { data: allUnits = [] } = useQuery({ queryKey: ["units", cid], queryFn: () => inventoryApi.getUnits(cid) });
  const { data: unitPrices = [], isLoading } = useQuery({
    queryKey: ["item-units", itemId],
    queryFn: () => inventoryApi.getItemUnits(itemId),
  });

  const [form, setForm] = useState<any>(UNIT_EMPTY);
  const [editUpId, setEditUpId] = useState<number | null>(null);
  const [showUnitForm, setShowUnitForm] = useState(false);

  const inv = () => qc.invalidateQueries({ queryKey: ["item-units", itemId] });
  const addMut = useMutation({
    mutationFn: (data: any) => inventoryApi.addItemUnit(itemId, data),
    onSuccess: () => { inv(); setForm(UNIT_EMPTY); setShowUnitForm(false); toast({ title: "تمت إضافة الوحدة" }); },
  });
  const updMut = useMutation({
    mutationFn: ({ upId, data }: any) => inventoryApi.updateItemUnit(itemId, upId, data),
    onSuccess: () => { inv(); setForm(UNIT_EMPTY); setEditUpId(null); setShowUnitForm(false); toast({ title: "تم التعديل" }); },
  });
  const delMut = useMutation({
    mutationFn: (upId: number) => inventoryApi.deleteItemUnit(itemId, upId),
    onSuccess: () => { inv(); toast({ title: "تم الحذف" }); },
  });

  function handleEditUp(up: any) {
    setForm({ unitId: String(up.unitId), conversionFactor: up.conversionFactor ?? "1", costPrice: up.costPrice ?? "0", salePrice: up.salePrice ?? "0", isBase: up.isBase });
    setEditUpId(up.id);
    setShowUnitForm(true);
  }
  function handleSubmitUp(e: React.FormEvent) {
    e.preventDefault();
    const data = { ...form, unitId: Number(form.unitId), conversionFactor: form.conversionFactor, costPrice: form.costPrice, salePrice: form.salePrice, isBase: form.isBase };
    if (editUpId) updMut.mutate({ upId: editUpId, data });
    else addMut.mutate(data);
  }

  const usedUnitIds = new Set((unitPrices as any[]).map((u: any) => String(u.unitId)));
  const availableUnits = allUnits.filter((u: any) => !usedUnitIds.has(String(u.id)) || String(u.id) === form.unitId);

  return (
    <div className="space-y-3">
      {/* Header + Add button */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          اربط الصنف بوحدات قياس متعددة مع تحديد معامل التحويل وسعر التكلفة والبيع لكل وحدة
        </p>
        {!showUnitForm && (
          <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs" onClick={() => { setForm(UNIT_EMPTY); setEditUpId(null); setShowUnitForm(true); }}>
            <Plus className="h-3.5 w-3.5" />إضافة وحدة
          </Button>
        )}
      </div>

      {/* Unit form */}
      {showUnitForm && (
        <div className="rounded-lg border bg-background p-4">
          <form onSubmit={handleSubmitUp} className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">وحدة القياس *</Label>
                <SearchCombobox
                  items={availableUnits.map((u: any) => ({ value: String(u.id), code: u.code, label: u.nameAr }))}
                  value={form.unitId}
                  onValueChange={v => setForm((p: any) => ({ ...p, unitId: v }))}
                  placeholder="— اختر وحدة —"
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">معامل التحويل *</Label>
                <Input className="h-8 text-xs" type="number" step="any" min="0.000001" value={form.conversionFactor} onChange={e => setForm((p: any) => ({ ...p, conversionFactor: e.target.value }))} required />
                <p className="text-[10px] text-muted-foreground">عدد الوحدات الأساسية</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">سعر التكلفة</Label>
                <Input className="h-8 text-xs" type="number" step="any" value={form.costPrice} onChange={e => setForm((p: any) => ({ ...p, costPrice: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">سعر البيع</Label>
                <Input className="h-8 text-xs" type="number" step="any" value={form.salePrice} onChange={e => setForm((p: any) => ({ ...p, salePrice: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">وحدة أساسية؟</Label>
                <div className="flex items-center gap-2 h-8">
                  <input type="checkbox" id="isbase" checked={form.isBase} onChange={e => setForm((p: any) => ({ ...p, isBase: e.target.checked }))} className="rounded" />
                  <label htmlFor="isbase" className="text-xs text-muted-foreground">نعم (وحدة المرجع)</label>
                </div>
              </div>
            </div>
            {/* Preview */}
            {form.unitId && form.conversionFactor && (
              <div className="text-xs bg-amber-50 border border-amber-100 rounded px-3 py-2 text-amber-800">
                كل 1 من هذه الوحدة = <b>{Number(form.conversionFactor).toFixed(Number(form.conversionFactor) % 1 === 0 ? 0 : 4)}</b> وحدة أساسية في المخزون
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setShowUnitForm(false); setEditUpId(null); }}>إلغاء</Button>
              <Button type="submit" size="sm" className="h-7 text-xs" disabled={addMut.isPending || updMut.isPending}>{editUpId ? "حفظ" : "إضافة"}</Button>
            </div>
          </form>
        </div>
      )}

      {/* Unit prices list */}
      {isLoading ? <Skeleton className="h-16 w-full" /> : (unitPrices as any[]).length === 0 && !showUnitForm ? (
        <div className="text-center py-6 text-xs text-muted-foreground border border-dashed rounded-lg">
          <Ruler className="h-6 w-6 mx-auto mb-1.5 opacity-30" />
          <p>لم يتم ربط أي وحدات بهذا الصنف بعد</p>
          <p className="mt-0.5 text-[10px]">انقر "إضافة وحدة" لتحديد وحدات التسعير</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
          {(unitPrices as any[]).map((up: any) => (
            <div key={up.id} className={cn("rounded-lg border p-3 bg-background flex flex-col gap-1 relative", up.isBase && "border-green-300 bg-green-50/40")}>
              {up.isBase && (
                <span className="absolute top-2 left-2 flex items-center gap-0.5 text-[9px] font-bold text-green-700 bg-green-100 rounded-full px-1.5 py-0.5">
                  <Star className="h-2.5 w-2.5" />أساسية
                </span>
              )}
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-xs font-bold font-mono text-primary">{up.unit?.code ?? "—"}</span>
                <span className="text-xs font-medium">{up.unit?.nameAr ?? "—"}</span>
              </div>
              <div className="grid grid-cols-3 gap-1 text-[10px]">
                <div className="bg-muted/50 rounded px-1.5 py-1 text-center">
                  <p className="text-muted-foreground">معامل</p>
                  <p className="font-bold tabular-nums">×{Number(up.conversionFactor).toFixed(Number(up.conversionFactor) % 1 === 0 ? 0 : 4)}</p>
                </div>
                <div className="bg-orange-50 rounded px-1.5 py-1 text-center">
                  <p className="text-orange-600">تكلفة</p>
                  <p className="font-bold tabular-nums text-orange-800">{fmt(up.costPrice)}</p>
                </div>
                <div className="bg-blue-50 rounded px-1.5 py-1 text-center">
                  <p className="text-blue-600">بيع</p>
                  <p className="font-bold tabular-nums text-blue-800">{fmt(up.salePrice)}</p>
                </div>
              </div>
              <div className="flex gap-1 justify-end mt-1">
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleEditUp(up)}><Pencil className="h-3 w-3" /></Button>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => { if (confirm("حذف وحدة التسعير؟")) delMut.mutate(up.id); }}><Trash2 className="h-3 w-3" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────
export default function Items() {
  const { user } = useAuth();
  const { fmt, fmtQty } = useFmt();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<"all" | "stock" | "service">("all");
  const [form, setForm] = useState<any>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [activeItemTab, setActiveItemTab] = useState("basic");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedTab, setExpandedTab] = useState<"balances" | "units">("balances");

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

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); setActiveItemTab("basic"); }
  function handleEdit(item: any) {
    setForm({
      ...item,
      groupId: item.groupId ?? "", unitId: item.unitId ?? "",
      costPrice: item.costPrice ?? "0", salePrice: item.salePrice ?? "0",
      vatRate: item.vatRate ?? "15", reorderLevel: item.reorderLevel ?? "0",
      maxLevel: item.maxLevel ?? "",
      costAccountId:    item.costAccountId    ? String(item.costAccountId)    : "",
      revenueAccountId: item.revenueAccountId ? String(item.revenueAccountId) : "",
    });
    setEditId(item.id);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      ...form,
      groupId:          form.groupId          ? Number(form.groupId)          : null,
      unitId:           form.unitId           ? Number(form.unitId)           : null,
      costAccountId:    form.costAccountId    ? Number(form.costAccountId)    : null,
      revenueAccountId: form.revenueAccountId ? Number(form.revenueAccountId) : null,
    };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else        createMut.mutate(payload);
  }
  function toggleExpand(id: number) {
    if (expandedId === id) { setExpandedId(null); }
    else { setExpandedId(id); setExpandedTab("balances"); }
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
    costPrice:    fmt(it.costPrice),
    salePrice:    fmt(it.salePrice),
    reorderLevel: fmtQty(it.reorderLevel),
    status:       it.status === "active" ? "نشط" : "موقوف",
  }));

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Package className="h-6 w-6 text-primary" />الأصناف</h1>
          <p className="text-muted-foreground text-sm mt-1">إدارة الأصناف المخزنية والخدمية — انقر على الصنف لإدارة وحدات التسعير والأرصدة</p>
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
          <form onSubmit={handleSubmit}>
            <Tabs value={activeItemTab} onValueChange={setActiveItemTab} className="w-full">
              {/* Tab bar — top right */}
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs text-muted-foreground">اختر التبويب لتعبئة البيانات</span>
                <TabsList className="h-9">
                  <TabsTrigger value="basic"    className="text-xs gap-1.5 px-3"><Package   className="h-3.5 w-3.5" />البيانات الأساسية</TabsTrigger>
                  <TabsTrigger value="pricing"  className="text-xs gap-1.5 px-3"><Ruler      className="h-3.5 w-3.5" />التسعير والتحكم</TabsTrigger>
                  <TabsTrigger value="accounts" className="text-xs gap-1.5 px-3"><BookMarked className="h-3.5 w-3.5" />الربط المحاسبي</TabsTrigger>
                </TabsList>
              </div>

              {/* ── Tab 1: البيانات الأساسية ─────────────────────────────── */}
              <TabsContent value="basic" className="mt-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="space-y-1.5"><Label>كود الصنف *</Label><Input placeholder="ITM-001" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} required /></div>
                  <div className="space-y-1.5"><Label>الاسم بالعربي *</Label><Input placeholder="اسم الصنف" value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} required /></div>
                  <div className="space-y-1.5"><Label>الاسم بالإنجليزي</Label><Input placeholder="Item Name" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} /></div>
                  <div className="space-y-1.5"><Label>باركود</Label><Input placeholder="1234567890" value={form.barcode} onChange={e => setForm((p: any) => ({ ...p, barcode: e.target.value }))} /></div>
                  <div className="space-y-1.5"><Label>نوع الصنف</Label>
                    <SearchCombobox
                      items={[{ value: "stock", label: "مخزني" }, { value: "service", label: "خدمي" }]}
                      value={form.itemType}
                      onValueChange={v => setForm((p: any) => ({ ...p, itemType: v }))}
                      placeholder="نوع الصنف"
                    />
                  </div>
                  <div className="space-y-1.5"><Label>المجموعة</Label>
                    <SearchCombobox
                      items={[{ value: "", label: "بدون مجموعة" }, ...(groups as any[]).map((g: any) => ({ value: String(g.id), code: g.code, label: g.nameAr, labelEn: g.nameEn }))]}
                      value={form.groupId}
                      onValueChange={v => setForm((p: any) => ({ ...p, groupId: v }))}
                      placeholder="— اختر مجموعة —"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>وحدة القياس الأساسية</Label>
                    <SearchCombobox
                      items={[{ value: "", label: "— بدون وحدة —" }, ...(units as any[]).map((u: any) => ({ value: String(u.id), code: u.code, label: u.nameAr }))]}
                      value={form.unitId}
                      onValueChange={v => setForm((p: any) => ({ ...p, unitId: v }))}
                      placeholder="— اختر وحدة —"
                    />
                    <p className="text-[10px] text-muted-foreground">وحدات التسعير المتعددة تُضاف بعد حفظ الصنف</p>
                  </div>
                  <div className="space-y-1.5"><Label>الحالة</Label>
                    <SearchCombobox
                      items={[{ value: "active", label: "نشط" }, { value: "inactive", label: "موقوف" }]}
                      value={form.status}
                      onValueChange={v => setForm((p: any) => ({ ...p, status: v }))}
                      placeholder="الحالة"
                    />
                  </div>
                </div>
              </TabsContent>

              {/* ── Tab 2: التسعير والتحكم ───────────────────────────────── */}
              <TabsContent value="pricing" className="mt-0">
                <div className="space-y-5">
                  <div>
                    <p className="text-xs font-semibold uppercase text-muted-foreground mb-3 tracking-wider">التسعير الافتراضي</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                      <div className="space-y-1.5"><Label>سعر التكلفة</Label><Input type="number" step="any" value={form.costPrice} onChange={e => setForm((p: any) => ({ ...p, costPrice: e.target.value }))} /></div>
                      <div className="space-y-1.5"><Label>سعر البيع</Label><Input type="number" step="any" value={form.salePrice} onChange={e => setForm((p: any) => ({ ...p, salePrice: e.target.value }))} /></div>
                      <div className="space-y-1.5"><Label>نسبة الضريبة %</Label><Input type="number" step="any" value={form.vatRate} onChange={e => setForm((p: any) => ({ ...p, vatRate: e.target.value }))} /></div>
                      <div className="space-y-1.5"><Label>طريقة احتساب التكلفة</Label>
                        <SearchCombobox
                          items={[{ value: "weighted_avg", label: "متوسط مرجح" }, { value: "last_cost", label: "آخر سعر" }]}
                          value={form.costMethod}
                          onValueChange={v => setForm((p: any) => ({ ...p, costMethod: v }))}
                          placeholder="طريقة التكلفة"
                        />
                      </div>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase text-muted-foreground mb-3 tracking-wider">بيانات التحكم</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div className="space-y-1.5"><Label>حد الطلب</Label><Input type="number" step="any" value={form.reorderLevel} onChange={e => setForm((p: any) => ({ ...p, reorderLevel: e.target.value }))} /></div>
                      <div className="space-y-1.5"><Label>الحد الأقصى للمخزون</Label><Input type="number" step="any" placeholder="اختياري" value={form.maxLevel} onChange={e => setForm((p: any) => ({ ...p, maxLevel: e.target.value }))} /></div>
                      <div className="space-y-1.5"><Label>ملاحظات / وصف</Label><Input placeholder="وصف الصنف" value={form.description} onChange={e => setForm((p: any) => ({ ...p, description: e.target.value }))} /></div>
                    </div>
                  </div>
                </div>
              </TabsContent>

              {/* ── Tab 3: الربط المحاسبي ────────────────────────────────── */}
              <TabsContent value="accounts" className="mt-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>حساب التكلفة</Label>
                    <AccountCombobox
                      value={form.costAccountId}
                      onValueChange={v => setForm((p: any) => ({ ...p, costAccountId: v }))}
                      placeholder="— اختر حساب التكلفة —"
                      filterTypes={["expense", "asset"]}
                      grouped={false}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>حساب الإيراد</Label>
                    <AccountCombobox
                      value={form.revenueAccountId}
                      onValueChange={v => setForm((p: any) => ({ ...p, revenueAccountId: v }))}
                      placeholder="— اختر حساب الإيراد —"
                      filterTypes={["revenue"]}
                      grouped={false}
                    />
                  </div>
                </div>
              </TabsContent>
            </Tabs>

            <div className="flex gap-2 justify-end pt-4 mt-4 border-t">
              <Button type="button" variant="outline" onClick={reset}>إلغاء</Button>
              <Button type="submit" disabled={createMut.isPending || updateMut.isPending}>{editId ? "حفظ التعديل" : "إضافة الصنف"}</Button>
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
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">الوحدة الأساسية</th>
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
                  <Fragment key={it.id}>
                    <tr className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <button onClick={() => toggleExpand(it.id)} className="text-muted-foreground hover:text-foreground">
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
                      <td className="px-4 py-3 hidden md:table-cell">
                        {it.unit ? (
                          <span className="text-xs font-mono font-bold text-primary bg-primary/5 rounded px-1.5 py-0.5">{it.unit.code}</span>
                        ) : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell tabular-nums text-xs">{fmt(it.costPrice)}</td>
                      <td className="px-4 py-3 hidden lg:table-cell tabular-nums text-xs font-medium">{fmt(it.salePrice)}</td>
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
                    {/* Expanded row: tabs for balances + unit prices */}
                    {expandedId === it.id && (
                      <tr className="bg-muted/20">
                        <td colSpan={10} className="px-6 py-4">
                          {/* Tabs */}
                          <div className="flex gap-1 bg-muted/50 p-1 rounded-lg w-fit mb-4 border">
                            <button
                              onClick={() => setExpandedTab("balances")}
                              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                expandedTab === "balances" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                              <Warehouse className="h-3.5 w-3.5" />أرصدة المخازن
                            </button>
                            <button
                              onClick={() => setExpandedTab("units")}
                              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                expandedTab === "units" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                              <Ruler className="h-3.5 w-3.5" />وحدات التسعير
                            </button>
                          </div>

                          {expandedTab === "balances" && (
                            <>
                              {!itemDetail?.balances?.length
                                ? <p className="text-xs text-muted-foreground py-4 text-center border border-dashed rounded-lg"><Warehouse className="h-6 w-6 mx-auto mb-1.5 opacity-30" />لا توجد أرصدة مسجّلة</p>
                                : (
                                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                                    {itemDetail.balances.map((b: any) => (
                                      <div key={b.id} className="rounded-lg border bg-background p-3">
                                        <p className="text-xs font-medium truncate">{b.warehouse?.nameAr ?? "—"}</p>
                                        <div className="flex items-end gap-1 mt-1">
                                          <span className="text-lg font-bold tabular-nums">{fmtQty(b.qty)}</span>
                                          <span className="text-xs text-muted-foreground mb-0.5">{it.unit?.code ?? ""}</span>
                                        </div>
                                        <p className="text-[10px] text-muted-foreground">متوسط التكلفة: {fmt(b.avgCost)} ر.س</p>
                                        {Number(b.qty) < Number(it.reorderLevel) && Number(b.qty) >= 0 && (
                                          <p className="text-[10px] text-amber-600 flex items-center gap-0.5 mt-0.5"><AlertTriangle className="h-2.5 w-2.5" />دون حد الطلب</p>
                                        )}
                                        {Number(b.qty) < 0 && (
                                          <p className="text-[10px] text-red-600 flex items-center gap-0.5 mt-0.5"><AlertTriangle className="h-2.5 w-2.5" />رصيد سالب</p>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                            </>
                          )}

                          {expandedTab === "units" && (
                            <ItemUnitPricesPanel itemId={it.id} />
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
          </tbody>
        </table>
        {!isLoading && (
          <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">
            {filtered.length} صنف من {items.length} — انقر على السهم لإدارة وحدات التسعير وأرصدة المخازن
          </div>
        )}
      </div>
    </div>
  );
}
