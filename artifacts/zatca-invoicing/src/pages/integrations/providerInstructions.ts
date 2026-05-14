/**
 * Per-provider step-by-step setup guides shown to the end user inside
 * the connection page. Pure data — no React imports — so the connection
 * page can render it however it wants.
 */
export interface InstructionStep {
  title: string;
  body: string;
}

export interface ProviderInstructions {
  intro: string;
  steps: InstructionStep[];
  warningAr?: string;
  docsUrl?: string;
}

const odoo: ProviderInstructions = {
  intro: "أودو نظام محاسبة شامل. لربطه بنظامنا تحتاج 4 معلومات من حساب أودو: رابط الخادم، اسم قاعدة البيانات، اسم المستخدم، ومفتاح API.",
  steps: [
    { title: "رابط الخادم (Base URL)",
      body: "هو رابط نظام أودو عند العميل. مثال: https://yourcompany.odoo.com — انسخه كاملاً من شريط المتصفح بدون أي مسار بعد اسم النطاق." },
    { title: "اسم قاعدة البيانات (Database)",
      body: "عادة هو الجزء الأول من رابط أودو. لو الرابط https://acme.odoo.com فاسم قاعدة البيانات هو acme. للأنظمة المستضافة ذاتياً اسأل العميل أو موظف IT." },
    { title: "اسم المستخدم (Username)",
      body: "البريد الإلكتروني الذي يسجّل به المستخدم دخول أودو. يُفضّل إنشاء مستخدم API مخصّص بدلاً من استخدام حساب شخصي." },
    { title: "توليد مفتاح API (API Key)",
      body: "في أودو: اضغط على اسم المستخدم أعلى يمين الشاشة → My Profile → تبويب Account Security → اضغط New API Key → اكتب وصف (مثل ZATCA Integration) → انسخ المفتاح فوراً (يُعرض مرة واحدة فقط)." },
    { title: "الصلاحيات المطلوبة",
      body: "يجب أن يملك المستخدم صلاحية Sales > User: All Documents (لقراءة الفواتير) وأيضاً Accounting > Billing إذا أردنا قراءة الفواتير المحاسبية." },
  ],
  warningAr: "إذا فُقد مفتاح الـ API يجب توليد مفتاح جديد — لا يمكن استرجاع القديم.",
  docsUrl: "https://www.odoo.com/documentation/master/developer/reference/external_api.html",
};

const salla: ProviderInstructions = {
  intro: "سلة منصة المتاجر الإلكترونية. تحتاج فقط Access Token من تطبيق خاص ينشئه التاجر داخل لوحة سلة.",
  steps: [
    { title: "الدخول للوحة التاجر",
      body: "افتح https://s.salla.sa/login وادخل بحساب صاحب المتجر (وليس موظف)." },
    { title: "إنشاء تطبيق خاص",
      body: "من القائمة الجانبية: التطبيقات → التطبيقات الخاصة → إنشاء تطبيق جديد. اكتب اسم التطبيق (مثل: ZATCA Sync) واختر صلاحية Read على Orders و Customers." },
    { title: "نسخ الـ Access Token",
      body: "بعد إنشاء التطبيق ستظهر شاشة بيانات الاعتماد. انسخ Access Token كاملاً (طويل، يبدأ بـ ory_...) والصقه في حقل Access Token عندنا." },
    { title: "معرّف المتجر (اختياري)",
      body: "إذا كان عند التاجر أكثر من متجر تحت نفس الحساب، حدّد Store ID لتجنب الخلط. عادة لا حاجة له." },
  ],
  docsUrl: "https://docs.salla.dev/421214m0",
};

const genericRest: ProviderInstructions = {
  intro: "هذا الخيار للأنظمة الداخلية أو أي API يرجع JSON. تحتاج 4 معلومات من فريق التطوير عند العميل.",
  steps: [
    { title: "Base URL",
      body: "نقطة البداية لكل طلبات الـ API. مثال: https://api.acme.com/v1 — بدون شرطة مائلة في النهاية." },
    { title: "نوع المصادقة",
      body: "اكتب bearer إذا كان النظام يستخدم Authorization: Bearer <token>، أو basic للمصادقة الأساسية، أو apikey لمفتاح في الـ header." },
    { title: "السر / التوكن",
      body: "القيمة الفعلية للتوكن أو المفتاح. يُحفظ مشفّراً ولا يُعرض مجدداً." },
    { title: "مسار جلب الفواتير",
      body: "المسار النسبي لجلب الفواتير، مع متغيّر {lastSync} لاسترجاع الجديد فقط. مثال: /invoices?status=posted&since={lastSync}" },
    { title: "صيغة الـ JSON المتوقّعة",
      body: 'يجب أن يرجع الـ API مصفوفة فواتير بالشكل الموحّد: { "buyer": { "name", "vat" }, "invoice": { "number", "issueDate", "currency", "flow" }, "line": { "item", "qty", "unitPrice", "vatRate", "totalInclVat" } }. أو استخدم Push عبر الـ Webhook بدلاً من Pull.',
    },
  ],
  warningAr: "إذا كان شكل الـ JSON عند العميل مختلفاً، يجب على فريقهم تحويله للشكل الموحّد قبل الإرسال — أو يستخدمون Inbound Webhook ويرسلون لنا الشكل الذي عندهم وسنعالجه يدوياً.",
};

const inboundWebhook: ProviderInstructions = {
  intro: "أبسط طريقة للربط: نعطيك رابطاً سرياً، ونظام العميل يرسل الفواتير لنا فور إنشائها.",
  steps: [
    { title: "أنشئ الاتصال",
      body: "بعد الإنشاء سيُعرض لك رابط فريد ورمز سري **مرة واحدة فقط**. انسخه فوراً." },
    { title: "أعطِ الرابط للعميل",
      body: "العميل يُبرمج نظامه لإرسال POST إلى هذا الرابط بصيغة JSON عند كل فاتورة جديدة." },
    { title: "صيغة الإرسال",
      body: "Content-Type: application/json — Body: شكل الفاتورة الموحّد (نفس Generic REST أعلاه). يرجع النظام 200 OK عند النجاح." },
    { title: "اختبار",
      body: "بعد أول إرسال، ستظهر العملية في تبويب 'سجل المزامنة' فوراً. اضغط 'عرض' للتأكد من وصول البيانات صحيحة." },
  ],
  warningAr: "الرمز السري يُعرض مرة واحدة فقط. لو فُقد، احذف الاتصال وأنشئ واحداً جديداً.",
};

const placeholderComingSoon: ProviderInstructions = {
  intro: "هذا التكامل قيد التطوير وسيُتاح قريباً. يمكنك حالياً استخدام Generic REST أو Inbound Webhook كحل مؤقت.",
  steps: [],
};

export const PROVIDER_INSTRUCTIONS: Record<string, ProviderInstructions> = {
  odoo,
  salla,
  generic_rest: genericRest,
  inbound_webhook: inboundWebhook,
};

export function getInstructions(providerId: string): ProviderInstructions {
  return PROVIDER_INSTRUCTIONS[providerId] ?? placeholderComingSoon;
}
