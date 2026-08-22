/**
 * agentInvoiceAcceleration.ts — central lib for Task #380 invoice acceleration.
 *
 * Key invariants:
 *   • NEVER throws into the invoice request path — errors are swallowed + logged.
 *   • ALL reads/writes go to centralDb explicitly — MUST NOT follow ALS proxy.
 *   • No SSH / deploy / domain-setup / schema-heal calls anywhere here.
 *   • History is bounded: newest 200 rows per agent (best-effort, non-blocking).
 *
 * Trial lifecycle:
 *   1. request admission locks the central agent row and persists status=0 claim.
 *      Active claims can never exceed the number of successful saves remaining.
 *   2. response completion locks the same row and finalizes that exact claim:
 *      • 5xx  → immediate auto-rollback to off;
 *      • 2xx/3xx → decrement remaining and evaluate when it reaches zero;
 *      • 4xx/499 → release the claim without consuming a successful save.
 *   3. interrupted claims older than ten minutes fail the trial closed on the
 *      next admission instead of leaving it permanently stuck.
 *
 * Evaluation is scoped to the trial start timestamp and compares against a
 * frozen pre-trial baseline. All UPDATE transitions carry a timestamp guard so
 * a concurrent manual-off or new trial cannot be silently overwritten.
 */

import { centralDb as db } from "@workspace/db";
import { agentInstancesTable, agentInvoiceSamplesTable, agentSecurityEventsTable } from "@workspace/db";
import { eq, and, desc, sql, lt, gte } from "drizzle-orm";
import { logger } from "./logger.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type InvoiceAccelerationMode = "off" | "trial" | "on";

/** Metadata stamped onto req.agentDomainHit by agentDataSourceRouter. */
export interface AgentDomainHit {
  id: number;
  domain: string;
  status: string;
  dbStatus: string;
  dbUrlEnc: string | null;
  brandName: string | null;
  brandLogoUrl: string | null;
  brandColor: string | null;
  proxyToken: string | null;
  accelerationMode: InvoiceAccelerationMode;
  trialStartAt: Date | null;
  accelerationRequestGeneration?: number | null;
}

export type InvoiceOperation = "create" | "update" | "post";

export interface InvoiceSampleInput {
  agentId: number;
  operation: InvoiceOperation;
  accelerated: boolean;
  status: number;
  totalMs: number;
  stages: Record<string, number>;
  lineCount: number;
  poolStart: unknown;
  poolEnd: unknown;
}

export interface SampleStats {
  count: number;
  avg: number;
  p50: number;
  p95: number;
  belowOneSecond: number;
}

export interface InvoiceAccelerationAdmission {
  mode: InvoiceAccelerationMode;
  accelerated: boolean;
  trialStartAt: Date | null;
  trialClaimId: number | null;
}

export interface FrozenInvoiceBaseline extends SampleStats {
  measuredAt: string;
}

export function shouldHonorRequestStartGeneration(
  requestGeneration: number | null,
  centralGeneration: number | null,
): boolean {
  return Number.isInteger(requestGeneration)
    && Number.isInteger(centralGeneration)
    && requestGeneration !== centralGeneration;
}

/**
 * Linearize an active-cache request against control transitions. FOR SHARE and
 * the transition UPDATE's row lock decide a single authoritative order without
 * comparing application-server clocks.
 */
export async function captureInvoiceAccelerationRequestGeneration(agentId: number): Promise<number | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ generation: agentInstancesTable.invoiceAccelerationGeneration })
      .from(agentInstancesTable)
      .where(eq(agentInstancesTable.id, agentId))
      .for("share")
      .limit(1);
    return row?.generation ?? null;
  });
}

// ── Read acceleration mode from request ────────────────────────────────────

/**
 * Read the acceleration mode that was snapshotted onto req.agentDomainHit at
 * request start. Returns "off" if the request is not on an agent domain or the
 * hit does not carry acceleration state.
 */
