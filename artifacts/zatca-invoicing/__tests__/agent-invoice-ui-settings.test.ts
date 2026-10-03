import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AGENT_UI_SETTINGS,
  normalizeAgentUiSettings,
} from "../src/lib/agentUiSettings";

test("compact invoice type selector is disabled for existing and new agents by default", () => {
  assert.equal(DEFAULT_AGENT_UI_SETTINGS.compactInvoiceTypeSelector, false);
  assert.equal(normalizeAgentUiSettings(null).compactInvoiceTypeSelector, false);
  assert.equal(normalizeAgentUiSettings({}).compactInvoiceTypeSelector, false);
});

test("compact invoice type selector accepts only an explicit true setting", () => {
  assert.equal(normalizeAgentUiSettings({ compactInvoiceTypeSelector: true }).compactInvoiceTypeSelector, true);
  assert.equal(normalizeAgentUiSettings({ compactInvoiceTypeSelector: "true" }).compactInvoiceTypeSelector, false);
});