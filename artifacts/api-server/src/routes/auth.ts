import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, subscriptionsTable, companiesTable, userBranchesTable, superAdminSessionsTable, currenciesTable, workSessionsTable, planConfigsTable, modulesTable } from "@workspace/db";
import { and, eq, isNull, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { writeAudit } from "../middleware/permissions.js";
import { resolveBearerToken } from "../middleware/auth.js";
import { runEndOfSessionHooks, loadSessionSettings } from "../lib/workSessionReport.js";
import { listSessionsForUser } from "./sessions.js";

const router = Router();

function generateToken(): string {
  return randomUUID() + "-" + randomUUID();
}

// Pull a usable client IP out of the request, mirroring the helper inside
// permissions.ts (kept private there to avoid widening its API surface).
function loginClientIp(req: any): string | null {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim().slice(0, 64);
  if (Array.isArray(xf) && xf.length) return String(xf[0]).slice(0, 64);
  return (req.socket?.remoteAddress ?? null)?.slice(0, 64) ?? null;
}

// POST /api/auth/login
//
// Tenant identity model (April 2026 redesign):
//   • Usernames are unique PER COMPANY, not globally. Two different
//     companies can each own a user named "ahmed".
//   • The client therefore identifies its tenant on every login by
//     sending `companyCode` (the public, human-friendly code shown
//     to the user at registration — e.g. "ZTC-1042").
//   • SuperAdmin accounts have NO companyId and live in a separate
//     keyspace; they do NOT use this endpoint (they call
//     /api/auth/superadmin/login). However, tenants who fat-finger
//     a SuperAdmin username here without a companyCode get a 409 +
//     useSuperAdminFlow hint so the UI can redirect them to the
//     correct flow with one click — preserving the legacy UX.
router.post("/login", async (req, res) => {
  const { username, password, companyCode } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" });
    return;
  }

  const ip = loginClientIp(req);
  const ua = req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null;

  // Resolve the tenant context. Two paths:
  //   A. companyCode provided → look it up; reject early if unknown.
  //   B. companyCode missing  → only legal for SuperAdmin fast-path
  //      (legacy auto-redirect). Tenant users MUST send a code.
  const trimmedCode = typeof companyCode === "string"
    ? companyCode.trim().toUpperCase()
    : "";
  let tenantCompanyId: number | null = null;
  if (trimmedCode) {
    const [co] = await db.select({ id: companiesTable.id })
      .from(companiesTable)
      .where(eq(companiesTable.code, trimmedCode));
    if (!co) {
      // Treat unknown codes as a credentials failure (no enumeration).
      // Audit so the Security Center still sees the attempt.
      await writeAudit({
        userId: null, username: String(username).slice(0, 80),
        role: null, companyId: null,
        module: "auth", action: "denied",
        method: "POST", path: "/api/auth/login", statusCode: 401,
        ip, userAgent: ua, metadata: { reason: "unknown_company_code" },
      });
      res.status(401).json({ error: "كود الشركة أو اسم المستخدم أو كلمة المرور غير صحيحة" });
      return;
    }
    tenantCompanyId = co.id;
  } else {
    // No companyCode — check whether this is a SuperAdmin trying to
    // sign in via the legacy single-input form. If so, hint the
    // client to use the SA flow.
    const [maybeSuper] = await db.select({ role: usersTable.role })
      .from(usersTable)
      .where(and(eq(usersTable.username, username), isNull(usersTable.companyId)));
    if (maybeSuper?.role === "superadmin") {
      res.status(409).json({
        error: "هذا الحساب يتطلب تسجيل دخول السوبر أدمن",
        useSuperAdminFlow: true,
      });
      return;
    }
    // Otherwise the tenant has to identify their company.
    res.status(400).json({ error: "كود الشركة مطلوب" });
    return;
  }

  const [user] = await db.select().from(usersTable)
    .where(and(eq(usersTable.username, username), eq(usersTable.companyId, tenantCompanyId)));
  if (!user) {
    // Failed login → record as denied so the Security Center can show it.
    await writeAudit({
      userId: null, username: String(username).slice(0, 80),
      role: null, companyId: null,
      module: "auth", action: "denied",
      method: "POST", path: "/api/auth/login", statusCode: 401,
      ip, userAgent: ua, metadata: { reason: "unknown_user" },
    });
    res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
    return;
  }
  if (!user.isActive) {
    await writeAudit({
      userId: user.id, username: user.username, role: user.role, companyId: user.companyId,
      module: "auth", action: "denied",
      method: "POST", path: "/api/auth/login", statusCode: 403,
      ip, userAgent: ua, metadata: { reason: "user_inactive" },
    });
    res.status(403).json({ error: "الحساب موقوف. تواصل مع الدعم." });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    await writeAudit({
      userId: user.id, username: user.username, role: user.role, companyId: user.companyId,
      module: "auth", action: "denied",
      method: "POST", path: "/api/auth/login", statusCode: 401,
      ip, userAgent: ua, metadata: { reason: "bad_password" },
    });
    res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
    return;
  }

  // Block login for tenants whose company has been suspended (e.g. by the
  // automatic-suspension job after subscription expiry). Superadmin is
  // tenant-less and is exempt.
  if (user.companyId && user.role !== "superadmin") {
    const [co] = await db.select({ status: companiesTable.status })
      .from(companiesTable).where(eq(companiesTable.id, user.companyId));
    if (co?.status === "suspended") {
      // Audit denied login for suspended-tenant rejections so they show up in
      // the Security Center login-history and feed denied-spike anomalies.
      await writeAudit({
        userId: user.id, username: user.username, role: user.role, companyId: user.companyId,
        module: "auth", action: "denied",
        method: "POST", path: "/api/auth/login", statusCode: 403,
        ip, userAgent: ua, metadata: { reason: "company_suspended" },
      });
      res.status(403).json({ error: "الاشتراك منتهي والشركة موقوفة. تواصل مع الدعم لتجديد الاشتراك." });
      return;
    }
  }

  // Single-session enforcement — generate new token (invalidates old)
  const sessionToken = generateToken();
  const sessionId = randomUUID();

  await db.update(usersTable).set({
    sessionToken,
    sessionId,
    lastLoginAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(usersTable.id, user.id));

  // Open a "work session" row to underpin the Work Sessions screen + AI
  // activity report. We:
  //   1. Force-end any pre-existing active sessions for this user
  //      (single-session login means a stale "active" row would otherwise
  //      stay open forever after a token rotation / browser swap).
  //   2. Insert one fresh "active" row for this login.
  // Wrapped in try/catch so a session-table issue can never block login.
  //
  // NOTE on ordering: this block runs BEFORE the login audit row is written
  // so the audit row's `createdAt` is strictly inside the new session window
  // (`startedAt`, now()). If the audit row were written first, its timestamp
  // would fall a few ms before `startedAt` and the login event would be
  // filtered out of the work-session activity preview / AI report.
  if (user.companyId) {
    try {
      // Atomic close-then-insert. Two concurrent logins for the same
      // (userId, companyId) race past a non-transactional version and end
      // up with multiple "active" rows; the partial unique index on
      // status='active' guarantees the second INSERT fails, and the
      // surrounding transaction makes the close-and-insert pair all-or-
      // nothing so we never strand both the old and the new in 'active'.
      const cid = user.companyId;

      // Pick a sensible default branch for this login row so reports and
      // filters can attribute the session to a branch. Resolution order:
      //   1. If the user has exactly one branch grant in user_branches,
      //      use that — common case for cashiers / branch managers.
      //   2. Otherwise fall back to the per-company defaultBranchId
      //      configured in the Session Settings screen (may be null).
      // Multi-branch admins (or users with viewAllBranches) intentionally
      // get the company default — they pick branches per-screen.
      let loginBranchId: number | null = null;
      try {
        const grants = await db
          .select({ branchId: userBranchesTable.branchId })
          .from(userBranchesTable)
          .where(eq(userBranchesTable.userId, user.id));
        if (grants.length === 1) {
          loginBranchId = grants[0].branchId;
        } else {
          const settings = await loadSessionSettings(cid);
          loginBranchId = settings.defaultBranchId ?? null;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[auth] branch resolution for work_session failed", e);
      }

      try {
        await db.transaction(async (tx) => {
          await tx.update(workSessionsTable).set({
            status:    "ended",
            endedAt:   new Date(),
            endReason: "new_login",
            updatedAt: new Date(),
          }).where(and(
            eq(workSessionsTable.userId, user.id),
            eq(workSessionsTable.status, "active"),
          ));
          await tx.insert(workSessionsTable).values({
            companyId: cid,
            userId:    user.id,
            username:  user.username,
            status:    "active",
            ip,
            userAgent: ua,
            branchId:  loginBranchId,
          });
        });
      } catch (txErr: any) {
        // The partial unique index `(user_id, company_id) WHERE status='active'`
        // can fire when two concurrent logins for the same user race past the
        // close step. In that case the OTHER transaction has already committed
        // both the close and a fresh active row, so we recover by adopting it
        // (refresh ip/userAgent so the row reflects the latest login). This
        // keeps the invariant "logged-in user always has exactly one active
        // work_session row" true even under the narrow race window.
        const isUniqueViolation = txErr?.code === "23505"
          || /duplicate key|unique constraint/i.test(String(txErr?.message ?? ""));
        if (!isUniqueViolation) throw txErr;
        await db.update(workSessionsTable).set({
          ip,
          userAgent: ua,
          updatedAt: new Date(),
        }).where(and(
          eq(workSessionsTable.userId, user.id),
          eq(workSessionsTable.status, "active"),
        ));
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[auth] failed to open work_session", e);
    }
  }

  // Successful login → audit row so the Security Center can list it AND
  // so it falls inside the freshly-opened work session window above.
  await writeAudit({
    userId: user.id, username: user.username, role: user.role, companyId: user.companyId,
    module: "auth", action: "login",
    method: "POST", path: "/api/auth/login", statusCode: 200,
    ip, userAgent: ua, metadata: null,
  });

  // Get subscription
  const [subscription] = user.companyId
    ? await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, user.companyId))
    : [null];

  const [company] = user.companyId
    ? await db.select().from(companiesTable).where(eq(companiesTable.id, user.companyId))
    : [null];

  // Load branch grants so the client can scope BranchFilter dropdowns.
  const branchLinks = await db
    .select({ branchId: userBranchesTable.branchId })
    .from(userBranchesTable)
    .where(eq(userBranchesTable.userId, user.id));

  // Manual sessions (admin-managed entity, see routes/sessions.ts).
  // The client uses this list to drive the post-login session picker:
  //   length === 1 → auto-pick;  > 1 → modal;  0 → "no session" or
  //   permission-gated quick-create. `currentSessionId` is the persisted
  //   selection (cleared if it points to a session no longer assigned).
  let manualSessions: Array<{ id: number; name: string; status: string }> = [];
  let currentSessionId: number | null = null;
  if (user.companyId) {
    try {
      manualSessions = await listSessionsForUser(user.id, user.companyId);
      const persisted = (user as any).currentSessionId ?? null;
      currentSessionId = persisted && manualSessions.find(s => s.id === persisted)
        ? persisted
        : null;
      if (persisted && currentSessionId == null) {
        // Self-heal stale persisted selection
        await db.update(usersTable).set({ currentSessionId: null })
          .where(eq(usersTable.id, user.id));
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[auth] failed to load manual sessions", e);
    }
  }

  res.json({
    token: sessionToken,
    sessionId,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
      code: (user as any).code ?? null,
      nameAr: (user as any).nameAr ?? null,
      nameEn: (user as any).nameEn ?? null,
      permissions: (user as any).permissions ?? {},
      viewAllBranches: (user as any).viewAllBranches ?? true,
      branchIds: branchLinks.map(l => l.branchId),
      company,
      subscription,
    },
    manualSessions,
    currentSessionId,
  });
});

// POST /api/auth/logout
// Recognises both the legacy single-session token (users.sessionToken) and
// SuperAdmin multi-session tokens (sa_sessions.sessionToken) so the SA flow
// can log out cleanly via the same endpoint.
router.post("/logout", async (req, res) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);

    // Legacy single-session: clear users.sessionToken / sessionId.
    const [user] = await db.select().from(usersTable).where(eq(usersTable.sessionToken, token));
    if (user) {
      await db.update(usersTable).set({
        sessionToken: null,
        sessionId: null,
        updatedAt: new Date(),
      }).where(eq(usersTable.id, user.id));
      await writeAudit({
        userId: user.id, username: user.username, role: user.role, companyId: user.companyId,
        module: "auth", action: "logout",
        method: "POST", path: "/api/auth/logout", statusCode: 200,
        ip: loginClientIp(req),
        userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null,
        metadata: null,
      });
      // Close any active work-session rows for this user. Defensive: a
      // session-table failure must not block the logout response.
      // We snapshot the IDs first so we can fire end-of-session hooks
      // (auto-report + email) for each one after closing.
      try {
        const active = await db.select({ id: workSessionsTable.id, companyId: workSessionsTable.companyId })
          .from(workSessionsTable)
          .where(and(
            eq(workSessionsTable.userId, user.id),
            eq(workSessionsTable.status, "active"),
          ));
        await db.update(workSessionsTable).set({
          status:    "ended",
          endedAt:   new Date(),
          endReason: "logout",
          updatedAt: new Date(),
        }).where(and(
          eq(workSessionsTable.userId, user.id),
          eq(workSessionsTable.status, "active"),
        ));
        // Fire hooks in the background — best-effort, never blocks logout.
        for (const a of active) {
          if (a.companyId) void runEndOfSessionHooks(a.id, a.companyId, { reason: "logout" });
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[auth] failed to close work_session on logout", e);
      }
    } else {
      // SuperAdmin multi-session: revoke this specific sa_sessions row only.
      const [sa] = await db.select({
        id: superAdminSessionsTable.id,
        userId: superAdminSessionsTable.userId,
      })
        .from(superAdminSessionsTable)
        .where(and(eq(superAdminSessionsTable.sessionToken, token), isNull(superAdminSessionsTable.revokedAt)))
        .limit(1);
      if (sa) {
        await db.update(superAdminSessionsTable)
          .set({ revokedAt: new Date(), revokedReason: "user_logout" })
          .where(eq(superAdminSessionsTable.id, sa.id));
        const [u] = await db.select({
          username: usersTable.username, role: usersTable.role, companyId: usersTable.companyId,
        }).from(usersTable).where(eq(usersTable.id, sa.userId));
        await writeAudit({
          userId: sa.userId, username: u?.username ?? "superadmin", role: u?.role ?? "superadmin",
          companyId: u?.companyId ?? null,
          module: "auth", action: "sa_logout",
          method: "POST", path: "/api/auth/logout", statusCode: 200,
          ip: loginClientIp(req),
          userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null,
          metadata: { saSessionId: sa.id },
        });
        // Close any active work-session rows for this superadmin user too,
        // and fire end-of-session hooks for each (best-effort).
        try {
          const active = await db.select({ id: workSessionsTable.id, companyId: workSessionsTable.companyId })
            .from(workSessionsTable)
            .where(and(
              eq(workSessionsTable.userId, sa.userId),
              eq(workSessionsTable.status, "active"),
            ));
          await db.update(workSessionsTable).set({
            status:    "ended",
            endedAt:   new Date(),
            endReason: "logout",
            updatedAt: new Date(),
          }).where(and(
            eq(workSessionsTable.userId, sa.userId),
            eq(workSessionsTable.status, "active"),
          ));
          for (const a of active) {
            if (a.companyId) void runEndOfSessionHooks(a.id, a.companyId, { reason: "logout" });
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[auth] failed to close work_session on sa logout", e);
        }
      }
    }
  }
  res.json({ ok: true });
});

