import type { Request, Response } from "express";

/**
 * Agent-scoped SuperAdmin operations.
 *
 * Companies created on a full_shell agent live in the AGENT's own PostgreSQL,
 * not the central DB. The SuperAdmin dashboard manages them by appending
 * `?agent=<agentInstanceId>` to the normal admin routes; handlers wrap their
 * body in `runWithAgentScope(req, res, fn)` which re-executes `fn` inside the
 * agent DB ALS context (so the proxied `db` transparently targets the agent).
 *
 * Security: ONLY superadmin callers may cross into another tenant DB —
 * callers must ensure the route is superadmin-gated before honoring `?agent=`.
 * The helper itself refuses non-superadmin auth users defensively.
 */
export async function runWithAgentScope<T>(
  req: Request,
  res: Response,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const raw = req.query?.agent;
  const agentId = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!raw || !Number.isFinite(agentId) || agentId <= 0) return fn();

  // Admin routes gate via requireSuperAdmin (sets req.adminUser); tenant
  // routes gate via extractAuth (sets req.authUser). Accept either verified
  // principal — but ONLY the superadmin role.
  const principal = (req as any).adminUser ?? (req as any).authUser;
  if (!principal || principal.role !== "superadmin") {
    res.status(403).json({ error: "الوصول لقاعدة وكيل متاح للمشرف العام فقط" });
    return undefined;
  }

  const { centralDb, runWithExternalDb, agentInstancesTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const [inst] = await centralDb.select().from(agentInstancesTable)
    .where(eq(agentInstancesTable.id, agentId)).limit(1);
  if (!inst || inst.dbStatus !== "initialized" || !inst.dbUrlEnc) {
    res.status(404).json({ error: "الوكيل غير موجود أو قاعدته غير مهيأة" });
    return undefined;
  }
  const { getAgentDbContext } = await import("./agentDb.js");
  const ctx = getAgentDbContext(inst.id, inst.dbUrlEnc);
  return await runWithExternalDb(ctx, fn);
}

/** List active agents with an initialized external DB (central registry). */
export async function listInitializedAgents(): Promise<Array<{
  id: number;
  name: string;
  domain: string;
  dbUrlEnc: string;
  lastSeenIp: string | null;
  lastHeartbeatAt: Date | null;
}>> {
  const { centralDb, agentInstancesTable } = await import("@workspace/db");
  const { and, eq, isNotNull } = await import("drizzle-orm");
  const rows = await centralDb.select({
    id: agentInstancesTable.id,
    name: agentInstancesTable.name,
    domain: agentInstancesTable.domain,
    dbUrlEnc: agentInstancesTable.dbUrlEnc,
    dbStatus: agentInstancesTable.dbStatus,
    lastSeenIp: agentInstancesTable.lastSeenIp,
    lastHeartbeatAt: agentInstancesTable.lastHeartbeatAt,
  }).from(agentInstancesTable)
    .where(and(eq(agentInstancesTable.status, "active"), isNotNull(agentInstancesTable.dbUrlEnc)));
  return rows
    .filter(r => r.dbStatus === "initialized" && r.dbUrlEnc)
    .map(r => ({
      id: r.id,
      name: r.name as string,
      domain: r.domain,
      dbUrlEnc: r.dbUrlEnc as string,
      lastSeenIp: r.lastSeenIp,
      lastHeartbeatAt: r.lastHeartbeatAt,
    }));
}
