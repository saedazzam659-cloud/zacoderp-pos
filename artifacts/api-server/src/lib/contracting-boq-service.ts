import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  contractingContractBoqLinesTable,
  contractingOwnerContractsTable,
  contractingProjectsTable,
  contractingSubContractsTable,
  contractingWorkItemsTable,
} from "@workspace/db";
import { contractingBranchAllowed } from "./contracting-security.js";
import type { AuthUser } from "../middleware/auth.js";

type BoqDirection = "owner" | "subcontract";
type Tx = any;

function error(message: string, status = 400): Error & { status: number } {
  const value = new Error(message) as Error & { status: number };
  value.status = status;
  return value;
}

function id(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw error(`${label} غير صالح`);
  return parsed;
}

function nonNegative(value: unknown, label: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) throw error(`${label} يجب أن يكون رقماً غير سالب`);
  return parsed;
}

function money(value: number): string {
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

function quantity(value: number): string {
  return (Math.round((value + Number.EPSILON) * 10000) / 10000).toFixed(4);
}

function directionOf(value: unknown): BoqDirection {
  const direction = String(value ?? "owner");
  if (direction !== "owner" && direction !== "subcontract") {
    throw error("اتجاه جدول الكميات غير صالح");
  }
  return direction;
}

async function lockBoqContract(
  tx: Tx,
  companyId: number,
  projectId: number,
  direction: BoqDirection,
  contractId: number | null,
) {
  if (contractId == null) return;
  if (direction === "owner") {
    await tx.execute(sql`
      SELECT id FROM contracting_owner_contracts
       WHERE id = ${contractId} AND company_id = ${companyId} AND project_id = ${projectId}
       FOR UPDATE
    `);
  } else {
    await tx.execute(sql`
      SELECT id FROM contracting_sub_contracts
       WHERE id = ${contractId} AND company_id = ${companyId} AND project_id = ${projectId}
       FOR UPDATE
    `);
  }
}

function text(value: unknown): string | null {
  const result = value == null ? "" : String(value).trim();
  return result || null;
}

/**
 * The BOQ extension is intentionally self-healing.  Existing central and
 * agent databases may have the shared contracting tables from an older
 * release, so every additive column/index is installed before service code
 * applies its strict business validation.
 */
export function ensureContractingBoqTables(): Promise<void> {
  return (async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS contracting_contract_boq_lines (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES contracting_projects(id) ON DELETE CASCADE,
        work_item_id INTEGER NOT NULL REFERENCES contracting_work_items(id) ON DELETE RESTRICT,
        direction TEXT NOT NULL DEFAULT 'owner',
        owner_contract_id INTEGER REFERENCES contracting_owner_contracts(id) ON DELETE RESTRICT,
        subcontractor_contract_id INTEGER REFERENCES contracting_sub_contracts(id) ON DELETE RESTRICT,
        source_owner_line_id INTEGER,
        base_line_id INTEGER,
        quantity_delta NUMERIC(14,4),
        unit_price_delta NUMERIC(14,2),
        unit_price_override NUMERIC(14,2),
        line_code TEXT,
        description TEXT,
        unit TEXT NOT NULL DEFAULT 'unit',
        quantity NUMERIC(14,4) NOT NULL DEFAULT 0,
        unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    // ALTERs are intentionally independent.  A partially upgraded tenant
    // must be healed column-by-column before any SELECT references a new field.
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'owner'`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS owner_contract_id INTEGER`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS subcontractor_contract_id INTEGER`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS source_owner_line_id INTEGER`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS base_line_id INTEGER`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS quantity_delta NUMERIC(14,4)`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS unit_price_delta NUMERIC(14,2)`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS unit_price_override NUMERIC(14,2)`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS line_code TEXT`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS description TEXT`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'unit'`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS quantity NUMERIC(14,4) NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS unit_price NUMERIC(14,2) NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS total_amount NUMERIC(14,2) NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()`);
    await db.execute(sql`ALTER TABLE contracting_contract_boq_lines ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`);
    await db.execute(sql`
      ALTER TABLE contracting_sub_contracts
        ADD COLUMN IF NOT EXISTS contract_type TEXT NOT NULL DEFAULT 'main'
    `);
    await db.execute(sql`
      ALTER TABLE contracting_sub_contracts
        ADD COLUMN IF NOT EXISTS parent_contract_id INTEGER
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ctg_boq_project_idx
        ON contracting_contract_boq_lines(company_id, project_id)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ctg_boq_owner_contract_idx
        ON contracting_contract_boq_lines(company_id, owner_contract_id)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ctg_boq_subcontract_idx
        ON contracting_contract_boq_lines(company_id, subcontractor_contract_id)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ctg_boq_work_item_idx
        ON contracting_contract_boq_lines(company_id, project_id, work_item_id)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ctg_boq_source_owner_idx
        ON contracting_contract_boq_lines(company_id, source_owner_line_id)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ctg_boq_base_line_idx
        ON contracting_contract_boq_lines(company_id, base_line_id)
    `);
    // A legacy database can contain duplicates, so do not add a strict
    // database unique constraint during healing.  Service-level duplicate
    // validation below works for both old and new databases.
  })();
}