export function getInvoiceAccelerationMode(req: { agentDomainHit?: unknown }): InvoiceAccelerationMode {
  const hit = req.agentDomainHit as AgentDomainHit | undefined;
  return hit?.accelerationMode ?? "off";
}

// ── Strongly-consistent request admission ──────────────────────────────────

const TRIAL_CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Resolve the CURRENT central mode for every create/update request. Trial
 * requests atomically reserve one of the remaining successful-save slots by
 * inserting a status=0 telemetry row while the agent control row is locked.
 *
 * This gives three properties the host cache alone cannot provide:
 *   • manual Off is observed by new requests across every API replica;
 *   • at most `invoiceTrialRemaining` trial requests are in flight;
 *   • exactly five successful create/update claims can complete a trial.
 */
export async function admitInvoiceAcceleration(
  agentId: number,
  operation: Extract<InvoiceOperation, "create" | "update">,
  requestSnapshot?: {
    mode: Extract<InvoiceAccelerationMode, "trial" | "on">;
    generation: number | null;
  },
): Promise<InvoiceAccelerationAdmission> {
  const staleCutoff = new Date(Date.now() - TRIAL_CLAIM_STALE_MS);
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        mode: agentInstancesTable.invoiceAccelerationMode,
        remaining: agentInstancesTable.invoiceTrialRemaining,
        trialStartAt: agentInstancesTable.invoiceAccelerationUpdatedAt,
        generation: agentInstancesTable.invoiceAccelerationGeneration,
      })
      .from(agentInstancesTable)
      .where(eq(agentInstancesTable.id, agentId))
      .for("update")
      .limit(1);

    const mode = (row?.mode ?? "off") as InvoiceAccelerationMode;
    if (!row) {
      return {
        admission: {
          mode: "off", accelerated: false, trialStartAt: null, trialClaimId: null,
        } as InvoiceAccelerationAdmission,
      };
    }
    // The request boundary was captured before host lookup/schema readiness.
    // If control changed after that boundary, this is a genuinely in-flight
    // request and must keep its request-start algorithm. A NEW request on a
    // stale active cache starts after the central transition and therefore
    // follows the current central mode instead.
    if (
      requestSnapshot
      && shouldHonorRequestStartGeneration(requestSnapshot.generation, row.generation)
    ) {
      return {
        admission: {
          mode: requestSnapshot.mode,
          accelerated: true,
          trialStartAt: null,
          trialClaimId: null,
        } as InvoiceAccelerationAdmission,
      };
    }
    if (mode === "off") {
      return {
        admission: {
          mode: "off", accelerated: false, trialStartAt: null, trialClaimId: null,
        } as InvoiceAccelerationAdmission,
      };
    }
    if (mode === "on") {
      return {
        admission: {
          mode: "on", accelerated: true, trialStartAt: null, trialClaimId: null,
        } as InvoiceAccelerationAdmission,
      };
    }

    const trialStartAt = row.trialStartAt;
    const remaining = row.remaining ?? 0;
    if (!trialStartAt || remaining <= 0) {
      const now = new Date();
      await tx.update(agentInstancesTable).set({
        invoiceAccelerationMode: "off",
        invoiceTrialRemaining: null,
        invoiceAccelerationLastError: "invalid_trial_state",
        invoiceAccelerationReason: "auto_rollback_invalid_trial_state",
        invoiceAccelerationUpdatedAt: now,
        invoiceAccelerationGeneration: sql`${agentInstancesTable.invoiceAccelerationGeneration} + 1`,
        updatedAt: now,
      }).where(eq(agentInstancesTable.id, agentId));
      return {
        admission: {
          mode: "off", accelerated: false, trialStartAt: null, trialClaimId: null,
        } as InvoiceAccelerationAdmission,
        rollbackReason: "invalid_trial_state",
      };
    }

    const staleClaims = await tx
      .select({ id: agentInvoiceSamplesTable.id })
      .from(agentInvoiceSamplesTable)
      .where(and(
        eq(agentInvoiceSamplesTable.agentId, agentId),
        eq(agentInvoiceSamplesTable.status, 0),
        gte(agentInvoiceSamplesTable.createdAt, trialStartAt),
        lt(agentInvoiceSamplesTable.createdAt, staleCutoff),
      ))
      .limit(1);
    if (staleClaims.length) {
      const now = new Date();
      await tx.update(agentInvoiceSamplesTable).set({
        status: 598,
        stages: { staleClaim: 1 },
      }).where(and(
        eq(agentInvoiceSamplesTable.agentId, agentId),
        eq(agentInvoiceSamplesTable.status, 0),
        gte(agentInvoiceSamplesTable.createdAt, trialStartAt),
        lt(agentInvoiceSamplesTable.createdAt, staleCutoff),
      ));
      await tx.update(agentInstancesTable).set({
        invoiceAccelerationMode: "off",
        invoiceTrialRemaining: null,
        invoiceAccelerationLastError: "stale_trial_request",
        invoiceAccelerationReason: "auto_rollback_stale_claim",
        invoiceAccelerationUpdatedAt: now,
        invoiceAccelerationGeneration: sql`${agentInstancesTable.invoiceAccelerationGeneration} + 1`,
        updatedAt: now,
      }).where(eq(agentInstancesTable.id, agentId));
      return {
        admission: {
          mode: "off", accelerated: false, trialStartAt: null, trialClaimId: null,
        } as InvoiceAccelerationAdmission,
        rollbackReason: "stale_trial_request",
      };
    }

    const [active] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(agentInvoiceSamplesTable)
      .where(and(
        eq(agentInvoiceSamplesTable.agentId, agentId),
        eq(agentInvoiceSamplesTable.status, 0),
        gte(agentInvoiceSamplesTable.createdAt, trialStartAt),
      ));
    const activeCount = Number(active?.count ?? 0);
    if (activeCount >= remaining) {
      // Trial capacity is already reserved. This request uses the unchanged
      // baseline algorithm and does not consume a trial success.
      return {
        admission: {
          mode: "trial", accelerated: false, trialStartAt, trialClaimId: null,
        } as InvoiceAccelerationAdmission,
      };
    }

    const [claim] = await tx.insert(agentInvoiceSamplesTable).values({
      agentId,
      operation,
      accelerated: true,
      status: 0,
      totalMs: 0,
      stages: { reserved: 1 },
      lineCount: null,
      poolStart: null,
      poolEnd: null,
    }).returning({ id: agentInvoiceSamplesTable.id });
    return {
      admission: {
        mode: "trial" as const,
        accelerated: true,
        trialStartAt,
        trialClaimId: claim.id,
      } as InvoiceAccelerationAdmission,
    };
  });

  if (outcome.rollbackReason) {
    await _clearHostCache();
    await _logCentralEvent(agentId, "invoice_acceleration_auto_rollback", {
      reason: outcome.rollbackReason,
    });
  }
  return outcome.admission;
}

