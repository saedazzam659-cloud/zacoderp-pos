import { useMemo, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";

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

export function usePeriodState(initial: PeriodPreset = "this_month") {
  const [preset, setPreset] = useState<PeriodPreset>(initial);
  const initialRange = useMemo(() => presetRange(initial === "custom" ? "this_month" : initial), [initial]);
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo]     = useState(initialRange.to);

  function setPresetSafe(p: PeriodPreset) {
    setPreset(p);
    if (p !== "custom") {
      const r = presetRange(p);
      setFrom(r.from);
      setTo(r.to);
    }
  }

  return { preset, setPreset: setPresetSafe, from, setFrom, to, setTo };
}

export type PeriodState = ReturnType<typeof usePeriodState>;

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
        <Input
          type="date"
          value={period.from}
          onChange={e => { period.setFrom(e.target.value); period.setPreset("custom"); }}
          className="w-[150px]"
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground block mb-1">إلى</label>
        <Input
          type="date"
          value={period.to}
          onChange={e => { period.setTo(e.target.value); period.setPreset("custom"); }}
          className="w-[150px]"
        />
      </div>
    </>
  );
}
