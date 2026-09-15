import test from "node:test";
import assert from "node:assert/strict";

import {
  reportBillIsCertified,
  reportOwnerContractScope,
  type ReportOwnerContract,
} from "../src/lib/contracting-report-math.ts";

const contracts: ReportOwnerContract[] = [
  { id: 10, projectId: 4, contractType: "main", parentContractId: null, status: "active", value: "1000" },
  { id: 11, projectId: 4, contractType: "change_order", parentContractId: 10, status: "approved", value: "125" },
  { id: 12, projectId: 4, contractType: "change_order", parentContractId: 10, status: "active", value: "999" },
  { id: 20, projectId: 4, contractType: "main", parentContractId: null, status: "active", value: "2000" },
  { id: 21, projectId: 4, contractType: "addendum", parentContractId: 20, status: "approved", value: "250" },
];

test("report certification excludes reversals, drafts, and non-certified workflow states", () => {
  assert.equal(reportBillIsCertified("paid"), true);
  assert.equal(reportBillIsCertified("approved", 9001), false);
  assert.equal(reportBillIsCertified("reversed"), false);
  assert.equal(reportBillIsCertified("draft"), false);
  assert.equal(reportBillIsCertified("cancelled"), false);
});

test("outgoing report contract scope uses exact base and approved children once", () => {
  assert.deepEqual(reportOwnerContractScope(contracts, 10, 9999), {
    baseContractId: 10,
    value: 1125,
  });
  assert.deepEqual(reportOwnerContractScope(contracts, 11, 9999), {
    baseContractId: 10,
    value: 1125,
  });
  assert.deepEqual(reportOwnerContractScope(contracts, 20, 9999), {
    baseContractId: 20,
    value: 2250,
  });
});