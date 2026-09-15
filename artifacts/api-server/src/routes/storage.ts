import { Router, raw, type IRouter, type Request, type Response, type NextFunction } from "express";
import { Readable } from "stream";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ObjectStorageService, ObjectNotFoundError, canReadPrivateObjectPath,
} from "../lib/objectStorage";
import { extractAuth } from "../middleware/auth.js";

const RequestUploadUrlBody = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  contentType: z.string().min(1),
});

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// Authenticated-only gate. The PUBLIC bucket route below opts out (it serves
// public objects by design), but private upload-URL issuance and private
// object fetches must require a valid Bearer token.
function requireAuthed(req: Request, res: Response, next: NextFunction) {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
}

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 */
router.post("/storage/uploads/request-url", extractAuth, requireAuthed, async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType } = parsed.data;
    if (size > 50 * 1024 * 1024) {
      res.status(413).json({ error: "File exceeds 50 MB limit" });
      return;
    }

    // External agents do not have Replit's signing sidecar. Keep the public
    // /objects/... contract identical, but upload the bytes through this
    // authenticated API into the agent's private filesystem.
    if (objectStorageService.usesLocalPrivateStorage()) {
      const objectId = randomUUID();
      res.json({
        uploadURL: `${req.baseUrl}/storage/uploads/direct/${objectId}`,
        objectPath: `/objects/uploads/${objectId}`,
        direct: true,
        metadata: { name, size, contentType },
      });
      return;
    }

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json({
      uploadURL,
      objectPath,
      metadata: { name, size, contentType },
    });
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

router.put(
  "/storage/uploads/direct/:id",
  extractAuth,
  requireAuthed,
  raw({ type: () => true, limit: "50mb" }),
  async (req: Request, res: Response) => {
    if (!objectStorageService.usesLocalPrivateStorage()) {
      res.status(404).json({ error: "Direct upload is available on local agents only" });
      return;
    }
    const id = String(req.params.id ?? "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      res.status(400).json({ error: "Invalid upload id" });
      return;
    }
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const expected = Number(req.headers["x-zacod-upload-size"]);
    if (bytes.length === 0 || !Number.isSafeInteger(expected) || expected !== bytes.length) {
      res.status(400).json({ error: "Upload size mismatch" });
      return;
    }
    try {
      const file = objectStorageService.getPrivateObjectFile(`uploads/${id}`);
      const stream = file.createWriteStream({
        metadata: {
          contentType: req.headers["content-type"] || "application/octet-stream",
          cacheControl: "private, no-store",
        },
      });
      stream.end(bytes);
      await once(stream, "finish");
      res.status(201).json({ objectPath: `/objects/uploads/${id}` });
    } catch (error) {
      req.log.error({ err: error }, "Local-agent direct upload failed");
      res.status(500).json({ error: "Failed to save uploaded file" });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
// Allow `?token=<bearer>` so it can be used in <img src="..."> tags where the
// browser cannot send an Authorization header. The token is passed through to
// extractAuth via the standard Authorization header on a per-request basis.
router.use("/storage/objects", (req, _res, next) => {
  const t = typeof req.query.token === "string" ? req.query.token : null;
  if (t && !req.headers.authorization) req.headers.authorization = `Bearer ${t}`;
  next();
});
router.get("/storage/objects/*path", extractAuth, requireAuthed, async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    // Contracting bill attachments are only readable through the bill-bound
    // download endpoint, which checks company + bill + branch scope. Never
    // let the generic object proxy turn their server-generated namespace into
    // an IDOR primitive.
    if (wildcardPath.startsWith("contracting-bills/")) {
      res.status(403).json({ error: "Use the bill attachment download endpoint" });
      return;
    }
    if (!canReadPrivateObjectPath(wildcardPath, (req as any).authUser)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    // --- Protected route example (uncomment when using replit-auth) ---
    // if (!req.isAuthenticated()) {
    //   res.status(401).json({ error: "Unauthorized" });
    //   return;
    // }
    // const canAccess = await objectStorageService.canAccessObjectEntity({
    //   userId: req.user.id,
    //   objectFile,
    //   requestedPermission: ObjectPermission.READ,
    // });
    // if (!canAccess) {
    //   res.status(403).json({ error: "Forbidden" });
    //   return;
    // }

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
