import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AuthUser } from "../middleware/auth.js";
import { contractingBranchAllowed } from "./contracting-security.js";
import {
  registerContractingExecutionActualCostAdapter,
  type ExecutionActualCost,
} from "./contracting-execution-storage.js";
import { ensureContractingAccountingTables } from "./contracting-accounting-storage.js";
import {
  analyticalAllocationAmount,
  categoryCoverage,
  equipmentHoursAllocation,
  validateSourceCategory,
} from "./contracting-cost-allocation-helper.js";

type BranchUser = Pick<AuthUser, "id" | "role" | "viewAllBranches" | "branchIds">;

type SourceSnapshot = {
  type: string;
  id: number;
  companyId: number;
  amount: number;
  date: string;
  label: string;
  category: string;
  branchId: number | null;
  meta: Record<string, unknown>;
};

function fail(message: string, status = 400, code?: string): never {
  throw Object.assign(new Error(message), { status, code });
}

function positiveInteger(value: unknown, label: string, optional = false): number | null {
  if (optional && (value == null || value === "")) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${label} غير صالح`, 422);
  return parsed;
}

function rowsOf(result: any): any[] {
  return Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];
}

function isoDateValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? "");
  const match = /^\d{4}-\d{2}-\d{2}/.exec(text);
  if (!match) fail("تاريخ مصدر التكلفة غير صالح", 422);
  return match[0];
}

function assertAllocationReplay(row: any, expected: {
  projectId: number;
  sourceType: string;
  sourceRecordId: number;
  ownerContractId: number | null;
  subcontractorContractId: number | null;
  boqLineId: number | null;
  body: any;
}) {
  const sameNullableId = (left: unknown, right: number | null) =>
    (left == null ? null : Number(left)) === right;
  const amountMatches = expected.body.amount == null
    || Math.abs(Number(row.allocated_amount) - Number(expected.body.amount)) < 0.005;
  const shareMatches = expected.body.sharePct == null
    || Math.abs(Number(row.share_pct) - Number(expected.body.sharePct)) < 0.0000005;
  const hoursMatches = expected.body.equipmentHours == null
    || Math.abs(Number(row.equipment_hours) - Number(expected.body.equipmentHours)) < 0.00005;
  if (Number(row.project_id) !== expected.projectId
    || String(row.source_type) !== expected.sourceType
    || Number(row.source_record_id) !== expected.sourceRecordId
    || !sameNullableId(row.owner_contract_id, expected.ownerContractId)
    || !sameNullableId(row.subcontractor_contract_id, expected.subcontractorContractId)
    || !sameNullableId(row.boq_line_id, expected.boqLineId)
    || (expected.body.category != null && String(row.category) !== String(expected.body.category))
    || !amountMatches || !shareMatches || !hoursMatches) {
    fail("مفتاح منع التكرار مستخدم لعملية أخرى", 409, "IDEMPOTENCY_KEY_REUSED");
  }
}

export async function ensureContractingCostAllocationTables(): Promise<void> {
  // db is the request-scoped ALS proxy, so readiness is applied to the active
  // tenant database rather than only to the central control-plane database.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS contracting_cost_allocations (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES contracting_projects(id) ON DELETE RESTRICT,
      owner_contract_id INTEGER REFERENCES contracting_owner_contracts(id) ON DELETE RESTRICT,
      subcontractor_contract_id INTEGER REFERENCES contracting_sub_contracts(id) ON DELETE RESTRICT,
      boq_line_id INTEGER REFERENCES contracting_contract_boq_lines(id) ON DELETE RESTRICT,
      category TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_record_id INTEGER NOT NULL,
      source_date DATE NOT NULL,
      source_amount NUMERIC(18,2) NOT NULL,
      basis TEXT NOT NULL DEFAULT 'percentage',
      share_pct NUMERIC(9,6),
      allocated_amount NUMERIC(18,2) NOT NULL,
      equipment_asset_id INTEGER,
      equipment_hours NUMERIC(14,4),
      source_hours_denominator NUMERIC(14,4),
      hourly_rate_evidence NUMERIC(18,6),
      reversal_of_id INTEGER REFERENCES contracting_cost_allocations(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL,
      source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      notes TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT ctg_cost_alloc_sign_ck CHECK (
        (reversal_of_id IS NULL AND allocated_amount > 0)
        OR (reversal_of_id IS NOT NULL AND allocated_amount < 0)
      ),
      CONSTRAINT ctg_cost_alloc_contract_side_ck CHECK (
        NOT (owner_contract_id IS NOT NULL AND subcontractor_contract_id IS NOT NULL)
      )
    )
  `);
  await db.execute(sql`
    ALTER TABLE contracting_cost_allocations
      ADD COLUMN IF NOT EXISTS equipment_asset_id INTEGER,
      ADD COLUMN IF NOT EXISTS equipment_hours NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS source_hours_denominator NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS hourly_rate_evidence NUMERIC(18,6)
  `);
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname='ctg_cost_alloc_equipment_asset_fk'
           AND conrelid='contracting_cost_allocations'::regclass
      ) THEN
        ALTER TABLE contracting_cost_allocations
          ADD CONSTRAINT ctg_cost_alloc_equipment_asset_fk
          FOREIGN KEY (equipment_asset_id) REFERENCES fixed_assets(id) ON DELETE RESTRICT NOT VALID;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname='ctg_cost_alloc_equipment_evidence_ck'
           AND conrelid='contracting_cost_allocations'::regclass
      ) THEN
        ALTER TABLE contracting_cost_allocations
          ADD CONSTRAINT ctg_cost_alloc_equipment_evidence_ck CHECK (
            (category='equipment' AND equipment_asset_id IS NOT NULL
              AND equipment_hours > 0 AND source_hours_denominator > 0
              AND hourly_rate_evidence > 0)
            OR
            (category<>'equipment' AND equipment_asset_id IS NULL
              AND equipment_hours IS NULL AND source_hours_denominator IS NULL
              AND hourly_rate_evidence IS NULL)
          ) NOT VALID;
      END IF;
    END $$;
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ctg_cost_alloc_source_idx ON contracting_cost_allocations(company_id, source_type, source_record_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ctg_cost_alloc_target_idx ON contracting_cost_allocations(company_id, project_id, owner_contract_id, subcontractor_contract_id, boq_line_id)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS ctg_cost_alloc_idempotency_uidx ON contracting_cost_allocations(company_id, idempotency_key)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS ctg_cost_alloc_reversal_uidx ON contracting_cost_allocations(reversal_of_id) WHERE reversal_of_id IS NOT NULL`);
}

async function projectAccess(client: any, companyId: number, projectId: number, user: BranchUser) {
  const result = await client.query(
    `SELECT id, branch_id FROM contracting_projects WHERE company_id=$1 AND id=$2`,
    [companyId, projectId],
  );
  const project = result.rows[0];
  if (!project) fail("المشروع غير موجود", 404);
  if (!contractingBranchAllowed(user, project.branch_id == null ? null : Number(project.branch_id))) {
    fail("لا تملك صلاحية فرع المشروع", 403);
  }
  return project;
}

async function validateTarget(client: any, input: {
  companyId: number;
  projectId: number;
  ownerContractId: number | null;
  subcontractorContractId: number | null;
  boqLineId: number | null;
}) {
  if (input.ownerContractId && input.subcontractorContractId) {
    fail("لا يمكن اختيار عقد مالك وعقد باطن معاً", 422);
  }
  if (input.ownerContractId) {
    const found = await client.query(
      `SELECT 1 FROM contracting_owner_contracts WHERE company_id=$1 AND project_id=$2 AND id=$3`,
      [input.companyId, input.projectId, input.ownerContractId],
    );
    if (!found.rowCount) fail("عقد المالك لا يتبع المشروع", 422);
  }
  if (input.subcontractorContractId) {
    const found = await client.query(
      `SELECT 1 FROM contracting_sub_contracts WHERE company_id=$1 AND project_id=$2 AND id=$3`,
      [input.companyId, input.projectId, input.subcontractorContractId],
    );
    if (!found.rowCount) fail("عقد المقاول لا يتبع المشروع", 422);
  }
  if (input.boqLineId) {
    const found = await client.query(
      `SELECT direction, owner_contract_id, subcontractor_contract_id
         FROM contracting_contract_boq_lines
        WHERE company_id=$1 AND project_id=$2 AND id=$3`,
      [input.companyId, input.projectId, input.boqLineId],
    );
    const line = found.rows[0];
    if (!line) fail("بند العقد لا يتبع المشروع", 422);
    if (input.ownerContractId && Number(line.owner_contract_id) !== input.ownerContractId) {
      fail("بند العقد لا يتبع عقد المالك المحدد", 422);
    }
    if (input.subcontractorContractId && Number(line.subcontractor_contract_id) !== input.subcontractorContractId) {
      fail("بند العقد لا يتبع عقد المقاول المحدد", 422);
    }
    if (!input.ownerContractId && !input.subcontractorContractId) {
      fail("يجب تحديد عقد البند", 422);
    }
  }
}

async function lockPostedSource(
  client: any,
  companyId: number,
  sourceType: string,
  sourceRecordId: number,
  requestedCategory: unknown,
  user: BranchUser,
): Promise<SourceSnapshot> {
  const category = validateSourceCategory(sourceType, requestedCategory);
  let query = "";
  if (sourceType === "payroll_snapshot") {
    query = `
      SELECT s.id, s.company_id, r.branch_id, s.allocated_amount amount, s.period_end source_date,
             ('Payroll snapshot #' || s.id) label,
             jsonb_build_object('payrollRunId', s.payroll_run_id, 'payrollLineId', s.payroll_line_id,
               'employeeId', s.employee_id, 'days', s.days, 'costBasis', s.cost_basis) meta
        FROM payroll_allocation_snapshots s
        JOIN payroll_runs r ON r.id=s.payroll_run_id AND r.company_id=s.company_id
       WHERE s.company_id=$1 AND s.id=$2 AND r.status='posted'
         AND r.posted_journal_id IS NOT NULL
       FOR UPDATE OF s`;
  } else if (sourceType === "fixed_asset_depreciation") {
    query = `
      SELECT r.id, r.company_id, a.branch_id, r.depreciation_amount amount,
             make_date(r.period_year, r.period_month, 1) source_date,
             (a.code || ' — ' || a.name_ar) label,
             jsonb_build_object('assetId', r.asset_id, 'periodYear', r.period_year,
               'periodMonth', r.period_month, 'journalEntryId', r.journal_entry_id,
               'approvedOperatingHours', a.approved_operating_hours,
               'allocationMethod', a.manufacturing_allocation_method) meta
        FROM fa_depreciation_runs r
        JOIN fixed_assets a ON a.id=r.asset_id AND a.company_id=r.company_id
       WHERE r.company_id=$1 AND r.id=$2 AND r.status='posted' AND r.journal_entry_id IS NOT NULL
       FOR UPDATE OF r`;
  } else if (sourceType === "purchase_invoice_line") {
    query = `
      SELECT l.id, l.company_id, i.branch_id, COALESCE(NULLIF(l.final_cost,0), l.line_total) amount,
             i.invoice_date::date source_date,
             COALESCE(l.item_code || ' — ', '') || l.item_name label,
             jsonb_build_object('invoiceId', i.id, 'documentNumber', i.doc_number,
               'journalEntryId', i.journal_entry_id, 'itemId', l.item_id) meta
        FROM purchase_invoice_lines l
        JOIN purchase_invoices i ON i.id=l.invoice_id AND i.company_id=l.company_id
        LEFT JOIN items item ON item.id=l.item_id AND item.company_id=l.company_id
        JOIN accounts expense_account
          ON expense_account.id=l.account_id AND expense_account.company_id=l.company_id
         AND expense_account.account_type='expense'
       WHERE l.company_id=$1 AND l.id=$2 AND i.status='posted' AND i.journal_entry_id IS NOT NULL
         AND (l.item_id IS NULL OR item.item_type <> 'stock')
       FOR UPDATE OF l`;
  } else if (sourceType === "subcontract_bill") {
    query = `
      SELECT b.id, b.company_id, p.branch_id, b.net_amount amount, b.bill_date source_date,
             ('Subcontract certificate ' || b.bill_number) label,
             jsonb_build_object('projectId', b.project_id, 'subcontractorContractId',
               b.subcontractor_contract_id, 'journalEntryId', b.journal_entry_id) meta
        FROM contracting_progress_bills b
        JOIN contracting_projects p ON p.id=b.project_id AND p.company_id=b.company_id
       WHERE b.company_id=$1 AND b.id=$2 AND b.direction='incoming'
         AND b.status IN ('approved','posted','partially_paid','paid')
         AND b.journal_entry_id IS NOT NULL AND b.reversal_journal_entry_id IS NULL
       FOR UPDATE OF b`;
  } else if (sourceType === "journal_expense_line") {
    query = `
      SELECT l.id, j.company_id, j.branch_id, l.debit amount, j.entry_date::date source_date,
             (COALESCE(j.doc_number, 'JE #' || j.id) || ' — ' ||
               COALESCE(l.description, a.name_ar)) label,
             jsonb_build_object('journalEntryId', j.id, 'accountId', l.account_id,
               'entryType', j.entry_type, 'costCenter', l.cost_center,
               'paymentVoucherId', (
                 SELECT v.id FROM payment_vouchers v
                  WHERE v.company_id=j.company_id AND v.journal_entry_id=j.id LIMIT 1
               )) meta
        FROM journal_entry_lines l
        JOIN journal_entries j ON j.id=l.entry_id
        JOIN accounts a ON a.id=l.account_id AND a.company_id=j.company_id
          AND a.account_type='expense'
       WHERE j.company_id=$1 AND l.id=$2 AND j.status='posted' AND l.debit > 0
         AND j.entry_type NOT LIKE 'contracting_%'
         AND NOT EXISTS (SELECT 1 FROM payroll_runs r WHERE r.company_id=j.company_id AND r.posted_journal_id=j.id)
         AND NOT EXISTS (SELECT 1 FROM fa_depreciation_runs r WHERE r.company_id=j.company_id AND r.journal_entry_id=j.id)
         AND NOT EXISTS (SELECT 1 FROM purchase_invoices i WHERE i.company_id=j.company_id AND i.journal_entry_id=j.id)
         AND NOT EXISTS (SELECT 1 FROM contracting_progress_bills b WHERE b.company_id=j.company_id AND b.journal_entry_id=j.id)
         AND NOT EXISTS (SELECT 1 FROM contracting_material_movements m WHERE m.company_id=j.company_id AND m.journal_entry_id=j.id)
         AND NOT EXISTS (SELECT 1 FROM accounting_adjustment_runs ar WHERE ar.company_id=j.company_id AND ar.journal_entry_id=j.id)
         AND NOT EXISTS (
           SELECT 1 FROM production_cost_allocations pa
            WHERE pa.company_id=j.company_id
              AND (pa.reclassification_journal_entry_id=j.id OR pa.reversal_journal_entry_id=j.id)
         )
         AND NOT EXISTS (
           SELECT 1 FROM payment_vouchers v
            WHERE v.company_id=j.company_id AND v.journal_entry_id=j.id
              AND v.purchase_invoice_id IS NOT NULL
         )
       FOR UPDATE OF l`;
  }
  const result = await client.query(query, [companyId, sourceRecordId]);
  const row = result.rows[0];
  if (!row) fail("مصدر التكلفة غير موجود أو غير مرحّل أو تم عكسه", 422, "POSTED_SOURCE_REQUIRED");
  if (!contractingBranchAllowed(user, row.branch_id == null ? null : Number(row.branch_id))) {
    fail("لا تملك صلاحية فرع مصدر التكلفة", 403);
  }
  const amount = Number(row.amount);
  if (!Number.isFinite(amount) || amount <= 0) fail("مصدر التكلفة لا يحتوي مبلغاً موجباً قابلاً للتوزيع", 422);
  return {
    type: sourceType,
    id: Number(row.id),
    companyId: Number(row.company_id),
    amount,
    date: isoDateValue(row.source_date),
    label: String(row.label),
    category,
    branchId: row.branch_id == null ? null : Number(row.branch_id),
    meta: row.meta ?? {},
  };
}

async function otherModuleAllocatedAmount(
  client: any,
  companyId: number,
  sourceType: string,
  sourceRecordId: number,
): Promise<number> {
  // Fixed-asset runs use the same stable source identity in production. The
  // posted run lock held by the caller serializes both allocation consumers.
  // Payroll production allocations are run-level while contracting consumes
  // project snapshots, and industrial purchases use invoice-level identities,
  // so those unlike identities must not be guessed or cross-subtracted.
  if (sourceType !== "fixed_asset_depreciation") return 0;
  const result = await client.query(
    `SELECT COALESCE(SUM(
       CASE WHEN reversal_journal_entry_id IS NULL THEN allocated_amount ELSE 0 END
     ),0)::text used
       FROM production_cost_allocations
      WHERE company_id=$1 AND source_type='fixed_asset_depreciation' AND source_record_id=$2`,
    [companyId, sourceRecordId],
  );
  return Number(result.rows[0]?.used ?? 0);
}

export async function createContractingCostAllocation(
  companyId: number,
  projectIdValue: unknown,
  body: any,
  user: BranchUser,
) {
  await ensureContractingCostAllocationTables();
  const projectId = positiveInteger(projectIdValue, "المشروع")!;
  const sourceRecordId = positiveInteger(body.sourceRecordId, "سجل المصدر")!;
  const ownerContractId = positiveInteger(body.ownerContractId, "عقد المالك", true);
  const subcontractorContractId = positiveInteger(body.subcontractorContractId, "عقد المقاول", true);
  const boqLineId = positiveInteger(body.boqLineId, "بند العقد", true);
  const sourceType = String(body.sourceType ?? "");
  const idempotencyKey = String(body.idempotencyKey ?? "").trim();
  if (!idempotencyKey || idempotencyKey.length > 160) fail("مفتاح منع التكرار مطلوب", 422);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await projectAccess(client, companyId, projectId, user);
    await validateTarget(client, {
      companyId, projectId, ownerContractId, subcontractorContractId, boqLineId,
    });
    const replay = await client.query(
      `SELECT * FROM contracting_cost_allocations WHERE company_id=$1 AND idempotency_key=$2`,
      [companyId, idempotencyKey],
    );
    if (replay.rows[0]) {
      assertAllocationReplay(replay.rows[0], {
        projectId, sourceType, sourceRecordId, ownerContractId,
        subcontractorContractId, boqLineId, body,
      });
      await client.query("COMMIT");
      return replay.rows[0];
    }
    const source = await lockPostedSource(
      client, companyId, sourceType, sourceRecordId, body.category, user,
    );
    // A concurrent retry can only reach this point after the same source lock
    // has been released. Re-check under that lock so idempotent retries return
    // the first row instead of surfacing the unique-index race.
    const lockedReplay = await client.query(
      `SELECT * FROM contracting_cost_allocations WHERE company_id=$1 AND idempotency_key=$2`,
      [companyId, idempotencyKey],
    );
    if (lockedReplay.rows[0]) {
      assertAllocationReplay(lockedReplay.rows[0], {
        projectId, sourceType, sourceRecordId, ownerContractId,
        subcontractorContractId, boqLineId, body,
      });
      await client.query("COMMIT");
      return lockedReplay.rows[0];
    }
    if (sourceType === "subcontract_bill") {
      const sourceProjectId = Number(source.meta.projectId);
      const sourceContractId = Number(source.meta.subcontractorContractId);
      if (sourceProjectId !== projectId || (subcontractorContractId && sourceContractId !== subcontractorContractId)) {
        fail("مستخلص المقاول لا يتبع المشروع/العقد المحدد", 422);
      }
    }
    const usedResult = await client.query(
      `SELECT COALESCE(SUM(allocated_amount),0)::text used
         FROM contracting_cost_allocations
        WHERE company_id=$1 AND source_type=$2 AND source_record_id=$3`,
      [companyId, sourceType, sourceRecordId],
    );
    const allocatedByOtherModules = await otherModuleAllocatedAmount(
      client, companyId, sourceType, sourceRecordId,
    );
    const alreadyAllocated = Number(usedResult.rows[0]?.used ?? 0) + allocatedByOtherModules;
    let equipmentAssetId: number | null = null;
    let equipmentHours: number | null = null;
    let sourceHoursDenominator: number | null = null;
    let hourlyRateEvidence: number | null = null;
    const calculated = source.category === "equipment"
      ? (() => {
          equipmentAssetId = Number(source.meta.assetId);
          equipmentHours = Number(body.equipmentHours);
          sourceHoursDenominator = Number(source.meta.approvedOperatingHours);
          if (!Number.isInteger(equipmentAssetId) || equipmentAssetId <= 0
            || !Number.isFinite(equipmentHours) || equipmentHours <= 0
            || !Number.isFinite(sourceHoursDenominator) || sourceHoursDenominator <= 0
            || source.meta.allocationMethod !== "operating_hours") {
            fail("توزيع ساعات المعدات يتطلب أصلاً مضبوطاً بطريقة ساعات التشغيل وساعات معتمدة", 422);
          }
          if (equipmentHours > sourceHoursDenominator + 0.00005) {
            fail("ساعات المعدة تتجاوز ساعات المصدر المعتمدة", 422);
          }
          const availableHours = sourceHoursDenominator
            * Math.max(0, source.amount - alreadyAllocated) / source.amount;
          if (equipmentHours > availableHours + 0.00005) {
            fail("ساعات المعدة تتجاوز الساعات المتبقية من تكلفة المصدر", 422);
          }
          const amount = equipmentHoursAllocation(
            source.amount, equipmentHours, sourceHoursDenominator,
          );
          hourlyRateEvidence = Number((source.amount / sourceHoursDenominator).toFixed(6));
          return {
            ...analyticalAllocationAmount({
              sourceAmount: source.amount,
              alreadyAllocated,
              amount,
            }),
            basis: "equipment_hours",
            sharePct: null,
          };
        })()
      : analyticalAllocationAmount({
          sourceAmount: source.amount,
          alreadyAllocated,
          amount: body.amount == null ? null : Number(body.amount),
          sharePct: body.sharePct == null ? null : Number(body.sharePct),
        });
    const inserted = await client.query(
      `INSERT INTO contracting_cost_allocations(
         company_id, project_id, owner_contract_id, subcontractor_contract_id, boq_line_id,
         category, source_type, source_record_id, source_date, source_amount, basis,
         share_pct, allocated_amount, equipment_asset_id, equipment_hours,
         source_hours_denominator, hourly_rate_evidence,
         idempotency_key, source_snapshot, notes, created_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21)
       RETURNING *`,
      [
        companyId, projectId, ownerContractId, subcontractorContractId, boqLineId,
        source.category, sourceType, sourceRecordId, source.date, source.amount,
        calculated.basis, calculated.sharePct, calculated.amount,
        equipmentAssetId, equipmentHours, sourceHoursDenominator, hourlyRateEvidence, idempotencyKey,
        JSON.stringify({ label: source.label, ...source.meta }),
        body.notes ? String(body.notes).slice(0, 1000) : null, user.id,
      ],
    );
    await client.query("COMMIT");
    return inserted.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function reverseContractingCostAllocation(
  companyId: number,
  allocationIdValue: unknown,
  idempotencyKeyValue: unknown,
  user: BranchUser,
) {
  await ensureContractingCostAllocationTables();
  const allocationId = positiveInteger(allocationIdValue, "التوزيع")!;
  const idempotencyKey = String(idempotencyKeyValue ?? "").trim();
  if (!idempotencyKey || idempotencyKey.length > 160) fail("مفتاح منع التكرار مطلوب", 422);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const replay = await client.query(
      `SELECT * FROM contracting_cost_allocations WHERE company_id=$1 AND idempotency_key=$2`,
      [companyId, idempotencyKey],
    );
    if (replay.rows[0]) {
      if (Number(replay.rows[0].reversal_of_id) !== allocationId) {
        fail("مفتاح منع التكرار مستخدم لعملية أخرى", 409, "IDEMPOTENCY_KEY_REUSED");
      }
      await projectAccess(client, companyId, Number(replay.rows[0].project_id), user);
      await client.query("COMMIT");
      return replay.rows[0];
    }
    const locked = await client.query(
      `SELECT * FROM contracting_cost_allocations
        WHERE company_id=$1 AND id=$2 FOR UPDATE`,
      [companyId, allocationId],
    );
    const original = locked.rows[0];
    if (!original) fail("التوزيع غير موجود", 404);
    if (original.reversal_of_id != null) fail("لا يمكن عكس سجل عكسي", 422);
    await projectAccess(client, companyId, Number(original.project_id), user);
    const existing = await client.query(
      `SELECT * FROM contracting_cost_allocations WHERE reversal_of_id=$1`,
      [allocationId],
    );
    if (existing.rows[0]) fail("تم عكس هذا التوزيع مسبقاً", 409, "ALLOCATION_ALREADY_REVERSED");
    const inserted = await client.query(
      `INSERT INTO contracting_cost_allocations(
         company_id, project_id, owner_contract_id, subcontractor_contract_id, boq_line_id,
         category, source_type, source_record_id, source_date, source_amount, basis,
         share_pct, allocated_amount, equipment_asset_id, equipment_hours,
         source_hours_denominator, hourly_rate_evidence,
         reversal_of_id, idempotency_key, source_snapshot,
         notes, created_by
       ) SELECT company_id, project_id, owner_contract_id, subcontractor_contract_id, boq_line_id,
         category, source_type, source_record_id, source_date, source_amount, 'reversal',
         share_pct, -allocated_amount, equipment_asset_id, equipment_hours,
         source_hours_denominator, hourly_rate_evidence,
         id, $3, source_snapshot,
         $4, $5
       FROM contracting_cost_allocations WHERE company_id=$1 AND id=$2
       RETURNING *`,
      [companyId, allocationId, idempotencyKey, `عكس التوزيع #${allocationId}`, user.id],
    );
    await client.query("COMMIT");
    return inserted.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listContractingCostAllocations(
  companyId: number,
  projectIdValue: unknown,
  user: BranchUser,
) {
  await ensureContractingCostAllocationTables();
  const projectId = positiveInteger(projectIdValue, "المشروع")!;
  const client = await pool.connect();
  try {
    await projectAccess(client, companyId, projectId, user);
    const result = await client.query(
      `SELECT a.*, COALESCE(w.name_ar, a.source_snapshot->>'label') boq_or_source_label
         FROM contracting_cost_allocations a
         LEFT JOIN contracting_contract_boq_lines b ON b.id=a.boq_line_id
         LEFT JOIN contracting_work_items w ON w.id=b.work_item_id
        WHERE a.company_id=$1 AND a.project_id=$2
        ORDER BY a.created_at DESC, a.id DESC`,
      [companyId, projectId],
    );
    const totals = new Map<string, number>();
    for (const row of result.rows) {
      totals.set(row.category, Number(((totals.get(row.category) ?? 0) + Number(row.allocated_amount)).toFixed(2)));
    }
    const coverage = categoryCoverage(totals.keys());
    return {
      allocations: result.rows,
      totals: coverage.categories.map(row => ({
        ...row,
        amount: row.available ? totals.get(row.category) ?? 0 : null,
      })),
      coverage: {
        complete: coverage.complete,
        missingCategories: coverage.missingCategories,
        note: coverage.complete
          ? null
          : "الفئات غير الموجودة غير مكتملة وليست تكلفتها صفراً.",
      },
    };
  } finally {
    client.release();
  }
}

