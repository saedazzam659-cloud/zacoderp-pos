import crypto from "node:crypto";
import { db, platformExtensionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { chatJSON, isAIAvailable } from "../lib/aiClient.js";
import {
  ExtensionManifestSchema,
  canonicalJson,
  type ExtensionManifest,
} from "./manifest.js";
import { signManifest, verifyManifest } from "./signing.js";
import { loadOrCreatePlatformKeys } from "./platformKey.js";
import { listCoreResources } from "./coreDataApi.js";
import { getBuiltin } from "./registry.js";

// ─────────────────────────────────────────────────────────────────────────
// Extension Platform — Phase 3: Publish Engine.
//
// A one-click pipeline a developer triggers to ship an extension. It runs a
// fixed sequence of STAGED GATES; a failing BLOCKING gate stops the pipeline
// and produces a clear, actionable report — deployment never happens unless
// every blocking gate passes.
//
//   build         — the candidate manifest must be a structurally valid,
//                   schema-conformant ExtensionManifest. (blocking)
//   security_scan — static policy + dependency-style scan: every requested
//                   permission must reference a KNOWN core resource/action
//                   (no privilege escalation), no dangerous strings, no
//                   duplicate keys, permission breadth within policy. (blocking)
//   ai_review     — an AI risk review of the declarative manifest, with a
//                   deterministic rule-based fallback when no AI provider is
//                   configured. A "reject" verdict blocks. (blocking)
//   package       — canonicalise the manifest + compute its sha256 digest.
//   sign          — Ed25519-sign the canonical manifest with the platform key
//                   and immediately re-verify the signature. (blocking)
//   deploy        — upsert the SIGNED manifest into platform_extensions
//                   (status active) so the catalog serves it.
//   monitor       — post-deploy health: re-read the deployed row and confirm
//                   its signature still verifies against the live public key
//                   (the exact gate getActiveExtensions enforces at runtime).
//
// CRITICAL invariant: the pipeline NEVER ingests or stores executable code.
// It only validates, signs and deploys the DECLARATIVE manifest. Executable
// handlers stay in the in-process BUILTINS map (registry.ts).
// ─────────────────────────────────────────────────────────────────────────

export const PUBLISH_STAGES = [
  "build",
  "security_scan",
  "ai_review",
  "package",
  "sign",
  "deploy",
  "monitor",
] as const;
export type PublishStage = (typeof PUBLISH_STAGES)[number];

// A blocking gate failure halts the pipeline and blocks deployment.
const BLOCKING_STAGES: ReadonlySet<PublishStage> = new Set<PublishStage>([
  "build",
  "security_scan",
  "ai_review",
  "sign",
]);

export type GateStatus = "pass" | "warn" | "fail" | "skip";

export interface GateResult {
  stage: PublishStage;
  status: GateStatus;
  summary: string;
  details: string[];
  durationMs: number;
}

export interface PublishReport {
  errors: string[];
  warnings: string[];
  blockedAt: PublishStage | null;
  aiReviewed: boolean;
}

export interface PublishOutcome {
  // pending | running | passed | deployed | failed | blocked
  status: "deployed" | "blocked" | "failed";
  extensionId: string;
  version: string;
  currentStage: PublishStage;
  gates: GateResult[];
  report: PublishReport;
  packageDigest: string | null;
  signature: string | null;
  publicKeyId: string | null;
  deployed: boolean;
  manifest: ExtensionManifest | null;
}

export interface PublishInput {
  manifest: unknown;
}

// Policy knobs for the security gate. Conservative defaults; a developer that
// needs more must justify it (a future review queue), so we warn/flag rather
// than silently allow privilege creep.
const MAX_WRITE_PERMISSIONS = 4;
const MAX_TOTAL_PERMISSIONS = 12;
const MAX_SCREENS = 50;
const MAX_TABLES = 50;
// Patterns that should never appear in a purely declarative manifest. They
// signal an attempt to smuggle executable/abusive content through metadata.
const DANGEROUS_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /<\s*script/i, label: "وسم <script>" },
  { re: /javascript\s*:/i, label: "javascript: URI" },
  { re: /\bon\w+\s*=/i, label: "معالج حدث inline (onX=)" },
  { re: /\beval\s*\(/i, label: "استدعاء eval(" },
  { re: /new\s+Function\s*\(/i, label: "new Function(" },
  { re: /\bimport\s*\(/i, label: "import() ديناميكي" },
  { re: /\.\.\//, label: "مسار اجتياز (../)" },
  { re: /data:\s*text\/html/i, label: "data:text/html URI" },
];

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// Recursively collect every string value in the manifest for content scanning.
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

function firstDuplicate(keys: string[]): string | null {
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) return k;
    seen.add(k);
  }
  return null;
}

// ── Gate: build ────────────────────────────────────────────────────────────
// Validate the candidate against the manifest schema. On success returns the
// parsed manifest (with schema defaults applied) for downstream gates.
function gateBuild(
  raw: unknown,
): { gate: GateResult; manifest: ExtensionManifest | null } {
  const started = Date.now();
  const parsed = ExtensionManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 20)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return {
      manifest: null,
      gate: {
        stage: "build",
        status: "fail",
        summary: "فشل التحقق من بنية البيان (manifest)",
        details: issues.length ? issues : ["البيان غير صالح"],
        durationMs: Date.now() - started,
      },
    };
  }
  const m = parsed.data;
  return {
    manifest: m,
    gate: {
      stage: "build",
      status: "pass",
      summary: `بيان صالح: ${m.screens.length} شاشة، ${m.tables.length} جدول، ${m.permissions.length} صلاحية`,
      details: [],
      durationMs: Date.now() - started,
    },
  };
}

