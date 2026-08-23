import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accountsTable,
  bankAccountsTable,
  companiesTable,
  db,
  journalEntriesTable,
  journalEntryLinesTable,
  pool,
} from "@workspace/db";
import { BANK_JE_COST_CENTER_LOCK_DDL } from "../src/lib/ensureSchema.ts";

const tag = `bank_cc_${randomBytes(4).toString("hex")}`;
const companyIds: number[] = [];
const accountIds: number[] = [];
const bankIds: number[] = [];
const entryIds: number[] = [];

let companyA: number;
let companyB: number;
let normalA: number;
let bankRootA: number;
let bankChildA: number;
let cashA: number;
let bankB: number;
let entryA: number;
let entryB: number;

before(async () => {
  // Install the exact idempotent production migration so this focused test can
  // run against a database that has not booted the API revision yet.
  await db.execute(sql.raw(BANK_JE_COST_CENTER_LOCK_DDL));

  const companies = await db.insert(companiesTable).values([
    {
      nameAr: `${tag} أ`, nameEn: `${tag} A`, vatNumber: `${tag}_vat_a`,
      crNumber: `${tag}_cr_a`, city: "Riyadh", street: "Test", buildingNumber: "1", postalCode: "12345",
    },
    {
      nameAr: `${tag} ب`, nameEn: `${tag} B`, vatNumber: `${tag}_vat_b`,
      crNumber: `${tag}_cr_b`, city: "Riyadh", street: "Test", buildingNumber: "1", postalCode: "12345",
    },
  ]).returning();
  [companyA, companyB] = companies.map(row => row.id);
  companyIds.push(companyA, companyB);

  const [normal] = await db.insert(accountsTable).values({
    companyId: companyA, code: `${tag}_normal`, nameAr: "حساب عادي",
    accountType: "expense" as any, isPosting: true, level: 1,
  }).returning();
  normalA = normal.id;
  const [bankRoot] = await db.insert(accountsTable).values({
    companyId: companyA, code: "11021", nameAr: "البنك",
    accountType: "asset" as any, isPosting: false, level: 2,
  }).returning();
  bankRootA = bankRoot.id;
  const [bankChild] = await db.insert(accountsTable).values({
    companyId: companyA, parentId: bankRootA, code: "110211", nameAr: "بنك فرعي",
    accountType: "asset" as any, isPosting: true, level: 3,
  }).returning();
  bankChildA = bankChild.id;
  const [cash] = await db.insert(accountsTable).values({
    companyId: companyA, code: "110111", nameAr: "صندوق",
    accountType: "asset" as any, isPosting: true, level: 3,
  }).returning();
  cashA = cash.id;
  const [foreignBank] = await db.insert(accountsTable).values({
    companyId: companyB, code: `${tag}_bank`, nameAr: "حساب بنك",
    accountType: "asset" as any, isPosting: true, level: 1,
  }).returning();
  bankB = foreignBank.id;
  accountIds.push(normalA, bankChildA, cashA, bankRootA, bankB);

  const [bank] = await db.insert(bankAccountsTable).values({
    companyId: companyB,
    code: `${tag}_bank`,
    nameAr: "بنك الاختبار",
    accountId: bankB,
  }).returning();
  bankIds.push(bank.id);

  const entries = await db.insert(journalEntriesTable).values([
    { companyId: companyA, entryDate: "2026-01-01", description: tag },
    { companyId: companyB, entryDate: "2026-01-01", description: tag },
  ]).returning();
  [entryA, entryB] = entries.map(row => row.id);
  entryIds.push(entryA, entryB);
});

after(async () => {
  if (entryIds.length) await db.delete(journalEntriesTable).where(inArray(journalEntriesTable.id, entryIds));
  if (bankIds.length) await db.delete(bankAccountsTable).where(inArray(bankAccountsTable.id, bankIds));
  if (accountIds.length) await db.delete(accountsTable).where(inArray(accountsTable.id, accountIds));
  if (companyIds.length) await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
  await pool.end();
});

async function insertAndRead(entryId: number, accountId: number, costCenter: string) {
  const [inserted] = await db.insert(journalEntryLinesTable).values({
    entryId,
    accountId,
    costCenter,
    debit: "1",
  }).returning();
  const [line] = await db.select().from(journalEntryLinesTable).where(and(
    eq(journalEntryLinesTable.id, inserted.id),
    eq(journalEntryLinesTable.entryId, entryId),
  ));
  return line;
}

test("bank account lines always persist a NULL cost center", async () => {
  const line = await insertAndRead(entryB, bankB, "CC-BANK");
  assert.equal(line.costCenter, null);

  await db.update(journalEntryLinesTable)
    .set({ costCenter: "CC-RETRY" })
    .where(eq(journalEntryLinesTable.id, line.id));
  const [updated] = await db.select().from(journalEntryLinesTable)
    .where(eq(journalEntryLinesTable.id, line.id));
  assert.equal(updated.costCenter, null, "updates cannot restore a bank cost center");
});

test("non-bank accounts retain their cost center", async () => {
  const line = await insertAndRead(entryA, normalA, "CC-NORMAL");
  assert.equal(line.costCenter, "CC-NORMAL");

  const cashLine = await insertAndRead(entryA, cashA, "CC-CASH");
  assert.equal(cashLine.costCenter, "CC-CASH", "cash boxes are outside the bank-only rule");
});

test("bank chart descendants are locked even without a bank_accounts row", async () => {
  const line = await insertAndRead(entryA, bankChildA, "CC-BANK-TREE");
  assert.equal(line.costCenter, null);
});

test("bank matching is scoped to the journal entry tenant", async () => {
  // bankB is registered only in company B. Even if a malformed/cross-tenant JE
  // line references that account from company A, B's bank setup cannot mutate A.
  const line = await insertAndRead(entryA, bankB, "CC-TENANT-A");
  assert.equal(line.costCenter, "CC-TENANT-A");
});