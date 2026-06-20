/**
 * Parent-account filter for the General Accounts reports — a searchable
 * MULTI-select of the PARENT (non-posting) accounts from the chart of
 * accounts. Mirrors the look & behaviour of `CostCenterFilter`.
 *
 * Contract:
 *   <AccountParentFilter value={parentIds} onChange={setParentIds} />
 *
 *   - `value: number[]`          → empty array ⇒ "All accounts" (no filter)
 *   - `onChange(ids: number[])`  → the report keeps only rows whose account
 *      is the selected parent OR a descendant of it (see `descendantIds`).
 *
 * Only accounts that are actually a parent of something are offered, since
 * filtering by a leaf account would be identical to picking that single row.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Network, Check, ChevronsUpDown, X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { useAccountTree } from "@/hooks/useAccountTree";
import { cn } from "@/lib/utils";

interface Props {
  value: number[];
  onChange: (parentIds: number[]) => void;
  className?: string;
  showLabel?: boolean;
  size?: "sm" | "md";
}

export default function AccountParentFilter({
  value, onChange, className, showLabel = true, size = "md",
}: Props) {
  const { t, i18n } = useTranslation();
  const { accounts, tree, isLoading } = useAccountTree();
  const isAr = i18n.language?.startsWith("ar");
  const [open, setOpen] = useState(false);

  // Offer ONLY parent accounts (those with children), ordered by code.
  const parents = useMemo(() => {
    return accounts
      .filter((a) => a?.id != null && tree.parentIds.has(Number(a.id)))
      .sort((a, b) => String(a.code ?? "").localeCompare(String(b.code ?? "")));
  }, [accounts, tree]);

  const byId = useMemo(() => {
    const m = new Map<number, any>();
    for (const p of parents) m.set(Number(p.id), p);
    return m;
  }, [parents]);

  const nameOf = (a: any) =>
    ((isAr ? a?.nameAr : (a?.nameEn || a?.nameAr)) || a?.code || "") as string;

  const selectedCount = value.length;
  const allLabel = t("accountParentFilter.all", "كل الحسابات");

  const triggerLabel = (() => {
    if (selectedCount === 0) return allLabel;
    if (selectedCount === 1) {
      const a = byId.get(value[0]);
      return a ? `${a.code} — ${nameOf(a)}` : String(value[0]);
    }
    return isAr ? `${selectedCount} حسابات محددة` : `${selectedCount} accounts selected`;
  })();

  const toggle = (id: number) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };
  const clearAll = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    onChange([]);
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      {showLabel && (
        <Label className="text-xs flex items-center gap-1.5 text-muted-foreground">
          <Network className="h-3.5 w-3.5" />
          {t("accountParentFilter.label", "حسابات الأب")}
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
        <PopoverContent className="p-0 w-[300px]" align="start">
          <Command
            filter={(itemValue, search) =>
              itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
            }
          >
            <CommandInput placeholder={t("accountParentFilter.search", "بحث بالكود أو الاسم...")} className="h-9" />
            <CommandList>
              <CommandEmpty>{t("common.noResults", "لا توجد نتائج")}</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value="__all__ كل الحسابات all accounts"
                  onSelect={() => {
                    const allIds = parents.map((p) => Number(p.id));
                    const allSelected = allIds.length > 0 && value.length === allIds.length;
                    onChange(allSelected ? [] : allIds);
                  }}
                  className="font-medium"
                >
                  <Check
                    className={cn(
                      "h-4 w-4",
                      parents.length > 0 && value.length === parents.length ? "opacity-100" : "opacity-0",
                      isAr ? "ml-2" : "mr-2",
                    )}
                  />
                  {allLabel}
                  {parents.length > 0 && (
                    <span className="ms-auto text-[10px] text-muted-foreground font-mono">
                      {parents.length}
                    </span>
                  )}
                </CommandItem>
                {parents.map((a) => {
                  const id = Number(a.id);
                  const checked = value.includes(id);
                  return (
                    <CommandItem
                      key={id}
                      value={`${a.code ?? ""} ${a.nameAr ?? ""} ${a.nameEn ?? ""}`}
                      onSelect={() => toggle(id)}
                    >
                      <Check className={cn("h-4 w-4", checked ? "opacity-100" : "opacity-0", isAr ? "ml-2" : "mr-2")} />
                      <span className="font-mono text-xs text-muted-foreground me-2">{a.code}</span>
                      <span className="truncate">{nameOf(a)}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selectedCount > 1 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {value.map((id) => {
            const a = byId.get(id);
            if (!a) return null;
            return (
              <Badge key={id} variant="secondary" className="gap-1 font-normal">
                <span className="font-mono text-[10px]">{a.code}</span>
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
