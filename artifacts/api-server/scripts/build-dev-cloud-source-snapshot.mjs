import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "../../..");
const outputPath = path.join(workspaceRoot, "artifacts/api-server/dist/dev-cloud-source.tar.gz");
const MAX_SOURCE_FILE_BYTES = 32 * 1024 * 1024;
const sourceExtensions = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc",
  ".yaml", ".yml", ".toml", ".md", ".css", ".html", ".svg", ".sql",
  ".sh", ".nix", ".txt",
]);
const rootSourceFiles = new Set([
  ".replit", ".replitignore", "README.md", "replit.md", "replit.nix",
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json",
  "tsconfig.base.json",
]);
const excludedDirs = new Set([
  ".git", ".local", ".agents", "node_modules", "dist", ".cache", "exports",
  "generated-artifacts", "tmp", "test-results", "playwright-report", "coverage",
  "storage", ".expo", ".expo-shared", "target", ".config", ".pythonlibs",
  "attached_assets",
]);
const excludedFile = /(^|\/)\.env($|\.(?!example$))|(^|\/)(id_rsa|id_ed25519|credentials|hosts\.yml|service-account)(\.|$)|(^|\/)\.npmrc$|\.(pem|key|p8|p12|pfx|crt|cer|sql|dump|sqlite|db|tar|tgz|zip|7z|rar|log)$/i;

function isExcluded(file) {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.split("/").some((part) => excludedDirs.has(part))) return true;
  if (excludedFile.test(normalized)) return true;
  return false;
}

async function walk(directory, relative = "") {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (isExcluded(rel)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...await walk(full, rel));
    } else if (entry.isFile()) {
      const info = await fs.stat(full);
      if (info.size <= MAX_SOURCE_FILE_BYTES) found.push(rel);
    }
  }
  return found;
}

async function trackedFiles() {
  try {
    const { stdout } = await execFileAsync("git", [
      "ls-files", "--cached", "--others", "--exclude-standard", "-z",
    ], { cwd: workspaceRoot, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
    return stdout.toString("utf8").split("\0").filter(Boolean);
  } catch {
    // Minimal safe fallback for source archives outside a Git checkout.
    const roots = [
      "artifacts", "lib", "scripts", "package.json", "pnpm-lock.yaml",
      "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.base.json",
      "replit.md", "README.md", "replit.nix", ".replit", ".replitignore",
    ];
    const files = [];
    for (const entry of roots) {
      const full = path.join(workspaceRoot, entry);
      try {
        const stat = await fs.stat(full);
        if (stat.isDirectory()) files.push(...await walk(full, entry));
        else if (stat.isFile()) files.push(entry);
      } catch { /* optional project file */ }
    }
    return files;
  }
}

async function build() {
  const candidates = await trackedFiles();
  const files = [];
  for (const candidate of candidates) {
    if (isExcluded(candidate)) continue;
    const topLevel = candidate.split("/")[0];
    const extension = path.extname(candidate).toLowerCase();
    if (!rootSourceFiles.has(candidate)
        && !["artifacts", "lib", "scripts"].includes(topLevel)
        || (!rootSourceFiles.has(candidate) && !sourceExtensions.has(extension))) continue;
    const full = path.resolve(workspaceRoot, candidate);
    if (!full.startsWith(`${workspaceRoot}${path.sep}`)) continue;
    try {
      const info = await fs.stat(full);
      if (info.isFile() && info.size <= MAX_SOURCE_FILE_BYTES) files.push(candidate);
    } catch { /* a tracked path may have been removed from the worktree */ }
  }
  files.sort();
  if (!files.length) throw new Error("No source files were eligible for the Developer Cloud snapshot");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dev-cloud-source-"));
  const listPath = path.join(tempDir, "files.list");
  const partialPath = `${outputPath}.partial-${process.pid}`;
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(listPath, `${files.join("\0")}\0`, { mode: 0o600 });
    await execFileAsync("tar", [
      "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
      "--format=gnu", "-czf", partialPath, "-C", workspaceRoot, "--null", "-T", listPath,
    ], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
    await fs.rename(partialPath, outputPath);
  } finally {
    await fs.rm(partialPath, { force: true }).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

build().catch((error) => {
  process.stderr.write(`Failed to build Developer Cloud source snapshot: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
