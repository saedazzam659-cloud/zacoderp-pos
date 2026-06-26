import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  devStudioPackagesTable, devStudioDevelopersTable, devStudioVisibilityTable,
  devStudioSnapshotsTable, devStudioSessionsTable, devStudioUsageTable,
  devStudioAuditTable, devStudioProposalsTable,
  DEV_STUDIO_BILLING_CYCLES, DEV_STUDIO_DEVELOPER_STATUSES,
  type DevStudioEntitlements, type DevStudioDeveloper,
} from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { writeAudit } from "../middleware/permissions.js";
import { extractAuth } from "../middleware/auth.js";
import {
  captureSnapshot, loadSnapshot, scopedPaths, isPathVisible, countLines,
} from "../lib/devStudioSnapshot.js";
import { proposeChange } from "../devstudio/aiOrchestrator.js";

// ─────────────────────────────────────────────────────────────────────────
// DevStudio — "التطوير من خلال زاكود" (additive only).
//
// Two routers, BOTH mounted BEFORE the path-less zatcaRouter (its catch-all
// 401s unmatched /api/* requests):
//   • devStudioRouter      → /dev-studio       (public register/login + developer studio;
//                            developers authenticate via their OWN bearer token kept in
//                            dev_studio_sessions — absent from usersTable.)
//   • devStudioAdminRouter → /admin/dev-studio (SuperAdmin governance; self-guarded.)
//
// Safety model: developers get READ-ONLY scoped access to a frozen snapshot and
// can only PROPOSE diffs. No code ever executes here; no download/clone/terminal.
// ─────────────────────────────────────────────────────────────────────────

const now = () => new Date();
const periodKey = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const newToken = () => randomUUID() + "-" + randomUUID();

function normalizeCycle(v: any): "monthly" | "annual" {
  return DEV_STUDIO_BILLING_CYCLES.includes(v) ? v : "monthly";
}

const DEFAULT_ENTITLEMENTS: DevStudioEntitlements = {
  offices: 1, units: 1, readLineQuota: 5000, writeLineQuota: 1000, billingCycle: "monthly",
};

function effectiveEntitlements(dev: DevStudioDeveloper): DevStudioEntitlements {
  return (dev.entitlements as DevStudioEntitlements | null) ?? DEFAULT_ENTITLEMENTS;
}

// Read-or-create the developer's usage row for the current period.
async function getUsage(developerId: number) {
  const pk = periodKey();
  const [row] = await db.select().from(devStudioUsageTable)
    .where(and(eq(devStudioUsageTable.developerId, developerId), eq(devStudioUsageTable.periodKey, pk)));
  if (row) return row;
  const [created] = await db.insert(devStudioUsageTable)
    .values({ developerId, periodKey: pk, readLinesUsed: 0, writeLinesUsed: 0 })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db.select().from(devStudioUsageTable)
    .where(and(eq(devStudioUsageTable.developerId, developerId), eq(devStudioUsageTable.periodKey, pk)));
  return again;
}

