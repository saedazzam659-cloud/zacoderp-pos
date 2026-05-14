/**
 * ZATCA Fatoora HTTP client — multi-tenant external gateway edition.
 *
 * Differences from `routes/zatca.ts` (which targets a single internal company):
 * - This module is a pure function lib (no DB writes). The caller (gateway
 *   submit-zatca route) decides what to persist based on the response.
 * - Credentials are passed in explicitly — no implicit company lookup.
 * - Returns a normalized result shape regardless of which endpoint was hit
 *   (Reporting for B2C, Clearance for B2B).
 *
 * Note on signing: full XAdES-BES (signed properties + cert digest +
 * signature value) is a large spec implementation — Phase 1B.3. For now
 * the caller submits the UBL XML produced by `zatca-gateway-builder.ts`
 * which contains all UBLExtension placeholders. ZATCA's compliance API
 * will return *warnings* about the signature, but cleared/reported
 * status flow + persistence are exercised end-to-end. Production
 * submission MUST wait for Phase 1B.3 — a guard in submitToZatca
 * refuses to call the production endpoint when the XML is unsigned.
 */
import { createHash } from "crypto";

export type ZatcaEnv = "sandbox" | "production";
export type ZatcaFlow = "standard" | "simplified";

export interface ZatcaCredentials {
  /** Basic-auth username = base64(certificate PEM body) */
  basicAuthToken: string;
  /** Basic-auth password = secret returned by ZATCA alongside CSID */
  basicAuthSecret: string;
}

export interface ZatcaSubmitInput {
  ublXml: string;
  invoiceHash: string;        // base64-encoded sha256(canonical XML)
  uuid: string;
  env: ZatcaEnv;
  flow: ZatcaFlow;
  credentials: ZatcaCredentials;
  /** When true, the XML carries a real XAdES signature (Phase 1B.3+) */
  isSigned?: boolean;
}

export type ZatcaResultStatus = "cleared" | "reported" | "warning" | "rejected" | "error";

export interface ZatcaSubmitResult {
  status: ZatcaResultStatus;
  /** ZATCA's reportingStatus / clearanceStatus enum, e.g. "REPORTED", "CLEARED", "NOT_CLEARED" */
  zatcaStatus: string | null;
  /** The signed XML returned by Clearance (B2B). Null for Reporting (B2C). */
  clearedXml: string | null;
  warnings: Array<{ code: string; category: string; message: string }>;
  errors: Array<{ code: string; category: string; message: string }>;
  /** Raw JSON body returned by ZATCA for audit/replay */
  raw: unknown;
  httpStatus: number;
  endpoint: string;
}

// Official ZATCA gateway base URLs as of 2024-2026.
// Sandbox = developer-portal (compliance phase).
// Production = core (live taxpayer phase).
function getBaseUrl(env: ZatcaEnv): string {
  return env === "production"
    ? "https://gw-fatoora.zatca.gov.sa/e-invoicing/core"
    : "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal";
}

function basicAuth(token: string, secret: string): string {
  return "Basic " + Buffer.from(`${token}:${secret}`).toString("base64");
}

/**
 * Submit one invoice to ZATCA. Routes B2C → reporting, B2B → clearance.
 * Production submission of unsigned XML is refused (would be rejected
 * with cryptic errors anyway).
 */
