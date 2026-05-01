import { Router } from "express";
import { db } from "@workspace/db";
import {
  accountsTable, warehousesTable, customersTable, suppliersTable,
  productionOrdersTable, productionOrderItemsTable, productionEventsTable,
  productionResourcesTable,
  securityEventMediaTable,
} from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission, requireModulePermission } from "../middleware/permissions.js";

const router = Router();

// All AI endpoints require authentication (prevents anonymous abuse of AI credits)
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

const OPENAI_BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const OPENAI_KEY  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

router.post("/parse-stock-count", async (req, res) => {
  try {
    if (!OPENAI_BASE || !OPENAI_KEY) {
      res.status(500).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" });
      return;
    }
    const { rows } = req.body as { rows: any[][] };
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: "لا توجد بيانات في الملف" });
      return;
    }

    const sample = rows.slice(0, 200);
    const userPrompt = `لديك بيانات من ملف Excel للجرد المخزني. كل صف عبارة عن مصفوفة قيم. استخرج لكل صف يحتوي على بيانات صنف:
- code: كود الصنف (إن وجد، رقم/نص)
- name: اسم الصنف
- qty: الكمية الفعلية الموجودة (رقم)
- barcode: الباركود (إن وجد)

تجاهل صفوف العناوين، المجاميع، والملاحظات الفارغة. أعد JSON فقط بهذا الشكل:
{ "items": [ { "code": "...", "name": "...", "qty": 0, "barcode": "..." }, ... ] }

البيانات:
${JSON.stringify(sample)}`;

    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 8192,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "أنت مساعد متخصص في تحويل بيانات Excel للمخزون إلى JSON منظم. ترد بـ JSON فقط بدون أي شرح." },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(500).json({ error: `فشل استدعاء الذكاء الاصطناعي: ${r.status} ${txt.slice(0, 200)}` });
      return;
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any;
    try { parsed = JSON.parse(content); }
    catch { res.status(500).json({ error: "تعذّر تحليل استجابة الذكاء الاصطناعي" }); return; }

    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    res.json({ items });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Suggest item-card fields from partial context.
