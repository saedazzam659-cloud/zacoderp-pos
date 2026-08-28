import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  accountsTable,
  bankAccountsTable,
  branchesTable,
  cashBoxesTable,
  companiesTable,
  costCentersTable,
  currenciesTable,
  customersTable,
  db,
  invoicesTable,
  itemGroupsTable,
  itemsTable,
  journalEntriesTable,
  pool,
  stockBalanceTable,
  suppliersTable,
  unitsTable,
  warehousesTable,
} from "@workspace/db";
import { cloneCompany } from "../src/lib/cloneCompany.ts";

const tag = `clean_demo_${randomBytes(5).toString("hex")}`;
const cleanupCompanyIds: number[] = [];

after(async () => {
  if (cleanupCompanyIds.length > 0) {
    await db.delete(companiesTable)
      .where(inArray(companiesTable.id, cleanupCompanyIds))
      .catch(() => {});
  }
  await pool.end().catch(() => {});
});

async function loadBaseline(companyId: number) {
  const [
    branches,
    warehouses,
    currencies,
    costCenters,
    customers,
    suppliers,
    cashBoxes,
    banks,
    units,
    groups,
    items,
    accounts,
    invoices,
    journals,
    stock,
  ] = await Promise.all([
    db.select().from(branchesTable).where(eq(branchesTable.companyId, companyId)),
    db.select().from(warehousesTable).where(eq(warehousesTable.companyId, companyId)),
    db.select().from(currenciesTable).where(eq(currenciesTable.companyId, companyId)),
    db.select().from(costCentersTable).where(eq(costCentersTable.companyId, companyId)),
    db.select().from(customersTable).where(eq(customersTable.companyId, companyId)),
    db.select().from(suppliersTable).where(eq(suppliersTable.companyId, companyId)),
    db.select().from(cashBoxesTable).where(eq(cashBoxesTable.companyId, companyId)),
    db.select().from(bankAccountsTable).where(eq(bankAccountsTable.companyId, companyId)),
    db.select().from(unitsTable).where(eq(unitsTable.companyId, companyId)),
    db.select().from(itemGroupsTable).where(eq(itemGroupsTable.companyId, companyId)),
    db.select().from(itemsTable).where(eq(itemsTable.companyId, companyId)),
    db.select().from(accountsTable).where(eq(accountsTable.companyId, companyId)),
    db.select().from(invoicesTable).where(eq(invoicesTable.companyId, companyId)),
    db.select().from(journalEntriesTable).where(eq(journalEntriesTable.companyId, companyId)),
    db.select().from(stockBalanceTable).where(eq(stockBalanceTable.companyId, companyId)),
  ]);
  return {
    branches, warehouses, currencies, costCenters, customers, suppliers,
    cashBoxes, banks, units, groups, items, accounts, invoices, journals, stock,
  };
}

