import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable, warehousesTable } from "@workspace/db";
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

export default router;
