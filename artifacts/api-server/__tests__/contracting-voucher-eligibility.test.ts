import assert from "node:assert/strict";
import { test } from "node:test";
import { isPostableVoucherContractStatus } from "../src/lib/contracting-voucher-eligibility.ts";
import { parseContractingAllocation, retentionRemainingCents } from "../src/lib/contracting-voucher-service.ts";
import { postVoucherSettlements } from "../src/lib/contracting-voucher-service.ts";
import { PgDialect } from "drizzle-orm/pg-core";

test("voucher contract eligibility follows the canonical approval status, not legacy activity", () => {
  // Creation persists draft; both main-contract approval and change-order decisions
  // persist approved. Neither legacy active nor completed proves approval.
  for (const [status, eligible] of [
    ["approved", true],
    ["draft", false],
    ["active", false],
    ["completed", false],
    ["rejected", false],
    [null, false],
  ] as const) {
    assert.equal(isPostableVoucherContractStatus(status), eligible, `status ${status}`);
  }
});

test("retention releases require an explicit certificate and the correct voucher direction", () => {
  for (const [kind, voucher, opposite] of [
    ["owner_retention_release", "receipt", "payment"],
    ["subcontract_retention_release", "payment", "receipt"],
  ] as const) {
    const allocation = { kind, projectId: 3, contractId: 4, billId: 5 };
    assert.deepEqual(parseContractingAllocation(allocation, voucher), allocation);
    assert.throws(() => parseContractingAllocation({ ...allocation, billId: null }, voucher), /billId/);
    assert.throws(() => parseContractingAllocation(allocation, opposite), /نوع السند/);
  }
  assert.equal(retentionRemainingCents("100.01", "70.00"), 3001n);
  assert.equal(retentionRemainingCents("100.01", "100.02"), -1n);
});

test("voucher retention lines consume the posted certificate retention, not its paid net", async () => {
  const dialect = new PgDialect();
  for (const [voucher, kind, settlement] of [
    ["receipt", "owner_retention_release", "retention_receipt"],
    ["payment", "subcontract_retention_release", "retention_payment"],
  ] as const) {
    const posted: Array<{ lineId: number; amount: string }> = [];
    let certificateJournalStatus = "posted";
    let contractParty = 6;
    const tx = {
      execute: async (statement: any) => {
        const { sql: text, params } = dialect.sqlToQuery(statement);
        if (text.includes("INSERT INTO contracting_accounting_settlements")) {
          assert.ok(params.includes(settlement));
          assert.ok(params.includes(77), "release shares the existing voucher journal");
          posted.push({ lineId: Number(params[15]), amount: String(params[7]) });
          return [];
        }
        if (text.includes("FROM journal_entries")) return [{ status: "posted" }];
        if (text.includes("FROM cash_boxes")) return [{ branch_id: null }];
        if (text.includes("FROM contracting_projects")) return [{ branch_id: null }];
        if (text.includes("FROM contracting_owner_contracts") || text.includes("FROM contracting_sub_contracts")) {
          return text.includes("FOR UPDATE") ? [{ id: 4 }] : [{ id: 4, party_id: contractParty, status: "approved" }];
        }
        if (text.includes("FROM contracting_progress_bills")) {
          return text.includes("FOR UPDATE") ? [{ id: 5 }] :
            text.includes("LEFT JOIN journal_entries") ?
              [{ id: 5, status: "paid", journal_status: certificateJournalStatus }] :
              [{ retention_amount: "100.00", net_amount: "0.00" }];
        }
        if (text.includes("FROM accounting_mappings")) return [{ id: 8 }];
        if (text.includes("source_voucher_line_id") && text.includes("FROM contracting_accounting_settlements"))
          return posted.filter((p) => p.lineId === Number(params[2]))
            .map((p) => ({ journal_entry_id: 77, amount: p.amount, kind: settlement, project_id: 3,
              bill_id: 5, owner_contract_id: voucher === "receipt" ? 4 : null,
              subcontractor_contract_id: voucher === "payment" ? 4 : null }));
        if (text.includes("SUM(amount)") && text.includes("FROM contracting_accounting_settlements"))
          return [{ amount: posted.reduce((sum, p) => sum + Number(p.amount), 0).toFixed(2) }];
        throw new Error(`unexpected SQL: ${text}`);
      },
    };
    const line = (id: number, amount: string) => ({
      id, amount, accountId: 8, contractingKind: kind,
      contractingProjectId: 3, contractingContractId: 4, contractingBillId: 5,
    });
    const header = { id: 10, entityId: 6, exchangeRate: 1, paymentType: "cash",
      cashBoxId: 9, date: "2026-01-01" };
    const post = (lines: ReturnType<typeof line>[]) =>
      postVoucherSettlements(tx, 1, voucher, header, lines, 77, { authUser: { id: null, viewAllBranches: true } });
    await post([line(1, "30.01"), line(2, "69.99")]);
    assert.equal(posted.length, 2);
    await post([line(1, "30.01")]);
    assert.equal(posted.length, 2, "same source line is idempotent");
    await assert.rejects(post([line(3, "0.01")]), /الرصيد المتبقي/);
    certificateJournalStatus = "draft";
    await assert.rejects(post([line(4, "1.00")]), /المستخلص غير معتمد/);
    certificateJournalStatus = "posted";
    contractParty = 99;
    await assert.rejects(post([line(4, "1.00")]), /العقد لا يرتبط بالطرف/);
  }
});