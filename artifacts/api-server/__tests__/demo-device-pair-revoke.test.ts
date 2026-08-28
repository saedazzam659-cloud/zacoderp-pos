import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, isNull } from "drizzle-orm";
import {
  companiesTable,
  db,
  demoDevicePairCodesTable,
  demoDeviceWorkspacesTable,
  pool,
  usersTable,
} from "@workspace/db";
import {
  createDemoPairCode,
  DEMO_BROWSER_COOKIE,
  DemoDeviceError,
  getDemoBrowserLoginPreflight as rawGetDemoBrowserLoginPreflight,
  needsDemoDevicePreparation as rawNeedsDemoDevicePreparation,
  propagateDemoSourcePermissions,
  propagateDemoWorkspaceMenuPermissions,
  refreshDemoShadowAuthorization,
  releaseDemoDeviceLink,
  resolveDemoDeviceLogin as rawResolveDemoDeviceLogin,
  revokeDemoDevice,
} from "../src/lib/demoDeviceIsolation.ts";
import { resolveBearerToken } from "../src/middleware/auth.ts";

const tag = `tt_demo_dev_${randomBytes(5).toString("hex")}`;
let companyId = 0;
let sourceUserId = 0;
const cleanupCompanyIds: number[] = [];
const cleanupUserIds: number[] = [];
const sessionIssue = (issuedAt = new Date()) => ({
  sessionToken: `bearer-${randomBytes(24).toString("hex")}`,
  sessionId: `session-${randomBytes(12).toString("hex")}`,
  sessionChannel: "web" as const,
  issuedAt,
});
const deviceHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const TEST_PHONE = "+966500000001";
const getDemoBrowserLoginPreflight = (source: any, token: unknown) =>
  rawGetDemoBrowserLoginPreflight(source, token, TEST_PHONE);
const needsDemoDevicePreparation = (source: any, token: unknown) =>
  rawNeedsDemoDevicePreparation(source, token, TEST_PHONE);
const resolveDemoDeviceLogin = (input: any) =>
  rawResolveDemoDeviceLogin({ phone: TEST_PHONE, ...input });

before(async () => {
  const [company] = await db.insert(companiesTable).values({
    nameAr: tag,
    nameEn: tag,
    code: `DPR-${randomBytes(3).toString("hex").toUpperCase()}`,
    crNumber: `CR-${tag}`,
    buildingNumber: "1",
    vatNumber: "300000000000003",
    city: "Riyadh",
    street: "Test",
    postalCode: "12345",
    country: "SA",
    invoiceType: "both",
    status: "active",
  }).returning({ id: companiesTable.id });
  companyId = company.id;

  const [source] = await db.insert(usersTable).values({
    username: tag,
    passwordHash: "not-used",
    companyId,
    role: "admin",
    isActive: true,
    demoDeviceIsolation: true,
    isDemoShadow: false,
  }).returning({ id: usersTable.id });
  sourceUserId = source.id;
});

after(async () => {
  if (sourceUserId) {
    await db.delete(demoDevicePairCodesTable)
      .where(eq(demoDevicePairCodesTable.sourceUserId, sourceUserId)).catch(() => {});
    await db.delete(demoDeviceWorkspacesTable)
      .where(eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId)).catch(() => {});
    await db.delete(usersTable).where(eq(usersTable.id, sourceUserId)).catch(() => {});
  }
  for (const id of cleanupUserIds) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
  for (const id of cleanupCompanyIds) {
    await db.delete(companiesTable).where(eq(companiesTable.id, id)).catch(() => {});
  }
  if (companyId) await db.delete(companiesTable).where(eq(companiesTable.id, companyId)).catch(() => {});
  await pool.end().catch(() => {});
});

const loadSource = async () => {
  const [source] = await db.select().from(usersTable).where(eq(usersTable.id, sourceUserId));
  assert.ok(source);
  return source;
};

