import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  derivePortalPunchState,
  isOvernightTailTime,
  isTimeInWindow,
  resolvePortalWorkdayDate,
  zonedDateAndTime,
} from "../src/lib/portalAttendanceState.ts";
import { computeDay } from "../src/lib/attendanceEngine.ts";

const overnight = {
  workStart: "22:00",
  workEnd: "06:00",
  crossesMidnight: true,
};

test("portal workday: a normal shift uses the calendar date", () => {
  assert.equal(
    resolvePortalWorkdayDate("2026-08-22", "09:00", {
      workStart: "08:00",
      workEnd: "17:00",
    }),
    "2026-08-22",
  );
});

test("portal workday: an overnight-shift tail belongs to the prior workday", () => {
  assert.equal(resolvePortalWorkdayDate("2026-08-23", "01:00", overnight), "2026-08-22");
  assert.equal(resolvePortalWorkdayDate("2026-08-23", "22:30", overnight), "2026-08-23");
  assert.equal(isOvernightTailTime("06:00", overnight), true);
  assert.equal(isOvernightTailTime("06:01", overnight), false);
});

test("portal clock: attendance date and time are resolved in Riyadh, not host UTC", () => {
  assert.deepEqual(zonedDateAndTime(new Date("2026-08-22T21:30:00.000Z")), {
    date: "2026-08-23",
    time: "00:30",
  });
  assert.equal(isTimeInWindow("00:30", "23:00", "02:00"), true);
  assert.equal(isTimeInWindow("12:00", "23:00", "02:00"), false);
});

test("portal state: before work only check-in is allowed", () => {
  assert.deepEqual(derivePortalPunchState([], null), {
    state: "not_started",
    checkIn: null,
    checkOut: null,
    canCheckIn: true,
    canCheckOut: false,
  });
});

test("portal state: one check-in disables attendance and enables checkout", () => {
  assert.deepEqual(
    derivePortalPunchState([{ type: "in", time: "08:05" }], null),
    {
      state: "working",
      checkIn: "08:05",
      checkOut: null,
      canCheckIn: false,
      canCheckOut: true,
    },
  );
});

test("portal state: check-in plus checkout completes the workday", () => {
  assert.deepEqual(
    derivePortalPunchState([
      { type: "in", time: "08:05" },
      { type: "out", time: "17:10" },
    ], null),
    {
      state: "completed",
      checkIn: "08:05",
      checkOut: "17:10",
      canCheckIn: false,
      canCheckOut: false,
    },
  );
});

test("portal state: overnight checkout is ordered after the prior-evening check-in", () => {
  assert.deepEqual(
    derivePortalPunchState([
      { type: "out", time: "05:45" },
      { type: "in", time: "22:10" },
    ], overnight),
    {
      state: "completed",
      checkIn: "22:10",
      checkOut: "05:45",
      canCheckIn: false,
      canCheckOut: false,
    },
  );
});

test("portal state: an out-without-in anomaly blocks employee changes for HR review", () => {
  assert.deepEqual(
    derivePortalPunchState([{ type: "out", time: "17:00" }], null),
    {
      state: "needs_hr_review",
      checkIn: null,
      checkOut: "17:00",
      canCheckIn: false,
      canCheckOut: false,
    },
  );
});

test("portal state: a valid session remains complete when HR evidence contains an earlier unmatched out", () => {
  assert.deepEqual(
    derivePortalPunchState([
      { type: "out", time: "07:45" },
      { type: "in", time: "08:00" },
      { type: "out", time: "17:00" },
    ], null),
    {
      state: "completed",
      checkIn: "08:00",
      checkOut: "17:00",
      canCheckIn: false,
      canCheckOut: false,
    },
  );
});

test("portal state: a legacy partial day without raw movements is HR-review-only", () => {
  assert.deepEqual(
    derivePortalPunchState([], null, { checkIn: "08:00", checkOut: null }),
    {
      state: "needs_hr_review",
      checkIn: "08:00",
      checkOut: null,
      canCheckIn: false,
      canCheckOut: false,
    },
  );
});

test("portal state: a legacy completed day stays visible but closed", () => {
  assert.deepEqual(
    derivePortalPunchState([], null, { checkIn: "08:00", checkOut: "17:00" }),
    {
      state: "completed",
      checkIn: "08:00",
      checkOut: "17:00",
      canCheckIn: false,
      canCheckOut: false,
    },
  );
});

test("attendance calculation: approved permission is deducted without out/re-check-in punches", () => {
  const result = computeDay({
    date: "2026-08-23",
    schedule: {
      workStart: "08:00",
      workEnd: "17:00",
      breakMinutes: 0,
      restDays: [],
    },
    movements: [
      { type: "in", time: "08:00" },
      { type: "out", time: "17:00" },
    ],
    permissions: [
      { id: 1, startTime: "10:00", endTime: "13:00", paid: true },
    ],
  });

  assert.equal(result.firstIn, "08:00");
  assert.equal(result.lastOut, "17:00");
  assert.equal(result.workedMinutes, 6 * 60);
  assert.equal(result.netMinutes, 6 * 60);
  assert.equal(result.permissionPaidMinutes, 3 * 60);
  assert.equal(result.missingMinutes, 0);
  assert.equal(result.status, "exit_permission");
});

test("source invariant: portal punch cardinality is locked and approved permissions do not create re-check-ins", () => {
  const route = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/routes/hr-portal.ts"),
    "utf8",
  );
  assert.match(route, /pg_advisory_xact_lock/);
  assert.match(route, /resolvePortalScheduleContext/);
  assert.match(route, /derivedRows\[0\]/);
  assert.match(route, /ATTENDANCE_ALREADY_RECORDED/);
  assert.match(route, /لا يلزم تسجيل حضور جديد بعد الاستئذان/);
  assert.match(route, /eq\(exitPermissionsTable\.status, "approved"\)/);
  assert.doesNotMatch(route, /exitPermissionId:\s*permission/);
});

test("source invariant: portal UI disables check-in from server state and explains approved permission handling", () => {
  const dashboard = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../zacodehr/src/pages/dashboard.tsx"),
    "utf8",
  );
  assert.match(dashboard, /disabled=\{!needsCheckIn/);
  assert.match(dashboard, /disabled=\{!needsCheckOut/);
  assert.match(dashboard, /approved-permission-notice/);
  assert.match(dashboard, /لا تحتاج إلى تسجيل حضور جديد بعد انتهائها/);
});