// Integration tests for the "تصفير شهري" (monthly reset) feature on the
// document-numbering engine.
//
// What this protects:
//   • When a sequence has monthly_reset = true, the per-branch counter
//     restarts at start_number at the beginning of each new calendar month,
//     so (paired with a {MM} month pattern) each month produces a distinct
//     stream: MR-01-0001, MR-01-0002, … then MR-02-0001 in the next month.
//   • The "NULL last_period adopts the current month WITHOUT resetting" rule:
//     flipping monthly_reset on for a counter that pre-dates the feature must
//     NOT retroactively reuse a number already issued this month.
//   • A monthly_reset = false sequence keeps the legacy continuous stream
//     even across a month boundary (no reset).
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Uses the real DB (DATABASE_URL).
//   - The test company is switched to sequence_date_source = "document" so the
//     issuance helper renders the {MM} token (and computes the reset period)
//     from the supplied docDate — giving deterministic control over "which
//     month" each issuance belongs to without waiting for the wall clock.
//   - docDate values use a local-noon time so the local-month derivation is
//     stable regardless of the runner's timezone.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  pool,
  companiesTable,
  branchesTable,
  sequencesTable,
  sequenceLogsTable,
  sequenceCountersTable,
} from "@workspace/db";

import { nextSequenceNumber } from "../src/lib/sequences.ts";

const TEST_TAG = `tt_seq_mreset_${randomBytes(4).toString("hex")}`;

let testCompanyId: number;
let branchAId: number;
let resetSeqId: number;     // monthly_reset = true,  {MM} pattern
let contSeqId: number;      // monthly_reset = false (legacy continuous)
let toggleSeqId: number;    // monthly_reset = true, used for the NULL-period test

const insertedCompanyIds:  number[] = [];
const insertedBranchIds:   number[] = [];
const insertedSequenceIds: number[] = [];

before(async () => {
  const [company] = await db.insert(companiesTable).values({
    nameAr:         `اختبار التصفير الشهري ${TEST_TAG}`,
    nameEn:         `Monthly Reset Test ${TEST_TAG}`,
    vatNumber:      `300000000000${TEST_TAG.slice(-3)}`,
    crNumber:       `CR_${TEST_TAG}`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
  }).returning();
  testCompanyId = company.id;
  insertedCompanyIds.push(testCompanyId);

  // Render the {MM} token (and compute the reset period) from the document's
  // own date so the tests can drive "which month" deterministically.
  await db.execute(sql`
    UPDATE companies SET sequence_date_source = 'document' WHERE id = ${testCompanyId}
  `);

  const [branch] = await db.insert(branchesTable).values({
    companyId: testCompanyId, code: `BRA_${TEST_TAG}`, nameAr: "فرع أ", nameEn: "Branch A",
  }).returning();
  branchAId = branch.id;
  insertedBranchIds.push(branchAId);

  // monthly_reset = true sequence with a {MM} month token.
  const [resetSeq] = await db.insert(sequencesTable).values({
    companyId:        testCompanyId,
    code:             `${TEST_TAG}_RESET`,
    nameAr:           `مسلسل تصفير ${TEST_TAG}`,
    prefix:           "MR-",
    monthPattern:     "{MM}-",
    startNumber:      1,
    endNumber:        9999,
    currentNumber:    1,
    padLength:        4,
    isActive:         true,
    monthlyReset:     true,
    transactionTypes: ["sales_invoice"],
  }).returning();
  resetSeqId = resetSeq.id;
  insertedSequenceIds.push(resetSeqId);

  // monthly_reset = false (legacy continuous) sequence, also with a {MM}
  // token so we can prove the {MM} token alone does NOT trigger a reset.
  const [contSeq] = await db.insert(sequencesTable).values({
    companyId:        testCompanyId,
    code:             `${TEST_TAG}_CONT`,
    nameAr:           `مسلسل مستمر ${TEST_TAG}`,
    prefix:           "CT-",
    monthPattern:     "{MM}-",
    startNumber:      1,
    endNumber:        9999,
    currentNumber:    1,
    padLength:        4,
    isActive:         true,
    monthlyReset:     false,
    transactionTypes: ["purchase_invoice"],
  }).returning();
  contSeqId = contSeq.id;
  insertedSequenceIds.push(contSeqId);

  // monthly_reset = true sequence used to verify the NULL last_period rule.
  const [toggleSeq] = await db.insert(sequencesTable).values({
    companyId:        testCompanyId,
    code:             `${TEST_TAG}_TOGGLE`,
    nameAr:           `مسلسل مُحوّل ${TEST_TAG}`,
    prefix:           "TG-",
    monthPattern:     "{MM}-",
    startNumber:      1,
    endNumber:        9999,
    currentNumber:    1,
    padLength:        4,
    isActive:         true,
    monthlyReset:     true,
    transactionTypes: ["sales_order"],
  }).returning();
  toggleSeqId = toggleSeq.id;
  insertedSequenceIds.push(toggleSeqId);
});

