// ZATCA onboarding orchestration (Task #233, Option B).
//
// Walks the device through the standalone EGS onboarding ladder WITHOUT the
// Zacod cloud:
//   1. generateOnboardingCsr  — keypair + CSR, private key → keyring.
//   2. exchangeComplianceCsid — CSR + OTP → compliance CSID.
//   3. runComplianceCheck     — sign + submit a sample invoice (ZATCA requires
//                               this before issuing a production CSID).
//   4. exchangeProductionCsid — compliance CSID → production CSID.
//
// Each step persists its outcome into the local `zatca_onboarding` singleton so
// onboarding survives restarts and a partial flow can be resumed.

import { bytesToHex } from "./crypto";
import { buildZatcaCsr, csrPemToBase64, type ZatcaCsrParams } from "./csr";
import { requestComplianceCsid, requestProductionCsid } from "./gateway";
import {
  zatcaSaveSecret,
  zatcaSaveOnboarding,
  zatcaGetOnboarding,
  zatcaLoadSecret,
  type ZatcaEnvironment,
  type ZatcaOnboardingState,
} from "./native";
import {
  buildAndSignInvoice,
  submitSigned,
  loadActiveCredentials,
  type BuildInvoiceInput,
} from "./submit";

export interface OnboardingOrg {
  /** Company legal/trading name (CSR CN + organizationName). */
  organizationName: string;
  /** Branch / unit name. */
  organizationUnit: string;
  vatNumber: string;
  /** EGS serial — "1-<solution>|2-<model>|3-<serial>" form recommended. */
  serialNumber: string;
  /** "simplified" | "standard" | "both". */
  invoiceType: string;
  /** Common name for the CSR (defaults to organizationName). */
  commonName?: string;
}

function csidJson(token: string, secret: string): string {
  return JSON.stringify({ token, secret });
}

/**
 * Step 1 — generate the secp256k1 keypair + ZATCA EGS CSR. The private key is
 * stored in the OS keyring (slot "privkey"); the CSR PEM + org snapshot + the
 * chosen environment are persisted to the onboarding row.
 */
export async function generateOnboardingCsr(
  org: OnboardingOrg,
  env: ZatcaEnvironment,
): Promise<{ csrPem: string }> {
  const params: ZatcaCsrParams = {
    commonName: org.commonName?.trim() || org.organizationName,
    organizationName: org.organizationName,
    organizationUnit: org.organizationUnit,
    serialNumber: org.serialNumber,
    vatNumber: org.vatNumber,
    invoiceType: org.invoiceType,
    isSandbox: env !== "production",
  };
  const { csrPem, keyPair } = buildZatcaCsr(params);
  await zatcaSaveSecret("privkey", bytesToHex(keyPair.privateKey));
  await zatcaSaveOnboarding({
    environment: env,
    status: "csr",
    csrPem,
    orgJson: JSON.stringify(org),
    // A fresh CSR invalidates any prior CSIDs.
    complianceRequestId: null,
    productionRequestId: null,
    lastError: null,
  });
  // Clear stale certs tied to a previous key.
  await zatcaSaveSecret("compliance", "").catch(() => undefined);
  await zatcaSaveSecret("production", "").catch(() => undefined);
  return { csrPem };
}

/**
 * Step 2 — exchange the stored CSR + a freshly-issued OTP for a COMPLIANCE
 * CSID. The cert/secret go to keyring slot "compliance".
 */
export async function exchangeComplianceCsid(otp: string): Promise<void> {
  const onb = await zatcaGetOnboarding();
  if (!onb.csrPem) throw new Error("لا يوجد طلب توقيع شهادة (CSR) — أنشئ المفتاح أولاً.");
  try {
    const { result } = await requestComplianceCsid(
      onb.environment,
      otp.trim(),
      csrPemToBase64(onb.csrPem),
    );
    await zatcaSaveSecret("compliance", csidJson(result.binarySecurityToken, result.secret));
    await zatcaSaveOnboarding({
      status: "compliance",
      complianceRequestId: result.requestId,
      lastError: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await zatcaSaveOnboarding({ lastError: msg });
    throw e;
  }
}

/**
 * Step 4 — exchange the compliance CSID for a PRODUCTION CSID. Run AFTER the
 * compliance checks pass. The production cert/secret go to slot "production".
 */
export async function exchangeProductionCsid(): Promise<void> {
  const onb = await zatcaGetOnboarding();
  if (!onb.complianceRequestId) throw new Error("لا يوجد معرّف طلب امتثال — أكمل خطوة شهادة الامتثال أولاً.");
  const raw = await zatcaLoadSecret("compliance");
  let comp: { token: string; secret: string } | null = null;
  try {
    const o = raw ? (JSON.parse(raw) as { token?: string; secret?: string }) : null;
    if (o?.token && o?.secret) comp = { token: o.token, secret: o.secret };
  } catch {
    /* ignore */
  }
  if (!comp) throw new Error("شهادة الامتثال غير متوفرة — أعد خطوة الامتثال.");
  try {
    const { result } = await requestProductionCsid(
      onb.environment,
      comp.token,
      comp.secret,
      onb.complianceRequestId,
    );
    await zatcaSaveSecret("production", csidJson(result.binarySecurityToken, result.secret));
    await zatcaSaveOnboarding({
      status: "production",
      productionRequestId: result.requestId,
      lastError: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await zatcaSaveOnboarding({ lastError: msg });
    throw e;
  }
}

/**
 * Step 3 — sign + submit a SAMPLE invoice against the compliance endpoints to
 * satisfy ZATCA's pre-production compliance checks. Uses the compliance CSID
 * and a minimal one-line invoice built from the supplied seller details.
 */
export async function runComplianceCheck(sample: BuildInvoiceInput): Promise<{
  zatcaStatus: string | null;
  ok: boolean;
}> {
  const creds = await loadActiveCredentials();
  const signed = await buildAndSignInvoice(creds, sample);
  const outcome = await submitSigned(creds, signed, { compliance: true });
  return { zatcaStatus: outcome.zatcaStatus, ok: outcome.status === "submitted" };
}

/** Convenience re-export so the UI imports onboarding state from one place. */
export type { ZatcaOnboardingState };
export { zatcaGetOnboarding };
