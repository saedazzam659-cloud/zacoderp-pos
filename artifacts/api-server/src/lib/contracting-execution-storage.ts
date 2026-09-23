import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  contractingResourcesTable,
  contractingWorkItemResourcesTable,
  contractingWorkItemsTable,
} from "@workspace/db";

export type ExecutionActualCost = {
  amount: number;
  complete: boolean;
  sources?: Array<{ type: string; referenceId: string | number; amount: number }>;
  missingCategories?: string[];
  boqLinked?: boolean;
};

export type ExecutionActualCostAdapter = (input: {
  companyId: number;
  projectId: number;
  workItemIds: number[];
}) => Promise<Map<number, ExecutionActualCost>>;

let actualCostAdapter: ExecutionActualCostAdapter | null = null;

/**
 * Integration seam for Inventory, Payroll, Fixed Assets, Purchasing,
 * subcontract certificates, and Expenses. Until the platform integration is
 * registered, callers receive zero with complete=false rather than a fabricated
 * actual cost derived from planning rates.
 */
export function registerContractingExecutionActualCostAdapter(
  adapter: ExecutionActualCostAdapter | null,
): void {
  actualCostAdapter = adapter;
}

export async function readIntegratedActualCosts(input: {
  companyId: number;
  projectId: number;
  workItemIds: number[];
}): Promise<Map<number, ExecutionActualCost>> {
  const values = actualCostAdapter
    ? await actualCostAdapter(input)
    : new Map<number, ExecutionActualCost>();
  const result = new Map<number, ExecutionActualCost>();
  for (const workItemId of input.workItemIds) {
    const value = values.get(workItemId);
    const amount = Number(value?.amount ?? 0);
    result.set(workItemId, {
      amount: Number.isFinite(amount) && amount >= 0 ? amount : 0,
      complete: value?.complete === true && Number.isFinite(amount) && amount >= 0,
      sources: value?.sources ?? [],
      missingCategories: value?.missingCategories ?? [],
      boqLinked: value?.boqLinked === true,
    });
  }
  return result;
}

/**
 * Additive readiness for the ambient database selected by external DB routing.
 * Deliberately uncached: the db export is a request-aware proxy and a success
 * for the central database must never mark a tenant database ready.
 */
