import { db, getActiveExternalDb } from "@workspace/db";
import { sql } from "drizzle-orm";

export type ContractingIntegrityDiagnostics = {
  deferredValidation: boolean;
  offendingIds: Record<string, number[]>;
};

let centralReady: Promise<ContractingIntegrityDiagnostics> | null = null;
const externalReady = new WeakMap<object, Promise<ContractingIntegrityDiagnostics>>();

function rowsOf(result: any): any[] {
  return Array.isArray(result) ? result : result?.rows ?? [];
}

/**
 * Additive, data-preserving upgrade for project hierarchy and contract-owned
 * financial scope. It only backfills a missing contract when exactly one
 * tenant/project candidate exists. Ambiguous or impossible legacy rows defer
 * constraint validation and are reported separately; readiness still succeeds.
 * No project, contract, or price is invented.
 */
export async function ensureContractingProjectIntegrity(): Promise<ContractingIntegrityDiagnostics> {
  const external = getActiveExternalDb();
  const current = external ? externalReady.get(external) : centralReady;
  if (current) return current;
  const initialization = runContractingProjectIntegrityMigration();
  if (external) externalReady.set(external, initialization);
  else centralReady = initialization;
  try {
    return await initialization;
  } catch (error) {
    if (external && externalReady.get(external) === initialization) externalReady.delete(external);
    if (!external && centralReady === initialization) centralReady = null;
    throw error;
  }
}

export async function repairContractingProjectIntegrity(): Promise<ContractingIntegrityDiagnostics> {
  return runContractingProjectIntegrityMigration();
}

