import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { Readable } from "node:stream";
import { db } from "@workspace/db";
import { documentArchivesTable, companiesTable } from "@workspace/db";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage.js";
import { sendEmail } from "../lib/email.js";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

type ArchiveMode = "local" | "cloud" | "off";
interface ArchiveSettings {
  defaultMode?: ArchiveMode;
  screens?: Record<string, ArchiveMode>;
  allowedUserIds?: number[];
}

// Allow `?token=<bearer>` so the download URL works in window.open()/<a> where
// the browser cannot attach an Authorization header. Must run BEFORE extractAuth.
router.use((req, _res, next) => {
  const t = typeof req.query.token === "string" ? req.query.token : null;
  if (t && !req.headers.authorization) req.headers.authorization = `Bearer ${t}`;
  next();
});
router.use(extractAuth);

// Resolve the tenant company id for the caller, 401/400 on failure.
function guard(req: Request, res: Response): number | null {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return null; }
  const cid = resolveCompanyId(req);
  if (cid == null) { res.status(400).json({ error: "لم يتم تحديد الشركة" }); return null; }
  return cid;
}

// Fetch the company's archive policy once (cached per request would be nicer but
// these endpoints touch it at most once).
async function loadSettings(companyId: number): Promise<ArchiveSettings | null> {
  const [co] = await db
    .select({ archiveSettings: companiesTable.archiveSettings })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));
  return (co?.archiveSettings ?? null) as ArchiveSettings | null;
}

// Admins / superadmin may always archive. Regular users must be listed in the
// company's archiveSettings.allowedUserIds (an empty/missing list = everyone).
function userAllowed(req: Request, settings: ArchiveSettings | null): boolean {
  const u = req.authUser!;
  if (u.role === "superadmin" || u.role === "admin") return true;
  const allowed = settings?.allowedUserIds;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  return allowed.includes(u.id);
}

// Effective storage mode for a screen: per-screen override → company default → local.
function modeFor(settings: ArchiveSettings | null, screenKey: string): ArchiveMode {
  return settings?.screens?.[screenKey] ?? settings?.defaultMode ?? "local";
}

const RecordBody = z.object({
  screenKey: z.string().min(1).max(64),
  docKey: z.string().min(1).max(256),
  filename: z.string().min(1).max(512),
  objectPath: z.string().min(1).max(1024),
  contentType: z.string().max(256).optional().nullable(),
  bytes: z.number().int().nonnegative().optional().nullable(),
  pages: z.number().int().nonnegative().optional().nullable(),
});

// POST /api/document-archives — record a file already uploaded to object
// storage (via /storage/uploads/request-url + the presigned PUT).
router.post("/", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const parsed = RecordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "بيانات غير صحيحة" });
    return;
  }
  // Only accept paths produced by our own upload-url endpoint.
  if (!parsed.data.objectPath.startsWith("/objects/")) {
    res.status(400).json({ error: "مسار الملف غير صالح" });
    return;
  }
  const settings = await loadSettings(cid);
  if (!userAllowed(req, settings)) {
    res.status(403).json({ error: "ليست لديك صلاحية أرشفة المستندات" });
    return;
  }
  // Cloud recording is only valid when this screen is actually in cloud mode.
  // (local mode never reaches the backend; off mode is disabled entirely.)
  if (modeFor(settings, parsed.data.screenKey) !== "cloud") {
    res.status(403).json({ error: "الأرشفة السحابية غير مفعّلة لهذه الشاشة" });
    return;
  }
  const u = req.authUser!;
  const [row] = await db
    .insert(documentArchivesTable)
    .values({
      companyId: cid,
      screenKey: parsed.data.screenKey,
      docKey: parsed.data.docKey,
      filename: parsed.data.filename,
      objectPath: parsed.data.objectPath,
      contentType: parsed.data.contentType ?? null,
      bytes: parsed.data.bytes ?? null,
      pages: parsed.data.pages ?? null,
      uploadedBy: u.id,
      uploadedByName: (u as any).nameAr ?? u.username ?? null,
    })
    .returning();
  res.status(201).json(row);
});

