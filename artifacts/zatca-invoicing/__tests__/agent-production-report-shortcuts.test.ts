import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const layout = read("../src/components/Layout.tsx");
const productionDashboard = read("../src/pages/ProductionDashboard.tsx");
const productionNavigation = read("../src/lib/productionNavigation.ts");
const unifiedReports = read("../src/pages/UnifiedModuleReports.tsx");

test("dashboard-group labels become accessible icon-only links only under the agent icon setting", () => {
  assert.match(layout, /const iconOnlyLabels = useAgentModuleShortcutIcons\(\) === true/);
  assert.match(layout, /iconOnlyLabels=\{iconOnlyLabels\}/);
  assert.match(layout, /aria-label=\{iconOnlyLabels \? t\(item\.nameKey\) : undefined\}/);
  assert.match(layout, /<span className=\{iconOnlyLabels \? "sr-only" : undefined\}>\{t\(item\.nameKey\)\}<\/span>/);
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