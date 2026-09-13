import assert from "node:assert/strict";
import test from "node:test";
import {
  assertManagementOperation,
  assertPlatformControlToken,
  assertPublicControllerOrigin,
  assertSourceManagementAccess,
  assertTargetManagementAccess,
  assertLiveInstanceMatchesLink,
  managementRequestPayload,
  managementResponse,
  safeManagementValue,
} from "../src/lib/controllerManagementBridge.ts";
import { sha256Verifier } from "../src/lib/agentControllerLinks.ts";

const targetIdentity = { platformId: "target-platform", origin: "https://target.example" };
const link = {
  direction: "imported",
  targetPlatformId: targetIdentity.platformId,
  targetOrigin: targetIdentity.origin,
  activeControllerId: targetIdentity.platformId,
  status: "active",
  licenseExpiresAt: null,
};

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (error: any) { return String(error?.code ?? ""); }
  return "";
}

test("management requires an authenticated local Super Admin", () => {
  assert.equal(codeOf(() => assertTargetManagementAccess({
    actor: null, link, identity: targetIdentity,
  })), "authentication_required");
  assert.equal(codeOf(() => assertTargetManagementAccess({
    actor: { role: "admin" }, link, identity: targetIdentity,
  })), "superadmin_required");
});

test("management binds the exact imported link and target origin", () => {
  assert.equal(codeOf(() => assertTargetManagementAccess({
    actor: { role: "superadmin" }, link: { ...link, direction: "outbound" }, identity: targetIdentity,
  })), "controller_link_not_found");
  assert.equal(codeOf(() => assertTargetManagementAccess({
    actor: { role: "superadmin" }, link, identity: { platformId: "other-platform", origin: targetIdentity.origin },
  })), "target_platform_mismatch");
  assert.equal(codeOf(() => assertTargetManagementAccess({
    actor: { role: "superadmin" }, link, identity: { ...targetIdentity, origin: "https://other.example" },
  })), "target_platform_mismatch");
});

test("management rejects suspended, expired, and non-active controllers", () => {
  assert.equal(codeOf(() => assertTargetManagementAccess({
    actor: { role: "superadmin" }, link: { ...link, activeControllerId: "source-platform" }, identity: targetIdentity,
  })), "inactive_controller");
  assert.equal(codeOf(() => assertTargetManagementAccess({
    actor: { role: "superadmin" }, link: { ...link, status: "suspended" }, identity: targetIdentity,
  })), "linked_agent_inactive");
  assert.equal(codeOf(() => assertTargetManagementAccess({
    actor: { role: "superadmin" },
    link: { ...link, licenseExpiresAt: new Date("2024-01-01T00:00:00Z") },
    identity: targetIdentity, now: new Date("2024-02-01T00:00:00Z"),
  })), "license_expired");
});

const sourceLink = {
  direction: "outbound",
  sourcePlatformId: "source-platform",
  sourceOrigin: "https://source.example",
  targetPlatformId: targetIdentity.platformId,
  targetOrigin: targetIdentity.origin,
  installationId: "installation-1",
  domain: "source.example",
  dbFingerprint: "db-fingerprint-1",
  controllerEpoch: 7,
  activeControllerId: targetIdentity.platformId,
};

test("source management rejects wrong installation, domain, fingerprint, and stale epoch", () => {
  const base = {
    link: sourceLink, localPlatformId: sourceLink.sourcePlatformId,
    requesterPlatformId: targetIdentity.platformId, requesterOrigin: targetIdentity.origin,
    installationId: sourceLink.installationId, domain: sourceLink.domain,
    dbFingerprint: sourceLink.dbFingerprint, controllerEpoch: sourceLink.controllerEpoch,
    activeControllerId: sourceLink.activeControllerId,
  };
  assert.equal(codeOf(() => assertSourceManagementAccess({ ...base, installationId: "other" })), "controller_identity_mismatch");
  assert.equal(codeOf(() => assertSourceManagementAccess({ ...base, domain: "other.example" })), "controller_identity_mismatch");
  assert.equal(codeOf(() => assertSourceManagementAccess({ ...base, dbFingerprint: "other" })), "controller_identity_mismatch");
  assert.equal(codeOf(() => assertSourceManagementAccess({ ...base, controllerEpoch: 6 })), "controller_state_mismatch");
  assert.equal(codeOf(() => assertSourceManagementAccess({ ...base, link: { ...sourceLink, status: "suspended" } })), "linked_agent_inactive");
  assert.equal(codeOf(() => assertSourceManagementAccess({ ...base, link: { ...sourceLink, licenseExpiresAt: new Date("2024-01-01T00:00:00Z") } })), "license_expired");
  assert.equal(codeOf(() => assertSourceManagementAccess({
    ...base,
    link: { ...sourceLink, activeControllerId: sourceLink.sourcePlatformId },
    activeControllerId: sourceLink.sourcePlatformId,
  })), "inactive_controller");
});