export async function listContractingCostSources(
  companyId: number,
  projectIdValue: unknown,
  sourceTypeValue: unknown,
  user: BranchUser,
) {
  await ensureContractingCostAllocationTables();
  const projectId = positiveInteger(projectIdValue, "المشروع")!;
  const sourceType = String(sourceTypeValue ?? "");
  // Validate before selecting a query. The category is selected separately by
  // the client, but each category still passes validateSourceCategory on write.
  validateSourceCategory(sourceType, undefined);
  const client = await pool.connect();
  try {
    await projectAccess(client, companyId, projectId, user);
    let query: string;
    let params: unknown[] = [companyId];
    if (sourceType === "payroll_snapshot") {
      query = `
        SELECT s.id, r.branch_id, s.allocated_amount amount, s.period_end source_date,
               ('Payroll #' || r.code || ' / employee #' || s.employee_id) label
          FROM payroll_allocation_snapshots s
          JOIN payroll_runs r ON r.id=s.payroll_run_id AND r.company_id=s.company_id
         WHERE s.company_id=$1 AND s.project_id=$2 AND r.status='posted'
           AND r.posted_journal_id IS NOT NULL
         ORDER BY s.period_end DESC, s.id DESC LIMIT 100`;
      params.push(projectId);
    } else if (sourceType === "fixed_asset_depreciation") {
      query = `
        SELECT r.id, a.branch_id, r.depreciation_amount amount,
               make_date(r.period_year, r.period_month, 1) source_date,
               (a.code || ' — ' || a.name_ar || ' (' || r.period_month || '/' || r.period_year || ')') label,
               a.id equipment_asset_id, a.approved_operating_hours,
               a.manufacturing_allocation_method allocation_method
          FROM fa_depreciation_runs r
          JOIN fixed_assets a ON a.id=r.asset_id AND a.company_id=r.company_id
         WHERE r.company_id=$1 AND r.status='posted' AND r.journal_entry_id IS NOT NULL
         ORDER BY r.period_year DESC, r.period_month DESC, r.id DESC LIMIT 100`;
    } else if (sourceType === "purchase_invoice_line") {
      query = `
        SELECT l.id, i.branch_id, COALESCE(NULLIF(l.final_cost,0), l.line_total) amount,
               i.invoice_date::date source_date,
               (COALESCE(i.doc_number, 'Purchase invoice #' || i.id) || ' — ' || l.item_name) label
          FROM purchase_invoice_lines l
          JOIN purchase_invoices i ON i.id=l.invoice_id AND i.company_id=l.company_id
          LEFT JOIN items item ON item.id=l.item_id AND item.company_id=l.company_id
          JOIN accounts expense_account
            ON expense_account.id=l.account_id AND expense_account.company_id=l.company_id
           AND expense_account.account_type='expense'
         WHERE l.company_id=$1 AND i.status='posted' AND i.journal_entry_id IS NOT NULL
           AND (l.item_id IS NULL OR item.item_type <> 'stock')
         ORDER BY i.invoice_date DESC, l.id DESC LIMIT 100`;
    } else if (sourceType === "subcontract_bill") {
      query = `
        SELECT b.id, p.branch_id, b.net_amount amount, b.bill_date source_date,
               ('Subcontract certificate ' || b.bill_number) label
          FROM contracting_progress_bills b
          JOIN contracting_projects p ON p.id=b.project_id AND p.company_id=b.company_id
         WHERE b.company_id=$1 AND b.project_id=$2 AND b.direction='incoming'
           AND b.status IN ('approved','posted','partially_paid','paid')
           AND b.journal_entry_id IS NOT NULL AND b.reversal_journal_entry_id IS NULL
         ORDER BY b.bill_date DESC, b.id DESC LIMIT 100`;
      params.push(projectId);
    } else {
      query = `
        SELECT l.id, j.branch_id, l.debit amount, j.entry_date::date source_date,
               (COALESCE(j.doc_number, 'JE #' || j.id) || ' — ' ||
                 COALESCE(l.description, a.name_ar)) label
          FROM journal_entry_lines l
          JOIN journal_entries j ON j.id=l.entry_id
          JOIN accounts a ON a.id=l.account_id AND a.company_id=j.company_id
            AND a.account_type='expense'
         WHERE j.company_id=$1 AND j.status='posted' AND l.debit > 0
           AND j.entry_type NOT LIKE 'contracting_%'
           AND NOT EXISTS (SELECT 1 FROM payroll_runs r WHERE r.company_id=j.company_id AND r.posted_journal_id=j.id)
           AND NOT EXISTS (SELECT 1 FROM fa_depreciation_runs r WHERE r.company_id=j.company_id AND r.journal_entry_id=j.id)
           AND NOT EXISTS (SELECT 1 FROM purchase_invoices i WHERE i.company_id=j.company_id AND i.journal_entry_id=j.id)
           AND NOT EXISTS (SELECT 1 FROM contracting_progress_bills b WHERE b.company_id=j.company_id AND b.journal_entry_id=j.id)
           AND NOT EXISTS (SELECT 1 FROM contracting_material_movements m WHERE m.company_id=j.company_id AND m.journal_entry_id=j.id)
           AND NOT EXISTS (SELECT 1 FROM accounting_adjustment_runs ar WHERE ar.company_id=j.company_id AND ar.journal_entry_id=j.id)
           AND NOT EXISTS (
             SELECT 1 FROM production_cost_allocations pa
              WHERE pa.company_id=j.company_id
                AND (pa.reclassification_journal_entry_id=j.id OR pa.reversal_journal_entry_id=j.id)
           )
           AND NOT EXISTS (
             SELECT 1 FROM payment_vouchers v
              WHERE v.company_id=j.company_id AND v.journal_entry_id=j.id
                AND v.purchase_invoice_id IS NOT NULL
           )
         ORDER BY j.entry_date DESC, l.id DESC LIMIT 100`;
    }
    const selected = await client.query(query, params);
    const ids = selected.rows.map(row => Number(row.id));
    let usedById = new Map<number, number>();
    if (ids.length) {
      const used = await client.query(
        `SELECT source_record_id, COALESCE(SUM(allocated_amount),0)::text used
           FROM contracting_cost_allocations
          WHERE company_id=$1 AND source_type=$2 AND source_record_id=ANY($3::integer[])
          GROUP BY source_record_id`,
        [companyId, sourceType, ids],
      );
      usedById = new Map(used.rows.map(row => [Number(row.source_record_id), Number(row.used)]));
      if (sourceType === "fixed_asset_depreciation") {
        const productionUsed = await client.query(
          `SELECT source_record_id, COALESCE(SUM(
             CASE WHEN reversal_journal_entry_id IS NULL THEN allocated_amount ELSE 0 END
           ),0)::text used
             FROM production_cost_allocations
            WHERE company_id=$1 AND source_type='fixed_asset_depreciation'
              AND source_record_id=ANY($2::integer[])
            GROUP BY source_record_id`,
          [companyId, ids],
        );
        for (const row of productionUsed.rows) {
          const id = Number(row.source_record_id);
          usedById.set(id, (usedById.get(id) ?? 0) + Number(row.used));
        }
      }
    }
    return {
      sources: selected.rows.filter(row =>
        contractingBranchAllowed(user, row.branch_id == null ? null : Number(row.branch_id)),
      ).map(row => {
        const amount = Number(row.amount);
        const allocated = usedById.get(Number(row.id)) ?? 0;
        return {
          id: Number(row.id),
          label: String(row.label),
          sourceDate: isoDateValue(row.source_date),
          amount,
          allocated,
          available: Number(Math.max(0, amount - allocated).toFixed(2)),
          equipmentAssetId: row.equipment_asset_id == null ? null : Number(row.equipment_asset_id),
          approvedOperatingHours: row.approved_operating_hours == null
            ? null : Number(row.approved_operating_hours),
          availableOperatingHours: row.approved_operating_hours == null || amount <= 0
            ? null
            : Number((Number(row.approved_operating_hours)
              * Math.max(0, amount - allocated) / amount).toFixed(4)),
          allocationMethod: row.allocation_method ?? null,
        };
      }).filter(row => row.available > 0),
      capabilities: {
        directExpense: "تظهر فقط أسطر الخدمات/المصروفات المرحلة على حساب مصروف.",
        equipment: "المتاح للمعدات هو توزيع تحليلي لإهلاك أصل مرحّل فقط؛ تقدير ساعات التشغيل غير المرحّل ليس مصدر تكلفة فعلية صالحاً.",
        inventory: "تُستبعد رسملة مشتريات المخزون؛ تصبح المواد تكلفة مشروع فقط عند صرفها بحركة مواد مقاولات مرحلة.",
      },
    };
  } finally {
    client.release();
  }
}

