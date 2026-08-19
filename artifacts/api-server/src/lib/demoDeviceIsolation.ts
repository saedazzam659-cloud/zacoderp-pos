import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  db,
  branchesTable,
  companiesTable,
  demoDevicePairCodesTable,
  demoDeviceWorkspacesTable,
  userBranchesTable,
  usersTable,
} from "@workspace/db";
import { cloneCompany } from "./cloneCompany.js";

const DEVICE_TOKEN_MIN = 24;
const DEVICE_TOKEN_MAX = 256;
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
export const DEMO_BROWSER_COOKIE = "zacode_demo_browser";

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

const normalizedPairCode = (value: string) =>
  value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

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

const generatePairCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let raw = "";
  for (let i = 0; i < 10; i++) {
    raw += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
};

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

async function createShadowUser(source: SourceUser, workspaceCompanyId: number, linkId: number) {
  const passwordHash = await bcrypt.hash(crypto.randomBytes(48).toString("base64url"), 12);
  const [shadow] = await db.insert(usersTable).values({
    username: `__demo_${source.id}_${linkId}`,
    passwordHash,
    companyId: workspaceCompanyId,
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
  } as typeof usersTable.$inferInsert).returning();
  await copyBranchScope(source, shadow.id, workspaceCompanyId);
  return shadow;
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
  deviceLabel?: unknown;
  userAgent?: string | null;
  ip?: string | null;
}