type BranchUser = Pick<AuthUser, "id" | "role" | "viewAllBranches" | "branchIds">;

async function assertProject(companyId: number, projectId: number, user?: BranchUser | null) {
  const [project] = await db.select({
    id: contractingProjectsTable.id,
    branchId: contractingProjectsTable.branchId,
  }).from(contractingProjectsTable).where(and(
    eq(contractingProjectsTable.id, projectId),
    eq(contractingProjectsTable.companyId, companyId),
  ));
  if (!project) throw error("المشروع غير موجود", 404);
  if (user && !contractingBranchAllowed(user, project.branchId)) {
    throw error("لا تملك صلاحية فرع المشروع", 403);
  }
  return project;
}

async function assertWorkItem(companyId: number, projectId: number, workItemId: number) {
  const [workItem] = await db.select().from(contractingWorkItemsTable).where(and(
    eq(contractingWorkItemsTable.id, workItemId),
    eq(contractingWorkItemsTable.companyId, companyId),
    eq(contractingWorkItemsTable.projectId, projectId),
  ));
  if (!workItem) throw error("بند التنفيذ غير صالح لهذا المشروع");
  return workItem;
}

async function assertContract(
  companyId: number,
  projectId: number,
  direction: BoqDirection,
  ownerContractId: number | null,
  subcontractorContractId: number | null,
) {
  if (direction === "owner") {
    if (!ownerContractId || subcontractorContractId != null) {
      throw error("سطر عقد المالك يجب أن يرتبط بعقد مالك واحد فقط");
    }
    const [contract] = await db.select().from(contractingOwnerContractsTable).where(and(
      eq(contractingOwnerContractsTable.id, ownerContractId),
      eq(contractingOwnerContractsTable.companyId, companyId),
      eq(contractingOwnerContractsTable.projectId, projectId),
    ));
    if (!contract) throw error("عقد المالك غير صالح لهذا المشروع");
    return contract;
  }
  if (!subcontractorContractId || ownerContractId != null) {
    throw error("سطر عقد الباطن يجب أن يرتبط بعقد باطن واحد فقط");
  }
  const [contract] = await db.select({
    id: contractingSubContractsTable.id,
    value: contractingSubContractsTable.value,
    contractorId: contractingSubContractsTable.contractorId,
    contractType: contractingSubContractsTable.contractType,
    parentContractId: contractingSubContractsTable.parentContractId,
  }).from(contractingSubContractsTable).where(and(
    eq(contractingSubContractsTable.id, subcontractorContractId),
    eq(contractingSubContractsTable.companyId, companyId),
    eq(contractingSubContractsTable.projectId, projectId),
  ));
  if (!contract) throw error("عقد الباطن غير صالح لهذا المشروع");
  return contract;
}

async function assertSourceOwnerLine(companyId: number, projectId: number, lineId: number) {
  const [line] = await db.select().from(contractingContractBoqLinesTable).where(and(
    eq(contractingContractBoqLinesTable.id, lineId),
    eq(contractingContractBoqLinesTable.companyId, companyId),
    eq(contractingContractBoqLinesTable.projectId, projectId),
    eq(contractingContractBoqLinesTable.direction, "owner"),
  ));
  if (!line) throw error("سطر عقد المالك المصدر غير صالح لهذا المشروع");
  return line;
}

