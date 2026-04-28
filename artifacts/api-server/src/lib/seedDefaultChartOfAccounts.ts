import { db, accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { DEFAULT_CHART_OF_ACCOUNTS } from "./defaultChartOfAccounts.js";
import { logger } from "./logger.js";

/**
 * Seed a brand-new tenant with the standard commercial chart of accounts.
 *
 * Idempotency + atomicity: the existence check and all inserts run in a
 * single DB transaction. If anything fails mid-run the whole batch rolls
 * back, so a retry will see the tenant as un-seeded and re-run cleanly —
 * no partial / permanently-incomplete chart of accounts. The pre-check
 * itself protects a manually-customised chart from being doubled.
 *
 * Parent linkage is resolved by parentCode → newly-inserted id, so rows
 * are inserted top-down (level ascending). The template file already
 * orders them that way but we sort defensively.
 */
export async function seedDefaultChartOfAccounts(companyId: number): Promise<{ inserted: number }> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: accountsTable.id })
      .from(accountsTable)
      .where(eq(accountsTable.companyId, companyId))
      .limit(1);
    if (existing.length > 0) {
      logger.info({ companyId }, "default-coa.skip-existing");
      return { inserted: 0 };
    }

    const codeToId = new Map<string, number>();
    const sorted = [...DEFAULT_CHART_OF_ACCOUNTS].sort((a, b) => a.level - b.level);
    let inserted = 0;

    for (const row of sorted) {
      const parentId = row.parentCode ? codeToId.get(row.parentCode) ?? null : null;
      if (row.parentCode && parentId === null) {
        logger.warn(
          { companyId, code: row.code, parentCode: row.parentCode },
          "default-coa.missing-parent",
        );
        continue;
      }
      const [created] = await tx
        .insert(accountsTable)
        .values({
          companyId,
          parentId,
          code: row.code,
          nameAr: row.nameAr,
          nameEn: row.nameEn,
          accountType: row.accountType,
          reportDirection: row.reportDirection,
          level: row.level,
          isPosting: row.isPosting,
          isActive: row.isActive,
        })
        .returning({ id: accountsTable.id });
      codeToId.set(row.code, created.id);
      inserted++;
    }

    logger.info({ companyId, inserted }, "default-coa.seeded");
    return { inserted };
  });
}
