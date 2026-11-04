"use client";

import * as React from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { advanceFocusFrom } from "@/hooks/useEnterAdvances";
import { useTranslation } from "react-i18next";

export interface ComboboxItem {
  value: string;
  code?: string;
  barcode?: string;
  label: string;
  labelEn?: string;
  description?: string;
  group?: string;
  badge?: string;
  badgeClass?: string;
  disabled?: boolean;
  /** Show a clear button when a value is selected. */
  clearable?: boolean;
  disabledReason?: string;
  /** Original row data retained by multi-select when remote search changes. */
  rawItem?: unknown;
}

interface SearchComboboxProps {
  items: ComboboxItem[];
  value?: string;
  onValueChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  disabled?: boolean;
  clearable?: boolean;
  /**
   * Dialog focus management focuses the first form control when content
   * mounts. Callers can keep that initial focus from opening the popover while
   * preserving click/keyboard opening for searchable fields inside dialogs.
   */
  openOnFocus?: boolean;
  grouped?: boolean;
  autoFocus?: boolean;
  advanceOnEnter?: boolean;
  onSearchEnter?: (search: string) => boolean | Promise<boolean>;
  testId?: string;
  renderSelected?: (item: ComboboxItem) => React.ReactNode;
  renderItem?: (item: ComboboxItem, selected: boolean) => React.ReactNode;
  onSearchChange?: (search: string) => void;
  loading?: boolean;
  /** Optional compact action rendered inside the existing trailing icon gutter. */
  endAdornment?: React.ReactNode;
  /** Turn the result rows into checkboxes and add all checked values together. */
  onAddSelected?: (values: string[], items: ComboboxItem[]) => void | Promise<void>;
  /** Immediately add one result on double-click while leaving other checked rows selected. */
  onItemDoubleClick?: (item: ComboboxItem) => void | Promise<void>;
}

