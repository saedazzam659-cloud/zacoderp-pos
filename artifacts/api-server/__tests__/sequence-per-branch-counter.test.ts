// Integration tests for the per-branch sequence counter behaviour added by the
// "ربط الفروع على مسلسل الحركات" feature.
//
// What this protects:
//   • Each (sequenceId, branchId) pair gets its OWN running counter so two
//     branches issuing on the same sequence config receive INDEPENDENT number
//     streams (no overlap WITHIN a stream — collisions BETWEEN streams are
//     intentional per the user spec).
//   • When NO counter exists yet for a sequence, the FIRST issuance seeds at
//     MAX(start_number, sequences.current_number) so existing tenants do not
//     re-issue numbers their old single-counter system already consumed.
//   • Subsequent NEW branches added to the same sequence start fresh at
//     start_number per spec.
//   • The MASTER `sequences.current_number` is NEVER mutated during issuance
//     (the user spec is explicit: "لا يتم تعديل Sequence Master").
//   • A `sequence_logs` row is appended for every issuance, regardless of
//     which branch counter advanced — so the PATCH integrity guard (which
//     uses sequence_logs as the "ever issued?" signal post-upgrade) still
//     correctly identifies in-use sequences.
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Uses the real DB (DATABASE_URL).
//   - Seeds and tears down its own data tagged with a per-run TEST_TAG. Other
//     tenants' data is never touched (cleanup is by recorded primary keys
//     only — no LIKE queries).

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

const TEST_TAG = `tt_seq_branch_${randomBytes(4).toString("hex")}`;

let testCompanyId: number;
let branchAId: number;
let branchBId: number;
let freshSeqId: number;        // start_number = 1, no prior issuance
let migratedSeqId: number;     // start_number = 1, currentNumber = 500 (legacy)

const insertedCompanyIds:  number[] = [];
const insertedBranchIds:   number[] = [];
const insertedSequenceIds: number[] = [];

before(async () => {
  // Company. The companies table has many NOT NULL fields with no defaults
  // (vat/cr/city/street/building/postal). Fill with deterministic tag-derived
  // strings so every test run gets unique, harmless values.
  const [company] = await db.insert(companiesTable).values({
    nameAr:         `اختبار عداد الفروع ${TEST_TAG}`,
    nameEn:         `Branch Counter Test ${TEST_TAG}`,
    vatNumber:      `300000000000${TEST_TAG.slice(-3)}`,
    crNumber:       `CR_${TEST_TAG}`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
  }).returning();
  testCompanyId = company.id;
  insertedCompanyIds.push(testCompanyId);

  // 2 branches. `code` and `nameAr` are NOT NULL on branches table.
  const branchRows = await db.insert(branchesTable).values([
    { companyId: testCompanyId, code: `BRA_${TEST_TAG}`, nameAr: "فرع أ", nameEn: "Branch A" },
    { companyId: testCompanyId, code: `BRB_${TEST_TAG}`, nameAr: "فرع ب", nameEn: "Branch B" },
  ]).returning();
  branchAId = branchRows[0].id;
  branchBId = branchRows[1].id;
  insertedBranchIds.push(branchAId, branchBId);

  // Fresh sequence (no prior issuance) — bound to "sales_invoice"
  const [freshSeq] = await db.insert(sequencesTable).values({
    companyId:        testCompanyId,
    code:             `${TEST_TAG}_FRESH`,
    nameAr:           `مسلسل جديد ${TEST_TAG}`,
    nameEn:           "Fresh seq",
    prefix:           "FRESH-",
    startNumber:      1,
    endNumber:        9999,
    currentNumber:    1,
    padLength:        4,
    isActive:         true,
    transactionTypes: ["sales_invoice"],
  }).returning();
  freshSeqId = freshSeq.id;
  insertedSequenceIds.push(freshSeqId);

  // Migrated sequence — simulates a legacy tenant that already issued 499
  // numbers under the old single-counter system. currentNumber=500 is the
  // NEXT number that would have been issued. After upgrade, the FIRST
  // per-branch counter created should seed at 500 (not 1) so we don't
  // re-issue PURCH-0001..0499 which the tenant already used.
  const [migSeq] = await db.insert(sequencesTable).values({
    companyId:        testCompanyId,
    code:             `${TEST_TAG}_MIGRATED`,
    nameAr:           `مسلسل مرحَّل ${TEST_TAG}`,
    nameEn:           "Migrated seq",
    prefix:           "PURCH-",
    startNumber:      1,
    endNumber:        9999,
    currentNumber:    500,
    padLength:        4,
    isActive:         true,
    transactionTypes: ["purchase_invoice"],
  }).returning();
  migratedSeqId = migSeq.id;
  insertedSequenceIds.push(migratedSeqId);
});

