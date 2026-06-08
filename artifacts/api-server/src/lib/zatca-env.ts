/**
 * Shared ZATCA environment / gateway helpers + chain constants.
 *
 * Factored out of routes/zatca.ts so every real ZATCA submission path (the
 * onboarding routes, the live invoice submit, and the sales-invoice bridge)
 * resolves the gateway base URL and the genesis previous-invoice hash from ONE
 * source — preventing the bridge from drifting onto a different gateway or a
 * different genesis hash than the onboarding flow.
 */

// ZATCA hosts three SELF-CONTAINED environments (developer-portal / simulation /
// core-production). ALL of them host the full onboarding chain.
export type ZatcaEnv = "sandbox" | "simulation" | "production";

export function getZatcaBaseUrl(env: ZatcaEnv): string {
  switch (env) {
    case "production":
      return "https://gw-fatoora.zatca.gov.sa/e-invoicing/core";
    case "simulation":
      return "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation";
    case "sandbox":
    default:
      return "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal";
  }
}

// Resolve the active environment for a company. The explicit `zatcaEnvironment`
// column wins; fall back to the legacy `isSandbox` boolean for rows predating it.
export function resolveZatcaEnv(company: { zatcaEnvironment?: string | null; isSandbox?: boolean | null }): ZatcaEnv {
  const e = company.zatcaEnvironment;
  if (e === "sandbox" || e === "simulation" || e === "production") return e;
  return (company.isSandbox ?? true) ? "sandbox" : "production";
}

export const envArabic: Record<ZatcaEnv, string> = {
  sandbox: "تجريبي",
  simulation: "محاكاة",
  production: "إنتاج",
};

// ZATCA genesis PIH — base64 of the SHA-256 hex digest of "0", used as the
// previous-invoice hash for the first document in a chain.
export const GENESIS_HASH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZmNTI5OWIxNmI2ZjRiMmUyNjY5MDkwMzBiMzdhZGZiMzU3NGI0OTJiNA==";
