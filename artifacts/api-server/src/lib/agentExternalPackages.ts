import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { File } from "@google-cloud/storage";
import { ObjectStorageService } from "./objectStorage.js";

export const EXTERNAL_PACKAGE_KINDS = ["backend", "frontend", "db"] as const;
export const AGENT_DB_EXCLUDED_TABLE_DATA = [
  "agent_instances",
  "agent_servers",
  "agent_security_events",
  "zacod_installation",
  "sa_otp_codes",
  "sa_sessions",
  "sa_trusted_devices",
  "sa_login_attempts",
  "sa_recovery_codes",
  "sa_device_approvals",
] as const;
export type ExternalPackageKind = (typeof EXTERNAL_PACKAGE_KINDS)[number];
export type ExternalPackageFormat = "tgz" | "pg_custom" | "sql" | "sql_gzip";

export type ExternalPackageEntry = {
  objectPath: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  signature: string;
  uploadedAt: string;
  version: string | null;
  format: ExternalPackageFormat;
  encrypted: true;
  verified: true;
  origin: "generated" | "uploaded";
};

export type ExternalPackageMap = Partial<Record<ExternalPackageKind, ExternalPackageEntry>>;

const HEADER = Buffer.from("Salted__");
const MAX_RAW_PACKAGE_BYTES = 800 * 1024 * 1024;
export function encryptedPackageSize(rawSize: number): number {
  return 16 + (Math.floor(rawSize / 16) + 1) * 16;
}
const MAX_ENCRYPTED_PACKAGE_BYTES = encryptedPackageSize(MAX_RAW_PACKAGE_BYTES);
const storage = new ObjectStorageService();
let promotionQueue: Promise<void> = Promise.resolve();

function signingSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new Error("SESSION_SECRET غير مضبوط بشكل آمن");
  return secret;
}

export function packageSignature(input: {
  agentId: number;
  kind: ExternalPackageKind;
  sha256: string;
  sizeBytes: number;
  format: ExternalPackageFormat;
}): string {
  return createHmac("sha256", signingSecret())
    .update(`agent-package-v1:${input.agentId}:${input.kind}:${input.sha256}:${input.sizeBytes}:${input.format}`)
    .digest("hex");
}

