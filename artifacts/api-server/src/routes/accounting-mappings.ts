import { Router } from "express";
import { db } from "@workspace/db";
import { accountingMappingsTable, accountsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit } from "../middleware/permissions.js";
import { ensureLeafAccounts } from "../lib/leafAccount.js";
import { seedDefaultAccountingMappings } from "../lib/accountingMappings.js";
import { chat as aiChat, isAIAvailable } from "../lib/aiClient.js";
import { requireAiFeature, logAiUsage } from "../middleware/requireAiFeature.js";

const DOCUMENT_TYPE_ROLES: Record<string, string[]> = {
  purchase_invoice:      ["inventory", "vat_input", "payable", "discount"],
  purchase_return:       ["inventory", "vat_input", "payable", "discount"],
  supplier_settlement:   ["payable", "cash", "bank", "discount"],
  sales_invoice:         ["receivable", "revenue", "vat_output", "cogs", "inventory", "discount"],
  pos_invoice:           ["cash", "bank", "receivable", "revenue", "vat_output", "cogs", "inventory", "discount"],
  sales_return:          ["receivable", "revenue_return", "vat_output", "cogs", "inventory", "discount"],
  customer_settlement:   ["receivable", "cash", "bank", "discount"],
  warehouse:             ["inventory", "opening_balance"],
  warehouse_adjustment:  ["inventory", "adjustment_gain", "adjustment_loss"],
  warehouse_transfer:    ["inventory_source", "inventory_destination", "transfer_cost"],
  cashbox:               ["cash_on_hand"],
  bank:                  ["bank_main", "bank_fees"],
  letter_of_credit:      ["lc_margin", "lc_liability", "lc_commission", "lc_expenses", "lc_fx_diff", "inventory", "bank"],
  entity_account_parents: ["cash_account_parent", "bank_account_parent", "customer_account_parent", "warehouse_account_parent", "supplier_account_parent"],
};

// Default LC chart-of-accounts seed used by /seed-lc
const LC_SEED_ACCOUNTS: Array<{
  code: string;
  nameAr: string;
  nameEn: string;
  accountType: "asset" | "liability" | "equity" | "revenue" | "expense";
  roleKey: string;
}> = [
  { code: "1150", nameAr: "هامش الاعتماد المستندي", nameEn: "Letter of Credit Margin", accountType: "asset",     roleKey: "lc_margin" },
  { code: "2150", nameAr: "الاعتمادات المستندية المفتوحة", nameEn: "Open Letters of Credit", accountType: "liability", roleKey: "lc_liability" },
  { code: "5830", nameAr: "عمولة فتح الاعتماد المستندي", nameEn: "LC Opening Commission", accountType: "expense",   roleKey: "lc_commission" },
  { code: "5835", nameAr: "مصاريف الاعتماد المستندي", nameEn: "LC Expenses (Shipping/Insurance/Customs)", accountType: "expense", roleKey: "lc_expenses" },
  { code: "5840", nameAr: "فروق عملة الاعتماد المستندي", nameEn: "LC FX Differences", accountType: "expense", roleKey: "lc_fx_diff" },
];

const isValidRole = (dt: string, rk: string) =>
  Array.isArray(DOCUMENT_TYPE_ROLES[dt]) && DOCUMENT_TYPE_ROLES[dt]!.includes(rk);

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});
router.use(moduleAudit("accounting_mappings"));

// Mutations + AI calls require admin/superadmin. Reads are allowed for any
// authenticated user of the same company (resolveCompanyId already enforces
// tenant scoping). This blocks regular employees from rewriting accounting
// links or burning AI cost.
function requireAdmin(req: any, res: any, next: any) {
  const role = req.authUser?.role;
  if (role === "superadmin" || role === "admin") { next(); return; }
  res.status(403).json({ error: "صلاحيات غير كافية — مطلوب مدير" });
}

