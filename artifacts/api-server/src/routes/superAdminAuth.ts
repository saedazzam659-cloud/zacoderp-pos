import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomBytes, randomInt, createHash } from "crypto";
import { db } from "@workspace/db";
import {
  usersTable,
  superAdminOtpCodesTable,
  superAdminTrustedDevicesTable,
  superAdminSessionsTable,
  superAdminLoginAttemptsTable,
  superAdminRecoveryCodesTable,
  superAdminDeviceApprovalsTable,
  superAdminRecoveryLinksTable,
  auditLogTable,
} from "@workspace/db";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { clientIpFrom, computeFingerprint, describeDevice } from "../lib/deviceFingerprint.js";
import { verifyTurnstile, turnstileEnabled } from "../lib/turnstile.js";
import { assessRisk } from "../lib/saRiskScore.js";
import {
  emailConfigured,
  sendOtpEmail,
  sendNewDeviceAlert,
  sendFailedLoginAlert,
  sendPasswordChangeAlert,
  sendDeviceApprovalRequest,
  sendRecoveryLink,
} from "../lib/email.js";
import { saLoginIpLimit, saLoginUsernameLimit, saOtpLimit, saRecoveryLimit, saUserCreateLimit } from "../middleware/saRateLimit.js";

const router = Router();

const OTP_TTL_MS = 60_000;
const APPROVAL_TTL_MS = 15 * 60_000;
const RECOVERY_TTL_MS = 30 * 60_000;
const MAX_OTP_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = (bytes = 32) => randomBytes(bytes).toString("hex");
const newOtp = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

// Emergency operator bypass: when the deployment has no working email
// transport (no SMTP secrets and no live Outlook connector), a SuperAdmin
// can be locked out of new devices because the approval / OTP messages
// never arrive. Setting SA_EMERGENCY_BYPASS=1 in the deployment env unlocks
// two operator-only behaviors:
//   1. Device-approval is skipped — login proceeds straight to the OTP
//      challenge even from a brand-new device.
//   2. The OTP code is printed to the server logs (with a SECURITY tag) so
//      the operator who controls the deployment can read it from the live
//      logs and complete the multi-factor login without an email round-trip.
// Disable the flag immediately after recovering access.
const emergencyBypassEnabled = (): boolean => {
  const v = (process.env.SA_EMERGENCY_BYPASS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
};
const newRecoveryCode = () => {
  const raw = randomBytes(8).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.slice(0, 4) + "-" + raw.slice(4, 8);
};

// Base URL for security email links. Prefers configured values over
// request headers (Host can be forged → would phish recovery tokens).
function publicBaseUrlFromReq(req: any): string {
  const fixed = (process.env.PUBLIC_BASE_URL ?? "").trim();
  if (fixed) return fixed.replace(/\/+$/, "");
  const replitDev = (process.env.REPLIT_DEV_DOMAIN ?? "").trim();
  if (replitDev) return `https://${replitDev}`;
  const replitDomains = (process.env.REPLIT_DOMAINS ?? "").split(",")[0]?.trim();
  if (replitDomains) return `https://${replitDomains}`;
  const proto = (req.headers["x-forwarded-proto"]?.toString() || "https").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"]?.toString() || req.headers.host?.toString() || "");
  return host ? `${proto}://${host}` : "";
}

async function recordAttempt(opts: {
  userId: number | null;
  username: string | null;
  ip: string | null;
  userAgent: string | null;
  deviceFingerprint: string | null;
  success: boolean;
  outcome: string;
  failureReason?: string | null;
  riskScore?: number;
  riskLevel?: string;
  riskFactors?: any;
}) {
  await db.insert(superAdminLoginAttemptsTable).values({
    userId: opts.userId,
    username: (opts.username ?? "").slice(0, 80),
    ip: opts.ip,
    userAgent: opts.userAgent,
    deviceFingerprint: opts.deviceFingerprint,
    success: opts.success,
    outcome: opts.outcome,
    failureReason: opts.failureReason ?? null,
    riskScore: opts.riskScore ?? 0,
    riskLevel: opts.riskLevel ?? "low",
    riskFactors: opts.riskFactors ?? null,
  });
}

async function bearerSuperAdmin(req: any) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const [s] = await db
    .select({
      sessionId: superAdminSessionsTable.id,
      userId: superAdminSessionsTable.userId,
      revokedAt: superAdminSessionsTable.revokedAt,
    })
    .from(superAdminSessionsTable)
    .where(eq(superAdminSessionsTable.sessionToken, token));
  if (!s || s.revokedAt) return null;
  const [u] = await db.select().from(usersTable).where(eq(usersTable.id, s.userId));
  if (!u || !u.isActive || u.role !== "superadmin") return null;
  await db.update(superAdminSessionsTable).set({ lastSeenAt: new Date() })
    .where(eq(superAdminSessionsTable.id, s.sessionId));
  return { user: u, sessionRowId: s.sessionId, sessionToken: token };
}

