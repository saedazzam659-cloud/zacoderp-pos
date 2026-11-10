export interface SalesPrintTemplateOption {
  id: number;
  name: string;
  desc: string;
  color: string;
  thermal: boolean;
}

export const SALES_PRINT_TEMPLATE_CATALOG: SalesPrintTemplateOption[] = [
  { id: 14, name: "الأصلي", desc: "نموذج مرتب بشعار وسط وبيانات شركة/عميل جانبية", color: "#b88a2a", thermal: false },
  { id: 15, name: "كلاسيكي ثنائي اللغة", desc: "نموذج تجاري بحدود كاملة عربي/إنجليزي", color: "#7c4a12", thermal: false },
  { id: 20, name: "كلاسيكي مدمج", desc: "نموذج أبيض وأسود بجدول مدمج وشعار ورمز QR", color: "#333333", thermal: false },
  { id: 1, name: "كلاسيكي", desc: "حدود وجداول تقليدية", color: "#2563eb", thermal: false },
  { id: 2, name: "حديث", desc: "تصميم نظيف بهيدر أخضر", color: "#059669", thermal: false },
  { id: 3, name: "مؤسسي", desc: "هيدر داكن احترافي", color: "#1e3a5f", thermal: false },
  { id: 4, name: "ملوّن", desc: "ألوان دافئة مع تدرج", color: "#d97706", thermal: false },
  { id: 5, name: "ZATCA رسمي", desc: "النموذج الحكومي مع QR", color: "#1a6e3d", thermal: false },
  { id: 8, name: "نقي أنيق", desc: "أبيض وأسود ولمسة ذهبية", color: "#0f172a", thermal: false },
  { id: 9, name: "ذهبي فاخر", desc: "خلفية داكنة ولمسات ذهبية", color: "#1c1917", thermal: false },
  { id: 10, name: "بحري عميق", desc: "تدرج أزرق مع موجة سفلية", color: "#0e7490", thermal: false },
  { id: 11, name: "حيوي", desc: "تدرجات بنفسجية ووردية", color: "#a855f7", thermal: false },
  { id: 12, name: "تنفيذي", desc: "شريط جانبي ببيانات الشركة", color: "#0f172a", thermal: false },
  { id: 13, name: "أنيق ذهبي", desc: "أونكس وذهب فاخر مع QR وتفقيط", color: "#c9a35e", thermal: false },
  { id: 6, name: "حراري كلاسيكي", desc: "إيصال 80mm أبيض/أسود", color: "#111111", thermal: true },
  { id: 7, name: "حراري عصري", desc: "إيصال 80mm ملوّن", color: "#0f766e", thermal: true },
];

export function getEnabledSalesPrintTemplates(company: {
  printEnabledTemplates?: unknown;
} | null | undefined): SalesPrintTemplateOption[] {
  const ids = company?.printEnabledTemplates;
  if (!Array.isArray(ids) || ids.length === 0) return SALES_PRINT_TEMPLATE_CATALOG;
  const enabled = new Set(ids.map(Number).filter(Number.isInteger));
  const visible = SALES_PRINT_TEMPLATE_CATALOG.filter(template => enabled.has(template.id));
  return visible.length > 0 ? visible : SALES_PRINT_TEMPLATE_CATALOG;
}

export function getDefaultQuotationBaseTemplateId(
  company: {
    printEnabledTemplates?: unknown;
    printDefaultTemplateQuotation?: unknown;
    printDefaultTemplate?: unknown;
  } | null | undefined,
  available: SalesPrintTemplateOption[] = getEnabledSalesPrintTemplates(company),
): number {
  const quotationDefault = Number(company?.printDefaultTemplateQuotation);
  if (Number.isInteger(quotationDefault) && available.some(item => item.id === quotationDefault)) {
    return quotationDefault;
  }
  const companyDefault = Number(company?.printDefaultTemplate);
  if (Number.isInteger(companyDefault) && available.some(item => item.id === companyDefault)) {
    return companyDefault;
  }
  return available[0]?.id ?? 14;
}
