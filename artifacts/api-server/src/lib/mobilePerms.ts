// ─── Per-user MOBILE APP rights (صلاحيات تطبيق الموبايل) ────────────────────
// users.mobile_permissions JSONB: { "<key>": boolean } | null
// Legacy mobile rights remain allow-by-default and admins bypass them. The
// cash-expense keys below are an explicit opt-in exception, including admins.
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
//   customer_statement_view          عرض كشف حساب عميل
//   customer_statement_detailed_view عرض كشف حساب عميل تفصيلي
//   quotations_view   عرض عروض الأسعار
//   quotation_create  إنشاء عرض سعر
//   quotation_edit    تعديل عرض سعر (يشمل تغيير الحالة والتحويل لفاتورة)
//   quotation_delete  حذف عرض سعر
//   items_view        عرض الأصناف
//   item_create       إضافة صنف
//   item_edit         تعديل صنف
//   item_delete       حذف صنف
//   screen_items      إظهار شاشة الأصناف في شريط التنقّل السفلي
//   screen_invoices   إظهار شاشة الفواتير في شريط التنقّل السفلي
//   screen_customers  إظهار شاشة العملاء في شريط التنقّل السفلي
//   screen_new        إظهار تبويب جديد (+) في شريط التنقّل السفلي
//   screen_reports    إظهار شاشة الملخص في شريط التنقّل السفلي
//   hr_attendance_view  تقرير حضوري وانصرافي (الموظف المرتبط بالمستخدم فقط)
//   offline_controls, server_settings
//   invoice_tab_returns, invoice_tab_details, invoice_save_draft,
//   invoice_save_issue, invoice_free_qty, invoice_discount,
//   invoice_unit_selection
//   invoice_post      ترحيل فاتورة مبيعات
//   invoice_unpost    فك ترحيل فاتورة مبيعات
//   return_post       ترحيل مرتجع مبيعات
//   return_unpost     فك ترحيل مرتجع مبيعات
//   voucher_post      ترحيل سند قبض
//   voucher_unpost    فك ترحيل سند قبض
//   cash_expenses_create/view_own/view_all/edit/post/cancel/report

export type MobilePerms = Record<string, boolean> | null;

export const CASH_EXPENSE_MOBILE_PERMISSION_KEYS = [
  "cash_expenses_create",
  "cash_expenses_view_own",
  "cash_expenses_view_all",
  "cash_expenses_edit",
  "cash_expenses_post",
  "cash_expenses_cancel",
  "cash_expenses_report",
] as const;

export const CASH_TRANSFER_MOBILE_PERMISSION_KEYS = [
  "cash_transfers_create",
  "cash_transfers_view_own",
  "cash_transfers_view_all",
  "cash_transfers_edit",
  "cash_transfers_submit",
  "cash_transfers_approve",
  "cash_transfers_reject",
] as const;

const EXPLICIT_MOBILE_PERMISSION_KEYS = new Set<string>([
  ...CASH_EXPENSE_MOBILE_PERMISSION_KEYS,
  ...CASH_TRANSFER_MOBILE_PERMISSION_KEYS,
  "voice_assistant_use",
]);
EXPLICIT_MOBILE_PERMISSION_KEYS.add("mobile_tracking");

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
  // This new module is opt-in even for admins and even when the stored map is
  // null/legacy. Do not change the allow-by-default rule for older features.
  if (EXPLICIT_MOBILE_PERMISSION_KEYS.has(key)) {
    return user.mobilePermissions?.[key] === true;
  }
  if (user.role === "admin" || user.role === "superadmin") return true;
  const map = user.mobilePermissions;
  if (map == null || typeof map !== "object") return true;
  return (map as Record<string, unknown>)[key] !== false;
}

/** True when the request came from the mobile companion app. */
export function isMobileChannel(req: { headers?: Record<string, unknown> }): boolean {
  return String((req.headers as any)?.["x-app-channel"] ?? "") === "mobile";
}
