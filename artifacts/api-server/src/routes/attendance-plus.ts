/**
 * Attendance & Time Management routes (شاشة الحضور والانصراف المطوّرة).
 *
 * Mounted at /api/attendance-plus. Complements the legacy manual rows in
 * routes/employees.ts — the daily employee_attendance row becomes a DERIVED
 * result recomputed from raw movements by lib/attendanceEngine.
 *
 * Anti-duplication guarantees (أهم متطلب — عدم التكرار):
 *  - movements: UNIQUE(employee,date,time,type) + ON CONFLICT DO NOTHING →
 *    duplicate device/manual punches are silently dropped and reported.
 *  - engine: interval arithmetic — a minute is never counted in two buckets
 *    (approved استئذان is never also lateness/early-leave/missing).
 *  - payroll: UNIQUE(company,period) transfer marker → 409 on re-transfer.
 *  - day lock: locked days reject ALL mutations until reopened (audited).
 */
import { Router } from "express";
import { db } from "@workspace/db";
import {
  employeesTable, employeeContractsTable, employeeAttendanceTable, employeeLeavesTable,
  attendanceShiftsTable, attendanceMovementsTable, exitPermissionsTable,
  attendanceDayLocksTable, attendancePayrollTransfersTable, attendanceAuditTable,
} from "@workspace/db";
import { and, eq, asc, desc, gte, lte, inArray, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requireDate, timeOrNull, intOrDefault, oneOf, respondHrError, HrValidationError } from "../lib/hrValidate.js";
import { computeDay, resolveSchedule, type PermissionInput } from "../lib/attendanceEngine.js";

const router = Router();
router.use(extractAuth);

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
const N = (v: any) => (v == null || v === "" ? null : v);
const uid = (req: any): number | null => (Number(req.authUser?.id) || null);

function requireTime(v: any, label: string): string {
  const t = timeOrNull(v, label);
  if (!t) throw new HrValidationError(`${label} مطلوب`);
  return t;
}

async function audit(cid: number, req: any, action: string, entity: string, entityId: number | null, extra: { old?: any; nu?: any; reason?: string } = {}) {
  try {
    await db.insert(attendanceAuditTable).values({
      companyId: cid, userId: uid(req), action, entity, entityId,
      oldValue: extra.old != null ? JSON.stringify(extra.old) : null,
      newValue: extra.nu != null ? JSON.stringify(extra.nu) : null,
      reason: N(extra.reason),
      ip: String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].slice(0, 64) || null,
    });
  } catch { /* audit must never break the operation */ }
}

import { assertDayOpen, assertPeriodNotTransferred } from "../lib/attendanceLocks.js";

async function assertEmployee(cid: number, employeeId: number) {
  const [e] = await db.select({ id: employeesTable.id }).from(employeesTable)
    .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid)));
  if (!e) throw new HrValidationError("الموظف غير موجود ضمن الشركة");
}

// ═══════════════════ Effective schedule resolution ═══════════════════

async function loadSchedules(cid: number, employeeIds: number[], date: string) {
  if (!employeeIds.length) return new Map<number, any>();
  const contracts = await db.select().from(employeeContractsTable)
    .where(and(
      eq(employeeContractsTable.companyId, cid),
      inArray(employeeContractsTable.employeeId, employeeIds),
      eq(employeeContractsTable.status, "active"),
      lte(employeeContractsTable.startDate, date),
    ))
    .orderBy(desc(employeeContractsTable.startDate));
  const byEmp = new Map<number, any>();
  for (const c of contracts) {
    if (c.endDate && c.endDate < date) continue;
    if (!byEmp.has(c.employeeId)) byEmp.set(c.employeeId, c);
  }
  const shiftIds = [...new Set([...byEmp.values()].map((c) => c.shiftId).filter(Boolean))] as number[];
  const shifts = shiftIds.length
    ? await db.select().from(attendanceShiftsTable)
        .where(and(eq(attendanceShiftsTable.companyId, cid), inArray(attendanceShiftsTable.id, shiftIds)))
    : [];
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const out = new Map<number, any>();
  for (const id of employeeIds) {
    const c = byEmp.get(id) ?? null;
    out.set(id, { contract: c, shift: c?.shiftId ? shiftById.get(c.shiftId) ?? null : null });
  }
  return out;
}

// ═══════════════════ Recalc core (قاعدة 29) ═══════════════════

