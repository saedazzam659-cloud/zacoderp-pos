import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar } from "lucide-react";

interface Props {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
}

function decode(decimalYears: string): { years: number; months: number } {
  const v = Number(decimalYears || 0);
  if (!Number.isFinite(v) || v < 0) return { years: 0, months: 0 };
  const totalMonths = Math.round(v * 12);
  return { years: Math.floor(totalMonths / 12), months: totalMonths % 12 };
}

function toDecimal(years: number, months: number): string {
  const y = Math.max(0, Math.floor(years || 0));
  const m = Math.max(0, Math.floor(months || 0));
  return String((y * 12 + m) / 12);
}

export function YearMonthInput({ label = "العمر الافتراضي", value, onChange, className }: Props) {
  const decoded = decode(value);

  // Local string state so users can type multi-digit numbers (e.g. "12", "60")
  // without each keystroke being normalized into years/months mid-typing.
  const [yStr, setYStr] = useState(String(decoded.years));
  const [mStr, setMStr] = useState(String(decoded.months));

  // Re-sync when the parent value changes (e.g. switching between assets).
  useEffect(() => {
    const d = decode(value);
    setYStr(String(d.years));
    setMStr(String(d.months));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const liveYears  = Math.max(0, Math.floor(Number(yStr) || 0));
  const liveMonths = Math.max(0, Math.floor(Number(mStr) || 0));
  const totalMonths = liveYears * 12 + liveMonths;

  // Commit on blur: roll any excess months into years and notify parent.
  function commit() {
    const normY = Math.floor(totalMonths / 12);
    const normM = totalMonths % 12;
    setYStr(String(normY));
    setMStr(String(normM));
    onChange(toDecimal(normY, normM));
  }

  return (
    <div className={className}>
      <Label className="flex items-center gap-1.5 text-violet-700">
        <Calendar className="h-3.5 w-3.5" /> {label}
      </Label>

      <div className="mt-1 rounded-xl border-2 border-violet-200 bg-gradient-to-br from-violet-50 to-indigo-50/60 p-2 shadow-sm focus-within:border-violet-400 focus-within:ring-2 focus-within:ring-violet-200 transition-all">
        <div className="flex items-center gap-2" dir="rtl">
          {/* Years */}
          <div className="flex-1 flex items-center gap-1.5 bg-white rounded-lg px-2 py-1 border border-violet-100">
            <Input
              type="number"
              min={0}
              value={yStr}
              onChange={(e) => setYStr(e.target.value)}
              onBlur={commit}
              className="h-8 text-center text-base font-bold text-violet-900 border-0 shadow-none focus-visible:ring-0 px-0 bg-transparent"
            />
            <span className="text-xs font-semibold text-violet-600 select-none whitespace-nowrap">سنة</span>
          </div>

          <span className="text-violet-300 font-bold">+</span>

          {/* Months — accepts any number; rolls into years on blur (e.g. 60 → 5 سنة) */}
          <div className="flex-1 flex items-center gap-1.5 bg-white rounded-lg px-2 py-1 border border-indigo-100">
            <Input
              type="number"
              min={0}
              value={mStr}
              onChange={(e) => setMStr(e.target.value)}
              onBlur={commit}
              className="h-8 text-center text-base font-bold text-indigo-900 border-0 shadow-none focus-visible:ring-0 px-0 bg-transparent"
            />
            <span className="text-xs font-semibold text-indigo-600 select-none whitespace-nowrap">شهر</span>
          </div>
        </div>

        {totalMonths > 0 && (
          <div className="mt-1.5 flex items-center justify-center gap-1 text-[11px] text-slate-500">
            <span>الإجمالي:</span>
            <span className="font-bold text-violet-700">{totalMonths.toLocaleString("ar-SA")}</span>
            <span>شهر</span>
            <span className="text-slate-400">
              ({Math.floor(totalMonths / 12)} سنة و {totalMonths % 12} شهر)
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
