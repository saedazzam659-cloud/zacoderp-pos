// Integration tests for the Fixed-Assets Journal Engine (IAS 16) added in
// Phase 2 of the auto-posting roll-out.
//
// What this protects:
//   • buildAcquisitionJournal — DR Asset Cost / CR Acquisition Clearing
//     when no cash source is supplied; balanced; entryType = "fa_acquisition";
//     status follows the autoPostFaAcquisition toggle (true → posted,
//     false → draft); the asset row gets `journalEntryId` back-filled.
//   • buildDepreciationRunJournal — DR Depreciation Expense / CR Accumulated
//     Depreciation; balanced; entryType = "fa_depreciation"; status follows
//     the autoPostFaDepreciation toggle; the depreciation-run row gets its
//     `journalEntryId` back-filled.
//   • buildDisposalJournal — full balanced unwind for a sale at a profit:
//     DR Acquisition Clearing (proceeds) + DR Accum Dep ; CR Asset Cost
//     + CR Disposal Gain; entryType = "fa_disposal"; status follows the
//     autoPostFaDisposal toggle; the disposal row gets its `journalEntryId`
//     back-filled.
//   • Per-category overrides — when a category has its own
//     depreciationExpenseAccountId, the depreciation JE uses THAT account
//     instead of the company-wide default. Catches a regression in
//     resolveFaAccounts() that would silently fall through to the company
//     default and corrupt segmental reporting.
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Uses the real DB (DATABASE_URL).
//   - Seeds a tagged company + 5 posting accounts + a category + an asset
//     for each scenario. Cleanup is by recorded primary keys ONLY (no LIKE).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  companiesTable,
  accountsTable,
  fixedAssetsTable,
  faCategoriesTable,
  faDepreciationRunsTable,
  faDisposalsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  cashBoxesTable,
  bankAccountsTable,
} from "@workspace/db";

import {
  buildAcquisitionJournal,
  buildDepreciationRunJournal,
  buildDisposalJournal,
} from "../src/lib/fa-journals.ts";
import { assertCompanyAccount, resolveCashAccount, resolveCustodyAccount, resolveHrAccounts } from "../src/lib/hr-journals.ts";

const TAG = `tt_fa_${randomBytes(4).toString("hex")}`;

let cid:                  number;
let acctCost:             number; // DR side of acquisition
let acctClearing:         number; // CR side of acquisition (when no cash given)
let acctAccum:            number; // CR depreciation, DR disposal
let acctDepExp:           number; // DR depreciation
let acctGain:             number; // CR disposal gain
let acctLoss:             number; // DR disposal loss (unused but configured)
let acctDepExpOverride:   number; // per-category override for depreciation expense

const insertedCompanyIds: number[] = [];
const insertedAccountIds: number[] = [];
const insertedAssetIds:   number[] = [];
const insertedCategoryIds: number[] = [];
const insertedRunIds:     number[] = [];
const insertedDisposalIds: number[] = [];
const insertedEntryIds:   number[] = [];

before(async () => {
  // Company. Defaults autoPostFa* to true (the schema default) so the first
  // scenarios assert the "posted immediately" path.
  const [c] = await db.insert(companiesTable).values({
    nameAr:         `اختبار قيود الأصول الثابتة ${TAG}`,
    nameEn:         `FA Journals Test ${TAG}`,
    vatNumber:      `300000000000${TAG.slice(-3)}`,
    crNumber:       `CR_${TAG}`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
  }).returning();
  cid = c.id;
  insertedCompanyIds.push(cid);

  // Six posting accounts. Codes are TAG-prefixed so they cannot collide with
  // any seeded COA. `isPosting` defaults true for all of these.
  const acctRows = await db.insert(accountsTable).values([
    { companyId: cid, code: `${TAG}_1101`, nameAr: "تكلفة أصل تجريبي",  accountType: "asset"   as any, isPosting: true, level: 4 },
    { companyId: cid, code: `${TAG}_1102`, nameAr: "وسيط اقتناء",         accountType: "asset"   as any, isPosting: true, level: 4 },
    { companyId: cid, code: `${TAG}_1103`, nameAr: "مجمع إهلاك تجريبي",  accountType: "asset"   as any, isPosting: true, level: 4 },
    { companyId: cid, code: `${TAG}_5301`, nameAr: "مصروف إهلاك تجريبي", accountType: "expense" as any, isPosting: true, level: 4 },
    { companyId: cid, code: `${TAG}_4901`, nameAr: "أرباح بيع أصول",     accountType: "revenue" as any, isPosting: true, level: 4 },
    { companyId: cid, code: `${TAG}_5901`, nameAr: "خسائر بيع أصول",     accountType: "expense" as any, isPosting: true, level: 4 },
    { companyId: cid, code: `${TAG}_5302`, nameAr: "إهلاك سيارات",       accountType: "expense" as any, isPosting: true, level: 4 },
  ]).returning();
  [acctCost, acctClearing, acctAccum, acctDepExp, acctGain, acctLoss, acctDepExpOverride] =
    acctRows.map(r => r.id);
  insertedAccountIds.push(...acctRows.map(r => r.id));

  // Wire the company-wide FA mappings.
  await db.update(companiesTable).set({
    faAssetCostAccountId:           acctCost,
    faAccumDepreciationAccountId:   acctAccum,
    faDepreciationExpenseAccountId: acctDepExp,
    faAcquisitionClearingAccountId: acctClearing,
    faDisposalGainAccountId:        acctGain,
    faDisposalLossAccountId:        acctLoss,
    updatedAt: new Date(),
  }).where(eq(companiesTable.id, cid));
});

