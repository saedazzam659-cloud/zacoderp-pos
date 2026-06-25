import { Router } from "express";
import { db } from "@workspace/db";
import {
  resellersTable, resellerCompaniesTable, resellerCommissionsTable,
  resellerTicketsTable, resellerActivationRequestsTable,
  companiesTable, subscriptionsTable, usersTable, currenciesTable, planConfigsTable,
} from "@workspace/db";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { requireReseller, requireResellerPermission, resellerCompanyIds, resellerOwnsCompany } from "../middleware/reseller.js";
import { accrueResellerCommission } from "../lib/resellerCommissions.js";
import { seedDefaultChartOfAccounts } from "../lib/seedDefaultChartOfAccounts.js";
import { logger } from "../lib/logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Reseller (Agent) portal API — Task #237 (additive only).
//
// Mounted at /api/reseller, BEFORE the path-less zatcaRouter so a reseller
// bearer token (absent from usersTable) is never 401-ed by the global tenant
// auth catch-all. Every authenticated endpoint is scoped to the calling
// reseller's own client companies — strict per-reseller data isolation.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

function generateToken(): string {
  return randomUUID() + "-" + randomUUID();
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function addMonthsISO(fromISO: string, months: number): string {
  const d = new Date(fromISO + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// ─── Reseller login (username + password, NO companyCode) ────────────────
router.post("/login", async (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (!username || !password) { res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" }); return; }
  const [reseller] = await db.select().from(resellersTable).where(eq(resellersTable.username, username));
  if (!reseller || !reseller.isActive) { res.status(401).json({ error: "بيانات الدخول غير صحيحة" }); return; }
  const ok = await bcrypt.compare(password, reseller.passwordHash);
  if (!ok) { res.status(401).json({ error: "بيانات الدخول غير صحيحة" }); return; }
  if (reseller.status !== "active") { res.status(403).json({ error: "تم إيقاف حساب الموزّع — يرجى التواصل مع الإدارة" }); return; }

  const token = generateToken();
  const sessionId = randomUUID();
  await db.update(resellersTable)
    .set({ sessionToken: token, sessionId, lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(resellersTable.id, reseller.id));

  res.json({
    token,
    user: {
      id: reseller.id,
      username: reseller.username,
      role: "reseller",
      companyId: null,
      resellerId: reseller.id,
      nameAr: reseller.nameAr,
      nameEn: reseller.nameEn,
      code: reseller.code,
      permissions: reseller.permissions ?? {},
    },
  });
});

// ─── Logout ──────────────────────────────────────────────────────────────
router.post("/logout", requireReseller, async (req, res) => {
  await db.update(resellersTable).set({ sessionToken: null, sessionId: null }).where(eq(resellersTable.id, req.reseller!.id));
  res.json({ ok: true });
});

// All endpoints below require an authenticated reseller.
router.use(requireReseller);

// ─── Profile ─────────────────────────────────────────────────────────────
router.get("/profile", async (req, res) => {
  const r = req.reseller!;
  res.json({
    id: r.id, code: r.code, nameAr: r.nameAr, nameEn: r.nameEn,
    phone: r.phone, email: r.email, address: r.address,
    commissionRate: r.commissionRate, status: r.status,
    permissions: r.permissions ?? {},
  });
});

// ─── Dashboard summary ───────────────────────────────────────────────────
router.get("/dashboard", async (req, res) => {
  const r = req.reseller!;
  const ids = await resellerCompanyIds(r.id);
  const now = new Date();
  const [commTotals] = await db
    .select({
      total: sql<string>`coalesce(sum(${resellerCommissionsTable.commissionAmount}),0)`,
      thisMonth: sql<string>`coalesce(sum(case when ${resellerCommissionsTable.periodYear} = ${now.getFullYear()} and ${resellerCommissionsTable.periodMonth} = ${now.getMonth() + 1} then ${resellerCommissionsTable.commissionAmount} else 0 end),0)`,
    })
    .from(resellerCommissionsTable)
    .where(eq(resellerCommissionsTable.resellerId, r.id));

  let activeClients = 0, suspendedClients = 0;
  if (ids.length) {
    const statusRows = await db
      .select({ status: companiesTable.status, n: sql<number>`count(*)::int` })
      .from(companiesTable)
      .where(inArray(companiesTable.id, ids))
      .groupBy(companiesTable.status);
    for (const s of statusRows) {
      if (s.status === "active") activeClients = s.n;
      else suspendedClients += s.n;
    }
  }
  const [openTickets] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(resellerTicketsTable)
    .where(and(eq(resellerTicketsTable.resellerId, r.id), eq(resellerTicketsTable.status, "open")));

  res.json({
    clientCount: ids.length,
    activeClients,
    suspendedClients,
    commissionTotal: commTotals?.total ?? "0",
    commissionThisMonth: commTotals?.thisMonth ?? "0",
    openTickets: openTickets?.n ?? 0,
    commissionRate: r.commissionRate,
  });
});

// ─── Clients (linked companies + latest subscription) ────────────────────
router.get("/clients", async (req, res) => {
  const ids = await resellerCompanyIds(req.reseller!.id);
  if (!ids.length) { res.json({ clients: [] }); return; }
  const companies = await db
    .select({
      id: companiesTable.id, code: companiesTable.code,
      nameAr: companiesTable.nameAr, nameEn: companiesTable.nameEn,
      phone: companiesTable.phone, city: companiesTable.city,
      status: companiesTable.status, createdAt: companiesTable.createdAt,
    })
    .from(companiesTable)
    .where(inArray(companiesTable.id, ids))
    .orderBy(desc(companiesTable.id));
  // Latest subscription per company.
  const subs = await db
    .select()
    .from(subscriptionsTable)
    .where(inArray(subscriptionsTable.companyId, ids))
    .orderBy(desc(subscriptionsTable.endDate), desc(subscriptionsTable.id));
  const subMap = new Map<number, typeof subs[number]>();
  for (const s of subs) if (!subMap.has(s.companyId)) subMap.set(s.companyId, s);
  res.json({
    clients: companies.map((c) => ({ ...c, subscription: subMap.get(c.id) ?? null })),
  });
});

// ─── Single client (scoped) ──────────────────────────────────────────────
router.get("/clients/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  if (!(await resellerOwnsCompany(req.reseller!.id, id))) { res.status(404).json({ error: "العميل غير موجود" }); return; }
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, id));
  if (!company) { res.status(404).json({ error: "العميل غير موجود" }); return; }
  const subs = await db.select().from(subscriptionsTable)
    .where(eq(subscriptionsTable.companyId, id))
    .orderBy(desc(subscriptionsTable.endDate), desc(subscriptionsTable.id));
  const users = await db
    .select({ id: usersTable.id, username: usersTable.username, email: usersTable.email, role: usersTable.role, isActive: usersTable.isActive })
    .from(usersTable).where(eq(usersTable.companyId, id));
  res.json({ company, subscriptions: subs, users });
});

// ─── Add a client company (requires add_companies) ───────────────────────
router.post("/clients", requireResellerPermission("add_companies"), async (req, res) => {
  const b = req.body ?? {};
  const nameAr = String(b.nameAr ?? "").trim();
  const vatNumber = String(b.vatNumber ?? "").trim();
  const crNumber = String(b.crNumber ?? "").trim();
  const username = String(b.username ?? "").trim();
  const password = String(b.password ?? "");
  const planKey = String(b.plan ?? "starter");
  const billingCycle = b.billingCycle === "annual" ? "annual" : "monthly";
  if (!nameAr || !vatNumber || !crNumber || !username || !password) {
    res.status(400).json({ error: "الاسم والرقم الضريبي والسجل التجاري واسم المستخدم وكلمة المرور حقول مطلوبة" }); return;
  }
  if (password.length < 6) { res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" }); return; }

  const [planRow] = await db.select().from(planConfigsTable).where(eq(planConfigsTable.key, planKey));
  if (!planRow || !planRow.isActive) { res.status(400).json({ error: "الباقة المحددة غير صالحة" }); return; }

  const price = billingCycle === "annual" ? planRow.annualPrice : planRow.monthlyPrice;

  // Create company.
  const [company] = await db.insert(companiesTable).values({
    nameAr,
    nameEn: b.nameEn ? String(b.nameEn).trim() : null,
    vatNumber, crNumber,
    city: b.city ? String(b.city).trim() : "",
    street: b.street ? String(b.street).trim() : "",
    buildingNumber: b.buildingNumber ? String(b.buildingNumber).trim() : "",
    postalCode: b.postalCode ? String(b.postalCode).trim() : "",
    phone: b.phone ? String(b.phone).trim() : null,
    country: b.country ? String(b.country).trim() : "SA",
    invoiceType: "both",
    isSandbox: false,
    status: "active",
    journalEntryFormMode: "manual",
  }).returning();

  const generatedCompanyCode = `ZTC-${company.id}`;
  try {
    await db.update(companiesTable).set({ code: generatedCompanyCode }).where(eq(companiesTable.id, company.id));
    company.code = generatedCompanyCode;
  } catch (err) {
    try { await db.delete(companiesTable).where(eq(companiesTable.id, company.id)); } catch { /* ignore */ }
    logger.error({ err, companyId: company.id }, "reseller add-client: company code generation failed");
    res.status(500).json({ error: "تعذّر إنشاء كود الشركة. يرجى المحاولة مرة أخرى." });
    return;
  }

  // Default currency (SAR for SA, else SAR fallback).
  try {
    await db.insert(currenciesTable).values({
      companyId: company.id, code: "SAR", nameAr: "ريال سعودي", nameEn: "Saudi Riyal",
      symbol: "ر.س", isDefault: true, isActive: true,
    });
  } catch (err) { logger.warn({ err, companyId: company.id }, "reseller add-client: currency seed failed"); }

  // Admin user for the new company.
  const passwordHash = await bcrypt.hash(password, 12);
  await db.insert(usersTable).values({
    companyId: company.id,
    username,
    email: b.email ? String(b.email).trim() : null,
    passwordHash,
    role: "admin",
    isActive: true,
  });

  // Subscription.
  const start = todayISO();
  const end = addMonthsISO(start, billingCycle === "annual" ? 12 : 1);
  const [subscription] = await db.insert(subscriptionsTable).values({
    companyId: company.id,
    plan: planKey,
    maxUsers: planRow.maxUsers,
    maxBranches: planRow.maxBranches,
    maxWarehouses: planRow.maxWarehouses,
    maxInvoices: planRow.maxInvoices,
    billingCycle,
    startDate: start,
    endDate: end,
    isActive: true,
    price: String(price),
  }).returning();

  // Seed default fiscal year + chart of accounts (best-effort).
  try {
    const { seedDefaultFiscalYear } = await import("../lib/seedDefaultFiscalYear.js");
    await seedDefaultFiscalYear({ companyId: company.id });
  } catch (err) { logger.warn({ err, companyId: company.id }, "reseller add-client: fiscal year seed failed"); }
  try { await seedDefaultChartOfAccounts(company.id); }
  catch (err) { logger.warn({ err, companyId: company.id }, "reseller add-client: COA seed failed"); }

  // Link the company to this reseller.
  await db.insert(resellerCompaniesTable).values({ resellerId: req.reseller!.id, companyId: company.id });

  // Accrue the new-subscription commission.
  await accrueResellerCommission({
    companyId: company.id,
    eventType: "new_subscription",
    baseAmount: Number(price ?? 0),
    subscriptionId: subscription.id,
    description: `اشتراك جديد — ${planKey} (${billingCycle})`,
  });

  res.status(201).json({ ok: true, company: { ...company }, companyCode: generatedCompanyCode, subscription });
});

// ─── Renew a client's subscription (requires renew_subscriptions) ────────
router.post("/clients/:id/renew", requireResellerPermission("renew_subscriptions"), async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  if (!(await resellerOwnsCompany(req.reseller!.id, id))) { res.status(404).json({ error: "العميل غير موجود" }); return; }
  const months = Number(req.body?.months);
  if (![1, 3, 6, 12].includes(months)) { res.status(400).json({ error: "عدد الأشهر يجب أن يكون 1 أو 3 أو 6 أو 12" }); return; }

  const [sub] = await db.select().from(subscriptionsTable)
    .where(eq(subscriptionsTable.companyId, id))
    .orderBy(desc(subscriptionsTable.endDate), desc(subscriptionsTable.id)).limit(1);
  if (!sub) { res.status(404).json({ error: "لا يوجد اشتراك لهذا العميل" }); return; }

  const result = await db.execute(sql`
    UPDATE subscriptions
       SET end_date = ((end_date::date + (${months} || ' months')::interval)::date)::text
     WHERE id = ${sub.id}
     RETURNING id, company_id, end_date
  `);
  const [updated] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, sub.id));
  // Reactivate the company if it was auto-suspended for expiry.
  if (updated && updated.endDate >= todayISO()) {
    await db.update(companiesTable)
      .set({ status: "active" })
      .where(and(eq(companiesTable.id, id), eq(companiesTable.status, "suspended")));
  }

  await accrueResellerCommission({
    companyId: id,
    eventType: "renewal",
    baseAmount: Number(updated?.price ?? 0),
    subscriptionId: sub.id,
    description: `تجديد الاشتراك ${months} شهر`,
  });
  res.json({ ok: true, subscription: updated });
});

