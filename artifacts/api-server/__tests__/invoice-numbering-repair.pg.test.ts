// PostgreSQL behaviour coverage for the SuperAdmin invoice-number repair API.
//
// This deliberately uses a fresh, hidden disposable tenant rather than any
// fixture/company that might already exist.  Cleanup is guarded by both the
// primary key we recorded and the hidden-workspace ownership marker.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";

import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogTable,
  branchesTable,
  companiesTable,
  db,
  deletedRecordsTable,
  pool,
  salesInvoicesTable,
  sequenceCountersTable,
  sequenceLogsTable,
  sequencesTable,
  usersTable,
} from "@workspace/db";

import app from "../src/app.ts";
import { tombstoneAndDeleteDraftInvoice } from "../src/lib/invoiceDeletionTombstone.js";
import { nextSequenceForPayment } from "../src/lib/sequences.js";

const TEST_TAG = `tt_invoice_repair_pg_${randomBytes(8).toString("hex")}`;
const DATE = "2030-01-15";

let server: http.Server;
let baseUrl: string;
let companyId: number;
let mainBranchId: number;
let otherBranchId: number;
let salesSequenceId: number;
let saToken: string;
let regularToken: string;

const insertedCompanyIds: number[] = [];
const insertedUserIds: number[] = [];
const insertedBranchIds: number[] = [];
const insertedSequenceIds: number[] = [];

type ApiResponse = { status: number; body: Record<string, unknown> };

