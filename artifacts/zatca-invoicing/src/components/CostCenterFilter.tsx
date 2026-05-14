/**
 * Cost-Center Filter for reports — searchable MULTI-select combobox.
 *
 * Contract:
 *   <CostCenterFilter value={ccIds} onChange={setCcIds} />
 *
 *   - `value: number[]`            → empty array ⇒ "All cost centers"
 *   - `onChange(ids: number[])`    → wire into the React-Query queryKey,
 *      the API querystring (`costCenterId`, comma-separated), and any
 *      export builder so exports match the on-screen rows.
 *
 * The backend (`/api/accounting-reports/...?costCenterId=3,7,12`) splits
 * the CSV and applies a single `IN (...)` filter on
 * `journal_entry_lines.cost_center` (text column, stringified id). A
 * single id passed in keeps backward compatibility — the same parser
 * handles both shapes.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Target, Check, ChevronsUpDown, X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { useCostCenters } from "@/hooks/useCostCenters";
import { cn } from "@/lib/utils";

interface Props {
  value: number[];
  onChange: (costCenterIds: number[]) => void;
  className?: string;
  showLabel?: boolean;
  size?: "sm" | "md";
}

export default function CostCenterFilter({
  value, onChange, className, showLabel = true, size = "md",
}: Props) {
  const { t, i18n } = useTranslation();
  const { data: centers = [], isLoading } = useCostCenters();
  const isAr = i18n.language?.startsWith("ar");
  const [open, setOpen] = useState(false);

  // Index by id once so the trigger label & chip removal are O(1).
  const ccById = useMemo(() => {
    const m = new Map<number, any>();
    for (const c of centers) m.set(c.id, c);
    return m;
  }, [centers]);

  const selectedCount = value.length;
  const allLabel = t("common.allCostCenters", "كل مراكز التكلفة");

  // Trigger label: "all" sentinel when nothing is picked, the single
  // selected centre when only one, otherwise an Arabic-aware count
  // ("3 مراكز محددة"). Long labels are truncated by the trigger styles.
  const triggerLabel = (() => {
    if (selectedCount === 0) return allLabel;
    if (selectedCount === 1) {
      const c = ccById.get(value[0]);
      return c
        ? `${c.code} — ${(isAr ? c.nameAr : (c.nameEn || c.nameAr)) || c.code}`
        : String(value[0]);
    }
    return isAr
      ? `${selectedCount} مراكز محددة`
      : `${selectedCount} centers selected`;
  })();

  const toggle = (id: number) => {
    onChange(value.includes(id) ? value.filter(v => v !== id) : [...value, id]);
  };
  const clearAll = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    onChange([]);
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      {showLabel && (
        <Label className="text-xs flex items-center gap-1.5 text-muted-foreground">
          <Target className="h-3.5 w-3.5" />
          {t("nav.costCenters", "مراكز التكلفة")}
        </Label>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={isLoading}
            className={cn(
              size === "sm" ? "h-8 text-xs" : "h-9 text-sm",
              "min-w-[180px] w-full justify-between font-normal",
              selectedCount === 0 && "text-muted-foreground",
            )}
          >
            <span className="truncate">{triggerLabel}</span>
            <span className="flex items-center gap-1 shrink-0">
              {selectedCount > 0 && (
                <span
                  role="button"
                  aria-label={t("common.clear", "مسح")}
                  onClick={clearAll}
                  className="opacity-60 hover:opacity-100 hover:text-destructive p-0.5 rounded"
                >
                  <X className="h-3.5 w-3.5" />
                </span>
              )}
              <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-[280px]" align="start">
          <Command
            // Match against code AND name so users can type either.
            filter={(itemValue, search) => {
              return itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
            }}
          >
            <CommandInput placeholder={t("common.searchCostCenter", "بحث بالكود أو الاسم...")} className="h-9" />
            <CommandList>
              <CommandEmpty>{t("common.noResults", "لا توجد نتائج")}</CommandEmpty>
              <CommandGroup>
                {/* "Select all / Clear" pseudo row — toggles between
                    every cost-centre id and an empty filter. Picking
                    "all" actually populates `value` with every id so
                    downstream UI (e.g. the cost-centre column on the
                    Account Statement) treats it as an explicit pick. */}
                <CommandItem
                  value="__all__ كل المراكز all centers"
                  onSelect={() => {
                    const allIds = centers.map(c => c.id);
                    const allSelected = allIds.length > 0 && value.length === allIds.length;
                    onChange(allSelected ? [] : allIds);
                  }}
                  className="font-medium"
                >
                  <Check
                    className={cn(
                      "h-4 w-4",
                      centers.length > 0 && value.length === centers.length ? "opacity-100" : "opacity-0",
                      isAr ? "ml-2" : "mr-2",
                    )}
                  />
                  {allLabel}
                  {centers.length > 0 && (
                    <span className="ms-auto text-[10px] text-muted-foreground font-mono">
                      {centers.length}
                    </span>
                  )}
                </CommandItem>
                {centers.map((c) => {
                  const checked = value.includes(c.id);
                  const name = (isAr ? c.nameAr : (c.nameEn || c.nameAr)) || c.code;
                  return (
                    <CommandItem
                      key={c.id}
                      value={`${c.code} ${c.nameAr ?? ""} ${c.nameEn ?? ""}`}
                      onSelect={() => toggle(c.id)}
                    >
                      <Check className={cn("h-4 w-4", checked ? "opacity-100" : "opacity-0", isAr ? "ml-2" : "mr-2")} />
                      <span className="font-mono text-xs text-muted-foreground me-2">{c.code}</span>
                      <span className="truncate">{name}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Chip strip for picked centres — visible only when 2+ selected so
          the single-selected case stays compact. Each chip removes its
          own id; the "X" on the trigger clears the whole list. */}
      {selectedCount > 1 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {value.map(id => {
            const c = ccById.get(id);
            if (!c) return null;
            return (
              <Badge key={id} variant="secondary" className="gap-1 font-normal">
                <span className="font-mono text-[10px]">{c.code}</span>
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  className="hover:text-destructive"
                  aria-label={t("common.remove", "إزالة")}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}
    </div>
  );
}
