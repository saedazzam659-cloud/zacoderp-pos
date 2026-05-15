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

function encode(years: number, months: number): string {
  const y = Math.max(0, Math.floor(years || 0));
  const m = Math.max(0, Math.min(11, Math.floor(months || 0)));
  const total = y * 12 + m;
  return String(total / 12);
}

export function YearMonthInput({ label = "العمر الافتراضي", value, onChange, className }: Props) {
  const { years, months } = decode(value);
  const totalMonths = years * 12 + months;

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
              max={99}
              value={years}
              onChange={(e) => onChange(encode(Number(e.target.value), months))}
              className="h-8 text-center text-base font-bold text-violet-900 border-0 shadow-none focus-visible:ring-0 px-0 bg-transparent"
            />
            <span className="text-xs font-semibold text-violet-600 select-none whitespace-nowrap">سنة</span>
          </div>

          <span className="text-violet-300 font-bold">+</span>

          {/* Months — accepts any number, auto-rolls into years (e.g. 60 → 5 سنة 0 شهر) */}
          <div className="flex-1 flex items-center gap-1.5 bg-white rounded-lg px-2 py-1 border border-indigo-100">
            <Input
              type="number"
              min={0}
              value={months}
              onChange={(e) => {
                const m = Math.max(0, Math.floor(Number(e.target.value) || 0));
                onChange(encode(years, m));
              }}
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
            {months > 0 && years > 0 && (
              <span className="text-slate-400">
                ({years}.{Math.round((months / 12) * 100).toString().padStart(2, "0")} سنة)
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
