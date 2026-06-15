import { useEffect, useMemo, useRef, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";

// Shared period selector for all SuperAdmin reports.
// Presets mirror the backend `parsePeriod` enum exactly:
//   this_month | last_month | this_quarter | last_quarter | this_year | last_year | custom
// State is managed by usePeriodState() so the parent can pass period.preset
// (or period.from/to for custom) into the report query and CSV download URL.

export type PeriodPreset =
  | "this_month" | "last_month"
  | "this_quarter" | "last_quarter"
  | "this_year" | "last_year"
  | "custom";

const VALID_PRESETS: PeriodPreset[] = [
  "this_month", "last_month", "this_quarter", "last_quarter",
  "this_year", "last_year", "custom",
];

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function utcDate(y: number, m: number, d: number): Date { return new Date(Date.UTC(y, m, d)); }

// Calendar boundaries — kept in sync with backend `parsePeriod` so the date
// inputs reflect what the server will use when the user picks a preset.
function presetRange(preset: Exclude<PeriodPreset, "custom">): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const q = Math.floor(m / 3);
  switch (preset) {
    case "this_month":   return { from: isoDate(utcDate(y, m,     1)), to: isoDate(utcDate(y, m + 1, 0)) };
    case "last_month":   return { from: isoDate(utcDate(y, m - 1, 1)), to: isoDate(utcDate(y, m,     0)) };
    case "this_quarter": return { from: isoDate(utcDate(y, q * 3, 1)),       to: isoDate(utcDate(y, q * 3 + 3, 0)) };
    case "last_quarter": return { from: isoDate(utcDate(y, (q - 1) * 3, 1)), to: isoDate(utcDate(y, (q - 1) * 3 + 3, 0)) };
    case "this_year":    return { from: isoDate(utcDate(y,     0, 1)), to: isoDate(utcDate(y,     11, 31)) };
    case "last_year":    return { from: isoDate(utcDate(y - 1, 0, 1)), to: isoDate(utcDate(y - 1, 11, 31)) };
  }
}

const PERIOD_STORAGE_PREFIX = "report-period:";
const SEARCH_STORAGE_PREFIX = "report-search:";
const BOOL_STORAGE_PREFIX = "report-bool:";

// Read previously persisted period from localStorage. Returns null when no
// valid record exists; the hook then falls back to its `initial` argument.
// Validation is strict so a corrupted entry can never crash the report page.
function readStoredPeriod(storageKey: string | undefined): { preset: PeriodPreset; from: string; to: string } | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${PERIOD_STORAGE_PREFIX}${storageKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!VALID_PRESETS.includes(parsed.preset)) return null;
    if (typeof parsed.from !== "string" || typeof parsed.to !== "string") return null;
    return { preset: parsed.preset, from: parsed.from, to: parsed.to };
  } catch {
    return null;
  }
}

export function usePeriodState(initial: PeriodPreset = "this_month", storageKey?: string) {
  // Resolve initial values once. We read localStorage lazily inside useState's
  // initializer so we never write a stale value back during the first render.
  // The stored record is parsed exactly once via a shared initializer ref so
  // the three useState calls below don't each re-parse JSON on mount.
  const initialRange = useMemo(() => presetRange(initial === "custom" ? "this_month" : initial), [initial]);
  const initRef = useRef<{ preset: PeriodPreset; from: string; to: string } | null | undefined>(undefined);
  if (initRef.current === undefined) initRef.current = readStoredPeriod(storageKey);
  const stored = initRef.current;
  const [preset, setPreset] = useState<PeriodPreset>(() => stored?.preset ?? initial);
  const [from, setFrom] = useState(() => stored?.from ?? initialRange.from);
  const [to, setTo]     = useState(() => stored?.to ?? initialRange.to);

  // Persist on any change. Wrapped in try/catch because Safari private mode
  // and storage-quota errors must never break the report.
  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        `${PERIOD_STORAGE_PREFIX}${storageKey}`,
        JSON.stringify({ preset, from, to }),
      );
    } catch { /* ignore storage failures */ }
  }, [storageKey, preset, from, to]);

  function setPresetSafe(p: PeriodPreset) {
    setPreset(p);
    if (p !== "custom") {
      const r = presetRange(p);
      setFrom(r.from);
      setTo(r.to);
    }
  }

  // Restore the report's default window. Used by the "إعادة الضبط" button.
  function reset() {
    const fallback = initial === "custom" ? "this_month" : initial;
    const r = presetRange(fallback);
    setPreset(initial);
    setFrom(r.from);
    setTo(r.to);
  }

  return { preset, setPreset: setPresetSafe, from, setFrom, to, setTo, reset };
}

