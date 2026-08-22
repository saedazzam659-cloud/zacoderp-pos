import crypto from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  db,
  branchesTable,
  companiesTable,
  demoDevicePairCodesTable,
  demoDeviceWorkspacesTable,
  userBranchesTable,
  usersTable,
} from "@workspace/db";

const DEVICE_TOKEN_MIN = 24;
const DEVICE_TOKEN_MAX = 256;
export const DEMO_BROWSER_COOKIE = "zacode_demo_browser";

/**
 * Emergency performance switch for the demo workspace feature.
 *
 * The default stays enabled so existing installations retain their policy.
 * Setting DEMO_DEVICE_ISOLATION_ENABLED=false bypasses device workspace
 * resolution and browser-cookie binding without deleting any demo data.
 */
export function isDemoDeviceIsolationEnabled(): boolean {
  return process.env.DEMO_DEVICE_ISOLATION_ENABLED !== "false";
}

export class DemoDeviceError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "DEMO_BROWSER_ERROR",
  ) {
    super(message);
    this.name = "DemoDeviceError";
  }
}

const sha256 = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

const validDeviceToken = (value: unknown): value is string =>
  typeof value === "string"
  && value.length >= DEVICE_TOKEN_MIN
  && value.length <= DEVICE_TOKEN_MAX
  && /^[A-Za-z0-9_-]+$/.test(value);

