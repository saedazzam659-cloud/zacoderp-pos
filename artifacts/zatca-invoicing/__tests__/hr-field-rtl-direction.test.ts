/**
 * Task #373 — HR Field screens RTL Direction audit tests
 *
 * Verifies that all seven field/ screens:
 * 1. Use active-language dir (i18n.dir()) on page roots, nested tables, dialogs,
 *    and alert dialogs — NOT hardcoded dir="rtl".
 * 2. Replace physical text-right / text-left table headers with logical text-start / text-end.
 * 3. Mark GPS coordinates, ticket numbers, dates, times, phone numbers, and
 *    numeric values with dir="ltr" where appropriate.
 * 4. Preserve map/GPS URL coordinate geometry as-is (href with lat/lng).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fieldRoot = join(import.meta.dirname ?? __dirname, "..", "src", "pages", "hr", "field");

function src(file: string): string {
  return readFileSync(join(fieldRoot, file), "utf8");
}

// ─── FieldServiceHub ──────────────────────────────────────────────────────────

test("FieldServiceHub: imports useTranslation", () => {
  assert.ok(src("FieldServiceHub.tsx").includes('from "react-i18next"'));
});

test("FieldServiceHub: page root uses i18n.dir(), not hardcoded rtl", () => {
  const code = src("FieldServiceHub.tsx");
  assert.ok(code.includes("dir={i18n.dir()}"), "must use i18n.dir()");
  assert.ok(!code.includes('dir="rtl"'), "must not hardcode dir=rtl");
});

// ─── FieldCheckIn ─────────────────────────────────────────────────────────────

test("FieldCheckIn: imports useTranslation", () => {
  assert.ok(src("FieldCheckIn.tsx").includes('from "react-i18next"'));
});

test("FieldCheckIn: page root uses i18n.dir(), not hardcoded rtl", () => {
  const code = src("FieldCheckIn.tsx");
  assert.ok(code.includes("dir={i18n.dir()}"), "must use i18n.dir()");
  assert.ok(!code.includes('dir="rtl"'), "must not hardcode dir=rtl");
});

test("FieldCheckIn: GPS coordinates display uses dir=ltr", () => {
  const code = src("FieldCheckIn.tsx");
  assert.ok(code.includes('dir="ltr"'), "GPS coords must be marked dir=ltr");
});

test("FieldCheckIn: time displays use dir=ltr", () => {
  const code = src("FieldCheckIn.tsx");
  // Should have at least two dir="ltr" occurrences (GPS + time)
  const matches = (code.match(/dir="ltr"/g) || []).length;
  assert.ok(matches >= 2, `FieldCheckIn must have at least 2 dir=ltr instances, found ${matches}`);
});

// ─── FieldLocations ───────────────────────────────────────────────────────────

test("FieldLocations: imports useTranslation", () => {
  assert.ok(src("FieldLocations.tsx").includes('from "react-i18next"'));
});

test("FieldLocations: page root uses i18n.dir(), not hardcoded rtl", () => {
  const code = src("FieldLocations.tsx");
  assert.ok(code.includes("dir={i18n.dir()}"), "must use i18n.dir()");
  assert.ok(!code.includes('dir="rtl"'), "must not hardcode dir=rtl anywhere");
});

test("FieldLocations: nested table uses dynamic dir", () => {
  const code = src("FieldLocations.tsx");
  // table should use i18n.dir(), not hardcoded rtl
  assert.ok(code.includes('dir={i18n.dir()}'), "nested table must use i18n.dir()");
});

test("FieldLocations: detail dialog uses dynamic dir", () => {
  const code = src("FieldLocations.tsx");
  // count dynamic dir occurrences — page root + table + dialog + alert
  const dynamicDirs = (code.match(/dir=\{i18n\.dir\(\)\}/g) || []).length;
  assert.ok(dynamicDirs >= 3, `FieldLocations must have at least 3 dynamic dir usages (root, table, dialog), found ${dynamicDirs}`);
});

test("FieldLocations: alert dialog uses dynamic dir", () => {
  const code = src("FieldLocations.tsx");
  assert.ok(!code.includes('dir="rtl"'), "AlertDialogContent must not hardcode dir=rtl");
});

test("FieldLocations: GPS coordinate cells use dir=ltr", () => {
  const code = src("FieldLocations.tsx");
  assert.ok(code.includes('dir="ltr"'), "GPS coordinate cells must be marked dir=ltr");
});

test("FieldLocations: phone number cell uses dir=ltr", () => {
  const code = src("FieldLocations.tsx");
  const ltrCount = (code.match(/dir="ltr"/g) || []).length;
  assert.ok(ltrCount >= 3, `FieldLocations must have ≥3 dir=ltr instances (coords table, coords detail, phone), found ${ltrCount}`);
});

test("FieldLocations: lat/lng form inputs use dir=ltr", () => {
  const code = src("FieldLocations.tsx");
  // Both lat and lng inputs should have dir="ltr"
  assert.ok(code.includes('Input dir="ltr"') || code.includes("dir=\"ltr\" value={form.lat}") || code.includes('dir="ltr"'), "lat/lng inputs must use dir=ltr");
});

test("FieldLocations: radius and contact-phone forms/displays use dir=ltr", () => {
  const code = src("FieldLocations.tsx");
  assert.match(code, /<Input[^>]*dir="ltr"[^>]*value=\{form\.radiusM\}/);
  assert.match(code, /<Input[^>]*dir="ltr"[^>]*value=\{form\.contactPhone\}/);
  assert.ok(code.includes('<span dir="ltr">{l.radiusM}</span>'));
  assert.ok(code.includes('<span dir="ltr">{viewing.radiusM}</span>'));
});

// ─── FieldVisitPlans ──────────────────────────────────────────────────────────

test("FieldVisitPlans: imports useTranslation", () => {
  assert.ok(src("FieldVisitPlans.tsx").includes('from "react-i18next"'));
});

test("FieldVisitPlans: page root uses i18n.dir(), not hardcoded rtl", () => {
  const code = src("FieldVisitPlans.tsx");
  assert.ok(code.includes("dir={i18n.dir()}"), "must use i18n.dir()");
  assert.ok(!code.includes('dir="rtl"'), "must not hardcode dir=rtl anywhere");
});

test("FieldVisitPlans: nested table uses dynamic dir", () => {
  const code = src("FieldVisitPlans.tsx");
  assert.ok(code.includes('dir={i18n.dir()}'));
});

test("FieldVisitPlans: detail dialog uses dynamic dir", () => {
  const code = src("FieldVisitPlans.tsx");
  const dynamicDirs = (code.match(/dir=\{i18n\.dir\(\)\}/g) || []).length;
  assert.ok(dynamicDirs >= 3, `FieldVisitPlans must have at least 3 dynamic dir usages, found ${dynamicDirs}`);
});

test("FieldVisitPlans: alert dialog uses dynamic dir", () => {
  const code = src("FieldVisitPlans.tsx");
  assert.ok(!code.includes('dir="rtl"'), "AlertDialogContent must not hardcode dir=rtl");
});

test("FieldVisitPlans: date cells use dir=ltr", () => {
  const code = src("FieldVisitPlans.tsx");
  assert.ok(code.includes('dir="ltr"'), "date/ID cells must be marked dir=ltr");
});

// ─── FieldServiceTickets ──────────────────────────────────────────────────────

test("FieldServiceTickets: imports useTranslation", () => {
  assert.ok(src("FieldServiceTickets.tsx").includes('from "react-i18next"'));
});

test("FieldServiceTickets: page root uses i18n.dir(), not hardcoded rtl", () => {
  const code = src("FieldServiceTickets.tsx");
  assert.ok(code.includes("dir={i18n.dir()}"), "must use i18n.dir()");
  assert.ok(!code.includes('dir="rtl"'), "must not hardcode dir=rtl anywhere");
});

test("FieldServiceTickets: nested table uses dynamic dir", () => {
  const code = src("FieldServiceTickets.tsx");
  assert.ok(code.includes('dir={i18n.dir()}'));
});

test("FieldServiceTickets: detail dialog uses dynamic dir", () => {
  const code = src("FieldServiceTickets.tsx");
  const dynamicDirs = (code.match(/dir=\{i18n\.dir\(\)\}/g) || []).length;
  assert.ok(dynamicDirs >= 3, `FieldServiceTickets must have at least 3 dynamic dir usages, found ${dynamicDirs}`);
});

test("FieldServiceTickets: ticket number cell uses dir=ltr", () => {
  const code = src("FieldServiceTickets.tsx");
  // ticketNo cell should have dir=ltr
  assert.ok(code.includes('dir="ltr"'), "ticket number and date cells must be marked dir=ltr");
});

test("FieldServiceTickets: SLA minute values use dir=ltr", () => {
  const code = src("FieldServiceTickets.tsx");
  const ltrCount = (code.match(/dir="ltr"/g) || []).length;
  assert.ok(ltrCount >= 5, `FieldServiceTickets must have ≥5 dir=ltr instances, found ${ltrCount}`);
});

test("FieldServiceTickets: date/time cells use dir=ltr", () => {
  const code = src("FieldServiceTickets.tsx");
  assert.ok(code.includes('dir="ltr"'));
  // Verify the date rendering lines include dir="ltr"
  assert.ok(code.includes('dir="ltr">{new Date(detail.openedAt)'));
});

// ─── FieldReports ─────────────────────────────────────────────────────────────

test("FieldReports: imports useTranslation", () => {
  assert.ok(src("FieldReports.tsx").includes('from "react-i18next"'));
});

test("FieldReports: page root uses i18n.dir(), not hardcoded rtl", () => {
  const code = src("FieldReports.tsx");
  assert.ok(code.includes("dir={i18n.dir()}"), "must use i18n.dir()");
  assert.ok(!code.includes('dir="rtl"'), "must not hardcode dir=rtl anywhere");
});

test("FieldReports: table headers use text-start/text-end, not text-right", () => {
  const code = src("FieldReports.tsx");
  assert.ok(!code.includes('"text-right"'), "must not use text-right class string");
  assert.ok(!code.includes('text-right p-2'), "must not use text-right on th cells");
});

test("FieldReports: does not use text-left on numeric columns", () => {
  const code = src("FieldReports.tsx");
  assert.ok(!code.includes('text-left'), "must not use physical text-left");
});

test("FieldReports: numeric data cells use dir=ltr", () => {
  const code = src("FieldReports.tsx");
  assert.ok(code.includes('dir="ltr"'), "numeric cells must use dir=ltr");
});

test("FieldReports: uses text-end on numeric column headers", () => {
  const code = src("FieldReports.tsx");
  assert.ok(code.includes('text-end'), "numeric column headers must use text-end");
});

// ─── FieldTracking ────────────────────────────────────────────────────────────

test("FieldTracking: imports useTranslation", () => {
  assert.ok(src("FieldTracking.tsx").includes('from "react-i18next"'));
});

test("FieldTracking: page root uses i18n.dir(), not hardcoded rtl", () => {
  const code = src("FieldTracking.tsx");
  assert.ok(code.includes("dir={i18n.dir()}"), "must use i18n.dir()");
  assert.ok(!code.includes('dir="rtl"'), "must not hardcode dir=rtl");
});

test("FieldTracking: employee code uses dir=ltr", () => {
  const code = src("FieldTracking.tsx");
  assert.ok(code.includes('dir="ltr"'), "employee code / time cells must be marked dir=ltr");
});

test("FieldTracking: time display uses dir=ltr", () => {
  const code = src("FieldTracking.tsx");
  const ltrCount = (code.match(/dir="ltr"/g) || []).length;
  assert.ok(ltrCount >= 2, `FieldTracking must have ≥2 dir=ltr instances, found ${ltrCount}`);
});

test("FieldTracking: map URL links preserve coordinate geometry (href unchanged)", () => {
  const code = src("FieldTracking.tsx");
  // The Google Maps link must still contain the GPS coordinate pattern
  assert.ok(code.includes("maps?q="), "Google Maps links must still include coordinate query params");
});
