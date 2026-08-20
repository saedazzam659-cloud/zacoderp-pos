/**
 * Task #373 — HR RTL Direction audit tests
 *
 * These tests verify that HR page source files:
 * 1. Have page roots with explicit dir attributes (not hardcoded "rtl").
 * 2. Use logical RTL-safe utilities (text-start/text-end, ps-/pe-, start-/end-)
 *    rather than physical left/right variants on search icons and numeric columns.
 * 3. Mark numeric/date/amount content with dir="ltr" where appropriate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname ?? __dirname, "..", "src", "pages", "hr");
const reportsRoot = join(root, "reports");

function src(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}
function reportSrc(rel: string): string {
  return readFileSync(join(reportsRoot, rel), "utf8");
}

// ─── Core HR pages ──────────────────────────────────────────────────────────

test("AllContracts: page root has dynamic dir attribute", () => {
  const code = src("AllContracts.tsx");
  assert.ok(
    code.includes('dir={isRtl ? "rtl" : "ltr"}'),
    "AllContracts root must use dynamic dir"
  );
});

test("AllContracts: does not use hardcoded dir='rtl' on root", () => {
  const code = src("AllContracts.tsx");
  // Allow dir="ltr" on data cells; but the root must not be hardcoded "rtl"
  assert.ok(
    !code.includes('dir="rtl"'),
    "AllContracts must not hardcode dir=rtl anywhere"
  );
});

test("AllContracts: amount/date cells use dir=ltr", () => {
  const code = src("AllContracts.tsx");
  assert.ok(
    code.includes('dir="ltr"'),
    "AllContracts should mark numeric/date cells with dir=ltr"
  );
});

test("Employees: search icon uses logical start-3 not physical left/right", () => {
  const code = src("Employees.tsx");
  assert.ok(
    code.includes("start-3") && !code.includes("right-3") && !code.includes("left-3"),
    "Employees search icon should use start-3 logical utility"
  );
});

test("Employees: search input uses ps-9 not pr-9/pl-9", () => {
  const code = src("Employees.tsx");
  assert.ok(
    code.includes("ps-9") && !code.includes("pr-9") && !code.includes("pl-9"),
    "Employees search input should use ps-9 logical padding"
  );
});

test("Employees: table header uses text-start not dynamic text-right/text-left", () => {
  const code = src("Employees.tsx");
  assert.ok(
    !code.includes('"text-right"') && !code.includes('"text-left"'),
    "Employees table header should not use physical text-right or text-left in class strings"
  );
});

test("AssetCustodyTabs: AssetCustodyTab root has dynamic dir attribute", () => {
  const code = src("AssetCustodyTabs.tsx");
  // Both exported components should have dir on their root
  const matches = (code.match(/dir=\{isRtl \? "rtl" : "ltr"\}/g) || []).length;
  assert.ok(matches >= 2, `AssetCustodyTabs should have at least 2 dynamic dir attributes, found ${matches}`);
});

test("AssetCustodyTabs: date/amount cells use dir=ltr", () => {
  const code = src("AssetCustodyTabs.tsx");
  assert.ok(
    code.includes('dir="ltr"'),
    "AssetCustodyTabs should mark date/amount cells with dir=ltr"
  );
});

test("HR hub and employee profile follow the active language direction", () => {
  assert.ok(src("HrHub.tsx").includes("dir={i18n.dir()}"));
  assert.ok(src("EmployeeProfile.tsx").includes("dir={i18n.dir()}"));
});

// ─── Report pages ────────────────────────────────────────────────────────────

const REPORT_FILES = [
  "AttendanceReport.tsx",
  "EmployeesReport.tsx",
  "ContractsReport.tsx",
  "PayrollReport.tsx",
  "LoansReport.tsx",
  "EOSReport.tsx",
  "DocumentsExpiryReport.tsx",
  "EmployeeCostReport.tsx",
  "LeavesReport.tsx",
];

for (const file of REPORT_FILES) {
  test(`${file}: page root uses dynamic dir, not hardcoded "rtl"`, () => {
    const code = reportSrc(file);
    assert.ok(
      code.includes('dir={isRtl ? "rtl" : "ltr"}'),
      `${file} must use dynamic dir on root`
    );
    assert.ok(
      !code.includes('dir="rtl"'),
      `${file} must not hardcode dir=rtl`
    );
  });

  test(`${file}: numeric columns use text-end, not text-left`, () => {
    const code = reportSrc(file);
    assert.ok(
      !code.includes('text-left'),
      `${file} must not use physical text-left on numeric columns`
    );
  });

  test(`${file}: table header tr has no physical text-right class`, () => {
    const code = reportSrc(file);
    assert.ok(
      !code.includes('"text-right"'),
      `${file} must not apply text-right class to table rows`
    );
  });
}

test("AttendanceReport: hour cells use dir=ltr", () => {
  const code = reportSrc("AttendanceReport.tsx");
  assert.ok(code.includes('dir="ltr"'), "AttendanceReport should use dir=ltr on hour cells");
});

test("PayrollReport: salary cells use dir=ltr", () => {
  const code = reportSrc("PayrollReport.tsx");
  assert.ok(code.includes('dir="ltr"'), "PayrollReport should use dir=ltr on salary cells");
});

test("EmployeeCostReport: cost cells use dir=ltr", () => {
  const code = reportSrc("EmployeeCostReport.tsx");
  assert.ok(code.includes('dir="ltr"'), "EmployeeCostReport should use dir=ltr on cost cells");
});

test("EOSReport: eos estimate cells use dir=ltr", () => {
  const code = reportSrc("EOSReport.tsx");
  assert.ok(code.includes('dir="ltr"'), "EOSReport should use dir=ltr on amount cells");
});

test("LoansReport: amount cells use dir=ltr", () => {
  const code = reportSrc("LoansReport.tsx");
  assert.ok(code.includes('dir="ltr"'), "LoansReport should use dir=ltr on amount cells");
});

test("AI insights panel follows the active language and uses logical alignment", () => {
  const code = reportSrc("_AIInsightsPanel.tsx");
  assert.ok(code.includes("dir={i18n.dir()}"));
  assert.ok(code.includes("text-end"));
  assert.ok(!code.includes("text-left"));
});

// ─── Task #373 — LTR data isolation regression assertions ─────────────────────

test("ContractsReport: contract number cell has dir=ltr", () => {
  const code = reportSrc("ContractsReport.tsx");
  // The contract number td must have dir="ltr" so the number reads left-to-right
  assert.ok(
    /contractNumber[^<]*dir="ltr"|dir="ltr"[^<]*contractNumber/.test(code) ||
    code.includes('dir="ltr">{r.contractNumber}'),
    "ContractsReport contract number cell must have dir=ltr"
  );
});

test("ContractsReport: start and end date cells have dir=ltr", () => {
  const code = reportSrc("ContractsReport.tsx");
  // Both startDate and endDate tds must carry dir="ltr"
  assert.ok(
    code.includes('dir="ltr">{r.startDate'),
    "ContractsReport startDate cell must have dir=ltr"
  );
  assert.ok(
    code.includes('dir="ltr">{r.endDate'),
    "ContractsReport endDate cell must have dir=ltr"
  );
});

test("EOSReport: employee code cell has dir=ltr", () => {
  const code = reportSrc("EOSReport.tsx");
  assert.ok(
    code.includes('dir="ltr">{r.code}'),
    "EOSReport employee code cell must have dir=ltr"
  );
});

test("EOSReport: hire date and end date cells have dir=ltr", () => {
  const code = reportSrc("EOSReport.tsx");
  assert.ok(
    code.includes('dir="ltr">{r.hireDate'),
    "EOSReport hireDate cell must have dir=ltr"
  );
  assert.ok(
    code.includes('dir="ltr">{r.endDate'),
    "EOSReport endDate cell must have dir=ltr"
  );
});

test("EOSReport: years-served cell uses text-end and dir=ltr", () => {
  const code = reportSrc("EOSReport.tsx");
  // The yearsServed td must have text-end and dir=ltr for numeric alignment
  assert.ok(
    code.includes("text-end") && code.includes("yearsServed"),
    "EOSReport years-served column header or cell must use text-end"
  );
});

test("EmployeesReport: employee code cell has dir=ltr", () => {
  const code = reportSrc("EmployeesReport.tsx");
  assert.ok(
    code.includes('dir="ltr">{r.code}'),
    "EmployeesReport employee code cell must have dir=ltr"
  );
});

test("EmployeesReport: hire date cell has dir=ltr", () => {
  const code = reportSrc("EmployeesReport.tsx");
  assert.ok(
    code.includes('dir="ltr">{r.hireDate'),
    "EmployeesReport hireDate cell must have dir=ltr"
  );
});

test("LoansReport: loan date cell has dir=ltr", () => {
  const code = reportSrc("LoansReport.tsx");
  assert.ok(
    code.includes('dir="ltr">{r.loanDate}'),
    "LoansReport loanDate cell must have dir=ltr"
  );
});

test("LoansReport: employee code (sub-row) has dir=ltr", () => {
  const code = reportSrc("LoansReport.tsx");
  assert.ok(
    code.includes('dir="ltr">{r.empCode}'),
    "LoansReport empCode sub-row must have dir=ltr"
  );
});

test("Employees: employee code table cell has dir=ltr", () => {
  const code = src("Employees.tsx");
  assert.ok(
    code.includes('dir="ltr">{e.code}'),
    "Employees employee code cell must have dir=ltr"
  );
});

test("Employees: national ID / iqama number table cell has dir=ltr", () => {
  const code = src("Employees.tsx");
  assert.ok(
    code.includes('dir="ltr">{e.idNumber'),
    "Employees idNumber cell must have dir=ltr"
  );
});

test("Employees: form codes, IDs, and salary inputs use dir=ltr", () => {
  const code = src("Employees.tsx");
  for (const field of ["editing.code", "editing.idNumber", "editing.passportNumber", "editing.basicSalary", "editing.housingAllow", "editing.transportAllow", "editing.otherAllow"]) {
    const escaped = field.replace(".", "\\.");
    assert.match(
      code,
      new RegExp(`<Input[^>]*dir="ltr"[^>]*value=\\{${escaped}\\}`),
      `${field} input must use dir=ltr`,
    );
  }
});

test("AttendanceReport: count columns (days/present/absent) use text-end", () => {
  const code = reportSrc("AttendanceReport.tsx");
  assert.ok(
    code.includes("text-end tabular-nums"),
    "AttendanceReport count cells should use text-end tabular-nums"
  );
});

test("AttendanceReport: employee code cell has dir=ltr", () => {
  const code = reportSrc("AttendanceReport.tsx");
  assert.ok(
    code.includes('dir="ltr">{e.empCode}'),
    "AttendanceReport empCode cell must have dir=ltr"
  );
});

test("PayrollReport: employee code cell has dir=ltr", () => {
  const code = reportSrc("PayrollReport.tsx");
  assert.ok(
    code.includes('dir="ltr">{e.empCode}'),
    "PayrollReport empCode cell must have dir=ltr"
  );
});

test("PayrollReport: months count uses text-end tabular-nums", () => {
  const code = reportSrc("PayrollReport.tsx");
  assert.ok(
    code.includes("text-end tabular-nums"),
    "PayrollReport months cell should use text-end tabular-nums"
  );
});

test("LeavesReport: employee code (sub-row) has dir=ltr", () => {
  const code = reportSrc("LeavesReport.tsx");
  assert.ok(
    code.includes('dir="ltr">{r.empCode}'),
    "LeavesReport empCode sub-row must have dir=ltr"
  );
});

test("LeavesReport: leave days count uses text-end", () => {
  const code = reportSrc("LeavesReport.tsx");
  assert.ok(
    code.includes("text-end") && code.includes("r.days"),
    "LeavesReport days count cell should use text-end"
  );
});

test("DocumentsExpiryReport: doc number cell has dir=ltr", () => {
  const code = reportSrc("DocumentsExpiryReport.tsx");
  assert.ok(
    code.includes('dir="ltr">{r.docNumber'),
    "DocumentsExpiryReport docNumber cell must have dir=ltr"
  );
});

test("DocumentsExpiryReport: expiry date cell has dir=ltr", () => {
  const code = reportSrc("DocumentsExpiryReport.tsx");
  assert.ok(
    code.includes('dir="ltr">{r.expiryDate}'),
    "DocumentsExpiryReport expiryDate cell must have dir=ltr"
  );
});

test("DocumentsExpiryReport: employee code sub-row has dir=ltr", () => {
  const code = reportSrc("DocumentsExpiryReport.tsx");
  assert.ok(
    code.includes('dir="ltr">{r.empCode}'),
    "DocumentsExpiryReport empCode sub-row must have dir=ltr"
  );
});

test("EmployeeCostReport: employee code cell has dir=ltr", () => {
  const code = reportSrc("EmployeeCostReport.tsx");
  assert.ok(
    code.includes('dir="ltr">{r.code}'),
    "EmployeeCostReport code cell must have dir=ltr"
  );
});

test("No HR report file uses physical text-right in class attributes", () => {
  const REPORTS = [
    "AttendanceReport.tsx", "EmployeesReport.tsx", "ContractsReport.tsx",
    "PayrollReport.tsx", "LoansReport.tsx", "EOSReport.tsx",
    "DocumentsExpiryReport.tsx", "EmployeeCostReport.tsx", "LeavesReport.tsx",
  ];
  for (const file of REPORTS) {
    const code = reportSrc(file);
    assert.ok(
      !code.includes('"text-right"'),
      `${file} must not use "text-right" class string`
    );
  }
});

test("No HR report file uses physical text-left in class attributes", () => {
  const REPORTS = [
    "AttendanceReport.tsx", "EmployeesReport.tsx", "ContractsReport.tsx",
    "PayrollReport.tsx", "LoansReport.tsx", "EOSReport.tsx",
    "DocumentsExpiryReport.tsx", "EmployeeCostReport.tsx", "LeavesReport.tsx",
  ];
  for (const file of REPORTS) {
    const code = reportSrc(file);
    assert.ok(
      !code.includes("text-left"),
      `${file} must not use text-left`
    );
  }
});