// ─── Commissions (requires view_reports) ─────────────────────────────────
router.get("/commissions", requireResellerPermission("view_reports"), async (req, res) => {
  const rows = await db
    .select({
      id: resellerCommissionsTable.id,
      companyId: resellerCommissionsTable.companyId,
      companyName: companiesTable.nameAr,
      eventType: resellerCommissionsTable.eventType,
      description: resellerCommissionsTable.description,
      baseAmount: resellerCommissionsTable.baseAmount,
      commissionRate: resellerCommissionsTable.commissionRate,
      commissionAmount: resellerCommissionsTable.commissionAmount,
      periodMonth: resellerCommissionsTable.periodMonth,
      periodYear: resellerCommissionsTable.periodYear,
      status: resellerCommissionsTable.status,
      createdAt: resellerCommissionsTable.createdAt,
    })
    .from(resellerCommissionsTable)
    .leftJoin(companiesTable, eq(companiesTable.id, resellerCommissionsTable.companyId))
    .where(eq(resellerCommissionsTable.resellerId, req.reseller!.id))
    .orderBy(desc(resellerCommissionsTable.createdAt));
  res.json({ commissions: rows });
});

// ─── Commission summary (monthly / annual roll-up) ───────────────────────
router.get("/commissions/summary", requireResellerPermission("view_reports"), async (req, res) => {
  const monthly = await db
    .select({
      periodYear: resellerCommissionsTable.periodYear,
      periodMonth: resellerCommissionsTable.periodMonth,
      count: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(${resellerCommissionsTable.commissionAmount}),0)`,
      base: sql<string>`coalesce(sum(${resellerCommissionsTable.baseAmount}),0)`,
    })
    .from(resellerCommissionsTable)
    .where(eq(resellerCommissionsTable.resellerId, req.reseller!.id))
    .groupBy(resellerCommissionsTable.periodYear, resellerCommissionsTable.periodMonth)
    .orderBy(desc(resellerCommissionsTable.periodYear), desc(resellerCommissionsTable.periodMonth));
  const annual = await db
    .select({
      periodYear: resellerCommissionsTable.periodYear,
      count: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(${resellerCommissionsTable.commissionAmount}),0)`,
    })
    .from(resellerCommissionsTable)
    .where(eq(resellerCommissionsTable.resellerId, req.reseller!.id))
    .groupBy(resellerCommissionsTable.periodYear)
    .orderBy(desc(resellerCommissionsTable.periodYear));
  res.json({ monthly, annual });
});

