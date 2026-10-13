export const THERMAL_PRINT_BOLD_MIN = 0;
export const THERMAL_PRINT_BOLD_MAX = 10;

export function clampThermalPrintBold(value: number): number {
  return Math.min(THERMAL_PRINT_BOLD_MAX, Math.max(THERMAL_PRINT_BOLD_MIN, Math.round(value)));
}

function storageKey(companyId: unknown, templateId: number): string | null {
  if (companyId == null || companyId === "") return null;
  return `zatca:thermal-print-bold:${String(companyId)}:${templateId}`;
}

export function readThermalPrintBold(companyId: unknown, templateId: number): number {
  const key = storageKey(companyId, templateId);
  if (!key || typeof window === "undefined") return THERMAL_PRINT_BOLD_MIN;
  try {
    const saved = Number(window.localStorage.getItem(key));
    return Number.isFinite(saved) && saved >= THERMAL_PRINT_BOLD_MIN && saved <= THERMAL_PRINT_BOLD_MAX
      ? saved
      : THERMAL_PRINT_BOLD_MIN;
  } catch {
    return THERMAL_PRINT_BOLD_MIN;
  }
}

export function saveThermalPrintBold(companyId: unknown, templateId: number, value: number): number {
  const boldness = clampThermalPrintBold(value);
  const key = storageKey(companyId, templateId);
  if (!key || typeof window === "undefined") return boldness;
  try {
    window.localStorage.setItem(key, String(boldness));
  } catch {
    // Keep the in-memory adjustment usable if browser storage is unavailable.
  }
  return boldness;
}

export function applyThermalPrintBold(html: string, value: number): string {
  const boldness = clampThermalPrintBold(value);
  if (boldness === THERMAL_PRINT_BOLD_MIN) return html;

  // A small text stroke adds gradual weight even when the selected font only
  // provides regular/bold faces. The 0 setting leaves the template untouched.
  const strokeWidth = (boldness * 0.06).toFixed(2);
  const style = `<style id="thermal-print-bold">@media print { body * { -webkit-text-stroke: ${strokeWidth}px currentColor !important; } }</style>`;
  return /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${style}</head>`)
    : html.replace(/<body/i, `${style}<body`);
}
