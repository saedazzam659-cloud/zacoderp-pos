export type RoleDef = {
  key: string;
  label: string;
  description: string;
  defaultHintCode?: string;
  accountType?: "asset" | "liability" | "equity" | "revenue" | "expense";
};

export type DocumentTypeDef = {
  key: string;
  label: string;
  icon?: string;
  description: string;
  roles: RoleDef[];
};

export const DOCUMENT_TYPES: DocumentTypeDef[] = [
  {
    key: "purchase_invoice",
    label: "فواتير المشتريات",
    description: "قيد شراء بضاعة من المورد: مدين المخزون/المصروف ومدين ضريبة المدخلات، دائن المورد (الذمم الدائنة).",
    roles: [
      { key: "inventory",   label: "المخزون / المشتريات", description: "الحساب المدين للبضاعة المستلمة (أصل).", defaultHintCode: "1220", accountType: "asset" },
      { key: "vat_input",   label: "ضريبة القيمة المضافة (مدخلات)", description: "الحساب المدين لضريبة الشراء القابلة للاسترداد.", defaultHintCode: "1240", accountType: "asset" },
      { key: "payable",     label: "حساب الموردين (دائن)", description: "الحساب الدائن مقابل الفاتورة الآجلة.", defaultHintCode: "2110", accountType: "liability" },
      { key: "discount",    label: "خصم مكتسب", description: "الحساب الدائن لخصومات الشراء المكتسبة (اختياري).", accountType: "revenue" },
    ],
  },
  {
    key: "purchase_return",
    label: "مرتجع المشتريات",
    description: "قيد مرتجع إلى المورد: مدين المورد، دائن المخزون وضريبة المدخلات.",
    roles: [
      { key: "payable",   label: "حساب الموردين (مدين)", description: "الحساب المدين - تخفيض رصيد المورد.", defaultHintCode: "2110", accountType: "liability" },
      { key: "inventory", label: "المخزون (دائن)", description: "الحساب الدائن - تخفيض المخزون.", defaultHintCode: "1220", accountType: "asset" },
      { key: "vat_input", label: "ضريبة المدخلات (دائن)", description: "عكس ضريبة المدخلات على المرتجع.", defaultHintCode: "1240", accountType: "asset" },
      { key: "discount",  label: "خصم (مدين)", description: "نفس حساب الخصم المكتسب في فاتورة الشراء — يُعكس في طرف المدين لإلغاء الخصم على البضاعة المرتجعة.", defaultHintCode: "4103", accountType: "revenue" },
    ],
  },
  {
    key: "supplier_settlement",
    label: "تسوية الموردين",
    description: "سداد دفعة نقدية أو بنكية للمورد: مدين المورد، دائن الخزينة/البنك.",
    roles: [
      { key: "payable", label: "حساب الموردين (مدين)", description: "تخفيض التزام المورد.", defaultHintCode: "2110", accountType: "liability" },
      { key: "cash",    label: "الخزينة (دائن)", description: "خصم نقدي من الصندوق.", defaultHintCode: "1110", accountType: "asset" },
      { key: "bank",    label: "البنك (دائن)", description: "خصم من الحساب البنكي.", defaultHintCode: "1130", accountType: "asset" },
    ],
  },
  {
    key: "sales_invoice",
    label: "فواتير المبيعات",
    description: "قيد بيع بضاعة للعميل: مدين العميل/النقدية، دائن الإيراد وضريبة المخرجات، وقيد تكلفة البضاعة المباعة.",
    roles: [
      { key: "receivable", label: "حساب العملاء (مدين)", description: "الحساب المدين لفاتورة آجلة.", defaultHintCode: "1210", accountType: "asset" },
      { key: "revenue",    label: "إيرادات المبيعات (دائن)", description: "الحساب الدائن لإيرادات البيع.", defaultHintCode: "4110", accountType: "revenue" },
      { key: "vat_output", label: "ضريبة المخرجات (دائن)", description: "الحساب الدائن للضريبة المحصلة من العميل.", defaultHintCode: "2140", accountType: "liability" },
      { key: "cogs",       label: "تكلفة البضاعة المباعة (مدين)", description: "تسجيل تكلفة المخزون المباع.", defaultHintCode: "5110", accountType: "expense" },
      { key: "inventory",  label: "المخزون (دائن لأجل COGS)", description: "تخفيض المخزون بمقدار تكلفة المباع.", defaultHintCode: "1220", accountType: "asset" },
      { key: "discount",   label: "خصم مسموح به (مدين)", description: "الحساب المدين لقيمة الخصم الممنوح للعميل على الفاتورة (طبيعته مصروف).", defaultHintCode: "5103", accountType: "expense" },
    ],
  },
  {
    key: "sales_return",
    label: "مرتجع المبيعات",
    description: "قيد استلام بضاعة مرتجعة من العميل: مدين مرتجعات المبيعات وضريبة المخرجات، دائن العميل، مع عكس قيد التكلفة.",
    roles: [
      { key: "revenue_return", label: "مرتجعات المبيعات (مدين)", description: "حساب مدين لإيراد المرتجع.", defaultHintCode: "4120", accountType: "revenue" },
      { key: "vat_output",     label: "ضريبة المخرجات (مدين)", description: "عكس ضريبة المخرجات.", defaultHintCode: "2140", accountType: "liability" },
      { key: "receivable",     label: "حساب العملاء (دائن)", description: "تخفيض رصيد العميل.", defaultHintCode: "1210", accountType: "asset" },
      { key: "inventory",      label: "المخزون (مدين)", description: "إعادة البضاعة للمخزون بالتكلفة.", defaultHintCode: "1220", accountType: "asset" },
      { key: "cogs",           label: "تكلفة البضاعة المباعة (دائن)", description: "عكس التكلفة للبضاعة المرتجعة.", defaultHintCode: "5110", accountType: "expense" },
      { key: "discount",       label: "خصم مسموح به (دائن)", description: "نفس حساب الخصم الممنوح في الفاتورة الأصلية — يُعكس في طرف الدائن لاسترداد الخصم عند المرتجع.", defaultHintCode: "5103", accountType: "expense" },
    ],
  },
  {
    key: "customer_settlement",
    label: "تسوية العملاء (سندات القبض)",
    description: "روابط الحسابات العامة لسندات القبض — تُستخدم تلقائياً عند الترحيل: مدين الخزينة/البنك، دائن العميل. الخزن والبنوك تستخدم حساباتها المباشرة أولاً ثم تعود إلى هذه الحسابات احتياطياً.",
    roles: [
      { key: "cash",       label: "الخزينة (مدين) — افتراضي لسندات القبض النقدية", description: "حساب النقدية الافتراضي إذا لم تكن الخزنة المختارة في سند القبض مرتبطة بحساب محاسبي.", defaultHintCode: "1110", accountType: "asset" },
      { key: "bank",       label: "البنك (مدين) — افتراضي لسندات القبض البنكية", description: "حساب البنك الافتراضي إذا لم يكن الحساب البنكي المختار في سند القبض مرتبطاً بحساب محاسبي.", defaultHintCode: "1130", accountType: "asset" },
      { key: "receivable", label: "حساب العملاء (دائن) — افتراضي لسندات القبض", description: "حساب الذمم المدينة الافتراضي إذا لم يكن العميل في سند القبض مرتبطاً بحساب محاسبي.", defaultHintCode: "1210", accountType: "asset" },
    ],
  },
  {
    key: "warehouse",
    label: "المخازن (الافتتاحي)",
    description: "أرصدة افتتاحية للمخزون: مدين المخزون، دائن رأس المال الافتتاحي / حقوق الملكية.",
    roles: [
      { key: "inventory",        label: "المخزون (مدين)", description: "قيمة المخزون الافتتاحي.", defaultHintCode: "1220", accountType: "asset" },
      { key: "opening_balance",  label: "رصيد افتتاحي (دائن)", description: "حساب مقابل الأرصدة الافتتاحية.", defaultHintCode: "3900", accountType: "equity" },
    ],
  },
  {
    key: "warehouse_adjustment",
    label: "تسوية المخازن",
    description: "جرد وتسويات المخزون: ربح أو خسارة جرد مقابل حساب المخزون.",
    roles: [
      { key: "inventory",        label: "المخزون", description: "حساب المخزون المتأثر بالتسوية.", defaultHintCode: "1220", accountType: "asset" },
      { key: "adjustment_gain",  label: "زيادة جرد / ربح تسوية", description: "دائن عند زيادة المخزون.", defaultHintCode: "4900", accountType: "revenue" },
      { key: "adjustment_loss",  label: "عجز جرد / خسارة تسوية", description: "مدين عند نقص المخزون.", defaultHintCode: "5900", accountType: "expense" },
    ],
  },
  {
    key: "warehouse_transfer",
    label: "تحويلات المخازن",
    description: "تحويل بضاعة بين مخزنين: مدين مخزن الوصول، دائن مخزن الإرسال (يمكن أن يكون نفس الحساب مع فرع مختلف).",
    roles: [
      { key: "inventory_source",      label: "مخزون المُصدر (دائن)", description: "تخفيض رصيد المخزن المُرسل.", defaultHintCode: "1220", accountType: "asset" },
      { key: "inventory_destination", label: "مخزون المُستقبل (مدين)", description: "زيادة رصيد المخزن المستلم.", defaultHintCode: "1220", accountType: "asset" },
      { key: "transfer_cost",         label: "مصاريف نقل (اختياري)", description: "حساب مدين إذا كان التحويل يحمل تكاليف.", accountType: "expense" },
    ],
  },
  // ملاحظة:  أُزيل بطاقتا «الخزن (الصناديق النقدية)» و«البنوك» من هذه الشاشة
  // لأن كل خزينة أو بنك يحمل حقل accountId خاصاً به في تعريفه (انظر
  // cash_boxes.account_id و bank_accounts.account_id في schema/cash.ts).
  // الترحيل يتم تلقائيًا عبر هذا الحساب المرتبط بدون الحاجة إلى ربط محاسبي
  // عام في هذه الشاشة، مع الاستمرار في احترام إعداد «الترحيل التلقائي/اليدوي»
  // على مستوى الشركة.
  {
    key: "letter_of_credit",
    label: "الاعتمادات المستندية",
    description: "القيود الخاصة بفتح الاعتماد وسداد الهامش وتحميل المصاريف والعمولات البنكية وفروق العملة، قبل ترحيل التكلفة النهائية على المخزون.",
    roles: [
      { key: "lc_margin",      label: "هامش الاعتماد (مدين)", description: "الحساب المدين بنسبة الهامش المُجمّد لدى البنك عند فتح الاعتماد.", defaultHintCode: "1150", accountType: "asset" },
      { key: "lc_liability",   label: "الاعتمادات المستندية المفتوحة (دائن)", description: "التزام الشركة للبنك بقيمة الاعتماد بعد خصم الهامش.", defaultHintCode: "2150", accountType: "liability" },
      { key: "lc_commission",  label: "عمولة فتح الاعتماد", description: "عمولة البنك عند فتح الاعتماد (مصروف).", defaultHintCode: "5830", accountType: "expense" },
      { key: "lc_expenses",    label: "مصاريف الاعتماد المستندي (شحن/تأمين/جمارك)", description: "حساب تجميع مصاريف الاعتماد قبل توزيعها على تكلفة المخزون.", defaultHintCode: "5835", accountType: "expense" },
      { key: "lc_fx_diff",     label: "فروق عملة الاعتماد", description: "فرق سعر الصرف بين فتح الاعتماد وسداده.", defaultHintCode: "5840", accountType: "expense" },
      { key: "inventory",      label: "المخزون (تحميل التكلفة)", description: "الحساب الذي تُحمّل عليه التكلفة النهائية (قيمة البضاعة + المصاريف).", defaultHintCode: "1220", accountType: "asset" },
      { key: "bank",           label: "البنك (دفع الهامش/المصاريف)", description: "الحساب البنكي الذي يُخصم منه الهامش والعمولات.", defaultHintCode: "1130", accountType: "asset" },
    ],
  },
];
