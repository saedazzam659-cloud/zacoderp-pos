import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  devWorkspacesTable, devWorkspaceSeatsTable, devDeploymentsTable,
  companiesTable,
  DEV_CLOUD_PROVIDERS, DEV_WORKSPACE_STATUSES, DEV_SEAT_ROLES,
  DEV_SEAT_PERMISSION_KEYS, DEV_ROLE_DEFAULT_PERMISSIONS, DEV_SEAT_STATUSES,
  DEV_DEPLOY_ENVIRONMENTS, DEV_DEPLOY_STATUSES,
  type DevCloudProvider, type DevSeatRole, type DevSeatPermissions,
  type DevDeployEnvironment, type DevDeployStatus,
} from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { writeAudit } from "../middleware/permissions.js";
import { extractAuth } from "../middleware/auth.js";

// ─────────────────────────────────────────────────────────────────────────
// SuperAdmin Developer Cloud (Workspaces) — Phase 5 (additive only).
// Mounted at /api/admin/dev-cloud. Every endpoint requires the platform
// SuperAdmin role. This router NEVER stores or returns server credentials,
// SSH/RDP details, or DB connection strings — only opaque provider references.
// The ONLY deployment path is the Publish engine (dev_deployments.method is
// fixed to 'publish_engine'); no other deploy endpoint exists.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();
router.use(extractAuth);

async function requireSuperAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (u.role !== "superadmin") { res.status(403).json({ error: "هذه الصفحة لمدير المنصة فقط" }); return; }
  next();
}
router.use(requireSuperAdmin);

const now = () => new Date();

function normalizeProvider(v: any): DevCloudProvider {
  return DEV_CLOUD_PROVIDERS.includes(v) ? (v as DevCloudProvider) : "replit";
}

function normalizeRole(v: any): DevSeatRole {
  return DEV_SEAT_ROLES.includes(v) ? (v as DevSeatRole) : "backend";
}

// Apply / sanitize a seat permission map. If `base` is provided (a role's
// default set), unspecified keys fall back to the role default — this is how we
// enforce least-privilege seats unless an operator explicitly overrides.
function sanitizePermissions(input: any, role?: DevSeatRole): DevSeatPermissions {
  const out: DevSeatPermissions = {};
  const roleDefaults = role ? new Set(DEV_ROLE_DEFAULT_PERMISSIONS[role]) : null;
  const hasInput = input && typeof input === "object";
  for (const k of DEV_SEAT_PERMISSION_KEYS) {
    if (hasInput && input[k] !== undefined) out[k] = input[k] === true;
    else if (roleDefaults) out[k] = roleDefaults.has(k);
    else out[k] = false;
  }
  return out;
}

const auditBase = (req: Request) => ({
  userId: req.authUser?.id ?? null,
  username: req.authUser?.username ?? null,
  role: "superadmin" as const,
});

