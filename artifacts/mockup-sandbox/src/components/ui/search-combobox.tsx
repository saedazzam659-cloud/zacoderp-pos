"use client";

import * as React from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
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
  clearable?: boolean;
  disabledReason?: string;
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
  openOnFocus?: boolean;
  grouped?: boolean;
  autoFocus?: boolean;
  testId?: string;
  renderSelected?: (item: ComboboxItem) => React.ReactNode;
  renderItem?: (item: ComboboxItem, selected: boolean) => React.ReactNode;
}

export function SearchCombobox({
  items,
  value,
  onValueChange,
  id,
  placeholder = "اختر...",
  searchPlaceholder,
  emptyText = "لا توجد نتائج",
  className,
  disabled,
  clearable = false,
  openOnFocus = true,
  grouped,
  autoFocus,
  testId,
  renderItem,
}: SearchComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const selectedItem = items.find(item => item.value === value);
  const displayValue = open ? search : selectedItem ? selectedItem.label : "";

  React.useEffect(() => {
    if (!autoFocus) return;
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
    }, 100);
    return () => clearTimeout(timer);
  }, [autoFocus]);

  const filteredItems = React.useMemo(() => {
    if (!search) return items;
    const query = search.toLowerCase();
    return items.filter(item =>
      item.code?.toLowerCase().includes(query) ||
      item.label.toLowerCase().includes(query) ||
      item.labelEn?.toLowerCase().includes(query) ||
      item.description?.toLowerCase().includes(query) ||
      item.value.toLowerCase().includes(query)
    );
  }, [items, search]);

  React.useEffect(() => {
    const firstEnabled = filteredItems.findIndex(item => !item.disabled);
    setHighlight(firstEnabled === -1 ? 0 : firstEnabled);
  }, [search, open, filteredItems]);

  const groups = React.useMemo(() => {
    if (!grouped) return null;
    const map = new Map<string, ComboboxItem[]>();
    for (const item of filteredItems) {
      const group = item.group ?? "";
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(item);
    }
    return map;
  }, [filteredItems, grouped]);

  const handleSelect = (selectedValue: string, advance = false) => {
    const item = items.find(option => option.value === selectedValue);
    if (item?.disabled) return;
    onValueChange(selectedValue);
    setOpen(false);
    setSearch("");
    if (advance) {
      const element = inputRef.current;
      setTimeout(() => advanceFocusFrom(element), 0);
    }
  };

  const moveHighlight = (direction: 1 | -1) => {
    if (filteredItems.length === 0) return;
    let index = highlight;
    for (let step = 0; step < filteredItems.length; step++) {
      index = (index + direction + filteredItems.length) % filteredItems.length;
      if (!filteredItems[index]?.disabled) {
        setHighlight(index);
        return;
      }
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      moveHighlight(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
    } else if (event.key === "Enter") {
      if (open && filteredItems[highlight]) {
        event.preventDefault();
        event.stopPropagation();
        handleSelect(filteredItems[highlight].value, true);
      } else if (open) {
        setOpen(false);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
      setSearch("");
      inputRef.current?.blur();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  React.useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    list.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const renderDefaultItem = (item: ComboboxItem, selected: boolean) => (
    <div className="flex w-full items-start gap-2">
      <Check className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 text-primary", selected ? "opacity-100" : "opacity-0")} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {item.code && <span className="shrink-0 rounded border border-primary/20 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">{item.code}</span>}
          {item.badge && <span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[10px]", item.badgeClass ?? "bg-muted text-muted-foreground")}>{item.badge}</span>}
          <span className="text-sm font-medium">{item.label}</span>
        </div>
        {item.labelEn && <p className="mt-0.5 truncate text-[11px] text-muted-foreground" dir="ltr">{item.labelEn}</p>}
        {item.description && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.description}</p>}
      </div>
    </div>
  );

  let renderedIndex = 0;
  const renderOption = (item: ComboboxItem, index: number) => {
    const selected = item.value === value;
    const highlighted = index === highlight;
    const itemDisabled = !!item.disabled;
    return (
      <div
        key={item.value}
        data-idx={index}
        title={itemDisabled ? item.disabledReason ?? "غير قابل للاختيار" : undefined}
        onMouseDown={event => { event.preventDefault(); if (!itemDisabled) handleSelect(item.value); }}
        onMouseEnter={() => { if (!itemDisabled) setHighlight(index); }}
        aria-disabled={itemDisabled}
        className={cn(
          "mx-1 rounded-sm px-2 py-2 text-sm",
          itemDisabled
            ? "cursor-not-allowed select-none opacity-50"
            : `cursor-pointer ${highlighted ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"}`
        )}
      >
        {renderItem ? renderItem(item, selected) : renderDefaultItem(item, selected)}
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
            placeholder={selectedItem ? "" : (searchPlaceholder ?? placeholder)}
            onFocus={() => { if (openOnFocus) setOpen(true); }}
            onClick={() => setOpen(true)}
            onChange={event => {
              setSearch(event.target.value);
              if (!open) setOpen(true);
            }}
            onKeyDown={onKeyDown}
            dir="auto"
            className={cn(
              "flex h-9 w-full rounded-md border border-input bg-background ps-3 pe-14 text-sm text-foreground shadow-sm",
              "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          />
          {clearable && selectedItem && !disabled && (
            <button
              type="button"
              tabIndex={-1}
              aria-label="مسح الاختيار"
              data-testid={testId ? `${testId}-clear` : undefined}
              className="pointer-events-auto rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onMouseDown={event => {
                event.preventDefault();
                event.stopPropagation();
                onValueChange("");
                setSearch("");
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <div className="pointer-events-none absolute inset-y-0 end-2 flex items-center gap-1">
            <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
          </div>
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-[260px] p-0"
        align="start"
        side="bottom"
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
      >
        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {filteredItems.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">{emptyText}</div>
          ) : grouped && groups ? (
            Array.from(groups.entries()).map(([groupName, groupItems], groupIndex) => (
              <div key={groupName}>
                {groupIndex > 0 && <div className="my-1 h-px bg-border" />}
                {groupName && <div className="px-3 py-1 text-[10px] font-semibold uppercase text-muted-foreground">{groupName}</div>}
                {groupItems.map(item => renderOption(item, renderedIndex++))}
              </div>
            ))
          ) : (
            filteredItems.map((item, index) => renderOption(item, index))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}