import * as React from "react";
import { CalendarDays, ChevronRight, ChevronLeft } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  formatHijriParts,
  gregorianIsoToHijri,
  hijriToGregorianIso,
  parseHijriText,
  HIJRI_MONTHS_AR,
  type HijriParts,
} from "@/lib/hijri";

export type HijriDateFieldProps = {
  /** The linked GREGORIAN ISO `YYYY-MM-DD` value (single source of truth). */
  isoValue: string;
  /** Fired with the converted Gregorian ISO when the user types a valid Hijri date. */
  onIsoChange: (iso: string) => void;
  placeholder?: string;
  invalidText?: string;
  disabled?: boolean;
  className?: string;
};

const WEEKDAYS_AR = ["أحد", "اثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"] as const;

/** Number of days in a Hijri month (29 or 30) per the Umm al-Qura tables. */
function hijriDaysInMonth(y: number, m: number): number {
  return hijriToGregorianIso({ y, m, d: 30 }) ? 30 : 29;
}

function todayHijri(): HijriParts {
  const iso = new Date().toISOString().slice(0, 10);
  return gregorianIsoToHijri(iso) ?? { y: 1447, m: 1, d: 1 };
}

/** Dropdown Hijri (Umm al-Qura) month-grid calendar. */
function HijriCalendar({
  selected,
  onPick,
}: {
  selected: HijriParts | null;
  onPick: (h: HijriParts, iso: string) => void;
}) {
  const init = selected ?? todayHijri();
  const [viewY, setViewY] = React.useState(init.y);
  const [viewM, setViewM] = React.useState(init.m);

  const nav = (delta: number) => {
    let m = viewM + delta;
    let y = viewY;
    if (m < 1) { m = 12; y -= 1; }
    else if (m > 12) { m = 1; y += 1; }
    setViewY(y); setViewM(m);
  };

  const days = React.useMemo(() => {
    const count = hijriDaysInMonth(viewY, viewM);
    const out: { d: number; iso: string }[] = [];
    for (let d = 1; d <= count; d++) {
      const iso = hijriToGregorianIso({ y: viewY, m: viewM, d });
      if (iso) out.push({ d, iso });
    }
    return out;
  }, [viewY, viewM]);

  // Weekday of day 1 (0=Sunday) to pad the grid; Saudi week renders Sun-first.
  const firstDow = days.length ? new Date(`${days[0].iso}T00:00:00Z`).getUTCDay() : 0;
  const today = todayHijri();

  return (
    <div className="w-64 select-none" dir="rtl">
      <div className="flex items-center justify-between mb-2">
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => nav(-1)} aria-label="الشهر السابق">
          <ChevronRight className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-1 text-sm font-semibold">
          <select
            className="bg-transparent border rounded px-1 py-0.5 text-xs"
            value={viewM}
            onChange={(e) => setViewM(Number(e.target.value))}
          >
            {HIJRI_MONTHS_AR.map((n, i) => (
              <option key={n} value={i + 1}>{n}</option>
            ))}
          </select>
          <select
            className="bg-transparent border rounded px-1 py-0.5 text-xs font-mono"
            value={viewY}
            onChange={(e) => setViewY(Number(e.target.value))}
          >
            {Array.from({ length: 201 }, (_, i) => 1300 + i).map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">هـ</span>
        </div>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => nav(1)} aria-label="الشهر التالي">
          <ChevronLeft className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] text-muted-foreground mb-1">
        {WEEKDAYS_AR.map((w) => <div key={w}>{w}</div>)}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {Array.from({ length: firstDow }, (_, i) => <div key={`pad-${i}`} />)}
        {days.map(({ d, iso }) => {
          const isSel = !!selected && selected.y === viewY && selected.m === viewM && selected.d === d;
          const isToday = today.y === viewY && today.m === viewM && today.d === d;
          return (
            <button
              key={d}
              type="button"
              title={iso}
              onClick={() => onPick({ y: viewY, m: viewM, d }, iso)}
              className={cn(
                "h-8 rounded text-xs font-mono hover:bg-emerald-100 transition-colors",
                isSel && "bg-emerald-600 text-white hover:bg-emerald-600",
                !isSel && isToday && "ring-1 ring-emerald-500",
              )}
            >
              {d}
            </button>
          );
        })}
      </div>

      <div className="mt-2 pt-2 border-t flex justify-between items-center">
        <button
          type="button"
          className="text-[11px] text-emerald-700 hover:underline"
          onClick={() => {
            const t = todayHijri();
            const iso = hijriToGregorianIso(t);
            if (iso) onPick(t, iso);
            else { setViewY(t.y); setViewM(t.m); }
          }}
        >
          اليوم
        </button>
        <span className="text-[10px] text-muted-foreground">تقويم أم القرى</span>
      </div>
    </div>
  );
}

