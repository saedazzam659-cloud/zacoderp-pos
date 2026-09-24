import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Guard the two independently maintained settings surfaces against drift.
// No database/tenant mappings are created by this test.
const ui = readFileSync(new URL("../../zatca-invoicing/src/config/accountingMappings.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/routes/accounting-mappings.ts", import.meta.url), "utf8");
const expected: Record<string, string[]> = {
  contracting_advance_receipt: ["advance_liability"],
  contracting_advance_payment: ["advance_asset"],
  contracting_advance_application: ["advance_liability", "receivable", "payable", "advance_asset"],
  contracting_retention_receipt: ["retention_receivable"],
  contracting_retention_payment: ["retention_payable"],
  contracting_material_movement: ["inventory", "wip"],
  contracting_outgoing_bill: ["receivable", "retention_receivable", "revenue", "vat_output", "addition", "deduction", "deductions", "penalty", "penalties"],
  contracting_incoming_bill: ["wip", "vat_input", "payable", "retention_payable", "addition", "deduction", "deductions", "penalty", "penalties"],
};

test("every contracting journal mapping role is editable in UI and accepted by API", () => {
  for (const [documentType, roles] of Object.entries(expected)) {
    const uiSection = ui.match(new RegExp(`^    key: "${documentType}",([\\s\\S]*?)(?=^    key: "|^\\];)`, "m"))?.[1];
    const apiSection = api.match(new RegExp(`^  ${documentType}: \\[([^\\]]+)\\]`, "m"))?.[1];
    assert.ok(uiSection, `UI missing ${documentType}`);
    assert.ok(apiSection, `API missing ${documentType}`);
    const uiRoles = [...uiSection.matchAll(/^      \{ key: "([^"]+)"/gm)].map((match) => match[1]);
    const apiRoles = [...apiSection.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(uiRoles.sort(), roles.slice().sort(), `${documentType} UI roles`);
    assert.deepEqual(apiRoles.sort(), roles.slice().sort(), `${documentType} API roles`);
  }
});