// ── Non-blocking sample recorder ───────────────────────────────────────────

export function createInvoiceResponseOutcomeTracker(
  trialClaimed: boolean,
  complete: (status: number) => void,
): {
  onFinish(status: number): void;
  onCloseBeforeFinish(): void;
  onBusinessOutcome(status: number): void;
} {
  let handled = false;
  let closedBeforeFinish = false;
  let businessOutcomeStatus: number | null = null;
  const handle = (status: number) => {
    if (handled) return;
    handled = true;
    complete(status);
  };
  return {
    onFinish(status: number) {
      handle(status);
    },
    onCloseBeforeFinish() {
      if (!trialClaimed) {
        handle(499);
        return;
      }
      closedBeforeFinish = true;
      if (businessOutcomeStatus !== null) handle(businessOutcomeStatus);
    },
    onBusinessOutcome(status: number) {
      if (!trialClaimed) return;
      businessOutcomeStatus = status;
      if (closedBeforeFinish) handle(status);
    },
  };
}

/**
 * Baseline/on samples follow the HTTP response lifecycle. A reserved trial
 * claim is different: the sales route must explicitly complete it when the
 * business handler itself finishes, so a client disconnect after the external
 * DB commit cannot turn a real successful save into a synthetic 499.
 */
export function recordInvoiceSampleOnFinish(
  res: {
    once(event: string, cb: () => void): void;
    statusCode: number;
    writableFinished?: boolean;
  },
  input: Omit<InvoiceSampleInput, "status">,
  trialStartAt: Date | null,
  trialClaimId: number | null = null,
  responseAlreadyClosed = false,
): { completeBusinessOutcome(status: number): void } {
  const tracker = createInvoiceResponseOutcomeTracker(!!trialClaimId, (status) => {
    const sample: InvoiceSampleInput = { ...input, status };
    _handleSampleFinish(sample, trialStartAt, trialClaimId).catch(() => {});
  });
  // Connected requests are measured through the real response finish for a
  // like-for-like baseline/trial latency comparison.
  if (responseAlreadyClosed) {
    queueMicrotask(() => tracker.onCloseBeforeFinish());
  } else {
    res.once("finish", () => tracker.onFinish(res.statusCode));
    res.once("close", () => {
      if (res.writableFinished) return;
      tracker.onCloseBeforeFinish();
    });
  }
  return {
    completeBusinessOutcome(status: number) {
      tracker.onBusinessOutcome(status);
    },
  };
}