async function audit(developerId: number | null, action: string, path: string | null, lines: number, detail: Record<string, any> = {}) {
  try {
    await db.insert(devStudioAuditTable).values({ developerId, action, path, lines, detail });
  } catch { /* audit must never break a request */ }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Developer auth (kill-switch enforced on EVERY call)
// ═══════════════════════════════════════════════════════════════════════════

async function extractDeveloper(req: Request, res: Response, next: NextFunction): Promise<void> {
  const hdr = req.headers.authorization ?? "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
  if (!token) { res.status(401).json({ error: "غير مصرح" }); return; }
  const [session] = await db.select().from(devStudioSessionsTable)
    .where(eq(devStudioSessionsTable.token, token));
  if (!session || session.status !== "active") { res.status(401).json({ error: "انتهت الجلسة" }); return; }
  const [dev] = await db.select().from(devStudioDevelopersTable)
    .where(eq(devStudioDevelopersTable.id, session.developerId));
  if (!dev) { res.status(401).json({ error: "غير مصرح" }); return; }
  // Instant kill-switch: a suspended/rejected developer is locked out live.
  if (dev.status !== "active") {
    await db.update(devStudioSessionsTable).set({ status: "killed" }).where(eq(devStudioSessionsTable.developerId, dev.id));
    res.status(403).json({ error: "تم إيقاف حسابك. تواصل مع مدير المنصة." });
    return;
  }
  await db.update(devStudioSessionsTable).set({ lastSeenAt: now() }).where(eq(devStudioSessionsTable.id, session.id));
  (req as any).devStudio = { dev, session };
  next();
}

const dev = (req: Request) => (req as any).devStudio.dev as DevStudioDeveloper;

// ═══════════════════════════════════════════════════════════════════════════
//  Public + Developer router  (/dev-studio)
// ═══════════════════════════════════════════════════════════════════════════

export const devStudioRouter = Router();

// ── Public: active packages for the registration form ──────────────────────
devStudioRouter.get("/packages", async (_req, res) => {
  const rows = await db.select().from(devStudioPackagesTable)
    .where(eq(devStudioPackagesTable.isActive, true))
    .orderBy(devStudioPackagesTable.sortOrder, devStudioPackagesTable.id);
  res.json({ packages: rows });
});

// ── Public: self-registration → pending (awaits SuperAdmin approval) ───────
devStudioRouter.post("/register", async (req, res) => {
  const b = req.body ?? {};
  const name = String(b.name ?? "").trim();
  const phone = String(b.phone ?? "").trim();
  const country = String(b.country ?? "").trim();
  const password = String(b.password ?? "");
  const packageId = b.packageId != null && b.packageId !== "" ? parseInt(b.packageId) : null;
  const ndaAccepted = b.ndaAccepted === true;

  if (!name) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
  if (!phone) { res.status(400).json({ error: "رقم الجوال مطلوب" }); return; }
  if (!country) { res.status(400).json({ error: "الدولة مطلوبة" }); return; }
  if (password.length < 8) { res.status(400).json({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" }); return; }
  if (!ndaAccepted) { res.status(400).json({ error: "يجب الموافقة على اتفاقية السرية (NDA)" }); return; }

  const [dup] = await db.select({ id: devStudioDevelopersTable.id }).from(devStudioDevelopersTable)
    .where(eq(devStudioDevelopersTable.phone, phone));
  if (dup) { res.status(409).json({ error: "رقم الجوال مسجّل مسبقاً" }); return; }

  let pkgId: number | null = null;
  let cycle: "monthly" | "annual" = normalizeCycle(b.billingCycle);
  if (packageId && Number.isInteger(packageId)) {
    const [pkg] = await db.select({ id: devStudioPackagesTable.id }).from(devStudioPackagesTable)
      .where(and(eq(devStudioPackagesTable.id, packageId), eq(devStudioPackagesTable.isActive, true)));
    if (pkg) pkgId = pkg.id;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const [created] = await db.insert(devStudioDevelopersTable).values({
    name, phone, country, packageId: pkgId, passwordHash,
    status: "pending", billingCycle: cycle, ndaAcceptedAt: now(),
  }).returning({ id: devStudioDevelopersTable.id });
  await audit(created.id, "register", null, 0, { phone, country });
  res.status(201).json({ ok: true, message: "تم استلام طلبك. سيتم تفعيل الحساب بعد موافقة مدير المنصة." });
});

// ── Public: login (phone + password). Only ACTIVE developers get a token ───
devStudioRouter.post("/login", async (req, res) => {
  const phone = String(req.body?.phone ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (!phone || !password) { res.status(400).json({ error: "البيانات ناقصة" }); return; }
  const [developer] = await db.select().from(devStudioDevelopersTable)
    .where(eq(devStudioDevelopersTable.phone, phone));
  if (!developer) { res.status(401).json({ error: "بيانات الدخول غير صحيحة" }); return; }
  const ok = await bcrypt.compare(password, developer.passwordHash);
  if (!ok) { res.status(401).json({ error: "بيانات الدخول غير صحيحة" }); return; }
  if (developer.status === "pending") { res.status(403).json({ error: "حسابك قيد المراجعة من مدير المنصة." }); return; }
  if (developer.status === "rejected") { res.status(403).json({ error: "تم رفض طلبك." }); return; }
  if (developer.status === "suspended") { res.status(403).json({ error: "حسابك موقوف. تواصل مع مدير المنصة." }); return; }

  const token = newToken();
  await db.insert(devStudioSessionsTable).values({ developerId: developer.id, token, status: "active" });
  await audit(developer.id, "login", null, 0, {});
  res.json({ ok: true, token, developer: { id: developer.id, name: developer.name } });
});

// ── Developer-only below ───────────────────────────────────────────────────
devStudioRouter.use(extractDeveloper);

devStudioRouter.post("/logout", async (req, res) => {
  const { session } = (req as any).devStudio;
  await db.update(devStudioSessionsTable).set({ status: "killed" }).where(eq(devStudioSessionsTable.id, session.id));
  res.json({ ok: true });
});

devStudioRouter.get("/me", async (req, res) => {
  const d = dev(req);
  const ent = effectiveEntitlements(d);
  const usage = await getUsage(d.id);
  let snapshot: { id: number; version: string; label: string | null } | null = null;
  if (d.snapshotId) {
    const [s] = await db.select({ id: devStudioSnapshotsTable.id, version: devStudioSnapshotsTable.version, label: devStudioSnapshotsTable.label })
      .from(devStudioSnapshotsTable).where(eq(devStudioSnapshotsTable.id, d.snapshotId));
    snapshot = s ?? null;
  }
  const visRows = await db.select({ pathPrefix: devStudioVisibilityTable.pathPrefix })
    .from(devStudioVisibilityTable).where(eq(devStudioVisibilityTable.developerId, d.id));
  res.json({
    developer: { id: d.id, name: d.name, phone: d.phone, country: d.country, status: d.status },
    entitlements: ent,
    usage: { readLinesUsed: usage?.readLinesUsed ?? 0, writeLinesUsed: usage?.writeLinesUsed ?? 0, period: periodKey() },
    snapshot,
    allowedPrefixes: visRows.map((r) => r.pathPrefix),
  });
});

// Helper: resolve the developer's assigned snapshot + allowed prefixes.
async function devContext(d: DevStudioDeveloper) {
  if (!d.snapshotId) return { snapshot: null as any, allowed: [] as string[] };
  const [snap] = await db.select().from(devStudioSnapshotsTable)
    .where(eq(devStudioSnapshotsTable.id, d.snapshotId));
  const visRows = await db.select({ pathPrefix: devStudioVisibilityTable.pathPrefix })
    .from(devStudioVisibilityTable).where(eq(devStudioVisibilityTable.developerId, d.id));
  return { snapshot: snap ?? null, allowed: visRows.map((r) => r.pathPrefix) };
}

// ── Scoped file tree (paths only) of the assigned snapshot ─────────────────
devStudioRouter.get("/files", async (req, res) => {
  const d = dev(req);
  const { snapshot, allowed } = await devContext(d);
  if (!snapshot) { res.json({ paths: [], snapshot: null, message: "لم يتم تعيين نسخة للعمل عليها بعد." }); return; }
  if (snapshot.status !== "published") { res.json({ paths: [], snapshot: null, message: "النسخة المعيّنة غير منشورة." }); return; }
  const data = await loadSnapshot(snapshot.id, snapshot.content);
  const paths = scopedPaths(data, allowed);
  res.json({ snapshot: { id: snapshot.id, version: snapshot.version, label: snapshot.label }, paths });
});

// ── Read a single file (scope + read-line quota + audit) ───────────────────
devStudioRouter.get("/file", async (req, res) => {
  const d = dev(req);
  const p = String(req.query.path ?? "").trim();
  if (!p) { res.status(400).json({ error: "المسار مطلوب" }); return; }
  const { snapshot, allowed } = await devContext(d);
  if (!snapshot || snapshot.status !== "published") { res.status(404).json({ error: "لا توجد نسخة منشورة معيّنة" }); return; }
  if (!isPathVisible(p, allowed)) { res.status(403).json({ error: "هذا الملف خارج نطاق صلاحياتك" }); return; }
  const data = await loadSnapshot(snapshot.id, snapshot.content);
  const content = data.files[p];
  if (content === undefined) { res.status(404).json({ error: "الملف غير موجود في النسخة" }); return; }

  const lines = countLines(content);
  const ent = effectiveEntitlements(d);
  const usage = await getUsage(d.id);
  const used = usage?.readLinesUsed ?? 0;
  if (used + lines > ent.readLineQuota) {
    await audit(d.id, "read_denied_quota", p, lines, { used, quota: ent.readLineQuota });
    res.status(429).json({ error: "تجاوزت حد القراءة المسموح لهذه الفترة", used, quota: ent.readLineQuota });
    return;
  }
  await db.update(devStudioUsageTable)
    .set({ readLinesUsed: sql`${devStudioUsageTable.readLinesUsed} + ${lines}`, updatedAt: now() })
    .where(and(eq(devStudioUsageTable.developerId, d.id), eq(devStudioUsageTable.periodKey, periodKey())));
  await audit(d.id, "read_file", p, lines, {});
  res.json({ path: p, content, lines, watermark: `${d.name} • ${d.phone} • DevStudio` });
});

// ── AI propose a diff over scoped files (audited) ──────────────────────────
devStudioRouter.post("/ai/propose", async (req, res) => {
  const d = dev(req);
  const request = String(req.body?.request ?? "").trim();
  const reqPaths: string[] = Array.isArray(req.body?.paths) ? req.body.paths.map((x: any) => String(x)) : [];
  if (!request) { res.status(400).json({ error: "اكتب وصف التعديل المطلوب" }); return; }
  const { snapshot, allowed } = await devContext(d);
  if (!snapshot || snapshot.status !== "published") { res.status(404).json({ error: "لا توجد نسخة منشورة معيّنة" }); return; }
  const data = await loadSnapshot(snapshot.id, snapshot.content);

  // Only pass files the developer is authorized to see.
  const files: { path: string; content: string }[] = [];
  for (const p of reqPaths.slice(0, 8)) {
    if (isPathVisible(p, allowed) && data.files[p] !== undefined) {
      files.push({ path: p, content: data.files[p] });
    }
  }

  // Feeding a file to the AI IS a read — meter it exactly like GET /file so the
  // read-line quota cannot be bypassed via /ai/propose, and audit each file read.
  const totalLines = files.reduce((s, f) => s + countLines(f.content), 0);
  const ent = effectiveEntitlements(d);
  const usage = await getUsage(d.id);
  const used = usage?.readLinesUsed ?? 0;
  if (totalLines > 0 && used + totalLines > ent.readLineQuota) {
    await audit(d.id, "read_denied_quota", files.map((f) => f.path).join(",") || null, totalLines, { used, quota: ent.readLineQuota, via: "ai_propose" });
    res.status(429).json({ error: "تجاوزت حد القراءة المسموح لهذه الفترة", used, quota: ent.readLineQuota });
    return;
  }
  if (totalLines > 0) {
    await db.update(devStudioUsageTable)
      .set({ readLinesUsed: sql`${devStudioUsageTable.readLinesUsed} + ${totalLines}`, updatedAt: now() })
      .where(and(eq(devStudioUsageTable.developerId, d.id), eq(devStudioUsageTable.periodKey, periodKey())));
    for (const f of files) await audit(d.id, "read_file", f.path, countLines(f.content), { via: "ai_propose" });
  }

  const result = await proposeChange({ request, files, developerName: d.name });
  await audit(d.id, "ai_propose", files.map((f) => f.path).join(",") || null, 0, { ok: result.ok, provider: result.provider, reason: result.reason });
  res.json(result);
});

// ── Proposals: list own ────────────────────────────────────────────────────
devStudioRouter.get("/proposals", async (req, res) => {
  const d = dev(req);
  const rows = await db.select().from(devStudioProposalsTable)
    .where(eq(devStudioProposalsTable.developerId, d.id))
    .orderBy(desc(devStudioProposalsTable.createdAt));
  res.json({ proposals: rows });
});

// ── Proposals: create/save (write-line quota enforced) ─────────────────────
devStudioRouter.post("/proposals", async (req, res) => {
  const d = dev(req);
  const b = req.body ?? {};
  const title = String(b.title ?? "").trim();
  if (!title) { res.status(400).json({ error: "العنوان مطلوب" }); return; }
  const diff = b.diff != null ? String(b.diff) : "";
  const writeLines = countLines(diff.trim() ? diff : "");
  const ent = effectiveEntitlements(d);
  const usage = await getUsage(d.id);
  const used = usage?.writeLinesUsed ?? 0;
  if (writeLines > 0 && used + writeLines > ent.writeLineQuota) {
    await audit(d.id, "write_denied_quota", b.targetPath ? String(b.targetPath) : null, writeLines, { used, quota: ent.writeLineQuota });
    res.status(429).json({ error: "تجاوزت حد الكتابة (الأسطر) المسموح لهذه الفترة", used, quota: ent.writeLineQuota });
    return;
  }
  const [created] = await db.insert(devStudioProposalsTable).values({
    developerId: d.id,
    snapshotId: d.snapshotId ?? null,
    title,
    description: b.description ? String(b.description) : null,
    targetPath: b.targetPath ? String(b.targetPath) : null,
    diff: diff || null,
    status: "draft",
    writeLines,
  }).returning();
  if (writeLines > 0) {
    await db.update(devStudioUsageTable)
      .set({ writeLinesUsed: sql`${devStudioUsageTable.writeLinesUsed} + ${writeLines}`, updatedAt: now() })
      .where(and(eq(devStudioUsageTable.developerId, d.id), eq(devStudioUsageTable.periodKey, periodKey())));
  }
  await audit(d.id, "proposal_create", created.targetPath, writeLines, { proposalId: created.id });
  res.status(201).json({ ok: true, proposal: created });
});

// ── Proposals: update own DRAFT ─────────────────────────────────────────────
devStudioRouter.put("/proposals/:id", async (req, res) => {
  const d = dev(req);
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [existing] = await db.select().from(devStudioProposalsTable)
    .where(and(eq(devStudioProposalsTable.id, id), eq(devStudioProposalsTable.developerId, d.id)));
  if (!existing) { res.status(404).json({ error: "المقترح غير موجود" }); return; }
  if (existing.status !== "draft") { res.status(409).json({ error: "لا يمكن تعديل مقترح مُرسَل" }); return; }
  const b = req.body ?? {};
  const patch: Record<string, any> = { updatedAt: now() };
  if (b.title !== undefined) { const v = String(b.title).trim(); if (!v) { res.status(400).json({ error: "العنوان مطلوب" }); return; } patch.title = v; }
  if (b.description !== undefined) patch.description = b.description ? String(b.description) : null;
  if (b.targetPath !== undefined) patch.targetPath = b.targetPath ? String(b.targetPath) : null;

  // Replacing the diff re-meters the write quota on the DELTA vs the proposal's
  // previously-counted writeLines, so a developer cannot stage a tiny draft and
  // then balloon it past quota on update.
  let writeDelta = 0;
  let newWriteLines = existing.writeLines ?? 0;
  if (b.diff !== undefined) {
    const newDiff = b.diff ? String(b.diff) : "";
    newWriteLines = countLines(newDiff.trim() ? newDiff : "");
    writeDelta = newWriteLines - (existing.writeLines ?? 0);
    if (writeDelta > 0) {
      const ent = effectiveEntitlements(d);
      const usage = await getUsage(d.id);
      const used = usage?.writeLinesUsed ?? 0;
      if (used + writeDelta > ent.writeLineQuota) {
        await audit(d.id, "write_denied_quota", existing.targetPath, writeDelta, { used, quota: ent.writeLineQuota, proposalId: id, via: "proposal_update" });
        res.status(429).json({ error: "تجاوزت حد الكتابة (الأسطر) المسموح لهذه الفترة", used, quota: ent.writeLineQuota });
        return;
      }
    }
    patch.diff = newDiff || null;
    patch.writeLines = newWriteLines;
  }
  const [updated] = await db.update(devStudioProposalsTable).set(patch).where(eq(devStudioProposalsTable.id, id)).returning();
  if (writeDelta !== 0) {
    await db.update(devStudioUsageTable)
      .set({ writeLinesUsed: sql`GREATEST(0, ${devStudioUsageTable.writeLinesUsed} + ${writeDelta})`, updatedAt: now() })
      .where(and(eq(devStudioUsageTable.developerId, d.id), eq(devStudioUsageTable.periodKey, periodKey())));
    await audit(d.id, "proposal_update", updated.targetPath, newWriteLines, { proposalId: id, writeDelta });
  }
  res.json({ ok: true, proposal: updated });
});

// ── Proposals: submit (records submission; publish wiring is phase 2) ───────
devStudioRouter.post("/proposals/:id/submit", async (req, res) => {
  const d = dev(req);
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [existing] = await db.select().from(devStudioProposalsTable)
    .where(and(eq(devStudioProposalsTable.id, id), eq(devStudioProposalsTable.developerId, d.id)));
  if (!existing) { res.status(404).json({ error: "المقترح غير موجود" }); return; }
  if (existing.status === "submitted" || existing.status === "published") { res.status(409).json({ error: "تم الإرسال مسبقاً" }); return; }
  const [updated] = await db.update(devStudioProposalsTable)
    .set({ status: "submitted", submittedAt: now(), updatedAt: now() })
    .where(eq(devStudioProposalsTable.id, id)).returning();
  await audit(d.id, "proposal_submit", existing.targetPath, existing.writeLines, { proposalId: id });
  res.json({ ok: true, proposal: updated });
});

// ── Proposals: delete own DRAFT ─────────────────────────────────────────────
devStudioRouter.delete("/proposals/:id", async (req, res) => {
  const d = dev(req);
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const del = await db.delete(devStudioProposalsTable)
    .where(and(eq(devStudioProposalsTable.id, id), eq(devStudioProposalsTable.developerId, d.id), eq(devStudioProposalsTable.status, "draft")))
    .returning({ id: devStudioProposalsTable.id });
  if (!del.length) { res.status(404).json({ error: "المقترح غير موجود أو غير قابل للحذف" }); return; }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
//  SuperAdmin governance router  (/admin/dev-studio)
// ═══════════════════════════════════════════════════════════════════════════

export const devStudioAdminRouter = Router();
devStudioAdminRouter.use(extractAuth);

async function requireSuperAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (u.role !== "superadmin") { res.status(403).json({ error: "هذه الصفحة لمدير المنصة فقط" }); return; }
  next();
}
devStudioAdminRouter.use(requireSuperAdmin);

const auditBase = (req: Request) => ({
  userId: req.authUser?.id ?? null,
  username: req.authUser?.username ?? null,
  role: "superadmin" as const,
});

// ── Overview / meta ─────────────────────────────────────────────────────────
devStudioAdminRouter.get("/", async (_req, res) => {
  const counts = await db.select({ status: devStudioDevelopersTable.status, n: sql<number>`count(*)::int` })
    .from(devStudioDevelopersTable).groupBy(devStudioDevelopersTable.status);
  const [pkgCount] = await db.select({ n: sql<number>`count(*)::int` }).from(devStudioPackagesTable);
  const [snapCount] = await db.select({ n: sql<number>`count(*)::int` }).from(devStudioSnapshotsTable);
  res.json({
    developerCounts: counts,
    packageCount: pkgCount?.n ?? 0,
    snapshotCount: snapCount?.n ?? 0,
    meta: { statuses: DEV_STUDIO_DEVELOPER_STATUSES, billingCycles: DEV_STUDIO_BILLING_CYCLES },
  });
});

// ── Packages CRUD ───────────────────────────────────────────────────────────
devStudioAdminRouter.get("/packages", async (_req, res) => {
  const rows = await db.select().from(devStudioPackagesTable)
    .orderBy(devStudioPackagesTable.sortOrder, devStudioPackagesTable.id);
  res.json({ packages: rows });
});

const intOr = (v: any, def: number) => { const n = parseInt(v); return Number.isFinite(n) && n >= 0 ? n : def; };

devStudioAdminRouter.post("/packages", async (req, res) => {
  const b = req.body ?? {};
  const nameAr = String(b.nameAr ?? "").trim();
  if (!nameAr) { res.status(400).json({ error: "اسم الباقة مطلوب" }); return; }
  const [created] = await db.insert(devStudioPackagesTable).values({
    nameAr, nameEn: b.nameEn ? String(b.nameEn).trim() : null,
    offices: intOr(b.offices, 1), units: intOr(b.units, 1),
    readLineQuota: intOr(b.readLineQuota, 5000), writeLineQuota: intOr(b.writeLineQuota, 1000),
    priceMonthly: intOr(b.priceMonthly, 0), priceAnnual: intOr(b.priceAnnual, 0),
    isActive: b.isActive !== false, sortOrder: intOr(b.sortOrder, 0),
  }).returning();
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "create", entityType: "dev_studio_package", entityId: String(created.id), metadata: { nameAr } });
  res.status(201).json({ ok: true, package: created });
});

devStudioAdminRouter.put("/packages/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [existing] = await db.select().from(devStudioPackagesTable).where(eq(devStudioPackagesTable.id, id));
  if (!existing) { res.status(404).json({ error: "الباقة غير موجودة" }); return; }
  const b = req.body ?? {};
  const patch: Record<string, any> = { updatedAt: now() };
  if (b.nameAr !== undefined) { const v = String(b.nameAr).trim(); if (!v) { res.status(400).json({ error: "اسم الباقة مطلوب" }); return; } patch.nameAr = v; }
  if (b.nameEn !== undefined) patch.nameEn = b.nameEn ? String(b.nameEn).trim() : null;
  if (b.offices !== undefined) patch.offices = intOr(b.offices, existing.offices);
  if (b.units !== undefined) patch.units = intOr(b.units, existing.units);
  if (b.readLineQuota !== undefined) patch.readLineQuota = intOr(b.readLineQuota, existing.readLineQuota);
  if (b.writeLineQuota !== undefined) patch.writeLineQuota = intOr(b.writeLineQuota, existing.writeLineQuota);
  if (b.priceMonthly !== undefined) patch.priceMonthly = intOr(b.priceMonthly, existing.priceMonthly);
  if (b.priceAnnual !== undefined) patch.priceAnnual = intOr(b.priceAnnual, existing.priceAnnual);
  if (b.isActive !== undefined) patch.isActive = b.isActive === true;
  if (b.sortOrder !== undefined) patch.sortOrder = intOr(b.sortOrder, existing.sortOrder);
  const [updated] = await db.update(devStudioPackagesTable).set(patch).where(eq(devStudioPackagesTable.id, id)).returning();
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "edit", entityType: "dev_studio_package", entityId: String(id), metadata: { fields: Object.keys(patch) } });
  res.json({ ok: true, package: updated });
});

devStudioAdminRouter.delete("/packages/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  await db.delete(devStudioPackagesTable).where(eq(devStudioPackagesTable.id, id));
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "delete", entityType: "dev_studio_package", entityId: String(id), metadata: {} });
  res.json({ ok: true });
});

