import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "@workspace/db";
import { ensureContractingGuaranteeTables } from "../src/lib/contracting-guarantees-storage.ts";

const armed = process.env.CONTRACTING_GUARANTEES_PG === "1";

test("PostgreSQL preserves tender → initial → awarded contract → new performance guarantee", {
  skip: !armed,
}, async () => {
  await ensureContractingGuaranteeTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const companyId = Number((await client.query(`
      INSERT INTO companies(name_ar, vat_number, cr_number, city, street, building_number, postal_code)
      VALUES ('Guarantee Test', 'vat-guarantee-test', 'cr-guarantee-test', 'Riyadh', 'Test', '1', '12345')
      RETURNING id
    `)).rows[0].id);
    const projectId = Number((await client.query(`
      INSERT INTO contracting_projects(company_id, code, name_ar)
      VALUES ($1, 'G-PROJECT', 'Guarantee Project') RETURNING id
    `, [companyId])).rows[0].id);
    const contractId = Number((await client.query(`
      INSERT INTO contracting_owner_contracts(company_id, project_id, contract_number, contract_date)
      VALUES ($1, $2, 'G-CONTRACT', CURRENT_DATE) RETURNING id
    `, [companyId, projectId])).rows[0].id);
    const mismatchedContractId = Number((await client.query(`
      INSERT INTO contracting_owner_contracts(company_id, project_id, contract_number, contract_date)
      VALUES ($1, $2, 'G-CONTRACT-OTHER', CURRENT_DATE) RETURNING id
    `, [companyId, projectId])).rows[0].id);
    const bankId = Number((await client.query(`
      INSERT INTO bank_accounts(company_id, code, name_ar, is_active)
      VALUES ($1, 'G-BANK', 'Guarantee Bank', true) RETURNING id
    `, [companyId])).rows[0].id);
    const tenderId = Number((await client.query(`
      INSERT INTO contracting_tenders(company_id, project_id, tender_number, title, tender_date)
      VALUES ($1, $2, 'T-1', 'Tender', CURRENT_DATE) RETURNING id
    `, [companyId, projectId])).rows[0].id);
    const journalCountBefore = Number((await client.query(
      "SELECT count(*)::int AS count FROM journal_entries WHERE company_id=$1",
      [companyId],
    )).rows[0].count);
    const initialId = Number((await client.query(`
      INSERT INTO contracting_guarantees(
        company_id, project_id, tender_id, bank_account_id, guarantee_number,
        guarantee_type, amount, issue_date, expiry_date, status
      ) VALUES ($1, $2, $3, $4, 'BG-I', 'initial', 100, CURRENT_DATE, CURRENT_DATE + 30, 'active')
      RETURNING id
    `, [companyId, projectId, tenderId, bankId])).rows[0].id);

    await client.query(`
      UPDATE contracting_tenders SET status='awarded', awarded_contract_kind='owner',
        awarded_owner_contract_id=$1, awarded_at=NOW() WHERE id=$2
    `, [contractId, tenderId]);
    await client.query("SAVEPOINT mismatched_award");
    await assert.rejects(client.query(`
      INSERT INTO contracting_guarantees(
        company_id, project_id, tender_id, contract_kind, owner_contract_id,
        parent_guarantee_id, bank_account_id, guarantee_number, guarantee_type,
        amount, issue_date, expiry_date, status
      ) VALUES ($1, $2, $3, 'owner', $4, $5, $6, 'BG-MISMATCH', 'performance',
        200, CURRENT_DATE, CURRENT_DATE + 60, 'draft')
    `, [companyId, projectId, tenderId, mismatchedContractId, initialId, bankId]),
    /ctg_performance_awarded_contract_mismatch/);
    await client.query("ROLLBACK TO SAVEPOINT mismatched_award");
    const performanceId = Number((await client.query(`
      INSERT INTO contracting_guarantees(
        company_id, project_id, tender_id, contract_kind, owner_contract_id,
        parent_guarantee_id, bank_account_id, guarantee_number, guarantee_type,
        amount, issue_date, expiry_date, status
      ) VALUES ($1, $2, $3, 'owner', $4, $5, $6, 'BG-P', 'performance',
        200, CURRENT_DATE, CURRENT_DATE + 60, 'draft')
      RETURNING id
    `, [companyId, projectId, tenderId, contractId, initialId, bankId])).rows[0].id);

    const rows = (await client.query(`
      SELECT id, guarantee_type, owner_contract_id, parent_guarantee_id
        FROM contracting_guarantees WHERE id = ANY($1::int[]) ORDER BY id
    `, [[initialId, performanceId]])).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.id === initialId)?.guarantee_type, "initial");
    assert.equal(rows.find(row => row.id === initialId)?.owner_contract_id, null);
    assert.equal(rows.find(row => row.id === performanceId)?.parent_guarantee_id, initialId);

    await client.query("SAVEPOINT invalid_conversion");
    await assert.rejects(client.query(`
      UPDATE contracting_guarantees
         SET guarantee_type='performance', contract_kind='owner', owner_contract_id=$1
       WHERE id=$2
    `, [contractId, initialId]), /ctg_initial_guarantee_is_immutable/);
    await client.query("ROLLBACK TO SAVEPOINT invalid_conversion");
    await client.query("SAVEPOINT invalid_standalone");
    await assert.rejects(client.query(`
      INSERT INTO contracting_guarantees(
        company_id, project_id, bank_account_id, guarantee_number, guarantee_type,
        amount, issue_date, expiry_date
      ) VALUES ($1, $2, $3, 'BG-BAD', 'maintenance', 1, CURRENT_DATE, CURRENT_DATE + 1)
    `, [companyId, projectId, bankId]), /ctg_guarantee_relationship_shape_ck/);
    await client.query("ROLLBACK TO SAVEPOINT invalid_standalone");

    await client.query("UPDATE contracting_guarantees SET status='issued' WHERE id=$1", [performanceId]);
    await client.query("UPDATE contracting_guarantees SET status='active' WHERE id=$1", [performanceId]);
    await client.query(`
      UPDATE contracting_guarantees
         SET status='extended', expiry_date=expiry_date + 30
       WHERE id=$1
    `, [performanceId]);
    await client.query("UPDATE contracting_guarantees SET status='released', released_at=NOW() WHERE id=$1", [performanceId]);
    await client.query("SAVEPOINT invalid_lifecycle");
    await assert.rejects(
      client.query("UPDATE contracting_guarantees SET status='active' WHERE id=$1", [performanceId]),
      /ctg_guarantee_invalid_lifecycle_transition/,
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_lifecycle");

    const original = (await client.query(`
      SELECT guarantee_type, tender_id, contract_kind, owner_contract_id,
             subcontract_id, parent_guarantee_id, guarantee_number, amount
        FROM contracting_guarantees WHERE id=$1
    `, [initialId])).rows[0];
    assert.deepEqual(original, {
      guarantee_type: "initial",
      tender_id: tenderId,
      contract_kind: null,
      owner_contract_id: null,
      subcontract_id: null,
      parent_guarantee_id: null,
      guarantee_number: "BG-I",
      amount: "100.00",
    });
    assert.equal(
      Number((await client.query(
        "SELECT count(*)::int AS count FROM journal_entries WHERE company_id=$1",
        [companyId],
      )).rows[0].count),
      journalCountBefore,
      "guarantee/tender lifecycle must not create journal entries",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});