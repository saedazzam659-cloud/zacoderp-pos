import { JournalScanArchive } from "@/components/JournalScanArchive";

export type ContractingArchiveEntityType =
  | "project"
  | "ownerContract"
  | "subcontract"
  | "boqLine"
  | "workItem"
  | "tender"
  | "guarantee";

export interface ContractingArchiveActionProps {
  entityType: ContractingArchiveEntityType;
  entityId: number;
  companyName?: string | null;
  className?: string;
  readOnly?: boolean;
}

const ENTITY_ARCHIVE_KEYS: Record<
  ContractingArchiveEntityType,
  { screenKey: string; docPrefix: string }
> = {
  project: { screenKey: "contracting_projects", docPrefix: "project" },
  ownerContract: { screenKey: "contracting_owner_contracts", docPrefix: "owner-contract" },
  subcontract: { screenKey: "contracting_subcontracts", docPrefix: "subcontract" },
  boqLine: { screenKey: "contracting_boq_lines", docPrefix: "boq-line" },
  workItem: { screenKey: "contracting_work_items", docPrefix: "work-item" },
  tender: { screenKey: "contracting_tenders", docPrefix: "tender" },
  guarantee: { screenKey: "contracting_guarantees", docPrefix: "guarantee" },
};

/**
 * Thin contracting adapter for the established archive UI. Storage, upload,
 * preview, download, local mode, and deletion remain owned by
 * JournalScanArchive; this component only emits canonical entity-bound keys.
 */
export function ContractingArchiveAction({
  entityType,
  entityId,
  companyName,
  className,
  readOnly = false,
}: ContractingArchiveActionProps) {
  if (!Number.isSafeInteger(entityId) || entityId <= 0) return null;
  const entity = ENTITY_ARCHIVE_KEYS[entityType];
  return (
    <JournalScanArchive
      jeKey={`${entity.docPrefix}:${entityId}`}
      screenKey={entity.screenKey}
      companyName={companyName}
      className={className}
      readOnly={readOnly}
    />
  );
}