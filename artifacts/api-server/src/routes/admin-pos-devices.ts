// SuperAdmin UI for Windows Desktop POS — license & device management +
// download-page release URLs per country. SuperAdmin only.

import { Router } from "express";
import { db } from "@workspace/db";
import {
  deviceLicensesTable, posDevicesTable, syncQueueLogTable,
  downloadReleasesTable, companiesTable,
} from "@workspace/db";
import { eq, and, desc, sql, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import { extractAuth } from "../middleware/auth.js";
import { generateLicenseKey } from "../lib/posDesktopGuards.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if ((req as any).authUser?.role !== "superadmin") {
    res.status(403).json({ error: "superadmin only" }); return;
  }
  next();
});

// ═════════════════════════════════════════════════════════════════════
// LICENSES
// ═════════════════════════════════════════════════════════════════════
router.get("/licenses", async (req, res) => {
  const companyId = req.query.companyId ? Number(req.query.companyId) : undefined;
  const status = req.query.status ? String(req.query.status) : undefined;
  const conds = [];
  if (companyId) conds.push(eq(deviceLicensesTable.companyId, companyId));
  if (status) conds.push(eq(deviceLicensesTable.status, status));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select({
    id: deviceLicensesTable.id,
    licenseKey: deviceLicensesTable.licenseKey,
    companyId: deviceLicensesTable.companyId,
    companyName: companiesTable.nameAr,
    deviceId: deviceLicensesTable.deviceId,
    status: deviceLicensesTable.status,
    plan: deviceLicensesTable.plan,
    issuedAt: deviceLicensesTable.issuedAt,
    activatedAt: deviceLicensesTable.activatedAt,
    expiresAt: deviceLicensesTable.expiresAt,
    revokedAt: deviceLicensesTable.revokedAt,
    notes: deviceLicensesTable.notes,
  }).from(deviceLicensesTable)
    .leftJoin(companiesTable, eq(companiesTable.id, deviceLicensesTable.companyId))
    .where(where as any)
    .orderBy(desc(deviceLicensesTable.id))
    .limit(500);
  res.json(rows);
});

const generateSchema = z.object({
  count: z.number().int().min(1).max(100).default(1),
  plan: z.enum(["pos_basic", "pos_full"]).default("pos_full"),
  expiresAt: z.string().datetime().optional(),
  notes: z.string().max(500).optional(),
  companyId: z.number().int().positive().optional(),
});
router.post("/licenses/generate", async (req, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const { count, plan, expiresAt, notes, companyId } = parsed.data;
  const userId = (req as any).authUser?.id ?? null;

  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      licenseKey: generateLicenseKey(),
      plan,
      companyId: companyId ?? null,
      status: companyId ? "assigned" : "unassigned",
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      notes,
      createdByUserId: userId,
    });
  }
  const created = await db.insert(deviceLicensesTable).values(rows).returning();
  res.json({ ok: true, created });
});

const assignSchema = z.object({ companyId: z.number().int().positive() });
router.post("/licenses/:id/assign", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "bad id" }); return; }
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload" }); return; }
  const [lic] = await db.select().from(deviceLicensesTable).where(eq(deviceLicensesTable.id, id));
  if (!lic) { res.status(404).json({ error: "license not found" }); return; }
  if (lic.deviceId) { res.status(409).json({ error: "license is already bound to a device; revoke first" }); return; }
  await db.update(deviceLicensesTable).set({
    companyId: parsed.data.companyId,
    status: "assigned",
    updatedAt: new Date(),
  }).where(eq(deviceLicensesTable.id, id));
  res.json({ ok: true });
});

router.post("/licenses/:id/revoke", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "bad id" }); return; }
  const [lic] = await db.select().from(deviceLicensesTable).where(eq(deviceLicensesTable.id, id));
  if (!lic) { res.status(404).json({ error: "license not found" }); return; }
  await db.update(deviceLicensesTable).set({
    status: "revoked", revokedAt: new Date(), updatedAt: new Date(),
  }).where(eq(deviceLicensesTable.id, id));
  if (lic.deviceId) {
    await db.update(posDevicesTable).set({
      status: "revoked", deactivatedAt: new Date(), updatedAt: new Date(),
    }).where(eq(posDevicesTable.id, lic.deviceId));
  }
  res.json({ ok: true });
});

const extendSchema = z.object({ expiresAt: z.string().datetime() });
router.post("/licenses/:id/extend", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "bad id" }); return; }
  const parsed = extendSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload" }); return; }
  await db.update(deviceLicensesTable).set({
    expiresAt: new Date(parsed.data.expiresAt),
    status: "active",
    updatedAt: new Date(),
  }).where(eq(deviceLicensesTable.id, id));
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════
// DEVICES
// ═════════════════════════════════════════════════════════════════════
router.get("/devices", async (req, res) => {
  const companyId = req.query.companyId ? Number(req.query.companyId) : undefined;
  const conds = companyId ? [eq(posDevicesTable.companyId, companyId)] : [];
  const rows = await db.select({
    id: posDevicesTable.id,
    companyId: posDevicesTable.companyId,
    companyName: companiesTable.nameAr,
    branchId: posDevicesTable.branchId,
    deviceName: posDevicesTable.deviceName,
    status: posDevicesTable.status,
    appVersion: posDevicesTable.appVersion,
    osInfo: posDevicesTable.osInfo,
    fingerprintHash: posDevicesTable.fingerprintHash,
    lastHeartbeatAt: posDevicesTable.lastHeartbeatAt,
    lastSeenIp: posDevicesTable.lastSeenIp,
    lastSyncAt: posDevicesTable.lastSyncAt,
    licenseId: posDevicesTable.licenseId,
    createdAt: posDevicesTable.createdAt,
  }).from(posDevicesTable)
    .leftJoin(companiesTable, eq(companiesTable.id, posDevicesTable.companyId))
    .where(conds.length ? and(...conds) : undefined as any)
    .orderBy(desc(posDevicesTable.id))
    .limit(500);
  res.json(rows);
});

