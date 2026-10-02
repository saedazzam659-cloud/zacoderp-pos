import test from "node:test";
import assert from "node:assert/strict";
import { assessSalesReturnRestoreSnapshot } from "../src/lib/deletedRecordRestorePolicy.js";

const completeDraftReturn = () => ({
  id: 41,
  companyId: 7,
  recordId: 41,
  tableName: "sales_returns",
  payload: {
    id: 41,
    companyId: 7,
    status: "draft",
    returnDate: "2026-09-13",
    zatcaStatus: "pending",
    lines: [{ id: 91, itemName: "صنف تجريبي", qty: "1.0000", unitPrice: "12.00" }],
  },
});

test("complete draft sales return with lines is eligible", () => {
  assert.deepEqual(assessSalesReturnRestoreSnapshot(completeDraftReturn()), {
    allowed: true,
    reason: null,
    lineCount: 1,
  });
});

test("header-only sales return snapshot is rejected", () => {
  const snap: any = completeDraftReturn();
  delete snap.payload.lines;
  assert.equal(assessSalesReturnRestoreSnapshot(snap).reason, "missing_return_lines");
});

test("posted, ZATCA-linked, or mismatched return snapshots are rejected", () => {
  const posted = completeDraftReturn();
  posted.payload.status = "posted";
  assert.equal(assessSalesReturnRestoreSnapshot(posted).reason, "not_draft");

  const zatca = completeDraftReturn();
  zatca.payload.invoiceHash = "signed-hash";
  assert.equal(assessSalesReturnRestoreSnapshot(zatca).reason, "zatca_artifacts");

  const wrongCompany = completeDraftReturn();
  wrongCompany.payload.companyId = 8;
  assert.equal(assessSalesReturnRestoreSnapshot(wrongCompany).reason, "company_id_mismatch");
});

test("sales return snapshot with an unnamed line is rejected", () => {
  const snap = completeDraftReturn();
  snap.payload.lines = [{ itemName: "  " }];
  assert.equal(assessSalesReturnRestoreSnapshot(snap).reason, "incomplete_return_lines");
});