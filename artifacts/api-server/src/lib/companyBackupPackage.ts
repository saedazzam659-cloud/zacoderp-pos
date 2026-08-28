import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable, Writable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { db, documentArchivesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getRoutedDb } from "./externalDbRouting";
import { buildFullCompanyBackup, isExternalFileReference, isFullCompanyBackupPayload, restoreFullCompanyBackup, sanitizeRow, type FullCompanyPayload } from "./fullCompanyBackup";
import { ObjectStorageService } from "./objectStorage";

const MAGIC = Buffer.from("ZCBP3\0", "ascii");
const HEADER_BYTES = MAGIC.length + 4;
export const MAX_PACKAGE_FILES = 10_000;
export const MAX_PACKAGE_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_PACKAGE_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_PACKAGE_MANIFEST_BYTES = 128 * 1024 * 1024;

export type FilePointer =
  | { kind: "data"; table: string; row: number; column: string }
  | { kind: "companySettings"; column: string };
export type PortableFile = { id: string; sourcePath: string; size: number; sha256: string; contentType: string; pointers: FilePointer[] };
export type PortableManifest = { version: 3; payload: FullCompanyPayload; files: PortableFile[]; skippedExternal: number };
export type CollectedFiles = { files: Array<{ id: string; sourcePath: string; pointers: FilePointer[] }>; skippedExternal: Array<{ pointer: FilePointer; value: string }> };
export type DocumentArchiveRestoreRow = {
  screenKey: string; docKey: string; filename: string; objectPath: string;
  contentType: string | null; bytes: number | null; pages: number | null; uploadedByName: string | null;
};

function fail(message: string): never { throw new Error(`تعذر معالجة حزمة النسخة الاحتياطية: ${message}`); }
function safeObjectPath(value: string): boolean {
  return /^\/objects\/[A-Za-z0-9][A-Za-z0-9/_\-.]*$/.test(value) && !value.includes("..") && !value.includes("//");
}
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }

/** Finds only direct, private object references, retaining their exact payload locations. */
export function collectPortableFileReferences(payload: FullCompanyPayload): CollectedFiles {
  const byPath = new Map<string, { id: string; sourcePath: string; pointers: FilePointer[] }>();
  const skippedExternal: CollectedFiles["skippedExternal"] = [];
  const visit = (column: string, value: unknown, pointer: FilePointer) => {
    if (!isExternalFileReference(column, value) || typeof value !== "string") return;
    if (!safeObjectPath(value)) { skippedExternal.push({ pointer, value }); return; }
    const current = byPath.get(value) ?? { id: String(byPath.size), sourcePath: value, pointers: [] };
    current.pointers.push(pointer); byPath.set(value, current);
  };
  for (const [table, rows] of Object.entries(payload.data)) {
    for (let row = 0; row < rows.length; row++) {
      for (const [column, value] of Object.entries(rows[row])) visit(column, value, { kind: "data", table, row, column });
    }
  }
  if (payload.companySettings) for (const [column, value] of Object.entries(payload.companySettings)) {
    visit(column, value, { kind: "companySettings", column });
  }
  return { files: [...byPath.values()], skippedExternal };
}

function pointerValue(payload: FullCompanyPayload, pointer: FilePointer): unknown {
  if (pointer.kind === "companySettings") return payload.companySettings?.[pointer.column];
  return payload.data[pointer.table]?.[pointer.row]?.[pointer.column];
}
function setPointerValue(payload: FullCompanyPayload, pointer: FilePointer, value: string): void {
  if (pointer.kind === "companySettings") payload.companySettings![pointer.column] = value;
  else payload.data[pointer.table][pointer.row][pointer.column] = value;
}

/**
 * Canonicalize legacy local-agent filesystem references before packaging.
 * The storage service accepts them only when they point to an existing file
 * beneath the configured private root, so arbitrary host files cannot enter a
 * backup package.
 */
