import { Router } from "express";
import { db } from "@workspace/db";
import { accountingMappingsTable, accountsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const DOCUMENT_TYPE_ROLES: Record<string, string[]> = {
  purchase_invoice:      ["inventory", "vat_input", "payable", "discount"],
  purchase_return:       ["inventory", "vat_input", "payable", "discount"],
  supplier_settlement:   ["payable", "cash", "bank", "discount"],
  sales_invoice:         ["receivable", "revenue", "vat_output", "cogs", "inventory"],
  sales_return:          ["receivable", "revenue_return", "vat_output", "cogs", "inventory"],
  customer_settlement:   ["receivable", "cash", "bank", "discount"],
  warehouse:             ["inventory", "opening_balance"],
  warehouse_adjustment:  ["inventory", "adjustment_gain", "adjustment_loss"],
  warehouse_transfer:    ["inventory_source", "inventory_destination", "transfer_cost"],
  cashbox:               ["cash_on_hand"],
  bank:                  ["bank_main", "bank_fees"],
};

const isValidRole = (dt: string, rk: string) =>
  Array.isArray(DOCUMENT_TYPE_ROLES[dt]) && DOCUMENT_TYPE_ROLES[dt]!.includes(rk);

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

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

router.put("/bulk", async (req, res) => {
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

router.post("/ai-suggest", async (req, res) => {
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

    const OPENAI_BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    const OPENAI_KEY  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    if (!OPENAI_BASE || !OPENAI_KEY) {
      res.status(500).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" });
      return;
    }

    const accountList = dbAccounts.slice(0, 300).map(a =>
      `- id=${a.id} | ${a.code} | ${a.nameAr} | type=${a.accountType}${a.isPosting === false ? " | (غير ترحيلي)" : ""}`
    ).join("\n");

    const prompt = `أنت خبير محاسبة سعودي متخصص في نظام ZATCA.
مطلوب ربط حساب محاسبي (من شجرة الحسابات الحالية) للدور التالي:

نوع المستند: ${documentType}
الدور: ${roleKey} — ${roleLabel}
الوصف: ${roleDescription}

شجرة الحسابات المتاحة:
${accountList}

أرجع JSON فقط بالشكل:
{"accountId": <رقم id من القائمة أو null>, "reasoning": "<شرح مختصر بالعربية>"}
اختر حساباً ترحيلياً (isPosting != غير ترحيلي) فقط. إذا لا يوجد حساب مناسب أعد accountId=null.`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    let aiRes: Response;
    try {
      aiRes = await fetch(`${OPENAI_BASE.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "أنت مساعد محاسبي. أعد JSON صالحاً فقط بدون أي نص إضافي." },
            { role: "user", content: prompt },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        }),
        signal: ctrl.signal,
      });
    } catch (e: any) {
      clearTimeout(timer);
      const msg = e?.name === "AbortError" ? "انتهت مهلة الذكاء الاصطناعي" : "تعذّر الاتصال بالذكاء الاصطناعي";
      res.status(502).json({ error: msg });
      return;
    }
    clearTimeout(timer);

    if (!aiRes.ok) {
      res.status(502).json({ error: "فشل الاتصال بالذكاء الاصطناعي" });
      return;
    }
    const data = await aiRes.json() as any;
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(content); } catch {}
    const suggestedId = parsed.accountId ? Number(parsed.accountId) : null;
    const valid = suggestedId && dbAccounts.some(a => a.id === suggestedId);
    res.json({
      accountId: valid ? suggestedId : null,
      reasoning: String(parsed.reasoning || "").slice(0, 1000),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
