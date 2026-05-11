// Integration tests for the Contracting Journal Engine (IFRS 15) added in
// Phase 3 of the auto-posting roll-out.
//
// What this protects:
//   • buildOutgoingBillJournal — DR Receivable (net) + DR Retention
//     Receivable / CR Revenue (gross-prevPaid) + CR VAT Output; balanced;
//     entryType = "contracting_outgoing_bill"; status follows the
//     autoPostCtgOutgoingBill toggle; bill row gets `journalEntryId`
//     back-filled.
//   • buildIncomingBillJournal — DR WIP (gross-prevPaid) + DR VAT Input /
//     CR Payable (net) + CR Retention Payable; balanced; entryType =
//     "contracting_incoming_bill"; status follows the
//     autoPostCtgIncomingBill toggle; bill row linked.
//   • Idempotency — calling the builder twice on the same approved bill
//     does not duplicate the JE.
//   • Period-revenue math — for a cumulative bill (gross=500, prevPaid=200,
//     ret%=5) the revenue line equals 300, not 500. A regression here would
//     overstate revenue every time a follow-up مستخلص is approved.
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Uses the real DB (DATABASE_URL). Seeds a tagged company + 8 posting
//     accounts + the matching accounting_mappings rows.
//   - Cleanup is by recorded primary keys ONLY (no LIKE).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  companiesTable,
  accountsTable,
  accountingMappingsTable,
  contractingProjectsTable,
  contractingProgressBillsTable,
  journalEntriesTable,
  journalEntryLinesTable,
} from "@workspace/db";

import {
  buildOutgoingBillJournal,
  buildIncomingBillJournal,
} from "../src/lib/contracting-journals.ts";

const TAG = `tt_ctg_${randomBytes(4).toString("hex")}`;

let cid: number;
let projectId: number;
let acctAR: number;
let acctRetRecv: number;
let acctRevenue: number;
let acctVatOut: number;
let acctWip: number;
let acctVatIn: number;
let acctAP: number;
let acctRetPay: number;

const insertedCompanyIds: number[] = [];
const insertedAccountIds: number[] = [];
const insertedMappingIds: number[] = [];
const insertedProjectIds: number[] = [];
const insertedBillIds: number[] = [];
const insertedEntryIds: number[] = [];

before(async () => {
  const [c] = await db.insert(companiesTable).values({
    nameAr:         `اختبار قيود المقاولات ${TAG}`,
    nameEn:         `Contracting Journals Test ${TAG}`,
    vatNumber:      `300000000000${TAG.slice(-3)}`,
    crNumber:       `CR_${TAG}`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
  }).returning();
  cid = c.id;
  insertedCompanyIds.push(cid);

  const acctRows = await db.insert(accountsTable).values([
    { companyId: cid, code: `${TAG}_1210`, nameAr: "عملاء مقاولات",          accountType: "asset"     as any, isPosting: true, level: 4 },
    { companyId: cid, code: `${TAG}_1215`, nameAr: "محتجزات لدى العملاء",     accountType: "asset"     as any, isPosting: true, level: 4 },
    { companyId: cid, code: `${TAG}_4115`, nameAr: "إيرادات مقاولات",         accountType: "revenue"   as any, isPosting: true, level: 4 },
    { companyId: cid, code: `${TAG}_2140`, nameAr: "ضريبة المخرجات",          accountType: "liability" as any, isPosting: true, level: 4 },
    { companyId: cid, code: `${TAG}_1310`, nameAr: "أعمال تحت التنفيذ",       accountType: "asset"     as any, isPosting: true, level: 4 },
    { companyId: cid, code: `${TAG}_1240`, nameAr: "ضريبة المدخلات",          accountType: "asset"     as any, isPosting: true, level: 4 },
    { companyId: cid, code: `${TAG}_2110`, nameAr: "موردي مقاولات",           accountType: "liability" as any, isPosting: true, level: 4 },
    { companyId: cid, code: `${TAG}_2115`, nameAr: "محتجزات لدى الباطن",     accountType: "liability" as any, isPosting: true, level: 4 },
  ]).returning();
  [acctAR, acctRetRecv, acctRevenue, acctVatOut, acctWip, acctVatIn, acctAP, acctRetPay] =
    acctRows.map(r => r.id);
  insertedAccountIds.push(...acctRows.map(r => r.id));

  const mapRows = await db.insert(accountingMappingsTable).values([
    { companyId: cid, documentType: "contracting_outgoing_bill", roleKey: "receivable",           accountId: acctAR },
    { companyId: cid, documentType: "contracting_outgoing_bill", roleKey: "retention_receivable", accountId: acctRetRecv },
    { companyId: cid, documentType: "contracting_outgoing_bill", roleKey: "revenue",              accountId: acctRevenue },
    { companyId: cid, documentType: "contracting_outgoing_bill", roleKey: "vat_output",           accountId: acctVatOut },
    { companyId: cid, documentType: "contracting_incoming_bill", roleKey: "wip",                  accountId: acctWip },
    { companyId: cid, documentType: "contracting_incoming_bill", roleKey: "vat_input",            accountId: acctVatIn },
    { companyId: cid, documentType: "contracting_incoming_bill", roleKey: "payable",              accountId: acctAP },
    { companyId: cid, documentType: "contracting_incoming_bill", roleKey: "retention_payable",    accountId: acctRetPay },
  ]).returning();
  insertedMappingIds.push(...mapRows.map(r => r.id));

  const [p] = await db.insert(contractingProjectsTable).values({
    companyId: cid, code: `${TAG}_PRJ`, nameAr: "مشروع اختبار",
    contractValue: "1000000",
  }).returning();
  projectId = p.id;
  insertedProjectIds.push(projectId);
});

