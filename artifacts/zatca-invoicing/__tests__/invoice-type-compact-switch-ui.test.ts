import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const form = readFileSync(
  new URL("../src/pages/sales/SalesDocumentForm.tsx", import.meta.url),
  "utf8",
);

test("sales invoice type choices live in the compact header instead of the large panel", () => {
  const switchIndex = form.indexOf('data-testid="invoice-type-compact-switch"');
  const navigatorIndex = form.indexOf("<DocNavigator", switchIndex);

  assert.notEqual(switchIndex, -1);
  assert.ok(navigatorIndex > switchIndex, "compact choices should sit in the invoice header");
  assert.equal((form.match(/data-testid="invoice-type-standard"/g) ?? []).length, 1);
  assert.equal((form.match(/data-testid="invoice-type-simplified"/g) ?? []).length, 1);
  assert.ok(!form.includes("rounded-2xl border-2 border-primary/20 bg-gradient-to-br"));
});

test("compact invoice type buttons preserve the existing selection behavior", () => {
  assert.ok(
    form.includes('onClick={() => { setInvoiceType("standard"); invoiceTypeUserPickedRef.current = true; }}'),
  );
  assert.ok(
    form.includes('onClick={() => { setInvoiceType("simplified"); invoiceTypeUserPickedRef.current = true; }}'),
  );
  assert.match(form, /aria-pressed=\{isStd\}/);
  assert.match(form, /aria-pressed=\{isSimp\}/);
});