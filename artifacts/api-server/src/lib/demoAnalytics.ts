import { and, eq, isNull, sql } from "drizzle-orm";
import { centralDb, db, companiesTable, demoActionLedgerTable, demoActionReservationsTable, demoAnalyticsEventsTable, demoAnalyticsPoliciesTable, demoAnalyticsProfilesTable, demoAnalyticsSessionsTable, usersTable } from "@workspace/db";
import type { Request } from "express";

export type DemoIdentity = { sourceKind: "central" | "agent"; sourceInstanceId: number | null; localCompanyId: number; localUserId: number };

export type DemoViewerScope = Pick<DemoIdentity, "sourceKind" | "sourceInstanceId" | "localCompanyId">;

/** Tenant viewers are always scoped from trusted request context, never query input. */
export function demoViewerScopeFromRequest(req: Pick<Request, "authUser"> & { agentDomainHit?: { id?: number } | null }): DemoViewerScope | null {
  const companyId = Number(req.authUser?.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) return null;
  const agentId = Number(req.agentDomainHit?.id);
  if (Number.isInteger(agentId) && agentId > 0) {
    return { sourceKind: "agent", sourceInstanceId: agentId, localCompanyId: companyId };
  }
  return { sourceKind: "central", sourceInstanceId: null, localCompanyId: companyId };
}

/** Pure ownership predicate used by tests and any non-SQL consumers. */
export function demoProfileBelongsToViewerScope(
  profile: Pick<DemoIdentity, "sourceKind" | "sourceInstanceId" | "localCompanyId">,
  scope: DemoViewerScope,
): boolean {
  return profile.sourceKind === scope.sourceKind
    && profile.sourceInstanceId === scope.sourceInstanceId
    && profile.localCompanyId === scope.localCompanyId;
}
export const normalizePhone = (value: unknown): string | null => {
  const raw = String(value ?? "").trim().replace(/[^\d+]/g, "");
  const digits = raw.replace(/\D/g, "");
  if (!digits || digits.length < 8 || digits.length > 15) return null;
  // Saudi local forms (05xxxxxxxx / 5xxxxxxxx) get their stable E.164 prefix.
  if (digits.startsWith("05") && digits.length === 10) return `+966${digits.slice(1)}`;
  if (digits.startsWith("5") && digits.length === 9) return `+966${digits}`;
  if (digits.startsWith("00966")) return `+${digits.slice(2)}`;
  return `+${digits}`;
};
export const interestCategoryForScore = (score: number) => score >= 70 ? "strong_candidate" : score >= 50 ? "very_interested" : score >= 30 ? "interested" : score >= 10 ? "casual" : "new_visitor";

/** Validates flags in the request's LOCAL datasource; only telemetry lives centrally. */
export async function resolveDemoIdentity(req: Request): Promise<DemoIdentity | null> {
  const auth = req.authUser;
  if (!auth?.companyId || auth.id <= 0) return null;
  const [row] = await db.select({
    userId: usersTable.id, companyId: usersTable.companyId, shadow: usersTable.isDemoShadow,
    isolation: usersTable.demoDeviceIsolation, workspace: companiesTable.isInternalDemoWorkspace,
  }).from(usersTable).innerJoin(companiesTable, eq(companiesTable.id, usersTable.companyId))
    .where(and(eq(usersTable.id, auth.id), eq(usersTable.companyId, auth.companyId))).limit(1);
  if (!row || !(row.shadow || row.isolation || row.workspace)) return null;
  const hit = (req as any).agentDomainHit;
  return { sourceKind: hit?.id ? "agent" : "central", sourceInstanceId: hit?.id ?? null, localCompanyId: row.companyId!, localUserId: row.userId };
}

export async function getProfile(identity: DemoIdentity, create = true) {
  const where = and(eq(demoAnalyticsProfilesTable.sourceKind, identity.sourceKind),
    identity.sourceInstanceId == null ? isNull(demoAnalyticsProfilesTable.sourceInstanceId) : eq(demoAnalyticsProfilesTable.sourceInstanceId, identity.sourceInstanceId),
    eq(demoAnalyticsProfilesTable.localCompanyId, identity.localCompanyId), eq(demoAnalyticsProfilesTable.localUserId, identity.localUserId));
  let [profile] = await centralDb.select().from(demoAnalyticsProfilesTable).where(where).limit(1);
  if (!profile && create) {
    // The unique index protects agent/central identity; retry read handles a concurrent first request.
    await centralDb.insert(demoAnalyticsProfilesTable).values(identity).onConflictDoNothing();
    [profile] = await centralDb.select().from(demoAnalyticsProfilesTable).where(where).limit(1);
  }
  return profile ?? null;
}

export async function bindDemoProfilePhone(identity: DemoIdentity, phone: string) {
  const profile = await getProfile(identity);
  if (!profile) throw new Error("Demo analytics profile could not be created");
  if (profile.phone !== phone) {
    await centralDb.update(demoAnalyticsProfilesTable)
      .set({ phone, updatedAt: new Date() })
      .where(eq(demoAnalyticsProfilesTable.id, profile.id));
  }
  return profile.id;
}

export async function getPolicy(profileId: number) {
  let [policy] = await centralDb.select().from(demoAnalyticsPoliciesTable).where(eq(demoAnalyticsPoliciesTable.profileId, profileId)).limit(1);
  if (!policy) {
    await centralDb.insert(demoAnalyticsPoliciesTable).values({ profileId }).onConflictDoNothing();
    [policy] = await centralDb.select().from(demoAnalyticsPoliciesTable).where(eq(demoAnalyticsPoliciesTable.profileId, profileId)).limit(1);
  }
  return policy!;
}

