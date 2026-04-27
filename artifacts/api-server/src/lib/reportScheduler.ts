import { db } from "@workspace/db";
import { reportEmailSchedulesTable, reportEmailScheduleRunsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";
import { produceDigestArtifacts, AVAILABLE_REPORTS } from "./reportDigest.js";
import { sendReportsDigest, emailConfigured } from "./email.js";

// Singleton config row id. We use a fixed primary-key=1 so updates are simple
// upserts and the system never needs to "pick" between schedules.
export const REPORT_SCHEDULE_ID = 1;

const WEEK_MS  = 7 * 86_400_000;
const MONTH_MS = 30 * 86_400_000;          // approx; "monthly" cadence — close enough for digests
const TICK_MS  = 15 * 60_000;              // poll every 15 min, mirrors backup scheduler
const STARTUP_DELAY_MS = 30_000;

export async function ensureScheduleRow() {
  const [existing] = await db.select().from(reportEmailSchedulesTable)
    .where(eq(reportEmailSchedulesTable.id, REPORT_SCHEDULE_ID));
  if (existing) return existing;
  const [created] = await db.insert(reportEmailSchedulesTable).values({
    id: REPORT_SCHEDULE_ID,
    enabled: false,
    reports: [],
    frequency: "weekly",
    recipients: [],
  }).returning();
  return created;
}

// Exported so tests can pin the "is it due?" gate directly. The function is
// pure (Date-comparing only) so a regression in the interval math or the
// null-handling shows up immediately without booting the scheduler.
export function isDue(lastSentAt: Date | null, frequency: string): boolean {
  if (!lastSentAt) return true;
  const interval = frequency === "monthly" ? MONTH_MS : WEEK_MS;
  return Date.now() - lastSentAt.getTime() >= interval;
}

export interface RunOutcome {
  status: "ok" | "failed" | "no_data" | "skipped";
  message: string;
  reports: string[];
  recipients: number;
}

// Single execution path used by both the scheduler tick and the manual
// "send now" endpoint, so behaviour stays identical regardless of trigger.
export async function runReportDigest(trigger: "scheduled" | "manual"): Promise<RunOutcome> {
  const cfg = await ensureScheduleRow();
  if (trigger === "scheduled" && !cfg.enabled) {
    return recordRun(trigger, "skipped", "الجدولة معطّلة", [], 0);
  }

  const reports = Array.isArray(cfg.reports) ? cfg.reports : [];
  const recipients = Array.isArray(cfg.recipients) ? cfg.recipients : [];
  if (reports.length === 0) {
    return recordRun(trigger, "skipped", "لا توجد تقارير محددة", reports, recipients.length);
  }
  if (recipients.length === 0) {
    return recordRun(trigger, "skipped", "لا يوجد مستلمون", reports, 0);
  }
  if (!emailConfigured()) {
    const msg = "إعدادات SMTP غير مهيأة على الخادم";
    await markLast(cfg.id, "failed", msg, reports, recipients.length);
    return recordRun(trigger, "failed", msg, reports, recipients.length);
  }

  const frequency: "weekly" | "monthly" = cfg.frequency === "monthly" ? "monthly" : "weekly";
  const labelMap = new Map<string, string>(AVAILABLE_REPORTS.map(r => [r.key, r.labelAr]));

  let attachments;
  try {
    const arts = await produceDigestArtifacts(reports, frequency);
    attachments = arts.map(a => ({ filename: a.filename, content: a.csv, contentType: "text/csv; charset=utf-8" }));
    if (attachments.length === 0) {
      const msg = "لم تُنتج التقارير أي ملفات";
      await markLast(cfg.id, "no_data", msg, reports, recipients.length);
      return recordRun(trigger, "no_data", msg, reports, recipients.length);
    }
  } catch (err: any) {
    const msg = `فشل توليد التقارير: ${err?.message ?? err}`;
    logger.error({ err }, "report-digest: failed to build CSVs");
    await markLast(cfg.id, "failed", msg, reports, recipients.length);
    return recordRun(trigger, "failed", msg, reports, recipients.length);
  }

  const sendRes = await sendReportsDigest({
    to: recipients,
    frequency,
    attachments,
    reportLabels: reports.map((k: string) => labelMap.get(k) ?? k),
  });
  if (!sendRes.ok) {
    const msg = `تعذّر إرسال البريد: ${sendRes.reason ?? "غير معروف"}`;
    await markLast(cfg.id, "failed", msg, reports, recipients.length);
    return recordRun(trigger, "failed", msg, reports, recipients.length);
  }

  await db.update(reportEmailSchedulesTable).set({
    lastSentAt: new Date(),
    lastStatus: "ok",
    lastError: null,
    lastReports: reports,
    lastRecipients: recipients.length,
    updatedAt: new Date(),
  }).where(eq(reportEmailSchedulesTable.id, cfg.id));

  return recordRun(
    trigger,
    "ok",
    `تم الإرسال إلى ${recipients.length} مستلمًا`,
    reports,
    recipients.length,
  );
}

async function markLast(id: number, status: string, message: string, reports: string[], recipientsN: number) {
  await db.update(reportEmailSchedulesTable).set({
    lastStatus: status,
    lastError: status === "ok" ? null : message,
    lastReports: reports,
    lastRecipients: recipientsN,
    updatedAt: new Date(),
  }).where(eq(reportEmailSchedulesTable.id, id));
}

async function recordRun(
  trigger: "scheduled" | "manual",
  status: RunOutcome["status"],
  message: string,
  reports: string[],
  recipients: number,
): Promise<RunOutcome> {
  try {
    await db.insert(reportEmailScheduleRunsTable).values({
      trigger, status, message, reports, recipients,
    });
  } catch (err) {
    logger.error({ err }, "report-digest: failed to record run history");
  }
  return { status, message, reports, recipients };
}

// Exported so tests can drive a single tick deterministically without
// booting the timers in startReportDigestScheduler. Production behaviour is
// unchanged — startReportDigestScheduler still owns the polling loop and
// just delegates each tick here.
export async function tickReportDigestScheduler(): Promise<void> {
  try {
    const cfg = await ensureScheduleRow();
    if (!cfg.enabled) return;
    if (!isDue(cfg.lastSentAt, cfg.frequency)) return;
    const outcome = await runReportDigest("scheduled");
    logger.info({ outcome }, "report-digest: scheduled tick complete");
  } catch (err) {
    logger.error({ err }, "report-digest: scheduler tick error");
  }
}

let started = false;
export function startReportDigestScheduler() {
  if (started) return;
  started = true;

  setTimeout(() => {
    void tickReportDigestScheduler();
    setInterval(() => { void tickReportDigestScheduler(); }, TICK_MS);
  }, STARTUP_DELAY_MS);
}