async function contractTotal(
  companyId: number,
  projectId: number,
  direction: BoqDirection,
  contractId: number,
  excludeId?: number,
) {
  const rows = await db.select({
    id: contractingContractBoqLinesTable.id,
    totalAmount: contractingContractBoqLinesTable.totalAmount,
  }).from(contractingContractBoqLinesTable).where(and(
    eq(contractingContractBoqLinesTable.companyId, companyId),
    eq(contractingContractBoqLinesTable.projectId, projectId),
    eq(contractingContractBoqLinesTable.direction, direction),
    direction === "owner"
      ? eq(contractingContractBoqLinesTable.ownerContractId, contractId)
      : eq(contractingContractBoqLinesTable.subcontractorContractId, contractId),
  ));
  return rows
    .filter((row) => row.id !== excludeId)
    .reduce((sum, row) => sum + Number(row.totalAmount), 0);
}

async function sourceAllocatedQuantity(companyId: number, sourceOwnerLineId: number, excludeId?: number) {
  const rows = await db.select({
    id: contractingContractBoqLinesTable.id,
    quantity: contractingContractBoqLinesTable.quantity,
  }).from(contractingContractBoqLinesTable).where(and(
    eq(contractingContractBoqLinesTable.companyId, companyId),
    eq(contractingContractBoqLinesTable.sourceOwnerLineId, sourceOwnerLineId),
    eq(contractingContractBoqLinesTable.direction, "subcontract"),
  ));
  return rows
    .filter((row) => row.id !== excludeId)
    .reduce((sum, row) => sum + Number(row.quantity), 0);
}

async function hasBillBoqReferenceColumn() {
  // Do not auto-assign or rewrite old bill lines.  Commercial BOQ edits are
  // blocked once any posted bill has captured this line's price/quantity.
  const exists = await db.execute(sql`
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'contracting_bill_lines'
       AND column_name = 'boq_line_id'
     LIMIT 1
  `);
  return Array.isArray(exists.rows) && exists.rows.length > 0;
}

async function assertCommercialLineMutable(companyId: number, lineId: number) {
  if (!await hasBillBoqReferenceColumn()) return;
  const referenced = await db.execute(sql`
    SELECT b.id
      FROM contracting_bill_lines l
      JOIN contracting_progress_bills b ON b.id = l.bill_id
     WHERE l.company_id = ${companyId}
       AND l.boq_line_id = ${lineId}
       AND (
         b.status IN ('approved', 'certified', 'posted', 'partially_paid', 'paid', 'reversed')
         OR b.journal_entry_id IS NOT NULL
       )
     LIMIT 1
  `);
  if (Array.isArray(referenced.rows) && referenced.rows.length > 0) {
    throw error("لا يمكن تعديل أو حذف بند جدول كميات مستخدم في مستخلص مرحّل؛ احتفظ باللقطة التاريخية وأنشئ سطراً جديداً", 409);
  }
}

