import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  isManualAgentReleaseRequest,
  resolveAgentReleaseCredentials,
  stripAgentReleaseCredentialsFromUrl,
  buildCustomAgentReleaseUrl,
} from "../src/lib/agentReleasePolicy.ts";
import { buildReleaseFromDist } from "../src/lib/agentRelease.ts";
import {
  buildManualUpdateScript,
  stripLegacyUpdateCron,
} from "../src/routes/localAgentUpdates.ts";

const execFileAsync = promisify(execFile);

test("central release policy never exposes a version to legacy cron requests", () => {
  assert.equal(isManualAgentReleaseRequest(undefined), false);
  assert.equal(isManualAgentReleaseRequest(""), false);
  assert.equal(isManualAgentReleaseRequest("0"), false);
  assert.equal(isManualAgentReleaseRequest("true"), false);
  assert.equal(isManualAgentReleaseRequest("1"), true);
});

test("manual release auth ignores URL credentials and requires headers", () => {
  assert.deepEqual(resolveAgentReleaseCredentials({
    manual: true,
    headers: {},
    query: { installationId: "query-id", licenseKey: "query-secret" },
  }), { installationId: "", licenseKey: "" });
  assert.deepEqual(resolveAgentReleaseCredentials({
    manual: true,
    headers: {
      "x-zacod-installation-id": "header-id",
      "x-zacod-license-key": "header-secret",
    },
    query: {},
  }), { installationId: "header-id", licenseKey: "header-secret" });
  assert.deepEqual(resolveAgentReleaseCredentials({
    manual: false,
    headers: {},
    query: { installationId: "legacy-id", licenseKey: "legacy-secret" },
  }), { installationId: "legacy-id", licenseKey: "legacy-secret" });
});

test("legacy release credentials are stripped from application-visible URLs", () => {
  const secret = "license-secret-that-must-not-be-logged";
  const clean = stripAgentReleaseCredentialsFromUrl(
    `/api/agent/release/manifest?installationId=agent-123&licenseKey=${secret}&manual=0`,
  );
  assert.equal(clean, "/api/agent/release/manifest?manual=0");
  assert.equal(clean.includes(secret), false);
  assert.equal(clean.includes("installationId"), false);
  assert.equal(clean.includes("licenseKey"), false);
});

test("custom uploaded-package URLs never contain release credentials", () => {
  const url = buildCustomAgentReleaseUrl("https://central.example", "backend", true);
  assert.equal(url, "https://central.example/api/agent/release/custom?kind=backend&enc=1");
  assert.equal(url.includes("installationId"), false);
  assert.equal(url.includes("licenseKey"), false);
});

test("release ID changes when only a public frontend asset changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zacod-release-id-test-"));
  const distDir = path.join(root, "dist");
  const releasesDir = path.join(root, "releases");
  try {
    await fs.mkdir(path.join(distDir, "public"), { recursive: true });
    await fs.mkdir(releasesDir);
    await fs.writeFile(path.join(distDir, "index.mjs"), "same-server");
    await fs.writeFile(path.join(distDir, "public", "index.html"), "frontend-one");
    const first = await buildReleaseFromDist(distDir, releasesDir);
    const repeated = await buildReleaseFromDist(distDir, releasesDir);
    await fs.writeFile(path.join(distDir, "public", "index.html"), "frontend-two");
    const second = await buildReleaseFromDist(distDir, releasesDir);
    assert.equal(first.version, repeated.version);
    assert.equal(first.sha256, repeated.sha256);
    assert.notEqual(first.version, second.version);
    assert.notEqual(first.sha256, second.sha256);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy updater cron is removed without touching unrelated jobs", () => {
  const original = [
    "*/5 * * * * /opt/zacod/heartbeat.sh # zacod-heartbeat",
    "*/10 * * * * /opt/zacod/update.sh # zacod-update",
    "0 2 * * * /opt/backups/nightly.sh",
    "15 * * * * /opt/zacod/update.sh",
    "",
  ].join("\n");
  assert.equal(
    stripLegacyUpdateCron(original),
    [
      "*/5 * * * * /opt/zacod/heartbeat.sh # zacod-heartbeat",
      "0 2 * * * /opt/backups/nightly.sh",
    ].join("\n"),
  );
});

