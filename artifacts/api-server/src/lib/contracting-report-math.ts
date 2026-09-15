export type ReportOwnerContract = {
  id: number;
  projectId: number;
  contractType: string;
  parentContractId: number | null;
  status: string;
  value: string | number;
};

const CERTIFIED_REPORT_BILL_STATUSES = new Set([
  "approved", "posted", "partially_paid", "paid",
]);

export function reportBillIsCertified(
  status: string,
  reversalJournalEntryId?: number | string | null,
): boolean {
  return CERTIFIED_REPORT_BILL_STATUSES.has(status) && reversalJournalEntryId == null;
}

export function reportOwnerContractScope(
  contracts: readonly ReportOwnerContract[],
  selectedContractId: number | null | undefined,
  projectContractValue: number,
) {
  const byId = new Map(contracts.map((contract) => [contract.id, contract] as const));
  const selected = selectedContractId == null ? undefined : byId.get(selectedContractId);
  const base = selected
    && ["change_order", "addendum"].includes(selected.contractType)
    && selected.parentContractId != null
    ? byId.get(selected.parentContractId) ?? selected
    : selected ?? contracts.find((contract) => contract.contractType === "main");
  const baseContractId = base?.id ?? selectedContractId ?? null;
  const legacyBaseContractId = contracts.find((contract) => contract.contractType === "main")?.id
    ?? baseContractId;
  const baseValue = Number(base?.value ?? selected?.value ?? projectContractValue ?? 0);
  const approvedChildChangeOrders = contracts
    .filter((contract) =>
      (contract.contractType === "change_order" || contract.contractType === "addendum")
      && contract.status === "approved"
      && (
        contract.parentContractId === baseContractId
        // Older child rows did not carry a parent link. Scope those legacy
        // rows to the project's primary base only, exactly once.
        || (contract.parentContractId == null && baseContractId === legacyBaseContractId)
      ),
    )
    .reduce((total, contract) => total + Number(contract.value), 0);
  return {
    baseContractId,
    value: baseValue + approvedChildChangeOrders,
  };
}