// ─── System Auto-Discovery Registry ───────────────────────────────────────────
//
// Reflective registry for the SuperAdmin AI Repair screen.
// "Auto-discovery" means: nothing here is hand-maintained. Any new Express
// router, any new DB table, any new frontend page (.tsx) under
// `artifacts/zatca-invoicing/src/pages/` is automatically picked up.
//
// Sources:
//   1. Express router stack reflection  → API modules + endpoints
//   2. PostgreSQL `pg_tables`           → DB domains
//   3. Filesystem scan of pages/        → Frontend screens (categorized)
//   4. Regex over SuperAdmin*.tsx       → Dashboard widgets (KPIs/cards)
//
// All paths are tagged with a `scope` (`superadmin` | `tenant` | `shared`)
// using path heuristics so the consumer can filter for the SuperAdmin view.

import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type Scope = "superadmin" | "tenant" | "shared";

export type ApiEndpoint  = { method: string; path: string; scope: Scope };
export type ApiModule    = { mount: string; scope: Scope; endpoints: ApiEndpoint[] };
export type DbDomain     = { table: string; rowCountApprox: number | null };
export type ScreenEntry  = { file: string; route: string; scope: Scope; category: string };
export type DashWidget   = { title: string; kind: "kpi" | "card" | "section"; source: string };

export type SystemTree = {
  generatedAt: string;
  scopeFilter: Scope | "all";
  apiModules:        ApiModule[];
  dbDomains:         DbDomain[];
  screens:           ScreenEntry[];
  dashboardWidgets:  DashWidget[];
  totals: {
    apiModules: number; apiEndpoints: number;
    dbTables: number; screens: number; dashboardWidgets: number;
  };
};

// ─── Scope tagging heuristics ────────────────────────────────────────────────
function scopeForApiPath(p: string): Scope {
  if (p.startsWith("/admin")) return "superadmin";
  if (p.startsWith("/companies")) return "superadmin";
  if (p.startsWith("/auth") || p === "/health") return "shared";
  return "tenant";
}
function scopeForScreenPath(rel: string): Scope {
  // rel is like "SuperAdminDashboard.tsx" or "admin/AICompanyFix.tsx"
  if (/^SuperAdmin/i.test(rel)) return "superadmin";
  if (rel.startsWith("admin/")) return "superadmin";
  if (rel.startsWith("Companies") || rel.startsWith("CompanyDetails") || rel.startsWith("CompanyNew")) return "superadmin";
  if (rel === "Login.tsx" || rel === "Register.tsx") return "shared";
  return "tenant";
}
function categoryForScreen(rel: string): string {
  const top = rel.split("/")[0];
  if (top.endsWith(".tsx")) return "general";
  return top;
}

