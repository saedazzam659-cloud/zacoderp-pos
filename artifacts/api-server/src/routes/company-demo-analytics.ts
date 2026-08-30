import { Router, type Request, type Response } from "express";
import { and, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  centralDb,
  companiesTable,
  db,
  demoAnalyticsEventsTable,
  demoAnalyticsPoliciesTable,
  demoAnalyticsProfilesTable,
  demoAnalyticsSessionsTable,
} from "@workspace/db";
import { requirePermission } from "../middleware/permissions.js";
import {
  actionsUsed,
  canViewCompanyDemoAnalytics,
  demoViewerScopeFromRequest,
  type DemoViewerScope,
} from "../lib/demoAnalytics.js";

const router = Router();

router.use(requirePermission("demo_analytics", "view"));
router.use((req, res, next) => {
  // Company monitoring is intentionally a manager-only screen. A regular
  // user — including the demo user being observed — is rejected even if an
  // accidental per-user RBAC grant exists.
  if (!canViewCompanyDemoAnalytics((req as any).authUser)) {
    res.status(403).json({ code: "DEMO_ANALYTICS_MANAGER_REQUIRED" });
    return;
  }
  next();
});

function scopeCondition(scope: DemoViewerScope, ownedCompanyIds: readonly number[]) {
  return and(
    eq(demoAnalyticsProfilesTable.sourceKind, scope.sourceKind),
    scope.sourceInstanceId == null
      ? isNull(demoAnalyticsProfilesTable.sourceInstanceId)
      : eq(demoAnalyticsProfilesTable.sourceInstanceId, scope.sourceInstanceId),
    inArray(demoAnalyticsProfilesTable.localCompanyId, [...ownedCompanyIds]),
  );
}

async function requireViewerScope(
  req: Request,
  res: Response,
): Promise<{ scope: DemoViewerScope; ownedCompanyIds: number[] } | null> {
  const scope = demoViewerScopeFromRequest(req as any);
  if (!scope) {
    res.status(403).json({ code: "DEMO_ANALYTICS_COMPANY_REQUIRED" });
    return null;
  }
  // Isolated demo logins run inside a hidden cloned company. The manager of
  // the source company owns visibility of those child workspaces, but never
  // of another company's demo workspaces. Resolve this relationship from the
  // trusted local datasource rather than accepting company IDs from the UI.
  const rows = await db.select({ id: companiesTable.id })
    .from(companiesTable)
    .where(or(
      eq(companiesTable.id, scope.localCompanyId),
      and(
        eq(companiesTable.isInternalDemoWorkspace, true),
        eq(companiesTable.demoParentCompanyId, scope.localCompanyId),
      ),
    ));
  const ownedCompanyIds = rows.map((row) => row.id);
  if (!ownedCompanyIds.includes(scope.localCompanyId)) {
    ownedCompanyIds.unshift(scope.localCompanyId);
  }
  return { scope, ownedCompanyIds };
}

