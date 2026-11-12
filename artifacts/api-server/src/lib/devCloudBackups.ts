import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { lookup } from "node:dns/promises";
import { createHash as createSha256 } from "node:crypto";
import { Client } from "ssh2";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import path from "node:path";
import os from "node:os";
import { ObjectStorageService } from "./objectStorage.js";
import { decryptSecret } from "./encryption.js";
import type { agentInstancesTable } from "@workspace/db";

const execFileAsync = promisify(execFile);
const storage = new ObjectStorageService();
const BACKUP_LIMIT_BYTES = 1_800_000_000;
const HASH_CHUNK = 128 * 1024;
const RESTORE_HEALTH_ATTEMPTS = 45;
const RESTORE_HEALTH_DELAY_SECONDS = 2;

type Agent = typeof agentInstancesTable.$inferSelect;
type BackupCrypto = { salt: string; iv: string; tag: string };
type BackupRow = {
  id: number;
  objectPath: string;
  bundleSha256: string;
  encryptedSha256: string;
  bundleSizeBytes: number;
  encryptionSalt: string;
  encryptionIv: string;
  encryptionTag: string;
  releaseVersion: string;
  releaseSha256: string;
};

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function hashTransform(hash: ReturnType<typeof createHash>): Transform {
  return new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

function encryptionKey(salt: Buffer): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new Error("مفتاح تشفير النسخ الاحتياطية غير مضبوط");
  return scryptSync(secret, Buffer.concat([Buffer.from("dev-cloud-backup-v1:"), salt]), 32);
}

function objectKeyForBackup(id: number): string {
  return `dev-cloud-backups/${id}/snapshot-${randomBytes(12).toString("hex")}.enc`;
}

function privateKeyFromObjectPath(objectPath: string): string {
  if (!objectPath.startsWith("/objects/")) throw new Error("مسار النسخة غير صالح");
  const key = objectPath.slice("/objects/".length);
  if (!key || key.includes("..") || !/^[A-Za-z0-9/_\-.]+$/.test(key)) {
    throw new Error("مسار النسخة غير صالح");
  }
  return key;
}

export async function createEncryptedBackupObject(
  inputPath: string,
  backupId: number,
): Promise<{
  objectPath: string;
  bundleSha256: string;
  encryptedSha256: string;
  bundleSizeBytes: number;
  crypto: BackupCrypto;
}> {
  const info = await fs.stat(inputPath);
  if (!info.isFile() || info.size <= 0 || info.size > BACKUP_LIMIT_BYTES) {
    throw new Error("حجم النسخة غير صالح أو يتجاوز الحد 1.8 جيجابايت");
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(salt), iv);
  const rawHash = createHash("sha256");
  const encryptedHash = createHash("sha256");
  const key = objectKeyForBackup(backupId);
  const file = storage.getPrivateObjectFile(key);
  try {
    await pipeline(
      createReadStream(inputPath, { highWaterMark: HASH_CHUNK }),
      hashTransform(rawHash),
      cipher,
      hashTransform(encryptedHash),
      file.createWriteStream({
        resumable: false,
        metadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
      }) as any,
    );
    const [metadata] = await file.getMetadata();
    const encryptedSize = Number(metadata.size);
    if (!Number.isSafeInteger(encryptedSize) || encryptedSize !== info.size) {
      throw new Error("تعذّر التحقق من حجم النسخة المخزنة");
    }
    return {
      objectPath: `/objects/${key}`,
      bundleSha256: rawHash.digest("hex"),
      encryptedSha256: encryptedHash.digest("hex"),
      bundleSizeBytes: info.size,
      crypto: { salt: salt.toString("hex"), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") },
    };
  } catch (error) {
    await file.delete({ ignoreNotFound: true }).catch(() => {});
    throw error;
  }
}

async function verifiedEncryptedRead(row: BackupRow, outputPath: string): Promise<void> {
  const file = storage.getPrivateObjectFile(privateKeyFromObjectPath(row.objectPath));
  const [exists] = await file.exists();
  if (!exists) throw new Error("ملف النسخة غير موجود في التخزين");
  const [metadata] = await file.getMetadata();
  const encryptedSize = Number(metadata.size);
  if (!Number.isSafeInteger(encryptedSize) || encryptedSize !== row.bundleSizeBytes
      || encryptedSize <= 0 || encryptedSize > BACKUP_LIMIT_BYTES) {
    throw new Error("حجم النسخة المخزنة لا يطابق بياناتها");
  }
  const salt = Buffer.from(row.encryptionSalt, "hex");
  const iv = Buffer.from(row.encryptionIv, "hex");
  const tag = Buffer.from(row.encryptionTag, "hex");
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) {
    throw new Error("بيانات تشفير النسخة غير صالحة");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(salt), iv);
  decipher.setAuthTag(tag);
  const encryptedHash = createHash("sha256");
  const rawHash = createHash("sha256");
  try {
    await pipeline(
      file.createReadStream(),
      hashTransform(encryptedHash),
      decipher,
      hashTransform(rawHash),
      createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
    );
    if (encryptedHash.digest("hex") !== row.encryptedSha256 || rawHash.digest("hex") !== row.bundleSha256) {
      throw new Error("بصمة النسخة غير مطابقة");
    }
  } catch {
    await fs.rm(outputPath, { force: true }).catch(() => {});
    throw new Error("فشل فك تشفير النسخة أو التحقق من سلامتها");
  }
}