export async function recalcDay(cid: number, date: string, employeeIds?: number[]) {
  const empConds = [eq(employeesTable.companyId, cid), eq(employeesTable.status, "active")];
  const emps = await db.select({ id: employeesTable.id }).from(employeesTable).where(and(...empConds));
  let ids = emps.map((e) => e.id);
  if (employeeIds?.length) ids = ids.filter((i) => employeeIds.includes(i));
  if (!ids.length) return { updated: 0 };

  // Cross-midnight shifts end on the NEXT calendar day, so out-punches land on
  // date+1 — fetch both days and attach next-day punches per-employee below.
  const nextDate = new Date(date + "T00:00:00Z");
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const nextDateStr = nextDate.toISOString().slice(0, 10);
  const [movs, nextMovs, perms, leaves, schedules] = await Promise.all([
    db.select().from(attendanceMovementsTable)
      .where(and(eq(attendanceMovementsTable.companyId, cid), eq(attendanceMovementsTable.date, date), inArray(attendanceMovementsTable.employeeId, ids)))
      .orderBy(asc(attendanceMovementsTable.time)),
    db.select().from(attendanceMovementsTable)
      .where(and(eq(attendanceMovementsTable.companyId, cid), eq(attendanceMovementsTable.date, nextDateStr), inArray(attendanceMovementsTable.employeeId, ids)))
      .orderBy(asc(attendanceMovementsTable.time)),
    db.select().from(exitPermissionsTable)
      .where(and(eq(exitPermissionsTable.companyId, cid), eq(exitPermissionsTable.date, date), eq(exitPermissionsTable.status, "approved"), inArray(exitPermissionsTable.employeeId, ids))),
    db.select().from(employeeLeavesTable)
      .where(and(eq(employeeLeavesTable.companyId, cid), inArray(employeeLeavesTable.employeeId, ids), eq(employeeLeavesTable.status, "approved"), lte(employeeLeavesTable.startDate, date), gte(employeeLeavesTable.endDate, date))),
    loadSchedules(cid, ids, date),
  ]);

  const movByEmp = new Map<number, any[]>();
  for (const m of movs) { const a = movByEmp.get(m.employeeId) ?? []; a.push(m); movByEmp.set(m.employeeId, a); }
  const nextMovByEmp = new Map<number, any[]>();
  for (const m of nextMovs) { const a = nextMovByEmp.get(m.employeeId) ?? []; a.push(m); nextMovByEmp.set(m.employeeId, a); }
  const permByEmp = new Map<number, any[]>();
  for (const p of perms) { const a = permByEmp.get(p.employeeId) ?? []; a.push(p); permByEmp.set(p.employeeId, a); }
  const leaveByEmp = new Map<number, any>();
  for (const l of leaves) if (!leaveByEmp.has(l.employeeId)) leaveByEmp.set(l.employeeId, l);

  let updated = 0;
  for (const empId of ids) {
    const empPerms = permByEmp.get(empId) ?? [];
    const leave = leaveByEmp.get(empId);
    const schedRow = schedules.get(empId);
    const schedule = resolveSchedule(schedRow?.contract ?? null, schedRow?.shift ?? null);
    let empMovs = movByEmp.get(empId) ?? [];
    // Cross-midnight shift: fold in next-day punches that fall before the
    // schedule END (raw clock time) — the engine offsets them +24h itself.
    const crossing = !!schedule && (schedule.crossesMidnight || schedule.workEnd <= schedule.workStart);
    if (crossing) {
      const tail = (nextMovByEmp.get(empId) ?? []).filter((m: any) => m.time <= schedule!.workEnd);
      if (tail.length) empMovs = [...empMovs, ...tail];
    }

    // Employees with NO movements, NO permission, NO leave and no existing
    // row are skipped — the daily-entry screen decides absences explicitly,
    // recalc must not flood the table with absent rows.
    const [existing] = await db.select().from(employeeAttendanceTable)
      .where(and(eq(employeeAttendanceTable.companyId, cid), eq(employeeAttendanceTable.employeeId, empId), eq(employeeAttendanceTable.date, date)));
    if (!empMovs.length && !empPerms.length && !leave && !existing) continue;
    // Manual rows without any movements keep their manual values (legacy flow).
    if (existing && existing.calcSource !== "engine" && !empMovs.length && !empPerms.length) continue;

    const r = computeDay({
      date,
      schedule,
      movements: empMovs.map((m) => ({ time: m.time, type: m.type as "in" | "out" })),
      permissions: empPerms.map((p): PermissionInput => ({ startTime: p.startTime, endTime: p.endTime, paid: !!p.paid, id: p.id })),
      onLeave: !!leave,
      leavePaid: leave ? !!leave.paid : undefined,
    });

    const values = {
      checkIn: r.firstIn, checkOut: r.lastOut,
      workedHours: (r.workedMinutes / 60).toFixed(2),
      overtimeHours: (r.overtimeMinutes / 60).toFixed(2),
      lateMinutes: r.lateMinutes,
      earlyLeaveMinutes: r.earlyLeaveMinutes,
      breakMinutes: r.breakMinutes,
      permissionPaidMinutes: r.permissionPaidMinutes,
      permissionUnpaidMinutes: r.permissionUnpaidMinutes,
      missingMinutes: r.missingMinutes,
      netHours: (r.netMinutes / 60).toFixed(2),
      status: r.status,
      calcSource: "engine" as const,
      updatedAt: new Date(),
    };
    if (existing) {
      await db.update(employeeAttendanceTable).set(values).where(eq(employeeAttendanceTable.id, existing.id));
    } else {
      await db.insert(employeeAttendanceTable)
        .values({ companyId: cid, employeeId: empId, date, ...values })
        .onConflictDoUpdate({ target: [employeeAttendanceTable.employeeId, employeeAttendanceTable.date], set: values });
    }
    updated++;
  }
  return { updated };
}