router.get("/dashboard", async (req, res): Promise<void> => {
  const viewer = await requireViewerScope(req, res);
  if (!viewer) return;
  const owned = scopeCondition(viewer.scope, viewer.ownedCompanyIds);
  const now = new Date();
  const [row, sessions, interest, devices, prospects, modules, screens, actions] = await Promise.all([
    centralDb.select({
      total: sql<number>`count(*)`,
      fresh: sql<number>`count(*) filter (where ${demoAnalyticsProfilesTable.createdAt} >= now() - interval '7 days')`,
      active: sql<number>`count(*) filter (where ${demoAnalyticsProfilesTable.updatedAt} >= now() - interval '7 days')`,
      usage: sql<number>`coalesce(sum(${demoAnalyticsProfilesTable.totalDurationMs}),0)`,
    }).from(demoAnalyticsProfilesTable).where(owned),
    centralDb.select({
      today: sql<number>`count(*) filter (where ${demoAnalyticsSessionsTable.startedAt} >= now() - interval '1 day')`,
      week: sql<number>`count(*) filter (where ${demoAnalyticsSessionsTable.startedAt} >= now() - interval '7 days')`,
      month: sql<number>`count(*) filter (where ${demoAnalyticsSessionsTable.startedAt} >= now() - interval '30 days')`,
      average: sql<number>`coalesce(avg(${demoAnalyticsSessionsTable.durationMs}),0)`,
    }).from(demoAnalyticsSessionsTable)
      .innerJoin(demoAnalyticsProfilesTable, eq(demoAnalyticsProfilesTable.id, demoAnalyticsSessionsTable.profileId))
      .where(owned),
    centralDb.select({
      key: demoAnalyticsProfilesTable.interestCategory,
      count: sql<number>`count(*)`,
    }).from(demoAnalyticsProfilesTable).where(owned).groupBy(demoAnalyticsProfilesTable.interestCategory),
    centralDb.select({
      key: demoAnalyticsProfilesTable.device,
      count: sql<number>`count(*)`,
    }).from(demoAnalyticsProfilesTable).where(owned).groupBy(demoAnalyticsProfilesTable.device),
    centralDb.select().from(demoAnalyticsProfilesTable)
      .where(owned)
      .orderBy(desc(demoAnalyticsProfilesTable.interestScore), desc(demoAnalyticsProfilesTable.updatedAt))
      .limit(20),
    centralDb.select({
      key: demoAnalyticsEventsTable.moduleKey,
      count: sql<number>`count(*)`,
      durationMs: sql<number>`coalesce(sum(${demoAnalyticsEventsTable.durationMs}),0)`,
    }).from(demoAnalyticsEventsTable)
      .innerJoin(demoAnalyticsProfilesTable, eq(demoAnalyticsProfilesTable.id, demoAnalyticsEventsTable.profileId))
      .where(owned)
      .groupBy(demoAnalyticsEventsTable.moduleKey)
      .orderBy(desc(sql`count(*)`)).limit(10),
    centralDb.select({
      key: demoAnalyticsEventsTable.screenKey,
      count: sql<number>`count(*)`,
      durationMs: sql<number>`coalesce(sum(${demoAnalyticsEventsTable.durationMs}),0)`,
    }).from(demoAnalyticsEventsTable)
      .innerJoin(demoAnalyticsProfilesTable, eq(demoAnalyticsProfilesTable.id, demoAnalyticsEventsTable.profileId))
      .where(owned)
      .groupBy(demoAnalyticsEventsTable.screenKey)
      .orderBy(desc(sql`count(*)`)).limit(10),
    centralDb.select({
      key: demoAnalyticsEventsTable.actionKey,
      count: sql<number>`count(*)`,
      durationMs: sql<number>`coalesce(sum(${demoAnalyticsEventsTable.durationMs}),0)`,
    }).from(demoAnalyticsEventsTable)
      .innerJoin(demoAnalyticsProfilesTable, eq(demoAnalyticsProfilesTable.id, demoAnalyticsEventsTable.profileId))
      .where(owned)
      .groupBy(demoAnalyticsEventsTable.actionKey)
      .orderBy(desc(sql`count(*)`)).limit(10),
  ]);
  res.json({
    totalProfiles: Number(row[0]?.total ?? 0),
    newProfiles: Number(row[0]?.fresh ?? 0),
    activeProfiles: Number(row[0]?.active ?? 0),
    loginCounts: sessions[0],
    totalUsageMs: Number(row[0]?.usage ?? 0),
    averageSessionMs: Number(sessions[0]?.average ?? 0),
    deviceDistribution: devices,
    interestDistribution: interest,
    rankedProspects: prospects,
    topModules: modules,
    topScreens: screens,
    topActions: actions,
    generatedAt: now,
  });
});