// ── Gate: security_scan ──────────────────────────────────────────────────────
// Static policy + dependency-style scan over the (already valid) manifest.
function gateSecurityScan(m: ExtensionManifest): GateResult {
  const started = Date.now();
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Permission policy — every requested permission must reference a KNOWN
  //    core resource AND that resource must actually allow the action. Anything
  //    else is a privilege-escalation attempt and HARD-fails the scan.
  const known = new Map(listCoreResources().map((r) => [r.resource, r.actions]));
  let writeCount = 0;
  for (const perm of m.permissions) {
    const [resource, action] = perm.split(":");
    const actions = known.get(resource);
    if (!actions) {
      errors.push(`صلاحية لمورد غير معروف: "${perm}" — المورد "${resource}" غير متاح في واجهة بيانات النواة`);
      continue;
    }
    if (action !== "read" && action !== "write") {
      errors.push(`إجراء صلاحية غير صالح: "${perm}"`);
      continue;
    }
    if (!actions.includes(action)) {
      errors.push(`المورد "${resource}" لا يسمح بالإجراء "${action}" (المتاح: ${actions.join("، ")})`);
      continue;
    }
    if (action === "write") writeCount++;
  }

  // 2. Permission breadth — too many writes / total perms is a smell. Warn so
  //    the report is actionable without blocking a legitimately broad app.
  if (writeCount > MAX_WRITE_PERMISSIONS) {
    warnings.push(`عدد صلاحيات الكتابة (${writeCount}) يتجاوز الحد الموصى به (${MAX_WRITE_PERMISSIONS}) — راجع مبدأ الحد الأدنى من الصلاحيات`);
  }
  if (m.permissions.length > MAX_TOTAL_PERMISSIONS) {
    warnings.push(`إجمالي الصلاحيات (${m.permissions.length}) كبير — قلّل الطلبات لتسريع المراجعة`);
  }

  // 3. Duplicate screen / table / api keys — ambiguous routing.
  const dupScreen = firstDuplicate(m.screens.map((s) => s.key));
  if (dupScreen) errors.push(`مفتاح شاشة مكرّر: "${dupScreen}"`);
  const dupTable = firstDuplicate(m.tables.map((t) => t.key));
  if (dupTable) errors.push(`مفتاح جدول مكرّر: "${dupTable}"`);
  const dupRoute = firstDuplicate(m.apiRoutes.map((r) => `${r.method} ${r.path}`));
  if (dupRoute) errors.push(`مسار API مكرّر: "${dupRoute}"`);

  // 4. Surface-area caps (defence in depth alongside the schema .max()).
  if (m.screens.length > MAX_SCREENS) errors.push(`عدد الشاشات يتجاوز الحد (${MAX_SCREENS})`);
  if (m.tables.length > MAX_TABLES) errors.push(`عدد الجداول يتجاوز الحد (${MAX_TABLES})`);

  // 5. Dangerous-string scan across ALL manifest text.
  const strings: string[] = [];
  collectStrings(m, strings);
  for (const s of strings) {
    for (const p of DANGEROUS_PATTERNS) {
      if (p.re.test(s)) {
        errors.push(`محتوى مشبوه في البيان (${p.label}): "${s.slice(0, 60)}"`);
        break;
      }
    }
  }

  const durationMs = Date.now() - started;
  if (errors.length) {
    return {
      stage: "security_scan",
      status: "fail",
      summary: `الفحص الأمني وجد ${errors.length} مشكلة حظر`,
      details: [...errors, ...warnings],
      durationMs,
    };
  }
  return {
    stage: "security_scan",
    status: warnings.length ? "warn" : "pass",
    summary: warnings.length
      ? `اجتاز الفحص الأمني مع ${warnings.length} تنبيه`
      : "اجتاز الفحص الأمني — لا مشاكل",
    details: warnings,
    durationMs,
  };
}

