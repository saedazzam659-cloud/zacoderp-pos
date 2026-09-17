import React, { useMemo, useState } from "react";

/**
 * Small local stand-in for the source SearchCombobox.
 * The extracted invoice baseline keeps the source control's visual contract
 * without importing the app's popover/enter-navigation side effects.
 */
export type InvoiceComboOption = {
  value: string;
  label: string;
  code?: string;
};

export function InvoiceSearchCombobox({
  items,
  value,
  onValueChange,
  placeholder = "اختر...",
  className = "",
  disabled = false,
}: {
  items: InvoiceComboOption[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = items.find((item) => item.value === value);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term ? items.filter((item) => `${item.code ?? ""} ${item.label}`.toLowerCase().includes(term)) : items;
  }, [items, query]);
  return (
    <div className="relative">
      <input
        disabled={disabled}
        value={open ? query : (selected ? `${selected.code ? `${selected.code} — ` : ""}${selected.label}` : "")}
        placeholder={placeholder}
        onFocus={() => { if (!disabled) { setQuery(""); setOpen(true); } }}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onBlur={() => window.setTimeout(() => setOpen(false), 130)}
        className={`flex h-9 w-full rounded-md border border-input bg-background ps-3 pe-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
      />
      {open && !disabled && <div className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-input bg-popover py-1 text-sm text-popover-foreground shadow-md">
        {filtered.length ? filtered.map((item) => <button type="button" key={item.value} onMouseDown={(event) => event.preventDefault()} onClick={() => { onValueChange(item.value); setOpen(false); }} className="block w-full px-3 py-2 text-right hover:bg-muted">
          {item.code ? `${item.code} — ` : ""}{item.label}
        </button>) : <p className="px-3 py-2 text-xs text-muted-foreground">لا توجد نتائج</p>}
      </div>}
    </div>
  );
}