// GET /api/document-archives?screenKey=&docKey= — list files for one document.
router.get("/", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const screenKey = typeof req.query.screenKey === "string" ? req.query.screenKey : "";
  const docKey = typeof req.query.docKey === "string" ? req.query.docKey : "";
  if (!screenKey || !docKey) {
    // Always return an array so the frontend list-fetch contract holds.
    res.json([]);
    return;
  }
  const settings = await loadSettings(cid);
  // Users without archive permission must not enumerate archived documents.
  if (!userAllowed(req, settings)) {
    res.status(403).json({ error: "ليست لديك صلاحية الوصول للأرشفة" });
    return;
  }
  // Honour the control-center "off" switch server-side too.
  if (modeFor(settings, screenKey) === "off") {
    res.json([]);
    return;
  }
  const rows = await db
    .select()
    .from(documentArchivesTable)
    .where(
      and(
        eq(documentArchivesTable.companyId, cid),
        eq(documentArchivesTable.screenKey, screenKey),
        eq(documentArchivesTable.docKey, docKey),
      ),
    )
    .orderBy(desc(documentArchivesTable.createdAt));
  res.json(rows);
});

// GET /api/document-archives/:id/download — stream the archived file ONLY after
// validating tenant ownership + caller permission + non-disabled mode. This is
// the object-level ACL: the private object is never served directly.
router.get("/:id/download", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const [row] = await db
    .select()
    .from(documentArchivesTable)
    .where(and(eq(documentArchivesTable.id, id), eq(documentArchivesTable.companyId, cid)));
  if (!row) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  const settings = await loadSettings(cid);
  if (!userAllowed(req, settings)) {
    res.status(403).json({ error: "ليست لديك صلاحية الوصول للأرشفة" });
    return;
  }
  if (modeFor(settings, row.screenKey) === "off") {
    res.status(403).json({ error: "الأرشفة معطّلة لهذه الشاشة" });
    return;
  }
  try {
    const objectFile = await objectStorageService.getObjectEntityFile(row.objectPath);
    const response = await objectStorageService.downloadObject(objectFile);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as any);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "الملف غير موجود في التخزين" });
      return;
    }
    req.log?.error({ err: error }, "document-archive download failed");
    res.status(500).json({ error: "تعذّر تنزيل الملف" });
  }
});

// POST /api/document-archives/:id/email — email an archived file as an
// attachment. Same tenant/permission/mode ACL as download; the server pulls the
// bytes from object storage so the client never handles the raw file.
const ArchiveEmailBody = z.object({
  to: z.string().email(),
  subject: z.string().max(256).optional(),
  message: z.string().max(4000).optional(),
});
router.post("/:id/email", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const parsed = ArchiveEmailBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "بيانات البريد غير صحيحة" }); return; }
  const [row] = await db
    .select()
    .from(documentArchivesTable)
    .where(and(eq(documentArchivesTable.id, id), eq(documentArchivesTable.companyId, cid)));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  const settings = await loadSettings(cid);
  if (!userAllowed(req, settings)) { res.status(403).json({ error: "ليست لديك صلاحية الوصول للأرشفة" }); return; }
  if (modeFor(settings, row.screenKey) === "off") { res.status(403).json({ error: "الأرشفة معطّلة لهذه الشاشة" }); return; }

  let buf: Buffer;
  try {
    const objectFile = await objectStorageService.getObjectEntityFile(row.objectPath);
    const response = await objectStorageService.downloadObject(objectFile);
    const ab = await response.arrayBuffer();
    buf = Buffer.from(ab);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) { res.status(404).json({ error: "الملف غير موجود في التخزين" }); return; }
    req.log?.error({ err: error }, "document-archive email fetch failed");
    res.status(500).json({ error: "تعذّر جلب الملف" });
    return;
  }
  const subject = parsed.data.subject || `مرفق: ${row.filename}`;
  const text = parsed.data.message || `مرفق الملف: ${row.filename}`;
  const r = await sendEmail({
    to: parsed.data.to,
    subject,
    html: `<div dir="rtl">${text.replace(/\n/g, "<br/>")}</div>`,
    text,
    attachments: [{ filename: row.filename, content: buf, contentType: row.contentType ?? "application/octet-stream" }],
  });
  if (!r.ok) { res.status(502).json({ error: "تعذّر إرسال البريد", reason: r.reason }); return; }
  res.json({ ok: true });
});

// DELETE /api/document-archives/:id — remove the index row (tenant-scoped).
router.delete("/:id", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const settings = await loadSettings(cid);
  if (!userAllowed(req, settings)) {
    res.status(403).json({ error: "ليست لديك صلاحية أرشفة المستندات" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const deleted = await db
    .delete(documentArchivesTable)
    .where(and(eq(documentArchivesTable.id, id), eq(documentArchivesTable.companyId, cid)))
    .returning({ id: documentArchivesTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  res.json({ ok: true });
});

export default router;