export function normalizeLegacyPortableFileReferences(
  payload: FullCompanyPayload,
  service: ObjectStorageService,
): number {
  const initial = collectPortableFileReferences(payload);
  let normalized = 0;
  for (const skipped of initial.skippedExternal) {
    const canonical = service.normalizePrivateObjectReference(skipped.value);
    if (!canonical) continue;
    setPointerValue(payload, skipped.pointer, canonical);
    normalized++;
  }
  return normalized;
}
function validatePointer(payload: FullCompanyPayload, pointer: unknown): asserts pointer is FilePointer {
  if (!pointer || typeof pointer !== "object") fail("مؤشر ملف غير صالح");
  const p = pointer as Partial<FilePointer>;
  if (p.kind === "companySettings") {
    if (typeof p.column !== "string" || !payload.companySettings || !(p.column in payload.companySettings)) fail("مؤشر إعدادات خارج الحدود");
    return;
  }
  if (p.kind !== "data" || typeof p.table !== "string" || !Number.isSafeInteger(p.row) || (p.row as number) < 0 || typeof p.column !== "string"
    || !Array.isArray(payload.data[p.table]) || (p.row as number) >= payload.data[p.table].length || !(p.column in payload.data[p.table][p.row as number])) fail("مؤشر بيانات خارج الحدود");
}

/** Validates the untrusted v3 manifest and returns a typed manifest. */
export function validatePortableManifest(value: unknown): PortableManifest {
  if (!value || typeof value !== "object") fail("بيان الحزمة غير صالح");
  const manifest = value as Partial<PortableManifest>;
  const skippedExternal = manifest.skippedExternal;
  if (manifest.version !== 3 || !isFullCompanyBackupPayload(manifest.payload) || !Array.isArray(manifest.files)
    || typeof skippedExternal !== "number" || !Number.isSafeInteger(skippedExternal) || skippedExternal < 0) {
    fail("إصدار أو محتوى بيان الحزمة غير صالح");
  }
  if (manifest.files.length > MAX_PACKAGE_FILES) fail("عدد الملفات يتجاوز الحد المسموح");
  let total = 0; const ids = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file !== "object" || typeof file.id !== "string" || !/^[0-9]+$/.test(file.id) || ids.has(file.id)
      || !safeObjectPath(file.sourcePath) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_PACKAGE_FILE_BYTES
      || typeof file.contentType !== "string" || file.contentType.length > 255
      || !isSha256(file.sha256) || !Array.isArray(file.pointers)) fail("وصف ملف غير صالح");
    ids.add(file.id); total += file.size;
    if (total > MAX_PACKAGE_TOTAL_BYTES) fail("إجمالي حجم الملفات يتجاوز الحد المسموح");
    for (const pointer of file.pointers) {
      validatePointer(manifest.payload, pointer);
      if (pointerValue(manifest.payload, pointer) !== file.sourcePath) fail("قيمة مؤشر الملف لا تطابق المصدر");
    }
  }
  return manifest as PortableManifest;
}

/** Serializes the custom, uncompressed container: magic, manifest length, manifest, then file bytes. */
export function serializePortableManifest(manifest: PortableManifest): Buffer {
  validatePortableManifest(manifest);
  const json = Buffer.from(JSON.stringify(manifest), "utf8");
  if (json.length > MAX_PACKAGE_MANIFEST_BYTES) fail("بيان الحزمة كبير جداً");
  const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, length, json]);
}
export function parsePortableManifest(container: Buffer): { manifest: PortableManifest; dataOffset: number } {
  if (container.length < HEADER_BYTES || !container.subarray(0, MAGIC.length).equals(MAGIC)) fail("توقيع الحزمة غير صحيح");
  const length = container.readUInt32BE(MAGIC.length);
  if (length > MAX_PACKAGE_MANIFEST_BYTES || HEADER_BYTES + length > container.length) fail("طول بيان الحزمة غير صالح");
  try {
    return { manifest: validatePortableManifest(JSON.parse(container.subarray(HEADER_BYTES, HEADER_BYTES + length).toString("utf8"))), dataOffset: HEADER_BYTES + length };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("تعذر")) throw error;
    fail("JSON بيان الحزمة غير صالح");
  }
}

/** Small-buffer verifier used by policy tests and diagnostics; production restore verifies by streams. */
export function verifyPortableContainerBuffer(container: Buffer): PortableManifest {
  const { manifest, dataOffset } = parsePortableManifest(container);
  let offset = dataOffset;
  for (const file of manifest.files) {
    const end = offset + file.size;
    if (!Number.isSafeInteger(end) || end > container.length) fail("حجم أحد الملفات لا يطابق الحزمة");
    const bytes = container.subarray(offset, end);
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      fail("بصمة أحد الملفات لا تطابق الحزمة");
    }
    offset = end;
  }
  if (offset !== container.length) fail("تحتوي الحزمة على بيانات زائدة");
  return manifest;
}

