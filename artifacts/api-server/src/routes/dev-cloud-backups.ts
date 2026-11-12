import { Router, type Request, type Response, type NextFunction } from "express";
import { centralDb, agentInstancesTable, devCloudBackupsTable, devCloudBackupOperationsTable } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractAuth } from "../middleware/auth.js";
import { writeAudit } from "../middleware/permissions.js";
import { logger } from "../lib/logger.js";
import {
  buildBackupBundle,
  createEncryptedBackupObject,
  downloadVerifiedBackup,
  dumpPostgresDatabase,
  publicBackupRow,
  restoreAgentCodeFromBackup,
  sanitizeBackupLabel,
  uploadEncryptedBackupToAgent,
} from "../lib/devCloudBackups.js";
import { decryptSecret } from "../lib/encryption.js";
import { buildReleaseFromDist, findDistDir, getReleaseInfo } from "../lib/agentRelease.js";
import {
  CreateDevCloudBackupBody,
  CreateDevCloudBackupResponse,
  ListDevCloudBackupsResponse,
  RestoreDevCloudBackupToAgentBody,
  RestoreDevCloudBackupToAgentResponse,
  UploadDevCloudBackupToAgentBody,
  UploadDevCloudBackupToAgentResponse,
} from "@workspace/api-zod";

const router = Router();
router.use(extractAuth);

async function requireSuperAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (req.authUser.role !== "superadmin") { res.status(403).json({ error: "هذه الصفحة لمدير المنصة فقط" }); return; }
  next();
}
router.use(requireSuperAdmin);

const actor = (req: Request) => ({
  createdByUserId: req.authUser?.id ?? null,
  createdByUsername: req.authUser?.username ?? null,
});

const publicOperation = (row: any) => ({
  id: row.id,
  backupId: row.backupId,
  action: row.action,
  targetType: row.targetType,
  targetAgentId: row.targetAgentId,
  targetLabel: row.targetLabel,
  status: row.status,
  message: row.message,
  error: row.error,
  createdAt: row.createdAt,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
});

