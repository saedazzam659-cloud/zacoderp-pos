import { Router } from "express";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { extractAuth } from "../middleware/auth.js";
import { logger } from "../lib/logger.js";

const execFileAsync = promisify(execFile);
const router = Router();

type AgentConfig = {
  mode?: string;
  localSuperadminEnabled?: boolean;
  domain?: string;
  installationId?: string;
  licenseKey?: string;
  centralOrigin?: string;
};

type UpdateState =
  | "idle"
  | "queued"
  | "downloading"
  | "verifying"
  | "installing"
  | "restarting"
  | "rolling_back"
  | "completed"
  | "rolled_back"
  | "failed";

type PersistedUpdateStatus = {
  state: UpdateState;
  message: string;
  targetVersion?: string;
  updatedAt: string;
};

type ManualManifest = {
  version: string;
  sizeBytes: number;
  sha256: string;
  publishedAt?: string;
};

type AgentPaths = {
  configPath: string;
  rootDir: string;
  appDir: string;
  versionFile: string;
  statusFile: string;
  dispatchLock: string;
  updateLock: string;
};

const BUSY_STATES = new Set<UpdateState>([
  "queued",
  "downloading",
  "verifying",
  "installing",
  "restarting",
  "rolling_back",
]);
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;

function agentPaths(): AgentPaths {
  const configPath = process.env.ZACOD_AGENT_CONFIG || "/opt/zacod/config.json";
  const rootDir = path.dirname(configPath);
  const appDir = process.env.ZACOD_APP_DIR || path.join(rootDir, "app");
  return {
    configPath,
    rootDir,
    appDir,
    versionFile: path.join(appDir, "VERSION"),
    statusFile: path.join(rootDir, "update-status.json"),
    dispatchLock: path.join(rootDir, "manual-update.dispatch"),
    updateLock: path.join(rootDir, "manual-update.lock"),
  };
}