export function verifyPackageEntry(agentId: number, kind: ExternalPackageKind, entry: ExternalPackageEntry): boolean {
  if (!entry?.encrypted || !entry?.verified || !/^[a-f0-9]{64}$/.test(entry.sha256)) return false;
  const expected = packageSignature({
    agentId,
    kind,
    sha256: entry.sha256,
    sizeBytes: entry.sizeBytes,
    format: entry.format,
  });
  const actualBuffer = Buffer.from(entry.signature ?? "", "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function keyIv(passphrase: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  const derived = pbkdf2Sync(passphrase, salt, 10_000, 48, "sha256");
  return { key: derived.subarray(0, 32), iv: derived.subarray(32, 48) };
}

async function fileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("data", chunk => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export async function objectSha256(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    file.createReadStream()
      .on("data", chunk => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export function packageObjectKey(agentId: number, kind: ExternalPackageKind, scope: "staging" | "packages"): string {
  const extension = scope === "staging" ? "upload" : "enc";
  return `agent-packages/${agentId}/${scope}/${kind}-${Date.now()}-${randomBytes(8).toString("hex")}.${extension}`;
}

export function objectPathToPrivateKey(objectPath: string): string {
  if (!objectPath.startsWith("/objects/")) throw new Error("مسار ملف غير صالح");
  const key = objectPath.slice("/objects/".length);
  if (!key || key.includes("..") || !/^[A-Za-z0-9/_\-.]+$/.test(key)) throw new Error("مسار ملف غير صالح");
  return key;
}

export async function createDirectUploadTarget(
  agentId: number,
  kind: ExternalPackageKind,
  sizeBytes: number,
  origin?: string,
) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_RAW_PACKAGE_BYTES) {
    throw new Error("حجم الملف غير صالح أو يتجاوز 800MB");
  }
  return storage.getPrivateUploadTarget(
    packageObjectKey(agentId, kind, "staging"),
    { sizeBytes, origin },
  );
}

export function privateFileForObjectPath(objectPath: string): File {
  return storage.getPrivateObjectFile(objectPathToPrivateKey(objectPath));
}

export async function encryptLocalFileToPrivateObject(
  sourcePath: string,
  objectKey: string,
  passphrase: string,
): Promise<{ objectPath: string; sizeBytes: number; sha256: string }> {
  const sourceStat = await fs.stat(sourcePath);
  if (!Number.isSafeInteger(sourceStat.size) || sourceStat.size <= 0 || sourceStat.size > MAX_RAW_PACKAGE_BYTES) {
    throw new Error("حجم الملف الخام غير صالح أو يتجاوز 800MB");
  }
  const target = storage.getPrivateObjectFile(objectKey);
  const salt = randomBytes(8);
  const { key, iv } = keyIv(passphrase, salt);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const writer = target.createWriteStream({
    resumable: false,
    metadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
  });
  writer.write(Buffer.concat([HEADER, salt]));
  await pipeline(createReadStream(sourcePath), cipher, writer);
  const [metadata] = await target.getMetadata();
  const sizeBytes = Number(metadata.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes !== encryptedPackageSize(sourceStat.size)) {
    await target.delete({ ignoreNotFound: true }).catch(() => {});
    throw new Error("فشل التحقق من حجم الحزمة المشفّرة");
  }
  return {
    objectPath: `/objects/${objectKey}`,
    sizeBytes,
    sha256: await objectSha256(target),
  };
}

function execChecked(file: string, args: string[], timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).slice(0, 400)));
      else resolve(String(stdout));
    });
  });
}

async function verifyPlainPackagePath(
  plainPath: string,
  kind: ExternalPackageKind,
): Promise<ExternalPackageFormat> {
  if (kind === "backend" || kind === "frontend") {
    const listing = await execChecked("tar", ["-tzf", plainPath]);
    const normalized = listing.split(/\r?\n/).map(v => v.replace(/^\.\//, ""));
    const required = kind === "backend" ? "index.mjs" : "index.html";
    if (!normalized.includes(required)) {
      throw new Error(kind === "backend"
        ? "حزمة Backend لا تحتوي ملف index.mjs"
        : "حزمة Frontend لا تحتوي ملف index.html");
    }
    return "tgz";
  }
  const headHandle = await fs.open(plainPath, "r");
  const head = Buffer.alloc(16);
  try {
    await headHandle.read(head, 0, 16, 0);
  } finally {
    await headHandle.close();
  }
  if (head.subarray(0, 5).toString("ascii") === "PGDMP") {
    await execChecked("pg_restore", ["--list", plainPath]);
    return "pg_custom";
  }
  if (head[0] === 0x1f && head[1] === 0x8b) {
    await execChecked("gzip", ["-t", plainPath]);
    return "sql_gzip";
  }
  const textHead = head.toString("utf8").trimStart().toUpperCase();
  if (textHead.startsWith("--") || textHead.startsWith("SET") || textHead.startsWith("CREATE")) {
    return "sql";
  }
  throw new Error("نسخة قاعدة البيانات ليست PostgreSQL dump أو SQL صالحًا");
}

export async function inspectPlainPackagePath(
  plainPath: string,
  kind: ExternalPackageKind,
): Promise<{ format: ExternalPackageFormat; sha256: string; sizeBytes: number }> {
  const stat = await fs.stat(plainPath);
  if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > MAX_RAW_PACKAGE_BYTES) {
    throw new Error("حجم الملف الخام غير صالح أو يتجاوز 800MB");
  }
  const format = await verifyPlainPackagePath(plainPath, kind);
  return { format, sha256: await fileSha256(plainPath), sizeBytes: stat.size };
}

export async function verifyEncryptedPackageObject(
  file: File,
  passphrase: string,
  expectedPlain: { sha256: string; sizeBytes: number },
): Promise<{ sha256: string; sizeBytes: number }> {
  const [metadata] = await file.getMetadata();
  const sizeBytes = Number(metadata.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 16 || sizeBytes > MAX_ENCRYPTED_PACKAGE_BYTES) {
    throw new Error("حجم الحزمة المشفّرة غير صالح");
  }
  const headerChunks: Buffer[] = [];
  for await (const chunk of file.createReadStream({ start: 0, end: 15 })) {
    headerChunks.push(Buffer.from(chunk));
  }
  const header = Buffer.concat(headerChunks);
  if (header.length !== 16 || !header.subarray(0, 8).equals(HEADER)) {
    throw new Error("الملف غير مشفّر بصيغة الحزمة المعتمدة");
  }
  const { key, iv } = keyIv(passphrase, header.subarray(8, 16));
  const encryptedHash = createHash("sha256");
  const plainHash = createHash("sha256");
  let skipped = 0;
  let plainSize = 0;
  const stripHeaderAndHash = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      encryptedHash.update(chunk);
      let body = chunk;
      if (skipped < 16) {
        const remove = Math.min(16 - skipped, body.length);
        skipped += remove;
        body = body.subarray(remove);
      }
      callback(null, body);
    },
  });
  const hashPlain = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      plainHash.update(chunk);
      plainSize += chunk.length;
      callback();
    },
  });
  await pipeline(
    file.createReadStream(),
    stripHeaderAndHash,
    createDecipheriv("aes-256-cbc", key, iv),
    hashPlain,
  );
  const actualPlainHash = plainHash.digest("hex");
  if (plainSize !== expectedPlain.sizeBytes || actualPlainHash !== expectedPlain.sha256) {
    throw new Error("فشل مطابقة الحزمة المشفّرة مع الملف الخام المتحقق منه");
  }
  return { sha256: encryptedHash.digest("hex"), sizeBytes };
}

