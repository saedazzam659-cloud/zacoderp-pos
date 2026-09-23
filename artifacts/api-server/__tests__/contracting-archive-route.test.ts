import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.resolve(here, "../src/routes/document-archives.ts"),
  "utf8",
);

test("archive routes enforce contracting entity ACL on every authenticated operation", () => {
  assert.match(source, /router\.post\("\/"[\s\S]*assertContractingArchiveAccess\([\s\S]*"edit"/);
  assert.match(source, /router\.get\("\/"[\s\S]*assertContractingArchiveAccess\(req, cid, screenKey, docKey, "view"\)/);
  assert.match(source, /router\.post\("\/:id\/share-link"[\s\S]*assertContractingArchiveAccess\(req, cid, row\.screenKey, row\.docKey, "view"\)/);
  assert.match(source, /router\.get\("\/:id\/download"[\s\S]*assertContractingArchiveAccess\(req, cid, row\.screenKey, row\.docKey, "view"\)/);
  assert.match(source, /router\.post\("\/:id\/email"[\s\S]*assertContractingArchiveAccess\(req, cid, row\.screenKey, row\.docKey, "view"\)/);
  assert.match(source, /router\.delete\("\/:id"[\s\S]*assertContractingArchiveAccess\(req, cid, row\.screenKey, row\.docKey, "delete"\)/);
});

test("contracting archives cannot be rekeyed to arbitrary business identifiers", () => {
  assert.match(source, /router\.patch\("\/rekey"[\s\S]*لا تدعم مستندات المقاولات تغيير المعرّف/);
});