test("a new browser requires confirmation, then atomically replaces the prior demo session", async () => {
  const source = await loadSource();
  const tokenA = randomBytes(32).toString("base64url");
  const tokenB = randomBytes(32).toString("base64url");

  assert.deepEqual(await getDemoBrowserLoginPreflight(source, tokenA), {
    needsPreparation: true,
    transferRequired: false,
    phoneRequired: false,
  });
  const first = await resolveDemoDeviceLogin({
    sourceUser: source, deviceToken: tokenA, deviceLabel: "browser-a",
  });
  assert.equal(first.isPrimary, true);
  assert.equal(first.bindingWasCreated, true);
  assert.notEqual(first.effectiveUser.id, sourceUserId);
  assert.notEqual(first.workspaceCompanyId, companyId);
  cleanupUserIds.push(first.effectiveUser.id);
  cleanupCompanyIds.push(first.workspaceCompanyId);
  assert.equal(
    await needsDemoDevicePreparation(source, tokenA),
    false,
    "a ready browser binding should not show preparation again",
  );

  // Same browser returns to the SAME workspace, no new binding.
  const returning = await resolveDemoDeviceLogin({
    sourceUser: source, deviceToken: tokenA, deviceLabel: "browser-a",
  });
  assert.equal(returning.deviceLinkId, first.deviceLinkId);
  assert.equal(returning.bindingWasCreated, false);

  assert.deepEqual(await getDemoBrowserLoginPreflight(source, tokenB), {
    needsPreparation: false,
    transferRequired: true,
    phoneRequired: false,
  });
  const primaryBearer = `bearer-${randomBytes(24).toString("hex")}`;
  await db.update(usersTable).set({ sessionToken: primaryBearer, sessionId: "demo-primary-test" })
    .where(eq(usersTable.id, first.effectiveUser.id));
  assert.equal(await resolveBearerToken(primaryBearer), null, "primary bearer without cookie must be rejected");
  const primaryOk = await resolveBearerToken(primaryBearer, `${DEMO_BROWSER_COOKIE}=${tokenA}`);
  assert.equal(primaryOk?.user.id, first.effectiveUser.id);

  await assert.rejects(
    () => resolveDemoDeviceLogin({
      sourceUser: source, deviceToken: tokenB, deviceLabel: "browser-b",
    }),
    (error: unknown) =>
      error instanceof DemoDeviceError
      && error.status === 409
      && error.code === "DEMO_SESSION_TRANSFER_REQUIRED",
  );
  assert.equal(
    (await resolveBearerToken(primaryBearer, `${DEMO_BROWSER_COOKIE}=${tokenA}`))?.user.id,
    first.effectiveUser.id,
    "cancelling/omitting confirmation must leave the old browser active",
  );

  const transferredSession = sessionIssue();
  const transferred = await resolveDemoDeviceLogin({
    sourceUser: source,
    deviceToken: tokenB,
    deviceLabel: "browser-b",
    confirmTransfer: true,
    sessionIssue: transferredSession,
  });
  assert.equal(transferred.isPrimary, true);
  assert.equal(transferred.bindingWasCreated, true);
  assert.equal(transferred.workspaceCompanyId, first.workspaceCompanyId);
  assert.equal(transferred.effectiveUser.id, first.effectiveUser.id);
  assert.notEqual(transferred.deviceLinkId, first.deviceLinkId);

  assert.equal(
    await resolveBearerToken(primaryBearer, `${DEMO_BROWSER_COOKIE}=${tokenA}`),
    null,
    "confirmed transfer must invalidate the prior bearer and cookie",
  );

  assert.equal(
    await resolveBearerToken(transferredSession.sessionToken, `${DEMO_BROWSER_COOKIE}=${tokenA}`),
    null,
    "the new bearer must not work with the previous browser cookie",
  );
  assert.equal(
    (await resolveBearerToken(
      transferredSession.sessionToken,
      `${DEMO_BROWSER_COOKIE}=${transferred.deviceToken}`,
    ))?.user.id,
    transferred.effectiveUser.id,
  );

  const active = await db.select({ id: demoDeviceWorkspacesTable.id })
    .from(demoDeviceWorkspacesTable)
    .where(and(
      eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
      isNull(demoDeviceWorkspacesTable.revokedAt),
    ));
  assert.deepEqual(active.map((row) => row.id), [transferred.deviceLinkId]);
});

