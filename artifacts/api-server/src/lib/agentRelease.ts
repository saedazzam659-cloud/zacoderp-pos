// Release bundle for «full» edition agent servers.
//
// The bundle is a deterministic tar.gz of the api-server's complete built dist
// directory (server bundle + workers + public SPA assets). Its release ID is
// derived from the final archive, so a frontend-only change is a new release.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ReleaseInfo {
  version: string;
  tarPath: string;
  sizeBytes: number;
  sha256: string;
  publishedAt: string;
}

let inFlight: Promise<ReleaseInfo> | null = null;

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function releaseInfo(tarPath: string, knownSha256?: string): Promise<ReleaseInfo> {
  const stat = await fs.stat(tarPath);
  const sha256 = knownSha256 ?? await hashFile(tarPath);
  return {
    version: sha256.slice(0, 16),
    tarPath,
    sizeBytes: stat.size,
    sha256,
    publishedAt: stat.mtime.toISOString(),
  };
}

export function findDistDir(): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), "dist"),
    path.resolve(process.cwd(), "artifacts/api-server/dist"),
    process.argv[1] ? path.dirname(process.argv[1]) : "",
  ].filter(Boolean);
  return (async () => {
    for (const dir of candidates) {
      try {
        await fs.access(path.join(dir, "index.mjs"));
        return dir;
      } catch { /* next */ }
    }
    throw new Error("حزمة النسخة الكاملة غير متاحة — لم يتم العثور على ملفات البناء (dist/index.mjs)");
  })();
}

export async function buildReleaseFromDist(distDir: string, releaseDir = "/tmp"): Promise<ReleaseInfo> {
  await fs.access(path.join(distDir, "index.mjs"));
  const workDir = await fs.mkdtemp(path.join(releaseDir, ".zacod-release-build-"));
  const partial = path.join(workDir, "release.tgz");
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("tar", [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--format=gnu",
        "--exclude=*.map",
        "-czf",
        partial,
        "-C",
        distDir,
        ".",
      ], { timeout: 120_000 }, (err, _o, stderr) => {
        if (err) reject(new Error(`تعذّر بناء حزمة النسخة: ${String(stderr || err.message).slice(0, 200)}`));
        else resolve();
      });
    });
    const sha256 = await hashFile(partial);
    const version = sha256.slice(0, 16);
    const tarPath = path.join(releaseDir, `zacod-release-${version}.tgz`);
    try {
      const existingSha = await hashFile(tarPath);
      if (existingSha !== sha256) throw new Error("تعارض نادر في معرّف حزمة التحديث");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      await fs.rename(partial, tarPath);
    }
    return releaseInfo(tarPath, sha256);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function buildRelease(): Promise<ReleaseInfo> {
  const distDir = await findDistDir();
  const rel = await buildReleaseFromDist(distDir);
  // Best-effort cleanup of older cached releases.
  try {
    const entries = await fs.readdir("/tmp");
    await Promise.all(entries
      .filter(f => f.startsWith("zacod-release-") && f !== path.basename(rel.tarPath))
      .map(f => fs.rm(path.join("/tmp", f), { force: true })));
  } catch { /* ignore */ }
  return rel;
}

/**
 * Immutable version+tarball of the current built dist.
 *
 * Normal release downloads share one cached archive. Explicit package
 * preparation must pass forceRebuild so clicking "prepare a new release" after
 * a fresh build cannot silently reuse an archive prepared from an older dist.
 */
export async function getReleaseInfo(options: { forceRebuild?: boolean } = {}): Promise<ReleaseInfo> {
  if (options.forceRebuild || !inFlight) {
    const pending = buildRelease();
    inFlight = pending;
    pending.catch(() => {
      if (inFlight === pending) inFlight = null;
    });
  }
  return inFlight;
}