// Body: {
//   nameAr?, nameEn?, code?, costPrice?, salePrice?, vatRate?, itemType?,
//   description?, barcode?, group?, unit?,
//   availableGroups?: string[], availableUnits?: string[]
// }
// Returns: {
//   nameAr, nameEn, description, tags: string[],
//   suggestedSalePrice, suggestedMargin, suggestedVatRate,
//   suggestedGroup, suggestedUnit, suggestedItemType, reasoning
// }
// ═══════════════════════════════════════════════════════════════════
router.post("/suggest-item-fields", requireModulePermission("items"), async (req, res) => {
  try {
    if (!OPENAI_BASE || !OPENAI_KEY) {
      res.status(500).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" });
      return;
    }
    // Truncate every user-controlled string to bound prompt size and prevent abuse.
    const clip = (v: any, max: number): string =>
      typeof v === "string" ? v.slice(0, max) : (v === undefined || v === null ? "" : String(v).slice(0, max));
    const ctx = {
      nameAr:      clip(req.body?.nameAr,      200),
      nameEn:      clip(req.body?.nameEn,      200),
      code:        clip(req.body?.code,         60),
      costPrice:   clip(req.body?.costPrice,    32),
      salePrice:   clip(req.body?.salePrice,    32),
      vatRate:     clip(req.body?.vatRate,      16),
      itemType:    clip(req.body?.itemType,     16),
      description: clip(req.body?.description, 500),
      barcode:     clip(req.body?.barcode,      80),
      group:       clip(req.body?.group,       120),
      unit:        clip(req.body?.unit,         60),
    };
    const has = (v: string) => v.trim() !== "" && v !== "0";
    if (!has(ctx.nameAr) && !has(ctx.nameEn) && !has(ctx.code) && !has(ctx.barcode) && !has(ctx.description)) {
      res.status(400).json({ error: "أدخل اسم الصنف أو وصفه أولاً قبل طلب اقتراحات الذكاء الاصطناعي" });
      return;
    }

    const cost = Number(ctx.costPrice || 0);
    const trimList = (arr: any): string[] =>
      Array.isArray(arr) ? arr.map(x => clip(x, 120)).filter(Boolean).slice(0, 60) : [];
    const availableGroups: string[] = trimList(req.body?.availableGroups);
    const availableUnits:  string[] = trimList(req.body?.availableUnits);

    const userPrompt = `أنت مساعد لإثراء بطاقة صنف في نظام محاسبي سعودي (متوافق مع زاتكا، الضريبة الافتراضية 15%).
البيانات الحالية المدخلة:
- الاسم بالعربية: ${ctx.nameAr || "(فارغ)"}
- الاسم بالإنجليزية: ${ctx.nameEn || "(فارغ)"}
- الكود: ${ctx.code || "(فارغ)"}
- الباركود: ${ctx.barcode || "(فارغ)"}
- نوع الصنف: ${ctx.itemType || "(غير محدد)"} (stock أو service)
- المجموعة الحالية: ${ctx.group || "(غير محددة)"}
- الوحدة الحالية: ${ctx.unit || "(غير محددة)"}
- سعر التكلفة: ${cost}
- سعر البيع الحالي: ${ctx.salePrice || "(فارغ)"}
- نسبة الضريبة الحالية: ${ctx.vatRate || "(فارغ)"}
- الوصف الحالي: ${ctx.description || "(فارغ)"}

المجموعات المتاحة في النظام (اختر منها فقط إذا كانت مناسبة، وإلا أعد null):
${availableGroups.length ? availableGroups.map(g => `- ${g}`).join("\n") : "(لا توجد)"}

الوحدات المتاحة في النظام (اختر منها فقط إذا كانت مناسبة، وإلا أعد null):
${availableUnits.length ? availableUnits.map(u => `- ${u}`).join("\n") : "(لا توجد)"}

المطلوب: أعد JSON فقط بهذا الشكل بالضبط (لا تكتب أي شرح خارج JSON):
{
  "nameAr": "اسم احترافي بالعربية (اقترح فقط إذا كان الحالي فارغاً أو يحتاج تحسين، وإلا أعد سلسلة فارغة)",
  "nameEn": "Professional English name (suggest only if current is empty or needs improvement, otherwise empty string)",
  "description": "وصف تسويقي قصير بالعربية (1-2 جملة) يصف الصنف ومميزاته",
  "tags": ["كلمة1", "كلمة2", "..."],
  "suggestedSalePrice": رقم أو null (سعر بيع مقترح بناءً على التكلفة وهامش ربح معقول لهذه الفئة من المنتجات. إذا كانت التكلفة صفر أعد null),
  "suggestedMargin": رقم بين 0 و 100 أو null (نسبة هامش الربح المقترحة %),
  "suggestedVatRate": 15 أو 0 (15 للسلع/الخدمات الخاضعة للضريبة، 0 للمعفاة كالأدوية والتعليم والتصدير),
  "suggestedGroup": "اسم مجموعة من القائمة أعلاه" أو null,
  "suggestedUnit": "اسم وحدة من القائمة أعلاه" أو null,
  "suggestedItemType": "stock" أو "service",
  "reasoning": "جملة قصيرة بالعربية تشرح المنطق وراء الاقتراحات"
}`;

    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 8192,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "أنت مساعد متخصص في إثراء بيانات الأصناف في الأنظمة المحاسبية السعودية. ترد بـ JSON فقط بدون أي شرح." },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(500).json({ error: `فشل استدعاء الذكاء الاصطناعي: ${r.status} ${txt.slice(0, 200)}` });
      return;
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any;
    try { parsed = JSON.parse(content); }
    catch { res.status(500).json({ error: "تعذّر تحليل استجابة الذكاء الاصطناعي" }); return; }

    const num = (v: any): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const str = (v: any, max = 500): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const arr = (v: any): string[] =>
      Array.isArray(v) ? v.map(x => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 12) : [];
    // Only echo back group/unit if AI picked one that actually exists in the user's list (case-insensitive).
    const pickFromList = (v: any, list: string[]): string | null => {
      const s = str(v, 120);
      if (!s) return null;
      const lower = s.toLowerCase();
      const found = list.find(x => x.toLowerCase() === lower);
      return found ?? null;
    };
    const sanitVat = (v: any): number | null => {
      const n = num(v);
      if (n === null) return null;
      // VAT is a percentage in [0, 100]; KSA uses 0 or 15 in practice.
      if (n < 0 || n > 100) return null;
      return n;
    };

    res.json({
      nameAr:             str(parsed.nameAr, 200),
      nameEn:             str(parsed.nameEn, 200),
      description:        str(parsed.description, 500),
      tags:               arr(parsed.tags),
      suggestedSalePrice: num(parsed.suggestedSalePrice),
      suggestedMargin:    num(parsed.suggestedMargin),
      suggestedVatRate:   sanitVat(parsed.suggestedVatRate),
      suggestedGroup:     pickFromList(parsed.suggestedGroup, availableGroups),
      suggestedUnit:      pickFromList(parsed.suggestedUnit, availableUnits),
      suggestedItemType:  parsed.suggestedItemType === "service" ? "service" : (parsed.suggestedItemType === "stock" ? "stock" : null),
      reasoning:          str(parsed.reasoning, 500),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Explain a ZATCA rejection in plain Arabic + suggest concrete fixes.
// Body: { invoice: {docNumber, totalAmount, vatAmount, status, customer:{...}, lines:[...]}, errors: [{code, message}] }
// Returns: { explanation, fixes: string[], summary }
// Falls back to a deterministic rule-based response if AI is not configured.
// ═══════════════════════════════════════════════════════════════════
router.post("/explain-zatca-rejection", async (req, res) => {
  try {
    const { invoice, errors } = req.body as {
      invoice: any;
      errors: { code: string; message: string }[];
    };
    if (!Array.isArray(errors) || errors.length === 0) {
      res.status(400).json({ error: "لا توجد أخطاء لتحليلها" });
      return;
    }

    // Deterministic fallback (used when AI isn't configured)
    const fallback = () => {
      const fixesByCode: Record<string, string> = {
        "BR-KSA-DRAFT":     "افتح الفاتورة واضغط على زر 'ترحيل' لتحويلها من مسودة إلى مرحّلة، ثم أعد الإرسال.",
        "BR-KSA-LINES":     "أضف بنداً واحداً على الأقل بالكمية والسعر، ثم احفظ الفاتورة وأعد الإرسال.",
        "BR-KSA-AMOUNT":    "تأكد من أن الكميات والأسعار في البنود أكبر من صفر بحيث يكون الإجمالي > 0.",
        "BR-KSA-VAT-CALC":  "أعد حساب الضريبة على كل بند بحيث تكون 15% من قيمة البند بعد الخصم. تحقق من أن جميع البنود تستخدم نسبة ضريبة موحّدة.",
        "BR-KSA-CUSTOMER":  "اربط الفاتورة بعميل من قائمة العملاء (الفواتير الكبيرة تحتاج لعميل ضريبي).",
        "BR-KSA-CUST-VAT":  "افتح بطاقة العميل وصحّح الرقم الضريبي ليكون 15 رقماً يبدأ وينتهي بالرقم 3 (مثال: 300000000000003).",
        "BR-KSA-CUST-ADDR": "افتح بطاقة العميل وأكمل: المدينة، الشارع، رقم المبنى (4 أرقام)، الرمز البريدي (5 أرقام). هذه حقول إلزامية لفاتورة B2B.",
      };
      const fixes = errors.map(e => fixesByCode[e.code] ?? `راجع البيان: ${e.message}`);
      const explanation = `رفضت هيئة الزكاة والضريبة والجمارك الفاتورة ${invoice?.docNumber ? `رقم ${invoice.docNumber}` : ""} لـ ${errors.length} سبب رئيسي. الأسباب موضّحة بالأسفل، وكل سبب مرتبط بخطوة تصحيح محددة.`;
      const summary = errors.map(e => `• ${e.message}`).join("\n");
      return { explanation, fixes, summary, source: "rules" as const };
    };

    if (!OPENAI_BASE || !OPENAI_KEY) {
      res.json(fallback());
      return;
    }

    const userPrompt = `أنت خبير في فاتورة الإلكترونية السعودية ZATCA (Phase 2). رُفِضت الفاتورة التالية:

بيانات الفاتورة:
${JSON.stringify({
  docNumber:     invoice?.docNumber,
  invoiceDate:   invoice?.invoiceDate,
  totalAmount:   invoice?.totalAmount,
  vatAmount:     invoice?.vatAmount,
  subtotal:      invoice?.subtotal,
  status:        invoice?.status,
  customer: invoice?.customer ? {
    nameAr:         invoice.customer.nameAr,
    vatNumber:      invoice.customer.vatNumber,
    city:           invoice.customer.city,
    street:         invoice.customer.street,
    buildingNumber: invoice.customer.buildingNumber,
    postalCode:     invoice.customer.postalCode,
  } : null,
}, null, 2)}

أخطاء ZATCA:
${errors.map((e, i) => `${i + 1}. [${e.code}] ${e.message}`).join("\n")}

اشرح للمحاسب بلغة عربية مبسّطة وصريحة:
1. سبب الرفض الجوهري (جملة أو جملتين).
2. خطوات التصحيح كقائمة عملية واضحة (كل خطوة في سطر).
3. ملخّص نهائي قصير.

أعد JSON فقط بهذا الشكل:
{ "explanation": "...", "fixes": ["خطوة 1", "خطوة 2", ...], "summary": "..." }`;

    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 1500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "أنت خبير محاسب متخصص في الفاتورة الإلكترونية السعودية (ZATCA Phase 2 / e-invoicing). ترد دائماً بـ JSON صالح فقط بدون أي شرح خارجي. اللغة العربية الفصحى المبسّطة." },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!r.ok) {
      // graceful degradation
      res.json(fallback());
      return;
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any;
    try { parsed = JSON.parse(content); } catch { res.json(fallback()); return; }

    res.json({
      explanation: String(parsed?.explanation || "").trim() || fallback().explanation,
      fixes: Array.isArray(parsed?.fixes) ? parsed.fixes.map(String) : fallback().fixes,
      summary: String(parsed?.summary || "").trim() || fallback().summary,
      source: "ai" as const,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Suggest source/destination inventory accounts for a stock transfer.
// Body: { fromWarehouseId, toWarehouseId, items?: [{nameAr, qty}], notes? }
// Returns: { fromAccountId, fromAccountLabel, toAccountId, toAccountLabel, reasoning, source }
// Always picks from the company's existing chart of accounts (asset/posting only).
// Falls back to warehouse.accountId or first inventory-keyword asset account if AI unavailable.
// ═══════════════════════════════════════════════════════════════════
router.post("/suggest-transfer-accounts", async (req, res) => {
  try {
    const cid = resolveCompanyId(req as any);
    if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const { fromWarehouseId, toWarehouseId, items = [], notes = "" } = req.body || {};
    if (!fromWarehouseId || !toWarehouseId) {
      res.status(400).json({ error: "يجب تحديد المخزن المصدر والمخزن الوجهة" }); return;
    }

    const [fromWh] = await db.select().from(warehousesTable)
      .where(and(eq(warehousesTable.id, Number(fromWarehouseId)), eq(warehousesTable.companyId, cid)));
    const [toWh]   = await db.select().from(warehousesTable)
      .where(and(eq(warehousesTable.id, Number(toWarehouseId)),   eq(warehousesTable.companyId, cid)));
    if (!fromWh || !toWh) { res.status(404).json({ error: "المخزن غير موجود" }); return; }

    const accounts = await db.select({
      id: accountsTable.id, code: accountsTable.code,
      nameAr: accountsTable.nameAr, nameEn: accountsTable.nameEn,
      accountType: accountsTable.accountType, isPosting: accountsTable.isPosting,
    }).from(accountsTable)
      .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.isActive, true)));

    const assetPosting = accounts.filter(a => a.accountType === "asset" && a.isPosting);
    const findByKeywords = (kw: string[]): typeof accounts[0] | undefined =>
      assetPosting.find(a => {
        const t = `${a.nameAr ?? ""} ${a.nameEn ?? ""} ${a.code ?? ""}`.toLowerCase();
        return kw.some(k => t.includes(k.toLowerCase()));
      });

    const buildFallback = () => {
      const fromAcc =
        (fromWh.accountId && accounts.find(a => a.id === fromWh.accountId)) ||
        findByKeywords([fromWh.nameAr ?? "", fromWh.code ?? ""]) ||
        findByKeywords(["مخزون", "بضاعة", "inventory", "stock"]) ||
        assetPosting[0];
      const toAcc =
        (toWh.accountId && accounts.find(a => a.id === toWh.accountId)) ||
        findByKeywords([toWh.nameAr ?? "", toWh.code ?? ""]) ||
        (fromAcc ? assetPosting.find(a => a.id !== fromAcc.id) : assetPosting[0]) ||
        assetPosting[0];
      const label = (a: any) => a ? `${a.code} - ${a.nameAr}` : "";
      return {
        fromAccountId:    fromAcc?.id ?? null,
        fromAccountLabel: label(fromAcc),
        toAccountId:      toAcc?.id ?? null,
        toAccountLabel:   label(toAcc),
        reasoning: fromAcc && toAcc
          ? `تم اختيار حساب «${label(fromAcc)}» للمخزن المصدر و«${label(toAcc)}» للمخزن الوجهة بناءً على الحسابات المرتبطة بالمخازن أو أقرب حسابات المخزون في دليل الحسابات.`
          : "لم يتم العثور على حسابات مخزون مناسبة في دليل الحسابات. الرجاء إنشاء حسابات أصول من نوع مخزون أولاً.",
        source: "rules" as const,
      };
    };

    if (!OPENAI_BASE || !OPENAI_KEY || assetPosting.length === 0) {
      res.json(buildFallback());
      return;
    }

    // Wrap AI call in its own try/catch so any network/runtime error gracefully degrades to rule-based fallback.
    try {

    const accountsList = assetPosting.map(a =>
      `{ "id": ${a.id}, "code": "${a.code}", "name": "${a.nameAr}${a.nameEn ? " / " + a.nameEn : ""}" }`
    ).join(",\n");
    const itemsSummary = Array.isArray(items) && items.length
      ? items.slice(0, 20).map((it: any) => `- ${it.nameAr || it.name || "صنف"} × ${it.qty || 0}`).join("\n")
      : "لا توجد بنود مفصّلة";

    const userPrompt = `أنت محاسب سعودي خبير. اختر من دليل الحسابات أدناه الحسابين الأنسب لقيد التحويل المخزني التالي:
- المخزن المصدر: ${fromWh.code} - ${fromWh.nameAr}${fromWh.city ? " (" + fromWh.city + ")" : ""}
- المخزن الوجهة: ${toWh.code} - ${toWh.nameAr}${toWh.city ? " (" + toWh.city + ")" : ""}
- ملاحظات التحويل: ${notes || "بدون"}
- أهم الأصناف:
${itemsSummary}

دليل الحسابات المتاح (أصول، حسابات ترحيل فقط):
[${accountsList}]

قواعد:
1. اختر "fromAccountId" = حساب المخزون المرتبط بالمخزن المصدر (سيتم دائنه).
2. اختر "toAccountId"   = حساب المخزون المرتبط بالمخزن الوجهة (سيتم مدينه).
3. يجب أن يكونا مختلفين إن أمكن.
4. أعِد فقط معرفات (id) موجودة في القائمة أعلاه. لا تخترع أرقاماً.

أعد JSON فقط:
{ "fromAccountId": <id>, "toAccountId": <id>, "reasoning": "شرح موجز بالعربية" }`;

    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "أنت محاسب سعودي. ترد بـ JSON صالح فقط." },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!r.ok) { res.json(buildFallback()); return; }
    const data = await r.json();
    let parsed: any;
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}"); }
    catch { res.json(buildFallback()); return; }

    const fromId = Number(parsed?.fromAccountId);
    const toId   = Number(parsed?.toAccountId);
    const fromAcc = assetPosting.find(a => a.id === fromId);
    const toAcc   = assetPosting.find(a => a.id === toId);
    if (!fromAcc || !toAcc) { res.json(buildFallback()); return; }
    res.json({
      fromAccountId: fromAcc.id,
      fromAccountLabel: `${fromAcc.code} - ${fromAcc.nameAr}`,
      toAccountId: toAcc.id,
      toAccountLabel: `${toAcc.code} - ${toAcc.nameAr}`,
      reasoning: String(parsed?.reasoning || "").trim() || "اقتراح تلقائي.",
      source: "ai" as const,
    });
    } catch {
      // Any runtime exception during AI call → graceful fallback
      res.json(buildFallback());
      return;
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Suggest accounts for a Stock Adjustment.
// Picks (a) inventory account = warehouse-side asset, (b) adjustment account = expense (loss) or income (gain).
// Falls back to deterministic rule-based picks when AI unavailable or any runtime error.
router.post("/suggest-adjustment-accounts", async (req, res) => {
  try {
    const cid = resolveCompanyId(req as any);
    if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const { warehouseId, reason = "", items = [], notes = "", direction = "auto" } = req.body || {};
    if (!warehouseId) { res.status(400).json({ error: "يجب تحديد المخزن" }); return; }

    const [wh] = await db.select().from(warehousesTable)
      .where(and(eq(warehousesTable.id, Number(warehouseId)), eq(warehousesTable.companyId, cid)));
    if (!wh) { res.status(404).json({ error: "المخزن غير موجود" }); return; }

    const accounts = await db.select({
      id: accountsTable.id, code: accountsTable.code,
      nameAr: accountsTable.nameAr, nameEn: accountsTable.nameEn,
      accountType: accountsTable.accountType, isPosting: accountsTable.isPosting,
    }).from(accountsTable)
      .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.isActive, true)));

    const assetPosting   = accounts.filter(a => a.accountType === "asset"    && a.isPosting);
    const expensePosting = accounts.filter(a => a.accountType === "expense"  && a.isPosting);
    const incomePosting  = accounts.filter(a => (a.accountType === "revenue" || a.accountType === "income") && a.isPosting);

    // Net direction from items: + means net increase (gain) → income; - means net decrease (loss) → expense
    const netQty = (Array.isArray(items) ? items : []).reduce((s: number, it: any) => s + Number(it.qty || 0), 0);
    const dir: "increase" | "decrease" =
      direction === "increase" ? "increase" :
      direction === "decrease" ? "decrease" :
      (netQty >= 0 ? "increase" : "decrease");

    const findByKeywords = (pool: typeof accounts, kw: string[]) =>
      pool.find(a => {
        const t = `${a.nameAr ?? ""} ${a.nameEn ?? ""} ${a.code ?? ""}`.toLowerCase();
        return kw.some(k => t.includes(k.toLowerCase()));
      });

    const reasonLower = `${reason} ${notes}`.toLowerCase();
    const isShrinkage = /(تالف|كسر|فاقد|عجز|تلف|خسار|shrink|damage|loss)/i.test(reasonLower);
    const isSurplus   = /(فائض|زياد|هبة|مكاف|surplus|gain)/i.test(reasonLower);

    const buildFallback = () => {
      const invAcc =
        (wh.accountId && accounts.find(a => a.id === wh.accountId)) ||
        findByKeywords(assetPosting, [wh.nameAr ?? "", wh.code ?? ""]) ||
        findByKeywords(assetPosting, ["مخزون", "بضاعة", "inventory", "stock"]) ||
        assetPosting[0];

      // Pick the contra account based on direction & reason hints.
      let adjPool = dir === "increase" ? incomePosting : expensePosting;
      if (isShrinkage) adjPool = expensePosting;
      if (isSurplus)   adjPool = incomePosting;

      const adjKw = isShrinkage
        ? ["تالف", "كسر", "فاقد", "عجز", "خسار", "shrinkage", "loss", "damage"]
        : isSurplus
        ? ["فائض", "زياد", "هبة", "مكاف", "surplus", "gain"]
        : (dir === "increase" ? ["فائض", "زياد", "إيراد", "income", "gain"] : ["تسوي", "خسار", "expense", "loss"]);

      const adjAcc =
        findByKeywords(adjPool, adjKw) ||
        findByKeywords(adjPool, ["تسوي", "adjust"]) ||
        adjPool[0] ||
        // Last resort — any expense (or any income) account
        (dir === "increase" ? incomePosting[0] : expensePosting[0]);

      const label = (a: any) => a ? `${a.code} - ${a.nameAr}` : "";
      return {
        inventoryAccountId:    invAcc?.id ?? null,
        inventoryAccountLabel: label(invAcc),
        adjustmentAccountId:    adjAcc?.id ?? null,
        adjustmentAccountLabel: label(adjAcc),
        direction: dir,
        reasoning: invAcc && adjAcc
          ? `تم اختيار حساب «${label(invAcc)}» للمخزون و«${label(adjAcc)}» كحساب تسوية ${dir === "increase" ? "للفائض" : "للنقص/التالف"} بناءً على المخزن وسبب التسوية.`
          : "لم يتم العثور على حسابات مناسبة. الرجاء إنشاء حسابات أصول (مخزون) ومصروفات/إيرادات (تسويات) أولاً.",
        source: "rules" as const,
      };
    };

    if (!OPENAI_BASE || !OPENAI_KEY || assetPosting.length === 0 || (expensePosting.length === 0 && incomePosting.length === 0)) {
      res.json(buildFallback());
      return;
    }

    try {
      const fmtList = (pool: typeof accounts) => pool.map(a =>
        `{ "id": ${a.id}, "code": "${a.code}", "name": "${a.nameAr}${a.nameEn ? " / " + a.nameEn : ""}", "type": "${a.accountType}" }`
      ).join(",\n");
      const candidates = [...assetPosting, ...expensePosting, ...incomePosting];
      const itemsSummary = Array.isArray(items) && items.length
        ? items.slice(0, 20).map((it: any) => `- ${it.nameAr || it.name || "صنف"} × ${it.qty || 0}`).join("\n")
        : "لا توجد بنود مفصّلة";

      const userPrompt = `أنت محاسب سعودي خبير. اختر الحسابين الأنسب لقيد تسوية مخزنية:
- المخزن: ${wh.code} - ${wh.nameAr}${wh.city ? " (" + wh.city + ")" : ""}
- سبب التسوية: ${reason || "—"}
- ملاحظات: ${notes || "—"}
- اتجاه التسوية الإجمالي: ${dir === "increase" ? "زيادة (فائض)" : "نقص (عجز/تالف)"}
- بنود التسوية:
${itemsSummary}

دليل الحسابات (ترحيل فقط) — أصول + مصروفات + إيرادات:
[${fmtList(candidates)}]

قواعد:
1. inventoryAccountId = حساب أصل (مخزون) — يفضّل المرتبط بالمخزن.
2. adjustmentAccountId = حساب مصروف إن كان عجز/تالف، أو حساب إيراد إن كان فائض/هبة.
3. يجب أن يكونا مختلفين، ومن القائمة فقط (لا تخترع IDs).
4. أعد فقط ID موجود في القائمة.

أعد JSON فقط:
{ "inventoryAccountId": <id>, "adjustmentAccountId": <id>, "reasoning": "شرح موجز بالعربية" }`;

      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 800,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "أنت محاسب سعودي. ترد بـ JSON صالح فقط." },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (!r.ok) { res.json(buildFallback()); return; }
      const data = await r.json();
      let parsed: any;
      try { parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}"); }
      catch { res.json(buildFallback()); return; }

      const invId = Number(parsed?.inventoryAccountId);
      const adjId = Number(parsed?.adjustmentAccountId);
      const invAcc = assetPosting.find(a => a.id === invId);
      const adjAcc = [...expensePosting, ...incomePosting].find(a => a.id === adjId);
      if (!invAcc || !adjAcc) { res.json(buildFallback()); return; }
      res.json({
        inventoryAccountId: invAcc.id,
        inventoryAccountLabel: `${invAcc.code} - ${invAcc.nameAr}`,
        adjustmentAccountId: adjAcc.id,
        adjustmentAccountLabel: `${adjAcc.code} - ${adjAcc.nameAr}`,
        direction: dir,
        reasoning: String(parsed?.reasoning || "").trim() || "اقتراح تلقائي.",
        source: "ai" as const,
      });
    } catch {
      res.json(buildFallback());
      return;
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Suggest counterparty account for a Receipt Voucher (سند قبض).
// The DR side is auto-resolved from cashbox/bank. AI picks the CR
// (counterparty) account based on entity, description, refType.
// Falls back to: linked customer/supplier account → keyword match → revenue.
router.post("/suggest-receipt-account", async (req, res) => {
  try {
    const cid = resolveCompanyId(req as any);
    if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const { entityType = "customer", entityId, entityName = "", description = "", refType = "", refNumber = "", notes = "", amount = 0 } = req.body || {};

    const accounts = await db.select({
      id: accountsTable.id, code: accountsTable.code,
      nameAr: accountsTable.nameAr, nameEn: accountsTable.nameEn,
      accountType: accountsTable.accountType, isPosting: accountsTable.isPosting,
    }).from(accountsTable)
      .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.isActive, true)));

    const posting = accounts.filter(a => a.isPosting);
    const byType = (t: string) => posting.filter(a => a.accountType === t);
    const assetPosting     = byType("asset");
    const liabilityPosting = byType("liability");
    const revenuePosting   = posting.filter(a => a.accountType === "revenue" || a.accountType === "income");

    // Pre-fetch linked entity account (customer AR / supplier AP).
    let linkedAccountId: number | null = null;
    let linkedLabel = "";
    if (entityType === "customer" && entityId) {
      const [c] = await db.select().from(customersTable)
        .where(and(eq(customersTable.id, Number(entityId)), eq(customersTable.companyId, cid)));
      if (c?.accountId) {
        linkedAccountId = c.accountId;
        linkedLabel = `حساب العميل ${c.nameAr ?? ""}`.trim();
      }
    } else if (entityType === "supplier" && entityId) {
      const [s] = await db.select().from(suppliersTable)
        .where(and(eq(suppliersTable.id, Number(entityId)), eq(suppliersTable.companyId, cid)));
      if (s?.accountId) {
        linkedAccountId = s.accountId;
        linkedLabel = `حساب المورد ${s.nameAr ?? ""}`.trim();
      }
    }

    const findByKeywords = (pool: typeof accounts, kw: string[]) =>
      pool.find(a => {
        const t = `${a.nameAr ?? ""} ${a.nameEn ?? ""} ${a.code ?? ""}`.toLowerCase();
        return kw.some(k => k && t.includes(k.toLowerCase()));
      });

    const ctx = `${description} ${refType} ${refNumber} ${notes} ${entityName}`.toLowerCase();
    const isAdvance = /(دفع.?مقدم|advance|عربون|سلفة|deposit|عهدة)/i.test(ctx);
    const isLoan    = /(قرض|تمويل|loan)/i.test(ctx);
    const isCashSale= /(بيع.?نقد|نقد.?بيع|cash sale|مبيع)/i.test(ctx) && entityType !== "supplier";

    const buildFallback = () => {
      let acc: any = null;
      let why = "";

      if (linkedAccountId) {
        acc = accounts.find(a => a.id === linkedAccountId);
        why = `استخدام الحساب المرتبط مباشرةً بـ ${entityType === "customer" ? "العميل" : "المورد"}.`;
      } else if (isAdvance) {
        acc = findByKeywords(liabilityPosting, ["دفعات مقدمة", "دفع مقدم", "عربون", "advance", "deposit"])
              || findByKeywords(liabilityPosting, ["دائن", "ذمم"])
              || liabilityPosting[0];
        why = "تم اختيار حساب التزام (دفعات مقدمة) لأن السند يبدو تحصيلاً مقدّماً.";
      } else if (isLoan) {
        acc = findByKeywords(liabilityPosting, ["قرض", "تمويل", "loan"]) || liabilityPosting[0];
        why = "تم اختيار حساب التزام (قروض) لأن السبب يشير إلى تمويل.";
      } else if (entityType === "customer") {
        acc = findByKeywords(assetPosting, ["ذمم مدينة", "عملاء", "receivable", "ذمم العملاء"])
              || (isCashSale ? (findByKeywords(revenuePosting, ["مبيعات", "إيراد", "sales", "revenue"]) || revenuePosting[0]) : null)
              || assetPosting[0];
        why = "تم اختيار حساب ذمم العملاء (أصل) كطرف مقابل لتحصيل من العميل.";
      } else if (entityType === "supplier") {
        acc = findByKeywords(liabilityPosting, ["ذمم دائنة", "موردين", "payable", "ذمم الموردين"]) || liabilityPosting[0];
        why = "تم اختيار حساب ذمم الموردين (التزام) لأن المبلغ مستلم من المورد (مرتجع/تسوية).";
      } else {
        acc = findByKeywords(revenuePosting, ["إيراد", "أخرى", "other", "miscellaneous", "متنوع"])
              || revenuePosting[0];
        why = "تم اختيار حساب إيرادات متنوعة لأن الجهة عامة (أخرى).";
      }

      const label = (a: any) => a ? `${a.code} - ${a.nameAr}` : "";
      return {
        accountId: acc?.id ?? null,
        accountLabel: label(acc),
        reasoning: acc
          ? (linkedLabel ? `${why} (${linkedLabel})` : why)
          : "لم يتم العثور على حساب مناسب. الرجاء إنشاء حساب ذمم/إيراد أولاً أو اختياره يدوياً.",
        source: "rules" as const,
      };
    };

    if (!OPENAI_BASE || !OPENAI_KEY || posting.length === 0) {
      res.json(buildFallback()); return;
    }

    try {
      const candidates = [...assetPosting, ...liabilityPosting, ...revenuePosting];
      const fmtList = candidates.map(a =>
        `{ "id": ${a.id}, "code": "${a.code}", "name": "${a.nameAr}${a.nameEn ? " / " + a.nameEn : ""}", "type": "${a.accountType}" }`
      ).join(",\n");

      const userPrompt = `أنت محاسب سعودي خبير. اختر الحساب المقابل الأنسب لسند قبض (تحصيل):
- نوع الجهة: ${entityType === "customer" ? "عميل" : entityType === "supplier" ? "مورّد" : "أخرى"}
- اسم الجهة: ${entityName || "—"}
- الحساب المرتبط بالجهة (إن وُجد): ${linkedLabel ? `(id=${linkedAccountId}) ${linkedLabel}` : "—"}
- المبلغ: ${amount}
- البيان: ${description || "—"}
- نوع المرجع / رقمه: ${refType || "—"} / ${refNumber || "—"}
- ملاحظات: ${notes || "—"}

دليل الحسابات (ترحيل فقط — أصول/التزامات/إيرادات):
[${fmtList}]

قواعد الاختيار:
1. السند المالي مدين النقدية/البنك ودائن الحساب الذي تختاره.
2. تحصيل من عميل عن فاتورة → ذمم مدينة (أصل).
3. تحصيل دفعة مقدمة/عربون → دفعات مقدمة (التزام).
4. تحصيل بيع نقدي مباشر → حساب إيراد مبيعات.
5. تحصيل من مورد (مرتجع/استرداد) → ذمم دائنة (التزام).
6. جهة أخرى → اقرب حساب إيراد متنوع/أخرى.
7. إن وُجد حساب مرتبط بالجهة، فضّله إلا إذا كان البيان يدل على شيء مختلف (مقدمة/قرض).
8. أعد فقط ID موجود في القائمة ولا تخترع.

أعد JSON فقط:
{ "accountId": <id>, "reasoning": "شرح موجز بالعربية" }`;

      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 600,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "أنت محاسب سعودي. ترد بـ JSON صالح فقط." },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (!r.ok) { res.json(buildFallback()); return; }
      const data = await r.json();
      let parsed: any;
      try { parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}"); }
      catch { res.json(buildFallback()); return; }

      const accId = Number(parsed?.accountId);
      const acc = candidates.find(a => a.id === accId);
      if (!acc) { res.json(buildFallback()); return; }
      res.json({
        accountId: acc.id,
        accountLabel: `${acc.code} - ${acc.nameAr}`,
        reasoning: String(parsed?.reasoning || "").trim() || "اقتراح تلقائي.",
        source: "ai" as const,
      });
    } catch {
      res.json(buildFallback());
      return;
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Suggest counterparty account for a Payment Voucher (سند صرف).
// The CR side is auto-resolved from cashbox/bank. AI picks the DR
// (counterparty) account based on entity, description, refType.
// Falls back to: linked supplier/customer account → keyword match → expense.
router.post("/suggest-payment-account", async (req, res) => {
  try {
    const cid = resolveCompanyId(req as any);
    if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const { entityType = "supplier", entityId, entityName = "", description = "", refType = "", refNumber = "", notes = "", amount = 0 } = req.body || {};

    const accounts = await db.select({
      id: accountsTable.id, code: accountsTable.code,
      nameAr: accountsTable.nameAr, nameEn: accountsTable.nameEn,
      accountType: accountsTable.accountType, isPosting: accountsTable.isPosting,
    }).from(accountsTable)
      .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.isActive, true)));

    const posting = accounts.filter(a => a.isPosting);
    const byType = (t: string) => posting.filter(a => a.accountType === t);
    const assetPosting     = byType("asset");
    const liabilityPosting = byType("liability");
    const expensePosting   = byType("expense");

    let linkedAccountId: number | null = null;
    let linkedLabel = "";
    if (entityType === "supplier" && entityId) {
      const [s] = await db.select().from(suppliersTable)
        .where(and(eq(suppliersTable.id, Number(entityId)), eq(suppliersTable.companyId, cid)));
      if (s?.accountId) { linkedAccountId = s.accountId; linkedLabel = `حساب المورد ${s.nameAr ?? ""}`.trim(); }
    } else if (entityType === "customer" && entityId) {
      const [c] = await db.select().from(customersTable)
        .where(and(eq(customersTable.id, Number(entityId)), eq(customersTable.companyId, cid)));
      if (c?.accountId) { linkedAccountId = c.accountId; linkedLabel = `حساب العميل ${c.nameAr ?? ""}`.trim(); }
    }

    const findByKeywords = (pool: typeof accounts, kw: string[]) =>
      pool.find(a => {
        const t = `${a.nameAr ?? ""} ${a.nameEn ?? ""} ${a.code ?? ""}`.toLowerCase();
        return kw.some(k => k && t.includes(k.toLowerCase()));
      });

    const ctx = `${description} ${refType} ${refNumber} ${notes} ${entityName}`.toLowerCase();
    const isAdvance  = /(دفع.?مقدم|advance|عربون|سلفة|deposit|عهدة)/i.test(ctx);
    const isLoan     = /(قرض|تمويل|loan|تسديد قرض|سداد قرض)/i.test(ctx);
    const isSalary   = /(راتب|رواتب|salary|payroll|أجر|أجور|wage)/i.test(ctx);
    const isRent     = /(إيجار|rent)/i.test(ctx);
    const isUtility  = /(كهرباء|ماء|اتصالات|هاتف|إنترنت|utility|electric|water|telecom|internet)/i.test(ctx);
    const isPurchase = /(فاتورة شراء|مشتريات|purchase|invoice)/i.test(ctx) && entityType === "supplier";
    const isCustomerRefund = /(مرتجع|استرداد|refund)/i.test(ctx) && entityType === "customer";

    const buildFallback = () => {
      let acc: any = null;
      let why = "";

      if (linkedAccountId && !isAdvance && !isSalary && !isRent && !isUtility) {
        acc = accounts.find(a => a.id === linkedAccountId);
        why = `استخدام الحساب المرتبط مباشرةً بـ ${entityType === "supplier" ? "المورد" : "العميل"}.`;
      } else if (isSalary) {
        acc = findByKeywords(expensePosting, ["راتب", "رواتب", "أجور", "salary", "payroll", "wage"]) || expensePosting[0];
        why = "تم اختيار حساب مصروف الرواتب/الأجور.";
      } else if (isRent) {
        acc = findByKeywords(expensePosting, ["إيجار", "rent"]) || expensePosting[0];
        why = "تم اختيار حساب مصروف الإيجارات.";
      } else if (isUtility) {
        acc = findByKeywords(expensePosting, ["كهرباء", "ماء", "اتصال", "هاتف", "إنترنت", "utility", "خدمات"]) || expensePosting[0];
        why = "تم اختيار حساب المصروفات الخدمية (كهرباء/ماء/اتصالات).";
      } else if (isLoan) {
        acc = findByKeywords(liabilityPosting, ["قرض", "تمويل", "loan"]) || liabilityPosting[0];
        why = "تم اختيار حساب التزام (قروض) لأن السبب يشير إلى سداد تمويل.";
      } else if (isAdvance && entityType === "supplier") {
        acc = findByKeywords(assetPosting, ["دفعات مقدمة", "دفع مقدم", "عربون", "advance", "deposit"])
              || findByKeywords(assetPosting, ["مقدم"])
              || assetPosting[0];
        why = "تم اختيار حساب أصل (دفعات مقدمة للموردين) لأن السند دفعة مقدمة.";
      } else if (isPurchase || entityType === "supplier") {
        acc = findByKeywords(liabilityPosting, ["ذمم دائنة", "موردين", "payable"]) || liabilityPosting[0];
        why = "تم اختيار حساب ذمم الموردين (التزام) لتسديد فاتورة/مستحق المورد.";
      } else if (isCustomerRefund || entityType === "customer") {
        acc = findByKeywords(assetPosting, ["ذمم مدينة", "عملاء", "receivable"]) || assetPosting[0];
        why = "تم اختيار حساب ذمم العملاء (أصل) لاسترداد مبلغ للعميل.";
      } else {
        acc = findByKeywords(expensePosting, ["متنوع", "أخرى", "miscellaneous", "other"])
              || expensePosting[0];
        why = "تم اختيار حساب مصروفات متنوعة لأن الجهة عامة (أخرى).";
      }

      const label = (a: any) => a ? `${a.code} - ${a.nameAr}` : "";
      return {
        accountId: acc?.id ?? null,
        accountLabel: label(acc),
        reasoning: acc
          ? (linkedLabel ? `${why} (${linkedLabel})` : why)
          : "لم يتم العثور على حساب مناسب. الرجاء إنشاء حساب ذمم/مصروف أولاً أو اختياره يدوياً.",
        source: "rules" as const,
      };
    };

    if (!OPENAI_BASE || !OPENAI_KEY || posting.length === 0) {
      res.json(buildFallback()); return;
    }

    try {
      const candidates = [...assetPosting, ...liabilityPosting, ...expensePosting];
      const fmtList = candidates.map(a =>
        `{ "id": ${a.id}, "code": "${a.code}", "name": "${a.nameAr}${a.nameEn ? " / " + a.nameEn : ""}", "type": "${a.accountType}" }`
      ).join(",\n");

      const userPrompt = `أنت محاسب سعودي خبير. اختر الحساب المقابل الأنسب لسند صرف (دفع/تسوية):
- نوع الجهة: ${entityType === "supplier" ? "مورّد" : entityType === "customer" ? "عميل" : "أخرى"}
- اسم الجهة: ${entityName || "—"}
- الحساب المرتبط بالجهة (إن وُجد): ${linkedLabel ? `(id=${linkedAccountId}) ${linkedLabel}` : "—"}
- المبلغ: ${amount}
- البيان: ${description || "—"}
- نوع المرجع / رقمه: ${refType || "—"} / ${refNumber || "—"}
- ملاحظات: ${notes || "—"}

دليل الحسابات (ترحيل فقط — أصول/التزامات/مصروفات):
[${fmtList}]

قواعد الاختيار:
1. السند المالي دائن النقدية/البنك ومدين الحساب الذي تختاره.
2. سداد فاتورة لمورد → ذمم دائنة - موردين (التزام).
3. دفعة مقدمة لمورد → دفعات مقدمة للموردين (أصل).
4. صرف رواتب/أجور → مصروف رواتب.
5. صرف إيجار → مصروف إيجار.
6. صرف خدمات (كهرباء/ماء/اتصالات) → المصروف الخدمي المناسب.
7. سداد قرض → حساب القرض (التزام).
8. استرداد لعميل (مرتجع) → ذمم مدينة - عملاء (أصل).
9. جهة أخرى/مصروف عام → أقرب حساب مصروف متنوع.
10. إن وُجد حساب مرتبط بالجهة، فضّله إلا إذا كان البيان يدل على غرض مختلف (راتب/إيجار/قرض/مقدمة).
11. أعد فقط ID موجود في القائمة ولا تخترع.

أعد JSON فقط:
{ "accountId": <id>, "reasoning": "شرح موجز بالعربية" }`;

      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 600,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "أنت محاسب سعودي. ترد بـ JSON صالح فقط." },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (!r.ok) { res.json(buildFallback()); return; }
      const data = await r.json();
      let parsed: any;
      try { parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}"); }
      catch { res.json(buildFallback()); return; }

      const accId = Number(parsed?.accountId);
      const acc = candidates.find(a => a.id === accId);
      if (!acc) { res.json(buildFallback()); return; }
      res.json({
        accountId: acc.id,
        accountLabel: `${acc.code} - ${acc.nameAr}`,
        reasoning: String(parsed?.reasoning || "").trim() || "اقتراح تلقائي.",
        source: "ai" as const,
      });
    } catch {
      res.json(buildFallback());
      return;
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// HR — AI helpers: parse Iqama/ID text, suggest contract terms, suggest leave policy
// ═══════════════════════════════════════════════════════════════════

router.post("/parse-employee-id", async (req, res) => {
  try {
    const { text } = req.body as { text?: string };
    if (!text || !String(text).trim()) {
      res.status(400).json({ error: "النص مطلوب" }); return;
    }

    function fallback() {
      const out: any = { source: "fallback" };
      const idMatch = String(text).match(/\b([12]\d{9})\b/);
      if (idMatch) {
        out.idNumber = idMatch[1];
        out.idType = idMatch[1].startsWith("1") ? "national" : "iqama";
      }
      const dateMatches = Array.from(String(text).matchAll(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})|(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/g));
      if (dateMatches.length) {
        const m = dateMatches[0];
        if (m[1]) out.iqamaExpiry = `${m[1]}-${String(m[2]).padStart(2,"0")}-${String(m[3]).padStart(2,"0")}`;
        else out.iqamaExpiry = `${m[6]}-${String(m[5]).padStart(2,"0")}-${String(m[4]).padStart(2,"0")}`;
      }
      const phone = String(text).match(/\b(?:\+?966|0)?5\d{8}\b/);
      if (phone) out.mobile = phone[0];
      return out;
    }

    if (!OPENAI_BASE || !OPENAI_KEY) { res.json(fallback()); return; }

    try {
      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 800,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "أنت مساعد لاستخراج بيانات الهوية/الإقامة السعودية من نص حر. ترد بـ JSON فقط." },
            { role: "user", content: `استخرج من النص التالي بيانات الموظف:
- nameAr: الاسم بالعربي
- nameEn: الاسم بالإنجليزي (إن وُجد)
- idType: "iqama" إن بدأ الرقم بـ 2، أو "national" إن بدأ بـ 1
- idNumber: رقم الهوية/الإقامة (10 أرقام)
- iqamaExpiry: تاريخ انتهاء الإقامة بصيغة YYYY-MM-DD
- nationality: الجنسية
- profession: المهنة
- sponsor: الكفيل
- mobile: رقم الجوال (إن وُجد)
- birthDate: تاريخ الميلاد بصيغة YYYY-MM-DD (إن وُجد)
- gender: "male" أو "female" (إن أمكن استنتاجه)

أعد JSON فقط بهذه المفاتيح، اترك الحقول غير المعروفة فارغة (لا تخترع).

النص:
${text}` },
          ],
        }),
      });
      if (!r.ok) { res.json(fallback()); return; }
      const data = await r.json();
      let parsed: any;
      try { parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}"); }
      catch { res.json(fallback()); return; }
      const allowed = ["nameAr","nameEn","idType","idNumber","iqamaExpiry","nationality","profession","sponsor","mobile","birthDate","gender"];
      const out: any = { source: "ai" };
      for (const k of allowed) if (parsed[k]) out[k] = parsed[k];
      res.json(out);
    } catch { res.json(fallback()); }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

router.post("/suggest-contract-terms", async (req, res) => {
  try {
    const { jobTitle, nationality, basicSalary, contractType } = req.body as any;
    const title = String(jobTitle || "").trim();
    const nat = String(nationality || "").trim();
    const cType = contractType === "unlimited" ? "غير محدد المدة" : "محدد المدة";

    function fallback() {
      const t = title.toLowerCase();
      const guess = (lo: number, hi: number) => Math.round((lo + hi) / 2);
      let basic = Number(basicSalary) > 0 ? Number(basicSalary) : guess(3000, 8000);
      if (/(محاسب|accountant)/i.test(t))                 basic = Number(basicSalary) || guess(5000, 9000);
      else if (/(مهندس|engineer)/i.test(t))              basic = Number(basicSalary) || guess(8000, 14000);
      else if (/(مدير|manager|director)/i.test(t))       basic = Number(basicSalary) || guess(12000, 20000);
      else if (/(مبيعات|sales|بائع)/i.test(t))           basic = Number(basicSalary) || guess(4000, 8000);
      else if (/(سائق|driver)/i.test(t))                 basic = Number(basicSalary) || guess(2500, 4000);
      else if (/(عامل|worker|labor)/i.test(t))           basic = Number(basicSalary) || guess(1500, 2500);
      else if (/(سكرتير|secretary|إداري)/i.test(t))      basic = Number(basicSalary) || guess(3500, 6000);
      else if (/(مطور|developer|programmer|مبرمج)/i.test(t)) basic = Number(basicSalary) || guess(9000, 16000);

      const housing = Math.round(basic * 0.25);
      const transport = Math.round(basic * 0.10);
      return {
        source: "fallback",
        basicSalary: basic,
        housingAllow: housing,
        transportAllow: transport,
        otherAllow: 0,
        workingHours: 8,
        probationDays: 90,
        noticePeriod: 60,
        vacationDays: 21,
        terms: `عقد عمل ${cType} وفق نظام العمل السعودي.
• ساعات العمل: 8 ساعات يومياً، 6 أيام أسبوعياً.
• فترة التجربة: 90 يوماً.
• فترة الإشعار للإنهاء: 60 يوماً.
• الإجازة السنوية: 21 يوماً مدفوعة الأجر.
• تأمين طبي وفق مستوى الشركة.
• تذكرة سفر سنوية للموظف غير السعودي.
• مكافأة نهاية الخدمة وفق المادة (84) من نظام العمل.`,
        reasoning: `تقدير مبدئي للوظيفة "${title}" بناءً على متوسط السوق السعودي.`,
      };
    }

    if (!OPENAI_BASE || !OPENAI_KEY) { res.json(fallback()); return; }

    try {
      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 1200,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "أنت خبير موارد بشرية في السوق السعودي ملمّ بنظام العمل السعودي. ترد بـ JSON صالح فقط." },
            { role: "user", content: `اقترح بنود عقد عمل لموظف:
- الوظيفة: ${title || "غير محددة"}
- الجنسية: ${nat || "غير محددة"}
- نوع العقد: ${cType}
- الراتب الأساسي المطلوب (إن وُجد): ${basicSalary || "اقترح أنت"}

أعد JSON فقط:
{
  "basicSalary": <رقم — متوسط السوق السعودي للوظيفة>,
  "housingAllow": <عادة 25% من الأساسي>,
  "transportAllow": <عادة 10% من الأساسي>,
  "otherAllow": <0 افتراضياً>,
  "workingHours": 8,
  "probationDays": 90,
  "noticePeriod": 60,
  "vacationDays": 21,
  "terms": "نص بنود العقد بالعربية وفق نظام العمل السعودي (نقاط مرقمة موجزة)",
  "reasoning": "شرح موجز بالعربية لأسباب التقدير"
}` },
          ],
        }),
      });
      if (!r.ok) { res.json(fallback()); return; }
      const data = await r.json();
      let parsed: any;
      try { parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}"); }
      catch { res.json(fallback()); return; }
      res.json({
        source: "ai",
        basicSalary: Number(parsed.basicSalary) || 0,
        housingAllow: Number(parsed.housingAllow) || 0,
        transportAllow: Number(parsed.transportAllow) || 0,
        otherAllow: Number(parsed.otherAllow) || 0,
        workingHours: Number(parsed.workingHours) || 8,
        probationDays: Number(parsed.probationDays) || 90,
        noticePeriod: Number(parsed.noticePeriod) || 60,
        vacationDays: Number(parsed.vacationDays) || 21,
        terms: String(parsed.terms || "").trim(),
        reasoning: String(parsed.reasoning || "").trim() || "اقتراح تلقائي.",
      });
    } catch { res.json(fallback()); }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

