// /api/invoice-field-policies
//
// Per-company "what-fields-show-on-invoice-screens" governance.
//
// Model:
//   - Admin defines named policy PROFILES (e.g. "كاشير", "محاسب مبتدئ").
//   - Each user is ASSIGNED to one profile (or inherits company default).
//   - Admins/superadmins always bypass.

import { Router } from "express";
import { eq, and, inArray } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import {
  db,
  invoiceFieldPolicyProfilesTable,
  userInvoiceFieldPoliciesTable,
  usersTable,
  POLICY_SCOPES,
  defaultPolicy,
  defaultBundle,
  companiesTable,
  type PolicyScope,
  type PolicyMap,
  type PolicyBundle,
  type FieldRule,
  FIELD_CATALOGUE,
} from "@workspace/db";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router: Router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function getCid(req: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query?.companyId);
  return cid ?? null;
}
// Authoring this policy is a SuperAdmin-only operation (entered into a
// tenant via the "الدخول إلى شركة" flow). Company admins never see the
// screen and the API rejects their writes here.
function isSuperadmin(req: any): boolean {
  return req.authUser?.role === "superadmin";
}
// Bypass on /me — applies to BOTH superadmins (acting/global) and company
// admins. Company admins still get a fully editable bundle so their own
// invoice screens are unaffected by this governance feature.
function bypassesPolicy(req: any): boolean {
  const role = req.authUser?.role;
  return role === "admin" || role === "superadmin";
}
function isScope(s: any): s is PolicyScope {
  return POLICY_SCOPES.includes(s);
}

/** Sanitize a single-scope policy map. */
function sanitizePolicy(scope: PolicyScope, raw: any): PolicyMap {
  const validModes = new Set(["editable", "readonly", "hidden", "required"]);
  const validDate  = new Set(["none", "today_only"]);
  const allowedKeys = new Set(FIELD_CATALOGUE[scope].map((f) => f.key));
  const dateKeys    = new Set(FIELD_CATALOGUE[scope].filter((f) => f.isDate).map((f) => f.key));

  const out: PolicyMap = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (!allowedKeys.has(k)) continue;
      const r = v as any;
      const mode = validModes.has(r?.mode) ? r.mode : "editable";
      const rule: FieldRule = { mode };
      if (dateKeys.has(k)) {
        rule.dateConstraint = validDate.has(r?.dateConstraint) ? r.dateConstraint : "none";
      }
      out[k] = rule;
    }
  }
  for (const f of FIELD_CATALOGUE[scope]) {
    if (!out[f.key]) {
      out[f.key] = { mode: "editable", ...(f.isDate ? { dateConstraint: "none" as const } : {}) };
    }
  }
  return out;
}

function sanitizeBundle(raw: any): PolicyBundle {
  return {
    sales:         sanitizePolicy("sales",         raw?.sales),
    purchase:      sanitizePolicy("purchase",      raw?.purchase),
    pos:           sanitizePolicy("pos",           raw?.pos),
    customers:     sanitizePolicy("customers",     raw?.customers),
    journal_entry: sanitizePolicy("journal_entry", raw?.journal_entry),
  };
}

// ── /me ─────────────────────────────────────────────────────────────────
// Returns the EFFECTIVE bundle for the current user.
router.get("/me", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }

    if (bypassesPolicy(req)) {
      res.json({ isAdmin: true, bundle: defaultBundle(), profile: null });
      return;
    }

    const userId = (req as any).authUser?.id;
    let profileId: number | null = null;
    if (userId) {
      const [a] = await db.select({ profileId: userInvoiceFieldPoliciesTable.profileId })
        .from(userInvoiceFieldPoliciesTable)
        .where(eq(userInvoiceFieldPoliciesTable.userId, userId)).limit(1);
      profileId = a?.profileId ?? null;
    }

    let profile: { id: number; name: string; bundle: any } | null = null;
    if (profileId) {
      const [p] = await db.select({
        id: invoiceFieldPolicyProfilesTable.id,
        name: invoiceFieldPolicyProfilesTable.name,
        bundle: invoiceFieldPolicyProfilesTable.bundle,
      }).from(invoiceFieldPolicyProfilesTable)
        .where(and(
          eq(invoiceFieldPolicyProfilesTable.id, profileId),
          eq(invoiceFieldPolicyProfilesTable.companyId, cid),
        )).limit(1);
      profile = p ?? null;
    }
    if (!profile) {
      // fall back to the company's default profile
      const [p] = await db.select({
        id: invoiceFieldPolicyProfilesTable.id,
        name: invoiceFieldPolicyProfilesTable.name,
        bundle: invoiceFieldPolicyProfilesTable.bundle,
      }).from(invoiceFieldPolicyProfilesTable)
        .where(and(
          eq(invoiceFieldPolicyProfilesTable.companyId, cid),
          eq(invoiceFieldPolicyProfilesTable.isDefault, true),
        )).limit(1);
      profile = p ?? null;
    }

    const bundle = profile ? sanitizeBundle(profile.bundle as any) : defaultBundle();
    res.json({
      isAdmin: false,
      bundle,
      profile: profile ? { id: profile.id, name: profile.name } : null,
    });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /invoice-field-policies/me failed");
    res.status(500).json({ error: e?.message ?? "internal error" });
  }
});