// ─── List workspaces (+ company name + seat/deployment counts) ──────────────
router.get("/", async (_req, res) => {
  const rows = await db
    .select({
      id: devWorkspacesTable.id,
      companyId: devWorkspacesTable.companyId,
      companyNameAr: companiesTable.nameAr,
      companyNameEn: companiesTable.nameEn,
      companyCode: companiesTable.code,
      provider: devWorkspacesTable.provider,
      region: devWorkspacesTable.region,
      tier: devWorkspacesTable.tier,
      status: devWorkspacesTable.status,
      provisionedAt: devWorkspacesTable.provisionedAt,
      isActive: devWorkspacesTable.isActive,
      createdAt: devWorkspacesTable.createdAt,
    })
    .from(devWorkspacesTable)
    .leftJoin(companiesTable, eq(companiesTable.id, devWorkspacesTable.companyId))
    .orderBy(desc(devWorkspacesTable.createdAt));

  const seatCounts = await db
    .select({ workspaceId: devWorkspaceSeatsTable.workspaceId, n: sql<number>`count(*)::int` })
    .from(devWorkspaceSeatsTable)
    .groupBy(devWorkspaceSeatsTable.workspaceId);
  const deployCounts = await db
    .select({ workspaceId: devDeploymentsTable.workspaceId, n: sql<number>`count(*)::int` })
    .from(devDeploymentsTable)
    .groupBy(devDeploymentsTable.workspaceId);
  const seatMap = new Map(seatCounts.map((c) => [c.workspaceId, c.n]));
  const deployMap = new Map(deployCounts.map((c) => [c.workspaceId, c.n]));

  res.json({
    workspaces: rows.map((r) => ({
      ...r,
      seatCount: seatMap.get(r.id) ?? 0,
      deploymentCount: deployMap.get(r.id) ?? 0,
    })),
    meta: {
      providers: DEV_CLOUD_PROVIDERS,
      statuses: DEV_WORKSPACE_STATUSES,
      roles: DEV_SEAT_ROLES,
      permissionKeys: DEV_SEAT_PERMISSION_KEYS,
      roleDefaults: DEV_ROLE_DEFAULT_PERMISSIONS,
      deployEnvironments: DEV_DEPLOY_ENVIRONMENTS,
    },
  });
});

// ─── Companies eligible for a NEW workspace (no workspace yet) ───────────────
router.get("/companies/available", async (req, res) => {
  const search = String(req.query.search ?? "").trim().toLowerCase();
  const existing = await db.select({ companyId: devWorkspacesTable.companyId }).from(devWorkspacesTable);
  const taken = new Set(existing.map((e) => e.companyId));
  let rows = await db
    .select({ id: companiesTable.id, nameAr: companiesTable.nameAr, nameEn: companiesTable.nameEn, code: companiesTable.code, status: companiesTable.status })
    .from(companiesTable)
    .orderBy(desc(companiesTable.id))
    .limit(400);
  rows = rows.filter((r) => !taken.has(r.id));
  if (search) {
    rows = rows.filter((r) =>
      (r.nameAr ?? "").toLowerCase().includes(search) ||
      (r.nameEn ?? "").toLowerCase().includes(search) ||
      (r.code ?? "").toLowerCase().includes(search));
  }
  res.json({ companies: rows.slice(0, 200) });
});

// ─── Create a workspace for a company (starts 'pending') ────────────────────
router.post("/", async (req, res) => {
  const b = req.body ?? {};
  const companyId = parseInt(b.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) { res.status(400).json({ error: "معرّف الشركة غير صالح" }); return; }
  const [company] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, companyId));
  if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
  const [already] = await db.select({ id: devWorkspacesTable.id }).from(devWorkspacesTable).where(eq(devWorkspacesTable.companyId, companyId));
  if (already) { res.status(409).json({ error: "للشركة مساحة عمل بالفعل" }); return; }

  const [created] = await db.insert(devWorkspacesTable).values({
    companyId,
    provider: normalizeProvider(b.provider),
    region: b.region ? String(b.region).trim() : null,
    tier: b.tier ? String(b.tier).trim() : "standard",
    notes: b.notes ? String(b.notes).trim() : null,
    status: "pending",
  }).returning();

  await writeAudit({
    ...auditBase(req), companyId, module: "dev_cloud", action: "create",
    entityType: "dev_workspace", entityId: String(created.id), metadata: { provider: created.provider },
  });
  res.status(201).json({ ok: true, workspace: created });
});