// ═══════════════════ Shifts (الورديات) ═══════════════════

router.get("/shifts", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(attendanceShiftsTable)
      .where(eq(attendanceShiftsTable.companyId, cid)).orderBy(asc(attendanceShiftsTable.name));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/shifts", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body || {};
    if (!b.name) { res.status(400).json({ error: "اسم الوردية مطلوب" }); return; }
    const startTime = requireTime(b.startTime, "بداية الوردية");
    const endTime = requireTime(b.endTime, "نهاية الوردية");
    const [row] = await db.insert(attendanceShiftsTable).values({
      companyId: cid, name: String(b.name).trim(), startTime, endTime,
      crossesMidnight: b.crossesMidnight === true || endTime <= startTime,
      breakMinutes: intOrDefault(b.breakMinutes, 0, "الاستراحة", 0, 480),
      lateGraceMin: intOrDefault(b.lateGraceMin, 0, "سماح التأخير", 0, 240),
      earlyGraceMin: intOrDefault(b.earlyGraceMin, 0, "سماح الانصراف", 0, 240),
      overtimeMinMinutes: intOrDefault(b.overtimeMinMinutes, 0, "حد الإضافي", 0, 480),
      restDays: Array.isArray(b.restDays) ? JSON.stringify(b.restDays.map(Number).filter((n: number) => n >= 0 && n <= 6)) : null,
      notes: N(b.notes),
    }).returning();
    await audit(cid, req, "create", "shift", row.id, { nu: row });
    res.status(201).json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

router.put("/shifts/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id); const b = req.body || {};
    const startTime = requireTime(b.startTime, "بداية الوردية");
    const endTime = requireTime(b.endTime, "نهاية الوردية");
    const [row] = await db.update(attendanceShiftsTable).set({
      name: String(b.name || "").trim() || undefined,
      startTime, endTime,
      crossesMidnight: b.crossesMidnight === true || endTime <= startTime,
      breakMinutes: intOrDefault(b.breakMinutes, 0, "الاستراحة", 0, 480),
      lateGraceMin: intOrDefault(b.lateGraceMin, 0, "سماح التأخير", 0, 240),
      earlyGraceMin: intOrDefault(b.earlyGraceMin, 0, "سماح الانصراف", 0, 240),
      overtimeMinMinutes: intOrDefault(b.overtimeMinMinutes, 0, "حد الإضافي", 0, 480),
      restDays: Array.isArray(b.restDays) ? JSON.stringify(b.restDays.map(Number).filter((n: number) => n >= 0 && n <= 6)) : null,
      active: b.active !== false,
      notes: N(b.notes), updatedAt: new Date(),
    }).where(and(eq(attendanceShiftsTable.id, id), eq(attendanceShiftsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الوردية غير موجودة" }); return; }
    await audit(cid, req, "update", "shift", id, { nu: row });
    res.json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

// ═══════════════════ Movements (السجل اليومي للحركات) ═══════════════════

router.get("/movements", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { date: d, employeeId, from, to } = req.query as any;
    const conds: any[] = [eq(attendanceMovementsTable.companyId, cid)];
    if (d) conds.push(eq(attendanceMovementsTable.date, String(d)));
    if (from) conds.push(gte(attendanceMovementsTable.date, String(from)));
    if (to) conds.push(lte(attendanceMovementsTable.date, String(to)));
    if (employeeId) conds.push(eq(attendanceMovementsTable.employeeId, Number(employeeId)));
    const rows = await db.select({
      id: attendanceMovementsTable.id,
      employeeId: attendanceMovementsTable.employeeId,
      date: attendanceMovementsTable.date,
      time: attendanceMovementsTable.time,
      type: attendanceMovementsTable.type,
      source: attendanceMovementsTable.source,
      deviceId: attendanceMovementsTable.deviceId,
      exitPermissionId: attendanceMovementsTable.exitPermissionId,
      editReason: attendanceMovementsTable.editReason,
      empCode: employeesTable.code,
      empNameAr: employeesTable.nameAr,
    }).from(attendanceMovementsTable)
      .leftJoin(employeesTable, eq(employeesTable.id, attendanceMovementsTable.employeeId))
      .where(and(...conds))
      .orderBy(asc(attendanceMovementsTable.date), asc(attendanceMovementsTable.time))
      .limit(1000);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Add punches (single or batch). Duplicates (same employee+date+time+type)
 * are DROPPED via the unique index + ON CONFLICT DO NOTHING and reported in
 * `duplicates` — the caller sees exactly what was deduplicated.
 * If an approved permission window covers an OUT punch, it is linked to it.
 */
router.post("/movements", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
    if (!items.length) { res.status(400).json({ error: "لا توجد حركات" }); return; }
    let inserted = 0, duplicates = 0;
    const affectedDates = new Set<string>();
    for (const b of items) {
      if (!b?.employeeId || !b?.date) throw new HrValidationError("الموظف والتاريخ مطلوبان لكل حركة");
      const date = requireDate(b.date, "تاريخ الحركة");
      await assertDayOpen(cid, date);
      await assertPeriodNotTransferred(cid, date);
      const employeeId = Number(b.employeeId);
      await assertEmployee(cid, employeeId);
      const time = requireTime(b.time, "وقت الحركة");
      const type = oneOf(b.type, ["in", "out"], "in", "نوع الحركة");
      const source = oneOf(b.source, ["device", "mobile", "manual", "api", "other"], "manual", "المصدر");
      // Auto-link to an approved permission window covering this punch
      let exitPermissionId: number | null = null;
      const [perm] = await db.select({ id: exitPermissionsTable.id }).from(exitPermissionsTable)
        .where(and(
          eq(exitPermissionsTable.companyId, cid), eq(exitPermissionsTable.employeeId, employeeId),
          eq(exitPermissionsTable.date, date), eq(exitPermissionsTable.status, "approved"),
          lte(exitPermissionsTable.startTime, time), gte(exitPermissionsTable.endTime, time),
        ));
      if (perm) exitPermissionId = perm.id;
      const r = await db.insert(attendanceMovementsTable).values({
        companyId: cid, employeeId, date, time, type, source,
        deviceId: N(b.deviceId), location: N(b.location),
        exitPermissionId, enteredBy: uid(req), editReason: N(b.editReason),
      }).onConflictDoNothing({ target: [attendanceMovementsTable.employeeId, attendanceMovementsTable.date, attendanceMovementsTable.time, attendanceMovementsTable.type] }).returning({ id: attendanceMovementsTable.id });
      if (r.length) { inserted++; affectedDates.add(date); await audit(cid, req, "create", "movement", r[0].id, { nu: { employeeId, date, time, type, source }, reason: b.editReason }); }
      else duplicates++;
    }
    for (const d of affectedDates) await recalcDay(cid, d);
    res.status(201).json({ inserted, duplicates });
  } catch (e: any) { respondHrError(req, res, e); }
});

router.delete("/movements/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [old] = await db.select().from(attendanceMovementsTable)
      .where(and(eq(attendanceMovementsTable.id, id), eq(attendanceMovementsTable.companyId, cid)));
    if (!old) { res.status(404).json({ error: "الحركة غير موجودة" }); return; }
    await assertDayOpen(cid, old.date);
    await assertPeriodNotTransferred(cid, old.date);
    const reason = N(req.body?.reason) ?? N(req.query?.reason);
    if (!reason) { res.status(400).json({ error: "سبب الحذف مطلوب" }); return; }
    await db.delete(attendanceMovementsTable).where(eq(attendanceMovementsTable.id, id));
    await audit(cid, req, "delete", "movement", id, { old, reason: String(reason) });
    await recalcDay(cid, old.date, [old.employeeId]);
    res.json({ ok: true });
  } catch (e: any) { respondHrError(req, res, e); }
});

// ═══════════════════ Exit permissions (استئذان الخروج) ═══════════════════

/** Monthly balance usage = sum of APPROVED permission minutes in the month. */
async function permissionUsage(cid: number, employeeId: number, month: string): Promise<number> {
  const [r] = await db.select({ m: sql<number>`coalesce(sum(${exitPermissionsTable.minutes}),0)` })
    .from(exitPermissionsTable)
    .where(and(
      eq(exitPermissionsTable.companyId, cid), eq(exitPermissionsTable.employeeId, employeeId),
      eq(exitPermissionsTable.status, "approved"),
      sql`to_char(${exitPermissionsTable.date}::date,'YYYY-MM') = ${month}`,
    ));
  return Number(r?.m ?? 0);
}

router.get("/permissions", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { date: d, from, to, employeeId, status } = req.query as any;
    const conds: any[] = [eq(exitPermissionsTable.companyId, cid)];
    if (d) conds.push(eq(exitPermissionsTable.date, String(d)));
    if (from) conds.push(gte(exitPermissionsTable.date, String(from)));
    if (to) conds.push(lte(exitPermissionsTable.date, String(to)));
    if (employeeId) conds.push(eq(exitPermissionsTable.employeeId, Number(employeeId)));
    if (status) conds.push(eq(exitPermissionsTable.status, String(status)));
    const rows = await db.select({
      id: exitPermissionsTable.id, employeeId: exitPermissionsTable.employeeId,
      date: exitPermissionsTable.date, startTime: exitPermissionsTable.startTime,
      endTime: exitPermissionsTable.endTime, minutes: exitPermissionsTable.minutes,
      permissionType: exitPermissionsTable.permissionType, paid: exitPermissionsTable.paid,
      reason: exitPermissionsTable.reason, status: exitPermissionsTable.status,
      decidedAt: exitPermissionsTable.decidedAt, decisionNote: exitPermissionsTable.decisionNote,
      empCode: employeesTable.code, empNameAr: employeesTable.nameAr,
    }).from(exitPermissionsTable)
      .leftJoin(employeesTable, eq(employeesTable.id, exitPermissionsTable.employeeId))
      .where(and(...conds))
      .orderBy(desc(exitPermissionsTable.date), asc(exitPermissionsTable.startTime))
      .limit(500);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/permissions/balance", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const employeeId = Number(req.query.employeeId);
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    if (!employeeId) { res.status(400).json({ error: "الموظف مطلوب" }); return; }
    const schedules = await loadSchedules(cid, [employeeId], month + "-28");
    const c = schedules.get(employeeId)?.contract;
    const monthly = c?.permissionMonthlyMinutes ?? null;   // null = بلا حد
    const used = await permissionUsage(cid, employeeId, month);
    res.json({ month, monthlyMinutes: monthly, usedMinutes: used, remainingMinutes: monthly == null ? null : Math.max(0, monthly - used), allowExceed: c?.permissionAllowExceed ?? false, maxPerRequestMinutes: c?.permissionMaxPerRequestMinutes ?? null });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/permissions", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body || {};
    if (!b.employeeId) { res.status(400).json({ error: "الموظف مطلوب" }); return; }
    const employeeId = Number(b.employeeId);
    await assertEmployee(cid, employeeId);
    const date = requireDate(b.date, "تاريخ الاستئذان");
    await assertDayOpen(cid, date);
    await assertPeriodNotTransferred(cid, date);
    const startTime = requireTime(b.startTime, "بداية الاستئذان");
    const endTime = requireTime(b.endTime, "نهاية الاستئذان");
    if (endTime <= startTime) { res.status(400).json({ error: "نهاية الاستئذان يجب أن تكون بعد بدايته" }); return; }
    const minutes = (Number(endTime.slice(0, 2)) * 60 + Number(endTime.slice(3))) - (Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3)));
    // Overlap guard + insert run atomically under a per-employee/day advisory
    // lock so two concurrent requests cannot both pass the check (عدم التكرار).
    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`att-perm:${cid}:${employeeId}:${date}`}))`);
      const existing = await tx.select().from(exitPermissionsTable)
        .where(and(
          eq(exitPermissionsTable.companyId, cid), eq(exitPermissionsTable.employeeId, employeeId),
          eq(exitPermissionsTable.date, date),
          inArray(exitPermissionsTable.status, ["draft", "pending", "approved"]),
          lte(exitPermissionsTable.startTime, endTime), gte(exitPermissionsTable.endTime, startTime),
        ));
      if (existing.some((p) => p.startTime < endTime && p.endTime > startTime)) {
        throw Object.assign(new Error("يوجد استئذان آخر متداخل لنفس الموظف في نفس الفترة"), { status: 409 });
      }
      const [inserted] = await tx.insert(exitPermissionsTable).values({
        companyId: cid, employeeId, date, startTime, endTime, minutes,
        permissionType: oneOf(b.permissionType, ["personal", "official", "medical", "other"], "personal", "نوع الاستئذان"),
        paid: b.paid !== false,
        reason: N(b.reason), notes: N(b.notes),
        status: b.status === "draft" ? "draft" : "pending",
        approverId: b.approverId ? Number(b.approverId) : null,
        createdBy: uid(req),
      }).returning();
      return inserted;
    });
    await audit(cid, req, "create", "permission", row.id, { nu: row });
    res.status(201).json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

/** approve | reject | cancel — balance is checked & consumed at APPROVAL time. */
router.post("/permissions/:id/decide", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const decision = oneOf(req.body?.decision, ["approve", "reject", "cancel"], "", "القرار");
    const [p] = await db.select().from(exitPermissionsTable)
      .where(and(eq(exitPermissionsTable.id, id), eq(exitPermissionsTable.companyId, cid)));
    if (!p) { res.status(404).json({ error: "الطلب غير موجود" }); return; }
    await assertDayOpen(cid, p.date);
    await assertPeriodNotTransferred(cid, p.date);
    if (!["draft", "pending", "approved"].includes(p.status) || (p.status === "approved" && decision === "approve")) {
      res.status(409).json({ error: `لا يمكن تنفيذ القرار — حالة الطلب الحالية: ${p.status}` }); return;
    }
    const status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "cancelled";
    // Balance check + status flip are done atomically under a per-employee/month
    // advisory lock, and the flip is CONDITIONAL on the previously-read status,
    // so two concurrent approvals cannot both consume the same balance.
    const row = await db.transaction(async (tx) => {
      if (decision === "approve") {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`att-perm:${cid}:${p.employeeId}:${p.date.slice(0, 7)}`}))`);
        const month = p.date.slice(0, 7);
        const schedules = await loadSchedules(cid, [p.employeeId], p.date);
        const c = schedules.get(p.employeeId)?.contract;
        if (c?.permissionMaxPerRequestMinutes && p.minutes > c.permissionMaxPerRequestMinutes) {
          throw Object.assign(new Error(`مدة الطلب (${p.minutes} دقيقة) تتجاوز الحد الأقصى للطلب الواحد (${c.permissionMaxPerRequestMinutes} دقيقة)`), { status: 409 });
        }
        if (c?.permissionMonthlyMinutes != null && !c?.permissionAllowExceed) {
          const used = await permissionUsage(cid, p.employeeId, month);
          if (used + p.minutes > c.permissionMonthlyMinutes) {
            throw Object.assign(new Error(`تجاوز رصيد الاستئذان الشهري — المستخدم ${used} دقيقة من ${c.permissionMonthlyMinutes}`), { status: 409 });
          }
        }
      }
      const [updatedRow] = await tx.update(exitPermissionsTable).set({
        status, decidedBy: uid(req), decidedAt: new Date(), decisionNote: N(req.body?.note), updatedAt: new Date(),
      }).where(and(eq(exitPermissionsTable.id, id), eq(exitPermissionsTable.status, p.status))).returning();
      if (!updatedRow) {
        throw Object.assign(new Error("تغيّرت حالة الطلب أثناء المعالجة — أعد المحاولة"), { status: 409 });
      }
      return updatedRow;
    });
    await audit(cid, req, decision, "permission", id, { old: { status: p.status }, nu: { status }, reason: req.body?.note });
    // Approved/cancelled permission changes the day's buckets → recalc
    await recalcDay(cid, p.date, [p.employeeId]);
    res.json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

