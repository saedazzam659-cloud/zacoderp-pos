"use client";

import * as React from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { advanceFocusFrom } from "@/hooks/useEnterAdvances";

export interface ComboboxItem {
  value: string;
  code?: string;
  label: string;
  labelEn?: string;
  description?: string;
  group?: string;
  badge?: string;
  badgeClass?: string;
  disabled?: boolean;
  disabledReason?: string;
}

interface SearchComboboxProps {
  items: ComboboxItem[];
  value?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  disabled?: boolean;
  grouped?: boolean;
  autoFocus?: boolean;
  renderSelected?: (item: ComboboxItem) => React.ReactNode;
  renderItem?: (item: ComboboxItem, selected: boolean) => React.ReactNode;
}

export function SearchCombobox({
  items,
  value,
  onValueChange,
  placeholder = "اختر...",
  searchPlaceholder,
  emptyText = "لا توجد نتائج",
  className,
  disabled,
  grouped,
  autoFocus,
  renderSelected: _renderSelected,
  renderItem,
}: SearchComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const selectedItem = items.find(i => i.value === value);

  // Display value: show search if user is typing/popover open, else just the
  // selected label. The code (when present) is shown as a colored badge in the
  // dropdown — no need to repeat it inside the (often narrow) input.
  const displayValue = open
    ? search
    : selectedItem
      ? selectedItem.label
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
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter(
      item =>
        (item.code?.toLowerCase().includes(q)) ||
        item.label.toLowerCase().includes(q) ||
        item.labelEn?.toLowerCase().includes(q) ||
        item.description?.toLowerCase().includes(q) ||
        item.value.toLowerCase().includes(q)
    );
  }, [items, search]);

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
    onValueChange(val);
    setOpen(false);
    setSearch("");
    if (advance) {
      // After committing a selection via Enter, jump to the next form
      // control just like a normal Enter-as-Tab would. Defer one tick so
      // React commits the value/close before focus moves.
      const el = inputRef.current;
      setTimeout(() => advanceFocusFrom(el), 0);
    }
  };

  const moveHighlight = (dir: 1 | -1) => {
    if (flatList.length === 0) return;
    let i = highlight;
    for (let step = 0; step < flatList.length; step++) {
      i = (i + dir + flatList.length) % flatList.length;
      if (!flatList[i]?.disabled) { setHighlight(i); return; }
    }
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onValueChange("");
    setSearch("");
    setOpen(true);
    inputRef.current?.focus();
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
      // Enter when the popover is open: pick the currently highlighted row
      // (defaults to the first enabled item, so opening + Enter immediately
      // selects the first option) and then advance to the next form field.
      // Enter when closed: let the event bubble so the global handler
      // advances focus normally.
      if (open && flatList[highlight]) {
        e.preventDefault();
        e.stopPropagation();
        handleSelect(flatList[highlight].value, /*advance*/ true);
      } else if (open) {
        // Open with no items — just close and let the global handler run.
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setSearch("");
      inputRef.current?.blur();
    } else if (e.key === "Tab") {
      setOpen(false);
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className={cn("relative w-full", className)}>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            disabled={disabled}
            value={displayValue}
            placeholder={selectedItem ? "" : (searchPlaceholder ?? placeholder)}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onChange={e => {
              setSearch(e.target.value);
              if (!open) setOpen(true);
            }}
            onKeyDown={onKeyDown}
            dir="auto"
            className={cn(
              "flex h-9 w-full rounded-md border border-input bg-background px-3 pe-14 text-sm text-foreground shadow-sm",
              "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          />
          <div className="absolute inset-y-0 end-2 flex items-center gap-1 pointer-events-none">
            {selectedItem && !open && (
              <button
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={handleClear}
                className="pointer-events-auto rounded p-0.5 hover:bg-muted text-muted-foreground"
                tabIndex={-1}
                aria-label="مسح"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
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
        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {flatList.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">{emptyText}</div>
          ) : grouped && groups ? (
            Array.from(groups.entries()).map(([groupName, groupItems], gi) => (
              <div key={groupName}>
                {gi > 0 && <div className="my-1 h-px bg-border" />}
                {groupName && (
                  <div className="px-3 py-1 text-[10px] font-semibold text-muted-foreground uppercase">{groupName}</div>
                )}
                {groupItems.map(item => {
                  const idx = renderedIdx++;
                  const isHi = idx === highlight;
                  const dis = !!item.disabled;
                  return (
                    <div
                      key={item.value}
                      data-idx={idx}
                      title={dis ? (item.disabledReason ?? "غير قابل للاختيار") : undefined}
                      onMouseDown={e => { e.preventDefault(); if (!dis) handleSelect(item.value); }}
                      onMouseEnter={() => { if (!dis) setHighlight(idx); }}
                      aria-disabled={dis}
                      className={cn(
                        "px-2 py-2 text-sm rounded-sm mx-1",
                        dis
                          ? "opacity-50 cursor-not-allowed select-none"
                          : "cursor-pointer " + (isHi ? "bg-accent text-accent-foreground" : "hover:bg-muted/60")
                      )}
                    >
                      {renderItem
                        ? renderItem(item, item.value === value)
                        : <DefaultItemRender item={item} sel={item.value === value} />}
                    </div>
                  );
                })}
              </div>
            ))
          ) : (
            flatList.map((item, idx) => {
              const isHi = idx === highlight;
              const dis = !!item.disabled;
              return (
                <div
                  key={item.value}
                  data-idx={idx}
                  title={dis ? (item.disabledReason ?? "غير قابل للاختيار") : undefined}
                  onMouseDown={e => { e.preventDefault(); if (!dis) handleSelect(item.value); }}
                  onMouseEnter={() => { if (!dis) setHighlight(idx); }}
                  aria-disabled={dis}
                  className={cn(
                    "px-2 py-2 text-sm rounded-sm mx-1",
                    dis
                      ? "opacity-50 cursor-not-allowed select-none"
                      : "cursor-pointer " + (isHi ? "bg-accent text-accent-foreground" : "hover:bg-muted/60")
                  )}
                >
                  {renderItem
                    ? renderItem(item, item.value === value)
                    : <DefaultItemRender item={item} sel={item.value === value} />}
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