// ─── Single workspace (+ seats + recent deployments) ────────────────────────
router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [workspace] = await db
    .select({
      id: devWorkspacesTable.id,
      companyId: devWorkspacesTable.companyId,
      companyNameAr: companiesTable.nameAr,
      companyNameEn: companiesTable.nameEn,
      companyCode: companiesTable.code,
      provider: devWorkspacesTable.provider,
      externalWorkspaceId: devWorkspacesTable.externalWorkspaceId,
      sandboxId: devWorkspacesTable.sandboxId,
      gitRepoUrl: devWorkspacesTable.gitRepoUrl,
      storageBucket: devWorkspacesTable.storageBucket,
      testEnvUrl: devWorkspacesTable.testEnvUrl,
      region: devWorkspacesTable.region,
      tier: devWorkspacesTable.tier,
      status: devWorkspacesTable.status,
      provisionedAt: devWorkspacesTable.provisionedAt,
      lastError: devWorkspacesTable.lastError,
      notes: devWorkspacesTable.notes,
      isActive: devWorkspacesTable.isActive,
      createdAt: devWorkspacesTable.createdAt,
      updatedAt: devWorkspacesTable.updatedAt,
    })
    .from(devWorkspacesTable)
    .leftJoin(companiesTable, eq(companiesTable.id, devWorkspacesTable.companyId))
    .where(eq(devWorkspacesTable.id, id));
  if (!workspace) { res.status(404).json({ error: "مساحة العمل غير موجودة" }); return; }

  const seats = await db.select().from(devWorkspaceSeatsTable)
    .where(eq(devWorkspaceSeatsTable.workspaceId, id))
    .orderBy(desc(devWorkspaceSeatsTable.createdAt));
  const deployments = await db.select().from(devDeploymentsTable)
    .where(eq(devDeploymentsTable.workspaceId, id))
    .orderBy(desc(devDeploymentsTable.createdAt))
    .limit(50);

  res.json({ workspace, seats, deployments });
});

// ─── Update workspace profile (provider/region/tier/notes + opaque refs) ────
router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [existing] = await db.select().from(devWorkspacesTable).where(eq(devWorkspacesTable.id, id));
  if (!existing) { res.status(404).json({ error: "مساحة العمل غير موجودة" }); return; }
  const b = req.body ?? {};
  const patch: Record<string, any> = { updatedAt: now() };

  if (b.provider !== undefined)            patch.provider = normalizeProvider(b.provider);
  if (b.region !== undefined)              patch.region = b.region ? String(b.region).trim() : null;
  if (b.tier !== undefined)                patch.tier = b.tier ? String(b.tier).trim() : "standard";
  if (b.notes !== undefined)               patch.notes = b.notes ? String(b.notes).trim() : null;
  // Opaque provider references — never credentials.
  if (b.externalWorkspaceId !== undefined) patch.externalWorkspaceId = b.externalWorkspaceId ? String(b.externalWorkspaceId).trim() : null;
  if (b.sandboxId !== undefined)           patch.sandboxId = b.sandboxId ? String(b.sandboxId).trim() : null;
  if (b.gitRepoUrl !== undefined)          patch.gitRepoUrl = b.gitRepoUrl ? String(b.gitRepoUrl).trim() : null;
  if (b.storageBucket !== undefined)       patch.storageBucket = b.storageBucket ? String(b.storageBucket).trim() : null;
  if (b.testEnvUrl !== undefined)          patch.testEnvUrl = b.testEnvUrl ? String(b.testEnvUrl).trim() : null;

  const [updated] = await db.update(devWorkspacesTable).set(patch).where(eq(devWorkspacesTable.id, id)).returning();
  await writeAudit({
    ...auditBase(req), companyId: existing.companyId, module: "dev_cloud", action: "edit",
    entityType: "dev_workspace", entityId: String(id), metadata: { fields: Object.keys(patch) },
  });
  res.json({ ok: true, workspace: updated });
});

