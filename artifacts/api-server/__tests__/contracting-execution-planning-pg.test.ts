import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "@workspace/db";
import { ensureContractingExecutionSchema } from "../src/lib/contracting-execution-storage.ts";
import {
  listExecutionWorkItems,
  upsertResourceAnalysis,
} from "../src/lib/contracting-execution-service.ts";
import { createContractingCostAllocation } from "../src/lib/contracting-cost-allocation-service.ts";

const armed = process.env.CONTRACTING_EXECUTION_PG === "1";

test("PostgreSQL execution planning enforces project WBS/resource scope and reports incomplete actual cost", {
  skip: !armed,
}, async () => {
  await ensureContractingExecutionSchema();
  const suffix = `${process.pid}-${Date.now()}`;
  const companyId = Number((await pool.query(`
    INSERT INTO companies(name_ar, vat_number, cr_number, city, street, building_number, postal_code)
    VALUES ($1, $2, $3, 'Riyadh', 'Test', '1', '12345') RETURNING id
  `, [`Execution ${suffix}`, `vat-${suffix}`, `cr-${suffix}`])).rows[0].id);
  const project = async (code: string) => Number((await pool.query(`
    INSERT INTO contracting_projects(company_id, code, name_ar)
    VALUES ($1, $2, $2) RETURNING id
  `, [companyId, code])).rows[0].id);
  const projectId = await project(`EXEC-${suffix}`);
  const otherProjectId = await project(`OTHER-${suffix}`);
  const workItem = async (projectValue: number, name: string) => Number((await pool.query(`
    INSERT INTO contracting_work_items(
      company_id, project_id, name_ar, planned_qty, unit_cost, total_planned_cost, progress_percent
    ) VALUES ($1, $2, $3, 10, 25, 250, 40) RETURNING id
  `, [companyId, projectValue, name])).rows[0].id);
  const rootId = await workItem(projectId, "Root");
  const childId = await workItem(projectId, "Child");
  const foreignId = await workItem(otherProjectId, "Foreign");
  const userId = Number((await pool.query(`
    INSERT INTO users(company_id, username, password_hash, role, is_active)
    VALUES ($1,$2,'test','admin',true) RETURNING id
  `, [companyId, `execution-${suffix}`])).rows[0].id);

  await pool.query("UPDATE contracting_work_items SET parent_work_item_id=$1 WHERE id=$2", [rootId, childId]);
  await assert.rejects(
    pool.query("UPDATE contracting_work_items SET parent_work_item_id=$1 WHERE id=$2", [childId, rootId]),
    /WBS cycle/i,
  );

  const ownerContractId = Number((await pool.query(`
    INSERT INTO contracting_owner_contracts(
      company_id, project_id, contract_number, contract_date
    ) VALUES ($1,$2,$3,CURRENT_DATE) RETURNING id
  `, [companyId, projectId, `OWNER-${suffix}`])).rows[0].id);
  const ownerBoqId = Number((await pool.query(`
    INSERT INTO contracting_contract_boq_lines(
      company_id, project_id, work_item_id, direction, owner_contract_id,
      unit, quantity, unit_price, total_amount
    ) VALUES ($1,$2,$3,'owner',$4,'ea',1,100,100) RETURNING id
  `, [companyId, projectId, childId, ownerContractId])).rows[0].id);
  const contractorId = Number((await pool.query(`
    INSERT INTO contracting_contractors(company_id, name)
    VALUES ($1,'Execution subcontractor') RETURNING id
  `, [companyId])).rows[0].id);
  const subcontractId = Number((await pool.query(`
    INSERT INTO contracting_sub_contracts(
      company_id, project_id, contractor_id, contract_number, contract_date
    ) VALUES ($1,$2,$3,$4,CURRENT_DATE) RETURNING id
  `, [companyId, projectId, contractorId, `SUB-${suffix}`])).rows[0].id);
  await pool.query(`
    INSERT INTO contracting_contract_boq_lines(
      company_id, project_id, work_item_id, direction, subcontractor_contract_id,
      source_owner_line_id, unit, quantity, unit_price, total_amount
    ) VALUES ($1,$2,$3,'subcontract',$4,$5,'ea',1,80,80)
  `, [companyId, projectId, childId, subcontractId, ownerBoqId]);
  const invoiceId = Number((await pool.query(`
    INSERT INTO purchase_invoices(company_id, invoice_date, status, journal_entry_id)
    VALUES ($1,CURRENT_DATE::text,'posted',765432) RETURNING id
  `, [companyId])).rows[0].id);
  const expenseAccountId = Number((await pool.query(`
    INSERT INTO accounts(company_id, code, name_ar, account_type)
    VALUES ($1,$2,'Execution expense','expense') RETURNING id
  `, [companyId, `EXEC-EXP-${suffix}`])).rows[0].id);
  const purchaseLineId = Number((await pool.query(`
    INSERT INTO purchase_invoice_lines(
      invoice_id, company_id, item_name, qty, unit_price, line_total, final_cost, account_id
    ) VALUES ($1,$2,'Execution service',1,60,60,60,$3) RETURNING id
  `, [invoiceId, companyId, expenseAccountId])).rows[0].id);
  await createContractingCostAllocation(companyId, projectId, {
    sourceType: "purchase_invoice_line",
    sourceRecordId: purchaseLineId,
    category: "direct_expense",
    amount: 60,
    ownerContractId,
    boqLineId: ownerBoqId,
    idempotencyKey: `execution-cost-${suffix}`,
  }, { id: userId, role: "admin", viewAllBranches: true, branchIds: [] });
  await assert.rejects(
    pool.query("UPDATE contracting_work_items SET parent_work_item_id=$1 WHERE id=$2", [foreignId, childId]),
    /foreign key/i,
  );

  const resourceId = Number((await pool.query(`
    INSERT INTO contracting_resources(company_id, project_id, name, type, unit, qty, unit_cost, total_cost)
    VALUES ($1, $2, 'Crew', 'labor', 'hr', 100, 20, 2000) RETURNING id
  `, [companyId, projectId])).rows[0].id);
  const foreignResourceId = Number((await pool.query(`
    INSERT INTO contracting_resources(company_id, project_id, name, type, unit, qty, unit_cost, total_cost)
    VALUES ($1, $2, 'Other crew', 'labor', 'hr', 100, 20, 2000) RETURNING id
  `, [companyId, otherProjectId])).rows[0].id);
  const analysis = await upsertResourceAnalysis(companyId, projectId, childId, {
    resourceId,
    plannedQty: 10,
    wastagePercent: 5,
    estimatedUnitCost: 20,
  });
  assert.equal(analysis.estimatedTotalCost, "210.00");
  await assert.rejects(
    upsertResourceAnalysis(companyId, projectId, childId, {
      resourceId: foreignResourceId,
      plannedQty: 1,
    }),
    /نفس المشروع/,
  );

  const [listed] = (await listExecutionWorkItems(companyId, projectId))
    .filter((item) => item.id === rootId);
  assert.equal(listed.estimatedBudget, "250.00");
  assert.equal(listed.earnedValue, "100.00");
  assert.equal(listed.totalActualCost, "0.00");
  assert.equal(listed.actualCostIncomplete, true);
  assert.equal(listed.costPerformanceIndex, 0);
  assert.equal(listed.costVariance, "100.00");
  const [costedChild] = (await listExecutionWorkItems(companyId, projectId))
    .filter((item) => item.id === childId);
  assert.equal(costedChild.totalActualCost, "60.00");
  assert.equal(costedChild.actualCostIncomplete, true);
  assert.equal(costedChild.actualCostSources.length, 1);
  assert.equal(costedChild.actualCostBoqLinked, true);
  assert.ok(costedChild.actualCostMissingCategories.includes("material"));
});