export async function resolveDemoDeviceLogin(input: ResolveDemoLoginInput): Promise<{
  effectiveUser: SourceUser;
  deviceToken: string | null;
  deviceLinkId: number | null;
  workspaceCompanyId: number | null;
  isPrimary: boolean;
}> {
  // Compatibility export for older callers: the legacy workspace-cloning
  // implementation below is unreachable. All logins now use strict binding.
  return resolveStrictDemoBrowserLogin(input);
  /*
  const source = input.sourceUser;
  if (!source.demoDeviceIsolation) {
    return {
      effectiveUser: source,
      deviceToken: null,
      deviceLinkId: null,
      workspaceCompanyId: source.companyId,
      isPrimary: true,
    };
  }
  if (source.isDemoShadow || !source.companyId) {
    throw new DemoDeviceError("لا يمكن تسجيل الدخول المباشر إلى مستخدم مساحة ديمو", 403);
  }

  const deviceToken = validDeviceToken(input.deviceToken)
    ? input.deviceToken
    : generateDemoDeviceToken();
  const deviceTokenHash = sha256(deviceToken);
  const label = typeof input.deviceLabel === "string" && input.deviceLabel.trim()
    ? input.deviceLabel.trim().slice(0, 180)
    : requestLabel(input.userAgent);

  const [existing] = await db.select().from(demoDeviceWorkspacesTable).where(and(
    eq(demoDeviceWorkspacesTable.sourceUserId, source.id),
    eq(demoDeviceWorkspacesTable.deviceTokenHash, deviceTokenHash),
  ));
  if (existing && existing.status !== "failed") {
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
    };
  }
  if (existing?.status === "failed") {
    await db.delete(demoDeviceWorkspacesTable).where(eq(demoDeviceWorkspacesTable.id, existing.id));
  }

  const pairCode = typeof input.pairCode === "string"
    ? normalizedPairCode(input.pairCode)
    : "";

  const claim = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${90_000_000 + source.id})`);

    const [raced] = await tx.select().from(demoDeviceWorkspacesTable).where(and(
      eq(demoDeviceWorkspacesTable.sourceUserId, source.id),
      eq(demoDeviceWorkspacesTable.deviceTokenHash, deviceTokenHash),
    ));
    if (raced) return { link: raced, targetCompanyId: raced.workspaceCompanyId, pair: false };

    let targetCompanyId: number | null = null;
    let isPrimary = false;
    let pair = false;
    if (pairCode) {
      const [codeJoin] = await tx.select({
        code: demoDevicePairCodesTable,
      }).from(demoDevicePairCodesTable)
        .innerJoin(
          demoDeviceWorkspacesTable,
          eq(demoDevicePairCodesTable.createdByDeviceId, demoDeviceWorkspacesTable.id),
        )
        .where(and(
          eq(demoDevicePairCodesTable.sourceUserId, source.id),
          eq(demoDevicePairCodesTable.codeHash, sha256(pairCode)),
          isNull(demoDevicePairCodesTable.usedAt),
          gt(demoDevicePairCodesTable.expiresAt, new Date()),
          eq(demoDeviceWorkspacesTable.sourceUserId, source.id),
          eq(demoDeviceWorkspacesTable.status, "ready"),
          isNull(demoDeviceWorkspacesTable.revokedAt),
        )).limit(1);
      if (!codeJoin) throw new DemoDeviceError("رمز ربط الجهاز غير صحيح أو انتهت صلاحيته", 400);
      const codeRow = codeJoin.code;
      targetCompanyId = codeRow.workspaceCompanyId;
      pair = true;
      await tx.update(demoDevicePairCodesTable).set({ usedAt: new Date() })
        .where(eq(demoDevicePairCodesTable.id, codeRow.id));
    } else {
      const active = await tx.select({ id: demoDeviceWorkspacesTable.id })
        .from(demoDeviceWorkspacesTable)
        .where(and(
          eq(demoDeviceWorkspacesTable.sourceUserId, source.id),
          isNull(demoDeviceWorkspacesTable.revokedAt),
          ne(demoDeviceWorkspacesTable.status, "failed"),
        )).limit(1);
      isPrimary = active.length === 0;
      targetCompanyId = isPrimary ? source.companyId : null;
    }

    const [link] = await tx.insert(demoDeviceWorkspacesTable).values({
      sourceUserId: source.id,
      sourceCompanyId: source.companyId!,
      workspaceCompanyId: targetCompanyId,
      workspaceUserId: isPrimary ? source.id : null,
      deviceTokenHash,
      deviceLabel: label,
      userAgent: input.userAgent ?? null,
      firstIp: input.ip ?? null,
      lastIp: input.ip ?? null,
      isPrimary,
      status: isPrimary ? "ready" : "provisioning",
    }).returning();
    return { link, targetCompanyId, pair };
  });

  if (claim.link.status === "ready") {
    const effectiveUser = await loadReadyWorkspace(source, claim.link);
    return {
      effectiveUser,
      deviceToken,
      deviceLinkId: claim.link.id,
      workspaceCompanyId: claim.link.workspaceCompanyId,
      isPrimary: claim.link.isPrimary,
    };
  }
  if (claim.link.status !== "provisioning") {
    throw new DemoDeviceError("تعذر تجهيز مساحة الديمو لهذا الجهاز", 500);
  }

  try {
    let workspaceCompanyId = claim.targetCompanyId;
    let workspaceUserId: number;
    if (claim.pair && workspaceCompanyId) {
      const shadow = await createShadowUser(source, workspaceCompanyId, claim.link.id);
      workspaceUserId = shadow.id;
    } else {
      const [parentCompany] = await db.select().from(companiesTable)
        .where(eq(companiesTable.id, source.companyId!));
      if (!parentCompany) throw new DemoDeviceError("الشركة الأصلية غير موجودة", 404);
      const cloned = await cloneCompany({
        sourceCompanyId: source.companyId!,
        identity: {
          nameAr: `${parentCompany.nameAr} — ديمو جهاز ${claim.link.id}`,
          nameEn: parentCompany.nameEn ? `${parentCompany.nameEn} — Device demo ${claim.link.id}` : null,
          vatNumber: parentCompany.vatNumber,
          crNumber: parentCompany.crNumber,
          city: parentCompany.city,
          district: parentCompany.district,
          street: parentCompany.street,
          buildingNumber: parentCompany.buildingNumber,
          postalCode: parentCompany.postalCode,
          additionalNumber: parentCompany.additionalNumber,
          phone: null,
          country: parentCompany.country,
          industryName: parentCompany.industryName,
        },
        admin: {
          username: `__demo_${source.id}_${claim.link.id}`,
          password: crypto.randomBytes(48).toString("base64url"),
          nameAr: source.nameAr,
          nameEn: source.nameEn,
          email: null,
        },
        copyUsers: false,
        internalDemoWorkspace: true,
      });
      workspaceCompanyId = cloned.newCompanyId;
      workspaceUserId = cloned.adminUserId;
      await syncShadowUser(source, workspaceUserId, workspaceCompanyId);
    }

    const [ready] = await db.update(demoDeviceWorkspacesTable).set({
      workspaceCompanyId,
      workspaceUserId,
      status: "ready",
      updatedAt: new Date(),
      lastSeenAt: new Date(),
    }).where(and(
      eq(demoDeviceWorkspacesTable.id, claim.link.id),
      eq(demoDeviceWorkspacesTable.status, "provisioning"),
      isNull(demoDeviceWorkspacesTable.revokedAt),
    )).returning();
    if (!ready) {
      if (workspaceUserId !== source.id) {
        await db.update(usersTable).set({
          isActive: false,
          sessionToken: null,
          sessionId: null,
          updatedAt: new Date(),
        }).where(eq(usersTable.id, workspaceUserId));
      }
      throw new DemoDeviceError("تم إلغاء ربط هذا الجهاز أثناء تجهيز مساحة الديمو", 403);
    }
    const effectiveUser = await loadReadyWorkspace(source, ready);
    return {
      effectiveUser,
      deviceToken,
      deviceLinkId: ready.id,
      workspaceCompanyId,
      isPrimary: false,
    };
  } catch (error) {
    await db.update(demoDeviceWorkspacesTable).set({
      status: "failed",
      updatedAt: new Date(),
    }).where(and(
      eq(demoDeviceWorkspacesTable.id, claim.link.id),
      isNull(demoDeviceWorkspacesTable.revokedAt),
    ));
    throw error;
  }
  */
}