async function updaterFixture(failFirstHealthCheck: boolean, manifestSizeDelta = 0) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zacod-update-test-"));
  const appDir = path.join(root, "app");
  const payloadDir = path.join(root, "payload");
  const fakeBin = path.join(root, "bin");
  const bundle = path.join(root, "release.tgz");
  const scriptPath = path.join(root, "run-update.sh");
  const statusFile = path.join(root, "update-status.json");
  const systemctlLog = path.join(root, "systemctl.log");
  const healthCount = path.join(root, "health-count");
  const capturedAuth = path.join(root, "captured-auth.curl");
  await fs.mkdir(path.join(appDir, "public"), { recursive: true });
  await fs.writeFile(path.join(appDir, "OLD"), "old");
  await fs.writeFile(path.join(appDir, "index.mjs"), "old-index");
  await fs.writeFile(path.join(appDir, "public", "index.html"), "old-html");
  await fs.mkdir(path.join(payloadDir, "public"), { recursive: true });
  await fs.writeFile(path.join(payloadDir, "NEW"), "new");
  await fs.writeFile(path.join(payloadDir, "index.mjs"), "new-index");
  await fs.writeFile(path.join(payloadDir, "public", "index.html"), "new-html");
  await execFileAsync("tar", ["-czf", bundle, "-C", payloadDir, "."]);
  const sha256 = createHash("sha256").update(await fs.readFile(bundle)).digest("hex");

  await fs.mkdir(fakeBin);
  await fs.writeFile(systemctlLog, "");
  await fs.writeFile(path.join(fakeBin, "curl"), `#!/usr/bin/env bash
set -e
OUT=""
URL=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) OUT="$2"; shift 2 ;;
    --config) cp "$2" "$CAPTURED_AUTH"; shift 2 ;;
    http://*|https://*) URL="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "$URL" == *"/api/healthz"* ]]; then
  N=0
  [ -f "$HEALTH_COUNT" ] && N=$(cat "$HEALTH_COUNT")
  N=$((N + 1))
  echo "$N" > "$HEALTH_COUNT"
  if [ "$FAIL_FIRST_HEALTH" = "1" ] && [ "$N" = "1" ]; then printf '503'; else printf '200'; fi
  exit 0
fi
if [ -n "$OUT" ]; then cp "$TEST_BUNDLE" "$OUT"; else cat "$TEST_BUNDLE"; fi
`, { mode: 0o700 });
  await fs.writeFile(path.join(fakeBin, "systemctl"), `#!/usr/bin/env bash
echo "$*" >> "$SYSTEMCTL_LOG"
exit 0
`, { mode: 0o700 });
  await fs.writeFile(path.join(root, "manual-update.dispatch"), "test");
  await fs.writeFile(path.join(root, "config.json"), JSON.stringify({
    mode: "full",
    installationId: "installation-test-123",
    licenseKey: "license-test-123",
    centralOrigin: "https://central.example",
  }), { mode: 0o600 });

  const paths = {
    configPath: path.join(root, "config.json"),
    rootDir: root,
    appDir,
    versionFile: path.join(appDir, "VERSION"),
    statusFile,
    dispatchLock: path.join(root, "manual-update.dispatch"),
    updateLock: path.join(root, "manual-update.lock"),
  };
  const script = buildManualUpdateScript({
    paths,
    manifest: {
      version: "0123456789abcdef",
      sizeBytes: (await fs.stat(bundle)).size + manifestSizeDelta,
      sha256,
    },
    bundleUrl: "https://central.example/api/agent/release/bundle?manual=1",
    scriptPath,
    healthAttempts: 1,
    healthDelaySeconds: 0,
  });
  assert.equal(script.includes("license-test-123"), false);
  assert.match(script, /--max-filesize "\$MAX_BUNDLE_SIZE"/);
  await fs.writeFile(scriptPath, script, { mode: 0o700 });

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    TEST_BUNDLE: bundle,
    HEALTH_COUNT: healthCount,
    FAIL_FIRST_HEALTH: failFirstHealthCheck ? "1" : "0",
    SYSTEMCTL_LOG: systemctlLog,
    CAPTURED_AUTH: capturedAuth,
  };
  let exitCode = 0;
  try {
    await execFileAsync("/bin/bash", [scriptPath], { env, timeout: 20_000 });
  } catch (error: any) {
    exitCode = error?.code ?? 1;
  }
  return {
    root,
    appDir,
    status: JSON.parse(await fs.readFile(statusFile, "utf8")) as { state: string; message: string },
    systemctlLog: await fs.readFile(systemctlLog, "utf8"),
    capturedAuth: await fs.readFile(capturedAuth, "utf8").catch(() => ""),
    exitCode,
  };
}

test("manual updater installs and health-checks the approved bundle", async () => {
  const fixture = await updaterFixture(false);
  try {
    assert.equal(fixture.exitCode, 0);
    assert.equal(fixture.status.state, "completed");
    assert.equal(await fs.readFile(path.join(fixture.appDir, "NEW"), "utf8"), "new");
    assert.equal(await fs.readFile(`${fixture.appDir}.old/OLD`, "utf8"), "old");
    assert.match(fixture.systemctlLog, /restart zacod-app/);
    assert.match(fixture.capturedAuth, /X-Zacod-Installation-Id: installation-test-123/);
    assert.match(fixture.capturedAuth, /X-Zacod-License-Key: license-test-123/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("bundle size mismatch fails before replacing or restarting the app", async () => {
  const fixture = await updaterFixture(false, 1);
  try {
    assert.notEqual(fixture.exitCode, 0);
    assert.equal(fixture.status.state, "failed");
    assert.equal(await fs.readFile(path.join(fixture.appDir, "OLD"), "utf8"), "old");
    assert.equal(fixture.systemctlLog, "");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("failed health check restores the previous app automatically", async () => {
  const fixture = await updaterFixture(true);
  try {
    assert.notEqual(fixture.exitCode, 0);
    assert.equal(fixture.status.state, "rolled_back");
    assert.equal(await fs.readFile(path.join(fixture.appDir, "OLD"), "utf8"), "old");
    assert.equal(await fs.readFile(`${fixture.appDir}.failed/NEW`, "utf8"), "new");
    assert.match(fixture.systemctlLog, /restart zacod-app/);
    assert.match(fixture.systemctlLog, /stop zacod-app/);
    assert.match(fixture.systemctlLog, /start zacod-app/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});