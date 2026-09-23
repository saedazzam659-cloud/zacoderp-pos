import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.resolve(here, "../src/components/ContractingGuaranteesPanel.tsx"),
  "utf8",
);

test("contract-scoped panel loads and renders the unified guarantee summary", () => {
  assert.match(source, /contracts\/\$\{contractKind\}\/\$\{contractId\}\/guarantee-summary/);
  assert.match(source, /ضمانات العقد الموحدة/);
  assert.match(source, /summary\.totalCount/);
  assert.match(source, /summary\.totalAmount/);
});

test("saved tenders and guarantees expose the shared archive wrapper", () => {
  assert.match(source, /entityType="guarantee"\s+entityId=\{row\.id\}/);
  assert.match(source, /entityType="tender"\s+entityId=\{row\.id\}/);
});

test("performance creation retains and references the original initial guarantee", () => {
  assert.match(source, /parentGuaranteeId:\s*fromInitial\s*\?\s*String\(fromInitial\.id\)/);
  assert.match(source, /row\.guarantee_type === "initial"[\s\S]*openGuarantee\(undefined, row\)/);
});