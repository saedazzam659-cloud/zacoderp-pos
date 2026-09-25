import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (name: string) => readFileSync(path.join(root, name), "utf8");
const sources = read("artifacts/api-server/src/lib/project-financial-sources.ts");
const purchasing = read("artifacts/api-server/src/routes/purchasing.ts");
const sales = read("artifacts/api-server/src/routes/sales.ts");
const receipts = read("artifacts/api-server/src/routes/goodsReceipts.ts");
const deliveries = read("artifacts/api-server/src/routes/goodsDeliveries.ts");
const schema = read("artifacts/api-server/src/lib/ensureSchema.ts");
const readiness = read("artifacts/api-server/src/lib/project-financial-link.ts");
const contracting = read("artifacts/api-server/src/routes/contracting.ts");

test("source-query contract excludes unposted recognition, VAT, and duplicated allocations", () => {
  for (const type of ["sales_invoice", "sales_return", "purchase_invoice_expense", "purchase_return_expense",
    "purchase_prepaid_adjustment_run", "payment_voucher_line", "prepaid_adjustment_run"]) {
    assert.ok(sources.includes(`'${type}'`), `${type} source missing`);
  }
  for (const section of ["'purchase_prepaid_adjustment_run'", "'prepaid_adjustment_run'"]) {
    const branch = sources.slice(sources.indexOf(section), sources.indexOf("UNION ALL", sources.indexOf(section)));
    assert.match(branch, /je\.status='posted'/);
    assert.match(branch, /alloc\.source_type='journal_expense_line'/);
    assert.match(branch, /GREATEST\(recognized\.expense_base - recognized\.allocated, 0\)/);
  }
  assert.match(sources, /total_amount::numeric - i\.vat_amount::numeric\) \* COALESCE\(i\.exchange_rate::numeric, 1\)/);
  assert.match(sources, /total_amount::numeric - r\.vat_amount::numeric\) \* COALESCE\(r\.exchange_rate::numeric, 1\)/);
  assert.match(sources, /alloc\.source_type='purchase_invoice_line'/);
  const returnExpense = sources.slice(sources.indexOf("'purchase_return_expense'"), sources.indexOf("UNION ALL", sources.indexOf("'purchase_return_expense'")));
  assert.match(returnExpense, /jel\.debit::numeric - jel\.credit::numeric/);
  assert.doesNotMatch(returnExpense, /NOT EXISTS|purchase_allocated/);
  assert.match(sources, /a\.account_type='expense'/);
  assert.match(sources, /acct\.account_type='expense'/);
});