// ── Developers: list / get ──────────────────────────────────────────────────
devStudioAdminRouter.get("/developers", async (req, res) => {
  const status = String(req.query.status ?? "").trim();
  const base = db.select({
    id: devStudioDevelopersTable.id, name: devStudioDevelopersTable.name,
    phone: devStudioDevelopersTable.phone, country: devStudioDevelopersTable.country,
    packageId: devStudioDevelopersTable.packageId, status: devStudioDevelopersTable.status,
    billingCycle: devStudioDevelopersTable.billingCycle, snapshotId: devStudioDevelopersTable.snapshotId,
    entitlements: devStudioDevelopersTable.entitlements, approvedAt: devStudioDevelopersTable.approvedAt,
    createdAt: devStudioDevelopersTable.createdAt,
  }).from(devStudioDevelopersTable);
  const rows = DEV_STUDIO_DEVELOPER_STATUSES.includes(status as any)
    ? await base.where(eq(devStudioDevelopersTable.status, status)).orderBy(desc(devStudioDevelopersTable.createdAt))
    : await base.orderBy(desc(devStudioDevelopersTable.createdAt));
  res.json({ developers: rows });
});

devStudioAdminRouter.get("/developers/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [developer] = await db.select().from(devStudioDevelopersTable).where(eq(devStudioDevelopersTable.id, id));
  if (!developer) { res.status(404).json({ error: "المطوّر غير موجود" }); return; }
  const visibility = await db.select().from(devStudioVisibilityTable)
    .where(eq(devStudioVisibilityTable.developerId, id)).orderBy(devStudioVisibilityTable.pathPrefix);
  const usage = await db.select().from(devStudioUsageTable)
    .where(eq(devStudioUsageTable.developerId, id)).orderBy(desc(devStudioUsageTable.periodKey)).limit(6);
  const proposals = await db.select().from(devStudioProposalsTable)
    .where(eq(devStudioProposalsTable.developerId, id)).orderBy(desc(devStudioProposalsTable.createdAt)).limit(50);
  const { passwordHash, ...safe } = developer;
  res.json({ developer: safe, visibility, usage, proposals });
});

