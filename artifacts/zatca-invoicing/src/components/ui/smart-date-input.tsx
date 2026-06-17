import * as React from "react";
import { Calendar as CalendarIconLucide } from "lucide-react";

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
        <Popover open={open} onOpenChange={setOpen}>
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
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={selected}
              defaultMonth={selected ?? minDate ?? new Date()}
              captionLayout="dropdown"
              startMonth={new Date(2000, 0)}
              endMonth={new Date(2100, 11)}
              disabled={[
                ...(minDate ? [{ before: minDate }] : []),
                ...(maxDate ? [{ after: maxDate }] : []),
              ]}
              onSelect={(d) => {
                if (d) {
                  const iso = clampToBounds(localDateToIso(d), min, max);
                  setDraft(isoToDisplay(iso));
                  onChange(iso);
                }
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
});

SmartDateInput.displayName = "SmartDateInput";

export default SmartDateInput;
