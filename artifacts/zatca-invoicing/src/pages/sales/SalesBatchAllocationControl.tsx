import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, Layers3, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export interface SalesBatchAllocation {
  batchNumber: string | null;
  expiryDate: string | null;
  qty: number;
}

interface BatchOption {
  batchNumber: string | null;
  expiryDate: string | null;
  availableQty: number;
  earliestInDate?: string | null;
}

interface BatchOptionsResponse {
  mode: "none" | "fifo" | "fefo";
  batches: BatchOption[];
  suggestedPicks: SalesBatchAllocation[];
  totalAvailable: number;
  sufficient: boolean;
}

interface Props {
  kind: "sale" | "return";
  companyId: string | number;
  itemId: string;
  warehouseId: string;
  sourceInvoiceId?: string;
  priorQty?: number;
  requestedQty: number;
  value: SalesBatchAllocation[] | null;
  onChange?: (allocations: SalesBatchAllocation[] | null) => void;
  canManuallyPick?: boolean;
  headers: Record<string, string>;
  rowId: string;
}

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const QTY_EPSILON = 0.0001;

function keyOf(batchNumber: string | null, expiryDate: string | null) {
  return JSON.stringify([batchNumber, expiryDate]);
}

function cleanPicks(rows: SalesBatchAllocation[] | null | undefined) {
  return (rows ?? []).filter((row) => Number(row.qty) > QTY_EPSILON);
}

function formatQty(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
}