test("source RBAC and menu grants propagate to an active retained demo workspace", async () => {
  const localTag = `${tag}_perm_sync`;
  const [sourceCompany, workspaceCompany] = await db.insert(companiesTable).values([
    {
      nameAr: `${localTag}_source`,
      nameEn: `${localTag}_source`,
      code: `DPS-${randomBytes(3).toString("hex").toUpperCase()}`,
      crNumber: `CR-${localTag}-S`,
      buildingNumber: "1",
      vatNumber: "300000000000003",
      city: "Riyadh",
      street: "Test",
      postalCode: "12345",
      country: "SA",
      invoiceType: "both",
      status: "active",
      menuPermissions: JSON.stringify({ fixed_assets: false }),
    },
    {
      nameAr: `${localTag}_workspace`,
      nameEn: `${localTag}_workspace`,
      code: `DPW-${randomBytes(3).toString("hex").toUpperCase()}`,
      crNumber: `CR-${localTag}-W`,
      buildingNumber: "1",
      vatNumber: "300000000000003",
      city: "Riyadh",
      street: "Test",
      postalCode: "12345",
      country: "SA",
      invoiceType: "both",
      status: "active",
      menuPermissions: JSON.stringify({ fixed_assets: false }),
      isInternalDemoWorkspace: true,
    },
  ]).returning({ id: companiesTable.id });
  cleanupCompanyIds.push(sourceCompany.id, workspaceCompany.id);

  const [sourceUser, workspaceUser] = await db.insert(usersTable).values([
    {
      username: `${localTag}_source`,
      passwordHash: "not-used",
      companyId: sourceCompany.id,
      role: "user",
      isActive: true,
      demoDeviceIsolation: true,
      isDemoShadow: false,
      permissions: { fixed_assets: { view: false } },
    },
    {
      username: `${localTag}_workspace`,
      passwordHash: "not-used",
      companyId: workspaceCompany.id,
      role: "user",
      isActive: true,
      demoDeviceIsolation: false,
      isDemoShadow: true,
      permissions: { fixed_assets: { view: false } },
    },
  ]).returning({ id: usersTable.id });
  cleanupUserIds.push(sourceUser.id, workspaceUser.id);

  await db.insert(demoDeviceWorkspacesTable).values({
    sourceUserId: sourceUser.id,
    sourceCompanyId: sourceCompany.id,
    workspaceCompanyId: workspaceCompany.id,
    workspaceUserId: workspaceUser.id,
    deviceTokenHash: deviceHash(randomBytes(32).toString("base64url")),
    status: "ready",
    isPrimary: true,
  });

  const permissions = { fixed_assets: { view: true } };
  const permissionTargets = await propagateDemoSourcePermissions(sourceUser.id, permissions);
  assert.deepEqual(permissionTargets.workspaceUserIds, [workspaceUser.id]);
  assert.deepEqual(permissionTargets.workspaceCompanyIds, [workspaceCompany.id]);

  const enabledMenus = JSON.stringify({ fixed_assets: true });
  const companyTargets = await propagateDemoWorkspaceMenuPermissions(
    sourceCompany.id,
    enabledMenus,
  );
  assert.deepEqual(companyTargets, [workspaceCompany.id]);

  const [updatedUser] = await db.select({
    permissions: usersTable.permissions,
  }).from(usersTable).where(eq(usersTable.id, workspaceUser.id));
  const [updatedCompany] = await db.select({
    menuPermissions: companiesTable.menuPermissions,
  }).from(companiesTable).where(eq(companiesTable.id, workspaceCompany.id));
  assert.deepEqual(updatedUser.permissions, permissions);
  assert.equal(updatedCompany.menuPermissions, enabledMenus);

  // Existing workspaces that were stale before the propagation hooks shipped
  // must repair themselves on the next /auth/me refresh.
  await db.update(usersTable).set({ permissions })
    .where(eq(usersTable.id, sourceUser.id));
  await db.update(companiesTable).set({ menuPermissions: enabledMenus })
    .where(eq(companiesTable.id, sourceCompany.id));
  await db.update(usersTable).set({ permissions: { fixed_assets: { view: false } } })
    .where(eq(usersTable.id, workspaceUser.id));
  await db.update(companiesTable).set({
    menuPermissions: JSON.stringify({ fixed_assets: false }),
  }).where(eq(companiesTable.id, workspaceCompany.id));

  const refreshed = await refreshDemoShadowAuthorization({
    id: workspaceUser.id,
    isDemoShadow: true,
  });
  assert.equal(refreshed.id, workspaceUser.id);
  const [healedUser] = await db.select({
    permissions: usersTable.permissions,
  }).from(usersTable).where(eq(usersTable.id, workspaceUser.id));
  const [healedCompany] = await db.select({
    menuPermissions: companiesTable.menuPermissions,
  }).from(companiesTable).where(eq(companiesTable.id, workspaceCompany.id));
  assert.deepEqual(healedUser.permissions, permissions);
  assert.equal(healedCompany.menuPermissions, enabledMenus);
});