async function api(
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<ApiResponse> {
  const response = await fetch(baseUrl + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

function repairPayload(
  number: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    mode: "repair_next",
    kind: "sales",
    number,
    branchId: mainBranchId,
    invoiceDate: DATE,
    paymentType: "credit",
    isForeign: false,
    ...overrides,
  };
}

async function assertOwnedTenant(when: string): Promise<void> {
  const [company] = await db.select({
    id: companiesTable.id,
    nameEn: companiesTable.nameEn,
    isInternalDemoWorkspace: companiesTable.isInternalDemoWorkspace,
  }).from(companiesTable).where(eq(companiesTable.id, companyId));
  assert.ok(company, `${when}: disposable tenant must still exist`);
  assert.equal(company.nameEn, `${TEST_TAG} owned disposable tenant`,
    `${when}: tenant ownership marker must match this test run`);
  assert.equal(company.isInternalDemoWorkspace, true,
    `${when}: test tenant must remain a hidden disposable workspace`);
}

async function insertInvoice(
  docNumber: string,
  status: "draft" | "posted",
  branchId = mainBranchId,
) {
  const [invoice] = await db.insert(salesInvoicesTable).values({
    companyId,
    branchId,
    docNumber,
    invoiceDate: DATE,
    paymentType: "credit",
    currencyCode: "SAR",
    exchangeRate: "1",
    subtotal: "0",
    vatAmount: "0",
    discountAmount: "0",
    totalAmount: "0",
    status,
  }).returning();
  return invoice;
}

async function recordDeletedDraft(docNumber: string): Promise<void> {
  const draft = await insertInvoice(docNumber, "draft");
  await db.insert(sequenceLogsTable).values({
    sequenceId: salesSequenceId,
    companyId,
    transactionType: "sales_invoice",
    generatedNumber: docNumber,
    refTable: "sales_invoices",
    refId: String(draft.id),
  });
  await db.transaction(async (tx) => {
    await tombstoneAndDeleteDraftInvoice(
      tx,
      salesInvoicesTable,
      "sales_invoices",
      draft,
      {
        companyId,
        recordId: draft.id,
        deletedBy: null,
        deletedByUsername: null,
        reason: "PG invoice-numbering-repair fixture deletion",
      },
    );
  });
}

async function issueSalesNumber(branchId = mainBranchId): Promise<string> {
  const issued = await nextSequenceForPayment(companyId, "sales_invoice", "credit", {
    refTable: "sales_invoices",
    branchId,
    docDate: DATE,
  });
  assert.ok(issued, "the configured SALES sequence must allocate a real number");
  return issued;
}

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Do not reuse a human tenant even if a prior crashed test left one behind:
  // this unique marker must name no company before this run creates its own.
  const preexisting = await db.select({ id: companiesTable.id })
    .from(companiesTable)
    .where(eq(companiesTable.nameEn, `${TEST_TAG} owned disposable tenant`));
  assert.equal(preexisting.length, 0, "test ownership marker unexpectedly already exists");

  const [company] = await db.insert(companiesTable).values({
    nameAr: `${TEST_TAG} شركة اختبار معزولة`,
    nameEn: `${TEST_TAG} owned disposable tenant`,
    vatNumber: "300000000000003",
    crNumber: "1010000001",
    city: "Riyadh",
    street: "Test Street",
    buildingNumber: "1",
    postalCode: "12345",
    country: "SA",
    invoiceType: "both",
    status: "active",
    // This is the ownership marker used in addition to the per-run name.
    isInternalDemoWorkspace: true,
    // Fix issuance and repair to DATE, not the clock date of the runner.
    sequenceDateSource: "document",
  }).returning({ id: companiesTable.id });
  companyId = company.id;
  insertedCompanyIds.push(companyId);

  const [mainBranch, otherBranch] = await db.insert(branchesTable).values([
    { companyId, code: `${TEST_TAG}-A`, nameAr: "فرع اختبار أ", nameEn: "Test branch A" },
    { companyId, code: `${TEST_TAG}-B`, nameAr: "فرع اختبار ب", nameEn: "Test branch B" },
  ]).returning({ id: branchesTable.id });
  mainBranchId = mainBranch.id;
  otherBranchId = otherBranch.id;
  insertedBranchIds.push(mainBranchId, otherBranchId);

  saToken = `tt_sa_${randomBytes(16).toString("hex")}`;
  regularToken = `tt_regular_${randomBytes(16).toString("hex")}`;
  const users = await db.insert(usersTable).values([
    {
      username: `${TEST_TAG}_sa`,
      email: null,
      passwordHash: "not-used-by-token-fixture",
      role: "superadmin",
      isActive: true,
      sessionToken: saToken,
      sessionId: "test",
      companyId: null,
    },
    {
      username: `${TEST_TAG}_regular`,
      email: null,
      passwordHash: "not-used-by-token-fixture",
      role: "admin",
      isActive: true,
      sessionToken: regularToken,
      sessionId: "test",
      companyId,
    },
  ]).returning({ id: usersTable.id });
  insertedUserIds.push(...users.map((user) => user.id));

  const [salesSequence, purchaseSequence] = await db.insert(sequencesTable).values([
    {
      companyId,
      code: `${TEST_TAG}-SALES`,
      nameAr: "تسلسل مبيعات اختبار",
      nameEn: "Test SALES sequence",
      prefix: "SA-",
      startNumber: 1,
      endNumber: 9999,
      // Simulates a counter left at 0015 after drafts 0012–0014 were removed.
      currentNumber: 15,
      padLength: 4,
      monthlyReset: false,
      transactionTypes: ["sales_invoice"],
    },
    {
      companyId,
      code: `${TEST_TAG}-PURCHASE`,
      nameAr: "تسلسل مشتريات اختبار",
      nameEn: "Test PURCHASE sequence",
      // Deliberately same rendered prefix as SALES: type isolation, not text
      // difference, is what permits an independent repair.
      prefix: "SA-",
      startNumber: 1,
      endNumber: 9999,
      currentNumber: 12,
      padLength: 3,
      monthlyReset: false,
      transactionTypes: ["purchase_invoice"],
    },
  ]).returning({ id: sequencesTable.id });
  salesSequenceId = salesSequence.id;
  insertedSequenceIds.push(salesSequence.id, purchaseSequence.id);

  await db.insert(sequenceCountersTable).values({
    sequenceId: salesSequenceId,
    branchId: mainBranchId,
    period: "",
    currentNumber: 15,
  });

  // A live 0011 is the last undisputed issued number.  The subsequent drafts
  // are removed by the same tombstone helper the invoice DELETE route uses.
  await insertInvoice("SA-0011", "posted");
  await recordDeletedDraft("SA-0012");
  await recordDeletedDraft("SA-0013");
  await recordDeletedDraft("SA-0014");
  const reclaimEvidence = await db.select({
    recordId: deletedRecordsTable.recordId,
    tableName: deletedRecordsTable.tableName,
  }).from(deletedRecordsTable).where(and(
    eq(deletedRecordsTable.companyId, companyId),
    eq(deletedRecordsTable.tableName, "sales_invoices"),
  ));
  assert.equal(reclaimEvidence.length, 3,
    "each deleted draft must leave the tombstone required for safe reclaim");
  await assertOwnedTenant("fixture setup");
});

