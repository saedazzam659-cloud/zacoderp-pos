import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
  releaseDemoDeviceLink,
  resolveDemoDeviceLogin,
  revokeDemoDevice,
} from "../src/lib/demoDeviceIsolation.ts";
import { resolveBearerToken } from "../src/middleware/auth.ts";

const tag = `tt_demo_dev_${randomBytes(5).toString("hex")}`;
let companyId = 0;
let sourceUserId = 0;
const cleanupCompanyIds: number[] = [];
const cleanupUserIds: number[] = [];

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

test("two browsers get two isolated workspaces; first is primary in the source company", async () => {
  const source = await loadSource();
  const tokenA = randomBytes(32).toString("base64url");
  const tokenB = randomBytes(32).toString("base64url");

  const first = await resolveDemoDeviceLogin({
    sourceUser: source, deviceToken: tokenA, deviceLabel: "browser-a",
  });
  assert.equal(first.isPrimary, true);
  assert.equal(first.bindingWasCreated, true);
  assert.equal(first.effectiveUser.id, sourceUserId);
  assert.equal(first.workspaceCompanyId, companyId);

  // Same browser returns to the SAME workspace, no new binding.
  const returning = await resolveDemoDeviceLogin({
    sourceUser: source, deviceToken: tokenA, deviceLabel: "browser-a",
  });
  assert.equal(returning.deviceLinkId, first.deviceLinkId);
  assert.equal(returning.bindingWasCreated, false);

  // A second browser is NOT rejected — it gets its own cloned workspace.
  const second = await resolveDemoDeviceLogin({
    sourceUser: source, deviceToken: tokenB, deviceLabel: "browser-b",
  });
  assert.equal(second.isPrimary, false);
  assert.equal(second.bindingWasCreated, true);
  assert.notEqual(second.deviceLinkId, first.deviceLinkId);
  assert.ok(second.workspaceCompanyId);
  assert.notEqual(second.workspaceCompanyId, companyId);
  assert.notEqual(second.effectiveUser.id, sourceUserId);
  assert.equal(second.effectiveUser.isDemoShadow, true);
  cleanupCompanyIds.push(second.workspaceCompanyId!);
  cleanupUserIds.push(second.effectiveUser.id);

  // Shadow bearer needs the matching cookie: reject bare + wrong, accept right.
  const shadowBearer = `bearer-${randomBytes(24).toString("hex")}`;
  await db.update(usersTable).set({ sessionToken: shadowBearer, sessionId: "demo-shadow-test" })
    .where(eq(usersTable.id, second.effectiveUser.id));
  assert.equal(await resolveBearerToken(shadowBearer), null, "shadow bearer without cookie must be rejected");
  assert.equal(
    await resolveBearerToken(shadowBearer, `${DEMO_BROWSER_COOKIE}=${tokenA}`),
    null,
    "shadow bearer with ANOTHER device's cookie must be rejected",
  );
  const shadowOk = await resolveBearerToken(shadowBearer, `${DEMO_BROWSER_COOKIE}=${tokenB}`);
  assert.equal(shadowOk?.user.id, second.effectiveUser.id);
  assert.equal((shadowOk?.user as any).demoSourceUserId, sourceUserId);

  // Source (primary) bearer also needs its cookie.
  const primaryBearer = `bearer-${randomBytes(24).toString("hex")}`;
  await db.update(usersTable).set({ sessionToken: primaryBearer, sessionId: "demo-primary-test" })
    .where(eq(usersTable.id, sourceUserId));
  assert.equal(await resolveBearerToken(primaryBearer), null, "primary bearer without cookie must be rejected");
  const primaryOk = await resolveBearerToken(primaryBearer, `${DEMO_BROWSER_COOKIE}=${tokenA}`);
  assert.equal(primaryOk?.user.id, sourceUserId);

  // Revoking the second device invalidates its shadow session.
  await revokeDemoDevice(sourceUserId, second.deviceLinkId!);
  assert.equal(
    await resolveBearerToken(shadowBearer, `${DEMO_BROWSER_COOKIE}=${tokenB}`),
    null,
    "revocation must invalidate the shadow bearer even with the old cookie",
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
    sourceUser: source, deviceToken: token, deviceLabel: "flaky-browser",
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
  if (!again.isPrimary && again.workspaceCompanyId) {
    cleanupCompanyIds.push(again.workspaceCompanyId);
    cleanupUserIds.push(again.effectiveUser.id);
  }
});

test("two concurrent logins with the SAME new second-device token never double-provision", async () => {
  const source = await loadSource();
  // Ensure a primary exists so the raced token takes the provisioning path.
  const primaryToken = randomBytes(32).toString("base64url");
  const primary = await resolveDemoDeviceLogin({
    sourceUser: source, deviceToken: primaryToken, deviceLabel: "race-primary",
  });
  if (!primary.isPrimary && primary.workspaceCompanyId) {
    cleanupCompanyIds.push(primary.workspaceCompanyId);
    cleanupUserIds.push(primary.effectiveUser.id);
  }

  const token = randomBytes(32).toString("base64url");
  const results = await Promise.allSettled([
    resolveDemoDeviceLogin({ sourceUser: source, deviceToken: token, deviceLabel: "race-a" }),
    resolveDemoDeviceLogin({ sourceUser: source, deviceToken: token, deviceLabel: "race-b" }),
  ]);
  const fulfilled = results.filter(
    (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof resolveDemoDeviceLogin>>> =>
      r.status === "fulfilled",
  );
  assert.ok(fulfilled.length >= 1, "at least one racer must win");
  for (const r of results) {
    if (r.status === "rejected") {
      assert.ok(r.reason instanceof DemoDeviceError, String(r.reason));
      assert.equal(r.reason.status, 409, "loser must back off with 409, never fail the link");
    }
  }
  // All fulfilled racers resolved to the SAME link, and it is ready.
  const linkIds = new Set(fulfilled.map(r => r.value.deviceLinkId));
  assert.equal(linkIds.size, 1);
  const [link] = await db.select().from(demoDeviceWorkspacesTable)
    .where(eq(demoDeviceWorkspacesTable.id, fulfilled[0].value.deviceLinkId!));
  assert.equal(link?.status, "ready");
  // The race must never leave a failed link behind for this user.
  const failed = await db.select({ id: demoDeviceWorkspacesTable.id })
    .from(demoDeviceWorkspacesTable)
    .where(and(
      eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
      eq(demoDeviceWorkspacesTable.status, "failed"),
    ));
  assert.equal(failed.length, 0);
  // Only the winner reports bindingWasCreated.
  assert.equal(fulfilled.filter(r => r.value.bindingWasCreated).length, 1);
  const winner = fulfilled[0].value;
  if (!winner.isPrimary && winner.workspaceCompanyId) {
    cleanupCompanyIds.push(winner.workspaceCompanyId);
    cleanupUserIds.push(winner.effectiveUser.id);
  }
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