after(async () => {
  if (insertedBillIds.length)    await db.delete(contractingProgressBillsTable).where(inArray(contractingProgressBillsTable.id, insertedBillIds));
  if (insertedEntryIds.length) {
    await db.delete(journalEntryLinesTable).where(inArray(journalEntryLinesTable.entryId, insertedEntryIds));
    await db.delete(journalEntriesTable).where(inArray(journalEntriesTable.id, insertedEntryIds));
  }
  if (insertedProjectIds.length) await db.delete(contractingProjectsTable).where(inArray(contractingProjectsTable.id, insertedProjectIds));
  if (insertedMappingIds.length) await db.delete(accountingMappingsTable).where(inArray(accountingMappingsTable.id, insertedMappingIds));
  if (insertedAccountIds.length) await db.delete(accountsTable).where(inArray(accountsTable.id, insertedAccountIds));
  if (insertedCompanyIds.length) await db.delete(companiesTable).where(inArray(companiesTable.id, insertedCompanyIds));
  await pool.end();
});

async function loadEntry(entryId: number) {
  const [hdr] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, entryId));
  const lines = await db.select().from(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, entryId));
  insertedEntryIds.push(entryId);
  return { hdr, lines };
}

// Helper to compute the schema's bill math the same way the route does.
function billMath(gross: number, retPct: number, vatPct: number, prevPaid: number) {
  const ret = Math.round((gross * retPct / 100) * 100) / 100;
  const due = Math.max(0, Math.round((gross - ret - prevPaid) * 100) / 100);
  const vat = Math.round((due * vatPct / 100) * 100) / 100;
  const net = Math.round((due + vat) * 100) / 100;
  return { ret, due, vat, net };
}