// ─── Step 1: credentials + Turnstile ───────────────────────────────────────
router.post("/login", saLoginIpLimit, saLoginUsernameLimit, async (req, res) => {
  const { username, password, turnstileToken } = req.body ?? {};
  const ip = clientIpFrom(req);
  const ua = req.headers["user-agent"]?.toString().slice(0, 500) ?? null;
  const fp = computeFingerprint(req);

  if (!username || !password) {
    res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" });
    return;
  }

  if (turnstileEnabled()) {
    const t = await verifyTurnstile(turnstileToken, ip);
    if (!t.ok) {
      await recordAttempt({
        userId: null, username, ip, userAgent: ua, deviceFingerprint: fp,
        success: false, outcome: "captcha_failed", failureReason: t.reason ?? null,
      });
      res.status(400).json({ error: "تحقق الكابتشا فشل، أعد المحاولة." });
      return;
    }
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  if (!user || user.role !== "superadmin") {
    await recordAttempt({
      userId: user?.id ?? null, username, ip, userAgent: ua, deviceFingerprint: fp,
      success: false, outcome: "denied", failureReason: "unknown_or_not_superadmin",
    });
    res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
    return;
  }
  if (!user.isActive) {
    await recordAttempt({
      userId: user.id, username, ip, userAgent: ua, deviceFingerprint: fp,
      success: false, outcome: "denied", failureReason: "inactive",
    });
    res.status(403).json({ error: "الحساب موقوف. تواصل مع الدعم." });
    return;
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    await recordAttempt({
      userId: user.id, username, ip, userAgent: ua, deviceFingerprint: fp,
      success: false, outcome: "denied", failureReason: "bad_password",
    });
    if (user.email) {
      sendFailedLoginAlert(user.email, ip, "bad_password").catch(() => {});
    }
    res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
    return;
  }

  // ── Risk assessment
  const hour = new Date().getHours();
  const risk = await assessRisk({ userId: user.id, ip, deviceFingerprint: fp, hour });

  // High-risk hard-block intentionally disabled by request: the SuperAdmin
  // should never be locked out of the control panel by the risk score.
  // OTP + device-approval challenges below still gate suspicious logins,
  // and we still record the elevated risk in the audit trail + email alert
  // so the activity remains visible in the Security Center.
  if (risk.level === "high") {
    await recordAttempt({
      userId: user.id, username, ip, userAgent: ua, deviceFingerprint: fp,
      success: false, outcome: "high_risk_observed",
      riskScore: risk.score, riskLevel: risk.level, riskFactors: risk.factors,
    });
    if (user.email) sendFailedLoginAlert(user.email, ip, `high_risk_observed:${risk.factors.join(",")}`).catch(() => {});
  }

  // ── Trusted device check
  const [trusted] = await db
    .select()
    .from(superAdminTrustedDevicesTable)
    .where(and(
      eq(superAdminTrustedDevicesTable.userId, user.id),
      eq(superAdminTrustedDevicesTable.deviceFingerprint, fp),
      isNull(superAdminTrustedDevicesTable.revokedAt),
    ))
    .limit(1);

  // Special case: if user has ZERO trusted devices, this is a first-ever
  // login → auto-trust this device (bootstrap).
  const [anyTrusted] = await db
    .select({ id: superAdminTrustedDevicesTable.id })
    .from(superAdminTrustedDevicesTable)
    .where(and(
      eq(superAdminTrustedDevicesTable.userId, user.id),
      isNull(superAdminTrustedDevicesTable.revokedAt),
    ))
    .limit(1);
  const isBootstrap = !anyTrusted;

  let needsApproval = false;
  let approvalToken: string | null = null;
  const emergency = emergencyBypassEnabled();

  if (!trusted && !isBootstrap && !emergency) {
    // Create approval request, email link to user
    approvalToken = newToken(24);
    await db.insert(superAdminDeviceApprovalsTable).values({
      userId: user.id,
      approvalToken,
      requestingDeviceFp: fp,
      requestingIp: ip,
      requestingUserAgent: ua,
      status: "pending",
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    });
    if (user.email) {
      sendDeviceApprovalRequest(user.email, approvalToken, ip, ua, publicBaseUrlFromReq(req)).catch(() => {});
    }
    needsApproval = true;
  }

  if (needsApproval) {
    await recordAttempt({
      userId: user.id, username, ip, userAgent: ua, deviceFingerprint: fp,
      success: false, outcome: "needs_device_approval",
      riskScore: risk.score, riskLevel: risk.level, riskFactors: risk.factors,
    });
    res.json({
      stage: "device_approval",
      approvalToken,
      requiresDeviceApproval: true,
      message: "هذا جهاز جديد. تم إرسال رابط الاعتماد إلى بريدك. وافق عليه من جهاز موثوق ثم أعد المحاولة.",
    });
    return;
  }

  // Generate OTP
  const code = newOtp();
  const challengeToken = newToken(24);
  await db.insert(superAdminOtpCodesTable).values({
    userId: user.id,
    challengeToken,
    codeHash: sha256(code),
    purpose: "login",
    deviceFingerprint: fp,
    ip,
    userAgent: ua,
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });

  if (user.email) {
    sendOtpEmail(user.email, code, ip, ua).catch(() => {});
  }
  // Initial-setup convenience: when SMTP isn't configured AND we're running
  // outside of production, surface the OTP to server logs so the engineer
  // can complete the multi-factor login. NEVER log the actual code in
  // production — even if logs are accessible only to admins, the OTP is a
  // bearer credential and must not be persisted in plaintext anywhere
  // beyond the user's email inbox.
  if (emergency) {
    // Operator explicitly opted in via SA_EMERGENCY_BYPASS — print to logs
    // even in production so they can recover access without working email.
    console.warn(`[sa-otp SECURITY EMERGENCY] code=${code} user=${user.username} ip=${ip} valid_for=${OTP_TTL_MS / 1000}s — disable SA_EMERGENCY_BYPASS after recovery`);
  } else if (!emailConfigured() && process.env.NODE_ENV !== "production") {
    console.log(`[sa-otp DEV-ONLY] code=${code} user=${user.username} valid_for=${OTP_TTL_MS / 1000}s`);
  } else if (!emailConfigured()) {
    console.warn(`[sa-otp] email transport not configured — OTP for ${user.username} cannot be delivered`);
  }

  await recordAttempt({
    userId: user.id, username, ip, userAgent: ua, deviceFingerprint: fp,
    success: false, outcome: "otp_sent",
    riskScore: risk.score, riskLevel: risk.level, riskFactors: risk.factors,
  });

  res.json({
    stage: "otp",
    challengeToken,
    requiresOtp: true,
    otpExpiresInSec: OTP_TTL_MS / 1000,
    riskLevel: risk.level,
    isNewDevice: risk.isNewDevice,
    isNewIp: risk.isNewIp,
    isBootstrap,
    deliveryHint: emailConfigured()
      ? `أُرسل الرمز إلى بريد المستخدم${user.email ? " " + maskEmail(user.email) : ""}`
      : "البريد غير مهيّأ — راجع سجل الخادم للحصول على الرمز.",
  });
});

function maskEmail(e: string): string {
  const [u, d] = e.split("@");
  if (!d) return "***";
  return `${u.slice(0, 2)}***@${d}`;
}

// ─── Resend OTP ────────────────────────────────────────────────────────────
router.post("/resend-otp", saOtpLimit, async (req, res) => {
  const { challengeToken } = req.body ?? {};
  if (!challengeToken) { res.status(400).json({ error: "challengeToken مطلوب" }); return; }
  const [otp] = await db.select().from(superAdminOtpCodesTable)
    .where(eq(superAdminOtpCodesTable.challengeToken, challengeToken));
  if (!otp || otp.consumedAt) { res.status(400).json({ error: "رمز الجلسة غير صالح" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, otp.userId));
  if (!user) { res.status(400).json({ error: "المستخدم غير موجود" }); return; }

  const code = newOtp();
  await db.update(superAdminOtpCodesTable).set({
    codeHash: sha256(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    attempts: 0,
  }).where(eq(superAdminOtpCodesTable.id, otp.id));

  if (user.email) sendOtpEmail(user.email, code, otp.ip, otp.userAgent).catch(() => {});
  // Same dev-only OTP echo policy as the initial /login leg.
  if (!emailConfigured() && process.env.NODE_ENV !== "production") {
    console.log(`[sa-otp resend DEV-ONLY] code=${code} user=${user.username}`);
  } else if (!emailConfigured()) {
    console.warn(`[sa-otp resend] email transport not configured — OTP for ${user.username} cannot be delivered`);
  }

  res.json({ ok: true, otpExpiresInSec: OTP_TTL_MS / 1000 });
});

// ─── Step 2: verify OTP ────────────────────────────────────────────────────
router.post("/verify-otp", saOtpLimit, async (req, res) => {
  const { challengeToken, code } = req.body ?? {};
  const ip = clientIpFrom(req);
  const ua = req.headers["user-agent"]?.toString().slice(0, 500) ?? null;
  const fp = computeFingerprint(req);

  if (!challengeToken || !code) {
    res.status(400).json({ error: "بيانات ناقصة" }); return;
  }

  const [otp] = await db.select().from(superAdminOtpCodesTable)
    .where(eq(superAdminOtpCodesTable.challengeToken, challengeToken));
  if (!otp) { res.status(400).json({ error: "جلسة الرمز غير موجودة" }); return; }
  if (otp.consumedAt) { res.status(400).json({ error: "الرمز استُخدم مسبقًا" }); return; }
  if (otp.expiresAt.getTime() < Date.now()) {
    await recordAttempt({
      userId: otp.userId, username: null, ip, userAgent: ua, deviceFingerprint: fp,
      success: false, outcome: "expired_otp",
    });
    res.status(400).json({ error: "انتهت صلاحية الرمز. اطلب رمزًا جديدًا.", expired: true });
    return;
  }
  if (otp.attempts >= MAX_OTP_ATTEMPTS) {
    await recordAttempt({
      userId: otp.userId, username: null, ip, userAgent: ua, deviceFingerprint: fp,
      success: false, outcome: "rate_limited", failureReason: "otp_attempts_exhausted",
    });
    res.status(429).json({ error: "تم تجاوز عدد المحاولات. اطلب رمزًا جديدًا." });
    return;
  }
  if (otp.deviceFingerprint && otp.deviceFingerprint !== fp && !emergencyBypassEnabled()) {
    await recordAttempt({
      userId: otp.userId, username: null, ip, userAgent: ua, deviceFingerprint: fp,
      success: false, outcome: "device_denied", failureReason: "otp_fingerprint_mismatch",
    });
    res.status(400).json({ error: "يجب إكمال التحقق من نفس الجهاز الذي بدأ تسجيل الدخول." });
    return;
  }
  if (sha256(String(code)) !== otp.codeHash) {
    await db.update(superAdminOtpCodesTable)
      .set({ attempts: otp.attempts + 1 })
      .where(eq(superAdminOtpCodesTable.id, otp.id));
    await recordAttempt({
      userId: otp.userId, username: null, ip, userAgent: ua, deviceFingerprint: fp,
      success: false, outcome: "bad_otp",
    });
    res.status(401).json({ error: "الرمز غير صحيح" });
    return;
  }

  // Atomic claim — guards against concurrent verifiers minting two
  // sessions from a single OTP.
  const claim = await db.update(superAdminOtpCodesTable)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(superAdminOtpCodesTable.id, otp.id),
      isNull(superAdminOtpCodesTable.consumedAt),
    ))
    .returning({ id: superAdminOtpCodesTable.id });
  if (claim.length === 0) {
    await recordAttempt({
      userId: otp.userId, username: null, ip, userAgent: ua, deviceFingerprint: fp,
      success: false, outcome: "race_lost", failureReason: "otp_already_consumed",
    });
    res.status(409).json({ error: "تم استخدام هذا الرمز للتو من جلسة أخرى. أعد المحاولة." });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, otp.userId));
  if (!user || !user.isActive || user.role !== "superadmin") {
    res.status(401).json({ error: "المستخدم غير متاح" }); return;
  }

  // Trust the device if not already trusted
  const [existingTrust] = await db.select().from(superAdminTrustedDevicesTable)
    .where(and(
      eq(superAdminTrustedDevicesTable.userId, user.id),
      eq(superAdminTrustedDevicesTable.deviceFingerprint, fp),
      isNull(superAdminTrustedDevicesTable.revokedAt),
    ))
    .limit(1);
  let wasNewDevice = false;
  if (!existingTrust) {
    wasNewDevice = true;
    await db.insert(superAdminTrustedDevicesTable).values({
      userId: user.id,
      deviceFingerprint: fp,
      deviceName: describeDevice(req),
      userAgent: ua,
      ip,
      approvedFromIp: ip,
    });
  } else {
    await db.update(superAdminTrustedDevicesTable).set({ lastSeenAt: new Date(), ip })
      .where(eq(superAdminTrustedDevicesTable.id, existingTrust.id));
  }

  // Create new sa_session
  const sessionToken = newToken(32);
  const [createdSession] = await db.insert(superAdminSessionsTable).values({
    userId: user.id,
    sessionToken,
    deviceFingerprint: fp,
    deviceName: describeDevice(req),
    userAgent: ua,
    ip,
  }).returning({ id: superAdminSessionsTable.id });

  await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));

  await recordAttempt({
    userId: user.id, username: user.username, ip, userAgent: ua, deviceFingerprint: fp,
    success: true, outcome: "ok",
  });

  if (wasNewDevice && user.email) {
    sendNewDeviceAlert(user.email, ip, ua).catch(() => {});
  }

  res.json({
    ok: true,
    token: sessionToken,
    // Use the same `sa-<rowId>` format that GET /api/auth/me returns so the
    // client's session-kick poll matches and does not log the user out.
    sessionId: `sa-${createdSession.id}`,
    user: {
      id: user.id, username: user.username, email: user.email, role: user.role,
      companyId: user.companyId, code: user.code, nameAr: user.nameAr, nameEn: user.nameEn,
      permissions: user.permissions ?? {}, viewAllBranches: user.viewAllBranches, branchIds: [],
      company: null, subscription: null,
    },
  });
});

