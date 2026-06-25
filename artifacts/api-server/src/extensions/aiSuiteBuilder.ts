import { randomBytes } from "node:crypto";
import { loadOrCreatePlatformKeys } from "./platformKey.js";
import { signManifest } from "./signing.js";
import {
  ExtensionManifestSchema,
  type ExtensionManifest,
  type ExtensionScreenKind,
} from "./manifest.js";
import { listCoreResources } from "./coreDataApi.js";
import { chatJSON, isAIAvailable } from "../lib/aiClient.js";

// ─────────────────────────────────────────────────────────────────────────
// AI Builder — turns a natural-language description into a VALID, SIGNED
// extension manifest scaffold, ready for the Publish engine (the exact shape
// `seedBuiltinExtensions` stores in `platform_extensions`: a manifest that
// passes `ExtensionManifestSchema` + an Ed25519 signature + the public key id).
//
// It NEVER ships executable code — only the declarative manifest. The AI path
// is best-effort; the output is always sanitised + schema-validated, and falls
// back to a deterministic rule-based scaffold if AI is unavailable or returns
// anything invalid. The generated manifest can only ever request READ
// permissions on the hand-picked core resources the gated Core Data API
// exposes — so a scaffold can never widen access beyond the platform's gates.
// ─────────────────────────────────────────────────────────────────────────

export interface ScaffoldResult {
  source: "ai" | "rules";
  valid: boolean;
  manifest: ExtensionManifest;
  signature: string;
  publicKeyId: string;
  notes: string[];
}

// Resources the gated Core Data API actually exposes. A scaffold may request a
// read permission ONLY for one of these; everything else is dropped.
function coreResourceKeys(): string[] {
  return listCoreResources().map((r) => r.resource);
}

// Arabic + English keyword → core resource map for the rule-based path and for
// sanitising/augmenting the AI output.
const RESOURCE_KEYWORDS: Record<string, string[]> = {
  invoices: ["invoice", "invoices", "billing", "sales", "فاتورة", "فواتير", "مبيعات"],
  customers: ["customer", "customers", "client", "clients", "crm", "عميل", "عملاء", "زبون", "زبائن"],
  items: ["item", "items", "product", "products", "stock", "inventory", "صنف", "أصناف", "منتج", "منتجات", "مخزون"],
  suppliers: ["supplier", "suppliers", "vendor", "vendors", "مورد", "موردين", "موردون"],
  accounts: ["account", "accounts", "ledger", "journal", "accounting", "حساب", "حسابات", "محاسبة", "قيد", "قيود", "دفتر"],
};

function detectResources(description: string): string[] {
  const lower = description.toLowerCase();
  const known = new Set(coreResourceKeys());
  const out: string[] = [];
  for (const [resource, words] of Object.entries(RESOURCE_KEYWORDS)) {
    if (!known.has(resource)) continue;
    if (words.some((w) => lower.includes(w))) out.push(resource);
  }
  return out;
}

function slugify(input: string, seed: string): string {
  let s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (s.length < 2) s = `ext-${seed}`;
  if (!/^[a-z0-9]/.test(s)) s = `e-${s}`.replace(/-+/g, "-");
  return s;
}

function tableSlug(input: string, fallback: string): string {
  let s = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 40);
  if (s.length < 1 || !/^[a-z0-9]/.test(s)) s = fallback;
  return s;
}