export async function contractingCostReportBreakdown(companyId: number, projectId: number) {
  await ensureContractingCostAllocationTables();
  const result = await db.execute(sql`
    SELECT category, source_type,
           ROUND(SUM(allocated_amount)::numeric, 2) amount,
           COUNT(*) FILTER (WHERE reversal_of_id IS NULL) allocation_count,
           COUNT(*) FILTER (WHERE reversal_of_id IS NOT NULL) reversal_count
      FROM contracting_cost_allocations
     WHERE company_id=${companyId} AND project_id=${projectId}
     GROUP BY category, source_type
     ORDER BY category, source_type
  `);
  const rows = rowsOf(result).map(row => ({
    category: String(row.category),
    sourceType: String(row.source_type),
    amount: Number(row.amount),
    allocationCount: Number(row.allocation_count),
    reversalCount: Number(row.reversal_count),
  }));
  const categories = new Set(rows.map(row => row.category));
  const coverage = categoryCoverage(categories);
  const byCategory = coverage.categories.map(row => ({
    category: row.category,
    amount: row.available
      ? Number(rows.filter(item => item.category === row.category)
        .reduce((sum, item) => sum + item.amount, 0).toFixed(2))
      : null,
    available: row.available,
  }));
  return {
    sources: rows,
    categories: byCategory,
    total: Number(rows.reduce((sum, row) => sum + row.amount, 0).toFixed(2)),
    coverageComplete: coverage.complete,
    missingCategories: coverage.missingCategories,
  };
}

