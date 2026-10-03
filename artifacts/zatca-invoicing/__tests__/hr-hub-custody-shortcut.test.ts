import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const layout = readFileSync(
  new URL("../src/components/Layout.tsx", import.meta.url),
  "utf8",
);
const hrHub = readFileSync(
  new URL("../src/pages/hr/HrHub.tsx", import.meta.url),
  "utf8",
);

test("the HR hub includes every HR submenu route, including employee custody", () => {
  const navBlock = layout.match(/const hrSubNav: NavDef\[\] = \[([\s\S]*?)\n\];/)?.[1];
  const tileBlock = hrHub.match(/const tiles: HubTile\[\] = \[([\s\S]*?)\n\];/)?.[1];
  assert.ok(navBlock, "HR navigation list should be present");
  assert.ok(tileBlock, "HR hub tile list should be present");

  const routes = (source: string) =>
    [...source.matchAll(/href:\s*"([^"]+)"/g)].map((match) => match[1]);
  const missingRoutes = routes(navBlock).filter(route => !routes(tileBlock).includes(route));
  assert.deepEqual(missingRoutes, []);
  assert.match(tileBlock, /href:\s*"\/hr\/custody"/);
});

test("the custody shortcut and new-tab arrows are gated by the agent shortcut-icon preference", () => {
  assert.match(hrHub, /useAgentModuleShortcutIcons\(\)\s*===\s*true/);
  assert.match(hrHub, /shortcutIcons\s*\?\s*tiles\s*:\s*tiles\.filter/);
  assert.match(layout, /useAgentModuleShortcutIcons\(\)\s*===\s*true/);
  assert.match(layout, /target="_blank"/);
  assert.match(layout, /rel="noopener noreferrer"/);
  assert.match(layout, /appRouteHref\(href\)/);
});