export type PeriodState = ReturnType<typeof usePeriodState>;

// Persisted free-text search input. Mirrors usePeriodState's storage strategy
// so a single storageKey per report is enough to remember the whole filter.
export function useStoredSearch(storageKey?: string) {
  const [search, setSearch] = useState<string>(() => {
    if (!storageKey || typeof window === "undefined") return "";
    try {
      return window.localStorage.getItem(`${SEARCH_STORAGE_PREFIX}${storageKey}`) ?? "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      if (search) {
        window.localStorage.setItem(`${SEARCH_STORAGE_PREFIX}${storageKey}`, search);
      } else {
        window.localStorage.removeItem(`${SEARCH_STORAGE_PREFIX}${storageKey}`);
      }
    } catch { /* ignore storage failures */ }
  }, [storageKey, search]);

  return [search, setSearch] as const;
}

// Persisted boolean toggle (e.g. "only over-limit", "only inactive").
// Mirrors useStoredSearch so reports can remember switch positions with the
// same per-report storageKey used by usePeriodState/useStoredSearch.
export function useStoredBoolean(storageKey?: string, initial = false) {
  const [value, setValue] = useState<boolean>(() => {
    if (!storageKey || typeof window === "undefined") return initial;
    try {
      const raw = window.localStorage.getItem(`${BOOL_STORAGE_PREFIX}${storageKey}`);
      if (raw === "true") return true;
      if (raw === "false") return false;
      return initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(`${BOOL_STORAGE_PREFIX}${storageKey}`, value ? "true" : "false");
    } catch { /* ignore storage failures */ }
  }, [storageKey, value]);

  return [value, setValue] as const;
}

// Build the query-string fragment all report endpoints understand. When the
// user picks a preset we send `period=<preset>` and let the server compute
// the calendar boundaries; for custom we send the raw from/to dates.
export function periodToQuery(period: PeriodState): string {
  const params = new URLSearchParams();
  if (period.preset === "custom") {
    params.set("from", period.from);
    params.set("to",   period.to);
  } else {
    params.set("period", period.preset);
  }
  return params.toString();
}

export function PeriodSelector({ period }: { period: PeriodState }) {
  return (
    <>
      <div>
        <label className="text-xs text-muted-foreground block mb-1">الفترة</label>
        <Select value={period.preset} onValueChange={v => period.setPreset(v as PeriodPreset)}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="this_month">هذا الشهر</SelectItem>
            <SelectItem value="last_month">الشهر الماضي</SelectItem>
            <SelectItem value="this_quarter">هذا الربع</SelectItem>
            <SelectItem value="last_quarter">الربع الماضي</SelectItem>
            <SelectItem value="this_year">هذه السنة</SelectItem>
            <SelectItem value="last_year">السنة الماضية</SelectItem>
            <SelectItem value="custom">مخصص</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className="text-xs text-muted-foreground block mb-1">من</label>
        <DateField
          value={period.from}
          onChange={e => { period.setFrom(e.target.value); period.setPreset("custom"); }}
          className="w-[150px]"
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground block mb-1">إلى</label>
        <DateField
          value={period.to}
          onChange={e => { period.setTo(e.target.value); period.setPreset("custom"); }}
          className="w-[150px]"
        />
      </div>
    </>
  );
}
