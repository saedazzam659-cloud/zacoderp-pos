import assert from "node:assert/strict";
import { test } from "node:test";
import { eligibleParties, eligibleContractors, withHistoricalParty } from "../src/lib/partyEligibility";

const customers = [
  { id: 1, partyClassification: "customer" },
  { id: 2, partyClassification: "project_owner" },
  { id: 3, partyClassification: "both" },
  { id: 4, partyClassification: null },
  { id: 5 },
];
const suppliers = [
  { id: 1, partyClassification: "supplier" },
  { id: 2, partyClassification: "subcontractor" },
  { id: 3, partyClassification: "both" },
  { id: 4, partyClassification: null },
];
const ids = (rows: { id: number }[]) => rows.map(row => row.id);

test("legacy customers stay sales-only, while a selected old owner reference remains", () => {
  assert.deepEqual(ids(eligibleParties(customers, "sales")), [1, 3, 4, 5]);
  assert.deepEqual(ids(eligibleParties(customers, "projectOwner")), [2, 3]);
  assert.deepEqual(ids(eligibleParties(customers, "sales", 2)), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids(eligibleParties(customers, "projectOwner", 4)), [2, 3, 4]);
});

test("purchase and subcontractor choices differ without duplicating selected rows", () => {
  assert.deepEqual(ids(eligibleParties(suppliers, "purchase")), [1, 3, 4]);
  assert.deepEqual(ids(eligibleParties(suppliers, "subcontractor")), [2, 3]);
  assert.deepEqual(ids(eligibleParties(suppliers, "subcontractor", 1)), [1, 2, 3]);
  assert.deepEqual(ids(eligibleParties([...suppliers, suppliers[0]], "purchase", 1)), [1, 3, 4]);
});

test("linked supplier classification filters contractor choices but preserves contractor IDs", () => {
  const contractors = [
    { id: 11, supplierPartyClassification: "supplier" },
    { id: 12, supplierPartyClassification: "subcontractor" },
    { id: 13, supplierPartyClassification: null },
  ];
  assert.deepEqual(ids(eligibleContractors(contractors)), [12]);
  assert.deepEqual(ids(eligibleContractors(contractors, 11)), [11, 12]);
  assert.deepEqual(ids(eligibleContractors(contractors, 13)), [12, 13]);
});

test("unloaded persisted selection gets a single fallback choice", () => {
  const choices = [{ value: "1", label: "One" }];
  assert.deepEqual(withHistoricalParty(choices, 9, "Previous"), [
    { value: "9", label: "Previous" }, ...choices,
  ]);
  assert.deepEqual(withHistoricalParty(choices, 1, "Previous"), choices);
});