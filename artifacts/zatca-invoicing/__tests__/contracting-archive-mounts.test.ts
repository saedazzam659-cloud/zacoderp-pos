import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => fs.readFileSync(path.resolve(here, relative), "utf8");

test("project detail mounts archives only on saved project and contract entities", () => {
  const source = read("../src/pages/ContractingProjectDetail.tsx");
  assert.match(source, /entityType="project"\s+entityId=\{project\.id\}/);
  assert.match(source, /entityType="ownerContract"\s+entityId=\{c\.id\}/);
  assert.match(source, /entityType="subcontract"\s+entityId=\{c\.id\}/);
  assert.doesNotMatch(source, /entityType="workItem"/);
});

test("saved BOQ lines expose the shared archive action", () => {
  const source = read("../src/components/ContractingContractBoqEditor.tsx");
  assert.match(source, /rows\.map\(row =>[\s\S]*entityType="boqLine"\s+entityId=\{row\.id\}/);
});

test("archive settings publish every contracting archive screen key", () => {
  const source = read("../src/pages/GeneralSettings.tsx");
  for (const key of [
    "contracting_projects",
    "contracting_owner_contracts",
    "contracting_subcontracts",
    "contracting_boq_lines",
    "contracting_work_items",
    "contracting_tenders",
    "contracting_guarantees",
  ]) {
    assert.match(source, new RegExp(`key: "${key}"`));
  }
});