// ─── Use a recovery code ───────────────────────────────────────────────────
router.post("/use-recovery-code", saRecoveryLimit, async (req, res) => {
  const { username, password, recoveryCode } = req.body ?? {};
  const ip = clientIpFrom(req);
  const ua = req.headers["user-agent"]?.toString().slice(0, 500) ?? null;
  const fp = computeFingerprint(req);
  if (!username || !password || !recoveryCode) {
    res.status(400).json({ error: "البيانات ناقصة" }); return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  if (!user || user.role !== "superadmin" || !user.isActive) {
    res.status(401).json({ error: "بيانات غير صحيحة" }); return;
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) { res.status(401).json({ error: "بيانات غير صحيحة" }); return; }

  const hash = sha256(recoveryCode.toString().trim().toUpperCase());
  const [code] = await db.select().from(superAdminRecoveryCodesTable)
    .where(and(
      eq(superAdminRecoveryCodesTable.userId, user.id),
      eq(superAdminRecoveryCodesTable.codeHash, hash),
      isNull(superAdminRecoveryCodesTable.usedAt),
    )).limit(1);
  if (!code) { res.status(401).json({ error: "رمز الاسترجاع غير صحيح أو مستخدم" }); return; }

  await db.update(superAdminRecoveryCodesTable).set({ usedAt: new Date(), usedFromIp: ip })
    .where(eq(superAdminRecoveryCodesTable.id, code.id));

  // Trust the current device immediately
  await db.insert(superAdminTrustedDevicesTable).values({
    userId: user.id,
    deviceFingerprint: fp,
    deviceName: describeDevice(req) + " (recovery)",
    userAgent: ua,
    ip,
    approvedFromIp: ip,
  });
  const sessionToken = newToken(32);
  const [saSessRow] = await db.insert(superAdminSessionsTable).values({
    userId: user.id, sessionToken, deviceFingerprint: fp,
    deviceName: describeDevice(req) + " (recovery)", userAgent: ua, ip,
  }).returning();
  await recordAttempt({
    userId: user.id, username, ip, userAgent: ua, deviceFingerprint: fp,
    success: true, outcome: "recovery_code",
  });

  res.json({
    ok: true,
    token: sessionToken,
    sessionId: `sa-${saSessRow.id}`,
    user: {
      id: user.id, username: user.username, email: user.email, role: user.role,
      companyId: user.companyId, code: user.code, nameAr: user.nameAr, nameEn: user.nameEn,
      permissions: user.permissions ?? {}, viewAllBranches: user.viewAllBranches, branchIds: [],
      company: null, subscription: null,
    },
  });
});

// ─── Recovery: request email link ──────────────────────────────────────────
router.post("/recovery/request-link", saRecoveryLimit, async (req, res) => {
  const { username } = req.body ?? {};
  const ip = clientIpFrom(req);
  const ua = req.headers["user-agent"]?.toString().slice(0, 500) ?? null;
  if (!username) { res.status(400).json({ error: "اسم المستخدم مطلوب" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  // Always return ok to prevent username enumeration
  if (!user || user.role !== "superadmin" || !user.email) {
    res.json({ ok: true, message: "إذا كان الحساب موجودًا، فقد أُرسل الرابط إلى بريده." });
    return;
  }
  const token = newToken(32);
  await db.insert(superAdminRecoveryLinksTable).values({
    userId: user.id, token, ip, userAgent: ua,
    expiresAt: new Date(Date.now() + RECOVERY_TTL_MS),
  });
  sendRecoveryLink(user.email, token, publicBaseUrlFromReq(req), ip).catch(() => {});
  // Recovery tokens are bearer credentials — same dev-only echo policy.
  if (!emailConfigured() && process.env.NODE_ENV !== "production") {
    console.log(`[sa-recovery DEV-ONLY] link token=${token} user=${user.username}`);
  } else if (!emailConfigured()) {
    console.warn(`[sa-recovery] email transport not configured — recovery link for ${user.username} cannot be delivered`);
  }
  res.json({ ok: true, message: "إذا كان الحساب موجودًا، فقد أُرسل الرابط إلى بريده." });
});

// GET /recovery/link/:token  → validate
router.get("/recovery/link/:token", async (req, res) => {
  const [link] = await db.select().from(superAdminRecoveryLinksTable)
    .where(eq(superAdminRecoveryLinksTable.token, String(req.params.token)));
  if (!link || link.usedAt || link.expiresAt.getTime() < Date.now()) {
    res.status(400).json({ error: "الرابط غير صالح أو منتهي" }); return;
  }
  const [user] = await db.select({ username: usersTable.username }).from(usersTable)
    .where(eq(usersTable.id, link.userId));
  res.json({ ok: true, username: user?.username });
});

// POST /recovery/link/:token/use  → reset trusted devices, sessions, generate new recovery codes, log in current device.
// Requires the account password to prevent stolen-link account-takeover, and
// atomically consumes the recovery link so concurrent reuses are blocked.
//
// `newPassword` is OPTIONAL. When supplied we rotate the account password
// as part of the recovery — the typical use case is "I think my account
// was compromised, please give me a fresh password too". When omitted we
// only revoke trusted devices/sessions and regenerate recovery codes.
router.post("/recovery/link/:token/use", saRecoveryLimit, async (req, res) => {
  const ip = clientIpFrom(req);
  const ua = req.headers["user-agent"]?.toString().slice(0, 500) ?? null;
  const fp = computeFingerprint(req);
  const { password, newPassword } = req.body ?? {};
  if (!password) { res.status(400).json({ error: "كلمة المرور مطلوبة لإكمال الاسترجاع" }); return; }
  if (newPassword !== undefined && newPassword !== null && String(newPassword).length < 10) {
    res.status(400).json({ error: "كلمة المرور الجديدة يجب أن تكون 10 أحرف فأكثر" }); return;
  }

  const [link] = await db.select().from(superAdminRecoveryLinksTable)
    .where(eq(superAdminRecoveryLinksTable.token, String(req.params.token)));
  if (!link || link.usedAt || link.expiresAt.getTime() < Date.now()) {
    res.status(400).json({ error: "الرابط غير صالح أو منتهي" }); return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, link.userId));
  if (!user || user.role !== "superadmin" || !user.isActive) {
    res.status(400).json({ error: "المستخدم غير صالح" }); return;
  }

  const passOk = await bcrypt.compare(password, user.passwordHash);
  if (!passOk) {
    await recordAttempt({
      userId: user.id, username: user.username, ip, userAgent: ua, deviceFingerprint: fp,
      success: false, outcome: "bad_password", failureReason: "recovery_link_bad_password",
    });
    res.status(401).json({ error: "كلمة المرور غير صحيحة" });
    return;
  }

  // Atomically claim the link: only update if still unused. If 0 rows
  // updated, another concurrent request consumed it first.
  const claimed = await db.update(superAdminRecoveryLinksTable)
    .set({ usedAt: new Date(), usedFromIp: ip })
    .where(and(
      eq(superAdminRecoveryLinksTable.id, link.id),
      isNull(superAdminRecoveryLinksTable.usedAt),
    ))
    .returning({ id: superAdminRecoveryLinksTable.id });
  if (claimed.length === 0) {
    res.status(400).json({ error: "الرابط غير صالح أو منتهي" });
    return;
  }

  // Revoke everything
  const now = new Date();
  await db.update(superAdminTrustedDevicesTable)
    .set({ revokedAt: now })
    .where(and(eq(superAdminTrustedDevicesTable.userId, user.id), isNull(superAdminTrustedDevicesTable.revokedAt)));
  await db.update(superAdminSessionsTable)
    .set({ revokedAt: now, revokedReason: "recovery" })
    .where(and(eq(superAdminSessionsTable.userId, user.id), isNull(superAdminSessionsTable.revokedAt)));

  // Optional password rotation. Done AFTER device/session revocation so any
  // active session that was leaked alongside the password is invalidated
  // before the new password is even live.
  if (newPassword) {
    const newHash = await bcrypt.hash(String(newPassword), 12);
    await db.update(usersTable).set({ passwordHash: newHash, updatedAt: new Date() })
      .where(eq(usersTable.id, user.id));
    if (user.email) sendPasswordChangeAlert(user.email, ip).catch(() => {});
  }

  // Trust current device + new session
  await db.insert(superAdminTrustedDevicesTable).values({
    userId: user.id, deviceFingerprint: fp, deviceName: describeDevice(req) + " (recovery)",
    userAgent: ua, ip, approvedFromIp: ip,
  });
  const sessionToken = newToken(32);
  const [createdSession] = await db.insert(superAdminSessionsTable).values({
    userId: user.id, sessionToken, deviceFingerprint: fp,
    deviceName: describeDevice(req) + " (recovery)", userAgent: ua, ip,
  }).returning({ id: superAdminSessionsTable.id });

  // Generate new recovery codes; invalidate previous codes
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) codes.push(newRecoveryCode());
  await db.update(superAdminRecoveryCodesTable).set({ usedAt: now })
    .where(and(eq(superAdminRecoveryCodesTable.userId, user.id), isNull(superAdminRecoveryCodesTable.usedAt)));
  for (const c of codes) {
    await db.insert(superAdminRecoveryCodesTable).values({
      userId: user.id, codeHash: sha256(c),
    });
  }

  if (user.email) {
    sendNewDeviceAlert(user.email, ip, ua + " (account recovered via email link)").catch(() => {});
  }

  await recordAttempt({
    userId: user.id, username: user.username, ip, userAgent: ua, deviceFingerprint: fp,
    success: true, outcome: "recovery_link",
  });
  res.json({
    ok: true,
    token: sessionToken,
    sessionId: `sa-${createdSession.id}`,
    recoveryCodes: codes,
    user: {
      id: user.id, username: user.username, email: user.email, role: user.role,
      companyId: user.companyId, code: user.code, nameAr: user.nameAr, nameEn: user.nameEn,
      permissions: user.permissions ?? {}, viewAllBranches: user.viewAllBranches, branchIds: [],
      company: null, subscription: null,
    },
  });
});

// ─── Public polling endpoint for new device awaiting approval ─────────────
router.get("/device-approvals/:token/status", async (req, res) => {
  const fp = computeFingerprint(req);
  const [a] = await db.select().from(superAdminDeviceApprovalsTable)
    .where(eq(superAdminDeviceApprovalsTable.approvalToken, String(req.params.token)));
  if (!a) { res.status(404).json({ error: "غير موجود" }); return; }
  if (a.requestingDeviceFp !== fp) {
    // Hide existence from a different device
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  if (a.expiresAt.getTime() < Date.now() && a.status === "pending") {
    await db.update(superAdminDeviceApprovalsTable).set({ status: "expired" })
      .where(eq(superAdminDeviceApprovalsTable.id, a.id));
    res.json({ status: "expired" });
    return;
  }
  res.json({ status: a.status });
});

// ─── Authenticated SuperAdmin endpoints ────────────────────────────────────
router.use(async (req, res, next) => {
  const ctx = await bearerSuperAdmin(req);
  if (!ctx) { res.status(401).json({ error: "غير مصرح" }); return; }
  (req as any).saCtx = ctx;
  next();
});

// GET /sessions
router.get("/sessions", async (req, res) => {
  const { user, sessionRowId } = (req as any).saCtx;
  const rows = await db.select().from(superAdminSessionsTable)
    .where(and(eq(superAdminSessionsTable.userId, user.id), isNull(superAdminSessionsTable.revokedAt)))
    .orderBy(desc(superAdminSessionsTable.lastSeenAt));
  res.json(rows.map(r => ({
    id: r.id,
    deviceName: r.deviceName,
    userAgent: r.userAgent,
    ip: r.ip,
    deviceFingerprint: r.deviceFingerprint,
    lastSeenAt: r.lastSeenAt,
    createdAt: r.createdAt,
    isCurrent: r.id === sessionRowId,
  })));
});

router.delete("/sessions/:id", async (req, res) => {
  const { user, sessionRowId } = (req as any).saCtx;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  if (id === sessionRowId) { res.status(400).json({ error: "لا يمكن إنهاء جلستك الحالية من هنا. استخدم تسجيل الخروج." }); return; }
  const result = await db.update(superAdminSessionsTable)
    .set({ revokedAt: new Date(), revokedReason: "user_revoked" })
    .where(and(eq(superAdminSessionsTable.id, id), eq(superAdminSessionsTable.userId, user.id)))
    .returning({ id: superAdminSessionsTable.id });
  if (!result.length) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json({ ok: true });
});

router.post("/sessions/revoke-all", async (req, res) => {
  const { user, sessionRowId } = (req as any).saCtx;
  await db.update(superAdminSessionsTable)
    .set({ revokedAt: new Date(), revokedReason: "user_revoke_all" })
    .where(and(
      eq(superAdminSessionsTable.userId, user.id),
      isNull(superAdminSessionsTable.revokedAt),
    ));
  // Restore current session
  await db.update(superAdminSessionsTable).set({ revokedAt: null, revokedReason: null })
    .where(eq(superAdminSessionsTable.id, sessionRowId));
  res.json({ ok: true });
});

// GET /devices
router.get("/devices", async (req, res) => {
  const { user } = (req as any).saCtx;
  const rows = await db.select().from(superAdminTrustedDevicesTable)
    .where(eq(superAdminTrustedDevicesTable.userId, user.id))
    .orderBy(desc(superAdminTrustedDevicesTable.lastSeenAt));
  res.json(rows);
});

router.delete("/devices/:id", async (req, res) => {
  const { user } = (req as any).saCtx;
  const id = Number(req.params.id);
  const result = await db.update(superAdminTrustedDevicesTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(superAdminTrustedDevicesTable.id, id), eq(superAdminTrustedDevicesTable.userId, user.id)))
    .returning({ id: superAdminTrustedDevicesTable.id, fp: superAdminTrustedDevicesTable.deviceFingerprint });
  if (!result.length) { res.status(404).json({ error: "غير موجود" }); return; }
  // Also revoke any active sessions for that device
  const fp = result[0].fp;
  await db.update(superAdminSessionsTable)
    .set({ revokedAt: new Date(), revokedReason: "device_revoked" })
    .where(and(
      eq(superAdminSessionsTable.userId, user.id),
      eq(superAdminSessionsTable.deviceFingerprint, fp),
      isNull(superAdminSessionsTable.revokedAt),
    ));
  res.json({ ok: true });
});

// GET /login-history
router.get("/login-history", async (req, res) => {
  const { user } = (req as any).saCtx;
  const limit = Math.min(200, Number(req.query.limit ?? 100));
  const rows = await db.select().from(superAdminLoginAttemptsTable)
    .where(eq(superAdminLoginAttemptsTable.userId, user.id))
    .orderBy(desc(superAdminLoginAttemptsTable.createdAt))
    .limit(limit);
  res.json(rows);
});

// GET /device-approvals/pending
router.get("/device-approvals/pending", async (req, res) => {
  const { user } = (req as any).saCtx;
  const rows = await db.select().from(superAdminDeviceApprovalsTable)
    .where(and(
      eq(superAdminDeviceApprovalsTable.userId, user.id),
      eq(superAdminDeviceApprovalsTable.status, "pending"),
      gt(superAdminDeviceApprovalsTable.expiresAt, new Date()),
    ))
    .orderBy(desc(superAdminDeviceApprovalsTable.createdAt));
  res.json(rows);
});

// POST /device-approvals/:token/decide  (body: { decision: "approve" | "reject" })
router.post("/device-approvals/:token/decide", async (req, res) => {
  const { user } = (req as any).saCtx;
  const { decision } = req.body ?? {};
  if (decision !== "approve" && decision !== "reject") {
    res.status(400).json({ error: "decision must be approve|reject" }); return;
  }
  const [a] = await db.select().from(superAdminDeviceApprovalsTable)
    .where(and(
      eq(superAdminDeviceApprovalsTable.approvalToken, String(req.params.token)),
      eq(superAdminDeviceApprovalsTable.userId, user.id),
    ));
  if (!a) { res.status(404).json({ error: "غير موجود" }); return; }
  if (a.status !== "pending") { res.status(400).json({ error: `الحالة الحالية: ${a.status}` }); return; }
  if (a.expiresAt.getTime() < Date.now()) {
    await db.update(superAdminDeviceApprovalsTable).set({ status: "expired" })
      .where(eq(superAdminDeviceApprovalsTable.id, a.id));
    res.status(400).json({ error: "انتهت صلاحية الطلب" }); return;
  }
  const ip = clientIpFrom(req);
  if (decision === "approve") {
    await db.insert(superAdminTrustedDevicesTable).values({
      userId: user.id,
      deviceFingerprint: a.requestingDeviceFp,
      deviceName: a.requestingUserAgent ? describeDeviceFromUa(a.requestingUserAgent) : "Approved device",
      userAgent: a.requestingUserAgent,
      ip: a.requestingIp,
      approvedFromIp: ip,
    });
    await db.update(superAdminDeviceApprovalsTable)
      .set({ status: "approved", decidedAt: new Date(), decidedFromIp: ip })
      .where(eq(superAdminDeviceApprovalsTable.id, a.id));
  } else {
    await db.update(superAdminDeviceApprovalsTable)
      .set({ status: "rejected", decidedAt: new Date(), decidedFromIp: ip })
      .where(eq(superAdminDeviceApprovalsTable.id, a.id));
  }
  res.json({ ok: true });
});

function describeDeviceFromUa(ua: string): string {
  const m = ua.match(/(Chrome|Firefox|Safari|Edge|Edg|Opera|OPR)\/[\d.]+/);
  const browser = m ? m[1].replace("OPR", "Opera").replace("Edg", "Edge") : "Browser";
  const os =
    /Windows NT/.test(ua) ? "Windows" :
    /Mac OS X/.test(ua) ? "macOS" :
    /Android/.test(ua) ? "Android" :
    /iPhone|iPad|iOS/.test(ua) ? "iOS" :
    /Linux/.test(ua) ? "Linux" : "Unknown OS";
  return `${browser} on ${os}`;
}

// GET /recovery-codes  → list status (used/unused) only
router.get("/recovery-codes", async (req, res) => {
  const { user } = (req as any).saCtx;
  const rows = await db.select({
    id: superAdminRecoveryCodesTable.id,
    label: superAdminRecoveryCodesTable.label,
    usedAt: superAdminRecoveryCodesTable.usedAt,
    createdAt: superAdminRecoveryCodesTable.createdAt,
  }).from(superAdminRecoveryCodesTable)
    .where(eq(superAdminRecoveryCodesTable.userId, user.id))
    .orderBy(desc(superAdminRecoveryCodesTable.createdAt));
  res.json(rows);
});

// POST /recovery-codes/regenerate
router.post("/recovery-codes/regenerate", async (req, res) => {
  const { user } = (req as any).saCtx;
  const now = new Date();
  await db.update(superAdminRecoveryCodesTable).set({ usedAt: now })
    .where(and(eq(superAdminRecoveryCodesTable.userId, user.id), isNull(superAdminRecoveryCodesTable.usedAt)));
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) codes.push(newRecoveryCode());
  for (const c of codes) {
    await db.insert(superAdminRecoveryCodesTable).values({
      userId: user.id, codeHash: sha256(c),
    });
  }
  res.json({ ok: true, codes });
});

// POST /change-password — requires current password, sends alert.
//
// Containment behaviour: rotating the password also revokes every OTHER
// active SA session (we keep the *current* one so the user isn't kicked
// out by their own password change). This guarantees that if the password
// was changed because of a suspected compromise, any stolen session token
// is invalidated immediately rather than living until natural expiry.
router.post("/change-password", async (req, res) => {
  const { user } = (req as any).saCtx;
  const ip = clientIpFrom(req);
  const { currentPassword, newPassword } = req.body ?? {};
  if (!currentPassword || !newPassword) { res.status(400).json({ error: "بيانات ناقصة" }); return; }
  if (newPassword.length < 10) { res.status(400).json({ error: "كلمة المرور الجديدة يجب أن تكون 10 أحرف فأكثر" }); return; }
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) { res.status(401).json({ error: "كلمة المرور الحالية غير صحيحة" }); return; }
  const hash = await bcrypt.hash(newPassword, 12);
  await db.update(usersTable).set({ passwordHash: hash, updatedAt: new Date() })
    .where(eq(usersTable.id, user.id));

  // Identify the current session (if known) so we don't accidentally revoke
  // it — the request bearer token is exposed via saCtx.sessionRowId by
  // the SA-auth gate. If unknown, we revoke ALL sessions to fail safe.
  const currentSaSessionId = (req as any).saCtx?.sessionRowId as number | undefined;
  const revokeWhere = currentSaSessionId
    ? and(
        eq(superAdminSessionsTable.userId, user.id),
        isNull(superAdminSessionsTable.revokedAt),
        sql`${superAdminSessionsTable.id} <> ${currentSaSessionId}`,
      )
    : and(
        eq(superAdminSessionsTable.userId, user.id),
        isNull(superAdminSessionsTable.revokedAt),
      );
  await db.update(superAdminSessionsTable)
    .set({ revokedAt: new Date(), revokedReason: "password_change" })
    .where(revokeWhere);

  if (user.email) sendPasswordChangeAlert(user.email, ip).catch(() => {});
  res.json({ ok: true });
});