// ── /catalogue (admin) ──────────────────────────────────────────────────
router.get("/catalogue", (req, res) => {
  if (!isSuperadmin(req)) { res.status(403).json({ error: "صلاحية السوبر أدمن فقط" }); return; }
  res.json({ catalogue: FIELD_CATALOGUE });
});

// ── /profiles ───────────────────────────────────────────────────────────
router.get("/profiles", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!isSuperadmin(req)) { res.status(403).json({ error: "صلاحية السوبر أدمن فقط" }); return; }

    const profiles = await db.select().from(invoiceFieldPolicyProfilesTable)
      .where(eq(invoiceFieldPolicyProfilesTable.companyId, cid));

    // count assigned users per profile
    const counts = new Map<number, number>();
    if (profiles.length) {
      const ids = profiles.map((p) => p.id);
      const rows = await db.select({
        profileId: userInvoiceFieldPoliciesTable.profileId,
      }).from(userInvoiceFieldPoliciesTable)
        .where(inArray(userInvoiceFieldPoliciesTable.profileId, ids));
      for (const r of rows) counts.set(r.profileId, (counts.get(r.profileId) ?? 0) + 1);
    }

    res.json({
      profiles: profiles.map((p) => ({
        id: p.id,
        name: p.name,
        bundle: sanitizeBundle(p.bundle as any),
        isDefault: p.isDefault,
        color: p.color,
        assignedCount: counts.get(p.id) ?? 0,
        updatedAt: p.updatedAt,
      })),
    });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /profiles failed");
    res.status(500).json({ error: e?.message ?? "internal error" });
  }
});

router.post("/profiles", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!isSuperadmin(req)) { res.status(403).json({ error: "صلاحية السوبر أدمن فقط" }); return; }

    const name = String(req.body?.name ?? "").trim();
    if (!name) { res.status(400).json({ error: "الاسم مطلوب" }); return; }

    const bundle = sanitizeBundle(req.body?.bundle);
    const color  = typeof req.body?.color === "string" ? req.body.color : null;
    const updatedBy = (req as any).authUser?.id ?? null;

    const [row] = await db.insert(invoiceFieldPolicyProfilesTable).values({
      companyId: cid, name, bundle: bundle as any, color, updatedBy,
    }).returning();

    res.json({ profile: { ...row, bundle: sanitizeBundle(row.bundle as any) } });
  } catch (e: any) {
    if (String(e?.message ?? "").includes("unique") || e?.code === "23505") {
      res.status(409).json({ error: "اسم القالب مستخدم بالفعل" });
      return;
    }
    req.log?.error?.({ err: e }, "POST /profiles failed");
    res.status(500).json({ error: e?.message ?? "internal error" });
  }
});

