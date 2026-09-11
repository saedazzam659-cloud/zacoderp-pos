// Additive packaging metadata endpoints.
//
// The versioned specification workflow remains in production.ts. This router
// owns only the logistics/EPR/archive snapshot fields added to a version, so
// the existing production screen and routes remain backwards compatible.
import { Router, type Request, type Response } from "express";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  db,
  documentArchivesTable,
  packagingSpecificationsTable,
  packagingSpecificationVersionsTable,
} from "@workspace/db";
import { getRoutedDb } from "../lib/externalDbRouting.js";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import {
  audit,
  companyAllowsModule,
  requirePermission,
} from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) {
    res.status(401).json({ error: "غير مصرح" });
    return;
  }
  if (req.authUser.role !== "superadmin" && !companyAllowsModule(req.authUser, "production")) {
    res.status(403).json({ error: "هذا الموديل غير مفعّل لشركتك — يرجى مراجعة المسؤول" });
    return;
  }
  next();
});

const DIMENSION_UNITS = new Set(["mm", "cm", "m", "in"]);
const WEIGHT_UNITS = new Set(["kg", "g", "lb"]);
const MAX_DIMENSION = 100_000;
const MAX_CAPACITY = 1_000_000;
const MAX_WEIGHT = 100_000;
const MAX_DECLARATIONS = 50;
const MAX_ARCHIVE_REFS = 50;

type TransportMetadata = {
  type: string;
  dimensionUnit: string;
  length: number | null;
  width: number | null;
  height: number | null;
  capacityUnits: number | null;
  capacityUnit: string;
  maxGrossWeight: number | null;
  weightUnit: string;
  stackLimit: number | null;
};

function guard(req: Request, res: Response): number | null {
  if (!req.authUser) {
    res.status(401).json({ error: "غير مصرح" });
    return null;
  }
  if (req.authUser.role !== "superadmin" && !companyAllowsModule(req.authUser, "production")) {
    res.status(403).json({ error: "هذا الموديل غير مفعّل لشركتك — يرجى مراجعة المسؤول" });
    return null;
  }
  const cid = resolveCompanyId(req, req.authUser.companyId ?? undefined);
  if (!cid) {
    res.status(401).json({ error: "غير مصرح" });
    return null;
  }
  return cid;
}

function boundedNumber(
  value: unknown,
  label: string,
  max: number,
  integer = false,
): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    parsed > max ||
    (integer && !Number.isInteger(parsed))
  ) {
    throw Object.assign(new Error(`${label} يجب أن يكون بين 0 و${max}${integer ? " وأن يكون عدداً صحيحاً" : ""}`), {
      status: 400,
    });
  }
  return parsed;
}

function normalizeTransport(value: unknown, label: string): TransportMetadata {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const dimensionUnit = String(source.dimensionUnit ?? "mm").toLowerCase();
  const weightUnit = String(source.weightUnit ?? "kg").toLowerCase();
  const capacityUnit = String(source.capacityUnit ?? "PCE").trim().slice(0, 20) || "PCE";
  if (!DIMENSION_UNITS.has(dimensionUnit)) {
    throw Object.assign(new Error(`وحدة أبعاد ${label} غير صحيحة`), { status: 400 });
  }
  if (!WEIGHT_UNITS.has(weightUnit)) {
    throw Object.assign(new Error(`وحدة وزن ${label} غير صحيحة`), { status: 400 });
  }
  return {
    type: String(source.type ?? "").trim().slice(0, 100),
    dimensionUnit,
    length: boundedNumber(source.length, `طول ${label}`, MAX_DIMENSION),
    width: boundedNumber(source.width, `عرض ${label}`, MAX_DIMENSION),
    height: boundedNumber(source.height, `ارتفاع ${label}`, MAX_DIMENSION),
    capacityUnits: boundedNumber(source.capacityUnits, `سعة ${label}`, MAX_CAPACITY),
    capacityUnit,
    maxGrossWeight: boundedNumber(source.maxGrossWeight, `الوزن الإجمالي الأقصى لـ${label}`, MAX_WEIGHT),
    weightUnit,
    stackLimit: boundedNumber(source.stackLimit, `حد التكديس لـ${label}`, 999, true),
  };
}

function normalizeEprDeclarations(value: unknown): Array<Record<string, unknown>> {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_DECLARATIONS) {
    throw Object.assign(new Error(`لا يمكن حفظ أكثر من ${MAX_DECLARATIONS} إقراراً بيئياً`), { status: 400 });
  }
  return value.map((entry: any, index) => {
    const material = String(entry?.material ?? "").trim().slice(0, 120);
    if (!material) {
      throw Object.assign(new Error(`مادة الإقرار البيئي مطلوبة في السطر ${index + 1}`), { status: 400 });
    }
    const massGrams = boundedNumber(entry?.massGrams, `وزن مادة الإقرار ${index + 1}`, 1_000_000);
    if (massGrams == null) {
      throw Object.assign(new Error(`وزن مادة الإقرار مطلوب في السطر ${index + 1}`), { status: 400 });
    }
    const recycledContentPct = boundedNumber(
      entry?.recycledContentPct,
      `نسبة المحتوى المعاد في الإقرار ${index + 1}`,
      100,
    );
    const recyclablePct = boundedNumber(
      entry?.recyclablePct,
      `نسبة القابلية لإعادة التدوير في الإقرار ${index + 1}`,
      100,
    );
    return {
      material,
      scheme: String(entry?.scheme ?? "").trim().slice(0, 120),
      massGrams,
      recycledContentPct,
      recyclablePct,
      declarationRef: String(entry?.declarationRef ?? "").trim().slice(0, 160),
      notes: String(entry?.notes ?? "").trim().slice(0, 500),
    };
  });
}

