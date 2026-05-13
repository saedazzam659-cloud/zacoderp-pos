// /api/invoice-field-policies
//
// Per-company "what-fields-show-on-invoice-screens" governance for non-admin
// users. Admins/superadmins author the policy here; every authenticated user
// reads /me to find out which fields are hidden / readonly / required for
// them on Sales / Purchase / POS invoice screens.

import { Router } from "express";
import { eq, and } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import {
  db,
  invoiceFieldPoliciesTable,
  POLICY_SCOPES,
  defaultPolicy,
  companiesTable,
  type PolicyScope,
  type PolicyMap,
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
function isAdmin(req: any): boolean {
  const role = req.authUser?.role;
  return role === "admin" || role === "superadmin";
}

function isScope(s: any): s is PolicyScope {
  return POLICY_SCOPES.includes(s);
}

/** Sanitize an incoming policy to our known fields + valid modes. */
function sanitizePolicy(scope: PolicyScope, raw: any): PolicyMap {
  const validModes = new Set(["editable", "readonly", "hidden", "required"]);
  const validDate  = new Set(["none", "today_only"]);
  const allowedKeys = new Set(FIELD_CATALOGUE[scope].map((f) => f.key));
  const dateKeys    = new Set(FIELD_CATALOGUE[scope].filter((f) => f.isDate).map((f) => f.key));

  const out: PolicyMap = {};
  if (!raw || typeof raw !== "object") return defaultPolicy(scope);
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
  // Fill in any missing fields with defaults so the response is always complete.
  for (const f of FIELD_CATALOGUE[scope]) {
    if (!out[f.key]) {
      out[f.key] = { mode: "editable", ...(f.isDate ? { dateConstraint: "none" as const } : {}) };
    }
  }
  return out;
}

// GET /me  ─────────────────────────────────────────────────────────────────
// Returns the effective policy bundle for ALL scopes for the current user.
// Admins always get an "all editable" bundle (the screens skip the policy
// for them anyway, but returning defaults keeps the client logic uniform).
router.get("/me", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }

    const bundle: Record<PolicyScope, PolicyMap> = {
      sales:    defaultPolicy("sales"),
      purchase: defaultPolicy("purchase"),
      pos:      defaultPolicy("pos"),
    };

    if (isAdmin(req)) {
      res.json({ isAdmin: true, bundle });
      return;
    }

    const rows = await db.select().from(invoiceFieldPoliciesTable)
      .where(eq(invoiceFieldPoliciesTable.companyId, cid));

    for (const row of rows) {
      if (isScope(row.scope)) {
        bundle[row.scope] = sanitizePolicy(row.scope, row.policy as any);
      }
    }
    res.json({ isAdmin: false, bundle });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /invoice-field-policies/me failed");
    res.status(500).json({ error: e?.message ?? "internal error" });
  }
});

// GET /  ───────────────────────────────────────────────────────────────────
// Admin-only: full bundle (same shape as /me but always real values, never
// the admin bypass).
router.get("/", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!isAdmin(req)) { res.status(403).json({ error: "للمشرفين فقط" }); return; }

    const rows = await db.select().from(invoiceFieldPoliciesTable)
      .where(eq(invoiceFieldPoliciesTable.companyId, cid));

    const bundle: Record<PolicyScope, PolicyMap> = {
      sales:    defaultPolicy("sales"),
      purchase: defaultPolicy("purchase"),
      pos:      defaultPolicy("pos"),
    };
    for (const row of rows) {
      if (isScope(row.scope)) bundle[row.scope] = sanitizePolicy(row.scope, row.policy as any);
    }
    res.json({ bundle, catalogue: FIELD_CATALOGUE });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "GET /invoice-field-policies failed");
    res.status(500).json({ error: e?.message ?? "internal error" });
  }
});

