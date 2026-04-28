// Single source of truth for the friendly labels we attach to the `action`
// and `entity_type` values written to `audit_log` by maintenance code paths.
//
// Two admin surfaces consume these labels:
//   - /admin/ai-fix (Arabic-only) — maintenance-history filter dropdowns,
//     the table, and the export-inspector dialog.
//   - /admin/audit-log (bilingual) — the export-inspector pane inside the
//     audit-row details dialog.
//
// Previously each surface kept its own copy (a TypeScript constant on
// /admin/ai-fix and matching i18n entries on /admin/audit-log), which meant
// adding a new maintenance action required updating both lists or one
// surface would silently start showing the raw machine value. This module
// keeps every known action / entity-type defined exactly once, in both
// languages, so they can never drift apart again.
//
// Anything not listed here intentionally falls back to the raw machine
// value at the call sites. That keeps both surfaces forward-compatible: a
// new logMaint("…") call surfaces immediately in the dropdowns and tables,
// just without a localised label until it is registered here.

export type MaintenanceHistoryLocale = "ar" | "en";

interface LocalisedLabel {
  ar: string;
  en: string;
}

export const MAINTENANCE_HISTORY_ACTION_LABELS: Record<string, LocalisedLabel> = {
  fix:              { ar: "إصلاح",              en: "Fix" },
  export_csv:       { ar: "تصدير CSV",          en: "CSV export" },
  run_now_one:      { ar: "تشغيل لشركة",        en: "Run for company" },
  run_now_all:      { ar: "تشغيل للكل",         en: "Run for all" },
  edit_schedule:    { ar: "تعديل الجدولة",      en: "Edit schedule" },
  send_test_email:  { ar: "بريد تجريبي",         en: "Test email" },
  edit_retention:   { ar: "تعديل مدة الاحتفاظ", en: "Edit retention" },
  // Daily auto-prune of the email-history tables (maintenance + reports).
  // Written by the scheduler — surfaced here so the maintenance-history panel
  // shows a friendly label instead of the raw machine value.
  auto_prune:       { ar: "تنظيف تلقائي",        en: "Auto-prune" },
};

export const MAINTENANCE_HISTORY_ENTITY_TYPE_LABELS: Record<string, LocalisedLabel> = {
  journal_pending:                 { ar: "قيود معلّقة",                en: "Pending journal entries" },
  broken_refs:                     { ar: "مراجع مكسورة",                en: "Broken references" },
  unlinked_accounts:               { ar: "حسابات غير مربوطة",           en: "Unlinked accounts" },
  sequence_gaps:                   { ar: "فجوات التسلسل",               en: "Sequence gaps" },
  dormant_users:                   { ar: "مستخدمون خاملون",             en: "Dormant users" },
  negative_stock:                  { ar: "رصيد سالب",                   en: "Negative stock" },
  stock_balance_drift:             { ar: "انحراف رصيد المخزون",         en: "Stock balance drift" },
  unbalanced_entries:              { ar: "قيود غير متوازنة",             en: "Unbalanced entries" },
  old_audit_logs:                  { ar: "سجلات تدقيق قديمة",           en: "Old audit logs" },
  old_maintenance_runs:            { ar: "عمليات صيانة قديمة",          en: "Old maintenance runs" },
  old_maintenance_email_runs:     { ar: "سجل بريد الصيانة القديم",     en: "Old maintenance email runs" },
  old_report_email_runs:          { ar: "سجل بريد التقارير القديم",    en: "Old report email runs" },
  maintenance_history:             { ar: "سجل الصيانة",                  en: "Maintenance history" },
  maintenance_schedule:            { ar: "جدولة الصيانة",                en: "Maintenance schedule" },
  maintenance_runs:                { ar: "تشغيل الصيانة",                en: "Maintenance runs" },
  maintenance_retention:           { ar: "مدة الاحتفاظ بالسجلات",       en: "Maintenance retention" },
  maintenance_tool_history:        { ar: "سجل تشغيلات الأداة",           en: "Tool run history" },
  // Combined entity for the daily email-history auto-prune (covers both
  // maintenance_email_runs and report_email_schedule_runs in one summary row).
  email_history:                   { ar: "سجل البريد",                   en: "Email history" },
  // Per-table entity for the daily auto-prune of the audit-log toolbox card.
  audit_log:                       { ar: "سجل التدقيق",                  en: "Audit log" },
};

export function maintenanceHistoryActionLabel(
  value: string,
  locale: MaintenanceHistoryLocale,
): string {
  return MAINTENANCE_HISTORY_ACTION_LABELS[value]?.[locale] ?? value;
}

export function maintenanceHistoryEntityTypeLabel(
  value: string,
  locale: MaintenanceHistoryLocale,
): string {
  return MAINTENANCE_HISTORY_ENTITY_TYPE_LABELS[value]?.[locale] ?? value;
}