export function SalesBatchAllocationControl({
  kind,
  companyId,
  itemId,
  warehouseId,
  sourceInvoiceId,
  priorQty = 0,
  requestedQty,
  value,
  onChange,
  canManuallyPick = false,
  headers,
  rowId,
}: Props) {
  const { i18n } = useTranslation();
  const isArabic = i18n.language.toLowerCase().startsWith("ar");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SalesBatchAllocation[]>([]);
  const [draftText, setDraftText] = useState<Record<string, string>>({});
  const qty = Number.isFinite(requestedQty) && requestedQty > 0 ? requestedQty : 0;
  const priorBaseQty = Number.isFinite(priorQty) && priorQty > 0 ? priorQty : 0;
  const enabled = !!itemId && !!warehouseId && qty > 0 && (kind !== "return" || !!sourceInvoiceId);
  const queryKey = [
    "sales-batch-options",
    kind,
    companyId,
    sourceInvoiceId ?? "",
    itemId,
    warehouseId,
    priorBaseQty,
    qty,
  ];

  const optionsQuery = useQuery<BatchOptionsResponse>({
    queryKey,
    enabled,
    staleTime: 10_000,
    queryFn: async () => {
      const params = new URLSearchParams({
        companyId: String(companyId),
        itemId,
        warehouseId,
        qty: String(qty),
      });
      if (kind === "return" && priorBaseQty > 0) params.set("priorQty", String(priorBaseQty));
      const path = kind === "sale"
        ? `${API}/api/sales/sales-invoices/batch-options?${params}`
        : `${API}/api/sales/sales-returns/${sourceInvoiceId}/batch-options?${params}`;
      const response = await fetch(path, { headers });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || (isArabic ? "تعذّر تحميل التشغيلات" : "Could not load batches"));
      return result as BatchOptionsResponse;
    },
  });

  const data = optionsQuery.data;
  const batches = data?.batches ?? [];
  const suggested = cleanPicks(data?.suggestedPicks);
  const displayedPicks = value == null ? suggested : cleanPicks(value);
  const sameAsSuggestion = useMemo(() => {
    const a = [...displayedPicks].sort((x, y) => keyOf(x.batchNumber, x.expiryDate).localeCompare(keyOf(y.batchNumber, y.expiryDate)));
    const b = [...suggested].sort((x, y) => keyOf(x.batchNumber, x.expiryDate).localeCompare(keyOf(y.batchNumber, y.expiryDate)));
    return a.length === b.length && a.every((pick, index) =>
      keyOf(pick.batchNumber, pick.expiryDate) === keyOf(b[index].batchNumber, b[index].expiryDate)
      && Math.abs(Number(pick.qty) - Number(b[index].qty)) <= QTY_EPSILON,
    );
  }, [displayedPicks, suggested]);

  useEffect(() => {
    if (!open || !data) return;
    const initial = cleanPicks(value ?? data.suggestedPicks).map((pick) => ({ ...pick }));
    setDraft(initial);
    setDraftText(Object.fromEntries(initial.map((pick) => [
      keyOf(pick.batchNumber, pick.expiryDate),
      String(pick.qty),
    ])));
  }, [open, data, value]);

  // Nothing is shown for untracked items or items with no on-hand batch
  // buckets. Their existing stock flow remains unchanged.
  if (!enabled || (data && (data.mode === "none" || batches.length === 0))) return null;

  const modeLabel = data?.mode === "fefo" ? "FEFO" : "FIFO";
  const summary = displayedPicks.length
    ? displayedPicks.map((pick) =>
        `${pick.batchNumber || (isArabic ? "غير مرمّز" : "Unlabeled")}${pick.expiryDate ? ` · ${pick.expiryDate}` : ""}: ${formatQty(Number(pick.qty))}`,
      ).join("، ")
    : (isArabic ? "لا توجد كمية كافية موزعة على التشغيلات" : "Not enough batch quantity available");
  const draftTotal = draft.reduce((sum, pick) => sum + Number(pick.qty || 0), 0);
  const canApply = Math.abs(draftTotal - qty) <= QTY_EPSILON
    && draft.every((pick) => Number(pick.qty) >= 0)
    && Object.values(draftText).every((text) =>
      text === "" || (!text.endsWith(".") && Number.isFinite(Number(text))),
    );

  function setBatchQty(batch: BatchOption, raw: string) {
    const key = keyOf(batch.batchNumber, batch.expiryDate);
    setDraftText((previous) => ({ ...previous, [key]: raw }));
    if (!raw || raw.endsWith(".") || !Number.isFinite(Number(raw))) return;
    const amount = Math.max(0, Math.min(batch.availableQty, Number(raw) || 0));
    setDraft((previous) => {
      const next = previous.filter((pick) => keyOf(pick.batchNumber, pick.expiryDate) !== key);
      if (amount > QTY_EPSILON) next.push({ batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, qty: amount });
      return next;
    });
  }

  function draftQty(batch: BatchOption) {
    return draft.find((pick) => keyOf(pick.batchNumber, pick.expiryDate) === keyOf(batch.batchNumber, batch.expiryDate))?.qty ?? 0;
  }

  return (
    <div className="mt-1 ms-1 flex flex-wrap items-center gap-1.5" data-testid={`batch-allocation-summary-${rowId}`}>
      {optionsQuery.isLoading ? (
        <span className="text-[10px] text-muted-foreground">{isArabic ? "تحميل التشغيلات…" : "Loading batches…"}</span>
      ) : optionsQuery.isError ? (
        <span className="text-[10px] text-destructive" role="status">{isArabic ? "تعذّر تحميل بيانات التشغيلات" : "Batch data could not be loaded"}</span>
      ) : data && data.mode !== "none" ? (
        <>
          <span className="text-[10px] text-muted-foreground">
            {isArabic ? `اقتراح ${modeLabel}:` : `${modeLabel} proposal:`}
          </span>
          <span className="max-w-[520px] truncate text-[10px] font-medium" title={summary}>{summary}</span>
          {!data.sufficient && (
            <span className="text-[10px] text-destructive" role="status">
              {isArabic ? `المتاح ${formatQty(data.totalAvailable)} من ${formatQty(qty)}` : `${formatQty(data.totalAvailable)} available of ${formatQty(qty)}`}
            </span>
          )}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[10px]"
                data-testid={`button-batch-details-${rowId}`}
              >
                <Layers3 className="h-3 w-3" />
                {kind === "return"
                  ? (isArabic ? "معاينة دفعات المرتجع" : "Preview return batches")
                  : (canManuallyPick ? (isArabic ? "اختيار التشغيلات" : "Choose batches") : (isArabic ? "تفاصيل التشغيلات" : "Batch details"))}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" dir={isArabic ? "rtl" : "ltr"}>
              <DialogHeader>
                <DialogTitle>
                  {kind === "return"
                    ? (isArabic ? "التشغيلات التي سيعاد إليها الصنف" : "Batches that will receive the return")
                    : (isArabic ? "توزيع كمية البيع على التشغيلات" : "Allocate sale quantity across batches")}
                </DialogTitle>
                <DialogDescription>
                  {kind === "return"
                    ? (isArabic ? "يعيد النظام الكمية إلى التشغيلات التي خرجت منها في الفاتورة الأصلية، ولا ينشئ تشغيلة بديلة." : "The system restores the quantity to the lots issued on the original invoice; it does not invent a replacement lot.")
                    : (isArabic ? `الترتيب الافتراضي ${modeLabel}. التخصيص اليدوي يظل خاضعًا للتحقق من الكمية المتاحة عند الترحيل.` : `Default order is ${modeLabel}. Manual allocations are revalidated against live stock when posted.`)}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
                  <span>{isArabic ? "الكمية المطلوبة" : "Requested quantity"}</span>
                  <span className="font-mono font-semibold" dir="ltr">{formatQty(qty)}</span>
                  <span>{isArabic ? "نمط السحب" : "Issue mode"}</span>
                  <span className="font-semibold">{modeLabel}</span>
                </div>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[520px] text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="p-2 text-start">{isArabic ? "رقم التشغيلة" : "Batch number"}</th>
                        <th className="p-2 text-start">{isArabic ? "تاريخ الانتهاء" : "Expiry date"}</th>
                        <th className="p-2 text-end">{isArabic ? "المتاح" : "Available"}</th>
                        <th className="p-2 text-end">{kind === "return" ? (isArabic ? "سيعاد" : "Returned") : (isArabic ? "المخصص" : "Allocated")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batches.map((batch, index) => (
                        <tr key={`${keyOf(batch.batchNumber, batch.expiryDate)}-${index}`} className="border-t">
                          <td className="p-2 font-mono" dir="auto">{batch.batchNumber || (isArabic ? "غير مرمّز" : "Unlabeled")}</td>
                          <td className="p-2" dir="ltr">{batch.expiryDate || "—"}</td>
                          <td className="p-2 text-end font-mono" dir="ltr">{formatQty(batch.availableQty)}</td>
                          <td className="p-2 text-end">
                            {kind === "return" || !canManuallyPick ? (
                              <span className="font-mono" dir="ltr">
                                {formatQty(kind === "return"
                                  ? (suggested.find((pick) => keyOf(pick.batchNumber, pick.expiryDate) === keyOf(batch.batchNumber, batch.expiryDate))?.qty ?? 0)
                                  : (displayedPicks.find((pick) => keyOf(pick.batchNumber, pick.expiryDate) === keyOf(batch.batchNumber, batch.expiryDate))?.qty ?? 0))}
                              </span>
                            ) : (
                              <Input
                                type="number"
                                min="0"
                                max={batch.availableQty}
                                step="0.0001"
                                inputMode="decimal"
                                className="ms-auto h-8 w-28 text-end font-mono"
                                value={draftText[keyOf(batch.batchNumber, batch.expiryDate)] ?? (draftQty(batch) || "")}
                                data-testid={`input-batch-qty-${rowId}-${index}`}
                                onChange={(event) => setBatchQty(batch, event.target.value)}
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {kind === "sale" && canManuallyPick && (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className={`text-xs ${Math.abs(draftTotal - qty) <= QTY_EPSILON ? "text-muted-foreground" : "text-destructive"}`} data-testid={`batch-allocation-total-${rowId}`}>
                      {isArabic ? "إجمالي المخصص" : "Allocated total"}: {formatQty(draftTotal)} / {formatQty(qty)}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        onChange?.(null);
                        setDraft(suggested.map((pick) => ({ ...pick })));
                        setDraftText(Object.fromEntries(suggested.map((pick) => [
                          keyOf(pick.batchNumber, pick.expiryDate),
                          String(pick.qty),
                        ])));
                      }}
                      className="gap-1.5"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      {isArabic ? `استخدام اقتراح ${modeLabel}` : `Use ${modeLabel} proposal`}
                    </Button>
                  </div>
                )}
                {kind === "sale" && canManuallyPick && (
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      disabled={!canApply}
                      onClick={() => {
                        onChange?.(cleanPicks(draft));
                        setOpen(false);
                      }}
                      data-testid={`button-apply-batches-${rowId}`}
                      className="gap-1.5"
                    >
                      <Check className="h-3.5 w-3.5" />
                      {isArabic ? "تطبيق التوزيع اليدوي" : "Apply manual allocation"}
                    </Button>
                  </div>
                )}
                {kind === "return" && (
                  <p className="text-xs text-muted-foreground">
                    {isArabic ? "هذا توزيع معاينة؛ الترحيل يعيد التحقق من الكميات المرتجعة والدفعات الأصلية." : "This is a preview; posting rechecks returned quantities and original batches."}
                  </p>
                )}
              </div>
            </DialogContent>
          </Dialog>
          {value != null && (
            <span className={`text-[10px] ${sameAsSuggestion ? "text-muted-foreground" : "font-semibold text-amber-700"}`}>
              {sameAsSuggestion ? (isArabic ? "مطابق للاقتراح" : "Matches proposal") : (isArabic ? "اختيار يدوي" : "Manual selection")}
            </span>
          )}
        </>
      ) : null}
    </div>
  );
}