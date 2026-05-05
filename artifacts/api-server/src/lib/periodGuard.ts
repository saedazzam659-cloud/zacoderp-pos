import { db, fiscalPeriodsTable } from "@workspace/db";
import { and, eq, lte, gte } from "drizzle-orm";

/**
 * Period guard helpers — keep journal-entry writes consistent with the
 * fiscal-period status the row falls into.
 *
 * Conventions:
 *   - "open"               → fully writable
 *   - "closed"             → soft-closed; rejects all journal writes (the
 *                             user has signed off but the period can still
 *                             be re-opened by an admin)
 *   - "permanently_closed" → hard-closed; rejects all writes; cannot be
 *                             re-opened (audit-trail final state)
 */

export type PeriodWritability =
  | { ok: true;  period: typeof fiscalPeriodsTable.$inferSelect | null }
  | { ok: false; reason: string; status: "closed" | "permanently_closed"; period: typeof fiscalPeriodsTable.$inferSelect };

/**
 * Resolve the fiscal_period row that contains the given ISO date for a
 * company. Returns null when no fiscal period covers that date — the caller
 * decides whether that's an error (strict mode) or acceptable (legacy entries
 * with no period coverage yet, e.g. before the company set up fiscal years).
 */
export async function resolvePeriodForDate(
  cid: number,
  isoDate: string,
): Promise<typeof fiscalPeriodsTable.$inferSelect | null> {
  const [row] = await db.select().from(fiscalPeriodsTable).where(and(
    eq(fiscalPeriodsTable.companyId, cid),
    lte(fiscalPeriodsTable.startDate, isoDate),
    gte(fiscalPeriodsTable.endDate, isoDate),
  )).limit(1);
  return row ?? null;
}

/**
 * Look up the fiscal period for a date and verify that journal writes are
 * allowed against it. The function is intentionally permissive when no
 * period exists — that's not a write-blocker because many companies have
 * journal entries from before they configured fiscal years. Strict period
 * coverage can be enforced separately at the company-policy level.
 */
export async function assertWritableForDate(
  cid: number,
  isoDate: string,
): Promise<PeriodWritability> {
  const period = await resolvePeriodForDate(cid, isoDate);
  if (!period) return { ok: true, period: null };

  if (period.status === "open") return { ok: true, period };

  const reason = period.status === "permanently_closed"
    ? `الفترة "${period.name}" مغلقة نهائياً — لا يمكن إضافة أو تعديل أي قيد عليها`
    : `الفترة "${period.name}" مقفلة (إقفال ناعم) — أعد فتح الفترة أولاً قبل التعديل`;
  return { ok: false, reason, status: period.status, period };
}

/**
 * Same check by periodId — used when an entry already has a periodId set
 * and we need to re-verify before posting/unposting/deleting it.
 */
export async function assertWritableForPeriodId(
  cid: number,
  periodId: number | null | undefined,
): Promise<PeriodWritability> {
  if (!periodId) return { ok: true, period: null };
  const [period] = await db.select().from(fiscalPeriodsTable).where(and(
    eq(fiscalPeriodsTable.id, periodId),
    eq(fiscalPeriodsTable.companyId, cid),
  ));
  if (!period) return { ok: true, period: null };
  if (period.status === "open") return { ok: true, period };
  const reason = period.status === "permanently_closed"
    ? `الفترة "${period.name}" مغلقة نهائياً — لا يمكن أي إجراء على قيودها`
    : `الفترة "${period.name}" مقفلة (إقفال ناعم) — أعد فتح الفترة أولاً`;
  return { ok: false, reason, status: period.status, period };
}