// ─── Provision a workspace on the managed provider ──────────────────────────
// Registers the opaque provider references (the operator supplies them after
// the managed provider provisions the sandbox+git+storage+test env, OR we mark
// it active once they are recorded). NEVER accepts/stores credentials. This is
// the integration point a real provider SDK call would populate.
router.post("/:id/provision", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [existing] = await db.select().from(devWorkspacesTable).where(eq(devWorkspacesTable.id, id));
  if (!existing) { res.status(404).json({ error: "مساحة العمل غير موجودة" }); return; }
  if (existing.status === "archived") { res.status(400).json({ error: "مساحة العمل مؤرشفة" }); return; }
  const b = req.body ?? {};

  const externalWorkspaceId = b.externalWorkspaceId ? String(b.externalWorkspaceId).trim() : existing.externalWorkspaceId;
  const sandboxId           = b.sandboxId ? String(b.sandboxId).trim() : existing.sandboxId;
  const gitRepoUrl          = b.gitRepoUrl ? String(b.gitRepoUrl).trim() : existing.gitRepoUrl;
  const storageBucket       = b.storageBucket ? String(b.storageBucket).trim() : existing.storageBucket;
  const testEnvUrl          = b.testEnvUrl ? String(b.testEnvUrl).trim() : existing.testEnvUrl;

  // A workspace is "active" only when all four isolated resources are present:
  // sandbox + git + storage + test environment.
  const fullyProvisioned = Boolean(sandboxId && gitRepoUrl && storageBucket && testEnvUrl);

  const [updated] = await db.update(devWorkspacesTable).set({
    externalWorkspaceId, sandboxId, gitRepoUrl, storageBucket, testEnvUrl,
    status: fullyProvisioned ? "active" : "provisioning",
    provisionedAt: fullyProvisioned ? (existing.provisionedAt ?? now()) : existing.provisionedAt,
    lastError: null,
    isActive: true,
    updatedAt: now(),
  }).where(eq(devWorkspacesTable.id, id)).returning();

  await writeAudit({
    ...auditBase(req), companyId: existing.companyId, module: "dev_cloud", action: "edit",
    entityType: "dev_workspace", entityId: String(id),
    metadata: { op: "provision", status: updated.status, fullyProvisioned },
  });
  res.json({ ok: true, workspace: updated });
});

// ─── Set workspace status (suspend / resume / archive) ──────────────────────
router.post("/:id/status", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [existing] = await db.select().from(devWorkspacesTable).where(eq(devWorkspacesTable.id, id));
  if (!existing) { res.status(404).json({ error: "مساحة العمل غير موجودة" }); return; }
  const to = String(req.body?.to ?? "").trim();
  if (!DEV_WORKSPACE_STATUSES.includes(to as any)) { res.status(400).json({ error: "حالة غير صالحة" }); return; }

  const patch: Record<string, any> = { status: to, updatedAt: now() };
  if (to === "suspended" || to === "archived") patch.isActive = false;
  if (to === "active") patch.isActive = true;

  const [updated] = await db.update(devWorkspacesTable).set(patch).where(eq(devWorkspacesTable.id, id)).returning();
  await writeAudit({
    ...auditBase(req), companyId: existing.companyId, module: "dev_cloud", action: "edit",
    entityType: "dev_workspace", entityId: String(id), metadata: { op: "status", from: existing.status, to },
  });
  res.json({ ok: true, workspace: updated });
});

// ─── Delete workspace ───────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [existing] = await db.select().from(devWorkspacesTable).where(eq(devWorkspacesTable.id, id));
  if (!existing) { res.status(404).json({ error: "مساحة العمل غير موجودة" }); return; }
  await db.delete(devWorkspacesTable).where(eq(devWorkspacesTable.id, id));
  await writeAudit({
    ...auditBase(req), companyId: existing.companyId, module: "dev_cloud", action: "delete",
    entityType: "dev_workspace", entityId: String(id), metadata: {},
  });
  res.json({ ok: true });
});

