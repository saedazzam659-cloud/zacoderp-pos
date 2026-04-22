import { useState, Fragment } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { parseError } from "@/lib/parseError";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import ExportButtons from "@/components/ExportButtons";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { AccountCombobox } from "@/components/AccountCombobox";
import { useFmt, trimTrailingZeros } from "@/hooks/use-fmt";
import {
  Plus, Pencil, Trash2, Package, Search, X, Save,
  ChevronDown, ChevronUp, Warehouse, Ruler, Star,
  AlertTriangle, BookMarked,
} from "lucide-react";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

const EMPTY = {
  code: "", nameAr: "", nameEn: "", barcode: "", itemType: "stock",
  groupId: "", unitId: "", costPrice: "0", salePrice: "0", vatRate: "15",
  reorderLevel: "0", maxLevel: "", costMethod: "weighted_avg", description: "", status: "active",
  costAccountId: "", revenueAccountId: "", imageUrl: "",
};

function ItemImageUpload({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);

  async function handleFile(file: File) {
    if (!file.type.startsWith("image/")) {
      toast({ title: "نوع ملف غير مدعوم", description: "يرجى اختيار صورة فقط", variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "حجم الصورة كبير", description: "الحد الأقصى 5 ميجابايت", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const res = await fetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("zatca_token") ?? ""}` },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!res.ok) throw new Error("فشل تجهيز رابط الرفع");
      const { uploadURL, objectPath } = await res.json();
      const putRes = await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!putRes.ok) throw new Error("فشل رفع الصورة");
      onChange(objectPath);
      toast({ title: "تم رفع الصورة" });
    } catch (e: any) {
      toast({ title: "تعذّر رفع الصورة", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  const previewSrc = value ? (value.startsWith("/objects/") ? `/api/storage${value}` : value) : "";

  return (
    <div className="flex items-center gap-3">
      <div className="w-20 h-20 rounded-xl border border-dashed border-border bg-muted/30 grid place-items-center overflow-hidden shrink-0">
        {previewSrc ? (
          <img src={previewSrc} alt="" className="w-full h-full object-cover" />
        ) : (
          <Package className="h-7 w-7 text-muted-foreground/50" />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <label className="cursor-pointer">
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={uploading}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
          />
          <span className="inline-flex items-center gap-1.5 text-xs h-8 px-3 rounded-md border bg-background hover:bg-accent transition">
            {uploading ? "جارٍ الرفع..." : value ? "تغيير الصورة" : "رفع صورة"}
          </span>
        </label>
        {value && (
          <button
            type="button"
            className="text-xs text-destructive hover:underline text-right"
            onClick={() => onChange("")}
          >
            إزالة الصورة
          </button>
        )}
      </div>
    </div>
  );
}
const UNIT_EMPTY = { unitId: "", conversionFactor: "1", costPrice: "0", salePrice: "0", isBase: false };

// ─── Item Unit Prices Panel ──────────────────────────────────────────────────
function ItemUnitPricesPanel({ itemId }: { itemId: number }) {
  const { t } = useTranslation();
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
    onSuccess: () => { inv(); setForm(UNIT_EMPTY); setShowUnitForm(false); toast({ title: t("pages.items.unitAdded") }); },
  });
  const updMut = useMutation({
    mutationFn: ({ upId, data }: any) => inventoryApi.updateItemUnit(itemId, upId, data),
    onSuccess: () => { inv(); setForm(UNIT_EMPTY); setEditUpId(null); setShowUnitForm(false); toast({ title: t("pages.items.updated") }); },
  });
  const delMut = useMutation({
    mutationFn: (upId: number) => inventoryApi.deleteItemUnit(itemId, upId),
    onSuccess: () => { inv(); toast({ title: t("pages.items.deleted") }); },
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
          {t("pages.items.unitPricesDescription")}
        </p>
        {!showUnitForm && (
          <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs" onClick={() => { setForm(UNIT_EMPTY); setEditUpId(null); setShowUnitForm(true); }}>
            <Plus className="h-3.5 w-3.5" />{t("pages.items.addUnit")}
          </Button>
        )}
      </div>

      {/* Unit form */}
      {showUnitForm && (
        <div className="rounded-lg border bg-background p-4">
          <form onSubmit={handleSubmitUp} className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("pages.items.unitLabel")}</Label>
                <SearchCombobox
                  items={availableUnits.map((u: any) => ({ value: String(u.id), code: u.code, label: u.nameAr }))}
                  value={form.unitId}
                  onValueChange={v => setForm((p: any) => ({ ...p, unitId: v }))}
                  placeholder={t("pages.items.chooseUnit")}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("pages.items.conversionFactorLabel")}</Label>
                <Input className="h-8 text-xs" type="number" step="any" min="0.000001" value={form.conversionFactor} onChange={e => setForm((p: any) => ({ ...p, conversionFactor: e.target.value }))} required />
                <p className="text-[10px] text-muted-foreground">{t("pages.items.conversionFactorHint")}</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("pages.items.costPriceLabel")}</Label>
                <Input className="h-8 text-xs" type="number" step="any" value={form.costPrice} onChange={e => setForm((p: any) => ({ ...p, costPrice: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("pages.items.salePriceLabel")}</Label>
                <Input className="h-8 text-xs" type="number" step="any" value={form.salePrice} onChange={e => setForm((p: any) => ({ ...p, salePrice: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("pages.items.isBaseLabel")}</Label>
                <div className="flex items-center gap-2 h-8">
                  <input type="checkbox" id="isbase" checked={form.isBase} onChange={e => setForm((p: any) => ({ ...p, isBase: e.target.checked }))} className="rounded" />
                  <label htmlFor="isbase" className="text-xs text-muted-foreground">{t("pages.items.isBaseYes")}</label>
                </div>
              </div>
            </div>
            {/* Preview */}
            {form.unitId && form.conversionFactor && (
              <div className="text-xs bg-amber-50 border border-amber-100 rounded px-3 py-2 text-amber-800">
                {t("pages.items.unitConversionPreview", { factor: trimTrailingZeros(form.conversionFactor) })}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setShowUnitForm(false); setEditUpId(null); }}>{t("common.cancel")}</Button>
              <Button type="submit" size="sm" className="h-7 text-xs" disabled={addMut.isPending || updMut.isPending}>{editUpId ? t("common.save") : t("common.add")}</Button>
            </div>
          </form>
        </div>
      )}

      {/* Unit prices list */}
      {isLoading ? <Skeleton className="h-16 w-full" /> : (unitPrices as any[]).length === 0 && !showUnitForm ? (
        <div className="text-center py-6 text-xs text-muted-foreground border border-dashed rounded-lg">
          <Ruler className="h-6 w-6 mx-auto mb-1.5 opacity-30" />
          <p>{t("pages.items.noUnitsLinked")}</p>
          <p className="mt-0.5 text-[10px]">{t("pages.items.addUnitToDefinePricing")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
          {(unitPrices as any[]).map((up: any) => (
            <div key={up.id} className={cn("rounded-lg border p-3 bg-background flex flex-col gap-1 relative", up.isBase && "border-green-300 bg-green-50/40")}>
              {up.isBase && (
                <span className="absolute top-2 left-2 flex items-center gap-0.5 text-[9px] font-bold text-green-700 bg-green-100 rounded-full px-1.5 py-0.5">
                  <Star className="h-2.5 w-2.5" />{t("pages.items.base")}
                </span>
              )}
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-xs font-bold font-mono text-primary">{up.unit?.code ?? "—"}</span>
                <span className="text-xs font-medium">{up.unit?.nameAr ?? "—"}</span>
              </div>
              <div className="grid grid-cols-3 gap-1 text-[10px]">
                <div className="bg-muted/50 rounded px-1.5 py-1 text-center">
                  <p className="text-muted-foreground">{t("pages.items.factor")}</p>
                  <p className="font-bold tabular-nums">×{trimTrailingZeros(up.conversionFactor)}</p>
                </div>
                <div className="bg-orange-50 rounded px-1.5 py-1 text-center">
                  <p className="text-orange-600">{t("pages.items.cost")}</p>
                  <p className="font-bold tabular-nums text-orange-800">{fmt(up.costPrice)}</p>
                </div>
                <div className="bg-blue-50 rounded px-1.5 py-1 text-center">
                  <p className="text-blue-600">{t("pages.items.sale")}</p>
                  <p className="font-bold tabular-nums text-blue-800">{fmt(up.salePrice)}</p>
                </div>
              </div>
              <div className="flex gap-1 justify-end mt-1">
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleEditUp(up)}><Pencil className="h-3 w-3" /></Button>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => { if (confirm(t("pages.items.deleteUnitPriceConfirm"))) delMut.mutate(up.id); }}><Trash2 className="h-3 w-3" /></Button>
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
  const { t } = useTranslation();
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
  const errToast = (title: string) => (e: any) => toast({ title, description: parseError(e), variant: "destructive" });
  const createMut = useMutation({ mutationFn: inventoryApi.createItem, onSuccess: () => { invalidate(); reset(); toast({ title: t("pages.items.itemSaved") }); }, onError: errToast("تعذّر حفظ الصنف") });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => inventoryApi.updateItem(id, data), onSuccess: () => { invalidate(); reset(); toast({ title: t("pages.items.itemUpdated") }); }, onError: errToast("تعذّر تعديل الصنف") });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteItem, onSuccess: () => { invalidate(); toast({ title: t("pages.items.deleted") }); }, onError: errToast("تعذّر الحذف") });

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

  const ITEM_EXPORT_COLS = [
    { key: "code",          header: t("pages.items.itemCode"),       width: 16 },
    { key: "nameAr",        header: t("pages.items.nameAr"),   width: 30 },
    { key: "nameEn",        header: t("pages.items.nameEn"), width: 30 },
    { key: "barcode",       header: t("pages.items.barcode"),           width: 18 },
    { key: "itemType",      header: t("common.status"),             width: 12 }, // Used for type here in original? Wait.
    { key: "groupName",     header: t("pages.items.group"),          width: 20 },
    { key: "unitName",      header: t("pages.items.unit"),            width: 14 },
    { key: "costPrice",     header: t("pages.items.costPriceLabel"),       width: 16 },
    { key: "salePrice",     header: t("pages.items.salePriceLabel"),         width: 16 },
    { key: "reorderLevel",  header: t("pages.items.reorderLevel"),          width: 14 },
    { key: "status",        header: t("common.status"),             width: 12 },
  ];

  const exportRows = filtered.map((it: any) => ({
    code:         it.code,
    nameAr:       it.nameAr,
    nameEn:       it.nameEn ?? "",
    barcode:      it.barcode ?? "",
    itemType:     it.itemType === "stock" ? t("pages.items.stock") : t("pages.items.service"),
    groupName:    it.group?.nameAr ?? "",
    unitName:     it.unit?.nameAr ?? "",
    costPrice:    fmt(it.costPrice),
    salePrice:    fmt(it.salePrice),
    reorderLevel: fmtQty(it.reorderLevel),
    status:       it.status === "active" ? t("pages.items.active") : t("pages.items.inactive"),
  }));

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Package className="h-6 w-6 text-primary" />{t("pages.items.itemsTitle")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("pages.items.itemsSubtitle")}</p>
        </div>
        <div className="flex gap-2">
          <ExportButtons rows={exportRows} columns={ITEM_EXPORT_COLS} filename={`${t("pages.items.itemsTitle")}-${new Date().toISOString().slice(0,10)}`} title={t("pages.items.itemsTitle")} />
          <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
            <Plus className="h-4 w-4" />{t("pages.items.newItem")}
          </Button>
        </div>
      </div>

      {showForm && (
        <FormPanel
          icon={Package}
          title={editId ? t("pages.items.editItem") : t("pages.items.newItem")}
          subtitle={t("pages.items.itemFormSubtitle")}
          width="4xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending || updateMut.isPending}
          saveDisabled={!form.code || !form.nameAr}
          saveLabel={editId ? t("pages.items.saveEdit") : t("pages.items.addItem")}
        >
          <Tabs value={activeItemTab} onValueChange={setActiveItemTab} className="w-full">
            <TabsList className="w-full h-9 mb-5">
              <TabsTrigger value="basic"    className="flex-1 text-xs gap-1.5"><Package   className="h-3.5 w-3.5" />{t("pages.items.basicData")}</TabsTrigger>
              <TabsTrigger value="pricing"  className="flex-1 text-xs gap-1.5"><Ruler      className="h-3.5 w-3.5" />{t("pages.items.pricingAndControl")}</TabsTrigger>
              <TabsTrigger value="accounts" className="flex-1 text-xs gap-1.5"><BookMarked className="h-3.5 w-3.5" />{t("pages.items.accountingLink")}</TabsTrigger>
            </TabsList>
            <TabsContent value="basic" className="mt-0">
              <FormGrid>
                <Field label={t("pages.items.itemCode")} required><Input placeholder="ITM-001" dir="ltr" className="text-left" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} /></Field>
                <Field label={t("pages.items.nameAr")} required><Input placeholder={t("pages.items.nameAr")} value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} /></Field>
                <Field label={t("pages.items.nameEn")}><Input placeholder="Item Name" dir="ltr" className="text-left" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} /></Field>
                <Field label={t("pages.items.barcode")}><Input placeholder="1234567890" dir="ltr" className="text-left" value={form.barcode} onChange={e => setForm((p: any) => ({ ...p, barcode: e.target.value }))} /></Field>
                <Field label={t("pages.items.itemType")}>
                  <SearchCombobox items={[{ value: "stock", label: t("pages.items.stock") }, { value: "service", label: t("pages.items.service") }]} value={form.itemType} onValueChange={v => setForm((p: any) => ({ ...p, itemType: v }))} placeholder={t("pages.items.itemType")} />
                </Field>
                <Field label={t("pages.items.group")}>
                  <SearchCombobox items={[{ value: "", label: t("pages.items.noGroup") }, ...(groups as any[]).map((g: any) => ({ value: String(g.id), code: g.code, label: g.nameAr, labelEn: g.nameEn }))]} value={form.groupId} onValueChange={v => setForm((p: any) => ({ ...p, groupId: v }))} placeholder={t("pages.items.chooseGroup")} />
                </Field>
                <Field label={t("pages.items.baseUnit")} hint={t("pages.items.baseUnitHint")}>
                  <SearchCombobox items={[{ value: "", label: t("pages.items.chooseUnit") }, ...(units as any[]).map((u: any) => ({ value: String(u.id), code: u.code, label: u.nameAr }))]} value={form.unitId} onValueChange={v => setForm((p: any) => ({ ...p, unitId: v }))} placeholder={t("pages.items.chooseUnit")} />
                </Field>
                <Field label={t("common.status")}>
                  <SearchCombobox items={[{ value: "active", label: t("pages.items.active") }, { value: "inactive", label: t("pages.items.inactive") }]} value={form.status} onValueChange={v => setForm((p: any) => ({ ...p, status: v }))} placeholder={t("common.status")} />
                </Field>
                <Field label="صورة الصنف" className="md:col-span-2">
                  <ItemImageUpload value={form.imageUrl ?? ""} onChange={(v) => setForm((p: any) => ({ ...p, imageUrl: v }))} />
                </Field>
              </FormGrid>
            </TabsContent>
            <TabsContent value="pricing" className="mt-0 space-y-6">
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground mb-3 tracking-wider">{t("pages.items.defaultPricing")}</p>
                <FormGrid>
                  <Field label={t("pages.items.costPriceLabel")}><Input type="number" step="any" dir="ltr" className="text-left" value={form.costPrice} onChange={e => setForm((p: any) => ({ ...p, costPrice: e.target.value }))} /></Field>
                  <Field label={t("pages.items.salePriceLabel")}><Input type="number" step="any" dir="ltr" className="text-left" value={form.salePrice} onChange={e => setForm((p: any) => ({ ...p, salePrice: e.target.value }))} /></Field>
                  <Field label={t("pages.items.vatRate")}><Input type="number" step="any" dir="ltr" className="text-left" value={form.vatRate} onChange={e => setForm((p: any) => ({ ...p, vatRate: e.target.value }))} /></Field>
                  <Field label={t("pages.items.costMethod")}>
                    <SearchCombobox items={[{ value: "weighted_avg", label: t("pages.items.weightedAvg") }, { value: "last_cost", label: t("pages.items.lastCost") }]} value={form.costMethod} onValueChange={v => setForm((p: any) => ({ ...p, costMethod: v }))} placeholder={t("pages.items.costMethodPlaceholder")} />
                  </Field>
                </FormGrid>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground mb-3 tracking-wider">{t("pages.items.controlData")}</p>
                <FormGrid>
                  <Field label={t("pages.items.reorderLevel")}><Input type="number" step="any" dir="ltr" className="text-left" value={form.reorderLevel} onChange={e => setForm((p: any) => ({ ...p, reorderLevel: e.target.value }))} /></Field>
                  <Field label={t("pages.items.maxStockLevel")}><Input type="number" step="any" placeholder={t("pages.items.optional")} dir="ltr" className="text-left" value={form.maxLevel} onChange={e => setForm((p: any) => ({ ...p, maxLevel: e.target.value }))} /></Field>
                  <Field label={t("pages.items.notesDescription")} className="md:col-span-2"><Input placeholder={t("pages.items.descriptionPlaceholder")} value={form.description} onChange={e => setForm((p: any) => ({ ...p, description: e.target.value }))} /></Field>
                </FormGrid>
              </div>
            </TabsContent>
            <TabsContent value="accounts" className="mt-0">
              <FormGrid>
                <Field label={t("pages.items.costAccount")}>
                  <AccountCombobox value={form.costAccountId} onValueChange={v => setForm((p: any) => ({ ...p, costAccountId: v }))} placeholder={t("pages.items.chooseCostAccount")} filterTypes={["expense", "asset"]} grouped={false} />
                </Field>
                <Field label={t("pages.items.revenueAccount")}>
                  <AccountCombobox value={form.revenueAccountId} onValueChange={v => setForm((p: any) => ({ ...p, revenueAccountId: v }))} placeholder={t("pages.items.chooseRevenueAccount")} filterTypes={["revenue"]} grouped={false} />
                </Field>
              </FormGrid>
            </TabsContent>
          </Tabs>
        </FormPanel>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pr-9" placeholder={t("pages.items.searchPlaceholder")} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1 bg-muted/50 p-1 rounded-lg border">
          {(["all", "stock", "service"] as const).map(ti => (
            <button key={ti} onClick={() => setFilterType(ti)} className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-all", filterType === ti ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {ti === "all" ? t("pages.items.all") : ti === "stock" ? t("pages.items.stock") : t("pages.items.service")}
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
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{t("pages.items.code")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{t("pages.items.item")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">{t("pages.items.group")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">{t("pages.items.baseUnit")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden lg:table-cell">{t("pages.items.cost")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden lg:table-cell">{t("pages.items.sale")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{t("pages.items.itemType")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{t("common.status")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-24">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={10} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
              : filtered.length === 0
              ? <tr><td colSpan={10} className="px-4 py-12 text-center text-muted-foreground"><Package className="h-8 w-8 mx-auto mb-2 opacity-30" />{t("pages.items.noItemsFound")}{search ? t("pages.items.matchingSearch") : ""}</td></tr>
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
                        <div className="flex items-center gap-2.5">
                          {it.imageUrl ? (
                            <img
                              src={it.imageUrl.startsWith("/objects/") ? `/api/storage${it.imageUrl}` : it.imageUrl}
                              alt=""
                              className="w-10 h-10 rounded-md object-cover border border-border shrink-0"
                            />
                          ) : (
                            <div className="w-10 h-10 rounded-md bg-muted grid place-items-center shrink-0">
                              <Package className="h-4 w-4 text-muted-foreground/40" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="font-medium">{it.nameAr}</p>
                            {it.nameEn && <p className="text-xs text-muted-foreground">{it.nameEn}</p>}
                            {it.barcode && <p className="text-[10px] text-muted-foreground/70 font-mono">🔖 {it.barcode}</p>}
                          </div>
                        </div>
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
                          {it.itemType === "stock" ? t("pages.items.stock") : t("pages.items.service")}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5", it.status === "active" ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-500")}>
                          {it.status === "active" ? t("pages.items.active") : t("pages.items.inactive")}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(it)}><Pencil className="h-3.5 w-3.5" /></Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => { if (confirm(t("pages.items.deleteItemConfirm"))) deleteMut.mutate(it.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
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
                              <Warehouse className="h-3.5 w-3.5" />{t("pages.items.warehouseBalances")}
                            </button>
                            <button
                              onClick={() => setExpandedTab("units")}
                              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                expandedTab === "units" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                              <Ruler className="h-3.5 w-3.5" />{t("pages.items.unitPrices")}
                            </button>
                          </div>

                          {expandedTab === "balances" && (
                            <>
                              {!itemDetail?.balances?.length
                                ? <p className="text-xs text-muted-foreground py-4 text-center border border-dashed rounded-lg"><Warehouse className="h-6 w-6 mx-auto mb-1.5 opacity-30" />{t("pages.items.noBalancesRegistered")}</p>
                                : (
                                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                                    {itemDetail.balances.map((b: any) => (
                                      <div key={b.id} className="rounded-lg border bg-background p-3">
                                        <p className="text-xs font-medium truncate">{b.warehouse?.nameAr ?? "—"}</p>
                                        <div className="flex items-end gap-1 mt-1">
                                          <span className="text-lg font-bold tabular-nums">{fmtQty(b.qty)}</span>
                                          <span className="text-xs text-muted-foreground mb-0.5">{it.unit?.code ?? ""}</span>
                                        </div>
                                        <p className="text-[10px] text-muted-foreground">{t("pages.items.avgCost")}: {fmt(b.avgCost)} {t("pages.items.sar")}</p>
                                        {Number(b.qty) < Number(it.reorderLevel) && Number(b.qty) >= 0 && (
                                          <p className="text-[10px] text-amber-600 flex items-center gap-0.5 mt-0.5"><AlertTriangle className="h-2.5 w-2.5" />{t("pages.items.belowReorderLevel")}</p>
                                        )}
                                        {Number(b.qty) < 0 && (
                                          <p className="text-[10px] text-red-600 flex items-center gap-0.5 mt-0.5"><AlertTriangle className="h-2.5 w-2.5" />{t("pages.items.negativeBalance")}</p>
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
            {t("pages.items.itemsCount", { filtered: filtered.length, total: items.length })}
          </div>
        )}
      </div>
    </div>
  );
}
