/**
 * Provider protocol primitives used by local mock tests.
 *
 * These functions deliberately require an injected transport and never open
 * sockets themselves. Real provider calls must not be wired until official
 * sandbox access is available and the provider-specific document mapping has
 * been verified.
 */

export type TaxEnvironment = "sandbox" | "production";

export interface TaxProviderRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
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

export type SubmissionResult =
  | { ok: true; httpStatus: number }
  | { ok: false; reason: "provider_rejected" | "provider_unavailable"; httpStatus?: number };

const ETA_PREPROD_IDENTITY_URL = "https://id.preprod.eta.gov.eg/connect/token";
const ETA_PREPROD_INVOICING_BASE_URL = "https://api.preprod.invoicing.eta.gov.eg";
const JOFOTARA_PRODUCTION_HOST = "backend.jofotara.gov.jo";

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
}): TaxProviderRequest {
  const clientId = requiredText(credentials.clientId, "clientId");
  const clientSecret = requiredText(credentials.clientSecret, "clientSecret");
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");

  return {
    url: ETA_PREPROD_IDENTITY_URL,
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
): Promise<EtaConnectionResult> {
  let request: TaxProviderRequest;
  try {
    request = buildEtaConnectionRequest(credentials);
  } catch {
    return { ok: false, reason: "invalid_credentials" };
  }

  try {
    const response = await transport(request);
    const body = isRecord(response.body) ? response.body : {};
    if (response.status >= 200 && response.status < 300 && typeof body.access_token === "string" && body.access_token.length > 0) {
      // Never return or persist the access token.
      return { ok: true, httpStatus: response.status };
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

  const response = await transport({
    url: `${ETA_PREPROD_INVOICING_BASE_URL}/api/v1.0/documentsubmissions/`,
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documents: input.signedDocuments }),
  }).catch(() => null);

  if (!response) return { ok: false, reason: "provider_unavailable" };
  return response.status >= 200 && response.status < 300
    ? { ok: true, httpStatus: response.status }
    : { ok: false, reason: "provider_rejected", httpStatus: response.status };
}

export function buildJordanSandboxInvoiceRequest(input: {
  environment: TaxEnvironment;
  endpoint: string;
  userNumber: string;
  secretKey: string;
  ublXml: string;
}): TaxProviderRequest {
  assertSandbox(input.environment);
  const endpoint = new URL(requiredText(input.endpoint, "endpoint"));
  if (endpoint.protocol !== "https:") throw new Error("Jordan sandbox endpoint must use HTTPS");
  if (endpoint.hostname.toLowerCase() === JOFOTARA_PRODUCTION_HOST) {
    throw new Error("The live JoFotara endpoint is blocked in sandbox mode");
  }

  const userNumber = requiredText(input.userNumber, "userNumber");
  const secretKey = requiredText(input.secretKey, "secretKey");
  const ublXml = requiredText(input.ublXml, "ublXml");

  return {
    url: endpoint.toString(),
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

export async function submitJordanSandboxInvoice(
  input: Parameters<typeof buildJordanSandboxInvoiceRequest>[0],
  transport: TaxProviderTransport,
): Promise<SubmissionResult> {
  const request = buildJordanSandboxInvoiceRequest(input);
  const response = await transport(request).catch(() => null);
  if (!response) return { ok: false, reason: "provider_unavailable" };
  return response.status >= 200 && response.status < 300
    ? { ok: true, httpStatus: response.status }
    : { ok: false, reason: "provider_rejected", httpStatus: response.status };
}