// ── Developers: approve (apply entitlements from package) ───────────────────
devStudioAdminRouter.post("/developers/:id/approve", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [developer] = await db.select().from(devStudioDevelopersTable).where(eq(devStudioDevelopersTable.id, id));
  if (!developer) { res.status(404).json({ error: "المطوّر غير موجود" }); return; }
  const b = req.body ?? {};

  // Resolve the package (body override → developer's chosen package).
  const pkgId = b.packageId != null && b.packageId !== "" ? parseInt(b.packageId) : developer.packageId;
  let entitlements: DevStudioEntitlements = { ...DEFAULT_ENTITLEMENTS, billingCycle: normalizeCycle(b.billingCycle ?? developer.billingCycle) };
  let resolvedPkgId: number | null = developer.packageId;
  if (pkgId && Number.isInteger(pkgId)) {
    const [pkg] = await db.select().from(devStudioPackagesTable).where(eq(devStudioPackagesTable.id, pkgId));
    if (pkg) {
      resolvedPkgId = pkg.id;
      entitlements = {
        offices: pkg.offices, units: pkg.units,
        readLineQuota: pkg.readLineQuota, writeLineQuota: pkg.writeLineQuota,
        billingCycle: normalizeCycle(b.billingCycle ?? developer.billingCycle),
      };
    }
  }
  // Allow explicit per-developer overrides at approval.
  if (b.readLineQuota !== undefined) entitlements.readLineQuota = intOr(b.readLineQuota, entitlements.readLineQuota);
  if (b.writeLineQuota !== undefined) entitlements.writeLineQuota = intOr(b.writeLineQuota, entitlements.writeLineQuota);

  const snapshotId = b.snapshotId != null && b.snapshotId !== "" ? parseInt(b.snapshotId) : developer.snapshotId;

  const [updated] = await db.update(devStudioDevelopersTable).set({
    status: "active", entitlements, packageId: resolvedPkgId,
    billingCycle: entitlements.billingCycle, snapshotId: snapshotId ?? null,
    approvedAt: developer.approvedAt ?? now(), suspendedAt: null, updatedAt: now(),
  }).where(eq(devStudioDevelopersTable.id, id)).returning();
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "approve", entityType: "dev_studio_developer", entityId: String(id), metadata: { entitlements } });
  const { passwordHash, ...safe } = updated;
  res.json({ ok: true, developer: safe });
});

