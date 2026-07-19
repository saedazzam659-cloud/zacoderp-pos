import * as React from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  formatHijriParts,
  gregorianIsoToHijri,
  hijriToGregorianIso,
  parseHijriText,
  HIJRI_MONTHS_AR,
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

/**
 * Two-way Hijri (Umm al-Qura) date input bound to a Gregorian ISO value.
 *
 * - Displays the linked Gregorian date converted to Hijri `DD/MM/YYYY`.
 * - Typing a complete valid Hijri date converts it and calls `onIsoChange`
 *   with the Gregorian ISO (so ONE canonical value is stored — no schema
 *   change and no drift between the two calendars).
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

  // External value changed (Gregorian picker used, edit-load, reset) — follow
  // it unless the user is actively typing here.
  React.useEffect(() => {
    if (!focused) { setText(derived); setInvalid(false); }
  }, [derived, focused]);

  const monthHint = React.useMemo(() => {
    const h = isoValue ? gregorianIsoToHijri(isoValue) : null;
    return h ? `${h.d} ${HIJRI_MONTHS_AR[h.m - 1]} ${h.y} هـ` : undefined;
  }, [isoValue]);

  return (
    <div className={cn("space-y-1", className)}>
      <Input
        value={text}
        disabled={disabled}
        placeholder={placeholder ?? "يوم/شهر/سنة هـ"}
        dir="ltr"
        inputMode="numeric"
        title={monthHint}
        className={cn("text-start", invalid && "border-destructive focus-visible:ring-destructive")}
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
      {invalid && (
        <div className="text-[11px] text-destructive">{invalidText ?? "تاريخ هجري غير صالح"}</div>
      )}
      {!invalid && monthHint && (
        <div className="text-[11px] text-muted-foreground">{monthHint}</div>
      )}
    </div>
  );
}
