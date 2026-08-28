import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PACKAGE_FILES, MAX_PACKAGE_FILE_BYTES, MAX_PACKAGE_TOTAL_BYTES,
  assertPortableExportLimits, collectPortableFileReferences, parsePortableManifest,
  rewritePortablePayload, separateRoutedDocumentArchiveRows, serializePortableManifest, validatePortableManifest,
  verifyPortableContainerBuffer, restorePortableBackupPackage,
} from "../src/lib/companyBackupPackage.js";

const payload: any = {
  meta: { schemaVersion: 2, scope: "full_company", companyId: 1, exportedAt: "2025-01-01", exportedBy: null, appName: "x", files: { mode: "references_only", referenced: 0, warning: null } },
  counts: { docs: 2 }, manifest: { format: "full-company", tables: {} , exclusions: [] },
  companySettings: { logo_path: "/objects/logo" },
  data: { docs: [{ attachment_path: "/objects/a", title: "a" }, { attachment_path: "/objects/a", attachment_url: "https://example.test/x" }] },
};

test("collects and deduplicates private files while skipping external references", () => {
  const found = collectPortableFileReferences(payload);
  assert.equal(found.files.length, 2);
  assert.equal(found.files.find(x => x.sourcePath === "/objects/a")?.pointers.length, 2);
  assert.equal(found.skippedExternal.length, 1);
});
test("rewrites only verified file pointers on a clone", () => {
  const found = collectPortableFileReferences(payload);
  const output = rewritePortablePayload(payload, found.files.map(x => ({ ...x, size: 0, sha256: "a".repeat(64), contentType: "application/octet-stream" })), new Map(found.files.map(x => [x.id, `/objects/new/${x.id}`])));
  assert.equal(output.data.docs[0].attachment_path, "/objects/new/0");
  assert.equal(payload.data.docs[0].attachment_path, "/objects/a");
});
test("manifest parser rejects malformed values and limits", () => {
  assert.throws(() => parsePortableManifest(Buffer.from("bad")));
  assert.throws(() => validatePortableManifest({ version: 3, payload, files: Array.from({ length: MAX_PACKAGE_FILES + 1 }, () => ({})) }));
  assert.throws(() => validatePortableManifest({ version: 3, payload, skippedExternal: "1", files: [] }));
  const found = collectPortableFileReferences(payload);
  const header = serializePortableManifest({ version: 3, payload, skippedExternal: 1, files: found.files.map(x => ({ ...x, size: 0, sha256: "a".repeat(64), contentType: "application/octet-stream" })) });
  assert.equal(parsePortableManifest(header).manifest.version, 3);
});
test("container byte verification rejects traversal, duplicate ids, bad hashes, and trailing data", () => {
  const bytes = Buffer.from("portable attachment");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const found = collectPortableFileReferences(payload);
  const first = { ...found.files[0], size: bytes.length, sha256, contentType: "text/plain" };
  const manifest = { version: 3 as const, payload, skippedExternal: 1, files: [first] };
  const container = Buffer.concat([serializePortableManifest(manifest), bytes]);
  assert.equal(verifyPortableContainerBuffer(container).files.length, 1);
  assert.throws(() => verifyPortableContainerBuffer(Buffer.concat([container, Buffer.from("extra")])));
  const badHash = { ...manifest, files: [{ ...first, sha256: "0".repeat(64) }] };
  assert.throws(() => verifyPortableContainerBuffer(Buffer.concat([serializePortableManifest(badHash), bytes])));
  assert.throws(() => validatePortableManifest({
    ...manifest,
    files: [first, { ...first, sourcePath: "/objects/../escape" }],
  }));
  assert.throws(() => validatePortableManifest({ ...manifest, files: [first, { ...first }] }));
});
test("portable restore rejects cross-tenant staging paths before storage access", async () => {
  await assert.rejects(
    () => restorePortableBackupPackage(2, "/objects/company-backup-packages/1/package.zacbackup"),
    /غير مصرح/,
  );
});
test("export limits reject excessive counts and bytes before object reads", () => {
  assert.equal(assertPortableExportLimits(2, [100, 200]), 300);
  assert.throws(() => assertPortableExportLimits(MAX_PACKAGE_FILES + 1, []), /عدد الملفات/);
  assert.throws(() => assertPortableExportLimits(1, [MAX_PACKAGE_FILE_BYTES + 1]), /حجم أحد الملفات/);
  assert.throws(
    () => assertPortableExportLimits(9, Array.from({ length: 9 }, () => MAX_PACKAGE_FILE_BYTES)),
    /إجمالي حجم الملفات/,
  );
});
test("separates routed document archives without changing original payload", () => {
  const source: any = {
    ...payload,
    counts: { ...payload.counts, document_archives: 1 },
    data: { ...payload.data, document_archives: [{ id: 9, object_path: "/objects/a" }] },
  };
  const separated = separateRoutedDocumentArchiveRows(source);
  assert.equal(separated.archiveRows.length, 1);
  assert.equal(separated.payload.data.document_archives.length, 0);
  assert.equal(separated.payload.counts.document_archives, 0);
  assert.equal(source.data.document_archives.length, 1);
});