function numericParam(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

async function findAgent(agentId: number) {
  const [agent] = await centralDb.select().from(agentInstancesTable)
    .where(eq(agentInstancesTable.id, agentId)).limit(1);
  return agent;
}

async function findBackup(backupId: number) {
  const [backup] = await centralDb.select().from(devCloudBackupsTable)
    .where(eq(devCloudBackupsTable.id, backupId)).limit(1);
  return backup;
}

function backupMetadata(row: any) {
  return {
    id: row.id,
    objectPath: row.objectPath,
    bundleSha256: row.bundleSha256,
    encryptedSha256: row.encryptedSha256,
    bundleSizeBytes: row.bundleSizeBytes,
    encryptionSalt: row.encryptionSalt,
    encryptionIv: row.encryptionIv,
    encryptionTag: row.encryptionTag,
    releaseVersion: row.releaseVersion,
  };
}

function startOperation(operationId: number): void {
  setImmediate(() => {
    void runOperation(operationId).catch(() => {
      logger.error({ operationId }, "Developer Cloud backup worker ended unexpectedly");
    });
  });
}

async function runOperation(operationId: number): Promise<void> {
  const [operation] = await centralDb.select().from(devCloudBackupOperationsTable)
    .where(eq(devCloudBackupOperationsTable.id, operationId)).limit(1);
  if (!operation || operation.status !== "queued") return;
  const [claimed] = await centralDb.update(devCloudBackupOperationsTable).set({
    status: "running",
    startedAt: new Date(),
    message: operation.action === "create" ? "جارٍ إنشاء النسخة" :
      operation.action === "restore" ? "جارٍ استعادة ملفات التطبيق فقط" : "جارٍ رفع النسخة المشفرة",
  }).where(and(
    eq(devCloudBackupOperationsTable.id, operationId),
    eq(devCloudBackupOperationsTable.status, "queued"),
  )).returning();
  if (!claimed) return;

  try {
    const backup = await findBackup(operation.backupId);
    if (!backup) throw new Error("backup-not-found");

    if (operation.action === "create") {
      await createBackup(backup);
    } else {
      if (backup.status !== "ready") throw new Error("backup-not-ready");
      if (!operation.targetAgentId) throw new Error("agent-not-selected");
      const agent = await findAgent(operation.targetAgentId);
      if (!agent) throw new Error("agent-not-found");
      let message: string;
      if (operation.action === "upload") {
        const remotePath = await uploadEncryptedBackupToAgent({
          agent,
          backupId: backup.id,
          row: backupMetadata(backup),
        });
        message = `تم حفظ النسخة المشفرة على السيرفر: ${remotePath}`;
      } else if (operation.action === "restore") {
        const result = await restoreAgentCodeFromBackup({
          agent,
          backupId: backup.id,
          row: backupMetadata(backup),
        });
        message = `تمت استعادة التطبيق إلى الإصدار ${result.targetVersion}. لم يتم استيراد قاعدة البيانات.`;
      } else {
        throw new Error("unsupported-operation");
      }
      await centralDb.update(devCloudBackupOperationsTable).set({
        status: "completed",
        message,
        completedAt: new Date(),
      }).where(eq(devCloudBackupOperationsTable.id, operationId));
    }
  } catch (error) {
    const publicMessage = operation.action === "create"
      ? "فشل إنشاء النسخة. تحقق من اتصال قاعدة البيانات والتخزين ثم أعد المحاولة."
      : operation.action === "upload"
        ? "فشل رفع النسخة إلى السيرفر. تحقق من SSH والمساحة المتاحة."
        : "فشلت استعادة التطبيق. لم يتم استيراد ملف قاعدة البيانات.";
    if (operation.action === "create") {
      await centralDb.update(devCloudBackupsTable).set({
        status: "failed",
        error: publicMessage,
        updatedAt: new Date(),
      }).where(eq(devCloudBackupsTable.id, operation.backupId));
    }
    await centralDb.update(devCloudBackupOperationsTable).set({
      status: "failed",
      error: publicMessage,
      completedAt: new Date(),
    }).where(eq(devCloudBackupOperationsTable.id, operationId));
    logger.error({
      operationId,
      backupId: operation.backupId,
      action: operation.action,
      errorClass: error instanceof Error ? error.name : "unknown",
    }, "Developer Cloud backup operation failed");
  }
}

async function createBackup(backup: typeof devCloudBackupsTable.$inferSelect): Promise<void> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "dev-cloud-create-"));
  try {
    const distDir = await findDistDir();
    const sourceArchivePath = path.join(distDir, "dev-cloud-source.tar.gz");
    await fs.access(sourceArchivePath);
    const release = await getReleaseInfo().catch(async () => buildReleaseFromDist(distDir));
    const databaseDumpPath = path.join(workDir, "database.dump");
    let databaseUrl: string;
    let sourceAgent: Awaited<ReturnType<typeof findAgent>> | undefined;

    if (backup.sourceType === "central") {
      databaseUrl = process.env.DATABASE_URL ?? "";
    } else {
      if (!backup.sourceAgentId) throw new Error("agent-not-selected");
      sourceAgent = await findAgent(backup.sourceAgentId);
      if (!sourceAgent || sourceAgent.status !== "active" || sourceAgent.mode !== "full") {
        throw new Error("source-agent-unavailable");
      }
      if (!sourceAgent.dbUrlEnc || sourceAgent.dbStatus !== "initialized") {
        throw new Error("source-agent-db-unavailable");
      }
      databaseUrl = decryptSecret(sourceAgent.dbUrlEnc) ?? "";
    }
    if (!databaseUrl) throw new Error("database-url-unavailable");

    await dumpPostgresDatabase(databaseUrl, databaseDumpPath, sourceAgent);
    const runtimePath = path.join(workDir, "runtime-release.tgz");
    const sourcePath = path.join(workDir, "source-code.tar.gz");
    await fs.copyFile(release.tarPath, runtimePath);
    await fs.copyFile(sourceArchivePath, sourcePath);
    const built = await buildBackupBundle({
      workDir,
      releaseArchivePath: runtimePath,
      sourceArchivePath: sourcePath,
      databaseDumpPath,
      releaseVersion: release.version,
      releaseSha256: release.sha256,
      sourceLabel: backup.sourceLabel,
      sourceType: backup.sourceType as "central" | "agent",
      sourceAgentId: backup.sourceAgentId,
    });
    const encrypted = await createEncryptedBackupObject(built.bundlePath, backup.id);
    await centralDb.update(devCloudBackupsTable).set({
      releaseVersion: release.version,
      releaseSha256: release.sha256,
      sourceSha256: built.sourceSha256,
      databaseSha256: built.databaseSha256,
      bundleSha256: encrypted.bundleSha256,
      encryptedSha256: encrypted.encryptedSha256,
      bundleSizeBytes: encrypted.bundleSizeBytes,
      objectPath: encrypted.objectPath,
      encryptionSalt: encrypted.crypto.salt,
      encryptionIv: encrypted.crypto.iv,
      encryptionTag: encrypted.crypto.tag,
      status: "ready",
      error: null,
      updatedAt: new Date(),
    }).where(eq(devCloudBackupsTable.id, backup.id));
    const [createOperation] = await centralDb.select({ id: devCloudBackupOperationsTable.id })
      .from(devCloudBackupOperationsTable)
      .where(and(
        eq(devCloudBackupOperationsTable.backupId, backup.id),
        eq(devCloudBackupOperationsTable.action, "create"),
      )).orderBy(desc(devCloudBackupOperationsTable.id)).limit(1);
    if (createOperation) {
      await centralDb.update(devCloudBackupOperationsTable).set({
        status: "completed",
        message: `اكتملت النسخة. حجم الحزمة ${(encrypted.bundleSizeBytes / (1024 * 1024)).toFixed(1)} م.ب.`,
        completedAt: new Date(),
      }).where(eq(devCloudBackupOperationsTable.id, createOperation.id));
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function queueOperation(input: {
  backupId: number;
  action: "create" | "upload" | "restore";
  targetType: "central" | "agent";
  targetAgentId?: number | null;
  targetLabel: string;
  createdByUserId: number | null;
  createdByUsername: string | null;
}) {
  const [operation] = await centralDb.insert(devCloudBackupOperationsTable).values({
    backupId: input.backupId,
    action: input.action,
    targetType: input.targetType,
    targetAgentId: input.targetAgentId ?? null,
    targetLabel: input.targetLabel,
    createdByUserId: input.createdByUserId,
    createdByUsername: input.createdByUsername,
  }).returning();
  startOperation(operation.id);
  return operation;
}

router.get("/backups", async (req, res): Promise<void> => {
  const [backups, operations, agents] = await Promise.all([
    centralDb.select().from(devCloudBackupsTable)
      .orderBy(desc(devCloudBackupsTable.createdAt)).limit(100),
    centralDb.select().from(devCloudBackupOperationsTable)
      .orderBy(desc(devCloudBackupOperationsTable.createdAt)).limit(100),
    centralDb.select({
      id: agentInstancesTable.id,
      name: agentInstancesTable.name,
      domain: agentInstancesTable.domain,
      status: agentInstancesTable.status,
      mode: agentInstancesTable.mode,
      dbStatus: agentInstancesTable.dbStatus,
      dbUrlEnc: agentInstancesTable.dbUrlEnc,
      sshHost: agentInstancesTable.sshHost,
      sshUser: agentInstancesTable.sshUser,
      sshSecretEnc: agentInstancesTable.sshSecretEnc,
      sshHostKeyFp: agentInstancesTable.sshHostKeyFp,
    }).from(agentInstancesTable)
      .where(and(eq(agentInstancesTable.mode, "full"), eq(agentInstancesTable.status, "active")))
      .orderBy(agentInstancesTable.name),
  ]);
  res.json(ListDevCloudBackupsResponse.parse({
    backups: backups.map(publicBackupRow),
    operations: operations.map(publicOperation),
    agentTargets: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      domain: agent.domain,
      status: agent.status,
      databaseReady: Boolean(agent.dbUrlEnc && agent.dbStatus === "initialized"),
      sshReady: Boolean(agent.sshHost && agent.sshUser && agent.sshSecretEnc && agent.sshHostKeyFp),
    })),
    replitRestoreMode: "manual_checkpoint_and_publish",
  }));
});

