import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertMonotonicEpoch,
  assertStoredInviteUsable,
  buildControllerLinkFile,
  createControllerSigningKeyPair,
  createPlatformLinkInvite,
  deriveControllerToken,
  derivePlatformControlToken,
  highestControllerState,
  licenseKeyVerifier,
  sha256Verifier,
  validateInvite,
  signControllerCommit,
  verifyControllerCommit,
  verifyControllerLinkFile,
} from "../src/lib/agentControllerLinks.ts";
import { controllerOriginsInOrder } from "../src/routes/localAgentUpdates.ts";

const target = { platformId: "platform:target-1234", origin: "https://target.example" };
const source = { platformId: "platform:source-1234", origin: "https://source.example" };

function fixture(now = new Date("2026-01-01T00:00:00Z")) {
  const invite = createPlatformLinkInvite({ targetPlatformId: target.platformId, targetOrigin: target.origin, now });
  const signing = createControllerSigningKeyPair();
  const payload = {
    schemaVersion: 1 as const,
    linkId: "81ab650b-f0ce-49cc-a9fe-fadf183a2cdd",
    inviteId: invite.inviteId,
    expiresAt: invite.expiresAt,
    agent: {
      name: "Agent", domain: "agent.example", extraDomains: ["www.agent.example"],
      installationId: "installation-123", dbFingerprint: "fingerprint-123",
      licenseExpiresAt: "2027-01-01T00:00:00.000Z", maxCompanies: 8,
      version: "abc123", status: "active", packageSource: "central",
      licenseVerifier: licenseKeyVerifier("ZC-RAW-LICENSE"),
    },
    source, target, controllerEpoch: 4, activeControllerId: source.platformId,
    sourceSigningPublicKey: signing.publicKey,
  };
  return { now, invite, signing, file: buildControllerLinkFile(payload, invite.inviteSecret) };
}

test("invite is HTTPS-bound, short-lived, and stores a usable verifier", () => {
  const { invite, now } = fixture();
  assert.equal(validateInvite(invite, target, now).inviteId, invite.inviteId);
  assert.match(invite.inviteSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.match(sha256Verifier(invite.inviteSecret), /^[a-f0-9]{64}$/);
  assert.throws(() => createPlatformLinkInvite({ ...target, targetPlatformId: target.platformId, targetOrigin: "http://target.example" }));
  assert.throws(() => validateInvite(invite, { ...target, platformId: "platform:wrong-1234" }, now), /target_mismatch/);
});

test("portable file has no raw credentials or business DB location", () => {
  const { file, invite, signing } = fixture();
  const raw = JSON.stringify(file);
  assert.equal(raw.includes(invite.inviteSecret), false);
  assert.equal(raw.includes("ZC-RAW-LICENSE"), false);
  assert.equal(/licenseKey|dbUrl/i.test(raw), false);
  assert.equal(raw.includes(signing.publicKey), true);
  assert.equal(raw.includes(signing.privateKey), false);
  assert.equal(/platformControlToken/i.test(raw), false);
});

test("expired and tampered links fail while a valid file verifies", () => {
  const { file, invite, now } = fixture();
  assert.equal(verifyControllerLinkFile(file, invite.inviteSecret, {
    inviteId: invite.inviteId, ...target,
  }, now).payload.agent.domain, "agent.example");
  const tampered = structuredClone(file);
  tampered.payload.agent.domain = "attacker.example";
  assert.throws(() => verifyControllerLinkFile(tampered, invite.inviteSecret, {
    inviteId: invite.inviteId, ...target,
  }, now), /invalid_link_mac/);
  assert.throws(() => verifyControllerLinkFile(file, invite.inviteSecret, {
    inviteId: invite.inviteId, ...target,
  }, new Date(invite.expiresAt)), /link_expired/);
});

test("license verifier authenticates raw input without retaining it", () => {
  const verifier = licenseKeyVerifier("correct-license");
  assert.equal(verifier, sha256Verifier("correct-license"));
  assert.notEqual(verifier, licenseKeyVerifier("wrong-license"));
  assert.equal(verifier.includes("correct-license"), false);
});

test("controller epochs are strictly monotonic", () => {
  assert.doesNotThrow(() => assertMonotonicEpoch(7, 8));
  assert.throws(() => assertMonotonicEpoch(7, 7), /not_monotonic/);
  assert.throws(() => assertMonotonicEpoch(7, 6), /not_monotonic/);
});

test("stored invites reject wrong secrets, expiry, and replay", () => {
  const { invite, now } = fixture();
  const stored = {
    consumedAt: null,
    expiresAt: new Date(invite.expiresAt),
    secretVerifier: sha256Verifier(invite.inviteSecret),
  };
  assert.doesNotThrow(() => assertStoredInviteUsable(stored, invite.inviteSecret, now));
  assert.throws(() => assertStoredInviteUsable(stored, "x".repeat(43), now), /invalid_invite_secret/);
  assert.throws(() => assertStoredInviteUsable(stored, invite.inviteSecret, stored.expiresAt), /invite_expired/);
  assert.throws(() => assertStoredInviteUsable({ ...stored, consumedAt: new Date() }, invite.inviteSecret, now), /already_consumed/);
});

test("controller origin selection prefers active then deterministic fallbacks", () => {
  assert.deepEqual(controllerOriginsInOrder({
    centralOrigin: "https://legacy.example",
    activeControllerId: "target",
    controllerOrigins: [
      { platformId: "local", origin: "https://local.example" },
      { platformId: "target", origin: "https://target.example" },
      { platformId: "other", origin: "https://other.example" },
    ],
  }), ["https://target.example", "https://local.example", "https://other.example"]);
  assert.deepEqual(controllerOriginsInOrder({ centralOrigin: "https://legacy.example" }), ["https://legacy.example"]);
});

test("link controller token is deterministic and distinct from the raw license", () => {
  const token = deriveControllerToken("a".repeat(43), "81ab650b-f0ce-49cc-a9fe-fadf183a2cdd", target.platformId);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, "ZC-RAW-LICENSE");
  assert.equal(token, deriveControllerToken("a".repeat(43), "81ab650b-f0ce-49cc-a9fe-fadf183a2cdd", target.platformId));
});