router.put("/profiles/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!isSuperadmin(req)) { res.status(403).json({ error: "صلاحية السوبر أدمن فقط" }); return; }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صحيح" }); return; }

    const patch: any = { updatedAt: new Date(), updatedBy: (req as any).authUser?.id ?? null };
    if (typeof req.body?.name === "string") {
      const n = req.body.name.trim();
      if (!n) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
      patch.name = n;
    }
    if (req.body?.bundle) patch.bundle = sanitizeBundle(req.body.bundle) as any;
    if (typeof req.body?.color === "string" || req.body?.color === null) patch.color = req.body.color;

    // Handle is_default toggle: ensure at most one default per company.
    if (typeof req.body?.isDefault === "boolean") {
      patch.isDefault = req.body.isDefault;
      if (req.body.isDefault) {
        await db.update(invoiceFieldPolicyProfilesTable)
          .set({ isDefault: false })
          .where(and(
            eq(invoiceFieldPolicyProfilesTable.companyId, cid),
            eq(invoiceFieldPolicyProfilesTable.isDefault, true),
          ));
      }
    }

    const [updated] = await db.update(invoiceFieldPolicyProfilesTable)
      .set(patch)
      .where(and(
        eq(invoiceFieldPolicyProfilesTable.id, id),
        eq(invoiceFieldPolicyProfilesTable.companyId, cid),
      ))
      .returning();

    if (!updated) { res.status(404).json({ error: "غير موجود" }); return; }
    res.json({ profile: { ...updated, bundle: sanitizeBundle(updated.bundle as any) } });
  } catch (e: any) {
    if (String(e?.message ?? "").includes("unique") || e?.code === "23505") {
      res.status(409).json({ error: "اسم القالب مستخدم بالفعل" });
      return;
    }
    req.log?.error?.({ err: e }, "PUT /profiles/:id failed");
    res.status(500).json({ error: e?.message ?? "internal error" });
  }
});

router.delete("/profiles/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!isSuperadmin(req)) { res.status(403).json({ error: "صلاحية السوبر أدمن فقط" }); return; }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صحيح" }); return; }

    const r = await db.delete(invoiceFieldPolicyProfilesTable)
      .where(and(
        eq(invoiceFieldPolicyProfilesTable.id, id),
        eq(invoiceFieldPolicyProfilesTable.companyId, cid),
      )).returning({ id: invoiceFieldPolicyProfilesTable.id });
    if (!r.length) { res.status(404).json({ error: "غير موجود" }); return; }
    res.json({ ok: true });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "DELETE /profiles/:id failed");
    res.status(500).json({ error: e?.message ?? "internal error" });
  }
});

// ── /assignments ────────────────────────────────────────────────────────
// Returns every user in the company together with their assigned profileId
// (or null) — admin uses this to bulk-assign.
router.get("/assignments", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!isSuperadmin(req)) { res.status(403).json({ error: "صلاحية السوبر أدمن فقط" }); return; }

    const users = await db.select({
      id: usersTable.id,
      username: usersTable.username,
      email: usersTable.email,
      role: usersTable.role,
      nameAr: usersTable.nameAr,
      nameEn: usersTable.nameEn,
    }).from(usersTable).where(eq(usersTable.companyId, cid));

    const userIds = users.map((u) => u.id);
    let assignments: { userId: number; profileId: number }[] = [];
    if (userIds.length) {
      assignments = await db.select({
        userId: userInvoiceFieldPoliciesTable.userId,
        profileId: userInvoiceFieldPoliciesTable.profileId,
      }).from(userInvoiceFieldPoliciesTable)
        .where(inArray(userInvoiceFieldPoliciesTable.userId, userIds));
    }
    const m = new Map(assignments.map((a) => [a.userId, a.profileId]));

    res.json({
      users: users.map((u) => ({
        ...u,
        profileId: m.get(u.id) ?? null,
      })),
    });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /assignments failed");
    res.status(500).json({ error: e?.message ?? "internal error" });
  }
});

router.put("/assignments/:userId", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!isSuperadmin(req)) { res.status(403).json({ error: "صلاحية السوبر أدمن فقط" }); return; }
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) { res.status(400).json({ error: "userId غير صحيح" }); return; }

    // Verify the target user belongs to the same company.
    const [target] = await db.select({ id: usersTable.id, companyId: usersTable.companyId })
      .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!target || target.companyId !== cid) {
      res.status(404).json({ error: "المستخدم غير موجود في هذه الشركة" });
      return;
    }

    const profileId = req.body?.profileId;
    const assignedBy = (req as any).authUser?.id ?? null;

    if (profileId === null || profileId === undefined) {
      await db.delete(userInvoiceFieldPoliciesTable)
        .where(eq(userInvoiceFieldPoliciesTable.userId, userId));
      res.json({ ok: true, profileId: null });
      return;
    }

    const pid = Number(profileId);
    if (!Number.isFinite(pid)) { res.status(400).json({ error: "profileId غير صحيح" }); return; }

    // Verify profile belongs to the same company.
    const [profile] = await db.select({ id: invoiceFieldPolicyProfilesTable.id })
      .from(invoiceFieldPolicyProfilesTable)
      .where(and(
        eq(invoiceFieldPolicyProfilesTable.id, pid),
        eq(invoiceFieldPolicyProfilesTable.companyId, cid),
      )).limit(1);
    if (!profile) { res.status(404).json({ error: "القالب غير موجود" }); return; }

    // Upsert
    const existing = await db.select({ userId: userInvoiceFieldPoliciesTable.userId })
      .from(userInvoiceFieldPoliciesTable)
      .where(eq(userInvoiceFieldPoliciesTable.userId, userId)).limit(1);
    if (existing.length) {
      await db.update(userInvoiceFieldPoliciesTable)
        .set({ profileId: pid, assignedAt: new Date(), assignedBy })
        .where(eq(userInvoiceFieldPoliciesTable.userId, userId));
    } else {
      await db.insert(userInvoiceFieldPoliciesTable).values({
        userId, profileId: pid, assignedBy,
      });
    }

    res.json({ ok: true, profileId: pid });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "PUT /assignments/:userId failed");
    res.status(500).json({ error: e?.message ?? "internal error" });
  }
});

