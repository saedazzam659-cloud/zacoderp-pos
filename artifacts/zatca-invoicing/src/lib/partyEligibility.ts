/** Limit only picker choices; a persisted selection remains selectable on edit. */
export type PartyRole = "sales" | "purchase" | "projectOwner" | "subcontractor";
type ClassifiedParty = { id: number; partyClassification?: string | null };

const allowed: Record<PartyRole, readonly string[]> = {
  sales: ["customer", "both"],
  purchase: ["supplier", "both"],
  projectOwner: ["project_owner", "both"],
  subcontractor: ["subcontractor", "both"],
};

// Legacy null/missing classifications retain the original customer/supplier
// role, not every new role. Historical selected IDs are handled separately.
const legacyRole: Record<PartyRole, boolean> = {
  sales: true,
  purchase: true,
  projectOwner: false,
  subcontractor: false,
};

export function eligibleParties<T extends ClassifiedParty>(
  parties: readonly T[],
  role: PartyRole,
  selectedId?: string | number | null,
): T[] {
  const selected = selectedId == null ? "" : String(selectedId);
  const seen = new Set<number>();
  return parties.filter(party => {
    if (seen.has(party.id)) return false;
    seen.add(party.id);
    return String(party.id) === selected ||
      (party.partyClassification == null && legacyRole[role]) ||
      (party.partyClassification != null && allowed[role].includes(party.partyClassification));
  });
}

/** Contractor IDs remain distinct from supplier IDs; classify using their linked supplier. */
export function eligibleContractors<T extends { id: number; supplierPartyClassification?: string | null }>(
  contractors: readonly T[],
  selectedId?: string | number | null,
): T[] {
  return eligibleParties(
    contractors.map(contractor => ({ contractor, id: contractor.id, partyClassification: contractor.supplierPartyClassification })),
    "subcontractor",
    selectedId,
  ).map(({ contractor }) => contractor);
}

/** Search results may omit a historical selection; keep its ID without inventing a party. */
export function withHistoricalParty<T extends { value: string; label: string }>(
  items: T[],
  selectedId: string | number | null | undefined,
  fallbackLabel: string,
): T[] {
  const id = selectedId == null ? "" : String(selectedId);
  return id && !items.some(item => item.value === id)
    ? [{ value: id, label: fallbackLabel } as T, ...items]
    : items;
}