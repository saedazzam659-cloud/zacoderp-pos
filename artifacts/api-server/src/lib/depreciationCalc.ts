// ─────────────────────────────────────────────────────────────────────────
// Shared fixed-assets depreciation math.
//
// Single source of truth for how much depreciation a straight-line asset
// accrues in a given calendar month. The method is DAY-BASED (pro-rata):
//
//   dailyRate = (purchaseValue - scrapValue) / totalLifeDays
//   monthAmount = dailyRate × (days of that month that fall inside the
//                 asset's useful life)
//
// So the first (partial) month charges only from the depreciation-start day
// to the month-end, subsequent full months charge by their real length
// (28/29/30/31), and the final month charges only up to the last life day.
// `buildSchedule` distributes rounding so the running total lands exactly on
// (purchase - scrap).
//
// `declining_balance` keeps the legacy monthly formula (book × 2/life / 12)
// — the day-based treatment applies to straight_line only.
// ─────────────────────────────────────────────────────────────────────────

export interface AssetCalcInput {
  purchaseValue: number;
  scrapValue: number;
  lifeYears: number;
  depreciationMethod: string;
  depreciationStart?: string | null; // 'YYYY-MM-DD'
  purchaseDate?: string | null;      // fallback start when no depreciationStart
  accumulatedDepreciation?: number;
  // "المجمع حتى تاريخ" — when set (straight-line only), the manually-entered
  // accumulatedDepreciation is treated as covering the life up to this date
  // (inclusive). Charging RESUMES the next day and the remaining base
  // (purchase - scrap - accum) is spread over the REMAINING life days, so the
  // asset still finishes exactly on its original last life day. NULL/absent =
  // legacy full-life daily rate (behavior unchanged for existing assets).
  accumAsOf?: string | null;         // 'YYYY-MM-DD'
  // Frozen opening-accum snapshot paired with accumAsOf. The live rolling
  // accumulatedDepreciation grows with every posted run — the resume rate must
  // be derived from THIS frozen figure or the daily rate drifts every month.
  accumAsOfAmount?: number | null;
}

const MS_DAY = 86_400_000;

// Days in a 1-based month (month 1..12). new Date(y, m, 0) = last day of month m.
export function daysInMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12, 0).getDate();
}

// Parse 'YYYY-MM-DD' at UTC noon to dodge timezone day-shift.
function parseDate(s?: string | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0));
}

// Add whole calendar months, clamping the day to the target month length.
function addMonths(d: Date, months: number): Date {
  const day = d.getUTCDate();
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 12, 0, 0));
  r.setUTCMonth(r.getUTCMonth() + months);
  const dim = daysInMonth(r.getUTCFullYear(), r.getUTCMonth() + 1);
  r.setUTCDate(Math.min(day, dim));
  return r;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS_DAY);
}

// Inclusive day count between two UTC-noon dates (a..b, both ends counted).
function dayDiffInclusive(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_DAY) + 1;
}

export interface LifeWindow {
  effStart: Date;       // first day depreciation runs
  lastLifeDay: Date;    // last day depreciation runs (inclusive)
  totalLifeDays: number;
  dailyRate: number;    // straight-line only (0 otherwise)
  depreciableBase: number;
  months: number;
}

