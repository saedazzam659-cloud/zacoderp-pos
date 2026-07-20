// ─── طلبات المتدربين — SuperAdmin trainee-request management ─────────────
// Fully additive router. A visitor files a request via the PUBLIC endpoint
// POST /api/auth/trainee-register (auth.ts); everything here is SuperAdmin-
// only: list/review requests, approve (choosing training duration, env mode
// shared|separate and allowed modules → creates the real users row flagged
// is_trainee and emails the activation message) or reject with a reason.
//
// Emails: ALL trainee correspondence goes out through the Outlook connector
// mailbox zacoderp@outlook.com (channel:"training" in lib/email.ts) per
// explicit owner instruction.
import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  usersTable, companiesTable, subscriptionsTable, currenciesTable,
  traineeRequestsTable,
} from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import { resolveBearerToken } from "../middleware/auth.js";
import { sendEmail } from "../lib/email.js";
import { writeAudit } from "../middleware/permissions.js";
import { resolveDefaultCurrency, REGISTRATION_MODULE_PERMISSIONS } from "./auth.js";

const router = Router();

// Same contract as admin.ts requireSuperAdmin: legacy users.sessionToken
// first, then the SuperAdmin multi-session resolver.
async function requireSuperAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { res.status(401).json({ error: "غير مصرح" }); return; }
  const token = auth.slice(7);
  let [user] = await db.select().from(usersTable).where(eq(usersTable.sessionToken, token));
  if (!user) {
    const resolved = await resolveBearerToken(token);
    if (resolved && resolved.origin === "superadmin") {
      const [full] = await db.select().from(usersTable).where(eq(usersTable.id, resolved.user.id));
      if (full) user = full;
    }
  }
  if (!user || !user.isActive || user.role !== "superadmin") {
    res.status(403).json({ error: "هذه الصفحة للمشرف العام فقط" });
    return;
  }
  req.adminUser = user;
  next();
}

router.use(requireSuperAdmin);

// Base URL for the Training URL placed in the activation email. Same rules
// as superAdminAuth.publicBaseUrlFromReq: configured values beat headers,
// and in prod we NEVER use REPLIT_DEV_DOMAIN (sleeping workspace).
function publicBaseUrlFromReq(req: Request): string {
  const fixed = (process.env.PUBLIC_BASE_URL ?? "").trim();
  if (fixed) return fixed.replace(/\/+$/, "");
  const domains = (process.env.REPLIT_DOMAINS ?? "")
    .split(",").map(d => d.trim()).filter(Boolean);
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && domains.length) {
    const custom = domains.find(d => !/\.replit\.(app|dev)$/i.test(d));
    return `https://${custom ?? domains[0]}`;
  }
  const replitDev = (process.env.REPLIT_DEV_DOMAIN ?? "").trim();
  if (replitDev) return `https://${replitDev}`;
  if (domains.length) return `https://${domains[0]}`;
  const proto = (req.headers["x-forwarded-proto"]?.toString() || "https").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"]?.toString() || req.headers.host?.toString() || "");
  return host ? `${proto}://${host}` : "";
}

// GET /api/admin/trainee-requests?status=pending — list requests
router.get("/", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const where = status && ["pending", "approved", "rejected"].includes(status)
    ? eq(traineeRequestsTable.status, status)
    : undefined;
  const rows = await db.select().from(traineeRequestsTable)
    .where(where)
    .orderBy(desc(traineeRequestsTable.createdAt));
  // Never leak the password hash to the client.
  res.json(rows.map(({ passwordHash: _ph, ...r }) => r));
});

