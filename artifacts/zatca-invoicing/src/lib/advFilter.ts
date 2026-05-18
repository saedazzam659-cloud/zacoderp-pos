/**
 * Shared per-column "advanced filter" primitives — two conditions joined by
 * AND/OR. Used by every audit-grid screen (SalesAuditGrid, SalesQuotations,
 * SalesOrders, Purchase*, Inventory*, …) so the filter UX/behavior is
 * identical across the system.
 *
 * Types only + pure helpers — the React popover lives in
 * `components/auditGrid/AdvFilterPopover.tsx`.
 */
import type { ColType } from "./auditGridLayout";

export type AdvOp =
  | "contains" | "ncontains" | "eq" | "neq" | "starts" | "ends"
  | "empty" | "nempty"
  | "gt" | "gte" | "lt" | "lte" | "between";

export type AdvCond = { op: AdvOp; v: string; v2?: string };
export type AdvFilter = { c1: AdvCond; conn: "and" | "or"; c2: AdvCond };

const DEFAULT_TEXT_COND: AdvCond = { op: "contains", v: "" };
const DEFAULT_NUM_COND:  AdvCond = { op: "eq",       v: "" };

export const defaultAdv = (type: ColType): AdvFilter => {
  const c = type === "num" ? DEFAULT_NUM_COND : DEFAULT_TEXT_COND;
  return { c1: { ...c }, conn: "and", c2: { ...c } };
};

export interface OpMeta { value: AdvOp; label: string; needsValue: boolean; needsV2?: boolean }

export const TEXT_OPS: ReadonlyArray<OpMeta> = [
  { value: "contains",  label: "يحتوي على",    needsValue: true  },
  { value: "ncontains", label: "لا يحتوي على", needsValue: true  },
  { value: "eq",        label: "يساوي",        needsValue: true  },
  { value: "neq",       label: "لا يساوي",     needsValue: true  },
  { value: "starts",    label: "يبدأ بـ",      needsValue: true  },
  { value: "ends",      label: "ينتهي بـ",     needsValue: true  },
  { value: "empty",     label: "فارغ",         needsValue: false },
  { value: "nempty",    label: "غير فارغ",     needsValue: false },
];

export const NUM_OPS: ReadonlyArray<OpMeta> = [
  { value: "eq",      label: "يساوي",        needsValue: true  },
  { value: "neq",     label: "لا يساوي",     needsValue: true  },
  { value: "gt",      label: "أكبر من",      needsValue: true  },
  { value: "gte",     label: "أكبر أو يساوي", needsValue: true },
  { value: "lt",      label: "أصغر من",      needsValue: true  },
  { value: "lte",     label: "أصغر أو يساوي", needsValue: true },
  { value: "between", label: "بين",          needsValue: true, needsV2: true },
  { value: "empty",   label: "فارغ",         needsValue: false },
  { value: "nempty",  label: "غير فارغ",     needsValue: false },
];

export const OPS_FOR = (t: ColType): ReadonlyArray<OpMeta> =>
  t === "num" ? NUM_OPS : TEXT_OPS;

// "Is this single condition meaningful enough to filter?" — empty/nempty
// always count, between needs both endpoints, others need a non-empty value.
export const isCondActive = (c: AdvCond | undefined): boolean => {
  if (!c?.op) return false;
  if (c.op === "empty" || c.op === "nempty") return true;
  if (c.op === "between") return c.v !== "" && (c.v2 ?? "") !== "";
  return c.v !== "";
};

export const isAdvActive = (a: AdvFilter | undefined): boolean =>
  !!a && (isCondActive(a.c1) || isCondActive(a.c2));

// Returns true/false if the condition applies, or null when it should be
// skipped (no value entered) so the rest of the expression decides.
export function evalCond(raw: unknown, c: AdvCond | undefined, type: ColType): boolean | null {
  if (!c?.op) return null;
  if (c.op === "empty")  return raw == null || String(raw).trim() === "";
  if (c.op === "nempty") return !(raw == null || String(raw).trim() === "");
  if (type === "num") {
    if (c.op === "between") {
      if (c.v === "" || (c.v2 ?? "") === "") return null;
      const num = Number(raw ?? 0);
      const a = Number(c.v); const b = Number(c.v2);
      if (!Number.isFinite(num) || !Number.isFinite(a) || !Number.isFinite(b)) return false;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return num >= lo && num <= hi;
    }
    if (c.v === "") return null;
    const num = Number(raw ?? 0);
    const v = Number(c.v);
    if (!Number.isFinite(num) || !Number.isFinite(v)) return false;
    switch (c.op) {
      case "eq":  return Math.abs(num - v) < 1e-9;
      case "neq": return Math.abs(num - v) >= 1e-9;
      case "gt":  return num >  v;
      case "gte": return num >= v;
      case "lt":  return num <  v;
      case "lte": return num <= v;
      default:    return null;
    }
  }
  if (c.v === "") return null;
  const s = String(raw ?? "").toLowerCase();
  const q = c.v.toLowerCase();
  switch (c.op) {
    case "contains":  return s.includes(q);
    case "ncontains": return !s.includes(q);
    case "eq":        return s === q;
    case "neq":       return s !== q;
    case "starts":    return s.startsWith(q);
    case "ends":      return s.endsWith(q);
    default:          return null;
  }
}

export function matchAdv(raw: unknown, adv: AdvFilter | undefined, type: ColType): boolean {
  if (!adv) return true;
  const r1 = evalCond(raw, adv.c1, type);
  const r2 = evalCond(raw, adv.c2, type);
  if (r1 == null && r2 == null) return true;
  if (r1 == null) return r2!;
  if (r2 == null) return r1;
  return adv.conn === "or" ? (r1 || r2) : (r1 && r2);
}

// Build a one-line human summary, used as a header tooltip when a filter
// is active so the user can recall what they set without re-opening.
export function describeCond(c: AdvCond, type: ColType): string {
  const ops = OPS_FOR(type);
  const lbl = ops.find(o => o.value === c.op)?.label ?? c.op;
  if (c.op === "empty" || c.op === "nempty") return lbl;
  if (c.op === "between") return `${lbl} ${c.v} - ${c.v2 ?? ""}`;
  return `${lbl} "${c.v}"`;
}

export function describeAdv(adv: AdvFilter | undefined, type: ColType): string {
  if (!isAdvActive(adv)) return "";
  const a1 = isCondActive(adv!.c1) ? describeCond(adv!.c1, type) : "";
  const a2 = isCondActive(adv!.c2) ? describeCond(adv!.c2, type) : "";
  if (a1 && a2) return `${a1}  ${adv!.conn === "or" ? "أو" : "و"}  ${a2}`;
  return a1 || a2;
}
