export function calculateWeightedPercentage(
  weights: Record<string, number>,
  componentPercentages: Record<string, number | null | undefined>,
): { complete: boolean; percentage: number | null; missing: string[] } {
  const entries = Object.entries(weights).filter(([, weight]) => Number(weight) > 0);
  const missing = entries.filter(([key]) => componentPercentages[key] == null).map(([key]) => key);
  if (!entries.length || missing.length) return { complete: false, percentage: null, missing };
  const total = entries.reduce((sum, [key, weight]) => {
    return sum + Number(componentPercentages[key] ?? 0) * Number(weight);
  }, 0);
  return { complete: true, percentage: Math.round(total) / 100, missing: [] };
}

export function gradeLabel(
  percent: number,
  bands: Array<{ minimumPercent: number; label: string }>,
): string {
  const sorted = [...bands].sort((a, b) => b.minimumPercent - a.minimumPercent);
  return sorted.find((band) => percent >= Number(band.minimumPercent))?.label ?? "غير محدد";
}

export function resultStatus(
  percent: number,
  passMark: number,
  secondRound: number,
): "pass" | "fail" | "second_round" {
  if (percent >= passMark) return "pass";
  return secondRound > 0 && percent >= secondRound ? "second_round" : "fail";
}

export function validateWeights(weights: unknown, allowed: Set<string>): weights is Record<string, number> {
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) return false;
  const entries = Object.entries(weights as Record<string, unknown>);
  if (!entries.length) return false;
  if (entries.some(([key, value]) => !allowed.has(key)
    || typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > 100)) return false;
  return Math.abs(entries.reduce((total, [, value]) => total + Number(value), 0) - 100) < 0.01;
}