export function readDemoBrowserCookie(rawHeader: string | undefined): string | undefined {
  if (!rawHeader) return undefined;
  for (const part of rawHeader.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey !== DEMO_BROWSER_COOKIE) continue;
    try {
      const value = decodeURIComponent(rest.join("="));
      return validDeviceToken(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface DemoBrowserLoginPreflight {
  needsPreparation: boolean;
  transferRequired: boolean;
}

/**
 * Credential-gated, read-only login probe. It distinguishes a first browser
 * from a different browser attempting to take over an existing demo session,
 * without revoking or otherwise mutating the active binding.
 */
export async function getDemoBrowserLoginPreflight(
  sourceUser: SourceUser,
  rawDeviceToken: unknown,
): Promise<DemoBrowserLoginPreflight> {
  if (!isDemoDeviceIsolationEnabled() || !sourceUser.demoDeviceIsolation) {
    return { needsPreparation: false, transferRequired: false };
  }

  const tokenHash = validDeviceToken(rawDeviceToken) ? sha256(rawDeviceToken) : null;
  const [current, active] = await Promise.all([
    tokenHash
      ? db.select({
          status: demoDeviceWorkspacesTable.status,
          revokedAt: demoDeviceWorkspacesTable.revokedAt,
        }).from(demoDeviceWorkspacesTable).where(and(
          eq(demoDeviceWorkspacesTable.sourceUserId, sourceUser.id),
          eq(demoDeviceWorkspacesTable.deviceTokenHash, tokenHash),
        )).limit(1)
      : Promise.resolve([]),
    db.select({ id: demoDeviceWorkspacesTable.id })
      .from(demoDeviceWorkspacesTable)
      .where(and(
        eq(demoDeviceWorkspacesTable.sourceUserId, sourceUser.id),
        isNull(demoDeviceWorkspacesTable.revokedAt),
        ne(demoDeviceWorkspacesTable.status, "failed"),
      ))
      .limit(1),
  ]);

  const currentBinding = current[0];
  if (currentBinding?.status === "ready" && currentBinding.revokedAt == null) {
    return { needsPreparation: false, transferRequired: false };
  }
  if (active.length > 0) {
    return { needsPreparation: false, transferRequired: true };
  }
  return { needsPreparation: true, transferRequired: false };
}

export async function needsDemoDevicePreparation(
  sourceUser: SourceUser,
  rawDeviceToken: unknown,
): Promise<boolean> {
  return (await getDemoBrowserLoginPreflight(sourceUser, rawDeviceToken)).needsPreparation;
}

export async function verifyStrictDemoBrowserBinding(
  sourceUserId: number,
  rawDeviceToken: string | undefined,
): Promise<boolean> {
  if (!validDeviceToken(rawDeviceToken)) return false;
  const [binding] = await db.select({ id: demoDeviceWorkspacesTable.id })
    .from(demoDeviceWorkspacesTable)
    .where(and(
      eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
      eq(demoDeviceWorkspacesTable.workspaceUserId, sourceUserId),
      eq(demoDeviceWorkspacesTable.deviceTokenHash, sha256(rawDeviceToken)),
      eq(demoDeviceWorkspacesTable.isPrimary, true),
      eq(demoDeviceWorkspacesTable.status, "ready"),
      isNull(demoDeviceWorkspacesTable.revokedAt),
    ))
    .limit(1);
  return !!binding;
}

export const generateDemoDeviceToken = () =>
  crypto.randomBytes(32).toString("base64url");

function requestLabel(userAgent?: string | null): string {
  const ua = String(userAgent ?? "");
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "متصفح";
  const os = /Windows/i.test(ua) ? "Windows"
    : /Android/i.test(ua) ? "Android"
    : /iPhone|iPad/i.test(ua) ? "iOS"
    : /Mac OS/i.test(ua) ? "macOS"
    : /Linux/i.test(ua) ? "Linux"
    : "";
  return [browser, os].filter(Boolean).join(" — ");
}

type SourceUser = typeof usersTable.$inferSelect;

async function copyBranchScope(source: SourceUser, targetUserId: number, targetCompanyId: number) {
  if (source.viewAllBranches) return;
  const sourceLinks = await db.select({ branchId: userBranchesTable.branchId })
    .from(userBranchesTable)
    .where(eq(userBranchesTable.userId, source.id));
  if (!sourceLinks.length) return;
  const sourceBranches = await db.select({ code: branchesTable.code })
    .from(branchesTable)
    .where(inArray(branchesTable.id, sourceLinks.map((r) => r.branchId)));
  const codes = sourceBranches.map((r) => r.code).filter((v): v is string => !!v);
  if (!codes.length) return;
  const targetBranches = await db.select({ id: branchesTable.id })
    .from(branchesTable)
    .where(and(
      eq(branchesTable.companyId, targetCompanyId),
      inArray(branchesTable.code, codes),
    ));
  for (const branch of targetBranches) {
    await db.insert(userBranchesTable)
      .values({ userId: targetUserId, branchId: branch.id })
      .onConflictDoNothing();
  }
}

async function syncShadowUser(
  source: SourceUser,
  workspaceUserId: number,
  workspaceCompanyId: number,
  activeLinkId?: number,
) {
  const updated = await db.update(usersTable).set({
    role: source.role === "superadmin" ? "admin" : source.role,
    email: null,
    code: source.code,
    nameAr: source.nameAr,
    nameEn: source.nameEn,
    permissions: source.permissions,
    postingPermissions: source.postingPermissions,
    mobilePermissions: source.mobilePermissions,
    viewAllBranches: source.viewAllBranches,
    scopeOwnCustomersOnly: source.scopeOwnCustomersOnly,
    canApprove: source.canApprove,
    approvalLevel: source.approvalLevel,
    maxApprovalAmount: source.maxApprovalAmount,
    requireSecondApproval: source.requireSecondApproval,
    isActive: source.isActive && source.demoDeviceIsolation,
    isDemoShadow: true,
    updatedAt: new Date(),
  }).where(and(
    eq(usersTable.id, workspaceUserId),
    activeLinkId == null
      ? undefined
      : sql`EXISTS (
          SELECT 1
            FROM ${demoDeviceWorkspacesTable} ddw
           WHERE ddw.id = ${activeLinkId}
             AND ddw.source_user_id = ${source.id}
             AND ddw.workspace_user_id = ${workspaceUserId}
             AND ddw.status = 'ready'
             AND ddw.revoked_at IS NULL
        )`,
  )).returning({ id: usersTable.id });
  if (activeLinkId != null && updated.length === 0) {
    throw new DemoDeviceError("تم إلغاء ربط هذا الجهاز. احذف بيانات الموقع ثم سجّل الدخول مجددًا.", 403);
  }
  await copyBranchScope(source, workspaceUserId, workspaceCompanyId);
  const [shadow] = await db.select().from(usersTable).where(eq(usersTable.id, workspaceUserId));
  if (!shadow?.isActive) throw new DemoDeviceError("تم تعطيل مساحة الديمو لهذا المستخدم", 403);
  return shadow;
}

/**
 * Keep an already-open demo workspace aligned with permission edits made on
 * its source user. Login-time synchronization alone is not enough: admins can
 * change RBAC while the retained shadow session is still active.
 */
export async function propagateDemoSourcePermissions(
  sourceUserId: number,
  permissions: SourceUser["permissions"],
): Promise<{ workspaceCompanyIds: number[]; workspaceUserIds: number[] }> {
  const links = await db.select({
    workspaceCompanyId: demoDeviceWorkspacesTable.workspaceCompanyId,
    workspaceUserId: demoDeviceWorkspacesTable.workspaceUserId,
  }).from(demoDeviceWorkspacesTable).where(and(
    eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
    eq(demoDeviceWorkspacesTable.status, "ready"),
    isNull(demoDeviceWorkspacesTable.revokedAt),
  ));

  const workspaceUserIds = [...new Set(
    links
      .map((link) => link.workspaceUserId)
      .filter((id): id is number => id != null && id !== sourceUserId),
  )];
  const workspaceCompanyIds = [...new Set(
    links
      .map((link) => link.workspaceCompanyId)
      .filter((id): id is number => id != null),
  )];

  if (workspaceUserIds.length) {
    await db.update(usersTable).set({
      permissions,
      updatedAt: new Date(),
    }).where(and(
      inArray(usersTable.id, workspaceUserIds),
      eq(usersTable.isDemoShadow, true),
    ));
  }

  return { workspaceCompanyIds, workspaceUserIds };
}

/**
 * Company menu grants are the upper permission bound for normal users. Mirror
 * them into retained demo workspace companies so a source-company toggle does
 * not remain visible only to admins (who bypass per-user RBAC).
 */
export async function propagateDemoWorkspaceMenuPermissions(
  sourceCompanyId: number,
  menuPermissions: string,
): Promise<number[]> {
  const links = await db.select({
    workspaceCompanyId: demoDeviceWorkspacesTable.workspaceCompanyId,
  }).from(demoDeviceWorkspacesTable).where(and(
    eq(demoDeviceWorkspacesTable.sourceCompanyId, sourceCompanyId),
    eq(demoDeviceWorkspacesTable.status, "ready"),
    isNull(demoDeviceWorkspacesTable.revokedAt),
  ));

  const workspaceCompanyIds = [...new Set(
    links
      .map((link) => link.workspaceCompanyId)
      .filter((id): id is number => id != null && id !== sourceCompanyId),
  )];

  if (workspaceCompanyIds.length) {
    await db.update(companiesTable).set({
      menuPermissions,
      updatedAt: new Date(),
    }).where(inArray(companiesTable.id, workspaceCompanyIds));
  }

  return workspaceCompanyIds;
}

async function syncRetainedWorkspaceMenuPermissions(
  sourceCompanyId: number,
  workspaceCompanyId: number,
): Promise<void> {
  if (sourceCompanyId === workspaceCompanyId) return;
  const [sourceCompany, workspaceCompany] = await Promise.all([
    db.select({
      menuPermissions: companiesTable.menuPermissions,
    }).from(companiesTable).where(eq(companiesTable.id, sourceCompanyId)).limit(1),
    db.select({
      menuPermissions: companiesTable.menuPermissions,
    }).from(companiesTable).where(eq(companiesTable.id, workspaceCompanyId)).limit(1),
  ]).then(([sourceRows, workspaceRows]) => [sourceRows[0], workspaceRows[0]]);
  if (!sourceCompany || !workspaceCompany) return;
  if (sourceCompany.menuPermissions === workspaceCompany.menuPermissions) return;
  await db.update(companiesTable).set({
    menuPermissions: sourceCompany.menuPermissions,
    updatedAt: new Date(),
  }).where(eq(companiesTable.id, workspaceCompanyId));
}

/**
 * Self-heal a retained shadow when `/auth/me` is refreshed. This repairs
 * workspaces that were already stale before the propagation hooks were
 * deployed, without requiring the admin to toggle permissions a second time.
 */
export async function refreshDemoShadowAuthorization<
  T extends { id: number; isDemoShadow?: boolean },
>(user: T): Promise<T | SourceUser> {
  if (!user.isDemoShadow) return user;
  const [link] = await db.select().from(demoDeviceWorkspacesTable).where(and(
    eq(demoDeviceWorkspacesTable.workspaceUserId, user.id),
    eq(demoDeviceWorkspacesTable.status, "ready"),
    isNull(demoDeviceWorkspacesTable.revokedAt),
  )).limit(1);
  if (!link?.workspaceCompanyId) return user;
  const [source] = await db.select().from(usersTable)
    .where(eq(usersTable.id, link.sourceUserId))
    .limit(1);
  if (!source) return user;
  await syncRetainedWorkspaceMenuPermissions(
    link.sourceCompanyId,
    link.workspaceCompanyId,
  );
  return syncShadowUser(
    source,
    user.id,
    link.workspaceCompanyId,
    link.id,
  );
}

async function loadReadyWorkspace(source: SourceUser, link: typeof demoDeviceWorkspacesTable.$inferSelect) {
  if (link.revokedAt || link.status === "revoked") {
    throw new DemoDeviceError("تم إلغاء ربط هذا الجهاز. احذف بيانات الموقع ثم سجّل الدخول مجددًا.", 403);
  }
  if (link.status !== "ready" || !link.workspaceCompanyId || !link.workspaceUserId) {
    throw new DemoDeviceError(
      link.status === "failed"
        ? "تعذر إنشاء مساحة الديمو لهذا الجهاز. حاول بجهاز جديد أو تواصل مع المسؤول."
        : "مساحة الديمو قيد التجهيز. حاول تسجيل الدخول مرة أخرى بعد لحظات.",
      link.status === "failed" ? 500 : 409,
    );
  }
  if (link.workspaceCompanyId !== source.companyId && source.companyId != null) {
    await syncRetainedWorkspaceMenuPermissions(source.companyId, link.workspaceCompanyId);
  }
  const effectiveUser = link.workspaceUserId === source.id
    ? source
    : await syncShadowUser(source, link.workspaceUserId, link.workspaceCompanyId, link.id);
  const touched = await db.update(demoDeviceWorkspacesTable).set({
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(demoDeviceWorkspacesTable.id, link.id),
    eq(demoDeviceWorkspacesTable.status, "ready"),
    isNull(demoDeviceWorkspacesTable.revokedAt),
  )).returning({ id: demoDeviceWorkspacesTable.id });
  if (touched.length === 0) {
    throw new DemoDeviceError("تم إلغاء ربط هذا الجهاز. احذف بيانات الموقع ثم سجّل الدخول مجددًا.", 403);
  }
  return effectiveUser;
}

export interface ResolveDemoLoginInput {
  sourceUser: SourceUser;
  deviceToken?: unknown;
  pairCode?: unknown;
  confirmTransfer?: unknown;
  sessionIssue?: {
    sessionToken: string;
    sessionId: string;
    sessionChannel: "web" | "mobile";
    issuedAt: Date;
  };
  deviceLabel?: unknown;
  userAgent?: string | null;
  ip?: string | null;
}

/**
 * One-browser demo handoff policy:
 *   • The first browser becomes the active primary binding.
 *   • The active browser can sign in again without confirmation.
 *   • A different browser must explicitly confirm a transfer. That revokes
 *     every prior binding/session and makes the new browser primary.
 * The per-browser token lives in an HttpOnly cookie and is ALSO re-verified
 * on every authenticated request (see middleware/auth.ts), so a copied
 * bearer token alone is useless in another browser.
 */
export async function resolveDemoDeviceLogin(input: ResolveDemoLoginInput): Promise<{
  effectiveUser: SourceUser;
  deviceToken: string | null;
  deviceLinkId: number | null;
  workspaceCompanyId: number | null;
  isPrimary: boolean;
  bindingWasCreated: boolean;
  sessionIssuedAtomically: boolean;
}> {
  const source = input.sourceUser;
  if (!isDemoDeviceIsolationEnabled() || !source.demoDeviceIsolation) {
    return {
      effectiveUser: source,
      deviceToken: null,
      deviceLinkId: null,
      workspaceCompanyId: source.companyId,
      isPrimary: true,
      bindingWasCreated: false,
      sessionIssuedAtomically: false,
    };
  }
  if (source.isDemoShadow || !source.companyId) {
    throw new DemoDeviceError("لا يمكن تسجيل الدخول المباشر إلى مستخدم مساحة ديمو", 403, "DEMO_SHADOW_LOGIN_DENIED");
  }

  let deviceToken = validDeviceToken(input.deviceToken)
    ? input.deviceToken
    : generateDemoDeviceToken();
  let deviceTokenHash = sha256(deviceToken);
  const label = typeof input.deviceLabel === "string" && input.deviceLabel.trim()
    ? input.deviceLabel.trim().slice(0, 180)
    : requestLabel(input.userAgent);

  const [existing] = await db.select().from(demoDeviceWorkspacesTable).where(and(
    eq(demoDeviceWorkspacesTable.sourceUserId, source.id),
    eq(demoDeviceWorkspacesTable.deviceTokenHash, deviceTokenHash),
  ));
  if (existing?.status === "ready" && existing.revokedAt == null) {
    const effectiveUser = await loadReadyWorkspace(source, existing);
    await db.update(demoDeviceWorkspacesTable).set({
      deviceLabel: label,
      userAgent: input.userAgent ?? null,
      lastIp: input.ip ?? null,
    }).where(eq(demoDeviceWorkspacesTable.id, existing.id));
    return {
      effectiveUser,
      deviceToken,
      deviceLinkId: existing.id,
      workspaceCompanyId: existing.workspaceCompanyId,
      isPrimary: existing.isPrimary,
      bindingWasCreated: false,
      sessionIssuedAtomically: false,
    };
  }
  if (existing && existing.revokedAt == null && existing.status === "provisioning") {
    throw new DemoDeviceError(
      "مساحة الديمو قيد التجهيز. حاول تسجيل الدخول مرة أخرى بعد لحظات.",
      409,
      "DEMO_BROWSER_PREPARING",
    );
  }
  // A revoked/failed row owns its old token hash forever as history. Rotate
  // the requesting browser to a fresh cookie rather than asking it to clear
  // site data or colliding with the unique (source, token_hash) index.
  if (existing) {
    deviceToken = generateDemoDeviceToken();
    deviceTokenHash = sha256(deviceToken);
  }

  const claim = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${90_000_000 + source.id})`);

    const [raced] = await tx.select().from(demoDeviceWorkspacesTable).where(and(
      eq(demoDeviceWorkspacesTable.sourceUserId, source.id),
      eq(demoDeviceWorkspacesTable.deviceTokenHash, deviceTokenHash),
    ));
    if (raced?.status === "ready" && raced.revokedAt == null) {
      return { link: raced, created: false, sessionIssuedAtomically: false, effectiveUser: null };
    }
    if (raced && raced.revokedAt == null && raced.status === "provisioning") {
      throw new DemoDeviceError(
        "مساحة الديمو قيد التجهيز. حاول تسجيل الدخول مرة أخرى بعد لحظات.",
        409,
        "DEMO_BROWSER_PREPARING",
      );
    }

    const active = await tx.select({
      id: demoDeviceWorkspacesTable.id,
      workspaceUserId: demoDeviceWorkspacesTable.workspaceUserId,
      workspaceCompanyId: demoDeviceWorkspacesTable.workspaceCompanyId,
      isPrimary: demoDeviceWorkspacesTable.isPrimary,
      status: demoDeviceWorkspacesTable.status,
      lastSeenAt: demoDeviceWorkspacesTable.lastSeenAt,
    }).from(demoDeviceWorkspacesTable).where(and(
      eq(demoDeviceWorkspacesTable.sourceUserId, source.id),
      isNull(demoDeviceWorkspacesTable.revokedAt),
      ne(demoDeviceWorkspacesTable.status, "failed"),
    ));
    if (active.length > 0 && input.confirmTransfer !== true) {
      throw new DemoDeviceError(
        "يوجد تسجيل ديمو نشط في متصفح آخر. أكد نقل الجلسة إلى هذا المتصفح للمتابعة.",
        409,
        "DEMO_SESSION_TRANSFER_REQUIRED",
      );
    }
    if (active.length > 0 && !input.sessionIssue) {
      throw new DemoDeviceError(
        "تعذر إصدار جلسة النقل بصورة آمنة. حاول تسجيل الدخول مرة أخرى.",
        500,
        "DEMO_SESSION_ISSUE_REQUIRED",
      );
    }

    const transferTarget = active
      .filter((row) =>
        row.status === "ready"
        && row.workspaceUserId != null
        && row.workspaceCompanyId != null)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0];
    if (active.length > 0 && !transferTarget) {
      throw new DemoDeviceError(
        "مساحة الديمو قيد التجهيز. حاول تسجيل الدخول مرة أخرى بعد لحظات.",
        409,
        "DEMO_BROWSER_PREPARING",
      );
    }

    if (active.length > 0) {
      const now = new Date();
      await tx.update(demoDeviceWorkspacesTable).set({
        status: "revoked",
        revokedAt: now,
        updatedAt: now,
      }).where(and(
        eq(demoDeviceWorkspacesTable.sourceUserId, source.id),
        isNull(demoDeviceWorkspacesTable.revokedAt),
        ne(demoDeviceWorkspacesTable.status, "failed"),
      ));
      await tx.update(demoDevicePairCodesTable).set({ usedAt: now }).where(and(
        eq(demoDevicePairCodesTable.sourceUserId, source.id),
        isNull(demoDevicePairCodesTable.usedAt),
      ));

      const shadowUserIds = active
        .map((row) => row.workspaceUserId)
        .filter((id): id is number => id != null && id !== source.id);
      const retainedShadowUserId = transferTarget?.workspaceUserId === source.id
        ? null
        : transferTarget?.workspaceUserId ?? null;
      const shadowUserIdsToDisable = shadowUserIds.filter((id) => id !== retainedShadowUserId);
      await tx.update(usersTable).set({
        sessionToken: null,
        sessionId: null,
        updatedAt: now,
      }).where(eq(usersTable.id, source.id));
      if (shadowUserIdsToDisable.length > 0) {
        await tx.update(usersTable).set({
          isActive: false,
          sessionToken: null,
          sessionId: null,
          updatedAt: now,
        }).where(inArray(usersTable.id, shadowUserIdsToDisable));
      }
    }

    const workspaceCompanyId = transferTarget?.workspaceCompanyId ?? source.companyId;
    const workspaceUserId = transferTarget?.workspaceUserId ?? source.id;
    const [link] = await tx.insert(demoDeviceWorkspacesTable).values({
      sourceUserId: source.id,
      sourceCompanyId: source.companyId!,
      workspaceCompanyId,
      workspaceUserId,
      deviceTokenHash,
      deviceLabel: label,
      userAgent: input.userAgent ?? null,
      firstIp: input.ip ?? null,
      lastIp: input.ip ?? null,
      isPrimary: workspaceUserId === source.id,
      status: "ready",
    }).returning();

    let effectiveUser: SourceUser | null = null;
    let sessionIssuedAtomically = false;
    if (active.length > 0) {
      const sessionIssue = input.sessionIssue!;
      const [issuedUser] = await tx.update(usersTable).set({
        ...(workspaceUserId === source.id
          ? {}
          : {
              role: source.role === "superadmin" ? "admin" : source.role,
              email: null,
              code: source.code,
              nameAr: source.nameAr,
              nameEn: source.nameEn,
              permissions: source.permissions,
              postingPermissions: source.postingPermissions,
              mobilePermissions: source.mobilePermissions,
              viewAllBranches: source.viewAllBranches,
              scopeOwnCustomersOnly: source.scopeOwnCustomersOnly,
              canApprove: source.canApprove,
              approvalLevel: source.approvalLevel,
              maxApprovalAmount: source.maxApprovalAmount,
              requireSecondApproval: source.requireSecondApproval,
              isActive: true,
              isDemoShadow: true,
            }),
        sessionToken: sessionIssue.sessionToken,
        sessionId: sessionIssue.sessionId,
        sessionChannel: sessionIssue.sessionChannel,
        lastLoginAt: sessionIssue.issuedAt,
        updatedAt: sessionIssue.issuedAt,
      }).where(and(
        eq(usersTable.id, workspaceUserId),
        eq(usersTable.isActive, true),
      )).returning();
      if (!issuedUser) {
        throw new DemoDeviceError(
          "تعذر إصدار جلسة المتصفح الجديد؛ لم يتم إلغاء الجلسة السابقة.",
          403,
          "DEMO_SESSION_ISSUE_FAILED",
        );
      }
      effectiveUser = issuedUser;
      sessionIssuedAtomically = true;
    }
    return { link, created: true, sessionIssuedAtomically, effectiveUser };
  });

  const effectiveUser = claim.effectiveUser ?? await loadReadyWorkspace(source, claim.link);
  return {
    effectiveUser,
    deviceToken,
    deviceLinkId: claim.link.id,
    workspaceCompanyId: claim.link.workspaceCompanyId,
    isPrimary: claim.link.isPrimary,
    bindingWasCreated: claim.created,
    sessionIssuedAtomically: claim.sessionIssuedAtomically,
  };
}

/**
 * Compensation path for a failed login (e.g. session write failed): delete
 * the freshly-created link row instead of revoking it — revoking would lock
 * the browser out forever because the cookie token stays in the browser.
 * A shadow user, if one was already provisioned, is deactivated.
 */
export async function releaseDemoDeviceLink(sourceUserId: number, linkId: number) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${90_000_000 + sourceUserId})`);
    const [link] = await tx.delete(demoDeviceWorkspacesTable).where(and(
      eq(demoDeviceWorkspacesTable.id, linkId),
      eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
    )).returning();
    if (link?.workspaceUserId && link.workspaceUserId !== sourceUserId) {
      await tx.update(usersTable).set({
        isActive: false,
        sessionToken: null,
        sessionId: null,
        updatedAt: new Date(),
      }).where(eq(usersTable.id, link.workspaceUserId));
    }
  });
}