function safeText(value: unknown, max = 240): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readAgentConfig(): Promise<{ config: AgentConfig; paths: AgentPaths } | null> {
  const paths = agentPaths();
  const config = await readJson<AgentConfig>(paths.configPath);
  if (
    !config ||
    config.mode !== "full" ||
    config.localSuperadminEnabled === false ||
    !/^[A-Za-z0-9._-]{8,200}$/.test(safeText(config.installationId, 200)) ||
    !/^[A-Za-z0-9._-]{8,500}$/.test(safeText(config.licenseKey, 500)) ||
    !safeText(config.centralOrigin, 1000)
  ) {
    return null;
  }
  try {
    const origin = new URL(config.centralOrigin!);
    if (origin.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { config, paths };
}

async function readCurrentVersion(paths: AgentPaths): Promise<string> {
  try {
    return (await fs.readFile(paths.versionFile, "utf8")).trim().slice(0, 80) || "unknown";
  } catch {
    return "unknown";
  }
}

async function readUpdateStatus(paths: AgentPaths): Promise<PersistedUpdateStatus> {
  const parsed = await readJson<PersistedUpdateStatus>(paths.statusFile);
  if (!parsed || typeof parsed.state !== "string" || typeof parsed.updatedAt !== "string") {
    return { state: "idle", message: "لا توجد عملية تحديث جارية", updatedAt: new Date(0).toISOString() };
  }
  // A killed transient unit must not leave the UI saying "جاري التحديث"
  // forever. The file lock below still provides the hard concurrency guard.
  if (BUSY_STATES.has(parsed.state)) {
    const ageMs = Date.now() - new Date(parsed.updatedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs > 30 * 60_000) {
      return {
        state: "failed",
        message: "انتهت مهلة عملية التحديث السابقة. يمكنك المحاولة مجددًا.",
        targetVersion: parsed.targetVersion,
        updatedAt: new Date().toISOString(),
      };
    }
  }
  return parsed;
}

async function writeUpdateStatus(paths: AgentPaths, status: PersistedUpdateStatus): Promise<void> {
  await fs.mkdir(paths.rootDir, { recursive: true });
  const tmp = `${paths.statusFile}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(status), { mode: 0o600 });
  await fs.rename(tmp, paths.statusFile);
}

function manualManifestUrl(config: AgentConfig): URL {
  const url = new URL("/api/agent/release/manifest", config.centralOrigin);
  url.searchParams.set("manual", "1");
  return url;
}

function manualBundleUrl(config: AgentConfig, version: string): URL {
  const url = new URL("/api/agent/release/bundle", config.centralOrigin);
  url.searchParams.set("manual", "1");
  url.searchParams.set("version", version);
  return url;
}

async function fetchManualManifest(config: AgentConfig): Promise<ManualManifest> {
  const response = await fetch(manualManifestUrl(config), {
    headers: {
      Accept: "application/json",
      "X-Zacod-Installation-Id": config.installationId!,
      "X-Zacod-License-Key": config.licenseKey!,
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(response.status === 403 ? "ترخيص الوكيل غير صالح أو موقوف" : "تعذّر فحص التحديثات من المنصة");
  }
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("استجابة التحديثات غير صالحة");
  }
  const version = safeText(body?.version, 80);
  const sha256 = safeText(body?.sha256, 80).toLowerCase();
  const sizeBytes = Number(body?.sizeBytes);
  if (
    !/^[a-f0-9]{16}$/.test(version) ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_BUNDLE_BYTES
  ) {
    throw new Error("بيانات حزمة التحديث غير مكتملة");
  }
  return {
    version,
    sha256,
    sizeBytes,
    publishedAt: safeText(body?.publishedAt, 80) || undefined,
  };
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the one-shot root updater. It runs in a separate transient systemd
 * unit so restarting zacod-app cannot kill its own health-check/rollback.
 */
export function buildManualUpdateScript(args: {
  paths: AgentPaths;
  manifest: ManualManifest;
  bundleUrl: string;
  scriptPath: string;
  healthAttempts?: number;
  healthDelaySeconds?: number;
}): string {
  const { paths, manifest, bundleUrl, scriptPath } = args;
  const healthAttempts = Math.max(1, Math.min(120, Math.floor(args.healthAttempts ?? 45)));
  const healthDelaySeconds = Math.max(0, Math.min(30, Math.floor(args.healthDelaySeconds ?? 2)));
  const tmpBundle = path.join(paths.rootDir, `.manual-update-${manifest.version}.tgz`);
  const authFile = path.join(paths.rootDir, `.manual-update-auth-${manifest.version}.curl`);
  const newDir = `${paths.appDir}.new`;
  const oldDir = `${paths.appDir}.old`;
  const failedDir = `${paths.appDir}.failed`;
  return `#!/usr/bin/env bash
set -Eeuo pipefail
STATUS_FILE=${shQuote(paths.statusFile)}
DISPATCH_LOCK=${shQuote(paths.dispatchLock)}
UPDATE_LOCK=${shQuote(paths.updateLock)}
APP_DIR=${shQuote(paths.appDir)}
NEW_DIR=${shQuote(newDir)}
OLD_DIR=${shQuote(oldDir)}
FAILED_DIR=${shQuote(failedDir)}
BUNDLE_FILE=${shQuote(tmpBundle)}
AUTH_FILE=${shQuote(authFile)}
CONFIG_FILE=${shQuote(paths.configPath)}
SCRIPT_FILE=${shQuote(scriptPath)}
TARGET_VERSION=${shQuote(manifest.version)}
EXPECTED_SHA=${shQuote(manifest.sha256)}
EXPECTED_SIZE=${manifest.sizeBytes}
MAX_BUNDLE_SIZE=${MAX_BUNDLE_BYTES}
BUNDLE_URL=${shQuote(bundleUrl)}
SWAPPED=0

write_status() {
  UPDATE_STATE="$1" UPDATE_MESSAGE="$2" UPDATE_VERSION="$TARGET_VERSION" STATUS_FILE="$STATUS_FILE" node - <<'NODE'
const fs = require("node:fs");
const path = process.env.STATUS_FILE;
const tmp = path + ".tmp-" + process.pid;
fs.writeFileSync(tmp, JSON.stringify({
  state: process.env.UPDATE_STATE,
  message: process.env.UPDATE_MESSAGE,
  targetVersion: process.env.UPDATE_VERSION,
  updatedAt: new Date().toISOString()
}), { mode: 0o600 });
fs.renameSync(tmp, path);
NODE
}

health_ok() {
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8080/api/healthz 2>/dev/null || true)
  [ "$code" = "200" ]
}

cleanup() {
  rm -f "$BUNDLE_FILE" "$AUTH_FILE" "$DISPATCH_LOCK" "$SCRIPT_FILE"
}

rollback() {
  set +e
  write_status "rolling_back" "فشل تشغيل النسخة الجديدة — جارٍ الرجوع للنسخة السابقة"
  systemctl stop zacod-app
  rm -rf "$FAILED_DIR"
  [ -d "$APP_DIR" ] && mv "$APP_DIR" "$FAILED_DIR"
  if [ -d "$OLD_DIR" ]; then
    mv "$OLD_DIR" "$APP_DIR"
    systemctl start zacod-app
    for _ in $(seq 1 ${healthAttempts}); do
      sleep ${healthDelaySeconds}
      health_ok && {
        write_status "rolled_back" "تعذر تثبيت التحديث وتمت استعادة النسخة السابقة بنجاح"
        cleanup
        exit 1
      }
    done
  fi
  write_status "failed" "فشل التحديث وتعذر تشغيل النسخة السابقة تلقائيًا"
  cleanup
  exit 1
}

on_error() {
  local rc=$?
  trap - ERR
  if [ "$SWAPPED" = "1" ]; then rollback; fi
  set +e
  write_status "failed" "فشل تنزيل أو تجهيز التحديث؛ لم تتغير النسخة الحالية"
  cleanup
  exit "$rc"
}
trap on_error ERR

exec 9>"$UPDATE_LOCK"
if ! flock -n 9; then
  write_status "failed" "توجد عملية تحديث أخرى جارية"
  cleanup
  exit 1
fi
[ ! -f ${shQuote(path.join(paths.rootDir, "SUSPENDED"))} ]

write_status "downloading" "جارٍ تنزيل حزمة التحديث"
CONFIG_FILE="$CONFIG_FILE" AUTH_FILE="$AUTH_FILE" node - <<'NODE'
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG_FILE, "utf8"));
const installationId = String(cfg.installationId || "");
const licenseKey = String(cfg.licenseKey || "");
if (!/^[A-Za-z0-9._-]{8,200}$/.test(installationId) || !/^[A-Za-z0-9._-]{8,500}$/.test(licenseKey)) {
  throw new Error("invalid release credentials");
}
fs.writeFileSync(process.env.AUTH_FILE, [
  'header = "X-Zacod-Installation-Id: ' + installationId + '"',
  'header = "X-Zacod-License-Key: ' + licenseKey + '"',
  ""
].join("\\n"), { mode: 0o600 });
NODE
curl --config "$AUTH_FILE" -fsS --retry 2 --connect-timeout 15 --max-time 300 \\
  --max-filesize "$MAX_BUNDLE_SIZE" "$BUNDLE_URL" \\
  | head -c "$((MAX_BUNDLE_SIZE + 1))" > "$BUNDLE_FILE"