test("outgoing: DR AR+Retention / CR Revenue+VAT — balanced, posted, bill linked", async () => {
  // First bill: gross 1000, ret 5%, VAT 15%, prevPaid 0
  const m = billMath(1000, 5, 15, 0);
  assert.equal(m.ret, 50); assert.equal(m.due, 950); assert.equal(m.vat, 142.5); assert.equal(m.net, 1092.5);

  const [bill] = await db.insert(contractingProgressBillsTable).values({
    companyId: cid, projectId, direction: "outgoing",
    billNumber: `${TAG}_OB1`, billDate: "2025-05-01",
    grossAmount: "1000", retentionPercent: "5", retentionAmount: String(m.ret),
    previousPaid: "0", dueAmount: String(m.due),
    vatPercent: "15", vatAmount: String(m.vat), netAmount: String(m.net),
    status: "approved",
  }).returning();
  insertedBillIds.push(bill.id);

  const entryId = await buildOutgoingBillJournal(cid, bill.id);
  assert.ok(entryId, "expected an entry id");
  const { hdr, lines } = await loadEntry(entryId!);

  assert.equal(hdr.entryType, "contracting_outgoing_bill");
  assert.equal(hdr.status, "posted");
  assert.equal(lines.length, 4);

  const byAcct = new Map<number, { d: number; c: number }>();
  for (const l of lines) {
    const cur = byAcct.get(l.accountId) ?? { d: 0, c: 0 };
    cur.d += Number(l.debit || 0); cur.c += Number(l.credit || 0);
    byAcct.set(l.accountId, cur);
  }
  assert.equal(byAcct.get(acctAR)?.d,      1092.5);
  assert.equal(byAcct.get(acctRetRecv)?.d, 50);
  assert.equal(byAcct.get(acctRevenue)?.c, 1000); // gross - prevPaid = 1000
  assert.equal(byAcct.get(acctVatOut)?.c,  142.5);

  const dr = lines.reduce((s, l) => s + Number(l.debit  || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  assert.equal(dr, cr);

  const [linked] = await db.select().from(contractingProgressBillsTable).where(eq(contractingProgressBillsTable.id, bill.id));
  assert.equal(linked.journalEntryId, entryId);
});

test("outgoing: cumulative second bill recognises only the period delta as revenue", async () => {
  // Cumulative: gross 1500 (was 1000 last period), prevPaid 950 (the dueAmount
  // that was billed last time). Revenue this period must be 1500-950=550, NOT 1500.
  const prevPaid = 950;
  const m = billMath(1500, 5, 15, prevPaid);

  const [bill] = await db.insert(contractingProgressBillsTable).values({
    companyId: cid, projectId, direction: "outgoing",
    billNumber: `${TAG}_OB2`, billDate: "2025-06-01",
    grossAmount: "1500", retentionPercent: "5", retentionAmount: String(m.ret),
    previousPaid: String(prevPaid), dueAmount: String(m.due),
    vatPercent: "15", vatAmount: String(m.vat), netAmount: String(m.net),
    status: "approved",
  }).returning();
  insertedBillIds.push(bill.id);

  const entryId = await buildOutgoingBillJournal(cid, bill.id);
  const { lines } = await loadEntry(entryId!);
  const rev = lines.find(l => l.accountId === acctRevenue && Number(l.credit) > 0)!;
  assert.equal(Number(rev.credit), 1500 - prevPaid, "revenue must be the period delta");

  const dr = lines.reduce((s, l) => s + Number(l.debit  || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  assert.equal(dr, cr, "cumulative-period JE must still balance");
});

test("outgoing: status follows autoPostCtgOutgoingBill toggle (false → draft)", async () => {
  await db.update(companiesTable).set({ autoPostCtgOutgoingBill: false }).where(eq(companiesTable.id, cid));
  try {
    const m = billMath(500, 5, 15, 0);
    const [bill] = await db.insert(contractingProgressBillsTable).values({
      companyId: cid, projectId, direction: "outgoing",
      billNumber: `${TAG}_OB3`, billDate: "2025-07-01",
      grossAmount: "500", retentionPercent: "5", retentionAmount: String(m.ret),
      previousPaid: "0", dueAmount: String(m.due),
      vatPercent: "15", vatAmount: String(m.vat), netAmount: String(m.net),
      status: "approved",
    }).returning();
    insertedBillIds.push(bill.id);
    const entryId = await buildOutgoingBillJournal(cid, bill.id);
    const { hdr } = await loadEntry(entryId!);
    assert.equal(hdr.status, "draft");
  } finally {
    await db.update(companiesTable).set({ autoPostCtgOutgoingBill: true }).where(eq(companiesTable.id, cid));
  }
});

test("outgoing: idempotent — calling twice does not create a second JE", async () => {
  const m = billMath(800, 5, 15, 0);
  const [bill] = await db.insert(contractingProgressBillsTable).values({
    companyId: cid, projectId, direction: "outgoing",
    billNumber: `${TAG}_OB4`, billDate: "2025-08-01",
    grossAmount: "800", retentionPercent: "5", retentionAmount: String(m.ret),
    previousPaid: "0", dueAmount: String(m.due),
    vatPercent: "15", vatAmount: String(m.vat), netAmount: String(m.net),
    status: "approved",
  }).returning();
  insertedBillIds.push(bill.id);
  const e1 = await buildOutgoingBillJournal(cid, bill.id);
  const e2 = await buildOutgoingBillJournal(cid, bill.id);
  assert.equal(e1, e2, "same entry id on second call");
  await loadEntry(e1!); // record for cleanup
});

test("incoming: DR WIP+VATIn / CR AP+RetentionPayable — balanced, posted, bill linked", async () => {
  const m = billMath(2000, 10, 15, 500);
  // Verify formula: ret=200, due=2000-200-500=1300, vat=195, net=1495
  assert.equal(m.ret, 200); assert.equal(m.due, 1300); assert.equal(m.vat, 195); assert.equal(m.net, 1495);

  const [bill] = await db.insert(contractingProgressBillsTable).values({
    companyId: cid, projectId, direction: "incoming",
    contractorId: null,
    billNumber: `${TAG}_IB1`, billDate: "2025-05-15",
    grossAmount: "2000", retentionPercent: "10", retentionAmount: String(m.ret),
    previousPaid: "500", dueAmount: String(m.due),
    vatPercent: "15", vatAmount: String(m.vat), netAmount: String(m.net),
    status: "approved",
  }).returning();
  insertedBillIds.push(bill.id);

  const entryId = await buildIncomingBillJournal(cid, bill.id);
  const { hdr, lines } = await loadEntry(entryId!);
  assert.equal(hdr.entryType, "contracting_incoming_bill");
  assert.equal(hdr.status, "posted");
  assert.equal(lines.length, 4);

  const byAcct = new Map<number, { d: number; c: number }>();
  for (const l of lines) {
    const cur = byAcct.get(l.accountId) ?? { d: 0, c: 0 };
    cur.d += Number(l.debit || 0); cur.c += Number(l.credit || 0);
    byAcct.set(l.accountId, cur);
  }
  assert.equal(byAcct.get(acctWip)?.d,    1500); // 2000 - 500 prevPaid
  assert.equal(byAcct.get(acctVatIn)?.d,  195);
  assert.equal(byAcct.get(acctAP)?.c,     1495);
  assert.equal(byAcct.get(acctRetPay)?.c, 200);

  const dr = lines.reduce((s, l) => s + Number(l.debit  || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  assert.equal(dr, cr);

  const [linked] = await db.select().from(contractingProgressBillsTable).where(eq(contractingProgressBillsTable.id, bill.id));
  assert.equal(linked.journalEntryId, entryId);
});

test("incoming: status follows autoPostCtgIncomingBill toggle (false → draft)", async () => {
  await db.update(companiesTable).set({ autoPostCtgIncomingBill: false }).where(eq(companiesTable.id, cid));
  try {
    const m = billMath(300, 5, 15, 0);
    const [bill] = await db.insert(contractingProgressBillsTable).values({
      companyId: cid, projectId, direction: "incoming",
      billNumber: `${TAG}_IB2`, billDate: "2025-06-15",
      grossAmount: "300", retentionPercent: "5", retentionAmount: String(m.ret),
      previousPaid: "0", dueAmount: String(m.due),
      vatPercent: "15", vatAmount: String(m.vat), netAmount: String(m.net),
      status: "approved",
    }).returning();
    insertedBillIds.push(bill.id);
    const entryId = await buildIncomingBillJournal(cid, bill.id);
    const { hdr } = await loadEntry(entryId!);
    assert.equal(hdr.status, "draft");
  } finally {
    await db.update(companiesTable).set({ autoPostCtgIncomingBill: true }).where(eq(companiesTable.id, cid));
  }
});

test("outgoing: throws clear Arabic error when revenue mapping is missing", async () => {
  // Temporarily clear the revenue mapping.
  await db.update(accountingMappingsTable)
    .set({ accountId: null })
    .where(inArray(accountingMappingsTable.id, insertedMappingIds));
  try {
    const m = billMath(100, 5, 15, 0);
    const [bill] = await db.insert(contractingProgressBillsTable).values({
      companyId: cid, projectId, direction: "outgoing",
      billNumber: `${TAG}_OB_ERR`, billDate: "2025-09-01",
      grossAmount: "100", retentionPercent: "5", retentionAmount: String(m.ret),
      previousPaid: "0", dueAmount: String(m.due),
      vatPercent: "15", vatAmount: String(m.vat), netAmount: String(m.net),
      status: "approved",
    }).returning();
    insertedBillIds.push(bill.id);
    await assert.rejects(
      () => buildOutgoingBillJournal(cid, bill.id),
      /receivable|revenue|محتجزات|ضريبة|غير مربوط/,
    );
  } finally {
    // Restore mappings for any later tests / cleanup.
    const rows = [
      { id: insertedMappingIds[0], accountId: acctAR },
      { id: insertedMappingIds[1], accountId: acctRetRecv },
      { id: insertedMappingIds[2], accountId: acctRevenue },
      { id: insertedMappingIds[3], accountId: acctVatOut },
      { id: insertedMappingIds[4], accountId: acctWip },
      { id: insertedMappingIds[5], accountId: acctVatIn },
      { id: insertedMappingIds[6], accountId: acctAP },
      { id: insertedMappingIds[7], accountId: acctRetPay },
    ];
    for (const r of rows) {
      await db.update(accountingMappingsTable).set({ accountId: r.accountId }).where(eq(accountingMappingsTable.id, r.id));
    }
  }
});
