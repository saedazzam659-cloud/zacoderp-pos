import { db } from "@workspace/db";
import { companiesTable, maintenanceRunsTable, maintenanceScheduleTable, maintenanceEmailRunsTable, maintenanceRetentionSettingsTable, auditLogTable, usersTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { logger } from "./logger.js";
import { runAllChecks, MAINTENANCE_TOOL_KEYS, type ToolRunOutcome } from "./maintenanceChecks.js";
import { emailConfigured, sendMaintenanceCriticalDigest, type MaintenanceDigestRow, type MaintenanceErrorDigestRow, type MaintenanceRecoveryDigestRow } from "./email.js";

// Arabic display labels for each tool — kept here (and not in the React UI) so
// the email digest reads naturally for SuperAdmins. Mirrors the labels rendered
// in artifacts/zatca-invoicing/src/pages/admin/AICompanyFix.tsx.
export const MAINTENANCE_TOOL_LABELS_AR: Record<string, string> = {
  "journal-pending":      "القيود المعلقة",
  "broken-refs":          "مرجعيات مكسورة",
  "unlinked-accounts":    "حسابات غير مربوطة",
  "sequence-gaps":        "فجوات في المسلسلات",
  "dormant-users":        "مستخدمون خاملون",
  "orphan-stock":         "حركات مخزون يتيمة",
  "negative-stock":       "أرصدة مخزون سالبة",
  "stock-balance-drift":  "انحراف رصيد المخزون",
  "unbalanced-entries":   "قيود مرحّلة غير متوازنة",
  "old-audit-logs":       "سجل التدقيق القديم",
  "old-maintenance-runs": "سجل تشغيل الصيانة القديم",
};
function toolLabelAr(key: string): string {
  return MAINTENANCE_TOOL_LABELS_AR[key] ?? key;
}

// Single-row config primary key — matches the report-scheduler convention.
export const MAINTENANCE_SCHEDULE_ID = 1;

// KSA is fixed UTC+3 (no DST), so we can compare without a tz library.
const KSA_OFFSET_MIN = 3 * 60;
// Polling cadence — 5 min strikes a balance between fast pickup of config
// changes and not hammering the DB for the daily tick.
const TICK_MS  = 5 * 60_000;
const STARTUP_DELAY_MS = 30_000;

export async function ensureMaintenanceScheduleRow() {
  const [existing] = await db.select().from(maintenanceScheduleTable)
    .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
  if (existing) return existing;
  const [created] = await db.insert(maintenanceScheduleTable).values({
    id: MAINTENANCE_SCHEDULE_ID,
    enabled: true,
    hourOfDay: 3,
    minuteOfHour: 0,
  }).returning();
  return created;
}

// ─── Time utilities (KSA-local) ──────────────────────────────────────────────
// Returns "minutes since midnight" in KSA local time for a given Date.
function ksaMinutesOfDay(now: Date): number {
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (utcMinutes + KSA_OFFSET_MIN) % (24 * 60);
}
// Returns the YYYY-MM-DD KSA-local date string for a given Date.
function ksaDateKey(now: Date): string {
  const shifted = new Date(now.getTime() + KSA_OFFSET_MIN * 60_000);
  return shifted.toISOString().slice(0, 10);
}

// Decides whether the daily tick should fire right now: schedule is enabled,
// we've crossed the configured local time of day, and we haven't already run
// today (lastRunAt is on a different KSA-local date).
// Exported so the maintenance test suite can pin this behaviour at the unit
// level (the only other call site is the in-process tick loop below).
export function isDailyDue(
  now: Date,
  cfg: { enabled: boolean; hourOfDay: number; minuteOfHour: number; lastRunAt: Date | null },
): boolean {
  if (!cfg.enabled) return false;
  const target = (cfg.hourOfDay ?? 3) * 60 + (cfg.minuteOfHour ?? 0);
  if (ksaMinutesOfDay(now) < target) return false;
  if (!cfg.lastRunAt) return true;
  return ksaDateKey(cfg.lastRunAt) !== ksaDateKey(now);
}

// ─── Persistence helper — one INSERT per (company, tool) outcome ─────────────
async function persistRunOutcomes(
  companyId: number,
  trigger: "scheduled" | "manual",
  outcomes: ToolRunOutcome[],
): Promise<void> {
  if (!outcomes.length) return;
  await db.insert(maintenanceRunsTable).values(outcomes.map(o => ({
    companyId,
    toolKey: o.toolKey,
    status: o.status,
    count: o.count,
    trigger,
    durationMs: o.durationMs,
    error: o.error ?? null,
    details: o.extras ?? null,
  })));
}

// ─── Public: run the full sweep across all active companies ──────────────────
export interface SweepSummary {
  companies: number;
  toolsRun: number;
  criticalCount: number;
  warnCount: number;
  errorCount: number;
  failedCompanies: number;
  // Number of (company, tool) pairs whose latest pre-sweep status was 'error'
  // and whose new outcome is non-error. Surfaced so the scheduler tick log
  // line includes positive feedback alongside the existing failure counters.
  recoveryCount: number;
}

export async function runMaintenanceSweep(
  trigger: "scheduled" | "manual",
  opts: { publicBaseUrl?: string } = {},
): Promise<SweepSummary> {
  const companies = await db.select({ id: companiesTable.id })
    .from(companiesTable)
    .where(eq(companiesTable.status, "active"));
  let toolsRun = 0, criticalCount = 0, warnCount = 0, errorCount = 0, failedCompanies = 0, recoveryCount = 0;
  for (const c of companies) {
    try {
      // Snapshot the latest pre-sweep status per tool so we can detect tools
      // that transitioned error → ok/warn/critical during this sweep. Reading
      // BEFORE persisting the new outcomes is essential — otherwise the just-
      // inserted rows would shadow the previous state and every recovery
      // would be invisible. Best-effort: a query failure here just disables
      // recovery logging for THIS company, never aborts the sweep.
      let prevByTool = new Map<string, { status: string; runAt: Date }>();
      try {
        const prev = await getLatestResultsForCompany(c.id);
        prevByTool = new Map(prev.map((p) => [p.toolKey, { status: p.status, runAt: p.runAt }]));
      } catch (err) {
        logger.warn({ err, companyId: c.id }, "maintenance-sweep: pre-sweep status snapshot failed");
      }
      const outcomes = await runAllChecks(c.id);
      await persistRunOutcomes(c.id, trigger, outcomes);
      toolsRun += outcomes.length;
      for (const o of outcomes) {
        if (o.status === "critical") criticalCount += 1;
        else if (o.status === "warn") warnCount += 1;
        else if (o.status === "error") errorCount += 1;
        // Recovery transition detection. We log info-level (not warn/error) so
        // it shows up in the operational stream as a positive confirmation —
        // distinct from the existing "company failed" error log. Any non-error
        // outcome (ok / warn / critical) following an error counts as a
        // recovery: even a warn means the check ran to completion this time,
        // which is the actionable signal operators care about.
        const prev = prevByTool.get(o.toolKey);
        if (prev && prev.status === "error" && o.status !== "error") {
          recoveryCount += 1;
          logger.info({
            tool: o.toolKey,
            company: c.id,
            previousErrorAt: prev.runAt,
            currentStatus: o.status,
          }, "maintenance-recovery: tool recovered");
        }
      }
    } catch (e: any) {
      failedCompanies += 1;
      logger.error({ err: e, companyId: c.id }, "maintenance-sweep: company failed");
    }
  }
  // Update schedule row's "last run" snapshot so the UI can display it.
  await db.update(maintenanceScheduleTable).set({
    lastRunAt: new Date(),
    lastRunStatus: failedCompanies > 0 || errorCount > 0 ? "partial" : "ok",
    lastRunCompanies: companies.length,
    lastRunCriticalCount: criticalCount,
    lastError: null,
    updatedAt: new Date(),
  }).where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
  // Dispatch the SuperAdmin email digest if this *scheduled* sweep surfaced any
  // non-OK signal. We deliberately exclude `trigger === "manual"` here —
  // an admin clicking "Run now" gets immediate on-screen results and shouldn't
  // surprise other SuperAdmins with an alert email; the spec ties the digest
  // specifically to the scheduled sweep. The digest is best-effort and never
  // throws back into the sweep so runs still persist if SMTP/Outlook is down.
  // IMPORTANT: dispatch BEFORE the auto-unmute below so dispatchCriticalDigest's
  // snooze check sees the pre-sweep state. Otherwise an active snooze would be
  // silently overridden and the email would go out anyway, which contradicts
  // the "alerts not snoozed" requirement.
  //
  // Trigger condition is widened from "criticalCount > 0" to also include
  // warnings and errors so per-recipient severity thresholds (warning / all)
  // can actually fire. The dispatch path itself filters recipients by their
  // configured threshold, so threshold='critical' SuperAdmins still only
  // receive emails when at least one critical finding is present.
  if ((criticalCount > 0 || warnCount > 0 || errorCount > 0) && trigger === "scheduled") {
    try {
      await dispatchCriticalDigest({ publicBaseUrl: opts.publicBaseUrl, trigger: "scheduled" });
    } catch (e: any) {
      logger.error({ err: e }, "maintenance-sweep: digest dispatch failed");
    }
  }
  // Any new criticals lift the snooze flag so the dashboard banner reappears.
  if (criticalCount > 0) {
    await db.update(maintenanceScheduleTable)
      .set({ alertsMutedUntil: null, updatedAt: new Date() })
      .where(and(
        eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID),
        sql`${maintenanceScheduleTable.alertsMutedUntil} IS NOT NULL`,
      ));
  }
  return { companies: companies.length, toolsRun, criticalCount, warnCount, errorCount, failedCompanies, recoveryCount };
}

