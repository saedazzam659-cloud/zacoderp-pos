import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const receipt = src("pages/cash/ReceiptVoucherFormMulti.tsx");
const payment = src("pages/cash/PaymentVoucherFormMulti.tsx");
const picker = src("components/VoucherContractingAllocation.tsx");
const panel = src("components/ContractingAccountingPanel.tsx");
const contractors = src("pages/ContractingContractors.tsx");
const project = src("pages/ContractingProjectDetail.tsx");

test("contracting lines remain optional and are saved through the existing multiline voucher endpoints", () => {
  for (const [form, direction] of [[receipt, "receipt"], [payment, "payment"]] as const) {
    assert.match(form, /contractingAllocation: null/);
    assert.match(form, /contractingAllocation: l\.contractingAllocation|contractingAllocation: ln\.contractingAllocation/);
    assert.match(form, /l\.contractingAllocation \? null : l\.accountId/);
    // Disabled contracting explicitly clears the allocation in the payload, rather than omitting the key.
    assert.match(form, /contractingAllocation: contractingEnabled \? l\.contractingAllocation : null/);
    assert.match(form, new RegExp(`\\$\\{API\\}/api/${direction}-vouchers`));
    assert.match(form, /Number\(form\.exchangeRate\) !== 1/);
    assert.match(form, /isLockedSourceEntry/);
  }
});

test("picker scopes options to company and party, cascades bill to contract, shows remaining", () => {
  assert.match(picker, /contracting-options\?\$\{query\}/);
  assert.match(picker, /companyId: String\(user!\.companyId\), entityId/);
  assert.match(picker, /Number\(row\.projectId\) === projectId/);
  assert.match(picker, /Number\(row\.contractId \?\? row\.ownerContractId \?\? row\.subcontractorContractId\) === contractId/);
  // Auto-select only an unambiguous contract; otherwise leave it at 0 for deliberate selection.
  assert.match(picker, /contractId: contract\?\.id \?\? 0/);
  assert.match(picker, /paidAmount/);
});

test("contracting panel opens an unsaved voucher separately from legacy direct settlements", () => {
  assert.match(panel, /navigate\(`\/cash\/\$\{direction\}-vouchers\/multi\/new\?\$\{query\}`\)/);
  assert.match(panel, /contract\.customerId \?\? options\.projectCustomerId \?\? null/);
  assert.match(panel, /data\.contracts\?\.find/);
  assert.match(panel, /amount: requested\.toFixed\(2\)/);
  assert.match(panel, /source_voucher_type/);
  assert.match(panel, /source_voucher_id/);
  assert.match(panel, /ترحيل مباشر/);
  assert.match(panel, /saveSettlement\(\)/);
});

test("contractor selector uses linked contracting records and offers an explicit supplier link", () => {
  assert.match(project, /api\/contracting\/contractors/);
  assert.match(project, /contractors\.map\(c => \(\{ value: String\(c\.id\)/);
  assert.match(contractors, /api\/suppliers/);
  assert.match(contractors, /supplierId: value === "none" \? null : Number\(value\)/);
  assert.match(contractors, /سجل المورد وحده لا يظهر هنا/);
});