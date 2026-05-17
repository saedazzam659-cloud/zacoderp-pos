// Seeds the accounting_standards_kb table with curated bilingual entries
// covering the most-asked IFRS / GAAP / ZATCA standards. Idempotent.
//
// Sourced from the public authoritative texts (IFRS Foundation, FASB,
// ZATCA regulations). Summaries are paraphrased for plain-Arabic
// readability — they are NOT a substitute for legal advice, and the UI
// surfaces a disclaimer to that effect.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

interface SeedStd {
  standard: "ifrs" | "gaap" | "zatca";
  code: string;
  titleAr: string;
  titleEn: string;
  summaryAr: string;
  summaryEn: string;
  fullTextAr: string;
  fullTextEn: string;
  tags: string[];
  references?: { titleAr?: string; titleEn?: string; url: string }[];
}

const SEED: SeedStd[] = [
  // ─── IFRS ─────────────────────────────────────────────────────────────
  {
    standard: "ifrs",
    code: "IFRS 15",
    titleAr: "الإيرادات من العقود مع العملاء",
    titleEn: "Revenue from Contracts with Customers",
    summaryAr: "نموذج موحّد من خمس خطوات للاعتراف بالإيراد: تحديد العقد، تحديد الالتزامات الأدائية، تحديد سعر المعاملة، توزيع السعر، الاعتراف بالإيراد عند تحقّق الالتزام.",
    summaryEn: "Unified 5-step model for revenue recognition: identify contract, identify performance obligations, determine transaction price, allocate price, recognise revenue when obligation is satisfied.",
    fullTextAr: "يُطبَّق IFRS 15 على جميع العقود مع العملاء، ويستبدل المعايير السابقة (IAS 18 وIAS 11). الخطوات الخمس: (1) تحديد العقد — وجود اتفاق نافذ بحقوق وشروط دفع واضحة، (2) تحديد الالتزامات الأدائية المتميزة (Distinct Performance Obligations) داخل العقد، (3) تحديد سعر المعاملة — المبلغ المتوقع تحصيله مقابل نقل البضائع/الخدمات، (4) توزيع سعر المعاملة على كل التزام بناءً على سعر البيع المستقل (Stand-alone Selling Price)، (5) الاعتراف بالإيراد عند (أو خلال) تنفيذ كل التزام — نقطة زمنية واحدة للبضائع أو على مدى الزمن للخدمات. حالات خاصة: المرتجعات، حقوق العميل، عقود البناء طويلة الأجل، الترخيصات، عقود الضمان.",
    fullTextEn: "IFRS 15 applies to all contracts with customers, superseding IAS 18 and IAS 11. The five steps are: (1) Identify the contract, (2) Identify the performance obligations, (3) Determine the transaction price, (4) Allocate the price, (5) Recognise revenue when each performance obligation is satisfied — at a point in time for goods or over time for services. Special considerations: returns, customer options, long-term construction contracts, licences, warranties.",
    tags: ["revenue", "contracts", "sales", "إيرادات", "عقود"],
    references: [{ titleEn: "IFRS Foundation – IFRS 15", url: "https://www.ifrs.org/issued-standards/list-of-standards/ifrs-15-revenue-from-contracts-with-customers/" }],
  },
  {
    standard: "ifrs",
    code: "IAS 2",
    titleAr: "المخزون",
    titleEn: "Inventories",
    summaryAr: "المخزون يُقاس بالأقل من التكلفة أو صافي القيمة الممكن تحقيقها. التكلفة تُحدّد بطريقة التكلفة المحددة، أو FIFO، أو المتوسط المرجّح — LIFO ممنوع في IFRS.",
    summaryEn: "Inventories measured at the lower of cost and net realisable value. Cost determined using specific identification, FIFO, or weighted average — LIFO is prohibited under IFRS.",
    fullTextAr: "تشمل تكلفة المخزون: تكلفة الشراء (السعر + الرسوم + النقل) + تكاليف التحويل (العمالة المباشرة + الأعباء الصناعية الموزّعة بناءً على الطاقة العادية). تكلفة البيع والإدارة لا تُرسمَل. صافي القيمة الممكن تحقيقها = سعر البيع المتوقع − تكاليف الإكمال − تكاليف البيع. عند انخفاضها عن التكلفة يُحمَّل الفرق على المصاريف فوراً. الانخفاض يُعكس في الفترات اللاحقة لو تحسّن الوضع، لكن في حدود التخفيض الأصلي. النظام يستخدم المتوسط المرجّح ويُحدّث التكلفة مع كل استلام.",
    fullTextEn: "Cost of inventories comprises purchase cost + conversion costs (direct labour + production overheads allocated based on normal capacity). Selling and administrative costs are not capitalised. NRV = expected selling price − completion costs − selling costs. Write-downs to NRV are expensed; reversals are allowed in later periods if conditions improve, limited to original write-down. The system uses weighted average and updates cost on each receipt.",
    tags: ["inventory", "stock", "valuation", "مخزون", "تقييم"],
    references: [{ titleEn: "IFRS Foundation – IAS 2", url: "https://www.ifrs.org/issued-standards/list-of-standards/ias-2-inventories/" }],
  },
  {
    standard: "ifrs",
    code: "IAS 16",
    titleAr: "الممتلكات والآلات والمعدات",
    titleEn: "Property, Plant and Equipment",
    summaryAr: "الأصول الثابتة تُقاس بداية بالتكلفة وتُستهلَك على مدى عمرها الإنتاجي. يمكن استخدام نموذج التكلفة أو إعادة التقييم.",
    summaryEn: "PP&E measured initially at cost and depreciated over useful life. Cost model or revaluation model permitted.",
    fullTextAr: "التكلفة الأولية تشمل: سعر الشراء + كل التكاليف المباشرة لإحضاره وتجهيزه للاستخدام (نقل، تركيب، اختبار) + تكلفة الإزالة المستقبلية إن وُجدت. الاستهلاك يبدأ عند جاهزية الأصل ويتبع نمط الاستفادة (قسط ثابت، متناقص، وحدات إنتاج). يُراجَع العمر الإنتاجي والقيمة المتبقية سنوياً. إعادة التقييم اختيارية ويجب تطبيقها على الفئة كاملة وبانتظام كافٍ. الفرق الموجب يُحَمَّل على احتياطي إعادة التقييم ضمن حقوق الملكية.",
    fullTextEn: "Initial cost includes purchase price + all directly attributable costs to bring the asset to working condition + estimated dismantling costs. Depreciation begins when ready for use and reflects expected pattern of consumption. Useful life and residual value reviewed annually. Revaluation is optional but applied to whole class regularly; surplus goes to OCI/revaluation reserve.",
    tags: ["ppe", "fixed-assets", "depreciation", "أصول ثابتة", "استهلاك"],
  },
  {
    standard: "ifrs",
    code: "IFRS 16",
    titleAr: "عقود الإيجار",
    titleEn: "Leases",
    summaryAr: "المستأجِر يعترف بأصل حق الاستخدام (Right-of-Use Asset) والتزام إيجار لكل العقود (باستثناء قصيرة الأجل ومنخفضة القيمة).",
    summaryEn: "Lessees recognise a right-of-use asset and a lease liability for almost all leases (excluding short-term and low-value).",
    fullTextAr: "ألغى IFRS 16 التفرقة السابقة بين الإيجار التشغيلي والتمويلي للمستأجِر. عند بدء الإيجار يُسجّل: DR أصل حق الاستخدام / CR التزام الإيجار (بالقيمة الحالية للدفعات). لاحقاً: استهلاك الأصل على مدة الإيجار + فائدة على الالتزام تنخفض مع كل دفعة. الاستثناءات: عقود ≤ 12 شهراً، والأصول منخفضة القيمة (~5000 دولار جديدة). المؤجِّر تظل قواعده كما في IAS 17 (تشغيلي vs تمويلي).",
    fullTextEn: "IFRS 16 eliminated the operating/finance lease distinction for lessees. At inception, the lessee records: DR right-of-use asset / CR lease liability (PV of payments). Subsequently: depreciation of the asset over lease term + interest on liability reducing with each payment. Exemptions: leases ≤ 12 months and low-value assets (~$5,000 new). Lessor accounting retains the IAS 17 operating/finance split.",
    tags: ["lease", "right-of-use", "إيجار", "حق استخدام"],
  },
  {
    standard: "ifrs",
    code: "IAS 36",
    titleAr: "انخفاض قيمة الأصول",
    titleEn: "Impairment of Assets",
    summaryAr: "الأصل يُخفّض لقيمته القابلة للاسترداد (الأعلى من القيمة العادلة ناقصاً تكاليف البيع والقيمة الاستخدامية) عندما توجد مؤشرات انخفاض.",
    summaryEn: "An asset is written down to its recoverable amount (higher of fair value less costs of disposal and value in use) when impairment indicators exist.",
    fullTextAr: "تُجرى مراجعة الانخفاض في تاريخ التقرير: إن وُجدت مؤشرات داخلية (تلف، توقّف استخدام) أو خارجية (تراجع السوق، تغيّر تقني، فوائد مرتفعة) يُحسَب الـRecoverable Amount. لو أقلّ من القيمة الدفترية، يُسجّل خسارة انخفاض في الربح والخسارة. الشهرة والأصول غير الملموسة بعمر غير محدد تُختبَر سنوياً بغض النظر عن المؤشرات. عكس الخسارة مسموح للأصول العادية (ليس الشهرة) لو تحسّن الوضع.",
    fullTextEn: "Impairment is assessed at each reporting date if internal (damage, abandonment) or external (market decline, technological change, high interest rates) indicators exist. If recoverable amount < carrying amount, recognise impairment loss in P&L. Goodwill and indefinite-life intangibles are tested annually regardless. Reversal allowed for non-goodwill assets if conditions improve.",
    tags: ["impairment", "anaforz", "انخفاض قيمة", "أصول"],
  },
  {
    standard: "ifrs",
    code: "IAS 1",
    titleAr: "عرض القوائم المالية",
    titleEn: "Presentation of Financial Statements",
    summaryAr: "يحدد المتطلبات الأساسية لعرض القوائم المالية: قائمة المركز المالي، الدخل الشامل، التغيّر في حقوق الملكية، التدفقات النقدية، الإيضاحات.",
    summaryEn: "Sets out overall requirements for presenting financial statements: statement of financial position, comprehensive income, changes in equity, cash flows, and notes.",
    fullTextAr: "تُعرَض القوائم سنوياً (وأقصر إن لزم). افتراضات أساسية: الاستمرارية (Going Concern)، أساس الاستحقاق (Accrual)، الأهمية النسبية، التوحيد، عدم المقاصّة بين الأصول والخصوم إلا بنص. الترتيب المعتاد للمركز المالي: تداول/غير تداول. يجب الإفصاح عن السياسات المحاسبية والأحكام والتقديرات الجوهرية.",
    fullTextEn: "Financial statements are prepared annually (shorter if required). Underlying assumptions: going concern, accrual basis, materiality, consistency, offsetting only when permitted. Statement of financial position typically grouped current/non-current. Disclosure of accounting policies and significant estimates is mandatory.",
    tags: ["presentation", "disclosure", "عرض", "إفصاح"],
  },
  {
    standard: "ifrs",
    code: "IAS 12",
    titleAr: "ضرائب الدخل",
    titleEn: "Income Taxes",
    summaryAr: "يُعترَف بضريبة الدخل الحالية والمؤجَّلة. الضريبة المؤجَّلة تنشأ من الفروقات الزمنية بين القيمة الدفترية والوعاء الضريبي.",
    summaryEn: "Recognises both current and deferred income tax. Deferred tax arises from temporary differences between carrying amounts and tax bases.",
    fullTextAr: "الضريبة الحالية = المبلغ المستحق للسلطات الضريبية عن السنة. الضريبة المؤجَّلة: التزام إن كانت الفروقات الزمنية ستزيد الضريبة مستقبلاً (مثلاً استهلاك ضريبي أسرع من المحاسبي) — أصل إن كانت ستخفّض (مثل المخصصات). تُحسب بالمعدل الضريبي المتوقّع وقت الاسترداد. الأصول الضريبية المؤجَّلة تُعترَف فقط إذا كان من المرجّح وجود ربح ضريبي مستقبلي تُخصَم منه.",
    fullTextEn: "Current tax = amount owed for the year. Deferred tax: liability when temporary differences will increase future tax (e.g. accelerated tax depreciation) — asset when they reduce it (e.g. provisions). Measured at the tax rate expected when recovered/settled. Deferred tax assets recognised only if recovery against future taxable profit is probable.",
    tags: ["tax", "deferred-tax", "ضريبة", "مؤجلة"],
  },
  {
    standard: "ifrs",
    code: "IFRS 9",
    titleAr: "الأدوات المالية",
    titleEn: "Financial Instruments",
    summaryAr: "يحكم تصنيف وقياس الأدوات المالية، انخفاض قيمتها (نموذج الخسائر الائتمانية المتوقعة)، ومحاسبة التحوّط.",
    summaryEn: "Governs classification, measurement, impairment (Expected Credit Loss model), and hedge accounting of financial instruments.",
    fullTextAr: "التصنيف للأصول المالية بناءً على نموذج العمل واختبار تدفقات نقدية تعاقدية: التكلفة المُطفأة (Amortised Cost)، أو القيمة العادلة من خلال الدخل الشامل (FVOCI)، أو القيمة العادلة من خلال الربح والخسارة (FVTPL). الانخفاض يستخدم نموذج خسائر الائتمان المتوقعة (ECL) بدلاً من نموذج الخسائر المتكبدة القديم — يُعترَف بالخسارة المتوقعة فور إنشاء الأصل، بثلاث مراحل حسب درجة تدهور الجودة الائتمانية.",
    fullTextEn: "Asset classification by business model + contractual cash-flow test: Amortised Cost, FVOCI, or FVTPL. Impairment uses the Expected Credit Loss (ECL) model — losses recognised from origination, with three stages reflecting credit deterioration. Replaces the older incurred-loss model.",
    tags: ["financial-instruments", "ecl", "أدوات مالية", "خسائر متوقعة"],
  },

  // ─── US GAAP ──────────────────────────────────────────────────────────
  {
    standard: "gaap",
    code: "ASC 606",
    titleAr: "الاعتراف بالإيراد (US GAAP)",
    titleEn: "Revenue from Contracts with Customers (US GAAP)",
    summaryAr: "نسخة US GAAP من نموذج الإيراد. متطابق إلى حد كبير مع IFRS 15 لكن مع اختلافات تطبيقية (مثل الترخيصات، الضرائب على المبيعات).",
    summaryEn: "US GAAP version of the revenue model. Largely converged with IFRS 15 but with practical differences (e.g., licences, sales tax presentation).",
    fullTextAr: "نفس الخطوات الخمس لـIFRS 15. الفروقات الجوهرية: 1) تكاليف الشحن بعد نقل الملكية تُعالَج كنشاط الوفاء بالأداء، 2) الضرائب على المبيعات تُستبعَد من سعر المعاملة (في IFRS اختياري)، 3) عقود التراخيص لها قواعد أكثر تفصيلاً، 4) أحكام مختلفة لتعديلات العقود غير الجوهرية.",
    fullTextEn: "Same five steps as IFRS 15. Key differences: 1) shipping post-control transfer can be treated as fulfilment activity, 2) sales tax mandatorily excluded from transaction price (optional under IFRS), 3) more granular licensing rules, 4) different treatment of immaterial contract modifications.",
    tags: ["revenue", "us-gaap", "إيراد", "asc"],
  },
  {
    standard: "gaap",
    code: "ASC 842",
    titleAr: "عقود الإيجار (US GAAP)",
    titleEn: "Leases (US GAAP)",
    summaryAr: "يماثل IFRS 16 في الاعتراف بأصل حق الاستخدام، لكنه يحتفظ بالتفرقة بين الإيجار التشغيلي والتمويلي للمستأجِر.",
    summaryEn: "Similar to IFRS 16 in recognising right-of-use assets, but retains the operating/finance lease distinction for lessees.",
    fullTextAr: "كلا النوعين يُحدِثان أصل حق الاستخدام والتزام في الميزانية. الفرق في الربح والخسارة: التمويلي يفصل الاستهلاك عن الفائدة (front-loaded)، التشغيلي يعرض مصروف إيجار خطي. هذا يختلف عن IFRS 16 الذي يطبّق المعاملة التمويلية على الكل.",
    fullTextEn: "Both lease types create a right-of-use asset and liability on the balance sheet. P&L differs: finance leases split depreciation and interest (front-loaded); operating leases present a straight-line lease expense. This differs from IFRS 16, which applies finance treatment to all.",
    tags: ["lease", "us-gaap", "إيجار", "تشغيلي تمويلي"],
  },
  {
    standard: "gaap",
    code: "ASC 326",
    titleAr: "خسائر الائتمان (CECL)",
    titleEn: "Credit Losses (CECL)",
    summaryAr: "نموذج خسائر الائتمان المتوقعة الحالية (Current Expected Credit Loss). يُسجَّل التزام احتياطي للخسارة المتوقعة على مدى عمر الأصل.",
    summaryEn: "Current Expected Credit Loss model — record an allowance for life-of-loan expected credit losses on origination.",
    fullTextAr: "أصرم من IFRS 9 ECL: لا يوجد تقسيم لمراحل — تُحسب الخسارة المتوقعة على مدى العمر الكامل من اليوم الأول. يُطبَّق على الذمم المدينة، القروض، الأوراق المالية المحفوظة حتى الاستحقاق. يُستخدَم في كثير من الكيانات الأمريكية ذات الذمم الكبيرة.",
    fullTextEn: "Stricter than IFRS 9 ECL: no staging — lifetime expected credit losses are recognised from day one. Applies to receivables, loans, held-to-maturity securities. Material for US entities with large receivables portfolios.",
    tags: ["credit-loss", "us-gaap", "cecl", "خسائر ائتمان"],
  },

  // ─── ZATCA ────────────────────────────────────────────────────────────
  {
    standard: "zatca",
    code: "ZATCA-Phase2",
    titleAr: "المرحلة الثانية للفوترة الإلكترونية",
    titleEn: "ZATCA E-Invoicing Phase 2 (Integration)",
    summaryAr: "تتطلب إصدار الفواتير بصيغة XML (UBL 2.1)، توقيعاً رقمياً عبر CSID، وإرسالها لزاتكا (Clearance للقياسية / Reporting للمبسطة).",
    summaryEn: "Requires invoices in UBL 2.1 XML, digital signature via CSID, and submission to ZATCA (Clearance for standard / Reporting for simplified).",
    fullTextAr: "كل كيان مكلَّف بالقيمة المضافة يخضع للمرحلة الثانية تدريجياً حسب الإيرادات السنوية. متطلبات النظام: 1) إنشاء CSR ورفعه على بوابة فاتورة للحصول على CSID، 2) توليد XML متوافق مع UBL 2.1 لكل فاتورة، 3) توقيع XAdES-BES باستخدام المفتاح الخاص للـCSID، 4) إرسال فوري لزاتكا — الفاتورة القياسية لا تُسلّم للعميل قبل Clearance، المبسطة تُسلَّم فوراً وتُرسَل خلال 24 ساعة (Reporting). يجب أن تتضمن الفاتورة رمز QR مشفّر TLV يحتوي على البيانات الأساسية وبصمة التوقيع.",
    fullTextEn: "All VAT-registered entities are subject to Phase 2 in waves based on annual revenue. System requirements: 1) generate CSR and upload to Fatoora portal to receive CSID, 2) produce UBL 2.1-compliant XML per invoice, 3) sign with XAdES-BES using CSID private key, 4) submit in real time — standard invoices not delivered until Clearance, simplified delivered immediately and Reported within 24 hours. A TLV-encoded QR code with core data and signature hash is mandatory.",
    tags: ["zatca", "phase-2", "csid", "ubl", "فاتورة الكترونية"],
    references: [{ titleEn: "ZATCA E-Invoicing Portal", url: "https://zatca.gov.sa/en/E-Invoicing" }],
  },
  {
    standard: "zatca",
    code: "ZATCA-VAT-15",
    titleAr: "ضريبة القيمة المضافة 15%",
    titleEn: "Saudi VAT 15%",
    summaryAr: "النسبة القياسية لضريبة القيمة المضافة في السعودية 15% منذ يوليو 2020. توجد سلع وخدمات معفاة أو خاضعة بنسبة صفر.",
    summaryEn: "Standard Saudi VAT rate is 15% since July 2020. Some supplies are exempt or zero-rated.",
    fullTextAr: "النسبة القياسية: 15%. النسبة الصفرية (0%): الصادرات لخارج دول الخليج، النقل الدولي للركاب والبضائع، الأدوية والمستلزمات الطبية المؤهلة، الذهب الاستثماري. الإعفاء: التعليم الحكومي، الرعاية الصحية الحكومية، الإيجار السكني، بعض الخدمات المالية. التسجيل إلزامي إذا تجاوزت الإيرادات السنوية 375,000 ر.س، وطوعي إذا تجاوزت 187,500 ر.س.",
    fullTextEn: "Standard rate: 15%. Zero-rated: exports outside GCC, international transport, qualifying medicines/medical supplies, investment gold. Exempt: government education, government healthcare, residential rent, certain financial services. Registration mandatory above SAR 375,000 annual taxable supplies; voluntary above SAR 187,500.",
    tags: ["vat", "saudi", "ضريبة قيمة مضافة", "نسبة"],
  },
  {
    standard: "zatca",
    code: "ZATCA-Art-53",
    titleAr: "متطلبات بيانات الفاتورة الضريبية",
    titleEn: "Mandatory Invoice Data Fields",
    summaryAr: "تحدد المادة 53 من اللائحة التنفيذية البيانات الإلزامية لكل فاتورة ضريبية: المورّد، المستلم، التواريخ، الأرقام، تفاصيل البنود، الضريبة، الإجمالي.",
    summaryEn: "Article 53 of the implementing regulation lists the mandatory data for every tax invoice: supplier, recipient, dates, numbers, line details, VAT, totals.",
    fullTextAr: "الحقول الإلزامية للفاتورة القياسية: اسم وعنوان ورقم تسجيل المورّد والعميل، رقم الفاتورة الفريد، تاريخ الإصدار والاستحقاق، وصف البضاعة/الخدمة وكميتها وسعرها، نسبة الضريبة لكل بند، إجمالي الضريبة، الإجمالي قبل وبعد الضريبة. للمبسطة: يكفي بيانات المورّد، الإجمالي، الضريبة، رمز QR. الإصدار يجب أن يكون قبل 15 يوم من نهاية الشهر التالي للتوريد.",
    fullTextEn: "Standard invoice mandatory fields: supplier and customer name, address, VAT number, unique invoice number, issue and due dates, item description, quantity, price, VAT rate per line, total VAT, totals before and after VAT. Simplified invoices: supplier details, total, VAT, QR code suffice. Must be issued no later than 15 days after the end of the month of supply.",
    tags: ["zatca", "invoice", "mandatory-fields", "حقول الزامية"],
  },
  {
    standard: "zatca",
    code: "ZATCA-QR",
    titleAr: "رمز QR للفاتورة (TLV)",
    titleEn: "Invoice QR Code (TLV Encoding)",
    summaryAr: "كل فاتورة (قياسية أو مبسطة) يجب أن تتضمن رمز QR مشفّر بصيغة TLV بحقول محددة.",
    summaryEn: "Every invoice (standard or simplified) must include a TLV-encoded QR code with specific fields.",
    fullTextAr: "حقول TLV: 1) اسم المورّد، 2) رقم التسجيل الضريبي، 3) طابع الزمن (ISO 8601)، 4) إجمالي الفاتورة شامل الضريبة، 5) إجمالي الضريبة. في المرحلة الثانية تُضاف: 6) Hash للفاتورة، 7) المفتاح العام للـCSID، 8) توقيع المفتاح العام. النظام يولّد الرمز تلقائياً عند الترحيل ويُضمِّنه في PDF والـXML معاً.",
    fullTextEn: "TLV fields: 1) seller name, 2) VAT number, 3) timestamp (ISO 8601), 4) invoice total incl. VAT, 5) VAT amount. Phase 2 adds: 6) invoice hash, 7) CSID public key, 8) signature. The system generates the QR automatically on posting and embeds it in both PDF and XML.",
    tags: ["zatca", "qr", "tlv", "رمز استجابة"],
  },
];

export async function ensureAccountingStandardsKbSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS accounting_standards_kb (
      id           SERIAL PRIMARY KEY,
      standard     VARCHAR(16) NOT NULL,
      code         VARCHAR(60) NOT NULL UNIQUE,
      title_ar     TEXT NOT NULL,
      title_en     TEXT,
      summary_ar   TEXT NOT NULL,
      summary_en   TEXT,
      full_text_ar TEXT NOT NULL,
      full_text_en TEXT,
      tags         JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_refs  JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS accounting_kb_standard_idx ON accounting_standards_kb (standard);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS accounting_kb_tags_gin ON accounting_standards_kb USING GIN (tags);`);
}

export async function seedAccountingStandardsKb(): Promise<{ inserted: number; total: number }> {
  await ensureAccountingStandardsKbSchema();
  let inserted = 0;
  for (const s of SEED) {
    const r: any = await db.execute(sql`
      INSERT INTO accounting_standards_kb (standard, code, title_ar, title_en, summary_ar, summary_en, full_text_ar, full_text_en, tags, source_refs)
      VALUES (${s.standard}, ${s.code}, ${s.titleAr}, ${s.titleEn}, ${s.summaryAr}, ${s.summaryEn},
              ${s.fullTextAr}, ${s.fullTextEn}, ${JSON.stringify(s.tags)}::jsonb,
              ${JSON.stringify(s.references ?? [])}::jsonb)
      ON CONFLICT (code) DO NOTHING
      RETURNING id;
    `);
    if (r.rows?.length) inserted++;
  }
  logger.info({ inserted, total: SEED.length }, "accounting standards KB seed complete");
  return { inserted, total: SEED.length };
}
