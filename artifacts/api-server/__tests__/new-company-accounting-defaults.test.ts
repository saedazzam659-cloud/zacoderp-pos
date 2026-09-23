import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAPPINGS } from "../src/lib/accountingMappings.js";
import { DEFAULT_CHART_OF_ACCOUNTS } from "../src/lib/defaultChartOfAccounts.js";
import {
  NEW_COMPANY_MAPPING_ACCOUNTS,
  NEW_COMPANY_MAPPING_CODE_CORRECTIONS,
  pendingNewCompanyMappingCorrections,
  unresolvedNewCompanyMappingDefaults,
} from "../src/lib/newCompanyAccountingDefaults.js";

test("new-company account additions complete every canonical default code", () => {
  const chartCodes = new Set([
    ...DEFAULT_CHART_OF_ACCOUNTS.map((row) => row.code),
    ...NEW_COMPANY_MAPPING_ACCOUNTS.map((row) => row.code),
  ]);
  const missing = [...new Set([
    ...DEFAULT_MAPPINGS.map((row) => row.accountCode),
    ...NEW_COMPANY_MAPPING_CODE_CORRECTIONS.map((row) => row.accountCode),
  ])]
    .filter((code) => !chartCodes.has(code)).sort();
  assert.deepEqual(missing, []);
  assert.equal(NEW_COMPANY_MAPPING_ACCOUNTS.length, 7);
  assert.equal(NEW_COMPANY_MAPPING_ACCOUNTS.find((a) => a.code === "4104")?.parentCode, "41");
  assert.equal(NEW_COMPANY_MAPPING_ACCOUNTS.find((a) => a.code === "5504")?.parentCode, "55");
  assert.equal(
    NEW_COMPANY_MAPPING_CODE_CORRECTIONS.find((m) => m.roleKey === "inventory_destination")?.accountCode,
    "11051",
  );
  assert.equal(
    NEW_COMPANY_MAPPING_CODE_CORRECTIONS.find((m) => m.documentType === "letter_of_credit" && m.roleKey === "bank")?.accountCode,
    "11021",
  );
});

test("industry-specific mapping counts as resolved without replacing its code", () => {
  const defaults = [
    { documentType: "sales_invoice", roleKey: "revenue", accountCode: "4101" },
    { documentType: "letter_of_credit", roleKey: "lc_margin", accountCode: "1150" },
  ];
  const industry = [
    { documentType: "sales_invoice", roleKey: "revenue", accountId: 42 },
    { documentType: "letter_of_credit", roleKey: "lc_margin", accountId: 43 },
  ];
  assert.deepEqual(unresolvedNewCompanyMappingDefaults(defaults, industry, new Set([42, 43])), []);
  assert.deepEqual(defaults[0].accountCode, "4101");
});

test("existing industry mappings including deliberate blanks are isolated from corrections", () => {
  const corrections = pendingNewCompanyMappingCorrections([
    { documentType: "warehouse_transfer", roleKey: "inventory_destination", accountId: 123 },
    { documentType: "letter_of_credit", roleKey: "bank", accountId: null },
  ]);
  assert.deepEqual(corrections, [
    { documentType: "letter_of_credit", roleKey: "inventory", accountCode: "11051" },
  ]);
});

test("missing, blank and foreign-company mapping targets remain unresolved", () => {
  const defaults = [
    { documentType: "a", roleKey: "missing", accountCode: "1150" },
    { documentType: "a", roleKey: "blank", accountCode: "4104" },
    { documentType: "a", roleKey: "foreign", accountCode: "5504" },
    { documentType: "a", roleKey: "valid", accountCode: "11051" },
  ];
  const mappings = [
    { documentType: "a", roleKey: "blank", accountId: null },
    { documentType: "a", roleKey: "foreign", accountId: 100 },
    { documentType: "a", roleKey: "valid", accountId: 10 },
  ];
  assert.deepEqual(
    unresolvedNewCompanyMappingDefaults(defaults, mappings, new Set([10])),
    defaults.slice(0, 3),
  );
});