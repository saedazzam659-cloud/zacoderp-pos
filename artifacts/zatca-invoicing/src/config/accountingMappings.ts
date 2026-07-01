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
    description: "قيد مرتجع إلى المورد: مدين المورد، دائن المخزون وضريبة المدخلات. حساب الفروق يستوعب الفرق بين قيمة المرتجع المتفق عليها مع المورد وتكلفة البضاعة الفعلية في المخزون (التشغيلة الأصلية).",
    roles: [
      { key: "payable",   label: "حساب الموردين (مدين)", description: "الحساب المدين - تخفيض رصيد المورد.", defaultHintCode: "2110", accountType: "liability" },
      { key: "inventory", label: "المخزون (دائن)", description: "الحساب الدائن - تخفيض المخزون.", defaultHintCode: "1220", accountType: "asset" },
      { key: "vat_input", label: "ضريبة المدخلات (دائن)", description: "عكس ضريبة المدخلات على المرتجع.", defaultHintCode: "1240", accountType: "asset" },
      { key: "discount",  label: "خصم (مدين)", description: "نفس حساب الخصم المكتسب في فاتورة الشراء — يُعكس في طرف المدين لإلغاء الخصم على البضاعة المرتجعة.", defaultHintCode: "4103", accountType: "revenue" },
      { key: "variance",  label: "فروق سعر مرتجع المشتريات (مدين/دائن)", description: "الفرق بين قيمة المرتجع المتفق عليها مع المورد (المبلغ على المستند) وتكلفة البضاعة الفعلية الخارجة من المخزون (متوسط تكلفة التشغيلة الأصلية). يُسجل كقيد مدين إذا كانت تكلفة البضاعة أعلى من قيمة الاسترداد (خسارة)، أو كقيد دائن إذا كانت أقل (ربح). يُطلب فقط عند وجود فرق فعلي أعلى من قروش التقريب.", defaultHintCode: "5108", accountType: "expense" },
    ],
  },
  {
    key: "supplier_settlement",
    label: "تسوية الموردين (سندات الصرف)",
    description: "روابط الحسابات العامة لسندات الصرف — تُستخدم تلقائياً عند الترحيل: مدين المورد، دائن الخزينة/البنك. الخزن والبنوك تستخدم حساباتها المباشرة أولاً ثم تعود إلى هذه الحسابات احتياطياً.",
    roles: [
      { key: "payable", label: "حساب الموردين (مدين) — افتراضي لسندات الصرف", description: "حساب الذمم الدائنة الافتراضي إذا لم يكن المورد في سند الصرف مرتبطاً بحساب محاسبي.", defaultHintCode: "2110", accountType: "liability" },
      { key: "cash",    label: "الخزينة (دائن) — افتراضي لسندات الصرف النقدية", description: "حساب النقدية الافتراضي إذا لم تكن الخزنة المختارة في سند الصرف مرتبطة بحساب محاسبي.", defaultHintCode: "1110", accountType: "asset" },
      { key: "bank",    label: "البنك (دائن) — افتراضي لسندات الصرف البنكية", description: "حساب البنك الافتراضي إذا لم يكن الحساب البنكي المختار في سند الصرف مرتبطاً بحساب محاسبي.", defaultHintCode: "1130", accountType: "asset" },
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
    key: "pos_invoice",
    label: "فواتير نقاط البيع",
    description: "قيد بيع نقاط البيع: مدين الخزينة/البنك/العميل، دائن الإيراد وضريبة المخرجات، وقيد تكلفة البضاعة المباعة. روابط مستقلة عن فواتير المبيعات لتمييز قيود المتجر عن قيود البيع التقليدي.",
    roles: [
      { key: "cash",       label: "الخزينة (مدين) — افتراضي للبيع النقدي", description: "حساب النقدية الافتراضي إذا لم تكن خزنة المحطة مرتبطة بحساب محاسبي.", defaultHintCode: "1110", accountType: "asset" },
      { key: "bank",       label: "البنك (مدين) — افتراضي للبيع البنكي/الكاش-إن", description: "حساب البنك الافتراضي إذا لم يكن الحساب البنكي للمحطة مرتبطاً بحساب محاسبي.", defaultHintCode: "1130", accountType: "asset" },
      { key: "receivable", label: "حساب العملاء (مدين) — افتراضي للبيع الآجل", description: "حساب الذمم المدينة الافتراضي إذا لم يكن العميل مرتبطاً بحساب محاسبي.", defaultHintCode: "1210", accountType: "asset" },
      { key: "revenue",    label: "إيرادات مبيعات نقاط البيع (دائن)", description: "الحساب الدائن لإيرادات البيع من نقاط البيع.", defaultHintCode: "4110", accountType: "revenue" },
      { key: "vat_output", label: "ضريبة المخرجات (دائن)", description: "الحساب الدائن للضريبة المحصلة من العميل.", defaultHintCode: "2140", accountType: "liability" },
      { key: "cogs",       label: "تكلفة البضاعة المباعة (مدين)", description: "تسجيل تكلفة المخزون المباع عبر نقاط البيع.", defaultHintCode: "5110", accountType: "expense" },
      { key: "inventory",  label: "المخزون (دائن لأجل COGS)", description: "تخفيض المخزون بمقدار تكلفة المباع.", defaultHintCode: "1220", accountType: "asset" },
      { key: "discount",   label: "خصم مسموح به (مدين)", description: "الحساب المدين لقيمة الخصم الممنوح للعميل في نقاط البيع.", defaultHintCode: "5103", accountType: "expense" },
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
    key: "entity_account_parents",
    label: "حسابات الكيانات (الآباء) — الإنشاء التلقائي",
    description: "اختر الحساب الأب لكل نوع كيان (خزن/بنوك/عملاء/موردين/مخازن). عند إنشاء كيان جديد بدون حساب محاسبي، يُنشئ النظام تلقائياً حساباً فرعياً تحت الحساب الأب المختار هنا، ويعطيه كوداً متسلسلاً (مثلاً 1102 → 11021، 11022، …). يمكنك بعد ذلك تعديل الحساب يدوياً من شجرة الحسابات.",
    roles: [
      { key: "cash_account_parent",      label: "أب حسابات الخزن (الصناديق النقدية)", description: "كل خزنة جديدة بدون حساب يتم إنشاؤها كحساب فرعي تحت هذا الحساب.", defaultHintCode: "1101", accountType: "asset" },
      { key: "bank_account_parent",      label: "أب الحسابات البنكية", description: "كل حساب بنكي جديد بدون حساب يتم إنشاؤه كحساب فرعي تحت هذا الحساب.", defaultHintCode: "1102", accountType: "asset" },
      { key: "customer_account_parent",  label: "أب حسابات العملاء (عام)", description: "الحساب الأب الافتراضي للعملاء عند عدم اختيار تصنيف (محلي/تصدير) أو عدم ربط حساب التصنيف.", defaultHintCode: "1103", accountType: "asset" },
      { key: "customer_local_account_parent",  label: "أب حسابات العملاء (محليون)", description: "عند اختيار تصنيف «عميل محلي» بدون حساب، يُنشأ الحساب الفرعي تحت هذا الأب.", defaultHintCode: "1103", accountType: "asset" },
      { key: "customer_export_account_parent", label: "أب حسابات العملاء (تصدير)", description: "عند اختيار تصنيف «عميل تصدير» بدون حساب، يُنشأ الحساب الفرعي تحت هذا الأب.", defaultHintCode: "1103", accountType: "asset" },
      { key: "warehouse_account_parent", label: "أب حسابات المخازن", description: "كل مخزن جديد بدون حساب يتم إنشاؤه كحساب فرعي تحت هذا الحساب.", defaultHintCode: "1105", accountType: "asset" },
      { key: "supplier_account_parent",  label: "أب حسابات الموردين (عام)", description: "الحساب الأب الافتراضي للموردين عند عدم اختيار تصنيف (محلي/أجنبي) أو عدم ربط حساب التصنيف.", defaultHintCode: "2101", accountType: "liability" },
      { key: "supplier_local_account_parent",  label: "أب حسابات الموردين (محليون)", description: "عند اختيار تصنيف «مورد محلي» بدون حساب، يُنشأ الحساب الفرعي تحت هذا الأب.", defaultHintCode: "2101", accountType: "liability" },
      { key: "supplier_foreign_account_parent", label: "أب حسابات الموردين (أجانب)", description: "عند اختيار تصنيف «مورد أجنبي» بدون حساب، يُنشأ الحساب الفرعي تحت هذا الأب.", defaultHintCode: "2101", accountType: "liability" },
    ],
  },
  {
    key: "contracting_outgoing_bill",
    label: "مستخلصات العملاء (مقاولات IFRS 15)",
    description: "قيد اعتماد مستخلص للمالك بطريقة نسبة الإنجاز: مدين العملاء (الصافي) ومدين المحتجزات لدى العميل، دائن إيرادات المقاولات وضريبة المخرجات.",
    roles: [
      { key: "receivable",           label: "حساب العملاء (مدين)",           description: "صافي القيمة المستحقة الآن من العميل (شاملاً ضريبة القيمة المضافة).", defaultHintCode: "1210", accountType: "asset" },
      { key: "retention_receivable", label: "محتجزات لدى العميل (مدين)",     description: "نسبة الضمان المحجوزة عند العميل لحين تسليم المشروع.", defaultHintCode: "1215", accountType: "asset" },
      { key: "revenue",              label: "إيرادات المقاولات (دائن)",      description: "قيمة الأعمال المنفذة في فترة المستخلص (الفرق بين الإجمالي التراكمي والمسبق).", defaultHintCode: "4115", accountType: "revenue" },
      { key: "vat_output",           label: "ضريبة المخرجات (دائن)",          description: "ضريبة القيمة المضافة المحصلة من العميل على المستخلص.", defaultHintCode: "2140", accountType: "liability" },
    ],
  },
  {
    key: "contracting_incoming_bill",
    label: "مستخلصات الباطن (مقاولات IFRS 15)",
    description: "قيد اعتماد مستخلص من مقاول الباطن: مدين أعمال تحت التنفيذ ومدين ضريبة المدخلات، دائن المورد (الصافي) ودائن محتجزات الموردين.",
    roles: [
      { key: "wip",               label: "أعمال تحت التنفيذ (مدين)",   description: "تكلفة الأعمال المنفذة في فترة المستخلص — تُرسمل ضمن تكلفة المشروع.", defaultHintCode: "1310", accountType: "asset" },
      { key: "vat_input",         label: "ضريبة المدخلات (مدين)",       description: "ضريبة القيمة المضافة على فاتورة الباطن القابلة للاسترداد.", defaultHintCode: "1240", accountType: "asset" },
      { key: "payable",           label: "مستحق مقاول الباطن (دائن)",   description: "صافي القيمة المستحقة الدفع للباطن (شاملاً ضريبة القيمة المضافة).", defaultHintCode: "2110", accountType: "liability" },
      { key: "retention_payable", label: "محتجزات الموردين (دائن)",     description: "نسبة الضمان المحجوزة من الباطن لحين انتهاء أعماله.", defaultHintCode: "2115", accountType: "liability" },
    ],
  },
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
