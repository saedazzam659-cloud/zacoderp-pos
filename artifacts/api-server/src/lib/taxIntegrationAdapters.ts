/**
 * Provider protocol primitives. They deliberately require an injected
 * transport so tests never open sockets and route handlers can enforce
 * tenant/environment policy before making any provider request.
 */
import { serializeEtaJsonWire } from "./eta-cades-bes.js";

export type TaxEnvironment = "sandbox" | "production";

export interface TaxProviderRequest {
  url: string;
  method: "POST" | "HEAD";
  headers: Record<string, string>;
  body?: string;
}

export interface TaxProviderResponse {
  status: number;
  body: unknown;
}

export type TaxProviderTransport = (
  request: TaxProviderRequest,
) => Promise<TaxProviderResponse>;

export type EtaConnectionResult =
  | { ok: true; httpStatus: number }
  | {
      ok: false;
      reason: "invalid_credentials" | "provider_rejected" | "provider_unavailable";
      httpStatus?: number;
    };

export type EtaAuthenticationResult =
  | { ok: true; httpStatus: number; accessToken: string }
  | {
      ok: false;
      reason: "invalid_credentials" | "provider_rejected" | "provider_unavailable";
      httpStatus?: number;
    };

export type SubmissionResult =
  | { ok: true; httpStatus: number; providerSubmissionId?: string }
  | { ok: false; reason: "provider_rejected" | "provider_unavailable"; httpStatus?: number };

const ETA_PREPROD_IDENTITY_URL = "https://id.preprod.eta.gov.eg/connect/token";
const ETA_PROD_IDENTITY_URL = "https://id.eta.gov.eg/connect/token";
const ETA_PREPROD_INVOICING_BASE_URL = "https://api.preprod.invoicing.eta.gov.eg";
const ETA_PROD_INVOICING_BASE_URL = "https://api.invoicing.eta.gov.eg";
const JOFOTARA_PRODUCTION_HOST = "backend.jofotara.gov.jo";
const JOFOTARA_PRODUCTION_ENDPOINT = "https://backend.jofotara.gov.jo/core/invoices/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function assertSandbox(environment: TaxEnvironment): void {
  if (environment !== "sandbox") {
    throw new Error("Tax submissions are disabled outside sandbox mode");
  }
}

export function buildEtaConnectionRequest(credentials: {
  clientId: string;
  clientSecret: string;
}, environment: TaxEnvironment = "sandbox"): TaxProviderRequest {
  const clientId = requiredText(credentials.clientId, "clientId");
  const clientSecret = requiredText(credentials.clientSecret, "clientSecret");
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");

  return {
    url: environment === "sandbox" ? ETA_PREPROD_IDENTITY_URL : ETA_PROD_IDENTITY_URL,
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  };
}

/** Runs against an injected mock transport; never calls global fetch. */
export async function testEtaConnection(
  credentials: { clientId: string; clientSecret: string },
  transport: TaxProviderTransport,
  environment: TaxEnvironment = "sandbox",
): Promise<EtaConnectionResult> {
  const result = await authenticateEta(credentials, transport, environment);
  if (!result.ok) return result;
  // The token is intentionally discarded; test results never return credentials.
  return { ok: true, httpStatus: result.httpStatus };
}

/** Fetch an ETA bearer token for an immediate submission; callers must not persist it. */
export async function authenticateEta(
  credentials: { clientId: string; clientSecret: string },
  transport: TaxProviderTransport,
  environment: TaxEnvironment = "sandbox",
): Promise<EtaAuthenticationResult> {
  let request: TaxProviderRequest;
  try {
    request = buildEtaConnectionRequest(credentials, environment);
  } catch {
    return { ok: false, reason: "invalid_credentials" };
  }

  try {
    const response = await transport(request);
    const body = isRecord(response.body) ? response.body : {};
    if (response.status >= 200 && response.status < 300 && typeof body.access_token === "string" && body.access_token.length > 0) {
      return { ok: true, httpStatus: response.status, accessToken: body.access_token };
    }
    if (
      response.status === 400 &&
      (body.error === "invalid_client" || body.error === "unauthorized_client")
    ) {
      return { ok: false, reason: "invalid_credentials", httpStatus: response.status };
    }
    return { ok: false, reason: "provider_rejected", httpStatus: response.status };
  } catch {
    return { ok: false, reason: "provider_unavailable" };
  }
}

export async function submitEtaSandboxDocuments(
  input: {
    environment: TaxEnvironment;
    accessToken: string;
    signedDocuments: readonly Record<string, unknown>[];
  },
  transport: TaxProviderTransport,
): Promise<SubmissionResult> {
  assertSandbox(input.environment);
  const accessToken = requiredText(input.accessToken, "accessToken");
  if (input.signedDocuments.length === 0) throw new Error("At least one signed document is required");

  return submitEtaDocuments(input, transport);
}

/** ETA submission for either environment; callers must separately confirm production use. */
export async function submitEtaDocuments(
  input: {
    environment: TaxEnvironment;
    accessToken: string;
    signedDocuments: readonly Record<string, unknown>[];
  },
  transport: TaxProviderTransport,
): Promise<SubmissionResult> {
  const accessToken = requiredText(input.accessToken, "accessToken");
  if (input.signedDocuments.length === 0) throw new Error("At least one signed document is required");

  let response: TaxProviderResponse;
  try {
    response = await transport({
      url: `${input.environment === "sandbox" ? ETA_PREPROD_INVOICING_BASE_URL : ETA_PROD_INVOICING_BASE_URL}/api/v1.0/documentsubmissions/`,
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: serializeEtaJsonWire({ documents: input.signedDocuments }),
    });
  } catch {
    return { ok: false, reason: "provider_unavailable" };
  }

  const body = isRecord(response.body) ? response.body : {};
  const providerSubmissionId = typeof body.submissionId === "string"
    ? body.submissionId
    : typeof body.submissionUUID === "string"
      ? body.submissionUUID
      : undefined;
  return response.status >= 200 && response.status < 300
    ? { ok: true, httpStatus: response.status, providerSubmissionId }
    : { ok: false, reason: "provider_rejected", httpStatus: response.status };
}

