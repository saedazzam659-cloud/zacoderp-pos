import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { centralDb, demoAgentBatchReceiptsTable, demoAnalyticsEventsTable, demoAnalyticsProfilesTable, demoAnalyticsSessionsTable } from "@workspace/db";
import { actionsUsed, finalizeDemoAction, getPolicy, getProfile, normalizePhone, recordEvents, refreshInterest, reserveDemoAction, resolveDemoIdentity } from "../lib/demoAnalytics.js";

const router = Router();
const eventKeys = new Set(["eventId", "type", "moduleKey", "screenKey", "actionKey", "route", "durationMs", "occurredAt"]);
const safeEventTypes = new Set(["screen_view", "module_view", "action"]);
const safeRouteSegments = new Set([
  "admin", "demo-analytics", "dashboard", "home", "sales", "purchasing", "inventory",
  "accounting", "cash", "bank", "reports", "report", "invoices", "invoice", "returns",
  "orders", "quotations", "customers", "suppliers", "items", "warehouses", "stock",
  "journal-entries", "accounts", "statements", "settings", "general", "users", "companies",
  "branches", "cost-centers", "fiscal", "periods", "hr", "employees", "payroll", "attendance",
  "fixed-assets", "assets", "custody", "loans", "zatca", "integrations", "office", "training",
  "pos", "documents", "archive", "notifications", "extensions", "partners", "agents",
]);
const safeActionCategories = new Set([
  "create", "add", "update", "edit", "delete", "save", "post", "unpost", "approve",
  "reject", "archive", "restore", "print", "export", "report", "login", "logout", "view",
]);
function sanitizeEventRoute(value: string): string {
  const path = value.split(/[?#]/)[0];
  const segments = path.split("/").filter(Boolean).slice(0, 12);
  return `/${segments.map((segment) => {
    const normalized = segment.toLowerCase();
    return safeRouteSegments.has(normalized) ? normalized : ":id";
  }).join("/")}`.slice(0, 220);
}
export function cleanDemoEvents(input: unknown) {
  if (!Array.isArray(input) || input.length > 200) return null;
  const out: any[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return null;
    const e: any = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (eventKeys.has(k)) e[k] = v;
    if (typeof e.eventId !== "string" || e.eventId.length < 1 || e.eventId.length > 128 || typeof e.type !== "string" || !safeEventTypes.has(e.type)) return null;
    for (const k of ["moduleKey", "screenKey", "actionKey"]) {
      if (e[k] == null) continue;
      if (typeof e[k] !== "string" || !/^[a-z][a-z0-9_.:-]{0,79}$/i.test(e[k]) || /[a-f0-9]{16,}/i.test(e[k])) return null;
    }
    if (e.route != null) {
      if (typeof e.route !== "string") return null;
      e.route = sanitizeEventRoute(e.route);
      if (!/^\/[a-z0-9/_:.-]{0,220}$/i.test(e.route)) return null;
      const routeParts = e.route.split("/").filter(Boolean);
      e.moduleKey = routeParts[0] && routeParts[0] !== ":id" ? routeParts[0] : "other";
      e.screenKey = routeParts.join("_") || "home";
    } else {
      delete e.moduleKey;
      delete e.screenKey;
    }
    if (e.actionKey != null) {
      const category = String(e.actionKey).toLowerCase().split(/[_.:-]/, 1)[0];
      e.actionKey = safeActionCategories.has(category) ? category : null;
    }
    if (e.durationMs != null && (!Number.isInteger(e.durationMs) || e.durationMs < 0 || e.durationMs > 86_400_000)) return null;
    const at = e.occurredAt ? new Date(e.occurredAt) : new Date();
    if (Number.isNaN(at.getTime())) return null;
    e.occurredAt = at;
    out.push(e);
  }
  return out;
}
async function current(req: any, res: any) {
  const identity = await resolveDemoIdentity(req);
  if (!identity) { res.status(403).json({ error: "Not a demo workspace", code: "DEMO_NOT_APPLICABLE" }); return null; }
  const profile = await getProfile(identity);
  const policy = await getPolicy(profile!.id);
  return { identity, profile: profile!, policy };
}

router.get("/status", async (req, res) => {
  const identity = await resolveDemoIdentity(req);
  if (!identity) return res.json({ applicable: false, phoneRequired: false, profileId: null, enabled: true, actionLimit: 0, actionsUsed: 0, remaining: 0, warningRemaining: 0, subscriptionMessage: null, blocked: false, currentSessionId: null });
  const profile = await getProfile(identity); const policy = await getPolicy(profile!.id);
  const used = await actionsUsed(profile!.id);
  const [session] = await centralDb.select({ id: demoAnalyticsSessionsTable.id }).from(demoAnalyticsSessionsTable)
    .where(and(eq(demoAnalyticsSessionsTable.profileId, profile!.id), sql`${demoAnalyticsSessionsTable.endedAt} IS NULL`)).orderBy(desc(demoAnalyticsSessionsTable.startedAt)).limit(1);
  const effectiveLimit = policy.limitEnabled ? policy.actionLimit : null;
  const remaining = effectiveLimit == null ? null : Math.max(0, effectiveLimit - used);
  return res.json({ applicable: true, phoneRequired: !profile!.phone, profileId: profile!.id, enabled: policy.enabled, limitEnabled: policy.limitEnabled, actionLimit: effectiveLimit, actionsUsed: used, remaining, warningRemaining: policy.warningRemaining, subscriptionMessage: policy.subscriptionMessage ?? null, blocked: !policy.enabled || (remaining != null && remaining <= 0), currentSessionId: session?.id ?? null });
});
router.post("/phone", async (req, res) => {
  const c = await current(req, res); if (!c) return;
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(422).json({ error: "Invalid phone", code: "DEMO_PHONE_INVALID" });
  if (c.profile.phone && c.profile.phone !== phone) {
    return res.status(409).json({ error: "رقم الديمو مرتبط بهذه المساحة ولا يمكن تغييره", code: "DEMO_PHONE_IMMUTABLE" });
  }
  await centralDb.update(demoAnalyticsProfilesTable).set({ phone, updatedAt: new Date() }).where(eq(demoAnalyticsProfilesTable.id, c.profile.id));
  return res.json({ phone });
});
router.post("/sessions/start", async (req, res) => {
  const c = await current(req, res); if (!c) return;
  const sessionKey = String(req.body?.sessionKey ?? "").slice(0, 128);
  if (!sessionKey) return res.status(422).json({ code: "DEMO_SESSION_KEY_REQUIRED" });
  const deviceType = ["mobile", "tablet", "desktop", "laptop"].includes(req.body?.deviceType) ? req.body.deviceType : null;
  const clean = (v: unknown, max: number) => typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, "").slice(0, max) : null;
  const os = clean(req.body?.os, 80), browser = clean(req.body?.browser, 80);
  const userAgent = clean(req.body?.userAgent ?? req.headers["user-agent"], 300);
  const [s] = await centralDb.insert(demoAnalyticsSessionsTable).values({ profileId: c.profile.id, sessionKey, deviceType, os, browser, userAgent }).onConflictDoNothing().returning();
  const session = s ?? (await centralDb.select().from(demoAnalyticsSessionsTable).where(and(eq(demoAnalyticsSessionsTable.profileId, c.profile.id), eq(demoAnalyticsSessionsTable.sessionKey, sessionKey))).limit(1))[0];
  if (s) await centralDb.update(demoAnalyticsProfilesTable).set({ loginCount: sql`${demoAnalyticsProfilesTable.loginCount} + 1`, updatedAt: new Date() }).where(eq(demoAnalyticsProfilesTable.id, c.profile.id));
  if (s && deviceType) await centralDb.update(demoAnalyticsProfilesTable).set({ device: deviceType, updatedAt: new Date() }).where(eq(demoAnalyticsProfilesTable.id, c.profile.id));
  await refreshInterest(c.profile.id);
  return res.json({ sessionId: session?.id ?? null, sessionKey, replay: !s });
});
router.post("/sessions/:id/heartbeat", async (req, res) => {
  const c = await current(req, res); if (!c) return;
  const durationMs = await centralDb.transaction(async (tx) => {
    const [s] = await tx.select().from(demoAnalyticsSessionsTable)
      .where(and(eq(demoAnalyticsSessionsTable.id, Number(req.params.id)), eq(demoAnalyticsSessionsTable.profileId, c.profile.id), sql`${demoAnalyticsSessionsTable.endedAt} IS NULL`))
      .for("update").limit(1);
    if (!s) return null;
    const nextDuration = Math.max(s.durationMs, Math.min(86_400_000, Date.now() - s.startedAt.getTime()));
    const delta = nextDuration - s.durationMs;
    await tx.update(demoAnalyticsSessionsTable).set({ lastHeartbeatAt: new Date(), durationMs: nextDuration }).where(eq(demoAnalyticsSessionsTable.id, s.id));
    if (delta) await tx.update(demoAnalyticsProfilesTable).set({ totalDurationMs: sql`${demoAnalyticsProfilesTable.totalDurationMs} + ${delta}` }).where(eq(demoAnalyticsProfilesTable.id, c.profile.id));
    return nextDuration;
  });
  if (durationMs == null) return res.status(404).json({ code: "DEMO_SESSION_NOT_FOUND" });
  return res.json({ ok: true });
});
router.post("/sessions/:id/end", async (req, res) => {
  const c = await current(req, res); if (!c) return;
  const result = await centralDb.transaction(async (tx) => {
    const whereIdentity = and(eq(demoAnalyticsSessionsTable.id, Number(req.params.id)), eq(demoAnalyticsSessionsTable.profileId, c.profile.id));
    const [s] = await tx.select().from(demoAnalyticsSessionsTable).where(whereIdentity).for("update").limit(1);
    if (!s) return null;
    if (s.endedAt) return { durationMs: s.durationMs, replay: true };
    const durationMs = Math.max(s.durationMs, Math.min(86_400_000, Date.now() - s.startedAt.getTime()));
    const delta = durationMs - s.durationMs;
    const now = new Date();
    await tx.update(demoAnalyticsSessionsTable).set({ endedAt: now, lastHeartbeatAt: now, durationMs }).where(and(whereIdentity, sql`${demoAnalyticsSessionsTable.endedAt} IS NULL`));
    if (delta) await tx.update(demoAnalyticsProfilesTable).set({ totalDurationMs: sql`${demoAnalyticsProfilesTable.totalDurationMs} + ${delta}`, updatedAt: now }).where(eq(demoAnalyticsProfilesTable.id, c.profile.id));
    return { durationMs, replay: false };
  });
  if (!result) return res.status(404).json({ code: "DEMO_SESSION_NOT_FOUND" });
  if (!result.replay) await refreshInterest(c.profile.id);
  return res.json({ ok: true, durationMs: result.durationMs, replay: result.replay });
});
router.post("/events/batch", async (req, res) => {
  const c = await current(req, res); if (!c) return;
  const events = cleanDemoEvents(req.body?.events); if (!events) return res.status(422).json({ code: "DEMO_EVENTS_INVALID" });
  return res.json({ accepted: await recordEvents(c.profile.id, events) });
});
router.post("/actions/consume", async (req, res) => {
  const c = await current(req, res); if (!c) return;
  const action = String(req.body?.action ?? "");
  const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : "";
  if (!["export", "print", "report"].includes(action) || !key || key.length > 160) return res.status(422).json({ code: "DEMO_ACTION_CONSUME_INVALID" });
  if (!c.profile.phone) return res.status(428).json({ code: "DEMO_PHONE_REQUIRED" });
  const r = await reserveDemoAction(c.profile.id, `/demo-analytics/actions/${action}`, key);
  if (!r.ok) return res.status(r.status).json({ code: r.code });
  await finalizeDemoAction(r.reservationId, true, `/demo-analytics/actions/${action}`);
  const used = await actionsUsed(c.profile.id);
  const effectiveLimit = r.policy.limitEnabled ? r.policy.actionLimit : null;
  return res.json({ action, actionsUsed: used, remaining: effectiveLimit == null ? null : Math.max(0, effectiveLimit - used) });
});
// Agent proxy authentication has already validated x-zacod-agent-token before
// setting verifiedAgentProxyIdentity. It is intentionally not a tenant bearer endpoint.
router.post("/agent/batch", async (req, res) => {
  const sourceInstanceId = (req as any).verifiedAgentProxyIdentity?.agentId;
  const receiptKey = String(req.headers["idempotency-key"] ?? req.body?.receiptKey ?? "").slice(0, 160);
  const incoming = Array.isArray(req.body?.events) ? req.body.events : null;
  const events = incoming && cleanDemoEvents(incoming.map((x: any) => x?.event));
  if (!sourceInstanceId) return res.status(403).json({ code: "DEMO_AGENT_IDENTITY_REQUIRED" });
  if (!receiptKey || !events) return res.status(422).json({ code: "DEMO_AGENT_BATCH_INVALID" });
  const claim = await centralDb.insert(demoAgentBatchReceiptsTable).values({ sourceInstanceId, receiptKey, eventCount: events.length, status: "processing" }).onConflictDoNothing().returning({ id: demoAgentBatchReceiptsTable.id });
  if (!claim.length) {
    const [prior] = await centralDb.select().from(demoAgentBatchReceiptsTable).where(and(eq(demoAgentBatchReceiptsTable.sourceInstanceId, sourceInstanceId), eq(demoAgentBatchReceiptsTable.receiptKey, receiptKey))).limit(1);
    if (prior?.status === "complete") return res.json({ accepted: 0, replay: true });
    if (prior?.status === "processing") return res.status(409).json({ code: "DEMO_AGENT_BATCH_IN_PROGRESS" });
    // Failed receipts are reclaimed; event IDs make repair safe.
    const reclaimed = await centralDb.update(demoAgentBatchReceiptsTable).set({ status: "processing", error: null, updatedAt: new Date() }).where(and(eq(demoAgentBatchReceiptsTable.id, prior!.id), eq(demoAgentBatchReceiptsTable.status, "failed"))).returning({ id: demoAgentBatchReceiptsTable.id });
    if (!reclaimed.length) return res.status(409).json({ code: "DEMO_AGENT_BATCH_IN_PROGRESS" });
  }
  let accepted = 0;
  try {
    for (let i = 0; i < events.length; i++) {
      const e = events[i]; const identity = incoming![i] as any;
      const companyId = Number(identity?.localCompanyId), userId = Number(identity?.localUserId);
      if (!Number.isInteger(companyId) || !Number.isInteger(userId)) continue;
      const p = await getProfile({ sourceKind: "agent", sourceInstanceId, localCompanyId: companyId, localUserId: userId });
      accepted += await recordEvents(p!.id, [e]);
    }
    await centralDb.update(demoAgentBatchReceiptsTable).set({ status: "complete", updatedAt: new Date(), error: null }).where(and(eq(demoAgentBatchReceiptsTable.sourceInstanceId, sourceInstanceId), eq(demoAgentBatchReceiptsTable.receiptKey, receiptKey)));
  } catch (err) {
    await centralDb.update(demoAgentBatchReceiptsTable).set({ status: "failed", updatedAt: new Date(), error: String((err as any)?.message ?? err).slice(0, 300) }).where(and(eq(demoAgentBatchReceiptsTable.sourceInstanceId, sourceInstanceId), eq(demoAgentBatchReceiptsTable.receiptKey, receiptKey)));
    throw err;
  }
  return res.json({ accepted, replay: false });
});
export default router;