// ─── Email digest dispatch ───────────────────────────────────────────────────
// Builds the rows from the latest critical-per-(company, tool) snapshot,
// fetches all SuperAdmin recipient emails, and updates the schedule row's
// last-email status so the UI card can render it. Also reused by the
// "Send test email" button in the AI Company Fix screen.
export interface EmailDispatchOutcome {
  status: "ok" | "skipped" | "failed" | "no_recipients" | "no_transport" | "snoozed" | "no_critical" | "rate_limited";
  message: string;
  recipients: number;
  rows: number;
}

// Stable hash of the current alert set, used to bypass the cooldown when a new
// row appears or an existing one shifts (count or severity). Sorted so the
// hash is order-independent. Extracted (and exported) so the unit tests can
// pin the rate-limit decision deterministically.
//
// Severity is part of the payload so that a (company, tool, count) row that
// flips warn ↔ critical produces a NEW signature — otherwise a sweep that
// promoted a warning to critical would be suppressed by the cooldown even
// though it now meets the per-recipient `critical` threshold and should
// re-arm the digest. When severity is omitted we treat it as "critical" so
// the historical caller shape (pre-severity) hashes identically and the
// existing test fixtures keep passing.
export function computeCriticalSignature(
  rows: ReadonlyArray<{ companyId: number; toolKey: string; count: number; severity?: AlertSeverity }>,
): string {
  if (rows.length === 0) return "";
  const sorted = [...rows].sort((a, b) =>
    a.companyId - b.companyId || a.toolKey.localeCompare(b.toolKey)
  );
  const payload = sorted
    .map((r) => `${r.companyId}:${r.toolKey}:${r.count}:${r.severity ?? "critical"}`)
    .join("|");
  return createHash("sha1").update(payload).digest("hex");
}

// ─── Severity threshold ──────────────────────────────────────────────────────
// Tools surface three non-OK signals: `critical`, `warn`, and `error`
// (latter is an execution failure, not a finding). Each SuperAdmin can pick a
// per-account threshold ("critical" / "warning" / "all") that controls which
// sweeps actually email them. The dispatch trigger is widened to fire on any
// non-OK signal — recipient filtering then decides who actually gets the mail.
export type AlertSeverity = "critical" | "warn" | "error";
export type SeverityThreshold = "critical" | "warning" | "all";
export const SEVERITY_THRESHOLDS: ReadonlyArray<SeverityThreshold> = ["critical", "warning", "all"];

// True when the sweep's present severity set satisfies the recipient's
// threshold. Pure / dependency-free so the unit tests can pin every
// combination without spinning up a DB.
//   - "critical" recipients require at least one critical row.
//   - "warning"  recipients accept critical OR warn rows.
//   - "all"      recipients accept any non-OK signal — including a sweep
//                whose only signal is a silently-broken (`error`) tool.
// Unknown thresholds (defensive: bad row in DB) fall back to "critical" so
// the more conservative default wins and we never accidentally over-page.
export function severityMeetsThreshold(
  present: ReadonlySet<AlertSeverity>,
  threshold: SeverityThreshold | string | null | undefined,
): boolean {
  const t: SeverityThreshold =
    threshold === "warning" || threshold === "all" || threshold === "critical"
      ? threshold
      : "critical";
  if (t === "all") return present.size > 0;
  if (t === "warning") return present.has("critical") || present.has("warn");
  return present.has("critical");
}

// Pure decision function: should this scheduled dispatch be skipped due to the
// configured per-digest cooldown? Returns true only when (a) cadence is on,
// (b) we have a previous *successful* send to anchor the window on, (c) we're
// still inside the cooldown window measured from that successful send, AND
// (d) the current critical set is byte-identical to the last one delivered.
// If any of those are false, the cooldown does not apply. Test sends always
// bypass this check at the call site.
//
// IMPORTANT: this anchors on `lastSuccessfulEmailAt` (NOT `lastEmailAt`). A
// suppressed tick records `rate_limited` to `lastEmailAt`/`lastEmailStatus`
// for UI display, but those fields must NOT shift the cooldown window — that
// would reset the timer on every tick and let the next sweep send too early.
export function shouldSkipForRateLimit(
  now: Date,
  cfg: {
    emailMinIntervalHours: number;
    lastSuccessfulEmailAt: Date | null;
    lastEmailCriticalSignature: string | null;
  },
  signature: string,
): boolean {
  if (!Number.isFinite(cfg.emailMinIntervalHours) || cfg.emailMinIntervalHours <= 0) return false;
  if (!cfg.lastSuccessfulEmailAt) return false;
  const elapsedMs = now.getTime() - new Date(cfg.lastSuccessfulEmailAt).getTime();
  const intervalMs = cfg.emailMinIntervalHours * 60 * 60_000;
  if (elapsedMs >= intervalMs) return false;
  return cfg.lastEmailCriticalSignature === signature;
}