router.get("/", async (req, res): Promise<void> => {
  const viewer = await requireViewerScope(req, res);
  if (!viewer) return;
  const q: any = req.query;
  const conditions: any[] = [scopeCondition(viewer.scope, viewer.ownedCompanyIds)];
  if (q.phone) conditions.push(ilike(demoAnalyticsProfilesTable.phone, `%${String(q.phone).slice(0, 32)}%`));
  if (q.device) conditions.push(eq(demoAnalyticsProfilesTable.device, String(q.device)));
  if (q.interest) conditions.push(eq(demoAnalyticsProfilesTable.interestCategory, String(q.interest)));
  if (q.leadStatus) conditions.push(eq(demoAnalyticsProfilesTable.leadStatus, String(q.leadStatus)));
  if (q.loginCount) {
    const loginCount = Number(q.loginCount);
    if (!Number.isFinite(loginCount) || loginCount < 0) {
      res.status(422).json({ code: "DEMO_FILTER_INVALID" });
      return;
    }
    conditions.push(gte(demoAnalyticsProfilesTable.loginCount, loginCount));
  }
  if (q.duration) {
    const duration = Number(q.duration);
    if (!Number.isFinite(duration) || duration < 0) {
      res.status(422).json({ code: "DEMO_FILTER_INVALID" });
      return;
    }
    conditions.push(gte(demoAnalyticsProfilesTable.totalDurationMs, duration));
  }
  if (q.from) {
    const from = new Date(String(q.from));
    if (Number.isNaN(from.getTime())) {
      res.status(422).json({ code: "DEMO_FILTER_INVALID" });
      return;
    }
    conditions.push(gte(demoAnalyticsProfilesTable.createdAt, from));
  }
  if (q.to) {
    const to = new Date(String(q.to));
    if (Number.isNaN(to.getTime())) {
      res.status(422).json({ code: "DEMO_FILTER_INVALID" });
      return;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.to))) to.setUTCDate(to.getUTCDate() + 1);
    conditions.push(lte(demoAnalyticsProfilesTable.createdAt, to));
  }
  if (q.module || q.screen) {
    const ids = await centralDb.selectDistinct({ profileId: demoAnalyticsEventsTable.profileId })
      .from(demoAnalyticsEventsTable)
      .innerJoin(demoAnalyticsProfilesTable, eq(demoAnalyticsProfilesTable.id, demoAnalyticsEventsTable.profileId))
      .where(and(
        scopeCondition(viewer.scope, viewer.ownedCompanyIds),
        q.module ? eq(demoAnalyticsEventsTable.moduleKey, String(q.module)) : undefined,
        q.screen ? eq(demoAnalyticsEventsTable.screenKey, String(q.screen)) : undefined,
      ));
    conditions.push(ids.length
      ? sql`${demoAnalyticsProfilesTable.id} IN (${sql.join(ids.map(x => sql`${x.profileId}`), sql`,`)})`
      : sql`false`);
  }
  const profiles = await centralDb.select().from(demoAnalyticsProfilesTable)
    .where(and(...conditions))
    .orderBy(desc(demoAnalyticsProfilesTable.updatedAt))
    .limit(Math.min(200, Math.max(1, Number(q.limit) || 50)));
  res.json(profiles);
});

router.get("/:id", async (req, res): Promise<void> => {
  const viewer = await requireViewerScope(req, res);
  if (!viewer) return;
  const id = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ code: "DEMO_PROFILE_NOT_FOUND" });
    return;
  }
  const [profile] = await centralDb.select().from(demoAnalyticsProfilesTable)
    .where(and(
      eq(demoAnalyticsProfilesTable.id, id),
      scopeCondition(viewer.scope, viewer.ownedCompanyIds),
    ))
    .limit(1);
  if (!profile) {
    // Deliberately return the same 404 for absent and cross-company IDs.
    res.status(404).json({ code: "DEMO_PROFILE_NOT_FOUND" });
    return;
  }
  const [sessions, events, storedPolicy, used] = await Promise.all([
    centralDb.select().from(demoAnalyticsSessionsTable)
      .where(eq(demoAnalyticsSessionsTable.profileId, id))
      .orderBy(desc(demoAnalyticsSessionsTable.startedAt)),
    centralDb.select().from(demoAnalyticsEventsTable)
      .where(eq(demoAnalyticsEventsTable.profileId, id))
      .orderBy(desc(demoAnalyticsEventsTable.occurredAt)).limit(500),
    centralDb.select().from(demoAnalyticsPoliciesTable)
      .where(eq(demoAnalyticsPoliciesTable.profileId, id)).limit(1),
    actionsUsed(id),
  ]);
  const policy = storedPolicy[0] ?? {
    enabled: true,
    limitEnabled: false,
    actionLimit: null,
    warningRemaining: 5,
    subscriptionMessage: null,
  };
  const effectiveLimit = policy.limitEnabled ? policy.actionLimit : null;
  res.json({
    profile,
    policy: { ...policy, actionLimit: effectiveLimit },
    actionsUsed: used,
    remaining: effectiveLimit == null ? null : Math.max(0, effectiveLimit - used),
    sessions,
    events,
  });
});

export default router;