import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface InvoiceSettlementOption {
  id: string;
  label: string;
  description: string;
  currencyCode: string;
  remainingAmount: number;
}

interface InvoiceSettlementPickerProps {
  options: InvoiceSettlementOption[];
  selectedIds: string[];
  percentages: Record<string, string>;
  voucherAmount: string;
  onSelectionChange: (invoiceIds: string[]) => void;
  onPercentageChange: (invoiceId: string, value: string) => void;
  disabled?: boolean;
  tone: "payment" | "receipt";
}

function percentageAmountShares(
  amount: number,
  invoiceIds: string[],
  percentages: Record<string, string>,
): Record<string, string> {
  const values = invoiceIds.map((id) => Math.max(0, Number(percentages[id]) || 0));
  const totalPercentage = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(amount) || amount <= 0 || totalPercentage <= 0) {
    return Object.fromEntries(invoiceIds.map((id) => [id, "0.00"]));
  }

  const totalCents = Math.round(amount * 100);
  const exactCents = values.map((value) => totalCents * value / totalPercentage);
  const cents = exactCents.map(Math.floor);
  let remaining = totalCents - cents.reduce((sum, value) => sum + value, 0);
  const order = exactCents
    .map((value, index) => ({ index, remainder: value - cents[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < remaining; i += 1) cents[order[i % order.length].index] += 1;
  return Object.fromEntries(invoiceIds.map((id, index) => [id, (cents[index] / 100).toFixed(2)]));
}

export function InvoiceSettlementPicker({
  options,
  selectedIds,
  percentages,
  voucherAmount,
  onSelectionChange,
  onPercentageChange,
  disabled = false,
  tone,
}: InvoiceSettlementPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedOptions = selectedIds
    .map((id) => options.find((option) => option.id === id))
    .filter((option): option is InvoiceSettlementOption => Boolean(option));
  const selectedCurrency = selectedOptions[0]?.currencyCode.trim().toUpperCase() ?? "";
  const normalizedPercentages = selectedIds.map((id) => Number(percentages[id]));
  const percentageTotal = normalizedPercentages.reduce(
    (sum, value) => sum + (Number.isFinite(value) ? value : 0),
    0,
  );
  const isPercentageValid = selectedIds.length > 1
    && normalizedPercentages.every((value) => Number.isFinite(value) && value > 0 && value <= 100)
    && Math.abs(percentageTotal - 100) < 0.005;
  const amountShares = useMemo(
    () => percentageAmountShares(Number(voucherAmount), selectedIds, percentages),
    [voucherAmount, selectedIds, percentages],
  );

  const filteredOptions = options.filter((option) => {
    const needle = search.trim().toLowerCase();
    return !needle || `${option.label} ${option.description} ${option.currencyCode}`.toLowerCase().includes(needle);
  });
  const toneClass = tone === "payment"
    ? {
        border: "border-red-200",
        icon: "text-red-700",
        panel: "border-red-200 bg-red-50/50",
        badge: "border-red-200 bg-red-100 text-red-800",
        input: "focus-visible:ring-red-500",
      }
    : {
        border: "border-emerald-200",
        icon: "text-emerald-700",
        panel: "border-emerald-200 bg-emerald-50/50",
        badge: "border-emerald-200 bg-emerald-100 text-emerald-800",
        input: "focus-visible:ring-emerald-500",
      };

  function toggleInvoice(invoiceId: string) {
    if (selectedIds.includes(invoiceId)) {
      onSelectionChange(selectedIds.filter((id) => id !== invoiceId));
      return;
    }
    onSelectionChange([...selectedIds, invoiceId]);
  }

  return (
    <div className="space-y-3" data-testid="invoice-settlement-picker">
      <div className="flex gap-2">
        <Popover open={open} onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setSearch("");
        }}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              aria-expanded={open}
              className={cn("h-10 min-w-0 flex-1 justify-between font-normal", toneClass.border)}
              data-testid="invoice-settlement-trigger"
            >
              <span className="truncate text-start">
                {selectedIds.length === 0
                  ? t("cashInvoiceAllocation.selectPlaceholder")
                  : selectedIds.length === 1
                    ? (selectedOptions[0]?.label ?? `#${selectedIds[0]}`)
                    : t("cashInvoiceAllocation.selectedCount", { count: selectedIds.length })}
              </span>
              <ChevronDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(92vw,28rem)] p-2">
            <div className="relative mb-2">
              <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("cashInvoiceAllocation.searchPlaceholder")}
                className="ps-9"
                aria-label={t("cashInvoiceAllocation.searchPlaceholder")}
              />
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {filteredOptions.map((option) => {
                const selected = selectedIds.includes(option.id);
                const compatible = !selectedCurrency
                  || option.currencyCode.trim().toUpperCase() === selectedCurrency;
                const optionDisabled = disabled || (!compatible && !selected);
                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={optionDisabled}
                    onClick={() => toggleInvoice(option.id)}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-start transition-colors",
                      selected ? "bg-primary/10" : "hover:bg-muted",
                      optionDisabled && "cursor-not-allowed opacity-45",
                    )}
                    aria-pressed={selected}
                  >
                    <span className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                    )}>
                      {selected && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{option.label}</span>
                        {!compatible && <span className="shrink-0 text-[10px] text-muted-foreground">{t("cashInvoiceAllocation.differentCurrency")}</span>}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {option.description}
                      </span>
                      <span className="mt-0.5 block text-[11px] font-medium text-foreground/75">
                        {t("cashInvoiceAllocation.openBalance", {
                          amount: option.remainingAmount.toFixed(2),
                          currency: option.currencyCode || "SAR",
                        })}
                      </span>
                    </span>
                  </button>
                );
              })}
              {filteredOptions.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t("cashInvoiceAllocation.noInvoices")}
                </p>
              )}
            </div>
            <p className="mt-2 border-t pt-2 text-[11px] text-muted-foreground">
              {t("cashInvoiceAllocation.currencyRule")}
            </p>
          </PopoverContent>
        </Popover>
        {selectedIds.length > 0 && !disabled && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => onSelectionChange([])}
            title={t("cashInvoiceAllocation.clearSelection")}
            aria-label={t("cashInvoiceAllocation.clearSelection")}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {selectedIds.length > 1 && (
        <div className={cn("space-y-3 rounded-lg border p-3", toneClass.panel)} data-testid="invoice-allocation-panel">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs font-semibold">{t("cashInvoiceAllocation.distributionTitle")}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {t("cashInvoiceAllocation.distributionHelp")}
              </p>
            </div>
            <span className={cn(
              "rounded-full border px-2 py-1 text-[11px] font-semibold tabular-nums",
              isPercentageValid ? toneClass.badge : "border-destructive/30 bg-destructive/10 text-destructive",
            )}>
              {t("cashInvoiceAllocation.totalPercentage", { value: percentageTotal.toFixed(2) })}
            </span>
          </div>

          <div className="space-y-2">
            {selectedIds.map((id) => {
              const option = options.find((item) => item.id === id);
              return (
                <div
                  key={id}
                  className="grid grid-cols-[minmax(0,1fr)_5.5rem_6.5rem] items-center gap-2 rounded-md bg-background/80 px-2.5 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold">{option?.label ?? `#${id}`}</p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {option ? `${option.remainingAmount.toFixed(2)} ${option.currencyCode || "SAR"}` : ""}
                    </p>
                  </div>
                  <div>
                    <label className="sr-only" htmlFor={`invoice-percent-${id}`}>
                      {t("cashInvoiceAllocation.percentageLabel")} — {option?.label ?? id}
                    </label>
                    <Input
                      id={`invoice-percent-${id}`}
                      data-testid={`invoice-allocation-percent-${id}`}
                      type="number"
                      min="0.000001"
                      max="100"
                      step="0.000001"
                      value={percentages[id] ?? ""}
                      onChange={(event) => onPercentageChange(id, event.target.value)}
                      disabled={disabled}
                      className={cn("h-8 px-2 text-end text-xs tabular-nums", toneClass.input)}
                    />
                  </div>
                  <div className="text-end">
                    <p className="text-[10px] text-muted-foreground">{t("cashInvoiceAllocation.allocatedLabel")}</p>
                    <p className="font-mono text-xs font-semibold tabular-nums">{amountShares[id] ?? "0.00"}</p>
                  </div>
                </div>
              );
            })}
          </div>
          {!isPercentageValid && (
            <p className="text-[11px] font-medium text-destructive" role="alert">
              {t("cashInvoiceAllocation.percentagesMustTotal")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