// GET /api/auth/me
router.get("/me", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "غير مصرح" });
    return;
  }
  const token = auth.slice(7);

  // Try regular session first, then SuperAdmin multi-session.
  let user: any = null;
  let resolvedSessionId: string | null = null;
  const [u] = await db.select().from(usersTable).where(eq(usersTable.sessionToken, token));
  if (u?.isActive) {
    user = u;
    resolvedSessionId = u.sessionId;
  } else {
    const resolved = await resolveBearerToken(token);
    if (resolved) {
      const [full] = await db.select().from(usersTable).where(eq(usersTable.id, resolved.user.id));
      if (full?.isActive) {
        user = full;
        resolvedSessionId = resolved.user.sessionId;
      }
    }
  }
  if (!user) {
    res.status(401).json({ error: "الجلسة منتهية — يرجى تسجيل الدخول مجدداً" });
    return;
  }

  const [subscription] = user.companyId
    ? await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, user.companyId))
    : [null];

  const [company] = user.companyId
    ? await db.select().from(companiesTable).where(eq(companiesTable.id, user.companyId))
    : [null];

  const branchLinks = await db
    .select({ branchId: userBranchesTable.branchId })
    .from(userBranchesTable)
    .where(eq(userBranchesTable.userId, user.id));

  res.json({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
    sessionId: resolvedSessionId,
    code: (user as any).code ?? null,
    nameAr: (user as any).nameAr ?? null,
    nameEn: (user as any).nameEn ?? null,
    permissions: (user as any).permissions ?? {},
    viewAllBranches: (user as any).viewAllBranches ?? true,
    // Per-SuperAdmin opt-out for the maintenance critical-digest email.
    // Surfaced here so the Settings page can render the toggle without an
    // extra round-trip. Defaults to true when null/undefined for safety.
    notifyMaintenanceEmail: (user as any).notifyMaintenanceEmail ?? true,
    // Per-SuperAdmin severity threshold for the same digest. Read alongside
    // the toggle so the Settings page can render the dropdown without a
    // second round-trip. Defaults to "critical" — the historical behaviour.
    notifyMaintenanceSeverity: (user as any).notifyMaintenanceSeverity ?? "critical",
    branchIds: branchLinks.map(l => l.branchId),
    company,
    subscription,
  });
});