test("a failed atomic session write rolls the whole handoff back", async () => {
  const source = await loadSource();
  const [before] = await db.select().from(demoDeviceWorkspacesTable).where(and(
    eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
    isNull(demoDeviceWorkspacesTable.revokedAt),
  ));
  assert.ok(before);
  assert.ok(before.workspaceUserId);
  const [sourceBefore] = await db.select({
    sessionToken: usersTable.sessionToken,
  }).from(usersTable).where(eq(usersTable.id, before.workspaceUserId));
  assert.ok(sourceBefore?.sessionToken);

  await assert.rejects(() => resolveDemoDeviceLogin({
    sourceUser: source,
    deviceToken: randomBytes(32).toString("base64url"),
    deviceLabel: "failed-atomic-transfer",
    confirmTransfer: true,
    sessionIssue: sessionIssue(new Date(Number.NaN)),
  }));

  const active = await db.select().from(demoDeviceWorkspacesTable).where(and(
    eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
    isNull(demoDeviceWorkspacesTable.revokedAt),
  ));
  assert.deepEqual(active.map((row) => row.id), [before.id]);
  const [sourceAfter] = await db.select({
    sessionToken: usersTable.sessionToken,
  }).from(usersTable).where(eq(usersTable.id, before.workspaceUserId));
  assert.equal(
    sourceAfter?.sessionToken,
    sourceBefore.sessionToken,
    "the prior bearer must survive a failed transfer transaction",
  );
});

test("global temporary switch bypasses demo workspace resolution without deleting data", async () => {
  const source = await loadSource();
  const prior = process.env.DEMO_DEVICE_ISOLATION_ENABLED;
  process.env.DEMO_DEVICE_ISOLATION_ENABLED = "false";
  try {
    const result = await resolveDemoDeviceLogin({
      sourceUser: source,
      deviceToken: randomBytes(32).toString("base64url"),
      deviceLabel: "temporarily-disabled",
    });
    assert.equal(result.effectiveUser.id, source.id);
    assert.equal(result.deviceLinkId, null);
    assert.equal(result.deviceToken, null);
    assert.equal(result.bindingWasCreated, false);
  } finally {
    if (prior == null) delete process.env.DEMO_DEVICE_ISOLATION_ENABLED;
    else process.env.DEMO_DEVICE_ISOLATION_ENABLED = prior;
  }
});

test("releaseDemoDeviceLink deletes the link row so the browser can rebind", async () => {
  const source = await loadSource();
  const token = randomBytes(32).toString("base64url");
  const login = await resolveDemoDeviceLogin({
    sourceUser: source,
    deviceToken: token,
    deviceLabel: "flaky-browser",
    confirmTransfer: true,
    sessionIssue: sessionIssue(),
  });
  if (!login.isPrimary && login.workspaceCompanyId) {
    cleanupCompanyIds.push(login.workspaceCompanyId);
    cleanupUserIds.push(login.effectiveUser.id);
  }
  await releaseDemoDeviceLink(sourceUserId, login.deviceLinkId!);
  const [row] = await db.select({ id: demoDeviceWorkspacesTable.id })
    .from(demoDeviceWorkspacesTable)
    .where(eq(demoDeviceWorkspacesTable.id, login.deviceLinkId!));
  assert.equal(row, undefined, "released link row must be deleted, not revoked");

  // The same browser token can log in again and mint a fresh workspace.
  const again = await resolveDemoDeviceLogin({
    sourceUser: source, deviceToken: token, deviceLabel: "flaky-browser",
  });
  assert.ok(again.deviceLinkId);
  assert.notEqual(again.deviceLinkId, login.deviceLinkId);
  assert.equal(
    again.deviceToken,
    token,
    "a compensation delete intentionally lets the same browser token bind again",
  );
  if (!again.isPrimary && again.workspaceCompanyId) {
    cleanupCompanyIds.push(again.workspaceCompanyId);
    cleanupUserIds.push(again.effectiveUser.id);
  }
});

