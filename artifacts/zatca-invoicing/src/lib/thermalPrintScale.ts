export const THERMAL_PRINT_SCALE_MIN = 85;
export const THERMAL_PRINT_SCALE_MAX = 100;

export function clampThermalPrintScale(value: number): number {
  return Math.min(THERMAL_PRINT_SCALE_MAX, Math.max(THERMAL_PRINT_SCALE_MIN, Math.round(value)));
}

function storageKey(companyId: unknown, templateId: number): string | null {
  if (companyId == null || companyId === "") return null;
  return `zatca:thermal-print-scale:${String(companyId)}:${templateId}`;
}

export function readThermalPrintScale(companyId: unknown, templateId: number): number {
  const key = storageKey(companyId, templateId);
  if (!key || typeof window === "undefined") return THERMAL_PRINT_SCALE_MAX;
  try {
    const saved = Number(window.localStorage.getItem(key));
    return Number.isFinite(saved) && saved >= THERMAL_PRINT_SCALE_MIN && saved <= THERMAL_PRINT_SCALE_MAX
      ? saved
      : THERMAL_PRINT_SCALE_MAX;
  } catch {
    return THERMAL_PRINT_SCALE_MAX;
  }
}

export function saveThermalPrintScale(companyId: unknown, templateId: number, value: number): number {
  const scale = clampThermalPrintScale(value);
  const key = storageKey(companyId, templateId);
  if (!key || typeof window === "undefined") return scale;
  try {
    window.localStorage.setItem(key, String(scale));
  } catch {
    // Keep the in-memory adjustment usable if browser storage is unavailable.
  }
  return scale;
}
