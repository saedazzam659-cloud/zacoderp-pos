import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyControllerLinkRenewalAttestationResponse,
  controllerLinkRenewalCredentialsMatchInvite,
  controllerLinkRenewalSourceFailures,
  deriveControllerToken,
  derivePlatformControlToken,
  sha256Verifier,
} from "../src/lib/agentControllerLinks.ts";

const expected = {
  targetOrigin: "https://target.example",
  platformId: "platform:source-1234",
  origin: "https://source.example",
  installationId: "install-12345678",
  domain: "agent.example",
  dbFingerprint: "fingerprint",
};

const validLink = {
  targetOrigin: expected.targetOrigin,
  sourcePlatformId: expected.platformId,
  sourceOrigin: expected.origin,
  controllerEpoch: 0,
  activeControllerId: expected.platformId,
  installationId: expected.installationId,
  domain: expected.domain,
  dbFingerprint: expected.dbFingerprint,
};

test("controller-link renewal accepts only an exact Epoch 0 source snapshot", () => {
  assert.deepEqual(controllerLinkRenewalSourceFailures(validLink, expected), []);
});

test("controller-link renewal reports every mismatching source condition without values", () => {
  assert.deepEqual(
    controllerLinkRenewalSourceFailures({
      ...validLink,
      targetOrigin: "https://other.example",
      sourcePlatformId: "platform:other-1234",
      sourceOrigin: "https://other-source.example",
      controllerEpoch: 1,
      activeControllerId: "platform:other-1234",
      installationId: "other-install-1234",
      domain: "other.example",
      dbFingerprint: null,
    }, expected),
    [
      "target_origin_mismatch",
      "source_platform_mismatch",
      "source_origin_mismatch",
      "controller_epoch_not_zero",
      "active_controller_mismatch",
      "installation_mismatch",
      "agent_domain_mismatch",
      "database_fingerprint_mismatch",
    ],
  );
});

test("controller-link renewal treats absent fingerprints as equal only when both are absent", () => {
  assert.deepEqual(
    controllerLinkRenewalSourceFailures({ ...validLink, dbFingerprint: undefined }, {
      ...expected,
      dbFingerprint: null,
    }),
    [],
  );
  assert.deepEqual(
    controllerLinkRenewalSourceFailures({ ...validLink, dbFingerprint: undefined }, expected),
    ["database_fingerprint_mismatch"],
  );
});

test("controller-link renewal distinguishes target refusal from an unavailable attestation", () => {
  assert.equal(
    classifyControllerLinkRenewalAttestationResponse(409, "controller_pairing_already_present"),
    "pairing_present",
  );
  assert.equal(
    classifyControllerLinkRenewalAttestationResponse(403, "renewal_attestation_denied"),
    "invite_denied",
  );
  assert.equal(
    classifyControllerLinkRenewalAttestationResponse(503, "renewal_attestation_denied"),
    "unavailable",
  );
  assert.equal(
    classifyControllerLinkRenewalAttestationResponse(403, "other_error"),
    "unavailable",
  );
});

test("controller-link renewal recognizes a committed invite for safe file recovery", () => {
  const inviteSecret = "test-fresh-invite-secret";
  const linkId = "5434c9c8-11f9-4ee3-b6dd-49e1623993ea";
  const targetPlatformId = "platform:target-1234";
  const committed = {
    linkId,
    targetPlatformId,
    controllerTokenVerifier: sha256Verifier(deriveControllerToken(inviteSecret, linkId, targetPlatformId)),
    platformControlTokenVerifier: sha256Verifier(derivePlatformControlToken(inviteSecret, linkId, targetPlatformId)),
  };

  assert.equal(controllerLinkRenewalCredentialsMatchInvite(committed, inviteSecret), true);
  assert.equal(controllerLinkRenewalCredentialsMatchInvite(committed, "different-invite-secret"), false);
  assert.equal(controllerLinkRenewalCredentialsMatchInvite({
    ...committed,
    platformControlTokenVerifier: null,
  }, inviteSecret), false);
});