async function validateLine(
  companyId: number,
  projectId: number,
  body: any,
  existingId?: number,
) {
  const direction = directionOf(body.direction);
  const workItemId = id(body.workItemId, "بند التنفيذ");
  const ownerContractId = body.ownerContractId == null || body.ownerContractId === ""
    ? null : id(body.ownerContractId, "عقد المالك");
  const subcontractorContractId = body.subcontractorContractId == null || body.subcontractorContractId === ""
    ? null : id(body.subcontractorContractId, "عقد الباطن");
  const workItem = await assertWorkItem(companyId, projectId, workItemId);
  const contract = await assertContract(companyId, projectId, direction, ownerContractId, subcontractorContractId);
  const unit = text(body.unit) || String(workItem.unit || "unit");
  const lineCode = text(body.lineCode);
  const description = text(body.description);
  const qty = nonNegative(body.quantity, "الكمية");
  const unitPrice = nonNegative(body.unitPrice, "سعر الوحدة");
  const totalAmount = qty * unitPrice;
  if (!unit) throw error("الوحدة مطلوبة");

  const plannedQty = Number(workItem.plannedQty);
  if (plannedQty > 0 && qty > plannedQty + 0.0001) {
    throw error("كمية جدول الكميات تتجاوز الكمية المخططة لبند المشروع");
  }

  let sourceOwnerLine: typeof contractingContractBoqLinesTable.$inferSelect | null = null;
  if (body.sourceOwnerLineId != null && body.sourceOwnerLineId !== "") {
    if (direction !== "subcontract") throw error("ربط سطر المالك متاح لأسطر عقود الباطن فقط");
    sourceOwnerLine = await assertSourceOwnerLine(companyId, projectId, id(body.sourceOwnerLineId, "سطر عقد المالك"));
    if (sourceOwnerLine.workItemId !== workItemId) {
      throw error("سطر المالك المصدر يجب أن يرتبط بنفس بند التنفيذ المختار، وليس ببند آخر مشابه في الاسم");
    }
    const allocated = await sourceAllocatedQuantity(companyId, sourceOwnerLine.id, existingId);
    if (allocated + qty > Number(sourceOwnerLine.quantity) + 0.0001) {
      throw error("إجمالي كميات المقاولين الباطنين يتجاوز كمية سطر عقد المالك");
    }
    if (sourceOwnerLine.unit && unit !== sourceOwnerLine.unit) {
      throw error("وحدة سطر الباطن يجب أن تطابق وحدة سطر عقد المالك المصدر");
    }
  }
  const baseLineId = body.baseLineId == null || body.baseLineId === ""
    ? null : id(body.baseLineId, "السطر الأساسي");
  let quantityDelta: number | null = null;
  let unitPriceDelta: number | null = null;
  let unitPriceOverride: number | null = null;
  if (baseLineId != null) {
    if (baseLineId === existingId) throw error("السطر الأساسي لا يمكن أن يساوي السطر نفسه");
    const [baseLine] = await db.select().from(contractingContractBoqLinesTable).where(and(
      eq(contractingContractBoqLinesTable.id, baseLineId),
      eq(contractingContractBoqLinesTable.companyId, companyId),
      eq(contractingContractBoqLinesTable.projectId, projectId),
      eq(contractingContractBoqLinesTable.direction, direction),
    ));
    if (!baseLine) throw error("السطر الأساسي غير صالح لهذا المشروع والعقد");
    if (direction === "owner") {
      if (contract.contractType !== "change_order" && contract.contractType !== "addendum"
        || contract.parentContractId !== baseLine.ownerContractId) {
        throw error("سطر التغيير يجب أن يتبع العقد الأساسي المحدد");
      }
    } else if (
      contract.contractType !== "change_order"
      || contract.parentContractId !== baseLine.subcontractorContractId
    ) {
      throw error("سطر تغيير عقد الباطن يجب أن يتبع العقد الأساسي المحدد");
    }
    if (body.quantityDelta !== undefined && body.quantityDelta !== null && body.quantityDelta !== "") {
      const parsedDelta = Number(body.quantityDelta);
      if (!Number.isFinite(parsedDelta)) throw error("تعديل الكمية غير صالح");
      quantityDelta = parsedDelta;
    }
    if (body.unitPriceOverride !== undefined && body.unitPriceOverride !== null && body.unitPriceOverride !== "") {
      unitPriceOverride = nonNegative(body.unitPriceOverride, "سعر التغيير");
    }
    if (body.unitPriceDelta !== undefined && body.unitPriceDelta !== null && body.unitPriceDelta !== "") {
      const parsedDelta = Number(body.unitPriceDelta);
      if (!Number.isFinite(parsedDelta)) throw error("تعديل سعر الوحدة غير صالح");
      if (Number(baseLine.unitPrice) + parsedDelta < -0.0001) {
        throw error("لا يمكن خفض سعر الوحدة إلى قيمة سالبة");
      }
      unitPriceDelta = parsedDelta;
    }
    if (quantityDelta != null && quantityDelta < 0) {
      const executed = await db.execute(sql`
        SELECT COALESCE(SUM(l.current_qty), 0)::numeric AS executed
          FROM contracting_bill_lines l
          JOIN contracting_progress_bills b ON b.id = l.bill_id
         WHERE l.company_id = ${companyId}
           AND l.boq_line_id = ${baseLineId}
           AND b.status IN ('approved', 'certified', 'posted', 'partially_paid', 'paid')
      `);
      const rows = Array.isArray(executed) ? executed : (executed as any).rows ?? [];
      if (Number(rows[0]?.executed ?? 0) > Number(baseLine.quantity) + quantityDelta + 0.0001) {
        throw error("لا يمكن خفض كمية التغيير عن الكمية المنفذة والمعتمدة");
      }
    }
  }
  if (direction === "owner" && existingId != null) {
    const allocated = await sourceAllocatedQuantity(companyId, existingId);
    if (allocated > qty + 0.0001) {
      throw error("لا يمكن خفض كمية سطر المالك عن الكمية الموزعة على عقود الباطن");
    }
  }

  // The contract's total is a ceiling, but an existing line is excluded when
  // editing.  This keeps a line from duplicating its own amount.
  const currentTotal = await contractTotal(
    companyId,
    projectId,
    direction,
    direction === "owner" ? ownerContractId! : subcontractorContractId!,
    existingId,
  );
  const contractValue = Number(contract.value ?? 0);
  if (contractValue > 0 && currentTotal + totalAmount > contractValue + 0.01) {
    throw error("إجمالي جدول الكميات يتجاوز قيمة العقد");
  }

  const duplicate = await db.select({ id: contractingContractBoqLinesTable.id })
    .from(contractingContractBoqLinesTable).where(and(
      eq(contractingContractBoqLinesTable.companyId, companyId),
      eq(contractingContractBoqLinesTable.projectId, projectId),
      eq(contractingContractBoqLinesTable.direction, direction),
      eq(contractingContractBoqLinesTable.workItemId, workItemId),
      direction === "owner"
        ? eq(contractingContractBoqLinesTable.ownerContractId, ownerContractId!)
        : eq(contractingContractBoqLinesTable.subcontractorContractId, subcontractorContractId!),
    ));
  if (duplicate.some((row) => row.id !== existingId)) {
    throw error("لا يمكن إضافة بند التنفيذ نفسه مرتين إلى العقد", 409);
  }

  return {
    direction,
    workItemId,
    ownerContractId,
    subcontractorContractId,
    sourceOwnerLineId: sourceOwnerLine?.id ?? null,
    baseLineId,
    quantityDelta: quantityDelta == null ? null : quantity(quantityDelta),
    unitPriceDelta: unitPriceDelta == null ? null : money(unitPriceDelta),
    unitPriceOverride: unitPriceOverride == null ? null : money(unitPriceOverride),
    lineCode,
    description,
    unit,
    quantity: quantity(qty),
    unitPrice: money(unitPrice),
    totalAmount: money(totalAmount),
  };
}

