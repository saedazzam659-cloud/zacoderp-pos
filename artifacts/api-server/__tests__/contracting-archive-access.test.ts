import assert from "node:assert/strict";
import test from "node:test";
import {
  ContractingArchiveAccessError,
  parseContractingArchiveRef,
} from "../src/lib/contracting-archive-access.js";

test("contracting archive parser accepts only canonical entity keys", () => {
  assert.deepEqual(parseContractingArchiveRef("contracting_projects", "project:42"), {
    screenKey: "contracting_projects",
    entityId: 42,
  });
  assert.deepEqual(parseContractingArchiveRef("contracting_owner_contracts", "owner-contract:7"), {
    screenKey: "contracting_owner_contracts",
    entityId: 7,
  });
  assert.deepEqual(parseContractingArchiveRef("contracting_subcontracts", "subcontract:8"), {
    screenKey: "contracting_subcontracts",
    entityId: 8,
  });
  assert.deepEqual(parseContractingArchiveRef("contracting_boq_lines", "boq-line:9"), {
    screenKey: "contracting_boq_lines",
    entityId: 9,
  });
  assert.deepEqual(parseContractingArchiveRef("contracting_work_items", "work-item:10"), {
    screenKey: "contracting_work_items",
    entityId: 10,
  });
  assert.deepEqual(parseContractingArchiveRef("contracting_tenders", "tender:11"), {
    screenKey: "contracting_tenders",
    entityId: 11,
  });
  assert.deepEqual(parseContractingArchiveRef("contracting_guarantees", "guarantee:12"), {
    screenKey: "contracting_guarantees",
    entityId: 12,
  });
});

test("contracting archive parser rejects arbitrary and unsupported identifiers", () => {
  const invalid = [
    ["contracting_projects", "42"],
    ["contracting_projects", "project:0"],
    ["contracting_projects", "project:-1"],
    ["contracting_projects", "project:1/path"],
    ["contracting_owner_contracts", "project:1"],
    ["contracting_tenders", "guarantee:1"],
    ["contracting_unknown", "unknown:1"],
  ] as const;
  for (const [screenKey, docKey] of invalid) {
    assert.throws(
      () => parseContractingArchiveRef(screenKey, docKey),
      ContractingArchiveAccessError,
    );
  }
  assert.equal(parseContractingArchiveRef("sales_invoices", "INV-1"), null);
});