after(async () => {
  try {
    // The test must never cascade-clean a tenant unless it can still prove
    // that the tenant is the hidden workspace created above.
    await assertOwnedTenant("before cleanup");

    const idsForCompany = async (table: any) =>
      (await db.select({ id: table.id }).from(table).where(eq(table.companyId, companyId))).map((row) => row.id);
    const deleteTracked = async (table: any, ids: number[]) => {
      if (ids.length) await db.delete(table).where(inArray(table.id, ids));
    };

    await deleteTracked(auditLogTable, await idsForCompany(auditLogTable));
    await deleteTracked(salesInvoicesTable, await idsForCompany(salesInvoicesTable));
    await deleteTracked(deletedRecordsTable, await idsForCompany(deletedRecordsTable));

    const counterIds = (await db.select({ id: sequenceCountersTable.id })
      .from(sequenceCountersTable)
      .where(inArray(sequenceCountersTable.sequenceId, insertedSequenceIds))).map((row) => row.id);
    const logIds = (await db.select({ id: sequenceLogsTable.id })
      .from(sequenceLogsTable)
      .where(inArray(sequenceLogsTable.sequenceId, insertedSequenceIds))).map((row) => row.id);
    await deleteTracked(sequenceCountersTable, counterIds);
    await deleteTracked(sequenceLogsTable, logIds);
    await deleteTracked(branchesTable, insertedBranchIds);
    await deleteTracked(usersTable, insertedUserIds);
    await deleteTracked(sequencesTable, insertedSequenceIds);
    await deleteTracked(companiesTable, insertedCompanyIds);
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    try { await pool.end(); } catch { /* pool may already be closed */ }
  }
});