async function runContractingProjectIntegrityMigration(): Promise<ContractingIntegrityDiagnostics> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20831, 1)`);
    await tx.execute(sql`
      ALTER TABLE contracting_projects ADD COLUMN IF NOT EXISTS parent_id INTEGER;
      CREATE INDEX IF NOT EXISTS ctg_proj_parent_idx
        ON contracting_projects(company_id, parent_id);
      CREATE UNIQUE INDEX IF NOT EXISTS ctg_proj_company_id_id_uq
        ON contracting_projects(company_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS ctg_oc_company_project_id_uq
        ON contracting_owner_contracts(company_id, project_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS ctg_sc_company_project_id_uq
        ON contracting_sub_contracts(company_id, project_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS ctg_boq_company_project_id_work_item_uq
        ON contracting_contract_boq_lines(company_id, project_id, id, work_item_id)
    `);

    // Preserve legacy rows only where ownership is mathematically unambiguous.
    await tx.execute(sql`
      UPDATE contracting_progress_bills b
         SET owner_contract_id = (
           SELECT min(c.id) FROM contracting_owner_contracts c
            WHERE c.company_id = b.company_id AND c.project_id = b.project_id
         )
       WHERE b.direction = 'outgoing'
         AND b.owner_contract_id IS NULL
         AND b.subcontractor_contract_id IS NULL
         AND b.status IN ('draft', 'submitted', 'rejected')
         AND b.journal_entry_id IS NULL
         AND b.approved_at IS NULL
         AND b.paid_at IS NULL
         AND 1 = (SELECT count(*) FROM contracting_owner_contracts c
                   WHERE c.company_id = b.company_id AND c.project_id = b.project_id)
    `);
    await tx.execute(sql`
      UPDATE contracting_progress_bills b
         SET subcontractor_contract_id = (
               SELECT min(c.id) FROM contracting_sub_contracts c
                WHERE c.company_id = b.company_id AND c.project_id = b.project_id
             ),
             contractor_id = (
               SELECT min(c.contractor_id) FROM contracting_sub_contracts c
                WHERE c.company_id = b.company_id AND c.project_id = b.project_id
             )
       WHERE b.direction = 'incoming'
         AND b.owner_contract_id IS NULL
         AND b.subcontractor_contract_id IS NULL
         AND b.status IN ('draft', 'submitted', 'rejected')
         AND b.journal_entry_id IS NULL
         AND b.approved_at IS NULL
         AND b.paid_at IS NULL
         AND 1 = (SELECT count(*) FROM contracting_sub_contracts c
                   WHERE c.company_id = b.company_id AND c.project_id = b.project_id)
    `);
    await tx.execute(sql`
      UPDATE contracting_contract_boq_lines l
         SET owner_contract_id = (
           SELECT min(c.id) FROM contracting_owner_contracts c
            WHERE c.company_id = l.company_id AND c.project_id = l.project_id
         )
       WHERE l.direction = 'owner'
         AND l.owner_contract_id IS NULL
         AND l.subcontractor_contract_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM contracting_bill_lines bl WHERE bl.boq_line_id = l.id
         )
         AND 1 = (SELECT count(*) FROM contracting_owner_contracts c
                   WHERE c.company_id = l.company_id AND c.project_id = l.project_id)
    `);
    await tx.execute(sql`
      UPDATE contracting_contract_boq_lines l
         SET subcontractor_contract_id = (
           SELECT min(c.id) FROM contracting_sub_contracts c
            WHERE c.company_id = l.company_id AND c.project_id = l.project_id
         )
       WHERE l.direction = 'subcontract'
         AND l.owner_contract_id IS NULL
         AND l.subcontractor_contract_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM contracting_bill_lines bl WHERE bl.boq_line_id = l.id
         )
         AND 1 = (SELECT count(*) FROM contracting_sub_contracts c
                   WHERE c.company_id = l.company_id AND c.project_id = l.project_id)
    `);

    const invalid = rowsOf(await tx.execute(sql`
      SELECT kind, id FROM (
        SELECT 'progress_bill_contract'::text kind, b.id
          FROM contracting_progress_bills b
          LEFT JOIN contracting_owner_contracts oc ON oc.id = b.owner_contract_id
          LEFT JOIN contracting_sub_contracts sc ON sc.id = b.subcontractor_contract_id
         WHERE NOT (
           b.direction = 'outgoing' AND b.owner_contract_id IS NOT NULL
             AND b.subcontractor_contract_id IS NULL AND b.contractor_id IS NULL
             AND (oc.company_id, oc.project_id) = (b.company_id, b.project_id)
           OR
           b.direction = 'incoming' AND b.owner_contract_id IS NULL
             AND b.subcontractor_contract_id IS NOT NULL AND b.contractor_id IS NOT NULL
             AND (sc.company_id, sc.project_id, sc.contractor_id)
                 = (b.company_id, b.project_id, b.contractor_id)
         )
        UNION ALL
        SELECT 'boq_contract', l.id
          FROM contracting_contract_boq_lines l
          LEFT JOIN contracting_owner_contracts oc ON oc.id = l.owner_contract_id
          LEFT JOIN contracting_sub_contracts sc ON sc.id = l.subcontractor_contract_id
          LEFT JOIN contracting_work_items wi ON wi.id = l.work_item_id
         WHERE NOT (
           l.direction = 'owner' AND l.owner_contract_id IS NOT NULL
             AND l.subcontractor_contract_id IS NULL AND l.source_owner_line_id IS NULL
             AND (oc.company_id, oc.project_id) = (l.company_id, l.project_id)
           OR
           l.direction = 'subcontract' AND l.owner_contract_id IS NULL
             AND l.subcontractor_contract_id IS NOT NULL
             AND (sc.company_id, sc.project_id) = (l.company_id, l.project_id)
         )
            OR wi.id IS NULL
            OR (wi.company_id, wi.project_id) <> (l.company_id, l.project_id)
        UNION ALL
        SELECT 'boq_source_owner', l.id
          FROM contracting_contract_boq_lines l
          LEFT JOIN contracting_contract_boq_lines source ON source.id = l.source_owner_line_id
         WHERE l.source_owner_line_id IS NOT NULL
           AND (source.id IS NULL OR source.direction <> 'owner'
             OR (source.company_id, source.project_id, source.work_item_id)
                <> (l.company_id, l.project_id, l.work_item_id))
        UNION ALL
        SELECT 'project_parent', p.id
          FROM contracting_projects p
          LEFT JOIN contracting_projects parent ON parent.id = p.parent_id
         WHERE p.parent_id IS NOT NULL
           AND (parent.id IS NULL OR parent.company_id <> p.company_id
             OR parent.branch_id IS DISTINCT FROM p.branch_id OR parent.id = p.id)
      ) invalid
      ORDER BY kind, id
    `));
    const grouped: Record<string, number[]> = {};
    for (const row of invalid) (grouped[String(row.kind)] ??= []).push(Number(row.id));

    await tx.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_proj_parent_company_fk') THEN
          ALTER TABLE contracting_projects ADD CONSTRAINT ctg_proj_parent_company_fk
            FOREIGN KEY (company_id, parent_id)
            REFERENCES contracting_projects(company_id, id) ON DELETE RESTRICT NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_proj_not_own_parent_ck') THEN
          ALTER TABLE contracting_projects ADD CONSTRAINT ctg_proj_not_own_parent_ck
            CHECK (parent_id IS NULL OR parent_id <> id) NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_bill_exact_direction_contract_ck') THEN
          ALTER TABLE contracting_progress_bills ADD CONSTRAINT ctg_bill_exact_direction_contract_ck CHECK (
            (direction = 'outgoing' AND owner_contract_id IS NOT NULL
              AND subcontractor_contract_id IS NULL AND contractor_id IS NULL)
            OR
            (direction = 'incoming' AND owner_contract_id IS NULL
              AND subcontractor_contract_id IS NOT NULL AND contractor_id IS NOT NULL)
          ) NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_bill_owner_contract_project_fk') THEN
          ALTER TABLE contracting_progress_bills ADD CONSTRAINT ctg_bill_owner_contract_project_fk
            FOREIGN KEY (company_id, project_id, owner_contract_id)
            REFERENCES contracting_owner_contracts(company_id, project_id, id) ON DELETE RESTRICT NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_bill_subcontract_project_fk') THEN
          ALTER TABLE contracting_progress_bills ADD CONSTRAINT ctg_bill_subcontract_project_fk
            FOREIGN KEY (company_id, project_id, subcontractor_contract_id)
            REFERENCES contracting_sub_contracts(company_id, project_id, id) ON DELETE RESTRICT NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_boq_exact_direction_contract_ck') THEN
          ALTER TABLE contracting_contract_boq_lines ADD CONSTRAINT ctg_boq_exact_direction_contract_ck CHECK (
            (direction = 'owner' AND owner_contract_id IS NOT NULL
              AND subcontractor_contract_id IS NULL AND source_owner_line_id IS NULL)
            OR
            (direction = 'subcontract' AND owner_contract_id IS NULL
              AND subcontractor_contract_id IS NOT NULL)
          ) NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_boq_owner_contract_project_fk') THEN
          ALTER TABLE contracting_contract_boq_lines ADD CONSTRAINT ctg_boq_owner_contract_project_fk
            FOREIGN KEY (company_id, project_id, owner_contract_id)
            REFERENCES contracting_owner_contracts(company_id, project_id, id) ON DELETE RESTRICT NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_boq_subcontract_project_fk') THEN
          ALTER TABLE contracting_contract_boq_lines ADD CONSTRAINT ctg_boq_subcontract_project_fk
            FOREIGN KEY (company_id, project_id, subcontractor_contract_id)
            REFERENCES contracting_sub_contracts(company_id, project_id, id) ON DELETE RESTRICT NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_boq_source_owner_project_item_fk') THEN
          ALTER TABLE contracting_contract_boq_lines ADD CONSTRAINT ctg_boq_source_owner_project_item_fk
            FOREIGN KEY (company_id, project_id, source_owner_line_id, work_item_id)
            REFERENCES contracting_contract_boq_lines(company_id, project_id, id, work_item_id)
            ON DELETE RESTRICT NOT VALID;
        END IF;
      END $$;

      CREATE OR REPLACE FUNCTION enforce_contracting_project_parent() RETURNS trigger AS $$
      DECLARE cycle_found BOOLEAN;
      BEGIN
        PERFORM pg_advisory_xact_lock(20831, NEW.company_id);
        IF NEW.parent_id IS NOT NULL THEN
          -- Enforce exactly two levels for new hierarchy writes while keeping
          -- deeper legacy rows readable and editable when parent_id is not
          -- being changed.
          IF (TG_OP = 'INSERT' OR OLD.parent_id IS DISTINCT FROM NEW.parent_id)
            AND EXISTS (
              SELECT 1 FROM contracting_projects parent
               WHERE parent.id = NEW.parent_id AND parent.company_id = NEW.company_id
                 AND parent.parent_id IS NOT NULL
            ) THEN
            RAISE EXCEPTION 'project hierarchy supports a root and one child level only';
          END IF;
          IF (TG_OP = 'INSERT' OR OLD.parent_id IS DISTINCT FROM NEW.parent_id)
            AND EXISTS (
              SELECT 1 FROM contracting_projects child
               WHERE child.parent_id = NEW.id AND child.company_id = NEW.company_id
            ) THEN
            RAISE EXCEPTION 'a project that already owns children cannot become a child';
          END IF;
          IF EXISTS (
            SELECT 1 FROM contracting_projects p
             WHERE p.id = NEW.parent_id AND p.company_id = NEW.company_id
               AND p.branch_id IS DISTINCT FROM NEW.branch_id
          ) THEN
            RAISE EXCEPTION 'project parent must have the same tenant and branch visibility';
          END IF;
          WITH RECURSIVE ancestors(id, parent_id) AS (
            SELECT p.id, p.parent_id FROM contracting_projects p
             WHERE p.id = NEW.parent_id AND p.company_id = NEW.company_id
            UNION
            SELECT p.id, p.parent_id FROM contracting_projects p
              JOIN ancestors a ON p.id = a.parent_id
             WHERE p.company_id = NEW.company_id
          )
          SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id) INTO cycle_found;
          IF cycle_found THEN RAISE EXCEPTION 'project hierarchy cycle is not allowed'; END IF;
        END IF;
        IF EXISTS (
          SELECT 1 FROM contracting_projects child
           WHERE child.parent_id = NEW.id AND child.company_id = NEW.company_id
             AND child.branch_id IS DISTINCT FROM NEW.branch_id
        ) THEN
          RAISE EXCEPTION 'project branch change conflicts with child project visibility';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS contracting_project_parent_guard ON contracting_projects;
      CREATE TRIGGER contracting_project_parent_guard
        BEFORE INSERT OR UPDATE OF parent_id, company_id, branch_id
        ON contracting_projects FOR EACH ROW
        EXECUTE FUNCTION enforce_contracting_project_parent();

      CREATE OR REPLACE FUNCTION enforce_contracting_bill_scope() RETURNS trigger AS $$
      BEGIN
        IF NEW.direction = 'incoming'
          AND NOT EXISTS (
            SELECT 1 FROM contracting_sub_contracts c
             WHERE c.id = NEW.subcontractor_contract_id
               AND c.company_id = NEW.company_id AND c.project_id = NEW.project_id
               AND c.contractor_id = NEW.contractor_id
          ) THEN
          RAISE EXCEPTION 'incoming bill contractor must match its project subcontract';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION enforce_contracting_boq_scope() RETURNS trigger AS $$
      BEGIN
        IF NEW.source_owner_line_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM contracting_contract_boq_lines source
             WHERE source.id = NEW.source_owner_line_id AND source.direction = 'owner'
               AND source.company_id = NEW.company_id AND source.project_id = NEW.project_id
               AND source.work_item_id = NEW.work_item_id
          ) THEN
          RAISE EXCEPTION 'source owner BOQ line must own the same project work item';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS contracting_bill_scope_guard ON contracting_progress_bills;
      CREATE TRIGGER contracting_bill_scope_guard
        BEFORE INSERT OR UPDATE OF company_id, project_id, direction, contractor_id,
          owner_contract_id, subcontractor_contract_id
        ON contracting_progress_bills FOR EACH ROW
        EXECUTE FUNCTION enforce_contracting_bill_scope();
      DROP TRIGGER IF EXISTS contracting_boq_scope_guard ON contracting_contract_boq_lines;
      CREATE TRIGGER contracting_boq_scope_guard
        BEFORE INSERT OR UPDATE OF company_id, project_id, direction, work_item_id,
          owner_contract_id, subcontractor_contract_id, source_owner_line_id
        ON contracting_contract_boq_lines FOR EACH ROW
        EXECUTE FUNCTION enforce_contracting_boq_scope()
    `);

    if (!grouped.project_parent) {
      await tx.execute(sql`
        ALTER TABLE contracting_projects VALIDATE CONSTRAINT ctg_proj_parent_company_fk;
        ALTER TABLE contracting_projects VALIDATE CONSTRAINT ctg_proj_not_own_parent_ck
      `);
    }
    if (!grouped.progress_bill_contract) {
      await tx.execute(sql`
        ALTER TABLE contracting_progress_bills VALIDATE CONSTRAINT ctg_bill_exact_direction_contract_ck;
        ALTER TABLE contracting_progress_bills VALIDATE CONSTRAINT ctg_bill_owner_contract_project_fk;
        ALTER TABLE contracting_progress_bills VALIDATE CONSTRAINT ctg_bill_subcontract_project_fk
      `);
    }
    if (!grouped.boq_contract && !grouped.boq_source_owner) {
      await tx.execute(sql`
        ALTER TABLE contracting_contract_boq_lines VALIDATE CONSTRAINT ctg_boq_exact_direction_contract_ck;
        ALTER TABLE contracting_contract_boq_lines VALIDATE CONSTRAINT ctg_boq_owner_contract_project_fk;
        ALTER TABLE contracting_contract_boq_lines VALIDATE CONSTRAINT ctg_boq_subcontract_project_fk;
        ALTER TABLE contracting_contract_boq_lines VALIDATE CONSTRAINT ctg_boq_source_owner_project_item_fk
      `);
    }
    return {
      deferredValidation: invalid.length > 0,
      offendingIds: grouped,
    };
  });
}