// ── Developers: reject ──────────────────────────────────────────────────────
devStudioAdminRouter.post("/developers/:id/reject", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [updated] = await db.update(devStudioDevelopersTable)
    .set({ status: "rejected", updatedAt: now() }).where(eq(devStudioDevelopersTable.id, id)).returning({ id: devStudioDevelopersTable.id });
  if (!updated) { res.status(404).json({ error: "المطوّر غير موجود" }); return; }
  await db.update(devStudioSessionsTable).set({ status: "killed" }).where(eq(devStudioSessionsTable.developerId, id));
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "reject", entityType: "dev_studio_developer", entityId: String(id), metadata: {} });
  res.json({ ok: true });
});

// ── Developers: suspend (INSTANT kill-switch — revokes live sessions) ───────
devStudioAdminRouter.post("/developers/:id/suspend", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [updated] = await db.update(devStudioDevelopersTable)
    .set({ status: "suspended", suspendedAt: now(), updatedAt: now() }).where(eq(devStudioDevelopersTable.id, id)).returning({ id: devStudioDevelopersTable.id });
  if (!updated) { res.status(404).json({ error: "المطوّر غير موجود" }); return; }
  await db.update(devStudioSessionsTable).set({ status: "killed" }).where(eq(devStudioSessionsTable.developerId, id));
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "suspend", entityType: "dev_studio_developer", entityId: String(id), metadata: {} });
  res.json({ ok: true });
});

