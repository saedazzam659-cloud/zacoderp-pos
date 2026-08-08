/**
 * Attendance & Time Management engine (محرك الحضور والانصراف).
 *
 * Derives the daily attendance result for one employee from:
 *   - the CONTRACT schedule (never re-entered daily) + optional shift
 *   - raw punch movements (device / mobile / manual / API)
 *   - APPROVED exit permissions (استئذان خروج)
 *   - leaves / rest days
 *
 * CORE RULE (قاعدة 16 — عدم التكرار):
 * Every scheduled minute lands in EXACTLY ONE bucket:
 *   worked | paidPermission | unpaidPermission | late | earlyLeave | missing
 * An approved permission window is NEVER also counted as lateness, early
 * leave, absence, or missing hours. Buckets are computed minute-interval
 * based (overlap arithmetic), not by subtracting aggregates, so the same
 * minute cannot appear twice.
 *
 * Raw movements are never mutated by recalc (قاعدة 29) — only derived
 * results are rewritten.
 */

export interface ScheduleInput {
  workStart: string;          // "08:00"
  workEnd: string;            // "16:00" (may be <= workStart → crosses midnight)
  crossesMidnight?: boolean;
  breakMinutes?: number;      // scheduled unpaid break
  lateGraceMin?: number;
  earlyGraceMin?: number;
  overtimeMinMinutes?: number;
  overtimePolicy?: string;    // none | after_shift
  restDays?: number[];        // JS getDay() numbers, 0=Sun … 6=Sat
}

export interface MovementInput { time: string; type: "in" | "out" }
export interface PermissionInput { startTime: string; endTime: string; paid: boolean; id?: number }

export interface DayContext {
  date: string;                       // ISO YYYY-MM-DD
  schedule: ScheduleInput | null;     // null → no schedule (rest handling only)
  movements: MovementInput[];
  permissions: PermissionInput[];     // APPROVED only
  onLeave?: boolean;
  leavePaid?: boolean;
  isHoliday?: boolean;                // official holiday
}

export interface DayResult {
  status: string;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;        // inside+outside schedule actual presence
  netMinutes: number;           // worked − scheduled break
  breakMinutes: number;         // gaps NOT covered by permission
  lateMinutes: number;          // after grace, permission-excluded
  earlyLeaveMinutes: number;    // after grace, permission-excluded
  overtimeMinutes: number;      // beyond schedule per policy + threshold
  permissionPaidMinutes: number;
  permissionUnpaidMinutes: number;
  missingMinutes: number;       // scheduled, unworked, not permission/late/early
  scheduledMinutes: number;
  violations: string[];         // machine keys, UI translates
}

const toMin = (t: string): number => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
};
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

type Interval = [number, number];

/** Overlap in minutes between one interval and a set of intervals (set assumed disjoint). */
function overlap(a: Interval, set: Interval[]): number {
  let s = 0;
  for (const b of set) s += Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  return s;
}

/** Merge possibly-overlapping intervals into a disjoint sorted set. */
function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([...iv] as Interval);
  }
  return out;
}

/** Subtract set B from set A (both disjoint sorted), returning remaining intervals of A. */
function subtract(a: Interval[], b: Interval[]): Interval[] {
  let cur = a.map((iv) => [...iv] as Interval);
  for (const cut of b) {
    const next: Interval[] = [];
    for (const iv of cur) {
      if (cut[1] <= iv[0] || cut[0] >= iv[1]) { next.push(iv); continue; }
      if (cut[0] > iv[0]) next.push([iv[0], cut[0]]);
      if (cut[1] < iv[1]) next.push([cut[1], iv[1]]);
    }
    cur = next;
  }
  return cur;
}

const total = (set: Interval[]): number => set.reduce((s, [a, b]) => s + (b - a), 0);

/**
 * Pair raw punches into presence sessions. Tolerates missing punches:
 * an "in" without "out" (or vice versa) is flagged, not guessed.
 * For cross-midnight shifts, times < workStart are treated as next-day
 * (offset +24h) so ordering stays monotonic.
 */
function buildSessions(movs: MovementInput[], crossRef: number | null): { sessions: Interval[]; flags: string[] } {
  const flags: string[] = [];
  const norm = movs
    .map((m) => {
      let t = toMin(m.time);
      if (crossRef != null && t < crossRef) t += 1440;
      return { t, type: m.type };
    })
    .sort((a, b) => a.t - b.t || (a.type === "in" ? -1 : 1));
  const sessions: Interval[] = [];
  let open: number | null = null;
  for (const m of norm) {
    if (m.type === "in") {
      if (open != null) flags.push("missing_out");   // two ins in a row
      open = m.t;
    } else {
      if (open == null) { flags.push("missing_in"); continue; }
      if (m.t > open) sessions.push([open, m.t]);
      open = null;
    }
  }
  if (open != null) flags.push("missing_out");
  return { sessions: mergeIntervals(sessions), flags };
}

