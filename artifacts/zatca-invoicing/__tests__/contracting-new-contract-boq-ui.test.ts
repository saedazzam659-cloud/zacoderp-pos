import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contractWorkItemDefaults } from "../src/lib/contractingWorkItemDefaults";

const detail = readFileSync(new URL("../src/pages/ContractingProjectDetail.tsx", import.meta.url), "utf8");
const editor = readFileSync(new URL("../src/components/ContractingContractBoqEditor.tsx", import.meta.url), "utf8");
const projects = readFileSync(new URL("../src/pages/ContractingProjects.tsx", import.meta.url), "utf8");
const planning = readFileSync(new URL("../src/components/ExecutionPlanningPanel.tsx", import.meta.url), "utf8");
const guarantees = readFileSync(new URL("../src/components/ContractingGuaranteesPanel.tsx", import.meta.url), "utf8");

test("new owner contract proposes this project's WBS items before the contract exists", () => {
  assert.match(editor, /projects\/\$\{projectId\}\/work-items/);
  assert.match(editor, /contractId == null && contractType === "main" && pendingLines === null/);
  assert.match(editor, /current => current \?\? projectItems\.map\(contractWorkItemDefaults\)/);
  assert.match(editor, /onPendingLinesChange\?\.\(next\)/);
  assert.match(detail, /contractId=\{editing\.id \?\? null\}/);
  assert.match(detail, /disabled=\{saving \|\| pendingBoqLines === null\}/);
});

test("saving a new agreement attaches each proposed BOQ line to its persisted contract only once", () => {
  assert.match(detail, /const contractId = isEdit \? Number\(editing\.id \?\? persistedContractId\.current\) : saved\.id/);
  assert.match(detail, /setEditing\(\{ \.\.\.editing, id: contractId \}\)/);
  assert.match(detail, /for \(const line of pendingBoqLines \?\? \[\]\)/);
  assert.match(detail, /ownerContractId: contractId/);
  assert.match(detail, /setPendingBoqLines\(current => \(current \?\? \[\]\)\.slice\(1\)\)/);
  assert.match(detail, /persistedContractId\.current = contractId/);
  assert.match(detail, /editing\.id != null \|\| persistedContractId\.current != null/);
  assert.match(detail, /existing\.some\(row =>/);
  assert.match(detail, /setPendingBoqLines\(null\)/);
});

test("project parent choices come from tenant-scoped options and refresh after mutations", () => {
  assert.match(projects, /projects\/options/);
  assert.match(projects, /Array\.isArray\(payload\?\.projects\) \? payload\.projects : \[\]/);
  assert.match(projects, /!descendants\.has\(project\.id\)/);
  assert.match(projects, /project\.branchId === editing\.branchId/);
  assert.match(projects, /Promise\.all\(\[load\(\), loadBranches\(\)\]\)/);
  assert.match(projects, /branchesError && \(/);
});

test("failed WBS, resources and guarantee reads retain API errors with retry rather than empty messaging", () => {
  assert.match(planning, /payload\?\.error \|\| `HTTP \$\{response\.status\}`/);
  assert.match(planning, /!loading && !loadError && !rows\.length/);
  assert.match(planning, /تعذر تحميل بنود التنفيذ أو مواردها: \{loadError\}/);
  assert.match(planning, /تعذر تحميل موارد المشروع أو خيارات المخزون: \{loadError\}/);
  assert.match(guarantees, /payload\?\.error \|\| `HTTP \$\{response\.status\}`/);
  assert.match(guarantees, /!loading && !loadError && guarantees\.length === 0/);
  assert.match(guarantees, /!loading && !loadError && tenders\.length === 0/);
  assert.match(guarantees, /تعذر تحميل المناقصات أو خطابات الضمان: \{loadError\}/);
});

test("owner draft BOQ pricing does not mistake estimated WBS cost for a sale price", () => {
  const suggested = contractWorkItemDefaults({
    id: 42, code: "EXC", nameAr: "حفر", unit: "m3", plannedQty: "1000",
    unitCost: "200", estimatedUnitCost: "200",
  } as Parameters<typeof contractWorkItemDefaults>[0]);
  assert.equal(suggested.quantity, "1000");
  assert.equal(suggested.unitPrice, "0");
  assert.match(editor, /value=\{draft\.unitPrice\} onChange=\{e => setDraft\(\{ \.\.\.draft, unitPrice: e\.target\.value \}\)\}/);
  assert.match(editor, /تكلفة الوحدة التقديرية في خطة التنفيذ ليست سعر البيع/);
  assert.match(editor, /مستقل عن تكلفة التخطيط وعن سعر عقد المالك/);
});

test("saved owner BOQ rows are fetched by this contract and appear after reopening edit", () => {
  assert.match(editor, /ownerContractId=\$\{contractId\}/);
  assert.match(editor, /contractId \? fetch\(`\$\{API\}\$\{path\}`/);
  assert.match(editor, /setRows\(contractLines\)/);
  assert.match(editor, /rows\.map\(row => \(/);
  assert.match(editor, /editingId == null \? "POST" : "PUT"/);
  assert.match(editor, /ownerContractId: direction === "owner" \? contractId : null/);
  assert.match(detail, /setEditing\(null\);\s+void load\(\)/);
  assert.match(detail, /setEditing\(c\)/);
  assert.match(detail, /key=\{`\$\{projectId\}:owner:\$\{editing\.id \?\? "new"\}`\}/);
  assert.match(detail, /persistedContractId\.current = null;\s+setEditing\(null\)/);
});

test("existing agreements offer an explicit editable import of only missing WBS items", () => {
  assert.match(editor, /contractId != null && direction === "owner" && contractType === "main"/);
  assert.match(editor, /data-testid="import-project-work-items"/);
  assert.match(editor, /!rows\.some\(row => row\.workItemId === item\.id\)/);
  assert.match(editor, /!\(pendingLines \?\? \[\]\)\.some\(line => Number\(line\.workItemId\) === item\.id\)/);
  assert.match(editor, /availableWorkItems[\s\S]*\.map\(contractWorkItemDefaults\)/);
  assert.match(editor, /ستظهر كمسودات قابلة للتعديل؛ احفظ العقد لتسجيلها/);
  assert.match(editor, /!loading && !loadError && rows\.length === 0/);
});

test("an approved owner contract stages its draft and both priced BOQ rows before approval", () => {
  const save = detail.slice(detail.indexOf("  async function save() {", detail.indexOf("function OwnerContractTab(")),
    detail.indexOf("  async function del(", detail.indexOf("function OwnerContractTab(")));
  const draft = save.indexOf('status: "draft"');
  const contractWrite = save.indexOf('const r = await fetch(url,');
  const lineWrite = save.indexOf('await fetch(`${API}/api/contracting/projects/${projectId}/boq-lines`');
  const approval = save.indexOf('await fetch(approvalUrl,');
  assert.ok(draft >= 0 && draft < contractWrite && contractWrite < lineWrite && lineWrite < approval);
  assert.match(save, /for \(const line of pendingBoqLines \?\? \[\]\)/);
  assert.match(save, /ownerContractId: contractId/);
  assert.match(save, /workItemId: Number\(line\.workItemId\)/);
  assert.match(save, /quantity: line\.quantity, unitPrice: line\.unitPrice/);
  assert.match(save, /persistedContractId\.current = contractId/);
  assert.match(save, /existingStatus.*?persistedContractId\.current \? "draft" : undefined/s);
  assert.match(save, /change-order-decision/);
  assert.match(save, /owner-contracts\/\$\{contractId\}\/approve/);
  assert.match(save, /if \(!approvalResponse\.ok\) throw new Error/);
});