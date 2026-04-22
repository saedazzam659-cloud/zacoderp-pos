// Chart of Accounts templates following Saudi/IFRS-aligned conventions.
// Coding standard: 1 char = main group, 2 chars = sub-group, 4 chars = control
// account, 5+ chars = posting (leaf) account.
//
// 1xxxx Assets       (الأصول)
// 2xxxx Liabilities  (الخصوم)
// 3xxxx Equity       (حقوق الملكية)
// 4xxxx Revenue      (الإيرادات)
// 5xxxx Expenses     (المصروفات)
// 6xxxx Manufacturing Costs — industrial only

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export type ReportDirection = "" | "balance_sheet" | "income_statement";

export interface CoaRow {
  code: string;
  nameAr: string;
  nameEn?: string;
  accountType: AccountType;
  parentCode?: string;
  level?: number;
  isPosting?: boolean;
  isActive?: boolean;
  reportDirection?: ReportDirection;
  notes?: string;
}

// ─── Header rows shared across templates ──────────────────────────────────────
const HEADERS: CoaRow[] = [
  // Assets
  { code: "1",     nameAr: "الأصول",                         nameEn: "ASSETS",                       accountType: "asset",     level: 1, isPosting: false },
  { code: "11",    nameAr: "الأصول المتداولة",               nameEn: "Current Assets",               accountType: "asset",     level: 2, isPosting: false, parentCode: "1" },
  { code: "1101",  nameAr: "النقدية وما في حكمها",            nameEn: "Cash and Cash Equivalents",    accountType: "asset",     level: 3, isPosting: false, parentCode: "11" },
  { code: "1102",  nameAr: "البنوك",                          nameEn: "Banks",                        accountType: "asset",     level: 3, isPosting: false, parentCode: "11" },
  { code: "1103",  nameAr: "العملاء والذمم المدينة",          nameEn: "Accounts Receivable",          accountType: "asset",     level: 3, isPosting: false, parentCode: "11" },
  { code: "1104",  nameAr: "أوراق القبض",                     nameEn: "Notes Receivable",             accountType: "asset",     level: 3, isPosting: false, parentCode: "11" },
  { code: "1105",  nameAr: "المخزون",                         nameEn: "Inventory",                    accountType: "asset",     level: 3, isPosting: false, parentCode: "11" },
  { code: "1106",  nameAr: "المصروفات المدفوعة مقدماً",       nameEn: "Prepaid Expenses",             accountType: "asset",     level: 3, isPosting: false, parentCode: "11" },
  { code: "1107",  nameAr: "ضريبة القيمة المضافة المدخلة",   nameEn: "VAT Receivable (Input)",       accountType: "asset",     level: 3, isPosting: false, parentCode: "11" },
  { code: "1108",  nameAr: "أرصدة مدينة أخرى",                nameEn: "Other Receivables",            accountType: "asset",     level: 3, isPosting: false, parentCode: "11" },

  { code: "12",    nameAr: "الأصول غير المتداولة",            nameEn: "Non-current Assets",           accountType: "asset",     level: 2, isPosting: false, parentCode: "1" },
  { code: "1201",  nameAr: "الأصول الثابتة",                  nameEn: "Property, Plant & Equipment",  accountType: "asset",     level: 3, isPosting: false, parentCode: "12" },
  { code: "1202",  nameAr: "مجمع الإهلاك",                    nameEn: "Accumulated Depreciation",     accountType: "asset",     level: 3, isPosting: false, parentCode: "12" },
  { code: "1203",  nameAr: "الأصول غير الملموسة",             nameEn: "Intangible Assets",            accountType: "asset",     level: 3, isPosting: false, parentCode: "12" },

  // Liabilities
  { code: "2",     nameAr: "الخصوم",                          nameEn: "LIABILITIES",                  accountType: "liability", level: 1, isPosting: false },
  { code: "21",    nameAr: "الخصوم المتداولة",                nameEn: "Current Liabilities",          accountType: "liability", level: 2, isPosting: false, parentCode: "2" },
  { code: "2101",  nameAr: "الموردون والذمم الدائنة",         nameEn: "Accounts Payable",             accountType: "liability", level: 3, isPosting: false, parentCode: "21" },
  { code: "2102",  nameAr: "أوراق الدفع",                     nameEn: "Notes Payable",                accountType: "liability", level: 3, isPosting: false, parentCode: "21" },
  { code: "2103",  nameAr: "قروض قصيرة الأجل",                nameEn: "Short-term Loans",             accountType: "liability", level: 3, isPosting: false, parentCode: "21" },
  { code: "2104",  nameAr: "ضريبة القيمة المضافة المستحقة",   nameEn: "VAT Payable (Output)",         accountType: "liability", level: 3, isPosting: false, parentCode: "21" },
  { code: "2105",  nameAr: "الرواتب والأجور المستحقة",        nameEn: "Salaries Payable",             accountType: "liability", level: 3, isPosting: false, parentCode: "21" },
  { code: "2106",  nameAr: "الزكاة وضريبة الدخل المستحقة",    nameEn: "Zakat & Income Tax Payable",   accountType: "liability", level: 3, isPosting: false, parentCode: "21" },
  { code: "2107",  nameAr: "مصروفات مستحقة",                  nameEn: "Accrued Expenses",             accountType: "liability", level: 3, isPosting: false, parentCode: "21" },
  { code: "2108",  nameAr: "أرصدة دائنة أخرى",                nameEn: "Other Payables",               accountType: "liability", level: 3, isPosting: false, parentCode: "21" },

  { code: "22",    nameAr: "الخصوم غير المتداولة",            nameEn: "Non-current Liabilities",      accountType: "liability", level: 2, isPosting: false, parentCode: "2" },
  { code: "2201",  nameAr: "قروض طويلة الأجل",                nameEn: "Long-term Loans",              accountType: "liability", level: 3, isPosting: false, parentCode: "22" },
  { code: "2202",  nameAr: "مخصص مكافأة نهاية الخدمة",        nameEn: "End-of-Service Provision",     accountType: "liability", level: 3, isPosting: false, parentCode: "22" },

  // Equity
  { code: "3",     nameAr: "حقوق الملكية",                    nameEn: "EQUITY",                       accountType: "equity",    level: 1, isPosting: false },
  { code: "31",    nameAr: "رأس المال",                       nameEn: "Capital",                      accountType: "equity",    level: 2, isPosting: false, parentCode: "3" },
  { code: "32",    nameAr: "الاحتياطيات",                     nameEn: "Reserves",                     accountType: "equity",    level: 2, isPosting: false, parentCode: "3" },
  { code: "33",    nameAr: "الأرباح المرحّلة",                nameEn: "Retained Earnings",            accountType: "equity",    level: 2, isPosting: false, parentCode: "3" },
  { code: "34",    nameAr: "أرباح / خسائر العام الحالي",       nameEn: "Current Year P&L",             accountType: "equity",    level: 2, isPosting: false, parentCode: "3" },
  { code: "35",    nameAr: "السحب الشخصي",                    nameEn: "Owner Drawings",               accountType: "equity",    level: 2, isPosting: false, parentCode: "3" },
];