/**
 * Collapse the legacy per-browser workspace model to one approved browser.
 * The original/primary row is kept; every secondary link and shadow session
 * is revoked. Hidden legacy companies are intentionally preserved.
 */
async function normalizeStrictBrowserLinks(tx: any, source: SourceUser) {
  const links = await tx.select().from(demoDeviceWorkspacesTable).where(and(
    eq(demoDeviceWorkspacesTable.sourceUserId, source.id),
    isNull(demoDeviceWorkspacesTable.revokedAt),
  )).orderBy(
    desc(demoDeviceWorkspacesTable.isPrimary),
    demoDeviceWorkspacesTable.createdAt,
    demoDeviceWorkspacesTable.id,
  );

  const canonical = links.find((link: typeof demoDeviceWorkspacesTable.$inferSelect) =>
    link.isPrimary && link.status === "ready",
  ) ?? null;
  const now = new Date();
  const extras = links.filter((link: typeof demoDeviceWorkspacesTable.$inferSelect) =>
    !canonical || link.id !== canonical.id,
  );

  if (extras.length) {
    await tx.update(demoDeviceWorkspacesTable).set({
      status: "revoked",
      revokedAt: now,
      updatedAt: now,
    }).where(inArray(demoDeviceWorkspacesTable.id, extras.map((link: typeof demoDeviceWorkspacesTable.$inferSelect) => link.id)));
  }

  const shadowIds = links
    .map((link: typeof demoDeviceWorkspacesTable.$inferSelect) => link.workspaceUserId)
    .filter((id: number | null): id is number => id != null && id !== source.id);
  if (shadowIds.length) {
    await tx.update(usersTable).set({
      isActive: false,
      sessionToken: null,
      sessionId: null,
      updatedAt: now,
    }).where(inArray(usersTable.id, shadowIds));
  }

  await tx.update(demoDevicePairCodesTable).set({ usedAt: now }).where(and(
    eq(demoDevicePairCodesTable.sourceUserId, source.id),
    isNull(demoDevicePairCodesTable.usedAt),
  ));

  if (!canonical) return null;
  const [normalized] = await tx.update(demoDeviceWorkspacesTable).set({
    workspaceCompanyId: source.companyId,
    workspaceUserId: source.id,
    isPrimary: true,
    status: "ready",
    revokedAt: null,
    updatedAt: now,
  }).where(eq(demoDeviceWorkspacesTable.id, canonical.id)).returning();
  return normalized;
}

