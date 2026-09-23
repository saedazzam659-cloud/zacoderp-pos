import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "@workspace/db";
import {
  createContractingCostAllocation,
  ensureContractingCostAllocationTables,
  listContractingCostAllocations,
  reverseContractingCostAllocation,
} from "../src/lib/contracting-cost-allocation-service.ts";

const armed = process.env.CONTRACTING_COST_ALLOCATIONS_PG === "1";
const admin = {
  id: 1,
  role: "admin",
  viewAllBranches: true,
  branchIds: [],
} as const;

test("actual PostgreSQL serializes source capacity and preserves analytical reversals", {
  skip: !armed,
}, async () => {
  await ensureContractingCostAllocationTables();
  const suffix = `${process.pid}-${Date.now()}`;
  const companyId = Number((await pool.query(`
    INSERT INTO companies(name_ar, vat_number, cr_number, city, street, building_number, postal_code)
    VALUES ($1,$2,$3,'Riyadh','Test','1','12345') RETURNING id
  `, [`Cost allocation ${suffix}`, `vat-${suffix}`, `cr-${suffix}`])).rows[0].id);
  const userId = Number((await pool.query(`
    INSERT INTO users(company_id, username, password_hash, role, is_active)
    VALUES ($1,$2,'test','admin',true) RETURNING id
  `, [companyId, `cost-${suffix}`])).rows[0].id);
  const projectId = Number((await pool.query(`
    INSERT INTO contracting_projects(company_id, code, name_ar)
    VALUES ($1,$2,'Project') RETURNING id
  `, [companyId, `COST-${suffix}`])).rows[0].id);
  const invoiceId = Number((await pool.query(`
    INSERT INTO purchase_invoices(
      company_id, invoice_date, status, journal_entry_id
    ) VALUES ($1,CURRENT_DATE::text,'posted',987654) RETURNING id
  `, [companyId])).rows[0].id);
  const expenseAccountId = Number((await pool.query(`
    INSERT INTO accounts(company_id, code, name_ar, account_type)
    VALUES ($1,$2,'Site expense','expense') RETURNING id
  `, [companyId, `EXP-${suffix}`])).rows[0].id);
  const sourceRecordId = Number((await pool.query(`
    INSERT INTO purchase_invoice_lines(
      invoice_id, company_id, item_name, qty, unit_price, line_total, final_cost, account_id
    ) VALUES ($1,$2,'Site service',1,100,100,100,$3) RETURNING id
  `, [invoiceId, companyId, expenseAccountId])).rows[0].id);
  const actingAdmin = { ...admin, id: userId };

  const attempts = await Promise.allSettled([
    createContractingCostAllocation(companyId, projectId, {
      sourceType: "purchase_invoice_line",
      sourceRecordId,
      amount: 80,
      idempotencyKey: `a-${suffix}`,
    }, actingAdmin),
    createContractingCostAllocation(companyId, projectId, {
      sourceType: "purchase_invoice_line",
      sourceRecordId,
      amount: 80,
      idempotencyKey: `b-${suffix}`,
    }, actingAdmin),
  ]);
  assert.equal(
    attempts.filter(row => row.status === "fulfilled").length,
    1,
    attempts.map(row => row.status === "rejected" ? String(row.reason?.message ?? row.reason) : "fulfilled").join(" | "),
  );
  assert.equal(attempts.filter(row => row.status === "rejected").length, 1);

  const original = (await listContractingCostAllocations(
    companyId, projectId, actingAdmin,
  )).allocations.find(row => Number(row.allocated_amount) > 0);
  assert.ok(original);
  const reversal = await reverseContractingCostAllocation(
    companyId, original.id, `reverse-${suffix}`, actingAdmin,
  );
  assert.equal(Number(reversal.allocated_amount), -80);
  await assert.rejects(
    reverseContractingCostAllocation(
      companyId, original.id, `reverse-again-${suffix}`, actingAdmin,
    ),
    /مسبقاً/,
  );

  const replacement = await createContractingCostAllocation(companyId, projectId, {
    sourceType: "purchase_invoice_line",
    sourceRecordId,
    amount: 100,
    idempotencyKey: `replacement-${suffix}`,
  }, actingAdmin);
  assert.equal(Number(replacement.allocated_amount), 100);

  const inventoryAccountId = Number((await pool.query(`
    INSERT INTO accounts(company_id, code, name_ar, account_type)
    VALUES ($1,$2,'Inventory capitalization','asset') RETURNING id
  `, [companyId, `INV-${suffix}`])).rows[0].id);
  const capitalizedLineId = Number((await pool.query(`
    INSERT INTO purchase_invoice_lines(
      invoice_id, company_id, item_name, qty, unit_price, line_total, final_cost, account_id
    ) VALUES ($1,$2,'Capitalized stock',1,25,25,25,$3) RETURNING id
  `, [invoiceId, companyId, inventoryAccountId])).rows[0].id);
  await assert.rejects(
    createContractingCostAllocation(companyId, projectId, {
      sourceType: "purchase_invoice_line",
      sourceRecordId: capitalizedLineId,
      category: "purchases",
      amount: 25,
      idempotencyKey: `capitalized-${suffix}`,
    }, actingAdmin),
    /غير موجود أو غير مرحّل/,
  );

  const otherCompanyId = Number((await pool.query(`
    INSERT INTO companies(name_ar, vat_number, cr_number, city, street, building_number, postal_code)
    VALUES ($1,$2,$3,'Riyadh','Test','1','12345') RETURNING id
  `, [`Other ${suffix}`, `vat-other-${suffix}`, `cr-other-${suffix}`])).rows[0].id);
  await assert.rejects(
    createContractingCostAllocation(otherCompanyId, projectId, {
      sourceType: "purchase_invoice_line",
      sourceRecordId,
      amount: 1,
      idempotencyKey: `cross-${suffix}`,
    }, actingAdmin),
    /المشروع غير موجود/,
  );
});