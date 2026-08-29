import bcrypt from "bcryptjs";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import {
  centralDb,
  centralPool,
  companiesTable,
  db,
  runWithExternalDb,
  subscriptionsTable,
  usersTable,
  type ExternalDbContext,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { getAgentDbContext } from "./agentDb.js";
import { listInitializedAgents } from "./agentScope.js";
import {
  buildFullCompanyBackup,
  isExternalFileReference,
  preflightFullCompanyBackup,
  resetTransferredZatcaIdentity,
  restoreFullCompanyBackup,
  type FullCompanyPayload,
} from "./fullCompanyBackup.js";
import {
  buildPortableBackupPackage,
  preflightPortableBackupPackage,
  restorePortableBackupPackage,
} from "./companyBackupPackage.js";
import { ObjectStorageService } from "./objectStorage.js";
import {
  assertAgentSshTransferReady,
  exportAgentPortablePackage,
  restoreAgentPortablePackage,
} from "./agentSshTransfer.js";
import {
  withPostSuccessCleanupWarning,
} from "./companyTransferCleanup.js";

export type TransferLocation = { kind: "central" } | { kind: "agent"; agentId: number };

export type TransferAdmin = {
  username: string;
  password: string;
  nameAr?: string | null;
  nameEn?: string | null;
  email?: string | null;
};

type SourceBundle = {
  company: typeof companiesTable.$inferSelect;
  subscription: typeof subscriptionsTable.$inferSelect | null;
  payload: FullCompanyPayload;
};

const centralContext: ExternalDbContext = { db: centralDb as any, pool: centralPool as any };

export function parseTransferLocation(value: unknown): TransferLocation {
  if (value === "central" || (value as any)?.kind === "central") return { kind: "central" };
  const text = typeof value === "string" ? value : "";
  const match = /^agent:(\d+)$/.exec(text);
  const candidate = match ? Number(match[1]) : Number((value as any)?.agentId);
  if (!Number.isInteger(candidate) || candidate <= 0) throw new Error("موقع الشركة غير صالح");
  return { kind: "agent", agentId: candidate };
}

export function transferLocationKey(location: TransferLocation): string {
  return location.kind === "central" ? "central" : `agent:${location.agentId}`;
}

export function sameTransferLocation(a: TransferLocation, b: TransferLocation): boolean {
  return transferLocationKey(a) === transferLocationKey(b);
}

async function contextFor(location: TransferLocation): Promise<ExternalDbContext> {
  if (location.kind === "central") return centralContext;
  const agent = (await listInitializedAgents()).find((row) => row.id === location.agentId);
  if (!agent) throw new Error("الوكيل غير موجود أو قاعدة بياناته غير مهيأة");
  if (!agent.lastHeartbeatAt || Date.now() - new Date(agent.lastHeartbeatAt).getTime() >= 5 * 60_000) {
    throw new Error(`الوكيل «${agent.name}» غير متصل حاليًا؛ أعد الاتصال قبل نقل الشركة`);
  }
  return getAgentDbContext(agent.id, agent.dbUrlEnc);
}

export async function withTransferLocation<T>(
  location: TransferLocation,
  fn: () => Promise<T>,
): Promise<T> {
  const context = await contextFor(location);
  return await runWithExternalDb(context, fn);
}

export async function listTransferCompanies(location: TransferLocation) {
  return withTransferLocation(location, async () =>
    db.select({
      id: companiesTable.id,
      code: companiesTable.code,
      nameAr: companiesTable.nameAr,
      nameEn: companiesTable.nameEn,
      vatNumber: companiesTable.vatNumber,
      status: companiesTable.status,
    }).from(companiesTable).orderBy(companiesTable.nameAr));
}

function rowValue(row: Record<string, unknown> | null, snake: string): unknown {
  if (!row) return undefined;
  const camel = snake.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return row[snake] ?? row[camel];
}

export function withoutPortableFiles(payload: FullCompanyPayload): FullCompanyPayload {
  const clone = JSON.parse(JSON.stringify(payload)) as FullCompanyPayload;
  let removed = 0;
  for (const rows of Object.values(clone.data)) {
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        if (!isExternalFileReference(column, value)) continue;
        row[column] = null;
        removed++;
      }
    }
  }
  if (clone.companySettings) {
    for (const [column, value] of Object.entries(clone.companySettings)) {
      if (!isExternalFileReference(column, value)) continue;
      clone.companySettings[column] = null;
      removed++;
    }
  }
  clone.meta.files = {
    mode: "references_only",
    referenced: 0,
    warning: removed ? `تم استبعاد ${removed} مرجع ملف من النقل المباشر بدون مرفقات.` : null,
  };
  return clone;
}

