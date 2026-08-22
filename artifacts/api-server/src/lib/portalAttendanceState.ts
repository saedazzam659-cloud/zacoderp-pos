import type { ScheduleInput } from "./attendanceEngine.js";

export type PortalPunchMovement = {
  time: string;
  type: "in" | "out";
};

export type PortalPunchState = {
  state: "not_started" | "working" | "completed" | "needs_hr_review";
  checkIn: string | null;
  checkOut: string | null;
  canCheckIn: boolean;
  canCheckOut: boolean;
};

export const ATTENDANCE_TIME_ZONE = "Asia/Riyadh";

const toMinutes = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + (minutes || 0);
};

export function zonedDateAndTime(
  instant = new Date(),
  timeZone = ATTENDANCE_TIME_ZONE,
): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

export function isTimeInWindow(time: string, start: string, end: string): boolean {
  const value = toMinutes(time);
  const from = toMinutes(start);
  const to = toMinutes(end);
  return to > from
    ? value >= from && value < to
    : value >= from || value < to;
}

export function addIsoDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function scheduleCrossesMidnight(schedule: ScheduleInput | null): boolean {
  return !!schedule
    && (!!schedule.crossesMidnight || toMinutes(schedule.workEnd) <= toMinutes(schedule.workStart));
}

export function isOvernightTailTime(time: string, schedule: ScheduleInput | null): boolean {
  return scheduleCrossesMidnight(schedule)
    && !!schedule
    && toMinutes(time) <= toMinutes(schedule.workEnd);
}

/**
 * Resolve the attendance workday, not merely the calendar date. A punch in the
 * tail of an overnight shift belongs to the day on which that shift started.
 */
export function resolvePortalWorkdayDate(
  calendarDate: string,
  localTime: string,
  schedule: ScheduleInput | null,
): string {
  if (!scheduleCrossesMidnight(schedule) || !schedule) return calendarDate;
  return toMinutes(localTime) <= toMinutes(schedule.workEnd)
    ? addIsoDays(calendarDate, -1)
    : calendarDate;
}

/**
 * Employee-portal punches are a one-session state machine. Extra movements may
 * still be entered by HR through the audited back-office exception flow, but
 * the employee portal itself never opens a second session in the same workday.
 */
export function derivePortalPunchState(
  movements: PortalPunchMovement[],
  schedule: ScheduleInput | null,
  legacyDay?: { checkIn?: string | null; checkOut?: string | null } | null,
): PortalPunchState {
  if (!movements.length && legacyDay && (legacyDay.checkIn || legacyDay.checkOut)) {
    if (legacyDay.checkIn && legacyDay.checkOut) {
      return {
        state: "completed",
        checkIn: legacyDay.checkIn,
        checkOut: legacyDay.checkOut,
        canCheckIn: false,
        canCheckOut: false,
      };
    }
    return {
      state: "needs_hr_review",
      checkIn: legacyDay.checkIn ?? null,
      checkOut: legacyDay.checkOut ?? null,
      canCheckIn: false,
      canCheckOut: false,
    };
  }
  const crossRef = scheduleCrossesMidnight(schedule) && schedule
    ? toMinutes(schedule.workStart)
    : null;
  const normalized = movements
    .map((movement) => {
      let minute = toMinutes(movement.time);
      if (crossRef != null && minute < crossRef) minute += 1440;
      return { ...movement, minute };
    })
    .sort((a, b) => a.minute - b.minute || (a.type === "in" ? -1 : 1));

  const ins = normalized.filter((movement) => movement.type === "in");
  const outs = normalized.filter((movement) => movement.type === "out");
  const firstIn = ins[0] ?? null;
  const validOuts = firstIn
    ? outs.filter((movement) => movement.minute > firstIn.minute)
    : [];
  const lastOut = validOuts.at(-1) ?? null;
  if (!firstIn && outs.length > 0) {
    return {
      state: "needs_hr_review",
      checkIn: null,
      checkOut: outs.at(-1)?.time ?? null,
      canCheckIn: false,
      canCheckOut: false,
    };
  }
  if (!firstIn) {
    return {
      state: "not_started",
      checkIn: null,
      checkOut: null,
      canCheckIn: true,
      canCheckOut: false,
    };
  }
  if (!lastOut) {
    return {
      state: "working",
      checkIn: firstIn.time,
      checkOut: null,
      canCheckIn: false,
      canCheckOut: true,
    };
  }
  return {
    state: "completed",
    checkIn: firstIn.time,
    checkOut: lastOut.time,
    canCheckIn: false,
    canCheckOut: false,
  };
}