/** Returns a deep clone with references atomically replaced after verifying original values. */
export function rewritePortablePayload(payload: FullCompanyPayload, files: PortableFile[], newPaths: Map<string, string>): FullCompanyPayload {
  const clone = JSON.parse(JSON.stringify(payload)) as FullCompanyPayload;
  for (const file of files) {
    const replacement = newPaths.get(file.id);
    if (!replacement || !safeObjectPath(replacement)) fail("مسار الملف المستعاد غير صالح");
    for (const pointer of file.pointers) {
      if (pointerValue(clone, pointer) !== file.sourcePath) fail("تغيرت قيمة مؤشر الملف قبل الاستعادة");
      if (pointer.kind === "companySettings") clone.companySettings![pointer.column] = replacement;
      else clone.data[pointer.table][pointer.row][pointer.column] = replacement;
    }
  }
  return clone;
}

async function hashCopy(source: Readable, destination: string, limit: number): Promise<{ size: number; sha256: string }> {
  const digest = createHash("sha256"); let size = 0;
  source.on("data", (chunk: Buffer) => { size += chunk.length; if (size > limit) source.destroy(new Error("ملف يتجاوز الحد المسموح")); else digest.update(chunk); });
  await pipeline(source, createWriteStream(destination, { flags: "wx" }));
  return { size, sha256: digest.digest("hex") };
}
async function streamWithLimit(source: Readable, destination: Writable, limit: number): Promise<void> {
  let size = 0; source.on("data", (chunk: Buffer) => { size += chunk.length; if (size > limit) source.destroy(new Error("الحزمة تتجاوز الحد المسموح")); });
  await pipeline(source, destination);
}
export function portablePackagePrefix(companyId: number): string { return `company-backup-packages/${companyId}/`; }
export function createPortablePackageUploadKey(companyId: number): string {
  return `${portablePackagePrefix(companyId)}${randomUUID()}.zacbackup`;
}
function tempName(dir: string, name: string): string { return join(dir, name); }

function archiveValue(row: Record<string, unknown>, snake: string): unknown {
  const camel = snake.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return row[snake] ?? row[camel];
}
function archiveText(row: Record<string, unknown>, name: string, nullable = false): string | null {
  const value = archiveValue(row, name);
  if (value == null && nullable) return null;
  if (typeof value !== "string") fail(`بيانات أرشيف المستندات غير صالحة (${name})`);
  return value;
}
function archiveInteger(row: Record<string, unknown>, name: string): number | null {
  const value = archiveValue(row, name);
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`بيانات أرشيف المستندات غير صالحة (${name})`);
  }
  return value;
}

