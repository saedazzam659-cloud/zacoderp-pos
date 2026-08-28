import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  accountsTable,
  accountingMappingsTable,
  bankAccountsTable,
  branchesTable,
  cashBoxesTable,
  companiesTable,
  costCentersTable,
  customPrintTemplatesTable,
  currenciesTable,
  customersTable,
  db,
  invoicesTable,
  invoiceFieldPolicyProfilesTable,
  itemBundleComponentsTable,
  itemCurrencyPricesTable,
  itemGroupsTable,
  itemUnitPricesTable,
  itemsTable,
  journalEntriesTable,
  pool,
  receiptVouchersTable,
  securityNotificationRulesTable,
  stockBalanceTable,
  stockLedgerTable,
  subscriptionsTable,
  suppliersTable,
  sequencesTable,
  unitsTable,
  usersTable,
  warehousesTable,
  workSessionSettingsTable,
} from "@workspace/db";
import { cloneCompany } from "../src/lib/cloneCompany.ts";
import { repairLegacyDemoAccountingSetup } from "../src/lib/demoDeviceIsolation.ts";

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
    mappings,
    unitPrices,
    currencyPrices,
    bundleComponents,
    sequences,
    invoicePolicies,
    printTemplates,
    workSessionSettings,
    users,
    subscriptions,
    securityRules,
    receiptVouchers,
    stockLedger,
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
    db.select().from(accountingMappingsTable).where(eq(accountingMappingsTable.companyId, companyId)),
    db.select().from(itemUnitPricesTable).where(eq(itemUnitPricesTable.companyId, companyId)),
    db.select().from(itemCurrencyPricesTable).where(eq(itemCurrencyPricesTable.companyId, companyId)),
    db.select().from(itemBundleComponentsTable).where(eq(itemBundleComponentsTable.companyId, companyId)),
    db.select().from(sequencesTable).where(eq(sequencesTable.companyId, companyId)),
    db.select().from(invoiceFieldPolicyProfilesTable).where(eq(invoiceFieldPolicyProfilesTable.companyId, companyId)),
    db.select().from(customPrintTemplatesTable).where(eq(customPrintTemplatesTable.companyId, companyId)),
    db.select().from(workSessionSettingsTable).where(eq(workSessionSettingsTable.companyId, companyId)),
    db.select().from(usersTable).where(eq(usersTable.companyId, companyId)),
    db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId)),
    db.select().from(securityNotificationRulesTable)
      .where(eq(securityNotificationRulesTable.companyId, companyId)),
    db.select().from(receiptVouchersTable).where(eq(receiptVouchersTable.companyId, companyId)),
    db.select().from(stockLedgerTable).where(eq(stockLedgerTable.companyId, companyId)),
  ]);
  return {
    branches, warehouses, currencies, costCenters, customers, suppliers,
    cashBoxes, banks, units, groups, items, accounts, invoices, journals, stock, mappings,
    unitPrices, currencyPrices, bundleComponents, sequences, invoicePolicies,
    printTemplates, workSessionSettings,
    users, subscriptions, securityRules, receiptVouchers, stockLedger,
  };
}

