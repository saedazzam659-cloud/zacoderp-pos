import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "@workspace/db";
import {
  ensureContractingProjectIntegrity,
  getContractingIntegrityDiagnostics,
  repairContractingProjectIntegrity,
} from "../src/lib/contracting-integrity.ts";

const armed = process.env.CONTRACTING_INTEGRITY_PG === "1";

test("PostgreSQL enforces hierarchy, exact contract side, source ownership, and safe backfill", {
  skip: !armed,
}, async () => {
  assert.deepEqual(await ensureContractingProjectIntegrity(), {
    deferredValidation: false,
    offendingIds: {},
  });
  const company = async (suffix: string) => Number((await pool.query(`
    INSERT INTO companies(name_ar, vat_number, cr_number, city, street, building_number, postal_code)
    VALUES ($1, $2, $3, 'Riyadh', 'Test', '1', '12345') RETURNING id
  `, [`Integrity ${suffix}`, `vat-${suffix}`, `cr-${suffix}`])).rows[0].id);
  const project = async (companyId: number, code: string) => Number((await pool.query(`
    INSERT INTO contracting_projects(company_id, code, name_ar)
    VALUES ($1, $2, $2) RETURNING id
  `, [companyId, code])).rows[0].id);

  const c1 = await company("one");
  const c2 = await company("two");
  const root = await project(c1, "ROOT");
  const child = await project(c1, "CHILD");
  const otherProject = await project(c1, "OTHER");
  const foreignProject = await project(c2, "FOREIGN");

  await pool.query("UPDATE contracting_projects SET parent_id=$1 WHERE id=$2", [root, child]);
  await assert.rejects(
    pool.query("UPDATE contracting_projects SET parent_id=$1 WHERE id=$2", [child, root]),
    /cycle/i,
  );
  await assert.rejects(
    pool.query("UPDATE contracting_projects SET parent_id=$1 WHERE id=$2", [foreignProject, child]),
    /foreign key|parent/i,
  );
  const concurrentA = await project(c1, "CONCURRENT-A");
  const concurrentB = await project(c1, "CONCURRENT-B");
  const clientA = await pool.connect();
  const clientB = await pool.connect();
  try {
    await clientA.query("BEGIN");
    await clientB.query("BEGIN");
    await clientA.query(
      "UPDATE contracting_projects SET parent_id=$1 WHERE id=$2",
      [concurrentB, concurrentA],
    );
    const opposite = clientB.query(
      "UPDATE contracting_projects SET parent_id=$1 WHERE id=$2",
      [concurrentA, concurrentB],
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await clientA.query("COMMIT");
    await assert.rejects(opposite, /cycle/i);
    await clientB.query("ROLLBACK");
  } finally {
    await clientA.query("ROLLBACK").catch(() => undefined);
    await clientB.query("ROLLBACK").catch(() => undefined);
    clientA.release();
    clientB.release();
  }

  const ownerContract = Number((await pool.query(`
    INSERT INTO contracting_owner_contracts(
      company_id, project_id, contract_number, contract_date
    ) VALUES ($1, $2, 'OC-1', CURRENT_DATE) RETURNING id
  `, [c1, root])).rows[0].id);
  await pool.query(`
    INSERT INTO contracting_progress_bills(
      company_id, project_id, direction, owner_contract_id, bill_number, bill_date
    ) VALUES ($1, $2, 'outgoing', $3, 'B-VALID', CURRENT_DATE)
  `, [c1, root, ownerContract]);
  await assert.rejects(pool.query(`
    INSERT INTO contracting_progress_bills(
      company_id, project_id, direction, bill_number, bill_date
    ) VALUES ($1, $2, 'outgoing', 'B-NONE', CURRENT_DATE)
  `, [c1, root]), /ctg_bill_exact_direction_contract_ck/);
  await assert.rejects(pool.query(`
    INSERT INTO contracting_progress_bills(
      company_id, project_id, direction, owner_contract_id, bill_number, bill_date
    ) VALUES ($1, $2, 'outgoing', $3, 'B-MISMATCH', CURRENT_DATE)
  `, [c1, otherProject, ownerContract]), /ctg_bill_owner_contract_project_fk/);

  const workItem = Number((await pool.query(`
    INSERT INTO contracting_work_items(company_id, project_id, name_ar)
    VALUES ($1, $2, 'Work') RETURNING id
  `, [c1, root])).rows[0].id);
  const ownerLine = Number((await pool.query(`
    INSERT INTO contracting_contract_boq_lines(
      company_id, project_id, work_item_id, direction, owner_contract_id, unit
    ) VALUES ($1, $2, $3, 'owner', $4, 'm') RETURNING id
  `, [c1, root, workItem, ownerContract])).rows[0].id);
  const contractor = Number((await pool.query(`
    INSERT INTO contracting_contractors(company_id, name) VALUES ($1, 'Sub') RETURNING id
  `, [c1])).rows[0].id);
  const subcontract = Number((await pool.query(`
    INSERT INTO contracting_sub_contracts(
      company_id, project_id, contractor_id, contract_number, contract_date
    ) VALUES ($1, $2, $3, 'SC-1', CURRENT_DATE) RETURNING id
  `, [c1, root, contractor])).rows[0].id);
  await pool.query(`
    INSERT INTO contracting_contract_boq_lines(
      company_id, project_id, work_item_id, direction, subcontractor_contract_id,
      source_owner_line_id, unit
    ) VALUES ($1, $2, $3, 'subcontract', $4, $5, 'm')
  `, [c1, root, workItem, subcontract, ownerLine]);
  await assert.rejects(pool.query(`
    UPDATE contracting_contract_boq_lines SET source_owner_line_id=id WHERE id=$1
  `, [ownerLine]), /ctg_boq_exact_direction_contract_ck|source owner/i);

  // Simulate an old database without bill constraints. One exact project
  // contract is safe to derive; business values and the row identity survive.
  await pool.query(`
    ALTER TABLE contracting_progress_bills
      DROP CONSTRAINT ctg_bill_exact_direction_contract_ck,
      DROP CONSTRAINT ctg_bill_owner_contract_project_fk,
      DROP CONSTRAINT ctg_bill_subcontract_project_fk
  `);
  const legacyProject = await project(c1, "LEGACY");
  const legacyContract = Number((await pool.query(`
    INSERT INTO contracting_owner_contracts(
      company_id, project_id, contract_number, contract_date
    ) VALUES ($1, $2, 'OC-LEGACY', CURRENT_DATE) RETURNING id
  `, [c1, legacyProject])).rows[0].id);
  const legacy = (await pool.query(`
    INSERT INTO contracting_progress_bills(
      company_id, project_id, direction, bill_number, bill_date, gross_amount, notes
    ) VALUES ($1, $2, 'outgoing', 'B-LEGACY', CURRENT_DATE, 123.45, 'preserve-me')
    RETURNING id
  `, [c1, legacyProject])).rows[0];
  const diagnostics = await repairContractingProjectIntegrity();
  assert.equal(diagnostics.deferredValidation, false);
  const preserved = (await pool.query(`
    SELECT id, owner_contract_id, gross_amount::text gross_amount, notes
      FROM contracting_progress_bills WHERE id=$1
  `, [legacy.id])).rows[0];
  assert.deepEqual(preserved, {
    id: legacy.id,
    owner_contract_id: legacyContract,
    gross_amount: "123.45",
    notes: "preserve-me",
  });

  // An impossible legacy row is preserved and reported. NOT VALID keeps
  // readiness available while PostgreSQL still rejects every future bad write.
  await pool.query(`
    ALTER TABLE contracting_progress_bills
      DROP CONSTRAINT ctg_bill_exact_direction_contract_ck,
      DROP CONSTRAINT ctg_bill_owner_contract_project_fk,
      DROP CONSTRAINT ctg_bill_subcontract_project_fk
  `);
  const unresolvedProject = await project(c1, "UNRESOLVED");
  const unresolved = (await pool.query(`
    INSERT INTO contracting_progress_bills(
      company_id, project_id, direction, bill_number, bill_date, notes
    ) VALUES ($1, $2, 'outgoing', 'B-UNRESOLVED', CURRENT_DATE, 'keep-unresolved')
    RETURNING id
  `, [c1, unresolvedProject])).rows[0];
  const foreignUnresolvedProject = await project(c2, "UNRESOLVED-OTHER-TENANT");
  const foreignUnresolved = (await pool.query(`
    INSERT INTO contracting_progress_bills(
      company_id, project_id, direction, bill_number, bill_date
    ) VALUES ($1, $2, 'outgoing', 'B-OTHER-TENANT', CURRENT_DATE)
    RETURNING id
  `, [c2, foreignUnresolvedProject])).rows[0];
  const deferred = await repairContractingProjectIntegrity();
  assert.equal(deferred.deferredValidation, true);
  assert.deepEqual(
    deferred.offendingIds.progress_bill_contract,
    [unresolved.id, foreignUnresolved.id].sort((a, b) => a - b),
  );
  assert.deepEqual(
    await getContractingIntegrityDiagnostics(c1, [unresolvedProject]),
    {
      deferredValidation: true,
      offendingIds: { progress_bill_contract: [unresolved.id] },
    },
  );
  assert.equal((await pool.query(`
    SELECT notes FROM contracting_progress_bills WHERE id=$1
  `, [unresolved.id])).rows[0].notes, "keep-unresolved");
  assert.ok((await pool.query(`
    SELECT convalidated FROM pg_constraint
     WHERE conname IN (
       'ctg_bill_exact_direction_contract_ck',
       'ctg_bill_owner_contract_project_fk',
       'ctg_bill_subcontract_project_fk'
     )
  `)).rows.every((row) => row.convalidated === false));
  await assert.rejects(pool.query(`
    INSERT INTO contracting_progress_bills(
      company_id, project_id, direction, bill_number, bill_date
    ) VALUES ($1, $2, 'outgoing', 'B-FUTURE-BAD', CURRENT_DATE)
  `, [c1, unresolvedProject]), /ctg_bill_exact_direction_contract_ck/);
});