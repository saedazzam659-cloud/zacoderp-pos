import { Storage, File } from "@google-cloud/storage";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

type LocalFileLike = File & { __zacodLocalFile?: true };
const activeLocalObjectReads = new Set<string>();

function localPrivateObjectRoot(): string | null {
  const explicit = process.env.ZACOD_LOCAL_OBJECT_DIR?.trim();
  const configPath = process.env.ZACOD_AGENT_CONFIG || "/opt/zacod/config.json";
  if (!explicit && !existsSync(configPath)) return null;
  return resolve(explicit || join(dirname(configPath), "storage", "private"));
}

function safeLocalPath(root: string, relativeKey: string): string {
  const key = relativeKey.replace(/^\/+/, "");
  if (!key || key.includes("..") || !/^[A-Za-z0-9/_\-.]+$/.test(key)) {
    throw new Error("Invalid private object key");
  }
  const target = resolve(root, key);
  if (target !== root && !target.startsWith(root + sep)) throw new Error("Invalid private object key");
  return target;
}

function localFile(root: string, relativeKey: string): LocalFileLike {
  const path = safeLocalPath(root, relativeKey);
  const metadataPath = `${path}.zacmeta.json`;
  return {
    __zacodLocalFile: true,
    name: relativeKey,
    exists: async () => [existsSync(path)],
    getMetadata: async () => {
      const info = await stat(path);
      let stored: Record<string, unknown> = {};
      try { stored = JSON.parse(readFileSync(metadataPath, "utf8")); } catch { /* legacy local file */ }
      return [{
        size: String(info.size),
        contentType: typeof stored.contentType === "string" ? stored.contentType : "application/octet-stream",
        cacheControl: typeof stored.cacheControl === "string" ? stored.cacheControl : "private, no-store",
        timeCreated: info.birthtime.toISOString(),
        updated: info.mtime.toISOString(),
      }];
    },
    createReadStream: (options?: any) => {
      const stream = createReadStream(path, options);
      activeLocalObjectReads.add(path);
      const release = () => activeLocalObjectReads.delete(path);
      stream.once("close", release);
      stream.once("error", release);
      return stream;
    },
    createWriteStream: (options?: any) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const stream = createWriteStream(path, { flags: "w", mode: 0o600 });
      const metadata = options?.metadata;
      stream.once("finish", () => {
        try {
          writeFileSync(metadataPath, JSON.stringify({
            contentType: metadata?.contentType || "application/octet-stream",
            cacheControl: metadata?.cacheControl || "private, no-store",
          }), { mode: 0o600 });
        } catch { /* metadata is best-effort; bytes remain valid */ }
      });
      return stream;
    },
    delete: async () => {
      await Promise.all([rm(path, { force: true }), rm(metadataPath, { force: true })]);
      return [{}];
    },
  } as unknown as LocalFileLike;
}

async function localFilesUnder(dir: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await localFilesUnder(path));
    else if (entry.isFile() && !entry.name.endsWith(".zacmeta.json")) files.push(path);
  }
  return files;
}

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export function canReadPrivateObjectPath(
  wildcardPath: string,
  auth: { role?: string | null; companyId?: number | null } | null | undefined,
): boolean {
  if (wildcardPath.startsWith("company-backup-packages/")) return false;
  const restoredMatch = /^company-backup-files\/(\d+)\//.exec(wildcardPath);
  if (!restoredMatch) return true;
  return auth?.role === "superadmin" || Number(auth?.companyId) === Number(restoredMatch[1]);
}

export class ObjectStorageService {
  constructor() {}

  usesLocalPrivateStorage(): boolean {
    return localPrivateObjectRoot() !== null;
  }