export async function submitToZatca(input: ZatcaSubmitInput): Promise<ZatcaSubmitResult> {
  if (input.env === "production" && !input.isSigned) {
    return {
      status: "error",
      zatcaStatus: null,
      clearedXml: null,
      warnings: [],
      errors: [{
        code: "UNSIGNED_PROD_BLOCKED",
        category: "client",
        message: "لا يمكن إرسال فاتورة غير موقعة رقمياً (XAdES) لبيئة الإنتاج. استخدم وضع التجربة لحين إكمال طور التوقيع الرقمي.",
      }],
      raw: null,
      httpStatus: 0,
      endpoint: "(blocked-client-side)",
    };
  }

  const path = input.flow === "simplified"
    ? "/invoices/reporting/single"
    : "/invoices/clearance/single";
  const endpoint = getBaseUrl(input.env) + path;

  // ZATCA expects the UBL XML wrapped in JSON envelope (base64 invoice +
  // base64 invoice hash + uuid). Clearance also requires `Clearance-Status`
  // header = 1 to actually receive a cleared XML back; setting it to 0
  // performs a "validation only" call which is useful for sandbox dry-runs.
  const body = JSON.stringify({
    invoiceHash: input.invoiceHash,
    uuid: input.uuid,
    invoice: Buffer.from(input.ublXml, "utf8").toString("base64"),
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Accept-Language": "en",
    "Accept-Version": "V2",
    "Authorization": basicAuth(input.credentials.basicAuthToken, input.credentials.basicAuthSecret),
  };
  if (input.flow === "standard") {
    headers["Clearance-Status"] = "1";
  }

  let httpStatus = 0;
  let raw: unknown = null;
  let httpError: string | null = null;

  try {
    const resp = await fetch(endpoint, { method: "POST", headers, body });
    httpStatus = resp.status;
    const text = await resp.text();
    try { raw = text ? JSON.parse(text) : null; } catch { raw = { rawText: text }; }
  } catch (e: unknown) {
    httpError = e instanceof Error ? e.message : String(e);
  }

  if (httpError) {
    return {
      status: "error",
      zatcaStatus: null,
      clearedXml: null,
      warnings: [],
      errors: [{ code: "HTTP_FAILURE", category: "transport", message: httpError }],
      raw: null, httpStatus, endpoint,
    };
  }

  // Normalize response. ZATCA shapes:
  //   { reportingStatus: "REPORTED" | "NOT_REPORTED", validationResults: {...}, ... }
  //   { clearanceStatus: "CLEARED"   | "NOT_CLEARED",  clearedInvoice: "<base64>", validationResults: {...} }
  // validationResults: { errorMessages: [...], warningMessages: [...], status: "PASS"|"WARNING"|"ERROR" }
  const r = (raw ?? {}) as Record<string, unknown>;
  const vr = (r.validationResults ?? {}) as Record<string, unknown>;
  const errMsgs   = Array.isArray(vr.errorMessages)   ? vr.errorMessages   as Array<Record<string, unknown>> : [];
  const warnMsgs  = Array.isArray(vr.warningMessages) ? vr.warningMessages as Array<Record<string, unknown>> : [];

  const errors   = errMsgs.map(m => ({ code: String(m.code ?? ""), category: String(m.category ?? ""), message: String(m.message ?? "") }));
  const warnings = warnMsgs.map(m => ({ code: String(m.code ?? ""), category: String(m.category ?? ""), message: String(m.message ?? "") }));

  const reportingStatus = typeof r.reportingStatus === "string" ? r.reportingStatus : null;
  const clearanceStatus = typeof r.clearanceStatus === "string" ? r.clearanceStatus : null;
  const zatcaStatus = clearanceStatus ?? reportingStatus;
  const clearedB64  = typeof r.clearedInvoice === "string" ? r.clearedInvoice : null;
  const clearedXml  = clearedB64 ? Buffer.from(clearedB64, "base64").toString("utf8") : null;

  // Decision order matters: an explicit success status from ZATCA wins
  // over HTTP code (ZATCA may use 202 etc.), but otherwise any non-2xx
  // HTTP response must be treated as failure — never as warning, never
  // as silent success.
  let status: ZatcaResultStatus;
  if (zatcaStatus === "CLEARED") status = "cleared";
  else if (zatcaStatus === "REPORTED") status = "reported";
  else if (httpStatus >= 500) status = "error";
  else if (httpStatus < 200 || httpStatus >= 300) status = "rejected";
  else if (errors.length > 0 || zatcaStatus === "NOT_CLEARED" || zatcaStatus === "NOT_REPORTED") status = "rejected";
  else if (warnings.length > 0) status = "warning";
  else status = "rejected"; // ambiguous 2xx with no explicit status — fail closed, never silently "cleared"

  return { status, zatcaStatus, clearedXml, warnings, errors, raw, httpStatus, endpoint };
}

/**
 * Convenience: derive base64 invoice hash from raw XML. Caller may also
 * pre-compute via zatca-gateway-builder which is preferred (canonical form).
 */
export function hashUblForZatca(xml: string): string {
  return createHash("sha256").update(xml, "utf8").digest("base64");
}