// ─── 1. API discovery via source-file reflection ─────────────────────────────
// Express 5 dropped `layer.regexp`, so runtime walking can't recover mount
// paths. Source-file reflection is both more reliable and gives a richer
// picture (including comments / route shape). It is still fully auto-
// discovered: nothing is hand-maintained, we just parse the actual code.
//
// 1. Read routes/index.ts → extract `router.use("/foo", barRouter)` lines
//    plus the matching `import barRouter from "./bar"` to resolve files.
// 2. For each module file, extract `router.<method>("/path", …)` definitions.
const ROUTES_DIR_CANDIDATES = [
  path.resolve(process.cwd(), "artifacts/api-server/src/routes"),
  path.resolve(process.cwd(), "src/routes"),
];
async function findRoutesDir(): Promise<string | null> {
  for (const p of ROUTES_DIR_CANDIDATES) {
    try { await fs.access(path.join(p, "index.ts")); return p; } catch { /* keep looking */ }
  }
  return null;
}
async function parseRouteModule(absFile: string): Promise<{ method: string; path: string }[]> {
  let src = "";
  try { src = await fs.readFile(absFile, "utf8"); } catch { return []; }
  const out: { method: string; path: string }[] = [];
  // Match e.g. `router.get("/foo/:id", …)` or `router.post(`/x`, …)` —
  // accepts single, double, and back-tick string literals; ignores indentation.
  const re = /\brouter\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*(["'`])([^"'`]+)\2/g;
  for (let m; (m = re.exec(src)); ) {
    const method = m[1].toUpperCase();
    const p = m[3];
    if (method === "USE") continue; // mounting middleware, not a leaf route
    out.push({ method, path: p });
  }
  return out;
}
export async function discoverApiModules(scopeFilter: Scope | "all"): Promise<ApiModule[]> {
  const dir = await findRoutesDir();
  if (!dir) return [];
  const indexSrc = await fs.readFile(path.join(dir, "index.ts"), "utf8");

  // Map var-name → relative file (without extension). Handles single & double quotes.
  const importRe = /import\s+(\w+)\s+from\s+["']\.\/([\w\-./]+)["']/g;
  const varToFile = new Map<string, string>();
  for (let m; (m = importRe.exec(indexSrc)); ) varToFile.set(m[1], m[2]);

  // Mount declarations. Two valid forms:
  //   router.use("/path", varName)   → prefixed mount
  //   router.use(varName)            → root-level mount (e.g. healthRouter)
  // We accept both so no module is silently dropped.
  const prefixedRe = /router\s*\.\s*use\s*\(\s*["']([^"']+)["']\s*,\s*(\w+)\s*\)/g;
  const bareRe     = /router\s*\.\s*use\s*\(\s*(\w+)\s*\)/g;
  const mounts: Array<{ mount: string; varName: string }> = [];
  for (let m; (m = prefixedRe.exec(indexSrc)); ) {
    mounts.push({ mount: m[1], varName: m[2] });
  }
  for (let m; (m = bareRe.exec(indexSrc)); ) {
    // The bare regex also matches `router.use("/x", v)` (it sees the `/x`
    // string literal as nothing). Filter out vars already captured prefixed.
    if (mounts.some(x => x.varName === m[1])) continue;
    // Only treat as a router mount if the var is one of our imports.
    if (!varToFile.has(m[1])) continue;
    mounts.push({ mount: "/", varName: m[1] });
  }

  const modules: ApiModule[] = [];
  for (const { mount, varName } of mounts) {
    const file = varToFile.get(varName);
    if (!file) continue;
    const sc = scopeForApiPath(mount);
    if (scopeFilter !== "all" && sc !== scopeFilter && sc !== "shared") continue;
    const candidates = [
      path.join(dir, `${file}.ts`),
      path.join(dir, file, "index.ts"),
    ];
    let endpoints: ApiEndpoint[] = [];
    for (const abs of candidates) {
      const found = await parseRouteModule(abs);
      if (found.length) {
        const prefix = mount === "/" ? "" : mount;
        endpoints = found.map(e => ({
          method: e.method,
          path: (prefix + (e.path === "/" ? "/" : e.path)) || "/",
          scope: sc,
        }));
        break;
      }
    }
    modules.push({
      mount, scope: sc,
      endpoints: endpoints.sort((a, b) => a.path.localeCompare(b.path)),
    });
  }
  return modules.sort((a, b) => a.mount.localeCompare(b.mount));
}

// ─── 2. DB domains via pg_tables ─────────────────────────────────────────────
export async function discoverDbDomains(): Promise<DbDomain[]> {
  // Use the Postgres planner statistics — no full COUNT(*) per table (would be
  // slow on large tables and the SuperAdmin tree only needs an order-of-mag.).
  const res = await db.execute(sql`
    SELECT c.relname AS table,
           CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END AS row_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND c.relname NOT LIKE 'sql\\_%' ESCAPE '\\'
      AND c.relname <> '__drizzle_migrations'
    ORDER BY c.relname
  `);
  const rows = (res as any).rows ?? [];
  return rows.map((r: any) => ({
    table: String(r.table),
    rowCountApprox: r.row_count == null ? null : Number(r.row_count),
  }));
}

// ─── 3. Frontend pages filesystem scan ───────────────────────────────────────
// Walks artifacts/zatca-invoicing/src/pages/**/*.tsx from disk. Naturally
// reflects any new file the moment it lands in the repo — no registry to
// keep in sync with code.
const PAGES_ROOT_CANDIDATES = [
  path.resolve(process.cwd(), "artifacts/zatca-invoicing/src/pages"),
  path.resolve(process.cwd(), "../zatca-invoicing/src/pages"),
];
async function findPagesRoot(): Promise<string | null> {
  for (const p of PAGES_ROOT_CANDIDATES) {
    try { await fs.access(p); return p; } catch { /* keep looking */ }
  }
  return null;
}
async function listTsxRecursive(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  const here = path.join(root, rel);
  let entries: any[] = [];
  try { entries = await fs.readdir(here, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...await listTsxRecursive(root, childRel));
    else if (ent.isFile() && ent.name.endsWith(".tsx")) out.push(childRel);
  }
  return out;
}
function relToRoute(rel: string): string {
  // Best-effort: pages mostly mirror routes. Convert PascalCase → kebab-case,
  // correctly splitting consecutive caps (e.g. "AICompanyFix" → "ai-company-fix",
  // "URLShortener" → "url-shortener").
  const noExt = rel.replace(/\.tsx$/, "");
  const segs  = noExt.split("/").map(s =>
    s
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")  // ABCDef → ABC-Def
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")     // aB     → a-B
      .toLowerCase()
  );
  return "/" + segs.join("/");
}
export async function discoverFrontendScreens(scopeFilter: Scope | "all"): Promise<ScreenEntry[]> {
  const root = await findPagesRoot();
  if (!root) return [];
  const files = await listTsxRecursive(root);
  return files
    .map(rel => ({
      file: rel,
      route: relToRoute(rel),
      scope: scopeForScreenPath(rel),
      category: categoryForScreen(rel),
    }))
    .filter(s => scopeFilter === "all" || s.scope === scopeFilter || s.scope === "shared")
    .sort((a, b) => (a.category + a.file).localeCompare(b.category + b.file));
}

// ─── 4. Dashboard widgets via source regex ───────────────────────────────────
// Reads SuperAdminDashboard.tsx and pulls every widget label. Two patterns:
//   - inline KPI arrays:   { label: "إجمالي الشركات", ... }
//   - <CardTitle>...</CardTitle> blocks
// Adding a new widget = adding a card → discovered next request, no code edit.
async function readSourceIfExists(rel: string): Promise<{ src: string; abs: string } | null> {
  const candidates = [
    path.resolve(process.cwd(), "artifacts/zatca-invoicing/src", rel),
    path.resolve(process.cwd(), "../zatca-invoicing/src", rel),
  ];
  for (const abs of candidates) {
    try { return { src: await fs.readFile(abs, "utf8"), abs }; }
    catch { /* keep looking */ }
  }
  return null;
}
function dedupePush(arr: DashWidget[], w: DashWidget) {
  const t = w.title.trim();
  if (!t) return;
  // Reject obvious non-widget noise picked up by string-literal scanning:
  //  - regex backreferences such as "$1", "$2" (from inline replace()s)
  //  - very short symbol-only strings
  //  - mostly punctuation
  if (/^\$\d+$/.test(t)) return;
  if (t.length < 2) return;
  if (!/[\p{L}\p{N}]/u.test(t)) return;
  arr.push({ ...w, title: t });
  // Dedupe (last wins on title+source).
  const seen = new Set<string>();
  for (let i = arr.length - 1; i >= 0; i--) {
    const k = arr[i].title + "|" + arr[i].source;
    if (seen.has(k)) arr.splice(i, 1); else seen.add(k);
  }
}
export async function discoverDashboardWidgets(scopeFilter: Scope | "all" = "superadmin"): Promise<DashWidget[]> {
  // Scope-aware: by default we only mine SuperAdmin pages (which is what the
  // AI Repair screen needs). When the caller asks for tenant or all, we widen
  // the candidate file set accordingly so the response is internally
  // consistent with `scopeFilter`.
  const root = await findPagesRoot();
  if (!root) return [];
  const all = await listTsxRecursive(root);
  const targets = all.filter(f => {
    const sc = scopeForScreenPath(f);
    if (scopeFilter === "all") return true;
    if (scopeFilter === "superadmin") return sc === "superadmin";
    if (scopeFilter === "tenant")     return sc === "tenant" || sc === "shared";
    if (scopeFilter === "shared")     return sc === "shared";
    return false;
  });

  const out: DashWidget[] = [];
  for (const rel of targets) {
    const loaded = await readSourceIfExists(`pages/${rel}`);
    if (!loaded) continue;
    const src = loaded.src;
    const sourceLabel = rel;

    // KPI / stat objects: { label: "..." , value: ... }
    const kpiRe = /\{\s*label:\s*"([^"]+)"[\s\S]*?value:/g;
    for (let m; (m = kpiRe.exec(src)); ) {
      dedupePush(out, { title: m[1], kind: "kpi", source: sourceLabel });
    }
    // Strip nested JSX expressions and tags from a chunk of source-as-text.
    // ORDER MATTERS: kill `{...}` first (so arrow-function `=>` inside
    // expressions doesn't get treated as a tag closer), then strip `<...>`.
    const cleanJsxText = (chunk: string) =>
      chunk
        .replace(/\{[^{}]*\}/g, " ")        // {expr} — non-nested is enough here
        .replace(/<[^>]+>/g, " ")           // JSX tags
        .replace(/\s+/g, " ")
        .trim();

    // Section titles inside <CardTitle>…</CardTitle>. We take just the first
    // line of cleaned text — anything after a newline is almost always action
    // buttons / icons embedded in the title, not the title itself.
    const titleRe = /<CardTitle[^>]*>([\s\S]*?)<\/CardTitle>/g;
    for (let m; (m = titleRe.exec(src)); ) {
      const lines = m[1].split(/\n/).map(cleanJsxText).filter(Boolean);
      const title = lines[0] || "";
      if (title) dedupePush(out, { title, kind: "section", source: sourceLabel });
    }
    // Top-level h1 heading (page title) — counts as a "card" entry
    const h1 = src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    if (h1) {
      const lines = h1[1].split(/\n/).map(cleanJsxText).filter(Boolean);
      const title = lines[0] || "";
      if (title) dedupePush(out, { title, kind: "card", source: sourceLabel });
    }
  }
  return out.sort((a, b) => a.source.localeCompare(b.source) || a.title.localeCompare(b.title));
}

// ─── Aggregator ──────────────────────────────────────────────────────────────
export async function buildSystemTree(
  scopeFilter: Scope | "all" = "superadmin",
): Promise<SystemTree> {
  const [apiModules, dbDomains, screens, dashboardWidgets] = await Promise.all([
    discoverApiModules(scopeFilter),
    discoverDbDomains(),
    discoverFrontendScreens(scopeFilter),
    discoverDashboardWidgets(scopeFilter),
  ]);

  const apiEndpoints = apiModules.reduce((s, m) => s + m.endpoints.length, 0);
  return {
    generatedAt: new Date().toISOString(),
    scopeFilter,
    apiModules, dbDomains, screens, dashboardWidgets,
    totals: {
      apiModules: apiModules.length,
      apiEndpoints,
      dbTables: dbDomains.length,
      screens: screens.length,
      dashboardWidgets: dashboardWidgets.length,
    },
  };
}
