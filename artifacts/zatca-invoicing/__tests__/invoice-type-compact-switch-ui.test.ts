import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const form = readFileSync(
  new URL("../src/pages/sales/SalesDocumentForm.tsx", import.meta.url),
  "utf8",
);
const agentSettings = readFileSync(
  new URL("../src/pages/admin/AgentServers.tsx", import.meta.url),
  "utf8",
);

test("compact invoice type choices are available only behind the per-agent setting", () => {
  const switchIndex = form.indexOf('data-testid="invoice-type-compact-switch"');
  const navigatorIndex = form.indexOf("<DocNavigator", switchIndex);

  assert.notEqual(switchIndex, -1);
  assert.ok(navigatorIndex > switchIndex, "compact choices should sit in the invoice header");
  assert.match(form, /isInvoice && compactInvoiceTypeSelector && \(\(\) => \{/);
  assert.match(form, /!compactInvoiceTypeSelector && isInvoice && \(\(\) => \{/);
  assert.equal((form.match(/data-testid="invoice-type-compact-standard"/g) ?? []).length, 1);
  assert.equal((form.match(/data-testid="invoice-type-compact-simplified"/g) ?? []).length, 1);
  assert.equal((form.match(/data-testid="invoice-type-standard"/g) ?? []).length, 1);
  assert.equal((form.match(/data-testid="invoice-type-simplified"/g) ?? []).length, 1);
  assert.ok(form.includes("rounded-2xl border-2 border-primary/20 bg-gradient-to-br"));
  assert.ok(agentSettings.includes('data-testid="checkbox-agent-compact-invoice-type-selector"'));
  assert.ok(agentSettings.includes("compactInvoiceTypeSelector: event.target.checked"));
});

test("both layouts preserve invoice type selection and manual-pick behavior", () => {
  assert.equal(
    (form.match(/onClick=\{\(\) => \{ setInvoiceType\("standard"\); invoiceTypeUserPickedRef\.current = true; \}\}/g) ?? []).length,
    2,
  );
  assert.equal(
    (form.match(/onClick=\{\(\) => \{ setInvoiceType\("simplified"\); invoiceTypeUserPickedRef\.current = true; \}\}/g) ?? []).length,
    2,
  );
  assert.match(form, /aria-pressed=\{isStd\}/);
  assert.match(form, /aria-pressed=\{isSimp\}/);
});