// ─── Seats: add a developer seat (least-privilege defaults by role) ─────────
router.post("/:id/seats", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [workspace] = await db.select({ id: devWorkspacesTable.id, companyId: devWorkspacesTable.companyId }).from(devWorkspacesTable).where(eq(devWorkspacesTable.id, id));
  if (!workspace) { res.status(404).json({ error: "مساحة العمل غير موجودة" }); return; }
  const b = req.body ?? {};
  const name = String(b.name ?? "").trim();
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!name) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
  if (!email) { res.status(400).json({ error: "البريد الإلكتروني مطلوب" }); return; }
  const role = normalizeRole(b.role);

  const [dup] = await db.select({ id: devWorkspaceSeatsTable.id }).from(devWorkspaceSeatsTable)
    .where(and(eq(devWorkspaceSeatsTable.workspaceId, id), eq(devWorkspaceSeatsTable.email, email)));
  if (dup) { res.status(409).json({ error: "البريد مستخدم في هذه المساحة" }); return; }

  // Default to the role's least-privilege set; honor explicit overrides.
  const permissions = sanitizePermissions(b.permissions, role);
  const [seat] = await db.insert(devWorkspaceSeatsTable).values({
    workspaceId: id, name, email, role, permissions, status: "active",
  }).returning();
  await writeAudit({
    ...auditBase(req), companyId: workspace.companyId, module: "dev_cloud", action: "create",
    entityType: "dev_seat", entityId: String(seat.id), metadata: { workspaceId: id, role },
  });
  res.status(201).json({ ok: true, seat });
});

