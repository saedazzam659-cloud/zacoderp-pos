import assert from "node:assert/strict";
import test from "node:test";
import { agentOwnsHost, resolvedAgentBranding, trustedBrandingSource, localAgentPublicBranding } from "../src/lib/agentPublicBranding.ts";
import type { LocalAgentRuntimeState } from "../src/lib/localAgentSuperadmin.ts";

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

const installed: LocalAgentRuntimeState = {
  isLocalAgent: true, localSuperadminEnabled: false, localSuperadminScreens: [],
  config: { mode: "full", domain: "agent.example", centralOrigin: "https://central.example" },
};

test("installed branding uses only installer-owned origin and domain, and ignores remote policy", async () => {
  let calls = 0;
  const fetchBrand = (async (input: string, init: RequestInit) => {
    calls++;
    assert.equal(input, "https://central.example/api/branding?host=agent.example");
    assert.equal(init.redirect, "manual");
    return new Response(JSON.stringify({
      isAgentDomain: true, brandName: "Installed Brand", brandLogoUrl: "https://cdn.example/logo.png",
      brandColor: "#123456", contactPhone: null,
      localSuperadminEnabled: true, localSuperadminScreens: ["users"], licenseKey: "secret",
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const result = await localAgentPublicBranding(installed, fetchBrand);
  assert.equal(result?.brandName, "Installed Brand");
  assert.equal(result?.localSuperadminEnabled, false);
  assert.deepEqual(result?.localSuperadminScreens, []);
  assert.equal("licenseKey" in (result ?? {}), false);
  const cached = await localAgentPublicBranding(installed, fetchBrand);
  assert.equal(calls, 1);
  assert.equal(cached?.brandName, "Installed Brand");
});

test("only HTTPS controller origin with no path/credentials is allowed", async () => {
  assert.deepEqual(trustedBrandingSource(installed), { origin: "https://central.example", domain: "agent.example" });
  for (const origin of ["http://central.example", "https://user:pass@central.example",
    "https://central.example/path", "https://central.example/?host=other", "https://127.0.0.1"]) {
    const state = { ...installed, config: { ...installed.config, centralOrigin: origin } };
    assert.equal(trustedBrandingSource(state), null);
  }
  const other = { ...installed, config: { ...installed.config, domain: "other.example",
    controllerOrigins: [{ platformId: "active", origin: "https://controller.example" }],
    activeControllerId: "active" } };
  assert.deepEqual(trustedBrandingSource(other), { origin: "https://controller.example", domain: "other.example" });
  const result = await localAgentPublicBranding(other, (async () => {
    throw new Error("offline");
  }) as typeof fetch);
  assert.equal(result, null);
});

test("controller cannot turn on disabled local Super Admin or supply branding for another host", async () => {
  const state = { ...installed, config: { ...installed.config, domain: "different.example" } };
  const result = await localAgentPublicBranding(state, (async () =>
    new Response(JSON.stringify({ isAgentDomain: false, localSuperadminEnabled: true, brandName: "Wrong" }),
      { headers: { "content-type": "application/json" } })) as typeof fetch);
  assert.equal(result, null);
  const enabled = { ...installed, localSuperadminEnabled: true, localSuperadminScreens: ["dashboard"] };
  const branded = await localAgentPublicBranding(enabled, (() => {
    throw new Error("cached branding must not refetch");
  }) as typeof fetch);
  assert.equal(branded?.localSuperadminEnabled, true);
  assert.deepEqual(branded?.localSuperadminScreens, ["dashboard"]);
});

test("uploaded data URI logo larger than 2048 characters is delivered intact", async () => {
  const logo = `data:image/png;base64,${"A".repeat(100_000)}`;
  const state = { ...installed, config: { ...installed.config, domain: "logo.example" } };
  const result = await localAgentPublicBranding(state, (async () =>
    new Response(JSON.stringify({ isAgentDomain: true, brandName: "Logo",
      brandLogoUrl: logo, brandColor: "#123456", contactPhone: null }),
      { headers: { "content-type": "application/json" } })) as typeof fetch);
  assert.equal(result?.brandLogoUrl, logo);
});

test("oversized streaming response is stopped before download completion and failure is negative-cached", async () => {
  const state = { ...installed, config: { ...installed.config, domain: "oversize.example" } };
  let calls = 0;
  let cancelled = false;
  const fetchBrand = (async () => {
    calls++;
    return new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(400_000));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  assert.equal(await localAgentPublicBranding(state, fetchBrand), null);
  assert.equal(cancelled, true);
  assert.equal(await localAgentPublicBranding(state, fetchBrand), null);
  assert.equal(calls, 1);
});

test("concurrent branding callers share one controller request while keeping local policies separate", async () => {
  const state = { ...installed, config: { ...installed.config, domain: "concurrent.example" } };
  let calls = 0;
  const fetchBrand = (async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ isAgentDomain: true, brandName: "Shared",
      brandLogoUrl: null, brandColor: null, contactPhone: null }),
      { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const [disabled, enabled] = await Promise.all([
    localAgentPublicBranding(state, fetchBrand),
    localAgentPublicBranding({ ...state, localSuperadminEnabled: true, localSuperadminScreens: ["dashboard"] }, fetchBrand),
  ]);
  assert.equal(calls, 1);
  assert.equal(disabled?.localSuperadminEnabled, false);
  assert.equal(enabled?.localSuperadminEnabled, true);
  assert.deepEqual(enabled?.localSuperadminScreens, ["dashboard"]);
});