export async function ensureContractingExecutionSchema(): Promise<void> {
  await db.execute(sql`ALTER TABLE contracting_work_items ADD COLUMN IF NOT EXISTS parent_work_item_id INTEGER`);
  await db.execute(sql`ALTER TABLE contracting_work_items ADD COLUMN IF NOT EXISTS description TEXT`);
  await db.execute(sql`ALTER TABLE contracting_work_items ADD COLUMN IF NOT EXISTS actual_start_date DATE`);
  await db.execute(sql`ALTER TABLE contracting_work_items ADD COLUMN IF NOT EXISTS actual_end_date DATE`);
  await db.execute(sql`ALTER TABLE contracting_work_items ADD COLUMN IF NOT EXISTS cost_center_id INTEGER`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ctg_wi_company_project_id_uq
      ON contracting_work_items(company_id, project_id, id)
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ctg_res_company_project_id_uq
      ON contracting_resources(company_id, project_id, id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ctg_wi_parent_idx
      ON contracting_work_items(company_id, project_id, parent_work_item_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ctg_wi_cost_center_idx
      ON contracting_work_items(company_id, cost_center_id)
  `);
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_wi_not_own_parent_ck') THEN
        ALTER TABLE contracting_work_items
          ADD CONSTRAINT ctg_wi_not_own_parent_ck
          CHECK (parent_work_item_id IS NULL OR parent_work_item_id <> id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_wi_parent_project_fk') THEN
        ALTER TABLE contracting_work_items
          ADD CONSTRAINT ctg_wi_parent_project_fk
          FOREIGN KEY (company_id, project_id, parent_work_item_id)
          REFERENCES contracting_work_items(company_id, project_id, id)
          ON DELETE RESTRICT NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_wi_cost_center_fk') THEN
        ALTER TABLE contracting_work_items
          ADD CONSTRAINT ctg_wi_cost_center_fk
          FOREIGN KEY (cost_center_id) REFERENCES cost_centers(id) ON DELETE SET NULL NOT VALID;
      END IF;
    END $$;
  `);
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION contracting_work_item_parent_cycle_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.parent_work_item_id IS NULL THEN RETURN NEW; END IF;
      PERFORM pg_advisory_xact_lock(NEW.company_id, NEW.project_id);
      IF EXISTS (
        WITH RECURSIVE ancestors(id, parent_work_item_id) AS (
          SELECT id, parent_work_item_id
            FROM contracting_work_items
           WHERE company_id = NEW.company_id
             AND project_id = NEW.project_id
             AND id = NEW.parent_work_item_id
          UNION ALL
          SELECT item.id, item.parent_work_item_id
            FROM contracting_work_items item
            JOIN ancestors ON item.id = ancestors.parent_work_item_id
           WHERE item.company_id = NEW.company_id
             AND item.project_id = NEW.project_id
        )
        SELECT 1 FROM ancestors WHERE id = NEW.id
      ) THEN
        RAISE EXCEPTION 'contracting work item WBS cycle';
      END IF;
      RETURN NEW;
    END $$;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'contracting_work_item_parent_cycle_guard_trg'
           AND tgrelid = 'contracting_work_items'::regclass
      ) THEN
        CREATE TRIGGER contracting_work_item_parent_cycle_guard_trg
          BEFORE INSERT OR UPDATE OF parent_work_item_id, project_id, company_id
          ON contracting_work_items
          FOR EACH ROW EXECUTE FUNCTION contracting_work_item_parent_cycle_guard();
      END IF;
    END $$;
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS contracting_work_item_resources (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES contracting_projects(id) ON DELETE CASCADE,
      work_item_id INTEGER NOT NULL,
      resource_id INTEGER NOT NULL,
      planned_qty NUMERIC(14,4) NOT NULL DEFAULT 0,
      wastage_percent NUMERIC(7,4),
      estimated_unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
      estimated_total_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT ctg_wir_work_item_project_fk
        FOREIGN KEY (company_id, project_id, work_item_id)
        REFERENCES contracting_work_items(company_id, project_id, id) ON DELETE CASCADE,
      CONSTRAINT ctg_wir_resource_project_fk
        FOREIGN KEY (company_id, project_id, resource_id)
        REFERENCES contracting_resources(company_id, project_id, id) ON DELETE RESTRICT,
      CONSTRAINT ctg_wir_non_negative_ck CHECK (
        planned_qty >= 0 AND estimated_unit_cost >= 0 AND estimated_total_cost >= 0
        AND (wastage_percent IS NULL OR (wastage_percent >= 0 AND wastage_percent <= 100))
      )
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ctg_wir_work_item_resource_uidx
      ON contracting_work_item_resources(company_id, project_id, work_item_id, resource_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ctg_wir_work_item_idx
      ON contracting_work_item_resources(company_id, project_id, work_item_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ctg_wir_resource_idx
      ON contracting_work_item_resources(company_id, project_id, resource_id)
  `);
}

export async function listStoredWorkItems(companyId: number, projectId: number) {
  return db.select().from(contractingWorkItemsTable).where(and(
    eq(contractingWorkItemsTable.companyId, companyId),
    eq(contractingWorkItemsTable.projectId, projectId),
  )).orderBy(asc(contractingWorkItemsTable.id));
}

export async function listStoredResourceAnalyses(
  companyId: number,
  projectId: number,
  workItemIds?: number[],
) {
  if (workItemIds?.length === 0) return [];
  const conditions = [
    eq(contractingWorkItemResourcesTable.companyId, companyId),
    eq(contractingWorkItemResourcesTable.projectId, projectId),
  ];
  if (workItemIds) conditions.push(inArray(contractingWorkItemResourcesTable.workItemId, workItemIds));
  return db.select({
    analysis: contractingWorkItemResourcesTable,
    resourceName: contractingResourcesTable.name,
    resourceType: contractingResourcesTable.type,
    resourceUnit: contractingResourcesTable.unit,
  }).from(contractingWorkItemResourcesTable)
    .innerJoin(contractingResourcesTable, and(
      eq(contractingResourcesTable.id, contractingWorkItemResourcesTable.resourceId),
      eq(contractingResourcesTable.companyId, companyId),
      eq(contractingResourcesTable.projectId, projectId),
    ))
    .where(and(...conditions))
    .orderBy(asc(contractingWorkItemResourcesTable.id));
}
