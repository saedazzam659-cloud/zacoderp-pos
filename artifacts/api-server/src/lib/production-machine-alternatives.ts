type MachineStageLike = {
  machineResourceIds?: unknown;
  machineSelectionEnabled?: unknown;
  resourceId?: unknown;
};

function parseMachineId(value: unknown): number | null {
  if (value == null || String(value).trim() === "") return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Read explicit alternatives, while supporting legacy route rows that only
 * contain resourceId. Invalid IDs are rejected rather than silently dropped.
 */
export function normalizeMachineResourceIds(
  rawIds: unknown,
  legacyResourceId?: unknown,
): number[] {
  const suppliedIds = Array.isArray(rawIds) ? rawIds : [];
  const values = suppliedIds.length
    ? suppliedIds
    : legacyResourceId == null || String(legacyResourceId).trim() === ""
      ? []
      : [legacyResourceId];
  const parsed = values.map(parseMachineId);
  if (parsed.some((id) => id == null)) {
    throw new Error("قائمة آلات المرحلة تحتوي رقم آلة غير صالح");
  }
  return [...new Set(parsed as number[])];
}

export function normalizePrimaryMachineId(
  rawPrimaryId: unknown,
  machineResourceIds: number[],
): number | null {
  const primary = parseMachineId(rawPrimaryId);
  if (primary != null && machineResourceIds.includes(primary)) return primary;
  return machineResourceIds[0] ?? null;
}

/**
 * Preserve the legacy single-machine resourceId. For enabled alternatives,
 * the order stage starts unselected so the operator chooses the actual
 * machine before execution and its existing cost calculation uses that one.
 */
export function orderMachineStageSnapshot(stage: MachineStageLike): {
  machineResourceIds: number[];
  machineSelectionEnabled: boolean;
  resourceId: number | null;
} {
  const machineResourceIds = normalizeMachineResourceIds(
    stage.machineResourceIds,
    stage.resourceId,
  );
  const machineSelectionEnabled =
    stage.machineSelectionEnabled === true && machineResourceIds.length > 1;
  const primary = normalizePrimaryMachineId(stage.resourceId, machineResourceIds);
  return {
    machineResourceIds,
    machineSelectionEnabled,
    resourceId: machineSelectionEnabled ? null : primary,
  };
}