router.post("/suggest-leave-policy", async (req, res) => {
  try {
    const { reason, leaveType, days } = req.body as any;
    const r0 = String(reason || "").toLowerCase();

    function fallback() {
      let type = leaveType || "annual";
      let paid = true;
      let advice = "إجازة اعتيادية مدفوعة الأجر تُخصم من الرصيد السنوي (21 يوم).";
      if (/(مرض|مستشفى|sick|ill)/i.test(r0)) {
        type = "sick"; paid = true;
        advice = "إجازة مرضية: 30 يوم بأجر كامل + 60 يوم بـ75% + 30 يوم بدون أجر (المادة 117).";
      } else if (/(زواج|marriage)/i.test(r0)) {
        type = "marriage"; paid = true;
        advice = "إجازة زواج: 5 أيام مدفوعة الأجر (المادة 113).";
      } else if (/(وفا|عزاء|moarn|death)/i.test(r0)) {
        type = "bereavement"; paid = true;
        advice = "إجازة وفاة: 5 أيام مدفوعة الأجر للزوج/الأقارب من الدرجة الأولى (المادة 113).";
      } else if (/(ولادة|إنجاب|أبو|paternity)/i.test(r0)) {
        type = "paternity"; paid = true;
        advice = "إجازة ولادة (للأب): 3 أيام مدفوعة الأجر (المادة 113).";
      } else if (/(أمومة|maternity)/i.test(r0)) {
        type = "maternity"; paid = true;
        advice = "إجازة أمومة: 10 أسابيع (4 قبل الولادة + 6 بعدها) بأجر كامل (المادة 151).";
      } else if (/(حج|عمرة|hajj)/i.test(r0)) {
        type = "hajj"; paid = true;
        advice = "إجازة حج: حتى 15 يوم بأجر كامل مرة واحدة طوال الخدمة (المادة 114).";
      } else if (/(دراسة|امتحان|study|exam)/i.test(r0)) {
        type = "study"; paid = true;
        advice = "إجازة لأداء امتحان: تُخصم من الرصيد السنوي (المادة 115).";
      } else if (/(بدون|غير مدفوع|unpaid)/i.test(r0)) {
        type = "unpaid"; paid = false;
        advice = "إجازة بدون أجر بموافقة صاحب العمل، لا تُحتسب ضمن مدة الخدمة الفعلية.";
      }
      return { source: "fallback", leaveType: type, paid, advice };
    }

    if (!OPENAI_BASE || !OPENAI_KEY) { res.json(fallback()); return; }
    try {
      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 600,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "أنت خبير في نظام العمل السعودي. ترد بـ JSON صالح فقط." },
            { role: "user", content: `موظف يطلب إجازة:
- السبب: ${reason || "غير مذكور"}
- النوع المختار: ${leaveType || "غير محدد"}
- المدة (أيام): ${days || "غير محددة"}

اقترح:
- leaveType: نوع الإجازة المناسب من: annual, sick, marriage, bereavement, paternity, maternity, hajj, study, unpaid
- paid: true/false (هل مدفوعة الأجر؟)
- advice: نصيحة موجزة بالعربية تشمل المرجع من نظام العمل السعودي إن أمكن

أعد JSON فقط بهذه المفاتيح.` },
          ],
        }),
      });
      if (!r.ok) { res.json(fallback()); return; }
      const data = await r.json();
      let parsed: any;
      try { parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}"); }
      catch { res.json(fallback()); return; }
      res.json({
        source: "ai",
        leaveType: parsed.leaveType || "annual",
        paid: parsed.paid !== false,
        advice: String(parsed.advice || "").trim() || "—",
      });
    } catch { res.json(fallback()); }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// HR — parse natural-language attendance into structured records
router.post("/parse-attendance", async (req, res) => {
  try {
    const { text, employees, date, defaultCheckIn, defaultCheckOut } = req.body as any;
    if (!text || !Array.isArray(employees)) {
      res.status(400).json({ error: "النص وقائمة الموظفين مطلوبة" }); return;
    }
    const dCi = defaultCheckIn || "08:00";
    const dCo = defaultCheckOut || "17:00";

    // Helper: find employee by name/code fuzzy (Arabic-tolerant)
    function normalize(s: string) {
      return String(s || "")
        .replace(/[إأآا]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
        .replace(/[ًٌٍَُِّْـ]/g, "")
        .toLowerCase().trim();
    }
    function findEmp(token: string) {
      const t = normalize(token);
      if (!t) return null;
      // exact code first
      let hit = employees.find((e: any) => normalize(e.code) === t);
      if (hit) return hit;
      // exact name
      hit = employees.find((e: any) => normalize(e.nameAr) === t || normalize(e.nameEn) === t);
      if (hit) return hit;
      // contains
      hit = employees.find((e: any) => {
        const n = normalize(e.nameAr); return n && (n.includes(t) || t.includes(n));
      });
      if (hit) return hit;
      // first-name match
      const firstNames = employees.map((e: any) => ({ e, f: normalize(e.nameAr).split(" ")[0] }));
      hit = firstNames.find((x: any) => x.f && (x.f === t || x.f.includes(t) || t.includes(x.f)));
      return hit?.e || null;
    }

    function fallback() {
      // Heuristic parser for common Arabic patterns
      const lines = String(text).split(/\n|،|;/).map(s => s.trim()).filter(Boolean);
      const records: any[] = [];
      const handled = new Set<number>();
      let globalCi = dCi, globalCo = dCo;

      // Detect global time (e.g. "كل الموظفين 8 إلى 5")
      const globalMatch = String(text).match(/(\d{1,2})(?::(\d{2}))?\s*(?:الى|إلى|-|—|to)\s*(\d{1,2})(?::(\d{2}))?/);
      if (globalMatch && /كل|الجميع|all/i.test(text)) {
        globalCi = `${String(globalMatch[1]).padStart(2,"0")}:${globalMatch[2]||"00"}`;
        const ch = Number(globalMatch[3]);
        globalCo = `${String(ch < 7 ? ch + 12 : ch).padStart(2,"0")}:${globalMatch[4]||"00"}`;
      }

      for (const line of lines) {
        const lower = normalize(line);
        // Find employee in line
        let matchedEmp: any = null;
        for (const e of employees) {
          const n = normalize(e.nameAr);
          const f = n.split(" ")[0];
          if ((f && lower.includes(f)) || normalize(e.code) === lower) { matchedEmp = e; break; }
        }
        if (!matchedEmp) continue;

        let status = "present";
        let ci = globalCi, co = globalCo, notes = "";

        if (/غاي?ب|غياب|absent/i.test(lower)) { status = "absent"; ci = ""; co = ""; }
        else if (/اجازه اسبوع|اجازه أسبوع|إجازه أسبوع|weekend|عطله|عطلة/i.test(lower)) { status = "weekend"; ci = ""; co = ""; }
        else if (/اجازه|إجازه|leave/i.test(lower)) { status = "leave"; ci = ""; co = ""; }
        else if (/متاخر|متأخر|late/i.test(lower)) { status = "late"; }

        // Extract specific times in line
        const times = [...line.matchAll(/(\d{1,2})(?::(\d{2}))?/g)].map(m => ({
          h: Number(m[1]), m: Number(m[2] || 0),
        }));
        if (times.length >= 2 && status !== "absent" && status !== "leave" && status !== "weekend") {
          ci = `${String(times[0].h).padStart(2,"0")}:${String(times[0].m).padStart(2,"0")}`;
          const t2 = times[1];
          const h2 = t2.h < 7 ? t2.h + 12 : t2.h;
          co = `${String(h2).padStart(2,"0")}:${String(t2.m).padStart(2,"0")}`;
        } else if (times.length === 1 && status === "late") {
          ci = `${String(times[0].h).padStart(2,"0")}:${String(times[0].m).padStart(2,"0")}`;
        }

        records.push({ employeeId: matchedEmp.id, empNameAr: matchedEmp.nameAr, status, checkIn: ci, checkOut: co, notes });
        handled.add(matchedEmp.id);
      }

      // If user said "كل" / "الجميع" — fill rest as present with global times
      const all = /كل\s*الموظفين|الجميع|كلهم|all\s*employees/i.test(text);
      if (all) {
        for (const e of employees) {
          if (!handled.has(e.id)) {
            records.push({ employeeId: e.id, empNameAr: e.nameAr, status: "present", checkIn: globalCi, checkOut: globalCo, notes: "" });
          }
        }
      }
      return { source: "fallback", records, summary: `تم تحليل ${records.length} سجل من النص.` };
    }

    if (!OPENAI_BASE || !OPENAI_KEY) { res.json(fallback()); return; }

    try {
      const empList = employees.map((e: any) => ({ id: e.id, code: e.code, name: e.nameAr })).slice(0, 200);
      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 1500,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "أنت مساعد لإدخال الحضور. حلّل النص العربي/الإنجليزي وحوّله لسجلات منظّمة. أعد JSON صالح فقط." },
            { role: "user", content: `التاريخ: ${date || "اليوم"}
وقت العمل الافتراضي: ${dCi} → ${dCo}

قائمة الموظفين المتاحين:
${JSON.stringify(empList, null, 2)}

النص المُدخل من المستخدم:
"""
${text}
"""

استخرج لكل موظف مذكور (أو ضمناً عبر "كل/الجميع") سجل حضور.
الحالات الممكنة: present (حاضر), absent (غائب), leave (إجازة), late (متأخر), weekend (إجازة أسبوعية).
صيغة الوقت 24 ساعة HH:MM. إذا قال "5 مساءً" فهي 17:00. إذا قال "غايب" فاترك checkIn و checkOut فارغين.

أعد JSON بالشكل التالي بالضبط:
{
  "records": [
    { "employeeId": <number>, "empNameAr": "<name>", "status": "<present|absent|leave|late|weekend>", "checkIn": "HH:MM" أو "", "checkOut": "HH:MM" أو "", "notes": "ملاحظة قصيرة إن وُجدت" }
  ],
  "summary": "ملخص بالعربية لما تم استخراجه (سطر واحد)"
}` },
          ],
        }),
      });
      if (!r.ok) { res.json(fallback()); return; }
      const data = await r.json();
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
      const records = Array.isArray(parsed.records) ? parsed.records.filter((x: any) =>
        x && typeof x.employeeId === "number" && employees.find((e: any) => e.id === x.employeeId)
      ) : [];
      if (records.length === 0) { res.json(fallback()); return; }
      res.json({ source: "ai", records, summary: parsed.summary || `تم تحليل ${records.length} سجل بالذكاء الاصطناعي.` });
    } catch { res.json(fallback()); }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// HR — explain payroll line in plain Arabic
router.post("/explain-payroll-line", async (req, res) => {
  try {
    const { line, periodMonth } = req.body as any;
    if (!line) { res.status(400).json({ error: "بيانات السطر مطلوبة" }); return; }

    function fallback() {
      const parts: string[] = [];
      parts.push(`الموظف ${line.empNameAr || "—"}:`);
      parts.push(`• الراتب الأساسي ${Number(line.basicSalary || 0).toFixed(2)} ر.س + بدلات (سكن ${Number(line.housingAllow || 0).toFixed(2)} + انتقال ${Number(line.transportAllow || 0).toFixed(2)} + أخرى ${Number(line.otherAllow || 0).toFixed(2)}).`);
      if (Number(line.overtimeAmount || 0) > 0) {
        parts.push(`• وقت إضافي ${Number(line.overtimeHours || 0).toFixed(2)} ساعة بقيمة ${Number(line.overtimeAmount).toFixed(2)} ر.س (أجر الساعة × 1.5 — المادة 107).`);
      }
      parts.push(`• إجمالي مستحقات الشهر: ${Number(line.grossSalary || 0).toFixed(2)} ر.س.`);
      if (Number(line.gosiEmployee || 0) > 0) {
        parts.push(`• تأمينات اجتماعية (10% من الأساسي + السكن للسعوديين): -${Number(line.gosiEmployee).toFixed(2)} ر.س.`);
      }
      if (Number(line.absenceDeduction || 0) > 0) {
        parts.push(`• خصم غياب ${line.absentDays || 0} يوم: -${Number(line.absenceDeduction).toFixed(2)} ر.س.`);
      }
      if (Number(line.loanDeduction || 0) > 0) {
        parts.push(`• قسط سلفة: -${Number(line.loanDeduction).toFixed(2)} ر.س.`);
      }
      parts.push(`• إجمالي الخصومات: ${Number(line.totalDeductions || 0).toFixed(2)} ر.س.`);
      parts.push(`• الصافي للصرف: ${Number(line.netSalary || 0).toFixed(2)} ر.س.`);
      return { source: "fallback", explanation: parts.join("\n") };
    }

    if (!OPENAI_BASE || !OPENAI_KEY) { res.json(fallback()); return; }
    try {
      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 700,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "أنت محاسب رواتب خبير في نظام العمل السعودي. اشرح بدقة وبأسلوب بسيط ومهني." },
            { role: "user", content: `اشرح بالعربية لمسؤول الرواتب كيف وصلنا إلى صافي راتب الموظف ${line.empNameAr || ""} لشهر ${periodMonth || ""} كأنك تحاسبه أمام الإدارة.

البيانات:
${JSON.stringify(line, null, 2)}

أعد JSON: { "explanation": "نص الشرح بنقاط مرتبة، يذكر المعادلة لكل بند والمواد القانونية ذات العلاقة من نظام العمل السعودي عند اللزوم" }` },
          ],
        }),
      });
      if (!r.ok) { res.json(fallback()); return; }
      const data = await r.json();
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
      const explanation = String(parsed.explanation || "").trim();
      if (!explanation) { res.json(fallback()); return; }
      res.json({ source: "ai", explanation });
    } catch { res.json(fallback()); }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// HR — generic explainer for any HR calculation
router.post("/explain-hr-calc", async (req, res) => {
  try {
    const { calcType, inputs, result } = req.body as any;
    if (!calcType || !result) { res.status(400).json({ error: "نوع الحساب والنتيجة مطلوبان" }); return; }

    const TYPE_CONTEXT: Record<string, { title: string; law: string; angle: string }> = {
      "annual-leave": { title: "حساب رصيد الإجازة السنوية", law: "المادة 109", angle: "يوضح الرصيد المستحق والمتبقي والقيمة النقدية" },
      "sick-leave":   { title: "حساب الإجازة المرضية",       law: "المادة 117", angle: "يوضح الأيام المدفوعة كاملة والمدفوعة جزئياً وغير المدفوعة" },
      "overtime":     { title: "حساب الوقت الإضافي",         law: "المادة 107", angle: "يوضح أجر الساعة الأصلي وأجر الساعة الإضافية" },
      "gosi":         { title: "حساب التأمينات الاجتماعية",  law: "نظام التأمينات الاجتماعية", angle: "يوضح حصة الموظف وحصة صاحب العمل والتكلفة الإجمالية" },
      "notice-period":{ title: "حساب بدل الإشعار",           law: "المادة 75", angle: "يوضح أيام الإشعار المطلوبة وقيمة التعويض" },
      "probation":    { title: "حالة فترة التجربة",          law: "المادة 53", angle: "يوضح المدة المنقضية والمتبقية" },
    };
    const ctx = TYPE_CONTEXT[calcType] || { title: "حساب موارد بشرية", law: "نظام العمل", angle: "" };

    function fallback() {
      const lines: string[] = [`${ctx.title} (${ctx.law}):`];
      const r = result || {};
      if (calcType === "annual-leave") {
        lines.push(`• مدة الخدمة: ${r.yearsOfService} سنة.`);
        lines.push(`• معدل الاستحقاق الحالي: ${r.ratePerYearCurrent} يوم/سنة (${r.noteTransition || ""}).`);
        lines.push(`• إجمالي الأيام المتراكمة: ${r.accruedDaysTotal} يوم.`);
        lines.push(`• الأيام المستهلكة: ${r.daysTaken} يوم.`);
        lines.push(`• الرصيد المتبقي: ${r.remainingDays} يوم.`);
        lines.push(`• قيمة الرصيد نقداً (للموظف): ${r.cashValueIfPaid} ر.س (بأجر يومي ${r.dailyWage}).`);
      } else if (calcType === "sick-leave") {
        lines.push(`• إجمالي الأيام المرضية في العام: ${r.daysTaken} يوم.`);
        lines.push(`• الأجر اليومي: ${r.dailyWage} ر.س.`);
        lines.push(`• 30 يوم بأجر كامل: ${r.fullPaidDays} يوم → ${r.fullPay} ر.س.`);
        lines.push(`• 60 يوم تالية بأجر 75%: ${r.partialPaidDays} يوم → ${r.partialPay} ر.س.`);
        lines.push(`• 30 يوم تالية بدون أجر: ${r.unpaidDays} يوم.`);
        lines.push(`• إجمالي ما يُدفع للموظف: ${r.totalPay} ر.س.`);
        if (r.warning) lines.push(`⚠ ${r.warning}`);
      } else if (calcType === "overtime") {
        lines.push(`• الأجر الشهري الشامل: ${r.monthlyWage} ر.س.`);
        lines.push(`• الأجر اليومي: ${r.dailyWage}، أجر الساعة العادية: ${r.hourlyWage} ر.س.`);
        lines.push(`• ساعات الوقت الإضافي: ${r.overtimeHours}.`);
        lines.push(`• المعامل: ×${r.multiplier} (الأصل + 50%).`);
        lines.push(`• قيمة الوقت الإضافي: ${r.overtimeAmount} ر.س.`);
        lines.push(`• المعادلة: ${r.formula}.`);
      } else if (calcType === "gosi") {
        lines.push(`• الأجر التأميني (أساسي + سكن، بحد أقصى 45,000): ${r.gosiWage} ر.س${r.capApplied ? " ⚠ تم تطبيق الحد الأعلى" : ""}.`);
        lines.push(`• ${r.isSaudi ? "موظف سعودي" : "موظف غير سعودي"}.`);
        lines.push(`• حصة الموظف (10%): ${r.employeeShare} ر.س${r.isSaudi ? "" : " — لا تُخصم"}.`);
        lines.push(`• حصة صاحب العمل — معاشات (12%): ${r.employerAnnuities} ر.س${r.isSaudi ? "" : " — لا تُحتسب"}.`);
        lines.push(`• حصة صاحب العمل — أخطار مهنية (2%): ${r.employerOccupationalHazards} ر.س.`);
        lines.push(`• إجمالي ما يدفعه صاحب العمل: ${r.totalEmployer} ر.س.`);
        lines.push(`• إجمالي التكلفة (موظف + صاحب عمل): ${r.totalCost} ر.س.`);
        lines.push(`• صافي ما يصل للموظف من الأجر التأميني: ${r.netToEmployee} ر.س.`);
      } else if (calcType === "notice-period") {
        lines.push(`• الأجر الشهري الشامل: ${r.monthlyWage} ر.س، الأجر اليومي: ${r.dailyWage} ر.س.`);
        lines.push(`• الإشعار المطلوب: ${r.requiredNoticeDays} يوم.`);
        lines.push(`• الإشعار الفعلي الممنوح: ${r.daysActuallyGiven} يوم.`);
        lines.push(`• أيام التعويض المستحقة: ${r.compensationDays} يوم.`);
        lines.push(`• قيمة بدل الإشعار: ${r.compensationAmount} ر.س.`);
        lines.push(`• المعادلة: ${r.formula}.`);
      } else if (calcType === "probation") {
        lines.push(`• تاريخ التعيين: ${r.hireDate}، فترة التجربة: ${r.probationDays} يوم.`);
        lines.push(`• تنتهي فترة التجربة في: ${r.probationEndDate}.`);
        lines.push(`• المنقضي: ${r.daysElapsed} يوم، المتبقي: ${r.daysRemaining} يوم.`);
        lines.push(`• الحالة: ${r.statusLabel}.`);
        if (r.warning) lines.push(`⚠ ${r.warning}`);
      }
      lines.push(`📚 المرجع: ${r.legalRef || ctx.law}`);
      return { source: "fallback", explanation: lines.join("\n") };
    }

    if (!OPENAI_BASE || !OPENAI_KEY) { res.json(fallback()); return; }
    try {
      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 800,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: `أنت مستشار في الموارد البشرية متخصص في نظام العمل السعودي ولوائحه التنفيذية. اشرح بدقة قانونية وبأسلوب مهني واضح للموظفين والإدارة.` },
            { role: "user", content: `${ctx.title} — ${ctx.angle}.

المُدخلات:
${JSON.stringify(inputs || {}, null, 2)}

النتيجة:
${JSON.stringify(result, null, 2)}

اشرح بالعربية بنقاط مرتبة:
1. المعطيات الأساسية،
2. كيف طُبقت ${ctx.law} للوصول للنتيجة،
3. ما تعنيه الأرقام عملياً للموظف وصاحب العمل،
4. أي تحذيرات أو نصائح ذات صلة.

أعد JSON: { "explanation": "النص الكامل بالعربية" }` },
          ],
        }),
      });
      if (!r.ok) { res.json(fallback()); return; }
      const data = await r.json();
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
      const explanation = String(parsed.explanation || "").trim();
      if (!explanation) { res.json(fallback()); return; }
      res.json({ source: "ai", explanation });
    } catch { res.json(fallback()); }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// HR — explain end of service calculation
