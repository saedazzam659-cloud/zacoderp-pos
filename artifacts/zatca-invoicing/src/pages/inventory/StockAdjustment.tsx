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
  Plus, Trash2, SlidersHorizontal, Search, X, Send,
  ChevronDown, ChevronUp, Zap,
} from "lucide-react";
import { FormPanel, Field, FormGrid, FormSection } from "@/components/FormPanel";
import { cn } from "@/lib/utils";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { AccountCombobox } from "@/components/AccountCombobox";
import { useFmt } from "@/hooks/use-fmt";

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  draft:  { label: "مسودة",  color: "bg-amber-50 text-amber-700" },
  posted: { label: "مُرحَّل", color: "bg-green-50 text-green-700" },
};
const REASONS = ["تعديل كمي", "تلف وخسارة", "فاقد وكسر", "إدخال أول مرة", "مكافآت وهبات", "أخرى"];

const EMPTY_FORM = {
  adjustmentNumber: "",
  adjustmentDate: new Date().toISOString().slice(0, 10),
  warehouseId: "",
  accountId: "",
  reason: REASONS[0],
  notes: "",
};
const newLine = () => ({ itemId: "", unitId: "", qty: "0", costPrice: "0", notes: "", conversionFactor: "1" });

export default function StockAdjustment() {
  const { fmt, fmtQty } = useFmt();
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

  const { data: adjustments = [], isLoading } = useQuery({
    queryKey: ["stock-adjustments", cid],
    queryFn: () => inventoryApi.getAdjustments(cid),
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
  const { data: adjDetail } = useQuery({
    queryKey: ["adj-detail", expandedId],
    queryFn: () => inventoryApi.getAdjustment(expandedId!),
    enabled: expandedId !== null,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["stock-adjustments"] });
  const createMut = useMutation({
    mutationFn: inventoryApi.createAdjustment,
    onSuccess: () => { invalidate(); reset(); toast({ title: "تم إنشاء التسوية" }); },
  });
  const postMut = useMutation({
    mutationFn: inventoryApi.postAdjustment,
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
      toast({ title: "تم ترحيل التسوية وتحديث المخزون" });
    },
  });
  const deleteMut = useMutation({
    mutationFn: inventoryApi.deleteAdjustment,
    onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); },
  });

  function reset() {
    setForm(EMPTY_FORM);
    setLines([newLine()]);
    setShowForm(false);
  }

  // Fetch unit prices for an item and cache them
  async function fetchItemUnits(itemId: string): Promise<any[]> {
    if (!itemId) return [];
    if (itemUnitsMap[itemId] !== undefined) return itemUnitsMap[itemId];
    try {
      const ups = await inventoryApi.getItemUnits(Number(itemId));
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
    if (!form.warehouseId) {
      toast({ title: "يجب اختيار المخزن", variant: "destructive" });
      return;
    }
    const validLines = lines.filter(l => l.itemId);
    if (!validLines.length) {
      toast({ title: "أضف صنفاً واحداً على الأقل", variant: "destructive" });
      return;
    }
    createMut.mutate({
      ...form,
      warehouseId: Number(form.warehouseId),
      accountId: form.accountId ? Number(form.accountId) : null,
      items: validLines.map(l => ({
        itemId: Number(l.itemId),
        unitId: l.unitId ? Number(l.unitId) : null,
        qty: l.qty,
        costPrice: l.costPrice,
        notes: l.notes,
      })),
    });
  }

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

  function isAutoFilled(line: any): boolean {
    const cached = itemUnitsMap[line.itemId] ?? [];
    return !!line.unitId && cached.some((u: any) => String(u.unitId) === line.unitId);
  }

  const filtered = (adjustments as any[]).filter(
    (a: any) => a.adjustmentNumber.includes(search) || (a.warehouse?.nameAr ?? "").includes(search)
  );

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <SlidersHorizontal className="h-6 w-6 text-primary" />
            التسوية المخزنية
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            تعديل وضبط أرصدة المخزون — اختيار الوحدة يملأ التكلفة تلقائياً
          </p>
        </div>
        <Button
          size="sm"
          className="gap-2"
          onClick={() => { reset(); setShowForm(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}
        >
          <Plus className="h-4 w-4" />تسوية جديدة
        </Button>
      </div>

      {/* Form */}
      {showForm && (
        <FormPanel
          icon={SlidersHorizontal}
          title="تسوية مخزنية جديدة"
          subtitle="إضافة أو خصم كميات الأصناف من المخزن مع ربط محاسبي اختياري"
          width="6xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending}
          saveDisabled={!form.warehouseId || !form.adjustmentDate}
          saveLabel="حفظ التسوية"
        >
          <div className="space-y-5">
            <FormSection title="معلومات الحركة">
              <FormGrid cols={2}>
                <Field label="رقم التسوية"><Input placeholder="ADJ-001 (تلقائي)" dir="ltr" className="text-left" value={form.adjustmentNumber} onChange={e => setForm((p: any) => ({ ...p, adjustmentNumber: e.target.value }))} /></Field>
                <Field label="التاريخ" required><Input type="date" value={form.adjustmentDate} onChange={e => setForm((p: any) => ({ ...p, adjustmentDate: e.target.value }))} /></Field>
                <Field label="المخزن" required>
                  <SearchCombobox items={(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr }))} value={form.warehouseId} onValueChange={v => setForm((p: any) => ({ ...p, warehouseId: v }))} placeholder="— اختر مخزن —" />
                </Field>
                <Field label="سبب التسوية">
                  <SearchCombobox items={REASONS.map(r => ({ value: r, label: r }))} value={form.reason} onValueChange={v => setForm((p: any) => ({ ...p, reason: v }))} placeholder="— اختر السبب —" />
                </Field>
                <Field label="ملاحظات" className="md:col-span-2"><Input placeholder="ملاحظات اختيارية" value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} /></Field>
              </FormGrid>
            </FormSection>

            <div className="rounded-lg border border-dashed border-muted-foreground/30 bg-muted/20 p-4">
              <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-3">الربط المحاسبي (اختياري)</p>
              <div className="max-w-xs">
                <Label className="text-xs font-medium text-foreground/80">الحساب المحاسبي</Label>
                <AccountCombobox value={form.accountId} onValueChange={v => setForm((p: any) => ({ ...p, accountId: v }))} placeholder="— اختر الحساب —" grouped={false} />
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
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground w-28">الكمية (+ زيادة / - نقص)</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground w-36">
                        <span className="flex items-center gap-1">
                          سعر التكلفة <Zap className="h-3 w-3 text-amber-500"><title>يُملأ تلقائياً</title></Zap>
                        </span>
                      </th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">ملاحظة</th>
                      <th className="px-3 py-2 w-10" />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {lines.map((line, i) => {
                      const lineUnits = getLineUnits(line);
                      const cf = Number(line.conversionFactor || "1");
                      const baseQtyHint = cf !== 1 ? `×${cf} = ${fmtQty(Number(line.qty || 0) * cf)} وحدة أساسية` : null;
                      const autoFilled = isAutoFilled(line);
                      const qtyNum = Number(line.qty || 0);

                      return (
                        <tr key={i}>
                          {/* Item */}
                          <td className="px-3 py-2 min-w-[180px]">
                            <SearchCombobox
                              items={(items as any[]).filter((it: any) => it.itemType === "stock").map((it: any) => ({ value: String(it.id), code: it.code, label: it.nameAr, labelEn: it.nameEn }))}
                              value={line.itemId}
                              onValueChange={v => handleItemSelect(i, v)}
                              placeholder="— اختر صنف —"
                              className="h-8 text-xs"
                            />
                          </td>

                          {/* Unit */}
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
                              dir="ltr"
                              className="h-8 text-xs text-left"
                              value={line.qty}
                              onChange={e => updateLine(i, "qty", e.target.value)}
                              placeholder="+100 أو -50"
                            />
                            <p className={cn(
                              "text-[10px] mt-0.5 leading-tight",
                              qtyNum >= 0 ? "text-green-600" : "text-red-600"
                            )}>
                              {qtyNum >= 0 ? "▲ زيادة" : "▼ نقص"}
                            </p>
                          </td>

                          {/* Cost price */}
                          <td className="px-3 py-2">
                            <div className="relative">
                              <Input
                                type="number"
                                step="any"
                                min="0"
                                dir="ltr"
                                className={cn(
                                  "h-8 text-xs text-left",
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

                          {/* Notes */}
                          <td className="px-3 py-2">
                            <Input
                              className="h-8 text-xs"
                              placeholder="ملاحظة"
                              value={line.notes}
                              onChange={e => updateLine(i, "notes", e.target.value)}
                            />
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
                </table>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
                <Zap className="h-3 w-3 text-amber-500" />
                اختيار الصنف يملأ الوحدة والتكلفة تلقائياً — يمكن تعديل التكلفة يدوياً
              </p>
            </div>
          </div>
        </FormPanel>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          className="pr-9"
          placeholder="بحث برقم التسوية أو المخزن..."
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
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">رقم التسوية</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">التاريخ</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">المخزن</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">السبب</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الحالة</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-32">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => (
                  <tr key={i}><td colSpan={7}><Skeleton className="h-6 m-4" /></td></tr>
                ))
              : filtered.length === 0
              ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-muted-foreground">
                    <SlidersHorizontal className="h-8 w-8 mx-auto mb-2 opacity-30" />لا توجد تسويات
                  </td>
                </tr>
              )
              : filtered.map((adj: any) => {
                  const st = STATUS_CONFIG[adj.status] ?? STATUS_CONFIG.draft;
                  return (
                    <Fragment key={adj.id}>
                      <tr className="hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <button
                            onClick={() => setExpandedId(expandedId === adj.id ? null : adj.id)}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            {expandedId === adj.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </button>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs font-bold">{adj.adjustmentNumber}</td>
                        <td className="px-4 py-3 text-muted-foreground">{adj.adjustmentDate}</td>
                        <td className="px-4 py-3 hidden sm:table-cell">{adj.warehouse?.nameAr ?? "—"}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-muted-foreground text-xs">{adj.reason ?? "—"}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn("text-[10px] font-medium rounded-full px-2.5 py-1", st.color)}>
                            {st.label}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1">
                            {adj.status === "draft" && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs gap-1 text-green-700 border-green-200 hover:bg-green-50"
                                  onClick={() => { if (confirm("ترحيل التسوية وتحديث أرصدة المخزون؟")) postMut.mutate(adj.id); }}
                                >
                                  <Send className="h-3 w-3" />ترحيل
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive"
                                  onClick={() => { if (confirm("حذف التسوية؟")) deleteMut.mutate(adj.id); }}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Expanded detail */}
                      {expandedId === adj.id && (
                        <tr className="bg-muted/10">
                          <td colSpan={7} className="px-6 py-4">
                            {!adjDetail?.items?.length
                              ? <p className="text-xs text-muted-foreground">لا توجد أصناف</p>
                              : (
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-muted-foreground border-b">
                                      <th className="text-right pb-2 pr-0">الصنف</th>
                                      <th className="text-right pb-2">الوحدة</th>
                                      <th className="text-right pb-2">الكمية</th>
                                      <th className="text-right pb-2">التكلفة</th>
                                      <th className="text-right pb-2">ملاحظة</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-border/50">
                                    {adjDetail.items.map((l: any) => (
                                      <tr key={l.id}>
                                        <td className="py-1.5 pr-0">{l.item?.nameAr ?? l.itemId}</td>
                                        <td className="py-1.5">{l.unit?.nameAr ?? "وحدة أساسية"}</td>
                                        <td className={cn(
                                          "py-1.5 tabular-nums font-medium",
                                          Number(l.qty) >= 0 ? "text-green-600" : "text-red-600"
                                        )}>
                                          {Number(l.qty) >= 0 ? "+" : ""}{fmtQty(l.qty)}
                                        </td>
                                        <td className="py-1.5 tabular-nums">{fmt(l.costPrice)}</td>
                                        <td className="py-1.5 text-muted-foreground">{l.notes ?? "—"}</td>
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
            {filtered.length} تسوية
          </div>
        )}
      </div>
    </div>
  );
}
