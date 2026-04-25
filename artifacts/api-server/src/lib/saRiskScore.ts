import { db } from "@workspace/db";
import { superAdminLoginAttemptsTable, superAdminTrustedDevicesTable } from "@workspace/db";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

// Outcomes that should count as actual login failures for the recent-failures
// risk factor. "otp_sent" / "otp_resent" / "needs_device_approval" are
// success=false in DB only because the session is not yet finalized — they
// are NOT bad attempts and must be excluded. The "denied" outcome is the
// generic failure bucket emitted by the SA login route for missing user,
// inactive account, or wrong password (failureReason carries the detail).
const FAILURE_OUTCOMES = [
  "denied",
  "bad_password",
  "bad_otp",
  "expired_otp",
  "bad_recovery_code",
  "blocked_high_risk",
  "rate_limited",
  "turnstile_failed",
  "captcha_failed",
  "device_denied",
];

export type RiskLevel = "low" | "medium" | "high";

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  factors: string[];
  isNewDevice: boolean;
  isNewIp: boolean;
}

export async function assessRisk(opts: {
  userId: number;
  ip: string | null;
  deviceFingerprint: string;
  hour: number;
}): Promise<RiskAssessment> {
  const { userId, ip, deviceFingerprint, hour } = opts;
  const factors: string[] = [];
  let score = 0;

  const [trusted] = await db
    .select({ id: superAdminTrustedDevicesTable.id })
    .from(superAdminTrustedDevicesTable)
    .where(and(
      eq(superAdminTrustedDevicesTable.userId, userId),
      eq(superAdminTrustedDevicesTable.deviceFingerprint, deviceFingerprint),
      isNull(superAdminTrustedDevicesTable.revokedAt),
    ))
    .limit(1);
  const isNewDevice = !trusted;
  if (isNewDevice) { score += 25; factors.push("new_device"); }

  let isNewIp = false;
  if (ip) {
    const [seenBefore] = await db
      .select({ id: superAdminLoginAttemptsTable.id })
      .from(superAdminLoginAttemptsTable)
      .where(and(
        eq(superAdminLoginAttemptsTable.userId, userId),
        eq(superAdminLoginAttemptsTable.ip, ip),
        eq(superAdminLoginAttemptsTable.success, true),
      ))
      .limit(1);
    isNewIp = !seenBefore;
    if (isNewIp) { score += 15; factors.push("new_ip"); }
  } else {
    isNewIp = true;
    factors.push("no_ip");
    score += 5;
  }

  if (hour < 6 || hour > 22) { score += 10; factors.push("off_hours"); }

  const since = new Date(Date.now() - 15 * 60_000);
  const recentFails = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(superAdminLoginAttemptsTable)
    .where(and(
      eq(superAdminLoginAttemptsTable.userId, userId),
      inArray(superAdminLoginAttemptsTable.outcome, FAILURE_OUTCOMES),
      gt(superAdminLoginAttemptsTable.createdAt, since),
    ));
  const failCount = recentFails[0]?.count ?? 0;
  if (failCount >= 3) { score += 30; factors.push(`recent_failures:${failCount}`); }
  else if (failCount > 0) { score += 5 * failCount; factors.push(`recent_failures:${failCount}`); }

  if (ip) {
    const sinceIp = new Date(Date.now() - 60 * 60_000);
    const ipFails = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(superAdminLoginAttemptsTable)
      .where(and(
        eq(superAdminLoginAttemptsTable.ip, ip),
        inArray(superAdminLoginAttemptsTable.outcome, FAILURE_OUTCOMES),
        gt(superAdminLoginAttemptsTable.createdAt, sinceIp),
      ));
    const c = ipFails[0]?.count ?? 0;
    if (c >= 5) { score += 25; factors.push(`ip_brute:${c}`); }
  }

  await db
    .select({ id: superAdminLoginAttemptsTable.id })
    .from(superAdminLoginAttemptsTable)
    .where(eq(superAdminLoginAttemptsTable.userId, userId))
    .orderBy(desc(superAdminLoginAttemptsTable.createdAt))
    .limit(1);

  const level: RiskLevel = score >= 60 ? "high" : score >= 25 ? "medium" : "low";
  return { score, level, factors, isNewDevice, isNewIp };
}
