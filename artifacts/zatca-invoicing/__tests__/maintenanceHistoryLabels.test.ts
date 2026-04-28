// Unit tests for the single-source-of-truth maintenance-history label
// module (task #136).
//
// What this protects:
//   The friendly Arabic/English labels for maintenance-history `action` and
//   `entity_type` values now live in exactly one place
//   (src/lib/maintenanceHistoryLabels.ts) and are consumed by both
//   /admin/ai-fix (Arabic-only) and /admin/audit-log (bilingual). These
//   tests pin:
//     • Known keys resolve to the documented Arabic / English label.
//     • Unknown keys fall back to the raw machine value in both locales —
//       the property both screens rely on so a brand-new logMaint("…")
//       call surfaces in the dropdowns the moment it is logged, just
//       without a localised label.
//     • Every registered entry actually carries both an Arabic and an
//       English string (no empty translations slipping through).
//     • The two registries cover at least the actions / entity types we
//       know are in active use today, so a refactor that accidentally
//       drops one is caught by CI rather than first noticed by an admin
//       seeing raw "fix" / "journal_pending" values.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAINTENANCE_HISTORY_ACTION_LABELS,
  MAINTENANCE_HISTORY_ENTITY_TYPE_LABELS,
  maintenanceHistoryActionLabel,
  maintenanceHistoryEntityTypeLabel,
} from "../src/lib/maintenanceHistoryLabels.ts";

// ---------------------------------------------------------------------------
// Action labels
// ---------------------------------------------------------------------------

test("maintenanceHistoryActionLabel: resolves a known key to its Arabic label", () => {
  assert.equal(maintenanceHistoryActionLabel("fix", "ar"), "إصلاح");
  assert.equal(maintenanceHistoryActionLabel("export_csv", "ar"), "تصدير CSV");
  assert.equal(maintenanceHistoryActionLabel("auto_prune", "ar"), "تنظيف تلقائي");
});

test("maintenanceHistoryActionLabel: resolves a known key to its English label", () => {
  assert.equal(maintenanceHistoryActionLabel("fix", "en"), "Fix");
  assert.equal(maintenanceHistoryActionLabel("export_csv", "en"), "CSV export");
  assert.equal(maintenanceHistoryActionLabel("auto_prune", "en"), "Auto-prune");
});

test("maintenanceHistoryActionLabel: unknown keys fall back to the raw value in both locales", () => {
  // /admin/ai-fix relies on this so a brand-new logMaint(action: "...") call
  // appears in the filter dropdown the moment it is logged for the first time.
  assert.equal(maintenanceHistoryActionLabel("brand_new_action", "ar"), "brand_new_action");
  assert.equal(maintenanceHistoryActionLabel("brand_new_action", "en"), "brand_new_action");
});

// ---------------------------------------------------------------------------
// Entity-type labels
// ---------------------------------------------------------------------------

test("maintenanceHistoryEntityTypeLabel: resolves a known key to its Arabic label", () => {
  assert.equal(maintenanceHistoryEntityTypeLabel("journal_pending", "ar"), "قيود معلّقة");
  assert.equal(maintenanceHistoryEntityTypeLabel("email_history", "ar"), "سجل البريد");
  assert.equal(maintenanceHistoryEntityTypeLabel("audit_log", "ar"), "سجل التدقيق");
});

test("maintenanceHistoryEntityTypeLabel: resolves a known key to its English label", () => {
  assert.equal(
    maintenanceHistoryEntityTypeLabel("journal_pending", "en"),
    "Pending journal entries",
  );
  assert.equal(maintenanceHistoryEntityTypeLabel("email_history", "en"), "Email history");
  assert.equal(maintenanceHistoryEntityTypeLabel("audit_log", "en"), "Audit log");
});

test("maintenanceHistoryEntityTypeLabel: unknown keys fall back to the raw value in both locales", () => {
  assert.equal(
    maintenanceHistoryEntityTypeLabel("brand_new_entity", "ar"),
    "brand_new_entity",
  );
  assert.equal(
    maintenanceHistoryEntityTypeLabel("brand_new_entity", "en"),
    "brand_new_entity",
  );
});

// ---------------------------------------------------------------------------
// Registry shape — guards against silent regressions
// ---------------------------------------------------------------------------

test("MAINTENANCE_HISTORY_ACTION_LABELS: every registered entry has a non-empty AR and EN label", () => {
  const entries = Object.entries(MAINTENANCE_HISTORY_ACTION_LABELS);
  assert.ok(entries.length > 0, "expected at least one registered action label");
  for (const [key, value] of entries) {
    assert.equal(typeof value.ar, "string", `${key}: missing Arabic label`);
    assert.equal(typeof value.en, "string", `${key}: missing English label`);
    assert.ok(value.ar.trim().length > 0, `${key}: Arabic label is blank`);
    assert.ok(value.en.trim().length > 0, `${key}: English label is blank`);
  }
});

test("MAINTENANCE_HISTORY_ENTITY_TYPE_LABELS: every registered entry has a non-empty AR and EN label", () => {
  const entries = Object.entries(MAINTENANCE_HISTORY_ENTITY_TYPE_LABELS);
  assert.ok(entries.length > 0, "expected at least one registered entity-type label");
  for (const [key, value] of entries) {
    assert.equal(typeof value.ar, "string", `${key}: missing Arabic label`);
    assert.equal(typeof value.en, "string", `${key}: missing English label`);
    assert.ok(value.ar.trim().length > 0, `${key}: Arabic label is blank`);
    assert.ok(value.en.trim().length > 0, `${key}: English label is blank`);
  }
});

test("MAINTENANCE_HISTORY_ACTION_LABELS: covers the actions in active use today", () => {
  // The minimum set the maintenance code paths produce today. Adding new
  // actions is welcome — losing one of these silently is what we want to
  // catch.
  const required = [
    "fix",
    "export_csv",
    "run_now_one",
    "run_now_all",
    "edit_schedule",
    "send_test_email",
    "edit_retention",
    "auto_prune",
  ];
  for (const key of required) {
    assert.ok(
      key in MAINTENANCE_HISTORY_ACTION_LABELS,
      `MAINTENANCE_HISTORY_ACTION_LABELS is missing required key "${key}"`,
    );
  }
});

test("MAINTENANCE_HISTORY_ENTITY_TYPE_LABELS: covers the entity types in active use today", () => {
  const required = [
    "journal_pending",
    "broken_refs",
    "unlinked_accounts",
    "sequence_gaps",
    "dormant_users",
    "negative_stock",
    "stock_balance_drift",
    "unbalanced_entries",
    "old_audit_logs",
    "old_maintenance_runs",
    "old_maintenance_email_runs",
    "old_report_email_runs",
    "maintenance_history",
    "maintenance_schedule",
    "maintenance_runs",
    "maintenance_retention",
    "maintenance_tool_history",
    "email_history",
    "audit_log",
  ];
  for (const key of required) {
    assert.ok(
      key in MAINTENANCE_HISTORY_ENTITY_TYPE_LABELS,
      `MAINTENANCE_HISTORY_ENTITY_TYPE_LABELS is missing required key "${key}"`,
    );
  }
});
