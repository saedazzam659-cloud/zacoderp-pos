import { Router } from "express";

const router = Router();

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

export default router;
