const MAX_POOL_SIZE = 100;

export function parseAgentDbPoolOverrides(value: string | undefined): Map<number, number> {
  const overrides = new Map<number, number>();
  for (const entry of value?.split(",") ?? []) {
    const match = entry.trim().match(/^([1-9]\d*)\s*=\s*([1-9]\d*)$/);
    if (!match) continue;
    const agentId = Number(match[1]);
    const max = Number(match[2]);
    if (!Number.isSafeInteger(agentId) || !Number.isSafeInteger(max) || max > MAX_POOL_SIZE) continue;
    overrides.set(agentId, max);
  }
  return overrides;
}

export function agentDbPoolMax(
  agentId: number,
  defaultMax: number,
  overrides: ReadonlyMap<number, number>,
): number {
  return overrides.get(agentId) ?? defaultMax;
}
