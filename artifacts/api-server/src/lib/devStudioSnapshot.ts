// ─────────────────────────────────────────────────────────────────────────
// DevStudio snapshot engine — captures an ISOLATED, version-pinned copy of the
// codebase that developers read from. They NEVER touch the live filesystem; all
// reads are served from a frozen snapshot blob (gzip→base64 JSON) stored in
// dev_studio_snapshots.content. This gives us:
//   • isolation     — live edits cannot affect what a developer sees,
//   • version pinning — the SuperAdmin distributes a chosen snapshot per dev,
//   • safety        — no clone/download/terminal; content is read-only here.
//
// Capture is curated (source trees + key configs, text only, size-capped) so the
// blob stays small. Nothing secret is captured (.env/keys/dist are excluded).
// ─────────────────────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { logger } from "./logger";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export interface SnapshotData {
  paths: string[];
  files: Record<string, string>;
}

// Roots we capture from (relative to repo root). Curated to keep blobs small.
const CAPTURE_ROOTS = ["artifacts", "lib", "scripts"];
const ROOT_FILES = ["package.json", "pnpm-workspace.yaml", "tsconfig.base.json", "replit.md"];

// Only descend into these subdirs of an artifact/lib package (skip dist/node_modules/etc).
const ALLOWED_PACKAGE_SUBDIRS = new Set(["src"]);

// Never descend into these directory names anywhere.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".cache", "coverage",
  ".turbo", "target", "out", ".vite", ".local", ".agents", "attached_assets",
]);

// Text source extensions worth showing a developer.
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".scss",
  ".html", ".md", ".sql", ".yaml", ".yml", ".toml", ".rs", ".sh", ".env.example",
]);

const MAX_FILE_BYTES = 200 * 1024; // skip files larger than 200KB
const MAX_TOTAL_BYTES = 24 * 1024 * 1024; // safety cap on a whole snapshot (24MB raw)

// Resolve the monorepo root by walking up until pnpm-workspace.yaml is found.
let cachedRoot: string | null = null;
async function repoRoot(): Promise<string> {
  if (cachedRoot) return cachedRoot;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    try {
      await fs.access(path.join(dir, "pnpm-workspace.yaml"));
      cachedRoot = dir;
      return dir;
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = process.cwd();
  return cachedRoot;
}

function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith(".env.example")) return true;
  return TEXT_EXT.has(path.extname(lower));
}

async function walk(absDir: string, relDir: string, depth: number, out: SnapshotData, totalRef: { bytes: number }): Promise<void> {
  if (totalRef.bytes >= MAX_TOTAL_BYTES) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const relPath = relDir ? `${relDir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      // At the package level (artifacts/<pkg>/<sub> or lib/<pkg>/<sub>), only
      // descend into ALLOWED_PACKAGE_SUBDIRS to skip dist/node_modules quickly.
      const parts = relPath.split("/");
      const inPackage = (parts[0] === "artifacts" || parts[0] === "lib") && parts.length === 3;
      if (inPackage && !ALLOWED_PACKAGE_SUBDIRS.has(ent.name)) continue;
      await walk(path.join(absDir, ent.name), relPath, depth + 1, out, totalRef);
    } else if (ent.isFile()) {
      if (!isTextFile(ent.name)) continue;
      try {
        const stat = await fs.stat(path.join(absDir, ent.name));
        if (stat.size > MAX_FILE_BYTES) continue;
        if (totalRef.bytes + stat.size >= MAX_TOTAL_BYTES) continue;
        const content = await fs.readFile(path.join(absDir, ent.name), "utf8");
        out.files[relPath] = content;
        out.paths.push(relPath);
        totalRef.bytes += stat.size;
      } catch { /* unreadable file — skip */ }
    }
  }
}

// Capture a curated snapshot of the current source tree. Returns the data plus
// a compressed (gzip→base64) blob suitable for dev_studio_snapshots.content.
export async function captureSnapshot(): Promise<{ data: SnapshotData; blob: string; fileCount: number; byteSize: number }> {
  const root = await repoRoot();
  const out: SnapshotData = { paths: [], files: {} };
  const totalRef = { bytes: 0 };

  for (const r of CAPTURE_ROOTS) {
    await walk(path.join(root, r), r, 0, out, totalRef);
  }
  for (const f of ROOT_FILES) {
    try {
      const abs = path.join(root, f);
      const stat = await fs.stat(abs);
      if (stat.size <= MAX_FILE_BYTES) {
        out.files[f] = await fs.readFile(abs, "utf8");
        out.paths.push(f);
      }
    } catch { /* missing root file — skip */ }
  }

  out.paths.sort();
  const json = JSON.stringify(out);
  const blob = (await gzip(Buffer.from(json, "utf8"))).toString("base64");
  logger.info({ files: out.paths.length, rawBytes: totalRef.bytes, blobBytes: blob.length }, "devStudio.captureSnapshot");
  return { data: out, blob, fileCount: out.paths.length, byteSize: totalRef.bytes };
}

// In-memory decompressed cache keyed by snapshot id (blobs are immutable once
// published, so caching is safe). Bounded to a handful of entries.
const cache = new Map<number, SnapshotData>();
const CACHE_MAX = 6;

export async function loadSnapshot(snapshotId: number, blob: string | null): Promise<SnapshotData> {
  const hit = cache.get(snapshotId);
  if (hit) return hit;
  if (!blob) return { paths: [], files: {} };
  const json = (await gunzip(Buffer.from(blob, "base64"))).toString("utf8");
  const data = JSON.parse(json) as SnapshotData;
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(snapshotId, data);
  return data;
}

// A path is visible to a developer iff it equals, or sits under, an allowed prefix.
export function isPathVisible(p: string, allowedPrefixes: string[]): boolean {
  if (!allowedPrefixes.length) return false;
  return allowedPrefixes.some((pre) => {
    const prefix = pre.replace(/\/+$/, "");
    return p === prefix || p.startsWith(prefix + "/");
  });
}

// Filter a snapshot's paths down to those a developer is allowed to see.
export function scopedPaths(data: SnapshotData, allowedPrefixes: string[]): string[] {
  return data.paths.filter((p) => isPathVisible(p, allowedPrefixes));
}

export function countLines(content: string): number {
  if (!content) return 0;
  return content.split("\n").length;
}