export async function refreshInterest(profileId: number) {
  const [aggregate] = await centralDb.select({
    modules: sql<number>`count(distinct ${demoAnalyticsEventsTable.moduleKey})`,
    actions: sql<number>`count(*) filter (where ${demoAnalyticsEventsTable.actionKey} is not null)`,
  }).from(demoAnalyticsEventsTable).where(eq(demoAnalyticsEventsTable.profileId, profileId));
  const [profile] = await centralDb.select().from(demoAnalyticsProfilesTable).where(eq(demoAnalyticsProfilesTable.id, profileId));
  if (!profile) return;
  // Score: logins (20), active minutes (25), modules (25), actions (30).
  // Stable funnel: new_visitor <10, casual <30, interested <50,
  // very_interested <70, strong_candidate >=70.
  const score = Math.min(20, profile.loginCount * 4) + Math.min(25, Math.floor(profile.totalDurationMs / 60_000)) +
    Math.min(25, Number(aggregate?.modules ?? 0) * 5) + Math.min(30, Number(aggregate?.actions ?? 0) * 3);
  const interestCategory = interestCategoryForScore(score);
  await centralDb.update(demoAnalyticsProfilesTable).set({ interestScore: score, interestCategory, updatedAt: new Date() }).where(eq(demoAnalyticsProfilesTable.id, profileId));
}

export async function actionsUsed(profileId: number) {
  const [r] = await centralDb.select({ count: sql<number>`count(*)` }).from(demoActionLedgerTable).where(eq(demoActionLedgerTable.profileId, profileId));
  return Number(r?.count ?? 0);
}

export async function recordEvents(profileId: number, events: Array<any>) {
  let accepted = 0;
  for (const event of events) {
    const inserted = await centralDb.insert(demoAnalyticsEventsTable).values({ profileId, ...event })
      .onConflictDoNothing().returning({ id: demoAnalyticsEventsTable.id });
    accepted += inserted.length;
  }
  if (accepted) await refreshInterest(profileId);
  return accepted;
}

export async function reserveDemoAction(profileId: number, route: string, key: string) {
  return centralDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM demo_analytics_profiles WHERE id = ${profileId} FOR UPDATE`);
    const [policy] = await tx.select().from(demoAnalyticsPoliciesTable)
      .where(eq(demoAnalyticsPoliciesTable.profileId, profileId)).limit(1);
    const p = policy ?? { enabled: true, limitEnabled: false, actionLimit: null, warningRemaining: 5, subscriptionMessage: null };
    if (!p.enabled) return { ok: false as const, code: "DEMO_DISABLED", status: 402, policy: p };
    const [existing] = await tx.select().from(demoActionReservationsTable).where(and(eq(demoActionReservationsTable.profileId, profileId), eq(demoActionReservationsTable.idempotencyKey, key))).limit(1);
    if (existing && existing.route !== route) return { ok: false as const, code: "DEMO_IDEMPOTENCY_ROUTE_MISMATCH", status: 409, policy: p };
    if (existing) return { ok: true as const, reservationId: existing.id, replay: true, policy: p };
    await tx.delete(demoActionReservationsTable).where(and(eq(demoActionReservationsTable.profileId, profileId), eq(demoActionReservationsTable.status, "reserved"), sql`${demoActionReservationsTable.createdAt} < now() - interval '15 minutes'`));
    const [count] = await tx.select({ count: sql<number>`count(*)` }).from(demoActionReservationsTable)
      .where(and(eq(demoActionReservationsTable.profileId, profileId), sql`${demoActionReservationsTable.status} IN ('reserved','success')`));
    if (p.limitEnabled && p.actionLimit != null && Number(count?.count ?? 0) >= p.actionLimit) {
      return { ok: false as const, code: "DEMO_ACTION_LIMIT_EXHAUSTED", status: 429, policy: p };
    }
    const [reservation] = await tx.insert(demoActionReservationsTable).values({ profileId, route, idempotencyKey: key }).returning({ id: demoActionReservationsTable.id });
    return { ok: true as const, reservationId: reservation.id, replay: false, policy: p };
  });
}

export async function finalizeDemoAction(reservationId: number, success: boolean, route: string) {
  if (!success) { await centralDb.delete(demoActionReservationsTable).where(eq(demoActionReservationsTable.id, reservationId)); return; }
  await centralDb.transaction(async tx => {
    const [r] = await tx.select().from(demoActionReservationsTable).where(eq(demoActionReservationsTable.id, reservationId)).limit(1);
    if (!r || r.status === "success") return;
    await tx.insert(demoActionLedgerTable).values({ reservationId, profileId: r.profileId, actionKey: route }).onConflictDoNothing();
    await tx.insert(demoAnalyticsEventsTable).values({ profileId: r.profileId, eventId: `server-action-${reservationId}`, type: "action", actionKey: route, route, occurredAt: new Date() }).onConflictDoNothing();
    await tx.update(demoActionReservationsTable).set({ status: "success", finalizedAt: new Date() }).where(eq(demoActionReservationsTable.id, reservationId));
  });
  await refreshInterest((await centralDb.select({ profileId: demoActionReservationsTable.profileId }).from(demoActionReservationsTable).where(eq(demoActionReservationsTable.id, reservationId)).limit(1))[0]?.profileId ?? 0);
}