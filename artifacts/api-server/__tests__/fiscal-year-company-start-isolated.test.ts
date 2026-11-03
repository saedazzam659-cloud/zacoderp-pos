// Focused database integration test for fiscal periods seeded at company start.
// Opt in with FISCAL_YEAR_COMPANY_START_TEST=1; only its tagged company is touched.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  companiesTable,
  db,
  fiscalPeriodsTable,
  fiscalYearsTable,
  pool,
} from "@workspace/db";
import { seedDefaultFiscalYear } from "../src/lib/seedDefaultFiscalYear.ts";

test("new company's first fiscal year starts on its activation date", {
  skip: process.env.FISCAL_YEAR_COMPANY_START_TEST !== "1",
}, async () => {
  const tag = `fystart_${randomBytes(6).toString("hex")}`;
  let companyId: number | undefined;

  try {
    const [company] = await db.insert(companiesTable).values({
      nameAr: `اختبار بداية السنة ${tag}`,
      nameEn: `Fiscal start test ${tag}`,
      vatNumber: `3${randomBytes(7).toString("hex").slice(0, 13)}`,
      crNumber: `CR-${tag}`,
      city: "Riyadh",
      street: "Test",
      buildingNumber: "1",
      postalCode: "12345",
    }).returning({ id: companiesTable.id });
    companyId = company.id;

    const activationDate = "2026-07-15";
    const seeded = await seedDefaultFiscalYear({ companyId, startDate: activationDate });
    assert.equal(seeded.created, true);
    assert.equal(seeded.periodCount, 6);

    const [year] = await db.select().from(fiscalYearsTable)
      .where(eq(fiscalYearsTable.id, seeded.fiscalYearId));
    assert.equal(year.startDate, activationDate);
    assert.equal(year.endDate, "2026-12-31");

    const periods = await db.select().from(fiscalPeriodsTable)
      .where(and(
        eq(fiscalPeriodsTable.companyId, companyId),
        eq(fiscalPeriodsTable.fiscalYearId, year.id),
      ))
      .orderBy(fiscalPeriodsTable.sequence);
    assert.equal(periods.length, 6);
    assert.equal(periods[0].startDate, activationDate);
    assert.equal(periods.at(-1)?.endDate, "2026-12-31");
    assert.ok(periods.every((period) => period.status === "open"));
    assert.ok(periods.every((period) => period.startDate >= activationDate));
    for (let index = 1; index < periods.length; index++) {
      const prior = new Date(`${periods[index - 1].endDate}T00:00:00.000Z`);
      prior.setUTCDate(prior.getUTCDate() + 1);
      assert.equal(periods[index].startDate, prior.toISOString().slice(0, 10), "periods must be contiguous");
    }

    const retry = await seedDefaultFiscalYear({ companyId, startDate: activationDate });
    assert.equal(retry.created, false, "retry must not create a duplicate year");
    const overlappingRetry = await seedDefaultFiscalYear({ companyId, startDate: "2026-08-01" });
    assert.equal(overlappingRetry.created, false, "a second seed attempt must preserve an existing overlapping year");
    assert.equal(overlappingRetry.fiscalYearId, year.id);
    assert.equal((await db.select().from(fiscalYearsTable).where(eq(fiscalYearsTable.companyId, companyId))).length, 1);
  } finally {
    if (companyId != null) {
      await db.delete(fiscalPeriodsTable).where(eq(fiscalPeriodsTable.companyId, companyId)).catch(() => {});
      await db.delete(fiscalYearsTable).where(eq(fiscalYearsTable.companyId, companyId)).catch(() => {});
      await db.delete(companiesTable).where(eq(companiesTable.id, companyId)).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
});