/**
 * Promote a direct-to-storage raw upload into the durable encrypted package.
 * The large request body never traverses the API server. The raw staging
 * object is private, short-lived, and deleted in every success/failure path.
 */
export async function promoteStagedUploadToEncryptedPackage(input: {
  sourceObjectPath: string;
  finalObjectKey: string;
  passphrase: string;
  kind: ExternalPackageKind;
  expectedRawSize: number;
}): Promise<{ objectPath: string; sizeBytes: number; sha256: string; format: ExternalPackageFormat }> {
  const previous = promotionQueue;
  let releaseQueue!: () => void;
  promotionQueue = new Promise<void>(resolve => { releaseQueue = resolve; });
  await previous;
  try {
    return await promoteStagedUploadWithSlot(input);
  } finally {
    releaseQueue();
  }
}

async function promoteStagedUploadWithSlot(input: {
  sourceObjectPath: string;
  finalObjectKey: string;
  passphrase: string;
  kind: ExternalPackageKind;
  expectedRawSize: number;
}): Promise<{ objectPath: string; sizeBytes: number; sha256: string; format: ExternalPackageFormat }> {
  const source = privateFileForObjectPath(input.sourceObjectPath);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), ".zacod-direct-upload-"));
  const plainPath = path.join(dir, "package.raw");
  let finalObjectPath: string | null = null;
  try {
    const [metadata] = await source.getMetadata();
    const rawSize = Number(metadata.size);
    if (!Number.isSafeInteger(rawSize) || rawSize <= 0 || rawSize > MAX_RAW_PACKAGE_BYTES) {
      throw new Error("حجم الملف المرفوع غير صالح");
    }
    if (rawSize !== input.expectedRawSize) throw new Error("حجم الملف المرفوع لا يطابق الحجم المعلن");
    await pipeline(source.createReadStream(), createWriteStream(plainPath, { mode: 0o600 }));
    const inspected = await inspectPlainPackagePath(plainPath, input.kind);
    if (inspected.sizeBytes !== rawSize) throw new Error("حجم الملف المؤقت لا يطابق الملف المرفوع");
    const encrypted = await encryptLocalFileToPrivateObject(plainPath, input.finalObjectKey, input.passphrase);
    finalObjectPath = encrypted.objectPath;
    const verified = await verifyEncryptedPackageObject(
      privateFileForObjectPath(encrypted.objectPath),
      input.passphrase,
      { sha256: inspected.sha256, sizeBytes: inspected.sizeBytes },
    );
    return { ...verified, objectPath: encrypted.objectPath, format: inspected.format };
  } catch (error) {
    await removePackageObject(finalObjectPath);
    throw error;
  } finally {
    await source.delete({ ignoreNotFound: true }).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function removePackageObject(objectPath: string | null | undefined): Promise<void> {
  if (!objectPath) return;
  await privateFileForObjectPath(objectPath).delete({ ignoreNotFound: true }).catch(() => {});
}

export async function removeAllAgentPackageObjects(agentId: number): Promise<void> {
  await storage.deletePrivateObjectsUnderPrefix(`agent-packages/${agentId}`);
}

export async function sweepStalePackageUploads(): Promise<number> {
  return storage.deletePrivateObjectsUnderPrefix("agent-packages", {
    olderThan: new Date(Date.now() - 60 * 60_000),
    requiredSegment: "/staging/",
  });
}

const stagingSweepTimer = setInterval(() => {
  void sweepStalePackageUploads().catch(() => {});
}, 15 * 60_000);
stagingSweepTimer.unref();
const initialStagingSweep = setTimeout(() => {
  void sweepStalePackageUploads().catch(() => {});
}, 60_000);
initialStagingSweep.unref();

export async function streamPrivatePackage(res: any, entry: ExternalPackageEntry): Promise<void> {
  const file = privateFileForObjectPath(entry.objectPath);
  const [exists] = await file.exists();
  if (!exists) throw new Error("ملف الحزمة غير موجود في التخزين");
  const [metadata] = await file.getMetadata();
  if (Number(metadata.size) !== entry.sizeBytes) throw new Error("حجم الحزمة لا يطابق البيانات المسجلة");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(entry.sizeBytes));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  file.createReadStream().pipe(res);
}

