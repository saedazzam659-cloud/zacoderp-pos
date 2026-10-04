import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Boxes, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { useToast } from "@/hooks/use-toast";
import { usePermission } from "@/hooks/usePermission";
import { inventoryApi } from "@/lib/inventoryApi";
import { summarizeBundleAssembly } from "./bundleAssembly";

type ItemRow = {
  id: number;
  code?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
  itemType?: string | null;
  itemNature?: string | null;
  isBundle?: boolean;
  unitId?: number | null;
  unitCode?: string | null;
};

type AssemblyLine = { itemId: number; qty: string };
type BundleComponent = { id: number; childItemId: number; qty: string | number };

function qtyText(value: number) {
  return Number.isFinite(value) ? String(Number(value.toFixed(4))) : "0";
}

function newAssemblyRequestId() {
  return globalThis.crypto?.randomUUID?.() ??
    `assembly-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function BundleAssemblyDialog({
  item,
  components,
  allItems,
  isArabic,
}: {
  item: ItemRow;
  components: BundleComponent[];
  allItems: ItemRow[];
  isArabic: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canCreateAdjustment = usePermission("stock_adjustments", "create");
  const canPostAdjustment = usePermission("stock_adjustments", "post");
  const [open, setOpen] = useState(false);
  const form = useForm<{ warehouseId: string; finishedQty: string; wasteNote: string }>({
    defaultValues: { warehouseId: "", finishedQty: "1", wasteNote: "" },
  });
  const warehouseId = form.watch("warehouseId");
  const finishedQty = form.watch("finishedQty");
  const wasteNote = form.watch("wasteNote");
  const [lines, setLines] = useState<AssemblyLine[]>([]);
  const [linesTouched, setLinesTouched] = useState(false);
  const [newItemId, setNewItemId] = useState("");
  const [draftId, setDraftId] = useState<number | null>(null);
  const [requestId, setRequestId] = useState(newAssemblyRequestId);
  const submitLock = useRef(false);

  const copy = isArabic ? {
    action: "تجميع الآن",
    title: "تجميع مخزني سريع",
    description: "تُصرف المكونات من المخزن المختار. يحسب الخادم تكلفة الصنف التام من تكلفة الصرف الفعلية وقت الترحيل؛ والتغييرات هنا تخص هذه العملية فقط.",
    warehouse: "مخزن الصرف والاستلام",
    chooseWarehouse: "اختر المخزن",
    searchWarehouse: "ابحث بالكود أو الاسم...",
    finishedQty: "الكمية التامة",
    materials: "المكونات التي ستُصرف",
    materialQty: "كمية الصرف",
    available: "المتاح",
    unitCost: "تكلفة الوحدة",
    lineTotal: "القيمة",
    addMaterial: "إضافة خامة",
    chooseMaterial: "اختر صنفًا",
    searchMaterial: "ابحث بالكود أو الاسم...",
    noResults: "لا توجد نتائج",
    restoreRecipe: "إعادة كميات التركيب المحفوظة",
    waste: "وصف الهالك (اختياري)",
    wastePlaceholder: "مثال: قصاصات أكريليك 0.5 متر",
    materialCost: "إجمالي تكلفة الخامات",
    outputCost: "تكلفة الوحدة التامة التقديرية",
    shortage: "الكمية المطلوبة أكبر من المتاح في المخزن.",
    loading: "جارٍ تحميل رصيد المخزن...",
    noLines: "أضف مكونًا واحدًا على الأقل.",
    draft: "حُفظت مسودة تسوية المخزون رقم",
    draftHint: "لم يتم ترحيلها بعد. أعد المحاولة هنا أو أكملها من شاشة تسويات المخزون.",
    cancel: "إغلاق",
    submit: "صرف الخامات وإضافة المنتج",
    retry: "إعادة ترحيل المسودة",
    success: "تم التجميع وتحديث المخزون",
    failed: "تعذر إتمام التجميع",
    invalid: "أدخل كمية تامة ومكونات بكميات موجبة.",
  } : {
    action: "Assemble now",
    title: "Quick inventory assembly",
    description: "Components are issued from the selected warehouse. The server derives finished-item cost from the actual issue cost when posting; edits apply to this operation only.",
    warehouse: "Issue and receipt warehouse",
    chooseWarehouse: "Choose a warehouse",
    searchWarehouse: "Search by code or name...",
    finishedQty: "Finished quantity",
    materials: "Components to issue",
    materialQty: "Issue quantity",
    available: "Available",
    unitCost: "Unit cost",
    lineTotal: "Value",
    addMaterial: "Add material",
    chooseMaterial: "Choose an item",
    searchMaterial: "Search by code or name...",
    noResults: "No matches",
    restoreRecipe: "Restore saved component quantities",
    waste: "Waste description (optional)",
    wastePlaceholder: "Example: 0.5 m acrylic offcuts",
    materialCost: "Total material cost",
    outputCost: "Estimated finished unit cost",
    shortage: "Required quantity exceeds stock available in this warehouse.",
    loading: "Loading warehouse balance...",
    noLines: "Add at least one component.",
    draft: "Inventory adjustment draft",
    draftHint: "was saved but not posted. Retry here or finish it in Stock Adjustments.",
    cancel: "Close",
    submit: "Issue materials and receive finished item",
    retry: "Retry posting draft",
    success: "Assembly posted and inventory updated",
    failed: "Assembly could not be completed",
    invalid: "Enter a positive finished quantity and positive component quantities.",
  };

  const { data: warehouses = [], isLoading: warehousesLoading } = useQuery<any[]>({
    queryKey: ["warehouses"],
    queryFn: () => inventoryApi.getWarehouses(),
  });
  const { data: balances = [], isFetching: balancesLoading } = useQuery<any[]>({
    queryKey: ["stock-balance", "bundle-assembly", warehouseId],
    queryFn: () => inventoryApi.getBalance({ warehouseId }),
    enabled: open && !!warehouseId,
  });

  useEffect(() => {
    if (warehouseId || !warehouses.length) return;
    const preferred = warehouses.find((warehouse: any) => warehouse.isDefault) ?? warehouses[0];
    form.setValue("warehouseId", String(preferred.id));
  }, [warehouseId, warehouses]);

  useEffect(() => {
    if (!open || linesTouched) return;
    const multiplier = Number(finishedQty);
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      setLines([]);
      return;
    }
    setLines(components.map(component => ({
      itemId: Number(component.childItemId),
      qty: qtyText(Number(component.qty) * multiplier),
    })));
  }, [open, finishedQty, components, linesTouched]);

  const itemById = useMemo(
    () => new Map(allItems.map(candidate => [Number(candidate.id), candidate])),
    [allItems],
  );
  const balanceById = useMemo(
    () => new Map(balances.map((row: any) => [Number(row.itemId), row])),
    [balances],
  );
  const summary = summarizeBundleAssembly(lines, balances, finishedQty);
  const currentWarehouse = warehouses.find((warehouse: any) => String(warehouse.id) === warehouseId);
  const usedItemIds = new Set(lines.map(line => line.itemId));
  const addableItems = allItems.filter(candidate =>
    Number(candidate.id) !== Number(item.id) &&
    !candidate.isBundle &&
    (!candidate.itemType || candidate.itemType === "stock") &&
    !usedItemIds.has(Number(candidate.id)),
  );

  const payload = () => {
    const warehouse = currentWarehouse;
    const goodQty = Number(finishedQty);
    if (!warehouse || !summary.validFinishedQty || !lines.length ||
        summary.invalidItemIds.length || summary.shortages.length) {
      throw new Error(copy.invalid);
    }
    const materialRows = lines.map(line => {
      const component = itemById.get(line.itemId);
      if (!component) throw new Error(copy.invalid);
      return {
        itemId: line.itemId,
        unitId: component.unitId ?? null,
        qty: String(-Number(Number(line.qty).toFixed(4))),
        costPrice: String(summary.unitCosts[line.itemId] ?? 0),
        notes: `صرف مكونات لتجميع ${item.nameAr || item.nameEn || `#${item.id}`}`,
      };
    });
    return {
      adjustmentDate: new Date().toISOString().slice(0, 10),
      warehouseId: Number(warehouse.id),
      accountId: warehouse.accountId ?? null,
      inventoryAccountId: warehouse.accountId ?? null,
      adjustmentAccountId: null,
      reason: "__BUNDLE_ASSEMBLY_V1__",
      notes: [
        `${isArabic ? "تجميع للصنف" : "Assembly for"} ${item.nameAr || item.nameEn || `#${item.id}`}`,
        `${isArabic ? "الكمية التامة" : "Finished quantity"}: ${qtyText(goodQty)} ${item.unitCode || ""}`.trim(),
        wasteNote.trim() ? `${isArabic ? "الهالك" : "Waste"}: ${wasteNote.trim()}` : "",
        isArabic
          ? "تكلفة الخامات المصروفة محملة على المنتج التام."
          : "Issued material cost is carried into the finished item.",
        `[bundle-assembly-request:${requestId}]`,
      ].filter(Boolean).join(" — "),
      items: [
        ...materialRows,
        {
          itemId: Number(item.id),
          unitId: item.unitId ?? null,
          qty: String(Number(goodQty.toFixed(4))),
          // The stock-adjustment posting transaction replaces this preview
          // with the actual locked warehouse issue cost.
          costPrice: "0",
          notes: isArabic ? "استلام المنتج التام من التجميع" : "Finished item received from assembly",
        },
      ],
    };
  };

  const assemblyMutation = useMutation({
    mutationFn: async () => {
      const adjustment = payload();
      let currentDraftId = draftId;
      if (currentDraftId) {
        const current = await inventoryApi.getAdjustment(currentDraftId);
        if (current?.status === "posted") return currentDraftId;
        const sameWarehouse = Number(current?.warehouseId) === Number(adjustment.warehouseId);
        await inventoryApi.updateAdjustment(currentDraftId, {
          ...adjustment,
          inventoryAccountId: sameWarehouse
            ? current?.inventoryAccountId ?? adjustment.inventoryAccountId
            : adjustment.inventoryAccountId,
          adjustmentAccountId: current?.adjustmentAccountId ?? adjustment.adjustmentAccountId,
        });
      } else {
        const created = await inventoryApi.createAdjustment(adjustment);
        if (!Number.isInteger(Number(created?.id))) {
          throw new Error(isArabic ? "لم يُرجع الخادم رقم تسوية صالحًا" : "The server did not return a valid adjustment ID");
        }
        currentDraftId = Number(created.id);
        if (created?.status === "posted") return currentDraftId;
        setDraftId(currentDraftId);
      }
      try {
        await inventoryApi.postAdjustment(currentDraftId);
      } catch (error: any) {
        throw new Error(`${error?.message || copy.failed}. ${copy.draft} #${currentDraftId}; ${copy.draftHint}`);
      }
      return currentDraftId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["stock-balance"] });
      queryClient.invalidateQueries({ queryKey: ["stock-adjustments"] });
      setDraftId(null);
      setRequestId(newAssemblyRequestId());
      setOpen(false);
      setLinesTouched(false);
      form.reset({ warehouseId, finishedQty: "1", wasteNote: "" });
      toast({ title: copy.success });
    },
    onError: (error: any) => toast({
      title: copy.failed,
      description: error?.message || copy.failed,
      variant: "destructive",
    }),
    onSettled: () => { submitLock.current = false; },
  });

  if (!canCreateAdjustment || !canPostAdjustment ||
      (item.itemType && item.itemType !== "stock")) return null;

  const validLines = lines.length > 0 && lines.every(line =>
    Number.isInteger(line.itemId) && line.itemId > 0 &&
    Number.isFinite(Number(line.qty)) && Number(line.qty) > 0,
  );
  const canSubmit = !assemblyMutation.isPending &&
    !warehousesLoading &&
    !!warehouseId &&
    summary.validFinishedQty &&
    validLines &&
    summary.invalidItemIds.length === 0 &&
    summary.shortages.length === 0 &&
    !balancesLoading;
  const submitAssembly = () => {
    try {
      payload();
      if (submitLock.current) return;
      submitLock.current = true;
      assemblyMutation.mutate();
    } catch (error: any) {
      submitLock.current = false;
      toast({ title: copy.failed, description: error?.message || copy.invalid, variant: "destructive" });
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="default"
        className="gap-1.5 shrink-0"
        data-testid="button-bundle-assembly-open"
        onClick={() => {
          if (!draftId) {
            form.setValue("finishedQty", "1");
            form.setValue("wasteNote", "");
            setLinesTouched(false);
            setRequestId(newAssemblyRequestId());
          }
          setOpen(true);
        }}
      >
        <Boxes className="h-3.5 w-3.5" />
        {draftId ? (isArabic ? `استكمال المسودة #${draftId}` : `Continue draft #${draftId}`) : copy.action}
      </Button>
      <Dialog open={open} onOpenChange={value => !assemblyMutation.isPending && setOpen(value)}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto" dir={isArabic ? "rtl" : "ltr"}>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(submitAssembly)} className="space-y-4">
              <DialogHeader>
                <DialogTitle data-testid="text-bundle-assembly-title">{copy.title}: {item.nameAr || item.nameEn || `#${item.id}`}</DialogTitle>
                <DialogDescription>{copy.description}</DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="warehouseId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel htmlFor={`bundle-assembly-warehouse-${item.id}`}>{copy.warehouse}</FormLabel>
                      <SearchCombobox
                        id={`bundle-assembly-warehouse-${item.id}`}
                        items={warehouses.map((warehouse: any) => ({
                          value: String(warehouse.id),
                          code: warehouse.code ?? undefined,
                          label: warehouse.nameAr || warehouse.nameEn || `#${warehouse.id}`,
                          labelEn: warehouse.nameEn || undefined,
                        }))}
                        value={field.value}
                        onValueChange={value => {
                            field.onChange(value);
                            if (!draftId) setRequestId(newAssemblyRequestId());
                        }}
                        placeholder={copy.chooseWarehouse}
                        searchPlaceholder={copy.searchWarehouse}
                        emptyText={copy.noResults}
                        disabled={warehousesLoading || assemblyMutation.isPending}
                        openOnFocus={false}
                        testId="select-bundle-assembly-warehouse"
                      />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="finishedQty"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{copy.finishedQty} {item.unitCode ? `(${item.unitCode})` : ""}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min="0.0001"
                          step="0.0001"
                          onChange={event => {
                            field.onChange(event);
                            if (!draftId) setRequestId(newAssemblyRequestId());
                          }}
                          disabled={assemblyMutation.isPending}
                          data-testid="input-bundle-assembly-finished-qty"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{copy.materials}</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                data-testid="button-bundle-assembly-reset-recipe"
                onClick={() => {
                  setLines(components.map(component => ({
                    itemId: Number(component.childItemId),
                    qty: qtyText(Number(component.qty) * Number(finishedQty || 0)),
                  })));
                  setLinesTouched(false);
                  if (!draftId) setRequestId(newAssemblyRequestId());
                }}
                disabled={assemblyMutation.isPending || Number(finishedQty) <= 0}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {copy.restoreRecipe}
              </Button>
            </div>

            {lines.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">{copy.noLines}</p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full min-w-[620px] text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="p-2 text-start">{copy.materials}</th>
                      <th className="p-2 text-start">{copy.materialQty}</th>
                      <th className="p-2 text-end">{copy.available}</th>
                      <th className="p-2 text-end">{copy.unitCost}</th>
                      <th className="p-2 text-end">{copy.lineTotal}</th>
                      <th className="w-10 p-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => {
                      const component = itemById.get(line.itemId);
                      const balance = balanceById.get(line.itemId);
                      const available = Math.max(0, Number(balance?.qty ?? 0));
                      const unitCost = summary.unitCosts[line.itemId] ?? 0;
                      const lineQty = Number(line.qty) || 0;
                      const isShort = lineQty > available;
                      return (
                        <tr key={`${line.itemId}-${index}`} className="border-t" data-testid={`row-bundle-assembly-material-${line.itemId}`}>
                          <td className="p-2 font-medium">
                            {component?.nameAr || component?.nameEn || `#${line.itemId}`}
                            {component?.unitCode ? <span className="ms-1 text-xs text-muted-foreground">({component.unitCode})</span> : null}
                          </td>
                          <td className="p-2">
                            <Input
                              type="number"
                              min="0.0001"
                              step="0.0001"
                              value={line.qty}
                              onChange={event => {
                                setLinesTouched(true);
                                setLines(previous => previous.map((row, rowIndex) =>
                                  rowIndex === index ? { ...row, qty: event.target.value } : row,
                                ));
                                if (!draftId) setRequestId(newAssemblyRequestId());
                              }}
                              className="h-8 w-32"
                              disabled={assemblyMutation.isPending}
                              data-testid={`input-bundle-assembly-material-qty-${line.itemId}`}
                            />
                          </td>
                          <td className={`p-2 text-end ${isShort ? "font-semibold text-destructive" : "text-muted-foreground"}`}>
                            {qtyText(available)} {component?.unitCode || ""}
                          </td>
                          <td className="p-2 text-end text-muted-foreground">{unitCost.toFixed(4)}</td>
                          <td className="p-2 text-end">{(lineQty * unitCost).toFixed(2)}</td>
                          <td className="p-2 text-center">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={isArabic ? "حذف المكون من هذه العملية" : "Remove component from this operation"}
                              className="h-8 w-8 text-destructive"
                              data-testid={`button-bundle-assembly-remove-${line.itemId}`}
                              onClick={() => {
                                setLinesTouched(true);
                                setLines(previous => previous.filter((_, rowIndex) => rowIndex !== index));
                                if (!draftId) setRequestId(newAssemblyRequestId());
                              }}
                              disabled={assemblyMutation.isPending}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[220px] flex-1 space-y-1.5">
                <Label htmlFor={`bundle-assembly-material-${item.id}`}>{copy.chooseMaterial}</Label>
                <SearchCombobox
                  id={`bundle-assembly-material-${item.id}`}
                  items={addableItems.map(candidate => ({
                    value: String(candidate.id),
                    code: candidate.code ?? undefined,
                    label: candidate.nameAr || candidate.nameEn || `#${candidate.id}`,
                    labelEn: candidate.nameEn || undefined,
                  }))}
                  value={newItemId}
                  onValueChange={setNewItemId}
                  placeholder={copy.chooseMaterial}
                  searchPlaceholder={copy.searchMaterial}
                  emptyText={copy.noResults}
                  disabled={assemblyMutation.isPending || addableItems.length === 0}
                  openOnFocus={false}
                  testId="select-bundle-assembly-add-material"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                className="gap-1.5"
                data-testid="button-bundle-assembly-add-material"
                disabled={!newItemId || assemblyMutation.isPending}
                onClick={() => {
                  const addedId = Number(newItemId);
                  setLines(previous => [...previous, { itemId: addedId, qty: "1" }]);
                  setLinesTouched(true);
                  setNewItemId("");
                  if (!draftId) setRequestId(newAssemblyRequestId());
                }}
              >
                <Plus className="h-4 w-4" />
                {copy.addMaterial}
              </Button>
            </div>
          </div>

              <FormField
                control={form.control}
                name="wasteNote"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{copy.waste}</FormLabel>
                    <FormControl>
                      <textarea
                        {...field}
                        onChange={event => {
                          field.onChange(event);
                          if (!draftId) setRequestId(newAssemblyRequestId());
                        }}
                        placeholder={copy.wastePlaceholder}
                        className="min-h-16 w-full rounded-md border bg-background px-3 py-2 text-sm"
                        disabled={assemblyMutation.isPending}
                        data-testid="input-bundle-assembly-waste-note"
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      {isArabic
                        ? "يُحفظ وصف الهالك في ملاحظات تسوية المخزون؛ وتُحمّل قيمة الخامات المصروفة على المنتج التام."
                        : "The waste note is saved on the inventory adjustment; issued material cost is allocated to the finished item."}
                    </p>
                  </FormItem>
                )}
              />

          <div className="grid gap-3 rounded-md border bg-muted/30 p-3 sm:grid-cols-2">
            <div>
              <div className="text-xs text-muted-foreground">{copy.materialCost}</div>
              <div className="font-semibold" data-testid="text-bundle-assembly-material-cost">{summary.materialCost.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{copy.outputCost}</div>
              <div className="font-semibold" data-testid="text-bundle-assembly-unit-cost">{summary.unitCost.toFixed(4)} {item.unitCode || ""}</div>
            </div>
          </div>

          {balancesLoading && warehouseId ? <p className="text-xs text-muted-foreground" role="status" data-testid="status-bundle-assembly-balances-loading">{copy.loading}</p> : null}
          {summary.shortages.length > 0 ? (
            <p role="alert" data-testid="status-bundle-assembly-shortages" className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">
              {copy.shortage}
            </p>
          ) : null}
          {draftId ? (
            <p role="status" data-testid="status-bundle-assembly-draft" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
              {copy.draft} #{draftId}; {copy.draftHint}
            </p>
          ) : null}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={assemblyMutation.isPending} data-testid="button-bundle-assembly-close">
                  {copy.cancel}
                </Button>
                <Button
                  type="submit"
                  disabled={!canSubmit}
                  data-testid="button-bundle-assembly-submit"
                >
                  {assemblyMutation.isPending ? (isArabic ? "جارٍ الترحيل..." : "Posting...") : draftId ? copy.retry : copy.submit}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}