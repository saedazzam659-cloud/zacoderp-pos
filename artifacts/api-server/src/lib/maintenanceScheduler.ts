import { db } from "@workspace/db";
import { companiesTable, maintenanceRunsTable, maintenanceScheduleTable, usersTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { logger } from "./logger.js";
import { runAllChecks, MAINTENANCE_TOOL_KEYS, type ToolRunOutcome } from "./maintenanceChecks.js";
import { emailConfigured, sendMaintenanceCriticalDigest, type MaintenanceDigestRow } from "./email.js";

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
}

export async function runMaintenanceSweep(
  trigger: "scheduled" | "manual",
  opts: { publicBaseUrl?: string } = {},
): Promise<SweepSummary> {
  const companies = await db.select({ id: companiesTable.id })
    .from(companiesTable)
    .where(eq(companiesTable.status, "active"));
  let toolsRun = 0, criticalCount = 0, warnCount = 0, errorCount = 0, failedCompanies = 0;
  for (const c of companies) {
    try {
      const outcomes = await runAllChecks(c.id);
      await persistRunOutcomes(c.id, trigger, outcomes);
      toolsRun += outcomes.length;
      for (const o of outcomes) {
        if (o.status === "critical") criticalCount += 1;
        else if (o.status === "warn") warnCount += 1;
        else if (o.status === "error") errorCount += 1;
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
  // critical findings. We deliberately exclude `trigger === "manual"` here —
  // an admin clicking "Run now" gets immediate on-screen results and shouldn't
  // surprise other SuperAdmins with an alert email; the spec ties the digest
  // specifically to the scheduled sweep. The digest is best-effort and never
  // throws back into the sweep so runs still persist if SMTP/Outlook is down.
  // IMPORTANT: dispatch BEFORE the auto-unmute below so dispatchCriticalDigest's
  // snooze check sees the pre-sweep state. Otherwise an active snooze would be
  // silently overridden and the email would go out anyway, which contradicts
  // the "alerts not snoozed" requirement.
  if (criticalCount > 0 && trigger === "scheduled") {
    try {
      await dispatchCriticalDigest({ publicBaseUrl: opts.publicBaseUrl });
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
  return { companies: companies.length, toolsRun, criticalCount, warnCount, errorCount, failedCompanies };
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

// Stable hash of the current critical set, used to bypass the cooldown when
// a new critical (or a count change on an existing one) appears. Sorted so the
// hash is order-independent. Extracted (and exported) so the unit tests can
// pin the rate-limit decision deterministically.
export function computeCriticalSignature(
  rows: ReadonlyArray<{ companyId: number; toolKey: string; count: number }>,
): string {
  if (rows.length === 0) return "";
  const sorted = [...rows].sort((a, b) =>
    a.companyId - b.companyId || a.toolKey.localeCompare(b.toolKey)
  );
  const payload = sorted.map((r) => `${r.companyId}:${r.toolKey}:${r.count}`).join("|");
  return createHash("sha1").update(payload).digest("hex");
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

async function getSuperAdminRecipients(): Promise<string[]> {
  // notifyMaintenanceEmail = false is an explicit per-SuperAdmin opt-out
  // (set from their account settings). Users who flip it off are silently
  // excluded from the recipient list — same effect as having no email on file.
  const rows = await db.select({ email: usersTable.email })
    .from(usersTable)
    .where(and(
      eq(usersTable.role, "superadmin"),
      eq(usersTable.isActive, true),
      eq(usersTable.notifyMaintenanceEmail, true),
    ));
  // De-dupe + drop blanks; SuperAdmins without a configured email simply opt out.
  return Array.from(new Set(rows.map((r) => (r.email ?? "").trim()).filter((e) => e.length > 0)));
}

export async function dispatchCriticalDigest(
  opts: { publicBaseUrl?: string; isTest?: boolean } = {},
): Promise<EmailDispatchOutcome> {
  const cfg = await ensureMaintenanceScheduleRow();
  const muted = cfg.alertsMutedUntil && new Date(cfg.alertsMutedUntil).getTime() > Date.now();
  // Real (non-test) sends respect the snooze. Test sends bypass it intentionally.
  if (muted && !opts.isTest) {
    return recordEmailOutcome({ status: "snoozed", message: "alerts_snoozed", recipients: 0, rows: 0 });
  }

  // Cap rows so a stuck tenant can't generate a multi-megabyte email, but make
  // the cap generous (every tool × every active company would be well under
  // this in practice) and explicitly note truncation if it ever fires.
  const ROW_CAP = 500;
  const alerts = await getCriticalAlerts(ROW_CAP + 1);
  const truncated = alerts.length > ROW_CAP;
  const visibleAlerts = truncated ? alerts.slice(0, ROW_CAP) : alerts;
  // For test sends we still want to deliver something even if everything is OK
  // — the SuperAdmin only wants to verify their inbox actually receives the
  // template. We slot in a single placeholder row so the email isn't blank.
  let rows: MaintenanceDigestRow[];
  if (opts.isTest && visibleAlerts.length === 0) {
    rows = [{
      companyId: 0,
      companyName: "(لا توجد نتائج حرجة حالياً — هذه رسالة تجريبية)",
      toolKey: "test",
      toolLabelAr: "اختبار",
      count: 0,
      runAt: new Date(),
    }];
  } else if (visibleAlerts.length === 0) {
    return recordEmailOutcome({ status: "no_critical", message: "no_critical_findings", recipients: 0, rows: 0 });
  } else {
    rows = visibleAlerts.map((a) => ({
      companyId: a.companyId,
      companyName: a.companyName,
      toolKey: a.toolKey,
      toolLabelAr: toolLabelAr(a.toolKey),
      count: a.count,
      runAt: a.runAt,
    }));
  }

  // Cooldown / rate-limit gate. Skipped for test sends (admins explicitly want
  // to verify delivery) and when the test placeholder row is in play. Real
  // dispatches with an unchanged critical set inside the configured window are
  // suppressed and surfaced in the UI as "rate_limited" so operators see *why*
  // the email didn't go out.
  const signature = computeCriticalSignature(visibleAlerts);
  if (!opts.isTest) {
    const skip = shouldSkipForRateLimit(new Date(), {
      emailMinIntervalHours: cfg.emailMinIntervalHours ?? 24,
      lastSuccessfulEmailAt: cfg.lastSuccessfulEmailAt,
      lastEmailCriticalSignature: cfg.lastEmailCriticalSignature,
    }, signature);
    if (skip) {
      // Note: we deliberately do NOT update lastEmailCriticalSignature here —
      // we want subsequent ticks to keep comparing against the last *sent*
      // signature, not against the most recently-skipped one.
      return recordEmailOutcome({
        status: "rate_limited",
        message: `cooldown_active_${cfg.emailMinIntervalHours ?? 24}h`,
        recipients: 0, rows: rows.length,
      });
    }
  }

  const recipients = await getSuperAdminRecipients();
  if (recipients.length === 0) {
    return recordEmailOutcome({
      status: "no_recipients",
      message: "no_superadmin_email_configured",
      recipients: 0, rows: rows.length,
    });
  }
  if (!emailConfigured()) {
    return recordEmailOutcome({
      status: "no_transport",
      message: "email_transport_unconfigured",
      recipients: recipients.length, rows: rows.length,
    });
  }

  const sendRes = await sendMaintenanceCriticalDigest({
    to: recipients,
    rows,
    publicBaseUrl: resolvePublicBaseUrl(opts.publicBaseUrl),
    isTest: !!opts.isTest,
    truncated,
  });
  if (!sendRes.ok) {
    return recordEmailOutcome({
      status: "failed",
      message: sendRes.reason ?? "send_failed",
      recipients: recipients.length, rows: rows.length,
    });
  }
  // Persist the signature ONLY for real successful sends. Test sends keep the
  // existing signature so they don't accidentally arm the cooldown against
  // the next real dispatch (admins click "Send test email" precisely when
  // they've already received — or want to receive — the real one).
  return recordEmailOutcome(
    {
      status: "ok",
      message: opts.isTest ? "test_sent" : "digest_sent",
      recipients: recipients.length, rows: rows.length,
    },
    // Real "ok" sends advance both the cooldown anchor and the signature.
    // Test sends keep the existing anchor/signature so they don't accidentally
    // arm (or rearm) the cooldown against the next real dispatch.
    opts.isTest ? {} : { criticalSignature: signature, advanceCooldownAnchor: true },
  );
}

async function recordEmailOutcome(
  o: EmailDispatchOutcome,
  extras: { criticalSignature?: string; advanceCooldownAnchor?: boolean } = {},
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
    if (extras.criticalSignature !== undefined) {
      patch.lastEmailCriticalSignature = extras.criticalSignature;
    }
    if (extras.advanceCooldownAnchor) {
      patch.lastSuccessfulEmailAt = new Date();
    }
    await db.update(maintenanceScheduleTable).set(patch)
      .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
  } catch (err) {
    logger.error({ err }, "maintenance-scheduler: failed to record email outcome");
  }
  return o;
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
           l.run_at     AS "runAt"
      FROM latest l
      JOIN companies c ON c.id = l.company_id
     WHERE l.status = 'critical'
       AND c.status = 'active'
     ORDER BY l.run_at DESC
     LIMIT ${limit}
  `);
  return ((exec as any).rows ?? []) as CriticalAlertRow[];
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