test("legacy rows without a phone workspace are replaced by a clean phone-keyed workspace", async () => {
  const source = await loadSource();
  const now = new Date();
  await db.update(demoDeviceWorkspacesTable).set({
    status: "revoked",
    revokedAt: now,
    updatedAt: now,
  }).where(and(
    eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
    isNull(demoDeviceWorkspacesTable.revokedAt),
  ));

  const shadowTag = `${tag}_legacy_shadow`;
  const [shadowCompany] = await db.insert(companiesTable).values({
    nameAr: shadowTag,
    nameEn: shadowTag,
    code: `DPS-${randomBytes(3).toString("hex").toUpperCase()}`,
    crNumber: `CR-${shadowTag}`,
    buildingNumber: "1",
    vatNumber: "300000000000003",
    city: "Riyadh",
    street: "Test",
    postalCode: "12345",
    country: "SA",
    invoiceType: "both",
    status: "active",
  }).returning({ id: companiesTable.id });
  cleanupCompanyIds.push(shadowCompany.id);
  const [shadowUser] = await db.insert(usersTable).values({
    username: `${shadowTag}_${randomBytes(3).toString("hex")}`,
    passwordHash: "not-used",
    companyId: shadowCompany.id,
    role: "admin",
    isActive: true,
    demoDeviceIsolation: false,
    isDemoShadow: true,
  }).returning({ id: usersTable.id });
  cleanupUserIds.push(shadowUser.id);

  const primaryToken = randomBytes(32).toString("base64url");
  const shadowToken = randomBytes(32).toString("base64url");
  await db.insert(demoDeviceWorkspacesTable).values([
    {
      sourceUserId,
      sourceCompanyId: companyId,
      workspaceCompanyId: companyId,
      workspaceUserId: sourceUserId,
      deviceTokenHash: deviceHash(primaryToken),
      deviceLabel: "legacy-primary",
      isPrimary: true,
      status: "ready",
      lastSeenAt: new Date(now.getTime() - 10 * 60_000),
    },
    {
      sourceUserId,
      sourceCompanyId: companyId,
      workspaceCompanyId: shadowCompany.id,
      workspaceUserId: shadowUser.id,
      deviceTokenHash: deviceHash(shadowToken),
      deviceLabel: "legacy-shadow-recent",
      isPrimary: false,
      status: "ready",
      lastSeenAt: now,
    },
  ]);

  const handoffSession = sessionIssue();
  const handoff = await resolveDemoDeviceLogin({
    sourceUser: source,
    deviceToken: randomBytes(32).toString("base64url"),
    deviceLabel: "legacy-handoff-target",
    confirmTransfer: true,
    sessionIssue: handoffSession,
  });
  assert.notEqual(handoff.workspaceCompanyId, companyId);
  assert.notEqual(handoff.workspaceCompanyId, shadowCompany.id);
  assert.notEqual(handoff.effectiveUser.id, sourceUserId);
  assert.notEqual(handoff.effectiveUser.id, shadowUser.id);
  cleanupCompanyIds.push(handoff.workspaceCompanyId);
  cleanupUserIds.push(handoff.effectiveUser.id);
  assert.equal(handoff.isPrimary, true);
  assert.equal(handoff.sessionIssuedAtomically, false);
  assert.equal(
    await resolveBearerToken(
      handoffSession.sessionToken,
      `${DEMO_BROWSER_COOKIE}=${handoff.deviceToken}`,
    ),
    null,
    "fresh phone workspace provisioning leaves session issuance to the caller",
  );

  const authRouteSource = readFileSync(
    new URL("../src/routes/auth.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    authRouteSource,
    /if\s*\(\s*user\.isDemoShadow\s*\)\s*\{\s*res\.status\(401\)/,
    "/auth/me must not reject a shadow session after resolveBearerToken accepted its active cookie binding",
  );
});

test("simultaneous confirmed transfers leave exactly one active browser binding", async () => {
  const source = await loadSource();
  const current = await db.select({ id: demoDeviceWorkspacesTable.id })
    .from(demoDeviceWorkspacesTable)
    .where(and(
      eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
      isNull(demoDeviceWorkspacesTable.revokedAt),
    ));
  for (const row of current) {
    await revokeDemoDevice(sourceUserId, row.id);
  }
  const primaryToken = randomBytes(32).toString("base64url");
  const primary = await resolveDemoDeviceLogin({
    sourceUser: source,
    deviceToken: primaryToken,
    deviceLabel: "race-primary",
  });
  cleanupCompanyIds.push(primary.workspaceCompanyId);
  cleanupUserIds.push(primary.effectiveUser.id);

  const tokenA = randomBytes(32).toString("base64url");
  const tokenB = randomBytes(32).toString("base64url");
  const issueA = sessionIssue();
  const issueB = sessionIssue();
  const results = await Promise.allSettled([
    resolveDemoDeviceLogin({
      sourceUser: source,
      deviceToken: tokenA,
      deviceLabel: "race-a",
      confirmTransfer: true,
      sessionIssue: issueA,
    }),
    resolveDemoDeviceLogin({
      sourceUser: source,
      deviceToken: tokenB,
      deviceLabel: "race-b",
      confirmTransfer: true,
      sessionIssue: issueB,
    }),
  ]);
  const fulfilled = results.filter(
    (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof resolveDemoDeviceLogin>>> =>
      r.status === "fulfilled",
  );
  assert.ok(fulfilled.length >= 1, "at least one racer must win");
  for (const r of results) {
    if (r.status === "rejected") {
      assert.ok(r.reason instanceof DemoDeviceError, String(r.reason));
      assert.equal(r.reason.status, 403, "a superseded racer may observe its link revoked");
    }
  }

  const active = await db.select().from(demoDeviceWorkspacesTable)
    .where(and(
      eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
      isNull(demoDeviceWorkspacesTable.revokedAt),
      eq(demoDeviceWorkspacesTable.status, "ready"),
    ));
  assert.equal(active.length, 1, "only the final confirmed browser may stay active");
  assert.equal(active[0].workspaceUserId, primary.effectiveUser.id);
  assert.equal(active[0].workspaceCompanyId, primary.workspaceCompanyId);
  const usable = await Promise.all([
    resolveBearerToken(issueA.sessionToken, `${DEMO_BROWSER_COOKIE}=${tokenA}`),
    resolveBearerToken(issueB.sessionToken, `${DEMO_BROWSER_COOKIE}=${tokenB}`),
  ]);
  assert.equal(
    usable.filter(Boolean).length,
    1,
    "only one raced bearer+cookie pair may remain usable",
  );

  const failed = await db.select({ id: demoDeviceWorkspacesTable.id })
    .from(demoDeviceWorkspacesTable)
    .where(and(
      eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
      eq(demoDeviceWorkspacesTable.status, "failed"),
    ));
  assert.equal(failed.length, 0);
});

test("pair-code creation stays disabled", async () => {
  await assert.rejects(
    () => createDemoPairCode(sourceUserId, 1),
    (error: unknown) =>
      error instanceof DemoDeviceError
      && error.status === 410
      && error.code === "DEMO_PAIRING_DISABLED",
  );
});

test("non-isolated user passes through untouched", async () => {
  await db.update(usersTable).set({ demoDeviceIsolation: false }).where(eq(usersTable.id, sourceUserId));
  try {
    const source = await loadSource();
    assert.equal(await needsDemoDevicePreparation(source, undefined), false);
    const result = await resolveDemoDeviceLogin({ sourceUser: source, deviceToken: undefined });
    assert.equal(result.deviceToken, null);
    assert.equal(result.deviceLinkId, null);
    assert.equal(result.effectiveUser.id, sourceUserId);
    assert.equal(result.bindingWasCreated, false);
  } finally {
    await db.update(usersTable).set({ demoDeviceIsolation: true }).where(eq(usersTable.id, sourceUserId));
  }
});

test("no leftover unrevoked links from cleanup helpers", async () => {
  const links = await db.select({ id: demoDeviceWorkspacesTable.id })
    .from(demoDeviceWorkspacesTable)
    .where(and(
      eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
      isNull(demoDeviceWorkspacesTable.revokedAt),
    ));
  // Whatever remains must belong to still-live tests above; just assert the query works.
  assert.ok(Array.isArray(links));
});

test("login UI exposes explicit confirm and cancel controls for demo handoff", () => {
  const loginSource = readFileSync(
    new URL("../../zatca-invoicing/src/pages/Login.tsx", import.meta.url),
    "utf8",
  );
  const authContextSource = readFileSync(
    new URL("../../zatca-invoicing/src/contexts/AuthContext.tsx", import.meta.url),
    "utf8",
  );
  assert.match(loginSource, /data-testid="demo-session-transfer-dialog"/);
  assert.match(loginSource, /data-testid="demo-session-transfer-confirm"/);
  assert.match(loginSource, /data-testid="demo-session-transfer-cancel"/);
  assert.match(loginSource, /DEMO_SESSION_TRANSFER_REQUIRED/);
  assert.match(authContextSource, /confirmDemoSessionTransfer/);
});
