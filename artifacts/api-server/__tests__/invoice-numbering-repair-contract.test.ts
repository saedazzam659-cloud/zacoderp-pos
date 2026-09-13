// Contract guard for the SuperAdmin-only invoice-number repair surface.
// Kept database-free: the behavioural checks protect the safety boundaries
// even in CI environments that do not provide DATABASE_URL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve(import.meta.dirname, "../src/routes/admin.ts"), "utf8");

test("invoice repair is a SA-only, read-first API contract", () => {
  assert.match(source, /router\.get\("\/companies\/:id\/invoice-numbering-repair", requireSuperAdmin/);
  assert.match(source, /router\.post\("\/companies\/:id\/invoice-numbering-repair", requireSuperAdmin/);
  assert.match(source, /exactDuplicates/);
  assert.match(source, /numericEquivalentDuplicates/);
  assert.match(source, /runWithAgentScope\(req, res/);
});

test("invoice repair never permits legal ZATCA or posted purchase changes", () => {
  assert.match(source, /zatca_uuid.*xml_content.*invoice_hash/s);
  assert.match(source, /invoice\.status !== "draft" \|\| signed/);
  assert.match(source, /مسودة غير موقعة فقط/);
  const repairBlock = source.slice(source.indexOf('router.post("/companies/:id/invoice-numbering-repair"'));
  assert.doesNotMatch(repairBlock.slice(0, repairBlock.indexOf('// PUT /api/admin/companies/:id/journal-sequence-control')),
    /SET (?:[^;]*)(?:zatca_uuid|zatca_icv|zatca_pih|invoice_hash|xml_content)\s*=/);
});

test("counter reclaim fails closed unless its log is a deleted draft", () => {
  assert.match(source, /payload->>'status' = 'draft'/);
  assert.match(source, /restored_at IS NULL/);
  assert.match(source, /لا يمكن إعادة استخدامه/);
  assert.match(source, /LIMIT 1 FOR UPDATE/);
  assert.match(source, /sequence_counters[\s\S]*FOR UPDATE/);
  assert.match(source, /superadmin_sequence_repair/);
});

test("draft correction locks only the invoice row and cannot rewind its counter", () => {
  assert.match(source, /LEFT JOIN customers c[\s\S]*FOR UPDATE OF i/);
  assert.match(source, /Math\.max\(currentCounter, parts\.suffix \+ 1\)/);
  assert.match(source, /رقم أو مكافئه الرقمي مستخدم في نفس مسار/);
  assert.match(source, /COALESCE\(i\.branch_id, 0\) = \$\{scope\.branchId\}/);
  assert.match(source, /to_char\(i\.invoice_date, 'YYYY-MM'\)/);
});