export interface ControlRule {
  key: string; name: string; module: string; category: string; severity: string;
  enabled: boolean; threshold: number | null; thresholdUnit: string | null;
  excludedUserIds: number[]; excludedRoles: string[]; supported: boolean;
  unsupportedReason: string | null;
}
function rule(key: string, name: string, category: string, severity = "medium", unit: string | null = null): ControlRule {
  return { key, name, module: category, category, severity, enabled: !unit, threshold: null, thresholdUnit: unit,
    excludedUserIds: [], excludedRoles: [], supported: true, unsupportedReason: null };
}
export const INTERNAL_CONTROL_RULES: ControlRule[] = [
  rule("permission_denied", "محاولة تنفيذ عملية بدون صلاحية", "permissions", "high"),
  rule("post_approval_edit", "تعديل بعد الاعتماد مثبت بسجل التدقيق", "post_approval", "high"),
  rule("document_cancelled", "إلغاء أو حذف مستند مسجل بالتدقيق", "cancelled"),
  rule("master_data_change", "تغيير بيانات مالية أساسية مسجل بالتدقيق", "master_data"),
  rule("high_payment", "سند صرف يتجاوز الحد المحدد", "finance", "high", "amount"),
  rule("high_receipt", "سند قبض يتجاوز الحد المحدد", "finance", "high", "amount"),
  rule("journal_no_reference", "قيد مرحل دون وصف أو رقم مرجعي", "finance"),
  rule("same_creator_approver", "إنشاء واعتماد القيد بواسطة نفس المستخدم — سياسة اختيارية", "permissions"),
  rule("sales_discount", "خصم المبيعات يتجاوز النسبة المحددة", "sales", "medium", "percent"),
  rule("purchase_missing_supplier", "فاتورة شراء مرحلة بدون مورد", "purchases", "high"),
  rule("duplicate_supplier_invoice", "تكرار رقم فاتورة المورد ضمن نفس الفرع", "purchases", "high"),
  rule("negative_stock", "رصيد مخزون يتجاوز سياسة السالب بالمستودع", "inventory", "high"),
  rule("manual_stock_adjustment", "تسوية مخزنية يدوية تحتاج مراجعة", "inventory"),
  rule("guarantee_expired", "خطاب ضمان ساري تجاوز تاريخ الانتهاء", "guarantees", "high"),
  rule("guarantee_expiring", "خطاب ضمان يقترب من الانتهاء", "guarantees", "high", "days"),
  rule("advance_missing_contract", "دفعة مقاولات مرحلة دون عقد مرتبط", "advances", "high"),
  rule("bill_retention_disabled", "محتجز رغم تعطيله في لقطة سياسة المستخلص", "projects", "high"),
  rule("bill_recovery_snapshot", "عدم اتساق رصيد الاسترداد في لقطة المستخلص", "projects", "high"),
  rule("prepaid_overallocated", "تسويات المصروف المقدم تتجاوز قيمته", "finance", "high"),
  rule("high_general_journal", "قيد عام أنشأه مستخدم يتجاوز الحد المالي", "finance", "high", "amount"),
  rule("journal_backdated", "تاريخ القيد يسبق إنشاءه بأكثر من المدة المحددة", "finance", "medium", "days"),
  rule("sales_backdated", "تاريخ فاتورة البيع يسبق إنشاءها بأكثر من المدة المحددة", "sales", "medium", "days"),
  rule("purchase_backdated", "تاريخ فاتورة الشراء يسبق إنشاءها بأكثر من المدة المحددة", "purchases", "medium", "days"),
  rule("guarantee_missing_link", "ضمان صادر دون رابط المناقصة أو العقد المطلوب", "guarantees", "high"),
  rule("guarantee_percent_mismatch", "قيمة ضمان نسبي لا تطابق أساسه ونسبته المسجلين دون سبب تجاوز", "guarantees", "high"),
  rule("stock_large_issue", "كمية صرف حركة مخزنية تتجاوز الحد بوحدة الصنف الأساسية", "inventory", "medium", "quantity"),
  rule("stock_large_transfer", "بند تحويل مخزني يتجاوز الحد بوحدة الصنف الأساسية", "inventory", "medium", "quantity"),
  rule("stock_count_difference", "فروق فعلية في جرد مرحل تستلزم المراجعة", "inventory"),
  rule("prepaid_missing_reference", "مصروف مقدم يدوي دون مستند مصدر أو ملاحظة مرجعية — مراجعة اختيارية", "finance"),
  rule("prepaid_schedule_due", "قسط مصروف مقدم مستحق لم ينشأ حسب جدول الدورة الفعلي", "finance", "high", "days"),
  rule("prepaid_unposted_run", "قيد تسوية مصروف مقدم لا يزال مسودة بعد المدة المحددة", "finance", "medium", "days"),
  rule("bill_exceeds_unchanged_contract", "مستخلص مرحل يتجاوز عقده الأصلي غير المعدل وبدون ملاحق", "projects", "high"),
  rule("bill_quantity_exceeded", "كمية تراكمية تتجاوز بند العقد غير المعدل دون موافقة تجاوز", "projects", "high"),
  ...[
    ["purchase_price_variance", "مقارنة أسعار المشتريات", "purchases", "تحتاج مقارنة موحدة للوحدات والعملات وشروط الأسعار"],
    ["contract_policy_variance", "سياسات المستخلصات والمحتجزات", "projects", "تحتاج سياسة تاريخية مكتملة لكل مستخلص؛ لا تقارن المستخلص القديم بإعدادات العقد الحالية"],
    ["advance_recovery_due", "استرداد الدفعات المقدمة", "advances", "تحتاج تحليل التسويات المرحلة غير المعكوسة وربط الاستحقاق بالمستخلصات"],
    ["missing_mandatory_project", "مشروع إلزامي مفقود", "projects", "لا توجد سياسة إلزام مشروع مؤرخة مؤكدة في مصادر المستندات؛ غياب المشروع وحده ليس مخالفة"],
    ["unusual_activity", "التكرار والكميات غير المعتادة", "operations", "تحتاج نافذة مرجعية وسياسة إحصائية معتمدة"],
    ["document_journal_variance", "مطابقة المستند والأثر المالي", "finance", "تحتاج مطابقة العملات والضريبة والقيود العكسية لكل دورة"],
  ].map(([key,name,category,reason]) => ({...rule(key,name,category), enabled:false, supported:false, unsupportedReason:reason})),
].map(r => ["same_creator_approver","prepaid_missing_reference"].includes(r.key) ? {...r, enabled: false} : r);

