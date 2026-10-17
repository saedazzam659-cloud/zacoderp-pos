import { test } from "node:test";
import assert from "node:assert/strict";
import { newCompanySequenceGroups } from "../src/lib/newCompanyDefaults.ts";

test("fresh-company customer credit and supplier debit notes get separate sequences", () => {
  const accountNoteGroups = newCompanySequenceGroups().filter((group) =>
    group.some((type) => type === "account_note_customer_credit" || type === "account_note_supplier_debit"),
  );

  assert.deepEqual(accountNoteGroups, [
    ["account_note_customer_credit"],
    ["account_note_supplier_debit"],
  ]);
});