after(async () => {
  // Strict ID-based cleanup: no LIKE, no wildcards.
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

// ─── Helper: read master.currentNumber so we can assert it never moves ──────
async function readMasterCurrent(seqId: number): Promise<number> {
  const [row] = await db.select({ n: sequencesTable.currentNumber })
    .from(sequencesTable).where(eq(sequencesTable.id, seqId));
  return Number(row.n);
}

async function readBranchCounter(seqId: number, branchId: number): Promise<number | null> {
  const rows = await db.select({ n: sequenceCountersTable.currentNumber })
    .from(sequenceCountersTable)
    .where(sql`${sequenceCountersTable.sequenceId} = ${seqId}
            AND ${sequenceCountersTable.branchId}   = ${branchId}`);
  return rows.length ? Number(rows[0].n) : null;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("each branch gets an independent counter on a fresh sequence", async () => {
  // Branch A: first 3 issuances → 0001, 0002, 0003
  const a1 = await nextSequenceNumber(testCompanyId, "sales_invoice", { branchId: branchAId });
  const a2 = await nextSequenceNumber(testCompanyId, "sales_invoice", { branchId: branchAId });
  const a3 = await nextSequenceNumber(testCompanyId, "sales_invoice", { branchId: branchAId });
  assert.equal(a1, "FRESH-0001");
  assert.equal(a2, "FRESH-0002");
  assert.equal(a3, "FRESH-0003");

  // Branch B: starts fresh from 0001 — INDEPENDENT stream, intentional collision
  // with branch A's first number (the user spec explicitly allows this; uniqueness
  // is per-branch, not per-company).
  const b1 = await nextSequenceNumber(testCompanyId, "sales_invoice", { branchId: branchBId });
  const b2 = await nextSequenceNumber(testCompanyId, "sales_invoice", { branchId: branchBId });
  assert.equal(b1, "FRESH-0001");
  assert.equal(b2, "FRESH-0002");

  // Branch A continues from where IT was, unaffected by branch B's activity.
  const a4 = await nextSequenceNumber(testCompanyId, "sales_invoice", { branchId: branchAId });
  assert.equal(a4, "FRESH-0004");
});

test("counter rows hold the NEXT number to issue (current+1 after each call)", async () => {
  // After the previous test, branch A issued up to 0004 and branch B up to 0002.
  // Counters store the NEXT number, so A should be 5 and B should be 3.
  assert.equal(await readBranchCounter(freshSeqId, branchAId), 5);
  assert.equal(await readBranchCounter(freshSeqId, branchBId), 3);
});

test("master sequences.currentNumber is NEVER mutated during issuance (per spec)", async () => {
  // Fresh sequence was created with currentNumber=1; despite 6 issuances
  // across 2 branches above, the master row must still read 1.
  assert.equal(await readMasterCurrent(freshSeqId), 1,
    "master currentNumber should remain at its config value (لا يتم تعديل Sequence Master)");
});

test("sequence_logs gets one row per issuance regardless of branch", async () => {
  // 6 issuances above (4 on branch A + 2 on branch B), all on freshSeqId.
  const rows = await db.select({ n: sequenceLogsTable.id })
    .from(sequenceLogsTable).where(eq(sequenceLogsTable.sequenceId, freshSeqId));
  assert.equal(rows.length, 6);
});

test("first counter on a migrated sequence inherits master.currentNumber to avoid re-issuing legacy numbers", async () => {
  // The migrated sequence was seeded with master.currentNumber=500. The very
  // first per-branch issuance after the upgrade must NOT re-emit "PURCH-0001"
  // (which the legacy tenant already used) — it must seed at 500.
  const first = await nextSequenceNumber(testCompanyId, "purchase_invoice", { branchId: branchAId });
  assert.equal(first, "PURCH-0500", "first issuance on a migrated sequence must inherit master.currentNumber");

  const second = await nextSequenceNumber(testCompanyId, "purchase_invoice", { branchId: branchAId });
  assert.equal(second, "PURCH-0501");
});

test("subsequent NEW branches on a migrated sequence start fresh at start_number (per spec)", async () => {
  // Branch A on migratedSeq is now at 502 (next). Branch B is brand new —
  // per spec "Current_Number = Start_Number" → it must start at 1.
  const b1 = await nextSequenceNumber(testCompanyId, "purchase_invoice", { branchId: branchBId });
  assert.equal(b1, "PURCH-0001",
    "a NEW branch added to a sequence that already has counters must start at start_number");
});

test("null branchId routes to the company-wide sentinel counter (branchId=0)", async () => {
  // Stock-flow operations (transfer/adjustment/count) are warehouse-scoped,
  // not branch-scoped — they pass branchId: null. Verify that two such calls
  // share ONE counter (the sentinel row at branchId=0), independent of the
  // branch-A/B counters issued above.
  const c1 = await nextSequenceNumber(testCompanyId, "sales_invoice", { branchId: null });
  const c2 = await nextSequenceNumber(testCompanyId, "sales_invoice", { branchId: undefined });
  assert.equal(c1, "FRESH-0001",
    "company-wide counter is a brand-new bucket independent of branch A/B");
  assert.equal(c2, "FRESH-0002",
    "second null-branch call must hit the SAME sentinel counter, not seed a new one");

  // Sentinel counter row exists at branchId=0 with currentNumber=3 (next).
  assert.equal(await readBranchCounter(freshSeqId, 0), 3);

  // Branch-A and Branch-B counters are untouched by the sentinel calls.
  assert.equal(await readBranchCounter(freshSeqId, branchAId), 5);
  assert.equal(await readBranchCounter(freshSeqId, branchBId), 3);
});

test("returns null when no active sequence is configured (legacy fallback path)", async () => {
  // The fresh sequence is bound to "sales_invoice" only — calling for an
  // unrelated tx type must return null so callers can fall back to legacy
  // numbering. This rollout-safety property is explicitly documented in
  // sequences.ts and we do not want a per-branch upgrade to regress it.
  const result = await nextSequenceNumber(testCompanyId, "stock_count", { branchId: branchAId });
  assert.equal(result, null);
});
