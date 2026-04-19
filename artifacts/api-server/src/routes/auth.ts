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

  // Hash password + create admin user
  const passwordHash = await bcrypt.hash(password, 12);
  const sessionToken = generateToken();
  const sessionId = randomUUID();

  const [newUser] = await db.insert(usersTable).values({
    username,
    email: email ?? null,
    passwordHash,
    companyId: company.id,
    role: "admin",
    sessionToken,
    sessionId,
    lastLoginAt: new Date(),
    isActive: true,
  }).returning();

  const [subscription] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, company.id));

  res.status(201).json({
    token: sessionToken,
    sessionId,
    user: {
      id: newUser.id,
      username: newUser.username,
      email: newUser.email,
      role: newUser.role,
      companyId: company.id,
      company,
      subscription,
    },
  });
});

export default router;
