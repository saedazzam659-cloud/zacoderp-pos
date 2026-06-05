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
  Plus, Trash2, ArrowRightLeft, Search, X,
  CheckCircle2, Send, ChevronDown, ChevronUp, Zap, Sparkles, Loader2,
  FileText, Save, Settings2, Boxes, Calculator,
} from "lucide-react";
import { Field, FormGrid } from "@/components/FormPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  rowToneFor, DocColorLegend, buildToneTooltip, type LegendItem,
} from "@/lib/docRowTone";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { AccountCombobox } from "@/components/AccountCombobox";
import { useFmt } from "@/hooks/use-fmt";
import { useTranslation } from "react-i18next";

const STATUS_CONFIG: Record<string, { color: string }> = {
  draft:     { color: "bg-amber-50 text-amber-700" },
  posted:    { color: "bg-green-50 text-green-700" },
  cancelled: { color: "bg-red-50 text-red-600" },
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
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => (isRtl ? (ar ?? en) : (en ?? ar)) ?? "";
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
          throw new Error(t("stockTransferPage.savedButPostFailed", { error: e?.message || e }));
        }
      }
      return created;
    },
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
      reset();
      toast({ title: t("stockTransferPage.toastCreated") });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });
  const postMut = useMutation({
    mutationFn: (id: number) => inventoryApi.postTransfer(id),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
      toast({ title: t("stockTransferPage.toastPosted") });
    },
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => inventoryApi.deleteTransfer(id),
    onSuccess: () => { invalidate(); toast({ title: t("stockTransferPage.toastDeleted") }); },
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
      toast({ title: t("stockTransferPage.errSelectWarehouses"), variant: "destructive" });
      return;
    }
    const validLines = lines.filter(l => l.itemId && Number(l.qty) > 0);
    if (!validLines.length) {
      toast({ title: t("stockTransferPage.errAddItem"), variant: "destructive" });
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
  function getLineUnits(line: any): { id: number; nameAr?: string | null; nameEn?: string | null; code?: string }[] {
    const cached = itemUnitsMap[line.itemId];
    if (cached && cached.length > 0) {
      return cached.map((u: any) => ({
        id: u.unitId,
        nameAr: u.unit?.nameAr ?? null,
        nameEn: u.unit?.nameEn ?? null,
        code: u.unit?.code,
      }));
    }
    return (units as any[]).map((u: any) => ({ id: u.id, nameAr: u.nameAr, nameEn: u.nameEn, code: u.code }));
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
      (t.fromWarehouse?.nameEn ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (t.toWarehouse?.nameAr ?? "").includes(search) ||
      (t.toWarehouse?.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ArrowRightLeft className="h-6 w-6 text-primary" />
            {t("stockTransferPage.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t("stockTransferPage.subtitle")}
          </p>
        </div>
        <Button
          size="sm"
          className="gap-2"
          onClick={() => { reset(); setShowForm(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}
        >
          <Plus className="h-4 w-4" />{t("stockTransferPage.newTransfer")}
        </Button>
      </div>

      {/* ─── Form (designed to match سند القبض pattern) ──────────────────── */}
      {showForm && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          {/* ─── Form header bar ────────────────────────────────────────── */}
          <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b bg-muted/30 flex-wrap">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ArrowRightLeft className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2 className="font-semibold text-sm sm:text-base text-foreground truncate">{t("stockTransferPage.formTitle")}</h2>
                <p className="text-xs text-muted-foreground truncate mt-0.5">{t("stockTransferPage.formSubtitle")}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border bg-amber-50 text-amber-700 border-amber-200">
                {t("stockTransferPage.status.draft")}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={reset}
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                aria-label={t("stockTransferPage.close")}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* ─── Two-column body: form on left, sticky JE preview on right ─ */}
          <div className="p-4 sm:p-5">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-5 items-start">
              {/* ── Left column: stacked sections ─────────────────────── */}
              <div className="space-y-4">
                {/* Section 1: Transfer header info */}
                <Card className="border-2">
                  <CardHeader className="py-3 px-4 border-b bg-muted/30">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <FileText className="h-4 w-4 text-amber-700" />
                      {t("stockTransferPage.transferDataTitle")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4 pb-4">
                    <FormGrid cols={2}>
                      <Field label={t("stockTransferPage.transferNumber")}>
                        <Input
                          placeholder={seqPeek.loading ? "…" : t("stockTransferPage.transferNumberPlaceholder")}
                          dir="ltr"
                          className={cn("text-left h-9 text-sm", seqPeek.hasSequence && "bg-muted/40 cursor-not-allowed")}
                          value={form.transferNumber}
                          onChange={e => { if (!seqPeek.hasSequence) setForm((p: any) => ({ ...p, transferNumber: e.target.value })); }}
                          readOnly={seqPeek.hasSequence}
                          title={seqPeek.hasSequence ? t("stockTransferPage.sequenceTitle", { code: seqPeek.sequenceCode ?? "" }) : undefined}
                        />
                      </Field>
                      <Field label={t("stockTransferPage.date")} required>
                        <Input type="date" className="h-9 text-sm" value={form.transferDate} onChange={e => setForm((p: any) => ({ ...p, transferDate: e.target.value }))} />
                      </Field>
                      <Field label={t("stockTransferPage.fromWarehouse")} required>
                        <SearchCombobox items={(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: pickName(w.nameAr, w.nameEn) }))} value={form.fromWarehouseId} onValueChange={v => setForm((p: any) => ({ ...p, fromWarehouseId: v }))} placeholder={t("stockTransferPage.fromWarehousePlaceholder")} />
                      </Field>
                      <Field label={t("stockTransferPage.toWarehouse")} required>
                        <SearchCombobox items={(warehouses as any[]).filter((w: any) => String(w.id) !== form.fromWarehouseId).map((w: any) => ({ value: String(w.id), code: w.code, label: pickName(w.nameAr, w.nameEn) }))} value={form.toWarehouseId} onValueChange={v => setForm((p: any) => ({ ...p, toWarehouseId: v }))} placeholder={t("stockTransferPage.toWarehousePlaceholder")} />
                      </Field>
                      <Field label={t("stockTransferPage.notes")} className="md:col-span-2">
                        <Input className="h-9 text-sm" placeholder={t("stockTransferPage.notesPlaceholder")} value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
                      </Field>
                    </FormGrid>
                  </CardContent>
                </Card>

                {/* Section 2: Accounting accounts (with AI suggest button) */}
                <Card className="border-2 border-blue-100">
                  <CardHeader className="py-3 px-4 border-b bg-blue-50/40">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2 text-blue-900">
                        <Settings2 className="h-4 w-4" />
                        {t("stockTransferPage.accountsTitle")}
                      </CardTitle>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-1.5 h-7 text-[11px] border-purple-300 text-purple-700 hover:bg-purple-50 shrink-0"
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
                            if (!r.ok) throw new Error(j?.error || t("stockTransferPage.aiErrSuggest"));
                            if (j.fromAccountId && j.toAccountId) {
                              setForm((p: any) => ({
                                ...p,
                                fromAccountId: String(j.fromAccountId),
                                toAccountId:   String(j.toAccountId),
                              }));
                              setAiReasoning(`${j.reasoning || ""}${j.source === "ai" ? t("stockTransferPage.aiSuggestAi") : t("stockTransferPage.aiSuggestAuto")}`);
                              toast({ title: t("stockTransferPage.toastAccountsSuggested"), description: `${j.fromAccountLabel} ⇄ ${j.toAccountLabel}` });
                            } else {
                              throw new Error(j?.reasoning || t("stockTransferPage.aiErrNoAccounts"));
                            }
                          } catch (e: any) {
                            toast({ title: t("stockTransferPage.aiErrSuggest"), description: e?.message || t("stockTransferPage.aiErrUnknown"), variant: "destructive" });
                          } finally {
                            setAiLoading(false);
                          }
                        }}
                      >
                        {aiLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                        {t("stockTransferPage.aiSuggest")}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-4 pb-4 space-y-3">
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {t("stockTransferPage.accountsHintStart")}<b className="text-blue-700">{t("stockTransferPage.debit")}</b>{t("stockTransferPage.accountsHintDest")}<b className="text-rose-700">{t("stockTransferPage.credit")}</b>{t("stockTransferPage.accountsHintSource")}
                    </p>
                    <FormGrid cols={2}>
                      <Field label={t("stockTransferPage.fromAccountLabel")}>
                        <AccountCombobox value={form.fromAccountId} onValueChange={v => setForm((p: any) => ({ ...p, fromAccountId: v }))} placeholder={t("stockTransferPage.selectAccountPlaceholder")} filterTypes={["asset"]} grouped={false} />
                      </Field>
                      <Field label={t("stockTransferPage.toAccountLabel")}>
                        <AccountCombobox value={form.toAccountId} onValueChange={v => setForm((p: any) => ({ ...p, toAccountId: v }))} placeholder={t("stockTransferPage.selectAccountPlaceholder")} filterTypes={["asset"]} grouped={false} />
                      </Field>
                    </FormGrid>
                    {aiReasoning && (
                      <div className="text-xs text-purple-700 bg-purple-50 border border-purple-200 rounded p-2 leading-relaxed">
                        <Sparkles className="h-3 w-3 inline ml-1" />{aiReasoning}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Section 3: Items table */}
                <Card className="border-2 border-slate-100">
                  <CardHeader className="py-3 px-4 border-b bg-slate-50/40">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2">
                        <Boxes className="h-4 w-4 text-slate-700" />
                        {t("stockTransferPage.itemsTitle")}
                        {lines.filter(l => l.itemId).length > 0 && (
                          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-primary/15 text-primary text-[10px] font-bold">
                            {lines.filter(l => l.itemId).length}
                          </span>
                        )}
                      </CardTitle>
                      <Button type="button" size="sm" variant="outline" onClick={addLine} className="gap-1 h-7 text-xs">
                        <Plus className="h-3 w-3" />{t("stockTransferPage.addItem")}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-3 pb-3 space-y-2">
                    {/* ── Items grid (سند نمط فواتير المبيعات) ─────────────── */}
                    {(() => {
                      const gridCols = "240px 110px 160px 90px 140px 140px 40px";
                      const headers = [t("stockTransferPage.colItem"), t("stockTransferPage.colItemCode"), t("stockTransferPage.colUnit"), t("stockTransferPage.colQty"), t("stockTransferPage.colCostPrice"), t("stockTransferPage.colTotal"), ""];
                      const totalLabel = t("stockTransferPage.colTotal");
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
                                  ? t("stockTransferPage.baseQtyHint", { cf, qty: fmtQty(Number(line.qty || 0) * cf) })
                                  : null;
                                const autoFilled = isAutoFilled(line);
                                const selectedItem: any = (items as any[]).find(
                                  (it: any) => String(it.id) === String(line.itemId)
                                );
                                const itemCode = selectedItem?.code ?? "";
                                const lineTotal = Number(line.qty || 0) * Number(line.costPrice || 0);

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
                                            label: pickName(it.nameAr, it.nameEn),
                                            labelEn: it.nameEn,
                                          }))}
                                        value={line.itemId}
                                        onValueChange={v => handleItemSelect(i, v)}
                                        placeholder={t("stockTransferPage.selectItemPlaceholder")}
                                        className="h-8 text-xs"
                                      />

                                      {/* كود الصنف (تلقائي) */}
                                      <Input
                                        className="h-8 text-xs bg-muted/40 font-mono"
                                        readOnly
                                        placeholder={t("stockTransferPage.autoPlaceholder")}
                                        value={itemCode}
                                        title={itemCode}
                                      />

                                      {/* الوحدة */}
                                      <div>
                                        <SearchCombobox
                                          items={[
                                            { value: "", label: t("stockTransferPage.baseUnit") },
                                            ...lineUnits.map(u => ({ value: String(u.id), label: pickName(u.nameAr, u.nameEn) || "—" })),
                                          ]}
                                          value={line.unitId}
                                          onValueChange={v => handleUnitSelect(i, v)}
                                          placeholder={t("stockTransferPage.baseUnit")}
                                          className="h-8 text-xs"
                                        />
                                        {baseQtyHint && (
                                          <p className="text-[10px] text-purple-600 mt-0.5 font-medium leading-tight truncate" title={baseQtyHint}>
                                            {baseQtyHint}
                                          </p>
                                        )}
                                      </div>

                                      {/* الكمية */}
                                      <Input
                                        type="number"
                                        step="any"
                                        min="0.001"
                                        dir="ltr"
                                        className="h-8 text-xs text-left"
                                        value={line.qty}
                                        onChange={e => updateLine(i, "qty", e.target.value)}
                                      />

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
                                            {t("stockTransferPage.autoBadge")}
                                          </span>
                                        )}
                                      </div>

                                      {/* الإجمالي */}
                                      <Input
                                        className="h-8 text-xs bg-primary/5 font-semibold text-primary font-mono text-left"
                                        dir="ltr"
                                        readOnly
                                        value={fmt(lineTotal)}
                                      />

                                      {/* حذف */}
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 text-destructive"
                                        onClick={() => removeLine(i)}
                                        disabled={lines.length <= 1}
                                        aria-label={t("stockTransferPage.deleteItem")}
                                        title={t("stockTransferPage.deleteItem")}
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

                    {/* ── إجمالي التحويل (تحت الجريد) ─────────────────────── */}
                    <div className="flex items-center justify-end gap-3 px-3 py-2 rounded-lg bg-muted/30 border">
                      <span className="text-xs font-semibold text-muted-foreground">{t("stockTransferPage.totalTransfer")}</span>
                      <span className="text-sm font-bold tabular-nums font-mono text-primary">
                        {fmt(lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.costPrice || 0), 0))} {t("stockTransferPage.sar")}
                      </span>
                    </div>

                    <p className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
                      <Zap className="h-3 w-3 text-amber-500" />
                      {t("stockTransferPage.autoFillHint")}
                    </p>
                  </CardContent>
                </Card>
              </div>

              {/* ── Right column: live JE preview (sticky on desktop) ── */}
              <aside className="lg:sticky lg:top-4 space-y-4">
                <Card className="border-2 border-blue-200 bg-blue-50/40">
                  <CardHeader className="py-3 px-4 border-b border-blue-200/60">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2 text-blue-900">
                      <Calculator className="h-4 w-4" />
                      {t("stockTransferPage.jePreviewTitle")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-3 pb-3">
                    {(() => {
                      const total = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.costPrice || 0), 0);
                      if (total <= 0) {
                        return (
                          <p className="text-xs text-muted-foreground text-center py-6">
                            {t("stockTransferPage.jeAddItemsHint")}
                          </p>
                        );
                      }
                      const fromWh: any = (warehouses as any[]).find((w: any) => String(w.id) === form.fromWarehouseId);
                      const toWh:   any = (warehouses as any[]).find((w: any) => String(w.id) === form.toWarehouseId);
                      const fromAcc = form.fromAccountId ? Number(form.fromAccountId) : (fromWh?.accountId ?? null);
                      const toAcc   = form.toAccountId   ? Number(form.toAccountId)   : (toWh?.accountId   ?? null);
                      const fromSrc = form.fromAccountId ? t("stockTransferPage.manualSelection") : (fromWh?.accountId ? t("stockTransferPage.warehouseDefault") : null);
                      const toSrc   = form.toAccountId   ? t("stockTransferPage.manualSelection") : (toWh?.accountId   ? t("stockTransferPage.warehouseDefault") : null);
                      if (!fromAcc || !toAcc) {
                        return (
                          <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 leading-relaxed">
                            {t("stockTransferPage.noJeWarning")}
                          </div>
                        );
                      }
                      if (fromAcc === toAcc) {
                        return (
                          <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 leading-relaxed">
                            {t("stockTransferPage.sameAccountWarning")}
                          </div>
                        );
                      }
                      return (
                        <>
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-blue-800/70 border-b border-blue-200/60">
                                <th className="text-start pb-1.5 font-medium">{t("stockTransferPage.colAccount")}</th>
                                <th className="text-left pb-1.5 font-medium">{t("stockTransferPage.debit")}</th>
                                <th className="text-left pb-1.5 font-medium">{t("stockTransferPage.credit")}</th>
                              </tr>
                            </thead>
                            <tbody className="font-mono">
                              <tr className="border-b border-blue-200/40">
                                <td className="py-1.5 text-start text-[11px]">
                                  {t("stockTransferPage.destWarehouse")}
                                  {toSrc && <div className="text-[9px] text-muted-foreground font-sans">{toSrc}</div>}
                                </td>
                                <td className="text-left text-green-700 font-semibold tabular-nums">{fmt(total)}</td>
                                <td className="text-left text-muted-foreground">—</td>
                              </tr>
                              <tr>
                                <td className="py-1.5 text-start text-[11px]">
                                  {t("stockTransferPage.sourceWarehouse")}
                                  {fromSrc && <div className="text-[9px] text-muted-foreground font-sans">{fromSrc}</div>}
                                </td>
                                <td className="text-left text-muted-foreground">—</td>
                                <td className="text-left text-red-700 font-semibold tabular-nums">{fmt(total)}</td>
                              </tr>
                            </tbody>
                            <tfoot className="border-t border-blue-200/60">
                              <tr>
                                <td className="pt-1.5 text-start text-[10px] font-semibold text-blue-900">{t("stockTransferPage.totalLabel")}</td>
                                <td className="pt-1.5 text-left text-[11px] font-bold text-blue-900 tabular-nums">{fmt(total)}</td>
                                <td className="pt-1.5 text-left text-[11px] font-bold text-blue-900 tabular-nums">{fmt(total)}</td>
                              </tr>
                            </tfoot>
                          </table>
                          <p className="text-[10px] text-blue-800/70 mt-2 leading-relaxed">
                            {t("stockTransferPage.jeBalancedHint")}
                          </p>
                        </>
                      );
                    })()}
                  </CardContent>
                </Card>

                <div className="text-[11px] text-muted-foreground leading-relaxed bg-muted/20 border rounded-lg p-3">
                  <p className="font-semibold mb-1">{t("stockTransferPage.shortcutsTitle")}</p>
                  <ul className="space-y-0.5 list-disc list-inside">
                    <li>{t("stockTransferPage.shortcut1")}</li>
                    <li>{t("stockTransferPage.shortcut2")}</li>
                    <li>{t("stockTransferPage.shortcut3")}</li>
                  </ul>
                </div>
              </aside>
            </div>
          </div>

          {/* ─── Bottom action bar ──────────────────────────────────────── */}
          <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-t bg-muted/20 flex-wrap">
            <Button variant="ghost" size="sm" onClick={reset} disabled={createMut.isPending}>
              {t("stockTransferPage.cancel")}
            </Button>
            <Button
              size="sm"
              className="gap-1.5 min-w-[140px]"
              onClick={() => handleSubmit({ preventDefault() {} } as any)}
              disabled={createMut.isPending || !form.fromWarehouseId || !form.toWarehouseId || !form.transferDate}
            >
              {createMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {t("stockTransferPage.saveDraft")}
            </Button>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          className="pr-9"
          placeholder={t("stockTransferPage.searchPlaceholder")}
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
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{t("stockTransferPage.colNumber")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{t("stockTransferPage.colDate")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">{t("stockTransferPage.colFromWarehouse")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">{t("stockTransferPage.colToWarehouse")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{t("stockTransferPage.colStatus")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-32">{t("stockTransferPage.colActions")}</th>
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
                    {t("stockTransferPage.emptyState")}
                  </td>
                </tr>
              )
              : filtered.map((tr: any) => {
                  const st = STATUS_CONFIG[tr.status] ?? STATUS_CONFIG.draft;
                  const statusKey = STATUS_CONFIG[tr.status] ? tr.status : "draft";
                  return (
                    <Fragment key={tr.id}>
                      <tr data-status={tr.status}
                          className={cn("transition-colors", rowToneFor({ status: tr.status }))}
                          title={buildToneTooltip({ status: tr.status })}>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => setExpandedId(expandedId === tr.id ? null : tr.id)}
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={expandedId === tr.id ? t("stockTransferPage.collapseDetails") : t("stockTransferPage.expandDetails")}
                            aria-expanded={expandedId === tr.id}
                            title={expandedId === tr.id ? t("stockTransferPage.collapseDetails") : t("stockTransferPage.expandDetails")}
                          >
                            {expandedId === tr.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </button>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs font-bold">{tr.transferNumber}</td>
                        <td className="px-4 py-3 text-muted-foreground">{tr.transferDate}</td>
                        <td className="px-4 py-3 hidden sm:table-cell">{pickName(tr.fromWarehouse?.nameAr, tr.fromWarehouse?.nameEn) || "—"}</td>
                        <td className="px-4 py-3 hidden sm:table-cell">{pickName(tr.toWarehouse?.nameAr, tr.toWarehouse?.nameEn) || "—"}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn("text-[10px] font-medium rounded-full px-2.5 py-1", st.color)}>
                            {t(`stockTransferPage.status.${statusKey}`)}
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
                                  onClick={() => { if (confirm(t("stockTransferPage.confirmPost"))) postMut.mutate(tr.id); }}
                                >
                                  <Send className="h-3 w-3" />{t("stockTransferPage.post")}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive"
                                  onClick={() => { if (confirm(t("stockTransferPage.confirmDelete"))) deleteMut.mutate(tr.id); }}
                                  aria-label={t("stockTransferPage.deleteTransfer")}
                                  title={t("stockTransferPage.deleteTransfer")}
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
                              ? <p className="text-xs text-muted-foreground">{t("stockTransferPage.noItems")}</p>
                              : (
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-muted-foreground border-b">
                                      <th className="text-right pb-2 pr-0">{t("stockTransferPage.colItem")}</th>
                                      <th className="text-right pb-2">{t("stockTransferPage.colUnit")}</th>
                                      <th className="text-right pb-2">{t("stockTransferPage.colQty")}</th>
                                      <th className="text-right pb-2">{t("stockTransferPage.detailColCost")}</th>
                                      <th className="text-right pb-2">{t("stockTransferPage.colTotal")}</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-border/50">
                                    {trDetail.items.map((l: any) => (
                                      <tr key={l.id}>
                                        <td className="py-1.5 pr-0">{pickName(l.item?.nameAr, l.item?.nameEn) || l.itemId}</td>
                                        <td className="py-1.5">{pickName(l.unit?.nameAr, l.unit?.nameEn) || t("stockTransferPage.baseUnit")}</td>
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
            {t("stockTransferPage.transferCount", { count: filtered.length })}
          </div>
        )}
      </div>
    </div>
  );
}