export function computeDay(ctx: DayContext): DayResult {
  const res: DayResult = {
    status: "absent", firstIn: null, lastOut: null,
    workedMinutes: 0, netMinutes: 0, breakMinutes: 0,
    lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0,
    permissionPaidMinutes: 0, permissionUnpaidMinutes: 0,
    missingMinutes: 0, scheduledMinutes: 0, violations: [],
  };

  const sched = ctx.schedule;
  const dayOfWeek = new Date(ctx.date + "T00:00:00").getDay();
  const isRest = !!sched?.restDays?.includes(dayOfWeek);

  // Cross-midnight normalization anchor
  const crosses = !!sched && (sched.crossesMidnight || toMin(sched.workEnd) <= toMin(sched.workStart));
  const schedStart = sched ? toMin(sched.workStart) : null;
  const schedEnd = sched ? toMin(sched.workEnd) + (crosses ? 1440 : 0) : null;
  const crossRef = crosses && schedStart != null ? schedStart : null;

  const { sessions, flags } = buildSessions(ctx.movements, crossRef);
  res.violations.push(...new Set(flags));

  if (sessions.length) {
    const fmt = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    res.firstIn = fmt(sessions[0][0]);
    res.lastOut = fmt(sessions[sessions.length - 1][1]);
  }
  res.workedMinutes = total(sessions);

  // Non-working-day statuses first
  if (ctx.isHoliday) { res.status = "official_holiday"; return finalizeOffDay(res, sessions, sched); }
  if (isRest)        { res.status = "weekend";          return finalizeOffDay(res, sessions, sched); }
  if (ctx.onLeave)   { res.status = "leave";            return res; }

  if (!sched || schedStart == null || schedEnd == null) {
    // No schedule: presence-only
    res.netMinutes = res.workedMinutes;
    res.status = sessions.length ? "present" : "absent";
    return res;
  }

  const span = schedEnd - schedStart;                       // full schedule window
  const breakAllow = sched.breakMinutes || 0;
  res.scheduledMinutes = Math.max(0, span - breakAllow);    // expected NET work minutes

  // Approved permission windows clipped to the schedule (rule 16 scope)
  const permsRaw: { iv: Interval; paid: boolean }[] = ctx.permissions
    .map((p) => {
      let s = toMin(p.startTime), e = toMin(p.endTime);
      if (crossRef != null) { if (s < crossRef) s += 1440; if (e <= crossRef) e += 1440; }
      return { iv: [clamp(s, schedStart, schedEnd), clamp(e, schedStart, schedEnd)] as Interval, paid: p.paid };
    })
    .filter((p) => p.iv[1] > p.iv[0]);
  const paidPermSet = mergeIntervals(permsRaw.filter((p) => p.paid).map((p) => p.iv));
  // Unpaid set excludes any overlap with paid (paid wins → no double count)
  const unpaidPermSet = subtract(mergeIntervals(permsRaw.filter((p) => !p.paid).map((p) => p.iv)), paidPermSet);
  const allPermSet = mergeIntervals([...paidPermSet, ...unpaidPermSet]);

  // Permission minutes counted ONLY where the employee was actually absent
  // during the window (present minutes stay "worked" — one bucket per minute).
  const absentDuringPerm = (set: Interval[]) => total(subtract(set, sessions));
  res.permissionPaidMinutes = absentDuringPerm(paidPermSet);
  res.permissionUnpaidMinutes = absentDuringPerm(unpaidPermSet);

  if (!sessions.length) {
    // Fully absent day (permission may still cover part of it).
    // Absent scheduled-work minutes = span − break allowance − permission.
    res.missingMinutes = Math.max(0, span - breakAllow - res.permissionPaidMinutes - res.permissionUnpaidMinutes);
    res.status = allPermSet.length ? "exit_permission" : "absent";
    if (!allPermSet.length) res.violations.push("absent");
    return res;
  }

  // ── Single-bucket partition of the schedule window [schedStart, schedEnd] ──
  // span = workedInSched + perm(absent-only) + lateRaw + earlyRaw + break + missing
  // Grace-forgiven late/early minutes stay inside lateRaw/earlyRaw (they are
  // simply not REPORTED as late/early), so they never leak into "missing".

  const firstIn = sessions[0][0];
  const lastOut = sessions[sessions.length - 1][1];

  // Lateness: schedule start → first presence, minus permission overlap
  let lateRaw = 0;
  if (firstIn > schedStart) {
    const lateIv: Interval = [schedStart, Math.min(firstIn, schedEnd)];
    lateRaw = Math.max(0, lateIv[1] - lateIv[0] - overlap(lateIv, allPermSet));
    res.lateMinutes = lateRaw > (sched.lateGraceMin || 0) ? lateRaw : 0;
    if (res.lateMinutes > 0) res.violations.push("late");
  }

  // Early leave: last presence → schedule end, minus permission overlap
  let earlyRaw = 0;
  if (lastOut < schedEnd) {
    const earlyIv: Interval = [Math.max(lastOut, schedStart), schedEnd];
    earlyRaw = Math.max(0, earlyIv[1] - earlyIv[0] - overlap(earlyIv, allPermSet));
    res.earlyLeaveMinutes = earlyRaw > (sched.earlyGraceMin || 0) ? earlyRaw : 0;
    if (res.earlyLeaveMinutes > 0) res.violations.push("early_leave");
  }

  // Presence clipped to the schedule window
  const workedInSched = total(
    sessions.map((s) => [clamp(s[0], schedStart, schedEnd), clamp(s[1], schedStart, schedEnd)] as Interval)
      .filter(([a, b]) => b > a),
  );

  // Mid-day gaps (between first-in and last-out, inside schedule, not covered
  // by presence or permission) → allowed break first, remainder → missing.
  const midIv: Interval[] = [[Math.max(schedStart, Math.min(firstIn, schedEnd)), Math.min(Math.max(lastOut, schedStart), schedEnd)]]
    .filter(([a, b]) => b > a) as Interval[];
  const gaps = subtract(subtract(midIv, sessions), allPermSet);
  const gapMinutes = total(gaps);
  res.breakMinutes = Math.min(gapMinutes, breakAllow);
  const excessGap = gapMinutes - res.breakMinutes;

  // Missing = whatever the partition leaves over (≡ excess mid-day gap).
  res.missingMinutes = Math.max(0, span
    - workedInSched
    - res.permissionPaidMinutes - res.permissionUnpaidMinutes
    - lateRaw - earlyRaw
    - res.breakMinutes);
  if (excessGap > 0) res.violations.push("excess_break");
  if (res.missingMinutes > 0 && !res.violations.includes("late") && !res.violations.includes("early_leave")) {
    res.violations.push("missing_hours");
  }

  // ── Overtime: presence OUTSIDE the schedule window, threshold-gated ──
  if ((sched.overtimePolicy || "after_shift") !== "none") {
    const outside = subtract(sessions, [[schedStart, schedEnd]]);
    const ot = total(outside);
    res.overtimeMinutes = ot >= (sched.overtimeMinMinutes || 0) ? ot : 0;
  }

  res.netMinutes = Math.max(0, res.workedMinutes - res.breakMinutes);

  // ── Status ──
  if (res.permissionPaidMinutes + res.permissionUnpaidMinutes > 0) res.status = "exit_permission";
  else if (res.lateMinutes > 0) res.status = "late";
  else if (res.missingMinutes > 0 || res.earlyLeaveMinutes > 0) res.status = "partial";
  else res.status = "present";
  return res;
}