export async function materializeVerifiedBackup(
  row: BackupRow,
): Promise<{ dir: string; bundlePath: string; runtimeReleasePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dev-cloud-backup-"));
  const bundlePath = path.join(dir, "snapshot.tar.gz");
  try {
    await verifiedEncryptedRead(row, bundlePath);
    const listing = await execFileAsync("tar", ["-tzf", bundlePath], {
      timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    const entries = String(listing.stdout).split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/^\.\//, ""));
    const required = new Set(["manifest.json", "runtime-release.tgz", "database.dump"]);
    // Older v1 archives included this source snapshot. Accept it for compatibility,
    // but never extract or restore it; code restore uses only the runtime release.
    const allowed = new Set([...required, "source-code.tar.gz"]);
    if (entries.some((entry) => entry.includes("..") || entry.startsWith("/") || !allowed.has(entry))) {
      throw new Error("محتويات النسخة غير آمنة");
    }
    for (const requiredEntry of required) {
      if (!entries.includes(requiredEntry)) throw new Error("النسخة لا تحتوي كل الملفات المطلوبة");
    }
    await execFileAsync("tar", [
      "--no-same-owner", "--no-same-permissions", "-xzf", bundlePath, "-C", dir,
      "runtime-release.tgz", "manifest.json",
    ], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
    const runtimeSha256 = await sha256File(path.join(dir, "runtime-release.tgz"));
    if (manifest.format !== "zacod-dev-cloud-backup-v1"
        || manifest.releaseVersion !== row.releaseVersion
        || manifest.releaseSha256 !== row.releaseSha256
        || runtimeSha256 !== row.releaseSha256
        || row.releaseVersion !== row.releaseSha256.slice(0, 16)
        || manifest.databaseRestorePolicy !== "never-import-during-code-restore") {
      throw new Error("بيانات إصدار النسخة لا تطابق الحزمة");
    }
    return {
      dir,
      bundlePath,
      runtimeReleasePath: path.join(dir, "runtime-release.tgz"),
    };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function buildBackupBundle(input: {
  workDir: string;
  releaseArchivePath: string;
  databaseDumpPath: string;
  releaseVersion: string;
  releaseSha256: string;
  sourceLabel: string;
  sourceType: "central" | "agent";
  sourceAgentId: number | null;
}): Promise<{ bundlePath: string; sourceSha256: string; databaseSha256: string }> {
  const sourceSha256 = await sha256File(input.releaseArchivePath);
  if (sourceSha256 !== input.releaseSha256) throw new Error("بصمة إصدار التطبيق لا تطابق الحزمة");
  const databaseSha256 = await sha256File(input.databaseDumpPath);
  const manifest = {
    format: "zacod-dev-cloud-backup-v1",
    createdAt: new Date().toISOString(),
    sourceType: input.sourceType,
    sourceAgentId: input.sourceAgentId,
    sourceLabel: input.sourceLabel,
    releaseVersion: input.releaseVersion,
    releaseSha256: input.releaseSha256,
    sourceSha256,
    databaseSha256,
    databaseRestorePolicy: "never-import-during-code-restore",
  };
  await fs.writeFile(path.join(input.workDir, "manifest.json"), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
  const bundlePath = path.join(input.workDir, "developer-cloud-backup.tar.gz");
  await execFileAsync("tar", [
    "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
    "--format=gnu", "-czf", bundlePath, "-C", input.workDir,
    "manifest.json",
    "runtime-release.tgz",
    "database.dump",
  ], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
  const size = (await fs.stat(bundlePath)).size;
  if (!Number.isSafeInteger(size) || size <= 0 || size > BACKUP_LIMIT_BYTES) {
    throw new Error("حجم حزمة النسخة يتجاوز الحد المسموح 1.8 جيجابايت");
  }
  return { bundlePath, sourceSha256, databaseSha256 };
}

function pgEnvironment(rawUrl: string, overrides: { host?: string; port?: number; sslmode?: string } = {}): NodeJS.ProcessEnv {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new Error("رابط قاعدة البيانات غير صالح"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("مصدر النسخ يجب أن يكون PostgreSQL");
  }
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!dbName) throw new Error("اسم قاعدة البيانات غير موجود");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: overrides.host ?? parsed.hostname,
    PGPORT: String(overrides.port ?? Number(parsed.port || 5432)),
    PGDATABASE: dbName,
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGCONNECT_TIMEOUT: parsed.searchParams.get("connect_timeout") ?? "10",
    PGSSLMODE: overrides.sslmode ?? parsed.searchParams.get("sslmode") ?? "prefer",
  };
  for (const [param, key] of [
    ["sslrootcert", "PGSSLROOTCERT"],
    ["sslcert", "PGSSLCERT"],
    ["sslkey", "PGSSLKEY"],
    ["application_name", "PGAPPNAME"],
  ]) {
    const value = parsed.searchParams.get(param);
    if (value) env[key] = value;
  }
  return env;
}

export async function dumpPostgresDatabase(
  databaseUrl: string,
  outputPath: string,
  agent?: Agent,
): Promise<void> {
  const args = [
    "--format=custom", "--no-owner", "--no-privileges", "--no-comments",
    "--exclude-table=public.dev_cloud_backups",
    "--exclude-table=public.dev_cloud_backup_operations",
    "--no-password", "--file", outputPath,
  ];
  try {
    await execFileAsync("pg_dump", args, {
      env: pgEnvironment(databaseUrl),
      timeout: 15 * 60_000,
      maxBuffer: 1024 * 1024,
    });
    return;
  } catch {
    if (!agent) throw new Error("فشل إنشاء نسخة قاعدة البيانات المركزية");
  }

  const tunnel = await openAgentDatabaseTunnel(agent!, databaseUrl);
  try {
    await execFileAsync("pg_dump", args, {
      env: pgEnvironment(databaseUrl, { host: "127.0.0.1", port: tunnel.port, sslmode: "disable" }),
      timeout: 15 * 60_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error("تعذر إنشاء نسخة قاعدة بيانات الوكيل عبر الاتصال المباشر أو نفق SSH");
  } finally {
    await tunnel.close();
  }
}

function isPublicAddress(address: string): boolean {
  if (address.includes(":")) {
    const ip = address.toLowerCase();
    return ip !== "::" && ip !== "::1" && !ip.startsWith("fc") && !ip.startsWith("fd")
      && !ip.startsWith("fe8") && !ip.startsWith("fe9") && !ip.startsWith("fea")
      && !ip.startsWith("feb") && !ip.startsWith("ff")
      && !ip.startsWith("::ffff:127.") && !ip.startsWith("::ffff:10.")
      && !ip.startsWith("::ffff:192.168.");
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a !== 0 && a !== 10 && a !== 127 && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
    && !(a === 100 && b >= 64 && b <= 127) && a < 224;
}

async function resolvePinnedAgentHost(host: string): Promise<string> {
  const rows = await lookup(host, { all: true, verbatim: true }).catch(() => []);
  const address = rows.find((row) => isPublicAddress(row.address))?.address;
  if (!address || rows.some((row) => !isPublicAddress(row.address))) {
    throw new Error("عنوان سيرفر الوكيل غير عام أو غير صالح");
  }
  return address;
}

function fingerprint(key: Buffer): string {
  return `SHA256:${createSha256("sha256").update(key).digest("base64")}`;
}

async function withAgentSsh<T>(agent: Agent, work: (client: Client) => Promise<T>): Promise<T> {
  if (agent.status !== "active" || agent.mode !== "full") {
    throw new Error("اختر سيرفر وكيل كاملًا ونشطًا");
  }
  if (!agent.sshHost || !agent.sshUser || !agent.sshSecretEnc || !agent.sshHostKeyFp) {
    throw new Error("احفظ بيانات SSH واختبر بصمة الخادم أولًا من شاشة سيرفرات الوكلاء");
  }
  const address = await resolvePinnedAgentHost(agent.sshHost);
  const secret = decryptSecret(agent.sshSecretEnc);
  if (!secret) throw new Error("تعذر قراءة بيانات اتصال الوكيل");
  const isKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secret);
  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.end();
      reject(new Error("انتهت مهلة اتصال SSH"));
    }, 20_000);
    client.once("ready", () => { clearTimeout(timer); resolve(); });
    client.once("error", (error) => { clearTimeout(timer); reject(error); });
    client.connect({
      host: address,
      port: agent.sshPort ?? 22,
      username: agent.sshUser!,
      ...(isKey ? { privateKey: secret } : { password: secret }),
      readyTimeout: 15_000,
      hostVerifier: (key: Buffer) => fingerprint(key) === agent.sshHostKeyFp,
    });
  });
  try {
    return await work(client);
  } finally {
    client.end();
  }
}

async function openAgentDatabaseTunnel(
  agent: Agent,
  databaseUrl: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  if (!agent.sshHost || !agent.sshUser || !agent.sshSecretEnc || !agent.sshHostKeyFp) {
    throw new Error("بيانات SSH أو بصمة الخادم غير مكتملة");
  }
  const address = await resolvePinnedAgentHost(agent.sshHost);
  const secret = decryptSecret(agent.sshSecretEnc);
  if (!secret) throw new Error("تعذر قراءة بيانات اتصال الوكيل");
  const dbUrl = new URL(databaseUrl);
  const isKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secret);
  const client = new Client();
  let server: ReturnType<typeof createServer> | null = null;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.end();
      reject(new Error("انتهت مهلة اتصال SSH"));
    }, 20_000);
    client.once("ready", () => { clearTimeout(timer); resolve(); });
    client.once("error", (error) => { clearTimeout(timer); reject(error); });
    client.connect({
      host: address,
      port: agent.sshPort ?? 22,
      username: agent.sshUser!,
      ...(isKey ? { privateKey: secret } : { password: secret }),
      readyTimeout: 15_000,
      keepaliveInterval: 10_000,
      hostVerifier: (key: Buffer) => fingerprint(key) === agent.sshHostKeyFp,
    });
  });
  try {
    const dbRows = await lookup(dbUrl.hostname, { all: true, verbatim: true }).catch(() => []);
    const sshRows = await lookup(agent.sshHost, { all: true, verbatim: true }).catch(() => []);
    const targetHost = dbRows.some((db) => sshRows.some((ssh) => db.address === ssh.address))
      ? "127.0.0.1"
      : dbUrl.hostname;
    server = createServer((localSocket) => {
      client.forwardOut("127.0.0.1", 0, targetHost, Number(dbUrl.port || 5432), (error, remoteSocket) => {
        if (error) { localSocket.destroy(error); return; }
        localSocket.pipe(remoteSocket).pipe(localSocket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const addressInfo = server.address();
    if (!addressInfo || typeof addressInfo === "string") throw new Error("تعذر فتح نفق قاعدة البيانات");
    return {
      port: addressInfo.port,
      close: async () => {
        await new Promise<void>((resolve) => {
          if (!server?.listening) { resolve(); return; }
          server.close(() => resolve());
        });
        client.end();
      },
    };
  } catch (error) {
    server?.close();
    client.end();
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function execRemote(client: Client, command: string, stdin = ""): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) { reject(error); return; }
      let output = "";
      const append = (chunk: Buffer) => {
        if (output.length < 32_000) output += chunk.toString().slice(0, 32_000 - output.length);
      };
      stream.on("data", append);
      stream.stderr.on("data", append);
      stream.on("close", (code: number) => resolve({ code: code ?? 1, output }));
      stream.end(stdin);
    });
  });
}