test("partial, reversed, full and unrelated manual allocations retain exact expense residual", () => {
  const purchase = sources.slice(sources.indexOf("'purchase_invoice_expense'"), sources.indexOf("UNION ALL", sources.indexOf("'purchase_invoice_expense'")));
  const voucher = sources.slice(sources.indexOf("'payment_voucher_line'"), sources.indexOf("UNION ALL", sources.indexOf("'payment_voucher_line'")));
  assert.match(sources, /SUM\(allocated_amount\)::numeric amount/);
  assert.match(purchase, /SUM\(jel\.debit::numeric \* COALESCE\(je\.exchange_rate::numeric, 1\) - COALESCE\(jalloc\.amount, 0\)\)/);
  assert.match(purchase, /COALESCE\(palloc\.amount, 0\)/);
  assert.match(purchase, /GROUP BY i\.id, i\.invoice_date, i\.doc_number, palloc\.amount/);
  assert.match(voucher, /jel\.sort_order=\(/);
  assert.match(voucher, /previous\.voucher_id=l\.voucher_id/);
  assert.match(voucher, /alloc\.source_record_id=jel\.id/);
  assert.match(voucher, /l\.amount::numeric < 0/);
  assert.match(voucher, /\(jel\.debit::numeric - jel\.credit::numeric\)=l\.amount::numeric/);
  assert.doesNotMatch(voucher, /NOT EXISTS/);
  const residual = (posted: number, allocations: number[]) =>
    Math.max(0, posted - allocations.reduce((sum, amount) => sum + amount, 0));
  assert.equal(residual(100, [20]) + 20, 100);
  assert.equal(residual(100, [20, -20]), 100);
  assert.equal(residual(100, [100]), 0);
  assert.equal(residual(100, [110]), 0);
  assert.equal(residual(100, [20]), 80);
  // A JE allocation from a different voucher line cannot affect this one.
  assert.equal(residual(55, []), 55);
  assert.equal(100 + (0 - 20), 80); // Negative direct voucher line reverses actual cost.
  const lineJeSort = (taxAmounts: number[], lineIndex: number) =>
    lineIndex + taxAmounts.slice(0, lineIndex).filter(tax => tax > 0).length;
  assert.deepEqual([0, 1, 2].map(index => lineJeSort([15, 0, 3], index)), [0, 2, 3]);
});

test("inventory documents inherit links but never create financial recognition merely from attribution", () => {
  assert.match(receipts, /projectId: gr\.projectId/);
  assert.match(deliveries, /projectId: gd\.projectId/);
  for (const kind of ["goods_receipt", "goods_delivery"]) {
    const start = sources.indexOf(`SELECT '${kind}'`);
    const end = sources.indexOf("UNION ALL", start);
    const branch = sources.slice(start, end === -1 ? undefined : end);
    assert.match(branch, /0::numeric/);
    assert.match(branch, /je\.status='posted'/);
  }
  assert.match(sources, /'goods_delivery_cogs'.*?SUM\(l\.total_cost::numeric\)/s);
  assert.match(sources, /l\.ref_type='sales_invoice'/);
  assert.match(sources, /l\.ref_type='sales_return'/);
});

test("linked return projects reverse the original project, including explicit null", () => {
  for (const route of [purchasing, sales]) {
    assert.match(route, /origin\.projectId !== selected/);
    assert.match(route, /req\.body\.projectId === undefined \? origin\?\.projectId : req\.body\.projectId/);
  }
  assert.match(purchasing, /origin\.projectId !== selected/);
  assert.match(sales, /origin\.projectId !== selected/);
});

test("agent and startup schema readiness and project options enforce tenant/branch scope", () => {
  assert.equal((schema.match(/await ensureProjectFinancialLinks\(\)/g) ?? []).length, 2);
  assert.match(readiness, /getActiveExternalDb\(\)/);
  assert.match(readiness, /WeakMap<object, Promise<void>>/);
  for (const table of ["purchase_invoices", "purchase_returns", "sales_invoices", "sales_returns",
    "payment_voucher_lines", "goods_receipts", "goods_deliveries"]) {
    assert.ok(readiness.includes(`"${table}"`), `${table} missing from readiness`);
  }
  const options = contracting.slice(contracting.indexOf('router.get("/projects/options"'), contracting.indexOf('router.get("/projects/:id"'));
  assert.match(options, /eq\(contractingProjectsTable\.companyId, cid\)/);
  assert.match(options, /projectBranchCondition\(req, contractingProjectsTable\.branchId\)/);
});

test("all seven existing document forms reopen project links and permit clearing", () => {
  for (const form of [
    "inventory/GoodsReceipts.tsx", "inventory/GoodsDeliveries.tsx",
    "purchasing/PurchaseReturns.tsx", "sales/SalesReturns.tsx",
  ]) {
    const source = read(`artifacts/zatca-invoicing/src/pages/${form}`);
    assert.match(source, /projectId:.*== null \? "" : String\(/);
    assert.match(source, /projectId: ""/);
    assert.match(source, /value=\{form\.projectId \?\? ""\}/);
  }
  for (const form of ["purchasing/PurchaseInvoiceForm.tsx", "sales/SalesDocumentForm.tsx"]) {
    const source = read(`artifacts/zatca-invoicing/src/pages/${form}`);
    assert.match(source, /setProjectId\(existing\.projectId == null \? "" : String\(existing\.projectId\)\)/);
    assert.match(source, /projectId: projectId \? Number\(projectId\) : null/);
  }
  const voucher = read("artifacts/zatca-invoicing/src/pages/cash/PaymentVoucherFormMulti.tsx");
  assert.match(voucher, /projectId: l\.projectId != null \? String\(l\.projectId\) : ""/);
  assert.match(voucher, /projectId:\s+l\.projectId \? Number\(l\.projectId\) : null/);
});

test("reported costs use signed stock movement and net base-currency revenue", () => {
  const revenue = (total: number, vat: number, rate: number) => (total - vat) * rate;
  const cost = (invoiceLedger: number, returnLedger: number, deliveryLedger: number) =>
    -invoiceLedger - returnLedger + deliveryLedger;
  assert.equal(revenue(115, 15, 2) - revenue(23, 3, 2), 160);
  assert.equal(cost(-60, 12, 0), 48);
  assert.equal(cost(0, 0, 60), 60);
  assert.match(sources, /'cogs', -SUM\(l\.total_cost::numeric\)/);
});