// Build the spec-mandated activation email (spec lines 87-106).
function activationEmail(fullName: string, email: string, trainingUrl: string) {
  const subject = "مرحباً بك في ZacoERP – تم تفعيل حساب التدريب الخاص بك";
  const text =
`مرحباً ${fullName}،

🎉 يسعدنا إبلاغك بأنه تم تفعيل حساب التدريب الخاص بك بنجاح.

يمكنك الآن تسجيل الدخول إلى منصة ZacoERP والبدء في استكشاف النظام والتدريب على الموديولات المخصصة لك.

بيانات الدخول:

- البريد الإلكتروني: ${email}
- رابط النظام: ${trainingUrl}

نتمنى لك تجربة مميزة، وإذا احتجت إلى أي مساعدة فإن فريق الدعم جاهز لخدمتك.

مرحباً بك في عائلة ZacoERP، ونتمنى لك رحلة تدريب ناجحة ومثمرة.`;
  const html = `
<div dir="rtl" lang="ar" style="font-family:'Tahoma',Arial,sans-serif;background:#f4f6f8;padding:32px;">
  <div style="max-width:560px;margin:auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 6px rgba(0,0,0,.06);">
    <div style="border-bottom:2px solid #10b981;padding-bottom:12px;margin-bottom:18px;">
      <h2 style="margin:0;color:#0f172a;font-size:20px;">مرحباً بك في ZacoERP</h2>
    </div>
    <div style="color:#334155;line-height:1.9;font-size:14px;">
      <p>مرحباً <strong>${fullName}</strong>،</p>
      <p>🎉 يسعدنا إبلاغك بأنه تم تفعيل حساب التدريب الخاص بك بنجاح.</p>
      <p>يمكنك الآن تسجيل الدخول إلى منصة ZacoERP والبدء في استكشاف النظام والتدريب على الموديولات المخصصة لك.</p>
      <p style="margin-bottom:4px;"><strong>بيانات الدخول:</strong></p>
      <ul style="margin-top:4px;">
        <li>البريد الإلكتروني: <strong>${email}</strong></li>
        <li>رابط النظام: <a href="${trainingUrl}" style="color:#10b981;">${trainingUrl}</a></li>
      </ul>
      <p>نتمنى لك تجربة مميزة، وإذا احتجت إلى أي مساعدة فإن فريق الدعم جاهز لخدمتك.</p>
      <p>مرحباً بك في عائلة ZacoERP، ونتمنى لك رحلة تدريب ناجحة ومثمرة.</p>
    </div>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
    <p style="font-size:12px;color:#94a3b8;margin:0;">هذه رسالة آلية من منصة ZacoERP.</p>
  </div>
</div>`;
  return { subject, text, html };
}

// Build the deny-filled menuPermissions JSON for the trainee's allowed
// modules, reusing the SAME authoritative mapping as company registration.
async function buildTraineeMenuPermissions(allowedModules: string[]): Promise<string> {
  const out: Record<string, boolean> = { dashboard: true, invoices: true, customers: true };
  for (const k of allowedModules) {
    const perms = REGISTRATION_MODULE_PERMISSIONS[k];
    if (!perms) continue;
    for (const p of perms) out[p] = true;
  }
  const { CANONICAL_MENU_PERMISSION_KEYS } = await import("../lib/menuPermissionCatalog.js");
  for (const k of CANONICAL_MENU_PERMISSION_KEYS) {
    if (out[k] !== true) out[k] = false;
  }
  return JSON.stringify(out);
}

// ── Per-user RBAC permission map for SHARED-mode trainees ────────────────
// users.permissions is shaped { key: { view, create, edit, delete, post,
// export } } (see zatca-invoicing lib/permissions.ts + usePermission). The
// first release stored a FLAT boolean map here, which the frontend reads as
// "no view permission on anything" → empty sidebar. This maps each high-level
// trainee module to the granular per-user permission keys of its screens.
const TRAINEE_USER_PERM_KEYS: Record<string, string[]> = {
  sales:        ["customers", "sales_quotations", "sales_invoices", "sales_returns", "sales_settlements", "sales_reps", "sales_reports"],
  purchasing:   ["suppliers", "purchase_invoices", "purchase_returns", "supplier_settlements"],
  inventory:    ["items", "warehouses", "stock_transfers", "stock_adjustments", "stock_counts", "inventory_reports", "brands"],
  pos:          ["pos"],
  cash:         ["cash_boxes", "bank_accounts", "receipt_vouchers", "payment_vouchers"],
  accounting:   ["accounts", "journal_entries", "accounting_reports", "accounting_maintenance", "vat_declaration"],
  hr:           ["hr_employees", "hr_attendance", "hr_loans", "hr_payroll", "hr_eos", "hr_calculators", "hr_settings", "hr_face_attendance"],
  zatca:        ["zatca_setup", "zatca_bridge", "zatca_report"],
  contracting:  ["contracting"],
  production:   ["production"],
  security:     ["security_events"],
  maintenance:  ["maintenance"],
  installments: ["installments"],
  hotel:        ["hotel"],
};