async function _handleSampleFinish(
  sample: InvoiceSampleInput,
  trialStartAt: Date | null,
  trialClaimId: number | null,
): Promise<void> {
  try {
    if (trialClaimId && trialStartAt && sample.accelerated) {
      const transition = await _completeTrialClaim(sample, trialStartAt, trialClaimId);
      if (transition.kind === "rollback_5xx") {
        await _clearHostCache();
        await _logCentralEvent(sample.agentId, "invoice_acceleration_auto_rollback", {
          reason: `server_error_during_trial: HTTP ${sample.status}`,
          statusCode: sample.status,
        });
      } else if (transition.kind === "evaluated") {
        await _clearHostCache();
        await _logCentralEvent(
          sample.agentId,
          transition.evaluation.eventType,
          transition.evaluation.eventDetail,
        );
      }
    } else {
      await db.insert(agentInvoiceSamplesTable).values({
        agentId:     sample.agentId,
        operation:   sample.operation,
        accelerated: sample.accelerated,
        status:      sample.status,
        totalMs:     sample.totalMs,
        stages:      sample.stages,
        lineCount:   sample.lineCount,
        poolStart:   sample.poolStart,
        poolEnd:     sample.poolEnd,
      });
    }
    _pruneOldSamples(sample.agentId).catch(() => {});
  } catch (err) {
    logger.warn({ err, agentId: sample.agentId }, "agentInvoiceAcceleration: failed to finish sample");
  }
}

async function _pruneOldSamples(agentId: number): Promise<void> {
  // Identify the id of the 200th-newest COMPLETED row for this agent. Active
  // trial reservations (status=0) must never be pruned.
  const cutoffRows = await db
    .select({ id: agentInvoiceSamplesTable.id })
    .from(agentInvoiceSamplesTable)
    .where(and(
      eq(agentInvoiceSamplesTable.agentId, agentId),
      sql`status <> 0`,
    ))
    .orderBy(desc(agentInvoiceSamplesTable.id))
    .limit(1)
    .offset(199);
  if (!cutoffRows.length) return;
  const cutoffId = cutoffRows[0].id;
  await db
    .delete(agentInvoiceSamplesTable)
    .where(
      and(
        eq(agentInvoiceSamplesTable.agentId, agentId),
        lt(agentInvoiceSamplesTable.id, cutoffId),
        sql`status <> 0`,
      ),
    );
}

