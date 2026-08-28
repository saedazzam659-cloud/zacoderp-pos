/**
 * Tests for Task #380 — Invoice Acceleration backend (corrected).
 *
 * Strategy: prefer static checks of the ACTUAL source file over reimplemented
 * toy logic so that the test fails if the real code diverges.
 *
 * Coverage:
 *   1. Source invariants — scan agentInvoiceAcceleration.ts and
 *      agentInstances.ts for presence/absence of required patterns.
 *   2. getInvoiceAccelerationMode — pure function, no DB.
 *   3. computeSampleStats — pure function, no DB.
 *   4. Fail-closed routing: both trial and on must be in the fail-closed
 *      branch; source text is authoritative.
 *   5. Trial scoping: samples must be filtered by trialStartAt, not
 *      accumulated globally.
 *   6. Decrement does NOT update invoiceAccelerationUpdatedAt (preserves trial
 *      start boundary).
 *   7. Rollback on 5xx: _trialRollbackOn5xx must use status >= 500 check.
 *   8. Successful trial ops: 2xx/3xx only; 4xx must not trigger decrement.
 *   9. Race guard: all auto-transitions must carry timestamp guard.
 *  10. isAccelerationEligible logic.
 *  11. publicRow safe-metadata invariant.
 *  12. trialStartAt stamped on agentDomainHit by router.
 *
 * How to run:
 *   pnpm --filter @workspace/api-server test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import {
  getInvoiceAccelerationMode,
  computeSampleStats,
  createInvoiceResponseOutcomeTracker,
  shouldHonorRequestStartGeneration,
  type InvoiceAccelerationMode,
  type AgentDomainHit,
} from "../src/lib/agentInvoiceAcceleration.ts";
import { sanitizeSchemaDumpForExternalAgent } from "../src/lib/agentExternalSchema.ts";

// ── Source text helpers ────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));

function readSrc(relPath: string): string {
  return readFileSync(resolve(__dir, "..", relPath), "utf8");
}

const accelSrc    = readSrc("src/lib/agentInvoiceAcceleration.ts");
const routerSrc   = readSrc("src/routes/agentInstances.ts");
const salesSrc    = readSrc("src/routes/sales.ts");
const ensureSchemaSrc = readSrc("src/lib/ensureSchema.ts");

// ── 1. Source invariants ────────────────────────────────────────────────────

test("source invariant: agentInvoiceAcceleration uses centralDb, never bare db import", () => {
  // Must import centralDb (not the ALS-proxied db) for all writes/reads.
  assert.ok(
    accelSrc.includes('centralDb as db'),
    "must import centralDb aliased as db",
  );
  // Must NOT import the bare proxied `db` export from @workspace/db.
  // The only db reference should be via the centralDb alias.
  const importLine = accelSrc.match(/^import\s*\{[^}]*\}\s*from\s*["']@workspace\/db["']/m)?.[0] ?? "";
  assert.ok(
    !importLine.includes(", db,") && !importLine.includes("{ db,") && !importLine.includes(", db }"),
    `must not import bare proxied 'db' from @workspace/db — got: ${importLine}`,
  );
});

test("source invariant: trial admission reserves capacity under an agent-row lock", () => {
  const fnStart = accelSrc.indexOf("export async function admitInvoiceAcceleration(");
  const fnEnd = accelSrc.indexOf("// ── Non-blocking sample recorder", fnStart);
  const fnBody = accelSrc.slice(fnStart, fnEnd);
  assert.ok(fnStart !== -1, "admitInvoiceAcceleration must exist");
  assert.ok(fnBody.includes('.for("update")'), "trial admission must lock the central agent control row");
  assert.ok(fnBody.includes("activeCount >= remaining"), "admission must cap in-flight claims at remaining successes");
  assert.ok(fnBody.includes("status: 0"), "a trial slot must be persisted as an active claim before reads start");
  assert.ok(fnBody.includes("trialClaimId"), "admission must return the durable claim id");
});

test("source invariant: locked trial evaluation filters by trialStartAt", () => {
  const fnStart = accelSrc.indexOf("async function _evaluateTrialLocked(");
  assert.ok(fnStart !== -1, "_evaluateTrialLocked must exist");
  const fnEnd = accelSrc.indexOf("/**\n * Recovery entry point", fnStart);
  const fnBody = fnEnd !== -1 ? accelSrc.slice(fnStart, fnEnd) : accelSrc.slice(fnStart);
  // Must reference trialStartAt in the WHERE clause for trial samples.
  assert.ok(
    fnBody.includes("trialStartAt"),
    "evaluateTrial must scope samples by trialStartAt (current trial only)",
  );
  // Must use gte or >= comparison to filter by trial start.
  assert.ok(
    fnBody.includes("gte(") || fnBody.includes(">= trialStartAt") || fnBody.includes("createdAt, trialStartAt"),
    "evaluateTrial must use gte/createdAt filter for trial-window scoping",
  );
});

test("source invariant: locked trial evaluation uses 2xx/3xx successful filter, not <500", () => {
  const fnStart = accelSrc.indexOf("async function _evaluateTrialLocked(");
  const fnEnd = accelSrc.indexOf("/**\n * Recovery entry point", fnStart);
  const fnBody  = fnEnd !== -1 ? accelSrc.slice(fnStart, fnEnd) : accelSrc.slice(fnStart);
  // Must use 200/400 boundary, not 500.
  assert.ok(
    fnBody.includes("status < 400") || fnBody.includes("status >= 200"),
    "evaluateTrial must filter successful samples as 2xx/3xx (< 400), not < 500",
  );
  // Must NOT have a bare `status < 500` filter for the trial samples.
  assert.ok(
    !fnBody.includes("status < 500"),
    "evaluateTrial must NOT use status < 500 as the success boundary",
  );
});

test("source invariant: locked evaluation transitions carry timestamp guards", () => {
  const fnStart = accelSrc.indexOf("async function _evaluateTrialLocked(");
  const fnEnd = accelSrc.indexOf("/**\n * Recovery entry point", fnStart);
  const fnBody  = fnEnd !== -1 ? accelSrc.slice(fnStart, fnEnd) : accelSrc.slice(fnStart);
  // Count UPDATE calls — should be 2 (promote and rollback).
  const updateCount = (fnBody.match(/\.update\(/g) ?? []).length;
  assert.ok(updateCount >= 2, `evaluateTrial should have at least 2 UPDATE paths, got ${updateCount}`);
  // Both UPDATE WHERE clauses must reference the timestamp guard.
  const guardCount = (fnBody.match(/invoice_acceleration_updated_at\s*=\s*\$/g) ?? []).length;
  assert.equal(
    guardCount,
    updateCount,
    `every evaluateTrial UPDATE (${updateCount}) must carry the timestamp guard, found ${guardCount}`,
  );
});

test("source invariant: completing a claimed 5xx rolls the same trial back", () => {
  const fnStart = accelSrc.indexOf("async function _completeTrialClaim(");
  const fnEnd = accelSrc.indexOf("// ── Trial evaluation", fnStart);
  const fnBody = accelSrc.slice(fnStart, fnEnd);
  assert.ok(fnStart !== -1, "_completeTrialClaim must exist");
  assert.ok(fnBody.includes("sample.status >= 500"), "claimed 5xx must take the rollback branch");
  assert.ok(fnBody.includes('invoiceAccelerationMode: "off"'), "claimed 5xx must disable acceleration");
  assert.ok(fnBody.includes('"rollback_5xx"'), "claimed 5xx must report the rollback transition");
});

test("source invariant: a claim consumes remaining only on 2xx/3xx, never 4xx/499", () => {
  const fnStart = accelSrc.indexOf("async function _completeTrialClaim(");
  assert.ok(fnStart !== -1, "_handleSampleFinish must exist");
  const fnEnd = accelSrc.indexOf("// ── Trial evaluation", fnStart);
  const fnBody = fnEnd !== -1 ? accelSrc.slice(fnStart, fnEnd) : accelSrc.slice(fnStart);
  assert.ok(
    fnBody.includes("status >= 200") && fnBody.includes("status < 400"),
    "claim completion must consume only 2xx/3xx",
  );
  assert.ok(
    fnBody.includes("4xx/499 release the reservation"),
    "4xx/disconnects must release without consuming a successful save",
  );
});

test("source invariant: claimed completion validates the same trial timestamp", () => {
  const fnStart = accelSrc.indexOf("async function _completeTrialClaim(");
  const fnEnd = accelSrc.indexOf("// ── Trial evaluation", fnStart);
  const fnBody  = fnEnd !== -1 ? accelSrc.slice(fnStart, fnEnd) : accelSrc.slice(fnStart);
  assert.ok(
    fnBody.includes("instance.updatedAt?.getTime() === trialStartAt.getTime()"),
    "claim completion must not mutate a manual-off or newer trial",
  );
});

test("source invariant: the fifth success evaluates before releasing the admission lock", () => {
  const fnStart = accelSrc.indexOf("async function _completeTrialClaim(");
  const fnEnd = accelSrc.indexOf("// ── Trial evaluation", fnStart);
  const fnBody = accelSrc.slice(fnStart, fnEnd);
  assert.ok(fnBody.includes('.for("update")'), "completion must hold the same agent-row lock as admission");
  assert.ok(
    fnBody.includes("await _evaluateTrialLocked(tx,"),
    "the fifth success must evaluate and transition inside the completion transaction",
  );
  assert.ok(
    !fnBody.includes('return remaining === 0 ? "evaluate"'),
    "completion must never commit a mode=trial, remaining=0 window",
  );
});

test("source invariant: disconnect outcome follows the completed business route", () => {
  const trackerStart = accelSrc.indexOf("export function createInvoiceResponseOutcomeTracker(");
  const trackerEnd = accelSrc.indexOf("/**\n * Baseline/on samples", trackerStart);
  const trackerBody = accelSrc.slice(trackerStart, trackerEnd);
  assert.ok(trackerBody.includes("businessOutcomeStatus"), "trial recorder must retain the route outcome");
  assert.ok(trackerBody.includes("closedBeforeFinish"), "trial recorder must distinguish socket loss from route completion");
  assert.ok(
    trackerBody.includes("if (closedBeforeFinish) handle(status)"),
    "a disconnected claimed request must be completed from the eventual route outcome",
  );
});

test("source invariant: router fail-closed includes BOTH trial and on", () => {
  // Find the agentDataSourceRouter function.
  const fnStart = routerSrc.indexOf("export async function agentDataSourceRouter(");
  assert.ok(fnStart !== -1, "agentDataSourceRouter must exist");
  // Slice a generous 5000 chars to cover the whole function body.
  const fnBody = routerSrc.slice(fnStart, fnStart + 5000);

  // The fail-closed block must exist.
  assert.ok(
    fnBody.includes("ACCELERATION_DB_NOT_INITIALIZED"),
    "router must have ACCELERATION_DB_NOT_INITIALIZED error code",
  );

  // Find the fail-closed if-condition — search the whole function body for
  // a combined condition that references both modes. The exact form may be
  // a single `||` compound or two separate conditions; either is acceptable.
  // We verify that BOTH "trial" and "on" appear BEFORE the error code, in the
  // same if-block that immediately precedes the ACCELERATION_DB_NOT_INITIALIZED.
  const beforeError = fnBody.slice(0, fnBody.indexOf("ACCELERATION_DB_NOT_INITIALIZED"));
  // Find the last `if (` before the error — that's the fail-closed condition.
  const lastIfIdx = beforeError.lastIndexOf("if (");
  assert.ok(lastIfIdx !== -1, "fail-closed block must be preceded by an if condition");
  const condAndBody = fnBody.slice(lastIfIdx, fnBody.indexOf("ACCELERATION_DB_NOT_INITIALIZED") + 50);
  assert.ok(
    condAndBody.includes('"trial"') || condAndBody.includes("'trial'"),
    "router fail-closed condition must include trial mode",
  );
  assert.ok(
    condAndBody.includes('"on"') || condAndBody.includes("'on'"),
    "router fail-closed condition must include on mode",
  );
});

test("source invariant: router stamps trialStartAt on agentDomainHit", () => {
  const fnStart = routerSrc.indexOf("export async function agentDataSourceRouter(");
  const fnEnd   = routerSrc.indexOf("\nexport async function ", fnStart + 1);
  const fnBody  = fnEnd !== -1 ? routerSrc.slice(fnStart, fnEnd) : routerSrc.slice(fnStart, fnStart + 4000);
  assert.ok(
    fnBody.includes("trialStartAt"),
    "agentDataSourceRouter must stamp trialStartAt onto agentDomainHit",
  );
  assert.ok(
    fnBody.includes("accelerationRequestGeneration"),
    "agentDataSourceRouter must stamp the authoritative request generation",
  );
  assert.ok(
    fnBody.indexOf("captureInvoiceAccelerationRequestGeneration(")
      < fnBody.indexOf("await resolveAgentRequestHost(req)"),
    "cached active requests must capture their fence before host/schema awaits",
  );
});

test("source invariant: host cache is cleared after auto-transitions (dynamic import)", () => {
  // _clearHostCache uses dynamic import to avoid static cycle.
  assert.ok(
    accelSrc.includes("clearAgentHostCache"),
    "lib must call clearAgentHostCache after auto-transitions",
  );
  assert.ok(
    accelSrc.includes("import(") && accelSrc.includes("agentInstances"),
    "lib must use dynamic import for clearAgentHostCache to avoid static cycle",
  );
});

test("source invariant: invoice timing is persisted centrally and post does not consume trial saves", () => {
  const timingStart = salesSrc.indexOf("function beginAgentInvoiceTiming(");
  const timingEnd = salesSrc.indexOf("\nfunction queryRows", timingStart);
  const timingBody = salesSrc.slice(timingStart, timingEnd);
  assert.ok(timingBody.includes("recordInvoiceSampleOnFinish("), "invoice timing must persist a central sample");
  assert.ok(
    timingBody.includes('operation === "create" || operation === "update"'),
    "only create/update may call trial admission; posting cannot consume a claim",
  );
  assert.ok(timingBody.includes("trialStartAt"), "recorder must receive the request's trial boundary");
  assert.ok(timingBody.includes("trialClaimId"), "recorder must complete the exact reserved trial claim");
});

test("source invariant: parallel reads are gated to trial/on for create and update", () => {
  const createStart = salesSrc.indexOf('router.post("/sales-invoices"');
  const updateStart = salesSrc.indexOf('router.put("/sales-invoices/:id"');
  const postStart = salesSrc.indexOf('router.patch("/sales-invoices/:id/post"');
  const createBody = salesSrc.slice(createStart, updateStart);
  const updateBody = salesSrc.slice(updateStart, postStart);

  for (const [name, body] of [["create", createBody], ["update", updateBody]] as const) {
    assert.ok(body.includes("usesAcceleratedAgentInvoicePath(timingStart)"), `${name} must use central admission`);
    assert.ok(body.includes("const fastReads = acceleratedPath ?"), `${name} fast reads must be mode-gated`);
    assert.ok(body.includes("captureRead("), `${name} must capture speculative read failures`);
    assert.ok(body.includes("readCaptured("), `${name} must consume captured reads at validation points`);
  }
});

test("source invariant: trial comparisons include only accelerated create/update operations", () => {
  const evaluateStart = accelSrc.indexOf("async function _evaluateTrialLocked(");
  const evaluateBody = accelSrc.slice(evaluateStart, accelSrc.indexOf("/**\n * Recovery entry point", evaluateStart));
  assert.ok(
    evaluateBody.includes("operation IN ('create', 'update')"),
    "trial p95 and baseline must exclude posting operations",
  );
  const trialEndpoint = routerSrc.slice(
    routerSrc.indexOf('router.post("/:id/invoice-acceleration/trial"'),
    routerSrc.indexOf('router.post("/:id/invoice-acceleration/off"'),
  );
  assert.ok(
    trialEndpoint.includes("operation IN ('create', 'update')"),
    "trial baseline eligibility must count only comparable invoice saves",
  );
});

test("source invariant: sub-second latency alone can never promote a slower trial", () => {
  const evaluateStart = accelSrc.indexOf("async function _evaluateTrialLocked(");
  const evaluateBody = accelSrc.slice(evaluateStart, accelSrc.indexOf("/**\n * Recovery entry point", evaluateStart));
  assert.ok(evaluateBody.includes("accP95 < baseP95"), "promotion must require measured p95 improvement");
  assert.ok(
    !evaluateBody.includes("accP95 < 1000 ||"),
    "being below one second must not override a worse pre-trial baseline",
  );
  assert.ok(
    evaluateBody.includes("state.baseline"),
    "evaluation must use the frozen pre-trial baseline rather than later fallback samples",
  );
});

test("source invariant: starting a trial is an atomic off-to-trial transition", () => {
  const trialEndpoint = routerSrc.slice(
    routerSrc.indexOf('router.post("/:id/invoice-acceleration/trial"'),
    routerSrc.indexOf('router.post("/:id/invoice-acceleration/off"'),
  );
  assert.ok(
    trialEndpoint.includes('eq(agentInstancesTable.invoiceAccelerationMode, "off")'),
    "trial start UPDATE must be conditional on the current mode still being off",
  );
  assert.ok(trialEndpoint.includes(".returning()"), "trial start must verify the conditional UPDATE won");
});

test("source invariant: acceleration telemetry DDL is central-only", () => {
  const centralStart = ensureSchemaSrc.indexOf("async function ensureCentralAgentInvoiceAccelerationSchema(");
  const runHealStart = ensureSchemaSrc.indexOf("async function runHeal(", centralStart);
  const centralBody = ensureSchemaSrc.slice(centralStart, runHealStart);
  assert.ok(centralStart !== -1, "central acceleration schema helper must exist");
  assert.ok(centralBody.includes("execCentralDDL("), "telemetry DDL must use the explicit central DB executor");
  assert.ok(centralBody.includes("agent_invoice_samples"), "central helper must create the telemetry table");

  const identityStart = ensureSchemaSrc.indexOf("async function ensureTenantIdentityIndexes(");
  const identityEnd = ensureSchemaSrc.indexOf("async function ensureCentralAgentInvoiceAccelerationSchema(", identityStart);
  const identityBody = ensureSchemaSrc.slice(identityStart, identityEnd);
  assert.ok(
    !identityBody.includes("agent_invoice_samples"),
    "external/full schema identity reconciliation must not create the central telemetry table",
  );
  assert.ok(
    /optionalMissingTables:\s*\[[^\]]*"integration_invoice_queue"[^\]]*"agent_invoice_samples"[^\]]*\]/s.test(ensureSchemaSrc),
    "strict external request healing must allow the intentionally central-only telemetry table to be absent",
  );
  for (const column of [
    "invoice_acceleration_mode",
    "invoice_trial_remaining",
    "invoice_acceleration_last_error",
    "invoice_acceleration_reason",
    "invoice_acceleration_updated_at",
    "invoice_acceleration_generation",
    "invoice_acceleration_baseline",
  ]) {
    assert.ok(
      ensureSchemaSrc.includes(`agent_instances.${column}`),
      `external schema healing must explicitly exclude central control column ${column}`,
    );
  }
  assert.ok(
    ensureSchemaSrc.includes("excludedColumns: CENTRAL_ONLY_AGENT_ACCELERATION_COLUMNS"),
    "both external healing paths must receive the central-column exclusion list",
  );
});

test("source invariant: agent invoice writes independently fail closed without an external ALS database", () => {
  const timingStart = salesSrc.indexOf("async function beginAgentInvoiceTiming(");
  const timingEnd = salesSrc.indexOf("\nfunction queryRows", timingStart);
  const timingBody = salesSrc.slice(timingStart, timingEnd);
  assert.ok(timingBody.includes("getActiveExternalDb()"), "sales handlers must verify external DB routing themselves");
  assert.ok(
    timingBody.includes("لم تُكتب أي بيانات") || timingBody.includes("الكتابة في القاعدة المركزية"),
    "fail-closed response must make clear no central business write occurred",
  );
  assert.ok(
    timingBody.includes("admitInvoiceAcceleration(agentId, operation, {"),
    "cached trial/on requests must re-read the current central mode before choosing the algorithm",
  );
  assert.ok(
    timingBody.includes('accelerationMode === "trial" || accelerationMode === "on"'),
    "cached off must retain the legacy path without a new central control-plane dependency",
  );
});

// ── 2. getInvoiceAccelerationMode ──────────────────────────────────────────

test("getInvoiceAccelerationMode: returns 'off' when req has no agentDomainHit", () => {
  assert.equal(getInvoiceAccelerationMode({}), "off");
});

test("getInvoiceAccelerationMode: returns 'off' when agentDomainHit has no accelerationMode", () => {
  const req = { agentDomainHit: { id: 1, domain: "example.com" } };
  assert.equal(getInvoiceAccelerationMode(req as any), "off");
});

test("getInvoiceAccelerationMode: returns correct mode from agentDomainHit", () => {
  const modes: InvoiceAccelerationMode[] = ["off", "trial", "on"];
  for (const mode of modes) {
    const req = {
      agentDomainHit: {
        id: 1,
        domain: "example.com",
        accelerationMode: mode,
          trialStartAt: null,
      } as AgentDomainHit,
    };
    assert.equal(getInvoiceAccelerationMode(req), mode, `expected mode=${mode}`);
  }
});

test("request boundary: an in-flight request keeps its pre-Off algorithm", () => {
  assert.equal(shouldHonorRequestStartGeneration(7, 8), true);
});

test("request boundary: a new request on stale active cache observes central Off", () => {
  assert.equal(shouldHonorRequestStartGeneration(8, 8), false);
});

test("response outcome tracker: close during admission waits for route success", () => {
  const statuses: number[] = [];
  const tracker = createInvoiceResponseOutcomeTracker(true, status => statuses.push(status));
  tracker.onCloseBeforeFinish();
  assert.deepEqual(statuses, []);
  tracker.onBusinessOutcome(201);
  assert.deepEqual(statuses, [201]);
  tracker.onFinish(200);
  assert.deepEqual(statuses, [201], "a late finish must not complete the claim twice");
});

test("response outcome tracker: connected trial uses the real response finish", () => {
  const statuses: number[] = [];
  const tracker = createInvoiceResponseOutcomeTracker(true, status => statuses.push(status));
  tracker.onBusinessOutcome(201);
  assert.deepEqual(statuses, []);
  tracker.onFinish(201);
  assert.deepEqual(statuses, [201]);
});

test("response outcome tracker: non-trial disconnect records 499", () => {
  const statuses: number[] = [];
  const tracker = createInvoiceResponseOutcomeTracker(false, status => statuses.push(status));
  tracker.onCloseBeforeFinish();
  assert.deepEqual(statuses, [499]);
});

test("fresh external schema sanitizer strips every central acceleration column", () => {
  const dump = String.raw`
CREATE TABLE public.agent_instances (
    id integer NOT NULL,
    invoice_acceleration_mode text DEFAULT 'off'::text NOT NULL,
    invoice_trial_remaining integer,
    invoice_acceleration_last_error text,
    invoice_acceleration_reason text,
    invoice_acceleration_updated_at timestamp without time zone,
    invoice_acceleration_generation integer DEFAULT 0 NOT NULL,
    invoice_acceleration_baseline jsonb,
    notes text
);
ALTER TABLE ONLY public.agent_instances ALTER COLUMN invoice_acceleration_generation SET DEFAULT 0;
\restrict abc
`;
  const cleaned = sanitizeSchemaDumpForExternalAgent(dump);
  assert.match(cleaned, /CREATE TABLE public\.agent_instances/);
  assert.match(cleaned, /notes text/);
  assert.doesNotMatch(cleaned, /invoice_acceleration|invoice_trial_remaining/i);
  assert.doesNotMatch(cleaned, /^\\restrict/m);
});

test("fresh external schema sanitizer fails closed if telemetry table escaped pg_dump exclusion", () => {
  assert.throws(
    () => sanitizeSchemaDumpForExternalAgent("CREATE TABLE public.agent_invoice_samples (id integer);"),
    /جدول قياسات مركزي/,
  );
});

test("source invariant: fresh external pg_dump excludes central telemetry table", () => {
  assert.ok(
    routerSrc.includes('"--exclude-table=public.agent_invoice_samples"'),
    "fresh external DB bootstrap must exclude agent_invoice_samples at pg_dump selection time",
  );
  assert.ok(
    routerSrc.includes("sanitizeSchemaDumpForExternalAgent(dumpSql)"),
    "fresh external DB bootstrap must strip central-only control columns before apply",
  );
});

// ── 3. computeSampleStats ──────────────────────────────────────────────────

test("computeSampleStats: empty array returns all zeros", () => {
  const stats = computeSampleStats([]);
  assert.equal(stats.count, 0);
  assert.equal(stats.avg, 0);
  assert.equal(stats.p50, 0);
  assert.equal(stats.p95, 0);
  assert.equal(stats.belowOneSecond, 0);
});

test("computeSampleStats: single value", () => {
  const stats = computeSampleStats([500]);
  assert.equal(stats.count, 1);
  assert.equal(stats.avg, 500);
  assert.equal(stats.p50, 500);
  assert.equal(stats.p95, 500);
  assert.equal(stats.belowOneSecond, 1);
});

test("computeSampleStats: known p95 with 20 values", () => {
  const ms = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
  const stats = computeSampleStats(ms);
  assert.equal(stats.count, 20);
  assert.equal(stats.avg, 1050);
  // p50: index floor(20*0.50)=10 → sorted[10] = 1100ms
  assert.equal(stats.p50, 1100);
  // p95: index floor(20*0.95)=19 → sorted[19] = 2000ms
  assert.equal(stats.p95, 2000);
  // belowOneSecond: 100..900 = 9 values
  assert.equal(stats.belowOneSecond, 9);
});

test("computeSampleStats: all values below 1000ms → belowOneSecond = count", () => {
  const stats = computeSampleStats([100, 200, 300, 400, 500]);
  assert.equal(stats.belowOneSecond, 5);
  assert.equal(stats.count, 5);
});

test("computeSampleStats: p95 index boundary (5 values)", () => {
  // 5 sorted: 100,200,300,400,500 — p95 = index floor(5*0.95)=4 → 500
  const stats = computeSampleStats([300, 100, 500, 200, 400]);
  assert.equal(stats.p95, 500);
  assert.equal(stats.p50, 300);
});

// ── 4. isAccelerationEligible (source text) ────────────────────────────────

test("source invariant: isAccelerationEligible rejects full mode", () => {
  // Find the isAccelerationEligible function in router source.
  const fnStart = routerSrc.indexOf("function isAccelerationEligible(");
  assert.ok(fnStart !== -1, "isAccelerationEligible must exist in router");
  // Grab up to 1000 chars — the function is small (< 200 chars of logic).
  const fnBody = routerSrc.slice(fnStart, fnStart + 1000);
  assert.ok(
    fnBody.includes('"full"') || fnBody.includes("'full'"),
    "isAccelerationEligible must reject full mode",
  );
  assert.ok(
    fnBody.includes("initialized"),
    "isAccelerationEligible must require initialized dbStatus",
  );
  assert.ok(
    fnBody.includes("dbUrlEnc"),
    "isAccelerationEligible must require dbUrlEnc",
  );
});

// ── 5. publicRow safe metadata ─────────────────────────────────────────────

test("publicRow: exposes acceleration fields, strips secrets", () => {
  // Check that publicRow in source mentions safe acceleration fields.
  const publicRowStart = routerSrc.indexOf("function publicRow(");
  assert.ok(publicRowStart !== -1, "publicRow must exist");
  const publicRowEnd = routerSrc.indexOf("\n}", publicRowStart) + 2;
  const publicRowBody = routerSrc.slice(publicRowStart, publicRowEnd);

  // Must expose safe acceleration metadata.
  assert.ok(publicRowBody.includes("invoiceAccelerationMode"), "publicRow must expose invoiceAccelerationMode");
  assert.ok(publicRowBody.includes("invoiceTrialRemaining"), "publicRow must expose invoiceTrialRemaining");
  assert.ok(publicRowBody.includes("invoiceAccelerationLastError"), "publicRow must expose invoiceAccelerationLastError");

  // Must destructure/strip secrets.
  assert.ok(publicRowBody.includes("dbUrlEnc"), "publicRow must strip dbUrlEnc");
  assert.ok(publicRowBody.includes("sshSecretEnc"), "publicRow must strip sshSecretEnc");

  // Public state fields remain visible, but the internal fence is stripped.
  const destructureBlock = publicRowBody.slice(
    publicRowBody.indexOf("{"),
    publicRowBody.indexOf("...rest"),
  );
  assert.ok(
    !destructureBlock.includes("invoiceAccelerationMode"),
    "invoiceAccelerationMode must not be stripped in destructure",
  );
  assert.ok(
    destructureBlock.includes("invoiceAccelerationGeneration: _invoiceAccelerationGeneration"),
    "invoiceAccelerationGeneration must be stripped from the public row",
  );
});

// ── 6. Trial start/baseline eligibility baseline filter ─────────────────────

test("source invariant: trial endpoint baseline requires status 2xx/3xx, not <500", () => {
  const trialRouteIdx = routerSrc.indexOf("invoice-acceleration/trial");
  assert.ok(trialRouteIdx !== -1, "trial endpoint must exist");
  // Find the baseline sample query inside this route.
  const routeBody = routerSrc.slice(trialRouteIdx, trialRouteIdx + 3000);
  assert.ok(
    routeBody.includes("status >= 200") || routeBody.includes("status < 400"),
    "trial endpoint baseline query must use 2xx/3xx filter",
  );
  assert.ok(
    !routeBody.includes("status < 500"),
    "trial endpoint baseline query must NOT use status < 500",
  );
});

// ── 7. AgentHostHit carries trialStartAt ──────────────────────────────────

test("source invariant: AgentHostHit type includes trial boundary and control generation", () => {
  // Find the AgentHostHit type definition.
  const typeIdx = routerSrc.indexOf("type AgentHostHit = {");
  assert.ok(typeIdx !== -1, "AgentHostHit type must exist");
  const typeEnd = routerSrc.indexOf("} | null;", typeIdx) + 9;
  const typeBody = routerSrc.slice(typeIdx, typeEnd);
  assert.ok(
    typeBody.includes("trialStartAt"),
    "AgentHostHit must include trialStartAt field",
  );
  assert.ok(
    typeBody.includes("controlGeneration"),
    "AgentHostHit must retain the generation from a cache-miss row snapshot",
  );
});

// ── 8. Mode-full forces acceleration off in PUT update ─────────────────────

test("source invariant: PUT update forces acceleration off when mode becomes full", () => {
  // Find the mode=full acceleration patch in the router.
  assert.ok(
    routerSrc.includes("forced_off_mode_full"),
    "PUT update must force acceleration off with reason 'forced_off_mode_full' when mode=full",
  );
  assert.ok(
    routerSrc.includes("invoiceAccelerationMode") && routerSrc.includes('"off"'),
    "PUT update must set invoiceAccelerationMode to 'off'",
  );
});
