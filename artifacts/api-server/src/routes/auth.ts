import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, subscriptionsTable, companiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

const router = Router();

function generateToken(): string {
  return randomUUID() + "-" + randomUUID();
}

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  if (!user) {
    res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
    return;
  }
  if (!user.isActive) {
    res.status(403).json({ error: "الحساب موقوف. تواصل مع الدعم." });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
    return;
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

  // Get subscription
  const [subscription] = user.companyId
    ? await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, user.companyId))
    : [null];

  const [company] = user.companyId
    ? await db.select().from(companiesTable).where(eq(companiesTable.id, user.companyId))
    : [null];

  res.json({
    token: sessionToken,
    sessionId,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
      company,
      subscription,
    },
  });
});

// POST /api/auth/logout
router.post("/logout", async (req, res) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.sessionToken, token));
    if (user) {
      await db.update(usersTable).set({
        sessionToken: null,
        sessionId: null,
        updatedAt: new Date(),
      }).where(eq(usersTable.id, user.id));
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

  const [user] = await db.select().from(usersTable).where(eq(usersTable.sessionToken, token));
  if (!user || !user.isActive) {
    res.status(401).json({ error: "الجلسة منتهية — يرجى تسجيل الدخول مجدداً" });
    return;
  }

  const [subscription] = user.companyId
    ? await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, user.companyId))
    : [null];

  const [company] = user.companyId
    ? await db.select().from(companiesTable).where(eq(companiesTable.id, user.companyId))
    : [null];

  res.json({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
    sessionId: user.sessionId,
    company,
    subscription,
  });
});

// POST /api/auth/register
// Creates: company + subscription + admin user
router.post("/register", async (req, res) => {
  const {
    // Company fields
    nameAr, nameEn, vatNumber, crNumber,
    city, district, street, buildingNumber, postalCode, country,
    industryName, invoiceType,
    // Subscription
    plan, billingCycle, startDate, endDate,
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
    industryName: industryName ?? null,
    invoiceType: invoiceType ?? "both",
    isSandbox: false,
    status: companyStatus,
  }).returning();

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
    price: planConfig.price,
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
router.put("/profile", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { res.status(401).json({ error: "غير مصرح" }); return; }
  const token = auth.slice(7);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.sessionToken, token));
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