const TRAINEE_BASE_PERM_KEYS = [
  "dashboard", "dashboard_kpis", "dashboard_charts", "dashboard_alerts",
  "dashboard_recent_invoices", "customers", "sales_invoices",
];

type UserPermMap = Record<string, Record<string, boolean>>;

function buildTraineeUserPermissions(allowedModules: string[]): UserPermMap {
  const ACTIONS = ["view", "create", "edit", "delete", "post", "export"] as const;
  const keys = new Set<string>(TRAINEE_BASE_PERM_KEYS);
  for (const m of allowedModules) for (const k of TRAINEE_USER_PERM_KEYS[m] ?? []) keys.add(k);
  const out: UserPermMap = {};
  for (const k of keys) {
    out[k] = {};
    for (const a of ACTIONS) out[k][a] = true;
  }
  return out;
}

// POST /api/admin/trainee-requests/:id/approve
// Body: { durationDays, envMode: "shared"|"separate", allowedModules: string[],
//         companyId? (required for shared mode) }
router.post("/:id/approve", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const durationDays = Math.floor(Number(req.body?.durationDays));
  const envMode = req.body?.envMode;
  const allowedModules = (Array.isArray(req.body?.allowedModules) ? req.body.allowedModules : [])
    .filter((m: unknown): m is string => typeof m === "string" && m in REGISTRATION_MODULE_PERMISSIONS);
  const sharedCompanyId = Number(req.body?.companyId);

  if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 730) {
    res.status(400).json({ error: "مدة التدريب غير صالحة (1 - 730 يوم)" });
    return;
  }
  if (envMode !== "shared" && envMode !== "separate") {
    res.status(400).json({ error: "بيئة التدريب يجب أن تكون shared أو separate" });
    return;
  }
  if (envMode === "shared" && (!Number.isInteger(sharedCompanyId) || sharedCompanyId <= 0)) {
    res.status(400).json({ error: "اختر الشركة التدريبية المشتركة" });
    return;
  }

  const menuPermissions = await buildTraineeMenuPermissions(allowedModules);
  const today = new Date().toISOString().split("T")[0];
  const endDate = new Date(Date.now() + durationDays * 86400000).toISOString().split("T")[0];

  try {
    // ── Atomic approval ────────────────────────────────────────────────
    // Everything that flips state (request row, company/subscription
    // seed, user creation) runs in ONE transaction under a row lock on
    // the trainee request, so a concurrent double-approve either sees
    // the lock (waits, then hits the non-pending 409) or nothing at all.
    // Best-effort side effects (fiscal-year seed, activation email) run
    // AFTER commit — they use the global db / external services and
    // must not hold the lock or roll back a valid approval.
    type TxError = { httpStatus: number; message: string };
    const outcome = await db.transaction(async (tx) => {
      const [reqRow] = await tx.select().from(traineeRequestsTable)
        .where(eq(traineeRequestsTable.id, id))
        .for("update");
      if (!reqRow) return { err: { httpStatus: 404, message: "الطلب غير موجود" } as TxError };
      if (reqRow.status !== "pending") {
        return { err: { httpStatus: 409, message: "تم البتّ في هذا الطلب بالفعل" } as TxError };
      }

      const emailLower = reqRow.email.toLowerCase();
      // Global trainee-username collision guard (partial unique index backstop).
      const [dupUser] = await tx.select({ id: usersTable.id }).from(usersTable)
        .where(and(sql`lower(${usersTable.username}) = ${emailLower}`, eq(usersTable.isTrainee, true)));
      if (dupUser) {
        return { err: { httpStatus: 409, message: "يوجد حساب تدريبي بنفس البريد الإلكتروني بالفعل" } as TxError };
      }

      let companyId: number;
      let role: string;
      if (envMode === "separate") {
        // Dedicated per-trainee training company (sandbox), mirroring the
        // company-registration seed flow.
        const [company] = await tx.insert(companiesTable).values({
          nameAr: `تدريب - ${reqRow.fullName}`,
          nameEn: `Training - ${reqRow.fullName}`,
          vatNumber: "000000000000000",
          crNumber: `TRN-${Date.now()}`,
          city: reqRow.city ?? "",
          street: "",
          buildingNumber: "",
          postalCode: "",
          phone: `${reqRow.phoneCountryKey}${reqRow.phone}`,
          country: reqRow.country,
          industryName: reqRow.industry,
          invoiceType: "both",
          isSandbox: true,
          status: "active",
          journalEntryFormMode: "manual",
          menuPermissions,
        }).returning();
        const code = `ZTC-${company.id}`;
        await tx.update(companiesTable).set({ code }).where(eq(companiesTable.id, company.id));

        const cur = resolveDefaultCurrency(reqRow.country);
        await tx.insert(currenciesTable).values({
          companyId: company.id,
          code: cur.code, nameAr: cur.nameAr, nameEn: cur.nameEn, symbol: cur.symbol,
          isDefault: true, isActive: true,
        });

        await tx.insert(subscriptionsTable).values({
          companyId: company.id,
          plan: "starter",
          maxUsers: 1,
          maxInvoices: 1000,
          billingCycle: "monthly",
          startDate: today,
          endDate,
          isActive: true,
          price: "0",
        });

        companyId = company.id;
        role = "admin"; // own sandbox company → full control inside it
      } else {
        // Shared training company chosen by the SuperAdmin.
        const [company] = await tx.select({ id: companiesTable.id })
          .from(companiesTable).where(eq(companiesTable.id, sharedCompanyId));
        if (!company) return { err: { httpStatus: 404, message: "الشركة التدريبية غير موجودة" } as TxError };
        companyId = company.id;
        role = "user";
      }

      const userValues: typeof usersTable.$inferInsert = {
        username: emailLower,
        email: emailLower,
        passwordHash: reqRow.passwordHash,
        companyId,
        role,
        isActive: true,
        isTrainee: true,
        // Shared-mode trainees get a personal RBAC permission map limited to
        // the allowed modules; separate-mode relies on the company-level map.
        ...(envMode === "shared" ? { permissions: buildTraineeUserPermissions(allowedModules) } : {}),
      };
      const [newUser] = await tx.insert(usersTable).values(userValues).returning();

      await tx.update(traineeRequestsTable).set({
        status: "approved",
        decidedBy: req.adminUser!.id,
        decidedAt: new Date(),
        durationDays,
        envMode,
        companyId,
        allowedModules,
        userId: newUser.id,
        activationEmailSentAt: null,
        updatedAt: new Date(),
      }).where(eq(traineeRequestsTable.id, id));

      return { err: null, companyId, newUserId: newUser.id, emailLower, fullName: reqRow.fullName };
    });

    if (outcome.err) {
      res.status(outcome.err.httpStatus).json({ error: outcome.err.message });
      return;
    }
    const { companyId, newUserId, emailLower, fullName } = outcome;

    // ── Post-commit best-effort side effects ──────────────────────────
    if (envMode === "separate") {
      try {
        const { seedDefaultFiscalYear } = await import("../lib/seedDefaultFiscalYear.js");
        await seedDefaultFiscalYear({ companyId });
      } catch (err) {
        req.log?.warn?.({ err, companyId }, "trainee company fiscal year seed failed");
      }
    }

    const trainingUrl = `${publicBaseUrlFromReq(req)}/login`;
    const mail = activationEmail(fullName, emailLower, trainingUrl);
    const sent = await sendEmail({
      to: emailLower,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      channel: "training",
    });
    if (sent.ok) {
      await db.update(traineeRequestsTable)
        .set({ activationEmailSentAt: new Date(), updatedAt: new Date() })
        .where(eq(traineeRequestsTable.id, id));
    }

    await writeAudit({
      userId: req.adminUser!.id, username: req.adminUser!.username, role: "superadmin",
      companyId, module: "admin", action: "approve",
      method: "POST", path: `/api/admin/trainee-requests/${id}/approve`, statusCode: 200,
      ip: null, userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null,
      metadata: { traineeRequestId: id, envMode, durationDays, allowedModules, userId: newUserId, emailSent: sent.ok },
    });

    res.json({
      ok: true,
      userId: newUserId,
      companyId,
      emailSent: sent.ok,
      ...(sent.ok ? {} : { emailError: sent.reason ?? "unknown" }),
    });
  } catch (err: any) {
    if (String(err?.code) === "23505") {
      res.status(409).json({ error: "يوجد حساب تدريبي بنفس البريد الإلكتروني بالفعل" });
      return;
    }
    req.log?.error?.({ err, traineeRequestId: id }, "trainee approve failed");
    res.status(500).json({ error: "تعذّر اعتماد الطلب. حاول مرة أخرى." });
  }
});

