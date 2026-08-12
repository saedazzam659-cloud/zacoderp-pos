// Release bundle for «full» edition agent servers.
//
// The bundle is a tar.gz of the api-server's own built dist directory
// (single esbuild bundle + pino/pdf workers + public/ SPA assets). Version is
// the sha256 of index.mjs — every central Publish changes it, and the agents'
// cron updater picks the new version automatically (same publish policy).
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ReleaseInfo {
  version: string;
  tarPath: string;
  sizeBytes: number;
}

let inFlight: Promise<ReleaseInfo> | null = null;

function findDistDir(): Promise<string> {
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

async function buildRelease(): Promise<ReleaseInfo> {
  const distDir = await findDistDir();
  const bundle = await fs.readFile(path.join(distDir, "index.mjs"));
  const version = createHash("sha256").update(bundle).digest("hex").slice(0, 16);
  const tarPath = path.join("/tmp", `zacod-release-${version}.tgz`);
  try {
    const st = await fs.stat(tarPath);
    return { version, tarPath, sizeBytes: st.size };
  } catch { /* build below */ }
  const partial = `${tarPath}.partial-${process.pid}`;
  await new Promise<void>((resolve, reject) => {
    execFile("tar", ["-czf", partial, "--exclude=*.map", "-C", distDir, "."],
      { timeout: 120_000 }, (err, _o, stderr) => {
        if (err) reject(new Error(`تعذّر بناء حزمة النسخة: ${String(stderr || err.message).slice(0, 200)}`));
        else resolve();
      });
  });
  await fs.rename(partial, tarPath);
  // Best-effort cleanup of older cached releases.
  try {
    const entries = await fs.readdir("/tmp");
    await Promise.all(entries
      .filter(f => f.startsWith("zacod-release-") && f !== path.basename(tarPath) && !f.includes(".partial"))
      .map(f => fs.rm(path.join("/tmp", f), { force: true })));
  } catch { /* ignore */ }
  const st = await fs.stat(tarPath);
  return { version, tarPath, sizeBytes: st.size };
}

/** Version+cached tarball of the current running build (single-flight). */
export async function getReleaseInfo(): Promise<ReleaseInfo> {
  if (!inFlight) {
    inFlight = buildRelease().finally(() => { inFlight = null; });
  }
  return inFlight;
}
