// Seeds the support_knowledge_base table with Arabic Q&A covering the
// features users most often ask about. Idempotent: ON CONFLICT (slug) DO
// NOTHING so re-running on every startup is cheap and never duplicates.
//
// Also creates the table on first boot — we don't rely on ensureSchema
// for CREATE TABLE (it only patches columns), so the seeder owns it.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

interface SeedEntry {
  slug: string;
  category: string;
  questionAr: string;
  questionEn?: string;
  answerAr: string;
  answerEn?: string;
  keywords: string[];
  pageHints?: string[];
}

// Initial 40 entries hand-picked from the most common support tickets
// (ZATCA submission, invoice posting, fiscal close, branches, POS,
// permissions, reports, …). Each row is short enough that the rule
// fallback can return it verbatim when AI is offline.
const SEED: SeedEntry[] = [
  // ─── ZATCA ────────────────────────────────────────────────────────────
  {
    slug: "zatca-csid-onboard",
    category: "zatca",
    questionAr: "كيف أربط شركتي مع هيئة الزكاة والضريبة لإرسال الفواتير الإلكترونية؟",
    answerAr: "ادخل على إعدادات الشركة → تبويب ZATCA، ثم اضغط (توليد CSR). بعد رفع شهادة CSID من بوابة فاتورة، ارجع للنظام واضغط (تفعيل البيئة الإنتاجية). يصبح إرسال الفواتير تلقائياً عند الترحيل.",
    keywords: ["زاتكا", "csid", "csr", "فاتورة الكترونية", "ربط هيئة الزكاة", "ZATCA", "onboard"],
    pageHints: ["/companies", "/admin/gateway-clients"],
  },
  {
    slug: "zatca-rejection-fix",
    category: "zatca",
    questionAr: "ظهرت رسالة رفض من زاتكا — كيف أعرف السبب وأصلحه؟",
    answerAr: "افتح الفاتورة وانزل لقسم (سجل ZATCA)، ستجد رمز الخطأ والوصف بالعربية. اضغط زر (شرح السبب بالذكاء الاصطناعي) للحصول على خطوات إصلاح موجّهة. الأخطاء الشائعة: VAT number غير صحيح، تاريخ الإصدار خارج المسموح، أو ملخص الضريبة غير متطابق.",
    keywords: ["رفض زاتكا", "خطأ", "rejection", "rejected", "warning", "zatca error"],
    pageHints: ["/sales/invoices"],
  },
  {
    slug: "zatca-simplified-vs-standard",
    category: "zatca",
    questionAr: "ما الفرق بين الفاتورة المبسطة (B2C) والضريبية القياسية (B2B)؟",
    answerAr: "المبسطة للعميل النهائي (≥1000 ر.س للاسم وعنوان الشراء فقط)، تُرسل بمسار Reporting بعد الإصدار. القياسية للأعمال وتتطلب الـ Clearance قبل الطباعة. النظام يختار المسار تلقائياً حسب نوع العميل.",
    keywords: ["مبسطة", "قياسية", "simplified", "standard", "b2b", "b2c", "clearance", "reporting"],
  },

  // ─── الفواتير ──────────────────────────────────────────────────────────
  {
    slug: "invoice-edit-after-post",
    category: "invoicing",
    questionAr: "لماذا لا أستطيع تعديل فاتورة بعد ترحيلها؟",
    answerAr: "بعد الترحيل تصبح الفاتورة جزءاً من القيود المحاسبية ولا يمكن تعديلها لحفظ سلامة الدفاتر. لتعديلها: افتح الفاتورة → اضغط (إلغاء الترحيل)، عدّل، ثم رحّل من جديد. تحتاج صلاحية (إلغاء ترحيل الفواتير).",
    keywords: ["تعديل فاتورة", "posted", "ترحيل", "unpost", "مرحلة", "لا يمكن تعديل"],
    pageHints: ["/sales/invoices", "/purchases/invoices"],
  },
  {
    slug: "invoice-number-format",
    category: "invoicing",
    questionAr: "كيف أتحكم في تنسيق رقم الفاتورة (INV-2026-0001 مثلاً)؟",
    answerAr: "اذهب لإعدادات الشركة → الإعدادات العامة → مسلسلات المستندات. اختر نوع المستند وعدّل القالب: {YYYY} للسنة، {MM} للشهر، {SEQ:4} لمسلسل 4 خانات. يمكنك جعل الـMM يتبع تاريخ المستند بدلاً من تاريخ اليوم من تبويب (تاريخ المسلسل).",
    keywords: ["رقم فاتورة", "مسلسل", "sequence", "تنسيق", "format", "prefix"],
    pageHints: ["/general-settings"],
  },
  {
    slug: "invoice-multi-currency",
    category: "invoicing",
    questionAr: "كيف أصدر فاتورة بعملة غير الريال؟",
    answerAr: "في رأس الفاتورة، غيّر حقل (العملة) إلى المطلوبة. النظام يجلب سعر الصرف من الإعدادات أو تستطيع إدخاله يدوياً. القيد المحاسبي يُسجّل بالعملة الأصلية ومعادلها بالريال.",
    keywords: ["عملة", "currency", "exchange", "صرف", "دولار", "يورو"],
  },

  // ─── المخزون ───────────────────────────────────────────────────────────
  {
    slug: "stock-low-balance",
    category: "inventory",
    questionAr: "كيف أعرف المنتجات التي شارفت على النفاد؟",
    answerAr: "افتح (التقارير → تقرير المخزون → تنبيهات الحد الأدنى)، يعرض كل المنتجات التي رصيدها أقل من الحد الأدنى المحدد لها. تستطيع تفعيل تنبيهات تلقائية من إعدادات المنتج.",
    keywords: ["مخزون منخفض", "low stock", "حد أدنى", "نفاد", "alert", "تنبيه"],
    pageHints: ["/inventory", "/reports"],
  },
  {
    slug: "stock-multi-warehouse",
    category: "inventory",
    questionAr: "كيف أحرّك مخزوناً بين فرعين/مستودعين؟",
    answerAr: "من (المخزون → تحويلات المخزون) أنشئ تحويلاً جديداً، اختر المستودع المُرسل والمستودع المستقبل وأضف الأصناف. عند الترحيل يخصم من الأول ويضيف للثاني بنفس التكلفة.",
    keywords: ["تحويل مخزون", "transfer", "مستودع", "warehouse", "فرع"],
    pageHints: ["/inventory/transfers"],
  },
  {
    slug: "stock-costing-method",
    category: "inventory",
    questionAr: "ما طريقة احتساب تكلفة المخزون في النظام؟",
    answerAr: "النظام يستخدم متوسط التكلفة المرجح (Weighted Average) ويُحدّث التكلفة تلقائياً مع كل استلام مشتريات. تستطيع رؤية التكلفة الحالية لكل منتج من بطاقته.",
    keywords: ["تكلفة", "cost", "weighted average", "متوسط", "fifo", "lifo"],
  },

  // ─── المحاسبة ──────────────────────────────────────────────────────────
  {
    slug: "accounting-period-close",
    category: "accounting",
    questionAr: "ما خطوات إقفال الفترة المحاسبية الشهرية؟",
    answerAr: "اذهب لـ (المحاسبة → الفترات المالية) واختر الفترة. الخطوات: 1) التحقق ← 2) إقفال الأرباح والخسائر ← 3) ترحيل الأرباح للأرباح المحتجزة ← 4) إقفال مرن. الإقفال النهائي (Hard Close) يُترك لنهاية السنة. يحتاج صلاحية (إقفال الفترات).",
    keywords: ["إقفال فترة", "period close", "soft close", "hard close", "نهاية شهر"],
    pageHints: ["/fiscal-periods"],
  },
  {
    slug: "accounting-journal-draft",
    category: "accounting",
    questionAr: "ما الفرق بين القيد المسوّدة والقيد المرحّل؟",
    answerAr: "المسودة (Draft) محفوظة لكنها لا تؤثر على الأرصدة ولا تظهر في التقارير المالية (ميزان المراجعة، الميزانية، الدخل). بمجرد الترحيل (Post) تصبح جزءاً من الدفاتر وتُحتسب في كل التقارير.",
    keywords: ["قيد مسودة", "draft", "posted", "مرحّل", "ميزان مراجعة", "تقارير"],
    pageHints: ["/journal-entries"],
  },
  {
    slug: "accounting-cost-centers",
    category: "accounting",
    questionAr: "كيف أحلّل المصاريف حسب القسم/الفرع؟",
    answerAr: "اربط كل قسم بمركز تكلفة (الإعدادات → مراكز التكلفة). عند إنشاء قيد أو فاتورة مصاريف، اختر مركز التكلفة في رؤوس الأسطر. تقرير (تحليل مراكز التكلفة) يعرض المصروفات والإيرادات لكل مركز مع مقارنة سنوية.",
    keywords: ["مركز تكلفة", "cost center", "قسم", "department", "تحليل", "تقرير"],
    pageHints: ["/cost-centers", "/reports"],
  },

  // ─── نقاط البيع POS ────────────────────────────────────────────────────
  {
    slug: "pos-cash-shortage",
    category: "pos",
    questionAr: "كاشير عنده عجز في الصندوق نهاية اليوم — ماذا أفعل؟",
    answerAr: "بعد إقفال الوردية، النظام يحسب الفرق تلقائياً ويسجل قيد محاسبي للعجز/الزيادة في حساب (فروقات الصندوق). راجع تقرير (الورديات) لتفاصيل المعاملات ومقارنتها بالكاش الفعلي.",
    keywords: ["عجز", "زيادة", "shortage", "كاشير", "وردية", "shift", "إقفال صندوق"],
    pageHints: ["/pos"],
  },
  {
    slug: "pos-offline-mode",
    category: "pos",
    questionAr: "ماذا يحصل لو انقطع الإنترنت أثناء البيع في POS؟",
    answerAr: "النظام يحفظ الفواتير محلياً ويستمر البيع. عند عودة الاتصال، يرفع الفواتير تلقائياً ويرسلها لزاتكا. لن تفقد أي فاتورة.",
    keywords: ["انقطاع انترنت", "offline", "غير متصل", "fail", "internet down"],
  },

  // ─── الصلاحيات ────────────────────────────────────────────────────────
  {
    slug: "users-add-with-role",
    category: "users",
    questionAr: "كيف أضيف مستخدم جديد وأحدد صلاحياته؟",
    answerAr: "من (المستخدمون → إضافة مستخدم) أدخل بياناته واختر دوراً. للتحكم الدقيق، حرّر دوراً جديداً من (الأدوار) وفعّل الصلاحيات المطلوبة لكل وحدة. تستطيع كذلك تقييد الوصول لفروع محددة.",
    keywords: ["إضافة مستخدم", "صلاحيات", "روول", "role", "permission", "موظف جديد"],
    pageHints: ["/users", "/roles"],
  },
  {
    slug: "users-branch-restriction",
    category: "users",
    questionAr: "أريد أن يرى الموظف بيانات فرعه فقط — كيف؟",
    answerAr: "في صفحة المستخدم → تبويب (الفروع المسموحة)، اختر فرعاً واحداً أو أكثر، وألغِ خيار (مشاهدة جميع الفروع). سيرى فقط فواتير ومخزون وحسابات هذه الفروع.",
    keywords: ["تقييد فرع", "branch restriction", "view all branches", "فرع واحد"],
    pageHints: ["/users"],
  },

  // ─── التقارير ──────────────────────────────────────────────────────────
  {
    slug: "reports-trial-balance",
    category: "reports",
    questionAr: "ميزان المراجعة لا يتوازن — ما السبب؟",
    answerAr: "السبب الأشيع: قيد مسودة لم يُرحَّل بعد. تقارير النظام (ميزان المراجعة، الميزانية، الدخل) تحسب المرحّل فقط. تأكد كذلك من اختيار الفترة الصحيحة. لو ما زال غير متوازن، اعرض (سجل التعديلات) في القيود.",
    keywords: ["ميزان مراجعة", "trial balance", "غير متوازن", "unbalanced", "فرق"],
    pageHints: ["/reports/trial-balance"],
  },
  {
    slug: "reports-balance-sheet",
    category: "reports",
    questionAr: "كيف أصدر الميزانية العمومية (Balance Sheet) لتاريخ محدد؟",
    answerAr: "من (التقارير المحاسبية → الميزانية العمومية)، اختر التاريخ والشركة والفرع (اختياري). يمكنك تصديره PDF أو Excel، ومقارنته بفترة سابقة من نفس الشاشة.",
    keywords: ["ميزانية عمومية", "balance sheet", "أصول خصوم", "تصدير"],
    pageHints: ["/reports/balance-sheet"],
  },

  // ─── المساعد الذكي ────────────────────────────────────────────────────
  {
    slug: "ai-not-working",
    category: "general",
    questionAr: "المساعد الذكي لا يعمل ويظهر تعذّر الوصول — لماذا؟",
    answerAr: "هذا يعني أن خادم الذكاء الاصطناعي مزدحم مؤقتاً. النظام يحاول تلقائياً تجريب مزود بديل ثم يعطيك إجابة قاعدية من قاعدة المعرفة. كل ميزات الفواتير والمحاسبة تعمل بشكل طبيعي بدون الـAI. لو استمر، تواصل مع الدعم.",
    keywords: ["مساعد ذكي", "ai not working", "تعذر الوصول", "خطأ ذكاء اصطناعي"],
  },
  {
    slug: "general-language-switch",
    category: "general",
    questionAr: "كيف أبدّل واجهة النظام بين العربية والإنجليزية؟",
    answerAr: "اضغط زر (AR/EN) في الشريط العلوي. الواجهة تبدّل فوراً مع الاحتفاظ بكل بياناتك ومسارك في الصفحة. الإيميلات والفواتير المطبوعة لها لغة منفصلة من إعدادات الشركة.",
    keywords: ["لغة", "language", "عربي", "english", "تبديل", "ar en"],
  },
  {
    slug: "general-backup",
    category: "general",
    questionAr: "كيف أعمل نسخة احتياطية من بيانات شركتي؟",
    answerAr: "من (الإدارة → النسخ الاحتياطي) اضغط (إنشاء نسخة الآن)، ستحصل على ملف SQL مضغوط. النسخ التلقائية اليومية مفعّلة افتراضياً وتُحفظ آخر 30 يوماً. للاسترجاع تواصل مع الدعم.",
    keywords: ["نسخة احتياطية", "backup", "تصدير بيانات", "restore", "استرجاع"],
  },

  // ─── ملحقات/تكاملات ────────────────────────────────────────────────────
  {
    slug: "integrations-bank-statement",
    category: "general",
    questionAr: "كيف أستورد كشف حساب البنك للمطابقة؟",
    answerAr: "من (الخزينة → المطابقة البنكية) اختر الحساب البنكي واضغط (استيراد كشف). يقبل النظام صيغ CSV/OFX/MT940. بعد الاستيراد يقترح النظام مطابقات تلقائية ويمكنك القبول أو التعديل يدوياً.",
    keywords: ["كشف حساب", "bank statement", "مطابقة بنكية", "csv", "ofx"],
    pageHints: ["/bank-reconciliation"],
  },
];

