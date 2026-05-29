import { db, unitsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { DEFAULT_UNITS } from "./defaultUnits.js";
import { logger } from "./logger.js";

/**
 * Seed a tenant with the standard set of measurement units.
 *
 * Idempotency + atomicity: the existence check and all inserts run in a
 * single DB transaction. The pre-check skips any tenant that already has
 * at least one unit, so a manually-defined unit list is never doubled and
 * re-running this on an already-seeded company is a no-op.
 */
export async function seedDefaultUnits(companyId: number): Promise<{ inserted: number }> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: unitsTable.id })
      .from(unitsTable)
      .where(eq(unitsTable.companyId, companyId))
      .limit(1);
    if (existing.length > 0) {
      logger.info({ companyId }, "default-units.skip-existing");
      return { inserted: 0 };
    }

    let inserted = 0;
    for (const u of DEFAULT_UNITS) {
      await tx.insert(unitsTable).values({
        companyId,
        code: u.code,
        nameAr: u.nameAr,
        nameEn: u.nameEn,
        conversionFactor: "1",
      });
      inserted++;
    }

    logger.info({ companyId, inserted }, "default-units.seeded");
    return { inserted };
  });
}
