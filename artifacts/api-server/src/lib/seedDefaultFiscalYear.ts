import { db } from "@workspace/db";
import { companiesTable, fiscalYearsTable, fiscalPeriodsTable } from "@workspace/db";
import { and, eq, gte, lte } from "drizzle-orm";

const ARABIC_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

const pad = (n: number) => String(n).padStart(2, "0");
const lastDayOfMonthUTC = (y: number, m: number) =>
  new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const isISODate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export interface SeedFiscalYearOptions {
  companyId: number;
  year?: number;
  /** The company's effective subscription/activation date, when known. */
  startDate?: string;
}

export interface SeedFiscalYearResult {
  created: boolean;
  fiscalYearId: number;
  periodCount: number;
  reason?: "already_exists";
}

export async function seedDefaultFiscalYear(
  opts: SeedFiscalYearOptions,
): Promise<SeedFiscalYearResult> {
  let startDate = opts.startDate;
  if (!startDate && opts.year != null) startDate = `${opts.year}-01-01`;
  if (!startDate) {
    const [company] = await db.select({ createdAt: companiesTable.createdAt })
      .from(companiesTable)
      .where(eq(companiesTable.id, opts.companyId))
      .limit(1);
    startDate = company?.createdAt?.toISOString().slice(0, 10);
  }
  if (!startDate) {
    const year = opts.year ?? new Date().getUTCFullYear();
    startDate = `${year}-01-01`;
  }
  if (!isISODate(startDate)) throw new Error("Invalid fiscal-year activation date");
  const year = Number(startDate.slice(0, 4));
  const endDate = `${year}-12-31`;
  const name = `السنة المالية ${year}`;

  // Company activation in the middle of a calendar year creates a short
  // first year. Never seed periods before that date; historical data can be
  // imported into explicitly created prior years by the company.
  const existing = await db.select({ id: fiscalYearsTable.id })
    .from(fiscalYearsTable)
    .where(and(
      eq(fiscalYearsTable.companyId, opts.companyId),
      lte(fiscalYearsTable.startDate, endDate),
      gte(fiscalYearsTable.endDate, startDate),
    ))
    .orderBy(fiscalYearsTable.startDate)
    .limit(1);
  if (existing.length > 0) {
    return { created: false, fiscalYearId: existing[0].id, periodCount: 0, reason: "already_exists" };
  }

  return await db.transaction(async (tx) => {
    const [created] = await tx.insert(fiscalYearsTable).values({
      companyId: opts.companyId,
      name,
      startDate,
      endDate,
      status: "open",
    }).returning();

    const periods: {
      companyId: number;
      fiscalYearId: number;
      name: string;
      startDate: string;
      endDate: string;
      sequence: number;
      status: "open";
    }[] = [];
    let cursor = startDate;
    while (cursor <= endDate) {
      const [cy, cm] = cursor.split("-").map(Number);
      const monthEnd = `${cy}-${pad(cm)}-${pad(lastDayOfMonthUTC(cy, cm - 1))}`;
      const periodEnd = monthEnd < endDate ? monthEnd : endDate;
      periods.push({
        companyId: opts.companyId,
        fiscalYearId: created.id,
        name: `${ARABIC_MONTHS[cm - 1]} ${cy}`,
        startDate: cursor,
        endDate: periodEnd,
        sequence: periods.length + 1,
        status: "open",
      });
      const nextMonth = new Date(Date.UTC(cy, cm, 1));
      cursor = nextMonth.toISOString().slice(0, 10);
    }
    const inserted = await tx.insert(fiscalPeriodsTable).values(periods).returning();

    return { created: true, fiscalYearId: created.id, periodCount: inserted.length };
  });
}