// ── /suggest (AI) ───────────────────────────────────────────────────────
// Returns a suggested bundle for a single profile, based on the company's
// industry. Admin clicks "اقتراح ذكي" while editing a profile.
router.post("/suggest", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!isSuperadmin(req)) { res.status(403).json({ error: "صلاحية السوبر أدمن فقط" }); return; }

    const role = String(req.body?.role ?? "كاشير").slice(0, 80);

    const [company] = await db.select({
      nameAr: companiesTable.nameAr,
      nameEn: companiesTable.nameEn,
      industryName: companiesTable.industryName,
    }).from(companiesTable).where(eq(companiesTable.id, cid)).limit(1);

    const industryName = company?.industryName ?? "غير محدد";

    const baseHint: PolicyBundle = defaultBundle();
    baseHint.sales.date = { mode: "required", dateConstraint: "today_only" };
    baseHint.sales.exchangeRate = { mode: "hidden" };
    baseHint.sales.costCenter = { mode: "hidden" };
    baseHint.sales.docNumber = { mode: "readonly" };
    baseHint.purchase.date = { mode: "required", dateConstraint: "today_only" };
    baseHint.purchase.exchangeRate = { mode: "hidden" };
    baseHint.purchase.costCenter = { mode: "hidden" };
    baseHint.pos.date = { mode: "required", dateConstraint: "today_only" };

    const apiKey  = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
    const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || undefined;

    if (!apiKey) {
      res.json({ source: "fallback", reason: "AI not configured", bundle: baseHint });
      return;
    }

    const prompt = `أنت خبير محاسبي. اقترح أذونات حقول الفواتير لقالب صلاحيات اسمه "${role}".
الشركة: ${company?.nameAr ?? company?.nameEn ?? "—"} — النشاط: ${industryName}.
لكل حقل اختر mode من: editable | readonly | hidden | required.
لحقول التاريخ أضف dateConstraint من: none | today_only.

ارجع JSON فقط:
{ "sales": {...}, "purchase": {...}, "pos": {...} }

الحقول المتاحة:
- sales: ${FIELD_CATALOGUE.sales.map((f) => f.key).join(", ")}
- purchase: ${FIELD_CATALOGUE.purchase.map((f) => f.key).join(", ")}
- pos: ${FIELD_CATALOGUE.pos.map((f) => f.key).join(", ")}

مبادئ:
- الكاشير/المحاسب المبتدئ: اقفل التاريخ today_only، أخفِ مركز التكلفة وسعر الصرف، اجعل العميل/المورد إلزامياً، اجعل رقم الفاتورة readonly.
- المحاسب المتقدم: editable لمعظم الحقول.
- مدير الفرع: شبيه بالمحاسب المتقدم لكن مع dateConstraint=none.`;

    let aiBundle: PolicyBundle | null = null;
    try {
      const client = new Anthropic({ apiKey, baseURL });
      const msg = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });
      const text = (msg.content?.[0] as any)?.text ?? "";
      const m = text.match(/\{[\s\S]*\}/);
      if (m) aiBundle = sanitizeBundle(JSON.parse(m[0]));
    } catch (e) {
      req.log?.warn?.({ err: e }, "AI suggest failed; using fallback");
    }

    res.json({ source: aiBundle ? "ai" : "fallback", bundle: aiBundle ?? baseHint });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "POST /suggest failed");
    res.status(500).json({ error: e?.message ?? "internal error" });
  }
});

export default router;