/**
 * Read-only, caller-scoped diagnostics. Never return IDs from another tenant
 * or from a project outside the caller's authorized branch set.
 */
export async function getContractingIntegrityDiagnostics(
  companyId: number,
  projectIds: number[],
): Promise<ContractingIntegrityDiagnostics> {
  const visible = [...new Set(projectIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!visible.length) return { deferredValidation: false, offendingIds: {} };
  const visibleSql = sql.join(visible.map((id) => sql`${id}`), sql`, `);
  const result = await db.execute(sql`
    SELECT kind, id FROM (
      SELECT 'progress_bill_contract'::text kind, b.id
        FROM contracting_progress_bills b
        LEFT JOIN contracting_owner_contracts oc ON oc.id = b.owner_contract_id
        LEFT JOIN contracting_sub_contracts sc ON sc.id = b.subcontractor_contract_id
       WHERE b.company_id = ${companyId}
         AND b.project_id IN (${visibleSql})
         AND NOT (
           b.direction = 'outgoing' AND b.owner_contract_id IS NOT NULL
             AND b.subcontractor_contract_id IS NULL AND b.contractor_id IS NULL
             AND (oc.company_id, oc.project_id) = (b.company_id, b.project_id)
           OR
           b.direction = 'incoming' AND b.owner_contract_id IS NULL
             AND b.subcontractor_contract_id IS NOT NULL AND b.contractor_id IS NOT NULL
             AND (sc.company_id, sc.project_id, sc.contractor_id)
                 = (b.company_id, b.project_id, b.contractor_id)
         )
      UNION ALL
      SELECT 'boq_contract', l.id
        FROM contracting_contract_boq_lines l
        LEFT JOIN contracting_owner_contracts oc ON oc.id = l.owner_contract_id
        LEFT JOIN contracting_sub_contracts sc ON sc.id = l.subcontractor_contract_id
        LEFT JOIN contracting_work_items wi ON wi.id = l.work_item_id
       WHERE l.company_id = ${companyId}
         AND l.project_id IN (${visibleSql})
         AND (NOT (
           l.direction = 'owner' AND l.owner_contract_id IS NOT NULL
             AND l.subcontractor_contract_id IS NULL AND l.source_owner_line_id IS NULL
             AND (oc.company_id, oc.project_id) = (l.company_id, l.project_id)
           OR
           l.direction = 'subcontract' AND l.owner_contract_id IS NULL
             AND l.subcontractor_contract_id IS NOT NULL
             AND (sc.company_id, sc.project_id) = (l.company_id, l.project_id)
         ) OR wi.id IS NULL
           OR (wi.company_id, wi.project_id) <> (l.company_id, l.project_id))
      UNION ALL
      SELECT 'boq_source_owner', l.id
        FROM contracting_contract_boq_lines l
        LEFT JOIN contracting_contract_boq_lines source ON source.id = l.source_owner_line_id
       WHERE l.company_id = ${companyId}
         AND l.project_id IN (${visibleSql})
         AND l.source_owner_line_id IS NOT NULL
         AND (source.id IS NULL OR source.direction <> 'owner'
           OR (source.company_id, source.project_id, source.work_item_id)
              <> (l.company_id, l.project_id, l.work_item_id))
      UNION ALL
      SELECT 'project_parent', p.id
        FROM contracting_projects p
        LEFT JOIN contracting_projects parent ON parent.id = p.parent_id
       WHERE p.company_id = ${companyId}
         AND p.id IN (${visibleSql})
         AND p.parent_id IS NOT NULL
         AND (parent.id IS NULL OR parent.company_id <> p.company_id
           OR parent.branch_id IS DISTINCT FROM p.branch_id OR parent.id = p.id)
    ) invalid ORDER BY kind, id
  `);
  const offendingIds: Record<string, number[]> = {};
  for (const row of rowsOf(result)) {
    (offendingIds[String(row.kind)] ??= []).push(Number(row.id));
  }
  return {
    deferredValidation: Object.keys(offendingIds).length > 0,
    offendingIds,
  };
}