// Deterministic, always-valid scaffold derived purely from keywords. This is
// the fallback when AI is off/unavailable, and the safety net when AI output
// fails validation.
function ruleScaffold(description: string, seed: string): ExtensionManifest {
  const trimmed = description.trim();
  const resources = detectResources(trimmed);
  const permissions = resources.map((r) => `${r}:read`);

  const lower = trimmed.toLowerCase();
  const wantsReport = /report|تقرير|تقارير/.test(lower);
  const wantsDashboard = /dashboard|لوحة|kpi|مؤشرات|إحصائيات/.test(lower);

  const screens: Array<{ key: string; titleAr: string; titleEn?: string; kind: ExtensionScreenKind; icon?: string }> = [
    { key: "home", titleAr: "الرئيسية", titleEn: "Home", kind: "screen", icon: "LayoutGrid" },
  ];
  if (wantsDashboard) {
    screens.push({ key: "dashboard", titleAr: "لوحة المعلومات", titleEn: "Dashboard", kind: "dashboard", icon: "LayoutDashboard" });
  }
  if (wantsReport) {
    screens.push({ key: "report", titleAr: "التقرير", titleEn: "Report", kind: "report", icon: "FileBarChart" });
  }

  // One owned collection so the scaffold persists its own data out of the box.
  let recordsKey = "records";
  if (/note|ملاحظ/.test(lower)) recordsKey = "notes";
  else if (/task|مهم/.test(lower)) recordsKey = "tasks";
  else if (/log|سجل/.test(lower)) recordsKey = "logs";
  recordsKey = tableSlug(recordsKey, "records");

  const slug = slugify(trimmed.split(/\s+/).slice(0, 4).join(" "), seed);

  return {
    manifestVersion: 1,
    extensionId: slug,
    name: { ar: trimmed.slice(0, 80) || "إضافة مُولّدة", en: "Generated Extension" },
    version: "0.1.0",
    vendor: "AI Builder",
    description:
      trimmed.slice(0, 500) ||
      "هيكل إضافة مُولّد آليًا. يقرأ بيانات النواة عبر الواجهة المُقيّدة بالصلاحيات ويخزّن بياناته الخاصة في جدول الإضافة.",
    screens,
    apiRoutes: [],
    tables: [{ key: recordsKey, titleAr: "السجلات", titleEn: "Records" }],
    permissions,
  };
}

interface RawAiManifest {
  extensionId?: unknown;
  name?: { ar?: unknown; en?: unknown } | unknown;
  version?: unknown;
  vendor?: unknown;
  description?: unknown;
  screens?: unknown;
  tables?: unknown;
  permissions?: unknown;
}