after(async () => {
  if (insertedDisposalIds.length) await db.delete(faDisposalsTable).where(inArray(faDisposalsTable.id, insertedDisposalIds));
  if (insertedRunIds.length)      await db.delete(faDepreciationRunsTable).where(inArray(faDepreciationRunsTable.id, insertedRunIds));
  if (insertedEntryIds.length) {
    await db.delete(journalEntryLinesTable).where(inArray(journalEntryLinesTable.entryId, insertedEntryIds));
    await db.delete(journalEntriesTable).where(inArray(journalEntriesTable.id, insertedEntryIds));
  }
  if (insertedAssetIds.length)    await db.delete(fixedAssetsTable).where(inArray(fixedAssetsTable.id, insertedAssetIds));
  if (insertedCategoryIds.length) await db.delete(faCategoriesTable).where(inArray(faCategoriesTable.id, insertedCategoryIds));
  if (insertedAccountIds.length)  await db.delete(accountsTable).where(inArray(accountsTable.id, insertedAccountIds));
  if (insertedCompanyIds.length)  await db.delete(companiesTable).where(inArray(companiesTable.id, insertedCompanyIds));
  await pool.end();
});

async function loadEntry(entryId: number) {
  const [hdr] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, entryId));
  const lines = await db.select().from(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, entryId));
  insertedEntryIds.push(entryId);
  return { hdr, lines };
}

test("acquisition: DR cost / CR clearing when no cash source — status posted, balanced, asset linked", async () => {
  const [asset] = await db.insert(fixedAssetsTable).values({
    companyId: cid, code: `${TAG}_AST1`, nameAr: "حاسوب اختبار",
    purchaseValue: "5000", scrapValue: "0", accumulatedDepreciation: "0",
    bookValue: "5000", lifeYears: 5, depreciationMethod: "straight_line" as any,
    purchaseDate: "2024-01-15",
  }).returning();
  insertedAssetIds.push(asset.id);

  const entryId = await buildAcquisitionJournal(cid, asset.id);
  assert.ok(entryId, "expected an entry id");
  const { hdr, lines } = await loadEntry(entryId!);

  assert.equal(hdr.entryType, "fa_acquisition");
  assert.equal(hdr.status, "posted");
  assert.equal(lines.length, 2);
  const dr = lines.find(l => Number(l.debit) > 0)!;
  const cr = lines.find(l => Number(l.credit) > 0)!;
  assert.equal(dr.accountId, acctCost);
  assert.equal(cr.accountId, acctClearing);
  assert.equal(Number(dr.debit), 5000);
  assert.equal(Number(cr.credit), 5000);

  const [linked] = await db.select().from(fixedAssetsTable).where(eq(fixedAssetsTable.id, asset.id));
  assert.equal(linked.journalEntryId, entryId);
});

