import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  blockDisabledLocalSuperadmin,
  effectiveLocalSuperadminEnabled,
  normalizeLocalSuperadminScreens,
  readLocalAgentRuntimeState,
  validateAgentLocalSuperadmin,
  validateLocalSuperadminScreenSelection,
} from "../src/lib/localAgentSuperadmin.ts";

test("local Super Admin entitlement is meaningful only for full editions", () => {
  assert.equal(effectiveLocalSuperadminEnabled("full", undefined), true);
  assert.equal(effectiveLocalSuperadminEnabled("full", false), false);
  assert.equal(effectiveLocalSuperadminEnabled("frontend_only", true), false);
  assert.equal(effectiveLocalSuperadminEnabled("full_shell", true), false);
});

test("screen selection removes unknown and duplicate values while legacy stays fully allowed", () => {
  assert.equal(normalizeLocalSuperadminScreens(undefined).length > 30, true);
  assert.deepEqual(normalizeLocalSuperadminScreens(["dashboard", "unknown", "dashboard", "reports"]), ["dashboard", "reports"]);
});

test("screen selection is required only when the local panel is enabled", () => {
  assert.equal(validateLocalSuperadminScreenSelection(false, []), null);
  assert.match(validateLocalSuperadminScreenSelection(true, []) ?? "", /شاشة واحدة/);
  assert.equal(validateLocalSuperadminScreenSelection(true, ["dashboard"]), null);
});

test("enabled full editions require complete local Super Admin credentials", () => {
  assert.match(validateAgentLocalSuperadmin({
    mode: "full", enabled: true, username: "", email: "", password: "",
  }) ?? "", /اسم مستخدم/);
  assert.match(validateAgentLocalSuperadmin({
    mode: "full", enabled: true, username: "owner", email: "", password: "StrongPass12",
  }) ?? "", /إيميل/);
  assert.equal(validateAgentLocalSuperadmin({
    mode: "full",
    enabled: true,
    username: "owner",
    email: "owner@example.com",
    password: "StrongPass12",
  }), null);
  assert.equal(validateAgentLocalSuperadmin({
    mode: "full",
    enabled: true,
    username: "owner",
    email: "owner@example.com",
    password: "",
    passwordAlreadySet: true,
  }), null);
});

test("disabled editions reject newly supplied Super Admin credentials", () => {
  assert.equal(validateAgentLocalSuperadmin({
    mode: "full", enabled: false, username: null, email: null, password: null,
  }), null);
  assert.match(validateAgentLocalSuperadmin({
    mode: "full", enabled: false, username: "owner", email: null, password: null,
  }) ?? "", /بدون لوحة/);
});

test("runtime config preserves legacy full agents and fails closed when disabled or malformed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zacod-local-sa-"));
  const configPath = path.join(dir, "config.json");
  const previous = process.env.ZACOD_AGENT_CONFIG;
  process.env.ZACOD_AGENT_CONFIG = configPath;
  try {
    assert.deepEqual(await readLocalAgentRuntimeState(), {
      isLocalAgent: false,
      localSuperadminEnabled: true,
      localSuperadminScreens: normalizeLocalSuperadminScreens(undefined),
      config: null,
    });

    await writeFile(configPath, JSON.stringify({ mode: "full", installationId: "legacy-agent" }));
    assert.equal((await readLocalAgentRuntimeState()).localSuperadminEnabled, true);

    await writeFile(configPath, JSON.stringify({ mode: "full", localSuperadminEnabled: false }));
    assert.equal((await readLocalAgentRuntimeState()).localSuperadminEnabled, false);

    await writeFile(configPath, "{broken");
    const malformed = await readLocalAgentRuntimeState();
    assert.equal(malformed.isLocalAgent, true);
    assert.equal(malformed.localSuperadminEnabled, false);
  } finally {
    if (previous === undefined) delete process.env.ZACOD_AGENT_CONFIG;
    else process.env.ZACOD_AGENT_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("disabled local edition hides Super Admin routes with 404", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zacod-local-sa-mw-"));
  const configPath = path.join(dir, "config.json");
  const previous = process.env.ZACOD_AGENT_CONFIG;
  process.env.ZACOD_AGENT_CONFIG = configPath;
  await writeFile(configPath, JSON.stringify({ mode: "full", localSuperadminEnabled: false }));
  try {
    let nextCalled = false;
    let statusCode = 0;
    let body: unknown;
    const res = {
      status(code: number) { statusCode = code; return this; },
      json(value: unknown) { body = value; return this; },
    };
    await blockDisabledLocalSuperadmin({} as any, res as any, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 404);
    assert.deepEqual(body, { error: "غير موجود" });
  } finally {
    if (previous === undefined) delete process.env.ZACOD_AGENT_CONFIG;
    else process.env.ZACOD_AGENT_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  }
});