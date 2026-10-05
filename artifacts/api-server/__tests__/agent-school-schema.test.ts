import test from "node:test";
import assert from "node:assert/strict";
import { runWithExternalDb } from "@workspace/db";
import {
  EXTERNAL_AGENT_SCHOOL_DDL,
  ensureAgentSchoolSchema,
} from "../src/lib/agentSchoolSchema.js";
import { SCHOOL_ACADEMIC_CONTROL_DDL } from "../src/lib/schoolAcademicControlSchema.js";
import { SCHOOL_TRANSPORT_DDL } from "../src/lib/schoolTransportSchema.js";

const expectedSchoolTables = [
  "school_campuses",
  "school_academic_years",
  "school_grades",
  "school_students",
  "school_student_guardians",
  "school_classes",
  "school_enrollments",
  "school_attendance",
  "school_subjects",
  "school_exams",
  "school_exam_results",
  "school_fee_charges",
  "school_guardian_portal_accounts",
  "school_guardian_portal_links",
  "school_student_biometric_consents",
  "school_biometric_consent_events",
  "school_student_face_templates",
  "school_student_attendance_events",
  "school_transport_vehicles",
  "school_transport_routes",
  "school_transport_stops",
  "school_transport_assignments",
  "school_academic_periods",
  "school_subject_offerings",
  "school_grade_subject_policies",
  "school_daily_assessments",
  "school_result_approvals",
  "school_grade_audit_events",
];

test("external school schema DDL is complete and additive", () => {
  const tableNames = EXTERNAL_AGENT_SCHOOL_DDL
    .map((statement) => /^CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(statement)?.[1])
    .filter((name): name is string => Boolean(name));
  assert.deepEqual(tableNames, expectedSchoolTables);
  assert.equal(
    EXTERNAL_AGENT_SCHOOL_DDL.length - expectedSchoolTables.length,
    3 + (SCHOOL_TRANSPORT_DDL.length - 4) + (SCHOOL_ACADEMIC_CONTROL_DDL.length - 6),
  );
  assert.ok(EXTERNAL_AGENT_SCHOOL_DDL.every((statement) =>
    /^CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS /.test(statement)
    || /^ALTER TABLE [a-z_]+\s+ADD COLUMN IF NOT EXISTS /.test(statement)));
  const vehicleDdl = SCHOOL_TRANSPORT_DDL.find((statement) =>
    /^CREATE TABLE IF NOT EXISTS school_transport_vehicles/.test(statement));
  assert.match(vehicleDdl ?? "", /fixed_asset_id INTEGER/);
  assert.doesNotMatch(vehicleDdl ?? "", /REFERENCES (?:fixed_assets|suppliers)\(/);
});

test("school schema readiness caches per external database and clears a failed attempt", async () => {
  const makeContext = (failFirst = false) => {
    const calls: unknown[] = [];
    let shouldFail = failFirst;
    const pool = {};
    const context = {
      pool,
      db: {
        execute: async (statement: unknown) => {
          calls.push(statement);
          if (shouldFail) {
            shouldFail = false;
            throw new Error("temporary DDL failure");
          }
        },
      },
    };
    return { context, calls };
  };

  const first = makeContext(true);
  await assert.rejects(
    runWithExternalDb(first.context as any, () => ensureAgentSchoolSchema()),
    /temporary DDL failure/,
  );
  await runWithExternalDb(first.context as any, () => ensureAgentSchoolSchema());
  await runWithExternalDb(first.context as any, () => ensureAgentSchoolSchema());
  assert.equal(first.calls.length, EXTERNAL_AGENT_SCHOOL_DDL.length + 1);

  const second = makeContext();
  await runWithExternalDb(second.context as any, () => ensureAgentSchoolSchema());
  assert.equal(second.calls.length, EXTERNAL_AGENT_SCHOOL_DDL.length);
});