async function _completeTrialClaim(
  sample: InvoiceSampleInput,
  trialStartAt: Date,
  claimId: number,
): Promise<
  | { kind: "none" }
  | { kind: "rollback_5xx" }
  | { kind: "evaluated"; evaluation: TrialEvaluationResult }
> {
  return db.transaction(async (tx) => {
    // Serialize claim completion with request admission for this agent.
    const [instance] = await tx
      .select({
        mode: agentInstancesTable.invoiceAccelerationMode,
        remaining: agentInstancesTable.invoiceTrialRemaining,
        updatedAt: agentInstancesTable.invoiceAccelerationUpdatedAt,
        baseline: agentInstancesTable.invoiceAccelerationBaseline,
      })
      .from(agentInstancesTable)
      .where(eq(agentInstancesTable.id, sample.agentId))
      .for("update")
      .limit(1);

    const [claim] = await tx
      .select({ id: agentInvoiceSamplesTable.id })
      .from(agentInvoiceSamplesTable)
      .where(and(
        eq(agentInvoiceSamplesTable.id, claimId),
        eq(agentInvoiceSamplesTable.agentId, sample.agentId),
        eq(agentInvoiceSamplesTable.status, 0),
      ))
      .limit(1);
    if (!claim) return { kind: "none" as const };

    await tx.update(agentInvoiceSamplesTable).set({
      status: sample.status,
      totalMs: sample.totalMs,
      stages: sample.stages,
      lineCount: sample.lineCount,
      poolStart: sample.poolStart,
      poolEnd: sample.poolEnd,
    }).where(eq(agentInvoiceSamplesTable.id, claimId));

    const sameTrial = instance?.mode === "trial"
      && instance.updatedAt?.getTime() === trialStartAt.getTime();
    if (!sameTrial) return { kind: "none" as const };

    if (sample.status >= 500) {
      const now = new Date();
      await tx.update(agentInstancesTable).set({
        invoiceAccelerationMode: "off",
        invoiceTrialRemaining: null,
        invoiceAccelerationLastError: `server_error_during_trial: HTTP ${sample.status}`,
        invoiceAccelerationReason: "auto_rollback_5xx",
        invoiceAccelerationUpdatedAt: now,
        invoiceAccelerationGeneration: sql`${agentInstancesTable.invoiceAccelerationGeneration} + 1`,
        updatedAt: now,
      }).where(eq(agentInstancesTable.id, sample.agentId));
      return { kind: "rollback_5xx" as const };
    }

    if (sample.status >= 200 && sample.status < 400) {
      const currentRemaining = instance?.remaining ?? 0;
      if (currentRemaining <= 0) return { kind: "none" as const };
      const remaining = currentRemaining - 1;
      if (remaining > 0) {
        await tx.update(agentInstancesTable).set({
          invoiceTrialRemaining: remaining,
        }).where(eq(agentInstancesTable.id, sample.agentId));
        return { kind: "none" as const };
      }

      // The fifth success is evaluated and transitioned while this same agent
      // row lock is still held. There is never a committed mode=trial,
      // remaining=0 window in which a sixth admission can force the trial off.
      const evaluation = await _evaluateTrialLocked(tx, sample.agentId, trialStartAt, {
        mode: instance.mode,
        updatedAt: instance.updatedAt,
        baseline: instance.baseline,
      });
      return { kind: "evaluated" as const, evaluation };
    }

    // 4xx/499 release the reservation but do not consume a successful save.
    return { kind: "none" as const };
  });
}

// ── Trial evaluation ────────────────────────────────────────────────────────

type TrialEvaluationResult = {
  promoted: boolean;
  reason: string;
  eventType: string;
  eventDetail: Record<string, unknown>;
};