// ── Developers: resume ──────────────────────────────────────────────────────
devStudioAdminRouter.post("/developers/:id/resume", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [developer] = await db.select().from(devStudioDevelopersTable).where(eq(devStudioDevelopersTable.id, id));
  if (!developer) { res.status(404).json({ error: "المطوّر غير موجود" }); return; }
  if (!developer.entitlements) { res.status(400).json({ error: "يجب اعتماد المطوّر أولاً" }); return; }
  const [updated] = await db.update(devStudioDevelopersTable)
    .set({ status: "active", suspendedAt: null, updatedAt: now() }).where(eq(devStudioDevelopersTable.id, id)).returning({ id: devStudioDevelopersTable.id });
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "resume", entityType: "dev_studio_developer", entityId: String(id), metadata: {} });
  res.json({ ok: true, developer: updated });
});

// ── Developers: edit (package / entitlements / notes) ──────────────────────
devStudioAdminRouter.put("/developers/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [developer] = await db.select().from(devStudioDevelopersTable).where(eq(devStudioDevelopersTable.id, id));
  if (!developer) { res.status(404).json({ error: "المطوّر غير موجود" }); return; }
  const b = req.body ?? {};
  const patch: Record<string, any> = { updatedAt: now() };
  if (b.name !== undefined) { const v = String(b.name).trim(); if (!v) { res.status(400).json({ error: "الاسم مطلوب" }); return; } patch.name = v; }
  if (b.country !== undefined) patch.country = String(b.country).trim();
  if (b.notes !== undefined) patch.notes = b.notes ? String(b.notes) : null;
  if (b.packageId !== undefined) patch.packageId = b.packageId ? parseInt(b.packageId) : null;
  if (b.entitlements !== undefined && b.entitlements && typeof b.entitlements === "object") {
    const cur = effectiveEntitlements(developer);
    patch.entitlements = {
      offices: intOr(b.entitlements.offices, cur.offices),
      units: intOr(b.entitlements.units, cur.units),
      readLineQuota: intOr(b.entitlements.readLineQuota, cur.readLineQuota),
      writeLineQuota: intOr(b.entitlements.writeLineQuota, cur.writeLineQuota),
      billingCycle: normalizeCycle(b.entitlements.billingCycle ?? cur.billingCycle),
    };
  }
  const [updated] = await db.update(devStudioDevelopersTable).set(patch).where(eq(devStudioDevelopersTable.id, id)).returning();
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "edit", entityType: "dev_studio_developer", entityId: String(id), metadata: { fields: Object.keys(patch) } });
  const { passwordHash, ...safe } = updated;
  res.json({ ok: true, developer: safe });
});