// Resolves a usable absolute base URL for deep-links inside the digest. The
// scheduled tick has no incoming request to derive the host from, so we fall
// back to PUBLIC_BASE_URL (operator-set) and finally to the Replit dev domain.
// Returning "" makes sendMaintenanceCriticalDigest emit a relative path, which
// only makes sense when the email is opened from inside the app (rare).
function resolvePublicBaseUrl(explicit?: string): string {
  const candidate = (explicit && explicit.trim())
    || process.env.PUBLIC_BASE_URL
    || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "");
  return candidate ? candidate.replace(/\/+$/, "") : "";
}

// Fetch the SuperAdmins eligible for THIS sweep's digest. A recipient is
// included only when (a) they're an active SuperAdmin with a usable email,
// (b) `notifyMaintenanceEmail` is on (the all-or-nothing kill switch), AND
// (c) the sweep's present severity set meets their per-account
// `notifyMaintenanceSeverity` threshold. Callers pass `presentSeverities`
// derived from the rows actually included in the digest (criticals + warns,
// and `error` when at least one tool is silently broken). When the set is
// empty no one is eligible — the dispatch path short-circuits earlier in
// that case but we belt-and-brace it here too.
//
// Returns de-duplicated emails so a SuperAdmin who somehow appears twice
// (e.g. legacy rows) doesn't get the digest twice.
//
// Exported so the maintenance test suite can pin the per-threshold filter
// against seeded SuperAdmins without spinning up the full sweep — the
// dispatch path's recipient-list assertion would otherwise only be visible
// as an integer count via EmailDispatchOutcome.recipients.
export async function getSuperAdminRecipients(
  presentSeverities: ReadonlySet<AlertSeverity>,
): Promise<string[]> {
  // notifyMaintenanceEmail = false is an explicit per-SuperAdmin opt-out
  // (set from their account settings). Users who flip it off are silently
  // excluded from the recipient list — same effect as having no email on file.
  const rows = await db.select({
    email: usersTable.email,
    severityThreshold: usersTable.notifyMaintenanceSeverity,
  })
    .from(usersTable)
    .where(and(
      eq(usersTable.role, "superadmin"),
      eq(usersTable.isActive, true),
      eq(usersTable.notifyMaintenanceEmail, true),
    ));
  const eligible = rows.filter((r) =>
    severityMeetsThreshold(presentSeverities, r.severityThreshold),
  );
  // De-dupe + drop blanks; SuperAdmins without a configured email simply opt out.
  return Array.from(new Set(eligible.map((r) => (r.email ?? "").trim()).filter((e) => e.length > 0)));
}