test("SA repair reclaims only deleted drafts and serializes with real issuance", async () => {
  const nonSa = await api(
    `/api/admin/companies/${companyId}/invoice-numbering-repair`,
    regularToken,
    repairPayload("SA-0012"),
  );
  assert.equal(nonSa.status, 403, "a tenant admin must not reach SA repair");

  const reset = await api(
    `/api/admin/companies/${companyId}/invoice-numbering-repair`,
    saToken,
    repairPayload("SA-0012"),
  );
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.number, "SA-0012");

  const firstIssued = await issueSalesNumber();
  assert.equal(firstIssued, "SA-0012", "repair_next must make 0012 the next real issuance");
  // Persist the real issued number so the remainder of the scenario works
  // against live business data, not just a sequence-log assertion.
  await insertInvoice(firstIssued, "draft");

  await insertInvoice("SA-0013", "draft");
  const colliding = await api(
    `/api/admin/companies/${companyId}/invoice-numbering-repair`,
    saToken,
    repairPayload("SA-0013"),
  );
  assert.equal(colliding.status, 409, "a live candidate must be rejected");

  const correction = await insertInvoice("SA-0099", "draft");
  await db.update(sequenceCountersTable).set({ currentNumber: 20 }).where(and(
    eq(sequenceCountersTable.sequenceId, salesSequenceId),
    eq(sequenceCountersTable.branchId, mainBranchId),
    eq(sequenceCountersTable.period, ""),
  ));
  const corrected = await api(
    `/api/admin/companies/${companyId}/invoice-numbering-repair`,
    saToken,
    repairPayload("SA-0014", { mode: "correct_draft", invoiceId: correction.id }),
  );
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  assert.equal(corrected.body.nextNumber, "SA-0020",
    "correcting one draft must not rewind a later counter");
  const [storedCorrection] = await db.select({
    docNumber: salesInvoicesTable.docNumber,
  }).from(salesInvoicesTable).where(eq(salesInvoicesTable.id, correction.id));
  const [storedCounter] = await db.select({
    currentNumber: sequenceCountersTable.currentNumber,
  }).from(sequenceCountersTable).where(and(
    eq(sequenceCountersTable.sequenceId, salesSequenceId),
    eq(sequenceCountersTable.branchId, mainBranchId),
    eq(sequenceCountersTable.period, ""),
  ));
  assert.equal(storedCorrection.docNumber, "SA-0014", "only the selected draft is corrected");
  assert.equal(storedCounter.currentNumber, 20, "draft correction must retain the later counter");

  // Make a legacy five-digit display number and then ask the three-digit
  // current formatter for the same numeric suffix.  Exact text differs, so a
  // 409 here proves the numeric-equivalent collision check reached PostgreSQL.
  await db.update(sequencesTable).set({ padLength: 3 }).where(eq(sequencesTable.id, salesSequenceId));
  await insertInvoice("SA-0015", "draft");
  const equivalentDraft = await insertInvoice("SA-099", "draft");
  const numericEquivalent = await api(
    `/api/admin/companies/${companyId}/invoice-numbering-repair`,
    saToken,
    repairPayload("SA-015", { mode: "correct_draft", invoiceId: equivalentDraft.id }),
  );
  assert.equal(numericEquivalent.status, 409,
    "SA-015 must be blocked by live numeric-equivalent SA-0015 in its stream");

  const otherBranch = await api(
    `/api/admin/companies/${companyId}/invoice-numbering-repair`,
    saToken,
    repairPayload("SA-012", { branchId: otherBranchId }),
  );
  assert.equal(otherBranch.status, 409,
    "a branchless historical log must not be guessed to belong to another branch");
  assert.equal(otherBranch.body.code, "MISSING_DELETED_DRAFT_PROOF");

  const purchase = await api(
    `/api/admin/companies/${companyId}/invoice-numbering-repair`,
    saToken,
    {
      mode: "repair_next",
      kind: "purchase",
      number: "SA-012",
      branchId: 0,
      invoiceDate: DATE,
      paymentType: "credit",
    },
  );
  assert.equal(purchase.status, 200, "the purchase stream is independent from SALES");

  // The reset transaction locks the same counter as central issuance.  Whichever
  // obtains it first, the concurrently issued value and the following real
  // issuance must be distinct. 101 is above the still-live 099 collision
  // fixture; attempting 021 would correctly fail the high-water guard.
  const [concurrentRepair, concurrentlyIssued] = await Promise.all([
    api(
      `/api/admin/companies/${companyId}/invoice-numbering-repair`,
      saToken,
      repairPayload("SA-101"),
    ),
    issueSalesNumber(),
  ]);
  assert.equal(concurrentRepair.status, 200, JSON.stringify(concurrentRepair.body));
  const afterConcurrentIssue = await issueSalesNumber();
  assert.notEqual(concurrentlyIssued, afterConcurrentIssue,
    "concurrent repair and issuance must never allocate a duplicate number");

  // Atomic 204 -> 202 correction. Its own direct allocation claim is
  // releasable; an additional legacy null-ref claim must fail closed.
  const atomicDraft = await insertInvoice("SA-204", "draft");
  await db.insert(sequenceLogsTable).values({
    sequenceId: salesSequenceId,
    companyId,
    transactionType: "sales_invoice",
    generatedNumber: "SA-204",
    refTable: "sales_invoices",
    refId: String(atomicDraft.id),
  });
  const [unknownDuplicateClaim] = await db.insert(sequenceLogsTable).values({
    sequenceId: salesSequenceId,
    companyId,
    transactionType: "sales_invoice",
    generatedNumber: "SA-204",
    refTable: "sales_invoices",
    refId: null,
  }).returning({ id: sequenceLogsTable.id });
  const blockedUnknownClaim = await api(
    `/api/admin/companies/${companyId}/invoice-numbering-repair`,
    saToken,
    repairPayload("SA-202", {
      mode: "correct_draft", invoiceId: atomicDraft.id, resetNext: true, dryRun: true,
    }),
  );
  assert.equal(blockedUnknownClaim.status, 409,
    "a second unknown old-number claim must not be waived by matching text");
  assert.equal(blockedUnknownClaim.body.code, "UNKNOWN_OLD_NUMBER_CLAIM");
  await db.delete(sequenceLogsTable).where(eq(sequenceLogsTable.id, unknownDuplicateClaim.id));

  const [counterBeforeDry] = await db.select({
    currentNumber: sequenceCountersTable.currentNumber,
  }).from(sequenceCountersTable).where(and(
    eq(sequenceCountersTable.sequenceId, salesSequenceId),
    eq(sequenceCountersTable.branchId, mainBranchId),
    eq(sequenceCountersTable.period, ""),
  ));
  const auditsBeforeDry = await db.select({ id: auditLogTable.id }).from(auditLogTable)
    .where(eq(auditLogTable.companyId, companyId));
  const preflight = await api(
    `/api/admin/companies/${companyId}/invoice-numbering-repair`,
    saToken,
    repairPayload("SA-202", {
      mode: "correct_draft", invoiceId: atomicDraft.id, resetNext: true, dryRun: true,
    }),
  );
  assert.equal(preflight.status, 200, JSON.stringify(preflight.body));
  assert.equal(preflight.body.canApply, true);
  assert.equal(preflight.body.oldNumber, "SA-204");
  assert.equal(preflight.body.newNumber, "SA-202");
  assert.equal(preflight.body.nextNumber, "SA-203");
  const [draftAfterDry] = await db.select({ docNumber: salesInvoicesTable.docNumber })
    .from(salesInvoicesTable).where(eq(salesInvoicesTable.id, atomicDraft.id));
  const [counterAfterDry] = await db.select({
    currentNumber: sequenceCountersTable.currentNumber,
  }).from(sequenceCountersTable).where(and(
    eq(sequenceCountersTable.sequenceId, salesSequenceId),
    eq(sequenceCountersTable.branchId, mainBranchId),
    eq(sequenceCountersTable.period, ""),
  ));
  const auditsAfterDry = await db.select({ id: auditLogTable.id }).from(auditLogTable)
    .where(eq(auditLogTable.companyId, companyId));
  assert.equal(draftAfterDry.docNumber, "SA-204", "dryRun must not renumber the draft");
  assert.equal(counterAfterDry.currentNumber, counterBeforeDry.currentNumber,
    "dryRun must not reset or insert a counter");
  assert.equal(auditsAfterDry.length, auditsBeforeDry.length, "dryRun must not write an audit");

  const atomic = await api(
    `/api/admin/companies/${companyId}/invoice-numbering-repair`,
    saToken,
    repairPayload("SA-202", {
      mode: "correct_draft", invoiceId: atomicDraft.id, resetNext: true, dryRun: false,
    }),
  );
  assert.equal(atomic.status, 200, JSON.stringify(atomic.body));
  assert.equal(atomic.body.nextNumber, "SA-203");
  assert.equal(await issueSalesNumber(), "SA-203");

  // The exact-log audit proof written atomically above releases 204 for a
  // later repair; a mere same-number audit could not do this.
  const futureRepair = await api(
    `/api/admin/companies/${companyId}/invoice-numbering-repair`,
    saToken,
    repairPayload("SA-204"),
  );
  assert.equal(futureRepair.status, 200, JSON.stringify(futureRepair.body));
  assert.equal(await issueSalesNumber(), "SA-204");
  await assertOwnedTenant("after behaviour assertions");
});