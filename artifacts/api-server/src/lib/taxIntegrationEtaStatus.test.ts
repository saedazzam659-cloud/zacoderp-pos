import test from "node:test";
import assert from "node:assert/strict";
import {
  getEtaSubmissionStatus,
  type TaxProviderRequest,
} from "./taxIntegrationAdapters.js";

test("ETA submission lookup uses the official submission endpoint and recognizes final validity", async () => {
  let request: TaxProviderRequest | undefined;
  const result = await getEtaSubmissionStatus({
    environment: "sandbox",
    accessToken: "test-token",
    providerSubmissionId: "submission/1",
    internalId: "OWNER-BILL-17",
  }, async current => {
    request = current;
    return {
      status: 200,
      body: {
        overallStatus: "valid",
        documentSummary: [{ internalId: "OWNER-BILL-17", status: "valid" }],
      },
    };
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "accepted");
  assert.equal(request?.method, "GET");
  assert.match(request?.url ?? "", /documentsubmissions\/submission%2F1\?pageNo=1&pageSize=20$/);
});

test("ETA submission lookup leaves pending documents in processing", async () => {
  const result = await getEtaSubmissionStatus({
    environment: "production",
    accessToken: "test-token",
    providerSubmissionId: "submission-2",
    internalId: "OWNER-BILL-18",
  }, async () => ({
    status: 200,
    body: {
      overallStatus: "in progress",
      documentSummary: [{ internalId: "OWNER-BILL-18", status: "submitted" }],
    },
  }));
  assert.equal(result.status, "processing");
});

test("ETA submission lookup reports a final rejection but never treats an unmatched document as accepted", async () => {
  const rejected = await getEtaSubmissionStatus({
    environment: "sandbox",
    accessToken: "test-token",
    providerSubmissionId: "submission-3",
    internalId: "OWNER-BILL-19",
  }, async () => ({
    status: 200,
    body: {
      overallStatus: "invalid",
      documentSummary: [{ internalId: "OWNER-BILL-19", status: "invalid" }],
    },
  }));
  const unmatched = await getEtaSubmissionStatus({
    environment: "sandbox",
    accessToken: "test-token",
    providerSubmissionId: "submission-4",
    internalId: "OWNER-BILL-20",
  }, async () => ({
    status: 200,
    body: {
      overallStatus: "valid",
      documentSummary: [{ internalId: "ANOTHER-BILL", status: "valid" }],
    },
  }));
  assert.equal(rejected.status, "rejected");
  assert.equal(unmatched.status, "unknown");
  assert.equal(unmatched.ok, false);
});