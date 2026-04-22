import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable, warehousesTable, customersTable, suppliersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

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

export default router;
