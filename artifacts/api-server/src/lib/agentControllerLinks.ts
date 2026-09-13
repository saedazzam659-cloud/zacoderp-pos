import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, timingSafeEqual, verify } from "node:crypto";

export const CONTROLLER_LINK_SCHEMA_VERSION = 1 as const;
export const MAX_LINK_LIFETIME_MS = 15 * 60_000;

export type PlatformLinkInvite = {
  schemaVersion: 1;
  targetPlatformId: string;
  targetOrigin: string;
  inviteId: string;
  expiresAt: string;
  inviteSecret: string;
};

export type ControllerLinkPayload = {
  schemaVersion: 1;
  linkId: string;
  inviteId: string;
  expiresAt: string;
  agent: {
    name: string;
    domain: string;
    extraDomains: string[];
    installationId: string;
    dbFingerprint: string | null;
    licenseExpiresAt: string | null;
    maxCompanies: number | null;
    version: string | null;
    status: string;
    packageSource: string;
    licenseVerifier: string;
  };
  source: { platformId: string; origin: string };
  target: { platformId: string; origin: string };
  controllerEpoch: number;
  activeControllerId: string;
  sourceSigningPublicKey: string;
};

export type ControllerLinkFile = {
  schemaVersion: 1;
  payload: ControllerLinkPayload;
  authentication: { algorithm: "HMAC-SHA256"; mac: string };
};

/** One-time renewal proof returned by the target platform.  It is deliberately
 * separate from a portable link: it only proves that this fresh invitation
 * was checked against the requested installation/link IDs and found no
 * imported controller link. */
export type ControllerLinkRenewalAttestationPayload = {
  schemaVersion: 1;
  kind: "controller_link_non_import";
  inviteId: string;
  sourcePlatformId: string;
  sourceOrigin: string;
  targetPlatformId: string;
  targetOrigin: string;
  installationId: string;
  candidateLinkIds: string[];
  nonce: string;
  expiresAt: string;
};

export type ControllerLinkRenewalAttestation = {
  payload: ControllerLinkRenewalAttestationPayload;
  authentication: { algorithm: "HMAC-SHA256"; mac: string };
};

export function normalizeHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("origin_must_be_https");
  }
  return url.origin.toLowerCase();
}

export function platformId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(value)) throw new Error("invalid_platform_id");
  return value;
}

