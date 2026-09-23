import type { Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  contractingProjectsTable,
  contractingOwnerContractsTable,
  contractingSubContractsTable,
  contractingWorkItemsTable,
  contractingContractBoqLinesTable,
} from "@workspace/db";
import { canAccessModule, type PermAction } from "../middleware/permissions.js";
import { contractingBranchAllowed } from "./contracting-security.js";
import { ensureContractingBoqTables } from "./contracting-boq-service.js";
import { ensureContractingGuaranteeTables } from "./contracting-guarantees-storage.js";

export const CONTRACTING_ARCHIVE_ENTITIES = {
  contracting_projects: { prefix: "project", label: "المشروع" },
  contracting_owner_contracts: { prefix: "owner-contract", label: "عقد المالك" },
  contracting_subcontracts: { prefix: "subcontract", label: "عقد المقاول من الباطن" },
  contracting_boq_lines: { prefix: "boq-line", label: "بند جدول الكميات" },
  contracting_work_items: { prefix: "work-item", label: "بند التنفيذ" },
  contracting_tenders: { prefix: "tender", label: "المناقصة" },
  contracting_guarantees: { prefix: "guarantee", label: "خطاب الضمان" },
} as const;

export type ContractingArchiveScreenKey = keyof typeof CONTRACTING_ARCHIVE_ENTITIES;
export type ContractingArchiveAction = "view" | "edit" | "delete";

export interface ContractingArchiveRef {
  screenKey: ContractingArchiveScreenKey;
  entityId: number;
}

export class ContractingArchiveAccessError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ContractingArchiveAccessError";
  }
}

/**
 * Contracting archive keys are deliberately closed and canonical. A caller
 * cannot substitute a project code, contract number, object path, or another
 * tenant's identifier and have it interpreted as an archive target.
 */
export function parseContractingArchiveRef(
  screenKey: string,
  docKey: string,
): ContractingArchiveRef | null {
  const config = CONTRACTING_ARCHIVE_ENTITIES[screenKey as ContractingArchiveScreenKey];
  if (!config) {
    if (screenKey.startsWith("contracting_")) {
      throw new ContractingArchiveAccessError("نوع أرشيف المقاولات غير مدعوم", 400);
    }
    return null;
  }
  const match = new RegExp(`^${config.prefix}:([1-9][0-9]*)$`).exec(docKey);
  const entityId = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(entityId)) {
    throw new ContractingArchiveAccessError("معرّف مستند المقاولات غير صالح", 400);
  }
  return { screenKey: screenKey as ContractingArchiveScreenKey, entityId };
}

async function entityProjectBranch(
  companyId: number,
  ref: ContractingArchiveRef,
): Promise<number | null | undefined> {
  switch (ref.screenKey) {
    case "contracting_projects": {
      const [row] = await db.select({ branchId: contractingProjectsTable.branchId })
        .from(contractingProjectsTable)
        .where(and(
          eq(contractingProjectsTable.id, ref.entityId),
          eq(contractingProjectsTable.companyId, companyId),
        )).limit(1);
      return row?.branchId;
    }
    case "contracting_owner_contracts": {
      const [row] = await db.select({ branchId: contractingProjectsTable.branchId })
        .from(contractingOwnerContractsTable)
        .innerJoin(contractingProjectsTable, and(
          eq(contractingProjectsTable.id, contractingOwnerContractsTable.projectId),
          eq(contractingProjectsTable.companyId, contractingOwnerContractsTable.companyId),
        ))
        .where(and(
          eq(contractingOwnerContractsTable.id, ref.entityId),
          eq(contractingOwnerContractsTable.companyId, companyId),
        )).limit(1);
      return row?.branchId;
    }
    case "contracting_subcontracts": {
      const [row] = await db.select({ branchId: contractingProjectsTable.branchId })
        .from(contractingSubContractsTable)
        .innerJoin(contractingProjectsTable, and(
          eq(contractingProjectsTable.id, contractingSubContractsTable.projectId),
          eq(contractingProjectsTable.companyId, contractingSubContractsTable.companyId),
        ))
        .where(and(
          eq(contractingSubContractsTable.id, ref.entityId),
          eq(contractingSubContractsTable.companyId, companyId),
        )).limit(1);
      return row?.branchId;
    }
    case "contracting_work_items": {
      const [row] = await db.select({ branchId: contractingProjectsTable.branchId })
        .from(contractingWorkItemsTable)
        .innerJoin(contractingProjectsTable, and(
          eq(contractingProjectsTable.id, contractingWorkItemsTable.projectId),
          eq(contractingProjectsTable.companyId, contractingWorkItemsTable.companyId),
        ))
        .where(and(
          eq(contractingWorkItemsTable.id, ref.entityId),
          eq(contractingWorkItemsTable.companyId, companyId),
        )).limit(1);
      return row?.branchId;
    }
    case "contracting_boq_lines": {
      // This healer executes through the request's active tenant DB context,
      // rather than preparing only the central database.
      await ensureContractingBoqTables();
      const [row] = await db.select({ branchId: contractingProjectsTable.branchId })
        .from(contractingContractBoqLinesTable)
        .innerJoin(contractingProjectsTable, and(
          eq(contractingProjectsTable.id, contractingContractBoqLinesTable.projectId),
          eq(contractingProjectsTable.companyId, contractingContractBoqLinesTable.companyId),
        ))
        .where(and(
          eq(contractingContractBoqLinesTable.id, ref.entityId),
          eq(contractingContractBoqLinesTable.companyId, companyId),
        )).limit(1);
      return row?.branchId;
    }
    case "contracting_tenders":
    case "contracting_guarantees": {
      // These tables are introduced by the guarantees module in parallel with
      // this integration. Use their physical names here so this helper does
      // not require a premature schema-barrel change. Readiness is per active
      // tenant DB (see contracting-guarantees-storage).
      await ensureContractingGuaranteeTables();
      const tableName = ref.screenKey === "contracting_tenders"
        ? sql.raw("contracting_tenders")
        : sql.raw("contracting_guarantees");
      const result = await db.execute(sql`
        SELECT p.branch_id AS "branchId"
          FROM ${tableName} e
          JOIN contracting_projects p
            ON p.id = e.project_id AND p.company_id = e.company_id
         WHERE e.id = ${ref.entityId} AND e.company_id = ${companyId}
         LIMIT 1
      `);
      const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
      return rows[0]?.branchId;
    }
  }
}

export async function assertContractingArchiveAccess(
  req: Request,
  companyId: number,
  screenKey: string,
  docKey: string,
  action: ContractingArchiveAction,
): Promise<ContractingArchiveRef | null> {
  const ref = parseContractingArchiveRef(screenKey, docKey);
  if (!ref) return null;

  const permission: PermAction = action;
  if (!canAccessModule(req.authUser, "contracting", permission)) {
    throw new ContractingArchiveAccessError("ليست لديك صلاحية مستندات المقاولات", 403);
  }
  const branchId = await entityProjectBranch(companyId, ref);
  if (branchId === undefined) {
    throw new ContractingArchiveAccessError("مستند المقاولات غير موجود", 404);
  }
  if (!contractingBranchAllowed(req.authUser, branchId)) {
    throw new ContractingArchiveAccessError("ليس لديك صلاحية فرع المشروع", 403);
  }
  return ref;
}