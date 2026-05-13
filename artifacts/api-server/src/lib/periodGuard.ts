import { db, fiscalPeriodsTable, fiscalYearsTable } from "@workspace/db";
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
 *
 * Year-level guard:
 *   The fiscal *year* status is also checked — closing a year cascades to
 *   its periods, but a date may fall in a gap between explicit period rows
 *   (e.g. a year configured with one period 22-5 → 31-12 leaves 1-1 → 21-5
 *   uncovered). Without the year-level check, a date in that gap would
 *   silently bypass the period guard. Reading reports also exclude such
 *   entries inconsistently — best to refuse the write at the gate.
 */

export type PeriodWritability =
  | { ok: true;  period: typeof fiscalPeriodsTable.$inferSelect | null }
  | { ok: false; reason: string; status: "closed" | "permanently_closed"; period: typeof fiscalPeriodsTable.$inferSelect | null };

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
 * Resolve the fiscal_year row whose [startDate, endDate] range contains the
 * given ISO date. Used as a fallback for dates that fall outside every
 * explicit period row inside a configured year.
 */
export async function resolveYearForDate(
  cid: number,
  isoDate: string,
): Promise<typeof fiscalYearsTable.$inferSelect | null> {
  const [row] = await db.select().from(fiscalYearsTable).where(and(
    eq(fiscalYearsTable.companyId, cid),
    lte(fiscalYearsTable.startDate, isoDate),
    gte(fiscalYearsTable.endDate, isoDate),
  )).limit(1);
  return row ?? null;
}

function reasonForStatus(name: string, status: "closed" | "permanently_closed", kind: "period" | "year") {
  const label = kind === "year" ? `السنة المالية "${name}"` : `الفترة "${name}"`;
  return status === "permanently_closed"
    ? `${label} مغلقة نهائياً — لا يمكن إضافة أو تعديل أي قيد أو فاتورة أو سند بتاريخ يقع داخلها`
    : `${label} مقفلة (إقفال ناعم) — أعد فتحها أولاً قبل التعديل`;
}

/**
 * Look up the fiscal period (and its parent year) for a date and verify
 * that journal writes are allowed against it.
 *
 * Resolution order:
 *   1) If a period row covers the date and is non-open → reject (period guard).
 *   2) If a fiscal year covers the date and is non-open → reject (year guard).
 *      This catches dates that fall in a gap between configured period rows
 *      inside a closed year.
 *   3) Otherwise allow (intentionally permissive when neither covers the
 *      date — many companies have legacy entries pre-fiscal-config).
 */
export async function assertWritableForDate(
  cid: number,
  isoDate: string,
): Promise<PeriodWritability> {
  const period = await resolvePeriodForDate(cid, isoDate);

  if (period && period.status !== "open") {
    return {
      ok: false,
      reason: reasonForStatus(period.name, period.status, "period"),
      status: period.status,
      period,
    };
  }

  // Year-level fallback — also catches the case where the period row IS
  // open but the parent year was hard-closed (cascade missed it, or the
  // year was closed via /years/:id/status without touching periods).
  const year = await resolveYearForDate(cid, isoDate);
  if (year && year.status !== "open") {
    return {
      ok: false,
      reason: reasonForStatus(year.name, year.status, "year"),
      status: year.status,
      period,
    };
  }

  return { ok: true, period };
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

  if (period.status !== "open") {
    return {
      ok: false,
      reason: reasonForStatus(period.name, period.status, "period"),
      status: period.status,
      period,
    };
  }

  // Period is open — also verify the parent year.
  const [year] = await db.select().from(fiscalYearsTable).where(and(
    eq(fiscalYearsTable.id, period.fiscalYearId),
    eq(fiscalYearsTable.companyId, cid),
  ));
  if (year && year.status !== "open") {
    return {
      ok: false,
      reason: reasonForStatus(year.name, year.status, "year"),
      status: year.status,
      period,
    };
  }

  return { ok: true, period };
}
