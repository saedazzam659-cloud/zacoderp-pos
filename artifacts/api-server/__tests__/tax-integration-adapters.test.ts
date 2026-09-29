import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEtaConnectionRequest,
  buildJordanSandboxInvoiceRequest,
  submitEtaSandboxDocuments,
  submitJordanSandboxInvoice,
  testEtaConnection,
  type TaxProviderRequest,
  type TaxProviderResponse,
} from "../src/lib/taxIntegrationAdapters.ts";

const etaCredentials = { clientId: "local-client", clientSecret: "local-secret" };
const jordanSandbox = {
  environment: "sandbox" as const,
  endpoint: "https://jofotara.sandbox.test/core/invoices/",
  userNumber: "local-user-number",
  secretKey: "local-secret-key",
  ublXml: "<Invoice><ID>MOCK-1</ID></Invoice>",
};

test("ETA connection request uses pre-production OAuth and never exposes a token", async () => {
  const request = buildEtaConnectionRequest(etaCredentials);
  assert.equal(request.url, "https://id.preprod.eta.gov.eg/connect/token");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.Authorization, `Basic ${Buffer.from("local-client:local-secret").toString("base64")}`);
  assert.equal(request.body, "grant_type=client_credentials");

  let captured: TaxProviderRequest | undefined;
  const result = await testEtaConnection(etaCredentials, async (mockRequest) => {
    captured = mockRequest;
    return {
      status: 200,
      body: { access_token: "mock-token-must-not-escape", token_type: "Bearer", expires_in: 3600 },
    };
  });
  assert.equal(captured?.url, request.url);
  assert.deepEqual(result, { ok: true, httpStatus: 200 });
  assert.equal(JSON.stringify(result).includes("mock-token"), false);
});

test("ETA invalid credentials are reduced to a safe local result", async () => {
  let calls = 0;
  const result = await testEtaConnection(etaCredentials, async () => {
    calls += 1;
    return { status: 400, body: { error: "invalid_client", error_description: "private response detail" } };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ok: false, reason: "invalid_credentials", httpStatus: 400 });
  assert.equal(JSON.stringify(result).includes("private response detail"), false);
});

test("ETA submission builds a sandbox-only document-submission request", async () => {
  let captured: TaxProviderRequest | undefined;
  const signedDocument = { issuer: { id: "EG-123" }, documentType: "I" };
  const result = await submitEtaSandboxDocuments({
    environment: "sandbox",
    accessToken: "mock-token",
    signedDocuments: [signedDocument],
  }, async (request) => {
    captured = request;
    return { status: 202, body: { submissionId: "mock-submission" } };
  });

  assert.equal(captured?.url, "https://api.preprod.invoicing.eta.gov.eg/api/v1.0/documentsubmissions/");
  assert.equal(captured?.headers.Authorization, "Bearer mock-token");
  assert.deepEqual(JSON.parse(captured?.body ?? "{}"), { documents: [signedDocument] });
  assert.deepEqual(result, { ok: true, httpStatus: 202 });
});

test("ETA refuses production submission before invoking any transport", async () => {
  let calls = 0;
  await assert.rejects(
    submitEtaSandboxDocuments({
      environment: "production",
      accessToken: "mock-token",
      signedDocuments: [{ id: "MOCK-1" }],
    }, async () => {
      calls += 1;
      return { status: 200, body: {} };
    }),
    /disabled outside sandbox mode/,
  );
  assert.equal(calls, 0);
});

test("Jordan request maps the documented API headers and Base64 UBL body", () => {
  const request = buildJordanSandboxInvoiceRequest(jordanSandbox);
  assert.equal(request.url, jordanSandbox.endpoint);
  assert.equal(request.method, "POST");
  assert.equal(request.headers["Client-Id"], jordanSandbox.userNumber);
  assert.equal(request.headers["Secret-Key"], jordanSandbox.secretKey);
  assert.deepEqual(
    JSON.parse(request.body),
    { invoice: Buffer.from(jordanSandbox.ublXml, "utf8").toString("base64") },
  );
});

test("Jordan sandbox submit maps mock acceptance without returning provider payload", async () => {
  let captured: TaxProviderRequest | undefined;
  const result = await submitJordanSandboxInvoice(jordanSandbox, async (request) => {
    captured = request;
    return { status: 200, body: { invoiceId: "mock-id", qr: "mock-qr" } };
  });
  assert.equal(captured?.url, jordanSandbox.endpoint);
  assert.deepEqual(result, { ok: true, httpStatus: 200 });
});

test("Jordan live endpoint and production mode are blocked before transport", async () => {
  let calls = 0;
  const transport = async (): Promise<TaxProviderResponse> => {
    calls += 1;
    return { status: 200, body: {} };
  };
  await assert.rejects(
    submitJordanSandboxInvoice({
      ...jordanSandbox,
      endpoint: "https://backend.jofotara.gov.jo/core/invoices/",
    }, transport),
    /live JoFotara endpoint is blocked/,
  );
  await assert.rejects(
    submitJordanSandboxInvoice({ ...jordanSandbox, environment: "production" }, transport),
    /disabled outside sandbox mode/,
  );
  assert.equal(calls, 0);
});

test("provider transport failures are normalized without leaking errors", async () => {
  const connection = await testEtaConnection(etaCredentials, async () => {
    throw new Error("mock network error containing secret");
  });
  const submission = await submitJordanSandboxInvoice(jordanSandbox, async () => {
    throw new Error("mock provider error containing secret");
  });
  assert.deepEqual(connection, { ok: false, reason: "provider_unavailable" });
  assert.deepEqual(submission, { ok: false, reason: "provider_unavailable" });
  assert.equal(JSON.stringify([connection, submission]).includes("secret"), false);
});