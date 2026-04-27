// Evaluates per-company `security_notification_rules` when a new
// security event is created and writes matching rows into the
// existing `notifications` table. Best-effort: any failure is logged
// and swallowed so it never breaks the create-event request.
//
// Designed to be called AFTER the security_events row is inserted,
// from `POST /api/security-events` and any other code path that
// inserts a security_events row through the API server.
import { db } from "@workspace/db";
import {
  notificationsTable,
  securityNotificationRulesTable,
  usersTable,
  branchesTable,
  type SecurityNotificationRule,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

// Severity rank table — single source of truth for "≥ minSeverity"
// comparisons. security_events uses low/medium/high/critical;
// notifications.severity supports info/low/medium/high (no
// "critical" tier) so we map critical → high when WRITING the
// notification but keep the full 4-tier scale for matching.
const SEV_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
const NOTIF_SEV_FROM_EVENT: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  critical: "high",
};

export interface SecurityEventForNotify {
  id: number;
  eventType: string;
  severity: string;          // low | medium | high | critical
  title: string;
  branchId: number | null;
  cameraLabel: string | null;
}

// Public entry point. `cid` MUST be the authenticated company id of
// the request that just inserted `event` — never accept it from the
// request body. Returns silently on any error.
export async function runSecurityNotificationRules(
  cid: number,
  event: SecurityEventForNotify,
  actingUserId: number | null,
): Promise<void> {
  try {
    // 1. Load active rules (auto-seed a default if none exist yet so
    //    the first event a company ever logs still notifies someone).
    let rules = await db.select()
      .from(securityNotificationRulesTable)
      .where(and(
        eq(securityNotificationRulesTable.companyId, cid),
        eq(securityNotificationRulesTable.isActive, true),
      ));

    if (rules.length === 0) {
      // Check if the company has ANY rules (active or not) before
      // seeding — admins may have intentionally disabled everything.
      const [anyRule] = await db.select({ id: securityNotificationRulesTable.id })
        .from(securityNotificationRulesTable)
        .where(eq(securityNotificationRulesTable.companyId, cid))
        .limit(1);
      if (!anyRule) {
        const [seeded] = await db.insert(securityNotificationRulesTable).values({
          companyId: cid,
          name: "تنبيه افتراضي للأحداث المتوسطة فأعلى",
          isActive: true,
          minSeverity: "medium",
          eventTypes: [],
          branchIds: [],
          targetMode: "broadcast",
          targetUserIds: [],
          createdByUserId: actingUserId,
        }).returning();
        if (seeded) rules = [seeded];
      }
    }
    if (rules.length === 0) return;

    // 2. Filter rules that actually match this event.
    const eventRank = SEV_RANK[event.severity] ?? 0;
    const matched: SecurityNotificationRule[] = [];
    for (const r of rules) {
      const minRank = SEV_RANK[r.minSeverity] ?? 99;
      if (eventRank < minRank) continue;
      if (Array.isArray(r.eventTypes) && r.eventTypes.length > 0
          && !r.eventTypes.includes(event.eventType)) continue;
      if (Array.isArray(r.branchIds) && r.branchIds.length > 0) {
        if (event.branchId == null) continue;
        if (!r.branchIds.includes(event.branchId)) continue;
      }
      matched.push(r);
    }
    if (matched.length === 0) return;

    // 3. Resolve branch label once (for nicer body text). Branches use
    //    Arabic-first nameAr (NOT NULL) with optional nameEn fallback.
    let branchLabel: string | null = null;
    if (event.branchId != null) {
      const [b] = await db.select({
          nameAr: branchesTable.nameAr,
          nameEn: branchesTable.nameEn,
        })
        .from(branchesTable)
        .where(and(eq(branchesTable.id, event.branchId), eq(branchesTable.companyId, cid)))
        .limit(1);
      branchLabel = b ? (b.nameAr || b.nameEn || null) : null;
    }

    // 4. Build the notification body once and emit per-rule.
    for (const r of matched) {
      const notifSev = NOTIF_SEV_FROM_EVENT[event.severity] ?? "info";
      const title = `${r.name} — ${event.title}`.slice(0, 280);
      const body = buildNotificationBody({
        eventId: event.id,
        eventType: event.eventType,
        severity: event.severity,
        branchLabel,
        cameraLabel: event.cameraLabel,
      });

      if (r.targetMode === "users") {
        // Re-validate user ids belong to the company at write time;
        // silently skip anyone who has been removed/transferred
        // since the rule was authored.
        const ids = Array.isArray(r.targetUserIds)
          ? r.targetUserIds.filter((x) => Number.isInteger(x) && x > 0)
          : [];
        if (ids.length === 0) continue;
        const validUsers = await db.select({ id: usersTable.id })
          .from(usersTable)
          .where(and(eq(usersTable.companyId, cid), inArray(usersTable.id, ids)));
        const validIds = validUsers.map((u) => u.id);
        if (validIds.length === 0) continue;
        await db.insert(notificationsTable).values(validIds.map((uid) => ({
          companyId: cid,
          userId: uid,
          title,
          body,
          severity: notifSev,
          category: "security_event",
          sourceKey: `security_event:${event.id}`,
          createdByUserId: actingUserId,
        })));
      } else {
        // broadcast — userId NULL means "every user in the company".
        await db.insert(notificationsTable).values({
          companyId: cid,
          userId: null,
          title,
          body,
          severity: notifSev,
          category: "security_event",
          sourceKey: `security_event:${event.id}`,
          createdByUserId: actingUserId,
        });
      }
    }
  } catch (e) {
    console.warn("security: notification rule evaluation failed:", e);
  }
}

function buildNotificationBody(p: {
  eventId: number;
  eventType: string;
  severity: string;
  branchLabel: string | null;
  cameraLabel: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`**الخطورة:** ${p.severity}`);
  lines.push(`**النوع:** ${p.eventType}`);
  if (p.branchLabel) lines.push(`**الفرع:** ${p.branchLabel}`);
  if (p.cameraLabel) lines.push(`**الكاميرا:** ${p.cameraLabel}`);
  lines.push("");
  lines.push(`[فتح الحدث](/security/events?focus=${p.eventId})`);
  return lines.join("\n");
}
