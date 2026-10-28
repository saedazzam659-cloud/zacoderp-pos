import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("RAGM collection packages user-selected files locally and does not connect to the source", async () => {
  const collector = await readFile(new URL("../src/pages/settings/RagmBackupCollector.tsx", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/pages/settings/DataImportExport.tsx", import.meta.url), "utf8");

  assert.match(collector, /import JSZip from "jszip"/);
  assert.match(collector, /zip\.file\("manifest\.json"/);
  assert.match(collector, /completeness: "Not verified/);
  assert.match(collector, /لا تطلب كلمة مرور أو ملفات جلسة/);
  assert.match(collector, /لا تتصل بـRAGM/);
  assert.doesNotMatch(collector, /fetch\s*\(/);
  assert.match(collector, /multiple/);
  assert.match(page, /value="collection" data-testid="tab-ragm-file-collection"/);
  assert.match(page, /<RagmBackupCollector isAr=\{!!isAr\} \/>/);
});
