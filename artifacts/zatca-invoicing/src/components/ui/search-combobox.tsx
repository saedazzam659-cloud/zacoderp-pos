"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface ComboboxItem {
  value: string;
  code?: string;
  label: string;
  labelEn?: string;
  description?: string;
  group?: string;
  badge?: string;
  badgeClass?: string;
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
  searchPlaceholder = "ابحث بالكود أو الاسم...",
  emptyText = "لا توجد نتائج",
  className,
  disabled,
  grouped,
  autoFocus,
  renderSelected,
  renderItem,
}: SearchComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!autoFocus) return;
    const t = setTimeout(() => {
      triggerRef.current?.focus();
      setOpen(true);
    }, 100);
    return () => clearTimeout(t);
  }, [autoFocus]);

  const selectedItem = items.find(i => i.value === value);

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

  const handleSelect = (val: string) => {
    onValueChange(val);
    setOpen(false);
    setSearch("");
  };

  const DefaultSelectedRender = ({ item }: { item?: ComboboxItem }) => {
    if (!item) return <span className="text-muted-foreground">{placeholder}</span>;
    return (
      <span className="flex items-center gap-2 truncate">
        {item.code && (
          <span className="font-mono text-[11px] bg-muted px-1.5 py-0.5 rounded border text-muted-foreground shrink-0">
            {item.code}
          </span>
        )}
        <span className="truncate">{item.label}</span>
      </span>
    );
  };

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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "w-full justify-between font-normal h-9 px-3",
            !selectedItem && "text-muted-foreground",
            className
          )}
        >
          <span className="flex-1 text-right overflow-hidden">
            {renderSelected
              ? renderSelected(selectedItem as ComboboxItem)
              : <DefaultSelectedRender item={selectedItem} />}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-40 mr-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0 min-w-[220px]"
        align="start"
        side="bottom"
      >
        <Command shouldFilter={false}>
          <div className="flex items-center border-b px-3 gap-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              className="flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              placeholder={searchPlaceholder}
              value={search}
              onChange={e => setSearch(e.target.value)}
              dir="auto"
            />
          </div>
          <CommandList className="max-h-72">
            {filteredItems.length === 0 && (
              <CommandEmpty>{emptyText}</CommandEmpty>
            )}
            {groups ? (
              Array.from(groups.entries()).map(([groupName, groupItems], gi) => (
                <React.Fragment key={groupName}>
                  {gi > 0 && <CommandSeparator />}
                  <CommandGroup heading={groupName || undefined}>
                    {groupItems.map(item => (
                      <CommandItem
                        key={item.value}
                        value={item.value}
                        onSelect={handleSelect}
                        className="py-2"
                      >
                        {renderItem
                          ? renderItem(item, item.value === value)
                          : <DefaultItemRender item={item} sel={item.value === value} />}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </React.Fragment>
              ))
            ) : (
              <CommandGroup>
                {filteredItems.map(item => (
                  <CommandItem
                    key={item.value}
                    value={item.value}
                    onSelect={handleSelect}
                    className="py-2"
                  >
                    {renderItem
                      ? renderItem(item, item.value === value)
                      : <DefaultItemRender item={item} sel={item.value === value} />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
