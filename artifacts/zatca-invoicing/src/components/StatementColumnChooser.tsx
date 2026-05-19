import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Columns3, RotateCcw } from "lucide-react";

/**
 * Column-visibility model shared by both customer & supplier statement
 * pages. The same keys are honoured by:
 *   - <AccountStatementView /> (on-screen table)
 *   - <StatementExportButtons /> (Excel sheet)
 *   - exportStatementToPDF (PDF / print HTML)
 * so the user sees ONE column layout everywhere — screen, Excel, PDF, print.
 *
 * Persisted per page slug in localStorage (e.g. "customer", "supplier") so
 * the user's preferred columns survive reloads, but the two pages keep
 * independent layouts (a hidden "الشرح" on customer statement won't hide
 * it on the supplier page too).
 */
export type StatementColKey =
  | "date" | "docNumber" | "type"
  | "debit" | "credit" | "balance"
  | "description";

export type StatementVisibleCols = Record<StatementColKey, boolean>;

export const STATEMENT_COL_DEFAULTS: StatementVisibleCols = {
  date: true, docNumber: true, type: true,
  debit: true, credit: true, balance: true,
  description: true,
};

export const STATEMENT_COL_LABELS: Record<StatementColKey, string> = {
  date:        "التاريخ",
  docNumber:   "الرقم",
  type:        "البيان",
  debit:       "مدين",
  credit:      "دائن",
  balance:     "الرصيد",
  description: "الشرح",
};

const STORAGE_PREFIX = "statement:visible-cols:";

export function useStatementVisibleCols(slug: string) {
  const key = STORAGE_PREFIX + slug;
  const [cols, setCols] = useState<StatementVisibleCols>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
      if (raw) return { ...STATEMENT_COL_DEFAULTS, ...JSON.parse(raw) };
    } catch { /* ignore corrupt storage */ }
    return STATEMENT_COL_DEFAULTS;
  });
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(cols)); } catch { /* noop */ }
  }, [key, cols]);
  return [cols, setCols] as const;
}

interface Props {
  value: StatementVisibleCols;
  onChange: (next: StatementVisibleCols) => void;
}

export default function StatementColumnChooser({ value, onChange }: Props) {
  const toggle = (k: StatementColKey) => onChange({ ...value, [k]: !value[k] });
  const reset  = () => onChange(STATEMENT_COL_DEFAULTS);
  const hiddenCount = (Object.keys(STATEMENT_COL_DEFAULTS) as StatementColKey[])
    .filter(k => !value[k]).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 relative">
          <Columns3 className="h-4 w-4" />
          الأعمدة
          {hiddenCount > 0 && (
            <span className="absolute -top-1 -end-1 h-4 min-w-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">
              {hiddenCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <div className="px-3 py-2.5 border-b flex items-center justify-between bg-muted/40">
          <p className="text-xs font-semibold">إظهار/إخفاء الأعمدة</p>
          <button
            type="button"
            className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
            onClick={reset}
          >
            <RotateCcw className="h-3 w-3" /> إعادة تعيين
          </button>
        </div>
        <div className="p-2 max-h-72 overflow-y-auto space-y-0.5">
          {(Object.keys(STATEMENT_COL_LABELS) as StatementColKey[]).map(k => (
            <label
              key={k}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/60 cursor-pointer text-sm"
            >
              <Checkbox checked={value[k]} onCheckedChange={() => toggle(k)} />
              <span className="flex-1">{STATEMENT_COL_LABELS[k]}</span>
            </label>
          ))}
        </div>
        <div className="px-3 py-2 text-[10px] text-muted-foreground border-t bg-muted/20 leading-relaxed">
          💡 يطبق هذا الاختيار على الجدول والطباعة و Excel و PDF.
        </div>
      </PopoverContent>
    </Popover>
  );
}
