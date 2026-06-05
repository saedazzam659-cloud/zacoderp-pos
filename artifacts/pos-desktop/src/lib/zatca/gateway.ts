// ZATCA gateway HTTP layer (Task #233, Option B).
//
// Builds the exact request shapes the ZATCA Fatoora gateway expects, then
// sends them through the Rust `zatca_https_post` proxy (the webview cannot
// reach the gateway directly: CORS + the host lock). Mirrors the cloud's
// `zatca-http-client.ts` base URLs, headers and endpoint paths so the
// standalone Windows app speaks the SAME protocol — without the Zacod cloud.

import { bytesToB64, utf8ToBytes } from "./crypto";
import { zatcaHttpsPost, type ZatcaEnvironment } from "./native";

/** Sandbox = developer-portal (compliance phase); production = core. */
export function zatcaBaseUrl(env: ZatcaEnvironment): string {
  return env === "production"
    ? "https://gw-fatoora.zatca.gov.sa/e-invoicing/core"
    : "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal";
}

export function basicAuth(username: string, password: string): string {
  return "Basic " + bytesToB64(utf8ToBytes(`${username}:${password}`));
}

export interface ZatcaJsonResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON body, or null when the body was empty / non-JSON. */
  json: Record<string, unknown> | null;
  raw: string;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  bodyObj: unknown,
): Promise<ZatcaJsonResponse> {
  const res = await zatcaHttpsPost(
    url,
    {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Language": "en",
      ...headers,
    },
    JSON.stringify(bodyObj),
  );
  let json: Record<string, unknown> | null = null;
  try {
    json = res.body ? (JSON.parse(res.body) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    json,
    raw: res.body,
  };
}

// ── CSID issuance (onboarding) ───────────────────────────────────────

export interface CsidResult {
  requestId: string;
  /** base64 of the issued certificate — used as the basic-auth username AND
   * as the signing certificate (PEM/bare-base64 accepted by the XAdES signer). */
  binarySecurityToken: string;
  secret: string;
}

function readCsid(json: Record<string, unknown> | null): CsidResult {
  const requestId = String(
    (json?.requestID ?? json?.requestId ?? json?.request_id ?? "") as unknown,
  );
  const binarySecurityToken = String((json?.binarySecurityToken ?? "") as unknown);
  const secret = String((json?.secret ?? "") as unknown);
  if (!binarySecurityToken || !secret) {
    throw new Error("استجابة زاتكا لا تحتوي على الشهادة أو السر (binarySecurityToken/secret)");
  }
  return { requestId, binarySecurityToken, secret };
}

/** Exchange the CSR + OTP for a COMPLIANCE CSID. */
export async function requestComplianceCsid(
  env: ZatcaEnvironment,
  otp: string,
  csrBase64: string,
): Promise<{ result: CsidResult; res: ZatcaJsonResponse }> {
  const res = await postJson(
    `${zatcaBaseUrl(env)}/compliance`,
    { OTP: otp, "Accept-Version": "V2" },
    { csr: csrBase64 },
  );
  if (!res.ok) {
    throw new Error(`فشل إصدار شهادة الامتثال (HTTP ${res.status}): ${res.raw || "بدون تفاصيل"}`);
  }
  return { result: readCsid(res.json), res };
}

/** Exchange the compliance CSID + request id for a PRODUCTION CSID. */
export async function requestProductionCsid(
  env: ZatcaEnvironment,
  complianceToken: string,
  complianceSecret: string,
  complianceRequestId: string,
): Promise<{ result: CsidResult; res: ZatcaJsonResponse }> {
  const res = await postJson(
    `${zatcaBaseUrl(env)}/production/csids`,
    {
      Authorization: basicAuth(complianceToken, complianceSecret),
      "Accept-Version": "V2",
    },
    { compliance_request_id: complianceRequestId },
  );
  if (!res.ok) {
    throw new Error(`فشل إصدار شهادة الإنتاج (HTTP ${res.status}): ${res.raw || "بدون تفاصيل"}`);
  }
  return { result: readCsid(res.json), res };
}

// ── Invoice submission ───────────────────────────────────────────────

export interface ZatcaSubmissionBody {
  invoiceHash: string;
  uuid: string;
  /** base64 of the signed UBL XML. */
  invoice: string;
}

export interface ZatcaSubmissionResult {
  status: number;
  ok: boolean;
  /** "REPORTED" / "CLEARED" / "NOT_REPORTED" / "NOT_CLEARED" / null. */
  zatcaStatus: string | null;
  warnings: unknown;
  raw: string;
}

function readSubmission(res: ZatcaJsonResponse): ZatcaSubmissionResult {
  const r = res.json ?? {};
  const reportingStatus =
    typeof r.reportingStatus === "string" ? r.reportingStatus : null;
  const clearanceStatus =
    typeof r.clearanceStatus === "string" ? r.clearanceStatus : null;
  return {
    status: res.status,
    ok: res.ok,
    zatcaStatus: clearanceStatus ?? reportingStatus,
    warnings: r.validationResults ?? r.warningMessages ?? null,
    raw: res.raw,
  };
}

/**
 * Submit one invoice. Simplified (B2C) → reporting; standard (B2B) → clearance
 * (which also requires `Clearance-Status: 1`). When `compliance` is true the
 * call goes to the `/compliance/invoices/...` endpoints used by the pre-CSID
 * compliance checks.
 */
export async function submitInvoice(opts: {
  env: ZatcaEnvironment;
  token: string;
  secret: string;
  flow: "simplified" | "standard";
  body: ZatcaSubmissionBody;
  compliance?: boolean;
}): Promise<ZatcaSubmissionResult> {
  const { env, token, secret, flow, body, compliance } = opts;
  const isClearance = flow === "standard";
  const segment = isClearance ? "clearance" : "reporting";
  const path = compliance
    ? `/compliance/invoices/${segment}/single`
    : `/invoices/${segment}/single`;
  const headers: Record<string, string> = {
    Authorization: basicAuth(token, secret),
    "Accept-Version": "V2",
  };
  if (isClearance) headers["Clearance-Status"] = "1";
  const res = await postJson(`${zatcaBaseUrl(env)}${path}`, headers, body);
  return readSubmission(res);
}