// ─── Postable leaves (commercial) ─────────────────────────────────────────────
const COMMERCIAL_LEAVES: CoaRow[] = [
  // Cash & banks
  { code: "11011", nameAr: "الصندوق الرئيسي",                 nameEn: "Main Cash",                    accountType: "asset",     level: 4, isPosting: true, parentCode: "1101" },
  { code: "11012", nameAr: "صندوق المبيعات",                  nameEn: "Sales Cash",                   accountType: "asset",     level: 4, isPosting: true, parentCode: "1101" },
  { code: "11021", nameAr: "البنك الأهلي السعودي",            nameEn: "SNB Bank",                     accountType: "asset",     level: 4, isPosting: true, parentCode: "1102" },
  { code: "11022", nameAr: "بنك الراجحي",                     nameEn: "Al Rajhi Bank",                accountType: "asset",     level: 4, isPosting: true, parentCode: "1102" },

  // AR + Inventory + VAT
  { code: "11031", nameAr: "العملاء — محليون",                nameEn: "Local Customers",              accountType: "asset",     level: 4, isPosting: true, parentCode: "1103" },
  { code: "11032", nameAr: "العملاء — تصدير",                 nameEn: "Export Customers",             accountType: "asset",     level: 4, isPosting: true, parentCode: "1103" },
  { code: "11033", nameAr: "مخصص الديون المشكوك فيها",        nameEn: "Allowance for Doubtful Debts", accountType: "asset",     level: 4, isPosting: true, parentCode: "1103" },
  { code: "11051", nameAr: "مخزون البضاعة",                   nameEn: "Merchandise Inventory",        accountType: "asset",     level: 4, isPosting: true, parentCode: "1105" },
  { code: "11071", nameAr: "ضريبة القيمة المضافة — مشتريات",  nameEn: "VAT Input on Purchases",       accountType: "asset",     level: 4, isPosting: true, parentCode: "1107" },

  // Fixed assets
  { code: "12011", nameAr: "أراضي ومباني",                    nameEn: "Land & Buildings",             accountType: "asset",     level: 4, isPosting: true, parentCode: "1201" },
  { code: "12012", nameAr: "أثاث ومعدات مكتبية",              nameEn: "Furniture & Office Equipment", accountType: "asset",     level: 4, isPosting: true, parentCode: "1201" },
  { code: "12013", nameAr: "أجهزة حاسب آلي",                  nameEn: "Computers",                    accountType: "asset",     level: 4, isPosting: true, parentCode: "1201" },
  { code: "12014", nameAr: "وسائل نقل",                       nameEn: "Vehicles",                     accountType: "asset",     level: 4, isPosting: true, parentCode: "1201" },
  { code: "12021", nameAr: "مجمع إهلاك المباني",              nameEn: "Acc. Depreciation — Buildings",accountType: "asset",     level: 4, isPosting: true, parentCode: "1202" },
  { code: "12022", nameAr: "مجمع إهلاك الأثاث",               nameEn: "Acc. Depreciation — Furniture",accountType: "asset",     level: 4, isPosting: true, parentCode: "1202" },
  { code: "12023", nameAr: "مجمع إهلاك الحاسب الآلي",         nameEn: "Acc. Depreciation — Computers",accountType: "asset",     level: 4, isPosting: true, parentCode: "1202" },
  { code: "12024", nameAr: "مجمع إهلاك السيارات",             nameEn: "Acc. Depreciation — Vehicles", accountType: "asset",     level: 4, isPosting: true, parentCode: "1202" },

  // Liabilities leaves
  { code: "21011", nameAr: "موردون محليون",                   nameEn: "Local Suppliers",              accountType: "liability", level: 4, isPosting: true, parentCode: "2101" },
  { code: "21012", nameAr: "موردون أجانب",                    nameEn: "Foreign Suppliers",            accountType: "liability", level: 4, isPosting: true, parentCode: "2101" },
  { code: "21041", nameAr: "ضريبة القيمة المضافة — مبيعات",   nameEn: "VAT Output on Sales",          accountType: "liability", level: 4, isPosting: true, parentCode: "2104" },
  { code: "21051", nameAr: "رواتب وأجور مستحقة",              nameEn: "Salaries Accrued",             accountType: "liability", level: 4, isPosting: true, parentCode: "2105" },

  // Equity
  { code: "3101",  nameAr: "رأس المال المدفوع",               nameEn: "Paid-in Capital",              accountType: "equity",    level: 3, isPosting: true, parentCode: "31" },
  { code: "3201",  nameAr: "احتياطي نظامي",                   nameEn: "Statutory Reserve",            accountType: "equity",    level: 3, isPosting: true, parentCode: "32" },
  { code: "3301",  nameAr: "أرباح مرحّلة من سنوات سابقة",     nameEn: "Retained Earnings — Prior",    accountType: "equity",    level: 3, isPosting: true, parentCode: "33" },
  { code: "3401",  nameAr: "صافي الربح / الخسارة للسنة",      nameEn: "Net Income / Loss",            accountType: "equity",    level: 3, isPosting: true, parentCode: "34" },

  // Revenue
  { code: "4",     nameAr: "الإيرادات",                       nameEn: "REVENUE",                      accountType: "revenue",   level: 1, isPosting: false },
  { code: "41",    nameAr: "إيرادات النشاط الرئيسي",          nameEn: "Operating Revenue",            accountType: "revenue",   level: 2, isPosting: false, parentCode: "4" },
  { code: "4101",  nameAr: "مبيعات",                          nameEn: "Sales",                        accountType: "revenue",   level: 3, isPosting: true, parentCode: "41" },
  { code: "4102",  nameAr: "مردودات المبيعات",                nameEn: "Sales Returns",                accountType: "revenue",   level: 3, isPosting: true, parentCode: "41" },
  { code: "4103",  nameAr: "خصم مكتسب",                       nameEn: "Discount Earned",              accountType: "revenue",   level: 3, isPosting: true, parentCode: "41" },
  { code: "42",    nameAr: "إيرادات أخرى",                    nameEn: "Other Revenue",                accountType: "revenue",   level: 2, isPosting: false, parentCode: "4" },
  { code: "4201",  nameAr: "أرباح بيع أصول",                  nameEn: "Gain on Sale of Assets",       accountType: "revenue",   level: 3, isPosting: true, parentCode: "42" },
  { code: "4202",  nameAr: "إيرادات متنوعة",                  nameEn: "Miscellaneous Revenue",        accountType: "revenue",   level: 3, isPosting: true, parentCode: "42" },

  // Expenses
  { code: "5",     nameAr: "المصروفات",                       nameEn: "EXPENSES",                     accountType: "expense",   level: 1, isPosting: false },
  { code: "51",    nameAr: "تكلفة المبيعات",                  nameEn: "Cost of Goods Sold",           accountType: "expense",   level: 2, isPosting: false, parentCode: "5" },
  { code: "5101",  nameAr: "تكلفة البضاعة المباعة",           nameEn: "COGS",                         accountType: "expense",   level: 3, isPosting: true, parentCode: "51" },
  { code: "5102",  nameAr: "مردودات المشتريات",               nameEn: "Purchase Returns",             accountType: "expense",   level: 3, isPosting: true, parentCode: "51" },
  { code: "5103",  nameAr: "خصم ممنوح",                       nameEn: "Discount Allowed",             accountType: "expense",   level: 3, isPosting: true, parentCode: "51" },

  { code: "52",    nameAr: "المصروفات الإدارية والعمومية",    nameEn: "G&A Expenses",                 accountType: "expense",   level: 2, isPosting: false, parentCode: "5" },
  { code: "5201",  nameAr: "رواتب وأجور",                     nameEn: "Salaries & Wages",             accountType: "expense",   level: 3, isPosting: true, parentCode: "52" },
  { code: "5202",  nameAr: "بدلات وحوافز",                    nameEn: "Allowances & Bonuses",         accountType: "expense",   level: 3, isPosting: true, parentCode: "52" },
  { code: "5203",  nameAr: "تأمينات اجتماعية",                nameEn: "Social Insurance (GOSI)",      accountType: "expense",   level: 3, isPosting: true, parentCode: "52" },
  { code: "5204",  nameAr: "إيجارات",                         nameEn: "Rent",                         accountType: "expense",   level: 3, isPosting: true, parentCode: "52" },
  { code: "5205",  nameAr: "كهرباء وماء",                     nameEn: "Utilities",                    accountType: "expense",   level: 3, isPosting: true, parentCode: "52" },
  { code: "5206",  nameAr: "اتصالات وإنترنت",                 nameEn: "Communications",               accountType: "expense",   level: 3, isPosting: true, parentCode: "52" },
  { code: "5207",  nameAr: "قرطاسية ومطبوعات",                nameEn: "Stationery & Printing",        accountType: "expense",   level: 3, isPosting: true, parentCode: "52" },
  { code: "5208",  nameAr: "صيانة وإصلاحات",                  nameEn: "Maintenance & Repairs",        accountType: "expense",   level: 3, isPosting: true, parentCode: "52" },
  { code: "5209",  nameAr: "ضيافة وحفلات",                    nameEn: "Hospitality",                  accountType: "expense",   level: 3, isPosting: true, parentCode: "52" },
  { code: "5210",  nameAr: "أتعاب مهنية واستشارات",           nameEn: "Professional Fees",            accountType: "expense",   level: 3, isPosting: true, parentCode: "52" },
  { code: "5211",  nameAr: "اشتراكات ورسوم حكومية",           nameEn: "Government Fees",              accountType: "expense",   level: 3, isPosting: true, parentCode: "52" },
  { code: "5212",  nameAr: "مصروفات بنكية",                   nameEn: "Bank Charges",                 accountType: "expense",   level: 3, isPosting: true, parentCode: "52" },
  { code: "5215",  nameAr: "مكافأة نهاية الخدمة",              nameEn: "End-of-Service Expense",       accountType: "expense",   level: 3, isPosting: true, parentCode: "52" },
  // HR-related postable liabilities/assets
  { code: "21051", nameAr: "صافي الرواتب المستحقة الدفع",       nameEn: "Net Salaries Payable",         accountType: "liability", level: 4, isPosting: true, parentCode: "2105" },
  { code: "21052", nameAr: "تأمينات اجتماعية مستحقة الدفع",     nameEn: "GOSI Payable",                 accountType: "liability", level: 4, isPosting: true, parentCode: "2105" },
  { code: "21053", nameAr: "استقطاعات أخرى مستحقة الدفع",       nameEn: "Other Deductions Payable",     accountType: "liability", level: 4, isPosting: true, parentCode: "2105" },
  { code: "11081", nameAr: "سلف وعُهد الموظفين",                nameEn: "Loans & Advances to Employees",accountType: "asset",     level: 4, isPosting: true, parentCode: "1108" },
  { code: "22021", nameAr: "مخصص مكافأة نهاية الخدمة",          nameEn: "EOS Provision",                accountType: "liability", level: 4, isPosting: true, parentCode: "2202" },

  { code: "53",    nameAr: "مصروفات البيع والتسويق",          nameEn: "Selling & Marketing",          accountType: "expense",   level: 2, isPosting: false, parentCode: "5" },
  { code: "5301",  nameAr: "دعاية وإعلان",                    nameEn: "Advertising",                  accountType: "expense",   level: 3, isPosting: true, parentCode: "53" },
  { code: "5302",  nameAr: "عمولات مبيعات",                   nameEn: "Sales Commissions",            accountType: "expense",   level: 3, isPosting: true, parentCode: "53" },
  { code: "5303",  nameAr: "نقل وشحن مبيعات",                 nameEn: "Freight Out",                  accountType: "expense",   level: 3, isPosting: true, parentCode: "53" },

  { code: "54",    nameAr: "الإهلاكات",                       nameEn: "Depreciation",                 accountType: "expense",   level: 2, isPosting: false, parentCode: "5" },
  { code: "5401",  nameAr: "إهلاك الأصول الثابتة",            nameEn: "Depreciation Expense",         accountType: "expense",   level: 3, isPosting: true, parentCode: "54" },
  { code: "5402",  nameAr: "إطفاء الأصول غير الملموسة",       nameEn: "Amortization Expense",         accountType: "expense",   level: 3, isPosting: true, parentCode: "54" },

  { code: "55",    nameAr: "مصروفات أخرى",                    nameEn: "Other Expenses",               accountType: "expense",   level: 2, isPosting: false, parentCode: "5" },
  { code: "5501",  nameAr: "خسائر بيع أصول",                  nameEn: "Loss on Sale of Assets",       accountType: "expense",   level: 3, isPosting: true, parentCode: "55" },
  { code: "5502",  nameAr: "ديون معدومة",                     nameEn: "Bad Debts",                    accountType: "expense",   level: 3, isPosting: true, parentCode: "55" },
  { code: "5503",  nameAr: "غرامات وجزاءات",                  nameEn: "Fines & Penalties",            accountType: "expense",   level: 3, isPosting: true, parentCode: "55" },
];

