import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const schema = read("../../../lib/db/src/schema/agentInstances.ts");
const api = read("../../api-server/src/routes/agentInstances.ts");
const admin = read("../src/pages/admin/AgentServers.tsx");
const branding = read("../src/lib/agentBranding.ts");
const menuHub = read("../src/components/MenuHub.tsx");
const generalSettings = read("../src/pages/GeneralSettings.tsx");
const dashboard = read("../src/pages/Dashboard.tsx");
const inventoryDashboard = read("../src/pages/inventory/InventoryDashboard.tsx");
const officeHub = read("../src/pages/office/OfficeHub.tsx");

test("module shortcut icon preference is agent-specific and defaults off", () => {
  assert.match(schema, /moduleShortcutIcons:\s*boolean\("module_shortcut_icons"\)\.notNull\(\)\.default\(false\)/);
  assert.match(admin, /moduleShortcutIcons:\s*false/);
  assert.match(admin, /moduleShortcutIcons:\s*a\.moduleShortcutIcons === true/);
  assert.match(admin, /moduleShortcutIcons:\s*form\.moduleShortcutIcons/);
  assert.match(api, /moduleShortcutIcons:\s*z\.boolean\(\)\.optional\(\)/);
  assert.match(api, /if \(d\.moduleShortcutIcons !== undefined\) patch\.moduleShortcutIcons = d\.moduleShortcutIcons/);
});

test("only an enabled agent branding response selects the new presentation", () => {
  assert.match(branding, /moduleShortcutIcons:\s*j\?\.isAgentDomain === true && j\?\.moduleShortcutIcons === true/);
  assert.match(branding, /cache\.isAgentDomain && cache\.moduleShortcutIcons/);
  assert.match(menuHub, /useAgentModuleShortcutIcons\(\) === true/);
  assert.match(menuHub, /href=\{tile\.href\}/);
});

test("module shortcut and General Settings grids are gated without changing routes", () => {
  assert.match(generalSettings, /agentShortcutIcons && \[/);
  assert.match(dashboard, /moduleShortcutIcons=\{moduleShortcutIcons\}/);
  assert.match(inventoryDashboard, /moduleShortcutIcons &&/);
  assert.match(officeHub, /moduleShortcutIcons &&/);
  assert.match(dashboard, /href=\{href\}/);
  assert.match(officeHub, /href=\{tile\.href\}/);
});