test("new internal demos inherit source setup with tenant-local links but no transactions or balances", async () => {
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
    invoiceFormLayout: "classic",
    hideQuickAddBar: true,
    autoPostSales: false,
    status: "active",
  }).returning({ id: companiesTable.id });
  cleanupCompanyIds.push(source.id);
  await db.insert(usersTable).values({
    companyId: source.id,
    username: `${tag}_source_user`,
    passwordHash: "source-only",
    role: "user",
  });
  await db.insert(subscriptionsTable).values({
    companyId: source.id,
    startDate: "2026-01-01",
    endDate: "2027-01-01",
  });
  await db.insert(securityNotificationRulesTable).values({
    companyId: source.id,
    name: "قاعدة مصدر لا تُنسخ",
  });

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
  const [dirtyCostCenter] = await db.insert(costCentersTable).values({
    companyId: source.id,
    code: "DIRTY-CC",
    nameAr: "مركز تكلفة من مستخدم آخر",
  }).returning();
  const [assetRoot] = await db.insert(accountsTable).values({
    companyId: source.id,
    code: "1",
    nameAr: "الأصول",
    accountType: "asset",
    level: 1,
    isPosting: false,
  }).returning();
  const [customerParent] = await db.insert(accountsTable).values({
    companyId: source.id,
    parentId: assetRoot.id,
    costCenterId: dirtyCostCenter.id,
    code: "1103",
    nameAr: "العملاء",
    accountType: "asset",
    level: 2,
    isPosting: false,
  }).returning();
  const [inventoryAccount] = await db.insert(accountsTable).values({
    companyId: source.id,
    parentId: assetRoot.id,
    code: "1300",
    nameAr: "المخزون",
    accountType: "asset",
    level: 2,
    isPosting: true,
  }).returning();
  const [liabilityRoot] = await db.insert(accountsTable).values({
    companyId: source.id,
    code: "2",
    nameAr: "الالتزامات",
    accountType: "liability",
    level: 1,
    isPosting: false,
  }).returning();
  await db.insert(accountsTable).values({
    companyId: source.id,
    parentId: liabilityRoot.id,
    code: "2101",
    nameAr: "الموردون",
    accountType: "liability",
    level: 2,
    isPosting: false,
  });
  const [revenueAccount] = await db.insert(accountsTable).values({
    companyId: source.id,
    costCenterId: dirtyCostCenter.id,
    code: "4100",
    nameAr: "إيرادات المبيعات",
    accountType: "revenue",
    level: 1,
    isPosting: true,
  }).returning();
  const [cashAccount] = await db.insert(accountsTable).values({
    companyId: source.id,
    parentId: assetRoot.id,
    code: "11011",
    nameAr: "الخزينة الأصلية",
    accountType: "asset",
    level: 2,
    isPosting: true,
  }).returning();
  const [bankAccount] = await db.insert(accountsTable).values({
    companyId: source.id,
    parentId: assetRoot.id,
    code: "11012",
    nameAr: "البنك الأصلي",
    accountType: "asset",
    level: 2,
    isPosting: true,
  }).returning();
  await db.insert(accountingMappingsTable).values([
    { companyId: source.id, documentType: "sales_invoice", roleKey: "revenue", accountId: revenueAccount.id },
    { companyId: source.id, documentType: "sales_return", roleKey: "inventory", accountId: inventoryAccount.id },
    { companyId: source.id, documentType: "purchase_invoice", roleKey: "inventory", accountId: inventoryAccount.id },
    { companyId: source.id, documentType: "purchase_return", roleKey: "inventory", accountId: inventoryAccount.id },
    { companyId: source.id, documentType: "receipt_voucher", roleKey: "cash", accountId: cashAccount.id },
    { companyId: source.id, documentType: "payment_voucher_multi", roleKey: "bank", accountId: bankAccount.id },
    { companyId: source.id, documentType: "cash_transfer", roleKey: "clearing", accountId: cashAccount.id },
    { companyId: source.id, documentType: "letter_of_credit", roleKey: "inventory", accountId: inventoryAccount.id },
  ]);
  const [dirtyWarehouse] = await db.insert(warehousesTable).values({
    companyId: source.id,
    branchId: dirtyBranch.id,
    code: "DIRTY-WH",
    nameAr: "مخزن من مستخدم آخر",
    isDefault: true,
    accountId: inventoryAccount.id,
  }).returning();
  await db.insert(cashBoxesTable).values({
    companyId: source.id,
    branchId: dirtyBranch.id,
    currencyId: dirtyCurrency.id,
    code: "DIRTY-CASH",
    nameAr: "خزنة من مستخدم آخر",
    accountId: cashAccount.id,
  });
  await db.insert(bankAccountsTable).values({
    companyId: source.id,
    branchId: dirtyBranch.id,
    currencyId: dirtyCurrency.id,
    code: "DIRTY-BANK",
    nameAr: "بنك من مستخدم آخر",
    accountId: bankAccount.id,
  });
  const [sourceCashBox] = await db.select().from(cashBoxesTable)
    .where(eq(cashBoxesTable.companyId, source.id));
  const [sourceBank] = await db.select().from(bankAccountsTable)
    .where(eq(bankAccountsTable.companyId, source.id));
  await db.update(companiesTable).set({
    hrDefaultPayCashBoxId: sourceCashBox.id,
    hrDefaultPayBankAccountId: sourceBank.id,
    posCashCashBoxId: sourceCashBox.id,
    posCardBankAccountId: sourceBank.id,
  }).where(eq(companiesTable.id, source.id));
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
  const [dirtyItem] = await db.insert(itemsTable).values({
    companyId: source.id,
    code: "DIRTY-ITEM",
    nameAr: "صنف من مستخدم آخر",
    unitId: dirtyUnit.id,
    groupId: dirtyGroup.id,
    isBundle: true,
  }).returning();
  const [dirtyChildItem] = await db.insert(itemsTable).values({
    companyId: source.id,
    code: "DIRTY-CHILD",
    nameAr: "مكوّن من الشركة الأصلية",
    unitId: dirtyUnit.id,
    groupId: dirtyGroup.id,
  }).returning();
  await db.insert(itemUnitPricesTable).values({
    companyId: source.id,
    itemId: dirtyItem.id,
    unitId: dirtyUnit.id,
    conversionFactor: "12",
    costPrice: "24",
    salePrice: "36",
  });
  await db.insert(itemCurrencyPricesTable).values({
    companyId: source.id,
    itemId: dirtyItem.id,
    currencyCode: "USD",
    costPrice: "6",
    salePrice: "9",
  });
  await db.insert(itemBundleComponentsTable).values({
    companyId: source.id,
    parentItemId: dirtyItem.id,
    childItemId: dirtyChildItem.id,
    qty: "2",
  });
  await db.insert(sequencesTable).values({
    companyId: source.id,
    code: "CUSTOM-SALES",
    nameAr: "تسلسل المبيعات الأصلي",
    prefix: "SRC-",
    startNumber: 7,
    currentNumber: 44,
    transactionTypes: ["sales_invoice"],
    branchIds: [dirtyBranch.id],
    fiscalPeriodIds: [987654],
  });
  await db.insert(invoiceFieldPolicyProfilesTable).values({
    companyId: source.id,
    name: "سياسة النموذج الأصلية",
    bundle: { sales_invoice: { customerId: "required" } },
    isDefault: true,
    color: "#123456",
  });
  await db.insert(customPrintTemplatesTable).values({
    companyId: source.id,
    documentType: "sales_invoice",
    name: "قالب الطباعة الأصلي",
    isDefault: true,
    layoutJson: { elements: [{ type: "text", value: "SOURCE" }] },
  });
  await db.insert(workSessionSettingsTable).values({
    companyId: source.id,
    defaultBranchId: dirtyBranch.id,
    requireBranchSelection: true,
    aiModel: "source-model",
    sessionStartTime: "08:30",
    sessionEndTime: "17:30",
  });
  await db.insert(invoicesTable).values({
    companyId: source.id,
    invoiceNumber: `SRC-INV-${tag}`,
    issueDate: "2026-01-15",
  });
  await db.insert(journalEntriesTable).values({
    companyId: source.id,
    entryDate: "2026-01-15",
  });
  await db.insert(receiptVouchersTable).values({
    companyId: source.id,
    branchId: dirtyBranch.id,
    cashBoxId: sourceCashBox.id,
    code: `SRC-RV-${tag}`,
    date: "2026-01-15",
    amount: "100",
  });
  await db.insert(stockBalanceTable).values({
    companyId: source.id,
    itemId: dirtyItem.id,
    warehouseId: dirtyWarehouse.id,
    qty: "9",
    avgCost: "24",
  });
  await db.insert(stockLedgerTable).values({
    companyId: source.id,
    itemId: dirtyItem.id,
    warehouseId: dirtyWarehouse.id,
    txDate: "2026-01-15",
    txType: "opening",
    qty: "9",
    costPrice: "24",
    totalCost: "216",
    balanceQty: "9",
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
    assert.equal(baseline.branches[0].nameAr, "فرع من مستخدم ديمو آخر");
    assert.equal(baseline.branches[0].isMain, true);
    assert.equal(baseline.warehouses.length, 1);
    assert.equal(baseline.warehouses[0].nameAr, "مخزن من مستخدم آخر");
    assert.equal(baseline.warehouses[0].branchId, baseline.branches[0].id);
    assert.equal(baseline.warehouses[0].isDefault, true);
    assert.equal(baseline.currencies.length, 1);
    assert.equal(baseline.currencies[0].code, "USD");
    assert.equal(baseline.currencies[0].isDefault, true);
    assert.equal(baseline.costCenters.length, 1);
    assert.equal(baseline.costCenters[0].nameAr, "مركز تكلفة من مستخدم آخر");
    assert.equal(baseline.customers.length, 1);
    assert.equal(baseline.suppliers.length, 1);
    assert.equal(baseline.cashBoxes.length, 1);
    assert.equal(baseline.banks.length, 1);
    assert.equal(baseline.items.length, 2);
    assert.ok(baseline.items.some((item) => item.nameAr === "صنف من مستخدم آخر"));
    assert.equal(baseline.mappings.length, 8);
    assert.equal(baseline.unitPrices.length, 1);
    assert.equal(baseline.currencyPrices.length, 1);
    assert.equal(baseline.bundleComponents.length, 1);
    assert.equal(baseline.sequences.length, 1);
    assert.equal(baseline.invoicePolicies.length, 1);
    assert.equal(baseline.printTemplates.length, 1);
    assert.equal(baseline.workSessionSettings.length, 1);
    assert.equal(baseline.users.length, 1);
    assert.equal(baseline.subscriptions.length, 0);
    assert.equal(baseline.securityRules.length, 0);
    assert.equal(baseline.receiptVouchers.length, 0);
    assert.equal(baseline.stockLedger.length, 0);
    assert.equal(baseline.invoices.length, 0);
    assert.equal(baseline.journals.length, 0);
    assert.equal(baseline.stock.length, 0);

    const accountIds = new Set(baseline.accounts.map((row) => row.id));
    const itemIds = new Set(baseline.items.map((row) => row.id));
    const unitIds = new Set(baseline.units.map((row) => row.id));
    for (const accountId of [
      baseline.warehouses[0].accountId,
      baseline.customers[0].accountId,
      baseline.suppliers[0].accountId,
      baseline.cashBoxes[0].accountId,
      baseline.banks[0].accountId,
      ...baseline.mappings.map((row) => row.accountId),
    ]) {
      assert.ok(accountId != null && accountIds.has(accountId), "every baseline ledger must belong to the new company");
    }
    assert.ok(itemIds.has(baseline.unitPrices[0].itemId));
    assert.ok(unitIds.has(baseline.unitPrices[0].unitId));
    assert.ok(itemIds.has(baseline.currencyPrices[0].itemId));
    assert.ok(itemIds.has(baseline.bundleComponents[0].parentItemId));
    assert.ok(itemIds.has(baseline.bundleComponents[0].childItemId));
    assert.deepEqual(baseline.sequences[0].branchIds, [baseline.branches[0].id]);
    assert.deepEqual(baseline.sequences[0].fiscalPeriodIds, []);
    assert.equal(baseline.sequences[0].currentNumber, 7);
    assert.equal(baseline.invoicePolicies[0].name, "سياسة النموذج الأصلية");
    assert.equal(baseline.printTemplates[0].name, "قالب الطباعة الأصلي");
    assert.equal(baseline.printTemplates[0].createdBy, null);
    assert.equal(baseline.workSessionSettings[0].defaultBranchId, baseline.branches[0].id);
    assert.equal(baseline.workSessionSettings[0].updatedByUserId, baseline.users[0].id);
  }

  assert.notEqual(a.branches[0].id, b.branches[0].id);
  assert.notEqual(a.customers[0].id, b.customers[0].id);
  assert.notEqual(a.suppliers[0].id, b.suppliers[0].id);
  assert.equal(companyA.invoiceFormLayout, "classic");
  assert.equal(companyA.hideQuickAddBar, true);
  assert.equal(companyA.autoPostSales, false);
  assert.equal(companyA.posCashCashBoxId, a.cashBoxes[0].id);
  assert.equal(companyA.posCardBankAccountId, a.banks[0].id);
  assert.equal(companyA.hrDefaultPayCashBoxId, a.cashBoxes[0].id);
  assert.equal(companyA.hrDefaultPayBankAccountId, a.banks[0].id);

  // Workspaces created by the previous deterministic baseline had no
  // accounting mappings. Repair only that defect in place without replacing
  // the company or touching its operational rows.
  await db.delete(accountingMappingsTable)
    .where(eq(accountingMappingsTable.companyId, cloneA.newCompanyId));
  const targetRevenue = a.accounts.find((account) => account.code === "4100");
  assert.ok(targetRevenue);
  await db.delete(accountsTable).where(eq(accountsTable.id, targetRevenue.id));
  await db.delete(costCentersTable).where(eq(costCentersTable.id, a.costCenters[0].id));
  await db.update(companiesTable).set({
    invoiceFormLayout: "tabbed",
    hideQuickAddBar: false,
  }).where(eq(companiesTable.id, cloneA.newCompanyId));
  assert.equal(
    await repairLegacyDemoAccountingSetup(source.id, cloneA.newCompanyId),
    true,
  );
  const repaired = await loadBaseline(cloneA.newCompanyId);
  const [repairedCompany] = await db.select().from(companiesTable)
    .where(eq(companiesTable.id, cloneA.newCompanyId));
  assert.equal(repaired.mappings.length, 8);
  assert.equal(repairedCompany.invoiceFormLayout, "classic");
  assert.equal(repairedCompany.hideQuickAddBar, true);
  const repairedRevenue = repaired.accounts.find((account) => account.code === "4100");
  const repairedCostCenter = repaired.costCenters.find((costCenter) => costCenter.code === "DIRTY-CC");
  assert.ok(repairedRevenue);
  assert.ok(repairedCostCenter);
  assert.equal(repairedRevenue.costCenterId, repairedCostCenter.id);

  await db.update(companiesTable).set({
    invoiceFormLayout: "tabbed",
    hideQuickAddBar: false,
  }).where(eq(companiesTable.id, cloneA.newCompanyId));
  assert.equal(
    await repairLegacyDemoAccountingSetup(source.id, cloneA.newCompanyId),
    false,
    "the migration must be idempotent once mappings exist",
  );
  const [customizedCompany] = await db.select().from(companiesTable)
    .where(eq(companiesTable.id, cloneA.newCompanyId));
  assert.equal(customizedCompany.invoiceFormLayout, "tabbed");
  assert.equal(customizedCompany.hideQuickAddBar, false);
  assert.equal(repaired.invoices.length, 0);
  assert.equal(repaired.journals.length, 0);
  assert.equal(repaired.stock.length, 0);
});