router.post("/explain-eos", async (req, res) => {
  try {
    const { calc, employee } = req.body as any;
    if (!calc) { res.status(400).json({ error: "بيانات الحساب مطلوبة" }); return; }

    function fallback() {
      const parts: string[] = [];
      parts.push(`حساب مكافأة نهاية الخدمة للموظف ${employee?.nameAr || "—"}:`);
      parts.push(`• مدة الخدمة: ${calc.yearsOfService} سنة (من ${calc.hireDate} إلى ${calc.endDate}).`);
      parts.push(`• الأجر الشامل الشهري: ${calc.basicSalary} (أساسي) + ${calc.housingAllow} (سكن) + ${calc.transportAllow} (انتقال) = ${calc.monthlySalary} ر.س.`);
      parts.push(`• حسب المادة (84): نصف شهر عن كل سنة من السنوات الخمس الأولى + شهر كامل عن كل سنة بعد ذلك.`);
      parts.push(`  - السنوات الخمس الأولى (${calc.breakdown.firstFiveYears} سنة) × ½ شهر = ${calc.breakdown.firstFiveAmount} ر.س.`);
      if (calc.breakdown.afterFiveYears > 0) {
        parts.push(`  - السنوات بعد الخمس (${calc.breakdown.afterFiveYears} سنة) × شهر كامل = ${calc.breakdown.afterFiveAmount} ر.س.`);
      }
      parts.push(`• المكافأة الكاملة: ${calc.grossEntitlement} ر.س.`);
      parts.push(`• ${calc.factorReason}`);
      parts.push(`• المعامل المطبّق: ${(calc.factor * 100).toFixed(0)}%.`);
      parts.push(`✅ صافي المستحق: ${calc.netAmount} ر.س.`);
      return { source: "fallback", explanation: parts.join("\n") };
    }

    if (!OPENAI_BASE || !OPENAI_KEY) { res.json(fallback()); return; }
    try {
      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 800,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "أنت مستشار قانوني في الموارد البشرية متخصص في نظام العمل السعودي. اشرح الحسابات بدقة قانونية وبلغة واضحة." },
            { role: "user", content: `اشرح للموظف ${employee?.nameAr || ""} كيف تم احتساب مكافأة نهاية الخدمة الخاصة به، مع ذكر المواد القانونية (84، 85) من نظام العمل السعودي ونصائح عملية إن أمكن.

بيانات الحساب:
${JSON.stringify(calc, null, 2)}

أعد JSON: { "explanation": "شرح مفصّل بالعربية بنقاط مرتبة، يبدأ بمدة الخدمة، ثم الأجر المحتسب، ثم تطبيق المادة 84، ثم تطبيق نسبة الاستحقاق وفق سبب إنهاء الخدمة، وينتهي بالصافي. اذكر أرقاماً واضحة." }` },
          ],
        }),
      });
      if (!r.ok) { res.json(fallback()); return; }
      const data = await r.json();
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
      const explanation = String(parsed.explanation || "").trim();
      if (!explanation) { res.json(fallback()); return; }
      res.json({ source: "ai", explanation });
    } catch { res.json(fallback()); }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// HR — explain HR-related journal entry (payroll / loan / EOS)
router.post("/explain-hr-journal", async (req, res) => {
  try {
    const { entryType, entry, lines, context } = req.body as any;
    if (!entryType || !entry || !Array.isArray(lines)) {
      res.status(400).json({ error: "بيانات القيد المحاسبي مطلوبة" });
      return;
    }

    const TITLES: Record<string, string> = {
      payroll_run:    "قيد مسير الرواتب الشهري",
      employee_loan:  "قيد صرف سلفة موظف",
      eos_payment:    "قيد صرف مكافأة نهاية الخدمة",
    };
    const title = TITLES[entryType] || "قيد محاسبي خاص بالموارد البشرية";

    function fallback() {
      const out: string[] = [];
      out.push(`${title}:`);
      out.push(`• رقم المستند: ${entry.docNumber || "—"} — التاريخ: ${entry.entryDate}`);
      const dr = (lines as any[]).filter((l) => Number(l.debit) > 0);
      const cr = (lines as any[]).filter((l) => Number(l.credit) > 0);
      const sum = (a: any[], k: "debit" | "credit") => a.reduce((s, x) => s + Number(x[k] || 0), 0);
      out.push(`• إجمالي مدين: ${sum(dr, "debit").toFixed(2)} ر.س — إجمالي دائن: ${sum(cr, "credit").toFixed(2)} ر.س.`);
      out.push("• الأطراف المدينة (من ح/):");
      for (const l of dr) out.push(`   - ${l.description || "—"}: ${Number(l.debit).toFixed(2)} ر.س.`);
      out.push("• الأطراف الدائنة (إلى ح/):");
      for (const l of cr) out.push(`   - ${l.description || "—"}: ${Number(l.credit).toFixed(2)} ر.س.`);
      if (entryType === "payroll_run") {
        out.push("📌 الفكرة: الرواتب والبدلات تُسجّل كمصروف على الشركة، وتُجزّأ على الجانب الدائن إلى ما يستحق دفعه فعلاً للموظفين، وحصة الموظف من التأمينات (تُورّد للمؤسسة)، واسترداد أقساط السلف، وأي استقطاعات أخرى.");
      } else if (entryType === "employee_loan") {
        out.push("📌 الفكرة: صرف السلفة يُحوّل النقد إلى ذمة على الموظف (أصل يُسترد بالخصم من الراتب).");
      } else if (entryType === "eos_payment") {
        out.push("📌 الفكرة: صرف مكافأة نهاية الخدمة يُقفل المصروف (أو المخصص المُكوَّن سابقاً) مقابل النقد المُسلَّم للموظف.");
      }
      return { source: "fallback", explanation: out.join("\n") };
    }

    if (!OPENAI_BASE || !OPENAI_KEY) { res.json(fallback()); return; }
    try {
      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 700,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "أنت محاسب سعودي خبير. اشرح القيود المحاسبية بأسلوب واضح مع تبيان منطق كل طرف ومدى توازن القيد، وفق النظام المحاسبي السعودي ومعايير IFRS-SME." },
            { role: "user", content: `${title}.

القيد:
${JSON.stringify(entry, null, 2)}

السطور:
${JSON.stringify(lines, null, 2)}

السياق الإضافي:
${JSON.stringify(context || {}, null, 2)}

اشرح:
1. لماذا تم تسجيل هذا القيد،
2. منطق كل طرف مدين وكل طرف دائن (ولماذا اخترنا هذه الحسابات)،
3. التحقق من التوازن،
4. الأثر على القوائم المالية وعلى علاقة الشركة بالموظف/المؤسسة.

أعد JSON: { "explanation": "النص الكامل بالعربية" }` },
          ],
        }),
      });
      if (!r.ok) { res.json(fallback()); return; }
      const data = await r.json();
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
      const explanation = String(parsed.explanation || "").trim();
      if (!explanation) { res.json(fallback()); return; }
      res.json({ source: "ai", explanation });
    } catch { res.json(fallback()); }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Analyze an HR report — generates AI insights, observations, and