// Resolve the depreciation window + daily rate for an asset, or null when the
// asset cannot depreciate (no start date, zero base, etc.).
export function lifeWindow(input: AssetCalcInput): LifeWindow | null {
  const purchase = Number(input.purchaseValue || 0);
  const scrap = Number(input.scrapValue || 0);
  const depreciableBase = purchase - scrap;
  if (!(depreciableBase > 0)) return null;

  const effStart = parseDate(input.depreciationStart) ?? parseDate(input.purchaseDate);
  if (!effStart) return null;

  const years = Math.max(1 / 12, Number(input.lifeYears || 1));
  const months = Math.max(1, Math.round(years * 12));

  // Resume mode ("المجمع حتى تاريخ"): the entered accumulated depreciation
  // covers the life up to accumAsOf, so charging resumes at accumAsOf+1 and
  // the REMAINING base is spread over the REMAINING days. Only honored when
  // the date is valid, inside the life window, and only for straight_line
  // (the declining_balance path never reads dailyRate/effStart from here for
  // its charge — it uses the rolling book).
  const method = String(input.depreciationMethod || "straight_line");
  const asOf = method === "straight_line" ? parseDate(input.accumAsOf) : null;

  // With "المجمع حتى تاريخ" the asset's LIFE is anchored at the PURCHASE
  // date (the opening accum covers purchase..asOf) — even when the form's
  // depreciationStart was set to asOf+1. Otherwise a 7y asset bought in
  // 2022 with accum through 2025 would wrongly run 7 MORE years from 2025.
  let lifeAnchor = effStart;
  if (asOf) {
    const pd = parseDate(input.purchaseDate);
    if (pd && pd < lifeAnchor && asOf >= pd) lifeAnchor = pd;
  }
  const endExclusive = addMonths(lifeAnchor, months);
  const lastLifeDay = addDays(endExclusive, -1);

  if (asOf && asOf >= lifeAnchor && asOf < lastLifeDay) {
    const resumeStart = addDays(asOf, 1);
    // Prefer the frozen snapshot; fall back to the live accum only when no
    // snapshot exists (first save, before any new run posts).
    const accum = Math.max(0, Number(input.accumAsOfAmount ?? input.accumulatedDepreciation ?? 0));
    const remainingBase = depreciableBase - accum;
    if (!(remainingBase > 0)) return null; // fully depreciated already
    const remainingDays = Math.max(1, dayDiffInclusive(resumeStart, lastLifeDay));
    return {
      effStart: resumeStart,
      lastLifeDay,
      totalLifeDays: remainingDays,
      dailyRate: remainingBase / remainingDays,
      depreciableBase: remainingBase,
      months,
    };
  }

  // Life already over before charging would start (e.g. purchase-anchored
  // life expired before the form's depreciationStart) → nothing to charge.
  if (lastLifeDay < effStart) return null;

  const totalLifeDays = Math.max(1, dayDiffInclusive(effStart, lastLifeDay));
  const dailyRate = depreciableBase / totalLifeDays;

  return { effStart, lastLifeDay, totalLifeDays, dailyRate, depreciableBase, months };
}

export interface PeriodResult {
  amount: number;       // raw depreciation for the period (un-capped, 2dp)
  daysCharged: number;  // days of this month inside the asset life
}

// Depreciation for a specific calendar (month,year), before capping against
// the remaining depreciable balance (the caller applies min(amount,remaining)).
export function computePeriodDepreciation(
  input: AssetCalcInput,
  month: number,
  year: number,
): PeriodResult {
  const method = String(input.depreciationMethod || "straight_line");

  if (method === "declining_balance") {
    // Legacy monthly double-declining — not day-based.
    const purchase = Number(input.purchaseValue || 0);
    const scrap = Number(input.scrapValue || 0);
    const accum = Number(input.accumulatedDepreciation || 0);
    const years = Math.max(1 / 12, Number(input.lifeYears || 1));
    const win = lifeWindow(input);
    // Respect the start date: no charge before the asset begins depreciating.
    if (win) {
      const monthStart = new Date(Date.UTC(year, month - 1, 1, 12));
      if (monthStart < new Date(Date.UTC(win.effStart.getUTCFullYear(), win.effStart.getUTCMonth(), 1, 12))) {
        return { amount: 0, daysCharged: 0 };
      }
    }
    const book = Math.max(scrap, purchase - accum);
    const monthly = (book * (2 / years)) / 12;
    return { amount: Number(monthly.toFixed(2)), daysCharged: daysInMonth(year, month) };
  }

  const win = lifeWindow(input);
  if (!win) return { amount: 0, daysCharged: 0 };

  const monthStart = new Date(Date.UTC(year, month - 1, 1, 12));
  const monthEnd = new Date(Date.UTC(year, month - 1, daysInMonth(year, month), 12));
  const chargeStart = win.effStart > monthStart ? win.effStart : monthStart;
  const chargeEnd = win.lastLifeDay < monthEnd ? win.lastLifeDay : monthEnd;
  if (chargeStart > chargeEnd) return { amount: 0, daysCharged: 0 };

  const daysCharged = dayDiffInclusive(chargeStart, chargeEnd);
  const amount = win.dailyRate * daysCharged;
  return { amount: Number(amount.toFixed(2)), daysCharged };
}