test("acquisition: status follows autoPostFaAcquisition toggle (false → draft)", async () => {
  await db.update(companiesTable).set({ autoPostFaAcquisition: false }).where(eq(companiesTable.id, cid));
  try {
    const [asset] = await db.insert(fixedAssetsTable).values({
      companyId: cid, code: `${TAG}_AST2`, nameAr: "أصل مسودة",
      purchaseValue: "1200", scrapValue: "0", accumulatedDepreciation: "0",
      bookValue: "1200", lifeYears: 4, depreciationMethod: "straight_line" as any,
      purchaseDate: "2024-02-10",
    }).returning();
    insertedAssetIds.push(asset.id);
    const entryId = await buildAcquisitionJournal(cid, asset.id);
    const { hdr } = await loadEntry(entryId!);
    assert.equal(hdr.status, "draft");
  } finally {
    await db.update(companiesTable).set({ autoPostFaAcquisition: true }).where(eq(companiesTable.id, cid));
  }
});

test("depreciation: DR dep-expense / CR accum-dep — balanced, posted, run row linked", async () => {
  const [asset] = await db.insert(fixedAssetsTable).values({
    companyId: cid, code: `${TAG}_AST3`, nameAr: "آلة إهلاك",
    purchaseValue: "12000", scrapValue: "0", accumulatedDepreciation: "0",
    bookValue: "12000", lifeYears: 5, depreciationMethod: "straight_line" as any,
    purchaseDate: "2024-01-01",
  }).returning();
  insertedAssetIds.push(asset.id);

  const [run] = await db.insert(faDepreciationRunsTable).values({
    companyId: cid, assetId: asset.id, periodMonth: 3, periodYear: 2025,
    depreciationAmount: "200.00", bookValueBefore: "12000.00", bookValueAfter: "11800.00",
  }).returning();
  insertedRunIds.push(run.id);

  const entryId = await buildDepreciationRunJournal(cid, run.id);
  const { hdr, lines } = await loadEntry(entryId!);
  assert.equal(hdr.entryType, "fa_depreciation");
  assert.equal(hdr.status, "posted");
  assert.equal(lines.length, 2);
  const dr = lines.find(l => Number(l.debit) > 0)!;
  const cr = lines.find(l => Number(l.credit) > 0)!;
  assert.equal(dr.accountId, acctDepExp);
  assert.equal(cr.accountId, acctAccum);
  assert.equal(Number(dr.debit), 200);
  assert.equal(Number(cr.credit), 200);

  const [linkedRun] = await db.select().from(faDepreciationRunsTable).where(eq(faDepreciationRunsTable.id, run.id));
  assert.equal(linkedRun.journalEntryId, entryId);
});

test("depreciation: per-category override wins over company default", async () => {
  const [cat] = await db.insert(faCategoriesTable).values({
    companyId: cid, code: `${TAG}_CAT1`, nameAr: "سيارات اختبار",
    defaultLifeYears: 5, defaultDepreciationMethod: "straight_line" as any,
    defaultScrapRate: "10",
    depreciationExpenseAccountId: acctDepExpOverride,
  }).returning();
  insertedCategoryIds.push(cat.id);

  const [asset] = await db.insert(fixedAssetsTable).values({
    companyId: cid, code: `${TAG}_AST4`, nameAr: "سيارة بفئة",
    categoryId: cat.id,
    purchaseValue: "60000", scrapValue: "0", accumulatedDepreciation: "0",
    bookValue: "60000", lifeYears: 5, depreciationMethod: "straight_line" as any,
    purchaseDate: "2024-01-01",
  }).returning();
  insertedAssetIds.push(asset.id);

  const [run] = await db.insert(faDepreciationRunsTable).values({
    companyId: cid, assetId: asset.id, periodMonth: 4, periodYear: 2025,
    depreciationAmount: "1000.00", bookValueBefore: "60000.00", bookValueAfter: "59000.00",
  }).returning();
  insertedRunIds.push(run.id);

  const entryId = await buildDepreciationRunJournal(cid, run.id);
  const { lines } = await loadEntry(entryId!);
  const dr = lines.find(l => Number(l.debit) > 0)!;
  assert.equal(dr.accountId, acctDepExpOverride, "category override should win");
});