// actionable recommendations in Arabic from the report's summary stats
// and a representative sample of rows.
//
// Body: { reportType, title, summary, rows, period? }
// Returns: { source, insights[], recommendations[], risks[], headline }
// ═══════════════════════════════════════════════════════════════════
router.post("/analyze-hr-report", async (req, res) => {
  try {
    const { reportType, title, summary, rows, period } = req.body as any;
    if (!reportType || !summary) {
      res.status(400).json({ error: "بيانات التقرير مطلوبة" });
      return;
    }

    function fallback() {
      const insights: string[] = [];
      const recommendations: string[] = [];
      const risks: string[] = [];

      if (reportType === "employees") {
        insights.push(`إجمالي الموظفين: ${summary.total} (${summary.active} نشط، ${summary.inactive} غير نشط).`);
        insights.push(`نسبة السعودة (تقريباً): ${summary.total ? ((summary.saudis / summary.total) * 100).toFixed(1) : 0}%.`);
        insights.push(`إجمالي الراتب الأساسي الشهري: ${num(summary.totalBasicSalary).toFixed(2)} ر.س، إجمالي البدلات: ${num(summary.totalAllowances).toFixed(2)} ر.س.`);
        if (summary.total && summary.saudis / summary.total < 0.4) {
          risks.push("نسبة السعودة منخفضة — قد تتعرض المنشأة لمتطلبات نطاقات.");
          recommendations.push("راجع متطلبات نطاقات وخطّط لرفع نسبة السعودة عبر التوظيف أو الاستبدال.");
        }
      } else if (reportType === "payroll") {
        insights.push(`عدد المسيرات في الفترة: ${summary.runsCount}، عدد الموظفين الإجمالي: ${summary.employeesCount}.`);
        insights.push(`إجمالي الإجمالي: ${num(summary.totalGross).toFixed(2)} ر.س — صافي الإجمالي: ${num(summary.totalNet).toFixed(2)} ر.س.`);
        insights.push(`إجمالي حصة الموظف من التأمينات (GOSI): ${num(summary.totalGosi).toFixed(2)} ر.س.`);
        insights.push(`إجمالي خصومات السلف: ${num(summary.totalLoans).toFixed(2)} ر.س — إجمالي الإضافي والأوفر تايم: ${num(summary.totalOvertime).toFixed(2)} ر.س.`);
        if (summary.totalDeductions / Math.max(1, summary.totalGross) > 0.3) {
          risks.push("نسبة الاستقطاعات للإجمالي تتجاوز 30% — قد يؤثر ذلك على رضا الموظفين.");
        }
      } else if (reportType === "attendance") {
        insights.push(`إجمالي السجلات: ${summary.totalRecords} لـ ${summary.employeesCount} موظفاً.`);
        insights.push(`أيام الحضور: ${summary.totalPresent}، الغياب: ${summary.totalAbsent}، الإجازات: ${summary.totalLeave}، التأخير: ${summary.totalLate}.`);
        insights.push(`متوسط نسبة الحضور: ${num(summary.avgAttendanceRate).toFixed(1)}%.`);
        if (summary.avgAttendanceRate < 90) {
          risks.push("متوسط الحضور أقل من 90% — مؤشر على ضعف الانتظام.");
          recommendations.push("افحص الموظفين أصحاب الغياب الأعلى وحدد الأسباب.");
        }
      } else if (reportType === "contracts") {
        insights.push(`إجمالي العقود: ${summary.total} (${summary.active} نشط).`);
        insights.push(`عقود منتهية: ${summary.expired} — قاربت على الانتهاء: ${summary.expiringSoon}.`);
        if (summary.expiringSoon > 0) {
          risks.push(`${summary.expiringSoon} عقد قارب الانتهاء — يجب التجديد قبل الموعد لتفادي المخالفات.`);
          recommendations.push("راجع العقود قاربة الانتهاء وابدأ إجراءات التجديد أو الإنهاء.");
        }
      } else if (reportType === "documents") {
        insights.push(`إجمالي الوثائق: ${summary.total}.`);
        insights.push(`إقامات منتهية: ${summary.iqamaExpired} — قاربت على الانتهاء: ${summary.iqamaExpiring}.`);
        insights.push(`جوازات منتهية: ${summary.passportExpired} — قاربت على الانتهاء: ${summary.passportExpiring}.`);
        if (summary.expired > 0) risks.push(`${summary.expired} وثيقة منتهية حالياً — مخالفة قانونية.`);
        if (summary.expiringSoon > 0) recommendations.push("ابدأ إجراءات تجديد الوثائق قاربة الانتهاء فوراً.");
      } else if (reportType === "loans") {
        insights.push(`إجمالي السلف: ${summary.total} (${summary.active} نشط).`);
        insights.push(`إجمالي المبلغ: ${num(summary.totalAmount).toFixed(2)} ر.س — المسدد: ${num(summary.totalPaid).toFixed(2)} ر.س — المتبقي: ${num(summary.totalRemaining).toFixed(2)} ر.س.`);
        if (summary.totalRemaining > summary.totalAmount * 0.5) {
          insights.push("أكثر من نصف قيمة السلف لا يزال متبقياً.");
        }
      } else if (reportType === "eos") {
        insights.push(`عدد الموظفين المنتهية خدمتهم: ${summary.total}.`);
        insights.push(`إجمالي مكافآت نهاية الخدمة المقدّرة: ${num(summary.totalEosEstimate).toFixed(2)} ر.س.`);
        insights.push(`متوسط سنوات الخدمة: ${num(summary.averageYears).toFixed(1)} سنة.`);
        recommendations.push("تأكد من تكوين مخصص نهاية خدمة شهري بنسبة كافية لمواجهة الالتزامات المستقبلية.");
      } else if (reportType === "employee-cost") {
        insights.push(`عدد الموظفين النشطين: ${summary.total}.`);
        insights.push(`إجمالي التكلفة الشهرية للشركة: ${num(summary.totalMonthlyCost).toFixed(2)} ر.س.`);
        insights.push(`إجمالي التكلفة السنوية: ${num(summary.totalAnnualCost).toFixed(2)} ر.س.`);
        insights.push(`إجمالي حصة صاحب العمل من التأمينات: ${num(summary.totalGosi).toFixed(2)} ر.س شهرياً.`);
      } else if (reportType === "leaves") {
        insights.push(`إجمالي طلبات الإجازة: ${summary.total} — معتمدة: ${summary.approved}، معلقة: ${summary.pending}.`);
        insights.push(`إجمالي الأيام: ${summary.totalDays} — مدفوعة: ${summary.paidDays}، غير مدفوعة: ${summary.unpaidDays}.`);
      }

      function num(v: any): number { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; }

      const headline = insights[0] || "لا توجد ملاحظات.";
      return {
        source: "fallback" as const,
        headline,
        insights,
        recommendations,
        risks,
      };
    }

    if (!OPENAI_BASE || !OPENAI_KEY) { res.json(fallback()); return; }

    try {
      // Limit rows in prompt to keep token usage reasonable
      const rowsForPrompt = Array.isArray(rows) ? rows.slice(0, 30) : [];

      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 1200,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "أنت محلل بيانات موارد بشرية محترف، خبير في نظام العمل السعودي ولوائح المؤسسة العامة للتأمينات الاجتماعية وقواعد نطاقات. تحلل تقارير شؤون الموظفين بأسلوب احترافي مختصر وتقدم توصيات قابلة للتنفيذ.",
            },
            {
              role: "user",
              content: `حلل تقرير ${title || reportType} للموارد البشرية.

نوع التقرير: ${reportType}
${period ? `الفترة: ${JSON.stringify(period)}` : ""}

ملخص التقرير:
${JSON.stringify(summary, null, 2)}

عينة من السجلات (أول 30):
${JSON.stringify(rowsForPrompt, null, 2)}

قدم تحليلاً عربياً واضحاً يتضمن:
1. headline: عنوان قصير جداً (سطر واحد) يلخص أهم ملاحظة.
2. insights: 4-6 ملاحظات موضوعية بناءً على الأرقام (تشمل النسب، المقارنات، الاتجاهات، النقاط الأكثر إثارة للاهتمام).
3. recommendations: 3-5 توصيات عملية محددة لتحسين الأداء أو تقليل المخاطر، بحسب نوع التقرير.
4. risks: المخاطر القانونية أو المالية أو التشغيلية المحتملة (يمكن أن تكون مصفوفة فارغة إن لم توجد).

أعد JSON بالشكل:
{ "headline": "...", "insights": ["...", "..."], "recommendations": ["...", "..."], "risks": ["...", "..."] }`,
            },
          ],
        }),
      });
      if (!r.ok) { res.json(fallback()); return; }
      const data = await r.json();
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
      const headline = String(parsed.headline || "").trim();
      const insights = Array.isArray(parsed.insights) ? parsed.insights.map((x: any) => String(x)) : [];
      const recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations.map((x: any) => String(x)) : [];
      const risks = Array.isArray(parsed.risks) ? parsed.risks.map((x: any) => String(x)) : [];
      if (!headline && insights.length === 0) { res.json(fallback()); return; }
      res.json({ source: "ai", headline, insights, recommendations, risks });
    } catch {
      res.json(fallback());
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Validate a journal entry. Confirms it is balanced (debits == credits)
// AND uses AI to spot common mistakes (account on wrong side, suspicious
// amounts, missing leg, etc.). Falls back to a deterministic rule-based
// check when AI is not configured.
//
// Body: { entry: {entryDate, description, entryType, currency},
//         lines: [{accountCode, accountName, accountType, debit, credit, description}] }
// Returns: {
//   isBalanced: boolean,
//   totalDebit: number,
//   totalCredit: number,
//   diff: number,
//   suggestion: string,        // which side and how much to add
//   issues: string[],          // human-readable list of problems
//   summary: string,           // one-line headline (Arabic)
//   source: "ai" | "fallback"
// }
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// Suggest the company's VAT account for the "قيد الضريبة" button on
// the Journal Entry form. Given a direction ("input" → ضريبة المدخلات
// on the Dr side, or "output" → ضريبة المخرجات on the Cr side), this
// picks the best matching posting account from the company's chart
// of accounts. The frontend then splits 15% out of the first line and
// adds a new VAT line on the same side using this account.
//
// Strategy:
//   1. Pull active POSTING accounts in the company.
//   2. Try AI (when configured): give the model a short list of asset
//      / liability candidates and ask it to pick one ID.
//   3. Always fall back to a deterministic keyword match so the UI
//      never returns nothing when AI is offline.
router.post("/suggest-vat-account", async (req, res) => {
  try {
    // SuperAdmin needs the companyId threaded through the body since the
    // request isn't tied to a tenant; tenant users always resolve to their
    // own company regardless of what they pass.
    const bodyCid = Number((req.body as any)?.companyId);
    const cid = resolveCompanyId(req as any, Number.isFinite(bodyCid) && bodyCid > 0 ? bodyCid : undefined);
    if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const { direction } = req.body as { direction?: "input" | "output" };
    if (direction !== "input" && direction !== "output") {
      res.status(400).json({ error: "direction يجب أن يكون input أو output" });
      return;
    }

    const accounts = await db.select({
      id: accountsTable.id, code: accountsTable.code,
      nameAr: accountsTable.nameAr, nameEn: accountsTable.nameEn,
      accountType: accountsTable.accountType, isPosting: accountsTable.isPosting,
    }).from(accountsTable)
      .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.isActive, true)));

    const posting = accounts.filter(a => a.isPosting);
    // Input VAT lives in assets (it's a recoverable claim against the gov't);
    // Output VAT lives in liabilities (it's owed to the gov't on collected sales).
    const naturalPool = posting.filter(a =>
      direction === "input"
        ? a.accountType === "asset"
        : a.accountType === "liability"
    );
    // We always allow the deterministic search to fall back to ALL posting
    // accounts in case the chart doesn't tag VAT accounts under the natural
    // type.
    const arabicKw = direction === "input"
      ? ["ضريبة المدخلات", "ضريبة مدخلات", "ضريبة قيمة مضافة مدخلات", "ضريبة شراء", "vat input", "input vat"]
      : ["ضريبة المخرجات", "ضريبة مخرجات", "ضريبة قيمة مضافة مخرجات", "ضريبة بيع", "vat output", "output vat"];

    const codeHint = direction === "input" ? "1240" : "2140";

    function findByKeywords(pool: typeof accounts, kw: string[]) {
      const lc = (s: string | null | undefined) => String(s ?? "").toLowerCase();
      return pool.find(a => {
        const t = `${lc(a.nameAr)} ${lc(a.nameEn)} ${lc(a.code)}`;
        return kw.some(k => k && t.includes(k.toLowerCase()));
      });
    }

    const buildFallback = () => {
      const acc =
        findByKeywords(naturalPool, arabicKw) ||
        findByKeywords(posting,     arabicKw) ||
        posting.find(a => a.code === codeHint) ||
        naturalPool[0] ||
        null;
      return {
        accountId: acc?.id ?? null,
        accountLabel: acc ? `${acc.code} - ${acc.nameAr ?? acc.nameEn ?? ""}`.trim() : "",
        reasoning: acc
          ? (direction === "input"
              ? "تم اختيار حساب ضريبة المدخلات بناءً على اسم الحساب أو نوعه (أصل)."
              : "تم اختيار حساب ضريبة المخرجات بناءً على اسم الحساب أو نوعه (التزام).")
          : (direction === "input"
              ? "لم يتم العثور على حساب ضريبة مدخلات. أنشئ حساباً باسم 'ضريبة المدخلات' أو حدّده يدوياً."
              : "لم يتم العثور على حساب ضريبة مخرجات. أنشئ حساباً باسم 'ضريبة المخرجات' أو حدّده يدوياً."),
        source: "rules" as const,
      };
    };

    if (!OPENAI_BASE || !OPENAI_KEY || posting.length === 0) {
      res.json(buildFallback()); return;
    }

    try {
      // Limit candidates to assets+liabilities to keep the prompt small.
      const candidates = posting.filter(a => a.accountType === "asset" || a.accountType === "liability");
      const fmtList = candidates.map(a =>
        `{ "id": ${a.id}, "code": "${a.code}", "name": "${a.nameAr}${a.nameEn ? " / " + a.nameEn : ""}", "type": "${a.accountType}" }`
      ).join(",\n");

      const userPrompt = `أنت محاسب سعودي خبير في ضريبة القيمة المضافة (15%). المستخدم في شاشة قيد محاسبي ويريد إضافة سطر للضريبة:
- الاتجاه المطلوب: ${direction === "input" ? "ضريبة مدخلات (تظهر في طرف المدين، طبيعتها أصل قابل للاسترداد من الهيئة)" : "ضريبة مخرجات (تظهر في طرف الدائن، طبيعتها التزام للهيئة)"}.

دليل الحسابات (ترحيل فقط — أصول/التزامات):
[${fmtList}]

قواعد الاختيار:
1. اختر الحساب الذي يحمل اسماً يطابق "${direction === "input" ? "ضريبة المدخلات / ضريبة قيمة مضافة (مدخلات) / VAT Input" : "ضريبة المخرجات / ضريبة قيمة مضافة (مخرجات) / VAT Output"}".
2. للمدخلات يفضّل حساب من نوع "asset"، وللمخرجات يفضّل حساب من نوع "liability".
3. إن لم يوجد حساب مخصص، اختر أقرب حساب يفي بالغرض ووضّح السبب.
4. أعد فقط ID موجود في القائمة — لا تخترع.

أعد JSON فقط:
{ "accountId": <id>, "reasoning": "شرح موجز بالعربية لسبب الاختيار" }`;

      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 400,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "أنت محاسب سعودي. ترد بـ JSON صالح فقط." },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (!r.ok) { res.json(buildFallback()); return; }
      const data = await r.json();
      let parsed: any;
      try { parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}"); }
      catch { res.json(buildFallback()); return; }

      const accId = Number(parsed?.accountId);
      const acc = candidates.find(a => a.id === accId);
      if (!acc) { res.json(buildFallback()); return; }
      res.json({
        accountId: acc.id,
        accountLabel: `${acc.code} - ${acc.nameAr ?? acc.nameEn ?? ""}`.trim(),
        reasoning: String(parsed?.reasoning || "").trim() ||
          (direction === "input" ? "اقتراح تلقائي لحساب ضريبة المدخلات." : "اقتراح تلقائي لحساب ضريبة المخرجات."),
        source: "ai" as const,
      });
    } catch {
      res.json(buildFallback());
      return;
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

router.post("/validate-journal-entry", async (req, res) => {
  try {
    const { entry, lines } = req.body as {
      entry: { entryDate?: string; description?: string; entryType?: string; currency?: string };
      lines: Array<{
        accountCode?: string;
        accountName?: string;
        accountType?: string;
        debit?: number | string;
        credit?: number | string;
        description?: string;
      }>;
    };
    if (!entry || !Array.isArray(lines)) {
      res.status(400).json({ error: "بيانات القيد مطلوبة" });
      return;
    }

    const num = (v: any) => Number(v || 0) || 0;
    const totalDebit  = lines.reduce((s, l) => s + num(l.debit),  0);
    const totalCredit = lines.reduce((s, l) => s + num(l.credit), 0);
    const diff = Math.round((totalDebit - totalCredit) * 100) / 100;
    const isBalanced = Math.abs(diff) < 0.01;
    const cur = entry.currency || "ر.س";

    const suggestion = isBalanced
      ? "القيد متوازن — يمكنك الحفظ."
      : diff > 0
        ? `أضف ${diff.toFixed(2)} ${cur} إلى الجانب الدائن (أو خفّض المدين بنفس المبلغ).`
        : `أضف ${Math.abs(diff).toFixed(2)} ${cur} إلى الجانب المدين (أو خفّض الدائن بنفس المبلغ).`;

    function deterministicIssues(): string[] {
      const issues: string[] = [];
      if (!isBalanced) {
        issues.push(`القيد غير متوازن: مدين ${totalDebit.toFixed(2)} ≠ دائن ${totalCredit.toFixed(2)} (الفرق ${Math.abs(diff).toFixed(2)} ${cur}).`);
      }
      const usable = lines.filter(l => (l.accountCode || l.accountName) && (num(l.debit) > 0 || num(l.credit) > 0));
      if (usable.length < 2) issues.push("يجب أن يحتوي القيد على سطرين على الأقل بحساب وقيمة.");
      for (const [i, l] of lines.entries()) {
        const d = num(l.debit), c = num(l.credit);
        if (d > 0 && c > 0) {
          issues.push(`السطر ${i + 1} (${l.accountName || l.accountCode || "—"}): لا يمكن إدخال مدين ودائن في نفس السطر.`);
        }
        if ((l.accountCode || l.accountName) && d === 0 && c === 0) {
          issues.push(`السطر ${i + 1} (${l.accountName || l.accountCode}): الحساب محدد لكن المبلغ صفر.`);
        }
        if (!l.accountCode && !l.accountName && (d > 0 || c > 0)) {
          issues.push(`السطر ${i + 1}: يوجد مبلغ بدون حساب.`);
        }
      }
      return issues;
    }

    function fallback() {
      const issues = deterministicIssues();
      const summary = isBalanced && issues.length === 0
        ? "القيد سليم ومتوازن."
        : !isBalanced
          ? `القيد غير متوازن — الفرق ${Math.abs(diff).toFixed(2)} ${cur}.`
          : "هناك ملاحظات على القيد، راجعها قبل الحفظ.";
      return {
        isBalanced, totalDebit, totalCredit, diff,
        suggestion, issues, summary,
        source: "fallback" as const,
      };
    }

    if (!OPENAI_BASE || !OPENAI_KEY) { res.json(fallback()); return; }

    try {
      const userPrompt = `راجع القيد المحاسبي التالي وفق المبادئ المحاسبية المتعارف عليها في السعودية (IFRS-SME).

رأس القيد:
${JSON.stringify({ entryDate: entry.entryDate, description: entry.description, entryType: entry.entryType, currency: cur }, null, 2)}

السطور (الترقيم يبدأ من 1):
${JSON.stringify(lines.map((l, i) => ({ row: i + 1, ...l })), null, 2)}

الإجماليات المحسوبة:
- إجمالي المدين: ${totalDebit.toFixed(2)} ${cur}
- إجمالي الدائن: ${totalCredit.toFixed(2)} ${cur}
- الفرق (مدين - دائن): ${diff.toFixed(2)} ${cur}
- متوازن؟ ${isBalanced ? "نعم" : "لا"}

اكتشف المشاكل (أمثلة): قيد غير متوازن، حساب على الجانب الخطأ بحسب طبيعته (أصول/مصروفات عادة مدينة، خصوم/إيرادات/حقوق ملكية عادة دائنة)، مبلغ بدون حساب، حساب محدد بدون مبلغ، مدين ودائن في نفس السطر، مبالغ تبدو خاطئة منطقياً.

أعد JSON فقط بالشكل:
{
  "summary": "جملة عربية واحدة قصيرة",
  "issues": ["مشكلة 1", "مشكلة 2"],
  "suggestion": "اقتراح عملي للإصلاح بالعربية"
}

إذا كان القيد سليماً تماماً، أعد issues فارغة وsummary مثل "القيد سليم ومتوازن".`;

      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 600,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "أنت محاسب سعودي خبير. تفحص القيود المحاسبية بدقة وتشير للمشاكل بإيجاز ووضوح. ترد بـ JSON فقط بدون أي شرح إضافي." },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (!r.ok) { res.json(fallback()); return; }
      const data = await r.json();
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
      const aiIssues = Array.isArray(parsed.issues) ? parsed.issues.map(String).filter(Boolean) : [];
      const aiSuggestion = String(parsed.suggestion || "").trim() || suggestion;
      const aiSummary = String(parsed.summary || "").trim() ||
        (isBalanced ? "القيد سليم ومتوازن." : `القيد غير متوازن — الفرق ${Math.abs(diff).toFixed(2)} ${cur}.`);
      res.json({
        isBalanced, totalDebit, totalCredit, diff,
        suggestion: aiSuggestion,
        issues: aiIssues.length ? aiIssues : deterministicIssues(),
        summary: aiSummary,
        source: "ai" as const,
      });
    } catch { res.json(fallback()); }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ غير معروف" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PRODUCTION ASSISTANT — context-aware screen explainer & action suggester.
//
// Accepts a screen_context tag (e.g. "production.orders.list") plus an
// optional natural-language user message and an optional order_id. When
// an order_id is provided, the endpoint loads a compact snapshot of the
// order, its items, and recent events to give the model rich context.
// Always responds with a strict JSON shape so the client can render the
// 4 sections deterministically. Falls back to a deterministic explanation
// when the AI service is unavailable, so the UI is never empty.
// ─────────────────────────────────────────────────────────────────────────
router.post("/assist", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
    const userMessage = String(req.body?.user_message ?? "").slice(0, 1000);
    const screenContext = String(req.body?.screen_context ?? "").slice(0, 200);
    const currentAction = String(req.body?.current_action ?? "").slice(0, 200);
    const orderId = req.body?.order_id ? Number(req.body.order_id) : null;
    const lang = String(req.body?.lang ?? "ar");

    // Load order snapshot if requested AND user is allowed to see it.
    let snapshot: any = null;
    if (cid && orderId) {
      const [order] = await db
        .select()
        .from(productionOrdersTable)
        .where(
          and(
            eq(productionOrdersTable.id, orderId),
            eq(productionOrdersTable.companyId, cid),
          ),
        );
      if (order) {
        const items = await db
          .select()
          .from(productionOrderItemsTable)
          .where(eq(productionOrderItemsTable.orderId, orderId));
        const events = await db
          .select()
          .from(productionEventsTable)
          .where(eq(productionEventsTable.orderId, orderId))
          .orderBy(desc(productionEventsTable.createdAt))
          .limit(15);
        let resourceName: string | null = null;
        if (order.resourceId) {
          // HIGH fix #3 — enforce companyId on the resource lookup so a
          // tampered/foreign resourceId can NEVER leak another tenant's name.
          const [r] = await db
            .select({ name: productionResourcesTable.name })
            .from(productionResourcesTable)
            .where(
              and(
                eq(productionResourcesTable.id, order.resourceId),
                eq(productionResourcesTable.companyId, cid),
              ),
            );
          resourceName = r?.name ?? null;
        }
        snapshot = {
          orderNumber: order.orderNumber,
          title: order.title,
          status: order.status,
          plannedQty: order.plannedQty,
          producedQty: order.producedQty,
          wasteQty: order.wasteQty,
          unitCode: order.unitCode,
          estimatedCost: order.estimatedCost,
          actualCost: order.actualCost,
          resourceName,
          itemCount: items.length,
          itemsBreakdown: items.reduce<Record<string, number>>((acc, it) => {
            acc[it.kind] = (acc[it.kind] ?? 0) + 1;
            return acc;
          }, {}),
          recentEvents: events.map((e) => ({
            type: e.eventType,
            at: e.createdAt,
            byAi: e.byAi,
          })),
        };
      }
    }

    // Deterministic fallback used when AI is unavailable OR raises an error.
    // Covers every major screen so the panel always returns a meaningful
    // explanation even with no AI credits configured. Unknown contexts fall
    // through to a generic "this screen" label.
    const screenLabels: Record<string, { ar: string; en: string; explainAr: string; explainEn: string }> = {
      // ── Dashboard ────────────────────────────────────────────────────
      "dashboard.home": {
        ar: "اللوحة الرئيسية",
        en: "Main dashboard",
        explainAr: "تعرض لك أهم مؤشرات الشركة (مبيعات، مشتريات، مخزون، صافي الربح) وروابط سريعة لأكثر العمليات استخداماً.",
        explainEn: "Shows the company's key indicators (sales, purchases, inventory, net profit) plus shortcuts to the most-used actions.",
      },
      "common.notifications": {
        ar: "الإشعارات",
        en: "Notifications",
        explainAr: "كل التنبيهات والرسائل التي يولّدها النظام لك (موافقات، تجاوزات، طلبات...). اضغط أي إشعار لفتح المستند المرتبط به.",
        explainEn: "All system-generated alerts (approvals, exceptions, requests…). Click any item to jump to its source document.",
      },

      // ── Sales ────────────────────────────────────────────────────────
      "sales.module": { ar: "وحدة المبيعات", en: "Sales module", explainAr: "إدارة العملاء، عروض الأسعار، الفواتير، المرتجعات والتحصيلات.", explainEn: "Manage customers, quotations, invoices, returns and collections." },
      "sales.invoices.list":   { ar: "قائمة فواتير المبيعات", en: "Sales invoices list", explainAr: "كل فواتير المبيعات (مرحّلة ومسودات) مع إمكانية الفلترة والتصدير وإرسال ZATCA.", explainEn: "All sales invoices (posted & drafts) with filtering, export and ZATCA submission." },
      "sales.invoices.new":    { ar: "فاتورة مبيعات جديدة", en: "New sales invoice", explainAr: "إنشاء فاتورة مبيعات لعميل: إضافة الأصناف، حساب الضريبة (15%)، ثم الترحيل والإرسال إلى ZATCA.", explainEn: "Create a customer invoice: add items, compute VAT (15%), then post and submit to ZATCA." },
      "sales.invoices.detail": { ar: "تفاصيل فاتورة المبيعات", en: "Sales invoice detail", explainAr: "عرض كامل لفاتورة المبيعات: البنود، الإجماليات، حالة الترحيل، حالة ZATCA، والمرتجعات المرتبطة.", explainEn: "Full invoice view: lines, totals, posting status, ZATCA status, linked returns." },
      "sales.quotations":        { ar: "عروض أسعار المبيعات", en: "Sales quotations", explainAr: "إعداد عروض أسعار للعملاء وتحويلها لاحقاً إلى فاتورة مبيعات بضغطة زر.", explainEn: "Prepare customer quotations and later convert any of them into a sales invoice in one click." },
      "sales.quotations.new":    { ar: "عرض سعر مبيعات جديد", en: "New sales quotation", explainAr: "إنشاء عرض سعر لعميل: الأصناف، الأسعار، الصلاحية. ثم يمكن تحويله إلى فاتورة مبيعات.", explainEn: "Create a customer quotation: items, prices, validity. Later convert to a sales invoice." },
      "sales.quotations.detail": { ar: "تفاصيل عرض السعر", en: "Quotation detail", explainAr: "عرض/تعديل عرض سعر، تحويله إلى فاتورة، أو طباعته للعميل.", explainEn: "View/edit a quotation, convert it to an invoice, or print it for the customer." },
      "sales.orders":            { ar: "أوامر البيع", en: "Sales orders", explainAr: "كل أوامر البيع المعتمدة من العملاء قبل الفوترة.", explainEn: "All approved customer sales orders before invoicing." },
      "sales.orders.new":        { ar: "أمر بيع جديد", en: "New sales order", explainAr: "إنشاء أمر بيع لعميل قبل تحويله لاحقاً إلى فاتورة.", explainEn: "Create a customer sales order before later converting it to an invoice." },
      "sales.orders.detail":     { ar: "تفاصيل أمر البيع", en: "Sales order detail", explainAr: "عرض/تعديل أمر بيع وتحويله إلى فاتورة جاهزة للترحيل.", explainEn: "View/edit a sales order and convert it to a ready-to-post invoice." },
      "sales.returns":         { ar: "مرتجعات المبيعات", en: "Sales returns", explainAr: "تسجيل الأصناف المرتجعة من العملاء مع التأثير التلقائي على المخزون والقيد المحاسبي.", explainEn: "Record items returned by customers with automatic inventory and journal-entry impact." },
      "sales.settlements":     { ar: "تسويات العملاء", en: "Customer settlements", explainAr: "ربط الفواتير بالمدفوعات لتسوية أرصدة العملاء.", explainEn: "Match invoices with payments to settle customer balances." },
      "sales.reps":            { ar: "مندوبو المبيعات", en: "Sales reps", explainAr: "إدارة المندوبين، عمولاتهم وأهدافهم البيعية.", explainEn: "Manage sales reps, their commissions and quotas." },
      "sales.reports":         { ar: "تقارير المبيعات", en: "Sales reports", explainAr: "تقارير شاملة: أعلى العملاء، أعلى الأصناف، تطور المبيعات، الأرباح، تحليل الفواتير.", explainEn: "Comprehensive reports: top customers, top items, sales trend, profit, invoice analysis." },
      "sales.customers.list":   { ar: "قائمة العملاء", en: "Customers list", explainAr: "كل العملاء، أرصدتهم، حدودهم الائتمانية، وفواتيرهم.", explainEn: "All customers with balances, credit limits and invoices." },
      "sales.customers.new":    { ar: "عميل جديد", en: "New customer", explainAr: "إضافة عميل: البيانات الأساسية، الرقم الضريبي (15 رقم يبدأ وينتهي بـ 3)، العنوان (إلزامي للـ B2B)، حد الائتمان.", explainEn: "Add a customer: profile, VAT number (15 digits starting/ending with 3), address (required for B2B), credit limit." },
      "sales.customers.detail": { ar: "بطاقة العميل", en: "Customer card", explainAr: "بطاقة العميل: الفواتير، المدفوعات، الرصيد، كشف حساب، وأهم المؤشرات.", explainEn: "Customer profile: invoices, payments, balance, statement and key indicators." },

      // ── Purchasing ───────────────────────────────────────────────────
      "purchasing.module":            { ar: "وحدة المشتريات", en: "Purchasing module", explainAr: "إدارة الموردين، فواتير الشراء، المرتجعات والتسويات.", explainEn: "Manage suppliers, purchase invoices, returns and settlements." },
      "purchasing.invoices.list":     { ar: "قائمة فواتير الشراء", en: "Purchase invoices list", explainAr: "كل فواتير الشراء مع الفلترة والتصدير وحالة الدفع.", explainEn: "All purchase invoices with filtering, export and payment status." },
      "purchasing.invoices.new":      { ar: "فاتورة شراء جديدة", en: "New purchase invoice", explainAr: "تسجيل فاتورة من مورد: الأصناف، الضريبة، أثرها على المخزون والذمم الدائنة.", explainEn: "Record a supplier invoice: items, VAT, impact on inventory and payables." },
      "purchasing.invoices.detail":   { ar: "تفاصيل فاتورة الشراء", en: "Purchase invoice detail", explainAr: "عرض كامل لفاتورة الشراء، حالة الدفع والمرتجعات.", explainEn: "Full purchase-invoice view, payment status and returns." },
      "purchasing.orders":            { ar: "أوامر الشراء", en: "Purchase orders", explainAr: "كل أوامر الشراء المرسلة للموردين قبل استلام الفاتورة.", explainEn: "All purchase orders sent to suppliers before receiving the invoice." },
      "purchasing.orders.new":        { ar: "أمر شراء جديد", en: "New purchase order", explainAr: "إنشاء أمر شراء لمورد قبل استلام البضاعة وفاتورة الشراء.", explainEn: "Create a purchase order to a supplier before receiving goods and invoice." },
      "purchasing.orders.detail":     { ar: "تفاصيل أمر الشراء", en: "Purchase order detail", explainAr: "عرض/تعديل أمر الشراء وتحويله لاحقاً إلى فاتورة شراء.", explainEn: "View/edit a purchase order and later convert it into a purchase invoice." },
      "purchasing.lc":                { ar: "الاعتمادات المستندية (LC)", en: "Letters of credit (LC)", explainAr: "إدارة الاعتمادات المستندية للمشتريات الأجنبية، مرفقاتها وقيود فتحها وتسويتها.", explainEn: "Manage letters of credit for foreign purchases — documents and journal entries on opening/settlement." },
      "purchasing.supplierGroups":    { ar: "مجموعات الموردين", en: "Supplier groups", explainAr: "تصنيف الموردين في مجموعات لتسهيل الفلترة والتقارير.", explainEn: "Group suppliers for easier filtering and reporting." },
      "purchasing.returns":           { ar: "مرتجعات المشتريات", en: "Purchase returns", explainAr: "إرجاع أصناف للمورد مع تأثيرها التلقائي على المخزون والذمم.", explainEn: "Return items to a supplier with automatic stock and AP impact." },
      "purchasing.settlements":       { ar: "تسويات الموردين", en: "Supplier settlements", explainAr: "ربط فواتير الشراء بالمدفوعات لتسوية أرصدة الموردين.", explainEn: "Match purchase invoices with payments to settle supplier balances." },
      "purchasing.reports":           { ar: "تقارير المشتريات", en: "Purchasing reports", explainAr: "تحليلات المشتريات حسب المورد والصنف، وأهم مؤشرات الأداء.", explainEn: "Purchasing analytics by supplier and item, plus key KPIs." },
      "purchasing.suppliers.list":    { ar: "قائمة الموردين", en: "Suppliers list", explainAr: "كل الموردين، أرصدتهم وفواتيرهم.", explainEn: "All suppliers with balances and invoices." },
      "purchasing.suppliers.new":     { ar: "مورد جديد", en: "New supplier", explainAr: "إضافة مورد: البيانات الأساسية، الرقم الضريبي والعنوان.", explainEn: "Add a supplier: profile, VAT number and address." },
      "purchasing.suppliers.detail":  { ar: "بطاقة المورد", en: "Supplier card", explainAr: "بطاقة المورد: الفواتير، المدفوعات، الرصيد، كشف حساب.", explainEn: "Supplier profile: invoices, payments, balance and statement." },

      // ── Cash & banks ────────────────────────────────────────────────
      "cash.module":           { ar: "وحدة الخزائن والبنوك", en: "Cash & banks module", explainAr: "إدارة الخزائن، البنوك، سندات القبض والصرف وتسوياتها.", explainEn: "Manage cash boxes, bank accounts, receipt/payment vouchers and reconciliations." },
      "cash.boxes":            { ar: "الخزائن", en: "Cash boxes", explainAr: "تعريف خزائن الشركة وأرصدتها، وقيود فتح الخزينة.", explainEn: "Define company cash boxes and their opening balances." },
      "cash.banks":            { ar: "الحسابات البنكية", en: "Bank accounts", explainAr: "تعريف الحسابات البنكية، أرصدتها وحركاتها.", explainEn: "Set up bank accounts, balances and movements." },
      "cash.receiptVouchers":  { ar: "سندات القبض", en: "Receipt vouchers", explainAr: "تسجيل المبالغ الواردة من العملاء أو غيرهم وربطها بفواتير.", explainEn: "Record incoming payments from customers and link them to invoices." },
      "cash.paymentVouchers":  { ar: "سندات الصرف", en: "Payment vouchers", explainAr: "تسجيل المبالغ المدفوعة للموردين أو المصروفات وربطها بفواتير.", explainEn: "Record outgoing payments to suppliers or expenses and link them to invoices." },
      "cash.transfers":        { ar: "التحويلات بين الخزائن والبنوك", en: "Cash/bank transfers", explainAr: "نقل أموال بين خزينة وأخرى أو بين حسابين بنكيين مع توليد قيد محاسبي تلقائي.", explainEn: "Move money between cash boxes or bank accounts with an automatic journal entry." },
      "cash.reports":          { ar: "تقارير الخزائن والبنوك", en: "Cash & bank reports", explainAr: "كشوف حركات الخزائن والبنوك، التدفق النقدي والأرصدة.", explainEn: "Cash/bank statements, cash flow and balances." },

      // ── Inventory ───────────────────────────────────────────────────
      "inventory.module":           { ar: "وحدة المخزون", en: "Inventory module", explainAr: "إدارة الأصناف، المخازن، التحويلات، التسويات والجرد.", explainEn: "Manage items, warehouses, transfers, adjustments and stock counts." },
      "inventory.items.list":       { ar: "قائمة الأصناف", en: "Items list", explainAr: "كل أصناف الشركة، أرصدتها في كل مخزن، أسعارها وتصنيفاتها.", explainEn: "All items with per-warehouse balances, prices and categories." },
      "inventory.items.new":        { ar: "صنف جديد", en: "New item", explainAr: "إضافة صنف: الكود، الباركود، الوحدات، أسعار البيع/الشراء، حساب المخزون المرتبط.", explainEn: "Add an item: code, barcode, units, sales/cost prices, linked inventory account." },
      "inventory.items.detail":     { ar: "بطاقة الصنف", en: "Item card", explainAr: "بطاقة الصنف: الأرصدة، الحركات، التكلفة، نقاط إعادة الطلب.", explainEn: "Item profile: balances, movements, cost, reorder points." },
      "inventory.itemGroups":       { ar: "مجموعات الأصناف", en: "Item groups", explainAr: "تصنيف الأصناف في مجموعات لتسهيل الفلترة وربط الحسابات المحاسبية.", explainEn: "Group items into categories for easier filtering and accounting account mapping." },
      "inventory.units":            { ar: "وحدات القياس", en: "Units of measure", explainAr: "تعريف الوحدات الأساسية والوحدات البديلة (مثل صندوق = 12 قطعة) لكل صنف.", explainEn: "Define base and alternate units (e.g. box = 12 pcs) for items." },
      "inventory.warehouses":       { ar: "المخازن", en: "Warehouses", explainAr: "تعريف مخازن الشركة، أمناءها وحساباتها المحاسبية.", explainEn: "Define warehouses, their keepers and linked accounting accounts." },
      "inventory.warehouseGroups":  { ar: "مجموعات المخازن", en: "Warehouse groups", explainAr: "تجميع المخازن في مناطق/فروع لإدارة الصلاحيات والتقارير بسهولة.", explainEn: "Group warehouses into regions/branches for permissions and reporting." },
      "inventory.offers":           { ar: "العروض الترويجية", en: "Promotional offers", explainAr: "تعريف عروض الأصناف (خصومات، اشترِ X واحصل على Y) وتفعيلها لفترات محددة.", explainEn: "Define item promotions (discounts, buy-X-get-Y) active for a date range." },
      "inventory.offers.new":       { ar: "عرض ترويجي جديد", en: "New promotional offer", explainAr: "إنشاء عرض جديد: نوعه، الأصناف المؤهلة، فترة السريان، نسبة/قيمة الخصم.", explainEn: "Create a new offer: type, eligible items, validity dates, discount %/amount." },
      "inventory.offers.detail":    { ar: "تفاصيل العرض الترويجي", en: "Promotional offer detail", explainAr: "عرض/تعديل عرض ترويجي قائم وتفعيله أو إيقافه.", explainEn: "View/edit an existing promotional offer and enable/disable it." },
      "inventory.transfers":        { ar: "التحويلات بين المخازن", en: "Stock transfers", explainAr: "نقل أصناف من مخزن لآخر مع توليد قيد محاسبي تلقائي.", explainEn: "Move items between warehouses with an automatic journal entry." },
      "inventory.transfers.new":    { ar: "تحويل مخزني جديد", en: "New stock transfer", explainAr: "إصدار سند تحويل من مخزن إلى آخر مع تسجيل التكلفة وتأثيرها على الأرصدة.", explainEn: "Issue a new transfer from one warehouse to another, recording cost and balance impact." },
      "inventory.adjustments":      { ar: "تسويات المخزون", en: "Stock adjustments", explainAr: "تسوية الفروق (تالف/فاقد/فائض) مع توليد قيد محاسبي تلقائي.", explainEn: "Reconcile differences (damaged/missing/surplus) with auto journal entry." },
      "inventory.adjustments.new":  { ar: "تسوية مخزون جديدة", en: "New stock adjustment", explainAr: "تسجيل تسوية يدوية لزيادة/نقص رصيد صنف مع سبب وحساب محاسبي.", explainEn: "Record a manual adjustment to increase/decrease an item's balance with a reason and account." },
      "inventory.counts":           { ar: "الجرد", en: "Stock counts", explainAr: "جرد دوري للأصناف ومقارنة الفعلي بالنظري وإصدار تسوية تلقائية بالفروق.", explainEn: "Periodic stock-takes comparing physical vs. system and producing an adjustment for the variance." },
      "inventory.counts.new":       { ar: "جرد مخزني جديد", en: "New stock count", explainAr: "بدء عملية جرد جديدة: اختيار المخزن والأصناف وتسجيل الكميات الفعلية.", explainEn: "Start a new stock-take: pick warehouse and items, then record physical quantities." },
      "inventory.ledger":           { ar: "حركات المخزون (الأستاذ المخزني)", en: "Stock ledger", explainAr: "كل الحركات الواردة والصادرة لكل صنف عبر الزمن مع التكلفة.", explainEn: "Every inbound/outbound movement per item over time, with cost." },
      "inventory.balance":          { ar: "أرصدة المخزون", en: "Stock balances", explainAr: "الرصيد الحالي لكل صنف في كل مخزن مع متوسط التكلفة.", explainEn: "Current balance per item per warehouse, with average cost." },
      "inventory.reports":          { ar: "تقارير المخزون", en: "Inventory reports", explainAr: "تقارير الحركات، الأرصدة، التكلفة، عمر المخزون والصلاحية.", explainEn: "Movement, balance, cost, ageing and expiry reports." },

      // ── Accounting ──────────────────────────────────────────────────
      "accounting.module":                 { ar: "وحدة المحاسبة", en: "Accounting module", explainAr: "إدارة دليل الحسابات، القيود اليومية، التقارير المالية.", explainEn: "Manage chart of accounts, journal entries and financial reports." },
      "accounting.chart":                  { ar: "دليل الحسابات", en: "Chart of accounts", explainAr: "تنظيم حسابات الشركة في شجرة (أصول، خصوم، ملكية، إيرادات، مصروفات). الحسابات الترحيلية فقط هي التي تُستخدم في القيود.", explainEn: "Organize accounts as a tree (assets, liabilities, equity, revenue, expenses). Only posting accounts are used in entries." },
      "accounting.costCenters":            { ar: "مراكز التكلفة", en: "Cost centers", explainAr: "تعريف مراكز التكلفة وتوزيع المصروفات والإيرادات عليها لتقارير الربحية.", explainEn: "Define cost centers and allocate expenses/revenue to them for profitability reporting." },
      "accounting.fiscalPeriods":          { ar: "الفترات المحاسبية", en: "Fiscal periods", explainAr: "تعريف السنوات والفترات المحاسبية وإقفالها لمنع التعديل بعد الإقفال.", explainEn: "Define fiscal years and periods, then close them to lock entries after the cut-off." },
      "accounting.journalEntries.list":    { ar: "قائمة القيود اليومية", en: "Journal entries list", explainAr: "كل القيود اليدوية والآلية مع إمكانية الفلترة والترحيل والعكس.", explainEn: "All manual & automatic journal entries with filter, post and reverse." },
      "accounting.journalEntries.new":     { ar: "قيد يومية جديد", en: "New journal entry", explainAr: "تسجيل قيد محاسبي يدوي: اختيار الفرع، إضافة الأطراف المدينة والدائنة (يجب أن يتساوى الجانبان)، ثم الحفظ والترحيل.", explainEn: "Record a manual journal entry: pick branch, add debit/credit lines (sides must balance), then save and post." },
      "accounting.journalEntries.detail":  { ar: "تفاصيل القيد", en: "Journal entry detail", explainAr: "عرض/تعديل قيد محاسبي قائم. تأكد من تساوي المدين والدائن قبل الترحيل.", explainEn: "View/edit an existing journal entry. Ensure debits = credits before posting." },
      "accounting.reports":                { ar: "التقارير المحاسبية", en: "Accounting reports", explainAr: "ميزان المراجعة، الأستاذ العام، قائمة الدخل، الميزانية، التدفقات النقدية.", explainEn: "Trial balance, general ledger, income statement, balance sheet and cash flow." },

      // ── HR ──────────────────────────────────────────────────────────
      "hr.module":               { ar: "وحدة الموارد البشرية", en: "HR module", explainAr: "إدارة الموظفين، الرواتب، الحضور والإجازات.", explainEn: "Manage employees, payroll, attendance and leaves." },
      "hr.employees.list":       { ar: "قائمة الموظفين", en: "Employees list", explainAr: "كل الموظفين، حالتهم الوظيفية، قسمهم وراتبهم الأساسي.", explainEn: "All employees with status, department and base salary." },
      "hr.employees.new":        { ar: "موظف جديد", en: "New employee", explainAr: "إضافة موظف: البيانات الشخصية، التعاقد، الراتب، الفرع، البدلات والاستقطاعات الافتراضية.", explainEn: "Add an employee: personal info, contract, salary, branch, default allowances and deductions." },
      "hr.employees.detail":     { ar: "ملف الموظف", en: "Employee profile", explainAr: "بطاقة الموظف: البيانات، عقد العمل، تاريخ الرواتب، الإجازات، الحضور.", explainEn: "Employee profile: details, contract, payroll history, leaves and attendance." },
      "hr.employees.contracts":  { ar: "عقود الموظف", en: "Employee contracts", explainAr: "عقود العمل الخاصة بالموظف: الراتب، البدلات، تاريخ البداية والنهاية، التجديدات.", explainEn: "This employee's work contracts: salary, allowances, start/end dates and renewals." },
      "hr.contracts":            { ar: "كل العقود", en: "All contracts", explainAr: "قائمة بكل عقود الموظفين عبر المؤسسة، حالاتها وتواريخ تجديدها.", explainEn: "All employee contracts across the company, their statuses and renewal dates." },
      "hr.payroll":              { ar: "الرواتب", en: "Payroll", explainAr: "إعداد كشف الرواتب الشهري وترحيله محاسبياً (مع ربطه بالفرع).", explainEn: "Generate monthly payroll runs and post them to accounting (linked to branch)." },
      "hr.attendance":           { ar: "الحضور والانصراف", en: "Attendance", explainAr: "تسجيل ساعات الحضور والانصراف وحساب الإضافي والخصومات.", explainEn: "Record attendance hours and compute overtime/deductions." },
      "hr.leaves":               { ar: "الإجازات", en: "Leaves", explainAr: "طلبات الإجازات وموافقاتها وتأثيرها على رصيد كل موظف.", explainEn: "Leave requests, approvals and their effect on each employee's balance." },
      "hr.loans":                { ar: "السلف والقروض", en: "Loans & advances", explainAr: "تسجيل السلف والقروض الممنوحة للموظفين وجدولة استقطاعها من الراتب.", explainEn: "Record employee advances/loans and schedule monthly deductions from payroll." },
      "hr.eos":                  { ar: "مكافأة نهاية الخدمة", en: "End-of-service", explainAr: "حساب مكافأة نهاية الخدمة وفق نظام العمل السعودي عند انتهاء عقد الموظف.", explainEn: "Compute end-of-service award per Saudi labor law when an employee's contract ends." },
      "hr.calculators":          { ar: "حاسبات الموارد البشرية", en: "HR calculators", explainAr: "حاسبات سريعة: نهاية الخدمة، صافي الراتب، الإجازات، التأمينات.", explainEn: "Quick calculators: end-of-service, net salary, leaves, GOSI." },
      "hr.settings":             { ar: "إعدادات الموارد البشرية", en: "HR settings", explainAr: "إعدادات قواعد الرواتب، الإجازات، أيام العمل وحساب نهاية الخدمة.", explainEn: "Settings for payroll rules, leaves, work days and end-of-service calculation." },
      "hr.reports":              { ar: "تقارير الموارد البشرية", en: "HR reports", explainAr: "تقارير الموظفين، الرواتب، الحضور، العقود، الإجازات والسلف.", explainEn: "Reports on employees, payroll, attendance, contracts, leaves and loans." },

      // ── Production ──────────────────────────────────────────────────
      "production.module":         { ar: "وحدة الإنتاج", en: "Production module", explainAr: "إدارة أوامر الإنتاج، الموارد والخامات.", explainEn: "Manage production orders, resources and raw materials." },
      "production.orders.list":    { ar: "قائمة أوامر الإنتاج", en: "Production orders list", explainAr: "كل أوامر الإنتاج وحالتها (مسودة → معتمد → قيد الإنتاج → فحص الجودة → مكتمل).", explainEn: "All production orders and their status (draft → approved → in-production → QC → completed)." },
      "production.orders.new":     { ar: "أمر إنتاج جديد", en: "New production order", explainAr: "إنشاء أمر إنتاج: المنتج النهائي، الكمية المخططة، الخامات والموارد المطلوبة.", explainEn: "Create a production order: finished product, planned qty, raw materials and resources." },
      "production.orders.detail":  { ar: "تفاصيل أمر الإنتاج", en: "Production order detail", explainAr: "تفاصيل أمر الإنتاج: الخامات، الموارد، الأحداث، التكلفة الفعلية مقابل المقدّرة.", explainEn: "Production order detail: materials, resources, events, actual vs estimated cost." },
      "production.resources":      { ar: "موارد الإنتاج", en: "Production resources", explainAr: "تعريف الماكينات وخطوط الإنتاج، طاقتها الإنتاجية وأوقات توقفها.", explainEn: "Define machines/production lines, their capacity and downtime." },
      "production.dashboard":      { ar: "لوحة معلومات الإنتاج", en: "Production dashboard", explainAr: "مؤشرات أداء الإنتاج: أوامر مفتوحة، إنتاج اليوم، نسبة الهالك، استغلال الموارد.", explainEn: "Production KPIs: open orders, today's output, waste %, resource utilization." },

      // ── ZATCA ───────────────────────────────────────────────────────
      "zatca.module":         { ar: "ZATCA — الفاتورة الإلكترونية", en: "ZATCA e-invoicing", explainAr: "إعدادات ZATCA Phase 2: الشهادات، الإرسال الفوري، السجل والملخصات.", explainEn: "ZATCA Phase 2 settings: certificates, real-time submission, log and summaries." },
      "zatca.bridge":         { ar: "جسر ZATCA", en: "ZATCA bridge", explainAr: "إعدادات الاتصال بـ ZATCA، تسجيل CSID، حالة الشهادة، إعادة المحاولة للفواتير المرفوضة.", explainEn: "ZATCA connectivity setup, CSID enrollment, certificate status, retry for rejected invoices." },
      "zatca.report":         { ar: "تقرير ZATCA", en: "ZATCA report", explainAr: "تقرير الفواتير المرسلة لـ ZATCA: المقبولة، المرفوضة، أسباب الرفض، إجراءات الإصلاح.", explainEn: "Report of invoices submitted to ZATCA: accepted, rejected, reasons and fix actions." },
      "zatca.vatDeclaration": { ar: "إقرار ضريبة القيمة المضافة", en: "VAT declaration", explainAr: "إعداد إقرار ضريبة القيمة المضافة (ضريبة المخرجات والمدخلات) للفترة المحددة.", explainEn: "Prepare the VAT return (output & input VAT) for the chosen period." },

      // ── Org & settings ──────────────────────────────────────────────
      "org.users":                    { ar: "المستخدمون", en: "Users", explainAr: "إدارة مستخدمي الشركة، صلاحياتهم وفروعهم.", explainEn: "Manage company users, their permissions and assigned branches." },
      "org.branches":                 { ar: "الفروع", en: "Branches", explainAr: "تعريف فروع الشركة. كل قيد محاسبي وكل مستند مرتبط بفرع.", explainEn: "Define company branches. Every journal entry and document is tagged to a branch." },
      "org.regions":                  { ar: "المناطق", en: "Regions", explainAr: "تعريف مناطق جغرافية تجمع الفروع لتسهيل تقارير المبيعات والمصروفات بحسب المنطقة.", explainEn: "Define geographic regions that group branches for region-based sales/expense reports." },
      "org.roles":                    { ar: "الأدوار والصلاحيات", en: "Roles & permissions", explainAr: "إنشاء أدوار جاهزة للصلاحيات وتطبيقها على المستخدمين.", explainEn: "Define permission roles and apply them to users." },
      "org.settings":                 { ar: "إعدادات المنظمة", en: "Organization settings", explainAr: "بيانات الشركة، الفروع، المستخدمين، اللغة الافتراضية.", explainEn: "Company info, branches, users and default language." },
      "settings.general":             { ar: "الإعدادات العامة", en: "General settings", explainAr: "إعدادات التطبيق العامة: اللغة، التاريخ، التقريب، طباعة المستندات.", explainEn: "General app settings: language, date, rounding, document printing." },
      "settings.currencies":          { ar: "العملات", en: "Currencies", explainAr: "تعريف العملات، أسعار الصرف وعملة الشركة الأساسية.", explainEn: "Define currencies, exchange rates and the company's base currency." },
      "settings.accountingMappings":  { ar: "ربط الحسابات المحاسبية", en: "Accounting mappings", explainAr: "ربط أنواع المستندات (مبيعات، مشتريات، خزينة...) بحسابات افتراضية في دليل الحسابات.", explainEn: "Map document types (sales, purchases, cash…) to default accounts in the chart." },
      "settings.dataIo":              { ar: "استيراد وتصدير البيانات", en: "Data import & export", explainAr: "استيراد بيانات أساسية (عملاء/أصناف/قيود) من Excel/CSV، أو تصدير بيانات النظام.", explainEn: "Import master data (customers/items/journal entries) from Excel/CSV, or export system data." },
      "settings.sequences":           { ar: "تسلسل المستندات", en: "Document sequences", explainAr: "تخصيص أرقام المستندات (الفواتير، القيود، السندات...) — البادئة، الطول، البداية.", explainEn: "Customize document numbering (invoices, journals, vouchers…) — prefix, padding, starting number." },
      "settings.other":               { ar: "إعدادات أخرى", en: "Other settings", explainAr: "إعدادات إضافية للنظام.", explainEn: "Additional system settings." },

      // ── POS ──────────────────────────────────────────────────────────
      "pos.monitoring": { ar: "مراقبة نقاط البيع", en: "POS monitoring", explainAr: "متابعة جلسات نقاط البيع المفتوحة، المبيعات اللحظية وحالة الأجهزة.", explainEn: "Monitor open POS sessions, real-time sales and device status." },
      "pos.settings":   { ar: "إعدادات نقاط البيع", en: "POS settings", explainAr: "إعدادات نقاط البيع: المخازن المرتبطة، طرق الدفع، الطباعة، المستخدمون.", explainEn: "POS settings: linked warehouses, payment methods, printing, users." },
      "pos.terminals":  { ar: "أجهزة نقاط البيع", en: "POS terminals", explainAr: "تعريف أجهزة نقاط البيع، أرقامها التسلسلية، حالتها وموقعها.", explainEn: "Define POS terminals, their serial numbers, status and location." },

      // ── Super admin (kept short) ────────────────────────────────────
      "admin.registrationRequests": { ar: "طلبات تسجيل الشركات", en: "Company registration requests", explainAr: "مراجعة طلبات تسجيل الشركات الجديدة والموافقة عليها.", explainEn: "Review and approve new company registration requests." },
      "admin.subscriptions":        { ar: "الاشتراكات", en: "Subscriptions", explainAr: "إدارة اشتراكات الشركات، تجديدها وإلغاؤها.", explainEn: "Manage company subscriptions, renewals and cancellations." },
      "admin.plans":                { ar: "الخطط", en: "Plans", explainAr: "تعريف خطط الاشتراك وأسعارها وحدودها.", explainEn: "Define subscription plans, prices and limits." },
      "admin.menuPermissions":      { ar: "صلاحيات القوائم", en: "Menu permissions", explainAr: "تحديد القوائم المرئية لكل خطة اشتراك.", explainEn: "Pick which menus are visible per subscription plan." },
      "admin.modules":              { ar: "الموديولات", en: "Modules", explainAr: "تفعيل/تعطيل موديولات النظام لكل شركة.", explainEn: "Enable/disable modules per company." },
      "admin.licenses":             { ar: "التراخيص", en: "Licenses", explainAr: "إدارة تراخيص الشركات، توليدها وتجديدها.", explainEn: "Manage company licenses, generation and renewal." },
      "admin.security":             { ar: "مركز الأمان", en: "Security center", explainAr: "إعدادات الأمان، السياسات وتدقيق العمليات.", explainEn: "Security settings, policies and audit." },
      "admin.reports":              { ar: "تقارير الإدارة", en: "Admin reports", explainAr: "تقارير أداء الشركات، الإيرادات، استخدام الخطط.", explainEn: "Reports on company performance, revenue and plan usage." },
      "admin.backups":              { ar: "النسخ الاحتياطية", en: "Backups", explainAr: "إدارة النسخ الاحتياطية للنظام واستعادتها.", explainEn: "Manage system backups and restores." },
      "admin.orphanStock":          { ar: "تنظيف الأصناف اليتيمة", en: "Orphan stock cleanup", explainAr: "اكتشاف وتنظيف أرصدة المخزون اليتيمة (بدون صنف فعلي).", explainEn: "Detect and clean orphan stock balances (without a real item)." },
      "admin.aiCompanyFix":         { ar: "تصحيح بيانات الشركة بالذكاء الاصطناعي", en: "AI company fix", explainAr: "اقتراحات ذكية لإصلاح اختلالات بيانات الشركة.", explainEn: "AI suggestions to fix data integrity issues for a company." },
      "admin.support":              { ar: "صندوق الدعم", en: "Support inbox", explainAr: "رسائل الدعم الواردة من الشركات والرد عليها.", explainEn: "Incoming support messages from companies and replies." },
      "admin.auditLog":             { ar: "سجل التدقيق", en: "Audit log", explainAr: "سجل كامل لكل العمليات الحساسة.", explainEn: "Full audit trail of every sensitive operation." },
      "admin.companies":            { ar: "الشركات", en: "Companies", explainAr: "كل الشركات المسجلة في المنصة.", explainEn: "All companies registered on the platform." },
      "admin.companyNew":           { ar: "شركة جديدة", en: "New company", explainAr: "إنشاء شركة جديدة يدوياً.", explainEn: "Create a new company manually." },
      "admin.companyDetails":       { ar: "تفاصيل الشركة", en: "Company details", explainAr: "بطاقة الشركة: الاشتراك، المستخدمون، الاستخدام، البيانات.", explainEn: "Company card: subscription, users, usage and data." },
    };
    const label = screenLabels[screenContext] ?? {
      ar: "هذه الشاشة",
      en: "this screen",
      explainAr: "هذه شاشة من النظام. اقرأ العناوين والأزرار لتعرف العملية المتاحة، أو اطرح سؤالاً محدداً عن الشاشة في الأسفل.",
      explainEn: "This is one of the system screens. Read the page title and action buttons to learn what it does, or ask a specific question about it below.",
    };
    const fallback = () => {
      // Production-detail fallback keeps its old, snapshot-aware behaviour
      // so the experience on the production module is unchanged.
      if (snapshot) {
        if (lang === "en") {
          return {
            explanation: `${label.en}. ${label.explainEn}`,
            suggestion: `Order ${snapshot.orderNumber} is currently in "${snapshot.status}". Make sure all raw materials are listed and a resource is assigned before approving.`,
            next_step: "Click the status button on the right to advance the order to the next stage when ready.",
            warning_if_any:
              Number(snapshot.wasteQty) > 0 && Number(snapshot.producedQty) === 0
                ? "Waste was recorded but no produced quantity yet — double-check the run."
                : "",
            source: "fallback" as const,
          };
        }
        return {
          explanation: `${label.ar}. ${label.explainAr}`,
          suggestion: `الأمر ${snapshot.orderNumber} حالته الآن "${snapshot.status}". تأكد من إدراج كل الخامات وتخصيص مورد قبل الاعتماد.`,
          next_step: "اضغط زر الحالة على اليسار لتمرير الأمر إلى المرحلة التالية عندما يصبح جاهزاً.",
          warning_if_any:
            Number(snapshot.wasteQty) > 0 && Number(snapshot.producedQty) === 0
              ? "تم تسجيل كمية هالك بدون أي إنتاج فعلي — راجع التشغيلة."
              : "",
          source: "fallback" as const,
        };
      }
      // Generic per-screen fallback for every other screen.
      if (lang === "en") {
        return {
          explanation: `${label.en}: ${label.explainEn}`,
          suggestion: "Use the search/filter at the top to narrow down the list, or click the primary button (top-right in RTL / top-left in LTR) to add a new record.",
          next_step: "Pick an item from the list to view its details, or ask me a specific question about this screen using the input below.",
          warning_if_any: "",
          source: "fallback" as const,
        };
      }
      return {
        explanation: `${label.ar}: ${label.explainAr}`,
        suggestion: "استخدم البحث/التصفية بالأعلى لتضييق القائمة، أو اضغط الزر الرئيسي (أعلى الصفحة) لإضافة سجل جديد.",
        next_step: "اختر سجلاً من القائمة لعرض تفاصيله، أو اسألني سؤالاً محدداً عن الشاشة من خلال المربع بالأسفل.",
        warning_if_any: "",
        source: "fallback" as const,
      };
    };

    if (!OPENAI_BASE || !OPENAI_KEY) {
      res.json(fallback());
      return;
    }

    // Generic, screen-agnostic system prompt: applies equally well to sales,
    // purchasing, accounting, inventory, HR, production, ZATCA, etc. The
    // backend tells the model the current screen ID via `screen_context`.
    const sysPrompt =
      lang === "en"
        ? "You are an embedded assistant inside a Saudi multi-tenant ERP that covers sales, purchasing, inventory, accounting, HR, production and ZATCA e-invoicing. You explain the screen the user is on, suggest the next concrete step, and flag risks. Always reply with a JSON object containing exactly these fields: explanation, suggestion, next_step, warning_if_any. Be concise (2-3 sentences per field max). Use practical, business-friendly language — no jargon. When the screen_context is unfamiliar, derive guidance from the route segments themselves."
        : "أنت مساعد ذكي مدمج داخل نظام ERP سعودي متعدد المستأجرين يشمل المبيعات والمشتريات والمخزون والمحاسبة والموارد البشرية والإنتاج والفاتورة الإلكترونية (ZATCA). مهمتك شرح الشاشة التي يقف عندها المستخدم، اقتراح الخطوة التالية الملموسة، وتنبيهه من أي مخاطرة. ترد دائماً بـ JSON بهذا الشكل بالضبط: explanation, suggestion, next_step, warning_if_any. كن مختصراً (٢-٣ جمل لكل حقل كحد أقصى) واستخدم لغة عملية مفهومة بدون مصطلحات تقنية. إذا كان screen_context غير معروف لك، استنبط الإرشاد من أجزاء المسار نفسها.";

    const userPrompt = JSON.stringify(
      {
        screen_context: screenContext,
        current_action: currentAction,
        user_message: userMessage,
        order_snapshot: snapshot,
      },
      null,
      2,
    );

    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!r.ok) {
      res.json(fallback());
      return;
    }
    const data = await r.json();
    let parsed: any = {};
    try {
      parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
    } catch {
      res.json(fallback());
      return;
    }
    const fb = fallback();
    res.json({
      explanation: String(parsed.explanation ?? fb.explanation),
      suggestion: String(parsed.suggestion ?? fb.suggestion),
      next_step: String(parsed.next_step ?? fb.next_step),
      warning_if_any: String(parsed.warning_if_any ?? fb.warning_if_any ?? ""),
      source: "ai" as const,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "AI assistant error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/ai/command — voice/text → screen actions
// ─────────────────────────────────────────────────────────────────────────
// Accepts the same screen_context plus a description of what's controllable
// on the current screen (fields + actions + lookup data) and the current
// form state. Returns:
//   { message: string, commands: Command[] }
// where each Command is one of:
//   { type: "set_field", field: <name>, value: <any> }
//   { type: "call_action", action: <name>, params: { ... } }
// The frontend executes them in order against its registered handlers.
//
// When the AI is unavailable or returns an unparseable response, we return
// an empty command list with a graceful message — the user can still get a
// passive explanation through /api/ai/assist.
// ─────────────────────────────────────────────────────────────────────────
router.post("/command", async (req, res) => {
  try {
    const userMessage = String(req.body?.user_message ?? "").slice(0, 2000);
    const screenContext = String(req.body?.screen_context ?? "").slice(0, 200);
    const lang = String(req.body?.lang ?? "ar");
    const screenState = sanitizeJson(req.body?.screen_state, 8000);
    const availableFields = Array.isArray(req.body?.available_fields)
      ? req.body.available_fields.slice(0, 60)
      : [];
    const availableActions = Array.isArray(req.body?.available_actions)
      ? req.body.available_actions.slice(0, 30)
      : [];
    const lookups = sanitizeJson(req.body?.lookups, 60_000);
    const screenDescription = String(req.body?.screen_description ?? "").slice(0, 500);
    const availableRoutes = Array.isArray(req.body?.available_routes)
      ? req.body.available_routes.slice(0, 200)
      : [];
    const uiSnapshot = sanitizeJson(req.body?.ui_snapshot, 12000) ?? {
      buttons: [],
      inputs: [],
      comboboxes: [],
    };

    if (!userMessage.trim()) {
      res.json({
        message:
          lang === "en"
            ? "Please describe what you'd like me to do."
            : "اكتب أو انطق ما تريد أن أنفذه على الشاشة.",
        commands: [],
        source: "fallback",
      });
      return;
    }

    // The model now has GLOBAL capabilities (navigate, click, type, select)
    // available on every screen. So "no actionable" only refers to the
    // screen-scoped registration; the assistant is never inert.
    const fallbackMessage = () => ({
      message:
        lang === "en"
          ? "I couldn't reach the AI service. Please try again in a moment."
          : "تعذر الوصول للذكاء الاصطناعي حالياً. حاول مرة أخرى بعد قليل.",
      commands: [] as any[],
      source: "fallback" as const,
    });

    if (!OPENAI_BASE || !OPENAI_KEY) {
      res.json(fallbackMessage());
      return;
    }

    const sysPrompt =
      lang === "en"
        ? `You are an action planner embedded in a Saudi multi-tenant ERP. You drive the WHOLE app by voice or text — not just one form. The user is currently on screen "${screenContext}" and is talking to you in natural language. You are given:
  - the user's message
  - available_routes: every screen the user can navigate to (path + AR/EN labels + aliases)
  - ui_snapshot: visible buttons / inputs / comboboxes on the CURRENT screen, each with a label
  - available_fields / available_actions: extra structured fields and actions THIS screen has registered (only some screens do)
  - the current form state
  - lookup tables that map ids to human names (e.g. customers, items)
Your job is to return a JSON object:
  { "message": "<short reply in the user's language>",
    "commands": [ <ordered list of commands to execute> ] }
Allowed command shapes:
  { "type": "navigate",       "path": "<path from available_routes>", "label": "<short human label>" }
  { "type": "click",          "label": "<button text from ui_snapshot.buttons>" }            // optional: "testid"
  { "type": "double_click",   "label": "<button text>" }
  { "type": "type_text",      "label": "<input label from ui_snapshot.inputs>", "value": "<text to type>" }
  { "type": "select_option",  "label": "<combobox label>", "option": "<option text the user wants>" }
  { "type": "set_field",      "field": "<available_fields[].name>", "value": <validated value> }
  { "type": "call_action",    "action": "<available_actions[].name>", "params": { ... } }
Rules:
  1. NAVIGATION: when the user asks to "open", "go to", or names a screen ("افتح المبيعات", "go to inventory"), pick the best route from available_routes and emit a navigate command. After navigating, you may NOT issue further click/type commands in the same response — the new screen hasn't loaded yet; ask the user what to do next.
  2. CLICK / DOUBLE_CLICK: only use labels that appear (case-insensitively, partial match OK) in ui_snapshot.buttons. NEVER invent button text.
  3. TYPE_TEXT: only use labels from ui_snapshot.inputs. The value is the literal text to put in the field.
  4. SELECT_OPTION: only use labels from ui_snapshot.comboboxes. "option" is the visible option text the user wants picked.
  5. set_field / call_action: only when available_fields / available_actions includes that name. For lookup fields, resolve the human name to the lookup item's "id" string. For select fields, value MUST equal one of options[].value. Numbers as numbers, booleans as true/false.
  6. Plan a minimal, sensible sequence — fields before dependent actions, navigate before anything on the new screen (in a follow-up turn).
  7. If you can't fulfil the request (no matching route / button / field, ambiguous name, etc), return commands: [] and EXPLAIN in "message" what's missing or ask a clarifying question.
  8. NEVER invent route paths, field names, action names, button labels, or lookup ids.
  9. Reply "message" should be short (1-2 sentences), in the user's language.
 10. The user's message may be transcribed from speech — be tolerant of small typos and approximate names.`
        : `أنت مخطط إجراءات مدمج داخل نظام ERP سعودي متعدد المستأجرين. مهمتك التحكم في كامل التطبيق بالصوت أو الكتابة — وليس بنموذج واحد فقط. المستخدم حالياً على الشاشة "${screenContext}" ويتحدث معك بلغة طبيعية. تستلم:
  - رسالة المستخدم
  - available_routes: كل الشاشات التي يستطيع المستخدم الانتقال إليها (path + اسم عربي + اسم إنجليزي + مرادفات)
  - ui_snapshot: الأزرار وحقول الإدخال والقوائم المنسدلة الظاهرة الآن على الشاشة، مع label لكل عنصر
  - available_fields / available_actions: حقول وإجراءات إضافية سجّلتها هذه الشاشة (لا تتوفر في كل الشاشات)
  - حالة النموذج الحالية
  - جداول lookup تربط المعرفات بالأسماء البشرية (عملاء، أصناف...)
مهمتك إرجاع كائن JSON بهذا الشكل:
  { "message": "<رد قصير للمستخدم بلغته>",
    "commands": [ <قائمة مرتبة من الأوامر لتنفيذها> ] }
أنواع الأوامر المسموحة:
  { "type": "navigate",       "path": "<مسار من available_routes>", "label": "<اسم الشاشة>" }
  { "type": "click",          "label": "<نص الزر من ui_snapshot.buttons>" }
  { "type": "double_click",   "label": "<نص الزر>" }
  { "type": "type_text",      "label": "<اسم الحقل من ui_snapshot.inputs>", "value": "<النص المراد كتابته>" }
  { "type": "select_option",  "label": "<اسم القائمة>", "option": "<اسم الخيار الظاهر للمستخدم>" }
  { "type": "set_field",      "field": "<available_fields[].name>", "value": <قيمة موافقة لنوع الحقل> }
  { "type": "call_action",    "action": "<available_actions[].name>", "params": { ... } }
قواعد إلزامية:
  1. التنقل: لو طلب المستخدم "افتح/اذهب إلى/روح إلى" شاشة، اختر أنسب مسار من available_routes وأصدر أمر navigate. بعد التنقل لا تُصدر أوامر click/type/type_text في نفس الرد — الشاشة الجديدة لم تظهر بعد؛ اسأل المستخدم عن الخطوة التالية.
  2. النقر: استخدم فقط نصوص أزرار موجودة في ui_snapshot.buttons (تطابق غير حساس لحالة الأحرف، ويُقبل التطابق الجزئي). لا تخترع أبداً نص زر.
  3. type_text: استخدم فقط labels من ui_snapshot.inputs. القيمة هي النص الحرفي للكتابة في الحقل.
  4. select_option: استخدم فقط labels من ui_snapshot.comboboxes. "option" هو الخيار الظاهر الذي يريد المستخدم اختياره.
  5. set_field / call_action: فقط عندما يكون الاسم موجوداً فعلاً في available_fields / available_actions. الحقول من نوع lookup: حوّل الاسم البشري إلى id من جدول lookup كـ string. select: القيمة يجب أن تساوي إحدى options[].value. الأرقام كأرقام، booleans كـ true/false.
  6. خطّط تسلسلاً بسيطاً ومنطقياً — اضبط الحقول قبل الإجراءات المعتمدة عليها، وانتقل أولاً قبل أي شيء على الشاشة الجديدة (في رد لاحق).
  7. لو لم تستطع تنفيذ الطلب (لا يوجد route/زر/حقل مطابق، اسم غامض...) أعد commands: [] واشرح في message ما هو الناقص أو اسأل سؤالاً توضيحياً.
  8. لا تخترع مطلقاً مسارات أو أسماء حقول أو إجراءات أو نصوص أزرار أو معرفات lookup.
  9. message يجب أن تكون قصيرة (جملة أو جملتين) باللغة العربية.
 10. رسالة المستخدم قد تكون مُحوّلة من الصوت — تسامح مع الأخطاء الإملائية البسيطة وقارب الأسماء.`;

    const userPrompt = JSON.stringify(
      {
        screen_context: screenContext,
        screen_description: screenDescription,
        user_message: userMessage,
        available_routes: availableRoutes,
        ui_snapshot: uiSnapshot,
        available_fields: availableFields,
        available_actions: availableActions,
        screen_state: screenState,
        lookups,
      },
      null,
      2,
    );

    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!r.ok) {
      res.json(fallbackMessage());
      return;
    }
    const data = await r.json();
    let parsed: any = {};
    try {
      parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
    } catch {
      res.json(fallbackMessage());
      return;
    }

    // Build field-name → field-def map and lookup-key → id-set map so we can
    // value-validate the AI's commands here (defense in depth — the client
    // also re-validates, but stripping garbage at the boundary keeps the chat
    // log honest and prevents nonsense commands from reaching React state).
    const fieldDefs = new Map<string, any>(
      availableFields.filter((f: any) => f?.name).map((f: any) => [f.name, f]),
    );
    const actionNames = new Set(availableActions.map((a: any) => a?.name).filter(Boolean));
    const lookupIdSets: Record<string, Set<string>> = {};
    if (lookups && typeof lookups === "object") {
      for (const [key, list] of Object.entries(lookups as Record<string, any[]>)) {
        if (Array.isArray(list)) {
          lookupIdSets[key] = new Set(list.map((it: any) => String(it?.id)));
        }
      }
    }

    const validateValue = (def: any, value: any): { ok: boolean; value?: any; reason?: string } => {
      if (!def) return { ok: false, reason: "no-def" };
      if (def.type === "boolean") {
        if (typeof value === "boolean") return { ok: true, value };
        if (value === "true" || value === 1) return { ok: true, value: true };
        if (value === "false" || value === 0 || value == null) return { ok: true, value: false };
        return { ok: true, value: Boolean(value) };
      }
      if (def.type === "number") {
        const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
        return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, reason: "nan" };
      }
      if (def.type === "select" && Array.isArray(def.options)) {
        const match = def.options.find((o: any) => String(o?.value) === String(value));
        return match
          ? { ok: true, value: match.value }
          : { ok: false, reason: "select-not-in-options" };
      }
      if (def.type === "lookup" && def.lookup) {
        const set = lookupIdSets[def.lookup];
        const idStr = String(value);
        return set?.has(idStr)
          ? { ok: true, value: idStr }
          : { ok: false, reason: "lookup-id-not-found" };
      }
      if (def.type === "date") {
        const s = String(value ?? "");
        return /^\d{4}-\d{2}-\d{2}/.test(s)
          ? { ok: true, value: s.slice(0, 10) }
          : { ok: false, reason: "bad-date" };
      }
      // text — accept anything stringifiable
      return { ok: true, value: value == null ? "" : String(value) };
    };

    // Build a path → label map of every navigable route the user is allowed
    // to open. The model can ONLY emit navigate commands for paths in this
    // set — protects against hallucinated routes and against the model
    // ignoring the per-user permission filter.
    const routePaths = new Map<string, string>();
    for (const r of availableRoutes as any[]) {
      if (r && typeof r.path === "string" && r.path.startsWith("/")) {
        routePaths.set(r.path, String(r.ar || r.en || r.id || r.path));
      }
    }

    // Whitelist of visible button / input / combobox labels. We use these
    // as a soft check — case-insensitive substring match — so the model's
    // partial-match license (rule #2 in the prompt) still works without
    // letting completely invented labels through.
    const buttonLabels = collectLabels((uiSnapshot as any)?.buttons);
    const inputLabels = collectLabels((uiSnapshot as any)?.inputs);
    const comboboxLabels = collectLabels((uiSnapshot as any)?.comboboxes);
    // Whitelist of testids the model is allowed to reference, scoped to the
    // CURRENT screen snapshot. Without this check the model could emit any
    // arbitrary `testid` and bypass the label whitelist entirely.
    const buttonTestids = collectTestids((uiSnapshot as any)?.buttons);
    const labelLooksValid = (label: any, pool: string[]) => {
      if (typeof label !== "string" || !label.trim()) return false;
      const a = normalizeLabel(label);
      if (!a) return false;
      return pool.some((b) => b === a || b.includes(a) || a.includes(b));
    };

    // Destructive labels we never let the model click without an explicit,
    // separately-confirmed user intent. Mirror of the client-side denylist
    // so the network can't be skipped.
    const destructive = (label: any) => {
      if (typeof label !== "string") return false;
      const norm = label.replace(/[\u064B-\u065F\u0670]/g, "").trim();
      return [
        /\bdelete\b/i,
        /\bremove\b/i,
        /\bvoid\b/i,
        /\bdiscard\b/i,
        /\bdestroy\b/i,
        /\breset\b/i,
        /حذف/,
        /إزالة/,
        /إلغاء\s*(الفاتورة|الطلب|المستند)/,
        /تدمير/,
        /مسح\s*الكل/,
      ].some((p) => p.test(norm));
    };

    const rawCmds = Array.isArray(parsed?.commands) ? parsed.commands : [];
    const intermediate = rawCmds
      .map((c: any) => {
        if (!c || typeof c !== "object") return null;
        if (c.type === "set_field" && typeof c.field === "string" && fieldDefs.has(c.field)) {
          const def = fieldDefs.get(c.field);
          const v = validateValue(def, c.value);
          if (!v.ok) return null;
          return { type: "set_field", field: c.field, value: v.value };
        }
        if (
          c.type === "call_action" &&
          typeof c.action === "string" &&
          actionNames.has(c.action)
        ) {
          return {
            type: "call_action",
            action: c.action,
            params: c.params && typeof c.params === "object" ? c.params : {},
          };
        }
        if (c.type === "navigate" && typeof c.path === "string" && routePaths.has(c.path)) {
          return {
            type: "navigate",
            path: c.path,
            label: typeof c.label === "string" && c.label.trim()
              ? c.label.slice(0, 80)
              : routePaths.get(c.path),
          };
        }
        if (c.type === "click" || c.type === "double_click") {
          // Drop destructive button clicks before the model can fire them.
          if (destructive(c.label)) return null;
          // Accept the command if EITHER the label is in the visible button
          // pool, OR the testid was actually present in the snapshot.
          const labelOk = labelLooksValid(c.label, buttonLabels);
          const testidOk =
            typeof c.testid === "string" &&
            c.testid.trim() &&
            buttonTestids.has(c.testid);
          if (!labelOk && !testidOk) return null;
          const out: any = { type: c.type };
          if (typeof c.label === "string") out.label = c.label.slice(0, 120);
          if (testidOk) out.testid = c.testid.slice(0, 80);
          return out;
        }
        if (
          c.type === "type_text" &&
          labelLooksValid(c.label, inputLabels) &&
          (typeof c.value === "string" || typeof c.value === "number")
        ) {
          return {
            type: "type_text",
            label: String(c.label).slice(0, 120),
            value: String(c.value).slice(0, 1000),
          };
        }
        if (
          c.type === "select_option" &&
          labelLooksValid(c.label, comboboxLabels) &&
          typeof c.option === "string" &&
          c.option.trim()
        ) {
          return {
            type: "select_option",
            label: String(c.label).slice(0, 120),
            option: c.option.slice(0, 200),
          };
        }
        return null;
      })
      .filter(Boolean);

    // Enforce "navigate must be terminal": once we hit a navigate command,
    // drop everything after it. The new screen's DOM hasn't loaded yet so
    // any further click/type would either fail or hit a stale element.
    const cleaned: any[] = [];
    for (const cmd of intermediate) {
      cleaned.push(cmd);
      if (cmd.type === "navigate") break;
      if (cleaned.length >= 50) break;
    }

    res.json({
      message: String(parsed.message ?? "").slice(0, 1000),
      commands: cleaned,
      source: "ai" as const,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "AI command error" });
  }
});

/**
 * Stringifies a value, then truncates if it exceeds maxBytes. Used to keep
 * lookup payloads from blowing up the LLM prompt.
 */
function sanitizeJson(v: any, maxBytes: number): any {
  if (v === undefined || v === null) return null;
  try {
    const s = JSON.stringify(v);
    if (s.length <= maxBytes) return v;
    return JSON.parse(s.slice(0, maxBytes - 50) + (Array.isArray(v) ? "...]" : "...}"));
  } catch {
    return null;
  }
}

/**
 * Pull a normalized array of label strings out of a UI snapshot section
 * (buttons / inputs / comboboxes). Used server-side to whitelist which
 * labels the model is allowed to act on.
 */
function collectLabels(section: any): string[] {
  if (!Array.isArray(section)) return [];
  const out: string[] = [];
  for (const item of section) {
    if (item && typeof item.label === "string") {
      const n = normalizeLabel(item.label);
      if (n) out.push(n);
    }
  }
  return out;
}

/**
 * Pull the set of `testid` values that the snapshot reported. We only let
 * the model reference testids that are actually visible right now — never
 * arbitrary ones — to close a hallucination/escalation hole.
 */
function collectTestids(section: any): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(section)) return out;
  for (const item of section) {
    if (item && typeof item.testid === "string" && item.testid.trim()) {
      out.add(item.testid);
    }
  }
  return out;
}

/** Cheap label normalization: strip Arabic diacritics + lowercase + trim. */
function normalizeLabel(s: string): string {
  return (s || "")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ─── Face attendance — AI weekly summary ─────────────────────────────────────
// Takes the analytics object produced by /api/hr/face/analytics and asks the
// LLM for a short, executive-style Arabic summary with concrete recommendations.
// Falls back gracefully when the proxy is not configured so the hub still
// renders its locally-computed insight.
router.post("/summarize-face-attendance", async (req, res) => {
  try {
    const a = (req.body ?? {}) as {
      totalEmployees?: number;
      enrolledEmployees?: number;
      enrollmentRate?: number;
      camerasCount?: number;
      todayPresent?: number;
      todayLate?: number;
      presenceRate?: number;
      weekRecognitions?: number;
      weekSpoofs?: number;
      topLate?: Array<{ employeeName?: string | null; employeeCode?: string | null; lateDays?: number; totalLateMin?: number }>;
      heatmap?: Array<{ hour: number; cnt: number }>;
    };
    if (!OPENAI_BASE || !OPENAI_KEY) {
      res.status(503).json({ error: "AI proxy not configured" });
      return;
    }

    // Sanitize numbers (finite, default to 0). Identities are intentionally
    // stripped — the LLM only needs aggregate metrics, never employee names or
    // codes, so no PII leaves the tenant boundary.
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const safe = {
      totalEmployees: num(a.totalEmployees),
      enrolledEmployees: num(a.enrolledEmployees),
      enrollmentRate: num(a.enrollmentRate),
      camerasCount: num(a.camerasCount),
      todayPresent: num(a.todayPresent),
      todayLate: num(a.todayLate),
      presenceRate: num(a.presenceRate),
      weekRecognitions: num(a.weekRecognitions),
      weekSpoofs: num(a.weekSpoofs),
      topLate: Array.isArray(a.topLate)
        ? a.topLate.slice(0, 5).map((t, i) => ({
            label: `موظف ${i + 1}`,
            lateDays: num(t.lateDays),
            totalLateMin: num(t.totalLateMin),
          }))
        : [],
      peakHours: (Array.isArray(a.heatmap) ? a.heatmap : [])
        .slice()
        .sort((x, y) => num(y.cnt) - num(x.cnt))
        .slice(0, 3)
        .map(h => ({ hour: num(h.hour), count: num(h.cnt) })),
    };

    const userPrompt = `لديك إحصاءات الحضور بالذكاء الاصطناعي لشركة سعودية للأسبوع الماضي. اكتب ملخصاً تنفيذياً قصيراً باللغة العربية (3-5 جمل، بحد أقصى 80 كلمة) يبرز:
• مستوى تغطية تسجيل الوجوه ومعدل الحضور اليوم.
• أهم نمط ملحوظ (ذروة، تأخر، محاولات تزوير) إن وجد.
• توصيتين عمليتين قابلتين للتنفيذ، مسبوقتين برمز 💡.

البيانات:
${JSON.stringify(safe)}

أعد JSON فقط بهذا الشكل: { "summary": "..." }`;

    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 600,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "أنت محلل موارد بشرية مختصر ومحايد. ترد بـ JSON فقط بدون أي شرح إضافي." },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!r.ok) {
      res.status(502).json({ error: "AI proxy error" });
      return;
    }
    const data = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let summary = "";
    try {
      const parsed = JSON.parse(content);
      summary = String(parsed?.summary ?? "").trim();
    } catch {
      summary = "";
    }
    if (!summary) {
      res.status(502).json({ error: "Empty AI response" });
      return;
    }
    res.json({ summary, source: "ai" });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "AI summary failed" });
  }
});

