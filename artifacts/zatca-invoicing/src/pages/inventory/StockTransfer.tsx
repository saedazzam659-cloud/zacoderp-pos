import { useState, Fragment } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Trash2, ArrowRightLeft, Search, X,
  CheckCircle2, Send, ChevronDown, ChevronUp, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchCombobox } from "@/components/ui/search-combobox";

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  draft:     { label: "مسودة",   color: "bg-amber-50 text-amber-700" },
  posted:    { label: "مُرحَّل",  color: "bg-green-50 text-green-700" },
  cancelled: { label: "ملغي",    color: "bg-red-50 text-red-600" },
};
const EMPTY_FORM = {
  transferNumber: "",
  transferDate: new Date().toISOString().slice(0, 10),
  fromWarehouseId: "",
  toWarehouseId: "",
  notes: "",
};
const newLine = () => ({ itemId: "", unitId: "", qty: "1", costPrice: "0", conversionFactor: "1" });

export default function StockTransfer() {
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [form, setForm] = useState<any>(EMPTY_FORM);
  const [lines, setLines] = useState<any[]>([newLine()]);
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // itemUnitsMap: itemId → array of unit-price rows (cached after first fetch)
  const [itemUnitsMap, setItemUnitsMap] = useState<Record<string, any[]>>({});

  const { data: transfers = [], isLoading } = useQuery({
    queryKey: ["stock-transfers", cid],
    queryFn: () => inventoryApi.getTransfers(cid),
  });
  const { data: warehouses = [] } = useQuery({
    queryKey: ["warehouses", cid],
    queryFn: () => inventoryApi.getWarehouses(cid),
  });
  const { data: items = [] } = useQuery({
    queryKey: ["items", cid],
    queryFn: () => inventoryApi.getItems(cid),
  });
  const { data: units = [] } = useQuery({
    queryKey: ["units", cid],
    queryFn: () => inventoryApi.getUnits(cid),
  });
  const { data: trDetail } = useQuery({
    queryKey: ["transfer-detail", expandedId],
    queryFn: () => inventoryApi.getTransfer(expandedId!),
    enabled: expandedId !== null,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["stock-transfers"] });
  const createMut = useMutation({
    mutationFn: (d: any) => inventoryApi.createTransfer(d),
    onSuccess: () => { invalidate(); reset(); toast({ title: "تم إنشاء أمر التحويل" }); },
  });
  const postMut = useMutation({
    mutationFn: (id: number) => inventoryApi.postTransfer(id),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
      toast({ title: "تم ترحيل التحويل وتحديث المخزون" });
    },
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => inventoryApi.deleteTransfer(id),
    onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); },
  });

  function reset() {
    setForm(EMPTY_FORM);
    setLines([newLine()]);
    setShowForm(false);
  }

  // Fetch unit prices for an item and cache them, then return the array
  async function fetchItemUnits(itemId: string): Promise<any[]> {
    if (!itemId) return [];
    // Return cached value if already fetched
    if (itemUnitsMap[itemId] !== undefined) return itemUnitsMap[itemId];
    try {
      const ups = await inventoryApi.getItemUnits(Number(itemId));
      // Persist to cache
      setItemUnitsMap(prev => ({ ...prev, [itemId]: ups }));
      return ups;
    } catch {
      setItemUnitsMap(prev => ({ ...prev, [itemId]: [] }));
      return [];
    }
  }

  // When user picks an item: load unit prices, pre-select base unit, auto-fill cost
  async function handleItemSelect(lineIdx: number, itemId: string) {
    const item = (items as any[]).find((it: any) => String(it.id) === itemId);
    const ups = await fetchItemUnits(itemId);
    const baseUp = ups.find((u: any) => u.isBase) ?? ups[0] ?? null;
    setLines(prev =>
      prev.map((l, idx) =>
        idx === lineIdx
          ? {
              ...l,
              itemId,
              unitId: baseUp ? String(baseUp.unitId) : "",
              costPrice: baseUp
                ? String(baseUp.costPrice)
                : (item?.costPrice ?? "0"),
              conversionFactor: baseUp ? String(baseUp.conversionFactor) : "1",
            }
          : l
      )
    );
  }

  // When user changes the unit: look up cost from cached unit prices
  function handleUnitSelect(lineIdx: number, unitId: string) {
    setLines(prev =>
      prev.map((l, idx) => {
        if (idx !== lineIdx) return l;
        const ups: any[] = itemUnitsMap[l.itemId] ?? [];
        const up = ups.find((u: any) => String(u.unitId) === unitId);
        return {
          ...l,
          unitId,
          costPrice: up ? String(up.costPrice) : l.costPrice,
          conversionFactor: up ? String(up.conversionFactor) : "1",
        };
      })
    );
  }

  function updateLine(idx: number, key: string, val: string) {
    setLines(prev => prev.map((l, i) => (i === idx ? { ...l, [key]: val } : l)));
  }
  function addLine() { setLines(prev => [...prev, newLine()]); }
  function removeLine(idx: number) { setLines(prev => prev.filter((_, i) => i !== idx)); }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.fromWarehouseId || !form.toWarehouseId) {
      toast({ title: "يجب اختيار مخزن المصدر والوجهة", variant: "destructive" });
      return;
    }
    const validLines = lines.filter(l => l.itemId && Number(l.qty) > 0);
    if (!validLines.length) {
      toast({ title: "يجب إضافة صنف واحد على الأقل", variant: "destructive" });
      return;
    }
    createMut.mutate({
      ...form,
      fromWarehouseId: Number(form.fromWarehouseId),
      toWarehouseId: Number(form.toWarehouseId),
      items: validLines.map(l => ({
        itemId: Number(l.itemId),
        unitId: l.unitId ? Number(l.unitId) : null,
        qty: l.qty,
        costPrice: l.costPrice,
      })),
    });
  }

  // Get available units for a line's item (from cache or fall back to global)
  function getLineUnits(line: any): { id: number; nameAr: string; code?: string }[] {
    const cached = itemUnitsMap[line.itemId];
    if (cached && cached.length > 0) {
      return cached.map((u: any) => ({
        id: u.unitId,
        nameAr: u.unit?.nameAr ?? "—",
        code: u.unit?.code,
      }));
    }
    return (units as any[]).map((u: any) => ({ id: u.id, nameAr: u.nameAr, code: u.code }));
  }

  // Check if the current unit has an auto-filled price
  function isAutoFilled(line: any): boolean {
    const cached = itemUnitsMap[line.itemId] ?? [];
    return !!line.unitId && cached.some((u: any) => String(u.unitId) === line.unitId);
  }

  const filtered = (transfers as any[]).filter(
    (t: any) =>
      t.transferNumber.includes(search) ||
      (t.fromWarehouse?.nameAr ?? "").includes(search) ||
      (t.toWarehouse?.nameAr ?? "").includes(search)
  );

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ArrowRightLeft className="h-6 w-6 text-primary" />
            التحويل بين المخازن
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            نقل الأصناف بين المخازن — اختيار الوحدة يملأ السعر تلقائياً
          </p>
        </div>
        <Button
          size="sm"
          className="gap-2"
          onClick={() => { reset(); setShowForm(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}
        >
          <Plus className="h-4 w-4" />تحويل جديد
        </Button>
      </div>

      {/* Form */}
      {showForm && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b bg-muted/30">
            <h2 className="font-semibold">أمر تحويل جديد</h2>
            <Button variant="ghost" size="icon" onClick={reset}><X className="h-4 w-4" /></Button>
          </div>
          <form onSubmit={handleSubmit} className="p-5 space-y-6">
            {/* Header fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-1.5">
                <Label>رقم الحركة</Label>
                <Input
                  placeholder="TRF-001 (تلقائي)"
                  value={form.transferNumber}
                  onChange={e => setForm((p: any) => ({ ...p, transferNumber: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>التاريخ *</Label>
                <Input
                  type="date"
                  value={form.transferDate}
                  onChange={e => setForm((p: any) => ({ ...p, transferDate: e.target.value }))}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label>من مخزن *</Label>
                <SearchCombobox
                  items={(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr }))}
                  value={form.fromWarehouseId}
                  onValueChange={v => setForm((p: any) => ({ ...p, fromWarehouseId: v }))}
                  placeholder="— اختر مخزن المصدر —"
                />
              </div>
              <div className="space-y-1.5">
                <Label>إلى مخزن *</Label>
                <SearchCombobox
                  items={(warehouses as any[]).filter((w: any) => String(w.id) !== form.fromWarehouseId).map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr }))}
                  value={form.toWarehouseId}
                  onValueChange={v => setForm((p: any) => ({ ...p, toWarehouseId: v }))}
                  placeholder="— اختر مخزن الوجهة —"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2 lg:col-span-4">
                <Label>ملاحظات</Label>
                <Input
                  placeholder="ملاحظات اختيارية"
                  value={form.notes}
                  onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))}
                />
              </div>
            </div>

            {/* Line items */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">الأصناف</h3>
                <Button type="button" size="sm" variant="outline" onClick={addLine} className="gap-1 h-7 text-xs">
                  <Plus className="h-3 w-3" />إضافة صنف
                </Button>
              </div>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 border-b">
                    <tr>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">الصنف</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground w-36">الوحدة</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground w-24">الكمية</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground w-36">
                        <span className="flex items-center gap-1">
                          سعر التكلفة <Zap className="h-3 w-3 text-amber-500" title="يُملأ تلقائياً" />
                        </span>
                      </th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground w-28">الإجمالي</th>
                      <th className="px-3 py-2 w-10" />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {lines.map((line, i) => {
                      const lineUnits = getLineUnits(line);
                      const cf = Number(line.conversionFactor || "1");
                      const baseQtyHint = cf !== 1 ? `×${cf} = ${(Number(line.qty || 0) * cf).toFixed(2)} وحدة أساسية` : null;
                      const autoFilled = isAutoFilled(line);

                      return (
                        <tr key={i}>
                          {/* Item selector */}
                          <td className="px-3 py-2 min-w-[180px]">
                            <SearchCombobox
                              items={(items as any[]).filter((it: any) => it.itemType === "stock").map((it: any) => ({ value: String(it.id), code: it.code, label: it.nameAr, labelEn: it.nameEn }))}
                              value={line.itemId}
                              onValueChange={v => handleItemSelect(i, v)}
                              placeholder="— اختر صنف —"
                              className="h-8 text-xs"
                            />
                          </td>

                          {/* Unit selector */}
                          <td className="px-3 py-2 min-w-[120px]">
                            <SearchCombobox
                              items={[{ value: "", label: "وحدة أساسية" }, ...lineUnits.map(u => ({ value: String(u.id), label: u.nameAr }))]}
                              value={line.unitId}
                              onValueChange={v => handleUnitSelect(i, v)}
                              placeholder="وحدة أساسية"
                              className="h-8 text-xs"
                            />
                            {baseQtyHint && (
                              <p className="text-[10px] text-purple-600 mt-0.5 font-medium leading-tight">
                                {baseQtyHint}
                              </p>
                            )}
                          </td>

                          {/* Qty */}
                          <td className="px-3 py-2">
                            <Input
                              type="number"
                              step="any"
                              min="0.001"
                              className="h-8 text-xs"
                              value={line.qty}
                              onChange={e => updateLine(i, "qty", e.target.value)}
                            />
                          </td>

                          {/* Cost price */}
                          <td className="px-3 py-2">
                            <div className="relative">
                              <Input
                                type="number"
                                step="any"
                                min="0"
                                className={cn(
                                  "h-8 text-xs",
                                  autoFilled && "border-amber-300 bg-amber-50/60"
                                )}
                                value={line.costPrice}
                                onChange={e => updateLine(i, "costPrice", e.target.value)}
                              />
                              {autoFilled && (
                                <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[8px] font-bold text-amber-600 bg-amber-100 rounded px-0.5">
                                  تلقائي
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Total */}
                          <td className="px-3 py-2 tabular-nums text-xs text-muted-foreground">
                            {(Number(line.qty) * Number(line.costPrice)).toFixed(2)}
                          </td>

                          {/* Remove */}
                          <td className="px-3 py-2">
                            {lines.length > 1 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-destructive"
                                onClick={() => removeLine(i)}
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-muted/30 border-t">
                    <tr>
                      <td colSpan={4} className="px-3 py-2 text-xs font-semibold text-left">إجمالي التحويل</td>
                      <td className="px-3 py-2 text-xs font-bold tabular-nums">
                        {lines.reduce((s, l) => s + Number(l.qty) * Number(l.costPrice), 0).toFixed(2)} ر.س
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
                <Zap className="h-3 w-3 text-amber-500" />
                عند اختيار الصنف تُملأ الوحدة الأساسية والتكلفة تلقائياً من وحدات التسعير
              </p>
            </div>

            <div className="flex gap-2 justify-end pt-2 border-t">
              <Button type="button" variant="outline" onClick={reset}>إلغاء</Button>
              <Button type="submit" disabled={createMut.isPending}>حفظ كمسودة</Button>
            </div>
          </form>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          className="pr-9"
          placeholder="بحث برقم الحركة أو المخزن..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* List */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-8" />
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">رقم الحركة</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">التاريخ</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">من مخزن</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">إلى مخزن</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الحالة</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-32">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => (
                  <tr key={i}>
                    <td colSpan={7} className="px-4 py-3">
                      <Skeleton className="h-6 w-full" />
                    </td>
                  </tr>
                ))
              : filtered.length === 0
              ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    <ArrowRightLeft className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    لا توجد حركات تحويل
                  </td>
                </tr>
              )
              : filtered.map((tr: any) => {
                  const st = STATUS_CONFIG[tr.status] ?? STATUS_CONFIG.draft;
                  return (
                    <Fragment key={tr.id}>
                      <tr className="hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <button
                            onClick={() => setExpandedId(expandedId === tr.id ? null : tr.id)}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            {expandedId === tr.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </button>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs font-bold">{tr.transferNumber}</td>
                        <td className="px-4 py-3 text-muted-foreground">{tr.transferDate}</td>
                        <td className="px-4 py-3 hidden sm:table-cell">{tr.fromWarehouse?.nameAr ?? "—"}</td>
                        <td className="px-4 py-3 hidden sm:table-cell">{tr.toWarehouse?.nameAr ?? "—"}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn("text-[10px] font-medium rounded-full px-2.5 py-1", st.color)}>
                            {st.label}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 items-center">
                            {tr.status === "draft" && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs gap-1 text-green-700 border-green-200 hover:bg-green-50"
                                  onClick={() => { if (confirm("ترحيل التحويل وتحديث أرصدة المخزون؟")) postMut.mutate(tr.id); }}
                                >
                                  <Send className="h-3 w-3" />ترحيل
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive"
                                  onClick={() => { if (confirm("حذف أمر التحويل؟")) deleteMut.mutate(tr.id); }}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </>
                            )}
                            {tr.status === "posted" && (
                              <CheckCircle2 className="h-4 w-4 text-green-600" />
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Expanded detail */}
                      {expandedId === tr.id && (
                        <tr className="bg-muted/10">
                          <td colSpan={7} className="px-6 py-4">
                            {!trDetail?.items?.length
                              ? <p className="text-xs text-muted-foreground">لا توجد أصناف</p>
                              : (
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-muted-foreground border-b">
                                      <th className="text-right pb-2 pr-0">الصنف</th>
                                      <th className="text-right pb-2">الوحدة</th>
                                      <th className="text-right pb-2">الكمية</th>
                                      <th className="text-right pb-2">التكلفة</th>
                                      <th className="text-right pb-2">الإجمالي</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-border/50">
                                    {trDetail.items.map((l: any) => (
                                      <tr key={l.id}>
                                        <td className="py-1.5 pr-0">{l.item?.nameAr ?? l.itemId}</td>
                                        <td className="py-1.5">{l.unit?.nameAr ?? "وحدة أساسية"}</td>
                                        <td className="py-1.5 tabular-nums">{Number(l.qty).toFixed(2)}</td>
                                        <td className="py-1.5 tabular-nums">{Number(l.costPrice).toFixed(2)}</td>
                                        <td className="py-1.5 tabular-nums font-medium">
                                          {(Number(l.qty) * Number(l.costPrice)).toFixed(2)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
          </tbody>
        </table>
        {!isLoading && (
          <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">
            {filtered.length} أمر تحويل
          </div>
        )}
      </div>
    </div>
  );
}
