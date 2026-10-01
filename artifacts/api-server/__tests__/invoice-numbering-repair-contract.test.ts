// Contract guard for the SuperAdmin-only invoice-number repair surface.
// Kept database-free: the behavioural checks protect the safety boundaries
// even in CI environments that do not provide DATABASE_URL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve(import.meta.dirname, "../src/routes/admin.ts"), "utf8");
const uiSource = readFileSync(resolve(import.meta.dirname, "../../zatca-invoicing/src/pages/Companies.tsx"), "utf8");
const salesSource = readFileSync(resolve(import.meta.dirname, "../src/routes/sales.ts"), "utf8");
const purchasingSource = readFileSync(resolve(import.meta.dirname, "../src/routes/purchasing.ts"), "utf8");
const sequenceSource = readFileSync(resolve(import.meta.dirname, "../src/lib/sequences.ts"), "utf8");

test("invoice repair is a SA-only, read-first API contract", () => {
  assert.match(source, /router\.get\("\/companies\/:id\/invoice-numbering-repair", requireSuperAdmin/);
  assert.match(source, /router\.post\("\/companies\/:id\/invoice-numbering-repair", requireSuperAdmin/);
  assert.match(source, /exactDuplicates/);
  assert.match(source, /numericEquivalentDuplicates/);
  assert.match(source, /runWithAgentScope\(req, res/);
  assert.match(source, /supportsAtomicDraftRepair: true/);
  assert.match(source, /supportsLegacyReservationOverride: true/);
});

test("invoice repair never permits legal ZATCA or posted purchase changes", () => {
  assert.match(source, /zatca_uuid.*xml_content.*invoice_hash/s);
  assert.match(source, /invoice\.status !== "draft"/);
  assert.match(source, /if \(signed\)/);
  assert.match(source, /المستند له آثار ZATCA ولا يمكن تعديله/);
  const repairBlock = source.slice(source.indexOf('router.post("/companies/:id/invoice-numbering-repair"'));
  assert.doesNotMatch(repairBlock.slice(0, repairBlock.indexOf('// PUT /api/admin/companies/:id/journal-sequence-control')),
    /SET (?:[^;]*)(?:zatca_uuid|zatca_icv|zatca_pih|invoice_hash|xml_content)\s*=/);
});

test("counter reclaim fails closed unless its log is a deleted draft", () => {
  assert.match(source, /payload->>'status' = 'draft'/);
  assert.match(source, /restored_at IS NULL/);
  assert.match(source, /يفتقد إثبات حذف مسودة غير موقعة/);
  assert.match(source, /LIMIT 1 FOR UPDATE/);
  assert.match(source, /sequence_counters[\s\S]*FOR UPDATE/);
  assert.match(source, /superadmin_sequence_repair/);
});

test("draft correction locks only the invoice row and cannot rewind its counter", () => {
  assert.match(source, /LEFT JOIN customers c[\s\S]*FOR UPDATE OF i/);
  assert.match(source, /Math\.max\(currentCounter, parts\.suffix \+ 1\)/);
  assert.match(source, /محجوز بسجل فاتورة نشط/);
  assert.match(source, /COALESCE\(i\.branch_id, 0\) = \$\{scope\.branchId\}/);
  assert.match(source, /to_char\(i\.invoice_date, 'YYYY-MM'\)/);
});

test("atomic draft repair preflights without mutation and records exact release proof", () => {
  assert.match(source, /const resetNext = req\.body\?\.resetNext === true/);
  assert.match(source, /const dryRun = req\.body\?\.dryRun === true/);
  assert.match(source, /if \(dryRun\) return \{ \.\.\.result, canApply: true \}/);
  assert.match(source, /op: resetNext \? "draft_renumber_release"/);
  assert.match(source, /releasedSequenceLogIds/);
  assert.match(source, /metadata->'releasedSequenceLogIds' @>/);
  assert.match(source, /noZatcaArtifactsVerified/);
  assert.match(source, /invoiceNumberReclaimable/);
  assert.match(source, /await tx\.insert\(auditLogTable\)/);
});

test("legacy reservation exception is explicit, scoped, uncertain, and separately audited", () => {
  assert.match(source, /legacyReservationOverride/);
  assert.match(source, /legacyReservationReason\.length < 10/);
  assert.match(source, /legacyReservationReason\.length > 1000/);
  assert.match(source, /mode !== "correct_draft" \|\| !resetNext/);
  assert.match(source, /legacyReservationWarnings/);
  assert.match(source, /overriddenSequenceLogIds/);
  assert.match(source, /op: "manualLegacyReservationOverride"/);
  assert.match(source, /evidenceUncertainty: "unknownLegacyDeletionHistory"/);
  assert.match(source, /metadata->>'sequenceId'/);
  assert.match(source, /metadata->>'branchId'/);
  assert.match(source, /metadata->>'kind'/);
  assert.match(source, /KNOWN_ISSUED_LEGACY_CLAIM/);
  assert.doesNotMatch(source, /op: "manualLegacyReservationOverride"[\s\S]{0,1000}noZatcaArtifactsVerified/);
});

test("return numbering uses the correct tables, dates, series, and side-effect guards", () => {
  assert.match(source, /sales_return:\s*\{\s*table: "sales_returns", dateColumn: "return_date", sequenceBase: "sales_return"/s);
  assert.match(source, /purchase_return:\s*\{\s*table: "purchase_returns", dateColumn: "return_date", sequenceBase: "purchase_return"/s);
  assert.match(source, /supportsReturnNumberRepair: true/);
  assert.match(source, /companyWideUnique: true/);
  assert.match(source, /ACTIVE_RETURN_NUMBER/);
  assert.match(source, /meta\.isReturn && invoice\.journal_entry_id != null/);
  assert.match(source, /FROM stock_ledger[\s\S]*ref_type = \$\{refType\} AND ref_id = \$\{id\}/);
  assert.match(source, /const signed = meta\.hasZatca && hasKnownInvoiceFiscalEvidence\(invoice\)/);
  assert.match(source, /legacyReservationOverride && INVOICE_REPAIR_META\[kind\]\.isReturn/);
  assert.match(source, /invoiceRepairSequenceIsShared\(seq, kind\)/);
  assert.match(source, /current_number, monthly_reset, code, transaction_types/);
});

test("failed sales and purchase return creation rolls back its number reservation", () => {
  const salesCreate = salesSource.slice(
    salesSource.indexOf('router.post("/sales-returns"'),
    salesSource.indexOf('router.put("/sales-returns/:id"'),
  );
  const purchaseCreate = purchasingSource.slice(
    purchasingSource.indexOf('router.post("/purchase-returns"'),
    purchasingSource.indexOf('router.put("/purchase-returns/:id"'),
  );
  assert.match(sequenceSource, /nextSequenceNumber\(companyId, foreignSub, ctx, dx\)/);
  assert.match(sequenceSource, /nextSequenceNumber\(companyId, sub, ctx, dx\)/);
  assert.match(sequenceSource, /nextSequenceNumber\(companyId, baseType, ctx, dx\)/);
  assert.match(salesCreate, /db\.transaction\(async \(tx: any\) => \{[\s\S]*nextSequenceForPayment\(cid, "sales_return"[\s\S]*buyerIsForeign, tx\)[\s\S]*tx\.insert\(salesReturnLinesTable\)/);
  assert.match(purchaseCreate, /db\.transaction\(async \(tx: any\) => \{[\s\S]*nextSequenceForPayment\(cid, "purchase_return"[\s\S]*false, tx\)[\s\S]*insertPurchaseReturnWithSerialRepair\([\s\S]*?, tx\)[\s\S]*tx\.insert\(purchaseReturnLinesTable\)/);
});

test("Companies repair UI exposes both return kinds and checks server capability", () => {
  assert.match(uiSource, /option value="sales_return">مرتجعات المبيعات/);
  assert.match(uiSource, /option value="purchase_return">مرتجعات المشتريات/);
  assert.match(uiSource, /supportsReturnNumberRepair !== true/);
  assert.match(uiSource, /invoiceRepairKind === "sales_return"/);
});

test("repair UI sends legacy reservation fields only when the explicit exception is active", () => {
  const requestStart = uiSource.indexOf("const invoiceRepairRequest = {");
  const requestEnd = uiSource.indexOf("const invoiceRepairKey", requestStart);
  const request = uiSource.slice(requestStart, requestEnd);
  assert.match(request, /\.\.\.\(invoiceRepairLegacyActive \? \{/);
  assert.match(request, /legacyReservationOverride: true/);
  assert.match(request, /legacyReservationReason: invoiceRepairLegacyReason\.trim\(\)/);
  assert.doesNotMatch(request, /legacyReservationOverride:\s*invoiceRepairLegacyActive/);
  assert.match(uiSource, /body: JSON\.stringify\(\{ \.\.\.invoiceRepairRequest, kind, dryRun \}\)/);
});