// ═══════════════════ Day view / recalc / summary ═══════════════════

router.post("/recalc", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const date = requireDate(req.body?.date, "التاريخ");
    await assertDayOpen(cid, date);
    await assertPeriodNotTransferred(cid, date);
    const out = await recalcDay(cid, date, Array.isArray(req.body?.employeeIds) ? req.body.employeeIds.map(Number) : undefined);
    await audit(cid, req, "recalc", "attendance", null, { nu: { date, ...out } });
    res.json(out);
  } catch (e: any) { respondHrError(req, res, e); }
});

/** Rich daily grid: employee × contract schedule × derived buckets. */
router.get("/day", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const date = requireDate(req.query.date, "التاريخ");
    const emps = await db.select({
      id: employeesTable.id, code: employeesTable.code, nameAr: employeesTable.nameAr,
      department: employeesTable.department, jobTitle: employeesTable.jobTitle, branchId: employeesTable.branchId,
    }).from(employeesTable)
      .where(and(eq(employeesTable.companyId, cid), eq(employeesTable.status, "active")))
      .orderBy(asc(employeesTable.code));
    const ids = emps.map((e) => e.id);
    const [rows, schedules, perms, lock] = await Promise.all([
      ids.length ? db.select().from(employeeAttendanceTable)
        .where(and(eq(employeeAttendanceTable.companyId, cid), eq(employeeAttendanceTable.date, date), inArray(employeeAttendanceTable.employeeId, ids))) : [],
      loadSchedules(cid, ids, date),
      ids.length ? db.select().from(exitPermissionsTable)
        .where(and(eq(exitPermissionsTable.companyId, cid), eq(exitPermissionsTable.date, date), eq(exitPermissionsTable.status, "approved"), inArray(exitPermissionsTable.employeeId, ids))) : [],
      db.select().from(attendanceDayLocksTable)
        .where(and(eq(attendanceDayLocksTable.companyId, cid), eq(attendanceDayLocksTable.date, date))),
    ]);
    const rowByEmp = new Map(rows.map((r) => [r.employeeId, r]));
    const permByEmp = new Map<number, number>();
    for (const p of perms) permByEmp.set(p.employeeId, (permByEmp.get(p.employeeId) ?? 0) + p.minutes);
    const out = emps.map((e) => {
      const s = schedules.get(e.id);
      const schedule = resolveSchedule(s?.contract ?? null, s?.shift ?? null);
      const r = rowByEmp.get(e.id) as any;
      return {
        employee: e,
        shiftName: s?.shift?.name ?? null,
        workStart: schedule?.workStart ?? null,
        workEnd: schedule?.workEnd ?? null,
        attendance: r ? {
          id: r.id, checkIn: r.checkIn, checkOut: r.checkOut, status: r.status,
          workedHours: r.workedHours, netHours: r.netHours, overtimeHours: r.overtimeHours,
          lateMinutes: r.lateMinutes, earlyLeaveMinutes: r.earlyLeaveMinutes,
          breakMinutes: r.breakMinutes, permissionPaidMinutes: r.permissionPaidMinutes,
          permissionUnpaidMinutes: r.permissionUnpaidMinutes, missingMinutes: r.missingMinutes,
          notes: r.notes, calcSource: r.calcSource,
        } : null,
        permissionMinutes: permByEmp.get(e.id) ?? 0,
      };
    });
    res.json({ date, dayLock: lock[0] ?? null, rows: out });
  } catch (e: any) { respondHrError(req, res, e); }
});