// ── Developers: delete ──────────────────────────────────────────────────────
devStudioAdminRouter.delete("/developers/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  await db.delete(devStudioDevelopersTable).where(eq(devStudioDevelopersTable.id, id));
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "delete", entityType: "dev_studio_developer", entityId: String(id), metadata: {} });
  res.json({ ok: true });
});

// ── Visibility: grant / revoke a path prefix (DEFAULT DENY) ─────────────────
devStudioAdminRouter.post("/developers/:id/visibility", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [developer] = await db.select({ id: devStudioDevelopersTable.id }).from(devStudioDevelopersTable).where(eq(devStudioDevelopersTable.id, id));
  if (!developer) { res.status(404).json({ error: "المطوّر غير موجود" }); return; }
  const prefix = String(req.body?.pathPrefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix) { res.status(400).json({ error: "المسار مطلوب" }); return; }
  const [created] = await db.insert(devStudioVisibilityTable)
    .values({ developerId: id, pathPrefix: prefix }).onConflictDoNothing().returning();
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "create", entityType: "dev_studio_visibility", entityId: String(id), metadata: { pathPrefix: prefix } });
  res.status(201).json({ ok: true, visibility: created ?? null });
});

devStudioAdminRouter.delete("/developers/:id/visibility/:visId", async (req, res) => {
  const id = parseInt(req.params.id);
  const visId = parseInt(req.params.visId);
  if (!Number.isInteger(id) || !Number.isInteger(visId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const del = await db.delete(devStudioVisibilityTable)
    .where(and(eq(devStudioVisibilityTable.id, visId), eq(devStudioVisibilityTable.developerId, id)))
    .returning({ id: devStudioVisibilityTable.id });
  if (!del.length) { res.status(404).json({ error: "غير موجود" }); return; }
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "delete", entityType: "dev_studio_visibility", entityId: String(visId), metadata: { developerId: id } });
  res.json({ ok: true });
});

// ── Developers: assign a snapshot (version distribution) ────────────────────
devStudioAdminRouter.post("/developers/:id/assign-snapshot", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [developer] = await db.select({ id: devStudioDevelopersTable.id }).from(devStudioDevelopersTable).where(eq(devStudioDevelopersTable.id, id));
  if (!developer) { res.status(404).json({ error: "المطوّر غير موجود" }); return; }
  const raw = req.body?.snapshotId;
  let snapshotId: number | null = null;
  if (raw != null && raw !== "") {
    snapshotId = parseInt(raw);
    if (!Number.isInteger(snapshotId)) { res.status(400).json({ error: "نسخة غير صالحة" }); return; }
    const [snap] = await db.select({ id: devStudioSnapshotsTable.id, status: devStudioSnapshotsTable.status })
      .from(devStudioSnapshotsTable).where(eq(devStudioSnapshotsTable.id, snapshotId));
    if (!snap) { res.status(404).json({ error: "النسخة غير موجودة" }); return; }
    if (snap.status !== "published") { res.status(400).json({ error: "يمكن تعيين النسخ المنشورة فقط" }); return; }
  }
  await db.update(devStudioDevelopersTable).set({ snapshotId, updatedAt: now() }).where(eq(devStudioDevelopersTable.id, id));
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "edit", entityType: "dev_studio_developer", entityId: String(id), metadata: { op: "assign_snapshot", snapshotId } });
  res.json({ ok: true, snapshotId });
});

// ── Snapshots: list (no content blob) ───────────────────────────────────────
devStudioAdminRouter.get("/snapshots", async (_req, res) => {
  const rows = await db.select({
    id: devStudioSnapshotsTable.id, version: devStudioSnapshotsTable.version,
    label: devStudioSnapshotsTable.label, status: devStudioSnapshotsTable.status,
    fileCount: devStudioSnapshotsTable.fileCount, byteSize: devStudioSnapshotsTable.byteSize,
    createdAt: devStudioSnapshotsTable.createdAt, publishedAt: devStudioSnapshotsTable.publishedAt,
  }).from(devStudioSnapshotsTable).orderBy(desc(devStudioSnapshotsTable.createdAt));
  res.json({ snapshots: rows });
});