// ── SuperAdmin account management ───────────────────────────────────────
// GET /users — list all SuperAdmin accounts (for context UX)
router.get("/users", async (req, res) => {
  const rows = await db.select({
    id: usersTable.id,
    username: usersTable.username,
    email: usersTable.email,
    nameAr: usersTable.nameAr,
    nameEn: usersTable.nameEn,
    isActive: usersTable.isActive,
    lastLoginAt: usersTable.lastLoginAt,
    createdAt: usersTable.createdAt,
  })
    .from(usersTable)
    .where(eq(usersTable.role, "superadmin"))
    .orderBy(desc(usersTable.createdAt));
  res.json(rows);
});

// POST /users — create a new SuperAdmin account
//   • Strict rate limit (5 / hour / actor+IP).
//   • Step-up auth: must re-enter current password.
//   • Returns 409 on uniqueness conflict (DB-enforced — race-safe).
router.post("/users", saUserCreateLimit, async (req, res) => {
  const { user: actor } = (req as any).saCtx;
  const ip = clientIpFrom(req);
  const ua = req.headers["user-agent"] ?? null;

  const usernameRaw    = String(req.body?.username        ?? "").trim().toLowerCase();
  const emailRaw       = String(req.body?.email           ?? "").trim().toLowerCase();
  const nameRaw        = String(req.body?.name            ?? "").trim();
  const password       = String(req.body?.password        ?? "");
  const currentPassword = String(req.body?.currentPassword ?? "");

  if (!currentPassword) {
    res.status(400).json({ error: "أدخل كلمة المرور الحالية لتأكيد الإجراء" });
    return;
  }
  if (!usernameRaw || !password || !nameRaw) {
    res.status(400).json({ error: "بيانات ناقصة (الاسم واسم المستخدم وكلمة المرور مطلوبة)" });
    return;
  }
  if (!/^[a-z0-9._-]{3,32}$/.test(usernameRaw)) {
    res.status(400).json({ error: "اسم المستخدم يجب أن يكون 3-32 حرفًا (أحرف إنجليزية صغيرة وأرقام و . _ -)" });
    return;
  }
  if (password.length < 10) {
    res.status(400).json({ error: "كلمة المرور يجب أن تكون 10 أحرف فأكثر" });
    return;
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    res.status(400).json({ error: "كلمة المرور يجب أن تحتوي على أحرف وأرقام" });
    return;
  }
  if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
    res.status(400).json({ error: "البريد الإلكتروني غير صالح" });
    return;
  }

  // Step-up: verify current password
  const okPw = await bcrypt.compare(currentPassword, actor.passwordHash);
  if (!okPw) {
    // Audit failed step-up
    try {
      await db.insert(auditLogTable).values({
        userId: actor.id, username: actor.username, role: "superadmin",
        module: "superadmin_accounts", action: "create_denied",
        method: "POST", path: "/api/auth/superadmin/users",
        statusCode: 401, ip, userAgent: typeof ua === "string" ? ua : null,
        metadata: { reason: "step_up_password_invalid", attempted: { username: usernameRaw, email: emailRaw } },
      });
    } catch { /* ignore */ }
    res.status(401).json({ error: "كلمة المرور الحالية غير صحيحة" });
    return;
  }

  // Insert; rely on DB unique constraint on username for race safety.
  const passwordHash = await bcrypt.hash(password, 12);
  let created;
  try {
    [created] = await db.insert(usersTable).values({
      username: usernameRaw,
      email: emailRaw || null,
      passwordHash,
      role: "superadmin",
      nameAr: nameRaw,
      isActive: true,
      viewAllBranches: true,
    }).returning({
      id: usersTable.id,
      username: usersTable.username,
      email: usersTable.email,
      nameAr: usersTable.nameAr,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    });
  } catch (err: any) {
    const msg = String(err?.message ?? "");
    const code = err?.code ?? err?.cause?.code;
    // Postgres unique violation: 23505
    if (code === "23505" || /duplicate key|unique constraint/i.test(msg)) {
      const onEmail = /email/i.test(msg);
      res.status(409).json({ error: onEmail ? "البريد الإلكتروني مستخدم بالفعل" : "اسم المستخدم مستخدم بالفعل" });
      return;
    }
    throw err;
  }

  // Audit success
  try {
    await db.insert(auditLogTable).values({
      userId: actor.id,
      username: actor.username,
      role: "superadmin",
      module: "superadmin_accounts",
      action: "create",
      method: "POST",
      path: "/api/auth/superadmin/users",
      entityType: "user",
      entityId: String(created.id),
      statusCode: 201,
      ip,
      userAgent: typeof ua === "string" ? ua : null,
      metadata: {
        newUsername: created.username,
        newEmail: created.email,
        sessionId: (req as any).saCtx?.sessionRowId ?? null,
      },
    });
  } catch { /* never block on audit */ }

  res.status(201).json(created);
});

