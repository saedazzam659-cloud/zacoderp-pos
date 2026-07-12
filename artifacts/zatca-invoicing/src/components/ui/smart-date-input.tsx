import * as React from "react";
import {
  Calendar as CalendarIconLucide,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// Internal/stored value is always ISO `YYYY-MM-DD`; the user sees and types the
// familiar `DD/MM/YYYY` form.
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DISPLAY_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** Convert Arabic-Indic (٠-٩) and extended/Persian (۰-۹) digits to Western 0-9
 *  so a typed date from an Arabic numpad parses too. */
function normalizeDigits(s: string): string {
  return s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0x0669 ? String(code - 0x0660) : String(code - 0x06f0);
  });
}

/** Last calendar day of a 1-based month (non-leap February → 28). */
function daysInMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12, 0).getDate();
}

/** Clamp y/m/d to a date that REALLY exists (e.g. 29 Feb 2026 → 28 Feb 2026). */
function clampParts(year: number, month1to12: number, day: number) {
  let mo = month1to12;
  let d = day;
  if (mo < 1) mo = 1;
  if (mo > 12) mo = 12;
  const last = daysInMonth(year, mo);
  if (d < 1) d = 1;
  if (d > last) d = last;
  return { y: year, mo, d };
}

function toIso(year: number, month1to12: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month1to12).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** ISO `YYYY-MM-DD` → display `DD/MM/YYYY` (empty string when absent/invalid). */
function isoToDisplay(iso: string | undefined): string {
  const m = ISO_RE.exec((iso ?? "").trim());
  if (!m) return "";
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Display `DD/MM/YYYY` → clamped ISO `YYYY-MM-DD`, or null if not complete. */
function displayToIso(text: string): string | null {
  const m = DISPLAY_RE.exec(normalizeDigits(text).trim());
  if (!m) return null;
  const c = clampParts(Number(m[3]), Number(m[2]), Number(m[1]));
  return toIso(c.y, c.mo, c.d);
}

/** Keep an ISO date inside the inclusive [min, max] policy window. */
function clampToBounds(iso: string, min?: string, max?: string): string {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

/** Build a *local* Date (midnight) from ISO — never `new Date(iso)` (UTC drift). */
function isoToLocalDate(iso: string | undefined): Date | undefined {
  const m = ISO_RE.exec((iso ?? "").trim());
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? undefined : d;
}

/** Local Date → ISO `YYYY-MM-DD` using LOCAL parts. */
function localDateToIso(d: Date): string {
  return toIso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// ---------------------------------------------------------------------------
// Open year range — wide enough for birth dates and far-future expiries alike.
// ---------------------------------------------------------------------------
const START_YEAR = 1930;
const END_YEAR = 2100;

const MONTHS_AR = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

type InlineItem = { value: string; label: string };

const MONTH_ITEMS: InlineItem[] = MONTHS_AR.map((label, i) => ({
  value: String(i),
  label: `${label} (${i + 1})`,
}));

const YEAR_ITEMS: InlineItem[] = Array.from(
  { length: END_YEAR - START_YEAR + 1 },
  (_, i) => {
    const y = START_YEAR + i;
    return { value: String(y), label: String(y) };
  },
);

/**
 * Searchable combobox styled after the system-wide `SearchCombobox`, but
 * rendered INLINE (no portal). A portaled nested Popover inside the calendar
 * popover triggers Radix's outside-interaction dismissal and closes the whole
 * calendar — the inline dropdown avoids that while keeping the same look.
 */
function InlineSearchCombobox({
  items,
  value,
  onValueChange,
  className,
  searchPlaceholder,
  ariaLabel,
}: {
  items: InlineItem[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  searchPlaceholder?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const selected = items.find((i) => i.value === value);
  const displayValue = open ? search : (selected?.label ?? "");

  const filtered = React.useMemo(() => {
    const q = normalizeDigits(search).trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        it.value.toLowerCase().includes(q),
    );
  }, [items, search]);

  // When opening (or filtering), highlight the currently-selected row if it is
  // visible, else the first row — and scroll it into view.
  React.useEffect(() => {
    if (!open) return;
    const selIdx = filtered.findIndex((it) => it.value === value);
    setHighlight(selIdx === -1 ? 0 : selIdx);
  }, [open, filtered, value]);

  React.useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${highlight}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const commit = (val: string) => {
    onValueChange(val);
    setOpen(false);
    setSearch("");
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => (filtered.length ? (h + 1) % filtered.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) =>
        filtered.length ? (h - 1 + filtered.length) % filtered.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (open && filtered[highlight]) commit(filtered[highlight].value);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      setSearch("");
      inputRef.current?.blur();
    } else if (e.key === "Tab") {
      setOpen(false);
      setSearch("");
    }
  };

  return (
    <div className={cn("relative", className)}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        value={displayValue}
        placeholder={selected ? "" : searchPlaceholder}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setSearch(e.target.value);
          if (!open) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setOpen(false);
          setSearch("");
        }}
        dir="auto"
        className={cn(
          "flex h-8 w-full rounded-md border border-input bg-background ps-2 pe-7 text-sm text-foreground shadow-sm",
          "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      />
      <div className="pointer-events-none absolute inset-y-0 end-1.5 flex items-center">
        <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
      </div>
      {open && (
        <div
          ref={listRef}
          className="absolute start-0 top-full z-50 mt-1 max-h-60 w-full min-w-[7rem] overflow-y-auto rounded-md border bg-popover py-1 shadow-md"
        >
          {filtered.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              لا توجد نتائج
            </div>
          ) : (
            filtered.map((it, idx) => {
              const isSel = it.value === value;
              const isHi = idx === highlight;
              return (
                <div
                  key={it.value}
                  data-idx={idx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(it.value);
                  }}
                  onMouseEnter={() => setHighlight(idx)}
                  className={cn(
                    "mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1.5 text-sm tabular-nums",
                    isHi ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
                  )}
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 text-primary",
                      isSel ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span>{it.label}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** First day of the month `n` months away, clamped to the supported range. */
function addMonthsClamped(d: Date, n: number): Date {
  const next = new Date(d.getFullYear(), d.getMonth() + n, 1);
  if (next.getFullYear() < START_YEAR) return new Date(START_YEAR, 0, 1);
  if (next.getFullYear() > END_YEAR) return new Date(END_YEAR, 11, 1);
  return next;
}

export type SmartDateInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "min" | "max" | "type"
> & {
  /** Current value as ISO `YYYY-MM-DD` (or empty string for no date). */
  value: string;
  /** Called with the clamped, always-valid ISO `YYYY-MM-DD` (or "" when cleared). */
  onChange: (value: string) => void;
  /** Inclusive lower bound (ISO `YYYY-MM-DD`). */
  min?: string;
  /** Inclusive upper bound (ISO `YYYY-MM-DD`). */
  max?: string;
};

/**
 * Familiar `DD/MM/YYYY` date field with a calendar popover, used as a drop-in for
 * native `<input type="date">`. The calendar is the primary editor — each month
 * only ever offers its real days, so picking February gives a valid February
 * date (fixing the sequence-number "next month" badge) and day 29 stays
 * available in every month that actually has it. Manual typing in `DD/MM/YYYY`
 * is also supported; impossible days are clamped to the month end on commit.
 * The stored/emitted value (`value` / `onChange`) is always ISO `YYYY-MM-DD`.
 *
 * The popover header exposes SEARCHABLE month + year comboboxes (same style as
 * the system-wide SearchCombobox) over an open 1930–2100 range, plus اليوم/مسح
 * shortcuts in the footer.
 */
export const SmartDateInput = React.forwardRef<
  HTMLInputElement,
  SmartDateInputProps
>(function SmartDateInput(
  {
    value,
    onChange,
    min,
    max,
    readOnly,
    disabled,
    required,
    className,
    title,
    id,
    name,
    placeholder = "يوم/شهر/سنة",
    "aria-label": ariaLabel,
    onBlur: userOnBlur,
    onFocus: userOnFocus,
    ...rest
  },
  ref,
) {
  const [draft, setDraft] = React.useState(() => isoToDisplay(value));
  const [open, setOpen] = React.useState(false);
  // The month currently DISPLAYED in the calendar grid (independent from the
  // selected value — the header comboboxes/arrows navigate this).
  const [viewMonth, setViewMonth] = React.useState<Date>(() => new Date());
  // While the field is focused the user owns the draft — we must NOT reformat
  // it on every keystroke or the caret jumps to the end (typing one digit in
  // the "day" slot would otherwise push the next digit into the "year",
  // producing values like "02/06/20262"). Reformatting happens only on blur or
  // on an external value change while the field is unfocused.
  const focusedRef = React.useRef(false);

  // Mirror external value changes (reset, edit-load, programmatic set) into the
  // displayed draft — but only when the user is NOT actively editing, so we
  // never fight their keystrokes mid-edit.
  React.useEffect(() => {
    if (!focusedRef.current) setDraft(isoToDisplay(value));
  }, [value]);

  const commitFromDisplay = React.useCallback(
    (text: string, reformat: boolean) => {
      const iso = displayToIso(text);
      if (iso) {
        const bounded = clampToBounds(iso, min, max);
        // Only canonicalise the visible text when explicitly asked (on blur).
        // Doing it during typing resets the caret to the end of the input.
        if (reformat) setDraft(isoToDisplay(bounded));
        onChange(bounded);
      }
    },
    [onChange, min, max],
  );

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (readOnly || disabled) return;
    const raw = e.target.value;
    setDraft(raw);
    const norm = normalizeDigits(raw).trim();
    if (norm === "") {
      onChange("");
      return;
    }
    // Commit only once a complete DD/MM/YYYY is typed, so partial input isn't
    // clamped prematurely. Don't reformat the draft here — keep the user's raw
    // text (and caret position) intact until they blur.
    if (DISPLAY_RE.test(norm)) commitFromDisplay(raw, false);
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    focusedRef.current = true;
    userOnFocus?.(e);
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    focusedRef.current = false;
    if (!readOnly && !disabled) {
      const raw = draft.trim();
      const norm = normalizeDigits(raw);
      if (norm === "") {
        onChange("");
      } else if (DISPLAY_RE.test(norm)) {
        // Now safe to canonicalise (e.g. "2/6/2026" → "02/06/2026").
        commitFromDisplay(raw, true);
      } else {
        // Unparseable on blur → restore the last committed value so the field
        // never displays a half-typed date.
        setDraft(isoToDisplay(value));
      }
    }
    // Always notify the caller (e.g. React Hook Form's touched-state tracking).
    userOnBlur?.(e);
  };

  const selected = isoToLocalDate(value);
  const minDate = isoToLocalDate(min);
  const maxDate = isoToLocalDate(max);
  const showPicker = !readOnly && !disabled;

  const openCalendar = (o: boolean) => {
    if (o) {
      // Land on the month of the current value (or the policy minimum, or
      // today) every time the popover opens.
      const base = selected ?? minDate ?? new Date();
      setViewMonth(new Date(base.getFullYear(), base.getMonth(), 1));
    }
    setOpen(o);
  };

  const pickIso = (iso: string) => {
    const bounded = clampToBounds(iso, min, max);
    setDraft(isoToDisplay(bounded));
    onChange(bounded);
    setOpen(false);
  };

  return (
    <div className="relative w-full" dir="ltr">
      <Input
        {...rest}
        ref={ref}
        type="text"
        dir="ltr"
        inputMode="numeric"
        autoComplete="off"
        value={draft}
        onChange={handleTextChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        readOnly={readOnly}
        disabled={disabled}
        required={required}
        pattern="\d{1,2}/\d{1,2}/\d{4}"
        placeholder={placeholder}
        title={title}
        id={id}
        name={name}
        aria-label={ariaLabel}
        className={cn(
          "text-right font-medium tabular-nums tracking-wide",
          showPicker && "ps-10",
          className,
        )}
      />
      {showPicker && (
        <Popover open={open} onOpenChange={openCalendar}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              tabIndex={-1}
              aria-label="اختيار التاريخ من التقويم"
              className="absolute inset-y-0 start-0 h-full w-10 px-0 text-muted-foreground hover:bg-transparent hover:text-primary"
            >
              <CalendarIconLucide className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start" dir="rtl">
            {/* Header: prev/next month + searchable month & year comboboxes */}
            <div className="flex items-center gap-1 border-b bg-muted/40 px-2 py-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label="الشهر السابق"
                onClick={() => setViewMonth((m) => addMonthsClamped(m, -1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <InlineSearchCombobox
                items={MONTH_ITEMS}
                value={String(viewMonth.getMonth())}
                onValueChange={(v) =>
                  setViewMonth(
                    (m) => new Date(m.getFullYear(), Number(v), 1),
                  )
                }
                className="w-[7.5rem]"
                searchPlaceholder="الشهر"
                ariaLabel="اختيار الشهر"
              />
              <InlineSearchCombobox
                items={YEAR_ITEMS}
                value={String(viewMonth.getFullYear())}
                onValueChange={(v) =>
                  setViewMonth((m) => new Date(Number(v), m.getMonth(), 1))
                }
                className="w-[5.5rem]"
                searchPlaceholder="السنة"
                ariaLabel="اختيار السنة"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label="الشهر التالي"
                onClick={() => setViewMonth((m) => addMonthsClamped(m, 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </div>
            <Calendar
              mode="single"
              dir="rtl"
              selected={selected}
              month={viewMonth}
              onMonthChange={setViewMonth}
              hideNavigation
              classNames={{ month_caption: "hidden", nav: "hidden" }}
              formatters={{
                formatWeekdayName: (date) =>
                  date.toLocaleDateString("ar", { weekday: "narrow" }),
              }}
              startMonth={new Date(START_YEAR, 0)}
              endMonth={new Date(END_YEAR, 11)}
              disabled={[
                ...(minDate ? [{ before: minDate }] : []),
                ...(maxDate ? [{ after: maxDate }] : []),
              ]}
              onSelect={(d) => {
                if (d) pickIso(localDateToIso(d));
                else setOpen(false);
              }}
            />
            {/* Footer: today / clear shortcuts */}
            <div className="flex items-center justify-between border-t px-2 py-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-primary"
                onClick={() => pickIso(localDateToIso(new Date()))}
              >
                اليوم
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-muted-foreground"
                onClick={() => {
                  setDraft("");
                  onChange("");
                  setOpen(false);
                }}
              >
                مسح
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
});

SmartDateInput.displayName = "SmartDateInput";

export default SmartDateInput;