export async function listContractBoqLines(
  companyId: number,
  projectId: number,
  options: { direction?: unknown; ownerContractId?: unknown; subcontractorContractId?: unknown } = {},
  user?: BranchUser | null,
) {
  await ensureContractingBoqTables();
  await assertProject(companyId, projectId, user);
  const conditions: any[] = [
    eq(contractingContractBoqLinesTable.companyId, companyId),
    eq(contractingContractBoqLinesTable.projectId, projectId),
  ];
  if (options.direction != null && options.direction !== "") {
    conditions.push(eq(contractingContractBoqLinesTable.direction, directionOf(options.direction)));
  }
  if (options.ownerContractId != null && options.ownerContractId !== "") {
    conditions.push(eq(contractingContractBoqLinesTable.ownerContractId, id(options.ownerContractId, "عقد المالك")));
  }
  if (options.subcontractorContractId != null && options.subcontractorContractId !== "") {
    conditions.push(eq(contractingContractBoqLinesTable.subcontractorContractId, id(options.subcontractorContractId, "عقد الباطن")));
  }
  const lines = await db.select({
    id: contractingContractBoqLinesTable.id,
    companyId: contractingContractBoqLinesTable.companyId,
    projectId: contractingContractBoqLinesTable.projectId,
    workItemId: contractingContractBoqLinesTable.workItemId,
    direction: contractingContractBoqLinesTable.direction,
    ownerContractId: contractingContractBoqLinesTable.ownerContractId,
    subcontractorContractId: contractingContractBoqLinesTable.subcontractorContractId,
    sourceOwnerLineId: contractingContractBoqLinesTable.sourceOwnerLineId,
    baseLineId: contractingContractBoqLinesTable.baseLineId,
    quantityDelta: contractingContractBoqLinesTable.quantityDelta,
    unitPriceDelta: contractingContractBoqLinesTable.unitPriceDelta,
    unitPriceOverride: contractingContractBoqLinesTable.unitPriceOverride,
    lineCode: contractingContractBoqLinesTable.lineCode,
    description: contractingContractBoqLinesTable.description,
    unit: contractingContractBoqLinesTable.unit,
    quantity: contractingContractBoqLinesTable.quantity,
    unitPrice: contractingContractBoqLinesTable.unitPrice,
    totalAmount: contractingContractBoqLinesTable.totalAmount,
    workItemCode: contractingWorkItemsTable.code,
    workItemName: contractingWorkItemsTable.nameAr,
    createdAt: contractingContractBoqLinesTable.createdAt,
    updatedAt: contractingContractBoqLinesTable.updatedAt,
  }).from(contractingContractBoqLinesTable).innerJoin(
    contractingWorkItemsTable,
    and(
      eq(contractingWorkItemsTable.id, contractingContractBoqLinesTable.workItemId),
      eq(contractingWorkItemsTable.companyId, companyId),
    ),
  ).where(and(...conditions)).orderBy(asc(contractingContractBoqLinesTable.id));
  return lines;
}