function validateJordanSandboxEndpoint(endpointValue: string): string {
  const endpoint = new URL(requiredText(endpointValue, "endpoint"));
  if (endpoint.protocol !== "https:") throw new Error("Jordan sandbox endpoint must use HTTPS");
  const hostname = endpoint.hostname.toLowerCase();
  if (hostname === JOFOTARA_PRODUCTION_HOST) {
    throw new Error("The live JoFotara endpoint is blocked in sandbox mode");
  }
  if (hostname !== "jofotara.gov.jo" && !hostname.endsWith(".jofotara.gov.jo")) {
    throw new Error("Jordan sandbox endpoint must use an official JoFotara host");
  }
  return endpoint.toString();
}

function jordanInvoiceRequest(input: {
  environment: TaxEnvironment;
  endpoint?: string;
  userNumber: string;
  secretKey: string;
  ublXml: string;
}): TaxProviderRequest {
  const userNumber = requiredText(input.userNumber, "userNumber");
  const secretKey = requiredText(input.secretKey, "secretKey");
  const ublXml = requiredText(input.ublXml, "ublXml");
  const url = input.environment === "sandbox"
    ? validateJordanSandboxEndpoint(input.endpoint ?? "")
    : JOFOTARA_PRODUCTION_ENDPOINT;

  return {
    url,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Client-Id": userNumber,
      "Content-Type": "application/json",
      "Secret-Key": secretKey,
    },
    body: JSON.stringify({ invoice: Buffer.from(ublXml, "utf8").toString("base64") }),
  };
}

export function buildJordanSandboxInvoiceRequest(input: {
  environment: TaxEnvironment;
  endpoint: string;
  userNumber: string;
  secretKey: string;
  ublXml: string;
}): TaxProviderRequest {
  assertSandbox(input.environment);
  return jordanInvoiceRequest(input);
}

/** Production endpoint is fixed to JoFotara's documented URL, never caller-controlled. */
export function buildJordanInvoiceRequest(input: {
  environment: TaxEnvironment;
  endpoint?: string;
  userNumber: string;
  secretKey: string;
  ublXml: string;
}): TaxProviderRequest {
  return jordanInvoiceRequest(input);
}

/** Non-mutating reachability check only; it does not validate Jordan credentials. */
export async function testJordanEndpointReachability(
  endpointValue: string,
  transport: TaxProviderTransport,
  environment: TaxEnvironment = "sandbox",
): Promise<
  | { ok: true; httpStatus: number; credentialsVerified: false }
  | { ok: false; reason: "provider_unavailable" | "production_test_unsupported"; httpStatus?: number }
> {
  let url: string;
  try {
    if (environment === "production") {
      // ISTD has not published a production-safe credential test. Never probe
      // the live host merely to mark setup as verified.
      return { ok: false, reason: "production_test_unsupported" };
    } else {
      url = validateJordanSandboxEndpoint(endpointValue);
    }
  } catch {
    return { ok: false, reason: "provider_unavailable" };
  }
  try {
    const response = await transport({
      url,
      method: "HEAD",
      headers: { Accept: "application/json" },
    });
    // 401/403/404/405 still prove the configured host is reachable. No invoice
    // payload or credentials are sent, and this result never means auth passed.
    if (response.status < 500) {
      return { ok: true, httpStatus: response.status, credentialsVerified: false };
    }
    return { ok: false, reason: "provider_unavailable", httpStatus: response.status };
  } catch {
    return { ok: false, reason: "provider_unavailable" };
  }
}

export async function submitJordanSandboxInvoice(
  input: Parameters<typeof buildJordanSandboxInvoiceRequest>[0],
  transport: TaxProviderTransport,
): Promise<SubmissionResult> {
  const request = buildJordanSandboxInvoiceRequest(input);
  return submitJordanInvoiceRequest(request, transport);
}

export async function submitJordanInvoice(
  input: {
    environment: TaxEnvironment;
    endpoint?: string;
    userNumber: string;
    secretKey: string;
    ublXml: string;
  },
  transport: TaxProviderTransport,
): Promise<SubmissionResult> {
  const request = buildJordanInvoiceRequest(input);
  return submitJordanInvoiceRequest(request, transport);
}

async function submitJordanInvoiceRequest(
  request: TaxProviderRequest,
  transport: TaxProviderTransport,
): Promise<SubmissionResult> {
  let response: TaxProviderResponse;
  try {
    response = await transport(request);
  } catch {
    return { ok: false, reason: "provider_unavailable" };
  }
  const body = isRecord(response.body) ? response.body : {};
  const providerSubmissionId = ["invoiceId", "invoiceUUID", "invoiceUuid", "id"]
    .map(key => body[key])
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return response.status >= 200 && response.status < 300
    ? { ok: true, httpStatus: response.status, providerSubmissionId }
    : { ok: false, reason: "provider_rejected", httpStatus: response.status };
}