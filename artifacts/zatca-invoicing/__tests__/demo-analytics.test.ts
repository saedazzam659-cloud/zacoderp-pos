import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const apiModule = import("../src/lib/demoAnalyticsApi.ts");

function setNavigator(userAgent: string, maxTouchPoints = 0) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent, maxTouchPoints },
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: { screen: { width: 1920 } },
    configurable: true,
  });
}

test("analytics route templates strip identifiers and derive safe dimensions", async () => {
  const { sanitizeRouteForDemoAnalytics } = await apiModule;
  const admin = sanitizeRouteForDemoAnalytics("/admin/demo-analytics/123?phone=secret");
  assert.deepEqual(admin, {
    path: "/admin/demo-analytics/:id",
    moduleKey: "admin",
    screenKey: "admin_demo-analytics_:id",
  });

  const invoice = sanitizeRouteForDemoAnalytics("/sales/invoices/9f86d081-884c-4715-929b-81a45f1b53e8");
  assert.equal(invoice.path, "/sales/invoices/:id");
  assert.equal(invoice.moduleKey, "sales");
  assert.equal(invoice.screenKey, "sales_invoices_:id");
  assert.equal(JSON.stringify(invoice).includes("9f86d081"), false);
});

test("device heuristics prioritize Android and Edge correctly", async () => {
  const { getClientDeviceHeuristics } = await apiModule;
  setNavigator("Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36");
  assert.deepEqual(
    getClientDeviceHeuristics(),
    {
      deviceType: "mobile",
      os: "Android",
      browser: "Chrome",
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36",
    },
  );

  setNavigator("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36 Edg/130");
  assert.equal(getClientDeviceHeuristics().browser, "Edge");
});

test("event IDs are distinct", async () => {
  const { generateEventId } = await apiModule;
  assert.notEqual(generateEventId(), generateEventId());
});

test("export waits for the shared demo quota gate", async () => {
  const source = await readFile(new URL("../src/components/ExportButtons.tsx", import.meta.url), "utf8");
  const consumeAt = source.indexOf("await gate(type === \"print\" ? \"print\" : \"export\")");
  const excelAt = source.indexOf("await exportToExcelBranded");
  const pdfAt = source.indexOf("await exportToPDF");
  assert.ok(consumeAt > 0);
  assert.ok(excelAt > consumeAt);
  assert.ok(pdfAt > consumeAt);
  assert.match(source, /useDemoActionGate/);
});

test("invoice print fallback cannot bypass a denied demo quota gate", async () => {
  const source = await readFile(new URL("../src/components/InvoicePrintDialog.tsx", import.meta.url), "utf8");
  const gateAt = source.indexOf('await gate("print")');
  const windowAt = source.indexOf('window.open("", "_blank"');
  const fallbackAt = source.indexOf("setTimeout(() => { try { win.focus(); win.print(); }");
  assert.ok(gateAt > 0);
  assert.ok(windowAt > gateAt);
  assert.ok(fallbackAt > windowAt);
  assert.doesNotMatch(source.slice(windowAt), /await gate\\([\"']print[\"']\\)/);
});

test("dashboard and detail use the actual API response contracts", async () => {
  const dashboard = await readFile(new URL("../src/pages/admin/demo-analytics/DemoAnalyticsDashboard.tsx", import.meta.url), "utf8");
  const detail = await readFile(new URL("../src/pages/admin/demo-analytics/DemoAnalyticsDetail.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /Array\.isArray\(profilesData\) \? profilesData : \[\]/);
  assert.match(dashboard, /dashboard\.rankedProspects/);
  assert.match(dashboard, /new_visitor[\s\S]*casual[\s\S]*interested[\s\S]*very_interested[\s\S]*strong_candidate/);
  assert.match(dashboard, /Number\(appliedFilters\.duration\) \* 60_000/);
  assert.match(detail, /data\?\.policy/);
  assert.match(detail, /const \{ profile, policy, actionsUsed, remaining, sessions, events \} = data/);
});

test("mandatory phone, quota notices, routes, and navigation are wired", async () => {
  const [phone, banner, app, layout] = await Promise.all([
    readFile(new URL("../src/components/demo-analytics/PhoneCaptureDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/demo-analytics/DemoQuotaBanner.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Layout.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(phone, /data-testid="phone-capture-form"/);
  assert.match(phone, /data-testid="phone-capture-submit"/);
  assert.doesNotMatch(phone, /DialogClose|onOpenChange/);
  assert.match(banner, /data-testid="demo-quota-warning"/);
  assert.match(banner, /data-testid="demo-quota-blocked"/);
  assert.match(app, /path="\/admin\/demo-analytics\/:id"/);
  assert.match(app, /path="\/admin\/demo-analytics"/);
  assert.match(layout, /href:\s*"\/admin\/demo-analytics"/);
});