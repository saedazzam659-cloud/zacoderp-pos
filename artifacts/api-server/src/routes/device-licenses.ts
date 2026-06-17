// Windows Desktop POS — license activation/validation/deactivation.
// These endpoints are called BY THE DESKTOP APP (no user JWT). The
// /activate call exchanges a license_key + hardware fingerprint for a
// long-lived device token. All subsequent calls (sync, validate,
// deactivate) authenticate via X-Device-Token.

import { Router } from "express";
import { db } from "@workspace/db";
import {
  deviceLicensesTable, posDevicesTable, companiesTable, branchesTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  deviceAuth, generateDeviceToken, hashFingerprint,
  type DeviceAuthedRequest,
} from "../lib/posDesktopGuards.js";

const router = Router();

const activateSchema = z.object({
  licenseKey: z.string().min(8),
  fingerprint: z.string().min(8),
  deviceName: z.string().min(1).max(120),
  branchId: z.number().int().positive().optional(),
  osInfo: z.string().max(500).optional(),
  appVersion: z.string().max(50).optional(),
});

// ─── POST /api/device-licenses/activate ──────────────────────────────
// First-time activation on the desktop app. Binds a license to a device
// fingerprint, creates a `pos_devices` row, and returns the device token
// the app must persist locally to call sync/heartbeat later.
router.post("/activate", async (req, res) => {
  const parsed = activateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const { licenseKey, fingerprint, deviceName, branchId, osInfo, appVersion } = parsed.data;

  const fpHash = hashFingerprint(fingerprint);

  // ─── Concurrency-safe activation ─────────────────────────────────────
  // The whole license-resolve → device-create → license-bind cycle runs
  // inside a single transaction with a SELECT ... FOR UPDATE row lock on
  // the license row. This prevents two parallel /activate calls from
  // both seeing `deviceId IS NULL` and each minting a valid token for
  // the same key (which would silently grant 2 active devices on a
  // 1-license/1-device contract). See Task #174 architect review.
  try {
    const out = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute<{
        id: number; license_key: string; company_id: number | null; device_id: number | null;
        status: string; plan: string; expires_at: Date | null;
      }>(sql`
        SELECT id, license_key, company_id, device_id, status, plan, expires_at
        FROM device_licenses
        WHERE license_key = ${licenseKey}
        FOR UPDATE
      `);
      const lic = (lockedRows.rows ?? lockedRows as any)[0];
      if (!lic) return { code: 404 as const, body: { error: "license key not found" } };
      if (lic.status === "revoked" || lic.status === "expired") {
        return { code: 403 as const, body: { error: `license ${lic.status}` } };
      }
      const expiresAt = lic.expires_at ? new Date(lic.expires_at) : null;
      if (expiresAt && expiresAt.getTime() < Date.now()) {
        return { code: 403 as const, body: { error: "license expired", expiresAt } };
      }
      if (!lic.company_id) {
        return { code: 400 as const, body: { error: "license not yet assigned to a company by SuperAdmin" } };
      }

      const [co] = await tx.select().from(companiesTable).where(eq(companiesTable.id, lic.company_id));
      if (!co || !co.enableOfflinePos) {
        return { code: 403 as const, body: { error: "offline POS not enabled for the licensed company" } };
      }

      // Re-activation: same fingerprint on the already-bound device → rotate token.
      if (lic.device_id) {
        const [existing] = await tx.select().from(posDevicesTable).where(eq(posDevicesTable.id, lic.device_id));
        if (existing && existing.fingerprintHash === fpHash) {
          const token = generateDeviceToken();
          await tx.update(posDevicesTable).set({
            deviceToken: token,
            status: "active",
            appVersion: appVersion ?? existing.appVersion,
            osInfo: osInfo ?? existing.osInfo,
            updatedAt: new Date(),
          }).where(eq(posDevicesTable.id, existing.id));
          return {
            code: 200 as const,
            body: {
              deviceId: existing.id, deviceToken: token, companyId: co.id,
              companyName: co.nameAr, expiresAt,
              message: "device re-activated",
            },
          };
        }
        return {
          code: 409 as const,
          body: { error: "license already bound to a different device. Ask SuperAdmin to unbind it first." },
        };
      }

      // Fresh activation — validate branch, create device, bind license atomically.
      if (branchId) {
        const [br] = await tx.select().from(branchesTable)
          .where(and(eq(branchesTable.id, branchId), eq(branchesTable.companyId, co.id)));
        if (!br) return { code: 400 as const, body: { error: "branch does not belong to this company" } };
      }

      const deviceToken = generateDeviceToken();
      const [created] = await tx.insert(posDevicesTable).values({
        companyId: co.id,
        branchId: branchId ?? null,
        deviceName,
        fingerprintHash: fpHash,
        licenseId: lic.id,
        deviceToken,
        status: "active",
        appVersion,
        osInfo,
        lastSeenIp: req.ip ?? null,
        lastHeartbeatAt: new Date(),
      }).returning();

      await tx.update(deviceLicensesTable).set({
        deviceId: created.id,
        status: "active",
        activatedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(deviceLicensesTable.id, lic.id));

      return {
        code: 200 as const,
        body: {
          deviceId: created.id, deviceToken, companyId: co.id,
          companyName: co.nameAr, branchId: created.branchId,
          expiresAt, message: "device activated",
        },
      };
    });

    res.status(out.code).json(out.body);
  } catch (err: any) {
    req.log.error({ err }, "device-licenses/activate failed");
    res.status(500).json({ error: "activation failed" });
  }
});