router.post("/backups", async (req, res): Promise<void> => {
  const parsed = CreateDevCloudBackupBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "بيانات طلب النسخة غير صالحة" }); return; }
  const body = parsed.data;
  if (body.sourceType === "agent" && !body.sourceAgentId) {
    res.status(400).json({ error: "اختر سيرفر الوكيل المصدر" });
    return;
  }
  if (body.sourceType === "central" && body.sourceAgentId) {
    res.status(400).json({ error: "معرّف الوكيل غير مطلوب للمصدر المركزي" });
    return;
  }
  let sourceLabel = "المركزية (Replit)";
  if (body.sourceType === "agent") {
    const source = await findAgent(body.sourceAgentId!);
    if (!source || source.status !== "active" || source.mode !== "full"
        || !source.dbUrlEnc || source.dbStatus !== "initialized") {
      res.status(400).json({ error: "الوكيل المحدد غير نشط أو لا يملك قاعدة بيانات مهيأة" });
      return;
    }
    sourceLabel = `${source.name} — ${source.domain}`;
  }
  const pending = await centralDb.select({ id: devCloudBackupOperationsTable.id })
    .from(devCloudBackupOperationsTable)
    .where(and(
      eq(devCloudBackupOperationsTable.action, "create"),
      inArray(devCloudBackupOperationsTable.status, ["queued", "running"]),
    )).limit(1);
  if (pending.length) { res.status(409).json({ error: "توجد نسخة أخرى قيد الإنشاء؛ انتظر اكتمالها" }); return; }

  const [backup] = await centralDb.insert(devCloudBackupsTable).values({
    label: sanitizeBackupLabel(body.label),
    sourceType: body.sourceType,
    sourceAgentId: body.sourceAgentId ?? null,
    sourceLabel,
    releaseVersion: "pending",
    releaseSha256: "pending",
    sourceSha256: "pending",
    databaseSha256: "pending",
    bundleSha256: "",
    encryptedSha256: "",
    bundleSizeBytes: 0,
    objectPath: "",
    encryptionSalt: "",
    encryptionIv: "",
    encryptionTag: "",
    status: "creating",
    ...actor(req),
  }).returning();
  const operation = await queueOperation({
    backupId: backup.id,
    action: "create",
    targetType: "central",
    targetLabel: "التخزين المركزي",
    ...actor(req),
  });
  await writeAudit({
    userId: req.authUser!.id,
    username: req.authUser!.username,
    role: "superadmin",
    companyId: null,
    module: "dev_cloud",
    action: "create",
    entityType: "dev_cloud_backup",
    entityId: String(backup.id),
    metadata: { sourceType: body.sourceType, sourceAgentId: body.sourceAgentId ?? null },
  });
  res.status(202).json(CreateDevCloudBackupResponse.parse({
    ok: true, backup: publicBackupRow(backup), operation: publicOperation(operation),
  }));
});