export async function dispatchCriticalDigest(
  opts: { publicBaseUrl?: string; isTest?: boolean; trigger?: "scheduled" | "manual" | "test" } = {},
): Promise<EmailDispatchOutcome> {
  const cfg = await ensureMaintenanceScheduleRow();
  // Resolve the trigger label written to the audit history. Callers can be
  // explicit (`trigger`) or imply it via the legacy `isTest` flag; default
  // to "scheduled" since that's the only auto-firing path.
  const trigger: "scheduled" | "manual" | "test" =
    opts.trigger ?? (opts.isTest ? "test" : "scheduled");
  const isTest = opts.isTest === true || trigger === "test";
  const muted = cfg.alertsMutedUntil && new Date(cfg.alertsMutedUntil).getTime() > Date.now();
  // Real (non-test) sends respect the snooze. Test sends bypass it intentionally.
  if (muted && !isTest) {
    return recordEmailOutcome(
      { status: "snoozed", message: "alerts_snoozed", recipients: 0, rows: 0 },
      { trigger, criticalSignature: "" },
    );
  }

  // Cap rows so a stuck tenant can't generate a multi-megabyte email, but make
  // the cap generous (every tool × every active company would be well under
  // this in practice) and explicitly note truncation if it ever fires.
  // The body now includes BOTH critical and warning rows so threshold='warning'
  // SuperAdmins see what actually fired their alert. Recipient filtering still
  // gates which severities a given user receives — see getSuperAdminRecipients.
  const ROW_CAP = 500;
  const alerts = await getMaintenanceAlerts(["critical", "warn"], ROW_CAP + 1);
  const truncated = alerts.length > ROW_CAP;
  const visibleAlerts = truncated ? alerts.slice(0, ROW_CAP) : alerts;
  // For test sends we still want to deliver something even if everything is OK
  // — the SuperAdmin only wants to verify their inbox actually receives the
  // template. We slot in a single placeholder row so the email isn't blank.
  let rows: MaintenanceDigestRow[];
  if (isTest && visibleAlerts.length === 0) {
    rows = [{
      companyId: 0,
      companyName: "(لا توجد نتائج حرجة حالياً — هذه رسالة تجريبية)",
      toolKey: "test",
      toolLabelAr: "اختبار",
      count: 0,
      runAt: new Date(),
      severity: "critical",
    }];
  } else {
    rows = visibleAlerts.map((a) => ({
      companyId: a.companyId,
      companyName: a.companyName,
      toolKey: a.toolKey,
      toolLabelAr: toolLabelAr(a.toolKey),
      count: a.count,
      runAt: a.runAt,
      severity: a.severity,
    }));
  }

  // Tools that errored within the recency window — surfaced alongside the
  // critical findings so SuperAdmins notice silently-broken checks. Errors
  // contribute to the present-severities set so threshold='all' recipients
  // can be notified even on a sweep whose only signal is a wedged tool, but
  // a sweep with ZERO warn/critical/error rows still short-circuits to
  // "no_critical" below (see the note on naming there).
  const ERROR_ROW_CAP = 50;
  let errorDigestRows: MaintenanceErrorDigestRow[] = [];
  try {
    const errs = await getRecentToolErrors(ERROR_ROW_CAP);
    errorDigestRows = errs.map((e) => ({
      companyId:   e.companyId,
      companyName: e.companyName,
      toolKey:     e.toolKey,
      toolLabelAr: toolLabelAr(e.toolKey),
      error:       e.error,
      runAt:       e.runAt,
    }));
  } catch (err) {
    // Best-effort — never fail the dispatch because the error-rows query
    // hiccupped; the SuperAdmin still wants the critical digest to land.
    logger.error({ err }, "maintenance-scheduler: failed to fetch tool errors for digest");
  }

  // Tools that recovered within the recency window — appended as a small
  // green section so SuperAdmins get explicit positive confirmation that
  // previously-broken checks are healthy again. Capped at the same 50-row
  // limit as the error section to keep the email scannable. Recoveries are
  // strictly informational: they do NOT contribute to `presentSeverities`,
  // do NOT influence the cooldown / signature, and never trigger a dispatch
  // on their own — they only ride along with digests that would already fire.
  const RECOVERY_ROW_CAP = 50;
  let recoveryDigestRows: MaintenanceRecoveryDigestRow[] = [];
  try {
    const recs = await getRecentToolRecoveries(RECOVERY_ROW_CAP);
    recoveryDigestRows = recs.map((r) => ({
      companyId:       r.companyId,
      companyName:     r.companyName,
      toolKey:         r.toolKey,
      toolLabelAr:     toolLabelAr(r.toolKey),
      currentStatus:   r.currentStatus,
      previousErrorAt: r.previousErrorAt,
      recoveredAt:     r.recoveredAt,
    }));
  } catch (err) {
    logger.error({ err }, "maintenance-scheduler: failed to fetch tool recoveries for digest");
  }

  // Build the severity set actually present in this dispatch payload so
  // recipient filtering matches what the email shows. Test sends with the
  // placeholder row count as 'critical' (the only audience for a test is the
  // operator triggering it).
  const presentSeverities = new Set<AlertSeverity>();
  for (const r of rows) presentSeverities.add(r.severity);
  if (errorDigestRows.length > 0) presentSeverities.add("error");

  // Short-circuit: nothing of any non-OK severity (no critical, no warn, no
  // recent error) AND no test-placeholder seat. We still record the schedule
  // row as `no_critical` for back-compat with the existing status taxonomy
  // (UI banners, audit history, /api/admin/maintenance dashboard all read
  // this enum) — but the inline message reflects the widened semantics so
  // operators auditing logs aren't misled into thinking only criticals were
  // checked. A future cleanup could rename the enum value end-to-end; doing
  // it here would touch UI/history without changing behaviour.
  if (!isTest && rows.length === 0 && errorDigestRows.length === 0) {
    return recordEmailOutcome(
      { status: "no_critical", message: "no_alerting_findings", recipients: 0, rows: 0 },
      { trigger, criticalSignature: "" },
    );
  }

  // Cooldown / rate-limit gate. Skipped for test sends (admins explicitly want
  // to verify delivery) and when the test placeholder row is in play. Real
  // dispatches with an unchanged critical set inside the configured window are
  // suppressed and surfaced in the UI as "rate_limited" so operators see *why*
  // the email didn't go out.
  //
  // Signature now includes severity per row so a sweep that promotes warn →
  // critical (or vice versa) bypasses the cooldown — threshold-sensitive
  // recipients need to see the change immediately.
  const signature = computeCriticalSignature(visibleAlerts);
  if (!isTest) {
    const skip = shouldSkipForRateLimit(new Date(), {
      emailMinIntervalHours: cfg.emailMinIntervalHours ?? 24,
      lastSuccessfulEmailAt: cfg.lastSuccessfulEmailAt,
      lastEmailCriticalSignature: cfg.lastEmailCriticalSignature,
    }, signature);
    if (skip) {
      // Note: we deliberately do NOT advance the schedule row's
      // lastEmailCriticalSignature here — subsequent ticks must keep
      // comparing against the last *sent* signature, not the most
      // recently-skipped one. The audit row still records `signature` so
      // SuperAdmins can see exactly which critical set was suppressed.
      return recordEmailOutcome({
        status: "rate_limited",
        message: `cooldown_active_${cfg.emailMinIntervalHours ?? 24}h_signature_unchanged`,
        recipients: 0, rows: rows.length,
      }, { trigger, criticalSignature: signature });
    }
  }

  // Test sends always go to every opted-in SuperAdmin (regardless of their
  // threshold) so an operator hitting "Send test email" gets confirmation
  // even if the live sweep is currently quiet. Real dispatches are
  // threshold-filtered by the present severity set.
  const recipientSeverities: ReadonlySet<AlertSeverity> = isTest
    ? new Set<AlertSeverity>(["critical", "warn", "error"])
    : presentSeverities;
  const recipients = await getSuperAdminRecipients(recipientSeverities);
  if (recipients.length === 0) {
    return recordEmailOutcome({
      status: "no_recipients",
      message: "no_superadmin_email_configured",
      recipients: 0, rows: rows.length,
    }, { trigger, criticalSignature: signature });
  }
  if (!emailConfigured()) {
    return recordEmailOutcome({
      status: "no_transport",
      message: "email_transport_unconfigured",
      recipients: recipients.length, rows: rows.length,
    }, { trigger, criticalSignature: signature });
  }

  const sendRes = await sendMaintenanceCriticalDigest({
    to: recipients,
    rows,
    publicBaseUrl: resolvePublicBaseUrl(opts.publicBaseUrl),
    isTest,
    truncated,
    errorRows: errorDigestRows,
    recoveryRows: recoveryDigestRows,
  });
  if (!sendRes.ok) {
    return recordEmailOutcome({
      status: "failed",
      message: sendRes.reason ?? "send_failed",
      recipients: recipients.length, rows: rows.length,
    }, { trigger, criticalSignature: signature });
  }
  // Real "ok" sends advance both the cooldown anchor (lastSuccessfulEmailAt)
  // and the schedule row's lastEmailCriticalSignature so the next sweep can
  // compare against the just-delivered set. Test sends keep the existing
  // schedule-row anchor/signature so they don't accidentally arm (or rearm)
  // the cooldown against the next real dispatch — but the audit row STILL
  // records the test signature so SuperAdmins can see what they sent.
  return recordEmailOutcome(
    {
      status: "ok",
      message: isTest ? "test_sent" : "digest_sent",
      recipients: recipients.length, rows: rows.length,
    },
    isTest
      ? { trigger, criticalSignature: signature }
      : { trigger, criticalSignature: signature, advanceCooldownAnchor: true },
  );
}

async function recordEmailOutcome(
  o: EmailDispatchOutcome,
  extras: {
    // Signature of the critical set considered for THIS attempt. Always
    // captured into the audit row so SuperAdmins can see exactly which
    // critical fingerprint was suppressed / sent / failed. Independent of
    // whether the cooldown anchor advances (see `advanceCooldownAnchor`).
    criticalSignature?: string;
    // Only true on real successful sends. When set we ALSO advance the
    // schedule row's `lastSuccessfulEmailAt` and `lastEmailCriticalSignature`
    // so the next sweep's cooldown decision anchors on this delivery.
    advanceCooldownAnchor?: boolean;
    trigger?: "scheduled" | "manual" | "test";
  } = {},
): Promise<EmailDispatchOutcome> {
  // Always stamp lastEmailAt so the UI shows the most recent attempt regardless
  // of outcome — operators need to know "we tried and SMTP rejected" just as
  // much as "we sent successfully". Errors land in lastEmailError for display.
  // `rate_limited` is a successful suppression (not a failure), so we don't
  // populate lastEmailError for it either. The cooldown anchor
  // (lastSuccessfulEmailAt) is only advanced via `extras.advanceCooldownAnchor`
  // so suppressed/failed/test attempts cannot reset the rate-limit window.
  const successful = o.status === "ok" || o.status === "no_critical" || o.status === "rate_limited";
  try {
    const patch: Record<string, any> = {
      lastEmailAt: new Date(),
      lastEmailStatus: o.status,
      lastEmailError: successful ? null : o.message,
      lastEmailRecipients: o.recipients,
      lastEmailCriticalCount: o.rows,
      updatedAt: new Date(),
    };
    // Advance the schedule-row signature ONLY when this is a real successful
    // send — never on suppressions / failures / tests. Otherwise the
    // signature on the schedule row would shift on every tick and the
    // cooldown decision (which compares the current signature to this one)
    // would always evaluate as "different" and bypass the cooldown.
    if (extras.advanceCooldownAnchor) {
      patch.lastSuccessfulEmailAt = new Date();
      if (extras.criticalSignature !== undefined) {
        patch.lastEmailCriticalSignature = extras.criticalSignature;
      }
    }
    await db.update(maintenanceScheduleTable).set(patch)
      .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
  } catch (err) {
    logger.error({ err }, "maintenance-scheduler: failed to record email outcome");
  }
  // Append-only audit row — preserved across attempts so SuperAdmins can
  // explain "why didn't I get the email last week?" without having to dig in
  // server logs. Failure to insert here is logged but never propagated, so a
  // history-table outage cannot block the actual send/UI update path.
  // `reason` always carries the machine-readable EmailDispatchOutcome.message
  // (e.g. "digest_sent", "cooldown_active_24h_signature_unchanged") so the UI
  // can explain *why* a sweep was skipped without parsing free-form errors.
  // `criticalSignature` captures the SHA-1 considered for THIS attempt so
  // SuperAdmins can verify the cooldown is anchored on the expected set.
  try {
    await db.insert(maintenanceEmailRunsTable).values({
      trigger:           extras.trigger ?? "scheduled",
      status:            o.status,
      recipients:        o.recipients,
      criticalCount:     o.rows,
      error:             successful ? null : o.message,
      reason:            o.message,
      criticalSignature: extras.criticalSignature ?? null,
    });
  } catch (err) {
    logger.error({ err }, "maintenance-scheduler: failed to append email-run history");
  }
  return o;
}

