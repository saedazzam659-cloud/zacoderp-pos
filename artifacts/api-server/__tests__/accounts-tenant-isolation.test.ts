import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const apiSource = readFileSync(
  new URL("../src/routes/accounts.ts", import.meta.url),
  "utf8",
);
const pageSource = readFileSync(
  new URL("../../zatca-invoicing/src/pages/accounting/ChartOfAccounts.tsx", import.meta.url),
  "utf8",
);
const treeHookSource = readFileSync(
  new URL("../../zatca-invoicing/src/hooks/useAccountTree.ts", import.meta.url),
  "utf8",
);
const importPanelSource = readFileSync(
  new URL("../../zatca-invoicing/src/components/AccountsImportPanel.tsx", import.meta.url),
  "utf8",
);

test("accounts list and detail fail closed without a resolved company", () => {
  assert.match(apiSource, /يجب تحديد الشركة لعرض شجرة الحسابات/);
  assert.match(apiSource, /يجب تحديد الشركة لعرض الحساب/);
  assert.doesNotMatch(
    apiSource,
    /:\s*await db\.select\(\)\.from\(accountsTable\)\.orderBy/,
  );
});

test("account reads and relationships stay company-scoped", () => {
  assert.match(
    apiSource,
    /eq\(accountsTable\.id, id\), eq\(accountsTable\.companyId, cid\)/,
  );
  assert.match(
    apiSource,
    /eq\(accountsTable\.id, parentId\), eq\(accountsTable\.companyId, cid\)/,
  );
  assert.match(
    apiSource,
    /eq\(costCentersTable\.id, costCenterId\), eq\(costCentersTable\.companyId, cid\)/,
  );
});

test("SuperAdmin account UI scopes requests and caches to the acting company", () => {
  for (const source of [pageSource, treeHookSource]) {
    assert.match(source, /actingCompanyId/);
    assert.match(source, /x-acting-company-id/);
    assert.match(source, /queryKey: \["accounts", cid\]/);
  }
  assert.match(importPanelSource, /x-acting-company-id/);
});