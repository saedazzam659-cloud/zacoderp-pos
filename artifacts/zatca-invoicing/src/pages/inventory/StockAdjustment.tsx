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
  Plus, Trash2, SlidersHorizontal, Search, X, Send,
  ChevronDown, ChevronUp, Zap, Sparkles, Loader2,
} from "lucide-react";
import { FormPanel, Field, FormGrid, FormSection } from "@/components/FormPanel";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  rowToneFor, DocColorLegend, buildToneTooltip, type LegendItem,
} from "@/lib/docRowTone";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { AccountCombobox } from "@/components/AccountCombobox";
import { useFmt } from "@/hooks/use-fmt";
import { useTranslation } from "react-i18next";

const STATUS_CONFIG: Record<string, { color: string }> = {
  draft:  { color: "bg-amber-50 text-amber-700" },
  posted: { color: "bg-green-50 text-green-700" },
};
const REASONS = ["تعديل كمي", "تلف وخسارة", "فاقد وكسر", "إدخال أول مرة", "مكافآت وهبات", "أخرى"];
const REASON_KEYS: Record<string, string> = {
  "تعديل كمي": "reasonQuantityAdjustment",
  "تلف وخسارة": "reasonDamageLoss",
  "فاقد وكسر": "reasonShortageBreakage",
  "إدخال أول مرة": "reasonInitialEntry",
  "مكافآت وهبات": "reasonRewardsGifts",
  "أخرى": "reasonOther",
};

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
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => (isRtl ? (ar ?? en) : (en ?? ar)) ?? "";
  const reasonLabel = (r: string) =>
    REASON_KEYS[r] ? t(`stockAdjustmentPage.${REASON_KEYS[r]}`) : r;
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
          throw new Error(t("stockAdjustmentPage.savedButPostFailed", { error: e?.message || e }));
        }
      }
      return created;
    },
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
      reset();
      toast({ title: t("stockAdjustmentPage.toastCreated") });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });
  const postMut = useMutation({
    mutationFn: inventoryApi.postAdjustment,
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
      toast({ title: t("stockAdjustmentPage.toastPosted") });
    },
  });
  const deleteMut = useMutation({
    mutationFn: inventoryApi.deleteAdjustment,
    onSuccess: () => { invalidate(); toast({ title: t("stockAdjustmentPage.toastDeleted") }); },
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
      toast({ title: t("stockAdjustmentPage.mustSelectWarehouse"), variant: "destructive" });
      return;
    }
    const validLines = lines.filter(l => l.itemId);
    if (!validLines.length) {
      toast({ title: t("stockAdjustmentPage.addAtLeastOneItem"), variant: "destructive" });
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
        nameAr: pickName(u.unit?.nameAr, u.unit?.nameEn) || "—",
        code: u.unit?.code,
      }));
    }
    return (units as any[]).map((u: any) => ({ id: u.id, nameAr: pickName(u.nameAr, u.nameEn), code: u.code }));
  }

  function isAutoFilled(line: any): boolean {
    const cached = itemUnitsMap[line.itemId] ?? [];
    return !!line.unitId && cached.some((u: any) => String(u.unitId) === line.unitId);
  }

  const filtered = (adjustments as any[]).filter(
    (a: any) => a.adjustmentNumber.includes(search) || (a.warehouse?.nameAr ?? "").includes(search) || (a.warehouse?.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <SlidersHorizontal className="h-6 w-6 text-primary" />
            {t("stockAdjustmentPage.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t("stockAdjustmentPage.subtitle")}
          </p>
        </div>
        <Button
          size="sm"
          className="gap-2"
          onClick={() => { reset(); setShowForm(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}
        >
          <Plus className="h-4 w-4" />{t("stockAdjustmentPage.newAdjustment")}
        </Button>
      </div>

      {/* Form */}
      {showForm && (
        <FormPanel
          icon={SlidersHorizontal}
          title={t("stockAdjustmentPage.formTitle")}
          subtitle={t("stockAdjustmentPage.formSubtitle")}
          width="6xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending}
          saveDisabled={!form.warehouseId || !form.adjustmentDate}
          saveLabel={t("stockAdjustmentPage.saveAdjustment")}
        >
          <Tabs defaultValue="info" className="w-full">
            <TabsList className="w-full grid grid-cols-2 mb-4">
              <TabsTrigger value="info">{t("stockAdjustmentPage.tabInfo")}</TabsTrigger>
              <TabsTrigger value="items">
                {t("stockAdjustmentPage.items")}
                {lines.filter(l => l.itemId).length > 0 && (
                  <span className="mr-2 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary/15 text-primary text-[10px] font-bold">
                    {lines.filter(l => l.itemId).length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="info" className="space-y-5 mt-0">
            <FormSection title={t("stockAdjustmentPage.sectionMovement")}>
              <FormGrid cols={2}>
                <Field label={t("stockAdjustmentPage.adjustmentNumber")}><Input
                  placeholder={seqPeek.loading ? "…" : t("stockAdjustmentPage.adjustmentNumberPlaceholder")}
                  dir="ltr"
                  className={cn("text-left", seqPeek.hasSequence && "bg-muted/40 cursor-not-allowed")}
                  value={form.adjustmentNumber}
                  onChange={e => { if (!seqPeek.hasSequence) setForm((p: any) => ({ ...p, adjustmentNumber: e.target.value })); }}
                  readOnly={seqPeek.hasSequence}
                  title={seqPeek.hasSequence ? t("stockAdjustmentPage.sequenceTooltip", { code: seqPeek.sequenceCode ?? "" }) : undefined}
                /></Field>
                <Field label={t("stockAdjustmentPage.date")} required><Input type="date" value={form.adjustmentDate} onChange={e => setForm((p: any) => ({ ...p, adjustmentDate: e.target.value }))} /></Field>
                <Field label={t("stockAdjustmentPage.warehouse")} required>
                  <SearchCombobox items={(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: pickName(w.nameAr, w.nameEn) }))} value={form.warehouseId} onValueChange={v => setForm((p: any) => ({ ...p, warehouseId: v }))} placeholder={t("stockAdjustmentPage.selectWarehouse")} />
                </Field>
                <Field label={t("stockAdjustmentPage.adjustmentReason")}>
                  <SearchCombobox items={REASONS.map(r => ({ value: r, label: reasonLabel(r) }))} value={form.reason} onValueChange={v => setForm((p: any) => ({ ...p, reason: v }))} placeholder={t("stockAdjustmentPage.selectReason")} />
                </Field>
                <Field label={t("stockAdjustmentPage.notes")} className="md:col-span-2"><Input placeholder={t("stockAdjustmentPage.notesPlaceholder")} value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} /></Field>
              </FormGrid>
            </FormSection>

            <FormSection title={t("stockAdjustmentPage.sectionJournal")}>
              <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-4 space-y-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t("stockAdjustmentPage.jeHintIntro")}
                    <b className="text-blue-700">{t("stockAdjustmentPage.jeHintIncrease")}</b>{t("stockAdjustmentPage.jeHintIncreaseRule")}
                    <b className="text-rose-700">{t("stockAdjustmentPage.jeHintDecrease")}</b>{t("stockAdjustmentPage.jeHintDecreaseRule")}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-1.5 h-8 text-xs border-purple-300 text-purple-700 hover:bg-purple-50 shrink-0"
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
                        if (!r.ok) throw new Error(j?.error || t("stockAdjustmentPage.suggestFailed"));
                        if (j.inventoryAccountId && j.adjustmentAccountId) {
                          setForm((p: any) => ({
                            ...p,
                            inventoryAccountId:  String(j.inventoryAccountId),
                            adjustmentAccountId: String(j.adjustmentAccountId),
                          }));
                          setAiReasoning(`${j.reasoning || ""}${j.source === "ai" ? t("stockAdjustmentPage.aiSuffix") : t("stockAdjustmentPage.autoSuffix")}`);
                          toast({ title: t("stockAdjustmentPage.accountsSuggested"), description: `${j.inventoryAccountLabel} ⇄ ${j.adjustmentAccountLabel}` });
                        } else {
                          throw new Error(j?.reasoning || t("stockAdjustmentPage.noSuitableAccounts"));
                        }
                      } catch (e: any) {
                        toast({ title: t("stockAdjustmentPage.suggestFailed"), description: e?.message || t("stockAdjustmentPage.unknownError"), variant: "destructive" });
                      } finally {
                        setAiLoading(false);
                      }
                    }}
                  >
                    {aiLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    {t("stockAdjustmentPage.aiSuggest")}
                  </Button>
                </div>

                <FormGrid cols={2}>
                  <Field label={t("stockAdjustmentPage.inventoryAccount")}>
                    <AccountCombobox value={form.inventoryAccountId} onValueChange={v => setForm((p: any) => ({ ...p, inventoryAccountId: v }))} placeholder={t("stockAdjustmentPage.selectInventoryAccount")} filterTypes={["asset"]} grouped={false} />
                  </Field>
                  <Field label={t("stockAdjustmentPage.adjustmentAccount")}>
                    <AccountCombobox value={form.adjustmentAccountId} onValueChange={v => setForm((p: any) => ({ ...p, adjustmentAccountId: v }))} placeholder={t("stockAdjustmentPage.selectAdjustmentAccount")} filterTypes={["expense", "revenue", "income"]} grouped={false} />
                  </Field>
                </FormGrid>

                {aiReasoning && (
                  <div className="text-xs text-purple-700 bg-purple-50 border border-purple-200 rounded p-2 leading-relaxed">
                    <Sparkles className="h-3 w-3 inline ml-1" />{aiReasoning}
                  </div>
                )}

                {/* JE preview — mirrors backend net-direction logic */}
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
                  const debit = Math.max(0, netInc - netDec);
                  const credit = Math.max(0, netDec - netInc);
                  if (debit + credit <= 0) return null;
                  if (!invAccId || !adjAccId) {
                    return (
                      <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                        {t("stockAdjustmentPage.noJeWarning")}
                      </div>
                    );
                  }
                  if (invAccId === adjAccId) {
                    return (
                      <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                        {t("stockAdjustmentPage.sameAccountsWarning")}
                      </div>
                    );
                  }
                  const invSrc = form.inventoryAccountId ? t("stockAdjustmentPage.manualSelection") : t("stockAdjustmentPage.defaultWarehouseAccount");
                  const isInc = debit > 0;
                  const amount = isInc ? debit : credit;
                  return (
                    <div className="rounded-md border border-blue-200 bg-white overflow-hidden">
                      <div className="px-3 py-1.5 bg-blue-100/50 text-[11px] font-semibold text-blue-900">
                        {t("stockAdjustmentPage.jePreviewPrefix")}{isInc ? t("stockAdjustmentPage.netIncrease") : t("stockAdjustmentPage.netDecrease")}
                      </div>
                      <table className="w-full text-xs">
                        <thead className="bg-muted/30 border-b">
                          <tr><th className="px-2 py-1 text-right font-medium">{t("stockAdjustmentPage.colAccount")}</th><th className="px-2 py-1 text-left font-medium w-28">{t("stockAdjustmentPage.colDebit")}</th><th className="px-2 py-1 text-left font-medium w-28">{t("stockAdjustmentPage.colCredit")}</th></tr>
                        </thead>
                        <tbody className="divide-y">
                          {isInc ? (
                            <>
                              <tr>
                                <td className="px-2 py-1.5 text-blue-700">{t("stockAdjustmentPage.inventoryAccountShort")} <span className="text-[10px] text-muted-foreground">({invSrc})</span></td>
                                <td className="px-2 py-1.5 text-left tabular-nums font-medium">{fmt(amount)}</td>
                                <td className="px-2 py-1.5 text-left tabular-nums">—</td>
                              </tr>
                              <tr>
                                <td className="px-2 py-1.5 text-rose-700">{t("stockAdjustmentPage.adjustmentAccountSurplus")}</td>
                                <td className="px-2 py-1.5 text-left tabular-nums">—</td>
                                <td className="px-2 py-1.5 text-left tabular-nums font-medium">{fmt(amount)}</td>
                              </tr>
                            </>
                          ) : (
                            <>
                              <tr>
                                <td className="px-2 py-1.5 text-blue-700">{t("stockAdjustmentPage.adjustmentAccountShortage")}</td>
                                <td className="px-2 py-1.5 text-left tabular-nums font-medium">{fmt(amount)}</td>
                                <td className="px-2 py-1.5 text-left tabular-nums">—</td>
                              </tr>
                              <tr>
                                <td className="px-2 py-1.5 text-rose-700">{t("stockAdjustmentPage.inventoryAccountShort")} <span className="text-[10px] text-muted-foreground">({invSrc})</span></td>
                                <td className="px-2 py-1.5 text-left tabular-nums">—</td>
                                <td className="px-2 py-1.5 text-left tabular-nums font-medium">{fmt(amount)}</td>
                              </tr>
                            </>
                          )}
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
                <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">{t("stockAdjustmentPage.items")}</h3>
                <Button type="button" size="sm" variant="outline" onClick={addLine} className="gap-1 h-7 text-xs">
                  <Plus className="h-3 w-3" />{t("stockAdjustmentPage.addItem")}
                </Button>
              </div>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 border-b">
                    <tr>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">{t("stockAdjustmentPage.colItem")}</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground w-36">{t("stockAdjustmentPage.colUnit")}</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground w-28">{t("stockAdjustmentPage.colQty")}</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground w-36">
                        <span className="flex items-center gap-1">
                          {t("stockAdjustmentPage.colCostPrice")} <Zap className="h-3 w-3 text-amber-500"><title>{t("stockAdjustmentPage.autoFillTooltip")}</title></Zap>
                        </span>
                      </th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">{t("stockAdjustmentPage.note")}</th>
                      <th className="px-3 py-2 w-10" />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {lines.map((line, i) => {
                      const lineUnits = getLineUnits(line);
                      const cf = Number(line.conversionFactor || "1");
                      const baseQtyHint = cf !== 1 ? t("stockAdjustmentPage.baseQtyHint", { factor: cf, qty: fmtQty(Number(line.qty || 0) * cf) }) : null;
                      const autoFilled = isAutoFilled(line);
                      const qtyNum = Number(line.qty || 0);

                      return (
                        <tr key={i}>
                          {/* Item */}
                          <td className="px-3 py-2 min-w-[180px]">
                            <SearchCombobox
                              items={(items as any[]).filter((it: any) => it.itemType === "stock").map((it: any) => ({ value: String(it.id), code: it.code, label: pickName(it.nameAr, it.nameEn), labelEn: it.nameEn }))}
                              value={line.itemId}
                              onValueChange={v => handleItemSelect(i, v)}
                              placeholder={t("stockAdjustmentPage.selectItem")}
                              className="h-8 text-xs"
                            />
                          </td>

                          {/* Unit */}
                          <td className="px-3 py-2 min-w-[120px]">
                            <SearchCombobox
                              items={[{ value: "", label: t("stockAdjustmentPage.baseUnit") }, ...lineUnits.map(u => ({ value: String(u.id), label: u.nameAr }))]}
                              value={line.unitId}
                              onValueChange={v => handleUnitSelect(i, v)}
                              placeholder={t("stockAdjustmentPage.baseUnit")}
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
                              placeholder={t("stockAdjustmentPage.qtyPlaceholder")}
                            />
                            <p className={cn(
                              "text-[10px] mt-0.5 leading-tight",
                              qtyNum >= 0 ? "text-green-600" : "text-red-600"
                            )}>
                              {qtyNum >= 0 ? t("stockAdjustmentPage.increase") : t("stockAdjustmentPage.decrease")}
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
                                  {t("stockAdjustmentPage.autoBadge")}
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Notes */}
                          <td className="px-3 py-2">
                            <Input
                              className="h-8 text-xs"
                              placeholder={t("stockAdjustmentPage.note")}
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
                {t("stockAdjustmentPage.autoFillHint")}
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
          placeholder={t("stockAdjustmentPage.searchPlaceholder")}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* List */}
      {(() => {
        const items: LegendItem[] = [
          { kind: "draft",     count: filtered.filter((x: any) => x.status === "draft").length },
          { kind: "posted",    count: filtered.filter((x: any) => x.status === "posted").length },
          { kind: "cancelled", count: filtered.filter((x: any) => x.status === "cancelled").length },
        ];
        return <DocColorLegend items={items} />;
      })()}

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-8" />
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{t("stockAdjustmentPage.colAdjustmentNumber")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{t("stockAdjustmentPage.date")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">{t("stockAdjustmentPage.warehouse")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">{t("stockAdjustmentPage.colReason")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{t("stockAdjustmentPage.colStatus")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-32">{t("stockAdjustmentPage.colActions")}</th>
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
                    <SlidersHorizontal className="h-8 w-8 mx-auto mb-2 opacity-30" />{t("stockAdjustmentPage.noAdjustments")}
                  </td>
                </tr>
              )
              : filtered.map((adj: any) => {
                  const st = STATUS_CONFIG[adj.status] ?? STATUS_CONFIG.draft;
                  return (
                    <Fragment key={adj.id}>
                      <tr data-status={adj.status}
                          className={cn("transition-colors", rowToneFor({ status: adj.status }))}
                          title={buildToneTooltip({ status: adj.status })}>
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
                        <td className="px-4 py-3 hidden sm:table-cell">{pickName(adj.warehouse?.nameAr, adj.warehouse?.nameEn) || "—"}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-muted-foreground text-xs">{adj.reason ? reasonLabel(adj.reason) : "—"}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn("text-[10px] font-medium rounded-full px-2.5 py-1", st.color)}>
                            {t(`stockAdjustmentPage.${adj.status === "posted" ? "statusPosted" : "statusDraft"}`)}
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
                                  onClick={() => { if (confirm(t("stockAdjustmentPage.confirmPost"))) postMut.mutate(adj.id); }}
                                >
                                  <Send className="h-3 w-3" />{t("stockAdjustmentPage.post")}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive"
                                  onClick={() => { if (confirm(t("stockAdjustmentPage.confirmDelete"))) deleteMut.mutate(adj.id); }}
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
                              ? <p className="text-xs text-muted-foreground">{t("stockAdjustmentPage.noItems")}</p>
                              : (
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-muted-foreground border-b">
                                      <th className="text-right pb-2 pr-0">{t("stockAdjustmentPage.colItem")}</th>
                                      <th className="text-right pb-2">{t("stockAdjustmentPage.colUnit")}</th>
                                      <th className="text-right pb-2">{t("stockAdjustmentPage.colQtyShort")}</th>
                                      <th className="text-right pb-2">{t("stockAdjustmentPage.colCost")}</th>
                                      <th className="text-right pb-2">{t("stockAdjustmentPage.note")}</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-border/50">
                                    {adjDetail.items.map((l: any) => (
                                      <tr key={l.id}>
                                        <td className="py-1.5 pr-0">{pickName(l.item?.nameAr, l.item?.nameEn) || l.itemId}</td>
                                        <td className="py-1.5">{pickName(l.unit?.nameAr, l.unit?.nameEn) || t("stockAdjustmentPage.baseUnit")}</td>
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
            {t("stockAdjustmentPage.countLabel", { count: filtered.length })}
          </div>
        )}
      </div>
    </div>
  );
}
