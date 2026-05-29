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

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Last calendar day of a 1-based month (handles non-leap February correctly:
 *  `daysInMonth(2026, 2) === 28`). Day 0 of the *next* month rolls back to the
 *  last day of the requested month. */
function daysInMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12, 0).getDate();
}

/** Coerce a raw `YYYY-MM-DD` string into a date that REALLY exists on the
 *  calendar by clamping the day to its month's last valid day — e.g.
 *  `2026-02-29` → `2026-02-28` (2026 is not a leap year). Returns `null` when
 *  the string is not a complete `YYYY-MM-DD`. This is the whole point of the
 *  component: the native `<input type="date">` silently REFUSES an impossible
 *  date (no change event fires), so the picked month was never committed and
 *  the form kept the previously-valid date. */
function clampIso(raw: string): string | null {
  const m = ISO_RE.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  let mo = Number(m[2]);
  let d = Number(m[3]);
  if (mo < 1) mo = 1;
  if (mo > 12) mo = 12;
  const last = daysInMonth(y, mo);
  if (d < 1) d = 1;
  if (d > last) d = last;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Keep an ISO date inside the inclusive [min, max] policy window. ISO
 *  `YYYY-MM-DD` strings compare correctly with plain string ordering. */
function clampToBounds(iso: string, min?: string, max?: string): string {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

/** Build a *local* Date (midnight) from an ISO string — never `new Date(iso)`,
 *  which parses as UTC and can shift the calendar selection by a day in +03. */
function isoToLocalDate(iso: string | undefined): Date | undefined {
  if (!iso) return undefined;
  const m = ISO_RE.exec(iso);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? undefined : d;
}

/** Format a local Date back to `YYYY-MM-DD` using its LOCAL parts. */
function localDateToIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface SmartDateInputProps {
  /** Current value as `YYYY-MM-DD` (or empty string for no date). */
  value: string;
  /** Called with the clamped, always-valid `YYYY-MM-DD` (or "" when cleared). */
  onChange: (value: string) => void;
  /** Inclusive lower bound (`YYYY-MM-DD`). */
  min?: string;
  /** Inclusive upper bound (`YYYY-MM-DD`). */
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
 * Drop-in replacement for `<Input type="date" />` that AUTO-CORRECTS impossible
 * dates instead of silently discarding them. The user can type `YYYY-MM-DD`
 * directly (the day is clamped to the chosen month on entry, so `2026-02-29`
 * becomes `2026-02-28`) or pick from the calendar popover (which only ever
 * offers real days). Either way the committed value is always a valid date,
 * so dependent UI — the sequence "next number" badge and the persisted record —
 * stay in sync with what the user actually chose.
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
  placeholder = "YYYY-MM-DD",
  "aria-label": ariaLabel,
}: SmartDateInputProps) {
  const [draft, setDraft] = React.useState(value ?? "");
  const [open, setOpen] = React.useState(false);

  // Mirror external value changes (reset, edit-load, programmatic set) into the
  // editable draft without fighting the user mid-keystroke.
  React.useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  const commit = React.useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (trimmed === "") {
        onChange("");
        return;
      }
      const clamped = clampIso(trimmed);
      if (clamped) {
        const bounded = clampToBounds(clamped, min, max);
        setDraft(bounded);
        onChange(bounded);
      }
    },
    [onChange, min, max],
  );

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (readOnly || disabled) return;
    const raw = e.target.value;
    setDraft(raw);
    if (raw.trim() === "") {
      onChange("");
      return;
    }
    // Only commit once a complete YYYY-MM-DD has been typed, so partial input
    // ("2026-0") isn't prematurely clamped.
    if (ISO_RE.test(raw.trim())) commit(raw);
  };

  const handleBlur = () => {
    if (readOnly || disabled) return;
    const raw = draft.trim();
    if (raw === "") {
      onChange("");
      return;
    }
    if (ISO_RE.test(raw)) {
      commit(raw);
      return;
    }
    // Incomplete / unparseable on blur → restore the last committed value so
    // the field never displays a half-typed date.
    setDraft(value ?? "");
  };

  const selected = isoToLocalDate(value);
  const minDate = isoToLocalDate(min);
  const maxDate = isoToLocalDate(max);
  const showPicker = !readOnly && !disabled;

  return (
    <div className="relative w-full">
      <Input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={draft}
        onChange={handleTextChange}
        onBlur={handleBlur}
        readOnly={readOnly}
        disabled={disabled}
        required={required}
        pattern="\d{4}-\d{2}-\d{2}"
        placeholder={placeholder}
        title={title}
        id={id}
        name={name}
        aria-label={ariaLabel}
        className={cn(showPicker && "pe-9", className)}
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
              className="absolute inset-y-0 end-0 h-full w-9 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
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
                  setDraft(iso);
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