/**
 * Two-way Hijri (Umm al-Qura) date input bound to a Gregorian ISO value.
 *
 * - Displays the linked Gregorian date converted to Hijri `DD/MM/YYYY`.
 * - Typing a complete valid Hijri date converts it and calls `onIsoChange`
 *   with the Gregorian ISO (so ONE canonical value is stored — no schema
 *   change and no drift between the two calendars).
 * - A dropdown Hijri month-grid calendar (أم القرى) is available via the
 *   calendar icon for point-and-click entry.
 * - While focused the user owns the text; on blur we re-sync to the stored
 *   value (or flag the text as invalid).
 */
export function HijriDateField({
  isoValue,
  onIsoChange,
  placeholder,
  invalidText,
  disabled,
  className,
}: HijriDateFieldProps) {
  const derived = React.useMemo(() => {
    if (!isoValue) return "";
    const h = gregorianIsoToHijri(isoValue);
    return h ? formatHijriParts(h) : "";
  }, [isoValue]);

  const [text, setText] = React.useState(derived);
  const [focused, setFocused] = React.useState(false);
  const [invalid, setInvalid] = React.useState(false);
  const [calOpen, setCalOpen] = React.useState(false);

  // External value changed (Gregorian picker used, edit-load, reset) — follow
  // it unless the user is actively typing here.
  React.useEffect(() => {
    if (!focused) { setText(derived); setInvalid(false); }
  }, [derived, focused]);

  const selectedHijri = React.useMemo(
    () => (isoValue ? gregorianIsoToHijri(isoValue) : null),
    [isoValue],
  );

  const monthHint = React.useMemo(() => {
    const h = selectedHijri;
    return h ? `${h.d} ${HIJRI_MONTHS_AR[h.m - 1]} ${h.y} هـ` : undefined;
  }, [selectedHijri]);

  return (
    <div className={cn("space-y-1", className)}>
      <div className="relative">
        <Input
          value={text}
          disabled={disabled}
          placeholder={placeholder ?? "يوم/شهر/سنة هـ"}
          dir="ltr"
          inputMode="numeric"
          title={monthHint}
          className={cn("text-start pe-9", invalid && "border-destructive focus-visible:ring-destructive")}
          onFocus={() => setFocused(true)}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            setInvalid(false);
            const h = parseHijriText(v);
            if (h) {
              const iso = hijriToGregorianIso(h);
              if (iso) { onIsoChange(iso); setInvalid(false); }
              else setInvalid(true);
            }
          }}
          onBlur={() => {
            setFocused(false);
            const h = parseHijriText(text);
            if (text.trim() && (!h || !hijriToGregorianIso(h))) setInvalid(true);
            else { setText(derived); setInvalid(false); }
          }}
        />
        <Popover open={calOpen} onOpenChange={setCalOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="فتح التقويم الهجري"
              className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <CalendarDays className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="p-3 w-auto">
            <HijriCalendar
              selected={selectedHijri}
              onPick={(_h, iso) => { onIsoChange(iso); setCalOpen(false); setInvalid(false); }}
            />
          </PopoverContent>
        </Popover>
      </div>
      {invalid && (
        <div className="text-[11px] text-destructive">{invalidText ?? "تاريخ هجري غير صالح"}</div>
      )}
      {!invalid && monthHint && (
        <div className="text-[11px] text-muted-foreground">{monthHint}</div>
      )}
    </div>
  );
}