test("disposal: sale at a gain — DR clearing+accum / CR cost+gain, balanced, linked", async () => {
  const [asset] = await db.insert(fixedAssetsTable).values({
    companyId: cid, code: `${TAG}_AST5`, nameAr: "أصل سيُباع",
    purchaseValue: "10000", scrapValue: "0",
    accumulatedDepreciation: "4000", bookValue: "6000",
    lifeYears: 5, depreciationMethod: "straight_line" as any,
    purchaseDate: "2022-01-01",
  }).returning();
  insertedAssetIds.push(asset.id);

  const [d] = await db.insert(faDisposalsTable).values({
    companyId: cid, assetId: asset.id, code: `${TAG}_DIS1`,
    type: "sale" as any, disposalDate: "2025-05-10",
    salePrice: "7500", scrapValue: "0",
    bookValueAtDisposal: "6000", gainLoss: "1500",
  }).returning();
  insertedDisposalIds.push(d.id);

  const entryId = await buildDisposalJournal(cid, d.id);
  const { hdr, lines } = await loadEntry(entryId!);
  assert.equal(hdr.entryType, "fa_disposal");
  assert.equal(hdr.status, "posted");

  // Expected: DR clearing 7500, DR accum 4000, CR cost 10000, CR gain 1500
  const byAcct = new Map<number, { d: number; c: number }>();
  for (const l of lines) {
    const cur = byAcct.get(l.accountId) ?? { d: 0, c: 0 };
    cur.d += Number(l.debit || 0); cur.c += Number(l.credit || 0);
    byAcct.set(l.accountId, cur);
  }
  assert.equal(byAcct.get(acctClearing)?.d, 7500);
  assert.equal(byAcct.get(acctAccum)?.d, 4000);
  assert.equal(byAcct.get(acctCost)?.c, 10000);
  assert.equal(byAcct.get(acctGain)?.c, 1500);

  const totalDr = lines.reduce((s, l) => s + Number(l.debit  || 0), 0);
  const totalCr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  assert.equal(totalDr, totalCr, "disposal JE must balance");

  const [linkedDisp] = await db.select().from(faDisposalsTable).where(eq(faDisposalsTable.id, d.id));
  assert.equal(linkedDisp.journalEntryId, entryId);
});

test("disposal: status follows autoPostFaDisposal toggle (false → draft)", async () => {
  await db.update(companiesTable).set({ autoPostFaDisposal: false }).where(eq(companiesTable.id, cid));
  try {
    const [asset] = await db.insert(fixedAssetsTable).values({
      companyId: cid, code: `${TAG}_AST6`, nameAr: "أصل مسودة استبعاد",
      purchaseValue: "2000", scrapValue: "0",
      accumulatedDepreciation: "500", bookValue: "1500",
      lifeYears: 4, depreciationMethod: "straight_line" as any,
    }).returning();
    insertedAssetIds.push(asset.id);

    const [d] = await db.insert(faDisposalsTable).values({
      companyId: cid, assetId: asset.id, code: `${TAG}_DIS2`,
      type: "scrap" as any, disposalDate: "2025-05-20",
      salePrice: "0", scrapValue: "0",
      bookValueAtDisposal: "1500", gainLoss: "-1500",
    }).returning();
    insertedDisposalIds.push(d.id);

    const entryId = await buildDisposalJournal(cid, d.id);
    const { hdr } = await loadEntry(entryId!);
    assert.equal(hdr.status, "draft");
  } finally {
    await db.update(companiesTable).set({ autoPostFaDisposal: true }).where(eq(companiesTable.id, cid));
  }
});

test("FA journals reject a restored account mapping owned by another company", async () => {
  const [otherCompany] = await db.insert(companiesTable).values({
    nameAr: `شركة أجنبية ${TAG}`, nameEn: `Foreign ${TAG}`,
    vatNumber: `310000000000${TAG.slice(-3)}`, crNumber: `FCR_${TAG}`,
    city: "Riyadh", street: "Test St", buildingNumber: "2", postalCode: "12345",
  }).returning();
  insertedCompanyIds.push(otherCompany.id);
  const [foreignAccount] = await db.insert(accountsTable).values({
    companyId: otherCompany.id, code: `${TAG}_FOREIGN_FA`, nameAr: "حساب شركة أخرى",
    accountType: "asset" as any, isPosting: true, level: 4,
  }).returning();
  insertedAccountIds.push(foreignAccount.id);
  const [asset] = await db.insert(fixedAssetsTable).values({
    companyId: cid, code: `${TAG}_FOREIGN_AST`, nameAr: "أصل بحساب مستعاد خاطئ",
    purchaseValue: "100", scrapValue: "0", accumulatedDepreciation: "0",
    bookValue: "100", lifeYears: 5, depreciationMethod: "straight_line" as any,
    purchaseDate: "2024-06-01",
  }).returning();
  insertedAssetIds.push(asset.id);

  await db.update(companiesTable)
    .set({ faAssetCostAccountId: foreignAccount.id })
    .where(eq(companiesTable.id, cid));
  try {
    await assert.rejects(
      buildAcquisitionJournal(cid, asset.id),
      /حساب تكلفة الأصل غير موجود أو لا يتبع الشركة الحالية/,
    );
  } finally {
    await db.update(companiesTable)
      .set({ faAssetCostAccountId: acctCost })
      .where(eq(companiesTable.id, cid));
  }
});