write_status "verifying" "جارٍ التحقق من سلامة الحزمة"
ACTUAL_SIZE=$(stat -c '%s' "$BUNDLE_FILE")
[ "$ACTUAL_SIZE" -eq "$EXPECTED_SIZE" ]
[ "$ACTUAL_SIZE" -le "$MAX_BUNDLE_SIZE" ]
ACTUAL_SHA=$(sha256sum "$BUNDLE_FILE" | awk '{print $1}')
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]
tar -tzf "$BUNDLE_FILE" >/dev/null

write_status "installing" "جارٍ تجهيز النسخة الجديدة"
rm -rf "$NEW_DIR"
mkdir -p "$NEW_DIR"
tar -xzf "$BUNDLE_FILE" -C "$NEW_DIR"
[ -f "$NEW_DIR/index.mjs" ]
[ -f "$NEW_DIR/public/index.html" ]
echo "$TARGET_VERSION" > "$NEW_DIR/VERSION"

rm -rf "$OLD_DIR" "$FAILED_DIR"
mv "$APP_DIR" "$OLD_DIR"
mv "$NEW_DIR" "$APP_DIR"
SWAPPED=1
write_status "restarting" "تم تثبيت الملفات — جارٍ إعادة تشغيل الخدمة"
systemctl restart zacod-app

HEALTHY=0
for _ in $(seq 1 ${healthAttempts}); do
  sleep ${healthDelaySeconds}
  if health_ok; then HEALTHY=1; break; fi
done
[ "$HEALTHY" = "1" ]