// PUT /api/auth/me/notifications — toggle the SuperAdmin maintenance-digest
// opt-out without requiring a password re-confirmation. This is a low-stakes
// preference (no security or financial impact), so the active session token
// is sufficient. Currently scoped to one flag — extend the body shape if more
// notification preferences land later.
router.put("/me/notifications", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { res.status(401).json({ error: "غير مصرح" }); return; }
  const token = auth.slice(7);
  let [user] = await db.select().from(usersTable).where(eq(usersTable.sessionToken, token));
  if (!user) {
    const resolved = await resolveBearerToken(token);
    if (resolved) {
      const [full] = await db.select().from(usersTable).where(eq(usersTable.id, resolved.user.id));
      if (full) user = full;
    }
  }
  if (!user || !user.isActive) { res.status(401).json({ error: "الجلسة منتهية" }); return; }

  // Both fields are optional — the Settings UI can flip just the toggle, just
  // the threshold, or both in a single PATCH. We validate each independently
  // so a malformed threshold doesn't poison a legitimate toggle change.
  const body = req.body ?? {};
  const hasToggle    = Object.prototype.hasOwnProperty.call(body, "notifyMaintenanceEmail");
  const hasThreshold = Object.prototype.hasOwnProperty.call(body, "notifyMaintenanceSeverity");
  if (!hasToggle && !hasThreshold) {
    res.status(400).json({ error: "لم يتم إرسال أي تفضيل لتحديثه" }); return;
  }
  const patch: Record<string, any> = { updatedAt: new Date() };
  if (hasToggle) {
    if (typeof body.notifyMaintenanceEmail !== "boolean") {
      res.status(400).json({ error: "notifyMaintenanceEmail يجب أن يكون قيمة منطقية" }); return;
    }
    patch.notifyMaintenanceEmail = body.notifyMaintenanceEmail;
  }
  if (hasThreshold) {
    const allowed = ["critical", "warning", "all"] as const;
    if (typeof body.notifyMaintenanceSeverity !== "string"
        || !(allowed as readonly string[]).includes(body.notifyMaintenanceSeverity)) {
      res.status(400).json({
        error: "notifyMaintenanceSeverity يجب أن يكون أحد القيم: critical, warning, all",
      }); return;
    }
    patch.notifyMaintenanceSeverity = body.notifyMaintenanceSeverity;
  }
  // Only SuperAdmins are ever on the digest list, so the toggle is a no-op
  // (but harmless) for other roles. We still accept it without a 403 so the
  // future shape — multiple notification preferences — can include flags
  // that *do* apply to non-SuperAdmins.
  const [updated] = await db.update(usersTable)
    .set(patch)
    .where(eq(usersTable.id, user.id))
    .returning();
  // Compose the toast message based on what actually changed. When both
  // fields are present we lead with the toggle change and append a short
  // note about the threshold so the SuperAdmin sees confirmation of both.
  const finalToggle    = (updated as any).notifyMaintenanceEmail ?? patch.notifyMaintenanceEmail ?? true;
  const finalThreshold = (updated as any).notifyMaintenanceSeverity ?? patch.notifyMaintenanceSeverity ?? "critical";
  const messages: string[] = [];
  if (hasToggle) {
    messages.push(finalToggle
      ? "تم تفعيل تنبيهات صيانة النظام"
      : "تم إيقاف تنبيهات صيانة النظام");
  }
  if (hasThreshold) {
    const labelMap: Record<string, string> = {
      critical: "حرجة فقط",
      warning:  "حرجة وتحذيرات",
      all:      "جميع الإشعارات",
    };
    messages.push(`مستوى التنبيهات: ${labelMap[finalThreshold] ?? finalThreshold}`);
  }
  res.json({
    ok: true,
    notifyMaintenanceEmail:    finalToggle,
    notifyMaintenanceSeverity: finalThreshold,
    message: messages.join(" — "),
  });
});

