import { after, before, beforeEach, test } from "node:test";
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
  resolveStrictDemoBrowserLogin,
  revokeDemoDevice,
} from "../src/lib/demoDeviceIsolation.ts";
import { resolveBearerToken } from "../src/middleware/auth.ts";

const tag = `tt_demo_pair_${randomBytes(5).toString("hex")}`;
let companyId = 0;
let sourceUserId = 0;

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

beforeEach(async () => {
  if (!sourceUserId) return;
  await db.delete(demoDevicePairCodesTable)
    .where(eq(demoDevicePairCodesTable.sourceUserId, sourceUserId));
  await db.delete(demoDeviceWorkspacesTable)
    .where(eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId));
  await db.update(usersTable).set({ sessionToken: null, sessionId: null })
    .where(eq(usersTable.id, sourceUserId));
});

after(async () => {
  if (sourceUserId) {
    await db.delete(demoDevicePairCodesTable)
      .where(eq(demoDevicePairCodesTable.sourceUserId, sourceUserId));
    await db.delete(demoDeviceWorkspacesTable)
      .where(eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId));
    await db.delete(usersTable).where(eq(usersTable.id, sourceUserId));
  }
  if (companyId) await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end().catch(() => {});
});

test("two first browsers racing leave exactly one approved browser", async () => {
  const [source] = await db.select().from(usersTable).where(eq(usersTable.id, sourceUserId));
  assert.ok(source);
  const tokenA = randomBytes(32).toString("hex");
  const tokenB = randomBytes(32).toString("hex");
  const results = await Promise.allSettled([
    resolveStrictDemoBrowserLogin({ sourceUser: source, deviceToken: tokenA, deviceLabel: "browser-a" }),
    resolveStrictDemoBrowserLogin({ sourceUser: source, deviceToken: tokenB, deviceLabel: "browser-b" }),
  ]);

  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.ok(rejected?.reason instanceof DemoDeviceError);
  assert.equal(rejected.reason.status, 423);
  assert.equal(rejected.reason.code, "DEMO_BROWSER_LOCKED");

  const active = await db.select().from(demoDeviceWorkspacesTable)
    .where(and(
      eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
      eq(demoDeviceWorkspacesTable.status, "ready"),
      isNull(demoDeviceWorkspacesTable.revokedAt),
    ));
  assert.equal(active.length, 1);
  assert.equal(active[0].isPrimary, true);
  assert.equal(active[0].workspaceCompanyId, companyId);
  assert.equal(active[0].workspaceUserId, sourceUserId);
});

test("same browser may return; another is rejected until admin reset", async () => {
  const [source] = await db.select().from(usersTable).where(eq(usersTable.id, sourceUserId));
  assert.ok(source);
  const approvedToken = randomBytes(32).toString("hex");
  const otherToken = randomBytes(32).toString("hex");
  const first = await resolveStrictDemoBrowserLogin({
    sourceUser: source,
    deviceToken: approvedToken,
    deviceLabel: "approved-browser",
  });
  assert.equal(first.effectiveUser.id, sourceUserId);
  assert.equal(first.workspaceCompanyId, companyId);

  const returning = await resolveStrictDemoBrowserLogin({
    sourceUser: source,
    deviceToken: approvedToken,
    deviceLabel: "approved-browser",
  });
  assert.equal(returning.deviceLinkId, first.deviceLinkId);

  await assert.rejects(
    () => resolveStrictDemoBrowserLogin({
      sourceUser: source,
      deviceToken: otherToken,
      deviceLabel: "other-browser",
    }),
    (error: unknown) =>
      error instanceof DemoDeviceError
      && error.status === 423
      && error.code === "DEMO_BROWSER_LOCKED",
  );
  await revokeDemoDevice(sourceUserId, first.deviceLinkId!);
  const rebound = await resolveStrictDemoBrowserLogin({
    sourceUser: source,
    deviceToken: otherToken,
    deviceLabel: "other-browser",
  });
  assert.equal(rebound.effectiveUser.id, sourceUserId);
  assert.notEqual(rebound.deviceLinkId, first.deviceLinkId);
});

test("pair-code creation is disabled by strict policy", async () => {
  await assert.rejects(
    () => createDemoPairCode(sourceUserId, 1),
    (error: unknown) =>
      error instanceof DemoDeviceError
      && error.status === 410
      && error.code === "DEMO_PAIRING_DISABLED",
  );
});

test("a bearer token is unusable without the approved HttpOnly browser cookie", async () => {
  const [source] = await db.select().from(usersTable).where(eq(usersTable.id, sourceUserId));
  assert.ok(source);
  const approvedToken = randomBytes(32).toString("hex");
  await resolveStrictDemoBrowserLogin({
    sourceUser: source,
    deviceToken: approvedToken,
    deviceLabel: "approved-browser",
  });

  const bearer = `bearer-${randomBytes(24).toString("hex")}`;
  await db.update(usersTable).set({ sessionToken: bearer, sessionId: "strict-demo-test" })
    .where(eq(usersTable.id, sourceUserId));

  assert.equal(await resolveBearerToken(bearer), null, "copied bearer alone must be rejected");
  assert.equal(
    await resolveBearerToken(
      bearer,
      `${DEMO_BROWSER_COOKIE}=${randomBytes(32).toString("hex")}`,
    ),
    null,
    "wrong browser cookie must be rejected",
  );
  const approved = await resolveBearerToken(
    bearer,
    `${DEMO_BROWSER_COOKIE}=${approvedToken}`,
  );
  assert.equal(approved?.user.id, sourceUserId);

  const [link] = await db.select({ id: demoDeviceWorkspacesTable.id })
    .from(demoDeviceWorkspacesTable)
    .where(and(
      eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId),
      isNull(demoDeviceWorkspacesTable.revokedAt),
    ));
  assert.ok(link);
  await revokeDemoDevice(sourceUserId, link.id);
  assert.equal(
    await resolveBearerToken(bearer, `${DEMO_BROWSER_COOKIE}=${approvedToken}`),
    null,
    "revocation must invalidate the bearer even when the old cookie remains",
  );
});