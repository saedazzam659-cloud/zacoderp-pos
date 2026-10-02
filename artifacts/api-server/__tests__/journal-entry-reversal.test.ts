import assert from "node:assert/strict";
import test from "node:test";
import { reverseJournalEntryLines } from "../src/lib/journalEntryReversal.js";

test("reverses debit and credit while preserving the line details", () => {
  const original = {
    id: 91,
    entryId: 14,
    accountId: 500,
    costCenter: "OPS",
    projectId: 22,
    debit: "125.50",
    credit: "0.00",
    description: "مصروف صيانة",
    supplierName: "مورد",
    supplierVatNumber: "300000000000003",
    supplierInvoiceNumber: "INV-14",
    supplierInvoiceDate: "2026-09-30",
    sortOrder: 3,
  };
  const originalSnapshot = { ...original };
  const reversed = reverseJournalEntryLines([original]);

  assert.deepEqual(original, originalSnapshot, "the source line is not mutated");
  assert.deepEqual(reversed, [{
    accountId: 500,
    costCenter: "OPS",
    projectId: 22,
    debit: "0.00",
    credit: "125.50",
    description: "مصروف صيانة",
    supplierName: "مورد",
    supplierVatNumber: "300000000000003",
    supplierInvoiceNumber: "INV-14",
    supplierInvoiceDate: "2026-09-30",
    sortOrder: 3,
  }]);
});