// POST /api/admin/trainee-requests/:id/reject — Body: { reason }
router.post("/:id/reject", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
  if (reason.length < 3) { res.status(400).json({ error: "سبب الرفض مطلوب (3 أحرف على الأقل)" }); return; }

  const [reqRow] = await db.select().from(traineeRequestsTable)
    .where(eq(traineeRequestsTable.id, id));
  if (!reqRow) { res.status(404).json({ error: "الطلب غير موجود" }); return; }
  if (reqRow.status !== "pending") {
    res.status(409).json({ error: "تم البتّ في هذا الطلب بالفعل" });
    return;
  }

  // Atomic claim: only a still-pending row can flip to rejected — a
  // concurrent approve/reject loses the race and gets a 409.
  const [claimed] = await db.update(traineeRequestsTable).set({
    status: "rejected",
    decidedBy: req.adminUser!.id,
    decidedAt: new Date(),
    rejectReason: reason,
    updatedAt: new Date(),
  }).where(and(
    eq(traineeRequestsTable.id, id),
    eq(traineeRequestsTable.status, "pending"),
  )).returning({ id: traineeRequestsTable.id });
  if (!claimed) {
    res.status(409).json({ error: "تم البتّ في هذا الطلب بالفعل" });
    return;
  }

  // Courtesy rejection email — best-effort, from the same Outlook mailbox.
  const sent = await sendEmail({
    to: reqRow.email,
    subject: "بخصوص طلب حساب التدريب في ZacoERP",
    html: `
<div dir="rtl" lang="ar" style="font-family:'Tahoma',Arial,sans-serif;background:#f4f6f8;padding:32px;">
  <div style="max-width:560px;margin:auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 6px rgba(0,0,0,.06);">
    <h2 style="margin:0 0 18px;color:#0f172a;font-size:20px;border-bottom:2px solid #ef4444;padding-bottom:12px;">طلب حساب التدريب</h2>
    <div style="color:#334155;line-height:1.9;font-size:14px;">
      <p>مرحباً <strong>${reqRow.fullName}</strong>،</p>
      <p>نشكرك على اهتمامك بمنصة ZacoERP. نأسف لإبلاغك بأنه لم يتم اعتماد طلب حساب التدريب الخاص بك في الوقت الحالي.</p>
      <p><strong>السبب:</strong> ${reason}</p>
      <p>يمكنك التقديم مرة أخرى في أي وقت، وإذا كان لديك أي استفسار فإن فريق الدعم جاهز لخدمتك.</p>
    </div>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
    <p style="font-size:12px;color:#94a3b8;margin:0;">هذه رسالة آلية من منصة ZacoERP.</p>
  </div>
</div>`,
    text: `مرحباً ${reqRow.fullName}،\n\nنشكرك على اهتمامك بمنصة ZacoERP. نأسف لإبلاغك بأنه لم يتم اعتماد طلب حساب التدريب الخاص بك في الوقت الحالي.\n\nالسبب: ${reason}\n\nيمكنك التقديم مرة أخرى في أي وقت.`,
    channel: "training",
  });

  await writeAudit({
    userId: req.adminUser!.id, username: req.adminUser!.username, role: "superadmin",
    companyId: null, module: "admin", action: "reject",
    method: "POST", path: `/api/admin/trainee-requests/${id}/reject`, statusCode: 200,
    ip: null, userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null,
    metadata: { traineeRequestId: id, reason, emailSent: sent.ok },
  });

  res.json({ ok: true, emailSent: sent.ok });
});