export function sha256Verifier(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function constantTimeHexEqual(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map(k =>
      `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createPlatformLinkInvite(args: {
  targetPlatformId: string; targetOrigin: string; now?: Date; lifetimeMs?: number;
}): PlatformLinkInvite {
  const now = args.now ?? new Date();
  const lifetime = Math.min(MAX_LINK_LIFETIME_MS, Math.max(30_000, args.lifetimeMs ?? 10 * 60_000));
  return {
    schemaVersion: 1,
    targetPlatformId: platformId(args.targetPlatformId),
    targetOrigin: normalizeHttpsOrigin(args.targetOrigin),
    inviteId: randomUUID(),
    expiresAt: new Date(now.getTime() + lifetime).toISOString(),
    inviteSecret: randomBytes(32).toString("base64url"),
  };
}

export function validateInvite(invite: unknown, expected?: { platformId: string; origin: string }, now = new Date()): PlatformLinkInvite {
  const x = invite as Partial<PlatformLinkInvite>;
  if (!x || x.schemaVersion !== 1 || typeof x.inviteId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(x.inviteId) || typeof x.inviteSecret !== "string" ||
      !/^[A-Za-z0-9_-]{43,100}$/.test(x.inviteSecret)) throw new Error("invalid_invite");
  const parsed: PlatformLinkInvite = {
    schemaVersion: 1,
    inviteId: x.inviteId,
    inviteSecret: x.inviteSecret,
    targetPlatformId: platformId(String(x.targetPlatformId)),
    targetOrigin: normalizeHttpsOrigin(String(x.targetOrigin)),
    expiresAt: String(x.expiresAt),
  };
  const expiry = Date.parse(parsed.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) throw new Error("invite_expired");
  if (expiry - now.getTime() > MAX_LINK_LIFETIME_MS + 5_000) throw new Error("invalid_invite_expiry");
  if (expected && (parsed.targetPlatformId !== expected.platformId ||
      parsed.targetOrigin !== normalizeHttpsOrigin(expected.origin))) throw new Error("target_mismatch");
  return parsed;
}

export function licenseKeyVerifier(rawLicenseKey: string): string {
  if (!rawLicenseKey) throw new Error("missing_license");
  return sha256Verifier(rawLicenseKey);
}

/** Pairing-only credential; never portable and never returned by APIs. */
export function deriveControllerToken(inviteSecret: string, linkId: string, targetPlatformId: string): string {
  return createHmac("sha256", inviteSecret)
    .update(`zacod-controller-link-v1:${linkId}:${targetPlatformId}`, "utf8").digest("base64url");
}

export function derivePlatformControlToken(inviteSecret: string, linkId: string, targetPlatformId: string): string {
  return createHmac("sha256", inviteSecret)
    .update(`zacod-platform-control-v1:${linkId}:${targetPlatformId}`, "utf8").digest("base64url");
}

export type ControllerCommitAuthorization = {
  linkId: string; installationId: string; expectedEpoch: number; expectedActiveControllerId: string;
  requestedEpoch: number; requestedActiveControllerId: string; expiresAt: number;
};
function commitAuthorizationBytes(value: ControllerCommitAuthorization): Buffer {
  return Buffer.from(canonical(value), "utf8");
}
export function createControllerSigningKeyPair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}
export function signControllerCommit(value: ControllerCommitAuthorization, privateKey: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, "base64"), type: "pkcs8", format: "der" });
  return sign(null, commitAuthorizationBytes(value), key).toString("base64url");
}
export function verifyControllerCommit(value: ControllerCommitAuthorization, signature: unknown, publicKey: string, now = Date.now()): void {
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 60_000) throw new Error("controller_authorization_expired");
  if (typeof signature !== "string" || !signature) throw new Error("controller_authorization_invalid");
  const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), type: "spki", format: "der" });
  if (!verify(null, commitAuthorizationBytes(value), key, Buffer.from(signature, "base64url"))) throw new Error("controller_authorization_invalid");
}

export type ControllerState = { controllerEpoch: number; activeControllerId: string };
export function compareControllerState(a: ControllerState, b: ControllerState, validIds: readonly string[]): number {
  const valid = (s: ControllerState) => Number.isSafeInteger(s.controllerEpoch) && s.controllerEpoch >= 0 && validIds.includes(s.activeControllerId);
  if (!valid(a) || !valid(b)) throw new Error("invalid_controller_state");
  if (a.controllerEpoch !== b.controllerEpoch) return a.controllerEpoch - b.controllerEpoch;
  // Protocol ordering must be locale-independent and identical to the
  // generated heartbeat script's JavaScript string comparison.
  return a.activeControllerId < b.activeControllerId ? -1
    : a.activeControllerId > b.activeControllerId ? 1
    : 0;
}
export function highestControllerState(states: readonly ControllerState[], validIds: readonly string[]): ControllerState {
  if (!states.length) throw new Error("missing_controller_state");
  return states.reduce((best, state) => compareControllerState(state, best, validIds) > 0 ? state : best);
}

export function buildControllerLinkFile(payload: ControllerLinkPayload, inviteSecret: string): ControllerLinkFile {
  const mac = createHmac("sha256", inviteSecret).update(canonical(payload)).digest("hex");
  return { schemaVersion: 1, payload, authentication: { algorithm: "HMAC-SHA256", mac } };
}

function normalizeRenewalCandidates(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new Error("invalid_renewal_candidates");
  const ids = value.map(item => String(item));
  if (ids.some(id => !/^[0-9a-f-]{36}$/i.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error("invalid_renewal_candidates");
  }
  return [...ids].sort();
}

function renewalAttestationBytes(payload: ControllerLinkRenewalAttestationPayload): Buffer {
  return Buffer.from(canonical(payload), "utf8");
}

export function createControllerLinkRenewalAttestation(
  payload: Omit<ControllerLinkRenewalAttestationPayload, "schemaVersion" | "kind" | "candidateLinkIds"> & {
    candidateLinkIds: string[];
  },
  inviteSecret: string,
): ControllerLinkRenewalAttestation {
  const normalized: ControllerLinkRenewalAttestationPayload = {
    schemaVersion: 1,
    kind: "controller_link_non_import",
    ...payload,
    candidateLinkIds: normalizeRenewalCandidates(payload.candidateLinkIds),
  };
  const mac = createHmac("sha256", inviteSecret).update(renewalAttestationBytes(normalized)).digest("hex");
  return { payload: normalized, authentication: { algorithm: "HMAC-SHA256", mac } };
}

export function verifyControllerLinkRenewalAttestation(
  input: unknown,
  inviteSecret: string,
  expected: {
    inviteId: string;
    sourcePlatformId: string;
    sourceOrigin: string;
    targetPlatformId: string;
    targetOrigin: string;
    installationId: string;
    candidateLinkIds: string[];
    nonce: string;
  },
  now = new Date(),
): ControllerLinkRenewalAttestation {
  const file = input as ControllerLinkRenewalAttestation;
  const payload = file?.payload;
  if (!file || !payload || payload.schemaVersion !== 1 ||
      payload.kind !== "controller_link_non_import" ||
      file.authentication?.algorithm !== "HMAC-SHA256") {
    throw new Error("invalid_renewal_attestation");
  }
  const expectedMac = createHmac("sha256", inviteSecret).update(renewalAttestationBytes(payload)).digest("hex");
  if (!constantTimeHexEqual(file.authentication.mac, expectedMac)) throw new Error("invalid_renewal_attestation_mac");
  const candidateLinkIds = normalizeRenewalCandidates(payload.candidateLinkIds);
  const expectedCandidates = normalizeRenewalCandidates(expected.candidateLinkIds);
  if (payload.inviteId !== expected.inviteId ||
      payload.sourcePlatformId !== expected.sourcePlatformId ||
      normalizeHttpsOrigin(payload.sourceOrigin) !== normalizeHttpsOrigin(expected.sourceOrigin) ||
      payload.targetPlatformId !== expected.targetPlatformId ||
      normalizeHttpsOrigin(payload.targetOrigin) !== normalizeHttpsOrigin(expected.targetOrigin) ||
      payload.installationId !== expected.installationId ||
      JSON.stringify(candidateLinkIds) !== JSON.stringify(expectedCandidates) ||
      payload.nonce !== expected.nonce) {
    throw new Error("renewal_attestation_binding_mismatch");
  }
  const expiry = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) throw new Error("renewal_attestation_expired");
  return { payload: { ...payload, candidateLinkIds }, authentication: file.authentication };
}

export function verifyControllerLinkFile(
  input: unknown,
  inviteSecret: string,
  expected: { inviteId: string; platformId: string; origin: string },
  now = new Date(),
): ControllerLinkFile {
  const file = input as ControllerLinkFile;
  if (!file || file.schemaVersion !== 1 || file.payload?.schemaVersion !== 1 ||
      file.authentication?.algorithm !== "HMAC-SHA256") throw new Error("invalid_link_schema");
  const payload = file.payload;
  const expectedMac = createHmac("sha256", inviteSecret).update(canonical(payload)).digest("hex");
  if (!constantTimeHexEqual(file.authentication.mac, expectedMac)) throw new Error("invalid_link_mac");
  if (payload.inviteId !== expected.inviteId ||
      payload.target?.platformId !== expected.platformId ||
      normalizeHttpsOrigin(payload.target?.origin) !== normalizeHttpsOrigin(expected.origin)) throw new Error("target_mismatch");
  if (Date.parse(payload.expiresAt) <= now.getTime()) throw new Error("link_expired");
  if (!Number.isSafeInteger(payload.controllerEpoch) || payload.controllerEpoch < 0) throw new Error("invalid_controller_epoch");
  platformId(payload.source?.platformId);
  platformId(payload.target?.platformId);
  normalizeHttpsOrigin(payload.source?.origin);
  if (!/^[0-9a-f-]{36}$/i.test(payload.linkId) ||
      !/^[A-Za-z0-9._-]{8,200}$/.test(payload.agent?.installationId ?? "") ||
      typeof payload.agent?.name !== "string" || !payload.agent.name.trim() ||
      !/^[a-z0-9.-]{3,253}$/.test(payload.agent?.domain ?? "") ||
      !Array.isArray(payload.agent?.extraDomains) || payload.agent.extraDomains.length > 20 ||
      payload.agent.extraDomains.some(d => !/^[a-z0-9.-]{3,253}$/.test(d)) ||
      !["active", "suspended"].includes(payload.agent?.status) ||
      !["central", "external"].includes(payload.agent?.packageSource) ||
      ![payload.source.platformId, payload.target.platformId].includes(payload.activeControllerId) ||
      typeof payload.sourceSigningPublicKey !== "string" || payload.sourceSigningPublicKey.length < 40) {
    throw new Error("invalid_link_metadata");
  }
  if (payload.agent.licenseExpiresAt !== null &&
      !Number.isFinite(Date.parse(payload.agent.licenseExpiresAt))) throw new Error("invalid_license_expiry");
  if (!/^[a-f0-9]{64}$/.test(payload.agent?.licenseVerifier ?? "")) throw new Error("invalid_license_verifier");
  try {
    const key = createPublicKey({ key: Buffer.from(payload.sourceSigningPublicKey, "base64"), type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong_key_type");
  } catch { throw new Error("invalid_source_signing_public_key"); }
  const forbidden = canonical(payload).toLowerCase();
  if (forbidden.includes("licensekey") || forbidden.includes("dburl") || forbidden.includes("invitesecret") ||
      forbidden.includes("platformcontroltoken") || forbidden.includes("privatekey")) {
    throw new Error("secret_field_forbidden");
  }
  return file;
}

export function assertMonotonicEpoch(current: number, requested: number): void {
  if (!Number.isSafeInteger(requested) || requested <= current) throw new Error("controller_epoch_not_monotonic");
}

export function assertStoredInviteUsable(
  stored: { consumedAt: Date | null; expiresAt: Date; secretVerifier: string },
  inviteSecret: string,
  now = new Date(),
): void {
  if (stored.consumedAt) throw new Error("invite_already_consumed");
  if (stored.expiresAt.getTime() <= now.getTime()) throw new Error("invite_expired");
  if (!constantTimeHexEqual(sha256Verifier(inviteSecret), stored.secretVerifier)) {
    throw new Error("invalid_invite_secret");
  }
}