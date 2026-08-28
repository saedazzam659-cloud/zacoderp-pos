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
import {
  AGENT_DB_EXCLUDED_TABLE_DATA,
  EXTERNAL_PACKAGE_KINDS,
  createDirectUploadTarget,
  encryptedPackageSize,
  objectPathToPrivateKey,
  packageObjectKey,
  packageSignature,
  privateFileForObjectPath,
  removePackageObject,
  verifyPackageEntry,
  type ExternalPackageEntry,
} from "../src/lib/agentExternalPackages.ts";

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

test("external package integrity signature is bound to agent, kind, size, digest, and format", () => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "test-session-secret-at-least-sixteen-characters";
  try {
    const base = {
      agentId: 17,
      kind: "backend" as const,
      sha256: "a".repeat(64),
      sizeBytes: 12_345,
      format: "tgz" as const,
    };
    const entry: ExternalPackageEntry = {
      objectPath: "/objects/agent-packages/17/packages/backend-test.enc",
      filename: "backend.tgz",
      sizeBytes: base.sizeBytes,
      sha256: base.sha256,
      signature: packageSignature(base),
      uploadedAt: new Date(0).toISOString(),
      version: "test-version",
      format: base.format,
      encrypted: true,
      verified: true,
      origin: "generated",
    };
    assert.equal(verifyPackageEntry(17, "backend", entry), true);
    assert.equal(verifyPackageEntry(18, "backend", entry), false);
    assert.equal(verifyPackageEntry(17, "frontend", entry), false);
    assert.equal(verifyPackageEntry(17, "backend", { ...entry, sizeBytes: entry.sizeBytes + 1 }), false);
    assert.equal(verifyPackageEntry(17, "backend", { ...entry, sha256: "b".repeat(64) }), false);
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});

test("private package paths remain under the caller-owned agent namespace", () => {
  assert.equal(
    objectPathToPrivateKey("/objects/agent-packages/17/packages/backend-test.enc"),
    "agent-packages/17/packages/backend-test.enc",
  );
  assert.throws(() => objectPathToPrivateKey("/public/backend.enc"));
  assert.throws(() => objectPathToPrivateKey("/objects/agent-packages/17/../other.enc"));
  assert.match(packageObjectKey(17, "backend", "staging"), /^agent-packages\/17\/staging\/backend-\d+-[a-f0-9]{16}\.upload$/);
  assert.match(packageObjectKey(17, "backend", "packages"), /^agent-packages\/17\/packages\/backend-\d+-[a-f0-9]{16}\.enc$/);
});

test("encrypted package sizing accounts for the OpenSSL header and CBC padding at the raw upload limit", () => {
  const rawLimit = 800 * 1024 * 1024;
  assert.equal(encryptedPackageSize(0), 32);
  assert.equal(encryptedPackageSize(1), 32);
  assert.equal(encryptedPackageSize(16), 48);
  assert.equal(encryptedPackageSize(rawLimit), rawLimit + 32);
});

test("direct upload session enforces the declared size before creating a staging object", async t => {
  if (!process.env.PRIVATE_OBJECT_DIR) {
    t.skip("private object storage is unavailable");
    return;
  }
  const origin = "https://direct-upload-test.example";
  const oversized = await createDirectUploadTarget(2_147_483_000, "backend", 3, origin);
  try {
    const response = await fetch(oversized.uploadURL, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("1234"),
    });
    assert.equal(response.ok, false);
    assert.equal((await privateFileForObjectPath(oversized.objectPath).exists())[0], false);
  } finally {
    await removePackageObject(oversized.objectPath);
  }

  const exact = await createDirectUploadTarget(2_147_483_000, "backend", 3, origin);
  try {
    const preflight = await fetch(exact.uploadURL, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(preflight.ok, true);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /\bPUT\b/);
    const response = await fetch(exact.uploadURL, {
      method: "PUT",
      headers: { Origin: origin, "Content-Type": "application/octet-stream" },
      body: Buffer.from("123"),
    });
    assert.equal(response.ok, true);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    const file = privateFileForObjectPath(exact.objectPath);
    assert.equal((await file.exists())[0], true);
    assert.equal(Number((await file.getMetadata())[0].size), 3);
  } finally {
    await removePackageObject(exact.objectPath);
  }
});

test("external edition requires all three encrypted artifacts and strips control-plane identity data from DB exports", () => {
  assert.deepEqual(EXTERNAL_PACKAGE_KINDS, ["backend", "frontend", "db"]);
  for (const table of [
    "agent_instances",
    "agent_servers",
    "agent_security_events",
    "agent_platform_link_invites",
    "agent_controller_links",
    "zacod_installation",
    "sa_sessions",
    "sa_otp_codes",
  ]) {
    assert.equal(AGENT_DB_EXCLUDED_TABLE_DATA.includes(table as any), true, `${table} must not be copied into an external agent DB package`);
  }
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
  await fs.mkdir(path.join(appDir, "public", "assets"), { recursive: true });
  await fs.writeFile(path.join(appDir, "OLD"), "old");
  await fs.writeFile(path.join(appDir, "index.mjs"), "old-index");
  await fs.writeFile(path.join(appDir, "public", "index.html"), "old-html");
  await fs.writeFile(path.join(appDir, "public", "assets", "old-current.js"), "old-current");
  await fs.writeFile(path.join(appDir, "public", "assets", "retained-older.js"), "retained-older");
  await fs.writeFile(path.join(appDir, ".retained-update-assets"), "assets/retained-older.js\n");
  await fs.mkdir(path.join(payloadDir, "public", "assets"), { recursive: true });
  await fs.writeFile(path.join(payloadDir, "NEW"), "new");
  await fs.writeFile(path.join(payloadDir, "index.mjs"), "new-index");
  await fs.writeFile(path.join(payloadDir, "public", "index.html"), "new-html");
  await fs.writeFile(path.join(payloadDir, "public", "assets", "new-current.js"), "new-current");
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
  assert.match(script, /try_files \{path\} \/index\.html/);
  assert.match(script, /handle \/assets\/\*/);
  assert.match(script, /public, max-age=31536000, immutable/);
  assert.match(script, /header Cache-Control "no-cache, no-store, must-revalidate"/);
  assert.match(script, /repair_spa_gateway/);
  assert.match(script, /\.retained-update-assets/);
  assert.match(script, /find "\$APP_DIR\/public\/assets" -type f -print0/);
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
    assert.equal(await fs.readFile(path.join(fixture.appDir, "public", "assets", "old-current.js"), "utf8"), "old-current");
    assert.equal(await fs.readFile(path.join(fixture.appDir, "public", "assets", "new-current.js"), "utf8"), "new-current");
    await assert.rejects(fs.access(path.join(fixture.appDir, "public", "assets", "retained-older.js")));
    assert.equal(await fs.readFile(path.join(fixture.appDir, ".retained-update-assets"), "utf8"), "assets/old-current.js\n");
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