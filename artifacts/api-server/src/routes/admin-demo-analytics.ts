import { Router } from "express";
import { and, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import { centralDb, demoAnalyticsEventsTable, demoAnalyticsPoliciesTable, demoAnalyticsProfilesTable, demoAnalyticsSessionsTable } from "@workspace/db";
import { actionsUsed, getPolicy } from "../lib/demoAnalytics.js";

const router = Router();
const guard = (req: any, res: any, next: any) => req.authUser?.role === "superadmin" ? next() : res.status(req.authUser ? 403 : 401).json({ code: "SUPERADMIN_REQUIRED" });
router.use(guard);
router.get("/dashboard", async (_req, res) => {
  const now = new Date();
  const [row, sessions, interest, devices, prospects, modules, screens, actions] = await Promise.all([
    centralDb.select({ total: sql<number>`count(*)`, fresh: sql<number>`count(*) filter (where ${demoAnalyticsProfilesTable.createdAt} >= now() - interval '7 days')`, active: sql<number>`count(*) filter (where ${demoAnalyticsProfilesTable.updatedAt} >= now() - interval '7 days')`, usage: sql<number>`coalesce(sum(${demoAnalyticsProfilesTable.totalDurationMs}),0)` }).from(demoAnalyticsProfilesTable),
    centralDb.select({ today: sql<number>`count(*) filter (where ${demoAnalyticsSessionsTable.startedAt} >= now() - interval '1 day')`, week: sql<number>`count(*) filter (where ${demoAnalyticsSessionsTable.startedAt} >= now() - interval '7 days')`, month: sql<number>`count(*) filter (where ${demoAnalyticsSessionsTable.startedAt} >= now() - interval '30 days')`, average: sql<number>`coalesce(avg(${demoAnalyticsSessionsTable.durationMs}),0)` }).from(demoAnalyticsSessionsTable),
    centralDb.select({ key: demoAnalyticsProfilesTable.interestCategory, count: sql<number>`count(*)` }).from(demoAnalyticsProfilesTable).groupBy(demoAnalyticsProfilesTable.interestCategory),
    centralDb.select({ key: demoAnalyticsProfilesTable.device, count: sql<number>`count(*)` }).from(demoAnalyticsProfilesTable).groupBy(demoAnalyticsProfilesTable.device),
    centralDb.select().from(demoAnalyticsProfilesTable).orderBy(desc(demoAnalyticsProfilesTable.interestScore), desc(demoAnalyticsProfilesTable.updatedAt)).limit(20),
    centralDb.select({ key: demoAnalyticsEventsTable.moduleKey, count: sql<number>`count(*)`, durationMs: sql<number>`coalesce(sum(${demoAnalyticsEventsTable.durationMs}),0)` }).from(demoAnalyticsEventsTable).groupBy(demoAnalyticsEventsTable.moduleKey).orderBy(desc(sql`count(*)`)).limit(10),
    centralDb.select({ key: demoAnalyticsEventsTable.screenKey, count: sql<number>`count(*)`, durationMs: sql<number>`coalesce(sum(${demoAnalyticsEventsTable.durationMs}),0)` }).from(demoAnalyticsEventsTable).groupBy(demoAnalyticsEventsTable.screenKey).orderBy(desc(sql`count(*)`)).limit(10),
    centralDb.select({ key: demoAnalyticsEventsTable.actionKey, count: sql<number>`count(*)`, durationMs: sql<number>`coalesce(sum(${demoAnalyticsEventsTable.durationMs}),0)` }).from(demoAnalyticsEventsTable).groupBy(demoAnalyticsEventsTable.actionKey).orderBy(desc(sql`count(*)`)).limit(10),
  ]);
  return res.json({ totalProfiles: Number(row[0]?.total ?? 0), newProfiles: Number(row[0]?.fresh ?? 0), activeProfiles: Number(row[0]?.active ?? 0), loginCounts: sessions[0], totalUsageMs: Number(row[0]?.usage ?? 0), averageSessionMs: Number(sessions[0]?.average ?? 0), deviceDistribution: devices, interestDistribution: interest, rankedProspects: prospects, topModules: modules, topScreens: screens, topActions: actions, generatedAt: now });
});
router.get("/", async (req, res) => {
  const q: any = req.query; const conditions: any[] = [];
  if (q.phone) conditions.push(ilike(demoAnalyticsProfilesTable.phone, `%${String(q.phone).slice(0, 32)}%`));
  if (q.device) conditions.push(eq(demoAnalyticsProfilesTable.device, String(q.device)));
  if (q.interest) conditions.push(eq(demoAnalyticsProfilesTable.interestCategory, String(q.interest)));
  if (q.leadStatus) conditions.push(eq(demoAnalyticsProfilesTable.leadStatus, String(q.leadStatus)));
  if (q.source) conditions.push(eq(demoAnalyticsProfilesTable.sourceKind, String(q.source)));
  if (q.loginCount) {
    const loginCount = Number(q.loginCount);
    if (!Number.isFinite(loginCount) || loginCount < 0) return res.status(422).json({ code: "DEMO_FILTER_INVALID" });
    conditions.push(gte(demoAnalyticsProfilesTable.loginCount, loginCount));
  }
  if (q.duration) {
    const duration = Number(q.duration);
    if (!Number.isFinite(duration) || duration < 0) return res.status(422).json({ code: "DEMO_FILTER_INVALID" });
    conditions.push(gte(demoAnalyticsProfilesTable.totalDurationMs, duration));
  }
  if (q.from) {
    const from = new Date(String(q.from));
    if (Number.isNaN(from.getTime())) return res.status(422).json({ code: "DEMO_FILTER_INVALID" });
    conditions.push(gte(demoAnalyticsProfilesTable.createdAt, from));
  }
  if (q.to) {
    const to = new Date(String(q.to));
    if (Number.isNaN(to.getTime())) return res.status(422).json({ code: "DEMO_FILTER_INVALID" });
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.to))) to.setUTCDate(to.getUTCDate() + 1);
    conditions.push(lte(demoAnalyticsProfilesTable.createdAt, to));
  }
  if (q.module || q.screen) {
    const ids = await centralDb.selectDistinct({ profileId: demoAnalyticsEventsTable.profileId }).from(demoAnalyticsEventsTable)
      .where(and(q.module ? eq(demoAnalyticsEventsTable.moduleKey, String(q.module)) : undefined, q.screen ? eq(demoAnalyticsEventsTable.screenKey, String(q.screen)) : undefined));
    conditions.push(ids.length ? sql`${demoAnalyticsProfilesTable.id} IN (${sql.join(ids.map(x => sql`${x.profileId}`), sql`,`)})` : sql`false`);
  }
  return res.json(await centralDb.select().from(demoAnalyticsProfilesTable).where(and(...conditions)).orderBy(desc(demoAnalyticsProfilesTable.updatedAt)).limit(Math.min(200, Math.max(1, Number(q.limit) || 50))));
});
router.get("/:id", async (req, res) => {
  const id = Number(req.params.id); const [profile] = await centralDb.select().from(demoAnalyticsProfilesTable).where(eq(demoAnalyticsProfilesTable.id, id));
  if (!profile) return res.status(404).json({ code: "DEMO_PROFILE_NOT_FOUND" });
  const [sessions, events, policy, used] = await Promise.all([centralDb.select().from(demoAnalyticsSessionsTable).where(eq(demoAnalyticsSessionsTable.profileId, id)).orderBy(desc(demoAnalyticsSessionsTable.startedAt)), centralDb.select().from(demoAnalyticsEventsTable).where(eq(demoAnalyticsEventsTable.profileId, id)).orderBy(desc(demoAnalyticsEventsTable.occurredAt)).limit(500), getPolicy(id), actionsUsed(id)]);
  const effectiveLimit = policy.limitEnabled ? policy.actionLimit : null;
  return res.json({ profile, policy: { ...policy, actionLimit: effectiveLimit }, actionsUsed: used, remaining: effectiveLimit == null ? null : Math.max(0, effectiveLimit - used), sessions, events });
});
router.put("/:id/policy", async (req, res) => {
  const profileId = Number(req.params.id);
  if (!Number.isInteger(profileId) || profileId <= 0) return res.status(422).json({ code: "DEMO_POLICY_PROFILE_INVALID" });
  const [profile] = await centralDb.select({ id: demoAnalyticsProfilesTable.id }).from(demoAnalyticsProfilesTable).where(eq(demoAnalyticsProfilesTable.id, profileId));
  if (!profile) return res.status(404).json({ code: "DEMO_PROFILE_NOT_FOUND" });
  const existing = await getPolicy(profileId); const b = req.body ?? {}; const values: any = { profileId, updatedAt: new Date() };
  for (const k of ["enabled", "limitEnabled", "actionLimit", "warningRemaining", "subscriptionMessage"]) if (k in b) values[k] = b[k];
  if (("enabled" in values && typeof values.enabled !== "boolean") ||
      ("limitEnabled" in values && typeof values.limitEnabled !== "boolean") ||
      (values.limitEnabled === true && values.actionLimit == null) ||
      ("actionLimit" in values && values.actionLimit != null && (!Number.isInteger(values.actionLimit) || values.actionLimit < 1)) ||
      (values.warningRemaining != null && (!Number.isInteger(values.warningRemaining) || values.warningRemaining < 0 || ((values.actionLimit ?? existing.actionLimit) != null && values.warningRemaining > (values.actionLimit ?? existing.actionLimit)))) ||
      (values.subscriptionMessage != null && (typeof values.subscriptionMessage !== "string" || values.subscriptionMessage.length > 1000))) return res.status(422).json({ code: "DEMO_POLICY_INVALID" });
  const where = eq(demoAnalyticsPoliciesTable.profileId, profileId);
  const [old] = await centralDb.select().from(demoAnalyticsPoliciesTable).where(where);
  const [policy] = old ? await centralDb.update(demoAnalyticsPoliciesTable).set(values).where(eq(demoAnalyticsPoliciesTable.id, old.id)).returning() : await centralDb.insert(demoAnalyticsPoliciesTable).values(values).returning();
  return res.json(policy);
});
router.put("/:id/lead", async (req, res) => {
  const b = req.body ?? {}; const values: any = { updatedAt: new Date() };
  if (b.status != null && !["new", "contacted", "qualified", "converted", "lost"].includes(b.status)) return res.status(422).json({ code: "DEMO_LEAD_STATUS_INVALID" });
  if (b.notes != null && (typeof b.notes !== "string" || b.notes.length > 4000)) return res.status(422).json({ code: "DEMO_LEAD_NOTES_INVALID" });
  if (b.followUpAt != null && (Number.isNaN(new Date(b.followUpAt).getTime()))) return res.status(422).json({ code: "DEMO_FOLLOW_UP_INVALID" });
  for (const k of ["status", "notes", "followUpAt"]) if (k in b) values[k === "status" ? "leadStatus" : k === "notes" ? "leadNotes" : "followUpAt"] = k === "followUpAt" && b[k] ? new Date(b[k]) : b[k];
  const [profile] = await centralDb.update(demoAnalyticsProfilesTable).set(values).where(eq(demoAnalyticsProfilesTable.id, Number(req.params.id))).returning();
  if (!profile) return res.status(404).json({ code: "DEMO_PROFILE_NOT_FOUND" }); return res.json(profile);
});
export default router;