async function _evaluateTrialLocked(
  tx: any,
  agentId: number,
  trialStartAt: Date,
  state: {
    mode: string | null;
    updatedAt: Date | null;
    baseline: unknown;
  },
): Promise<TrialEvaluationResult> {
  const baseline = (state.baseline && typeof state.baseline === "object")
    ? state.baseline as Partial<FrozenInvoiceBaseline>
    : null;
  const baselineCount = Number(baseline?.count ?? 0);
  const baseP95 = Number(baseline?.p95 ?? 0);

  const trialSamples = await tx
    .select()
    .from(agentInvoiceSamplesTable)
    .where(
      and(
        eq(agentInvoiceSamplesTable.agentId, agentId),
        eq(agentInvoiceSamplesTable.accelerated, true),
        gte(agentInvoiceSamplesTable.createdAt, trialStartAt),
        sql`operation IN ('create', 'update')`,
        sql`status >= 200 AND status < 400`,
      ),
    )
    .orderBy(desc(agentInvoiceSamplesTable.id))
    .limit(5);

  const accStats = computeSampleStats(trialSamples.map((sample: { totalMs: number }) => sample.totalMs));
  const accP95 = accStats.p95;
  const passes = trialSamples.length === 5
    && baselineCount >= 3
    && Number.isFinite(baseP95)
    && baseP95 > 0
    && accP95 < baseP95;
  const now = new Date();

  if (passes) {
    const rows = await tx
      .update(agentInstancesTable)
      .set({
        invoiceAccelerationMode:      "on",
        invoiceTrialRemaining:        null,
        invoiceAccelerationLastError: null,
        invoiceAccelerationReason:    `auto_promoted: accP95=${Math.round(accP95)}ms baseP95=${Math.round(baseP95)}ms`,
        invoiceAccelerationUpdatedAt: now,
        invoiceAccelerationGeneration: sql`${agentInstancesTable.invoiceAccelerationGeneration} + 1`,
        updatedAt:                    now,
      })
      .where(
        and(
          eq(agentInstancesTable.id, agentId),
          eq(agentInstancesTable.invoiceAccelerationMode, "trial"),
          sql`invoice_acceleration_updated_at = ${trialStartAt.toISOString()}`,
        ),
      )
      .returning({ id: agentInstancesTable.id });
    if (!rows.length) {
      return {
        promoted: false,
        reason: "guard_missed",
        eventType: "invoice_acceleration_transition_guard_missed",
        eventDetail: { target: "on" },
      };
    }
    return {
      promoted: true,
      reason: `accP95=${Math.round(accP95)}ms`,
      eventType: "invoice_acceleration_auto_enabled",
      eventDetail: {
        accP95: Math.round(accP95),
        accAvg: accStats.avg,
        baseP95: Math.round(baseP95),
        baseAvg: Number(baseline?.avg ?? 0),
        trialSamples: trialSamples.length,
        baselineSamples: baselineCount,
      },
    };
  }

  const reason = trialSamples.length !== 5
    ? `trial_samples=${trialSamples.length}, expected=5`
    : baselineCount < 3 || !Number.isFinite(baseP95) || baseP95 <= 0
      ? "frozen_baseline_missing_or_invalid"
      : `no_p95_improvement: accP95=${Math.round(accP95)}ms baseP95=${Math.round(baseP95)}ms`;
  const rows = await tx
    .update(agentInstancesTable)
    .set({
      invoiceAccelerationMode:      "off",
      invoiceTrialRemaining:        null,
      invoiceAccelerationLastError: reason,
      invoiceAccelerationReason:    "auto_rollback",
      invoiceAccelerationUpdatedAt: now,
      invoiceAccelerationGeneration: sql`${agentInstancesTable.invoiceAccelerationGeneration} + 1`,
      updatedAt:                    now,
    })
    .where(
      and(
        eq(agentInstancesTable.id, agentId),
        eq(agentInstancesTable.invoiceAccelerationMode, "trial"),
        sql`invoice_acceleration_updated_at = ${trialStartAt.toISOString()}`,
      ),
    )
    .returning({ id: agentInstancesTable.id });
  if (!rows.length) {
    return {
      promoted: false,
      reason: "guard_missed",
      eventType: "invoice_acceleration_transition_guard_missed",
      eventDetail: { target: "off" },
    };
  }
  return {
    promoted: false,
    reason,
    eventType: "invoice_acceleration_auto_rollback",
    eventDetail: {
      reason,
      accP95: Math.round(accP95),
      accAvg: accStats.avg,
      baseP95: baselineCount >= 3 ? Math.round(baseP95) : null,
      baseAvg: Number(baseline?.avg ?? 0),
      trialSamples: trialSamples.length,
      baselineSamples: baselineCount,
    },
  };
}