/** Rest/holiday day: any presence is pure overtime (no lateness concepts). */
function finalizeOffDay(res: DayResult, sessions: Interval[], sched: ScheduleInput | null): DayResult {
  res.netMinutes = res.workedMinutes;
  if (res.workedMinutes > 0) {
    const min = sched?.overtimeMinMinutes || 0;
    res.overtimeMinutes = res.workedMinutes >= min ? res.workedMinutes : 0;
  }
  return res;
}

/** Resolve the effective schedule for an employee from contract + shift rows. */
export function resolveSchedule(contract: any | null, shift: any | null): ScheduleInput | null {
  const parseRest = (v: any): number[] | undefined => {
    if (!v) return undefined;
    try { const a = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(a) ? a.map(Number).filter((n) => n >= 0 && n <= 6) : undefined; }
    catch { return undefined; }
  };
  const workStart = contract?.workStart || shift?.startTime;
  const workEnd = contract?.workEnd || shift?.endTime;
  if (!workStart || !workEnd) return null;
  return {
    workStart, workEnd,
    crossesMidnight: shift?.crossesMidnight ?? undefined,
    breakMinutes: shift?.breakMinutes ?? 0,
    lateGraceMin: contract?.lateGraceMin ?? shift?.lateGraceMin ?? 0,
    earlyGraceMin: contract?.earlyGraceMin ?? shift?.earlyGraceMin ?? 0,
    overtimeMinMinutes: contract?.overtimeMinMinutes ?? shift?.overtimeMinMinutes ?? 0,
    overtimePolicy: contract?.overtimePolicy ?? "after_shift",
    restDays: parseRest(contract?.restDays) ?? parseRest(shift?.restDays) ?? [5, 6],
  };
}