SWAPPED=0
write_status "completed" "تم تثبيت التحديث وتشغيل الخدمة بنجاح"
cleanup
exit 0
`;
}

async function acquireDispatchLock(paths: AgentPaths): Promise<boolean> {
  try {
    const handle = await fs.open(paths.dispatchLock, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    await handle.close();
    return true;
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const stat = await fs.stat(paths.dispatchLock);
      if (Date.now() - stat.mtimeMs > 30 * 60_000) {
        await fs.rm(paths.dispatchLock, { force: true });
        return acquireDispatchLock(paths);
      }
    } catch {
      return acquireDispatchLock(paths);
    }
    return false;
  }
}

router.use(extractAuth);
router.use((req, res, next) => {
  // Updating this service restarts every tenant hosted on the agent. A company
  // admin must never be able to interrupt other companies on the same server.
  if (req.authUser?.role !== "superadmin") {
    res.status(req.authUser ? 403 : 401).json({ error: "التحديث متاح لمسؤول خادم الوكيل فقط" });
    return;
  }
  next();
});

router.get("/status", async (_req, res) => {
  const local = await readAgentConfig();
  if (!local) {
    res.status(404).json({ error: "هذه الخدمة ليست خادم وكيل كاملًا" });
    return;
  }
  try {
    const [manifest, currentVersion, operation] = await Promise.all([
      fetchManualManifest(local.config),
      readCurrentVersion(local.paths),
      readUpdateStatus(local.paths),
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      currentVersion,
      availableVersion: manifest.version,
      sizeBytes: manifest.sizeBytes,
      publishedAt: manifest.publishedAt ?? null,
      updateAvailable: currentVersion !== manifest.version,
      operation,
    });
  } catch (error: any) {
    res.status(502).json({ error: safeText(error?.message, 300) || "تعذّر فحص التحديثات" });
  }
});

router.post("/apply", async (req, res) => {
  const local = await readAgentConfig();
  if (!local) {
    res.status(404).json({ error: "هذه الخدمة ليست خادم وكيل كاملًا" });
    return;
  }
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "يلزم تأكيد إعادة تشغيل خادم الوكيل" });
    return;
  }
  let dispatchAcquired = false;
  try {
    const manifest = await fetchManualManifest(local.config);
    const requestedVersion = safeText(req.body?.version, 80);
    if (requestedVersion && requestedVersion !== manifest.version) {
      res.status(409).json({ error: "تغير الإصدار المتاح — افحص التحديثات مرة أخرى" });
      return;
    }
    const currentVersion = await readCurrentVersion(local.paths);
    if (currentVersion === manifest.version) {
      res.status(409).json({ error: "الخادم يعمل بالفعل بأحدث إصدار" });
      return;
    }
    dispatchAcquired = await acquireDispatchLock(local.paths);
    if (!dispatchAcquired) {
      res.status(409).json({ error: "توجد عملية تحديث جارية بالفعل" });
      return;
    }

    const scriptPath = path.join(local.paths.rootDir, `.manual-update-${Date.now()}.sh`);
    const script = buildManualUpdateScript({
      paths: local.paths,
      manifest,
      bundleUrl: manualBundleUrl(local.config, manifest.version).toString(),
      scriptPath,
    });
    await fs.writeFile(scriptPath, script, { mode: 0o700 });
    await writeUpdateStatus(local.paths, {
      state: "queued",
      message: "تمت الموافقة — سيبدأ التحديث خلال لحظات",
      targetVersion: manifest.version,
      updatedAt: new Date().toISOString(),
    });
    const unit = `zacod-manual-update-${Date.now()}`;
    await execFileAsync("systemd-run", [
      "--unit", unit,
      "--collect",
      "--property=TimeoutStartSec=15min",
      "/bin/bash",
      scriptPath,
    ], { timeout: 15_000 });
    res.status(202).json({ started: true, targetVersion: manifest.version });
  } catch (error: any) {
    if (dispatchAcquired) await fs.rm(local.paths.dispatchLock, { force: true }).catch(() => {});
    logger.error({ err: error }, "manual agent update dispatch failed");
    res.status(502).json({ error: safeText(error?.message, 300) || "تعذّر بدء التحديث" });
  }
});

export function stripLegacyUpdateCron(crontab: string): string {
  return crontab
    .split(/\r?\n/)
    .filter((line) => !line.includes("zacod-update") && !line.includes("/opt/zacod/update.sh"))
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * One-time migration for full-agent servers. It is intentionally a no-op on
 * central/dev hosts. Existing legacy cron entries are removed before the app
 * starts serving; future updates are only dispatched by the authenticated API.
 */
export async function disableLegacyAgentAutoUpdater(): Promise<void> {
  const local = await readAgentConfig();
  if (!local || local.paths.rootDir !== "/opt/zacod") return;
  try {
    let existing = "";
    try {
      const result = await execFileAsync("crontab", ["-l"], { timeout: 5_000 });
      existing = result.stdout;
    } catch {
      existing = "";
    }
    const filtered = stripLegacyUpdateCron(existing);
    if (filtered !== existing.replace(/\n+$/, "")) {
      const tmp = path.join(local.paths.rootDir, `.crontab-manual-${process.pid}`);
      await fs.writeFile(tmp, filtered ? `${filtered}\n` : "", { mode: 0o600 });
      try {
        await execFileAsync("crontab", [tmp], { timeout: 5_000 });
      } finally {
        await fs.rm(tmp, { force: true });
      }
      logger.info("disabled legacy automatic agent update cron");
    }
    await fs.rm(path.join(local.paths.rootDir, "update.sh"), { force: true });
  } catch (error) {
    // The central manifest gate still makes the legacy cron a no-op. Log this
    // for operator repair, but never block the agent app from starting.
    logger.warn({ err: error }, "failed to remove legacy agent update cron");
  }
}

export default router;