/**
 * Recovery entry point for a legacy/interrupted trial already at remaining=0.
 * Normal fifth-save evaluation runs inside `_completeTrialClaim` under the same
 * lock and transaction, so no sixth admission can interleave.
 */
export async function evaluateTrial(agentId: number, trialStartAt: Date): Promise<{
  promoted: boolean;
  reason: string;
}> {
  const evaluation = await db.transaction(async (tx) => {
    const [state] = await tx
      .select({
        mode: agentInstancesTable.invoiceAccelerationMode,
        remaining: agentInstancesTable.invoiceTrialRemaining,
        updatedAt: agentInstancesTable.invoiceAccelerationUpdatedAt,
        baseline: agentInstancesTable.invoiceAccelerationBaseline,
      })
      .from(agentInstancesTable)
      .where(eq(agentInstancesTable.id, agentId))
      .for("update")
      .limit(1);
    const sameTrial = state?.mode === "trial"
      && state.updatedAt?.getTime() === trialStartAt.getTime();
    if (!sameTrial) return null;
    if ((state.remaining ?? -1) !== 0) return null;
    return _evaluateTrialLocked(tx, agentId, trialStartAt, state);
  });
  if (!evaluation) return { promoted: false, reason: "guard_missed" };
  await _clearHostCache();
  await _logCentralEvent(agentId, evaluation.eventType, evaluation.eventDetail);
  return { promoted: evaluation.promoted, reason: evaluation.reason };
}

// ── Aggregate sample stats ──────────────────────────────────────────────────

/** Compute count/avg/p50/p95/belowOneSecond from a list of ms values. */
export function computeSampleStats(msValues: number[]): SampleStats {
  if (!msValues.length) return { count: 0, avg: 0, p50: 0, p95: 0, belowOneSecond: 0 };
  const sorted = [...msValues].sort((a, b) => a - b);
  const count  = sorted.length;
  const avg    = Math.round(sorted.reduce((a, b) => a + b, 0) / count);
  const p50    = sorted[Math.floor(count * 0.50)];
  const p95    = sorted[Math.floor(count * 0.95)];
  const belowOneSecond = sorted.filter(v => v < 1000).length;
  return { count, avg, p50, p95, belowOneSecond };
}

// ── Central security event helper ───────────────────────────────────────────

export async function _logCentralEvent(
  agentId: number,
  eventType: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(agentSecurityEventsTable).values({
      agentId,
      eventType,
      detail,
    });
  } catch (err) {
    logger.warn({ err, agentId, eventType }, "agentInvoiceAcceleration: failed to log central event");
  }
}

// ── Host cache clear (dynamic import to avoid static cycle) ─────────────────

async function _clearHostCache(): Promise<void> {
  try {
    const { clearAgentHostCache } = await import("../routes/agentInstances.js");
    clearAgentHostCache();
  } catch (err) {
    logger.warn({ err }, "agentInvoiceAcceleration: failed to clear host cache");
  }
}
