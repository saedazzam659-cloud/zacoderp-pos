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

export interface SmartDateInputProps {
  /** Current value as ISO `YYYY-MM-DD` (or empty string for no date). */
  value: string;
  /** Called with the clamped, always-valid ISO `YYYY-MM-DD` (or "" when cleared). */
  onChange: (value: string) => void;
  /** Inclusive lower bound (ISO `YYYY-MM-DD`). */
  min?: string;
  /** Inclusive upper bound (ISO `YYYY-MM-DD`). */
  max?: string;
  readOnly?: boolean;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  title?: string;
  id?: string;
  name?: string;
  placeholder?: string;
  "aria-label"?: string;
}

/**
 * Familiar `DD/MM/YYYY` date field with a calendar popover, used as a drop-in for
 * native `<input type="date">`. The calendar is the primary editor — each month
 * only ever offers its real days, so picking February gives a valid February
 * date (fixing the sequence-number "next month" badge) and day 29 stays
 * available in every month that actually has it. Manual typing in `DD/MM/YYYY`
 * is also supported; impossible days are clamped to the month end on commit.
 * The stored/emitted value (`value` / `onChange`) is always ISO `YYYY-MM-DD`.
 */
export function SmartDateInput({
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
}: SmartDateInputProps) {
  const [draft, setDraft] = React.useState(() => isoToDisplay(value));
  const [open, setOpen] = React.useState(false);

  // Mirror external value changes (reset, edit-load, programmatic set) into the
  // displayed draft without fighting the user mid-keystroke.
  React.useEffect(() => {
    setDraft(isoToDisplay(value));
  }, [value]);

  const commitFromDisplay = React.useCallback(
    (text: string) => {
      const iso = displayToIso(text);
      if (iso) {
        const bounded = clampToBounds(iso, min, max);
        setDraft(isoToDisplay(bounded));
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
    // clamped prematurely.
    if (DISPLAY_RE.test(norm)) commitFromDisplay(raw);
  };

  const handleBlur = () => {
    if (readOnly || disabled) return;
    const raw = draft.trim();
    const norm = normalizeDigits(raw);
    if (norm === "") {
      onChange("");
      return;
    }
    if (DISPLAY_RE.test(norm)) {
      commitFromDisplay(raw);
      return;
    }
    // Unparseable on blur → restore the last committed value so the field never
    // displays a half-typed date.
    setDraft(isoToDisplay(value));
  };

  const selected = isoToLocalDate(value);
  const minDate = isoToLocalDate(min);
  const maxDate = isoToLocalDate(max);
  const showPicker = !readOnly && !disabled;

  return (
    <div className="relative w-full" dir="ltr">
      <Input
        type="text"
        dir="ltr"
        inputMode="numeric"
        autoComplete="off"
        value={draft}
        onChange={handleTextChange}
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
}

export default SmartDateInput;