// ─── POST /api/device-licenses/validate ──────────────────────────────
// Periodic license check. Desktop app calls this every hour to ensure
// the device is still authorized. Returns 200 with status or 403.
router.post("/validate", deviceAuth, async (req: DeviceAuthedRequest, res) => {
  const lic = req.device!.licenseId
    ? (await db.select().from(deviceLicensesTable).where(eq(deviceLicensesTable.id, req.device!.licenseId!)))[0]
    : null;

  const expiresAt = lic?.expiresAt ?? null;

  // Authoritative expiry / revocation enforcement — must mirror /activate.
  // Without this, a device whose license was revoked or whose expiry date
  // has passed would keep booting: /validate would always return 200
  // {valid:true}, leaving expiry enforcement entirely up to the desktop
  // client (which can be tampered with or run an outdated build). The
  // desktop's boot 403 handler turns these responses into the
  // license-expired / re-activation screen.
  //
  // Fail closed: an active device must always be bound to a valid license.
  // The activation flow always sets licenseId, and deactivation flips the
  // device to a non-active status (rejected earlier by deviceAuth), so a
  // null/missing license here means the binding was lost — never open.
  if (!lic) {
    res.status(403).json({ error: "license missing", expiresAt: null });
    return;
  }
  if (lic.status === "revoked" || lic.status === "expired") {
    res.status(403).json({ error: `license ${lic.status}`, expiresAt });
    return;
  }
  if (expiresAt && expiresAt.getTime() < Date.now()) {
    res.status(403).json({ error: "license expired", expiresAt });
    return;
  }

  res.json({
    valid: true,
    deviceId: req.device!.id,
    companyId: req.device!.companyId,
    licenseStatus: lic?.status ?? null,
    expiresAt,
    serverTime: new Date().toISOString(),
  });
});

// ─── POST /api/device-licenses/deactivate ────────────────────────────
// Voluntary deactivation from the desktop app (user clicked "logout
// device" or uninstalled). Frees the license so it can be reassigned.
router.post("/deactivate", deviceAuth, async (req: DeviceAuthedRequest, res) => {
  const did = req.device!.id;
  await db.update(posDevicesTable).set({
    status: "deactivated",
    deactivatedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(posDevicesTable.id, did));
  if (req.device!.licenseId) {
    await db.update(deviceLicensesTable).set({
      status: "assigned",
      deviceId: null,
      updatedAt: new Date(),
    }).where(eq(deviceLicensesTable.id, req.device!.licenseId));
  }
  res.json({ ok: true, message: "device deactivated" });
});

export default router;