// ─── Seats: update role / permissions / status ──────────────────────────────
router.put("/:id/seats/:seatId", async (req, res) => {
  const id = parseInt(req.params.id);
  const seatId = parseInt(req.params.seatId);
  if (!Number.isInteger(id) || !Number.isInteger(seatId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [seat] = await db.select().from(devWorkspaceSeatsTable)
    .where(and(eq(devWorkspaceSeatsTable.id, seatId), eq(devWorkspaceSeatsTable.workspaceId, id)));
  if (!seat) { res.status(404).json({ error: "المقعد غير موجود" }); return; }
  const b = req.body ?? {};
  const patch: Record<string, any> = { updatedAt: now() };

  if (b.name !== undefined) { const v = String(b.name).trim(); if (!v) { res.status(400).json({ error: "الاسم مطلوب" }); return; } patch.name = v; }
  let effectiveRole = seat.role as DevSeatRole;
  if (b.role !== undefined) { effectiveRole = normalizeRole(b.role); patch.role = effectiveRole; }
  if (b.status !== undefined) {
    const s = String(b.status).trim();
    if (!DEV_SEAT_STATUSES.includes(s as any)) { res.status(400).json({ error: "حالة غير صالحة" }); return; }
    patch.status = s;
  }
  // If the role changed but no explicit permissions were sent, re-apply the new
  // role's least-privilege defaults; otherwise honor the explicit map.
  if (b.permissions !== undefined) patch.permissions = sanitizePermissions(b.permissions, effectiveRole);
  else if (b.role !== undefined)   patch.permissions = sanitizePermissions(seat.permissions, effectiveRole);

  const [updated] = await db.update(devWorkspaceSeatsTable).set(patch)
    .where(eq(devWorkspaceSeatsTable.id, seatId)).returning();
  await writeAudit({
    ...auditBase(req), companyId: null, module: "dev_cloud", action: "edit",
    entityType: "dev_seat", entityId: String(seatId), metadata: { workspaceId: id, fields: Object.keys(patch) },
  });
  res.json({ ok: true, seat: updated });
});

// ─── Seats: remove ──────────────────────────────────────────────────────────
router.delete("/:id/seats/:seatId", async (req, res) => {
  const id = parseInt(req.params.id);
  const seatId = parseInt(req.params.seatId);
  if (!Number.isInteger(id) || !Number.isInteger(seatId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const del = await db.delete(devWorkspaceSeatsTable)
    .where(and(eq(devWorkspaceSeatsTable.id, seatId), eq(devWorkspaceSeatsTable.workspaceId, id)))
    .returning({ id: devWorkspaceSeatsTable.id });
  if (!del.length) { res.status(404).json({ error: "المقعد غير موجود" }); return; }
  await writeAudit({
    ...auditBase(req), companyId: null, module: "dev_cloud", action: "delete",
    entityType: "dev_seat", entityId: String(seatId), metadata: { workspaceId: id },
  });
  res.json({ ok: true });
});

// ─── Deployments: trigger a deployment via the PUBLISH ENGINE (only path) ────
// The workspace must be 'active'. The triggering seat (if given) must belong to
// the workspace AND hold the `trigger_publish` capability — least-privilege is
// enforced server-side. method is hard-fixed to 'publish_engine'.
router.post("/:id/deployments", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [workspace] = await db.select().from(devWorkspacesTable).where(eq(devWorkspacesTable.id, id));
  if (!workspace) { res.status(404).json({ error: "مساحة العمل غير موجودة" }); return; }
  if (workspace.status !== "active") { res.status(400).json({ error: "يجب أن تكون مساحة العمل نشطة قبل النشر" }); return; }
  const b = req.body ?? {};

  const environment = (DEV_DEPLOY_ENVIRONMENTS.includes(b.environment) ? b.environment : "test") as DevDeployEnvironment;
  let triggeredBySeatId: number | null = null;
  if (b.seatId !== undefined && b.seatId !== null && b.seatId !== "") {
    const seatId = parseInt(b.seatId);
    if (!Number.isInteger(seatId)) { res.status(400).json({ error: "مقعد غير صالح" }); return; }
    const [seat] = await db.select().from(devWorkspaceSeatsTable)
      .where(and(eq(devWorkspaceSeatsTable.id, seatId), eq(devWorkspaceSeatsTable.workspaceId, id)));
    if (!seat) { res.status(404).json({ error: "المقعد غير موجود" }); return; }
    if (seat.status !== "active") { res.status(403).json({ error: "المقعد موقوف" }); return; }
    if (!(seat.permissions as DevSeatPermissions)?.trigger_publish) {
      res.status(403).json({ error: "هذا المقعد لا يملك صلاحية النشر" }); return;
    }
    triggeredBySeatId = seatId;
  }

  const [deployment] = await db.insert(devDeploymentsTable).values({
    workspaceId: id,
    environment,
    ref: b.ref ? String(b.ref).trim() : null,
    notes: b.notes ? String(b.notes).trim() : null,
    triggeredBySeatId,
    method: "publish_engine",
    status: "queued",
  }).returning();
  await writeAudit({
    ...auditBase(req), companyId: workspace.companyId, module: "dev_cloud", action: "create",
    entityType: "dev_deployment", entityId: String(deployment.id),
    metadata: { workspaceId: id, environment, method: "publish_engine" },
  });
  res.status(201).json({ ok: true, deployment });
});

// ─── Deployments: update status (Publish engine progress callback) ──────────
router.put("/:id/deployments/:deployId", async (req, res) => {
  const id = parseInt(req.params.id);
  const deployId = parseInt(req.params.deployId);
  if (!Number.isInteger(id) || !Number.isInteger(deployId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [deployment] = await db.select().from(devDeploymentsTable)
    .where(and(eq(devDeploymentsTable.id, deployId), eq(devDeploymentsTable.workspaceId, id)));
  if (!deployment) { res.status(404).json({ error: "النشر غير موجود" }); return; }
  const to = String(req.body?.status ?? "").trim() as DevDeployStatus;
  if (!DEV_DEPLOY_STATUSES.includes(to)) { res.status(400).json({ error: "حالة غير صالحة" }); return; }

  const patch: Record<string, any> = { status: to };
  if (to === "published") { patch.publishedAt = now(); patch.lastError = null; }
  if (to === "failed") patch.lastError = req.body?.error ? String(req.body.error).trim() : "فشل النشر";

  const [updated] = await db.update(devDeploymentsTable).set(patch)
    .where(eq(devDeploymentsTable.id, deployId)).returning();
  await writeAudit({
    ...auditBase(req), companyId: null, module: "dev_cloud", action: "edit",
    entityType: "dev_deployment", entityId: String(deployId), metadata: { workspaceId: id, status: to },
  });
  res.json({ ok: true, deployment: updated });
});

export default router;