// ── Snapshots: capture a new frozen copy of the current source tree ─────────
devStudioAdminRouter.post("/snapshots", async (req, res) => {
  const b = req.body ?? {};
  const version = (b.version ? String(b.version).trim() : "") ||
    `v${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
  const [dupV] = await db.select({ id: devStudioSnapshotsTable.id }).from(devStudioSnapshotsTable).where(eq(devStudioSnapshotsTable.version, version));
  if (dupV) { res.status(409).json({ error: "رقم النسخة مستخدم" }); return; }
  const { blob, fileCount, byteSize } = await captureSnapshot();
  const [created] = await db.insert(devStudioSnapshotsTable).values({
    version, label: b.label ? String(b.label).trim() : null, status: "draft",
    fileCount, byteSize, content: blob,
  }).returning({ id: devStudioSnapshotsTable.id, version: devStudioSnapshotsTable.version, status: devStudioSnapshotsTable.status, fileCount: devStudioSnapshotsTable.fileCount, byteSize: devStudioSnapshotsTable.byteSize, createdAt: devStudioSnapshotsTable.createdAt });
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "create", entityType: "dev_studio_snapshot", entityId: String(created.id), metadata: { version, fileCount } });
  res.status(201).json({ ok: true, snapshot: created });
});

// ── Snapshots: publish (makes it assignable + readable) ─────────────────────
devStudioAdminRouter.post("/snapshots/:id/publish", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [updated] = await db.update(devStudioSnapshotsTable)
    .set({ status: "published", publishedAt: now() }).where(eq(devStudioSnapshotsTable.id, id))
    .returning({ id: devStudioSnapshotsTable.id, status: devStudioSnapshotsTable.status });
  if (!updated) { res.status(404).json({ error: "النسخة غير موجودة" }); return; }
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "edit", entityType: "dev_studio_snapshot", entityId: String(id), metadata: { op: "publish" } });
  res.json({ ok: true, snapshot: updated });
});

// ── Snapshots: archive ──────────────────────────────────────────────────────
devStudioAdminRouter.post("/snapshots/:id/archive", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [updated] = await db.update(devStudioSnapshotsTable)
    .set({ status: "archived" }).where(eq(devStudioSnapshotsTable.id, id))
    .returning({ id: devStudioSnapshotsTable.id });
  if (!updated) { res.status(404).json({ error: "النسخة غير موجودة" }); return; }
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "edit", entityType: "dev_studio_snapshot", entityId: String(id), metadata: { op: "archive" } });
  res.json({ ok: true });
});

// ── Snapshots: delete ───────────────────────────────────────────────────────
devStudioAdminRouter.delete("/snapshots/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  // Un-assign any developer on this snapshot first (FK is soft / no cascade).
  await db.update(devStudioDevelopersTable).set({ snapshotId: null }).where(eq(devStudioDevelopersTable.snapshotId, id));
  await db.delete(devStudioSnapshotsTable).where(eq(devStudioSnapshotsTable.id, id));
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "delete", entityType: "dev_studio_snapshot", entityId: String(id), metadata: {} });
  res.json({ ok: true });
});

// ── Audit log (recent; optional developer filter) ──────────────────────────
devStudioAdminRouter.get("/audit", async (req, res) => {
  const devId = req.query.developerId ? parseInt(String(req.query.developerId)) : null;
  const q = db.select().from(devStudioAuditTable);
  const rows = Number.isInteger(devId)
    ? await q.where(eq(devStudioAuditTable.developerId, devId as number)).orderBy(desc(devStudioAuditTable.createdAt)).limit(300)
    : await q.orderBy(desc(devStudioAuditTable.createdAt)).limit(300);
  res.json({ audit: rows });
});

// ── Proposals (all developers; optional status filter) ─────────────────────
devStudioAdminRouter.get("/proposals", async (req, res) => {
  const status = String(req.query.status ?? "").trim();
  const rows = await db.select({
    id: devStudioProposalsTable.id, developerId: devStudioProposalsTable.developerId,
    developerName: devStudioDevelopersTable.name, title: devStudioProposalsTable.title,
    targetPath: devStudioProposalsTable.targetPath, status: devStudioProposalsTable.status,
    writeLines: devStudioProposalsTable.writeLines, createdAt: devStudioProposalsTable.createdAt,
    submittedAt: devStudioProposalsTable.submittedAt,
  }).from(devStudioProposalsTable)
    .leftJoin(devStudioDevelopersTable, eq(devStudioDevelopersTable.id, devStudioProposalsTable.developerId))
    .orderBy(desc(devStudioProposalsTable.createdAt)).limit(300);
  const filtered = status ? rows.filter((r) => r.status === status) : rows;
  res.json({ proposals: filtered });
});

// ── Proposal detail (with diff) ─────────────────────────────────────────────
devStudioAdminRouter.get("/proposals/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [proposal] = await db.select().from(devStudioProposalsTable).where(eq(devStudioProposalsTable.id, id));
  if (!proposal) { res.status(404).json({ error: "المقترح غير موجود" }); return; }
  res.json({ proposal });
});

// ── Proposal status (publish / reject — MVP records the decision) ──────────
devStudioAdminRouter.post("/proposals/:id/status", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const to = String(req.body?.status ?? "").trim();
  if (!["published", "rejected"].includes(to)) { res.status(400).json({ error: "حالة غير صالحة" }); return; }
  const [updated] = await db.update(devStudioProposalsTable)
    .set({ status: to, updatedAt: now() }).where(eq(devStudioProposalsTable.id, id))
    .returning({ id: devStudioProposalsTable.id, status: devStudioProposalsTable.status });
  if (!updated) { res.status(404).json({ error: "المقترح غير موجود" }); return; }
  await writeAudit({ ...auditBase(req), companyId: null, module: "dev_studio", action: "edit", entityType: "dev_studio_proposal", entityId: String(id), metadata: { status: to } });
  res.json({ ok: true, proposal: updated });
});
