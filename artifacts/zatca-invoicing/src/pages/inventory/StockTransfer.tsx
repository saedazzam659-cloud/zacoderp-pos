import { useState, useEffect, Fragment } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import {
  Plus, Trash2, ArrowRightLeft, Search, X,
  CheckCircle2, Send, ChevronDown, ChevronUp, Zap, Sparkles, Loader2,
} from "lucide-react";
import { FormPanel, Field, FormGrid, FormSection } from "@/components/FormPanel";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { AccountCombobox } from "@/components/AccountCombobox";
import { useFmt } from "@/hooks/use-fmt";

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
  fromAccountId: "",
  toAccountId: "",
  notes: "",
};
const newLine = () => ({ itemId: "", unitId: "", qty: "1", costPrice: "0", conversionFactor: "1" });

export default function StockTransfer() {
  const { fmt, fmtQty } = useFmt();
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [aiLoading, setAiLoading] = useState(false);
  const [aiReasoning, setAiReasoning] = useState<string>("");

  const [search, setSearch] = useState("");
  const [form, setForm] = useState<any>(EMPTY_FORM);
  const [lines, setLines] = useState<any[]>([newLine()]);
  const [showForm, setShowForm] = useState(false);

  const seqPeek = useNextSequenceNumber("stock_transfer", showForm);
  useEffect(() => {
    if (!showForm) return;
    if (seqPeek.hasSequence && seqPeek.number) {
      setForm((p: any) => (p.transferNumber === seqPeek.number ? p : { ...p, transferNumber: seqPeek.number }));
    }
  }, [showForm, seqPeek.hasSequence, seqPeek.number]);
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
    mutationFn: async (d: any) => {
      const created: any = await inventoryApi.createTransfer(d);
      if (created?.id && (created.status ?? "draft") === "draft") {
        try {
          return await inventoryApi.postTransfer(created.id);
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
      toast({ title: "تم إنشاء أمر التحويل وترحيله" });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
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
      toWarehouseId:   Number(form.toWarehouseId),
      fromAccountId:   form.fromAccountId ? Number(form.fromAccountId) : null,
      toAccountId:     form.toAccountId   ? Number(form.toAccountId)   : null,
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
        <FormPanel
          icon={ArrowRightLeft}
          title="أمر تحويل جديد"
          subtitle="نقل أصناف بين مخزنين مع تحديد الكميات وأسعار التكلفة"
          width="6xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending}
          saveDisabled={!form.fromWarehouseId || !form.toWarehouseId || !form.transferDate}
          saveLabel="حفظ كمسودة"
        >
          <Tabs defaultValue="info" className="w-full">
            <TabsList className="w-full grid grid-cols-2 mb-4">
              <TabsTrigger value="info">معلومات الحركة والقيد المحاسبي</TabsTrigger>
              <TabsTrigger value="items">
                الأصناف
                {lines.filter(l => l.itemId).length > 0 && (
                  <span className="mr-2 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary/15 text-primary text-[10px] font-bold">
                    {lines.filter(l => l.itemId).length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="info" className="space-y-5 mt-0">
            <FormSection title="معلومات الحركة">
              <FormGrid cols={2}>
                <Field label="رقم الحركة"><Input
                  placeholder={seqPeek.loading ? "…" : "TRF-001 (تلقائي)"}
                  dir="ltr"
                  className={cn("text-left", seqPeek.hasSequence && "bg-muted/40 cursor-not-allowed")}
                  value={form.transferNumber}
                  onChange={e => { if (!seqPeek.hasSequence) setForm((p: any) => ({ ...p, transferNumber: e.target.value })); }}
                  readOnly={seqPeek.hasSequence}
                  title={seqPeek.hasSequence ? `مسلسل: ${seqPeek.sequenceCode ?? ""}` : undefined}
                /></Field>
                <Field label="التاريخ" required><Input type="date" value={form.transferDate} onChange={e => setForm((p: any) => ({ ...p, transferDate: e.target.value }))} /></Field>
                <Field label="من مخزن" required>
                  <SearchCombobox items={(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr }))} value={form.fromWarehouseId} onValueChange={v => setForm((p: any) => ({ ...p, fromWarehouseId: v }))} placeholder="— اختر مخزن المصدر —" />
                </Field>
                <Field label="إلى مخزن" required>
                  <SearchCombobox items={(warehouses as any[]).filter((w: any) => String(w.id) !== form.fromWarehouseId).map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr }))} value={form.toWarehouseId} onValueChange={v => setForm((p: any) => ({ ...p, toWarehouseId: v }))} placeholder="— اختر مخزن الوجهة —" />
                </Field>
                <Field label="ملاحظات" className="md:col-span-2"><Input placeholder="ملاحظات اختيارية" value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} /></Field>
              </FormGrid>
            </FormSection>

            <FormSection title="القيد المحاسبي التلقائي">
              <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-4 space-y-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    سيتم إنشاء قيد محاسبي متوازن تلقائياً عند الترحيل: <b className="text-blue-700">مدين</b> = حساب مخزن الوجهة، <b className="text-rose-700">دائن</b> = حساب مخزن المصدر.
                    اختر الحسابات يدوياً أو دع الذكاء الاصطناعي يقترحها بناءً على الأصناف والمخازن.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-1.5 h-8 text-xs border-purple-300 text-purple-700 hover:bg-purple-50 shrink-0"
                    disabled={!form.fromWarehouseId || !form.toWarehouseId || aiLoading}
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
                        const r = await fetch(`${apiBase}/api/ai/suggest-transfer-accounts`, {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            ...(token ? { Authorization: `Bearer ${token}` } : {}),
                          },
                          body: JSON.stringify({
                            fromWarehouseId: Number(form.fromWarehouseId),
                            toWarehouseId:   Number(form.toWarehouseId),
                            items: itemsPayload,
                            notes: form.notes,
                          }),
                        });
                        const j = await r.json();
                        if (!r.ok) throw new Error(j?.error || "تعذّر الاقتراح");
                        if (j.fromAccountId && j.toAccountId) {
                          setForm((p: any) => ({
                            ...p,
                            fromAccountId: String(j.fromAccountId),
                            toAccountId:   String(j.toAccountId),
                          }));
                          setAiReasoning(`${j.reasoning || ""}${j.source === "ai" ? " (اقتراح AI)" : " (اقتراح آلي)"}`);
                          toast({ title: "تم اقتراح الحسابات", description: `${j.fromAccountLabel} ⇄ ${j.toAccountLabel}` });
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
                    {aiLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    اقتراح بالذكاء الاصطناعي
                  </Button>
                </div>

                <FormGrid cols={2}>
                  <Field label="حساب مخزن المصدر (دائن)">
                    <AccountCombobox value={form.fromAccountId} onValueChange={v => setForm((p: any) => ({ ...p, fromAccountId: v }))} placeholder="— اختر الحساب —" filterTypes={["asset"]} grouped={false} />
                  </Field>
                  <Field label="حساب مخزن الوجهة (مدين)">
                    <AccountCombobox value={form.toAccountId} onValueChange={v => setForm((p: any) => ({ ...p, toAccountId: v }))} placeholder="— اختر الحساب —" filterTypes={["asset"]} grouped={false} />
                  </Field>
                </FormGrid>

                {aiReasoning && (
                  <div className="text-xs text-purple-700 bg-purple-50 border border-purple-200 rounded p-2 leading-relaxed">
                    <Sparkles className="h-3 w-3 inline ml-1" />{aiReasoning}
                  </div>
                )}

                {/* JE preview — reflects backend behavior: transfer-level overrides take priority,
                    otherwise warehouse.accountId is used as fallback. */}
                {(() => {
                  const total = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.costPrice || 0), 0);
                  if (total <= 0) return null;
                  const fromWh: any = (warehouses as any[]).find((w: any) => String(w.id) === form.fromWarehouseId);
                  const toWh:   any = (warehouses as any[]).find((w: any) => String(w.id) === form.toWarehouseId);
                  const fromAcc = form.fromAccountId ? Number(form.fromAccountId) : (fromWh?.accountId ?? null);
                  const toAcc   = form.toAccountId   ? Number(form.toAccountId)   : (toWh?.accountId   ?? null);
                  const fromSrc = form.fromAccountId ? "اختيار يدوي" : (fromWh?.accountId ? "حساب المخزن الافتراضي" : null);
                  const toSrc   = form.toAccountId   ? "اختيار يدوي" : (toWh?.accountId   ? "حساب المخزن الافتراضي" : null);
                  if (!fromAcc || !toAcc) {
                    return (
                      <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                        لن يتم إنشاء قيد محاسبي — اختر الحسابين أو اربط المخازن بحسابات افتراضية (سيتم تحديث المخزون فقط).
                      </div>
                    );
                  }
                  if (fromAcc === toAcc) {
                    return (
                      <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                        الحسابان متطابقان — لن يتم إنشاء قيد (لا أثر محاسبي، يتم تحديث المخزون فقط).
                      </div>
                    );
                  }
                  return (
                    <div className="rounded-md border border-blue-200 bg-white overflow-hidden">
                      <div className="px-3 py-1.5 bg-blue-100/50 text-[11px] font-semibold text-blue-900">معاينة القيد المحاسبي</div>
                      <table className="w-full text-xs">
                        <thead className="bg-muted/30 border-b">
                          <tr><th className="px-2 py-1 text-right font-medium">الحساب</th><th className="px-2 py-1 text-left font-medium w-28">مدين</th><th className="px-2 py-1 text-left font-medium w-28">دائن</th></tr>
                        </thead>
                        <tbody className="divide-y">
                          <tr>
                            <td className="px-2 py-1.5 text-blue-700">حساب مخزن الوجهة {toSrc && <span className="text-[10px] text-muted-foreground">({toSrc})</span>}</td>
                            <td className="px-2 py-1.5 text-left tabular-nums font-medium">{fmt(total)}</td>
                            <td className="px-2 py-1.5 text-left tabular-nums">—</td>
                          </tr>
                          <tr>
                            <td className="px-2 py-1.5 text-rose-700">حساب مخزن المصدر {fromSrc && <span className="text-[10px] text-muted-foreground">({fromSrc})</span>}</td>
                            <td className="px-2 py-1.5 text-left tabular-nums">—</td>
                            <td className="px-2 py-1.5 text-left tabular-nums font-medium">{fmt(total)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </div>
            </FormSection>
            </TabsContent>

            <TabsContent value="items" className="space-y-3 mt-0">
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
                          سعر التكلفة <Zap className="h-3 w-3 text-amber-500"><title>يُملأ تلقائياً</title></Zap>
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
                      const baseQtyHint = cf !== 1 ? `×${cf} = ${fmtQty(Number(line.qty || 0) * cf)} وحدة أساسية` : null;
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
                              dir="ltr"
                              className="h-8 text-xs text-left"
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

                          {/* Total */}
                          <td className="px-3 py-2 tabular-nums text-xs text-muted-foreground">
                            {fmt(Number(line.qty) * Number(line.costPrice))}
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
                        {fmt(lines.reduce((s, l) => s + Number(l.qty) * Number(l.costPrice), 0))} ر.س
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
            </TabsContent>
          </Tabs>
        </FormPanel>
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
                                        <td className="py-1.5 tabular-nums">{fmtQty(l.qty)}</td>
                                        <td className="py-1.5 tabular-nums">{fmt(l.costPrice)}</td>
                                        <td className="py-1.5 tabular-nums font-medium">
                                          {fmt(Number(l.qty) * Number(l.costPrice))}
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
