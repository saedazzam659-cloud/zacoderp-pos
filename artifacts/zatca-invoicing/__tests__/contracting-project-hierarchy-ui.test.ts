import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const projects = readFileSync(new URL("../src/pages/ContractingProjects.tsx", import.meta.url), "utf8");
const detail = readFileSync(new URL("../src/pages/ContractingProjectDetail.tsx", import.meta.url), "utf8");
const reports = readFileSync(new URL("../src/components/ContractingProjectReports.tsx", import.meta.url), "utf8");
const accounting = readFileSync(new URL("../src/components/ContractingAccountingPanel.tsx", import.meta.url), "utf8");

test("project forms and detail expose the existing parent hierarchy", () => {
  assert.match(projects, /testId="project-parent-picker"/);
  assert.match(projects, /parentId: value === "__root__" \? null : Number\(value\)/);
  assert.match(detail, /projectOptions\.filter\(item => item\.parentId === project\.id\)/);
  assert.match(detail, /href=\{`\/contracting\/projects\/\$\{child\.id\}`\}/);
});

test("deferred integrity diagnostics are visible and route to existing bill repair flows", () => {
  assert.match(projects, /integrityDiagnostics\?\.deferredValidation/);
  assert.match(projects, /href="\/contracting\/bills"/);
  assert.match(projects, /لا تخمّن الربط/);
  assert.match(detail, /button-open-project-bills-integrity/);
  assert.match(detail, /setTab\("bills"\)/);
  assert.match(detail, /أنشئ أو اختر العقد الصحيح/);
});

test("bill contract changes clear stale draft BOQ execution", () => {
  assert.match(detail, /function updateAggregateContract/);
  assert.match(detail, /setDraftExecution\(emptyDraftExecution\)/);
  assert.match(detail, /setRecoveredExecution\(null\)/);
});

test("project reports request and distinguish descendant rollups", () => {
  assert.match(reports, /\?includeDescendants=true/);
  assert.match(reports, /toggle-project-descendants/);
  assert.match(reports, /hierarchy\.localSummary/);
  assert.match(reports, /hierarchy\.summary/);
  assert.match(reports, /لا يتم دمجها مع الصفوف المحلية/);
  assert.match(reports, /pricingProfitability/);
  assert.match(reports, /expectedMarginPercent/);
});

test("material issues support optional contract and filtered BOQ links while returns inherit source", () => {
  assert.match(accounting, /accounting-material-contract-picker/);
  assert.match(accounting, /accounting-material-boq-picker/);
  assert.match(accounting, /ownerContractId: contractDirection === "owner"/);
  assert.match(accounting, /subcontractorContractId: contractDirection === "subcontract"/);
  assert.match(accounting, /movementDirection === "issue" \? \{/);
  assert.match(accounting, /الإرجاع يرث العقد وسطر جدول الكميات من حركة الصرف الأصلية/);
});