// PATCH /api/admin/trainee-requests/:id — edit an APPROVED trainee's
// training settings. Body: { durationDays?, allowedModules? }
// Applies the change to the live account too:
//   shared   → rewrites the trainee user's personal RBAC permission map.
//   separate → rewrites the sandbox company's menuPermissions + the
//              subscription endDate (duration counted from the approval day).
router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const [reqRow] = await db.select().from(traineeRequestsTable)
    .where(eq(traineeRequestsTable.id, id));
  if (!reqRow) { res.status(404).json({ error: "الطلب غير موجود" }); return; }
  if (reqRow.status !== "approved") {
    res.status(409).json({ error: "التعديل متاح للطلبات المعتمدة فقط" });
    return;
  }

  const hasDuration = req.body?.durationDays !== undefined;
  const hasModules = req.body?.allowedModules !== undefined;
  if (!hasDuration && !hasModules) {
    res.status(400).json({ error: "لا يوجد ما يتم تعديله" });
    return;
  }

  let durationDays = reqRow.durationDays ?? 30;
  if (hasDuration) {
    durationDays = Math.floor(Number(req.body.durationDays));
    if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 730) {
      res.status(400).json({ error: "مدة التدريب غير صالحة (1 - 730 يوم)" });
      return;
    }
  }
  let allowedModules: string[] = Array.isArray(reqRow.allowedModules) ? reqRow.allowedModules : [];
  if (hasModules) {
    allowedModules = (Array.isArray(req.body.allowedModules) ? req.body.allowedModules : [])
      .filter((m: unknown): m is string => typeof m === "string" && m in REGISTRATION_MODULE_PERMISSIONS);
  }

  try {
    if (hasModules) {
      if (reqRow.envMode === "shared" && reqRow.userId) {
        await db.update(usersTable)
          .set({ permissions: buildTraineeUserPermissions(allowedModules) })
          .where(eq(usersTable.id, reqRow.userId));
      } else if (reqRow.envMode === "separate" && reqRow.companyId) {
        const menuPermissions = await buildTraineeMenuPermissions(allowedModules);
        await db.update(companiesTable)
          .set({ menuPermissions })
          .where(eq(companiesTable.id, reqRow.companyId));
      }
    }

    if (hasDuration && reqRow.envMode === "separate" && reqRow.companyId) {
      const baseMs = reqRow.decidedAt ? new Date(reqRow.decidedAt).getTime() : Date.now();
      const endDate = new Date(baseMs + durationDays * 86400000).toISOString().split("T")[0];
      await db.update(subscriptionsTable)
        .set({ endDate })
        .where(eq(subscriptionsTable.companyId, reqRow.companyId));
    }

    await db.update(traineeRequestsTable).set({
      durationDays,
      allowedModules,
      updatedAt: new Date(),
    }).where(eq(traineeRequestsTable.id, id));

    await writeAudit({
      userId: req.adminUser!.id, username: req.adminUser!.username, role: "superadmin",
      companyId: reqRow.companyId ?? null, module: "admin", action: "update",
      method: "PATCH", path: `/api/admin/trainee-requests/${id}`, statusCode: 200,
      ip: null, userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null,
      metadata: { traineeRequestId: id, durationDays, allowedModules },
    });

    res.json({ ok: true });
  } catch (err) {
    req.log?.error?.({ err, traineeRequestId: id }, "trainee edit failed");
    res.status(500).json({ error: "تعذّر حفظ التعديلات. حاول مرة أخرى." });
  }
});

