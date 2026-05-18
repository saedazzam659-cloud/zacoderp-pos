/**
 * Shared per-column "attractive filter" dialog used by every audit-style
 * grid (SalesAuditGrid, SalesQuotations, SalesOrders, Purchase*, …).
 *
 * Renders a funnel icon button (the trigger) and a Popover with two
 * conditions joined by AND/OR — same UX everywhere so users only learn
 * the pattern once.
 */
import { useEffect, useState } from "react";
import { Filter as FilterIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ColType } from "@/lib/auditGridLayout";
import {
  type AdvCond, type AdvFilter, type AdvOp, type OpMeta,
  OPS_FOR, defaultAdv,
} from "@/lib/advFilter";

export interface AdvFilterPopoverProps {
  colLabel: string;
  colType: ColType;
  value: AdvFilter | undefined;
  onApply: (v: AdvFilter) => void;
  onClear: () => void;
  active: boolean;
}

export function AdvFilterPopover(props: AdvFilterPopoverProps) {
  const { colLabel, colType, value, onApply, onClear, active } = props;
  const [open, setOpen] = useState(false);
  // Local draft so the user can tweak without instantly re-filtering the
  // grid on every keystroke — only "تطبيق" commits the change.
  const [draft, setDraft] = useState<AdvFilter>(() => value ?? defaultAdv(colType));
  // Re-seed the draft each time the popover opens so it reflects the most
  // recently-applied state (or the column-type default if cleared).
  useEffect(() => {
    if (open) setDraft(value ?? defaultAdv(colType));
  }, [open, value, colType]);

  const ops = OPS_FOR(colType);
  const cond1Meta = ops.find(o => o.value === draft.c1.op);
  const cond2Meta = ops.find(o => o.value === draft.c2.op);
  const updateC1 = (patch: Partial<AdvCond>) => setDraft(d => ({ ...d, c1: { ...d.c1, ...patch } }));
  const updateC2 = (patch: Partial<AdvCond>) => setDraft(d => ({ ...d, c2: { ...d.c2, ...patch } }));

  const renderCondInputs = (
    cond: AdvCond,
    meta: OpMeta | undefined,
    update: (p: Partial<AdvCond>) => void,
  ) => {
    if (!meta?.needsValue) return null;
    if (meta.needsV2) {
      return (
        <div className="flex items-center gap-1.5">
          <Input value={cond.v} onChange={e => update({ v: e.target.value })}
            placeholder="من" type={colType === "num" ? "number" : "text"}
            className="h-8 text-xs flex-1" />
          <span className="text-slate-400 text-xs">-</span>
          <Input value={cond.v2 ?? ""} onChange={e => update({ v2: e.target.value })}
            placeholder="إلى" type={colType === "num" ? "number" : "text"}
            className="h-8 text-xs flex-1" />
        </div>
      );
    }
    return (
      <Input value={cond.v} onChange={e => update({ v: e.target.value })}
        placeholder="القيمة…" type={colType === "num" ? "number" : "text"}
        className="h-8 text-xs" />
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={e => e.stopPropagation()}
          aria-label={`فلتر العمود: ${colLabel}`}
          title={active ? `فلتر مفعل` : "فتح فلتر العمود"}
          className={cn(
            "ms-0.5 inline-flex items-center justify-center w-5 h-5 rounded-md border transition-all",
            active
              ? "bg-rose-600 text-white border-rose-700 shadow ring-2 ring-rose-200"
              : "bg-white/70 text-slate-500 border-slate-300 opacity-60 hover:opacity-100 hover:bg-amber-50 hover:text-amber-700 hover:border-amber-400",
          )}
        >
          <FilterIcon className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" side="bottom" sideOffset={6}
        className="w-80 p-0 overflow-hidden shadow-2xl border-slate-300"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 bg-gradient-to-l from-rose-50 to-amber-50 border-b border-slate-200">
          <div className="flex items-center gap-1.5 text-slate-800 font-semibold text-xs">
            <FilterIcon className="h-3.5 w-3.5 text-rose-600" />
            <span>فلتر: {colLabel}</span>
          </div>
          <button type="button" onClick={() => setOpen(false)} aria-label="إغلاق"
            className="text-slate-400 hover:text-slate-700 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-3 space-y-3 bg-white">
          <div className="space-y-1.5">
            <Label className="text-[10.5px] text-slate-500 font-normal">شرط 1</Label>
            <select value={draft.c1.op}
              onChange={e => updateC1({ op: e.target.value as AdvOp, v: "", v2: "" })}
              className="w-full h-8 text-xs px-2 rounded-md border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-rose-200 focus:border-rose-400">
              {ops.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {renderCondInputs(draft.c1, cond1Meta, updateC1)}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-slate-200" />
            <select value={draft.conn}
              onChange={e => setDraft(d => ({ ...d, conn: e.target.value as "and" | "or" }))}
              className={cn(
                "h-7 text-[11px] px-2 rounded-full border font-semibold cursor-pointer transition-colors",
                draft.conn === "or"
                  ? "bg-amber-50 text-amber-800 border-amber-300"
                  : "bg-emerald-50 text-emerald-800 border-emerald-300",
              )}>
              <option value="and">و</option>
              <option value="or">أو</option>
            </select>
            <div className="flex-1 h-px bg-slate-200" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[10.5px] text-slate-500 font-normal">شرط 2</Label>
            <select value={draft.c2.op}
              onChange={e => updateC2({ op: e.target.value as AdvOp, v: "", v2: "" })}
              className="w-full h-8 text-xs px-2 rounded-md border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-rose-200 focus:border-rose-400">
              {ops.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {renderCondInputs(draft.c2, cond2Meta, updateC2)}
          </div>
        </div>

        {/* Footer — Clear / Close / Apply */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 border-t border-slate-200">
          <Button type="button" size="sm" variant="ghost"
            className="h-8 px-3 text-xs text-slate-600 hover:bg-slate-200"
            onClick={() => { onClear(); setOpen(false); }}>
            مسح
          </Button>
          <div className="flex items-center gap-1.5">
            <Button type="button" size="sm" variant="outline" className="h-8 px-3 text-xs"
              onClick={() => setOpen(false)}>
              إغلاق
            </Button>
            <Button type="button" size="sm"
              className="h-8 px-4 text-xs bg-rose-600 hover:bg-rose-500 text-white"
              onClick={() => { onApply(draft); setOpen(false); }}>
              تطبيق
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
