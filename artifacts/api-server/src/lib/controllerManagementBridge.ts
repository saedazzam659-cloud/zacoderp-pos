import { isIP } from "node:net";
import { isPublicControllerAddress } from "./controllerHandoff.js";
import { constantTimeHexEqual, normalizeHttpsOrigin, sha256Verifier } from "./agentControllerLinks.js";

/** Operations intentionally exposed across an imported controller link. */
export const MANAGEMENT_OPERATIONS = [
  "company.list", "company.get", "company.create", "company.update",
  "company.status", "company.delete",
  "user.list", "user.get", "user.create", "user.update", "user.status", "user.delete",
  "branch.list",
] as const;

export type ManagementOperation = typeof MANAGEMENT_OPERATIONS[number];

export class ManagementBridgeError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  constructor(code: string, httpStatus: number, message = code) {
    super(message);
    this.name = "ManagementBridgeError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function assertManagementOperation(value: unknown): ManagementOperation {
  if (typeof value !== "string" ||
      !(MANAGEMENT_OPERATIONS as readonly string[]).includes(value.trim())) {
    throw new ManagementBridgeError("unsupported_management_operation", 400);
  }
  return value.trim() as ManagementOperation;
}

type ManagementRecord = Record<string, any>;

function managementDate(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function pickManagementFields(value: unknown, fields: readonly string[]): ManagementRecord {
  const source = value && typeof value === "object" ? value as ManagementRecord : {};
  const result: ManagementRecord = {};
  for (const field of fields) {
    if (source[field] !== undefined) result[field] = managementDate(source[field]);
  }
  return result;
}

// These DTOs are intentionally allowlists, not a denylist layered over ORM
// rows. Adding a credential, OTP, ZATCA, branding, or runtime column to the
// schema therefore cannot make it cross the controller link by accident.
const COMPANY_MANAGEMENT_FIELDS = [
  "id", "code", "nameAr", "nameEn", "vatNumber", "crNumber", "phone",
  "city", "district", "street", "buildingNumber", "postalCode",
  "additionalNumber", "country", "industryName", "invoiceType", "isSandbox",
  "status", "rejectionReason", "createdAt", "updatedAt",
] as const;
const USER_MANAGEMENT_FIELDS = [
  "id", "username", "email", "role", "code", "nameAr", "nameEn", "isActive",
  "branchIds", "viewAllBranches", "scopeOwnCustomersOnly",
  "permissions", "postingPermissions", "mobilePermissions",
  "canApprove", "approvalLevel", "maxApprovalAmount", "requireSecondApproval",
  "lastLoginAt", "createdAt", "updatedAt",
] as const;
const BRANCH_MANAGEMENT_FIELDS = [
  "id", "code", "nameAr", "nameEn", "regionId", "companyId", "city",
  "address", "phone", "email", "isMain", "status", "notes", "createdAt", "updatedAt",
] as const;

function allowPayloadFields(value: unknown, fields: readonly string[]): ManagementRecord {
  const source = value && typeof value === "object" ? value as ManagementRecord : {};
  const result: ManagementRecord = {};
  for (const field of fields) {
    if (source[field] !== undefined) result[field] = source[field];
  }
  return result;
}

const COMPANY_UPDATE_FIELDS = COMPANY_MANAGEMENT_FIELDS.filter(field =>
  !["id", "code", "status", "rejectionReason", "createdAt", "updatedAt"].includes(field),
);
const USER_WRITE_FIELDS = [
  "id", "companyId", "username", "password", "email", "role", "code", "nameAr", "nameEn",
  "isActive", "branchIds", "permissions", "postingPermissions", "mobilePermissions",
  "viewAllBranches", "scopeOwnCustomersOnly", "canApprove", "approvalLevel",
  "maxApprovalAmount", "requireSecondApproval",
] as const;

/** Narrow request bodies before an existing router sees them as well. */
export function managementRequestPayload(operation: ManagementOperation | string, value: unknown): ManagementRecord {
  if (operation === "company.create") {
    return allowPayloadFields(value, [
      "nameAr", "nameEn", "vatNumber", "crNumber", "phone", "city", "district",
      "street", "buildingNumber", "postalCode", "country", "industryName",
      "invoiceType", "plan", "billingCycle", "username", "email", "password",
    ]);
  }
  if (operation === "company.update") {
    return allowPayloadFields(value, COMPANY_UPDATE_FIELDS);
  }
  if (operation === "company.get" || operation === "company.delete") {
    return allowPayloadFields(value, ["id"]);
  }
  if (operation === "company.status") {
    return allowPayloadFields(value, ["id", "status", "reason"]);
  }
  if (operation === "user.list" || operation === "branch.list") {
    return allowPayloadFields(value, ["companyId"]);
  }
  if (operation === "user.get" || operation === "user.delete") {
    return allowPayloadFields(value, ["id", "companyId"]);
  }
  if (operation === "user.create" || operation === "user.update") {
    return allowPayloadFields(value, USER_WRITE_FIELDS);
  }
  if (operation === "user.status") {
    return allowPayloadFields(value, ["id", "companyId", "isActive"]);
  }
  return {};
}

function companyManagementDto(value: unknown): ManagementRecord {
  return pickManagementFields(value, COMPANY_MANAGEMENT_FIELDS);
}
function userManagementDto(value: unknown): ManagementRecord {
  return pickManagementFields(value, USER_MANAGEMENT_FIELDS);
}
function branchManagementDto(value: unknown): ManagementRecord {
  return pickManagementFields(value, BRANCH_MANAGEMENT_FIELDS);
}

/** Convert every successful bridge result to the operation's narrow DTO. */
export function managementResponse(operation: ManagementOperation | string, value: any): unknown {
  if (operation === "company.list") {
    return Array.isArray(value) ? value.map(companyManagementDto) : [];
  }
  if (operation === "company.get" || operation === "company.update" || operation === "company.status") {
    return companyManagementDto(value);
  }
  if (operation === "company.create") {
    const company = value?.user?.company ?? value?.company;
    const user = value?.user;
    const response: ManagementRecord = { ok: true };
    if (company) response.company = companyManagementDto(company);
    if (user) response.user = userManagementDto(user);
    const companyId = company?.id ?? value?.companyId;
    const companyCode = company?.code ?? value?.companyCode;
    if (companyId !== undefined) response.companyId = companyId;
    if (companyCode !== undefined) response.companyCode = companyCode;
    return response;
  }
  if (operation === "user.list") {
    return Array.isArray(value) ? value.map(userManagementDto) : [];
  }
  if (operation === "user.get" || operation === "user.create") {
    return userManagementDto(value);
  }
  if (operation === "user.update" || operation === "user.status" || operation === "user.delete" || operation === "company.delete") {
    return { ok: true };
  }
  if (operation === "branch.list") {
    return Array.isArray(value) ? value.map(branchManagementDto) : [];
  }
  return { ok: true };
}

export function assertPlatformControlToken(token: unknown, verifier: string | null | undefined): void {
  if (typeof token !== "string" || !verifier || !constantTimeHexEqual(sha256Verifier(token), verifier)) {
    throw new ManagementBridgeError("platform_control_token_mismatch", 403);
  }
}

/**
 * Browser requests are authenticated by the target router, but this explicit
 * guard remains at the capability boundary as defense in depth if the route
 * is ever remounted or called from another router.
 */
export function assertTargetManagementAccess(args: {
  actor: { role?: string } | null | undefined;
  link: { direction: string; targetPlatformId: string; targetOrigin: string; activeControllerId: string; status?: string | null; licenseExpiresAt?: Date | null };
  identity: { platformId: string; origin: string };
  now?: Date;
}): void {
  if (!args.actor) throw new ManagementBridgeError("authentication_required", 401);
  if (args.actor.role !== "superadmin") throw new ManagementBridgeError("superadmin_required", 403);
  if (args.link.direction !== "imported") throw new ManagementBridgeError("controller_link_not_found", 404);
  let targetOrigin: string;
  try { targetOrigin = normalizeHttpsOrigin(args.link.targetOrigin); }
  catch { throw new ManagementBridgeError("target_platform_mismatch", 403); }
  if (args.link.targetPlatformId !== args.identity.platformId || targetOrigin !== args.identity.origin) {
    throw new ManagementBridgeError("target_platform_mismatch", 403);
  }
  if (args.link.activeControllerId !== args.identity.platformId) {
    throw new ManagementBridgeError("inactive_controller", 409);
  }
  if (args.link.status && args.link.status !== "active") {
    throw new ManagementBridgeError("linked_agent_inactive", 403);
  }
  if (args.link.licenseExpiresAt && args.link.licenseExpiresAt < (args.now ?? new Date())) {
    throw new ManagementBridgeError("license_expired", 403);
  }
}

export function assertSourceManagementAccess(args: {
  link: {
    direction: string; sourcePlatformId: string; sourceOrigin: string;
    targetPlatformId: string; targetOrigin: string; installationId: string;
    domain: string; dbFingerprint?: string | null; controllerEpoch: number;
    activeControllerId: string; status?: string | null; licenseExpiresAt?: Date | null;
  };
  localPlatformId: string;
  requesterPlatformId: string;
  requesterOrigin: string;
  installationId: unknown;
  domain: string;
  dbFingerprint: unknown;
  controllerEpoch: unknown;
  activeControllerId: unknown;
}): void {
  const link = args.link;
  if (link.direction !== "outbound") throw new ManagementBridgeError("controller_link_not_found", 404);
  if (link.status && link.status !== "active") {
    throw new ManagementBridgeError("linked_agent_inactive", 403);
  }
  if (link.licenseExpiresAt && link.licenseExpiresAt < new Date()) {
    throw new ManagementBridgeError("license_expired", 403);
  }
  let expectedTargetOrigin: string;
  try { expectedTargetOrigin = normalizeHttpsOrigin(link.targetOrigin); }
  catch { throw new ManagementBridgeError("controller_identity_mismatch", 403); }
  if (link.sourcePlatformId !== args.localPlatformId ||
      link.targetPlatformId !== args.requesterPlatformId ||
      args.requesterOrigin !== expectedTargetOrigin) {
    throw new ManagementBridgeError("controller_identity_mismatch", 403);
  }
  if (args.installationId !== link.installationId ||
      args.domain !== link.domain ||
      (link.dbFingerprint && args.dbFingerprint !== link.dbFingerprint)) {
    throw new ManagementBridgeError("controller_identity_mismatch", 403);
  }
  const epoch = Number(args.controllerEpoch);
  if (!Number.isSafeInteger(epoch) || epoch !== link.controllerEpoch ||
      String(args.activeControllerId ?? "") !== link.activeControllerId) {
    throw new ManagementBridgeError("controller_state_mismatch", 409);
  }
  if (link.activeControllerId !== link.targetPlatformId) {
    throw new ManagementBridgeError("inactive_controller", 409);
  }
}

/**
 * The link row is control-plane metadata, not proof that the current
 * agent_instances row still points at the same installation/database. This
 * fence must run before any external DB URL is handed to getAgentDbContext.
 */
export function assertLiveInstanceMatchesLink(args: {
  instance: { installationId: string; domain: string; dbFingerprint?: string | null };
  link: { installationId: string; domain: string; dbFingerprint?: string | null };
}): void {
  if (args.instance.installationId !== args.link.installationId ||
      args.instance.domain !== args.link.domain ||
      (args.instance.dbFingerprint ?? null) !== (args.link.dbFingerprint ?? null)) {
    throw new ManagementBridgeError("controller_identity_mismatch", 403);
  }
}

/** Reject unsafe controller origins before DNS resolution and pinning. */
export function assertPublicControllerOrigin(value: string): URL {
  let normalized: string;
  try { normalized = normalizeHttpsOrigin(value); }
  catch { throw new ManagementBridgeError("target_origin_must_be_https", 400); }
  const url = new URL(normalized);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname === "metadata.google.internal") {
    throw new ManagementBridgeError("target_private_address", 400);
  }
  const ipKind = isIP(hostname);
  if (ipKind && !isPublicControllerAddress(hostname)) {
    throw new ManagementBridgeError("target_private_address", 400);
  }
  return url;
}

/** Responses may include full ORM rows; never let credentials or branding
 * escape the source platform, including when nested in an array/object. */
export function safeManagementValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeManagementValue);
  if (!value || typeof value !== "object") return value;
  const forbidden = /^(?:token|password|passwordHash|sessionToken|sessionId|currentSessionId|logo(?:Url|Data|Path)?|brand(?:Name|Logo|Color|Url|ing)?|branding|favicon(?:Url)?|zatca.*|backup(?:Email|Whatsapp)Otp.*|senderSmtpPassEnc|proxySecret|dbUrl(?:Enc)?|sshSecret(?:Enc)?|privateKey|apiKey|apiSecret|accessToken|refreshToken|platformControlToken|controllerToken)$/i;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !forbidden.test(key))
    .map(([key, item]) => [key, safeManagementValue(item)]));
}
