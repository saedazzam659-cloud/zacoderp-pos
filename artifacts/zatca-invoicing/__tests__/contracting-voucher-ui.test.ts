import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const receipt = src("pages/cash/ReceiptVoucherFormMulti.tsx");
const payment = src("pages/cash/PaymentVoucherFormMulti.tsx");
const picker = src("components/VoucherContractingAllocation.tsx");
const panel = src("components/ContractingAccountingPanel.tsx");

test("contracting lines remain optional and are saved through the existing multiline voucher endpoints", () => {
  for (const [form, direction] of [[receipt, "receipt"], [payment, "payment"]] as const) {
    assert.match(form, /contractingAllocation: null/);
    assert.match(form, /contractingAllocation: l\.contractingAllocation|contractingAllocation: ln\.contractingAllocation/);
    assert.match(form, /l\.contractingAllocation \? null : l\.accountId/);
    assert.match(form, /\.\.\.\(l\.contractingAllocation \? \{ contractingAllocation: l\.contractingAllocation \} : \{\}\)/);
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
  assert.match(picker, /contractId: 0/);
  assert.match(picker, /paidAmount/);
});

test("contracting panel opens an unsaved voucher separately from legacy direct settlements", () => {
  assert.match(panel, /navigate\(`\/cash\/\$\{receipt \? "receipt" : "payment"\}-vouchers\/multi\/new\?\$\{query\}`\)/);
  assert.match(panel, /source_voucher_type/);
  assert.match(panel, /source_voucher_id/);
  assert.match(panel, /ترحيل مباشر/);
  assert.match(panel, /saveSettlement\(\)/);
});