// ─── Manual cooldown reset ───────────────────────────────────────────────────
// Called from the "Clear cooldown" SuperAdmin action when an operator wants
// the next scheduled sweep (or manual run-now) to fire the digest immediately,
// bypassing the configured cadence. Wipes the schedule row's signature anchor
// AND its successful-send timestamp so `shouldSkipForRateLimit` short-circuits
// to "no prior successful send → never skips" on the next tick.
//
// Returning the snapshot (timestamps it cleared, plus the prior signature)
// lets the caller log it for the audit trail without a second SELECT.
export interface CooldownClearSnapshot {
  clearedAt: Date;
  previousLastSuccessfulEmailAt: Date | null;
  previousSignature: string | null;
}
export async function clearCriticalDigestCooldown(): Promise<CooldownClearSnapshot> {
  const cfg = await ensureMaintenanceScheduleRow();
  const snapshot: CooldownClearSnapshot = {
    clearedAt: new Date(),
    previousLastSuccessfulEmailAt: cfg.lastSuccessfulEmailAt,
    previousSignature: cfg.lastEmailCriticalSignature,
  };
  await db.update(maintenanceScheduleTable).set({
    lastSuccessfulEmailAt: null,
    lastEmailCriticalSignature: null,
    updatedAt: new Date(),
  }).where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
  // Drop a marker row in the audit history so SuperAdmins can see who/when
  // forced the bypass. Best-effort — never throw, mirroring recordEmailOutcome.
  try {
    await db.insert(maintenanceEmailRunsTable).values({
      trigger:           "manual",
      status:            "skipped",
      recipients:        0,
      criticalCount:     0,
      error:             null,
      reason:            "cooldown_cleared",
      criticalSignature: snapshot.previousSignature,
    });
  } catch (err) {
    logger.error({ err }, "maintenance-scheduler: failed to log cooldown clear");
  }
  return snapshot;
}

// ─── Latest-result query (used by the UI badges + dashboard banner) ──────────
export interface LatestResultRow {
  toolKey: string;
  status: string;
  count: number;
  trigger: string;
  runAt: Date;
}

export async function getLatestResultsForCompany(
  companyId: number,
  opts: { trigger?: "scheduled" | "manual" } = {},
): Promise<LatestResultRow[]> {
  // Pick the most recent run per tool_key for this company. DISTINCT ON is
  // the natural fit in Postgres and keeps this O(rows-per-tool). Callers can
  // narrow to a specific trigger so the dashboard "آخر فحص تلقائي" badge
  // doesn't get masked by a more-recent ad-hoc manual run.
  const triggerFilter = opts.trigger ? sql`AND trigger = ${opts.trigger}` : sql``;
  const exec = await db.execute<any>(sql`
    SELECT DISTINCT ON (tool_key)
           tool_key  AS "toolKey",
           status,
           count,
           trigger,
           run_at    AS "runAt"
      FROM maintenance_runs
     WHERE company_id = ${companyId}
       ${triggerFilter}
     ORDER BY tool_key, run_at DESC
  `);
  return ((exec as any).rows ?? []) as LatestResultRow[];
}

// ─── Dashboard banner — companies whose latest run hit "critical" ────────────
export interface CriticalAlertRow {
  companyId: number;
  companyName: string;
  toolKey: string;
  count: number;
  runAt: Date;
  // Always populated. The dashboard banner uses 'critical' rows exclusively
  // (existing behaviour); the digest dispatch path uses the same shape with
  // 'warn' mixed in so threshold='warning' recipients see what actually fired.
  // Narrower than `AlertSeverity` because the SQL behind every producer of
  // this row only ever selects critical/warn — `error` is delivered separately
  // via `getRecentToolErrors`/`MaintenanceErrorDigestRow`.
  severity: "critical" | "warn";
}

export async function getCriticalAlerts(limit = 20): Promise<CriticalAlertRow[]> {
  // For each (company, tool), only the most recent row matters. We take the
  // latest per pair, keep those whose status='critical', and join the company
  // name for display. Limit defends against an extreme worst-case payload.
  const exec = await db.execute<any>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (company_id, tool_key)
             company_id, tool_key, status, count, run_at
        FROM maintenance_runs
       ORDER BY company_id, tool_key, run_at DESC
    )
    SELECT l.company_id AS "companyId",
           c.name_ar    AS "companyName",
           l.tool_key   AS "toolKey",
           l.count,
           l.run_at     AS "runAt",
           l.status     AS "severity"
      FROM latest l
      JOIN companies c ON c.id = l.company_id
     WHERE l.status = 'critical'
       AND c.status = 'active'
     ORDER BY l.run_at DESC
     LIMIT ${limit}
  `);
  return ((exec as any).rows ?? []) as CriticalAlertRow[];
}

// Same per-(company, tool) latest projection as `getCriticalAlerts`, but
// scoped to a caller-supplied set of statuses. Used by the digest path to pull
// in `warn` rows alongside the criticals so threshold='warning' recipients get
// a body that actually shows what triggered their alert. Critical rows are
// listed first (so the email leads with the most severe items) and warns
// follow within their respective recency order.
//
// We stay in `getCriticalAlerts`-shape rather than introducing a parallel
// type so the digest dispatch only has to think about one row format.
export async function getMaintenanceAlerts(
  severities: ReadonlyArray<"critical" | "warn">,
  limit = 20,
): Promise<CriticalAlertRow[]> {
  if (severities.length === 0) return [];
  const list = sql.join(severities.map((s) => sql`${s}`), sql`, `);
  const exec = await db.execute<any>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (company_id, tool_key)
             company_id, tool_key, status, count, run_at
        FROM maintenance_runs
       ORDER BY company_id, tool_key, run_at DESC
    )
    SELECT l.company_id AS "companyId",
           c.name_ar    AS "companyName",
           l.tool_key   AS "toolKey",
           l.count,
           l.run_at     AS "runAt",
           l.status     AS "severity"
      FROM latest l
      JOIN companies c ON c.id = l.company_id
     WHERE l.status IN (${list})
       AND c.status = 'active'
     ORDER BY CASE l.status WHEN 'critical' THEN 0 ELSE 1 END,
              l.run_at DESC
     LIMIT ${limit}
  `);
  return ((exec as any).rows ?? []) as CriticalAlertRow[];
}

