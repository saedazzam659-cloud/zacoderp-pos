// Auto-generate the next entity code when the user leaves the code field
// blank on a master-data create form (items, units, groups, brands, ...).
//
// Strategy: scan the tenant's EXISTING codes, take the highest trailing
// numeric suffix, and continue the series as `<PREFIX>-<n+1>` zero-padded
// to 4 digits (e.g. ITM-0007). Works with user-typed codes too: "ITM-12",
// "12", "ABC12" all contribute their trailing number to the max. This is
// per-company by construction because callers pass company-scoped rows.
//
// NOTE: uniqueness stays enforced by the route's existing duplicate check
// (and any DB unique index) — the caller must run the generated code
// through the same dup check as a manual one to stay race-safe.
export function nextEntityCode(prefix: string, existingCodes: ReadonlyArray<string | null | undefined>): string {
  let max = 0;
  for (const c of existingCodes) {
    const m = String(c ?? "").trim().match(/(\d+)$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}
