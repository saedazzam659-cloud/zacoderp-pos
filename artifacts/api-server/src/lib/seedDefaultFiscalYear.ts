import { db } from "@workspace/db";
import { fiscalYearsTable, fiscalPeriodsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

const ARABIC_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

const pad = (n: number) => String(n).padStart(2, "0");
const lastDayOfMonthUTC = (y: number, m: number) =>
  new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

export interface SeedFiscalYearOptions {
  companyId: number;
  year?: number;
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
  const year = opts.year ?? new Date().getUTCFullYear();
  const startDate = `${year}-01-01`;
  const endDate   = `${year}-12-31`;
  const name      = `السنة المالية ${year}`;

  const existing = await db.select({ id: fiscalYearsTable.id })
    .from(fiscalYearsTable)
    .where(and(
      eq(fiscalYearsTable.companyId, opts.companyId),
      eq(fiscalYearsTable.startDate, startDate),
    ));
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

    const periods = Array.from({ length: 12 }, (_, m) => ({
      companyId:    opts.companyId,
      fiscalYearId: created.id,
      name:         `${ARABIC_MONTHS[m]} ${year}`,
      startDate:    `${year}-${pad(m + 1)}-01`,
      endDate:      `${year}-${pad(m + 1)}-${pad(lastDayOfMonthUTC(year, m))}`,
      sequence:     m + 1,
      status:       "open" as const,
    }));
    const inserted = await tx.insert(fiscalPeriodsTable).values(periods).returning();

    return { created: true, fiscalYearId: created.id, periodCount: inserted.length };
  });
}