// POST /logout-current
router.post("/logout-current", async (req, res) => {
  const { sessionRowId } = (req as any).saCtx;
  await db.update(superAdminSessionsTable)
    .set({ revokedAt: new Date(), revokedReason: "user_logout" })
    .where(eq(superAdminSessionsTable.id, sessionRowId));
  res.json({ ok: true });
});

// GET /security-status — top card numbers for dashboard
router.get("/security-status", async (req, res) => {
  const { user } = (req as any).saCtx;
  const [activeSessions] = await db.select({ c: sql<number>`count(*)::int` }).from(superAdminSessionsTable)
    .where(and(eq(superAdminSessionsTable.userId, user.id), isNull(superAdminSessionsTable.revokedAt)));
  const [trustedDevices] = await db.select({ c: sql<number>`count(*)::int` }).from(superAdminTrustedDevicesTable)
    .where(and(eq(superAdminTrustedDevicesTable.userId, user.id), isNull(superAdminTrustedDevicesTable.revokedAt)));
  const [unusedCodes] = await db.select({ c: sql<number>`count(*)::int` }).from(superAdminRecoveryCodesTable)
    .where(and(eq(superAdminRecoveryCodesTable.userId, user.id), isNull(superAdminRecoveryCodesTable.usedAt)));
  res.json({
    activeSessions: Number(activeSessions?.c ?? 0),
    trustedDevices: Number(trustedDevices?.c ?? 0),
    unusedRecoveryCodes: Number(unusedCodes?.c ?? 0),
    emailConfigured: emailConfigured(),
    turnstileEnabled: turnstileEnabled(),
  });
});

export default router;