/**
 * For an authenticated demo SHADOW session, verify the browser cookie still
 * matches the device link that owns this shadow user. Returns the source
 * user id when valid, otherwise null (the middleware must reject).
 */
export async function resolveDemoShadowBinding(
  workspaceUserId: number,
  rawCookieToken: string | undefined,
): Promise<number | null> {
  if (!validDeviceToken(rawCookieToken)) return null;
  const [link] = await db.select({
    sourceUserId: demoDeviceWorkspacesTable.sourceUserId,
  }).from(demoDeviceWorkspacesTable).where(and(
    eq(demoDeviceWorkspacesTable.workspaceUserId, workspaceUserId),
    eq(demoDeviceWorkspacesTable.deviceTokenHash, sha256(rawCookieToken)),
    eq(demoDeviceWorkspacesTable.status, "ready"),
    isNull(demoDeviceWorkspacesTable.revokedAt),
  )).limit(1);
  return link?.sourceUserId ?? null;
}


export async function listDemoDevices(sourceUserId: number) {
  return db.select({
    id: demoDeviceWorkspacesTable.id,
    deviceLabel: demoDeviceWorkspacesTable.deviceLabel,
    isPrimary: demoDeviceWorkspacesTable.isPrimary,
    status: demoDeviceWorkspacesTable.status,
    revokedAt: demoDeviceWorkspacesTable.revokedAt,
    lastSeenAt: demoDeviceWorkspacesTable.lastSeenAt,
    lastIp: demoDeviceWorkspacesTable.lastIp,
    userAgent: demoDeviceWorkspacesTable.userAgent,
    createdAt: demoDeviceWorkspacesTable.createdAt,
    workspaceCompanyId: demoDeviceWorkspacesTable.workspaceCompanyId,
    workspaceName: companiesTable.nameAr,
  }).from(demoDeviceWorkspacesTable)
    .leftJoin(companiesTable, eq(companiesTable.id, demoDeviceWorkspacesTable.workspaceCompanyId))
    .where(eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId))
    .orderBy(desc(demoDeviceWorkspacesTable.lastSeenAt));
}

