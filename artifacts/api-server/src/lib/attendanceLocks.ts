/**
 * Shared attendance day-lock / payroll-transfer guards.
 * Used by BOTH the new attendance-plus router and the legacy manual
 * attendance CRUD in routes/employees.ts, so a locked or transferred day
 * cannot be edited through ANY path (قفل الفترة + منع الترحيل المكرر).
 */
import { db } from "@workspace/db";
import { attendanceDayLocksTable, attendancePayrollTransfersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export async function assertDayOpen(cid: number, date: string): Promise<void> {
  const [lock] = await db.select().from(attendanceDayLocksTable)
    .where(and(eq(attendanceDayLocksTable.companyId, cid), eq(attendanceDayLocksTable.date, date)));
  if (lock && lock.status === "locked") {
    throw Object.assign(new Error("هذا اليوم مقفل — أعد فتح اليوم أولاً لإجراء تعديلات"), { status: 423 });
  }
}

export async function assertPeriodNotTransferred(cid: number, date: string): Promise<void> {
  const period = date.slice(0, 7);
  const [t] = await db.select({ id: attendancePayrollTransfersTable.id })
    .from(attendancePayrollTransfersTable)
    .where(and(eq(attendancePayrollTransfersTable.companyId, cid), eq(attendancePayrollTransfersTable.period, period)));
  if (t) throw Object.assign(new Error(`فترة ${period} مُرحّلة للرواتب — لا يمكن التعديل عليها`), { status: 423 });
}
