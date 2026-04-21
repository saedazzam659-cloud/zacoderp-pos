import { Router } from "express";
import { extractAuth } from "../middleware/auth.js";

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

export default router;
