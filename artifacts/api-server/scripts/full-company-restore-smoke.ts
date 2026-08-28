import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  buildFullCompanyBackup,
  restoreFullCompanyBackup,
} from "../src/lib/fullCompanyBackup.js";

function rows(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result) ? result as Record<string, unknown>[] : ((result as any)?.rows ?? []);
}

async function createCompany(label: string): Promise<number> {
  const inserted = rows(await db.execute(sql`
    INSERT INTO "companies"
      ("name_ar", "name_en", "vat_number", "cr_number", "city", "street",
       "building_number", "postal_code", "country", "is_sandbox",
       "is_internal_demo_workspace")
    VALUES
      (${`اختبار مؤقت ${label}`}, ${`Full restore smoke ${label}`},
       '000000000000000', ${`FULL-RESTORE-${label}`}, 'Riyadh', 'Smoke Test',
       '0000', '00000', 'SA', true, true)
    RETURNING "id"
  `));
  const id = Number(inserted[0]?.id);
  if (!Number.isInteger(id)) throw new Error(`Could not create ${label} company`);
  return id;
}

async function deleteFixtureCompany(companyId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM "invoices" WHERE "company_id" = ${companyId}`);
    await tx.execute(sql`DELETE FROM "production_shifts" WHERE "company_id" = ${companyId}`);
    await tx.execute(sql`DELETE FROM "security_notification_rules" WHERE "company_id" = ${companyId}`);
    await tx.execute(sql`DELETE FROM "users" WHERE "company_id" = ${companyId}`);
    await tx.execute(sql`DELETE FROM "companies" WHERE "id" = ${companyId}`);
  });
}

const stamp = `${process.pid}-${Date.now()}`;
let sourceCompanyId: number | null = null;
let targetCompanyId: number | null = null;

try {
  sourceCompanyId = await createCompany(`SOURCE-${stamp}`);
  // Regression fixture: company settings can contain JSON arrays. These must
  // be bound as one SQL parameter during restore, never expanded into multiple
  // placeholders (which previously caused a 101-vs-100 bind failure).
  await db.execute(sql`
    UPDATE "companies"
    SET "print_enabled_templates" = '[1,2,3]'::jsonb
    WHERE "id" = ${sourceCompanyId}
  `);
  const categoryId = Number(rows(await db.execute(sql`
    INSERT INTO "fa_categories" ("company_id", "code", "name_ar")
    VALUES (${sourceCompanyId}, ${`FA-CAT-${stamp}`}, 'فئة أصل اختبارية')
    RETURNING "id"
  `))[0]?.id);
  await db.execute(sql`
    INSERT INTO "fixed_assets"
      ("company_id", "category_id", "code", "name_ar", "purchase_value",
       "book_value", "is_opening_balance", "skip_acquisition_je")
    VALUES
      (${sourceCompanyId}, ${categoryId}, ${`FA-${stamp}`}, 'أصل ثابت اختباري',
       '125000.00', '100000.00', true, true)
  `);
  await db.execute(sql`
    INSERT INTO "production_shifts"
      ("company_id", "name", "code", "start_time", "end_time", "days_of_week")
    VALUES
      (${sourceCompanyId}, 'وردية اختبار', ${`SMOKE-${stamp}`}, '08:00', '16:00', '[0,1,2,3,4]'::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO "users"
      ("company_id", "username", "email", "password_hash", "role", "permissions", "is_active")
    VALUES
      (${sourceCompanyId}, ${`existing-${stamp}`}, ${`existing-${stamp}@example.test`},
       '!smoke!', 'admin', '{"dashboard":{"view":true}}'::jsonb, false),
      (${sourceCompanyId}, ${`new-${stamp}`}, ${`new-${stamp}@example.test`},
       '!smoke!', 'user', '{"invoices":{"view":true}}'::jsonb, false)
  `);
  const sourceCreatorId = Number(rows(await db.execute(sql`
    SELECT "id" FROM "users"
    WHERE "company_id" = ${sourceCompanyId} AND "username" = ${`existing-${stamp}`}
  `))[0]?.id);
  await db.execute(sql`
    INSERT INTO "security_notification_rules"
      ("company_id", "name", "is_active", "min_severity", "event_types",
       "branch_ids", "target_mode", "target_user_ids", "created_by_user_id",
       "trigger_type", "action_type", "target_module")
    VALUES
      (${sourceCompanyId}, 'اقتحام', true, 'medium', ARRAY['intrusion']::text[],
       ARRAY[]::integer[], 'broadcast', ARRAY[]::integer[], ${sourceCreatorId},
       'manual', 'notify', 'none')
  `);
  await db.execute(sql`
    INSERT INTO "invoices"
      ("company_id", "invoice_number", "invoice_type", "status", "issue_date")
    VALUES
      (${sourceCompanyId}, ${`SMOKE-INV-${stamp}`}, 'standard', 'draft', CURRENT_DATE)
  `);

  const { payload, counts } = await buildFullCompanyBackup(sourceCompanyId, "restore-smoke-test");
  await deleteFixtureCompany(sourceCompanyId);
  sourceCompanyId = null;

  targetCompanyId = await createCompany(`TARGET-${stamp}`);
  await db.execute(sql`
    INSERT INTO "users"
      ("company_id", "username", "email", "password_hash", "role", "is_active")
    VALUES
      (${targetCompanyId}, ${`existing-${stamp}`}, ${`target-${stamp}@example.test`},
       '!target-admin!', 'admin', true)
  `);

  const report = await restoreFullCompanyBackup(targetCompanyId, payload);
  const expected = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const received = Object.values(report).reduce((sum, item) => sum + item.received, 0);
  if (received !== expected) {
    throw new Error(`Restore count mismatch: expected ${expected}, received ${received}`);
  }

  const checks = rows(await db.execute(sql`
    SELECT
      (SELECT "days_of_week" FROM "production_shifts" WHERE "company_id" = ${targetCompanyId} LIMIT 1) AS "days",
      (SELECT count(*) FROM "users" WHERE "company_id" = ${targetCompanyId}) AS "users",
      (SELECT count(*) FROM "invoices" WHERE "company_id" = ${targetCompanyId}) AS "invoices",
      (SELECT count(*) FROM "security_notification_rules" WHERE "company_id" = ${targetCompanyId}) AS "rules",
      (SELECT count(*) FROM "fixed_assets" WHERE "company_id" = ${targetCompanyId}) AS "fixed_assets",
      (SELECT "print_enabled_templates" FROM "companies" WHERE "id" = ${targetCompanyId}) AS "templates"
  `))[0];
  if (JSON.stringify(checks.days) !== JSON.stringify([0, 1, 2, 3, 4])
      || Number(checks.users) !== 2 || Number(checks.invoices) !== 1 || Number(checks.rules) !== 1
      || Number(checks.fixed_assets) !== 1
      || JSON.stringify(checks.templates) !== JSON.stringify([1, 2, 3])) {
    throw new Error(`Restored fixture verification failed: ${JSON.stringify(checks)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    tables: Object.keys(report).length,
    records: received,
    checks,
  }));
} finally {
  if (sourceCompanyId) await deleteFixtureCompany(sourceCompanyId);
  if (targetCompanyId) await deleteFixtureCompany(targetCompanyId);
}