// ─── Industrial-only additions ────────────────────────────────────────────────
const INDUSTRIAL_EXTRA: CoaRow[] = [
  // Inventory subtypes
  { code: "11052", nameAr: "مخزون المواد الخام",              nameEn: "Raw Materials Inventory",      accountType: "asset",     level: 4, isPosting: true, parentCode: "1105" },
  { code: "11053", nameAr: "مخزون الإنتاج تحت التشغيل",       nameEn: "Work in Process",              accountType: "asset",     level: 4, isPosting: true, parentCode: "1105" },
  { code: "11054", nameAr: "مخزون الإنتاج التام",             nameEn: "Finished Goods Inventory",     accountType: "asset",     level: 4, isPosting: true, parentCode: "1105" },
  { code: "11055", nameAr: "مخزون قطع الغيار والمستلزمات",    nameEn: "Spare Parts & Supplies",       accountType: "asset",     level: 4, isPosting: true, parentCode: "1105" },

  // Manufacturing fixed assets
  { code: "12015", nameAr: "آلات ومعدات إنتاج",               nameEn: "Production Machinery",         accountType: "asset",     level: 4, isPosting: true, parentCode: "1201" },
  { code: "12025", nameAr: "مجمع إهلاك آلات الإنتاج",         nameEn: "Acc. Depreciation — Machinery",accountType: "asset",     level: 4, isPosting: true, parentCode: "1202" },

  // Manufacturing cost section
  { code: "6",     nameAr: "تكاليف الإنتاج (الصناعية)",       nameEn: "MANUFACTURING COSTS",          accountType: "expense",   level: 1, isPosting: false },
  { code: "61",    nameAr: "المواد المباشرة",                 nameEn: "Direct Materials",             accountType: "expense",   level: 2, isPosting: false, parentCode: "6" },
  { code: "6101",  nameAr: "استخدام المواد الخام",            nameEn: "Raw Materials Used",           accountType: "expense",   level: 3, isPosting: true, parentCode: "61" },

  { code: "62",    nameAr: "العمالة المباشرة",                nameEn: "Direct Labor",                 accountType: "expense",   level: 2, isPosting: false, parentCode: "6" },
  { code: "6201",  nameAr: "أجور عمال الإنتاج",               nameEn: "Production Wages",             accountType: "expense",   level: 3, isPosting: true, parentCode: "62" },
  { code: "6202",  nameAr: "تأمينات عمال الإنتاج",            nameEn: "Production Labor Insurance",   accountType: "expense",   level: 3, isPosting: true, parentCode: "62" },

  { code: "63",    nameAr: "التكاليف الصناعية غير المباشرة",  nameEn: "Manufacturing Overhead",       accountType: "expense",   level: 2, isPosting: false, parentCode: "6" },
  { code: "6301",  nameAr: "مواد غير مباشرة",                 nameEn: "Indirect Materials",           accountType: "expense",   level: 3, isPosting: true, parentCode: "63" },
  { code: "6302",  nameAr: "أجور غير مباشرة (مشرفين)",        nameEn: "Indirect Labor",               accountType: "expense",   level: 3, isPosting: true, parentCode: "63" },
  { code: "6303",  nameAr: "إهلاك آلات الإنتاج",              nameEn: "Machinery Depreciation",       accountType: "expense",   level: 3, isPosting: true, parentCode: "63" },
  { code: "6304",  nameAr: "كهرباء وماء المصنع",              nameEn: "Factory Utilities",            accountType: "expense",   level: 3, isPosting: true, parentCode: "63" },
  { code: "6305",  nameAr: "صيانة آلات الإنتاج",              nameEn: "Machinery Maintenance",        accountType: "expense",   level: 3, isPosting: true, parentCode: "63" },
  { code: "6306",  nameAr: "إيجار المصنع",                    nameEn: "Factory Rent",                 accountType: "expense",   level: 3, isPosting: true, parentCode: "63" },
  { code: "6307",  nameAr: "تأمين على المصنع",                nameEn: "Factory Insurance",            accountType: "expense",   level: 3, isPosting: true, parentCode: "63" },
  { code: "6308",  nameAr: "وقود ومحروقات الإنتاج",            nameEn: "Factory Fuel",                 accountType: "expense",   level: 3, isPosting: true, parentCode: "63" },
];

// Auto-derive reportDirection from accountType so it appears next to every
// row in the downloaded Excel template:
//   asset / liability / equity → balance_sheet (مركز مالي)
//   revenue / expense          → income_statement (قائمة دخل)
function withDirection(rows: CoaRow[]): CoaRow[] {
  return rows.map(r => ({
    ...r,
    reportDirection: r.reportDirection ?? (
      r.accountType === "revenue" || r.accountType === "expense"
        ? "income_statement"
        : "balance_sheet"
    ),
  }));
}

export const COA_TEMPLATES = {
  empty:      [] as CoaRow[],
  commercial: withDirection([...HEADERS, ...COMMERCIAL_LEAVES]),
  industrial: withDirection([...HEADERS, ...COMMERCIAL_LEAVES, ...INDUSTRIAL_EXTRA]),
};

export const TEMPLATE_LABELS: Record<keyof typeof COA_TEMPLATES, string> = {
  empty:      "قالب فارغ (للتعبئة اليدوية)",
  commercial: "شركة تجارية — دليل حسابات معياري",
  industrial: "شركة صناعية — دليل حسابات معياري",
};