test("active source and target contexts are accepted", () => {
  assert.doesNotThrow(() => assertTargetManagementAccess({
    actor: { role: "superadmin" }, link, identity: targetIdentity,
  }));
  assert.doesNotThrow(() => assertSourceManagementAccess({
    link: sourceLink, localPlatformId: sourceLink.sourcePlatformId,
    requesterPlatformId: targetIdentity.platformId, requesterOrigin: targetIdentity.origin,
    installationId: sourceLink.installationId, domain: sourceLink.domain,
    dbFingerprint: sourceLink.dbFingerprint, controllerEpoch: sourceLink.controllerEpoch,
    activeControllerId: sourceLink.activeControllerId,
  }));
});

test("only the narrow management operation allowlist is accepted", () => {
  assert.equal(assertManagementOperation("company.list"), "company.list");
  assert.equal(assertManagementOperation("user.status"), "user.status");
  assert.equal(codeOf(() => assertManagementOperation("sql.query")), "unsupported_management_operation");
  assert.equal(codeOf(() => assertManagementOperation("company.delete.extra")), "unsupported_management_operation");
});

test("platform-control capability is verifier-bound", () => {
  const verifier = sha256Verifier("capability-secret");
  assert.doesNotThrow(() => assertPlatformControlToken("capability-secret", verifier));
  assert.equal(codeOf(() => assertPlatformControlToken("wrong-secret", verifier)), "platform_control_token_mismatch");
  assert.equal(codeOf(() => assertPlatformControlToken("capability-secret", null)), "platform_control_token_mismatch");
});

test("controller origins require HTTPS and public addresses", () => {
  assert.equal(codeOf(() => assertPublicControllerOrigin("http://source.example")), "target_origin_must_be_https");
  assert.equal(codeOf(() => assertPublicControllerOrigin("https://127.0.0.1")), "target_private_address");
  assert.equal(codeOf(() => assertPublicControllerOrigin("https://10.0.0.5")), "target_private_address");
  assert.equal(assertPublicControllerOrigin("https://8.8.8.8").protocol, "https:");
});

test("management responses omit credentials, logos, and branding recursively", () => {
  const safe = safeManagementValue({
    id: 3, nameAr: "شركة أصلية", passwordHash: "hash", sessionToken: "session",
    logoUrl: "data:image/png;base64,secret", brandColor: "#fff",
    senderSmtpPassEnc: "encrypted", backupWhatsappOtpHash: "otp", zatcaPrivateKey: "key",
    nested: [{ apiKey: "secret", value: "kept" }],
  }) as any;
  assert.deepEqual(safe, { id: 3, nameAr: "شركة أصلية", nested: [{ value: "kept" }] });
});

test("company DTOs are explicit allowlists, including list/get/update", () => {
  const row = {
    id: 3, code: "ZTC-3", nameAr: "شركة أصلية", vatNumber: "vat",
    senderSmtpPassEnc: "encrypted", backupWhatsappOtpHash: "otp",
    zatcaPrivateKey: "key", logo: "data:image/png;base64,secret",
    brandLogo: "data:image/png;base64,secret", runtimeSecret: "secret",
  };
  for (const operation of ["company.list", "company.get", "company.update"] as const) {
    const result: any = managementResponse(operation, operation === "company.list" ? [row] : row);
    const dto = operation === "company.list" ? result[0] : result;
    assert.deepEqual(dto, { id: 3, code: "ZTC-3", nameAr: "شركة أصلية", vatNumber: "vat" });
    assert.equal("senderSmtpPassEnc" in dto, false);
    assert.equal("backupWhatsappOtpHash" in dto, false);
    assert.equal("zatcaPrivateKey" in dto, false);
    assert.equal("logo" in dto, false);
    assert.equal("brandLogo" in dto, false);
  }
});

test("company update request DTO cannot mutate credentials, ZATCA, branding, or runtime fields", () => {
  const payload: any = managementRequestPayload("company.update", {
    id: 3, nameAr: "شركة محدثة", vatNumber: "vat", crNumber: "cr", city: "Riyadh",
    street: "Street", buildingNumber: "1", postalCode: "12345",
    senderSmtpPassEnc: "encrypted", backupWhatsappOtpHash: "otp",
    zatcaCsid: "csid", zatcaPrivateKey: "key", logo: "logo",
    serialNumber: "runtime", deviceSerial1: "runtime",
  });
  assert.deepEqual(payload, {
    nameAr: "شركة محدثة", vatNumber: "vat", crNumber: "cr", city: "Riyadh",
    street: "Street", buildingNumber: "1", postalCode: "12345",
  });
});

test("live agent identity must match the copied link before DB URL use", () => {
  const live = { installationId: "installation-1", domain: "source.example", dbFingerprint: "db-fingerprint-1" };
  const copied = { ...live };
  assert.doesNotThrow(() => assertLiveInstanceMatchesLink({ instance: live, link: copied }));
  for (const mismatch of [
    { ...live, installationId: "repointed-installation" },
    { ...live, domain: "repointed.example" },
    { ...live, dbFingerprint: "repointed-db" },
  ]) {
    assert.equal(codeOf(() => assertLiveInstanceMatchesLink({ instance: mismatch, link: copied })), "controller_identity_mismatch");
  }
});