// ─── Recent tool-error indicator — latest per-(company, tool) "error" rows ───
// A tool whose latest run threw is silently broken: it contributes nothing to
// `criticalCount` (the digest/banner trigger) so an operator can stay green
// for weeks while a check is wedged. We surface it explicitly via this helper
// so the dashboard can show a distinct indicator and the maintenance page can
// list which tools/companies need attention.
//
// Recency window — `windowDays` (default 7) — bounds the surface so a transient
// failure that has since recovered (any non-error run later wins via the
// per-(company, tool) latest projection) AND historical errors before the
// window simply drop off. Operators investigate "what broke this week", not
// "what broke 3 months ago".
export const TOOL_ERROR_WINDOW_DAYS = 7;

export interface ToolErrorRow {
  id: number;
  companyId: number;
  companyName: string;
  toolKey: string;
  status: "error";
  error: string | null;
  runAt: Date;
}

export async function getRecentToolErrors(
  limit = 50,
  windowDays: number = TOOL_ERROR_WINDOW_DAYS,
): Promise<ToolErrorRow[]> {
  // Same per-(company, tool) latest projection as getCriticalAlerts so a
  // recovered tool can't keep flagging — its latest row will be ok/warn/
  // critical, not 'error'. Bound by the recency window so operators see only
  // currently-broken tools.
  const exec = await db.execute<any>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (company_id, tool_key)
             id, company_id, tool_key, status, error, run_at
        FROM maintenance_runs
       ORDER BY company_id, tool_key, run_at DESC
    )
    SELECT l.id         AS "id",
           l.company_id AS "companyId",
           c.name_ar    AS "companyName",
           l.tool_key   AS "toolKey",
           l.status     AS "status",
           l.error      AS "error",
           l.run_at     AS "runAt"
      FROM latest l
      JOIN companies c ON c.id = l.company_id
     WHERE l.status  = 'error'
       AND c.status  = 'active'
       AND l.run_at >= now() - ((${windowDays})::int || ' days')::interval
     ORDER BY l.run_at DESC
     LIMIT ${limit}
  `);
  return ((exec as any).rows ?? []) as ToolErrorRow[];
}

// ─── Recent recoveries — tools that flipped error → non-error in window ──────
// Mirrors `getRecentToolErrors` but in the positive direction: each row
// represents a (company, tool) pair whose latest run finished without error
// AND whose immediately-previous run was an 'error' that occurred within the
// recency window. Used by the digest dispatch to render a green "recovered
// tools" section so SuperAdmins get explicit confirmation that previously-
// broken checks are healthy again — without it, a fixed tool just silently
// disappears from the error section.
//
// Bounding by `recoveredAt >= now() - windowDays` matches the error helper
// (operators care about "what changed this week", not historical churn).
// Capping at `limit` mirrors `ERROR_ROW_CAP` so a noisy tenant can't blow
// up the email body. We do NOT join the original error row — only the
// previous-error timestamp is needed for the digest line.
export interface ToolRecoveryRow {
  companyId: number;
  companyName: string;
  toolKey: string;
  // Status of the recovery row itself (always non-error: ok / warn / critical).
  // Surfaced because a recovery to "warn"/"critical" still warrants a glance —
  // the check ran successfully but found new findings. Operators can use this
  // to distinguish "fully healed" from "now reporting normally with issues".
  currentStatus: string;
  previousErrorAt: Date;
  recoveredAt: Date;
}

export async function getRecentToolRecoveries(
  limit = 50,
  windowDays: number = TOOL_ERROR_WINDOW_DAYS,
): Promise<ToolRecoveryRow[]> {
  // LAG window function over (company_id, tool_key) ordered by run_at gives
  // each row its predecessor's status + run_at. We then keep only rows whose:
  //   - own status is non-error,
  //   - prior status was 'error',
  //   - own run_at is the latest for the (company, tool) pair (so a tool that
  //     recovered then re-broke is excluded — its latest row would be 'error',
  //     and `getRecentToolErrors` covers that case),
  //   - recovery happened inside the recency window.
  // The `latest` CTE is the same per-(company, tool) projection used by
  // `getRecentToolErrors` so the two helpers are mutually exclusive: a given
  // (company, tool) pair appears in at most one of them at any time.
  const exec = await db.execute<any>(sql`
    WITH ranked AS (
      SELECT id,
             company_id,
             tool_key,
             status,
             run_at,
             LAG(status) OVER (PARTITION BY company_id, tool_key ORDER BY run_at) AS prev_status,
             LAG(run_at) OVER (PARTITION BY company_id, tool_key ORDER BY run_at) AS prev_run_at,
             ROW_NUMBER() OVER (PARTITION BY company_id, tool_key ORDER BY run_at DESC) AS rn
        FROM maintenance_runs
    )
    SELECT r.company_id    AS "companyId",
           c.name_ar       AS "companyName",
           r.tool_key      AS "toolKey",
           r.status        AS "currentStatus",
           r.prev_run_at   AS "previousErrorAt",
           r.run_at        AS "recoveredAt"
      FROM ranked r
      JOIN companies c ON c.id = r.company_id
     WHERE r.rn = 1
       AND r.status      <> 'error'
       AND r.prev_status  = 'error'
       AND c.status       = 'active'
       AND r.run_at >= now() - ((${windowDays})::int || ' days')::interval
     ORDER BY r.run_at DESC
     LIMIT ${limit}
  `);
  return ((exec as any).rows ?? []) as ToolRecoveryRow[];
}

// ─── Email-history auto-prune ────────────────────────────────────────────────
// The two append-only email-history tables (`report_email_schedule_runs` and
// `maintenance_email_runs`) grow forever otherwise: every scheduled or manual
// dispatch (success, failure, suppression) appends a row, so the SuperAdmin
// audit panels gradually slow down on long-running deployments. The toolbox
// "fix" buttons can purge them manually, but that only runs when an operator
// clicks. This helper runs once per scheduled sweep so retention is enforced
// even when nobody opens the toolbox.
//
// Retention is read from `maintenance_retention_settings` (the same table the
// SuperAdmin retention controls write to) and falls back to 90 days — the
// same default the toolbox cards display. Bounds (7..3650) mirror the
// RETENTION_TOOL_BOUNDS table in admin.ts so a stale settings row from an
// older deploy can't bypass the input validation.
//
// Each sweep writes a single summary row to `audit_log` so SuperAdmins can
// see when the auto-prune ran and how many rows it removed without parsing
// server logs. Recorded under company 0 (system-wide) since both tables are
// global, matching the convention used by the retention-settings PUT path.
const EMAIL_HISTORY_RETENTION_DEFAULT_DAYS = 90;
const EMAIL_HISTORY_RETENTION_MIN_DAYS = 7;
const EMAIL_HISTORY_RETENTION_MAX_DAYS = 3650;

function clampRetention(days: unknown, fallback: number): number {
  const n = Number(days);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (n < EMAIL_HISTORY_RETENTION_MIN_DAYS) return EMAIL_HISTORY_RETENTION_MIN_DAYS;
  if (n > EMAIL_HISTORY_RETENTION_MAX_DAYS) return EMAIL_HISTORY_RETENTION_MAX_DAYS;
  return n;
}

// Reads the persisted retention for `toolKey`, clamps it against the shared
// bounds, and falls back to 90 days when the row is missing or the SELECT
// errors (e.g. pre-`pnpm db:push` deploy). Mirrors `getRetentionDays` in
// admin.ts but kept local to avoid a circular import (admin.ts already
// imports from this module).
async function getEmailHistoryRetentionDays(toolKey: string): Promise<number> {
  try {
    const [row] = await db.select()
      .from(maintenanceRetentionSettingsTable)
      .where(eq(maintenanceRetentionSettingsTable.toolKey, toolKey));
    if (!row) return EMAIL_HISTORY_RETENTION_DEFAULT_DAYS;
    return clampRetention(row.days, EMAIL_HISTORY_RETENTION_DEFAULT_DAYS);
  } catch (err) {
    logger.warn({ err, toolKey }, "email-history-prune: retention lookup failed — using default");
    return EMAIL_HISTORY_RETENTION_DEFAULT_DAYS;
  }
}

export interface EmailHistoryPruneSummary {
  reportEmailRunsDeleted: number;
  reportEmailRunsRetentionDays: number;
  maintenanceEmailRunsDeleted: number;
  maintenanceEmailRunsRetentionDays: number;
  durationMs: number;
}

// Prunes both email-history tables in one pass and writes a single summary
// audit row. Each DELETE is wrapped independently so a failure on one table
// (e.g. the report scheduler artifact hasn't been deployed yet and the table
// is missing) doesn't block the other. Failures are logged and surfaced in
// the audit metadata under `errors[]` so operators can see partial sweeps in
// the maintenance history panel.
//
// Exported so the scheduler test suite can drive the function directly
// without spinning up the daily-tick loop.
export async function runEmailHistoryAutoPrune(
  trigger: "scheduled" | "manual" = "scheduled",
): Promise<EmailHistoryPruneSummary> {
  const t0 = Date.now();
  const reportDays = await getEmailHistoryRetentionDays("old-report-email-runs");
  const maintDays  = await getEmailHistoryRetentionDays("old-maintenance-email-runs");
  const errors: Array<{ table: string; error: string }> = [];

  // Use the driver's `rowCount` instead of `RETURNING id` so the very first
  // sweep (which may face years of accumulated rows after this feature ships)
  // doesn't materialize a giant id list in memory just to count it. node-pg
  // populates `rowCount` reliably for DELETE; we fall back to `rows.length`
  // defensively in case a future driver swap drops it.
  const countDeleted = (exec: unknown): number => {
    const r = exec as { rowCount?: number | null; rows?: unknown[] };
    if (typeof r?.rowCount === "number") return r.rowCount;
    return Array.isArray(r?.rows) ? r.rows.length : 0;
  };

  let reportDeleted = 0;
  try {
    const exec = await db.execute(sql`
      DELETE FROM report_email_schedule_runs
       WHERE ran_at < NOW() - (${reportDays}::int || ' days')::interval
    `);
    reportDeleted = countDeleted(exec);
  } catch (err: any) {
    errors.push({ table: "report_email_schedule_runs", error: err?.message ?? String(err) });
    logger.error({ err }, "email-history-prune: report_email_schedule_runs DELETE failed");
  }

  let maintDeleted = 0;
  try {
    const exec = await db.execute(sql`
      DELETE FROM maintenance_email_runs
       WHERE ran_at < NOW() - (${maintDays}::int || ' days')::interval
    `);
    maintDeleted = countDeleted(exec);
  } catch (err: any) {
    errors.push({ table: "maintenance_email_runs", error: err?.message ?? String(err) });
    logger.error({ err }, "email-history-prune: maintenance_email_runs DELETE failed");
  }

  const durationMs = Date.now() - t0;

  // One summary audit row per sweep. Best-effort: an audit-log outage cannot
  // mask the prune itself (rows are already deleted) so we log and move on.
  // companyId=0 mirrors the retention-settings PUT convention since both
  // tables are system-wide, not tenant-scoped.
  try {
    await db.insert(auditLogTable).values({
      userId: null,
      username: null,
      role: "system",
      companyId: 0,
      module: "maintenance",
      action: "auto_prune",
      method: null,
      path: null,
      entityType: "email_history",
      entityId: null,
      metadata: {
        trigger,
        reportEmailRuns: { deleted: reportDeleted, retentionDays: reportDays },
        maintenanceEmailRuns: { deleted: maintDeleted, retentionDays: maintDays },
        durationMs,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
  } catch (err) {
    logger.error({ err }, "email-history-prune: failed to write audit summary");
  }

  return {
    reportEmailRunsDeleted: reportDeleted,
    reportEmailRunsRetentionDays: reportDays,
    maintenanceEmailRunsDeleted: maintDeleted,
    maintenanceEmailRunsRetentionDays: maintDays,
    durationMs,
  };
}

// ─── Per-table old-records auto-prune (audit_log + maintenance_runs) ─────────
// Companion to runEmailHistoryAutoPrune that handles the two per-company
// "old records" toolbox cards (`old-audit-logs` and `old-maintenance-runs`).
// Both grow much faster than the email-history tables, so the same daily
// hygiene treatment prevents the SuperAdmin panels and the maintenance
// history accordion from slowing down between manual sweeps.
//
// Unlike the manual toolbox handlers in admin.ts — which scope each DELETE
// to a single company because the operator picks one tenant in the UI — the
// scheduled sweep deletes across ALL companies in a single statement. The
// retention setting is system-wide and there's no per-tenant exclusion, so
// fanning out per-company would just multiply DB round-trips for the same
// effective result.
//
// One summary audit row is written per table per sweep so the maintenance-
// history panel surfaces each prune independently. companyId=0 mirrors the
// retention-settings PUT convention since these summaries describe a
// system-wide action, not a tenant-scoped one.
//
// Audit-log self-pruning note: the summary row is written AFTER the DELETE
// and carries created_at = NOW(), which is strictly greater than the cutoff
// (NOW() - retentionDays). The summary therefore survives its own prune —
// same guarantee the manual /maintenance/old-audit-logs/fix handler relies
// on (see the comment there).
//
// Per-tool bounds — duplicated here from RETENTION_TOOL_BOUNDS in
// admin.ts to avoid a circular import (admin.ts already imports from this
// module). MUST stay in sync with that table: a stale persisted setting from
// an older deploy (or an out-of-band UPDATE) is clamped against the same
// per-tool window the manual toolbox cards enforce, so the scheduled sweep
// can never delete more aggressively than the UI would let an operator do.
// In particular, `old-audit-logs` has min=30 (NOT the global 7), so a
// persisted row with days=10 must be clamped up to 30 here.
const OLD_RECORDS_BOUNDS: Record<
  "old-audit-logs" | "old-maintenance-runs",
  { default: number; min: number; max: number }
> = {
  "old-audit-logs":       { default: 365, min: 30, max: 3650 },
  "old-maintenance-runs": { default: 90,  min: 7,  max: 3650 },
};

function clampOldRecordsRetention(
  days: unknown, bounds: { default: number; min: number; max: number },
): number {
  const n = Number(days);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return bounds.default;
  if (n < bounds.min) return bounds.min;
  if (n > bounds.max) return bounds.max;
  return n;
}

async function getRetentionDaysForOldRecords(
  toolKey: "old-audit-logs" | "old-maintenance-runs",
): Promise<number> {
  const bounds = OLD_RECORDS_BOUNDS[toolKey];
  try {
    const [row] = await db.select()
      .from(maintenanceRetentionSettingsTable)
      .where(eq(maintenanceRetentionSettingsTable.toolKey, toolKey));
    if (!row) return bounds.default;
    return clampOldRecordsRetention(row.days, bounds);
  } catch (err) {
    logger.warn({ err, toolKey }, "old-records-prune: retention lookup failed — using default");
    return bounds.default;
  }
}

export interface OldRecordsPruneSummary {
  deleted: number;
  retentionDays: number;
  durationMs: number;
}

// Internal helper — runs one DELETE + one summary audit row. Exported wrappers
// below pin the toolKey / table so the test suite can call each path
// explicitly without duplicating the orchestration. Bounds + defaults come
// from OLD_RECORDS_BOUNDS so adding a tool is a one-line config change.
async function pruneOldRecordsTable(
  args: {
    toolKey: "old-audit-logs" | "old-maintenance-runs";
    table: "audit_log" | "maintenance_runs";
    entityType: "audit_log" | "maintenance_runs";
    trigger: "scheduled" | "manual";
  },
): Promise<OldRecordsPruneSummary> {
  const t0 = Date.now();
  const days = await getRetentionDaysForOldRecords(args.toolKey);
  let deleted = 0;
  let error: string | null = null;

  // Use the driver's `rowCount` instead of `RETURNING id` so the very first
  // sweep (which may face years of accumulated rows after this feature ships)
  // doesn't materialize a giant id list in memory just to count it. Same
  // shape as the email-history helper above.
  const countDeleted = (exec: unknown): number => {
    const r = exec as { rowCount?: number | null; rows?: unknown[] };
    if (typeof r?.rowCount === "number") return r.rowCount;
    return Array.isArray(r?.rows) ? r.rows.length : 0;
  };

  try {
    // Two near-identical DELETEs because the timestamp column differs
    // (`created_at` vs `run_at`). Inlining the table + column names keeps
    // the SQL readable and avoids smuggling identifiers through `sql.raw`.
    const exec = args.table === "audit_log"
      ? await db.execute(sql`
          DELETE FROM audit_log
           WHERE created_at < NOW() - (${days}::int || ' days')::interval
        `)
      : await db.execute(sql`
          DELETE FROM maintenance_runs
           WHERE run_at < NOW() - (${days}::int || ' days')::interval
        `);
    deleted = countDeleted(exec);
  } catch (err: any) {
    error = err?.message ?? String(err);
    logger.error({ err, table: args.table }, "old-records-prune: DELETE failed");
  }

  const durationMs = Date.now() - t0;

  // One summary audit row per sweep. Best-effort: an audit-log outage cannot
  // mask the prune itself (rows are already deleted) so we log and move on.
  try {
    await db.insert(auditLogTable).values({
      userId: null,
      username: null,
      role: "system",
      companyId: 0,
      module: "maintenance",
      action: "auto_prune",
      method: null,
      path: null,
      entityType: args.entityType,
      entityId: null,
      metadata: {
        trigger: args.trigger,
        deleted,
        retentionDays: days,
        durationMs,
        ...(error ? { error } : {}),
      },
    });
  } catch (err) {
    logger.error({ err, table: args.table }, "old-records-prune: failed to write audit summary");
  }

  return { deleted, retentionDays: days, durationMs };
}

// Exported so the scheduler test suite can drive the function directly
// without spinning up the daily-tick loop. Bounds (default 365d, min 30d,
// max 3650d) mirror the `old-audit-logs` entry in RETENTION_TOOL_BOUNDS
// in admin.ts via OLD_RECORDS_BOUNDS above.
export async function runAuditLogAutoPrune(
  trigger: "scheduled" | "manual" = "scheduled",
): Promise<OldRecordsPruneSummary> {
  return pruneOldRecordsTable({
    toolKey: "old-audit-logs",
    table: "audit_log",
    entityType: "audit_log",
    trigger,
  });
}

// Exported so the scheduler test suite can drive the function directly
// without spinning up the daily-tick loop. Bounds (default 90d, min 7d,
// max 3650d) mirror the `old-maintenance-runs` entry in RETENTION_TOOL_BOUNDS
// in admin.ts via OLD_RECORDS_BOUNDS above.
export async function runMaintenanceRunsAutoPrune(
  trigger: "scheduled" | "manual" = "scheduled",
): Promise<OldRecordsPruneSummary> {
  return pruneOldRecordsTable({
    toolKey: "old-maintenance-runs",
    table: "maintenance_runs",
    entityType: "maintenance_runs",
    trigger,
  });
}

// ─── Scheduler boot (called once from index.ts) ──────────────────────────────
let started = false;
export function startMaintenanceScheduler() {
  if (started) return;
  started = true;

  async function tick() {
    try {
      const cfg = await ensureMaintenanceScheduleRow();
      // Always advance lastTickAt so we can tell from the UI when the loop
      // last evaluated, even on days the schedule is off.
      await db.update(maintenanceScheduleTable)
        .set({ lastTickAt: new Date() })
        .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
      if (!isDailyDue(new Date(), cfg)) return;
      const summary = await runMaintenanceSweep("scheduled");
      logger.info({ summary }, "maintenance-scheduler: scheduled sweep complete");
      // Auto-prune the two email-history tables once per scheduled sweep so
      // the SuperAdmin audit panels don't quietly accumulate years of rows
      // when nobody clicks the manual "fix" buttons. Best-effort: any
      // failure is logged inside the helper itself and never escapes — the
      // sweep already succeeded, so we don't want to mask its success or
      // double-fire next tick.
      try {
        const pruneSummary = await runEmailHistoryAutoPrune("scheduled");
        logger.info({ pruneSummary }, "maintenance-scheduler: email-history auto-prune complete");
      } catch (err) {
        logger.error({ err }, "maintenance-scheduler: email-history auto-prune failed");
      }
      // Same hygiene treatment for the two per-company "old records" cards
      // (audit_log + maintenance_runs). Both grow much faster than the
      // email-history tables, so without a scheduled prune the SuperAdmin
      // panels and the maintenance-history accordion slow down between
      // manual sweeps. Each helper is wrapped independently so a failure on
      // one does not block the other; helper-internal errors are logged
      // there too and never escape into the outer tick.
      try {
        const auditPruneSummary = await runAuditLogAutoPrune("scheduled");
        logger.info({ auditPruneSummary }, "maintenance-scheduler: audit-log auto-prune complete");
      } catch (err) {
        logger.error({ err }, "maintenance-scheduler: audit-log auto-prune failed");
      }
      try {
        const runsPruneSummary = await runMaintenanceRunsAutoPrune("scheduled");
        logger.info({ runsPruneSummary }, "maintenance-scheduler: maintenance-runs auto-prune complete");
      } catch (err) {
        logger.error({ err }, "maintenance-scheduler: maintenance-runs auto-prune failed");
      }
    } catch (e: any) {
      logger.error({ err: e }, "maintenance-scheduler: tick error");
      try {
        await db.update(maintenanceScheduleTable)
          .set({ lastError: e?.message ?? String(e), updatedAt: new Date() })
          .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
      } catch { /* swallow — already logged */ }
    }
  }

  setTimeout(() => {
    void tick();
    setInterval(() => { void tick(); }, TICK_MS);
  }, STARTUP_DELAY_MS);
}

// Re-export for routes that want to enumerate tool keys.
export { MAINTENANCE_TOOL_KEYS };
