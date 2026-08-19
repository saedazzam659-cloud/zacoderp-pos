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
  DemoDeviceError,
  resolveDemoDeviceLogin,
  revokeDemoDevice,
} from "../src/lib/demoDeviceIsolation.ts";

const tag = `tt_demo_pair_${randomBytes(5).toString("hex")}`;
let companyId = 0;
let sourceUserId = 0;

async function createReadyDevice(tokenSeed: string) {
  const [row] = await db.insert(demoDeviceWorkspacesTable).values({
    sourceUserId,
    sourceCompanyId: companyId,
    workspaceCompanyId: companyId,
    workspaceUserId: sourceUserId,
    deviceTokenHash: tokenSeed.padEnd(64, "0").slice(0, 64),
    deviceLabel: tokenSeed,
    isPrimary: false,
    status: "ready",
  }).returning();
  return row;
}

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
      .where(eq(demoDevicePairCodesTable.sourceUserId, sourceUserId));
    await db.delete(demoDeviceWorkspacesTable)
      .where(eq(demoDeviceWorkspacesTable.sourceUserId, sourceUserId));
    await db.delete(usersTable).where(eq(usersTable.id, sourceUserId));
  }
  if (companyId) await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end().catch(() => {});
});

test("pair-code creation racing revoke never leaves a usable code", async () => {
  const device = await createReadyDevice("race-device");
  const [createResult, revokeResult] = await Promise.allSettled([
    createDemoPairCode(sourceUserId, device.id),
    revokeDemoDevice(sourceUserId, device.id),
  ]);

  assert.equal(revokeResult.status, "fulfilled");
  if (createResult.status === "rejected") {
    assert.ok(createResult.reason instanceof DemoDeviceError);
    assert.equal(createResult.reason.status, 404);
  }

  const unused = await db.select({ id: demoDevicePairCodesTable.id })
    .from(demoDevicePairCodesTable)
    .where(and(
      eq(demoDevicePairCodesTable.createdByDeviceId, device.id),
      isNull(demoDevicePairCodesTable.usedAt),
    ));
  assert.equal(unused.length, 0, "revoke must leave no unused code created by that device");
});

test("a code from a revoked device cannot be redeemed or recreated", async () => {
  const device = await createReadyDevice("redeem-device");
  const pair = await createDemoPairCode(sourceUserId, device.id);
  await revokeDemoDevice(sourceUserId, device.id);

  const [source] = await db.select().from(usersTable).where(eq(usersTable.id, sourceUserId));
  assert.ok(source);
  await assert.rejects(
    () => resolveDemoDeviceLogin({
      sourceUser: source,
      deviceToken: randomBytes(32).toString("hex"),
      pairCode: pair.code,
    }),
    (error: unknown) => error instanceof DemoDeviceError && error.status === 400,
  );
  await assert.rejects(
    () => createDemoPairCode(sourceUserId, device.id),
    (error: unknown) => error instanceof DemoDeviceError && error.status === 404,
  );
});