after(async () => {
  if (insertedSequenceIds.length) {
    await db.delete(sequenceCountersTable).where(inArray(sequenceCountersTable.sequenceId, insertedSequenceIds));
    await db.delete(sequenceLogsTable).where(inArray(sequenceLogsTable.sequenceId, insertedSequenceIds));
    await db.delete(sequencesTable).where(inArray(sequencesTable.id, insertedSequenceIds));
  }
  if (insertedBranchIds.length) {
    await db.delete(branchesTable).where(inArray(branchesTable.id, insertedBranchIds));
  }
  if (insertedCompanyIds.length) {
    await db.delete(companiesTable).where(inArray(companiesTable.id, insertedCompanyIds));
  }
  await pool.end();
});

// Local-noon document dates so the local-month derivation is timezone-stable.
const JAN = "2026-01-15T12:00:00";
const FEB = "2026-02-15T12:00:00";
const MAR = "2026-03-15T12:00:00";
const APR = "2026-04-15T12:00:00";
const MAY = "2026-05-15T12:00:00";

test("monthly_reset restarts the counter at start_number on a new month", async () => {
  // January: two issuances → 0001, 0002 (month token = 01).
  const j1 = await nextSequenceNumber(testCompanyId, "sales_invoice", { branchId: branchAId, docDate: JAN });
  const j2 = await nextSequenceNumber(testCompanyId, "sales_invoice", { branchId: branchAId, docDate: JAN });
  assert.equal(j1, "MR-01-0001");
  assert.equal(j2, "MR-01-0002");

  // February: month changed → counter resets to start_number (0001).
  const f1 = await nextSequenceNumber(testCompanyId, "sales_invoice", { branchId: branchAId, docDate: FEB });
  const f2 = await nextSequenceNumber(testCompanyId, "sales_invoice", { branchId: branchAId, docDate: FEB });
  assert.equal(f1, "MR-02-0001", "the counter must restart at start_number in a new month");
  assert.equal(f2, "MR-02-0002");

  // March: resets again.
  const m1 = await nextSequenceNumber(testCompanyId, "sales_invoice", { branchId: branchAId, docDate: MAR });
  assert.equal(m1, "MR-03-0001");
});

test("a continuous (monthly_reset = false) sequence does NOT reset across months", async () => {
  // {MM} token is present but monthly_reset is off → the running number must
  // keep climbing across the month boundary.
  const j1 = await nextSequenceNumber(testCompanyId, "purchase_invoice", { branchId: branchAId, docDate: JAN });
  const j2 = await nextSequenceNumber(testCompanyId, "purchase_invoice", { branchId: branchAId, docDate: JAN });
  assert.equal(j1, "CT-01-0001");
  assert.equal(j2, "CT-01-0002");

  const f1 = await nextSequenceNumber(testCompanyId, "purchase_invoice", { branchId: branchAId, docDate: FEB });
  assert.equal(f1, "CT-02-0003", "without monthly_reset the counter keeps climbing across months");
});

test("toggling monthly_reset on for a counter with NULL last_period does NOT reuse a number issued this month", async () => {
  // Simulate a counter that pre-dates the feature: it already issued 4 numbers
  // this month (next = 5) but has never recorded a period (last_period = NULL).
  // Per spec, the next issuance THIS month must adopt the current month WITHOUT
  // resetting — so it issues 0005, not 0001.
  await db.insert(sequenceCountersTable).values({
    sequenceId:    toggleSeqId,
    branchId:      branchAId,
    currentNumber: 5,
    lastPeriod:    null,
  });

  const first = await nextSequenceNumber(testCompanyId, "sales_order", { branchId: branchAId, docDate: FEB });
  assert.equal(first, "TG-02-0005",
    "a NULL last_period must adopt the current month without resetting (no retroactive reuse)");

  // Now that the period is stamped (2026-02), the NEXT month genuinely resets.
  const next = await nextSequenceNumber(testCompanyId, "sales_order", { branchId: branchAId, docDate: MAR });
  assert.equal(next, "TG-03-0001", "once a period is recorded, a real month change resets the counter");
});

test("out-of-order month entry keeps each month's counter independent (no reset, no duplicate)", async () => {
  // This encodes the EXACT historical failure: with the old single-counter +
  // last_period model, jumping between months (May → April → May …) made the
  // counter reset/overwrite, producing wrong next-numbers and DUPLICATE
  // document numbers. With per-period counters each month is its own stream.
  const [seq] = await db.insert(sequencesTable).values({
    companyId:        testCompanyId,
    code:             `${TEST_TAG}_OOO`,
    nameAr:           `مسلسل خارج الترتيب ${TEST_TAG}`,
    prefix:           "OO-",
    monthPattern:     "{MM}-",
    startNumber:      1,
    endNumber:        9999,
    currentNumber:    1,
    padLength:        4,
    isActive:         true,
    monthlyReset:     true,
    transactionTypes: ["sales_return"],
  }).returning();
  insertedSequenceIds.push(seq.id);

  const issue = (date: string) =>
    nextSequenceNumber(testCompanyId, "sales_return", { branchId: branchAId, docDate: date });

  // May → April → May → April → May, interleaved.
  assert.equal(await issue(MAY), "OO-05-0001");
  assert.equal(await issue(APR), "OO-04-0001");
  assert.equal(await issue(MAY), "OO-05-0002", "May must CONTINUE, not reset back to 0001");
  assert.equal(await issue(APR), "OO-04-0002", "April keeps its own independent stream");
  assert.equal(await issue(MAY), "OO-05-0003");
  // Re-touching April once more proves it never collided with May's numbers.
  assert.equal(await issue(APR), "OO-04-0003");
});