export default router;

// ═══════════════════════════════════════════════════════════════════
// Classify a free-text security incident description into a structured
// {eventType, severity, suggestedTitle} payload. Used by the
// SecurityEventForm "Suggest with AI" button so operators can paste a
// short Arabic/English description and have the form pre-filled.
// Body: { description: string, cameraLabel?: string }
// Returns: { eventType, severity, suggestedTitle, reasoning }
// ═══════════════════════════════════════════════════════════════════
router.post("/security/classify-event", requirePermission("security_events", "view"), async (req, res) => {
  try {
    const { description, cameraLabel } = (req.body ?? {}) as {
      description?: string;
      cameraLabel?: string;
    };
    const desc = String(description ?? "").trim();
    if (!desc || desc.length < 5) {
      res.status(400).json({ error: "الوصف قصير جداً للتحليل" });
      return;
    }
    if (!OPENAI_BASE || !OPENAI_KEY) {
      res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" });
      return;
    }

    const TYPES = [
      "intrusion", "theft", "suspicious_movement", "unknown_person",
      "after_hours_presence", "missing_item", "unusual_gathering",
      "tampering", "other",
    ];
    const SEVERITIES = ["low", "medium", "high", "critical"];

    const userPrompt = `صنّف الحدث الأمني التالي إلى نوع ومستوى خطورة، واقترح عنواناً قصيراً (5-10 كلمات) باللغة العربية.

الوصف: ${desc}
${cameraLabel ? `الكاميرا/الموقع: ${cameraLabel}` : ""}

الأنواع المتاحة (اختر واحداً فقط بالقيمة الإنجليزية بالضبط):
${TYPES.map(t => `- ${t}`).join("\n")}

مستويات الخطورة (اختر واحداً فقط بالقيمة الإنجليزية بالضبط):
${SEVERITIES.map(s => `- ${s}`).join("\n")}

أعد JSON فقط بهذا الشكل:
{ "eventType": "...", "severity": "...", "suggestedTitle": "...", "reasoning": "سبب موجز جداً (جملة واحدة)" }`;

    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 400,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "أنت مصنّف أحداث أمنية محايد. ترد بـ JSON فقط بدون أي شرح خارج الـ JSON." },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(502).json({ error: `فشل استدعاء الذكاء الاصطناعي: ${r.status} ${txt.slice(0, 200)}` });
      return;
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any;
    try { parsed = JSON.parse(content); }
    catch { res.status(500).json({ error: "تعذّر تحليل استجابة الذكاء الاصطناعي" }); return; }

    // Always return a valid value — fall back to safe defaults if the LLM
    // hallucinates an unknown enum value rather than 500-ing the form.
    const eventType = TYPES.includes(parsed?.eventType) ? parsed.eventType : "other";
    const severity  = SEVERITIES.includes(parsed?.severity) ? parsed.severity : "medium";
    const suggestedTitle = String(parsed?.suggestedTitle ?? "").slice(0, 200) || desc.slice(0, 80);
    const reasoning = String(parsed?.reasoning ?? "").slice(0, 500);

    res.json({ eventType, severity, suggestedTitle, reasoning });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "AI classify failed" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/ai/security/analyze-image
// Take an uploaded image (object-storage path) and run vision analysis to
// detect a security event. Returns the same shape as classify-event PLUS
// a suggested description and an isSecurityConcern flag.
// Body: { imageUrl: string ("/objects/..."), hint?: string, cameraLabel?: string }
// ═══════════════════════════════════════════════════════════════════
router.post("/security/analyze-image", requirePermission("security_events", "view"), async (req, res) => {
  try {
    const { imageUrl, hint, cameraLabel } = (req.body ?? {}) as {
      imageUrl?: string;
      hint?: string;
      cameraLabel?: string;
    };
    const path = String(imageUrl ?? "").trim();
    if (!path || !path.startsWith("/objects/")) {
      res.status(400).json({ error: "مسار الصورة غير صالح" });
      return;
    }
    if (!OPENAI_BASE || !OPENAI_KEY) {
      res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" });
      return;
    }

    // ── Authorization: object-level tenant isolation ────────────────
    // Even though the route is gated by security_events:view, we must
    // also verify the caller's company actually OWNS this object path.
    // The ONLY trusted source of ownership is security_event_media,
    // which is stamped at upload-URL issuance time from the auth token
    // (companyId is never accepted from request bodies). We do NOT
    // trust security_events.imageUrl as proof, because users can write
    // arbitrary strings into that column — write-side validation also
    // pins those columns to security_event_media for the same company,
    // so the two sources are equivalent and we can keep the check
    // single-sourced here.
    const cid = resolveCompanyId(req, (req as any).authUser?.companyId ?? undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }

    const [mediaRow] = await db.select({ id: securityEventMediaTable.id })
      .from(securityEventMediaTable)
      .where(and(
        eq(securityEventMediaTable.companyId, cid),
        eq(securityEventMediaTable.objectPath, path),
      ))
      .limit(1);
    if (!mediaRow) {
      // 404 (not 403) so we don't confirm to a probing attacker that
      // some other tenant's path exists.
      res.status(404).json({ error: "الصورة غير موجودة" });
      return;
    }

    // Pull the image bytes from object storage. We require the object to
    // exist and to be a real image (not video / pdf / arbitrary blob)
    // before paying for a vision call.
    const { ObjectStorageService, ObjectNotFoundError } = await import("../lib/objectStorage.js");
    const svc = new ObjectStorageService();
    let buf: Buffer;
    let contentType = "image/jpeg";
    try {
      const file = await svc.getObjectEntityFile(path);
      const [meta] = await file.getMetadata();
      const ct = String((meta as any)?.contentType ?? "").toLowerCase();
      if (!ct.startsWith("image/")) {
        res.status(400).json({ error: "الملف ليس صورة" });
        return;
      }
      contentType = ct;
      const [data] = await file.download();
      buf = data;
    } catch (e: any) {
      if (e instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "الصورة غير موجودة" });
        return;
      }
      throw e;
    }

    // Hard cap: 8MB after base64 expansion is ~10.7MB; vision APIs choke
    // on larger payloads. Reject up-front instead of timing out.
    if (buf.length > 8 * 1024 * 1024) {
      res.status(413).json({ error: "الصورة أكبر من 8 ميجابايت" });
      return;
    }
    const dataUrl = `data:${contentType};base64,${buf.toString("base64")}`;

    const TYPES = [
      "intrusion", "theft", "suspicious_movement", "unknown_person",
      "after_hours_presence", "missing_item", "unusual_gathering",
      "tampering", "other",
    ];
    const SEVERITIES = ["low", "medium", "high", "critical"];

    const userText = `حلّل الصورة المرفقة من كاميرا مراقبة وحدد ما إذا كانت تمثّل حدثاً أمنياً.
${hint ? `سياق إضافي من المستخدم: ${hint}` : ""}
${cameraLabel ? `الكاميرا/الموقع: ${cameraLabel}` : ""}

الأنواع المتاحة (اختر واحداً فقط بالقيمة الإنجليزية بالضبط):
${TYPES.map(t => `- ${t}`).join("\n")}

مستويات الخطورة (اختر واحداً فقط بالقيمة الإنجليزية بالضبط):
${SEVERITIES.map(s => `- ${s}`).join("\n")}

أعد JSON فقط بهذا الشكل:
{
  "isSecurityConcern": true|false,
  "eventType": "...",
  "severity": "...",
  "suggestedTitle": "عنوان مختصر بالعربية (5-10 كلمات)",
  "suggestedDescription": "وصف مختصر بالعربية لما تظهره الصورة (1-3 جمل)",
  "confidence": 0.0-1.0,
  "reasoning": "سبب موجز جداً (جملة واحدة)"
}

إذا كانت الصورة لا تظهر أي مشكلة أمنية (مشهد عادي / فارغ)، فاضبط isSecurityConcern=false وeventType="other" وseverity="low".`;

    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 600,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "أنت محلّل لقطات كاميرات مراقبة محايد. ترد بـ JSON فقط بدون أي شرح خارج الـ JSON." },
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(502).json({ error: `فشل استدعاء الذكاء الاصطناعي: ${r.status} ${txt.slice(0, 200)}` });
      return;
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any;
    try { parsed = JSON.parse(content); }
    catch { res.status(500).json({ error: "تعذّر تحليل استجابة الذكاء الاصطناعي" }); return; }

    const eventType = TYPES.includes(parsed?.eventType) ? parsed.eventType : "other";
    const severity  = SEVERITIES.includes(parsed?.severity) ? parsed.severity : "medium";
    const suggestedTitle = String(parsed?.suggestedTitle ?? "").slice(0, 200);
    const suggestedDescription = String(parsed?.suggestedDescription ?? "").slice(0, 1000);
    const reasoning = String(parsed?.reasoning ?? "").slice(0, 500);
    const isSecurityConcern = parsed?.isSecurityConcern === true;
    let confidence = Number(parsed?.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));

    res.json({
      isSecurityConcern,
      eventType,
      severity,
      suggestedTitle,
      suggestedDescription,
      confidence,
      reasoning,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "AI vision failed" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Trial Balance — analyze imbalance, abnormal accounts, suggest adjustments
// ═══════════════════════════════════════════════════════════════════
router.post("/analyze-trial-balance", requireModulePermission("accounting_maintenance"), async (req, res) => {
  try {
    const { lines, totalDebit, totalCredit } = req.body as {
      lines: Array<{ accountCode: string; accountName: string; accountType?: string; debit: number|string; credit: number|string }>;
      totalDebit: number|string;
      totalCredit: number|string;
    };
    if (!Array.isArray(lines)) {
      res.status(400).json({ error: "lines required" }); return;
    }
    const td = Number(totalDebit ?? 0);
    const tc = Number(totalCredit ?? 0);
    const diff = +(td - tc).toFixed(2);

    function fallback() {
      // Deterministic rules: detect imbalance + flag abnormal accounts
      // (asset/expense should be debit-positive; liability/equity/revenue credit-positive).
      const abnormal: Array<{ accountCode: string; accountName: string; reason: string; severity: "low"|"medium"|"high" }> = [];
      for (const l of lines) {
        const t = String(l.accountType || "").toLowerCase();
        const d = Number(l.debit  ?? 0);
        const c = Number(l.credit ?? 0);
        if (d < 0 || c < 0) {
          abnormal.push({ accountCode: l.accountCode, accountName: l.accountName, reason: "قيمة سالبة في المدين/الدائن", severity: "high" });
        }
        if (d > 0 && c > 0) {
          abnormal.push({ accountCode: l.accountCode, accountName: l.accountName, reason: "كلا الجانبين (مدين ودائن) لهما قيم", severity: "medium" });
        }
        if ((t === "asset" || t === "expense") && c > 0 && d === 0) {
          abnormal.push({ accountCode: l.accountCode, accountName: l.accountName, reason: `حساب ${t === "asset" ? "أصول" : "مصروفات"} برصيد دائن (غير معتاد)`, severity: "low" });
        }
        if ((t === "liability" || t === "equity" || t === "revenue") && d > 0 && c === 0) {
          abnormal.push({ accountCode: l.accountCode, accountName: l.accountName, reason: `حساب ${t === "liability" ? "خصوم" : t === "equity" ? "حقوق ملكية" : "إيرادات"} برصيد مدين (غير معتاد)`, severity: "low" });
        }
      }
      const suggestions: Array<{ description: string; lines: Array<{ accountCode: string; debit: number; credit: number }> }> = [];
      if (Math.abs(diff) > 0.01) {
        suggestions.push({
          description: `قيد تسوية تلقائي لمعالجة الفرق ${Math.abs(diff).toFixed(2)} ر.س`,
          lines: diff > 0
            ? [
                { accountCode: "*ضع كود حساب فرق المراجعة المدين*", debit: 0, credit: Math.abs(diff) },
                { accountCode: "*ضع كود الحساب المقابل*", debit: Math.abs(diff), credit: 0 },
              ]
            : [
                { accountCode: "*ضع كود حساب فرق المراجعة الدائن*", debit: Math.abs(diff), credit: 0 },
                { accountCode: "*ضع كود الحساب المقابل*", debit: 0, credit: Math.abs(diff) },
              ],
        });
      }
      const imbalanceReason = Math.abs(diff) > 0.01
        ? `الميزان غير متوازن بفرق ${diff.toFixed(2)} ر.س (المدين ${td.toFixed(2)} مقابل الدائن ${tc.toFixed(2)}). راجع البنود الشاذة أدناه أو طبّق قيد تسوية مقترح.`
        : `الميزان متوازن (إجمالي المدين = إجمالي الدائن = ${td.toFixed(2)} ر.س).`;
      return {
        source: "fallback" as const,
        balanced: Math.abs(diff) < 0.01,
        difference: diff,
        imbalanceReason,
        abnormalAccounts: abnormal,
        suggestions,
      };
    }

    if (!OPENAI_BASE || !OPENAI_KEY) { res.json(fallback()); return; }
    try {
      const top = lines.slice(0, 80).map(l => `${l.accountCode}|${l.accountName}|${l.accountType||""}|${Number(l.debit||0).toFixed(2)}|${Number(l.credit||0).toFixed(2)}`).join("\n");
      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-5.4",
          max_completion_tokens: 1500,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "أنت محاسب خبير تحلل ميزان المراجعة. ترد بـ JSON فقط." },
            { role: "user", content:
`حلّل ميزان المراجعة التالي:
- إجمالي المدين: ${td.toFixed(2)}
- إجمالي الدائن: ${tc.toFixed(2)}
- الفرق: ${diff.toFixed(2)}

البنود (code|name|type|debit|credit):
${top}

أرجع JSON بالحقول التالية:
{
  "balanced": boolean,
  "imbalanceReason": "تفسير قصير للفرق إن وُجد",
  "abnormalAccounts": [{ "accountCode": "...", "accountName": "...", "reason": "...", "severity": "low|medium|high" }],
  "suggestions": [{ "description": "...", "lines": [{ "accountCode": "...", "debit": 0, "credit": 0 }] }]
}` },
          ],
        }),
      });
      if (!r.ok) { res.json(fallback()); return; }
      const data = await r.json();
      let parsed: any;
      try { parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}"); }
      catch { res.json(fallback()); return; }
      res.json({
        source: "ai",
        balanced: parsed?.balanced === true || Math.abs(diff) < 0.01,
        difference: diff,
        imbalanceReason: String(parsed?.imbalanceReason || "").trim() || fallback().imbalanceReason,
        abnormalAccounts: Array.isArray(parsed?.abnormalAccounts) ? parsed.abnormalAccounts : [],
        suggestions: Array.isArray(parsed?.suggestions) ? parsed.suggestions : [],
      });
    } catch { res.json(fallback()); }
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تحليل ميزان المراجعة فشل" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// AI audit of a sales-invoices list (الجرد الخارجي للفواتير).
// Receives a summary of all invoices and returns structured findings:
// - issues (errors): VAT mismatches, missing customer, posted with no JE, ZATCA rejections
// - warnings: drafts older than 7 days, abnormally large totals (outliers)
// - summary metrics + 3-5 plain-Arabic recommendations
// Falls back to a deterministic rule-based audit when AI is not configured.
// Body: { invoices: Array<{...}>, currencyCode?: string }
// Returns: { findings: Array<{level, code, invoiceId?, docNumber?, message, fix?}>, metrics, recommendations: string[] }
// ═══════════════════════════════════════════════════════════════════
router.post("/audit-sales-invoices", requirePermission("sales_invoices", "view"), async (req, res) => {
  try {
    const { invoices = [], currencyCode = "SAR" } = (req.body ?? {}) as {
      invoices?: any[];
      currencyCode?: string;
    };
    if (!Array.isArray(invoices) || invoices.length === 0) {
      res.status(400).json({ error: "لا توجد فواتير لتدقيقها" });
      return;
    }

    // ── Deterministic rule-based pass (always runs to seed the findings list) ──
    const findings: Array<{
      level: "error" | "warning" | "info";
      code: string;
      invoiceId?: number;
      docNumber?: string;
      message: string;
      fix?: string;
    }> = [];

    let totalPosted = 0;
    let totalDraft = 0;
    let totalVat = 0;
    const totals: number[] = [];
    const today = new Date();

    for (const inv of invoices) {
      const sub = Number(inv.subtotal ?? 0);
      const vat = Number(inv.vatAmount ?? 0);
      const tot = Number(inv.totalAmount ?? 0);
      const disc = Number(inv.discountAmount ?? 0);
      totals.push(tot);
      totalVat += vat;
      if (inv.status === "posted") totalPosted += tot;
      if (inv.status === "draft")  totalDraft  += tot;

      // 1. VAT mismatch (allow ±0.5 rounding)
      const expectedVat = (sub - disc) * 0.15;
      if (sub > 0 && Math.abs(expectedVat - vat) > 0.5) {
        findings.push({
          level: "error",
          code: "VAT_MISMATCH",
          invoiceId: inv.id,
          docNumber: inv.docNumber,
          message: `قيمة الضريبة (${vat.toFixed(2)}) لا تساوي 15% من المجموع بعد الخصم (المتوقع ${expectedVat.toFixed(2)})`,
          fix: "افتح الفاتورة وأعد حساب البنود — قد يكون أحد البنود يحمل نسبة ضريبة مختلفة أو أن الخصم غير محسوب على الأساس الضريبي.",
        });
      }

      // 2. Missing customer
      if (!inv.customerId) {
        findings.push({
          level: "error",
          code: "MISSING_CUSTOMER",
          invoiceId: inv.id,
          docNumber: inv.docNumber,
          message: "الفاتورة لا تحتوي على عميل — مطلوب لـ ZATCA إذا كانت B2B وللذمم المدينة.",
          fix: "افتح الفاتورة واختر العميل من القائمة.",
        });
      }

      // 3. Posted with no journal entry
      if (inv.status === "posted" && !inv.journalEntryId) {
        findings.push({
          level: "error",
          code: "POSTED_NO_JE",
          invoiceId: inv.id,
          docNumber: inv.docNumber,
          message: "الفاتورة مُرحّلة لكن لا يوجد قيد محاسبي مرتبط بها.",
          fix: "ألغِ الترحيل وأعد ترحيل الفاتورة لإعادة توليد القيد.",
        });
      }

      // 4. ZATCA rejection
      if (String(inv.zatcaStatus ?? "") === "rejected") {
        findings.push({
          level: "error",
          code: "ZATCA_REJECTED",
          invoiceId: inv.id,
          docNumber: inv.docNumber,
          message: `الفاتورة مرفوضة من ZATCA${inv.zatcaResponseCode ? ` (${inv.zatcaResponseCode})` : ""}.`,
          fix: "افتح صفحة جسر ZATCA واطّلع على رسالة الخطأ ثم صحّح الحقول المطلوبة وأعد الإرسال.",
        });
      }

      // 5. Old drafts (>7 days)
      if (inv.status === "draft" && inv.invoiceDate) {
        const d = new Date(inv.invoiceDate);
        if (!isNaN(d.getTime())) {
          const daysOld = Math.floor((today.getTime() - d.getTime()) / 86400000);
          if (daysOld > 7) {
            findings.push({
              level: "warning",
              code: "OLD_DRAFT",
              invoiceId: inv.id,
              docNumber: inv.docNumber,
              message: `مسودة عمرها ${daysOld} يوماً — قد تكون منسيّة.`,
              fix: "راجع الفاتورة ثم رحّلها أو احذفها.",
            });
          }
        }
      }

      // 6. Zero total
      if (tot <= 0 && inv.status !== "cancelled") {
        findings.push({
          level: "warning",
          code: "ZERO_TOTAL",
          invoiceId: inv.id,
          docNumber: inv.docNumber,
          message: "الإجمالي صفر — تأكد من إدخال البنود.",
          fix: "افتح الفاتورة وأضف البنود أو احذفها إن لم تكن مطلوبة.",
        });
      }

      // 7. Credit posted invoice without payment settlement (potential receivable)
      if (inv.status === "posted" && inv.paymentType === "credit" && !inv.paymentSettlement && tot > 0) {
        findings.push({
          level: "info",
          code: "OPEN_RECEIVABLE",
          invoiceId: inv.id,
          docNumber: inv.docNumber,
          message: `ذمّة مفتوحة بقيمة ${tot.toFixed(2)} ${currencyCode}.`,
          fix: "أنشئ سند قبض للعميل عند التحصيل.",
        });
      }
    }

    // 8. Outlier detection (any total > 3× median).
    //    Baseline = positive, non-cancelled totals only, so a sea of zero/cancelled
    //    rows can't collapse the median to zero and silence outlier warnings.
    const baseline = invoices
      .filter((i: any) => i.status !== "cancelled" && Number(i.totalAmount ?? 0) > 0)
      .map((i: any) => Number(i.totalAmount ?? 0))
      .sort((a, b) => a - b);
    let median = 0;
    if (baseline.length > 0) {
      const mid = Math.floor(baseline.length / 2);
      median = baseline.length % 2 === 0
        ? (baseline[mid - 1] + baseline[mid]) / 2
        : baseline[mid];
    }
    if (median > 0) {
      for (const inv of invoices) {
        const tot = Number(inv.totalAmount ?? 0);
        if (inv.status !== "cancelled" && tot > median * 3) {
          findings.push({
            level: "warning",
            code: "OUTLIER_HIGH",
            invoiceId: inv.id,
            docNumber: inv.docNumber,
            message: `قيمة الفاتورة (${tot.toFixed(2)}) أعلى بكثير من الوسيط (${median.toFixed(2)}).`,
            fix: "تأكد من صحة الكميات والأسعار — قد يكون هناك خطأ إدخال.",
          });
        }
      }
    }

    const metrics = {
      totalInvoices: invoices.length,
      totalPosted: invoices.filter((i: any) => i.status === "posted").length,
      totalDrafts: invoices.filter((i: any) => i.status === "draft").length,
      totalCancelled: invoices.filter((i: any) => i.status === "cancelled").length,
      sumPosted: totalPosted,
      sumDraft: totalDraft,
      sumVat: totalVat,
      median,
      issuesCount: findings.filter(f => f.level === "error").length,
      warningsCount: findings.filter(f => f.level === "warning").length,
    };

    // ── Build deterministic recommendations seed ──
    const recommendations: string[] = [];
    if (metrics.issuesCount > 0) {
      recommendations.push(`عالج ${metrics.issuesCount} مشكلة حرجة قبل الترحيل أو الإرسال إلى ZATCA.`);
    }
    if (metrics.totalDrafts > 0) {
      recommendations.push(`لديك ${metrics.totalDrafts} مسودة غير مُرحّلة بقيمة ${totalDraft.toFixed(2)} ${currencyCode} — راجعها وأكمل ترحيلها.`);
    }
    const openRcv = findings.filter(f => f.code === "OPEN_RECEIVABLE").length;
    if (openRcv > 0) {
      recommendations.push(`${openRcv} فاتورة آجلة مفتوحة بانتظار التحصيل — تابع العملاء.`);
    }
    if (recommendations.length === 0) {
      recommendations.push("لا توجد مشاكل واضحة في فواتيرك — استمر بنفس مستوى الجودة.");
    }

    // ── Optionally enrich with AI commentary on top of rule findings ──
    let aiUsed = false;
    if (OPENAI_BASE && OPENAI_KEY) {
      try {
        const sample = invoices.slice(0, 50).map((i: any) => ({
          id: i.id,
          docNumber: i.docNumber,
          date: i.invoiceDate,
          customer: i.customerName ?? null,
          payment: i.paymentType,
          subtotal: Number(i.subtotal ?? 0),
          vat: Number(i.vatAmount ?? 0),
          total: Number(i.totalAmount ?? 0),
          status: i.status,
          zatcaStatus: i.zatcaStatus ?? null,
          journalEntryId: i.journalEntryId ?? null,
          paid: !!i.paymentSettlement,
        }));
        const userPrompt = `أنت مدقق محاسبي سعودي خبير في ZATCA. لديك ملخص ${invoices.length} فاتورة مبيعات (عيّنة ${sample.length}). والقواعد التلقائية اكتشفت ${findings.length} ملاحظة.
المؤشرات: ${JSON.stringify(metrics)}
عيّنة الفواتير:
${JSON.stringify(sample)}

اكتب 3-5 توصيات عملية موجزة بالعربية لتحسين جودة الفواتير وتقليل المخاطر المحاسبية والضريبية. ركّز على الأنماط (وليس فاتورة واحدة).
أعد JSON فقط: { "recommendations": ["...", "..."] }`;

        const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            max_completion_tokens: 1024,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "أنت مدقق محاسبي سعودي. ترد بـ JSON فقط بدون أي شرح." },
              { role: "user", content: userPrompt },
            ],
          }),
        });
        if (r.ok) {
          const data = await r.json();
          const content = data?.choices?.[0]?.message?.content ?? "{}";
          const parsed = JSON.parse(content);
          const aiRecs = Array.isArray(parsed?.recommendations)
            ? parsed.recommendations.map((x: any) => String(x).trim()).filter((x: string) => x.length > 0)
            : [];
          if (aiRecs.length > 0) {
            recommendations.push(...aiRecs);
            aiUsed = true;
          }
        }
      } catch {
        // Silently fall back to rule-based recommendations
      }
    }

    res.json({ findings, metrics, recommendations, source: aiUsed ? "ai+rules" : "rules" });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تدقيق الفواتير فشل" });
  }
});