// Coerce an AI-produced object into something that has a chance of passing the
// strict schema, and CLAMP its requested permissions to read-only on known
// core resources. Never trusts the AI to widen access.
function sanitizeAiManifest(raw: RawAiManifest, description: string, seed: string): ExtensionManifest {
  const known = new Set(coreResourceKeys());
  const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

  const nameObj = (raw.name && typeof raw.name === "object" ? raw.name : {}) as { ar?: unknown; en?: unknown };
  const ar = str(nameObj.ar).trim() || description.slice(0, 80) || "إضافة مُولّدة";
  const en = str(nameObj.en).trim() || undefined;

  const rawScreens = Array.isArray(raw.screens) ? raw.screens : [];
  const screens = rawScreens
    .map((s: any) => {
      const kind: ExtensionScreenKind = ["screen", "report", "dashboard"].includes(s?.kind) ? s.kind : "screen";
      const key = tableSlug(str(s?.key), "");
      const titleAr = str(s?.titleAr).trim() || str(s?.titleEn).trim() || "شاشة";
      if (!key) return null;
      return {
        key: key.slice(0, 64),
        titleAr: titleAr.slice(0, 120),
        titleEn: str(s?.titleEn).trim() ? str(s.titleEn).trim().slice(0, 120) : undefined,
        icon: str(s?.icon).trim() ? str(s.icon).trim().slice(0, 64) : undefined,
        kind,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s != null)
    .slice(0, 50);
  if (screens.length === 0) screens.push({ key: "home", titleAr: "الرئيسية", titleEn: "Home", icon: undefined, kind: "screen" });

  const rawTables = Array.isArray(raw.tables) ? raw.tables : [];
  const tables = rawTables
    .map((t: any) => {
      const key = tableSlug(str(t?.key), "");
      if (!key) return null;
      return {
        key: key.slice(0, 64),
        titleAr: (str(t?.titleAr).trim() || "السجلات").slice(0, 120),
        titleEn: str(t?.titleEn).trim() ? str(t.titleEn).trim().slice(0, 120) : undefined,
      };
    })
    .filter((t): t is NonNullable<typeof t> => t != null)
    .slice(0, 50);
  if (tables.length === 0) tables.push({ key: "records", titleAr: "السجلات", titleEn: "Records" });

  // CLAMP: read-only, known-resource permissions only.
  const rawPerms = Array.isArray(raw.permissions) ? raw.permissions : [];
  const perms = new Set<string>();
  for (const p of rawPerms) {
    if (typeof p !== "string") continue;
    const m = p.trim().toLowerCase().match(/^([a-z_]+):(read|write)$/);
    if (!m) continue;
    if (!known.has(m[1]!)) continue;
    perms.add(`${m[1]}:read`); // never grant write from an AI scaffold
  }

  const extId = slugify(str(raw.extensionId).trim() || ar, seed);

  return {
    manifestVersion: 1,
    extensionId: extId,
    name: { ar: ar.slice(0, 120), en: en?.slice(0, 120) },
    version: /^\d+\.\d+\.\d+/.test(str(raw.version)) ? str(raw.version).slice(0, 32) : "0.1.0",
    vendor: str(raw.vendor).trim() ? str(raw.vendor).trim().slice(0, 120) : "AI Builder",
    description: (str(raw.description).trim() || description.slice(0, 500)).slice(0, 1024),
    screens,
    apiRoutes: [],
    tables,
    permissions: [...perms],
  };
}

async function tryAiScaffold(description: string, seed: string): Promise<ExtensionManifest | null> {
  const resources = coreResourceKeys();
  const sys = [
    "You design declarative manifests for the Zacode ERP Extension Platform.",
    "Return ONLY a JSON object — no prose, no markdown fences.",
    "Fields: extensionId (lowercase a-z0-9 and hyphens, 2-64 chars),",
    "name {ar, en}, version (semver like 0.1.0), vendor, description,",
    "screens [{key, titleAr, titleEn, kind one of screen|report|dashboard, icon (lucide name)}],",
    "tables [{key (lowercase slug a-z0-9_-), titleAr, titleEn}],",
    `permissions: array of "<resource>:read" where resource is one of [${resources.join(", ")}].`,
    "Only request READ permissions, and only for resources clearly implied by the description.",
    "Keep the design minimal, relevant, and in Arabic for the titles. Do not invent core resources.",
  ].join(" ");
  const raw = await chatJSON<RawAiManifest>(
    [
      { role: "system", content: sys },
      { role: "user", content: `الوصف: ${description}` },
    ],
    { maxTokens: 1200, timeoutMs: 25_000 },
  );
  if (!raw || typeof raw !== "object") return null;
  const candidate = sanitizeAiManifest(raw, description, seed);
  const parsed = ExtensionManifestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export async function buildScaffold(description: string): Promise<ScaffoldResult> {
  const seed = randomBytes(4).toString("hex");
  const notes: string[] = [];

  let manifest = ruleScaffold(description, seed);
  let source: "ai" | "rules" = "rules";

  if (isAIAvailable()) {
    try {
      const ai = await tryAiScaffold(description, seed);
      if (ai) {
        manifest = ai;
        source = "ai";
      } else {
        notes.push("تعذّر إنتاج بيان صالح عبر الذكاء الاصطناعي؛ تم استخدام الهيكل القائم على القواعد.");
      }
    } catch {
      notes.push("فشل استدعاء الذكاء الاصطناعي؛ تم استخدام الهيكل القائم على القواعد.");
    }
  } else {
    notes.push("الذكاء الاصطناعي غير متاح؛ تم توليد الهيكل بالقواعد.");
  }

  // Final guarantee the manifest is schema-valid before we sign it.
  const finalParse = ExtensionManifestSchema.safeParse(manifest);
  if (!finalParse.success) {
    manifest = ruleScaffold(description, seed);
    source = "rules";
    notes.push("تم استبدال البيان بهيكل قواعد بعد فشل التحقق النهائي.");
  } else {
    manifest = finalParse.data;
  }

  const keys = await loadOrCreatePlatformKeys();
  const signature = signManifest(keys.privateKey, manifest);

  return {
    source,
    valid: true,
    manifest,
    signature,
    publicKeyId: keys.keyId,
    notes,
  };
}