async function uploadSftp(client: Client, localPath: string, remotePath: string): Promise<void> {
  const sftp = await new Promise<any>((resolve, reject) =>
    client.sftp((error, value) => error ? reject(error) : resolve(value)));
  try {
    await new Promise<void>((resolve, reject) =>
      sftp.fastPut(localPath, remotePath, { concurrency: 1, chunkSize: 128 * 1024 },
        (error: Error | undefined) => error ? reject(error) : resolve()));
  } finally {
    sftp.end();
  }
}

async function runRootScript(client: Client, agent: Agent, script: string): Promise<string> {
  const secret = decryptSecret(agent.sshSecretEnc);
  if (!secret) throw new Error("تعذر قراءة بيانات اتصال الوكيل");
  const isKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secret);
  let command = agent.sshUser === "root" ? "bash -s" : "sudo -n bash -s";
  let stdin = script;
  if (agent.sshUser !== "root") {
    const probe = await execRemote(client, "sudo -n true >/dev/null 2>&1");
    if (probe.code !== 0) {
      if (isKey) throw new Error("مستخدم SSH يحتاج sudo بدون كلمة مرور");
      command = "sudo -S -p '' bash -s";
      stdin = `${secret}\n${script}`;
    }
  }
  const result = await execRemote(client, command, stdin);
  if (result.code !== 0) throw new Error(result.output.slice(-800) || "فشل تنفيذ العملية على الوكيل");
  return result.output;
}