export interface ScheduleRow {
  year: number;
  month: number;       // 1..12
  days: number;        // days charged that month
  amount: number;      // depreciation for the month (2dp, remainder-adjusted)
  cumulative: number;  // accumulated depreciation after this month (2dp)
}

export interface ScheduleRunIdentity {
  id: number;
  periodYear: number;
  periodMonth: number;
  status: string;
}

export type ScheduleRowWithRun = ScheduleRow & {
  posted: boolean;
  runId: number | null;
  runStatus: string | null;
};

/**
 * Add persisted run identity to calculated schedule months without modifying
 * any depreciation values. A posted run wins defensively if legacy duplicate
 * rows exist, preserving the schedule's existing "any posted run" semantics.
 */
export function overlayScheduleRuns(
  schedule: ScheduleRow[],
  runs: ScheduleRunIdentity[],
): ScheduleRowWithRun[] {
  const runsByPeriod = new Map<string, ScheduleRunIdentity>();
  for (const run of runs) {
    const key = `${run.periodYear}-${run.periodMonth}`;
    const current = runsByPeriod.get(key);
    if (!current || (current.status !== "posted" && run.status === "posted")) {
      runsByPeriod.set(key, run);
    }
  }

  return schedule.map((row) => {
    const run = runsByPeriod.get(`${row.year}-${row.month}`);
    return {
      ...row,
      posted: run?.status === "posted",
      runId: run?.id ?? null,
      runStatus: run?.status ?? null,
    };
  });
}

// Full month-by-month depreciation schedule across the asset's life.
// Rounding remainder is folded into the final charged month so the
// cumulative total lands exactly on the depreciable base.
export function buildSchedule(input: AssetCalcInput): ScheduleRow[] {
  const win = lifeWindow(input);
  if (!win) return [];

  const method = String(input.depreciationMethod || "straight_line");
  const rows: ScheduleRow[] = [];
  let cumulative = 0;
  // Rolling accumulated depreciation from the asset's current book. Only
  // declining_balance depends on it (its monthly charge decays as the book
  // shrinks); straight_line day-based ignores accum entirely.
  const startAccum = Number(input.accumulatedDepreciation || 0);
  let y = win.effStart.getUTCFullYear();
  let m = win.effStart.getUTCMonth() + 1;
  const endY = win.lastLifeDay.getUTCFullYear();
  const endM = win.lastLifeDay.getUTCMonth() + 1;

  // Hard stop guards against any date math surprise (max ~ life months + 2).
  const guard = win.months + 4;
  let steps = 0;

  while ((y < endY || (y === endY && m <= endM)) && steps < guard) {
    // Feed the running book back in so declining_balance actually decays.
    const periodInput = method === "declining_balance"
      ? { ...input, accumulatedDepreciation: startAccum + cumulative }
      : input;
    const { amount, days } = computePeriodDepreciation(periodInput, m, y);
    const isLast = y === endY && m === endM;
    let charge = amount;
    if (isLast) {
      // Final month absorbs the rounding remainder.
      charge = Number((win.depreciableBase - cumulative).toFixed(2));
    } else if (cumulative + charge > win.depreciableBase) {
      charge = Number((win.depreciableBase - cumulative).toFixed(2));
    }
    if (charge < 0) charge = 0;
    cumulative = Number((cumulative + charge).toFixed(2));
    rows.push({ year: y, month: m, days, amount: charge, cumulative });

    if (m === 12) { m = 1; y += 1; } else { m += 1; }
    steps += 1;
  }

  return rows;
}