export function resetTargetZatcaIdentity(payload: FullCompanyPayload): FullCompanyPayload {
  return resetTransferredZatcaIdentity(payload);
}

export async function buildTransferSource(
  location: TransferLocation,
  companyId: number,
  exportedBy: string | null,
): Promise<SourceBundle> {
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error("الشركة المصدر غير صالحة");
  return withTransferLocation(location, async () => {
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
    if (!company || company.deletedAt) throw new Error("الشركة المصدر غير موجودة");
    const [subscription] = await db.select().from(subscriptionsTable)
      .where(eq(subscriptionsTable.companyId, companyId))
      .orderBy(desc(subscriptionsTable.createdAt)).limit(1);
    const { payload } = await buildFullCompanyBackup(companyId, exportedBy);
    return { company, subscription: subscription ?? null, payload };
  });
}

async function createTargetShell(
  payload: FullCompanyPayload,
  subscription: SourceBundle["subscription"],
  admin: TransferAdmin,
): Promise<{ companyId: number; companyCode: string; adminUserId: number }> {
  const settings = payload.companySettings;
  const passwordHash = await bcrypt.hash(admin.password, 12);
  return db.transaction(async (tx) => {
    const [company] = await tx.insert(companiesTable).values({
      nameAr: String(rowValue(settings, "name_ar") ?? "شركة منقولة"),
      nameEn: rowValue(settings, "name_en") ? String(rowValue(settings, "name_en")) : null,
      vatNumber: String(rowValue(settings, "vat_number") ?? ""),
      crNumber: String(rowValue(settings, "cr_number") ?? ""),
      city: String(rowValue(settings, "city") ?? ""),
      district: rowValue(settings, "district") ? String(rowValue(settings, "district")) : null,
      street: String(rowValue(settings, "street") ?? ""),
      buildingNumber: String(rowValue(settings, "building_number") ?? ""),
      postalCode: String(rowValue(settings, "postal_code") ?? ""),
      additionalNumber: rowValue(settings, "additional_number") ? String(rowValue(settings, "additional_number")) : null,
      phone: rowValue(settings, "phone") ? String(rowValue(settings, "phone")) : null,
      country: String(rowValue(settings, "country") ?? "SA"),
      industryName: rowValue(settings, "industry_name") ? String(rowValue(settings, "industry_name")) : null,
      invoiceType: String(rowValue(settings, "invoice_type") ?? "both"),
      // A transfer target must never become login-capable until the complete
      // restore and ownership audit have committed successfully.
      status: "suspended",
      autoSendZatcaAfterPost: false,
    } as typeof companiesTable.$inferInsert).returning({ id: companiesTable.id });
    const companyCode = `ZTC-${company.id}`;
    await tx.update(companiesTable).set({ code: companyCode }).where(eq(companiesTable.id, company.id));
    const [targetAdmin] = await tx.insert(usersTable).values({
      companyId: company.id,
      username: admin.username.trim(),
      passwordHash,
      role: "admin",
      nameAr: admin.nameAr?.trim() || null,
      nameEn: admin.nameEn?.trim() || null,
      email: admin.email?.trim() || null,
      isActive: false,
    } as typeof usersTable.$inferInsert).returning({ id: usersTable.id });
    if (subscription) {
      const { id: _id, companyId: _sourceCompanyId, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = subscription as any;
      await tx.insert(subscriptionsTable).values({
        ...rest,
        companyId: company.id,
        isActive: true,
      } as typeof subscriptionsTable.$inferInsert);
    }
    return { companyId: company.id, companyCode, adminUserId: targetAdmin.id };
  });
}

export async function cleanupFailedTransferTarget(
  targetCompanyId: number,
  transferError: unknown,
  operations: {
    deleteTarget?: () => Promise<void>;
    targetExists?: () => Promise<boolean>;
  } = {},
): Promise<void> {
  const deleteTarget = operations.deleteTarget ?? (async () => {
    await db.delete(companiesTable).where(eq(companiesTable.id, targetCompanyId));
  });
  const targetExists = operations.targetExists ?? (async () => {
    const [remaining] = await db.select({ id: companiesTable.id })
      .from(companiesTable).where(eq(companiesTable.id, targetCompanyId)).limit(1);
    return !!remaining;
  });
  try {
    await deleteTarget();
    if (await targetExists()) throw new Error("بقي سجل الشركة الهدف بعد الحذف");
  } catch (cleanupError: any) {
    throw new Error(
      `${(transferError as any)?.message ?? "فشل النقل"}. تعذّر تنظيف الشركة الهدف المعلّقة رقم `
      + `${targetCompanyId}: ${cleanupError?.message ?? "خطأ تنظيف غير معروف"}`,
    );
  }
}

export async function preflightCompanyTransfer(options: {
  sourceLocation: TransferLocation;
  targetLocation: TransferLocation;
  sourceCompanyId: number;
  exportedBy: string | null;
  includeAttachments?: boolean;
}) {
  const source = await buildTransferSource(
    options.sourceLocation,
    options.sourceCompanyId,
    options.exportedBy,
  );
  const payload = resetTargetZatcaIdentity(
    options.includeAttachments ? source.payload : withoutPortableFiles(source.payload),
  );
  const integrity = await withTransferLocation(
    options.targetLocation,
    () => preflightFullCompanyBackup(1, payload),
  );
  let portableSummary: { files: number; bytes: number } | null = null;
  if (options.includeAttachments) {
    const portable = options.sourceLocation.kind === "central"
      ? await withTransferLocation(options.sourceLocation, () =>
        buildPortableBackupPackage(options.sourceCompanyId, options.exportedBy, {
          sanitizeForCompanyTransfer: true,
        }))
      : await exportAgentPortablePackage(
        options.sourceLocation.agentId,
        options.sourceCompanyId,
        options.exportedBy,
      );
    try {
      portableSummary = {
        files: portable.summary.files,
        bytes: portable.summary.bytes,
      };
      if (options.targetLocation.kind === "agent") {
        await assertAgentSshTransferReady(options.targetLocation.agentId);
      }
    } finally {
      await portable.cleanup();
    }
  }
  return {
    sourceCompany: {
      id: source.company.id,
      code: source.company.code,
      nameAr: source.company.nameAr,
    },
    counts: payload.counts,
    rows: integrity.summary.rows,
    tables: integrity.summary.tables,
    includeAttachments: !!options.includeAttachments,
    files: portableSummary ?? {
      files: 0,
      bytes: 0,
    },
    excludedFileReferences: options.includeAttachments ? 0 : source.payload.meta.files.referenced,
    zatcaReconnectRequired: true,
    integrity,
  };
}

export async function transferCompany(options: {
  sourceLocation: TransferLocation;
  targetLocation: TransferLocation;
  sourceCompanyId: number;
  exportedBy: string | null;
  admin: TransferAdmin;
  includeAttachments?: boolean;
}) {
  if (sameTransferLocation(options.sourceLocation, options.targetLocation)) {
    throw new Error("اختر موقع هدف مختلفًا عن موقع المصدر للنقل الكامل");
  }
  const source = await buildTransferSource(
    options.sourceLocation,
    options.sourceCompanyId,
    options.exportedBy,
  );
  const payload = resetTargetZatcaIdentity(
    options.includeAttachments ? source.payload : withoutPortableFiles(source.payload),
  );
  const portable = options.includeAttachments
    ? (options.sourceLocation.kind === "central"
      ? await withTransferLocation(options.sourceLocation, () =>
        buildPortableBackupPackage(options.sourceCompanyId, options.exportedBy, {
          sanitizeForCompanyTransfer: true,
        }))
      : await exportAgentPortablePackage(
        options.sourceLocation.agentId,
        options.sourceCompanyId,
        options.exportedBy,
      ))
    : null;
  let completed: any = null;
  let transferError: unknown = null;
  try {
    completed = await withTransferLocation(options.targetLocation, async () => {
    const target = await createTargetShell(payload, source.subscription, options.admin);
    try {
      let restored: any;
      const warnings: string[] = [];
      if (portable) {
        if (options.targetLocation.kind === "agent") {
          restored = await restoreAgentPortablePackage(
            options.targetLocation.agentId,
            target.companyId,
            portable.path,
          );
          if (restored.cleanupWarning) warnings.push(restored.cleanupWarning);
        } else {
          const objectPath = `/objects/company-backup-packages/${target.companyId}/${randomUUID()}.zacbackup`;
          const service = new ObjectStorageService();
          const settled = await withPostSuccessCleanupWarning(async () => {
            await pipeline(
              createReadStream(portable.path),
              service.getPrivateObjectFile(objectPath.replace(/^\/objects\//, "")).createWriteStream({
                metadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
              }),
            );
            const portablePreflight = await preflightPortableBackupPackage(target.companyId, objectPath);
            if (!portablePreflight.integrity.ok) {
              throw new Error(portablePreflight.integrity.issues[0]?.message || "فشل فحص حزمة النقل");
            }
            return restorePortableBackupPackage(target.companyId, objectPath);
          }, async () => {
            await service.getObjectEntityFile(objectPath)
              .then((file) => file.delete({ ignoreNotFound: true }));
          });
          restored = settled.value;
          if (settled.cleanupWarning) warnings.push(settled.cleanupWarning);
        }
      } else {
        const integrity = await preflightFullCompanyBackup(target.companyId, payload);
        if (!integrity.ok) throw new Error(integrity.issues[0]?.message || "فشل فحص النقل");
        restored = await restoreFullCompanyBackup(target.companyId, payload);
      }
      await db.transaction(async (tx) => {
        await tx.update(companiesTable)
          .set({ status: "active", updatedAt: new Date() })
          .where(eq(companiesTable.id, target.companyId));
        await tx.update(usersTable)
          .set({ isActive: true })
          .where(eq(usersTable.id, target.adminUserId));
      });
      return {
        companyId: target.companyId,
        companyCode: target.companyCode,
        sourceCompanyName: source.company.nameAr,
        counts: payload.counts,
        integrity: restored.integrity,
        files: portable?.summary ?? { files: 0, bytes: 0 },
        filesCopied: portable?.summary.files ?? 0,
        excludedFileReferences: portable ? 0 : source.payload.meta.files.referenced,
        zatcaReconnectRequired: true,
        warning: warnings.length ? warnings.join(" ") : undefined,
      };
    } catch (error) {
      await cleanupFailedTransferTarget(target.companyId, error);
      throw error;
    }
    });
  } catch (error) {
    transferError = error;
  }
  let packageCleanupError: unknown = null;
  try {
    await portable?.cleanup();
  } catch (error) {
    packageCleanupError = error;
  }
  if (transferError) {
    if (packageCleanupError) {
      throw new Error(
        `${(transferError as any)?.message ?? "فشل النقل"}. كما تعذّر تنظيف نسخة الحزمة المحلية المؤقتة: `
        + `${(packageCleanupError as any)?.message ?? String(packageCleanupError)}`,
        { cause: transferError },
      );
    }
    throw transferError;
  }
  if (packageCleanupError) {
    completed.warning = [
      completed.warning,
      "اكتمل النقل، لكن تعذّر حذف نسخة الحزمة المحلية المؤقتة؛ راجع مساحة التخزين المؤقت على الخادم المركزي.",
    ].filter(Boolean).join(" ");
  }
  return completed;
}