/** Monthly summary per employee (الملخص الشهري) + calendar statuses. */
router.get("/monthly", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const month = String(req.query.month || "").match(/^\d{4}-\d{2}$/) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : null;
    const from = `${month}-01`;
    const to = `${month}-31`;
    const conds: any[] = [eq(employeeAttendanceTable.companyId, cid), gte(employeeAttendanceTable.date, from), lte(employeeAttendanceTable.date, to)];
    if (employeeId) conds.push(eq(employeeAttendanceTable.employeeId, employeeId));
    const rows = await db.select().from(employeeAttendanceTable).where(and(...conds));
    const byEmp = new Map<number, any>();
    for (const r of rows as any[]) {
      const s = byEmp.get(r.employeeId) ?? {
        employeeId: r.employeeId, workDays: 0, presentDays: 0, absentDays: 0, leaveDays: 0,
        holidayDays: 0, weekendDays: 0, workedHours: 0, overtimeHours: 0, lateMinutes: 0,
        earlyLeaveMinutes: 0, permissionPaidMinutes: 0, permissionUnpaidMinutes: 0, missingMinutes: 0,
        days: [] as any[],
      };
      s.days.push({ date: r.date, status: r.status, checkIn: r.checkIn, checkOut: r.checkOut, lateMinutes: r.lateMinutes, permissionPaidMinutes: r.permissionPaidMinutes, permissionUnpaidMinutes: r.permissionUnpaidMinutes });
      if (["present", "late", "partial", "exit_permission"].includes(r.status)) { s.presentDays++; s.workDays++; }
      else if (r.status === "absent") { s.absentDays++; s.workDays++; }
      else if (r.status === "leave") s.leaveDays++;
      else if (r.status === "official_holiday") s.holidayDays++;
      else if (r.status === "weekend") s.weekendDays++;
      s.workedHours += Number(r.workedHours || 0);
      s.overtimeHours += Number(r.overtimeHours || 0);
      s.lateMinutes += Number(r.lateMinutes || 0);
      s.earlyLeaveMinutes += Number(r.earlyLeaveMinutes || 0);
      s.permissionPaidMinutes += Number(r.permissionPaidMinutes || 0);
      s.permissionUnpaidMinutes += Number(r.permissionUnpaidMinutes || 0);
      s.missingMinutes += Number(r.missingMinutes || 0);
      byEmp.set(r.employeeId, s);
    }
    const empRows = byEmp.size ? await db.select({ id: employeesTable.id, code: employeesTable.code, nameAr: employeesTable.nameAr, department: employeesTable.department })
      .from(employeesTable).where(and(eq(employeesTable.companyId, cid), inArray(employeesTable.id, [...byEmp.keys()]))) : [];
    const empById = new Map(empRows.map((e) => [e.id, e]));
    res.json({ month, employees: [...byEmp.values()].map((s) => ({ ...s, employee: empById.get(s.employeeId) ?? null })) });
  } catch (e: any) { respondHrError(req, res, e); }
});

