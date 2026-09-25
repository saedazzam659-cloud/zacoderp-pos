import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const detail = readFileSync(new URL("../src/pages/ContractingProjectDetail.tsx", import.meta.url), "utf8");
const projects = readFileSync(new URL("../src/pages/ContractingProjects.tsx", import.meta.url), "utf8");
const options = readFileSync(new URL("../src/lib/contractingProjectOptions.ts", import.meta.url), "utf8");

test("project and list share scoped in-flight options with bounded freshness", () => {
  assert.match(options, /\["contracting-project-options", userId, companyId, actingCompanyId, token\]/);
  assert.match(detail, /queryKey: contractingOptionsKey/);
  assert.match(projects, /queryKey: contractingOptionsKey/);
  assert.match(detail, /staleTime: 30_000/);
  assert.match(projects, /staleTime: 30_000/);
  assert.match(projects, /invalidateQueries\(\{ queryKey: \["contracting-project-options"\] \}\)/);
  assert.match(options, /integrityDiagnostics/);
});

test("visited forms preserve drafts without reloading hidden lists; financial panels remount", () => {
  for (const tab of ["bills", "owner-contract", "sub-contracts"]) {
    assert.match(detail, new RegExp(`value="${tab}" forceMount`));
  }
  assert.match(detail, /if \(active\) void load\(\)/);
  assert.match(detail, /if \(!token \|\| !active \|\| \(!editing && !autoOpen && !pendingNewBill\)\) return/);
  assert.match(detail, /Date\.now\(\) - billOptionsLoadedAt\.current < 30_000/);
  assert.doesNotMatch(detail, /value="accounting" forceMount/);
  assert.doesNotMatch(detail, /value="reports" forceMount/);
  assert.match(detail, /tab === "overview" && project/);
});