function archiveIds(value: unknown): number[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ARCHIVE_REFS) {
    throw Object.assign(new Error(`لا يمكن ربط أكثر من ${MAX_ARCHIVE_REFS} ملف تصميم مؤرشف`), { status: 400 });
  }
  const ids = [...new Set(value.map((entry) => Number(entry)))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw Object.assign(new Error("مراجع ملفات التصميم يجب أن تكون أرقام سجلات الأرشيف فقط"), { status: 400 });
  }
  return ids;
}

router.patch(
  "/versions/:id/packaging-metadata",
  requirePermission("production", "post"),
  audit("production", "post"),
  async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const versionId = Number(req.params.id);
    if (!Number.isInteger(versionId) || versionId <= 0) {
      return void res.status(400).json({ error: "معرّف إصدار التعبئة غير صحيح" });
    }

    const [version] = await db
      .select({
        id: packagingSpecificationVersionsTable.id,
        status: packagingSpecificationVersionsTable.status,
      })
      .from(packagingSpecificationVersionsTable)
      .innerJoin(
        packagingSpecificationsTable,
        eq(packagingSpecificationsTable.id, packagingSpecificationVersionsTable.specificationId),
      )
      .where(and(
        eq(packagingSpecificationVersionsTable.id, versionId),
        eq(packagingSpecificationsTable.companyId, cid),
      ))
      .limit(1);
    if (!version) return void res.status(404).json({ error: "إصدار مواصفة التعبئة غير موجود" });
    if (["approved", "retired"].includes(version.status)) {
      return void res.status(409).json({ error: "لا يمكن تعديل بيانات إصدار معتمد أو متقاعد" });
    }

    const palletMetadata = normalizeTransport(req.body?.palletMetadata, "الطبلية");
    const containerMetadata = normalizeTransport(req.body?.containerMetadata, "الحاوية");
    const eprDeclarations = normalizeEprDeclarations(req.body?.eprDeclarations);
    if (req.body?.artworkArchiveRefs != null) {
      return void res.status(400).json({
        error: "استخدم معرّفات ملفات الأرشيف المحمي فقط؛ الروابط الخارجية غير مسموحة",
      });
    }
    const ids = archiveIds(req.body?.artworkArchiveIds);

    // References are accepted only from the existing tenant-scoped archive
    // index and only when its key belongs to this exact packaging version.
    // No caller-supplied URL/object path is accepted or persisted.
    const archiveDb = await getRoutedDb("document_archive");
    const archives = ids.length
      ? await archiveDb.select().from(documentArchivesTable).where(and(
          eq(documentArchivesTable.companyId, cid),
          inArray(documentArchivesTable.id, ids),
          eq(documentArchivesTable.screenKey, "packaging_specifications"),
          eq(documentArchivesTable.docKey, `packaging:${versionId}`),
        ))
      : [];
    if (archives.length !== ids.length) {
      return void res.status(400).json({
        error: "كل مراجع التصميم يجب أن تكون ملفات موجودة في الأرشيف المحمي لهذه المواصفة والإصدار",
      });
    }
    if (archives.some((archive) => !archive.objectPath.startsWith("/objects/"))) {
      return void res.status(400).json({ error: "ملف تصميم مؤرشف بمسار غير صالح" });
    }
    const artworkArchiveRefs = archives.map((archive) => ({
      archiveId: archive.id,
      filename: archive.filename,
      objectPath: archive.objectPath,
      contentType: archive.contentType,
      bytes: archive.bytes,
      screenKey: archive.screenKey,
      docKey: archive.docKey,
    }));

    const [updated] = await db.update(packagingSpecificationVersionsTable)
      .set({
        palletMetadata,
        containerMetadata,
        eprDeclarations,
        artworkArchiveRefs,
        updatedAt: new Date(),
      })
      .where(and(
        eq(packagingSpecificationVersionsTable.id, versionId),
        ne(packagingSpecificationVersionsTable.status, "approved"),
        ne(packagingSpecificationVersionsTable.status, "retired"),
      ))
      .returning();
    if (!updated) {
      return void res.status(409).json({ error: "تم اعتماد إصدار التعبئة أثناء الحفظ؛ أعد تحميل الشاشة" });
    }
    res.json(updated);
  } catch (error: any) {
    res.status(error?.status ?? 500).json({ error: error?.message ?? "تعذر حفظ بيانات التعبئة" });
  }
  },
);

export default router;
