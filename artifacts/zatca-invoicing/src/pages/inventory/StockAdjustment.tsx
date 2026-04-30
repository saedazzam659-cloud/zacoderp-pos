import { useState, useEffect, Fragment } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import {
  Plus, Trash2, SlidersHorizontal, Search, X, Send, Save,
  ChevronDown, ChevronUp, Zap, Sparkles, Loader2,
  FileText, Settings2, Boxes,
} from "lucide-react";
import { Field, FormGrid } from "@/components/FormPanel";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  inventoryAccountId: "",
  adjustmentAccountId: "",
  reason: REASONS[0],
  notes: "",
};
const newLine = () => ({ itemId: "", unitId: "", qty: "0", costPrice: "0", notes: "", conversionFactor: "1" });

export default function StockAdjustment() {
  const { fmt, fmtQty } = useFmt();
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const [aiLoading, setAiLoading] = useState(false);
  const [aiReasoning, setAiReasoning] = useState<string>("");
  const qc = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [form, setForm] = useState<any>(EMPTY_FORM);
  const [lines, setLines] = useState<any[]>([newLine()]);
  const [showForm, setShowForm] = useState(false);

  const seqPeek = useNextSequenceNumber("stock_adjustment", showForm);
  useEffect(() => {
    if (!showForm) return;
    if (seqPeek.hasSequence && seqPeek.number) {
      setForm((p: any) => (p.adjustmentNumber === seqPeek.number ? p : { ...p, adjustmentNumber: seqPeek.number }));
    }
  }, [showForm, seqPeek.hasSequence, seqPeek.number]);
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
    mutationFn: async (d: any) => {
      const created: any = await inventoryApi.createAdjustment(d);
      if (created?.id && (created.status ?? "draft") === "draft") {
        try {
          return await inventoryApi.postAdjustment(created.id);
        } catch (e: any) {
          throw new Error(`تم الحفظ ولكن فشل الترحيل: ${e?.message || e}`);
        }
      }
      return created;
    },
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
      reset();
      toast({ title: "تم إنشاء التسوية وترحيلها" });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
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
      inventoryAccountId:  form.inventoryAccountId  ? Number(form.inventoryAccountId)  : null,
      adjustmentAccountId: form.adjustmentAccountId ? Number(form.adjustmentAccountId) : null,
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

      {/* ─── Form (designed to match سند القبض pattern) ──────────────────── */}
      {showForm && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          {/* ─── Form header bar ────────────────────────────────────────── */}
          <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b bg-muted/30 flex-wrap">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <SlidersHorizontal className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2 className="font-semibold text-sm sm:text-base text-foreground truncate">تسوية مخزنية جديدة</h2>
                <p className="text-xs text-muted-foreground truncate mt-0.5">إضافة أو خصم كميات الأصناف من المخزن مع ربط محاسبي اختياري</p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border bg-amber-50 text-amber-700 border-amber-200">
                مسودة
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={reset}
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                aria-label="إغلاق"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* ─── Two-column body: form on left, sticky JE preview on right ─ */}
          <div className="p-4 sm:p-5 pb-20">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-5 items-start">
              {/* ── Left column: stacked sections ─────────────────────── */}
              <div className="space-y-4">
                {/* Section 1: Adjustment header info — same layout idiom as سند القبض */}
                <Card className="border-2">
                  <CardHeader className="py-3 px-4 border-b bg-muted/30">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <FileText className="h-4 w-4 text-amber-700" />
                      بيانات التسوية
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4 pb-4 space-y-4">
                    {/* Compact 4-col row for short fields (number + date) */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">رقم التسوية</Label>
                        <Input
                          placeholder={seqPeek.loading ? "…" : "ADJ-001 (تلقائي)"}
                          dir="ltr"
                          className={cn("h-9 text-sm font-mono text-left", seqPeek.hasSequence && "bg-muted/40 cursor-not-allowed")}
                          value={form.adjustmentNumber}
                          onChange={e => { if (!seqPeek.hasSequence) setForm((p: any) => ({ ...p, adjustmentNumber: e.target.value })); }}
                          readOnly={seqPeek.hasSequence}
                          title={seqPeek.hasSequence ? `مسلسل: ${seqPeek.sequenceCode ?? ""}` : undefined}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">
                          التاريخ <span className="text-destructive">*</span>
                        </Label>
                        <Input
                          type="date"
                          className="h-9 text-sm"
                          value={form.adjustmentDate}
                          onChange={e => setForm((p: any) => ({ ...p, adjustmentDate: e.target.value }))}
                        />
                      </div>
                    </div>

                    {/* Warehouse + reason on a 2-col row (comboboxes need width) */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">
                          المخزن <span className="text-destructive">*</span>
                        </Label>
                        <SearchCombobox
                          items={(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr }))}
                          value={form.warehouseId}
                          onValueChange={v => setForm((p: any) => ({ ...p, warehouseId: v }))}
                          placeholder="— اختر مخزن —"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">سبب التسوية</Label>
                        <SearchCombobox
                          items={REASONS.map(r => ({ value: r, label: r }))}
                          value={form.reason}
                          onValueChange={v => setForm((p: any) => ({ ...p, reason: v }))}
                          placeholder="— اختر السبب —"
                        />
                      </div>
                    </div>

                    {/* Notes on its own full-width row */}
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">ملاحظات</Label>
                      <Input
                        className="h-9 text-sm"
                        placeholder="ملاحظات اختيارية"
                        value={form.notes}
                        onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))}
                      />
                    </div>
                  </CardContent>
                </Card>

                {/* Section 2: Accounting accounts (with AI suggest button) */}
                <Card className="border-2 border-blue-100">
                  <CardHeader className="py-3 px-4 border-b bg-blue-50/40">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2 text-blue-900">
                        <Settings2 className="h-4 w-4" />
                        حسابات القيد المحاسبي
                      </CardTitle>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-1.5 h-7 text-[11px] border-purple-300 text-purple-700 hover:bg-purple-50 shrink-0"
                        disabled={!form.warehouseId || aiLoading}
                        onClick={async () => {
                          setAiLoading(true);
                          setAiReasoning("");
                          try {
                            const apiBase = import.meta.env.VITE_API_URL ?? "";
                            const itemsPayload = lines
                              .filter(l => l.itemId)
                              .map(l => {
                                const it: any = (items as any[]).find((x: any) => String(x.id) === String(l.itemId));
                                return { nameAr: it?.nameAr ?? "", qty: Number(l.qty || 0) };
                              });
                            const r = await fetch(`${apiBase}/api/ai/suggest-adjustment-accounts`, {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/json",
                                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                              },
                              body: JSON.stringify({
                                warehouseId: Number(form.warehouseId),
                                reason: form.reason,
                                notes: form.notes,
                                items: itemsPayload,
                              }),
                            });
                            const j = await r.json();
                            if (!r.ok) throw new Error(j?.error || "تعذّر الاقتراح");
                            if (j.inventoryAccountId && j.adjustmentAccountId) {
                              setForm((p: any) => ({
                                ...p,
                                inventoryAccountId:  String(j.inventoryAccountId),
                                adjustmentAccountId: String(j.adjustmentAccountId),
                              }));
                              setAiReasoning(`${j.reasoning || ""}${j.source === "ai" ? " (اقتراح AI)" : " (اقتراح آلي)"}`);
                              toast({ title: "تم اقتراح الحسابات", description: `${j.inventoryAccountLabel} ⇄ ${j.adjustmentAccountLabel}` });
                            } else {
                              throw new Error(j?.reasoning || "لم يتم العثور على حسابات مناسبة");
                            }
                          } catch (e: any) {
                            toast({ title: "تعذّر الاقتراح", description: e?.message || "خطأ غير معروف", variant: "destructive" });
                          } finally {
                            setAiLoading(false);
                          }
                        }}
                      >
                        {aiLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                        اقتراح بالذكاء الاصطناعي
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-4 pb-4 space-y-3">
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      سيتم إنشاء قيد محاسبي متوازن تلقائياً عند الترحيل:
                      <b className="text-blue-700"> زيادة المخزون</b> = مدين حساب المخزون / دائن حساب التسوية،
                      <b className="text-rose-700"> نقص المخزون</b> = مدين حساب التسوية / دائن حساب المخزون.
                    </p>
                    <FormGrid cols={2}>
                      <Field label="حساب المخزون (أصول)">
                        <AccountCombobox value={form.inventoryAccountId} onValueChange={v => setForm((p: any) => ({ ...p, inventoryAccountId: v }))} placeholder="— اختر حساب المخزون —" filterTypes={["asset"]} grouped={false} />
                      </Field>
                      <Field label="حساب التسوية (مصروف / إيراد)">
                        <AccountCombobox value={form.adjustmentAccountId} onValueChange={v => setForm((p: any) => ({ ...p, adjustmentAccountId: v }))} placeholder="— اختر حساب التسوية —" filterTypes={["expense", "revenue", "income"]} grouped={false} />
                      </Field>
                    </FormGrid>
                    {aiReasoning && (
                      <div className="text-xs text-purple-700 bg-purple-50 border border-purple-200 rounded p-2 leading-relaxed">
                        <Sparkles className="h-3 w-3 inline ml-1" />{aiReasoning}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Section 3: Items grid (sales-invoice grid pattern) */}
                <Card className="border-2 border-slate-100">
                  <CardHeader className="py-3 px-4 border-b bg-slate-50/40">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2">
                        <Boxes className="h-4 w-4 text-slate-700" />
                        أصناف التسوية
                        {lines.filter(l => l.itemId).length > 0 && (
                          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-primary/15 text-primary text-[10px] font-bold">
                            {lines.filter(l => l.itemId).length}
                          </span>
                        )}
                      </CardTitle>
                      <Button type="button" size="sm" variant="outline" onClick={addLine} className="gap-1 h-7 text-xs">
                        <Plus className="h-3 w-3" />إضافة صنف
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-3 pb-3 space-y-2">
                    {/* ── Items grid (نمط فواتير المبيعات) ─────────────── */}
                    {(() => {
                      const gridCols = "240px 110px 160px 120px 140px 140px 180px 40px";
                      const headers = ["الصنف", "كود الصنف", "الوحدة", "الكمية (+ / -)", "سعر التكلفة", "الإجمالي", "ملاحظة", ""];
                      const totalLabel = "الإجمالي";
                      return (
                        <div className="rounded-xl border bg-card overflow-x-auto">
                          <div className="min-w-max">
                            {/* Sticky header */}
                            <div
                              className="grid gap-2 px-3 py-2 border-b bg-muted/40 sticky top-0"
                              style={{ gridTemplateColumns: gridCols }}
                            >
                              {headers.map((h, i) => (
                                <p
                                  key={i}
                                  className={cn(
                                    "text-[11px] font-medium truncate",
                                    h === totalLabel ? "font-semibold text-primary" : "text-muted-foreground"
                                  )}
                                  title={h}
                                >
                                  {h}
                                </p>
                              ))}
                            </div>

                            {/* Rows */}
                            <div className="divide-y">
                              {lines.map((line, i) => {
                                const lineUnits = getLineUnits(line);
                                const cf = Number(line.conversionFactor || "1");
                                const baseQtyHint = cf !== 1
                                  ? `×${cf} = ${fmtQty(Number(line.qty || 0) * cf)} وحدة أساسية`
                                  : null;
                                const autoFilled = isAutoFilled(line);
                                const qtyNum = Number(line.qty || 0);
                                const selectedItem: any = (items as any[]).find(
                                  (it: any) => String(it.id) === String(line.itemId)
                                );
                                const itemCode = selectedItem?.code ?? "";
                                const lineTotal = qtyNum * Number(line.costPrice || 0);

                                return (
                                  <div
                                    key={i}
                                    className="px-3 py-2 hover:bg-muted/30 transition-colors"
                                  >
                                    <div
                                      className="grid gap-2 items-center"
                                      style={{ gridTemplateColumns: gridCols }}
                                    >
                                      {/* الصنف */}
                                      <SearchCombobox
                                        items={(items as any[])
                                          .filter((it: any) => it.itemType === "stock")
                                          .map((it: any) => ({
                                            value: String(it.id),
                                            code: it.code,
                                            label: it.nameAr,
                                            labelEn: it.nameEn,
                                          }))}
                                        value={line.itemId}
                                        onValueChange={v => handleItemSelect(i, v)}
                                        placeholder="— اختر صنف —"
                                        className="h-8 text-xs"
                                      />

                                      {/* كود الصنف (تلقائي) */}
                                      <Input
                                        className="h-8 text-xs bg-muted/40 font-mono"
                                        readOnly
                                        placeholder="تلقائي"
                                        value={itemCode}
                                        title={itemCode}
                                      />

                                      {/* الوحدة */}
                                      <div>
                                        <SearchCombobox
                                          items={[
                                            { value: "", label: "وحدة أساسية" },
                                            ...lineUnits.map(u => ({ value: String(u.id), label: u.nameAr })),
                                          ]}
                                          value={line.unitId}
                                          onValueChange={v => handleUnitSelect(i, v)}
                                          placeholder="وحدة أساسية"
                                          className="h-8 text-xs"
                                        />
                                        {baseQtyHint && (
                                          <p className="text-[10px] text-purple-600 mt-0.5 font-medium leading-tight truncate" title={baseQtyHint}>
                                            {baseQtyHint}
                                          </p>
                                        )}
                                      </div>

                                      {/* الكمية (+ زيادة / - نقص) */}
                                      <div>
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
                                          qtyNum > 0 ? "text-green-600" : qtyNum < 0 ? "text-red-600" : "text-muted-foreground"
                                        )}>
                                          {qtyNum > 0 ? "▲ زيادة" : qtyNum < 0 ? "▼ نقص" : "—"}
                                        </p>
                                      </div>

                                      {/* سعر التكلفة */}
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

                                      {/* الإجمالي */}
                                      <Input
                                        className={cn(
                                          "h-8 text-xs font-semibold font-mono text-left",
                                          lineTotal > 0 ? "bg-green-50 text-green-700"
                                            : lineTotal < 0 ? "bg-red-50 text-red-700"
                                            : "bg-primary/5 text-primary"
                                        )}
                                        dir="ltr"
                                        readOnly
                                        value={fmt(lineTotal)}
                                      />

                                      {/* ملاحظة */}
                                      <Input
                                        className="h-8 text-xs"
                                        placeholder="ملاحظة"
                                        value={line.notes}
                                        onChange={e => updateLine(i, "notes", e.target.value)}
                                      />

                                      {/* حذف */}
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 text-destructive"
                                        onClick={() => removeLine(i)}
                                        disabled={lines.length <= 1}
                                        aria-label="حذف الصنف"
                                        title="حذف الصنف"
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </Button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    <p className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
                      <Zap className="h-3 w-3 text-amber-500" />
                      اختيار الصنف يملأ الوحدة والتكلفة تلقائياً — استخدم قيمة موجبة للزيادة وسالبة للنقص
                    </p>
                  </CardContent>
                </Card>
              </div>

              {/* ── Right column: sticky JE preview aside ─────────────── */}
              <aside className="lg:sticky lg:top-4 space-y-4">
                <Card className="border-2 border-blue-200 bg-blue-50/40">
                  <CardHeader className="py-3 px-4 border-b border-blue-200/60">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2 text-blue-900">
                      <FileText className="h-4 w-4" />
                      معاينة القيد المحاسبي
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-3 pb-3">
                    {(() => {
                      const wh: any = (warehouses as any[]).find((w: any) => String(w.id) === form.warehouseId);
                      const invAccId = form.inventoryAccountId ? Number(form.inventoryAccountId) : (wh?.accountId ?? null);
                      const adjAccId = form.adjustmentAccountId ? Number(form.adjustmentAccountId) : null;
                      let netInc = 0, netDec = 0;
                      for (const l of lines) {
                        const amt = Math.abs(Number(l.qty || 0)) * Number(l.costPrice || 0);
                        if (Number(l.qty || 0) > 0) netInc += amt;
                        else if (Number(l.qty || 0) < 0) netDec += amt;
                      }
                      const debit  = Math.max(0, netInc - netDec);
                      const credit = Math.max(0, netDec - netInc);

                      if (debit + credit <= 0) {
                        return (
                          <p className="text-xs text-muted-foreground text-center py-6">
                            أدخل الأصناف والكميات لمعاينة القيد المحاسبي
                          </p>
                        );
                      }
                      if (!invAccId || !adjAccId) {
                        return (
                          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 leading-relaxed">
                            لن يتم إنشاء قيد محاسبي — اختر حساب المخزون وحساب التسوية أو اربط المخزن بحساب افتراضي.
                          </div>
                        );
                      }
                      if (invAccId === adjAccId) {
                        return (
                          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                            الحسابان متطابقان — لن يتم إنشاء قيد.
                          </div>
                        );
                      }
                      const invSrc = form.inventoryAccountId ? "اختيار يدوي" : "حساب المخزن الافتراضي";
                      const isInc  = debit > 0;
                      const amount = isInc ? debit : credit;

                      return (
                        <div className="space-y-2">
                          <div className={cn(
                            "px-2.5 py-1.5 rounded-md text-[11px] font-semibold border",
                            isInc
                              ? "bg-green-50 text-green-800 border-green-200"
                              : "bg-rose-50 text-rose-800 border-rose-200"
                          )}>
                            {isInc ? "صافي زيادة (فائض)" : "صافي نقص (عجز / تالف)"}
                          </div>
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-blue-800/70 border-b border-blue-200/60">
                                <th className="text-start pb-1.5 font-medium">الحساب</th>
                                <th className="text-left pb-1.5 font-medium">مدين</th>
                                <th className="text-left pb-1.5 font-medium">دائن</th>
                              </tr>
                            </thead>
                            <tbody className="font-mono">
                              {isInc ? (
                                <>
                                  <tr className="border-b border-blue-200/40">
                                    <td className="py-1.5 text-start text-[11px] text-blue-900">
                                      حساب المخزون
                                      <span className="block text-[9px] text-muted-foreground font-sans">({invSrc})</span>
                                    </td>
                                    <td className="text-left text-green-700 font-semibold">{fmt(amount)}</td>
                                    <td className="text-left text-muted-foreground">—</td>
                                  </tr>
                                  <tr>
                                    <td className="py-1.5 text-start text-[11px] text-rose-900">
                                      حساب التسوية (إيراد فائض)
                                    </td>
                                    <td className="text-left text-muted-foreground">—</td>
                                    <td className="text-left text-red-700 font-semibold">{fmt(amount)}</td>
                                  </tr>
                                </>
                              ) : (
                                <>
                                  <tr className="border-b border-blue-200/40">
                                    <td className="py-1.5 text-start text-[11px] text-blue-900">
                                      حساب التسوية (مصروف عجز / تالف)
                                    </td>
                                    <td className="text-left text-green-700 font-semibold">{fmt(amount)}</td>
                                    <td className="text-left text-muted-foreground">—</td>
                                  </tr>
                                  <tr>
                                    <td className="py-1.5 text-start text-[11px] text-rose-900">
                                      حساب المخزون
                                      <span className="block text-[9px] text-muted-foreground font-sans">({invSrc})</span>
                                    </td>
                                    <td className="text-left text-muted-foreground">—</td>
                                    <td className="text-left text-red-700 font-semibold">{fmt(amount)}</td>
                                  </tr>
                                </>
                              )}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()}
                  </CardContent>
                </Card>

                <div className="text-[11px] text-blue-900/80 leading-relaxed bg-blue-50/40 border border-blue-200 rounded-lg p-3">
                  <div className="flex items-start gap-2">
                    <Settings2 className="h-4 w-4 mt-0.5 text-blue-700 shrink-0" />
                    <div className="space-y-1">
                      <p className="font-semibold">روابط الحسابات العامة</p>
                      <p>حسابات المخزن والتسوية الافتراضية تُدار من شاشة «ربط القيود المحاسبية» — قسم «التسويات المخزنية».</p>
                    </div>
                  </div>
                </div>

                <div className="text-[11px] text-muted-foreground leading-relaxed bg-muted/20 border rounded-lg p-3">
                  <p className="font-semibold mb-1">إرشادات سريعة</p>
                  <ul className="space-y-0.5 list-disc list-inside">
                    <li>الكمية الموجبة (+) لزيادة المخزون</li>
                    <li>الكمية السالبة (−) لنقص المخزون</li>
                    <li>اختيار الصنف يملأ الوحدة والتكلفة تلقائياً</li>
                  </ul>
                </div>
              </aside>
            </div>
          </div>

          {/* ─── Sticky bottom action bar ──────────────────────────── */}
          <div className="sticky bottom-0 inset-x-0 bg-background/95 backdrop-blur border-t z-30">
            <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
              <Button variant="ghost" onClick={reset} disabled={createMut.isPending}>
                إلغاء
              </Button>
              <Button
                type="button"
                size="sm"
                className="gap-2 min-w-[140px]"
                onClick={() => handleSubmit({ preventDefault() {} } as any)}
                disabled={createMut.isPending || !form.warehouseId || !form.adjustmentDate}
              >
                {createMut.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    جارٍ الحفظ...
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    حفظ التسوية
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
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