// POST /api/admin/trainee-requests/:id/resend-email — re-send the activation
// email for an approved request (e.g. it landed in spam or never arrived).
router.post("/:id/resend-email", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const [reqRow] = await db.select().from(traineeRequestsTable)
    .where(eq(traineeRequestsTable.id, id));
  if (!reqRow) { res.status(404).json({ error: "الطلب غير موجود" }); return; }
  if (reqRow.status !== "approved") {
    res.status(409).json({ error: "إعادة الإرسال متاحة للطلبات المعتمدة فقط" });
    return;
  }

  const trainingUrl = `${publicBaseUrlFromReq(req)}/login`;
  const mail = activationEmail(reqRow.fullName, reqRow.email.toLowerCase(), trainingUrl);
  const sent = await sendEmail({
    to: reqRow.email.toLowerCase(),
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    channel: "training",
  });
  if (sent.ok) {
    await db.update(traineeRequestsTable)
      .set({ activationEmailSentAt: new Date(), updatedAt: new Date() })
      .where(eq(traineeRequestsTable.id, id));
  }
  res.json({ ok: sent.ok, emailSent: sent.ok, ...(sent.ok ? {} : { emailError: sent.reason ?? "unknown" }) });
});

// DELETE /api/admin/trainee-requests/:id — remove a request entirely.
// For approved requests this also removes the trainee's user account
// (fallback: deactivate if the row is referenced elsewhere) and, in
// separate mode, suspends the sandbox training company (never a hard
// cascade delete of a whole company).
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const [reqRow] = await db.select().from(traineeRequestsTable)
    .where(eq(traineeRequestsTable.id, id));
  if (!reqRow) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

  try {
    let userDeleted = false;
    let userDeactivated = false;
    if (reqRow.userId) {
      try {
        const deleted = await db.delete(usersTable).where(and(
          eq(usersTable.id, reqRow.userId),
          eq(usersTable.isTrainee, true), // never touch a non-trainee account
        )).returning({ id: usersTable.id });
        userDeleted = deleted.length > 0;
      } catch {
        // FK references (audit rows etc.) — deactivate instead.
        const updated = await db.update(usersTable)
          .set({ isActive: false, sessionToken: null })
          .where(and(eq(usersTable.id, reqRow.userId), eq(usersTable.isTrainee, true)))
          .returning({ id: usersTable.id });
        userDeactivated = updated.length > 0;
      }
    }

    let companySuspended = false;
    if (reqRow.envMode === "separate" && reqRow.companyId) {
      const suspended = await db.update(companiesTable)
        .set({ status: "suspended" })
        .where(and(eq(companiesTable.id, reqRow.companyId), eq(companiesTable.isSandbox, true)))
        .returning({ id: companiesTable.id });
      companySuspended = suspended.length > 0;
    }

    await db.delete(traineeRequestsTable).where(eq(traineeRequestsTable.id, id));

    await writeAudit({
      userId: req.adminUser!.id, username: req.adminUser!.username, role: "superadmin",
      companyId: reqRow.companyId ?? null, module: "admin", action: "delete",
      method: "DELETE", path: `/api/admin/trainee-requests/${id}`, statusCode: 200,
      ip: null, userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null,
      metadata: { traineeRequestId: id, userId: reqRow.userId, userDeleted, userDeactivated, companySuspended },
    });

    res.json({ ok: true, userDeleted, userDeactivated, companySuspended });
  } catch (err) {
    req.log?.error?.({ err, traineeRequestId: id }, "trainee delete failed");
    res.status(500).json({ error: "تعذّر حذف الطلب. حاول مرة أخرى." });
  }
});

export default router;
