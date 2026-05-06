import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

interface DiscountRowProps {
  gross: number;
  value: string;
  onChange: (newAmount: string) => void;
  className?: string;
}

export function DiscountRow({ gross, value, onChange, className }: DiscountRowProps) {
  const amt = Math.max(0, Math.min(gross, Number(value) || 0));
  const pctFromAmt = gross > 0 ? (amt / gross) * 100 : 0;
  const [pctText, setPctText] = useState(pctFromAmt ? pctFromAmt.toFixed(2).replace(/\.?0+$/, "") : "0");

  useEffect(() => {
    const next = gross > 0 ? (amt / gross) * 100 : 0;
    setPctText(next ? next.toFixed(2).replace(/\.?0+$/, "") : "0");
  }, [amt, gross]);

  function handlePctChange(t: string) {
    setPctText(t);
    const p = Math.max(0, Math.min(100, Number(t) || 0));
    const newAmt = (gross * p) / 100;
    onChange(newAmt.toFixed(2));
  }

  return (
    <div className={cn("flex items-center justify-between gap-2", className)}>
      <span className="text-muted-foreground">الخصم</span>
      <div className="flex items-center gap-1">
        <input
          data-testid="doc-discount-pct-input"
          type="number" min="0" max="100" step="0.01"
          value={pctText}
          onFocus={e => e.target.select()}
          onChange={e => handlePctChange(e.target.value)}
          className="w-14 h-7 text-left font-mono text-rose-700 bg-background border rounded px-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <span className="text-[10px] text-muted-foreground">%</span>
        <input
          data-testid="doc-discount-input"
          type="number" min="0" step="0.01"
          value={value}
          onFocus={e => e.target.select()}
          onChange={e => onChange(e.target.value)}
          className="w-24 h-7 text-left font-mono text-rose-700 bg-background border rounded px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <span className="text-[10px] text-muted-foreground">ر.س</span>
      </div>
    </div>
  );
}