/** Violations grid (شاشة المخالفات) for a date or range. */
router.get("/violations", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const from = requireDate(req.query.from ?? req.query.date, "من تاريخ");
    const to = requireDate(req.query.to ?? req.query.date, "إلى تاريخ");
    const rows = await db.select({
      id: employeeAttendanceTable.id, employeeId: employeeAttendanceTable.employeeId,
      date: employeeAttendanceTable.date, status: employeeAttendanceTable.status,
      checkIn: employeeAttendanceTable.checkIn, checkOut: employeeAttendanceTable.checkOut,
      lateMinutes: employeeAttendanceTable.lateMinutes,
      earlyLeaveMinutes: employeeAttendanceTable.earlyLeaveMinutes,
      missingMinutes: employeeAttendanceTable.missingMinutes,
      empCode: employeesTable.code, empNameAr: employeesTable.nameAr, department: employeesTable.department,
    }).from(employeeAttendanceTable)
      .leftJoin(employeesTable, eq(employeesTable.id, employeeAttendanceTable.employeeId))
      .where(and(
        eq(employeeAttendanceTable.companyId, cid),
        gte(employeeAttendanceTable.date, from), lte(employeeAttendanceTable.date, to),
        sql`(coalesce(${employeeAttendanceTable.lateMinutes},0) > 0
          OR coalesce(${employeeAttendanceTable.earlyLeaveMinutes},0) > 0
          OR coalesce(${employeeAttendanceTable.missingMinutes},0) > 0
          OR ${employeeAttendanceTable.status} = 'absent'
          OR (${employeeAttendanceTable.checkIn} IS NOT NULL AND ${employeeAttendanceTable.checkOut} IS NULL)
          OR (${employeeAttendanceTable.checkIn} IS NULL AND ${employeeAttendanceTable.checkOut} IS NOT NULL))`,
      ))
      .orderBy(desc(employeeAttendanceTable.date))
      .limit(1000);
    const out = rows.map((r: any) => {
      const v: string[] = [];
      if (r.status === "absent") v.push("absent");
      if (Number(r.lateMinutes) > 0) v.push("late");
      if (Number(r.earlyLeaveMinutes) > 0) v.push("early_leave");
      if (Number(r.missingMinutes) > 0) v.push("missing_hours");
      if (r.checkIn && !r.checkOut) v.push("missing_out");
      if (!r.checkIn && r.checkOut) v.push("missing_in");
      return { ...r, violations: v };
    });
    res.json(out);
  } catch (e: any) { respondHrError(req, res, e); }
});