async function contractingExecutionActualCosts(input: {
  companyId: number;
  projectId: number;
  workItemIds: number[];
}): Promise<Map<number, ExecutionActualCost>> {
  const result = new Map<number, ExecutionActualCost>();
  for (const id of input.workItemIds) {
    result.set(id, {
      amount: 0,
      complete: false,
      sources: [],
      missingCategories: [...categoryCoverage([]).missingCategories],
      boqLinked: false,
    });
  }
  if (!input.workItemIds.length) return result;
  await Promise.all([
    ensureContractingCostAllocationTables(),
    ensureContractingAccountingTables(),
  ]);
  const eventsResult = await db.execute(sql`
    WITH requested AS (
      SELECT id
        FROM contracting_work_items
       WHERE company_id=${input.companyId}
         AND project_id=${input.projectId}
         AND id IN (${sql.join(input.workItemIds.map(id => sql`${id}`), sql`, `)})
    ),
    boq_items AS (
      SELECT DISTINCT b.work_item_id
        FROM contracting_contract_boq_lines b
        JOIN requested r ON r.id=b.work_item_id
       WHERE b.company_id=${input.companyId} AND b.project_id=${input.projectId}
    ),
    cost_events AS (
      SELECT b.work_item_id, 'material'::text category,
             'contracting_material_movement'::text source_type,
             m.id source_id,
             CASE WHEN m.direction='return' THEN -m.total_cost ELSE m.total_cost END amount
        FROM contracting_material_movements m
        JOIN contracting_contract_boq_lines b
          ON b.id=m.boq_line_id AND b.company_id=m.company_id AND b.project_id=m.project_id
        JOIN requested r ON r.id=b.work_item_id
       WHERE m.company_id=${input.companyId} AND m.project_id=${input.projectId}
         AND m.status='posted'
      UNION ALL
      SELECT b.work_item_id, a.category, a.source_type,
             a.id source_id, a.allocated_amount amount
        FROM contracting_cost_allocations a
        JOIN contracting_contract_boq_lines b
          ON b.id=a.boq_line_id AND b.company_id=a.company_id AND b.project_id=a.project_id
        JOIN requested r ON r.id=b.work_item_id
       WHERE a.company_id=${input.companyId} AND a.project_id=${input.projectId}
         AND a.category <> 'material'
    )
    SELECT work_item_id, category, source_type, source_id, amount
      FROM cost_events
    ORDER BY work_item_id, source_type, source_id
  `);
  const events = rowsOf(eventsResult);
  const boqResult = await db.execute(sql`
    SELECT DISTINCT work_item_id
      FROM contracting_contract_boq_lines
     WHERE company_id=${input.companyId} AND project_id=${input.projectId}
       AND work_item_id IN (${sql.join(input.workItemIds.map(id => sql`${id}`), sql`, `)})
  `);
  const hasBoq = new Set(rowsOf(boqResult).map(row => Number(row.work_item_id)));
  const categoriesByItem = new Map<number, Set<string>>();
  for (const row of events) {
    const workItemId = Number(row.work_item_id);
    const current = result.get(workItemId);
    if (!current) continue;
    const amount = Number(row.amount);
    current.amount = Number((current.amount + amount).toFixed(2));
    current.sources!.push({
      type: String(row.source_type),
      referenceId: Number(row.source_id),
      amount,
    });
    const categories = categoriesByItem.get(workItemId) ?? new Set<string>();
    categories.add(String(row.category));
    categoriesByItem.set(workItemId, categories);
  }
  for (const [workItemId, current] of result) {
    const coverage = categoryCoverage(categoriesByItem.get(workItemId) ?? []);
    current.complete = hasBoq.has(workItemId) && coverage.complete;
    current.boqLinked = hasBoq.has(workItemId);
    current.missingCategories = coverage.missingCategories;
  }
  return result;
}

registerContractingExecutionActualCostAdapter(contractingExecutionActualCosts);