test("new internal demos use the same clean tenant-local baseline, never mutable source master data", async () => {
  const [source] = await db.insert(companiesTable).values({
    nameAr: tag,
    nameEn: tag,
    code: `CDS-${randomBytes(3).toString("hex").toUpperCase()}`,
    crNumber: `CR-${tag}`,
    buildingNumber: "1",
    vatNumber: "300000000000003",
    city: "Riyadh",
    street: "Test",
    postalCode: "12345",
    country: "SA",
    invoiceType: "both",
    status: "active",
  }).returning({ id: companiesTable.id });
  cleanupCompanyIds.push(source.id);

  const [dirtyBranch] = await db.insert(branchesTable).values({
    companyId: source.id,
    code: "DIRTY-BRANCH",
    nameAr: "فرع من مستخدم ديمو آخر",
    isMain: true,
  }).returning();
  const [dirtyCurrency] = await db.insert(currenciesTable).values({
    companyId: source.id,
    code: "USD",
    nameAr: "دولار من مستخدم آخر",
    isDefault: true,
  }).returning();
  await db.insert(costCentersTable).values({
    companyId: source.id,
    code: "DIRTY-CC",
    nameAr: "مركز تكلفة من مستخدم آخر",
  });
  await db.insert(warehousesTable).values({
    companyId: source.id,
    branchId: dirtyBranch.id,
    code: "DIRTY-WH",
    nameAr: "مخزن من مستخدم آخر",
    isDefault: true,
  });
  await db.insert(cashBoxesTable).values({
    companyId: source.id,
    branchId: dirtyBranch.id,
    currencyId: dirtyCurrency.id,
    code: "DIRTY-CASH",
    nameAr: "خزنة من مستخدم آخر",
  });
  await db.insert(bankAccountsTable).values({
    companyId: source.id,
    branchId: dirtyBranch.id,
    currencyId: dirtyCurrency.id,
    code: "DIRTY-BANK",
    nameAr: "بنك من مستخدم آخر",
  });
  const [dirtyUnit] = await db.insert(unitsTable).values({
    companyId: source.id,
    code: "DIRTY-UNIT",
    nameAr: "وحدة من مستخدم آخر",
  }).returning();
  const [dirtyGroup] = await db.insert(itemGroupsTable).values({
    companyId: source.id,
    code: "DIRTY-GROUP",
    nameAr: "مجموعة من مستخدم آخر",
  }).returning();
  await db.insert(itemsTable).values({
    companyId: source.id,
    code: "DIRTY-ITEM",
    nameAr: "صنف من مستخدم آخر",
    unitId: dirtyUnit.id,
    groupId: dirtyGroup.id,
  });

  const makeClone = async (suffix: string) => {
    const cloned = await cloneCompany({
      sourceCompanyId: source.id,
      identity: {
        nameAr: `ديمو ${suffix}`,
        nameEn: `Demo ${suffix}`,
        vatNumber: "300000000000003",
        crNumber: `CR-${suffix}`,
        city: "Riyadh",
        street: "Test",
        buildingNumber: "1",
        postalCode: "12345",
        phone: `+96650000${suffix}`,
        country: "SA",
      },
      admin: {
        username: `${tag}_${suffix}`,
        password: randomBytes(24).toString("base64url"),
      },
      copyUsers: false,
      internalDemoWorkspace: true,
    });
    cleanupCompanyIds.unshift(cloned.newCompanyId);
    return cloned;
  };

  const cloneA = await makeClone("01");
  const cloneB = await makeClone("02");
  const [a, b, [companyA]] = await Promise.all([
    loadBaseline(cloneA.newCompanyId),
    loadBaseline(cloneB.newCompanyId),
    db.select().from(companiesTable).where(eq(companiesTable.id, cloneA.newCompanyId)),
  ]);

  for (const baseline of [a, b]) {
    assert.equal(baseline.branches.length, 1);
    assert.equal(baseline.branches[0].nameAr, "الفرع الرئيسي");
    assert.equal(baseline.branches[0].isMain, true);
    assert.equal(baseline.warehouses.length, 1);
    assert.equal(baseline.warehouses[0].nameAr, "المخزن الرئيسي");
    assert.equal(baseline.warehouses[0].branchId, baseline.branches[0].id);
    assert.equal(baseline.warehouses[0].isDefault, true);
    assert.equal(baseline.currencies.length, 1);
    assert.equal(baseline.currencies[0].code, "SAR");
    assert.equal(baseline.currencies[0].isDefault, true);
    assert.equal(baseline.costCenters.length, 1);
    assert.equal(baseline.costCenters[0].nameAr, "مركز تكلفة عام");
    assert.equal(baseline.customers.length, 1);
    assert.equal(baseline.suppliers.length, 1);
    assert.equal(baseline.cashBoxes.length, 1);
    assert.equal(baseline.banks.length, 1);
    assert.equal(baseline.items.length, 1);
    assert.equal(baseline.items[0].nameAr, "صنف تجريبي");
    assert.equal(baseline.invoices.length, 0);
    assert.equal(baseline.journals.length, 0);
    assert.equal(baseline.stock.length, 0);

    const accountIds = new Set(baseline.accounts.map((row) => row.id));
    for (const accountId of [
      baseline.warehouses[0].accountId,
      baseline.customers[0].accountId,
      baseline.suppliers[0].accountId,
      baseline.cashBoxes[0].accountId,
      baseline.banks[0].accountId,
    ]) {
      assert.ok(accountId != null && accountIds.has(accountId), "every baseline ledger must belong to the new company");
    }
  }

  assert.notEqual(a.branches[0].id, b.branches[0].id);
  assert.notEqual(a.customers[0].id, b.customers[0].id);
  assert.notEqual(a.suppliers[0].id, b.suppliers[0].id);
  assert.equal(companyA.posCashCashBoxId, a.cashBoxes[0].id);
  assert.equal(companyA.posCardBankAccountId, a.banks[0].id);
  assert.equal(companyA.hrDefaultPayCashBoxId, a.cashBoxes[0].id);
  assert.equal(companyA.hrDefaultPayBankAccountId, a.banks[0].id);
});