router.get("/backups/:backupId/download", async (req, res): Promise<void> => {
  const id = numericParam(req.params.backupId);
  if (!id) { res.status(400).json({ error: "معرّف النسخة غير صالح" }); return; }
  const backup = await findBackup(id);
  if (!backup || backup.status !== "ready") { res.status(404).json({ error: "النسخة غير موجودة أو لم تكتمل" }); return; }
  const materialized = await downloadVerifiedBackup(backupMetadata(backup));
  const filename = `zacod-dev-cloud-backup-${backup.id}.tar.gz`;
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Content-Length", String(backup.bundleSizeBytes));
  const stream = createReadStream(materialized.bundlePath);
  stream.on("error", () => {
    if (!res.headersSent) res.status(500).json({ error: "تعذر تنزيل النسخة" });
    else res.destroy();
    void fs.rm(materialized.dir, { recursive: true, force: true }).catch(() => {});
  });
  stream.on("close", () => { void fs.rm(materialized.dir, { recursive: true, force: true }).catch(() => {}); });
  await writeAudit({
    userId: req.authUser!.id,
    username: req.authUser!.username,
    role: "superadmin",
    companyId: null,
    module: "dev_cloud",
    action: "export",
    entityType: "dev_cloud_backup",
    entityId: String(backup.id),
    metadata: { action: "download" },
  });
  stream.pipe(res);
});

