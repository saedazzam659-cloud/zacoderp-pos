#!/usr/bin/env node
/**
 * audit-branch-filter.cjs
 *
 * Enforces the **Branch Filter Policy (MANDATORY)** documented in
 * `replit.md` by scanning every report page under
 *   artifacts/zatca-invoicing/src/pages/**
 * whose filename matches a known report pattern, and warning on any
 * file that does not import the canonical `BranchFilter` component.
 *
 * Exit code 0 → all reports compliant.
 * Exit code 1 → at least one report is missing BranchFilter; CI / PRs
 *               should treat this as a blocker.
 *
 * Run from the repo root:
 *   pnpm audit:branch-filter
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAGES_DIR = path.join(ROOT, "artifacts/zatca-invoicing/src/pages");

const REPORT_PATTERNS = [
  /Report\.tsx$/,
  /Statement\.tsx$/,
  /Balances\.tsx$/,
  /Aging.*\.tsx$/i,
  /By(Customer|Item|Period|Supplier|Branch|Account)\.tsx$/,
  /^VATDeclaration\.tsx$/,
  /^ZatcaReport\.tsx$/,
  /^IncomeStatement\.tsx$/,
  /^AccountStatement\.tsx$/,
  /^CashFlowReport\.tsx$/,
  /^TopCustomers\.tsx$/,
  /^TrialBalance\.tsx$/,
  /^GeneralLedger\.tsx$/,
];

const ALLOWLIST = new Set([
  // Pages that legitimately do not need a branch filter (e.g. reports that
  // operate on entities without a branchId column). Add the BASENAME only,
  // and document why next to it.
  "VATDeclaration.tsx", // ZATCA invoicesTable has no branchId column — VAT declaration aggregates across all branches.
  "LowStockReport.tsx", // warehousesTable has no branchId column — stock balance is per-warehouse only.
]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function isReport(file) {
  const base = path.basename(file);
  return REPORT_PATTERNS.some((re) => re.test(base));
}

function hasBranchFilter(src) {
  return /from\s+["']@\/components\/BranchFilter["']/.test(src) ||
         /<BranchFilter[\s/>]/.test(src);
}

const all = walk(PAGES_DIR);
const reports = all.filter(isReport);
const missing = [];

for (const file of reports) {
  const base = path.basename(file);
  if (ALLOWLIST.has(base)) continue;
  const src = fs.readFileSync(file, "utf8");
  if (!hasBranchFilter(src)) missing.push(path.relative(ROOT, file));
}

console.log(`Branch Filter audit — scanned ${reports.length} report page(s).`);

if (missing.length === 0) {
  console.log("OK: every report imports the canonical BranchFilter.");
  process.exit(0);
}

console.error("");
console.error(`FAIL: ${missing.length} report page(s) missing BranchFilter:`);
for (const m of missing) console.error("  - " + m);
console.error("");
console.error("Per the Branch Filter Policy (MANDATORY) in replit.md, every");
console.error("report MUST mount <BranchFilter /> from");
console.error("  artifacts/zatca-invoicing/src/components/BranchFilter.tsx");
console.error("at the top of its filter bar, thread `branchId` through the");
console.error("API helper + queryKey + exports, and rely on backend");
console.error("`branchScopeFilter()` for per-user enforcement.");
process.exit(1);
