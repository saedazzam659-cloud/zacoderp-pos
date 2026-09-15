/**
 * Contracting enum codes stay English in API payloads and database rows.
 * These maps are the Arabic presentation layer used by every contracting
 * screen, so a newly loaded row never exposes a raw enum to the operator.
 */
export const PROJECT_STATUS_LABEL: Record<string, string> = {
  draft: "مسودة",
  study: "دراسة",
  contract: "متعاقد عليه",
  planning: "تخطيط",
  in_progress: "قيد التنفيذ",
  on_hold: "متوقفة",
  completed: "مكتملة",
  cancelled: "ملغاة",
};

export const PROJECT_TYPE_LABEL: Record<string, string> = {
  building: "مبنى",
  road: "طرق",
  infrastructure: "بنية تحتية",
  renovation: "ترميم",
  maintenance: "صيانة",
  other: "أخرى",
};

export const WORK_CATEGORY_LABEL: Record<string, string> = {
  earthworks: "أعمال ترابية",
  excavation: "حفر",
  concrete: "خرسانة",
  steel: "حديد وإنشاءات معدنية",
  masonry: "مبانٍ",
  electrical: "كهرباء",
  plumbing: "سباكة",
  mep: "كهروميكانيكا",
  finishing: "تشطيبات",
  other: "أخرى",
};

export const WORK_STATUS_LABEL: Record<string, string> = {
  pending: "معلّق",
  in_progress: "قيد التنفيذ",
  completed: "مكتمل",
  done: "منجز",
  blocked: "محجوب",
};

export const RESOURCE_TYPE_LABEL: Record<string, string> = {
  labor: "عمالة",
  equipment: "معدات",
  material: "مواد",
  subcontractor: "مقاول باطن",
  other: "أخرى",
};

export const RESOURCE_STATUS_LABEL: Record<string, string> = {
  planned: "مخطط",
  in_use: "قيد الاستخدام",
  consumed: "مستهلك",
  returned: "مرتجع",
};

export const BILL_STATUS_LABEL: Record<string, string> = {
  draft: "مسودة",
  submitted: "مقدّم",
  under_review: "قيد المراجعة",
  approved: "معتمد",
  posted: "مرحل محاسبياً",
  partially_paid: "مسدد جزئياً",
  paid: "مدفوع",
  rejected: "مرفوض",
  reversed: "معكوس",
  cancelled: "ملغى",
};

export const BILL_TYPE_LABEL: Record<string, string> = {
  interim: "مرحلي",
  final: "نهائي",
  advance: "دفعة مقدمة",
  retention_release: "صرف المحتجز",
};

export const BILL_DIRECTION_LABEL: Record<string, string> = {
  outgoing: "صادر للمالك",
  incoming: "وارد من المقاول الباطن",
};

export const CONTRACT_TYPE_LABEL: Record<string, string> = {
  main: "رئيسي",
  addendum: "ملحق",
  change_order: "أمر تغيير",
};

export const CONTRACT_STATUS_LABEL: Record<string, string> = {
  draft: "مسودة",
  active: "نشط",
  approved: "معتمد",
  suspended: "معلّق",
  completed: "مكتمل",
  terminated: "منتهٍ",
  on_hold: "متوقف",
};

export const RISK_CATEGORY_LABEL: Record<string, string> = {
  delay: "تأخير",
  schedule: "جدول زمني",
  cost: "تكلفة",
  material: "مواد",
  equipment: "معدات",
  quality: "جودة",
  safety: "سلامة",
  environmental: "بيئي",
  legal: "قانوني",
  contractual: "تعاقدي",
  other: "أخرى",
};

export const RISK_LEVEL_LABEL: Record<string, string> = {
  low: "منخفض",
  medium: "متوسط",
  high: "مرتفع",
};

export const RISK_STATUS_LABEL: Record<string, string> = {
  open: "مفتوح",
  mitigating: "قيد المعالجة",
  resolved: "محلول",
  accepted: "مقبول",
};

export const EVENT_TYPE_LABEL: Record<string, string> = {
  project_created: "إنشاء مشروع",
  phase_started: "بدء مرحلة",
  material_issued: "صرف مواد",
  resource_planned: "تخطيط مورد",
  bill_submitted: "تقديم مستخلص",
  bill_approved: "اعتماد مستخلص",
  risk_added: "إضافة مخاطرة",
  ai_suggestion: "اقتراح ذكي",
  delay_detected: "اكتشاف تأخير",
  owner_contract_created: "إنشاء عقد مالك",
  sub_contract_created: "إنشاء عقد باطن",
  other: "حدث آخر",
};

export const EVENT_SEVERITY_LABEL: Record<string, string> = {
  info: "معلومة",
  warn: "تنبيه",
  error: "خطأ",
};

export const UNIT_LABEL: Record<string, string> = {
  m3: "م³",
  m2: "م²",
  m: "م",
  hr: "ساعة",
  day: "يوم",
  kg: "كجم",
  ton: "طن",
  pcs: "قطعة",
  lump: "مقطوعية",
};

export const labelEnum = (map: Record<string, string>, value: string | null | undefined): string =>
  (value && map[value]) || "غير محدد";