export async function uploadEncryptedBackupToAgent(input: {
  agent: Agent;
  backupId: number;
  row: BackupRow;
}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dev-cloud-upload-"));
  const localPath = path.join(dir, "backup.enc");
  try {
    const file = storage.getPrivateObjectFile(privateKeyFromObjectPath(input.row.objectPath));
    const [metadata] = await file.getMetadata();
    if (Number(metadata.size) !== input.row.bundleSizeBytes) throw new Error("حجم النسخة غير مطابق");
    const hash = createHash("sha256");
    await pipeline(file.createReadStream(), hashTransform(hash), createWriteStream(localPath, { mode: 0o600 }));
    if (hash.digest("hex") !== input.row.encryptedSha256) throw new Error("بصمة النسخة المشفرة غير مطابقة");
    const remoteName = `dev-cloud-backup-${input.backupId}.enc`;
    const remoteTemp = `/tmp/${remoteName}.${randomBytes(6).toString("hex")}`;
    const remoteFinal = `/opt/zacod/backups/dev-cloud/${remoteName}`;
    await withAgentSsh(input.agent, async (client) => {
      await uploadSftp(client, localPath, remoteTemp);
      await runRootScript(client, input.agent, `set -Eeuo pipefail
mkdir -p /opt/zacod/backups/dev-cloud
chmod 700 /opt/zacod/backups/dev-cloud
install -o root -g root -m 600 ${shellQuote(remoteTemp)} ${shellQuote(remoteFinal)}
rm -f ${shellQuote(remoteTemp)}
test -s ${shellQuote(remoteFinal)}
echo ZACOD_DEV_CLOUD_BACKUP_SAVED
`);
    });
    return remoteFinal;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function restoreAgentCodeFromBackup(input: {
  agent: Agent;
  backupId: number;
  row: BackupRow;
}): Promise<{ targetVersion: string }> {
  const materialized = await materializeVerifiedBackup(input.row);
  const dir = materialized.dir;
  const runtimeTemp = path.join(dir, "agent-release.tgz");
  try {
    await fs.copyFile(materialized.runtimeReleasePath, runtimeTemp);
    const releaseSha = await sha256File(runtimeTemp);
    if (releaseSha !== input.row.releaseSha256 || input.row.releaseVersion !== releaseSha.slice(0, 16)) {
      throw new Error("بصمة إصدار التطبيق لا تطابق النسخة");
    }
    const releaseListing = String((await execFileAsync("tar", ["-tzf", runtimeTemp], {
      timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    })).stdout).split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/^\.\//, ""));
    if (releaseListing.some((entry) => entry.includes("..") || entry.startsWith("/"))
        || !releaseListing.includes("index.mjs") || !releaseListing.includes("public/index.html")) {
      throw new Error("حزمة التطبيق غير صالحة للاستعادة");
    }

    const safeId = `${input.backupId}-${randomBytes(6).toString("hex")}`;
    const remoteReleaseTemp = `/tmp/dev-cloud-release-${safeId}.tgz`;
    const version = input.row.releaseVersion;
    if (!/^[a-f0-9]{8,64}$/.test(version)) throw new Error("إصدار النسخة غير صالح");
    const scriptPath = `/opt/zacod/.dev-cloud-restore-${safeId}.sh`;
    const script = `#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/opt/zacod
APP="$ROOT/app"
NEW="$ROOT/app.new"
OLD="$ROOT/app.old"
FAILED="$ROOT/backups/dev-cloud/failed-app-${safeId}"
LOCK="$ROOT/manual-update.lock"
RELEASE_TEMP=${shellQuote(remoteReleaseTemp)}
VERSION=${shellQuote(version)}
EXPECTED_SHA=${shellQuote(releaseSha)}
SCRIPT_FILE=${shellQuote(scriptPath)}
RELEASE="$ROOT/.dev-cloud-release-${safeId}.tgz"
SWAPPED=0
NEW_CREATED=0
cleanup() {
  if [ "$NEW_CREATED" = "1" ] && [ "$SWAPPED" = "0" ]; then rm -rf "$NEW"; fi
  rm -f "$RELEASE_TEMP" "$SCRIPT_FILE" "$RELEASE"
}
rollback() {
  set +e
  systemctl stop zacod-app
  rm -rf "$FAILED"
  [ ! -d "$APP" ] || mv "$APP" "$FAILED"
  if [ -d "$OLD" ]; then mv "$OLD" "$APP"; systemctl start zacod-app; fi
  rm -rf "$NEW"
  for _ in $(seq 1 ${RESTORE_HEALTH_ATTEMPTS}); do
    sleep ${RESTORE_HEALTH_DELAY_SECONDS}
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:8080/api/healthz 2>/dev/null || true)
    [ "$code" = "200" ] && break
  done
  cleanup
}
on_error() {
  rc=$?
  trap - ERR
  if [ "$SWAPPED" = "1" ]; then rollback; else cleanup; fi
  exit "$rc"
}
trap on_error ERR
exec 9>"$LOCK"
flock -n 9 || { cleanup; exit 75; }
trap on_error ERR
[ -d "$APP" ] && [ -f "$APP/index.mjs" ]
[ -f "$ROOT/app.env" ]
[ ! -e "$ROOT/SUSPENDED" ]
[ ! -e "$NEW" ]
install -d -m 700 "$ROOT/backups/dev-cloud"
mv "$RELEASE_TEMP" "$RELEASE"
ACTUAL_SHA=$(sha256sum "$RELEASE" | awk '{print $1}')
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]
mkdir -m 755 "$NEW"
NEW_CREATED=1
tar --no-same-owner --no-same-permissions -xzf "$RELEASE" -C "$NEW"
[ -f "$NEW/index.mjs" ] && [ -f "$NEW/public/index.html" ]
echo "$VERSION" > "$NEW/VERSION"
if [ -e "$OLD" ]; then mv "$OLD" "$ROOT/backups/dev-cloud/pre-restore-app-old-${safeId}"; fi
if [ -e "$FAILED" ]; then echo "Previous restore failure archive exists" >&2; exit 68; fi
mv "$APP" "$OLD"
SWAPPED=1
mv "$NEW" "$APP"
NEW_CREATED=0
systemctl restart zacod-app
HEALTHY=0
for _ in $(seq 1 ${RESTORE_HEALTH_ATTEMPTS}); do
  sleep ${RESTORE_HEALTH_DELAY_SECONDS}
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:8080/api/healthz/agent-update?version=$VERSION" 2>/dev/null || true)
  if [ "$code" = "200" ]; then HEALTHY=1; break; fi
done
[ "$HEALTHY" = "1" ]
SWAPPED=0
rm -f "$RELEASE" "$SCRIPT_FILE"
echo ZACOD_DEV_CLOUD_RESTORE_OK
`;
    await withAgentSsh(input.agent, async (client) => {
      await uploadSftp(client, runtimeTemp, remoteReleaseTemp);
      const result = await runRootScript(client, input.agent, script);
      if (!result.includes("ZACOD_DEV_CLOUD_RESTORE_OK")) throw new Error("تعذر التحقق من اكتمال استعادة التطبيق");
    });
    return { targetVersion: version };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function downloadVerifiedBackup(row: BackupRow): Promise<{
  dir: string;
  bundlePath: string;
  bundleSha256: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dev-cloud-download-"));
  const bundlePath = path.join(dir, `zacod-dev-cloud-backup-${row.id}.tar.gz`);
  try {
    await verifiedEncryptedRead(row, bundlePath);
    const bundleSha256 = await sha256File(bundlePath);
    return { dir, bundlePath, bundleSha256 };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function sanitizeBackupLabel(value: unknown): string {
  const label = String(value ?? "").trim().replace(/[\u0000-\u001f]/g, "").slice(0, 120);
  return label || `نسخة احتياطية ${new Date().toLocaleDateString("ar-EG")}`;
}

export function publicBackupRow(row: any) {
  return {
    id: row.id,
    label: row.label,
    sourceType: row.sourceType,
    sourceAgentId: row.sourceAgentId,
    sourceLabel: row.sourceLabel,
    releaseVersion: row.releaseVersion,
    sourceSha256: row.sourceSha256,
    databaseSha256: row.databaseSha256,
    bundleSizeBytes: row.bundleSizeBytes,
    status: row.status,
    error: row.error,
    createdByUsername: row.createdByUsername,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

