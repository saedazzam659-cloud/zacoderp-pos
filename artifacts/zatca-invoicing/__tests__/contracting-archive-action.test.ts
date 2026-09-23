import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.resolve(here, "../src/components/ContractingArchiveAction.tsx"),
  "utf8",
);

test("contracting archive action remains a thin canonical-key wrapper", () => {
  assert.match(source, /JournalScanArchive/);
  assert.match(source, /contracting_projects[\s\S]*docPrefix: "project"/);
  assert.match(source, /contracting_owner_contracts[\s\S]*docPrefix: "owner-contract"/);
  assert.match(source, /contracting_subcontracts[\s\S]*docPrefix: "subcontract"/);
  assert.match(source, /contracting_boq_lines[\s\S]*docPrefix: "boq-line"/);
  assert.match(source, /contracting_work_items[\s\S]*docPrefix: "work-item"/);
  assert.match(source, /contracting_tenders[\s\S]*docPrefix: "tender"/);
  assert.match(source, /contracting_guarantees[\s\S]*docPrefix: "guarantee"/);
  assert.doesNotMatch(source, /fetch\(|objectPath|localStorage/);
});