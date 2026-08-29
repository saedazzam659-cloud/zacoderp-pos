import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accountsTable,
  companiesTable,
  customersTable,
  db,
  pool,
} from "@workspace/db";
import {
  buildFullCompanyBackup,
  preflightFullCompanyBackup,
  restoreFullCompanyBackup,
} from "../src/lib/fullCompanyBackup.js";

const tag = `tt_company_restore_${randomBytes(5).toString("hex")}`;
const cleanupCompanyIds: number[] = [];

async function createCompany(label: string): Promise<number> {
  const [company] = await db.insert(companiesTable).values({
    nameAr: `${tag}_${label}`,
    nameEn: `${tag}_${label}`,
    code: `${label.toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`,
    crNumber: `CR-${tag}-${label}`,
    buildingNumber: "1",
    vatNumber: "300000000000003",
    city: "Riyadh",
    street: "Restore Test",
    postalCode: "12345",
    country: "SA",
    invoiceType: "both",
    status: "active",
  }).returning({ id: companiesTable.id });
  cleanupCompanyIds.push(company.id);
  return company.id;
}

after(async () => {
  for (const companyId of cleanupCompanyIds.reverse()) {
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId)).catch(() => {});
  }
  await pool.end().catch(() => {});
});

test("strict cross-company restore remaps logical account references and audits ownership", {
  timeout: 180_000,
}, async () => {
  const sourceCompanyId = await createCompany("source");
  const targetCompanyId = await createCompany("target");

  // Consume a target-side ID first so a source identifier can never appear
  // correct by coincidence after restoration.
  await db.insert(accountsTable).values({
    companyId: targetCompanyId,
    code: "OLD-999",
    nameAr: `${tag} حساب هدف قديم`,
    accountType: "asset",
  });
  const [sourceAccount] = await db.insert(accountsTable).values({
    companyId: sourceCompanyId,
    code: "1100-T",
    nameAr: `${tag} حساب المصدر`,
    accountType: "asset",
  }).returning({ id: accountsTable.id });
  await db.insert(customersTable).values({
    companyId: sourceCompanyId,
    nameAr: `${tag} عميل`,
    accountId: sourceAccount.id,
  });
  await db.update(companiesTable)
    .set({ hrSalariesExpenseAccountId: sourceAccount.id })
    .where(eq(companiesTable.id, sourceCompanyId));

  const { payload } = await buildFullCompanyBackup(sourceCompanyId, tag);
  assert.equal(payload.companySettings?.hr_salaries_expense_account_id, sourceAccount.id);

  const preflight = await preflightFullCompanyBackup(targetCompanyId, payload);
  assert.equal(preflight.ok, true, JSON.stringify(preflight.issues));
  assert.ok(preflight.summary.logicalReferences >= 2);

  const restored = await restoreFullCompanyBackup(targetCompanyId, payload);
  assert.equal(restored.integrity.ok, true);
  assert.equal(restored.integrity.phase, "completed");
  assert.ok(restored.integrity.summary.remapped >= 2);

  const [targetAccount] = await db.select({ id: accountsTable.id })
    .from(accountsTable)
    .where(eq(accountsTable.companyId, targetCompanyId));
  const [targetCustomer] = await db.select({ accountId: customersTable.accountId })
    .from(customersTable)
    .where(eq(customersTable.companyId, targetCompanyId));
  const [targetCompany] = await db.select({
    accountId: companiesTable.hrSalariesExpenseAccountId,
  }).from(companiesTable).where(eq(companiesTable.id, targetCompanyId));

  assert.ok(targetAccount);
  assert.notEqual(targetAccount.id, sourceAccount.id);
  assert.equal(targetCustomer.accountId, targetAccount.id);
  assert.equal(targetCompany.accountId, targetAccount.id);
});