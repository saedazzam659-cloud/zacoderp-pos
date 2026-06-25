import { Router, type Request, type Response, type NextFunction } from "express";
import { db, extensionPublishesTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { writeAudit } from "../middleware/permissions.js";
import { extractAuth } from "../middleware/auth.js";
import { listBuiltins } from "../extensions/registry.js";
import { runPublishPipeline } from "../extensions/publish.js";

// ─────────────────────────────────────────────────────────────────────────
// Extension Platform — Phase 3: Publish Engine routes.
// Mounted at /api/admin/publish. SuperAdmin-only (self-guarded), strictly
// additive — touches ONLY the new extension_publishes table + the catalog
// upsert performed inside the pipeline. Every publish event writes an
// immutable audit_log row.
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

function auditBase(req: Request) {
  const u = req.authUser!;
  return {
    userId: u.id ?? null,
    username: u.username ?? null,
    role: u.role ?? null,
    companyId: null,
    module: "extension_publish",
    method: req.method,
    path: req.originalUrl,
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  };
}

// Discovery: builtin manifests the developer can publish from the UI as a
// starting point (so the page is demonstrable without hand-authoring JSON).
router.get("/builtins", (_req: Request, res: Response) => {
  res.json({
    builtins: listBuiltins().map((b) => ({
      extensionId: b.extensionId,
      manifest: b.manifest,
    })),
  });
});

// List recent publish runs (newest first).
router.get("/", async (_req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(extensionPublishesTable)
    .orderBy(desc(extensionPublishesTable.createdAt))
    .limit(100);
  res.json({ runs: rows });
});

// Fetch a single run.
router.get("/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "مُعرّف غير صالح" }); return; }
  const rows = await db
    .select()
    .from(extensionPublishesTable)
    .where(eq(extensionPublishesTable.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json({ run: row });
});

// Trigger a publish run. Body: { manifest, partnerId? }.
router.post("/", async (req: Request, res: Response) => {
  const u = req.authUser!;
  const manifest = req.body?.manifest;
  if (!manifest || typeof manifest !== "object") {
    res.status(400).json({ error: "البيان (manifest) مطلوب" });
    return;
  }
  const partnerId = Number.isInteger(req.body?.partnerId) ? Number(req.body.partnerId) : null;

  let outcome;
  try {
    outcome = await runPublishPipeline({ manifest });
  } catch (err) {
    req.log?.error({ err }, "publish pipeline crashed");
    res.status(500).json({ error: "تعذّر تنفيذ خط النشر" });
    return;
  }

  // Persist the run (durable, queryable audit trail of the distribution layer).
  const [row] = await db
    .insert(extensionPublishesTable)
    .values({
      extensionId: outcome.extensionId || "unknown",
      version: outcome.version || "0.0.0",
      partnerId,
      submittedManifest: manifest,
      status: outcome.status,
      currentStage: outcome.currentStage,
      gates: outcome.gates,
      report: outcome.report,
      packageDigest: outcome.packageDigest,
      signature: outcome.signature,
      publicKeyId: outcome.publicKeyId,
      deployedAt: outcome.deployed ? new Date() : null,
      createdBy: u.id ?? null,
      createdByUsername: u.username ?? null,
    })
    .returning();

  // Immutable audit entry for the publish event.
  await writeAudit({
    ...auditBase(req),
    action: `publish:${outcome.status}`,
    entityType: "extension_publish",
    entityId: row?.id != null ? String(row.id) : outcome.extensionId,
    statusCode: 200,
    metadata: {
      extensionId: outcome.extensionId,
      version: outcome.version,
      status: outcome.status,
      blockedAt: outcome.report.blockedAt,
      deployed: outcome.deployed,
      gates: outcome.gates.map((g) => ({ stage: g.stage, status: g.status })),
    },
  });

  res.json({ run: row, outcome });
});

export default router;