export async function enforceSingleDemoBrowser(sourceUserId: number) {
  const [source] = await db.select().from(usersTable).where(and(
    eq(usersTable.id, sourceUserId),
    eq(usersTable.isDemoShadow, false),
  )).limit(1);
  if (!source) throw new DemoDeviceError("مستخدم الديمو غير موجود", 404);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${90_000_000 + source.id})`);
    return normalizeStrictBrowserLinks(tx, source);
  });
}

/**
 * Strict demo policy: the first browser token becomes the only approved
 * browser. A second browser is rejected even if it shares the same IP.
 */
export async function resolveStrictDemoBrowserLogin(input: ResolveDemoLoginInput): Promise<{
  effectiveUser: SourceUser;
  deviceToken: string | null;
  deviceLinkId: number | null;
  workspaceCompanyId: number | null;
  isPrimary: boolean;
  bindingWasCreated: boolean;
}> {
  const source = input.sourceUser;
  if (!source.demoDeviceIsolation) {
    return {
      effectiveUser: source,
      deviceToken: null,
      deviceLinkId: null,
      workspaceCompanyId: source.companyId,
      isPrimary: true,
      bindingWasCreated: false,
    };
  }
  if (source.isDemoShadow || !source.companyId) {
    throw new DemoDeviceError("لا يمكن تسجيل الدخول المباشر إلى مستخدم مساحة ديمو", 403, "DEMO_SHADOW_LOGIN_DENIED");
  }

  const deviceToken = validDeviceToken(input.deviceToken)
    ? input.deviceToken
    : generateDemoDeviceToken();
  const deviceTokenHash = sha256(deviceToken);
  const label = typeof input.deviceLabel === "string" && input.deviceLabel.trim()
    ? input.deviceLabel.trim().slice(0, 180)
    : requestLabel(input.userAgent);

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${90_000_000 + source.id})`);
    const canonical = await normalizeStrictBrowserLinks(tx, source);
    const now = new Date();

    if (canonical) {
      if (canonical.deviceTokenHash !== deviceTokenHash) {
        return {
          kind: "locked" as const,
          deviceLabel: canonical.deviceLabel,
          lastSeenAt: canonical.lastSeenAt,
        };
      }
      const [updated] = await tx.update(demoDeviceWorkspacesTable).set({
        deviceLabel: label,
        userAgent: input.userAgent ?? null,
        lastIp: input.ip ?? null,
        lastSeenAt: now,
        updatedAt: now,
      }).where(and(
        eq(demoDeviceWorkspacesTable.id, canonical.id),
        eq(demoDeviceWorkspacesTable.status, "ready"),
        isNull(demoDeviceWorkspacesTable.revokedAt),
      )).returning();
      if (!updated) {
        throw new DemoDeviceError("تم فك ارتباط متصفح الديمو. سجّل الدخول مرة أخرى.", 403, "DEMO_BROWSER_RESET");
      }
      return { kind: "ready" as const, link: updated, bindingWasCreated: false };
    }

    const [prior] = await tx.select().from(demoDeviceWorkspacesTable).where(and(
      eq(demoDeviceWorkspacesTable.sourceUserId, source.id),
      eq(demoDeviceWorkspacesTable.deviceTokenHash, deviceTokenHash),
    )).limit(1);
    const values = {
      sourceCompanyId: source.companyId!,
      workspaceCompanyId: source.companyId!,
      workspaceUserId: source.id,
      deviceLabel: label,
      userAgent: input.userAgent ?? null,
      lastIp: input.ip ?? null,
      isPrimary: true,
      status: "ready",
      revokedAt: null,
      lastSeenAt: now,
      updatedAt: now,
    };
    const [link] = prior
      ? await tx.update(demoDeviceWorkspacesTable).set(values)
          .where(eq(demoDeviceWorkspacesTable.id, prior.id)).returning()
      : await tx.insert(demoDeviceWorkspacesTable).values({
          ...values,
          sourceUserId: source.id,
          deviceTokenHash,
          firstIp: input.ip ?? null,
        }).returning();
    return { kind: "ready" as const, link, bindingWasCreated: true };
  });

  if (result.kind === "locked") {
    const detail = result.deviceLabel ? ` (${result.deviceLabel})` : "";
    throw new DemoDeviceError(
      `حساب الديمو مرتبط بالفعل بمتصفح آخر${detail}. اطلب من مسؤول النظام فك الارتباط أولاً.`,
      423,
      "DEMO_BROWSER_LOCKED",
    );
  }
  return {
    effectiveUser: source,
    deviceToken,
    deviceLinkId: result.link.id,
    workspaceCompanyId: source.companyId,
    isPrimary: true,
    bindingWasCreated: result.bindingWasCreated,
  };
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
    "تم إيقاف ربط متصفحات إضافية. حساب الديمو يسمح بمتصفح واحد فقط.",
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
  // Legacy shadow sessions are intentionally no longer decorated. The bearer
  // resolver treats the missing demoSourceUserId as invalid, which immediately
  // retires all sessions created by the old per-browser workspace model.
  return user;
}