router.get("/", async (req, res) => {
  try {
    const raw = req.query.companyId ? Number(req.query.companyId) : undefined;
    const companyId = resolveCompanyId(req, raw);
    if (!companyId) { res.json([]); return; }
    const rows = await db.select().from(accountingMappingsTable)
      .where(eq(accountingMappingsTable.companyId, companyId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/bulk", requireAdmin, async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length > 500) { res.status(400).json({ error: "كمية عناصر كبيرة" }); return; }

    type Cleaned = { documentType: string; roleKey: string; accountId: number | null; isLocked: boolean };
    const cleaned: Cleaned[] = [];
    const accountIdsToCheck = new Set<number>();

    for (const it of items) {
      const documentType = String(it.documentType || "").trim();
      const roleKey = String(it.roleKey || "").trim();
      if (!documentType || !roleKey) continue;
      if (!isValidRole(documentType, roleKey)) {
        res.status(400).json({ error: `نوع مستند/دور غير مدعوم: ${documentType}.${roleKey}` });
        return;
      }
      const accountId = it.accountId ? Number(it.accountId) : null;
      if (accountId) accountIdsToCheck.add(accountId);
      cleaned.push({ documentType, roleKey, accountId, isLocked: !!it.isLocked });
    }

    if (accountIdsToCheck.size) {
      const accs = await db.select().from(accountsTable)
        .where(inArray(accountsTable.id, Array.from(accountIdsToCheck)));
      const validIds = new Set(accs.filter(a => a.companyId === companyId).map(a => a.id));
      for (const id of accountIdsToCheck) {
        if (!validIds.has(id)) {
          res.status(400).json({ error: `الحساب ${id} غير صالح للشركة` });
          return;
        }
      }
      try {
        await ensureLeafAccounts(companyId, Array.from(accountIdsToCheck));
      } catch (err: any) {
        res.status(400).json({ error: err?.message ?? "حساب رئيسي غير مسموح" });
        return;
      }
    }

    await db.transaction(async (tx) => {
      for (const c of cleaned) {
        await tx.insert(accountingMappingsTable).values({
          companyId, documentType: c.documentType, roleKey: c.roleKey,
          accountId: c.accountId, isLocked: c.isLocked,
        }).onConflictDoUpdate({
          target: [
            accountingMappingsTable.companyId,
            accountingMappingsTable.documentType,
            accountingMappingsTable.roleKey,
          ],
          set: { accountId: c.accountId, isLocked: c.isLocked, updatedAt: new Date() },
        });
      }
    });

    const rows = await db.select().from(accountingMappingsTable)
      .where(eq(accountingMappingsTable.companyId, companyId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Seed default LC chart-of-accounts and map them to the letter_of_credit document type.
// Idempotent: accounts with matching code are reused; mappings are upserted.
router.post("/seed-lc", requireAdmin, async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body?.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }

    const existing = await db.select().from(accountsTable)
      .where(eq(accountsTable.companyId, companyId));
    const byCode = new Map(existing.map(a => [a.code, a]));

    const created: Array<{ code: string; nameAr: string; id: number }> = [];
    const reused: Array<{ code: string; nameAr: string; id: number }> = [];
    const roleToAccountId: Record<string, number> = {};

    for (const seed of LC_SEED_ACCOUNTS) {
      const hit = byCode.get(seed.code);
      if (hit) {
        roleToAccountId[seed.roleKey] = hit.id;
        reused.push({ code: hit.code, nameAr: hit.nameAr, id: hit.id });
        continue;
      }
      const [inserted] = await db.insert(accountsTable).values({
        companyId,
        parentId: null,
        code: seed.code,
        nameAr: seed.nameAr,
        nameEn: seed.nameEn,
        accountType: seed.accountType as any,
        level: 1,
        isPosting: true,
        isActive: true,
      }).returning();
      roleToAccountId[seed.roleKey] = inserted.id;
      created.push({ code: inserted.code, nameAr: inserted.nameAr, id: inserted.id });
    }

    // Auto-map the seeded LC accounts; leave `inventory` and `bank` roles untouched so the user picks them.
    await db.transaction(async (tx) => {
      for (const [roleKey, accountId] of Object.entries(roleToAccountId)) {
        await tx.insert(accountingMappingsTable).values({
          companyId, documentType: "letter_of_credit", roleKey, accountId, isLocked: false,
        }).onConflictDoUpdate({
          target: [
            accountingMappingsTable.companyId,
            accountingMappingsTable.documentType,
            accountingMappingsTable.roleKey,
          ],
          // Preserve any existing mapping the user already set.
          set: { updatedAt: new Date() },
        });
      }
    });

    res.json({ created, reused, mapped: Object.keys(roleToAccountId).length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /seed-defaults — apply the canonical mapping template (purchase /
// sales / settlements / warehouse / cashbox / bank / LC).  Pass
// `{ overwrite: true }` to forcibly relink rows that already point at a
// different account; locked rows are NEVER touched.  Auto-runs after a
// COA bulk-import too — see seedDefaultAccountingMappings doc for details.
router.post("/seed-defaults", requireAdmin, async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body?.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const overwrite = req.body?.overwrite === true;
    const result = await seedDefaultAccountingMappings(companyId, { overwrite });
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/ai-suggest", requireAdmin, requireAiFeature("account_suggestions"), async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }

    const documentType = String(req.body?.documentType || "").slice(0, 64);
    const roleKey = String(req.body?.roleKey || "").slice(0, 64);
    const roleLabel = String(req.body?.roleLabel || "").slice(0, 200);
    const roleDescription = String(req.body?.roleDescription || "").slice(0, 500);
    if (!documentType || !roleKey || !isValidRole(documentType, roleKey)) {
      res.status(400).json({ error: "documentType/roleKey غير صالحين" });
      return;
    }

    const dbAccounts = await db.select().from(accountsTable)
      .where(and(eq(accountsTable.companyId, companyId), eq(accountsTable.isActive, true)));
    if (!dbAccounts.length) {
      res.json({ accountId: null, reasoning: "لا توجد حسابات نشطة." });
      return;
    }

    if (!isAIAvailable()) {
      await logAiUsage(req, { status: "error", meta: { reason: "ai-not-configured" } });
      res.status(500).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" });
      return;
    }

    const accountList = dbAccounts.slice(0, 400).map(a =>
      `- id=${a.id} | ${a.code} | ${a.nameAr} | type=${a.accountType}${a.isPosting === false ? " | (غير ترحيلي/أب)" : ""}`
    ).join("\n");

    const prompt = `أنت خبير محاسبة سعودي متخصص في نظام ZATCA والدليل المحاسبي السعودي.
مطلوب ربط حساب محاسبي للدور التالي:

نوع المستند: ${documentType}
الدور: ${roleKey} — ${roleLabel}
الوصف: ${roleDescription}

شجرة الحسابات الحالية:
${accountList}

القاعدة:
1) إن وُجد حساب ترحيلي مناسب تماماً، أعد accountId برقمه.
2) إن لم يوجد، اقترح إنشاء حساب جديد عبر الحقل create، واختر أب مناسب من القائمة (حساب غير ترحيلي من نفس النوع).

أرجع JSON فقط بالشكل:
{
  "accountId": <رقم id موجود أو null>,
  "create": {"code": "<كود 4-6 أرقام>", "nameAr": "<اسم عربي واضح>", "accountType": "<asset|liability|equity|revenue|expense>", "parentId": <id حساب أب موجود أو null>} أو null,
  "reasoning": "<شرح مختصر بالعربية>"
}
لا تعد create إن كنت تعد accountId بقيمة صالحة.`;

    const result = await aiChat([
        { role: "system", content: "أنت مساعد محاسبي. أعد JSON صالحاً فقط بدون أي نص إضافي." },
        { role: "user", content: prompt },
      ], { json: true,
      maxTokens: 1024,
      timeoutMs: 20_000,
      providers: ["gemini"] });
    if (!result.ok) {
      await logAiUsage(req, { status: "error", meta: { reason: result.reason } });
      res.status(502).json({ error: "فشل الاتصال بالذكاء الاصطناعي: " + result.reason });
      return;
    }
    const parsed: any = result.data ?? {};
    await logAiUsage(req, { status: "allowed", provider: result.provider });

    const suggestedId = parsed.accountId ? Number(parsed.accountId) : null;
    const existingAcc = suggestedId ? dbAccounts.find(a => a.id === suggestedId) : null;
    const reasoning = String(parsed.reasoning || "").slice(0, 1000);

    if (existingAcc && existingAcc.isPosting !== false) {
      res.json({ accountId: existingAcc.id, created: false, reasoning });
      return;
    }

    const createSpec = parsed.create && typeof parsed.create === "object" ? parsed.create : null;
    if (createSpec) {
      const validTypes = ["asset","liability","equity","revenue","expense"] as const;
      const accountType = validTypes.includes(createSpec.accountType) ? createSpec.accountType : null;
      let code = String(createSpec.code || "").trim().slice(0, 32);
      const nameAr = String(createSpec.nameAr || "").trim().slice(0, 200);
      const parentIdRaw = createSpec.parentId ? Number(createSpec.parentId) : null;
      const parent = parentIdRaw ? dbAccounts.find(a => a.id === parentIdRaw) : null;

      if (accountType && nameAr && code) {
        // Ensure unique code per company
        const existingCodes = new Set(dbAccounts.map(a => a.code));
        if (existingCodes.has(code)) {
          let i = 1;
          while (existingCodes.has(`${code}${i}`)) i++;
          code = `${code}${i}`;
        }
        const level = parent ? (parent.level ?? 1) + 1 : 1;
        try {
          const [inserted] = await db.insert(accountsTable).values({
            companyId,
            parentId: parent?.id ?? null,
            code,
            nameAr,
            accountType: accountType as any,
            level,
            isPosting: true,
            isActive: true,
          }).returning();
          // Flip parent to non-posting (branch)
          if (parent && parent.isPosting) {
            await db.update(accountsTable)
              .set({ isPosting: false, updatedAt: new Date() })
              .where(eq(accountsTable.id, parent.id));
          }
          res.json({
            accountId: inserted.id,
            created: true,
            createdAccount: { id: inserted.id, code: inserted.code, nameAr: inserted.nameAr, accountType: inserted.accountType },
            reasoning,
          });
          return;
        } catch (err: any) {
          res.json({ accountId: null, created: false, reasoning: `${reasoning} (تعذّر إنشاء الحساب: ${err?.message ?? "خطأ"})` });
          return;
        }
      }
    }

    res.json({ accountId: null, created: false, reasoning });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