export function validateRuleConfig(input: any): Record<string, unknown> {
  const keys = ["enabled", "severity", "threshold", "excludedUserIds", "excludedRoles"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw new Error("إعدادات قاعدة غير صالحة");
  if ("enabled" in input && typeof input.enabled !== "boolean") throw new Error("حالة التفعيل غير صالحة");
  if ("severity" in input && !["low","medium","high","critical"].includes(input.severity)) throw new Error("درجة الخطورة غير صالحة");
  if ("threshold" in input && input.threshold !== null && (typeof input.threshold !== "number" || !Number.isFinite(input.threshold) || input.threshold < 0 || input.threshold > 1e12)) throw new Error("الحد غير صالح");
  if ("excludedUserIds" in input && (!Array.isArray(input.excludedUserIds) || input.excludedUserIds.length > 100 || input.excludedUserIds.some((x: any) => !Number.isSafeInteger(x) || x <= 0))) throw new Error("قائمة المستخدمين غير صالحة");
  if ("excludedRoles" in input && (!Array.isArray(input.excludedRoles) || input.excludedRoles.length > 30 || input.excludedRoles.some((x: any) => typeof x !== "string" || !/^[a-zA-Z0-9_-]{1,60}$/.test(x)))) throw new Error("قائمة الأدوار غير صالحة");
  return input;
}