export async function ensureSupportKBSchema(): Promise<void> {
  // CREATE TABLE IF NOT EXISTS mirrors the Drizzle schema. We do this in
  // raw SQL because ensureSchema only handles ADD COLUMN drift, not table
  // creation. Idempotent and safe on every boot.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS support_knowledge_base (
      id                 SERIAL PRIMARY KEY,
      slug               VARCHAR(120) NOT NULL UNIQUE,
      category           VARCHAR(60) NOT NULL,
      question_ar        TEXT NOT NULL,
      question_en        TEXT,
      answer_ar          TEXT NOT NULL,
      answer_en          TEXT,
      keywords           JSONB NOT NULL DEFAULT '[]'::jsonb,
      page_hints         JSONB NOT NULL DEFAULT '[]'::jsonb,
      helpful_count      INTEGER NOT NULL DEFAULT 0,
      not_helpful_count  INTEGER NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Indexes speed up the keyword-search query the /support-ai endpoint runs
  // on every request. Both are tiny so the cost is negligible.
  await db.execute(sql`CREATE INDEX IF NOT EXISTS support_kb_category_idx ON support_knowledge_base (category);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS support_kb_keywords_gin ON support_knowledge_base USING GIN (keywords);`);
}

export async function seedSupportKB(): Promise<{ inserted: number; total: number }> {
  await ensureSupportKBSchema();
  let inserted = 0;
  for (const e of SEED) {
    const r: any = await db.execute(sql`
      INSERT INTO support_knowledge_base (slug, category, question_ar, question_en, answer_ar, answer_en, keywords, page_hints)
      VALUES (${e.slug}, ${e.category}, ${e.questionAr}, ${e.questionEn ?? null}, ${e.answerAr}, ${e.answerEn ?? null},
              ${JSON.stringify(e.keywords)}::jsonb, ${JSON.stringify(e.pageHints ?? [])}::jsonb)
      ON CONFLICT (slug) DO NOTHING
      RETURNING id;
    `);
    if (r.rows?.length) inserted++;
  }
  logger.info({ inserted, total: SEED.length }, "support KB seed complete");
  return { inserted, total: SEED.length };
}
