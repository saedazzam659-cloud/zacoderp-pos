// ─── Per-user MOBILE APP rights (صلاحيات تطبيق الموبايل) ────────────────────
// users.mobile_permissions JSONB: { "<key>": boolean } | null
// Semantics mirror posting_permissions: NULL / missing key = ALLOWED
// (back-compat — existing users keep full access); explicit false = denied.
// Admin/superadmin always bypass.
//
// Known keys (kept in lockstep with MOBILE_PERM_KEYS in the web Users screen —
// unknown keys are preserved for forward-compat):
//   invoices_view     عرض الفواتير
//   invoice_create    إنشاء فاتورة مبيعات
//   invoice_edit_price تعديل سعر البيع في الفاتورة
//   invoice_print     طباعة / مشاركة PDF
//   invoice_whatsapp  إرسال عبر واتساب
//   returns_view      عرض المرتجعات
//   return_create     إنشاء مرتجع مبيعات
//   vouchers_view     عرض سندات القبض
//   voucher_create    إنشاء سند قبض
//   customers_view    عرض العملاء
//   customer_create   إضافة عميل
//   reports_view      الملخص والتقارير
//   invoice_edit      تعديل فاتورة مبيعات محفوظة
//   invoice_delete    حذف فاتورة مبيعات
//   return_edit       تعديل مرتجع مبيعات
//   return_delete     حذف مرتجع مبيعات
//   voucher_edit      تعديل سند قبض
//   voucher_delete    حذف سند قبض
//   customer_edit     تعديل عميل
//   customer_delete   حذف عميل
//   quotations_view   عرض عروض الأسعار
//   quotation_create  إنشاء عرض سعر
//   quotation_edit    تعديل عرض سعر (يشمل تغيير الحالة والتحويل لفاتورة)
//   quotation_delete  حذف عرض سعر

export type MobilePerms = Record<string, boolean> | null;

/** Clamp the client payload: coerce values to booleans, cap key length. */
export function sanitizeMobilePermissions(raw: any): Record<string, boolean> | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k) continue;
    out[String(k).slice(0, 64)] = v !== false;
  }
  return Object.keys(out).length ? out : null;
}

/** Allowed unless explicitly denied; admin/superadmin bypass. */
export function mobilePermAllowed(
  user: { role?: string | null; mobilePermissions?: any } | null | undefined,
  key: string,
): boolean {
  if (!user) return false;
  if (user.role === "admin" || user.role === "superadmin") return true;
  const map = user.mobilePermissions;
  if (map == null || typeof map !== "object") return true;
  return (map as Record<string, unknown>)[key] !== false;
}

/** True when the request came from the mobile companion app. */
export function isMobileChannel(req: { headers?: Record<string, unknown> }): boolean {
  return String((req.headers as any)?.["x-app-channel"] ?? "") === "mobile";
}
