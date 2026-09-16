// This integration regression is intentionally NOT part of the normal suite.
// Run it through scripts/run-isolated-contracting-lifecycle.sh, which creates
// and destroys its own loopback PostgreSQL cluster.
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accountsTable,
  accountingMappingsTable,
  cashBoxesTable,
  companiesTable,
  contractingBillAdditionsTable,
  contractingBillLinesTable,
  contractingContractBoqLinesTable,
  contractingContractorsTable,
  contractingOwnerContractsTable,
  contractingProgressBillsTable,
  contractingProjectsTable,
  contractingSubContractsTable,
  contractingWorkItemsTable,
  createExternalDb,
  db,
  journalEntriesTable,
  journalEntryLinesTable,
  pool,
  runWithExternalDb,
  sequencesTable,
  usersTable,
} from "@workspace/db";
import {
  approveBill,
  createSettlement,
  createPostedCorrection,
  reverseBillSettlement,
} from "../src/lib/contracting-accounting-service.ts";
import { createContractIdempotently } from "../src/lib/contracting-contract-create-idempotency.ts";
import { ensureBillCreateIdempotencySchema } from "../src/lib/contracting-bill-create-idempotency.ts";
import contractingRouter from "../src/routes/contracting.ts";

const armed = process.env.CONTRACTING_ISOLATED_LIFECYCLE === "1";
const localUrl = process.env.DATABASE_URL ?? "";
const req = { authUser: { id: 1, role: "admin", viewAllBranches: true, branchIds: [] } };

async function assertBalancedFlippedJournals(originalId: number, reversalId: number) {
  const [original] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, originalId));
  const [reversal] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, reversalId));
  assert.equal(original?.status, "posted");
  assert.equal(reversal?.status, "posted");
  const [originalLines, reversalLines] = await Promise.all([
    db.select().from(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, originalId)),
    db.select().from(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, reversalId)),
  ]);
  assert.ok(originalLines.length > 0);
  assert.equal(reversalLines.length, originalLines.length);
  const cents = (amount: unknown) => Math.round(Number(amount) * 100);
  assert.equal(
    originalLines.reduce((sum, line) => sum + cents(line.debit), 0),
    originalLines.reduce((sum, line) => sum + cents(line.credit), 0),
    "original journal is balanced",
  );
  assert.equal(
    reversalLines.reduce((sum, line) => sum + cents(line.debit), 0),
    reversalLines.reduce((sum, line) => sum + cents(line.credit), 0),
    "reversal journal is balanced",
  );
  const grouped = (lines: typeof originalLines) => {
    const byAccount = new Map<string, { debit: number; credit: number }>();
    for (const line of lines) {
      const key = `${line.accountId}|${line.costCenter ?? ""}`;
      const current = byAccount.get(key) ?? { debit: 0, credit: 0 };
      current.debit += cents(line.debit);
      current.credit += cents(line.credit);
      byAccount.set(key, current);
    }
    return byAccount;
  };
  const originalByAccount = grouped(originalLines);
  const reversalByAccount = grouped(reversalLines);
  assert.equal(reversalByAccount.size, originalByAccount.size);
  for (const [account, line] of originalByAccount) {
    const flipped = reversalByAccount.get(account);
    assert.ok(flipped, "reversal retains each account/cost-center allocation");
    assert.equal(flipped!.debit, line.credit, "reversal debits original credit");
    assert.equal(flipped!.credit, line.debit, "reversal credits original debit");
  }
}

async function assertBalancedJournal(entryId: number) {
  const [entry] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, entryId));
  assert.equal(entry?.status, "posted");
  const lines = await db.select().from(journalEntryLinesTable)
    .where(eq(journalEntryLinesTable.entryId, entryId));
  assert.ok(lines.length > 0);
  const cents = (amount: unknown) => Math.round(Number(amount) * 100);
  assert.equal(
    lines.reduce((sum, line) => sum + cents(line.debit), 0),
    lines.reduce((sum, line) => sum + cents(line.credit), 0),
    "journal is balanced",
  );
}

