import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const layout = read("../src/components/Layout.tsx");
const productionDashboard = read("../src/pages/ProductionDashboard.tsx");
const productionNavigation = read("../src/lib/productionNavigation.ts");
const unifiedReports = read("../src/pages/UnifiedModuleReports.tsx");
const controlPanel = read("../src/pages/ControlPanelHub.tsx");
const unifiedInventoryReports = read("../src/pages/inventory/reports/UnifiedInventoryReports.tsx");

test("agent dashboard navigation opens the icon hub and keeps the information board inside it", () => {
  assert.match(layout, /if \(isAgentDomain && g\.key === "dashboard"\)/);
  assert.match(layout, /data-testid="topnav-agent-control-panel"/);
  assert.match(layout, /item=\{\{ nameKey: "nav\.dashboardGroup", href: "\/control-panel", icon: Settings \}\}/);
  assert.match(layout, /isAgentDomain \? \([\s\S]*?nav\.dashboardGroup[\s\S]*?\/control-panel[\s\S]*?\) : \([\s\S]*?nav\.infoBoard[\s\S]*?DashboardNavGroup/);
  assert.match(controlPanel, /nameKey: "nav\.infoBoard",[\s\S]*?href: "\/",[\s\S]*?icon: LayoutDashboard/);
  assert.match(controlPanel, /tiles=\{isAgentDomain \? \[agentDashboardTile, \.\.\.tiles\] : tiles\}/);
});

test("agent production tiles reuse all 22 production routes and keep core tiles as the default", () => {
  const productionHrefs = [...productionNavigation.matchAll(/href:\s*"(\/production[^"]*)"/g)]
    .map((match) => match[1]);
  assert.equal(productionHrefs.length, 22);
  assert.equal(new Set(productionHrefs).size, 22);
  assert.match(productionDashboard, /isAgentDomain && moduleScreensAsTiles\.includes\("production"\)/);
  assert.match(productionDashboard, /allProductionHubTiles\.filter\(tile => companyAllowsScreen\(user, tile\.href\)\)/);
  assert.match(productionDashboard, /: coreProductionHubTiles/);
});

test("unified report selection scrolls to the embedded report and respects reduced motion", () => {
  assert.match(unifiedReports, /selectedReportContainerRef\.current/);
  assert.match(unifiedReports, /container\.scrollIntoView\(\{/);
  assert.match(unifiedReports, /prefers-reduced-motion: reduce/);
  assert.match(unifiedReports, /\{selectedReport && \([\s\S]*?ref=\{selectedReportContainerRef\}/);
});

test("agent inventory report selection scrolls to the embedded report table", () => {
  assert.match(unifiedInventoryReports, /if \(!isAgentDomain \|\| !selectedReport \|\| !container\) return/);
  assert.match(unifiedInventoryReports, /container\.scrollIntoView\(\{/);
  assert.match(unifiedInventoryReports, /prefers-reduced-motion: reduce/);
  assert.match(unifiedInventoryReports, /data-testid="container-selected-unified-inventory-report"/);
});