// Country → default-currency catalog. Mirrors
// artifacts/zatca-invoicing/src/lib/countries.ts; kept inline (rather than
// imported across artifacts) so the API server has no front-end coupling.
// `currencyOverride` lets the client send an explicit ISO 4217 code that
// wins over the country mapping when the user wants something custom.
const COUNTRY_CURRENCY: Record<string, { code: string; nameAr: string; nameEn: string; symbol: string }> = {
  SA: { code: "SAR", nameAr: "ريال سعودي",  nameEn: "Saudi Riyal",   symbol: "ر.س" },
  AE: { code: "AED", nameAr: "درهم إماراتي", nameEn: "UAE Dirham",    symbol: "د.إ" },
  KW: { code: "KWD", nameAr: "دينار كويتي",  nameEn: "Kuwaiti Dinar", symbol: "د.ك" },
  QA: { code: "QAR", nameAr: "ريال قطري",    nameEn: "Qatari Riyal",  symbol: "ر.ق" },
  BH: { code: "BHD", nameAr: "دينار بحريني", nameEn: "Bahraini Dinar",symbol: "د.ب" },
  OM: { code: "OMR", nameAr: "ريال عُماني",  nameEn: "Omani Rial",    symbol: "ر.ع" },
  EG: { code: "EGP", nameAr: "جنيه مصري",    nameEn: "Egyptian Pound",symbol: "ج.م" },
  GLOBAL: { code: "USD", nameAr: "دولار أمريكي", nameEn: "US Dollar", symbol: "$" },
};