/** Enforces export bounds before any object bytes are read. */
export function assertPortableExportLimits(fileCount: number, sizes: number[]): number {
  if (!Number.isSafeInteger(fileCount) || fileCount < 0 || fileCount > MAX_PACKAGE_FILES) {
    fail("عدد الملفات يتجاوز الحد المسموح");
  }
  let total = 0;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PACKAGE_FILE_BYTES) {
      fail("حجم أحد الملفات يتجاوز الحد المسموح");
    }
    total += size;
    if (!Number.isSafeInteger(total) || total > MAX_PACKAGE_TOTAL_BYTES) {
      fail("إجمالي حجم الملفات يتجاوز الحد المسموح");
    }
  }
  return total;
}
/** Extracts archive rows and makes the central restore safely ignore that routed table. */
export function separateRoutedDocumentArchiveRows(payload: FullCompanyPayload): {
  payload: FullCompanyPayload; archiveRows: Record<string, unknown>[];
} {
  const clone = JSON.parse(JSON.stringify(payload)) as FullCompanyPayload;
  const archiveRows = clone.data.document_archives ?? [];
  if (!Array.isArray(archiveRows)) fail("بيانات أرشيف المستندات غير صالحة");
  clone.data.document_archives = [];
  clone.counts.document_archives = 0;
  return { payload: clone, archiveRows };
}
/** Maps raw backup columns (snake case) or Drizzle columns (camel case) to a safe target insert. */
export function documentArchiveRestoreValues(row: Record<string, unknown>): DocumentArchiveRestoreRow {
  return {
    screenKey: archiveText(row, "screen_key")!,
    docKey: archiveText(row, "doc_key")!,
    filename: archiveText(row, "filename")!,
    objectPath: archiveText(row, "object_path")!,
    contentType: archiveText(row, "content_type", true),
    bytes: archiveInteger(row, "bytes"),
    pages: archiveInteger(row, "pages"),
    uploadedByName: archiveText(row, "uploaded_by_name", true),
  };
}
async function loadRoutedDocumentArchives(companyId: number): Promise<Record<string, unknown>[] | null> {
  const routed = await getRoutedDb("document_archive");
  if (routed === db) return null;
  const result = await routed.execute(sql`SELECT * FROM "document_archives" WHERE "company_id" = ${companyId}`);
  const rows = Array.isArray(result) ? result : (result as { rows?: Record<string, unknown>[] }).rows ?? [];
  return rows.map((row) => sanitizeRow(row, "document_archives"));
}
async function replaceRoutedDocumentArchives(
  companyId: number, archiveRows: Record<string, unknown>[],
): Promise<number> {
  const routed = await getRoutedDb("document_archive");
  if (routed === db) return 0;
  await routed.transaction(async (tx) => {
    await tx.delete(documentArchivesTable).where(eq(documentArchivesTable.companyId, companyId));
    if (archiveRows.length) await tx.insert(documentArchivesTable).values(archiveRows.map((row) => ({
      ...documentArchiveRestoreValues(row),
      companyId,
      uploadedBy: null,
    })));
  });
  return archiveRows.length;
}

export async function buildPortableBackupPackage(companyId: number, exportedBy: string | null = null) {
  const { payload } = await buildFullCompanyBackup(companyId, exportedBy);
  // document_archives may be platform-routed to a different database and is
  // therefore absent from the central transaction used by the core exporter.
  if (payload.manifest.tables.document_archives) {
    const routedRows = await loadRoutedDocumentArchives(companyId);
    if (routedRows) {
      payload.data.document_archives = routedRows;
      payload.counts.document_archives = routedRows.length;
    }
  }
  const service = new ObjectStorageService(); const dir = await mkdtemp(join(tmpdir(), "company-backup-"));
  normalizeLegacyPortableFileReferences(payload, service);
  const collected = collectPortableFileReferences(payload);
  assertPortableExportLimits(collected.files.length, []);
  const cleanup = async () => { await rm(dir, { recursive: true, force: true }); };
  try {
    const planned: Array<{
      entry: CollectedFiles["files"][number];
      source: Awaited<ReturnType<ObjectStorageService["getObjectEntityFile"]>>;
      size: number;
      contentType: string;
    }> = [];
    for (const entry of collected.files) {
      const source = await service.getObjectEntityFile(entry.sourcePath);
      const [metadata] = await source.getMetadata();
      planned.push({
        entry,
        source,
        size: Number(metadata.size),
        contentType: typeof metadata.contentType === "string" ? metadata.contentType : "application/octet-stream",
      });
    }
    assertPortableExportLimits(collected.files.length, planned.map((file) => file.size));

    const files: PortableFile[] = [];
    for (const plan of planned) {
      const { entry, source } = plan;
      const staged = tempName(dir, `file-${entry.id}`);
      const hashed = await hashCopy(source.createReadStream(), staged, plan.size);
      if (hashed.size !== plan.size) fail("حجم الملف الفعلي لا يطابق بيانات التخزين");
      files.push({
        ...entry,
        ...hashed,
        contentType: plan.contentType,
      });
    }
    const skippedExternal = collected.skippedExternal.length;
    const header = serializePortableManifest({ version: 3, payload, files, skippedExternal });
    const raw = tempName(dir, "backup.zcbp"); const out = tempName(dir, "backup.zcbp.gz");
    const handle = await open(raw, "w"); await handle.write(header); await handle.close();
    const append = createWriteStream(raw, { flags: "a" });
    for (const file of files) await pipeline(createReadStream(tempName(dir, `file-${file.id}`)), append, { end: false });
    append.end(); await new Promise<void>((resolve, reject) => append.once("finish", resolve).once("error", reject));
    await pipeline(createReadStream(raw), createGzip(), createWriteStream(out, { flags: "wx" }));
    return {
      path: out,
      filename: `company-${companyId}-backup.zacbackup`,
      summary: {
        files: files.length,
        bytes: files.reduce((sum, file) => sum + file.size, 0),
        skippedExternal,
      },
      cleanup,
    };
  } catch (error) { await cleanup(); throw error; }
}

