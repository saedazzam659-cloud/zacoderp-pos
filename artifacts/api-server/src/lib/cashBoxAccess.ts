import { db } from "@workspace/db";
import { cashBoxesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export function canUserUseCashBox(
  user: { id?: number | string; role?: string } | null | undefined,
  box: { accessUserIds?: unknown },
): boolean {
  if (user?.role === "admin" || user?.role === "superadmin") return true;
  const assigned = box.accessUserIds;
  if (assigned == null) return true;
  if (!Array.isArray(assigned)) return false;
  const userId = Number(user?.id);
  return Number.isSafeInteger(userId) && assigned.some(id => Number(id) === userId);
}

export async function userCanUseCashBox(
  user: { id?: number | string; role?: string } | null | undefined,
  companyId: number,
  cashBoxId: number,
  executor: any = db,
): Promise<boolean> {
  if (!Number.isSafeInteger(cashBoxId) || cashBoxId <= 0) return false;
  const [box] = await executor.select({
    id: cashBoxesTable.id,
    companyId: cashBoxesTable.companyId,
    accessUserIds: cashBoxesTable.accessUserIds,
  }).from(cashBoxesTable).where(and(
    eq(cashBoxesTable.id, cashBoxId),
    eq(cashBoxesTable.companyId, companyId),
  )).limit(1);
  return !!box && canUserUseCashBox(user, box);
}
