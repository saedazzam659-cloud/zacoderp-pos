// Regression tests for the source-document JE posting policy.
//
// Background:
//   Source-document journal entries (entryType in LOCKED_ENTRY_TYPES, e.g.
//   "sales_invoice") are created as DRAFT when a company has auto-posting OFF
//   (resolvePostingStatus → "draft"). Previously POST /:id/post rejected ALL
//   locked entry types, so those drafts could never be posted by any screen and
//   never reached the financial reports. The fix lets /post flip a locked draft
//   → posted (status-flip only), while edit / delete / unpost stay locked so the
//   JE can never drift out of sync with its source document.
//
// What this protects (the policy matrix):
//   1. A balanced, draft "sales_invoice" JE CAN be posted via POST /:id/post.
//   2. Editing that JE (PUT /:id) is still 403 (locked).
//   3. Unposting that JE (POST /:id/unpost) is still 403 (locked).
//   4. An UNBALANCED draft "sales_invoice" JE is rejected (400) by /post — the
//      status flip never bypasses the balance guard.
//
// Uses the real DB (DATABASE_URL); cleans up strictly by primary key.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import {
  db, pool,
  usersTable, companiesTable, accountsTable,
  journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";

import app from "../src/app.ts";

const TAG = `tt_jelock_${randomBytes(4).toString("hex")}`;

let server: http.Server;
let baseUrl: string;
let saToken: string;
let saUserId: number;
let cid: number;
let acctDr: number;
let acctCr: number;

const entryIds: number[] = [];

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const [c] = await db.insert(companiesTable).values({
    nameAr:         `اختبار قفل القيود ${TAG}`,
    nameEn:         `JE Lock Test ${TAG}`,
    vatNumber:      `300000000000${TAG.slice(-3)}`,
    crNumber:       `CR_${TAG}`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
  }).returning();
  cid = c.id;

  // A regular company admin (not superadmin) so resolveCompanyId deterministically
  // resolves to this tenant via authUser.companyId — and role "admin" bypasses the
  // per-action permission map while staying inside the company module gate.
  saToken = randomBytes(32).toString("hex");
  const [u] = await db.insert(usersTable).values({
    username: `${TAG}_admin`,
    passwordHash: await bcrypt.hash("x", 4),
    role: "admin",
    companyId: cid,
    sessionToken: saToken,
  }).returning({ id: usersTable.id });
  saUserId = u.id;

  const acctRows = await db.insert(accountsTable).values([
    { companyId: cid, code: `${TAG}_1101`, nameAr: "مدين تجريبي", accountType: "asset"   as any, isPosting: true, level: 4 },
    { companyId: cid, code: `${TAG}_4101`, nameAr: "دائن تجريبي", accountType: "revenue" as any, isPosting: true, level: 4 },
  ]).returning();
  acctDr = acctRows[0].id;
  acctCr = acctRows[1].id;
});

after(async () => {
  try {
    if (entryIds.length) {
      await db.delete(journalEntryLinesTable).where(inArray(journalEntryLinesTable.entryId, entryIds));
      await db.delete(journalEntriesTable).where(inArray(journalEntriesTable.id, entryIds));
    }
    await db.delete(accountsTable).where(eq(accountsTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
    await db.delete(usersTable).where(eq(usersTable.id, saUserId));
  } finally {
    server?.close();
    await pool.end().catch(() => {});
  }
});

function url(p: string): string { return `${baseUrl}${p}`; }
function H() { return { Authorization: `Bearer ${saToken}`, "Content-Type": "application/json" }; }

// Seed a draft source-document JE (entryType "sales_invoice") directly in the
// DB, mimicking what the sales-invoice post endpoint does when auto-posting is
// OFF. periodId is left null so the period guard is a no-op.
async function seedDraftSalesInvoiceJE(dr: number, cr: number): Promise<number> {
  const [e] = await db.insert(journalEntriesTable).values({
    companyId: cid, branchId: null, docNumber: null,
    entryDate: "2026-01-15", currency: "SAR", exchangeRate: "1",
    description: `${TAG} قيد فاتورة مبيعات`, entryType: "sales_invoice",
    status: "draft", periodId: null,
  }).returning();
  entryIds.push(e.id);
  await db.insert(journalEntryLinesTable).values([
    { entryId: e.id, accountId: acctDr, debit: String(dr), credit: "0", sortOrder: 0 },
    { entryId: e.id, accountId: acctCr, debit: "0", credit: String(cr), sortOrder: 1 },
  ]);
  return e.id;
}

test("balanced draft sales_invoice JE CAN be posted via /post (the fix)", async () => {
  const id = await seedDraftSalesInvoiceJE(100, 100);
  const r = await fetch(url(`/api/journal-entries/${id}/post?companyId=${cid}`), {
    method: "POST", headers: H(),
  });
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  const body = await r.json();
  assert.equal(body.ok, true);

  const [row] = await db.select({ status: journalEntriesTable.status })
    .from(journalEntriesTable).where(eq(journalEntriesTable.id, id));
  assert.equal(row.status, "posted", "JE should be posted in the DB");
});

test("editing a locked sales_invoice JE is still rejected (403)", async () => {
  const id = await seedDraftSalesInvoiceJE(50, 50);
  const r = await fetch(url(`/api/journal-entries/${id}?companyId=${cid}`), {
    method: "PUT", headers: H(),
    body: JSON.stringify({ description: "محاولة تعديل", lines: [] }),
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}`);
});

test("unposting a locked sales_invoice JE is still rejected (403)", async () => {
  const id = await seedDraftSalesInvoiceJE(75, 75);
  // First post it (allowed by the fix), then confirm unpost is still blocked.
  const post = await fetch(url(`/api/journal-entries/${id}/post?companyId=${cid}`), {
    method: "POST", headers: H(),
  });
  assert.equal(post.status, 200);
  const unpost = await fetch(url(`/api/journal-entries/${id}/unpost?companyId=${cid}`), {
    method: "POST", headers: H(),
  });
  assert.equal(unpost.status, 403, `expected 403, got ${unpost.status}`);
});

test("unbalanced draft sales_invoice JE is rejected by /post (400) — guard not bypassed", async () => {
  const id = await seedDraftSalesInvoiceJE(100, 90);
  const r = await fetch(url(`/api/journal-entries/${id}/post?companyId=${cid}`), {
    method: "POST", headers: H(),
  });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);

  const [row] = await db.select({ status: journalEntriesTable.status })
    .from(journalEntriesTable).where(eq(journalEntriesTable.id, id));
  assert.equal(row.status, "draft", "unbalanced JE must remain draft");
});