test("HR account resolution replaces a foreign restored mapping with this company's code", async () => {
  const otherCompanyId = insertedCompanyIds.find(id => id !== cid);
  assert.ok(otherCompanyId);
  const [foreignAccount] = await db.select({ id: accountsTable.id }).from(accountsTable)
    .where(eq(accountsTable.companyId, otherCompanyId!));
  assert.ok(foreignAccount);
  const [localFallback] = await db.insert(accountsTable).values({
    companyId: cid, code: "5201", nameAr: "مصروف رواتب محلي",
    accountType: "expense" as any, isPosting: true, level: 4,
  }).returning();
  insertedAccountIds.push(localFallback.id);

  await db.update(companiesTable)
    .set({ hrSalariesExpenseAccountId: foreignAccount.id })
    .where(eq(companiesTable.id, cid));
  try {
    const resolved = await resolveHrAccounts(cid, true);
    assert.equal(resolved.salariesExpense, localFallback.id);
    const [company] = await db.select({
      accountId: companiesTable.hrSalariesExpenseAccountId,
    }).from(companiesTable).where(eq(companiesTable.id, cid));
    assert.equal(company.accountId, localFallback.id);
  } finally {
    await db.update(companiesTable)
      .set({ hrSalariesExpenseAccountId: null })
      .where(eq(companiesTable.id, cid));
  }
});

test("HR rejects foreign restored cash, bank, custody, and settlement-account links", async () => {
  const [otherCompany] = await db.insert(companiesTable).values({
    nameAr: `شركة HR أجنبية ${TAG}`, nameEn: `Foreign HR ${TAG}`,
    vatNumber: `320000000000${TAG.slice(-3)}`, crNumber: `HRCR_${TAG}`,
    city: "Riyadh", street: "Test St", buildingNumber: "3", postalCode: "12345",
  }).returning();
  const [foreignAccount] = await db.insert(accountsTable).values({
    companyId: otherCompany.id, code: `${TAG}_FOREIGN_HR`, nameAr: "حساب HR أجنبي",
    accountType: "expense" as any, isPosting: true, level: 4,
  }).returning();
  const [cashBox] = await db.insert(cashBoxesTable).values({
    companyId: cid, code: `${TAG}_CASH`, nameAr: "صندوق برابط أجنبي", accountId: foreignAccount.id,
  }).returning();
  const [bank] = await db.insert(bankAccountsTable).values({
    companyId: cid, code: `${TAG}_BANK`, nameAr: "بنك برابط أجنبي", accountId: foreignAccount.id,
  }).returning();
  await db.update(companiesTable).set({ hrEmployeeCustodyAccountId: acctCost }).where(eq(companiesTable.id, cid));
  try {
    await assert.rejects(resolveCashAccount(cid, { cashBoxId: cashBox.id }), /الصندوق المختار غير موجود أو لا يتبع الشركة الحالية/);
    await assert.rejects(resolveCashAccount(cid, { bankAccountId: bank.id }), /البنك المختار غير موجود أو لا يتبع الشركة الحالية/);
    assert.equal(await resolveCustodyAccount(cid, foreignAccount.id, db), acctCost, "foreign custody link must use the safe company fallback");
    await assert.rejects(
      assertCompanyAccount(cid, foreignAccount.id, "حساب مصروف التسوية", db),
      /حساب مصروف التسوية غير موجود أو لا يتبع الشركة الحالية/,
    );
  } finally {
    await db.update(companiesTable).set({ hrEmployeeCustodyAccountId: null }).where(eq(companiesTable.id, cid));
    await db.delete(cashBoxesTable).where(eq(cashBoxesTable.id, cashBox.id));
    await db.delete(bankAccountsTable).where(eq(bankAccountsTable.id, bank.id));
    await db.delete(accountsTable).where(eq(accountsTable.id, foreignAccount.id));
    await db.delete(companiesTable).where(eq(companiesTable.id, otherCompany.id));
  }
});
