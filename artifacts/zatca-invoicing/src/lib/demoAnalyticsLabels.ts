import { MODULE_GROUPS } from "@/lib/menuItems";

const MODULE_LABELS: Record<string, string> = {
  home: "الرئيسية",
  dashboard: "لوحة التحكم",
  sales: "المبيعات",
  purchasing: "المشتريات",
  inventory: "المخزون",
  accounting: "الحسابات العامة",
  cash: "النقد",
  bank: "البنوك",
  reports: "التقارير",
  invoices: "الفواتير",
  customers: "العملاء",
  suppliers: "الموردون",
  items: "الأصناف",
  warehouses: "المستودعات",
  hr: "شؤون الموظفين",
  "fixed-assets": "الأصول الثابتة",
  zatca: "الربط مع زاتكا",
  integrations: "التكاملات",
  office: "أوفيس زاكود",
  training: "التدريب",
  pos: "نقاط البيع",
  documents: "المستندات",
  archive: "الأرشيف",
  notifications: "الإشعارات",
  extensions: "الإضافات",
  companies: "الشركات",
  settings: "الإعدادات",
};

const ACTION_LABELS: Record<string, string> = {
  create: "إنشاء",
  add: "إضافة",
  update: "تحديث",
  edit: "تعديل",
  delete: "حذف",
  save: "حفظ",
  post: "ترحيل",
  unpost: "فك الترحيل",
  approve: "اعتماد",
  reject: "رفض",
  archive: "أرشفة",
  restore: "استعادة",
  print: "طباعة",
  export: "تصدير",
  report: "عرض تقرير",
  login: "تسجيل دخول",
  logout: "تسجيل خروج",
  view: "عرض",
};

const EVENT_LABELS: Record<string, string> = {
  screen_view: "زيارة شاشة",
  module_view: "زيارة قسم",
  action: "تنفيذ إجراء",
};

function normalizePath(path: string): string {
  return path
    .split(/[?#]/)[0]
    .replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/+$/, "") || "/";
}

const SCREEN_LABELS = new Map<string, string>();
for (const group of MODULE_GROUPS) {
  for (const screen of group.screens) {
    const path = normalizePath(screen.path);
    SCREEN_LABELS.set(path, screen.label);
    SCREEN_LABELS.set(path.replace(/^\//, "").replace(/\//g, "_"), screen.label);
  }
}
SCREEN_LABELS.set("/", "الرئيسية");
SCREEN_LABELS.set("home", "الرئيسية");
SCREEN_LABELS.set("/admin/demo-analytics", "متابعة الديمو");
SCREEN_LABELS.set("admin_demo-analytics", "متابعة الديمو");

function readableFallback(kind: "قسم" | "شاشة" | "إجراء" | "حدث"): string {
  return `${kind} أخرى`;
}

export function demoModuleLabel(key: unknown): string {
  const value = String(key ?? "").trim().toLowerCase();
  return MODULE_LABELS[value] ?? readableFallback("قسم");
}

export function demoScreenLabel(screenKey: unknown, route?: unknown): string {
  const normalizedRoute = normalizePath(String(route ?? ""));
  const normalizedKey = String(screenKey ?? "").trim();
  return SCREEN_LABELS.get(normalizedRoute)
    ?? SCREEN_LABELS.get(normalizedKey)
    ?? readableFallback("شاشة");
}

export function demoActionLabel(key: unknown): string {
  const value = String(key ?? "").trim().toLowerCase().split(/[_.:-]/, 1)[0];
  return ACTION_LABELS[value] ?? readableFallback("إجراء");
}

export function demoEventTypeLabel(type: unknown): string {
  return EVENT_LABELS[String(type ?? "")] ?? readableFallback("حدث");
}