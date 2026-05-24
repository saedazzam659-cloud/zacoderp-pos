// Windows Desktop POS (Task #174) — shared guards & helpers.
// All sync/license/device APIs go through these to enforce the
// `companies.enable_offline_pos` feature flag and to authenticate the
// Windows desktop app via the per-device X-Device-Token header.

import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { companiesTable, posDevicesTable, deviceLicensesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";

export interface DeviceAuthedRequest extends Request {
  device?: {
    id: number;
    companyId: number;
    branchId: number | null;
    licenseId: number | null;
    fingerprintHash: string;
  };
}

/** Resolve a request to a Device by its X-Device-Token header. */
export async function deviceAuth(req: DeviceAuthedRequest, res: Response, next: NextFunction) {
  const token = String(req.headers["x-device-token"] || "").trim();
  if (!token) {
    res.status(401).json({ error: "device token required" });
    return;
  }
  const [dev] = await db.select().from(posDevicesTable).where(eq(posDevicesTable.deviceToken, token));
  if (!dev) { res.status(401).json({ error: "invalid device token" }); return; }
  if (dev.status !== "active") {
    res.status(403).json({ error: "device disabled", status: dev.status });
    return;
  }
  // Enforce the per-company feature flag.
  const [co] = await db.select().from(companiesTable).where(eq(companiesTable.id, dev.companyId));
  if (!co || !co.enableOfflinePos) {
    res.status(403).json({ error: "offline POS not enabled for this company" });
    return;
  }
  if (co.status === "suspended" || co.deletedAt) {
    res.status(403).json({ error: "company suspended or deleted" });
    return;
  }
  // Check license validity if attached.
  if (dev.licenseId) {
    const [lic] = await db.select().from(deviceLicensesTable).where(eq(deviceLicensesTable.id, dev.licenseId));
    if (!lic || lic.status === "revoked" || lic.status === "expired") {
      res.status(403).json({ error: "license revoked or expired" });
      return;
    }
    if (lic.expiresAt && lic.expiresAt.getTime() < Date.now()) {
      res.status(403).json({ error: "license expired", expiresAt: lic.expiresAt });
      return;
    }
  }
  req.device = {
    id: dev.id,
    companyId: dev.companyId,
    branchId: dev.branchId,
    licenseId: dev.licenseId,
    fingerprintHash: dev.fingerprintHash,
  };
  next();
}

/** Generate a 24-char base32-ish license key formatted as XXXX-XXXX-XXXX-XXXX-XXXX. */
export function generateLicenseKey(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const raw = randomBytes(20);
  const chars: string[] = [];
  for (let i = 0; i < 20; i++) chars.push(alphabet[raw[i] % alphabet.length]);
  return [chars.slice(0,4), chars.slice(4,8), chars.slice(8,12), chars.slice(12,16), chars.slice(16,20)]
    .map((g) => g.join("")).join("-");
}

/** Generate a 64-char device session token (high entropy). */
export function generateDeviceToken(): string {
  return randomBytes(48).toString("base64url");
}

/** Hash a raw fingerprint string the client sends (we never store the raw fingerprint). */
export function hashFingerprint(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Quick lookup: is offline POS enabled for the given company?
 * Used by SuperAdmin UI endpoints that don't require a device token.
 */
export async function isOfflinePosEnabled(companyId: number): Promise<boolean> {
  const [co] = await db.select({ flag: companiesTable.enableOfflinePos })
    .from(companiesTable).where(eq(companiesTable.id, companyId));
  return Boolean(co?.flag);
}

/** Re-export for routes that need it. */
export { posDevicesTable, deviceLicensesTable };