export async function createDemoPairCode(sourceUserId: number, deviceId: number) {
  void sourceUserId;
  void deviceId;
  throw new DemoDeviceError(
    "رموز الربط لم تعد مستخدمة. يمكن نقل جلسة الديمو من شاشة تسجيل الدخول.",
    410,
    "DEMO_PAIRING_DISABLED",
  );
}

export async function revokeDemoDevice(sourceUserId: number, deviceId: number) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${90_000_000 + sourceUserId})`);
    const [device] = await tx.update(demoDeviceWorkspacesTable).set({
      status: "revoked",
      revokedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(demoDeviceWorkspacesTable.id, deviceId),
      eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
    )).returning();
    if (!device) throw new DemoDeviceError("الجهاز غير موجود", 404);
    await tx.update(demoDevicePairCodesTable).set({ usedAt: new Date() }).where(and(
      eq(demoDevicePairCodesTable.createdByDeviceId, deviceId),
      isNull(demoDevicePairCodesTable.usedAt),
    ));
    if (device.workspaceUserId) {
      await tx.update(usersTable).set({
        sessionToken: null,
        sessionId: null,
        ...(device.workspaceUserId === sourceUserId ? {} : { isActive: false }),
        updatedAt: new Date(),
      }).where(eq(usersTable.id, device.workspaceUserId));
    }
    return device;
  });
}

export async function revokeAllDemoDevices(sourceUserId: number) {
  const devices = await db.select().from(demoDeviceWorkspacesTable)
    .where(eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId));
  for (const device of devices) {
    if (!device.revokedAt) await revokeDemoDevice(sourceUserId, device.id);
  }
  await db.update(demoDevicePairCodesTable).set({ usedAt: new Date() }).where(and(
    eq(demoDevicePairCodesTable.sourceUserId, sourceUserId),
    isNull(demoDevicePairCodesTable.usedAt),
  ));
}

/**
 * Preserve the source user's display identity while retaining the shadow
 * user's id/companyId for authorization and tenant routing.
 */
export async function decorateDemoShadowUser<T extends { id: number; isDemoShadow?: boolean }>(
  user: T,
): Promise<T & { demoSourceUserId?: number; demoDeviceIsolation?: boolean }> {
  if (!user.isDemoShadow) return user;
  const [link] = await db.select({
    sourceUserId: demoDeviceWorkspacesTable.sourceUserId,
  }).from(demoDeviceWorkspacesTable).where(and(
    eq(demoDeviceWorkspacesTable.workspaceUserId, user.id),
    eq(demoDeviceWorkspacesTable.status, "ready"),
    isNull(demoDeviceWorkspacesTable.revokedAt),
  )).limit(1);
  if (!link) return user;
  return { ...user, demoSourceUserId: link.sourceUserId };
}