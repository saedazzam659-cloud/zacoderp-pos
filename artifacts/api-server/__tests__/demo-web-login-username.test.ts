import assert from "node:assert/strict";
import test from "node:test";
import {
  ASCII_DEMO_USERNAME_VARIANTS,
  isAsciiDemoUsername,
  isDemoWebLoginAttempt,
  selectDemoWebUsernameFallback,
} from "../src/lib/demoWebLoginUsername.ts";

const source = (username: string, demoDeviceIsolation: boolean, hasHistory = false) => ({
  user: { username, demoDeviceIsolation, isDemoShadow: false },
  hasHistory,
});

test("only four ASCII demo letters qualify, in any casing", () => {
  assert.equal(ASCII_DEMO_USERNAME_VARIANTS.length, 16);
  for (const variant of ASCII_DEMO_USERNAME_VARIANTS) {
    assert.equal(isAsciiDemoUsername(variant), true);
    assert.equal(selectDemoWebUsernameFallback(variant, [source("demo", true)])?.user.username, "demo");
  }
  for (const value of [" demos", "demo ", "dëmo", "demо", "admin", "demo_1", 123]) {
    assert.equal(isAsciiDemoUsername(value), false);
    assert.equal(selectDemoWebUsernameFallback(value, [source("demo", true)]), null);
  }
});

test("requires existing isolated source or sticky workspace history", () => {
  assert.equal(selectDemoWebUsernameFallback("DEMO", [source("demo", false)]), null);
  assert.equal(selectDemoWebUsernameFallback("DeMo", [source("demo", false, true)])?.user.username, "demo");
  assert.equal(selectDemoWebUsernameFallback("DEMO", [source("Demo", true)])?.user.username, "Demo");
  assert.equal(selectDemoWebUsernameFallback("DEMO", [{
    user: { ...source("demo", true).user, isDemoShadow: true },
    hasHistory: true,
  }]), null);
  assert.equal(selectDemoWebUsernameFallback("DEMO", [source("demo1", true)]), null);
});

test("case-colliding demo sources never select an arbitrary account", () => {
  assert.equal(selectDemoWebUsernameFallback("DEMO", [
    source("demo", true), source("Demo", false, true),
  ]), null);
  assert.equal(selectDemoWebUsernameFallback("DEMO", [
    source("demo", false), source("Demo", true),
  ])?.user.username, "Demo");
});

test("fallback is restricted to ERP web demo preflight or phone login", () => {
  const web = {
    username: "DEMO", appChannel: undefined, surface: undefined,
    agentDomainHit: false, isLocalAgent: false,
    intent: "check_demo_preparation", demoPhone: undefined,
  };
  assert.equal(isDemoWebLoginAttempt(web), true);
  assert.equal(isDemoWebLoginAttempt({ ...web, intent: undefined, demoPhone: "+966500000000" }), true);
  assert.equal(isDemoWebLoginAttempt({ ...web, intent: undefined }), false);
  assert.equal(isDemoWebLoginAttempt({ ...web, appChannel: "mobile" }), false);
  assert.equal(isDemoWebLoginAttempt({ ...web, surface: "pos" }), false);
  assert.equal(isDemoWebLoginAttempt({ ...web, agentDomainHit: true }), false);
  assert.equal(isDemoWebLoginAttempt({ ...web, isLocalAgent: true }), false);
  assert.equal(isDemoWebLoginAttempt({ ...web, username: "ADMIN" }), false);
});