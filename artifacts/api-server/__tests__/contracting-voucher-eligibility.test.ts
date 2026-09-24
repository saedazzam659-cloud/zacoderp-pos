import assert from "node:assert/strict";
import { test } from "node:test";
import { isPostableVoucherContractStatus } from "../src/lib/contracting-voucher-eligibility.ts";

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