function resolveDefaultCurrency(country: string, currencyOverride?: string | null) {
  const fromCountry = COUNTRY_CURRENCY[country] ?? COUNTRY_CURRENCY.SA;
  if (!currencyOverride || currencyOverride === fromCountry.code) return fromCountry;
  // Honor an explicit override even if it's not in our catalog: fall back
  // to a minimal record so the seed still succeeds with a meaningful code.
  const known = Object.values(COUNTRY_CURRENCY).find(c => c.code === currencyOverride);
  return known ?? { code: currencyOverride, nameAr: currencyOverride, nameEn: currencyOverride, symbol: currencyOverride };
}

// POST /api/auth/register
// Creates: company + subscription + admin user
router.post("/register", async (req, res) => {
  const {
    // Company fields
    nameAr, nameEn, vatNumber, crNumber,
    city, district, street, buildingNumber, postalCode, country,
    currency,
    industryName, invoiceType,
    // New: multi-industry list + per-module selection from the redesigned
    // registration wizard Step 1. Both are optional; legacy clients that
    // only send `industryName` / `plan` continue to work.
    selectedIndustries, selectedModules,
    // Subscription
    plan, billingCycle, startDate, endDate,
    // Optional override of the subscription price coming from the new
    // module-based pricing UI (base plan + per-module add-ons). When
    // omitted (legacy clients) we fall back to the static plan price.
    price: priceOverride,
    // Admin user
    username, email, password,
  } = req.body;

  if (!nameAr || !vatNumber || !crNumber || !username || !password) {
    res.status(400).json({ error: "البيانات المطلوبة ناقصة" });
    return;
  }

  // Username uniqueness is no longer global (April 2026 redesign): two
  // tenants can share the same username because the new login form
  // disambiguates them by companyCode. The only conflict that could
  // matter here is a SuperAdmin with the same username — and SuperAdmin
  // accounts always have company_id IS NULL, so the partial UNIQUE index
  // `users_username_superadmin_uniq` enforces this for them only. The
  // tenant we are about to create gets a fresh company_id, so no
  // pre-check is needed: the new user is trivially the only row for
  // (this future company_id, username).


  // Plan limits
  const PLANS: Record<string, { maxUsers: number; maxInvoices: number; price: string }> = {
    starter:      { maxUsers: 1,   maxInvoices: 50,      price: billingCycle === "annual" ? "990"  : "99" },
    professional: { maxUsers: 5,   maxInvoices: 500,     price: billingCycle === "annual" ? "2990" : "299" },
    enterprise:   { maxUsers: 999, maxInvoices: 999999,  price: billingCycle === "annual" ? "8990" : "899" },
  };
  const planConfig = PLANS[plan ?? "starter"] ?? PLANS.starter;

  // ── AUTHORITATIVE pricing (server-side) ─────────────────────────────
  // The new module-based pricing UI computes a total client-side for
  // display, but BILLING MUST NEVER trust client input. We mirror the
  // pricing tables here and recompute the monthly total ourselves; the
  // client's `priceOverride` is intentionally IGNORED for billing — it
  // only gets logged for tamper detection. This blocks an attacker from
  // submitting a lower-than-correct price to underpay their subscription.
  //
  // Pricing model (mirrors lib/systemModules.ts on the client):
  //   monthlyTotal = basePlanMonthly
  //                 + sum(prices of selected modules)
  //                 - sum(cheapest `includedModulesCount` modules' prices)
  // Annual cycle: monthlyTotal × 10 (preserves the static ~17% discount).
  //
  // SOURCE OF TRUTH: the `plan_configs` and `modules` tables — so a
  // SuperAdmin price change in /admin/plans or /admin/modules is reflected
  // here without a code deploy. We fall back to a sane minimum (100 SAR)
  // only if the plan row genuinely cannot be found, which would indicate
  // a misconfigured DB rather than a missing override.
  const planKeyForPricing = plan ?? "starter";
  const [planRow] = await db.select({
    monthlyPrice:         planConfigsTable.monthlyPrice,
    annualPrice:          planConfigsTable.annualPrice,
    includedModulesCount: planConfigsTable.includedModulesCount,
    isActive:             planConfigsTable.isActive,
  }).from(planConfigsTable).where(eq(planConfigsTable.key, planKeyForPricing));

  // Reject unknown / inactive plan keys outright. Falling back to a
  // hard-coded 100 SAR (the prior behaviour) effectively let an attacker
  // submit `plan: "free-forever"` and pay near-zero. Forcing a 400 here
  // means billing can only ever use prices the SuperAdmin actually
  // configured in /admin/plans.
  if (!planRow || !planRow.isActive) {
    res.status(400).json({ error: "الباقة المحددة غير صالحة" });
    return;
  }
  const basePlanMonthly = Number(planRow.monthlyPrice);
  const basePlanAnnual  = Number(planRow.annualPrice);
  const includedFreeCount = Number(planRow.includedModulesCount ?? 0);

  // Build a set of ACTIVE module keys + a price lookup. We use this set as
  // the single authority for two things:
  //   1. pricing math (only billed for active modules, no surprise charges)
  //   2. permission grants (deactivated modules cannot leak permissions)
  // Industry templates auto-add module keys via `selectedModules`, so without
  // this filter a deactivated module would still grant access without billing.
  //
  // `extraSubtotal` is the monthly cost of the modules billed beyond the
  // plan's `includedModulesCount` (cheapest N modules go free). We keep
  // it as a separate variable from the base plan price so we can compose
  // the right total per billing cycle below.
  let extraSubtotal = 0;
  const activeKeys = new Set<string>();
  if (Array.isArray(selectedModules) && selectedModules.length > 0) {
    const wantedKeys = selectedModules
      .filter((k: unknown): k is string => typeof k === "string");
    if (wantedKeys.length > 0) {
      const moduleRows = await db.select({
        key:          modulesTable.key,
        monthlyPrice: modulesTable.monthlyPrice,
      }).from(modulesTable)
        .where(and(eq(modulesTable.isActive, true), inArray(modulesTable.key, wantedKeys)));

      for (const r of moduleRows) activeKeys.add(r.key);

      const prices = moduleRows
        .map(r => Number(r.monthlyPrice))
        .filter(n => Number.isFinite(n) && n >= 0)
        .sort((a, b) => a - b);
      const freeCount  = Math.min(includedFreeCount, prices.length);
      const freeAmount = prices.slice(0, freeCount).reduce((s, p) => s + p, 0);
      const grossTotal = prices.reduce((s, p) => s + p, 0);
      extraSubtotal    = grossTotal - freeAmount;
    }
  }

  // Compose the final billed price per cycle:
  //   • Monthly: configured monthlyPrice + monthly module extras.
  //   • Annual:  configured annualPrice + (monthly module extras × 10).
  // Using `planRow.annualPrice` as the annual base means a SuperAdmin
  // edit to a plan's annual price (e.g. running a promo at 8x instead of
  // the default 10x) flows straight through to billing — without this
  // the server would silently charge `monthlyPrice * 10` and ignore the
  // override. The 10x on module extras preserves the long-standing
  // ~17% module discount on annual subscriptions.
  const monthlyTotal = basePlanMonthly + extraSubtotal;
  const annualTotal  = basePlanAnnual  + extraSubtotal * 10;
  const finalPrice: string = billingCycle === "annual"
    ? String(annualTotal)
    : String(monthlyTotal);

  // Tamper detection — log mismatches but don't reject (gives us a
  // visibility signal without breaking legitimate clients during rollout).
  if (priceOverride !== undefined && priceOverride !== null) {
    const clientNum = Number(priceOverride);
    const serverNum = Number(finalPrice);
    if (Number.isFinite(clientNum) && Math.abs(clientNum - serverNum) > 0.01) {
      console.warn(
        "[register] client price mismatch",
        { plan: planKeyForPricing, billingCycle, client: clientNum, server: serverNum, modules: selectedModules },
      );
    }
  }

  // Determine if this is an internal admin creation (called by superadmin) vs public registration
  const auth = req.headers.authorization;
  const isAdminCreate = !!auth?.startsWith("Bearer ");
  let callerIsSuperAdmin = false;
  if (isAdminCreate) {
    const token = auth!.slice(7);
    const [caller] = await db.select().from(usersTable).where(eq(usersTable.sessionToken, token));
    callerIsSuperAdmin = caller?.role === "superadmin";
  }

  // Companies created by superadmin are immediately active; self-registered are pending
  const companyStatus = callerIsSuperAdmin ? "active" : "pending";
  const userIsActive = callerIsSuperAdmin;

  // Capture registration IP (respects X-Forwarded-For for proxied environments)
  const registrationIp =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    null;

  // Resolve final industryName: prefer the multi-select list (joined CSV)
  // if it was sent, otherwise fall back to the single legacy field.
  const resolvedIndustryName: string | null = (() => {
    if (Array.isArray(selectedIndustries) && selectedIndustries.length > 0) {
      return selectedIndustries.filter((s: unknown): s is string => typeof s === "string" && s.length > 0).join(",");
    }
    return industryName ?? null;
  })();

  // Build the menuPermissions JSON from the user-selected high-level
  // modules. The mapping mirrors systemModules.ts on the frontend; we keep
  // the backend authoritative so a tampered request can't grant arbitrary
  // permissions. Core dashboard/invoices/customers are always granted.
  const MODULE_PERMISSIONS: Record<string, string[]> = {
    sales:      ["sales_module", "sales_reports", "customers"],
    purchasing: ["purchases_module", "purchases_reports", "suppliers"],
    inventory:  ["inventory_mobile", "inventory_reports"],
    pos:        ["pos"],
    cash:       ["cash_module", "cash_reports"],
    accounting: ["accounts", "accounting_reports", "accounting_maintenance"],
    hr:         ["hr_module"],
    zatca:      ["zatca", "reports"],
    // Contracting/Construction ERP — single permission key matching the
    // requirePermission("contracting") guard in routes/contracting{,-ai}.ts.
    contracting: ["contracting"],
    // Manufacturing/Production — single permission key matching the
    // requirePermission("production") guard in production routes.
    production: ["production"],
    // Security & Surveillance — backend uses the `security_events` permission
    // key (see routes/ai.ts security/* handlers and Layout.tsx securitySubNav).
    security: ["security_events"],
    // Maintenance / Asset Management — single permission key matching the
    // requirePermission("maintenance") guard in routes/maintenance.ts.
    maintenance: ["maintenance"],
    installments: ["installments"],
    // Hotel ERP — single permission key matching the
    // requireModulePermission("hotel") guard in routes/hotel.ts + hotel-ai.ts.
    hotel: ["hotel"],
  };
  // Permissions are derived from the ACTIVE module set we computed above for
  // pricing — this guarantees that a module deactivated in /admin/modules can
  // never grant access (even when injected via an industry template) and can
  // never be granted-without-being-billed.
  const buildMenuPermissionsJson = (keys: unknown): string | null => {
    if (!Array.isArray(keys)) return null;
    const out: Record<string, boolean> = {
      dashboard: true, invoices: true, customers: true, // always-on core
    };
    for (const k of keys) {
      if (typeof k !== "string") continue;
      if (!activeKeys.has(k)) continue; // deactivated modules → no permissions
      const perms = MODULE_PERMISSIONS[k];
      if (!perms) continue;
      for (const p of perms) out[p] = true;
    }
    return JSON.stringify(out);
  };
  let resolvedMenuPermissions = buildMenuPermissionsJson(selectedModules);

  // ── INDUSTRY-DRIVEN MENU PERMISSIONS ────────────────────────────────
  // On top of the module-derived permissions above, OR in any granular
  // menu-permission keys attached to the chosen industries (managed in
  // /admin/industries → recommendedModuleKeys). This is what makes
  // picking the "تجاري" chip on the registration screen automatically
  // light up its sidebar items (dashboard, customers, sales, purchases,
  // accounting, hr…) without the user having to toggle each one.
  // We only honour ACTIVE industries — a deactivated industry can't
  // leak permissions even if a stale client posted its code.
  try {
    const codes = (Array.isArray(selectedIndustries) ? selectedIndustries : [])
      .filter((s: unknown): s is string => typeof s === "string" && s.length > 0);
    if (codes.length > 0) {
      const { industriesTable } = await import("@workspace/db");
      const { inArray, and } = await import("drizzle-orm");
      const rows = await db.select({
        keys: industriesTable.recommendedModuleKeys,
      }).from(industriesTable).where(and(
        inArray(industriesTable.code, codes),
        eq(industriesTable.isActive, true),
      ));

      const granted: Record<string, boolean> = resolvedMenuPermissions
        ? JSON.parse(resolvedMenuPermissions)
        : { dashboard: true, invoices: true, customers: true };
      // Whitelist filter: even though writes to industries.recommendedModuleKeys
      // go through the same canonical filter (see `routes/adminIndustries.ts`),
      // we re-filter here as defense-in-depth — guards against legacy rows
      // written before the whitelist existed and against any direct DB edits.
      const { filterCanonicalKeys } = await import("../lib/menuPermissionCatalog.js");
      for (const r of rows) {
        const safeKeys = filterCanonicalKeys((r.keys ?? []) as unknown[]);
        for (const k of safeKeys) granted[k] = true;
      }
      resolvedMenuPermissions = JSON.stringify(granted);
    }
  } catch (e) {
    // Permission grant from industries is additive — failing it should
    // never block a registration. Worst case: the user lands without
    // the auto-granted menus and an admin enables them later.
    req.log?.warn?.({ err: e }, "industry → menuPermissions merge failed");
  }

  // Create company
  const [company] = await db.insert(companiesTable).values({
    nameAr,
    nameEn: nameEn ?? null,
    vatNumber,
    crNumber,
    city: city ?? "",
    district: district ?? null,
    street: street ?? "",
    buildingNumber: buildingNumber ?? "",
    postalCode: postalCode ?? "",
    country: country ?? "SA",
    industryName: resolvedIndustryName,
    invoiceType: invoiceType ?? "both",
    isSandbox: false,
    status: companyStatus,
    registrationIp,
    // Only override default menuPermissions if the user picked modules at
    // registration; otherwise let the schema default apply.
    ...(resolvedMenuPermissions ? { menuPermissions: resolvedMenuPermissions } : {}),
  }).returning();

  // Generate the public, human-friendly company code that the tenant
  // will use to identify itself on the new login form. We format it
  // from the freshly-allocated id so it is guaranteed unique without
  // a retry loop. Stored back on the company so existing tooling
  // (admin lists, audit, future password-recovery emails) can surface
  // it. Persistence MUST succeed — the user receives this code in the
  // response and will type it on every login, so a stale/missing DB
  // value would lock them out.
  const generatedCompanyCode = `ZTC-${company.id}`;
  try {
    await db.update(companiesTable)
      .set({ code: generatedCompanyCode })
      .where(eq(companiesTable.id, company.id));
    company.code = generatedCompanyCode;
  } catch (err) {
    req.log?.error?.({ err, companyId: company.id }, "company code generation failed");
    // Roll back the orphan company so the user can retry cleanly.
    try {
      await db.delete(companiesTable).where(eq(companiesTable.id, company.id));
    } catch (delErr) {
      req.log?.error?.({ err: delErr, companyId: company.id }, "company rollback after code-generation failure also failed");
    }
    return res.status(500).json({ error: "تعذّر إنشاء كود الشركة. يرجى المحاولة مرة أخرى." });
  }

  // Seed the default currency for the new company. The currency code is
  // derived from the country (SA→SAR, AE→AED, …) unless the client sent an
  // explicit `currency` override. Failures here are logged but do NOT roll
  // back the company creation — admins can fix the currency manually from
  // Settings → Currencies if anything weird happens.
  try {
    const cur = resolveDefaultCurrency(country ?? "SA", currency);
    await db.insert(currenciesTable).values({
      companyId: company.id,
      code:      cur.code,
      nameAr:    cur.nameAr,
      nameEn:    cur.nameEn,
      symbol:    cur.symbol,
      isDefault: true,
      isActive:  true,
    });
  } catch (err) {
    console.error("[register] failed to seed default currency for company", company.id, err);
  }

  // Create subscription
  const today = new Date().toISOString().split("T")[0];
  await db.insert(subscriptionsTable).values({
    companyId: company.id,
    plan: plan ?? "starter",
    maxUsers: planConfig.maxUsers,
    maxInvoices: planConfig.maxInvoices,
    billingCycle: billingCycle ?? "monthly",
    startDate: startDate ?? today,
    endDate: endDate ?? (billingCycle === "annual"
      ? new Date(Date.now() + 365 * 86400000).toISOString().split("T")[0]
      : new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0]),
    isActive: true,
    price: finalPrice,
  });

  // ── PER-INDUSTRY DEFAULT TEMPLATES ─────────────────────────────────
  // SuperAdmin can attach a chart-of-accounts AND/OR an accounting-
  // mappings template per industry from /admin/industries. When a NEW
  // company picks one of those industries here, the templates are
  // applied so the tenant boots with a ready COA + wired-up posting
  // rules — no manual "Import Excel" step needed for first-time use.
  // Failures are logged but never block registration: worst case the
  // company starts empty and the admin can import templates manually.
  try {
    const codes = (Array.isArray(selectedIndustries) ? selectedIndustries : [])
      .filter((s: unknown): s is string => typeof s === "string" && s.length > 0);
    if (codes.length > 0) {
      const { applyIndustryTemplates } = await import("../lib/applyIndustryTemplates.js");
      const r = await applyIndustryTemplates(company.id, codes);
      if (r.coaInserted > 0 || r.mappingsInserted > 0) {
        req.log?.info?.({ companyId: company.id, ...r }, "industry templates applied");
      }
    }
  } catch (err) {
    req.log?.warn?.({ err }, "industry templates apply failed");
  }

  // Hash password + create admin user (inactive until superadmin approves)
  const passwordHash = await bcrypt.hash(password, 12);
  const [newUser] = await db.insert(usersTable).values({
    username,
    email: email ?? null,
    passwordHash,
    companyId: company.id,
    role: "admin",
    sessionToken: null,
    sessionId: null,
    lastLoginAt: null,
    isActive: userIsActive,
  }).returning();

  if (callerIsSuperAdmin) {
    // Admin-created: return token immediately
    const sessionToken = generateToken();
    const sessionId = randomUUID();
    await db.update(usersTable).set({ sessionToken, sessionId, lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(usersTable.id, newUser.id));
    const [subscription] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, company.id));
    res.status(201).json({
      token: sessionToken,
      sessionId,
      user: { id: newUser.id, username: newUser.username, email: newUser.email, role: newUser.role, companyId: company.id, company, subscription },
    });
  } else {
    // Self-registered: pending approval. We surface the freshly-generated
    // companyCode so the success screen can show it BIG with a copy
    // button — without it the tenant has no way to log in once the
    // SuperAdmin approves their account.
    res.status(201).json({
      pending: true,
      message: "تم استلام طلبك بنجاح. سيتم مراجعته من قِبل الإدارة وستُبلَّغ بالنتيجة قريباً.",
      companyId: company.id,
      companyCode: generatedCompanyCode,
      username: newUser.username,
    });
  }
});

