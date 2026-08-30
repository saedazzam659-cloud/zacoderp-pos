import test from "node:test";
import assert from "node:assert/strict";
import {
  canViewCompanyDemoAnalytics,
  demoProfileBelongsToViewerScope,
  demoViewerScopeFromRequest,
  interestCategoryForScore,
  normalizePhone,
} from "../src/lib/demoAnalytics.ts";
import { cleanDemoEvents } from "../src/routes/demo-analytics.ts";
import { isDemoQuotaWrite } from "../src/middleware/demoQuota.ts";

test("demo phone normalization has stable Saudi and international forms", () => {
  assert.equal(normalizePhone("050 123 4567"), "+966501234567");
  assert.equal(normalizePhone("+1 (212) 555-1212"), "+12125551212");
  assert.equal(normalizePhone("bad"), null);
});
test("event contract strips payloads and validates replay-safe event ids", () => {
  const events = cleanDemoEvents([{ eventId: "e-1", type: "screen_view", moduleKey: "sales", customer: { secret: true } }]);
  assert.deepEqual(events?.[0], { eventId: "e-1", type: "screen_view", occurredAt: events?.[0].occurredAt });
  assert.equal(cleanDemoEvents([{ eventId: "", type: "screen_view" }]), null);
  assert.equal(cleanDemoEvents([{ eventId: "e-pii", type: "john-smith" }]), null);
  const redacted = cleanDemoEvents([{
    eventId: "e-2",
    type: "screen_view",
    route: "/customers/john-smith?phone=secret",
    moduleKey: "untrusted-name",
    screenKey: "untrusted-name",
    actionKey: "customer_john-smith",
  }]);
  assert.equal(redacted?.[0].route, "/customers/:id");
  assert.equal(redacted?.[0].moduleKey, "customers");
  assert.equal(redacted?.[0].screenKey, "customers_:id");
  assert.equal(redacted?.[0].actionKey, null);
  const categorized = cleanDemoEvents([{
    eventId: "e-3",
    type: "action",
    route: "/sales/invoices/123",
    actionKey: "export.johnsmith",
  }]);
  assert.equal(categorized?.[0].actionKey, "export");
});
test("quota classifier preserves browsing and excluded control routes", () => {
  assert.equal(isDemoQuotaWrite({ method: "GET", path: "/invoices", originalUrl: "/invoices" } as any), false);
  assert.equal(isDemoQuotaWrite({ method: "POST", path: "/demo-analytics/events/batch", originalUrl: "" } as any), false);
  assert.equal(isDemoQuotaWrite({ method: "POST", path: "/invoices", originalUrl: "" } as any), true);
});
test("interest funnel has five stable categories", () => {
  assert.deepEqual([0, 10, 30, 50, 70].map(interestCategoryForScore), ["new_visitor", "casual", "interested", "very_interested", "strong_candidate"]);
});

test("company demo viewer scope is derived from session and agent request context", () => {
  const central = demoViewerScopeFromRequest({ authUser: { companyId: 41 } } as any);
  const agent = demoViewerScopeFromRequest({ authUser: { companyId: 41 }, agentDomainHit: { id: 9 } } as any);
  assert.deepEqual(central, { sourceKind: "central", sourceInstanceId: null, localCompanyId: 41 });
  assert.deepEqual(agent, { sourceKind: "agent", sourceInstanceId: 9, localCompanyId: 41 });
  assert.equal(demoViewerScopeFromRequest({ authUser: {} } as any), null);
});

test("demo profile ownership requires source kind, source instance, and local company", () => {
  const scope = { sourceKind: "agent" as const, sourceInstanceId: 9, localCompanyId: 41 };
  assert.equal(demoProfileBelongsToViewerScope({ ...scope }, scope), true);
  assert.equal(demoProfileBelongsToViewerScope({ ...scope, localCompanyId: 42 }, scope), false);
  assert.equal(demoProfileBelongsToViewerScope({ ...scope, sourceInstanceId: 10 }, scope), false);
  assert.equal(demoProfileBelongsToViewerScope({ ...scope, sourceKind: "central", sourceInstanceId: null }, scope), false);
});

test("company demo monitoring is visible only to the company manager", () => {
  assert.equal(canViewCompanyDemoAnalytics({ role: "admin" }), true);
  assert.equal(canViewCompanyDemoAnalytics({ role: "user" }), false);
  assert.equal(canViewCompanyDemoAnalytics({ role: "trainee" }), false);
  assert.equal(canViewCompanyDemoAnalytics({ role: "superadmin" }), false);
  assert.equal(canViewCompanyDemoAnalytics(null), false);
});