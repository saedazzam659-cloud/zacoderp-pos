import assert from "node:assert/strict";
import test from "node:test";
import { agentOwnsHost, resolvedAgentBranding } from "../src/lib/agentPublicBranding.ts";

test("primary and extra agent domains resolve the same instance", () => {
  const agent = { domain: "agent.example", extraDomains: ["www.agent.example", "shop.agent.example"] };
  assert.equal(agentOwnsHost("agent.example", agent), true);
  assert.equal(agentOwnsHost("www.agent.example", agent), true);
  assert.equal(agentOwnsHost("unknown.example", agent), false);
});

test("public agent branding exposes contact phone but no supplied secrets", () => {
  const payload = resolvedAgentBranding({
    status: "active",
    brandName: "Agent",
    brandLogoUrl: null,
    brandColor: "#123456",
    contactPhone: "01000903159",
    dbUrlEnc: "secret",
    proxyToken: "secret",
  } as any);

  assert.equal(payload.contactPhone, "01000903159");
  assert.equal(payload.isAgentDomain, true);
  assert.equal("dbUrlEnc" in payload, false);
  assert.equal("proxyToken" in payload, false);
});