export async function createContractBoqLine(companyId: number, projectId: number, req: any) {
  await ensureContractingBoqTables();
  await assertProject(companyId, projectId, req.authUser);
  return db.transaction(async (tx) => {
    const body = req.body ?? {};
    const direction = directionOf(body.direction);
    const contractId = direction === "owner"
      ? (body.ownerContractId == null ? null : Number(body.ownerContractId))
      : (body.subcontractorContractId == null ? null : Number(body.subcontractorContractId));
    await lockBoqContract(tx, companyId, projectId, direction, contractId);
    const values = await validateLine(companyId, projectId, body);
    const [row] = await tx.insert(contractingContractBoqLinesTable).values({
      companyId,
      projectId,
      ...values,
    }).returning();
    return row;
  });
}

export async function updateContractBoqLine(companyId: number, lineId: number, req: any) {
  await ensureContractingBoqTables();
  const [existing] = await db.select().from(contractingContractBoqLinesTable).where(and(
    eq(contractingContractBoqLinesTable.id, lineId),
    eq(contractingContractBoqLinesTable.companyId, companyId),
  ));
  if (!existing) throw error("سطر جدول الكميات غير موجود", 404);
  await assertProject(companyId, existing.projectId, req.authUser);
  return db.transaction(async (tx) => {
    const direction = directionOf(existing.direction);
    const contractId = direction === "owner" ? existing.ownerContractId : existing.subcontractorContractId;
    await lockBoqContract(tx, companyId, existing.projectId, direction, contractId);
    await assertCommercialLineMutable(companyId, lineId);
    const body = { ...existing, ...(req.body ?? {}) };
    const values = await validateLine(companyId, existing.projectId, body, lineId);
    const [row] = await tx.update(contractingContractBoqLinesTable).set({
      ...values,
      updatedAt: new Date(),
    }).where(and(
      eq(contractingContractBoqLinesTable.id, lineId),
      eq(contractingContractBoqLinesTable.companyId, companyId),
    )).returning();
    return row;
  });
}

export async function deleteContractBoqLine(companyId: number, lineId: number, user?: BranchUser | null) {
  await ensureContractingBoqTables();
  const [existing] = await db.select().from(contractingContractBoqLinesTable).where(and(
    eq(contractingContractBoqLinesTable.id, lineId),
    eq(contractingContractBoqLinesTable.companyId, companyId),
  ));
  if (!existing) throw error("سطر جدول الكميات غير موجود", 404);
  await assertProject(companyId, existing.projectId, user);
  return db.transaction(async (tx) => {
    await lockBoqContract(tx, companyId, existing.projectId, directionOf(existing.direction),
      existing.direction === "owner" ? existing.ownerContractId : existing.subcontractorContractId);
    await assertCommercialLineMutable(companyId, lineId);
    if (await hasBillBoqReferenceColumn()) {
    const references = await db.execute(sql`
      SELECT 1 FROM contracting_bill_lines
       WHERE company_id = ${companyId} AND boq_line_id = ${lineId}
       LIMIT 1
    `);
    if (Array.isArray(references.rows) && references.rows.length > 0) {
      throw error("لا يمكن حذف سطر جدول كميات مرتبط بمستخلص؛ أنشئ تصحيحاً بدلاً من حذف التاريخ", 409);
    }
    }
    const sourceReferences = await db.select({ id: contractingContractBoqLinesTable.id })
    .from(contractingContractBoqLinesTable)
    .where(and(
      eq(contractingContractBoqLinesTable.companyId, companyId),
      eq(contractingContractBoqLinesTable.sourceOwnerLineId, lineId),
    ));
    if (sourceReferences.length > 0) {
    throw error("لا يمكن حذف سطر المالك المرتبط بتوزيعات عقود الباطن", 409);
    }
    await tx.delete(contractingContractBoqLinesTable).where(and(
    eq(contractingContractBoqLinesTable.id, lineId),
    eq(contractingContractBoqLinesTable.companyId, companyId),
    ));
    return { ok: true };
  });
}