interface AiVerdict {
  verdict: "approve" | "warn" | "reject";
  score: number;
  reasons: string[];
}

// Deterministic rule-based fallback mirroring the AI's job, so the gate works
// (and stays a real gate) even with no AI provider configured.
function ruleBasedReview(m: ExtensionManifest): AiVerdict {
  const reasons: string[] = [];
  let risk = 0;
  const writes = m.permissions.filter((p) => p.endsWith(":write")).length;
  risk += writes * 15;
  risk += Math.max(0, m.permissions.length - 3) * 5;
  if (writes > MAX_WRITE_PERMISSIONS) reasons.push("عدد كبير من صلاحيات الكتابة");
  if (!m.vendor) {
    risk += 10;
    reasons.push("لا يوجد مزوّد (vendor) معرّف");
  }
  if (!m.description) {
    risk += 5;
    reasons.push("لا يوجد وصف للإضافة");
  }
  const score = Math.max(0, Math.min(100, 100 - risk));
  const verdict: AiVerdict["verdict"] = score >= 60 ? (reasons.length ? "warn" : "approve") : "reject";
  if (!reasons.length) reasons.push("لا ملاحظات جوهرية");
  return { verdict, score, reasons };
}

// ── Gate: ai_review ──────────────────────────────────────────────────────────
async function gateAiReview(m: ExtensionManifest): Promise<GateResult> {
  const started = Date.now();
  let verdict: AiVerdict | null = null;
  let usedAi = false;

  if (isAIAvailable()) {
    try {
      const result = await chatJSON<AiVerdict>(
        [
          {
            role: "system",
            content:
              "You are a strict security reviewer for an ERP extension marketplace. " +
              "Review the DECLARATIVE extension manifest (no executable code is provided) " +
              "for risk: over-broad permissions, suspicious metadata, deceptive naming, " +
              "or scope mismatch between the stated purpose and requested access. " +
              'Respond ONLY as JSON: {"verdict":"approve"|"warn"|"reject","score":0-100,"reasons":["..."]}. ' +
              "Use Arabic for reasons. Reject only on clear risk.",
          },
          { role: "user", content: canonicalJson(m) },
        ],
        { maxTokens: 600, timeoutMs: 20000 },
      );
      if (
        result &&
        typeof result === "object" &&
        ["approve", "warn", "reject"].includes((result as AiVerdict).verdict)
      ) {
        verdict = {
          verdict: (result as AiVerdict).verdict,
          score: Number((result as AiVerdict).score) || 0,
          reasons: Array.isArray((result as AiVerdict).reasons)
            ? (result as AiVerdict).reasons.slice(0, 12).map((r) => String(r))
            : [],
        };
        usedAi = true;
      }
    } catch (err) {
      logger.warn({ err }, "publish: AI review failed; using rule-based fallback");
    }
  }

  if (!verdict) verdict = ruleBasedReview(m);

  const durationMs = Date.now() - started;
  const prefix = usedAi ? "مراجعة ذكية" : "مراجعة قائمة على القواعد";
  const details = [`النتيجة: ${verdict.score}/100`, ...verdict.reasons];
  if (verdict.verdict === "reject") {
    return {
      stage: "ai_review",
      status: "fail",
      summary: `${prefix}: رُفضت الإضافة (${verdict.score}/100)`,
      details,
      durationMs,
    };
  }
  return {
    stage: "ai_review",
    status: verdict.verdict === "warn" ? "warn" : "pass",
    summary: `${prefix}: ${verdict.verdict === "warn" ? "قبول مع تنبيهات" : "مقبولة"} (${verdict.score}/100)`,
    details,
    durationMs,
  };
}

