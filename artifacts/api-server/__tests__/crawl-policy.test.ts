import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aiBots, publicPages, robotsHeader, robotsText, frontendSourceMap, caddyCrawlPolicy } from "../src/lib/crawlPolicy.js";

test("marketing allowlist, query strings, Unicode articles and internal routes", () => {
  for (const path of [...publicPages, "/blog/فاتورة", "/pricing?plan=pro", "/compare/", "/%70ricing"]) {
    assert.equal(robotsHeader(path), "index, follow", path);
  }
  for (const path of ["/api", "/api/public/plans", "/sales", "/sales/invoices/1",
    "/purchasing", "/inventory", "/hr/face/kiosk", "/pos/", "/settings",
    "/reports-invitation/token", "/recover-superadmin/token", "/pricing-secret",
    "/login/private", "/new-private-module", "/%61pi/items", "/%ZZ", "//api/items"]) {
    assert.equal(robotsHeader(path), "noindex, nofollow, noarchive", path);
  }
});

test("AI robots opt-out and ordinary search engine public allowlist", () => {
  const text = robotsText("https://example.test");
  for (const bot of aiBots) assert.ok(text.includes(`User-agent: ${bot}\nDisallow: /\n`));
  assert.ok(!text.includes("User-agent: Googlebot\n"));
  assert.ok(!text.includes("User-agent: Bingbot\n"));
  assert.ok(!text.includes("Allow: /\n"));
  assert.ok(text.includes("User-agent: *\nDisallow: /"));
  assert.ok(text.includes("Sitemap: https://example.test/sitemap.xml"));
  assert.equal(readFileSync(new URL("../../zatca-invoicing/public/robots.txt", import.meta.url), "utf8").trim(), robotsText().trim());
});

test("only frontend JS/CSS maps are denied, not APIs/uploads/dev/POS/mobile files", () => {
  for (const path of ["/assets/main.js.map", "/assets/a.css.map?x=1", "/assets/main%2Ejs.map"]) {
    assert.equal(frontendSourceMap(path), true, path);
  }
  for (const path of ["/api/assets/a.js.map", "/storage/a.js.map", "/objects/a.css.map",
    "/uploads/a.js.map", "/pos/assets/a.js.map", "/mobile/a.js.map",
    "/@vite/client", "/src/main.tsx", "/assets/main.js", "/assets/map.json"]) {
    assert.equal(frontendSourceMap(path), false, path);
  }
});

test("generated agent policies run before fallback and use no domain constants", () => {
  const policy = caddyCrawlPolicy();
  assert.ok(policy.includes('header X-Robots-Tag "noindex, nofollow, noarchive"'));
  assert.ok(policy.includes('header @crawlPublic X-Robots-Tag "index, follow"'));
  assert.ok(policy.includes("method GET HEAD"));
  assert.ok(policy.includes("respond @frontendMap 404"));
  for (const path of publicPages) assert.ok(policy.includes(path));
  for (const file of ["agentInstances.ts", "localAgentUpdates.ts"]) {
    const source = readFileSync(new URL(`../src/routes/${file}`, import.meta.url), "utf8");
    assert.ok(source.includes("${caddyCrawlPolicy()}"));
  }
});