export async function buildFrontendArchive(distDir: string, outputDir: string): Promise<string> {
  const candidates = [
    path.join(distDir, "public"),
    path.resolve(path.dirname(distDir), "..", "zatca-invoicing", "dist", "public"),
    path.resolve(process.cwd(), "artifacts", "zatca-invoicing", "dist", "public"),
    path.resolve(process.cwd(), "..", "zatca-invoicing", "dist", "public"),
  ];
  let publicDir = "";
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(candidate, "index.html"));
      publicDir = candidate;
      break;
    } catch { /* next */ }
  }
  if (!publicDir) {
    throw new Error("حزمة Frontend غير متاحة — ابنِ تطبيق zatca-invoicing أولًا");
  }
  const out = path.join(outputDir, "frontend.tgz");
  await execChecked("tar", [
    "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
    "--format=gnu", "-czf", out, "-C", publicDir, ".",
  ]);
  return out;
}

export async function buildAgentDatabaseDump(databaseUrl: string, outputDir: string): Promise<string> {
  const out = path.join(outputDir, "database.dump");
  await execChecked("pg_dump", [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--no-comments",
    ...AGENT_DB_EXCLUDED_TABLE_DATA.map(table => `--exclude-table-data=${table}`),
    "--file", out,
    databaseUrl,
  ], 15 * 60_000);
  return out;
}

export async function packageFileExists(entry: ExternalPackageEntry): Promise<boolean> {
  if (!entry.objectPath) return false;
  const file = privateFileForObjectPath(entry.objectPath);
  const [exists] = await file.exists();
  if (!exists) return false;
  const [metadata] = await file.getMetadata();
  if (Number(metadata.size) !== entry.sizeBytes) return false;
  return await objectSha256(file) === entry.sha256;
}