// ═══════════════════ Day approve / lock / reopen (شاشة الاعتماد) ═══════════════════

router.get("/day-locks", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { from, to } = req.query as any;
    const conds: any[] = [eq(attendanceDayLocksTable.companyId, cid)];
    if (from) conds.push(gte(attendanceDayLocksTable.date, String(from)));
    if (to) conds.push(lte(attendanceDayLocksTable.date, String(to)));
    res.json(await db.select().from(attendanceDayLocksTable).where(and(...conds)).orderBy(desc(attendanceDayLocksTable.date)).limit(100));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/day-locks", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const date = requireDate(req.body?.date, "التاريخ");
    const status = oneOf(req.body?.status, ["approved", "locked"], "approved", "الحالة");
    const [row] = await db.insert(attendanceDayLocksTable).values({
      companyId: cid, date, status, lockedBy: uid(req), notes: N(req.body?.notes),
    }).onConflictDoUpdate({
      target: [attendanceDayLocksTable.companyId, attendanceDayLocksTable.date],
      set: { status, lockedBy: uid(req), lockedAt: new Date(), reopenedBy: null, reopenedAt: null, notes: N(req.body?.notes) },
    }).returning();
    await audit(cid, req, status === "locked" ? "lock" : "approve", "day_lock", row.id, { nu: { date, status } });
    res.json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

router.post("/day-locks/reopen", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const date = requireDate(req.body?.date, "التاريخ");
    const [row] = await db.update(attendanceDayLocksTable)
      .set({ status: "approved", reopenedBy: uid(req), reopenedAt: new Date() })
      .where(and(eq(attendanceDayLocksTable.companyId, cid), eq(attendanceDayLocksTable.date, date)))
      .returning();
    if (!row) { res.status(404).json({ error: "لا يوجد قفل لهذا اليوم" }); return; }
    await audit(cid, req, "reopen", "day_lock", row.id, { nu: { date }, reason: req.body?.reason });
    res.json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

// ═══════════════════ Payroll transfer (منع الترحيل المكرر) ═══════════════════

router.get("/transfers", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    res.json(await db.select().from(attendancePayrollTransfersTable)
      .where(eq(attendancePayrollTransfersTable.companyId, cid))
      .orderBy(desc(attendancePayrollTransfersTable.period)).limit(36));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/transfers", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const period = String(req.body?.period || "");
    if (!/^\d{4}-\d{2}$/.test(period)) { res.status(400).json({ error: "الفترة مطلوبة بصيغة YYYY-MM" }); return; }
    // Snapshot the month's engine results — this is what payroll consumes.
    const rows = await db.select().from(employeeAttendanceTable)
      .where(and(eq(employeeAttendanceTable.companyId, cid), gte(employeeAttendanceTable.date, `${period}-01`), lte(employeeAttendanceTable.date, `${period}-31`)));
    const byEmp = new Map<number, any>();
    for (const r of rows as any[]) {
      const s = byEmp.get(r.employeeId) ?? { employeeId: r.employeeId, presentDays: 0, absentDays: 0, leaveDays: 0, workedHours: 0, overtimeHours: 0, lateMinutes: 0, earlyLeaveMinutes: 0, permissionUnpaidMinutes: 0, missingMinutes: 0 };
      if (["present", "late", "partial", "exit_permission"].includes(r.status)) s.presentDays++;
      else if (r.status === "absent") s.absentDays++;
      else if (r.status === "leave") s.leaveDays++;
      s.workedHours += Number(r.workedHours || 0);
      s.overtimeHours += Number(r.overtimeHours || 0);
      s.lateMinutes += Number(r.lateMinutes || 0);
      s.earlyLeaveMinutes += Number(r.earlyLeaveMinutes || 0);
      s.permissionUnpaidMinutes += Number(r.permissionUnpaidMinutes || 0);
      s.missingMinutes += Number(r.missingMinutes || 0);
      byEmp.set(r.employeeId, s);
    }
    try {
      const [row] = await db.insert(attendancePayrollTransfersTable).values({
        companyId: cid, period, summary: JSON.stringify([...byEmp.values()]), transferredBy: uid(req),
      }).returning();
      await audit(cid, req, "transfer", "payroll_transfer", row.id, { nu: { period, employees: byEmp.size } });
      res.status(201).json({ id: row.id, period, employees: byEmp.size });
    } catch (e: any) {
      if (String(e?.message).includes("uq_att_payroll_transfer")) {
        res.status(409).json({ error: `فترة ${period} مُرحّلة للرواتب مسبقاً — الترحيل المكرر ممنوع` }); return;
      }
      throw e;
    }
  } catch (e: any) { respondHrError(req, res, e); }
});

// ═══════════════════ Audit log ═══════════════════

router.get("/audit", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    res.json(await db.select().from(attendanceAuditTable)
      .where(eq(attendanceAuditTable.companyId, cid))
      .orderBy(desc(attendanceAuditTable.createdAt)).limit(300));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
