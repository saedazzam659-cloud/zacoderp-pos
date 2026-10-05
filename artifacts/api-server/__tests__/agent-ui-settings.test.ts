import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeAgentUiSettings } from "../src/lib/agentUiSettings.js";
import { resolvedAgentBranding } from "../src/lib/agentPublicBranding.js";

test("public agent UI settings keep the compact invoice selector disabled by default", () => {
  assert.equal(sanitizeAgentUiSettings(null).compactInvoiceTypeSelector, false);
  assert.equal(sanitizeAgentUiSettings({}).compactInvoiceTypeSelector, false);
  assert.equal(sanitizeAgentUiSettings(null).colorfulInvoiceTabs, false);
  assert.equal(sanitizeAgentUiSettings({}).colorfulInvoiceTabs, false);
  assert.deepEqual(sanitizeAgentUiSettings({}).moduleScreensAsTiles, []);
});

test("public agent UI settings accept the additional module tile hubs only when selected", () => {
  assert.deepEqual(
    sanitizeAgentUiSettings({
      moduleScreensAsTiles: [
        "simpleManufacturing",
        "contracting",
        "school",
        "school",
        "unknown",
      ],
    }).moduleScreensAsTiles,
    ["simpleManufacturing", "contracting", "school"],
  );
});

test("public agent UI settings expose compact invoice selector only when explicitly enabled", () => {
  assert.equal(
    sanitizeAgentUiSettings({ compactInvoiceTypeSelector: true }).compactInvoiceTypeSelector,
    true,
  );
  assert.equal(
    sanitizeAgentUiSettings({ compactInvoiceTypeSelector: 1 }).compactInvoiceTypeSelector,
    false,
  );
  assert.equal(sanitizeAgentUiSettings({ colorfulInvoiceTabs: true }).colorfulInvoiceTabs, true);
  assert.equal(sanitizeAgentUiSettings({ colorfulInvoiceTabs: "true" }).colorfulInvoiceTabs, false);
});

test("public agent UI settings keep the user guide disabled unless explicitly enabled", () => {
  assert.equal(sanitizeAgentUiSettings(null).userGuideEnabled, false);
  assert.equal(sanitizeAgentUiSettings({}).userGuideEnabled, false);
  assert.equal(sanitizeAgentUiSettings({ userGuideEnabled: true }).userGuideEnabled, true);
  assert.equal(sanitizeAgentUiSettings({ userGuideEnabled: "true" }).userGuideEnabled, false);
});

test("public branding exposes the compact selector only through sanitized agent UI settings", () => {
  const branding = resolvedAgentBranding({
    status: "active",
    brandName: "Example Agent",
    brandLogoUrl: null,
    brandColor: null,
    contactPhone: null,
    inventoryReportsUnified: false,
    moduleShortcutIcons: false,
    moduleReportsUnified: false,
    agentUiSettings: {
      compactInvoiceTypeSelector: true,
      colorfulInvoiceTabs: true,
      userGuideEnabled: true,
      privateFlag: "discard",
    },
  });

  assert.equal(branding.isAgentDomain, true);
  assert.equal(branding.agentUiSettings.compactInvoiceTypeSelector, true);
  assert.equal(branding.agentUiSettings.colorfulInvoiceTabs, true);
  assert.equal(branding.agentUiSettings.userGuideEnabled, true);
  assert.equal("privateFlag" in branding.agentUiSettings, false);
});