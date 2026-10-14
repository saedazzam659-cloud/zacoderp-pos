import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const generalSettings = readFileSync(
  new URL("../src/pages/GeneralSettings.tsx", import.meta.url),
  "utf8",
);
const salesForm = readFileSync(
  new URL("../src/pages/sales/SalesDocumentForm.tsx", import.meta.url),
  "utf8",
);

test("general settings assigns only the overdraft permission for the selected user", () => {
  assert.match(generalSettings, /permissions\.sales_invoice_overdraft = \{ \.\.\.existingGrant, view: enabled, edit: enabled \}/);
  assert.match(generalSettings, /fetch\(`\$\{API\}\/api\/users\/\$\{targetId\}`, \{\s*method: "PATCH"/);
  assert.match(generalSettings, /data-testid=\{`overdraft-user-\$\{candidate\.id\}`\}/);
  assert.match(generalSettings, /hasOverdraftGrant\(candidate\)/);
});

test("the selected user's new sales invoices default to overdraft while saved invoices keep their persisted choice", () => {
  assert.match(salesForm, /if \(isInvoice && isNew\) setAllowNegativeStock\(globalOverdraftEnabled && canEditOverdraft\)/);
  assert.match(salesForm, /if \(isInvoice\) setAllowNegativeStock\(!!existing\.allowNegativeStock\)/);
});
