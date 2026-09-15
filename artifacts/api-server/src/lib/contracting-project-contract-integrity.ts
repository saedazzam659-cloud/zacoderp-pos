import { db } from "@workspace/db";
import { assertBillContractScope } from "./contracting-bill-contracts.js";

export type BillDirection = "incoming" | "outgoing";

export type ProjectContractSelection = {
  companyId: number;
  projectId: number;
  direction: BillDirection;
  contractorId?: number | null;
  ownerContractId?: number | null;
  subcontractorContractId?: number | null;
  /**
   * Rows imported before contract links existed may be edited for non-financial
   * fields without inventing a link. Posting still calls this helper without
   * this escape hatch.
   */
  allowLegacyUnlinked?: boolean;
};

/**
 * Contract links are project-owned dimensions.  Keep the check in one helper
 * so every bill mutation validates both the tenant/project boundary and the
 * incoming contractor ↔ subcontract relationship.
 */
export async function ensureProjectContractSelection(
  selection: ProjectContractSelection,
): Promise<string | null> {
  try {
    await assertBillContractScope(db, selection.companyId, selection, {
      requireSelection: !selection.allowLegacyUnlinked,
    });
    return null;
  } catch (error: any) {
    return error?.message ?? "روابط العقود غير صالحة";
  }
}