test("platform control credential is domain-separated from the agent token", () => {
  const secret = "a".repeat(43);
  const linkId = "81ab650b-f0ce-49cc-a9fe-fadf183a2cdd";
  assert.notEqual(derivePlatformControlToken(secret, linkId, target.platformId), deriveControllerToken(secret, linkId, target.platformId));
});

test("Ed25519 commit authorization rejects tampering and expiry", () => {
  const keys = createControllerSigningKeyPair();
  const authorization = {
    linkId: "81ab650b-f0ce-49cc-a9fe-fadf183a2cdd", installationId: "installation-123",
    expectedEpoch: 4, expectedActiveControllerId: source.platformId,
    requestedEpoch: 5, requestedActiveControllerId: target.platformId, expiresAt: 10_000,
  };
  const signature = signControllerCommit(authorization, keys.privateKey);
  assert.doesNotThrow(() => verifyControllerCommit(authorization, signature, keys.publicKey, 9_000));
  assert.throws(() => verifyControllerCommit({ ...authorization, requestedEpoch: 6 }, signature, keys.publicKey, 9_000), /invalid/);
  assert.throws(() => verifyControllerCommit(authorization, signature, keys.publicKey, 10_000), /expired/);
});

test("same epoch leadership converges by platform ID total order", () => {
  assert.deepEqual(highestControllerState([
    { controllerEpoch: 9, activeControllerId: "platform:a-1234" },
    { controllerEpoch: 9, activeControllerId: "platform:z-1234" },
  ], ["platform:a-1234", "platform:z-1234"]), { controllerEpoch: 9, activeControllerId: "platform:z-1234" });
  assert.deepEqual(highestControllerState([
    { controllerEpoch: 10, activeControllerId: "platform:A-1234" },
    { controllerEpoch: 10, activeControllerId: "platform:a-1234" },
  ], ["platform:A-1234", "platform:a-1234"]), { controllerEpoch: 10, activeControllerId: "platform:a-1234" });
});