  /**
   * Older external-agent rows may contain a relative/absolute local storage
   * path instead of the public-neutral `/objects/...` form. Convert only paths
   * that resolve to an existing file inside this agent's private object root.
   */
  normalizePrivateObjectReference(rawPath: string): string | null {
    const value = rawPath.trim();
    if (value.startsWith("/objects/")) return value;
    const root = localPrivateObjectRoot();
    if (!root || !value) return null;
    let candidate = value;
    if (value.startsWith("file://")) {
      try { candidate = new URL(value).pathname; } catch { return null; }
    }
    let target: string;
    try {
      target = isAbsolute(candidate) ? resolve(candidate) : safeLocalPath(root, candidate);
    } catch {
      return null;
    }
    if (target === root || !target.startsWith(root + sep) || !existsSync(target)) return null;
    const key = relative(root, target).split(sep).join("/");
    return key && !key.includes("..") ? `/objects/${key}` : null;
  }

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(file: File, cacheTtlSec: number = 3600): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = (file as LocalFileLike).__zacodLocalFile ? null : await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
  }

  /**
   * Create a short-lived direct-upload URL at a caller-owned private key.
   * The key is never exposed outside the private object namespace and must be
   * generated by trusted server code (never accepted verbatim from a client).
   */
  async getPrivateUploadTarget(
    relativeKey: string,
    options: { sizeBytes: number; origin?: string },
  ): Promise<{ uploadURL: string; objectPath: string }> {
    const safeKey = relativeKey.replace(/^\/+/, "");
    if (!safeKey || safeKey.includes("..") || !/^[A-Za-z0-9/_\-.]+$/.test(safeKey)) {
      throw new Error("Invalid private object key");
    }
    if (!Number.isSafeInteger(options.sizeBytes) || options.sizeBytes <= 0) {
      throw new Error("Invalid private upload size");
    }
    const privateObjectDir = this.getPrivateObjectDir().replace(/\/+$/, "");
    const { bucketName, objectName } = parseObjectPath(`${privateObjectDir}/${safeKey}`);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    const origin = options.origin && /^https?:\/\/[^/]+$/i.test(options.origin)
      ? options.origin
      : undefined;
    // A GCS resumable session binds X-Upload-Content-Length at initiation.
    // Unlike a generic signed PUT, the storage service itself rejects any body
    // larger (or smaller) than the declared size without creating an object.
    const [uploadURL] = await file.createResumableUpload({
      metadata: {
        contentType: "application/octet-stream",
        contentLength: options.sizeBytes,
        cacheControl: "private, no-store",
      },
      origin,
    });
    // GCS resumable sessions otherwise live for several days. Best-effort
    // cancellation restores the same short capability lifetime as signed URLs.
    const cancelTimer = setTimeout(() => {
      void fetch(uploadURL, { method: "DELETE" }).catch(() => {});
    }, 15 * 60_000);
    cancelTimer.unref();
    return {
      uploadURL,
      objectPath: `/objects/${safeKey}`,
    };
  }

  /** Resolve a trusted private relative key to a GCS File handle. */
  getPrivateObjectFile(relativeKey: string): File {
    const safeKey = relativeKey.replace(/^\/+/, "");
    if (!safeKey || safeKey.includes("..") || !/^[A-Za-z0-9/_\-.]+$/.test(safeKey)) {
      throw new Error("Invalid private object key");
    }
    const localRoot = localPrivateObjectRoot();
    if (localRoot) return localFile(localRoot, safeKey);
    const privateObjectDir = this.getPrivateObjectDir().replace(/\/+$/, "");
    const { bucketName, objectName } = parseObjectPath(`${privateObjectDir}/${safeKey}`);
    return objectStorageClient.bucket(bucketName).file(objectName);
  }

  /**
   * Delete private objects under a server-owned prefix.
   * Used for short-lived upload staging and agent teardown; callers must pass
   * a fixed/generated prefix, never raw user input.
   */
  async deletePrivateObjectsUnderPrefix(
    relativePrefix: string,
    options: { olderThan?: Date; requiredSegment?: string } = {},
  ): Promise<number> {
    const safePrefix = relativePrefix.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!safePrefix || safePrefix.includes("..") || !/^[A-Za-z0-9/_\-.]+$/.test(safePrefix)) {
      throw new Error("Invalid private object prefix");
    }
    const localRoot = localPrivateObjectRoot();
    if (localRoot) {
      const target = safeLocalPath(localRoot, safePrefix);
      if (!options.olderThan && !options.requiredSegment) {
        await rm(target, { recursive: true, force: true });
        return 1;
      }
      let deleted = 0;
      for (const path of await localFilesUnder(target)) {
        if (activeLocalObjectReads.has(path)) continue;
        const relative = path.slice(localRoot.length + 1);
        if (options.requiredSegment && !relative.includes(options.requiredSegment)) continue;
        if (options.olderThan) {
          const info = await stat(path);
          if (info.mtime.getTime() >= options.olderThan.getTime()) continue;
        }
        await Promise.all([
          rm(path, { force: true }),
          rm(`${path}.zacmeta.json`, { force: true }),
        ]);
        deleted++;
      }
      return deleted;
    }
    const privateObjectDir = this.getPrivateObjectDir().replace(/\/+$/, "");
    const { bucketName, objectName } = parseObjectPath(`${privateObjectDir}/${safePrefix}/`);
    const bucket = objectStorageClient.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix: objectName });
    const deletable: File[] = [];
    for (const file of files) {
      if (options.requiredSegment && !file.name.includes(options.requiredSegment)) continue;
      if (options.olderThan) {
        const [metadata] = await file.getMetadata();
        const created = Date.parse(String(metadata.timeCreated ?? metadata.updated ?? ""));
        if (!Number.isFinite(created) || created >= options.olderThan.getTime()) continue;
      }
      deletable.push(file);
    }
    await Promise.all(deletable.map(file => file.delete({ ignoreNotFound: true }).catch(() => {})));
    return deletable.length;
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    const localRoot = localPrivateObjectRoot();
    if (localRoot) {
      const file = localFile(localRoot, entityId);
      const [exists] = await file.exists();
      if (!exists) throw new ObjectNotFoundError();
      return file;
    }
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`
    );
  }

  const { signed_url: signedURL } = await response.json();
  return signedURL;
}
