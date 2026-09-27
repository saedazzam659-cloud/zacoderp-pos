// Immutable full-agent archives contain the built API and the SPA actually served
// by central. Never run a production build as part of a release request.
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

const cached = new Map<string, ReleaseInfo>();
const flights = new Map<string, Promise<ReleaseInfo>>();

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

export async function findDistDir(): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), "dist"),
    path.resolve(process.cwd(), "artifacts/api-server/dist"),
    process.argv[1] ? path.dirname(process.argv[1]) : "",
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      await fs.access(path.join(dir, "index.mjs"));
      return dir;
    } catch { /* next */ }
  }
  throw new Error("حزمة النسخة الكاملة غير متاحة — لم يتم العثور على ملفات البناء (dist/index.mjs)");
}

// Match app.readSpaIndexHtml's central deployment locations. A present web
// artifact is authoritative even if its build is missing: never fall back to
// an old API dist/public in that case.
async function webSource(distDir: string): Promise<string> {
  const apiArtifact = path.dirname(path.resolve(distDir));
  // An API artifact in a monorepo requires its sibling web build, even if
  // that artifact has been deleted or has not yet produced dist/public.
  if (path.basename(apiArtifact) === "api-server" && path.basename(path.dirname(apiArtifact)) === "artifacts") {
    return path.resolve(apiArtifact, "..", "zatca-invoicing/dist/public");
  }
  // Supports explicit workspace fixtures that pass root/dist to this helper.
  const sibling = path.resolve(path.dirname(distDir), "artifacts/zatca-invoicing");
  try {
    if ((await fs.stat(sibling)).isDirectory()) return path.join(sibling, "dist/public");
  } catch { /* standalone */ }
  return path.join(distDir, "public");
}

async function validateWeb(publicDir: string): Promise<void> {
  let html: string;
  try {
    html = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
    if (!html.trim()) throw new Error("empty index");
    // Every hashed Vite asset named by the entry page must exist in the
    // captured tree. A missing chunk must not be hidden by an older snapshot.
    for (const match of html.matchAll(/(?:src|href)=["']\/?(assets\/[^"'?#]+)(?:[?#][^"']*)?["']/g)) {
      const asset = path.resolve(publicDir, match[1]);
      if (!asset.startsWith(path.resolve(publicDir) + path.sep) || !(await fs.stat(asset)).isFile()) {
        throw new Error(`missing asset: ${match[1]}`);
      }
    }
  } catch (error: any) {
    throw new Error(`حزمة Frontend غير مكتملة — ابنِ تطبيق zatca-invoicing أولًا (${error?.message ?? error})`);
  }
}

async function fingerprint(dir: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(current: string, relative: string): Promise<void> {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        hash.update(name + "/\0");
        await visit(path.join(current, entry.name), name);
      }
      else if (entry.isFile() && !name.endsWith(".map")) {
        hash.update(name + "\0");
        hash.update(await hashFile(path.join(current, entry.name)));
      } else if (!entry.isFile()) throw new Error(`ملف غير صالح في حزمة النسخة: ${name}`);
    }
  }
  await visit(dir, "");
  return hash.digest("hex");
}

async function archiveSnapshot(snapshot: string, releaseDir: string, key: string): Promise<ReleaseInfo> {
  const previous = cached.get(key);
  if (previous) {
    try {
      if (await hashFile(previous.tarPath) === previous.sha256) return previous;
    } catch { /* archived file was removed: recreate it */ }
  }
  const partial = path.join(path.dirname(snapshot), "release.tgz");
  await new Promise<void>((resolve, reject) => {
    execFile("tar", [
      "--sort=name", "--mtime=@0", "--owner=0", "--group=0",
      "--numeric-owner", "--format=gnu", "--exclude=*.map",
      "-czf", partial, "-C", snapshot, ".",
    ], { timeout: 120_000 }, (err, _o, stderr) => {
      if (err) reject(new Error(`تعذّر بناء حزمة النسخة: ${String(stderr || err.message).slice(0, 200)}`));
      else resolve();
    });
  });
  const sha256 = await hashFile(partial);
  const tarPath = path.join(releaseDir, `zacod-release-${sha256.slice(0, 16)}.tgz`);
  try {
    // A hard link publishes the completed archive atomically. copyFile could
    // expose a partially written archive to another request.
    await fs.link(partial, tarPath);
  } catch (error: any) {
    if (error?.code !== "EEXIST" || await hashFile(tarPath) !== sha256) throw error;
  }
  const info = await releaseInfo(tarPath, sha256);
  cached.set(key, info);
  return info;
}

export async function buildReleaseFromDist(distDir: string, releaseDir = "/tmp"): Promise<ReleaseInfo> {
  distDir = path.resolve(distDir);
  await fs.access(path.join(distDir, "index.mjs"));
  const workDir = await fs.mkdtemp(path.join(releaseDir, ".zacod-release-build-"));
  try {
    const snapshot = path.join(workDir, "dist");
    const publicSource = await webSource(distDir);
    await validateWeb(publicSource);
    await fs.cp(distDir, snapshot, { recursive: true, filter: (source) =>
      source !== path.join(distDir, "public") && !source.endsWith(".map") });
    await fs.cp(publicSource, path.join(snapshot, "public"), { recursive: true, filter: (source) => !source.endsWith(".map") });
    await validateWeb(path.join(snapshot, "public"));
    const key = `${path.resolve(releaseDir)}:${await fingerprint(snapshot)}`;
    let pending = flights.get(key);
    if (!pending) {
      pending = archiveSnapshot(snapshot, releaseDir, key);
      flights.set(key, pending);
    }
    try { return await pending; }
    finally { if (flights.get(key) === pending) flights.delete(key); }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Resolve an explicitly requested archive, including versions from earlier days. */
export async function getReleaseByVersion(version: string, releaseDir = "/tmp"): Promise<ReleaseInfo> {
  if (!/^[a-f0-9]{16}$/.test(version)) throw new Error("invalid_release_version");
  const tarPath = path.join(releaseDir, `zacod-release-${version}.tgz`);
  let info: ReleaseInfo;
  try { info = await releaseInfo(tarPath); }
  catch (error: any) {
    if (error?.code === "ENOENT") throw new Error("release_archive_missing_reprepare");
    throw error;
  }
  if (info.version !== version) throw new Error("release_archive_corrupt_reprepare");
  return info;
}

/** Extract the exact immutable backend archive for a matching frontend package. */
export async function extractReleaseSnapshot(release: ReleaseInfo, outputDir: string): Promise<string> {
  if (await hashFile(release.tarPath) !== release.sha256) throw new Error("release_archive_corrupt_reprepare");
  const target = path.join(outputDir, "captured-release");
  await fs.mkdir(target);
  await new Promise<void>((resolve, reject) => {
    execFile("tar", ["-xzf", release.tarPath, "-C", target], { timeout: 120_000 }, (err, _o, stderr) => {
      if (err) reject(new Error(`تعذّر فك حزمة النسخة: ${String(stderr || err.message).slice(0, 200)}`));
      else resolve();
    });
  });
  await validateWeb(path.join(target, "public"));
  return target;
}

/** Re-capture built inputs on each request; the fingerprint is of that snapshot. */
export async function getReleaseInfo(_options: { forceRebuild?: boolean } = {}): Promise<ReleaseInfo> {
  return buildReleaseFromDist(await findDistDir());
}