// PUT /:scope  ─────────────────────────────────────────────────────────────
router.put("/:scope", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!isAdmin(req)) { res.status(403).json({ error: "للمشرفين فقط" }); return; }

    const scope = req.params.scope as PolicyScope;
    if (!isScope(scope)) { res.status(400).json({ error: "scope غير صحيح" }); return; }

    const cleaned = sanitizePolicy(scope, req.body?.policy);
    const updatedBy = (req as any).authUser?.id ?? null;

    // Upsert by (companyId, scope).
    const existing = await db.select({ id: invoiceFieldPoliciesTable.id })
      .from(invoiceFieldPoliciesTable)
      .where(and(
        eq(invoiceFieldPoliciesTable.companyId, cid),
        eq(invoiceFieldPoliciesTable.scope, scope),
      )).limit(1);

    if (existing[0]) {
      await db.update(invoiceFieldPoliciesTable)
        .set({ policy: cleaned as any, updatedAt: new Date(), updatedBy })
        .where(eq(invoiceFieldPoliciesTable.id, existing[0].id));
    } else {
      await db.insert(invoiceFieldPoliciesTable).values({
        companyId: cid, scope, policy: cleaned as any, updatedBy,
      });
    }

    res.json({ ok: true, scope, policy: cleaned });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "PUT /invoice-field-policies failed");
    res.status(500).json({ error: e?.message ?? "internal error" });
  }
});

// POST /suggest  ───────────────────────────────────────────────────────────
// AI: ask Claude to propose a sensible policy bundle for THIS company based
// on its industry / activity. Falls back to a hand-tuned default when the
// AI integration isn't configured so the button never returns an error.
router.post("/suggest", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!isAdmin(req)) { res.status(403).json({ error: "للمشرفين فقط" }); return; }

    const [company] = await db.select({
      nameAr: companiesTable.nameAr,
      nameEn: companiesTable.nameEn,
      industryName: companiesTable.industryName,
    }).from(companiesTable).where(eq(companiesTable.id, cid)).limit(1);

    const industryName = company?.industryName ?? "غير محدد";

    const baseHint: Record<PolicyScope, PolicyMap> = {
      sales:    defaultPolicy("sales"),
      purchase: defaultPolicy("purchase"),
      pos:      defaultPolicy("pos"),
    };
    // Hand-tuned default: lock down dates, hide cost-center & exchange rate
    // for non-admins, mark notes optional. Used as the fallback AND as the
    // seed prompt for Claude.
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

    const prompt = `أنت خبير محاسبي تساعد مدير شركة على ضبط أذونات حقول الفواتير للمستخدمين العاديين (الكاشير/المحاسب المبتدئ).
بيانات الشركة: ${company?.nameAr ?? company?.nameEn ?? "—"} — النشاط: ${industryName}.

لكل حقل اختر mode من: editable | readonly | hidden | required.
لحقول التاريخ (date) أضف dateConstraint من: none | today_only.

ارجع JSON فقط بهذا الشكل:
{
  "sales": { "date": {"mode":"required","dateConstraint":"today_only"}, ... },
  "purchase": { ... },
  "pos": { ... }
}

الحقول المتاحة:
- sales: ${FIELD_CATALOGUE.sales.map((f) => f.key).join(", ")}
- purchase: ${FIELD_CATALOGUE.purchase.map((f) => f.key).join(", ")}
- pos: ${FIELD_CATALOGUE.pos.map((f) => f.key).join(", ")}

مبادئ توجيهية:
- اقفل تاريخ الفاتورة على اليوم الحالي (today_only) ما لم يكن نشاط الشركة يحتاج تواريخ تاريخية (مكاتب محاسبة).
- أخفِ سعر الصرف ومركز التكلفة عن المستخدم العادي ما لم يكن النشاط متعدد العملات/الفروع.
- اجعل العميل/المورد إلزامياً.
- في POS لا تُظهر مركز التكلفة أو سعر الصرف.
- اجعل رقم الفاتورة readonly (يولّد تلقائياً).`;

    let aiBundle: Record<PolicyScope, PolicyMap> | null = null;
    try {
      const client = new Anthropic({ apiKey, baseURL });
      const msg = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });
      const text = (msg.content?.[0] as any)?.text ?? "";
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        aiBundle = {
          sales:    sanitizePolicy("sales",    parsed.sales),
          purchase: sanitizePolicy("purchase", parsed.purchase),
          pos:      sanitizePolicy("pos",      parsed.pos),
        };
      }
    } catch (e) {
      req.log?.warn?.({ err: e }, "AI suggest failed; using fallback");
    }

    res.json({
      source: aiBundle ? "ai" : "fallback",
      bundle: aiBundle ?? baseHint,
    });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "POST /invoice-field-policies/suggest failed");
    res.status(500).json({ error: e?.message ?? "internal error" });
  }
});

export default router;