test("isolated PostgreSQL contracting lifecycle", { skip: !armed }, async (t) => {
  assert.match(localUrl, /^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/postgres\?sslmode=disable$/);
  const tag = `isolated-${randomUUID()}`;
  let companyId = 0;
  let testServer: any = null;
  let externalDbName: string | null = null;
  let externalContext: ReturnType<typeof createExternalDb> | null = null;
  try {
    // Schema setup must follow the active AsyncLocalStorage datasource. Verify
    // it against central plus a second database in this same disposable
    // cluster, without contacting any production/external database.
    await ensureBillCreateIdempotencySchema();
    externalDbName = `ctg_ext_${randomUUID().replace(/-/g, "")}`;
    await pool.query(`CREATE DATABASE "${externalDbName}"`);
    externalContext = createExternalDb(localUrl.replace(
      "/postgres?sslmode=disable",
      `/${externalDbName}?sslmode=disable`,
    ));
    await runWithExternalDb(externalContext, async () => {
      await db.execute(sql`CREATE TABLE companies (id INTEGER PRIMARY KEY)`);
      await db.execute(sql`CREATE TABLE users (id INTEGER PRIMARY KEY)`);
      await db.execute(sql`CREATE TABLE contracting_progress_bills (id INTEGER PRIMARY KEY)`);
      await ensureBillCreateIdempotencySchema();
      const table = await db.execute(sql`
        SELECT to_regclass('public.contracting_bill_create_idempotency') AS name
      `);
      assert.equal((table as any).rows[0].name, "contracting_bill_create_idempotency");
    });
    await externalContext.pool.end();
    externalContext = null;
    await pool.query(`DROP DATABASE "${externalDbName}"`);
    externalDbName = null;

    const [company] = await db.insert(companiesTable).values({
      nameAr: `اختبار ${tag}`, nameEn: tag, vatNumber: "300000000000003",
      crNumber: tag, city: "Riyadh", street: "Test", buildingNumber: "1", postalCode: "12345",
    }).returning();
    companyId = company.id;
    const [user] = await db.insert(usersTable).values({
      companyId, username: tag, passwordHash: "isolated-test-only", sessionToken: tag, role: "admin",
    }).returning();
    req.authUser.id = user.id;
    const [project] = await db.insert(contractingProjectsTable).values({
      companyId, code: tag, nameAr: "مشروع دورة حياة", contractValue: "1200",
    }).returning();
    const [contractor] = await db.insert(contractingContractorsTable).values({
      companyId, name: "مقاول اختبار",
    }).returning();

    // Owner and subcontract retries replay their original resource rather than
    // creating a second contract.
    const ownerPayload = `${tag}-owner`;
    const ownerCreate = (tx: any) => tx.insert(contractingOwnerContractsTable).values({
      companyId, projectId: project.id, contractNumber: ownerPayload, contractDate: "2026-01-01",
      value: "1000", advancePayment: "300", advanceRecoveryEnabled: true,
      advanceRecoveryPercent: "50", advanceRecoveryStartProgressPercent: "0",
      retentionEnabled: true, retentionPercent: "10", retentionCapPercent: "5",
      vatPercent: "15", status: "active",
    }).returning().then((rows: any[]) => rows[0]);
    const ownerOne = await createContractIdempotently({
      companyId, userId: user.id, operation: "owner_contract_create", idempotencyKey: `${tag}-oc`,
      payloadHash: ownerPayload, create: ownerCreate,
    });
    const ownerTwo = await createContractIdempotently({
      companyId, userId: user.id, operation: "owner_contract_create", idempotencyKey: `${tag}-oc`,
      payloadHash: ownerPayload, create: ownerCreate,
    });
    assert.equal(ownerOne.row.id, ownerTwo.created ? ownerTwo.row.id : ownerTwo.result.id);
    const owner = ownerOne.row;

    const subPayload = `${tag}-sub`;
    const subCreate = (tx: any) => tx.insert(contractingSubContractsTable).values({
      companyId, projectId: project.id, contractorId: contractor.id,
      contractNumber: subPayload, contractDate: "2026-01-01", value: "700", status: "active",
    }).returning().then((rows: any[]) => rows[0]);
    const subOne = await createContractIdempotently({
      companyId, userId: user.id, operation: "subcontract_create", idempotencyKey: `${tag}-sc`,
      payloadHash: subPayload, create: subCreate,
    });
    const subTwo = await createContractIdempotently({
      companyId, userId: user.id, operation: "subcontract_create", idempotencyKey: `${tag}-sc`,
      payloadHash: subPayload, create: subCreate,
    });
    assert.equal(subOne.row.id, subTwo.created ? subTwo.row.id : subTwo.result.id);
    const sub = subOne.row;
    await db.insert(sequencesTable).values({
      companyId, code: `${tag}-bill-sequence`, nameAr: "مسلسل مستخلص الاختبار",
      prefix: "AUTO-", startNumber: 1, endNumber: 999, currentNumber: 1, padLength: 4,
      transactionTypes: ["contracting_bill"],
    });

    // Use the mounted production router, not a service shortcut: a retry after
    // a lost 201 response sends the same body + Idempotency-Key and gets the
    // same persisted bill id without a duplicate draft.
    const http = express();
    http.use(express.json());
    http.use("/contracting", contractingRouter);
    testServer = http.listen(0, "127.0.0.1");
    await once(testServer, "listening");
    const port = (testServer.address() as { port: number }).port;
    const endpoint = `http://127.0.0.1:${port}/contracting/projects/${project.id}/bills`;
    const draftKey = `${tag}-lost-response`;
    const draftPayload = {
      idempotencyKey: draftKey, billNumber: `${tag}-http-draft`, billDate: "2026-01-21",
      direction: "outgoing", ownerContractId: owner.id, grossAmount: "100", progressPercent: "10",
    };
    const postBill = () => fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tag}`,
        "content-type": "application/json",
        "idempotency-key": draftKey,
      },
      body: JSON.stringify(draftPayload),
    });
    const firstResponse = await postBill();
    assert.equal(firstResponse.status, 201);
    // Deliberately discard the successful response body: this models a client
    // whose request committed but whose network response was lost.
    await firstResponse.text();
    const [persistedBeforeRetry] = await db.select().from(contractingProgressBillsTable).where(and(
      eq(contractingProgressBillsTable.companyId, companyId),
      eq(contractingProgressBillsTable.billNumber, draftPayload.billNumber),
    ));
    assert.ok(persistedBeforeRetry);
    const replayResponse = await postBill();
    assert.equal(replayResponse.status, 200);
    const replayDraft = await replayResponse.json() as { id: number };
    assert.equal(replayDraft.id, persistedBeforeRetry.id);
    const persistedDrafts = await db.select().from(contractingProgressBillsTable).where(and(
      eq(contractingProgressBillsTable.companyId, companyId),
      eq(contractingProgressBillsTable.billNumber, draftPayload.billNumber),
    ));
    assert.equal(persistedDrafts.length, 1);
    // The no-number path must make the durable request claim before it allocates
    // a sequence value. A lost response retry returns the original AUTO number,
    // and deleting a draft cascades only its replay claim so the key is reusable.
    const autoKey = `${tag}-lost-auto`;
    const autoPayload = {
      idempotencyKey: autoKey, billDate: "2026-01-22", direction: "outgoing",
      ownerContractId: owner.id, grossAmount: "100", progressPercent: "10",
    };
    const postAutoBill = () => fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tag}`, "content-type": "application/json", "idempotency-key": autoKey,
      },
      body: JSON.stringify(autoPayload),
    });
    const autoFirst = await postAutoBill();
    assert.equal(autoFirst.status, 201);
    await autoFirst.text();
    const [persistedAuto] = await db.select().from(contractingProgressBillsTable).where(and(
      eq(contractingProgressBillsTable.companyId, companyId),
      eq(contractingProgressBillsTable.projectId, project.id),
      eq(contractingProgressBillsTable.billDate, "2026-01-22"),
    ));
    assert.match(persistedAuto.billNumber, /^AUTO-\d{4}$/);
    const autoReplay = await postAutoBill();
    assert.equal(autoReplay.status, 200);
    assert.equal((await autoReplay.json() as { id: number }).id, persistedAuto.id);
    await db.delete(contractingProgressBillsTable).where(eq(contractingProgressBillsTable.id, persistedAuto.id));
    const autoAfterDelete = await postAutoBill();
    assert.equal(autoAfterDelete.status, 201, "draft deletion cascades its operational idempotency claim");
    const recreatedAuto = await autoAfterDelete.json() as { id: number; billNumber: string };
    assert.notEqual(recreatedAuto.id, persistedAuto.id);
    assert.notEqual(recreatedAuto.billNumber, persistedAuto.billNumber);

    const [work] = await db.insert(contractingWorkItemsTable).values({
      companyId, projectId: project.id, nameAr: "خرسانة", unit: "m3", plannedQty: "100",
    }).returning();
    const [ownerBoq] = await db.insert(contractingContractBoqLinesTable).values({
      companyId, projectId: project.id, workItemId: work.id, direction: "owner",
      ownerContractId: owner.id, unit: "m3", quantity: "100", unitPrice: "10", totalAmount: "1000",
    }).returning();
    const [subBoq] = await db.insert(contractingContractBoqLinesTable).values({
      companyId, projectId: project.id, workItemId: work.id, direction: "subcontract",
      subcontractorContractId: sub.id, sourceOwnerLineId: ownerBoq.id,
      unit: "m3", quantity: "100", unitPrice: "7", totalAmount: "700",
    }).returning();
    assert.notEqual(String(ownerBoq.unitPrice), String(subBoq.unitPrice), "BOQ commercial prices are contract-specific");

    // The approved change order changes the owner ceiling from 1,000 to 1,200.
    const [changeOrder] = await db.insert(contractingOwnerContractsTable).values({
      companyId, projectId: project.id, contractNumber: `${tag}-co`, contractDate: "2026-01-15",
      contractType: "change_order", parentContractId: owner.id, value: "200", status: "approved",
    }).returning();
    assert.equal(changeOrder.status, "approved");

    const accountRows = await db.insert(accountsTable).values([
      ["AR", "asset"], ["RET", "asset"], ["REV", "revenue"], ["VAT", "liability"],
      ["ADV", "liability"], ["CASH", "asset"], ["WIP", "asset"], ["VATI", "asset"], ["AP", "liability"], ["ADD", "revenue"],
    ].map(([code, accountType]) => ({
      companyId, code: `${tag}-${code}`, nameAr: code, accountType: accountType as any, isPosting: true, level: 4,
    }))).returning();
    const accounts = Object.fromEntries(accountRows.map((row) => [row.nameAr, row.id]));
    await db.insert(accountingMappingsTable).values([
      ["contracting_outgoing_bill", "receivable", accounts.AR],
      ["contracting_outgoing_bill", "retention_receivable", accounts.RET],
      ["contracting_outgoing_bill", "revenue", accounts.REV],
      ["contracting_outgoing_bill", "vat_output", accounts.VAT],
      ["contracting_advance_receipt", "advance_liability", accounts.ADV],
      ["contracting_advance_application", "advance_liability", accounts.ADV],
      ["contracting_advance_application", "receivable", accounts.AR],
      ["contracting_incoming_bill", "wip", accounts.WIP],
      ["contracting_incoming_bill", "vat_input", accounts.VATI],
      ["contracting_incoming_bill", "payable", accounts.AP],
      ["contracting_outgoing_bill", "test_addition", accounts.ADD],
    ].map(([documentType, roleKey, accountId]) => ({ companyId, documentType: String(documentType), roleKey: String(roleKey), accountId: Number(accountId) })));
    const [cash] = await db.insert(cashBoxesTable).values({
      companyId, code: tag, nameAr: "خزنة الاختبار", accountId: accounts.CASH, isActive: true,
    }).returning();

    const advance = await createSettlement({
      companyId, projectId: project.id, ownerContractId: owner.id, kind: "advance_receipt",
      amount: 300, settlementDate: "2026-01-20", paymentType: "cash", cashBoxId: cash.id,
      idempotencyKey: `${tag}-advance`, userId: user.id, req,
    });
    assert.equal(advance.idempotentReplay, false);

    const insertBill = async (number: string, gross: string, qty: string, date: string) => {
      const [bill] = await db.insert(contractingProgressBillsTable).values({
        companyId, projectId: project.id, direction: "outgoing", ownerContractId: owner.id,
        billNumber: number, billDate: date, progressPercent: gross === "500" ? "41.67" : "83.33",
        grossAmount: gross, retentionEnabled: true, retentionPercent: "10", retentionCapPercent: "5",
        vatPercent: "15", advanceRecoveryEnabled: true, advanceRecoveryPercent: "50",
        advanceRecoveryStartProgressPercent: "0", status: "draft",
      }).returning();
      await db.insert(contractingBillLinesTable).values({
        companyId, projectId: project.id, billId: bill.id, workItemId: work.id, boqLineId: ownerBoq.id,
        currentQty: qty,
      });
      return bill;
    };
    const first = await insertBill(`${tag}-01`, "500", "50", "2026-02-01");
    const approvedOne = await approveBill({ companyId, billId: first.id, userId: user.id, req });
    assert.equal(String(approvedOne.previousPaid), "0.00");
    assert.equal(String(approvedOne.retentionAmount), "50.00", "first-period retention stays below the approved 5% cap");
    assert.equal(String(approvedOne.advanceRecoveryAmount), "250.00", "recovery uses a posted advance, not a requested advance");

    const second = await insertBill(`${tag}-02`, "1000", "50", "2026-03-01");
    const approvedTwo = await approveBill({ companyId, billId: second.id, userId: user.id, req });
    assert.equal(String(approvedTwo.previousPaid), "500.00");
    assert.equal(String(approvedTwo.retentionAmount), "10.00", "retention cap is cumulative: total is capped at 60 on the 1,200 adjusted contract");
    assert.equal(String(approvedTwo.advanceRecoveryAmount), "50.00", "recovery is capped by actual remaining advance");
    const [secondLine] = await db.select().from(contractingBillLinesTable).where(eq(contractingBillLinesTable.billId, second.id));
    assert.equal(String(secondLine.previousQty), "50.0000");
    assert.equal(String(secondLine.currentQty), "50.0000");
    assert.equal(String(secondLine.cumulativeQty), "100.0000");

    // A real partial payment followed by the balance then separate reversal
    // entries proves the projection follows posted settlement evidence.
    const partialInput = {
      companyId, projectId: project.id, billId: second.id, kind: "bill_receipt", amount: 200,
      settlementDate: "2026-03-05", paymentType: "cash", cashBoxId: cash.id,
      idempotencyKey: `${tag}-partial`, userId: user.id, req,
    } as const;
    const partialAttempts = await Promise.all([
      createSettlement(partialInput), createSettlement(partialInput),
    ]);
    assert.equal(partialAttempts.filter((row) => !row.idempotentReplay).length, 1);
    assert.equal(partialAttempts.filter((row) => row.idempotentReplay).length, 1);
    const partial = partialAttempts.find((row) => !row.idempotentReplay)!;
    let [afterPartial] = await db.select().from(contractingProgressBillsTable).where(eq(contractingProgressBillsTable.id, second.id));
    assert.equal(afterPartial.status, "partially_paid");
    const balance = Number(approvedTwo.netAmount) - Number(approvedTwo.advanceRecoveryAmount) - 200;
    const finalInput = {
      companyId, projectId: project.id, billId: second.id, kind: "bill_receipt", amount: balance,
      settlementDate: "2026-03-06", paymentType: "cash", cashBoxId: cash.id,
      idempotencyKey: `${tag}-final`, userId: user.id, req,
    } as const;
    const finalAttempts = await Promise.all([createSettlement(finalInput), createSettlement(finalInput)]);
    assert.equal(finalAttempts.filter((row) => !row.idempotentReplay).length, 1);
    assert.equal(finalAttempts.filter((row) => row.idempotentReplay).length, 1);
    const finalPayment = finalAttempts.find((row) => !row.idempotentReplay)!;
    let [afterFull] = await db.select().from(contractingProgressBillsTable).where(eq(contractingProgressBillsTable.id, second.id));
    assert.equal(afterFull.status, "paid");
    const reversedFinal = await reverseBillSettlement({ companyId, settlementId: Number(finalPayment.id), userId: user.id, req });
    assert.equal(reversedFinal.status, "reversed");
    await assertBalancedFlippedJournals(
      Number(finalPayment.journal_entry_id),
      Number(reversedFinal.reversal_journal_entry_id),
    );
    [afterPartial] = await db.select().from(contractingProgressBillsTable).where(eq(contractingProgressBillsTable.id, second.id));
    assert.equal(afterPartial.status, "partially_paid");
    await reverseBillSettlement({ companyId, settlementId: Number(partial.id), userId: user.id, req });
    const [afterAllReversed] = await db.select().from(contractingProgressBillsTable).where(eq(contractingProgressBillsTable.id, second.id));
    assert.equal(afterAllReversed.status, "partially_paid", "the 50 advance recovery remains a posted settlement");
    assert.equal(String(afterAllReversed.paidAmount), "50.00");

    // Incoming subcontractor path: approve/publish the liability, partially
    // pay it, pay in full, and reverse the full payment through the same
    // immutable settlement workflow.
    const [incoming] = await db.insert(contractingProgressBillsTable).values({
      companyId, projectId: project.id, direction: "incoming", contractorId: contractor.id,
      subcontractorContractId: sub.id, billNumber: `${tag}-sub-01`, billDate: "2026-03-10",
      progressPercent: "100", grossAmount: "700", retentionEnabled: false, retentionPercent: "0",
      vatPercent: "15", advanceRecoveryEnabled: false, status: "draft",
    }).returning();
    await db.insert(contractingBillLinesTable).values({
      companyId, projectId: project.id, billId: incoming.id, workItemId: work.id, boqLineId: subBoq.id,
      currentQty: "100",
    });
    const approvedIncoming = await approveBill({ companyId, billId: incoming.id, userId: user.id, req });
    assert.equal(approvedIncoming.status, "approved");
    assert.equal(String(approvedIncoming.netAmount), "805.00");
    await assertBalancedJournal(Number(approvedIncoming.journalEntryId));
    const [projectAfterIncoming] = await db.select().from(contractingProjectsTable)
      .where(eq(contractingProjectsTable.id, project.id));
    assert.equal(String(projectAfterIncoming.actualCost), "700.00", "incoming approval adds certified subcontract cost to the project");
    const incomingPartial = await createSettlement({
      companyId, projectId: project.id, billId: incoming.id, kind: "bill_payment", amount: 300,
      settlementDate: "2026-03-11", paymentType: "cash", cashBoxId: cash.id,
      idempotencyKey: `${tag}-sub-partial`, userId: user.id, req,
    });
    let [afterIncomingPartial] = await db.select().from(contractingProgressBillsTable)
      .where(eq(contractingProgressBillsTable.id, incoming.id));
    assert.equal(afterIncomingPartial.status, "partially_paid");
    const incomingFinal = await createSettlement({
      companyId, projectId: project.id, billId: incoming.id, kind: "bill_payment",
      amount: Number(approvedIncoming.netAmount) - 300, settlementDate: "2026-03-12",
      paymentType: "cash", cashBoxId: cash.id, idempotencyKey: `${tag}-sub-final`, userId: user.id, req,
    });
    let [afterIncomingFull] = await db.select().from(contractingProgressBillsTable)
      .where(eq(contractingProgressBillsTable.id, incoming.id));
    assert.equal(afterIncomingFull.status, "paid");
    const incomingReversals = await Promise.all([
      reverseBillSettlement({ companyId, settlementId: Number(incomingFinal.id), userId: user.id, req }),
      reverseBillSettlement({ companyId, settlementId: Number(incomingFinal.id), userId: user.id, req }),
    ]);
    assert.equal(incomingReversals.filter((row) => !row.idempotentReplay).length, 1, "concurrent duplicate reversals post one JE");
    assert.equal(incomingReversals.filter((row) => row.idempotentReplay).length, 1);
    const incomingReversal = incomingReversals.find((row) => !row.idempotentReplay)!;
    await assertBalancedFlippedJournals(
      Number(incomingFinal.journal_entry_id),
      Number(incomingReversal.reversal_journal_entry_id),
    );
    [afterIncomingPartial] = await db.select().from(contractingProgressBillsTable)
      .where(eq(contractingProgressBillsTable.id, incoming.id));
    assert.equal(afterIncomingPartial.status, "partially_paid");

    // Separate drafts race to certify 60 + 60 against a 100-unit BOQ. Contract
    // row locks serialize them; one succeeds, the retry becomes a clear 409.
    const [raceContract] = await db.insert(contractingOwnerContractsTable).values({
      companyId, projectId: project.id, contractNumber: `${tag}-race`, contractDate: "2026-04-01",
      value: "1000", retentionEnabled: false, vatPercent: "15", status: "active",
    }).returning();
    const [raceBoq] = await db.insert(contractingContractBoqLinesTable).values({
      companyId, projectId: project.id, workItemId: work.id, direction: "owner",
      ownerContractId: raceContract.id, unit: "m3", quantity: "100", unitPrice: "10", totalAmount: "1000",
    }).returning();
    // Same date avoids chronology itself becoming the loser reason; only the
    // shared 100-unit BOQ ceiling decides the concurrent outcome.
    const raceA = await insertBill(`${tag}-race-a`, "600", "60", "2026-04-10");
    const raceB = await insertBill(`${tag}-race-b`, "600", "60", "2026-04-10");
    await db.update(contractingProgressBillsTable).set({ ownerContractId: raceContract.id, retentionEnabled: false })
      .where(and(eq(contractingProgressBillsTable.id, raceA.id), eq(contractingProgressBillsTable.companyId, companyId)));
    await db.update(contractingProgressBillsTable).set({ ownerContractId: raceContract.id, retentionEnabled: false })
      .where(and(eq(contractingProgressBillsTable.id, raceB.id), eq(contractingProgressBillsTable.companyId, companyId)));
    await db.update(contractingBillLinesTable).set({ boqLineId: raceBoq.id })
      .where(and(eq(contractingBillLinesTable.billId, raceA.id), eq(contractingBillLinesTable.companyId, companyId)));
    await db.update(contractingBillLinesTable).set({ boqLineId: raceBoq.id })
      .where(and(eq(contractingBillLinesTable.billId, raceB.id), eq(contractingBillLinesTable.companyId, companyId)));
    const raced = await Promise.allSettled([
      approveBill({ companyId, billId: raceA.id, userId: user.id, req }),
      approveBill({ companyId, billId: raceB.id, userId: user.id, req }),
    ]);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = raced.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.equal((rejected.reason as any).status, 409);
    const retryId = raced[0].status === "rejected" ? raceA.id : raceB.id;
    const winnerId = retryId === raceA.id ? raceB.id : raceA.id;
    const [rejectedDraft] = await db.select().from(contractingProgressBillsTable).where(eq(
      contractingProgressBillsTable.id, retryId,
    ));
    assert.equal(rejectedDraft.journalEntryId, null, "rejected over-certification posts no bill journal");
    const rejectedArtifacts = await db.execute(sql`
      SELECT COUNT(*)::int AS count
        FROM contracting_accounting_audit
       WHERE company_id = ${companyId}
         AND bill_id = ${retryId}
    `);
    assert.equal(Number((rejectedArtifacts as any).rows[0].count), 0, "rejected over-certification leaves no accounting audit artifact");
    await db.update(contractingBillLinesTable).set({ currentQty: "40" })
      .where(and(eq(contractingBillLinesTable.billId, retryId), eq(contractingBillLinesTable.companyId, companyId)));
    await db.update(contractingProgressBillsTable).set({ grossAmount: "1000", billDate: "2026-04-11" })
      .where(and(eq(contractingProgressBillsTable.id, retryId), eq(contractingProgressBillsTable.companyId, companyId)));
    const retried = await approveBill({ companyId, billId: retryId, userId: user.id, req });
    assert.equal(retried.status, "approved");
    const raceLines = await db.select().from(contractingBillLinesTable).where(and(
      eq(contractingBillLinesTable.companyId, companyId),
      inArray(contractingBillLinesTable.billId, [winnerId, retryId]),
    ));
    const winnerLine = raceLines.find((line) => line.billId === winnerId)!;
    const retryLine = raceLines.find((line) => line.billId === retryId)!;
    assert.equal(String(winnerLine.currentQty), "60.0000");
    assert.equal(String(winnerLine.cumulativeQty), "60.0000");
    assert.equal(String(retryLine.previousQty), "60.0000");
    assert.equal(String(retryLine.currentQty), "40.0000");
    assert.equal(String(retryLine.cumulativeQty), "100.0000");
    assert.equal(
      Number(winnerLine.currentQty) + Number(retryLine.currentQty),
      100,
      "concurrent approval plus retry certifies exactly the 100-unit BOQ allocation",
    );
    const fullyPaidRaceId = winnerId;
    const [fullyPaidRace] = await db.select().from(contractingProgressBillsTable)
      .where(eq(contractingProgressBillsTable.id, fullyPaidRaceId));
    const singleFullPayment = await createSettlement({
      companyId, projectId: project.id, billId: fullyPaidRaceId, kind: "bill_receipt",
      amount: Number(fullyPaidRace.netAmount), settlementDate: "2026-04-12",
      paymentType: "cash", cashBoxId: cash.id, idempotencyKey: `${tag}-race-full`,
      userId: user.id, req,
    });
    await reverseBillSettlement({ companyId, settlementId: Number(singleFullPayment.id), userId: user.id, req });
    const [afterZeroPaymentReversal] = await db.select().from(contractingProgressBillsTable)
      .where(eq(contractingProgressBillsTable.id, fullyPaidRaceId));
    assert.equal(afterZeroPaymentReversal.status, "approved");
    assert.equal(String(afterZeroPaymentReversal.paidAmount), "0.00");
    const [correctionContract] = await db.insert(contractingOwnerContractsTable).values({
      companyId, projectId: project.id, contractNumber: `${tag}-correction`, contractDate: "2026-05-01",
      value: "100", advanceRecoveryEnabled: true, advanceRecoveryPercent: "50",
      advanceRecoveryStartProgressPercent: "0", retentionEnabled: false, vatPercent: "15", status: "active",
    }).returning();
    const [correctionBoq] = await db.insert(contractingContractBoqLinesTable).values({
      companyId, projectId: project.id, workItemId: work.id, direction: "owner",
      ownerContractId: correctionContract.id, unit: "m3", quantity: "10", unitPrice: "10", totalAmount: "100",
    }).returning();
    const [correctionSource] = await db.insert(contractingProgressBillsTable).values({
      companyId, projectId: project.id, direction: "outgoing", ownerContractId: correctionContract.id,
      billNumber: `${tag}-correction-source`, billDate: "2026-05-10", progressPercent: "100", grossAmount: "100",
      retentionEnabled: false, retentionPercent: "0", vatPercent: "15", advanceRecoveryEnabled: true,
      advanceRecoveryPercent: "50", advanceRecoveryStartProgressPercent: "0", status: "draft",
    }).returning();
    await db.insert(contractingBillLinesTable).values({
      companyId, projectId: project.id, billId: correctionSource.id, workItemId: work.id,
      boqLineId: correctionBoq.id, currentQty: "10",
    });
    await db.insert(contractingBillAdditionsTable).values({
      companyId, projectId: project.id, billId: correctionSource.id, additionKey: `${tag}-addition`,
      calculationType: "fixed", baseType: "gross", baseAmount: "100", amount: "20",
      reason: "إضافة اختبار", referenceType: "attachment", reference: "TEST-ADD",
      taxTreatment: "non_taxable_settlement_adjustment", accountMappingKey: "test_addition", createdByUserId: user.id,
    });
    const approvedCorrectionSource = await approveBill({
      companyId, billId: correctionSource.id, userId: user.id, req,
    });
    assert.equal(String(approvedCorrectionSource.advanceRecoveryPercent), "50.00");
    const correction = await createPostedCorrection({
      companyId, billId: correctionSource.id, userId: user.id, req,
    });
    assert.equal(correction.draft.correctionOfId, correctionSource.id);
    assert.equal(correction.draft.status, "draft");
    const [correctedSource] = await db.select().from(contractingProgressBillsTable)
      .where(eq(contractingProgressBillsTable.id, correctionSource.id));
    assert.equal(correctedSource.status, "reversed");
    await assertBalancedFlippedJournals(
      Number(approvedCorrectionSource.journalEntryId),
      Number(correction.reversalJournalEntryId),
    );
    const [copiedCorrectionLine] = await db.select().from(contractingBillLinesTable).where(eq(
      contractingBillLinesTable.billId, correction.draft.id,
    ));
    assert.equal(copiedCorrectionLine.boqLineId, correctionBoq.id);
    assert.equal(String(correction.draft.advanceRecoveryPercent), "50.00");
    assert.equal(correction.draft.advanceRecoveryEnabled, true);
    const copiedAdditions = await db.select().from(contractingBillAdditionsTable).where(eq(
      contractingBillAdditionsTable.billId, correction.draft.id,
    ));
    assert.equal(copiedAdditions.length, 1);
    assert.equal(String(copiedAdditions[0].amount), "20.00");
    const approvedReplacement = await approveBill({
      companyId, billId: correction.draft.id, userId: user.id, req,
    });
    assert.equal(approvedReplacement.status, "approved");
    await assertBalancedJournal(Number(approvedReplacement.journalEntryId));
    t.diagnostic("isolated lifecycle passed: real bill POST retry, both bill directions, balanced reversals, correction draft, recovery, cap, and concurrency.");
  } finally {
    if (testServer) await new Promise<void>((resolve, reject) =>
      testServer!.close((error) => error ? reject(error) : resolve()));
    if (externalContext) await externalContext.pool.end();
    if (externalDbName) {
      await pool.query(`DROP DATABASE IF EXISTS "${externalDbName}"`);
    }
    if (companyId) {
      // journal_entries deliberately has a restrictive company FK (it is
      // accounting evidence in normal tenants), so clear the disposable
      // settlement/audit references before the final tenant cleanup.
      await db.execute(sql`DELETE FROM contracting_accounting_audit WHERE company_id = ${companyId}`);
      await db.execute(sql`DELETE FROM contracting_accounting_settlements WHERE company_id = ${companyId}`);
      await db.delete(journalEntriesTable).where(eq(journalEntriesTable.companyId, companyId));
      await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
    }
    await pool.end();
  }
});