// ── Run the full pipeline ────────────────────────────────────────────────────
export async function runPublishPipeline(input: PublishInput): Promise<PublishOutcome> {
  const gates: GateResult[] = [];
  const report: PublishReport = { errors: [], warnings: [], blockedAt: null, aiReviewed: false };
  let manifest: ExtensionManifest | null = null;
  let packageDigest: string | null = null;
  let signature: string | null = null;
  let publicKeyId: string | null = null;
  let deployed = false;
  let lastStage: PublishStage = "build";

  const record = (g: GateResult): boolean => {
    gates.push(g);
    lastStage = g.stage;
    if (g.status === "warn") report.warnings.push(...g.details);
    if (g.status === "fail") {
      report.errors.push(...(g.details.length ? g.details : [g.summary]));
      if (BLOCKING_STAGES.has(g.stage)) {
        report.blockedAt = g.stage;
        return false; // halt
      }
    }
    return true;
  };

  // 1) build
  const built = gateBuild(input.manifest);
  if (!record(built.gate) || !built.manifest) {
    return finalize();
  }
  manifest = built.manifest;

  // 2) security_scan
  if (!record(gateSecurityScan(manifest))) return finalize();

  // 3) ai_review
  const ai = await gateAiReview(manifest);
  report.aiReviewed = true;
  if (!record(ai)) return finalize();

  // 4) package
  const packageStarted = Date.now();
  const canonical = canonicalJson(manifest);
  packageDigest = sha256Hex(canonical);
  record({
    stage: "package",
    status: "pass",
    summary: `تم تجهيز الحزمة (sha256: ${packageDigest.slice(0, 12)}…)`,
    details: [`حجم البيان: ${canonical.length} بايت`],
    durationMs: Date.now() - packageStarted,
  });

  // 5) sign (blocking)
  const signStarted = Date.now();
  try {
    const keys = await loadOrCreatePlatformKeys();
    signature = signManifest(keys.privateKey, manifest);
    publicKeyId = keys.keyId;
    const ok = verifyManifest(keys.publicKey, manifest, signature);
    if (!ok) throw new Error("re-verification failed");
    record({
      stage: "sign",
      status: "pass",
      summary: "تم التوقيع الرقمي والتحقق منه",
      details: [`مُعرّف المفتاح: ${publicKeyId}`],
      durationMs: Date.now() - signStarted,
    });
  } catch (err) {
    logger.error({ err }, "publish: sign gate failed");
    record({
      stage: "sign",
      status: "fail",
      summary: "فشل التوقيع الرقمي",
      details: ["تعذّر توقيع البيان بمفتاح المنصة"],
      durationMs: Date.now() - signStarted,
    });
    return finalize();
  }

  // 6) deploy — upsert the SIGNED manifest into the catalog (status active).
  const deployStarted = Date.now();
  try {
    await db
      .insert(platformExtensionsTable)
      .values({
        extensionId: manifest.extensionId,
        nameAr: manifest.name.ar,
        nameEn: manifest.name.en ?? null,
        version: manifest.version,
        vendor: manifest.vendor ?? null,
        manifest,
        signature,
        publicKeyId,
        status: "active",
      })
      .onConflictDoUpdate({
        target: platformExtensionsTable.extensionId,
        set: {
          nameAr: manifest.name.ar,
          nameEn: manifest.name.en ?? null,
          version: manifest.version,
          vendor: manifest.vendor ?? null,
          manifest,
          signature,
          publicKeyId,
          status: "active",
          updatedAt: sql`NOW()`,
        },
      });
    deployed = true;
    const hasHandler = Boolean(getBuiltin(manifest.extensionId));
    record({
      stage: "deploy",
      status: hasHandler ? "pass" : "warn",
      summary: hasHandler
        ? "تم النشر إلى كتالوج المنصة"
        : "تم النشر (بدون معالج برمجي مُسجّل — الشاشات/الـAPI لن تعمل حتى يُسجَّل المعالج)",
      details: hasHandler ? [] : ["لا يوجد معالج in-process لهذا المُعرّف؛ البيان منشور لكنه تعريفي فقط"],
      durationMs: Date.now() - deployStarted,
    });
  } catch (err) {
    logger.error({ err, extensionId: manifest.extensionId }, "publish: deploy failed");
    record({
      stage: "deploy",
      status: "fail",
      summary: "فشل النشر إلى الكتالوج",
      details: ["تعذّر كتابة البيان الموقّع إلى قاعدة البيانات"],
      durationMs: Date.now() - deployStarted,
    });
    return finalize();
  }

  // 7) monitor — post-deploy health: re-read the deployed row and confirm its
  //    signature verifies against the LIVE public key (the same gate the
  //    runtime applies in getActiveExtensions).
  const monitorStarted = Date.now();
  try {
    const keys = await loadOrCreatePlatformKeys();
    const rows = await db
      .select()
      .from(platformExtensionsTable)
      .where(eq(platformExtensionsTable.extensionId, manifest.extensionId))
      .limit(1);
    const row = rows[0];
    const healthy =
      !!row &&
      row.status === "active" &&
      verifyManifest(keys.publicKey, row.manifest, row.signature);
    record({
      stage: "monitor",
      status: healthy ? "pass" : "warn",
      summary: healthy
        ? "فحص ما بعد النشر سليم — التوقيع يُتحقّق والحالة نشطة"
        : "تحذير مراقبة: تعذّر تأكيد سلامة الإضافة بعد النشر",
      details: healthy ? [] : ["أعد التحقق من حالة الإضافة في الكتالوج"],
      durationMs: Date.now() - monitorStarted,
    });
  } catch (err) {
    logger.warn({ err }, "publish: monitor gate failed");
    record({
      stage: "monitor",
      status: "warn",
      summary: "تحذير مراقبة: فشل فحص ما بعد النشر",
      details: ["النشر تم لكن تعذّر إجراء فحص الصحة"],
      durationMs: Date.now() - monitorStarted,
    });
  }

  return finalize();

  function finalize(): PublishOutcome {
    const status: PublishOutcome["status"] = deployed
      ? "deployed"
      : report.blockedAt
        ? "blocked"
        : "failed";
    return {
      status,
      extensionId: manifest?.extensionId ?? "",
      version: manifest?.version ?? "",
      currentStage: lastStage,
      gates,
      report,
      packageDigest,
      signature,
      publicKeyId,
      deployed,
      manifest,
    };
  }
}