// ─── Support tickets (requires support) ──────────────────────────────────
router.get("/tickets", requireResellerPermission("support"), async (req, res) => {
  const rows = await db.select().from(resellerTicketsTable)
    .where(eq(resellerTicketsTable.resellerId, req.reseller!.id))
    .orderBy(desc(resellerTicketsTable.createdAt));
  res.json({ tickets: rows });
});

router.post("/tickets", requireResellerPermission("support"), async (req, res) => {
  const subject = String(req.body?.subject ?? "").trim();
  const body = String(req.body?.body ?? "").trim();
  if (!subject || !body) { res.status(400).json({ error: "الموضوع والنص مطلوبان" }); return; }
  let companyId: number | null = null;
  if (req.body?.companyId != null) {
    const cid = parseInt(req.body.companyId);
    if (Number.isInteger(cid) && (await resellerOwnsCompany(req.reseller!.id, cid))) companyId = cid;
  }
  const [created] = await db.insert(resellerTicketsTable).values({
    resellerId: req.reseller!.id,
    companyId,
    subject, body,
    category: req.body?.category ? String(req.body.category).trim() : "general",
    priority: req.body?.priority === "high" || req.body?.priority === "urgent" ? String(req.body.priority) : "normal",
    status: "open",
  }).returning();
  res.status(201).json({ ok: true, ticket: created });
});

// ─── Activation requests ─────────────────────────────────────────────────
router.get("/activation-requests", async (req, res) => {
  const rows = await db.select().from(resellerActivationRequestsTable)
    .where(eq(resellerActivationRequestsTable.resellerId, req.reseller!.id))
    .orderBy(desc(resellerActivationRequestsTable.createdAt));
  res.json({ requests: rows });
});

router.post("/activation-requests", async (req, res) => {
  const companyNameAr = String(req.body?.companyNameAr ?? "").trim();
  if (!companyNameAr) { res.status(400).json({ error: "اسم الشركة مطلوب" }); return; }
  const [created] = await db.insert(resellerActivationRequestsTable).values({
    resellerId: req.reseller!.id,
    companyNameAr,
    contactPhone: req.body?.contactPhone ? String(req.body.contactPhone).trim() : null,
    contactEmail: req.body?.contactEmail ? String(req.body.contactEmail).trim() : null,
    plan: req.body?.plan ? String(req.body.plan).trim() : null,
    notes: req.body?.notes ? String(req.body.notes).trim() : null,
    status: "pending",
  }).returning();
  res.status(201).json({ ok: true, request: created });
});

export default router;
