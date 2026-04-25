import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, subscriptionsTable, companiesTable, userBranchesTable, superAdminSessionsTable, currenciesTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { writeAudit } from "../middleware/permissions.js";
import { resolveBearerToken } from "../middleware/auth.js";

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
router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" });
    return;
  }

  const ip = loginClientIp(req);
  const ua = req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null;

  // SuperAdmin uses the dedicated multi-layer auth flow (2FA, devices,
  // risk, etc). Tell the client to call the SuperAdmin endpoint instead.
  const [maybeSuper] = await db.select({ role: usersTable.role }).from(usersTable)
    .where(eq(usersTable.username, username));
  if (maybeSuper?.role === "superadmin") {
    res.status(409).json({
      error: "هذا الحساب يتطلب تسجيل دخول السوبر أدمن",
      useSuperAdminFlow: true,
    });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username));
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

  // Successful login → audit row so the Security Center can list it.
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

  const { notifyMaintenanceEmail } = req.body ?? {};
  if (typeof notifyMaintenanceEmail !== "boolean") {
    res.status(400).json({ error: "notifyMaintenanceEmail يجب أن يكون قيمة منطقية" }); return;
  }
  // Only SuperAdmins are ever on the digest list, so the toggle is a no-op
  // (but harmless) for other roles. We still accept it without a 403 so the
  // future shape — multiple notification preferences — can include flags
  // that *do* apply to non-SuperAdmins.
  const [updated] = await db.update(usersTable)
    .set({ notifyMaintenanceEmail, updatedAt: new Date() })
    .where(eq(usersTable.id, user.id))
    .returning();
  res.json({
    ok: true,
    notifyMaintenanceEmail: (updated as any).notifyMaintenanceEmail ?? notifyMaintenanceEmail,
    message: notifyMaintenanceEmail
      ? "تم تفعيل تنبيهات صيانة النظام"
      : "تم إيقاف تنبيهات صيانة النظام",
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

  // Check username uniqueness
  const [existingUser] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  if (existingUser) {
    res.status(409).json({ error: "اسم المستخدم مستخدم مسبقاً" });
    return;
  }

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
  // Pricing model (mirrors lib/systemModules.ts):
  //   monthlyTotal = basePlanMonthly +
  //                  sum(prices of selected modules)
  //                  - sum(cheapest `included` selected modules' prices)
  // Annual cycle: monthlyTotal × 10 (preserves the static ~17% discount).
  const MODULE_PRICES: Record<string, number> = {
    sales: 35, purchasing: 35, inventory: 40, pos: 45,
    cash: 30, accounting: 50, hr: 35, zatca: 25,
  };
  const PLAN_INCLUDED_MODULES: Record<string, number> = {
    starter: 2, professional: 5, enterprise: 100,
  };
  const BASE_MONTHLY: Record<string, number> = {
    starter: 99, professional: 299, enterprise: 899,
  };

  const computeMonthlyPrice = (planKey: string, moduleKeys: unknown): number => {
    const base = BASE_MONTHLY[planKey] ?? BASE_MONTHLY.starter;
    if (!Array.isArray(moduleKeys)) return base;
    const prices = moduleKeys
      .filter((k): k is string => typeof k === "string")
      .map(k => MODULE_PRICES[k])
      .filter((p): p is number => typeof p === "number")
      .sort((a, b) => a - b);
    const included = PLAN_INCLUDED_MODULES[planKey] ?? 0;
    const freeCount = Math.min(included, prices.length);
    const freeAmount = prices.slice(0, freeCount).reduce((s, p) => s + p, 0);
    const grossTotal = prices.reduce((s, p) => s + p, 0);
    return base + (grossTotal - freeAmount);
  };

  const planKeyForPricing = plan ?? "starter";
  const monthlyTotal = computeMonthlyPrice(planKeyForPricing, selectedModules);
  const finalPrice: string = billingCycle === "annual"
    ? String(monthlyTotal * 10)
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
    accounting: ["accounts", "accounting_reports"],
    hr:         ["hr_module"],
    zatca:      ["zatca", "reports"],
  };
  const buildMenuPermissionsJson = (keys: unknown): string | null => {
    if (!Array.isArray(keys)) return null;
    const out: Record<string, boolean> = {
      dashboard: true, invoices: true, customers: true, // always-on core
    };
    for (const k of keys) {
      if (typeof k !== "string") continue;
      const perms = MODULE_PERMISSIONS[k];
      if (!perms) continue;
      for (const p of perms) out[p] = true;
    }
    return JSON.stringify(out);
  };
  const resolvedMenuPermissions = buildMenuPermissionsJson(selectedModules);

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
    // Self-registered: pending approval
    res.status(201).json({
      pending: true,
      message: "تم استلام طلبك بنجاح. سيتم مراجعته من قِبل الإدارة وستُبلَّغ بالنتيجة قريباً.",
      companyId: company.id,
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
    // Check uniqueness
    const [existing] = await db.select().from(usersTable).where(eq(usersTable.username, newUsername));
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
