import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { getRoutedDb } from "../lib/externalDbRouting.js";

// All document_archives ROW operations go through the platform storage
// routing (may live on an external DB). Company policy reads stay central.
const adb = () => getRoutedDb("document_archive");
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
  const [row] = await (await adb())
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
  const rows = await (await adb())
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

// ─── Share links (WhatsApp etc.) ─────────────────────────────────────────────
// wa.me cannot attach files, so "sending via WhatsApp" means sharing a signed,
// short-lived download link. The token is an HMAC over `${id}.${exp}` — no DB
// state, self-expiring, and it can ONLY be minted by an authorised user via
// POST /:id/share-link (the ACL runs there). The public GET below re-checks
// tenant "off" mode before streaming.
// SECURITY: NO hardcoded fallback — a guessable secret would let anyone forge
// tokens for the PUBLIC /shared/:token route and enumerate archived files.
// If SESSION_SECRET is absent the feature fails CLOSED (mint → 503, verify →
// always rejects) instead of crashing the whole server at boot.
const SHARE_SECRET = process.env.SESSION_SECRET || "";
const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function signShareToken(id: number, exp: number): string {
  const payload = `${id}.${exp}`;
  const sig = crypto.createHmac("sha256", SHARE_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyShareToken(token: string): number | null {
  if (!SHARE_SECRET) return null; // fail closed — no secret, no public access
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [idS, expS, sig] = parts;
  const id = Number(idS);
  const exp = Number(expS);
  if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(exp)) return null;
  const expect = crypto.createHmac("sha256", SHARE_SECRET).update(`${idS}.${expS}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() > exp) return null;
  return id;
}

// POST /api/document-archives/:id/share-link — mint a signed public link for
// an archived file. Full tenant + permission + mode ACL (same as download).
router.post("/:id/share-link", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [row] = await (await adb())
    .select()
    .from(documentArchivesTable)
    .where(and(eq(documentArchivesTable.id, id), eq(documentArchivesTable.companyId, cid)));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  const settings = await loadSettings(cid);
  if (!userAllowed(req, settings)) { res.status(403).json({ error: "ليست لديك صلاحية الوصول للأرشفة" }); return; }
  if (modeFor(settings, row.screenKey) === "off") { res.status(403).json({ error: "الأرشفة معطّلة لهذه الشاشة" }); return; }
  if (!SHARE_SECRET) {
    res.status(503).json({ error: "مشاركة الروابط غير مهيأة على الخادم (SESSION_SECRET مفقود)" });
    return;
  }
  const exp = Date.now() + SHARE_TTL_MS;
  const token = signShareToken(id, exp);
  // The frontend builds the absolute URL from its own origin so the link
  // works for both the dev preview host and the production domain.
  res.json({ token, path: `/api/document-archives/shared/${token}`, expiresAt: new Date(exp).toISOString() });
});

// GET /api/document-archives/shared/:token — PUBLIC (no auth): stream the file
// referenced by a valid, unexpired share token. Registered before /:id/download
// (Express 5: literal sub-segment first). Re-checks the company "off" switch so
// disabling archiving also kills previously shared links.
router.get("/shared/:token", async (req: Request, res: Response) => {
  const id = verifyShareToken(String(req.params.token ?? ""));
  if (id == null) { res.status(403).json({ error: "الرابط غير صالح أو منتهي الصلاحية" }); return; }
  const [row] = await (await adb())
    .select()
    .from(documentArchivesTable)
    .where(eq(documentArchivesTable.id, id));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  const settings = await loadSettings(row.companyId);
  if (modeFor(settings, row.screenKey) === "off") { res.status(403).json({ error: "الأرشفة معطّلة" }); return; }
  try {
    const objectFile = await objectStorageService.getObjectEntityFile(row.objectPath);
    const response = await objectStorageService.downloadObject(objectFile);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (row.contentType) res.setHeader("Content-Type", row.contentType);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
    if (response.body) {
      Readable.fromWeb(response.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) { res.status(404).json({ error: "الملف غير موجود في التخزين" }); return; }
    req.log?.error({ err: error }, "document-archive shared download failed");
    res.status(500).json({ error: "تعذّر تنزيل الملف" });
  }
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
  const [row] = await (await adb())
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
  const [row] = await (await adb())
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
    companyId: cid,
  });
  if (!r.ok) { res.status(502).json({ error: "تعذّر إرسال البريد", reason: r.reason }); return; }
  res.json({ ok: true });
});

// DELETE /api/document-archives/:id — remove the index row (tenant-scoped).
// PATCH /api/document-archives/rekey — move records archived under a DRAFT
// docKey (new-form per-mount key) onto the saved voucher/document code so
// they stay reachable from edit mode after the first save.
router.patch("/rekey", async (req: Request, res: Response) => {
  const cid = guard(req, res); if (cid == null) return;
  const Body = z.object({
    screenKey: z.string().min(1),
    oldDocKey: z.string().min(1),
    newDocKey: z.string().min(1),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "بيانات غير صحيحة" }); return; }
  const settings = await loadSettings(cid);
  if (!userAllowed(req, settings)) {
    res.status(403).json({ error: "ليست لديك صلاحية أرشفة المستندات" });
    return;
  }
  await (await adb()).update(documentArchivesTable)
    .set({ docKey: parsed.data.newDocKey })
    .where(and(
      eq(documentArchivesTable.companyId, cid),
      eq(documentArchivesTable.screenKey, parsed.data.screenKey),
      eq(documentArchivesTable.docKey, parsed.data.oldDocKey),
    ));
  res.json({ ok: true });
});

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
  const deleted = await (await adb())
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