export async function restorePortableBackupPackage(companyId: number, packageObjectPath: string) {
  const expected = `/objects/${portablePackagePrefix(companyId)}`;
  if (!packageObjectPath.startsWith(expected) || !safeObjectPath(packageObjectPath)) fail("مسار حزمة الاستعادة غير مصرح به");
  const service = new ObjectStorageService(); const dir = await mkdtemp(join(tmpdir(), "company-restore-"));
  const destinationPrefix = `company-backup-files/${companyId}/${randomUUID()}`;
  const source = await service.getObjectEntityFile(packageObjectPath);
  try {
    const [packageMetadata] = await source.getMetadata();
    const packageBytes = Number(packageMetadata.size ?? 0);
    if (!Number.isSafeInteger(packageBytes) || packageBytes <= 0
      || packageBytes > MAX_PACKAGE_TOTAL_BYTES + MAX_PACKAGE_MANIFEST_BYTES + 1024 * 1024) {
      fail("حجم ملف الحزمة غير صالح");
    }
    const raw = tempName(dir, "incoming.zcbp");
    await streamWithLimit(source.createReadStream().pipe(createGunzip()), createWriteStream(raw, { flags: "wx" }), MAX_PACKAGE_TOTAL_BYTES + MAX_PACKAGE_MANIFEST_BYTES + HEADER_BYTES);
    const fd = await open(raw, "r"); const prefix = Buffer.alloc(MAX_PACKAGE_MANIFEST_BYTES + HEADER_BYTES);
    const read = await fd.read(prefix, 0, prefix.length, 0); await fd.close();
    const { manifest, dataOffset } = parsePortableManifest(prefix.subarray(0, read.bytesRead));
    let offset = dataOffset;
    // Never publish a partial set of restored files: authenticate every byte
    // in the package before the first destination object is created.
    for (const file of manifest.files) {
      const staged = tempName(dir, `import-${file.id}`);
      const hashed = file.size === 0
        ? (() => ({ size: 0, sha256: createHash("sha256").digest("hex") }))()
        : await hashCopy(createReadStream(raw, { start: offset, end: offset + file.size - 1 }), staged, file.size);
      if (file.size === 0) { const empty = await open(staged, "wx"); await empty.close(); }
      if (hashed.size !== file.size || hashed.sha256 !== file.sha256) fail("بصمة أحد الملفات لا تطابق الحزمة");
      offset += file.size;
    }
    if ((await stat(raw)).size !== offset) fail("تحتوي الحزمة على بيانات زائدة");
    const paths = new Map<string, string>();
    for (const file of manifest.files) {
      await pipeline(createReadStream(tempName(dir, `import-${file.id}`)),
        service.getPrivateObjectFile(`${destinationPrefix}/${file.id}`).createWriteStream({
          resumable: false,
          metadata: { contentType: file.contentType || "application/octet-stream", cacheControl: "private, no-store" },
        }));
      paths.set(file.id, `/objects/${destinationPrefix}/${file.id}`);
    }
    const payload = rewritePortablePayload(manifest.payload, manifest.files, paths);
    try {
      const routed = await getRoutedDb("document_archive");
      const isRouted = routed !== db && !!payload.manifest.tables.document_archives;
      const separated = isRouted ? separateRoutedDocumentArchiveRows(payload) : null;
      const report = await restoreFullCompanyBackup(companyId, separated?.payload ?? payload);
      if (separated) {
        const restored = await replaceRoutedDocumentArchives(companyId, separated.archiveRows);
        report.document_archives = { received: restored, inserted: restored, updated: 0 };
      }
      return {
        report,
        files: {
          copied: manifest.files.length,
          bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
          skippedExternal: manifest.skippedExternal,
        },
      };
    }
    catch (error) { await service.deletePrivateObjectsUnderPrefix(destinationPrefix); throw error; }
  } catch (error) {
    await service.deletePrivateObjectsUnderPrefix(destinationPrefix).catch(() => {});
    throw error;
  } finally {
    await source.delete({ ignoreNotFound: true }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}