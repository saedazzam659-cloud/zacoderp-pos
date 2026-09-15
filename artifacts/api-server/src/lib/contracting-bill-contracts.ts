import {
  and,
  eq,
} from "drizzle-orm";
import {
  contractingContractorsTable,
  contractingOwnerContractsTable,
  contractingSubContractsTable,
} from "@workspace/db";

type BillContractScope = {
  projectId: number;
  direction: string;
  contractorId?: number | string | null;
  ownerContractId?: number | string | null;
  subcontractorContractId?: number | string | null;
};

type ScopeOptions = {
  /**
   * Drafts imported before contract links existed are still editable.  They
   * are deliberately not postable: callers validating a posting must leave
   * this enabled.
   */
  requireSelection?: boolean;
  /**
   * Standalone subcontractor advance settlements do not carry a contractorId
   * in their payload.  The subcontract itself still has to belong to the
   * company/project; bill approval always keeps this enabled.
   */
  requireIncomingContractor?: boolean;
};

function failure(message: string, status = 422): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function optionalId(value: unknown, label: string): number | null {
  if (value == null || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw failure(`${label} غير صالح`);
  return id;
}

/**
 * Validate the complete bill-to-contract relationship.
 *
 * A foreign-key check alone is insufficient here: all three links are
 * nullable for legacy rows and PostgreSQL does not enforce that a contract
 * belongs to the bill's project/company or that a subcontract's contractor
 * equals the bill contractor.  Keep this helper usable with both db and a
 * transaction executor so create/edit and accounting posting share exactly
 * the same rules.
 */
export async function assertBillContractScope(
  tx: any,
  companyId: number,
  bill: BillContractScope,
  options: ScopeOptions = {},
) {
  const requireSelection = options.requireSelection !== false;
  const requireIncomingContractor = options.requireIncomingContractor !== false;
  const ownerContractId = optionalId(bill.ownerContractId, "عقد المالك");
  const subcontractorContractId = optionalId(bill.subcontractorContractId, "عقد الباطن");
  const contractorId = optionalId(bill.contractorId, "المقاول الباطن");

  if (bill.direction !== "outgoing" && bill.direction !== "incoming") {
    throw failure("اتجاه المستخلص غير صالح");
  }

  if (bill.direction === "outgoing") {
    if (subcontractorContractId != null || contractorId != null) {
      throw failure("مستخلصات المالك لا تقبل عقد أو مقاول باطن");
    }
    if (ownerContractId == null) {
      if (requireSelection) throw failure("يجب تحديد عقد المالك قبل اعتماد المستخلص");
      return { ownerContractId: null, subcontractorContractId: null, contractorId: null };
    }
    const [contract] = await tx.select({
      id: contractingOwnerContractsTable.id,
      projectId: contractingOwnerContractsTable.projectId,
    }).from(contractingOwnerContractsTable).where(and(
      eq(contractingOwnerContractsTable.id, ownerContractId),
      eq(contractingOwnerContractsTable.companyId, companyId),
      eq(contractingOwnerContractsTable.projectId, bill.projectId),
    ));
    if (!contract) {
      throw failure("عقد المالك لا يتبع نفس الشركة والمشروع");
    }
    return { ownerContractId, subcontractorContractId: null, contractorId: null, contract };
  }

  if (ownerContractId != null) {
    throw failure("مستخلصات الباطن لا تقبل عقد المالك");
  }
  if (subcontractorContractId == null) {
    if (requireSelection) throw failure("يجب تحديد عقد المقاول الباطن قبل اعتماد المستخلص");
    return { ownerContractId: null, subcontractorContractId: null, contractorId };
  }
  const [contract] = await tx.select({
    id: contractingSubContractsTable.id,
    projectId: contractingSubContractsTable.projectId,
    contractorId: contractingSubContractsTable.contractorId,
  }).from(contractingSubContractsTable).where(and(
    eq(contractingSubContractsTable.id, subcontractorContractId),
    eq(contractingSubContractsTable.companyId, companyId),
    eq(contractingSubContractsTable.projectId, bill.projectId),
  ));
  if (!contract) {
    throw failure("عقد الباطن لا يتبع نفس الشركة والمشروع");
  }
  if (requireIncomingContractor && contractorId == null) {
    throw failure("يجب تحديد المقاول الباطن مع عقده");
  }
  if (contractorId != null && Number(contract.contractorId) !== contractorId) {
    throw failure("المقاول الباطن لا يطابق المقاول المرتبط بالعقد المحدد");
  }
  const [contractor] = await tx.select({
    id: contractingContractorsTable.id,
  }).from(contractingContractorsTable).where(and(
    eq(contractingContractorsTable.id, contract.contractorId),
    eq(contractingContractorsTable.companyId, companyId),
  ));
  if (!contractor) throw failure("المقاول المرتبط بعقد الباطن لا يتبع نفس الشركة");
  return { ownerContractId: null, subcontractorContractId, contractorId: contractorId ?? Number(contract.contractorId), contract };
}