router.post("/devices/:id/unbind", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "bad id" }); return; }
  const [dev] = await db.select().from(posDevicesTable).where(eq(posDevicesTable.id, id));
  if (!dev) { res.status(404).json({ error: "device not found" }); return; }
  await db.update(posDevicesTable).set({
    status: "deactivated", deactivatedAt: new Date(), updatedAt: new Date(),
  }).where(eq(posDevicesTable.id, id));
  if (dev.licenseId) {
    await db.update(deviceLicensesTable).set({
      status: "assigned", deviceId: null, updatedAt: new Date(),
    }).where(eq(deviceLicensesTable.id, dev.licenseId));
  }
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════
// SYNC LOGS
// ═════════════════════════════════════════════════════════════════════
router.get("/sync-logs", async (req, res) => {
  const deviceId = req.query.deviceId ? Number(req.query.deviceId) : undefined;
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const conds = deviceId ? [eq(syncQueueLogTable.deviceId, deviceId)] : [];
  const rows = await db.select().from(syncQueueLogTable)
    .where(conds.length ? and(...conds) : undefined as any)
    .orderBy(desc(syncQueueLogTable.id))
    .limit(limit);
  res.json(rows);
});

// ═════════════════════════════════════════════════════════════════════
// DOWNLOAD RELEASES
// ═════════════════════════════════════════════════════════════════════
router.get("/releases", async (_req, res) => {
  const rows = await db.select().from(downloadReleasesTable).orderBy(desc(downloadReleasesTable.id));
  res.json(rows);
});

const releaseSchema = z.object({
  countryCode: z.string().min(2).max(3),
  platform: z.string().default("win-x64"),
  version: z.string().min(1).max(50),
  downloadUrl: z.string().url(),
  fileSizeBytes: z.number().int().nonnegative().optional(),
  checksumSha256: z.string().length(64).optional(),
  releaseNotes: z.string().max(5000).optional(),
  isActive: z.boolean().default(true),
});
router.post("/releases", async (req, res) => {
  const parsed = releaseSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const [created] = await db.insert(downloadReleasesTable).values({
    ...parsed.data,
    countryCode: parsed.data.countryCode.toUpperCase(),
  }).returning();
  res.json(created);
});

router.patch("/releases/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "bad id" }); return; }
  const parsed = releaseSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload" }); return; }
  const patch: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
  if (parsed.data.countryCode) patch.countryCode = parsed.data.countryCode.toUpperCase();
  await db.update(downloadReleasesTable).set(patch).where(eq(downloadReleasesTable.id, id));
  res.json({ ok: true });
});

router.delete("/releases/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "bad id" }); return; }
  await db.delete(downloadReleasesTable).where(eq(downloadReleasesTable.id, id));
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════
// COMPANY FEATURE FLAG TOGGLE
// ═════════════════════════════════════════════════════════════════════
const flagSchema = z.object({ enableOfflinePos: z.boolean() });
router.patch("/company/:id/offline-pos-flag", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "bad id" }); return; }
  const parsed = flagSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload" }); return; }
  await db.update(companiesTable).set({
    enableOfflinePos: parsed.data.enableOfflinePos,
    updatedAt: new Date(),
  }).where(eq(companiesTable.id, id));
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════
// STATS
// ═════════════════════════════════════════════════════════════════════
router.get("/stats", async (_req, res) => {
  const totalLicenses = (await db.select({ c: sql<number>`count(*)::int` }).from(deviceLicensesTable))[0]?.c ?? 0;
  const activeLicenses = (await db.select({ c: sql<number>`count(*)::int` }).from(deviceLicensesTable).where(eq(deviceLicensesTable.status, "active")))[0]?.c ?? 0;
  const unassignedLicenses = (await db.select({ c: sql<number>`count(*)::int` }).from(deviceLicensesTable).where(eq(deviceLicensesTable.status, "unassigned")))[0]?.c ?? 0;
  const revokedLicenses = (await db.select({ c: sql<number>`count(*)::int` }).from(deviceLicensesTable).where(eq(deviceLicensesTable.status, "revoked")))[0]?.c ?? 0;
  const totalDevices = (await db.select({ c: sql<number>`count(*)::int` }).from(posDevicesTable))[0]?.c ?? 0;
  const activeDevices = (await db.select({ c: sql<number>`count(*)::int` }).from(posDevicesTable).where(eq(posDevicesTable.status, "active")))[0]?.c ?? 0;
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const onlineDevices = (await db.select({ c: sql<number>`count(*)::int` }).from(posDevicesTable)
    .where(and(eq(posDevicesTable.status, "active"), sql`last_heartbeat_at > ${fiveMinAgo.toISOString()}`)))[0]?.c ?? 0;
  res.json({
    totalLicenses, activeLicenses, unassignedLicenses, revokedLicenses,
    totalDevices, activeDevices, onlineDevices,
  });
});

export default router;