export function SearchCombobox({
  items,
  value,
  onValueChange,
  id,
  placeholder,
  searchPlaceholder,
  emptyText,
  className,
  disabled,
  clearable = false,
  openOnFocus = true,
  grouped,
  autoFocus,
  advanceOnEnter = true,
  onSearchEnter,
  testId,
  renderSelected: _renderSelected,
  renderItem,
  onSearchChange,
  loading = false,
  endAdornment,
  onAddSelected,
  onItemDoubleClick,
}: SearchComboboxProps) {
  const { i18n } = useTranslation();
  const isEnglish = i18n.language?.toLowerCase().startsWith("en") ?? false;
  const defaultSearchPlaceholder = isEnglish ? "Search..." : "ابحث...";
  const defaultEmptyText = isEnglish ? "No results" : "لا توجد نتائج";
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);
  const [multiSelectedValues, setMultiSelectedValues] = React.useState<string[]>([]);
  const [multiSelectedItems, setMultiSelectedItems] = React.useState<Record<string, ComboboxItem>>({});
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      if (search) {
        setSearch("");
        onSearchChange?.("");
      }
      setMultiSelectedValues([]);
      setMultiSelectedItems({});
    }
  };

  const localizedItem = React.useCallback((item: ComboboxItem): ComboboxItem => ({
    ...item,
    label: isEnglish ? (item.labelEn?.trim() || item.label) : item.label,
    // A selected-language label is shown, not a second-language subtitle.
    labelEn: undefined,
  }), [isEnglish]);
  const selectedItem = items.find(i => i.value === value);

  // Display value: show search if user is typing/popover open, else just the
  // selected label. The code (when present) is shown as a colored badge in the
  // dropdown — no need to repeat it inside the (often narrow) input.
  const displayValue = open
    ? search
    : selectedItem
      ? localizedItem(selectedItem).label
      : "";

  React.useEffect(() => {
    if (!autoFocus) return;
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
    }, 100);
    return () => clearTimeout(t);
  }, [autoFocus]);

  const filteredItems = React.useMemo(() => {
    // Remote-search callers have already filtered and ranked this bounded list.
    // Filtering it again by the visible label can discard valid server matches
    // (for example, an English query on an Arabic-labeled item).
    if (onSearchChange || !search) return items.map(localizedItem);
    const q = search.toLowerCase();
    return items.filter(
      item =>
        (item.code?.toLowerCase().includes(q)) ||
        item.label.toLowerCase().includes(q) ||
        item.labelEn?.toLowerCase().includes(q) ||
        item.description?.toLowerCase().includes(q) ||
        item.value.toLowerCase().includes(q)
     ).map(localizedItem);
  }, [items, localizedItem, onSearchChange, search]);

  React.useEffect(() => {
    // Snap highlight onto the first enabled row whenever the filter changes
    // or the popover opens, so Enter/click never lands on a disabled item.
    const firstEnabled = filteredItems.findIndex(it => !it.disabled);
    setHighlight(firstEnabled === -1 ? 0 : firstEnabled);
  }, [search, open, filteredItems]);

  const groups = React.useMemo(() => {
    if (!grouped) return null;
    const map = new Map<string, ComboboxItem[]>();
    for (const item of filteredItems) {
      const g = item.group ?? "";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(item);
    }
    return map;
  }, [filteredItems, grouped]);

  const flatList = filteredItems;

  const handleSelect = (val: string, advance: boolean = false) => {
    const it = items.find(i => i.value === val);
    if (it?.disabled) return;
    if (onAddSelected) {
      setMultiSelectedValues(current => current.includes(val)
        ? current.filter(value => value !== val)
        : [...current, val]);
      setMultiSelectedItems(current => {
        const next = { ...current };
        if (next[val]) delete next[val];
        else if (it) next[val] = it;
        return next;
      });
      return;
    }
    onValueChange(val);
    setOpen(false);
    setSearch("");
    onSearchChange?.("");
    if (advance) {
      // After committing a selection via Enter, jump to the next form
      // control just like a normal Enter-as-Tab would. Defer one tick so
      // React commits the value/close before focus moves.
      const el = inputRef.current;
      setTimeout(() => advanceFocusFrom(el), 0);
    }
  };

  const addQuickly = (item: ComboboxItem) => {
    if (item.disabled || !onAddSelected || !onItemDoubleClick) return;
    setMultiSelectedValues(current => current.filter(value => value !== item.value));
    setMultiSelectedItems(current => {
      const next = { ...current };
      delete next[item.value];
      return next;
    });
    void Promise.resolve(onItemDoubleClick(item)).catch(error => {
      console.error("[SearchCombobox] could not add item quickly", error);
    });
  };

  const commitHighlightedItem = (item: ComboboxItem, advance = false) => {
    if (onAddSelected && onItemDoubleClick) {
      addQuickly(item);
      return;
    }
    handleSelect(item.value, advance);
  };

  const renderOption = (item: ComboboxItem, idx: number) => {
    const isHi = idx === highlight;
    const dis = !!item.disabled;
    const selected = onAddSelected
      ? multiSelectedValues.includes(item.value)
      : item.value === value;
    return (
      <div
        key={item.value}
        data-idx={idx}
        title={dis ? (item.disabledReason ?? (isEnglish ? "Not selectable" : "غير قابل للاختيار")) : undefined}
        onMouseDown={e => {
          if (dis) {
            e.preventDefault();
            return;
          }
          if (onAddSelected && (e.target as HTMLElement).closest('input[type="checkbox"]')) return;
          e.preventDefault();
          handleSelect(item.value);
        }}
        onDoubleClick={e => {
          if (dis || !onAddSelected || !onItemDoubleClick) return;
          if ((e.target as HTMLElement).closest('input[type="checkbox"]')) return;
          e.preventDefault();
          addQuickly(item);
        }}
        onMouseEnter={() => { if (!dis) setHighlight(idx); }}
        aria-disabled={dis}
        aria-selected={selected}
        role="option"
        className={cn(
          "px-2 py-2 text-sm rounded-sm mx-1",
          onAddSelected && "flex items-start gap-2",
          dis
            ? "opacity-50 cursor-not-allowed select-none"
            : "cursor-pointer " + (isHi ? "bg-accent text-accent-foreground" : "hover:bg-muted/60")
        )}
      >
        {onAddSelected && (
          <input
            type="checkbox"
            checked={selected}
            disabled={dis}
            aria-label={isEnglish ? `Select ${item.label}` : `اختيار ${item.label}`}
            data-testid={testId ? `${testId}-multi-${item.value}` : `search-combobox-multi-${item.value}`}
            className="h-4 w-4 shrink-0 align-middle accent-primary"
            onMouseDown={event => event.stopPropagation()}
            onChange={() => handleSelect(item.value)}
          />
        )}
        {renderItem
          ? renderItem(item, selected)
          : <DefaultItemRender item={item} sel={selected} />}
      </div>
    );
  };

  const moveHighlight = (dir: 1 | -1) => {
    if (flatList.length === 0) return;
    let i = highlight;
    for (let step = 0; step < flatList.length; step++) {
      i = (i + dir + flatList.length) % flatList.length;
      if (!flatList[i]?.disabled) { setHighlight(i); return; }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      moveHighlight(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveHighlight(-1);
    } else if (e.key === "Enter") {
      if (open && search.trim() && onSearchEnter) {
        e.preventDefault();
        e.stopPropagation();
        const currentSearch = search;
        void Promise.resolve(onSearchEnter(currentSearch))
          .then(handled => {
            if (!handled && flatList[highlight]) {
              commitHighlightedItem(flatList[highlight], advanceOnEnter);
            }
          })
          .catch(() => {
            if (flatList[highlight]) commitHighlightedItem(flatList[highlight], advanceOnEnter);
          });
        return;
      }
      // Enter when the popover is open: pick the currently highlighted row
      // (defaults to the first enabled item, so opening + Enter immediately
      // selects the first option) and then advance to the next form field.
      // Enter when closed: let the event bubble so the global handler
      // advances focus normally.
      if (open && flatList[highlight]) {
        e.preventDefault();
        e.stopPropagation();
        commitHighlightedItem(flatList[highlight], advanceOnEnter);
      } else if (open) {
        // Open with no items — just close and let the global handler run.
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setSearch("");
      onSearchChange?.("");
      inputRef.current?.blur();
    } else if (e.key === "Tab") {
      setOpen(false);
      setSearch("");
      onSearchChange?.("");
    }
  };

  // Scroll highlighted item into view
  React.useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const DefaultItemRender = ({ item, sel }: { item: ComboboxItem; sel: boolean }) => (
    <div className="flex items-start gap-2 w-full">
      <Check className={cn("h-3.5 w-3.5 mt-0.5 shrink-0 text-primary", sel ? "opacity-100" : "opacity-0")} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {item.code && (
            <span className="font-mono text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded border border-primary/20 shrink-0">
              {item.code}
            </span>
          )}
          {item.badge && (
            <span className={cn("text-[10px] px-1.5 py-0.5 rounded border shrink-0", item.badgeClass ?? "bg-muted text-muted-foreground")}>
              {item.badge}
            </span>
          )}
          <span className="font-medium text-sm">{item.label}</span>
        </div>
        {item.labelEn && (
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate" dir="ltr">{item.labelEn}</p>
        )}
        {item.description && (
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{item.description}</p>
        )}
      </div>
    </div>
  );

  let renderedIdx = 0;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>
        <div className={cn("relative w-full", className)}>
          <input
            ref={inputRef}
            id={id}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            data-testid={testId}
            disabled={disabled}
            value={displayValue}
            placeholder={selectedItem ? "" : (searchPlaceholder ?? placeholder ?? defaultSearchPlaceholder)}
            onFocus={() => { if (openOnFocus) setOpen(true); }}
            onClick={() => setOpen(true)}
            onChange={e => {
              setSearch(e.target.value);
              onSearchChange?.(e.target.value);
              if (!open) setOpen(true);
            }}
            onKeyDown={onKeyDown}
            dir="auto"
            className={cn(
              // Use purely *logical* padding (ps/pe) — mixing physical `px-3`
              // with `pe-14` makes both target the same side in RTL, so the
              // physical rule wins and the reserved space for the clear/chevron
              // icons collapses, overlapping the selected text. ps-3 + pe-14
              // keeps a clean 0.75rem start gap and 3.5rem icon gutter in both
              // RTL and LTR.
              "flex h-9 w-full rounded-md border border-input bg-background ps-3 pe-14 text-sm text-foreground shadow-sm",
              "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          />
          {clearable && selectedItem && !disabled && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={isEnglish ? "Clear selection" : "مسح الاختيار"}
              data-testid={testId ? `${testId}-clear` : undefined}
              className="pointer-events-auto rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onMouseDown={e => {
                e.preventDefault();
                e.stopPropagation();
                onValueChange("");
                setSearch("");
                onSearchChange?.("");
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <div className="absolute inset-y-0 end-2 flex items-center gap-1 pointer-events-none">
            {endAdornment && <span className="pointer-events-auto">{endAdornment}</span>}
            <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
          </div>
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0 min-w-[260px]"
        align="start"
        side="bottom"
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <div ref={listRef} role="listbox" aria-multiselectable={!!onAddSelected} className="max-h-72 overflow-y-auto py-1">
          {loading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">{isEnglish ? "Searching..." : "جارٍ البحث عن الأصناف..."}</div>
          ) : flatList.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">{emptyText ?? defaultEmptyText}</div>
          ) : grouped && groups ? (
            Array.from(groups.entries()).map(([groupName, groupItems], gi) => (
              <div key={groupName}>
                {gi > 0 && <div className="my-1 h-px bg-border" />}
                {groupName && (
                  <div className="px-3 py-1 text-[10px] font-semibold text-muted-foreground uppercase">{groupName}</div>
                )}
                {groupItems.map(item => renderOption(item, renderedIdx++))}
              </div>
            ))
          ) : (
            flatList.map((item, idx) => renderOption(item, idx))
          )}
        </div>
        {onAddSelected && (
          <div className="flex items-center justify-between gap-2 border-t p-2">
            <div className="min-w-0">
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {isEnglish
                  ? `${multiSelectedValues.length} selected`
                  : `${multiSelectedValues.length} صنف محدد`}
              </span>
              {onItemDoubleClick && (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {isEnglish ? "Double-click an item to add it now" : "دبل كليك على الصنف لإضافته مباشرة"}
                </p>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              className="h-8"
              disabled={multiSelectedValues.length === 0 || loading}
              data-testid="button-add-selected-items"
              onClick={() => {
                const selected = [...multiSelectedValues];
                const selectedItems = selected.map(value => multiSelectedItems[value]).filter(Boolean);
                void Promise.resolve(onAddSelected(selected, selectedItems)).then(() => {
                  setMultiSelectedValues([]);
                  setMultiSelectedItems({});
                  setOpen(false);
                  setSearch("");
                  onSearchChange?.("");
                }).catch(error => {
                  console.error("[SearchCombobox] could not add selected items", error);
                });
              }}
            >
              {isEnglish ? "Add selected" : "إضافة المحدد"}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