async function validateAgentTarget(
  res: Response,
  body: { targetAgentId: number },
  action: "upload" | "restore",
) {
  const agent = await findAgent(body.targetAgentId);
  if (!agent || agent.status !== "active" || agent.mode !== "full") {
    res.status(404).json({ error: "سيرفر الوكيل غير موجود أو غير نشط" });
    return null;
  }
  const pending = await centralDb.select({ id: devCloudBackupOperationsTable.id })
    .from(devCloudBackupOperationsTable)
    .where(and(
      eq(devCloudBackupOperationsTable.targetAgentId, agent.id),
      inArray(devCloudBackupOperationsTable.status, ["queued", "running"]),
    )).limit(1);
  if (pending.length) {
    res.status(409).json({ error: "توجد عملية نسخ أو استعادة أخرى على هذا السيرفر" });
    return null;
  }
  const sshReady = Boolean(agent.sshHost && agent.sshUser && agent.sshSecretEnc && agent.sshHostKeyFp);
  if (!sshReady) {
    res.status(400).json({ error: "اختبر اتصال SSH وبصمة الخادم أولًا من شاشة سيرفرات الوكلاء" });
    return null;
  }
  if (action === "restore" && !agent.sshHostKeyFp) {
    res.status(400).json({ error: "استعادة التطبيق تتطلب بصمة SSH مثبتة مسبقًا" });
    return null;
  }
  return agent;
}

router.post("/backups/:backupId/upload", async (req, res): Promise<void> => {
  const id = numericParam(req.params.backupId);
  if (!id) { res.status(400).json({ error: "معرّف النسخة غير صالح" }); return; }
  const parsed = UploadDevCloudBackupToAgentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "اختر سيرفر الوكيل" }); return; }
  const backup = await findBackup(id);
  if (!backup || backup.status !== "ready") { res.status(404).json({ error: "النسخة غير موجودة أو لم تكتمل" }); return; }
  const agent = await validateAgentTarget(res, parsed.data, "upload");
  if (!agent) return;
  const operation = await queueOperation({
    backupId: id,
    action: "upload",
    targetType: "agent",
    targetAgentId: agent.id,
    targetLabel: `${agent.name} — ${agent.domain}`,
    ...actor(req),
  });
  await writeAudit({
    userId: req.authUser!.id,
    username: req.authUser!.username,
    role: "superadmin",
    companyId: null,
    module: "dev_cloud",
    action: "create",
    entityType: "dev_cloud_backup_operation",
    entityId: String(operation.id),
    metadata: { backupId: id, operation: "upload", targetAgentId: agent.id },
  });
  res.status(202).json(UploadDevCloudBackupToAgentResponse.parse({
    ok: true, operation: publicOperation(operation),
  }));
});

router.post("/backups/:backupId/restore-agent", async (req, res): Promise<void> => {
  const id = numericParam(req.params.backupId);
  if (!id) { res.status(400).json({ error: "معرّف النسخة غير صالح" }); return; }
  const parsed = RestoreDevCloudBackupToAgentBody.safeParse(req.body);
  if (!parsed.success || parsed.data.confirm !== true) {
    res.status(400).json({ error: "يجب تأكيد استعادة ملفات التطبيق فقط" });
    return;
  }
  const backup = await findBackup(id);
  if (!backup || backup.status !== "ready") { res.status(404).json({ error: "النسخة غير موجودة أو لم تكتمل" }); return; }
  const agent = await validateAgentTarget(res, parsed.data, "restore");
  if (!agent) return;
  const operation = await queueOperation({
    backupId: id,
    action: "restore",
    targetType: "agent",
    targetAgentId: agent.id,
    targetLabel: `${agent.name} — ${agent.domain}`,
    ...actor(req),
  });
  await writeAudit({
    userId: req.authUser!.id,
    username: req.authUser!.username,
    role: "superadmin",
    companyId: null,
    module: "dev_cloud",
    action: "edit",
    entityType: "dev_cloud_backup_operation",
    entityId: String(operation.id),
    metadata: { backupId: id, operation: "restore_code_only", targetAgentId: agent.id },
  });
  res.status(202).json(RestoreDevCloudBackupToAgentResponse.parse({
    ok: true, operation: publicOperation(operation),
  }));
});

export default router;
