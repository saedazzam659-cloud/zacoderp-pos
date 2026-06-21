/**
 * Shared ZATCA environment / gateway helpers + chain constants.
 *
 * Factored out of routes/zatca.ts so every real ZATCA submission path (the
 * onboarding routes, the live invoice submit, and the sales-invoice bridge)
 * resolves the gateway base URL and the genesis previous-invoice hash from ONE
 * source — preventing the bridge from drifting onto a different gateway or a
 * different genesis hash than the onboarding flow.
 */

import { X509Certificate } from "node:crypto";

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

// ─── CSID environment-mismatch detection ────────────────────────────────────
// The stored CSID/PCSID binarySecurityToken is base64-over-base64 of the DER
// certificate. Decode defensively (the inner value may already be DER, or itself
// be base64), then parse so we can read the issuer.
function parseCsidCert(token: string): X509Certificate | null {
  try {
    let buf = Buffer.from(token, "base64");
    // If it doesn't start with an ASN.1 SEQUENCE (0x30), the first decode yielded
    // the inner base64 string (the double-base64 wrapper) — decode once more.
    if (buf[0] !== 0x30) {
      buf = Buffer.from(buf.toString("utf8").trim(), "base64");
    }
    if (buf[0] !== 0x30) return null;
    return new X509Certificate(buf);
  } catch {
    return null;
  }
}

// Issuer CommonName of the stored CSID/PCSID certificate, or null if unparseable.
export function getCsidCertIssuerCN(token: string | null | undefined): string | null {
  if (!token) return null;
  const cert = parseCsidCert(token);
  if (!cert) return null;
  const m = /CN=([^,\n]+)/.exec(cert.issuer);
  return m ? m[1].trim() : null;
}

/**
 * ZATCA's developer-portal (sandbox) CA issues compliance certificates with the
 * bare issuer `CN=eInvoicing`. The simulation and production gateways issue from
 * the real ZATCA PKI (never the bare `eInvoicing`). So a stored CSID whose issuer
 * is `eInvoicing` while the company is linked to simulation/production is a
 * cross-environment mismatch — the live gateway rejects it with an opaque 401.
 * Returns an actionable Arabic message in that case, else null.
 */
export function csidEnvMismatchMessage(
  token: string | null | undefined,
  env: ZatcaEnv,
): string | null {
  if (!token || env === "sandbox") return null;
  if (getCsidCertIssuerCN(token) === "eInvoicing") {
    return `الشهادة المخزَّنة صادرة من البيئة التجريبية (Sandbox) بينما وضع الربط الحالي هو «${envArabic[env]}». بوابة ${envArabic[env]} ترفض هذه الشهادة (401 غير مُصرَّح). أعد استخراج شهادة الامتثال (CSID) من بوابة ${envArabic[env]} باستخدام رمز OTP جديد من بوابة فاتورة، ثم أعد المحاولة.`;
  }
  return null;
}