// PUT /api/auth/profile — change username / password
// Recognises both legacy users.sessionToken AND SuperAdmin sa_sessions tokens.
router.put("/profile", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { res.status(401).json({ error: "غير مصرح" }); return; }
  const token = auth.slice(7);
  let [user] = await db.select().from(usersTable).where(eq(usersTable.sessionToken, token));
  if (!user) {
    const resolved = await resolveBearerToken(token);
    if (resolved) {
      const [full] = await db.select().from(usersTable).where(eq(usersTable.id, resolved.user.id));
      if (full) user = full;
    }
  }
  if (!user || !user.isActive) { res.status(401).json({ error: "الجلسة منتهية" }); return; }

  const { currentPassword, newUsername, newPassword } = req.body;

  // Always verify current password before any change
  if (!currentPassword) { res.status(400).json({ error: "كلمة المرور الحالية مطلوبة" }); return; }
  const passwordOk = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!passwordOk) { res.status(401).json({ error: "كلمة المرور الحالية غير صحيحة" }); return; }

  const updates: Record<string, any> = { updatedAt: new Date() };

  if (newUsername && newUsername !== user.username) {
    // Username uniqueness is scoped to the user's keyspace:
    //   • Tenant users → unique within their company (companyId match).
    //   • SuperAdmin   → unique across the SuperAdmin pool (companyId IS NULL).
    // This mirrors the partial UNIQUE indexes on the users table.
    const conflictWhere = user.companyId == null
      ? and(eq(usersTable.username, newUsername), isNull(usersTable.companyId))
      : and(eq(usersTable.username, newUsername), eq(usersTable.companyId, user.companyId));
    const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(conflictWhere);
    if (existing) { res.status(409).json({ error: "اسم المستخدم مستخدم من قِبل حساب آخر" }); return; }
    updates.username = newUsername;
  }

  if (newPassword) {
    if (newPassword.length < 8) { res.status(400).json({ error: "كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل" }); return; }
    updates.passwordHash = await bcrypt.hash(newPassword, 12);
  }

  if (Object.keys(updates).length === 1) { // only updatedAt
    res.status(400).json({ error: "لم يتم تحديد أي تغيير" }); return;
  }

  const [updated] = await db.update(usersTable).set(updates).where(eq(usersTable.id, user.id)).returning();
  res.json({ ok: true, username: updated.username, message: "تم تحديث بيانات الحساب بنجاح" });
});

export default router;
