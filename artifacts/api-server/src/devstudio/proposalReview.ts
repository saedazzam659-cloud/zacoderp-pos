// ─────────────────────────────────────────────────────────────────────────
// DevStudio proposal review engine (Phase 2).
//
// Produces an ADVISORY review report for a developer-submitted unified diff so a
// SuperAdmin can make an informed manual approve/reject decision (safe model #1).
// It NEVER applies the diff, never executes code, never touches the live FS — it
// only inspects the diff TEXT and returns gates + an aggregate verdict + a
// tamper-evident sha256 hash of the diff.
//
// Mirrors the Extension Publish Engine's philosophy (staged gates + AI with a
// deterministic rule-based fallback + audit) but operates on a CODE DIFF, which
// the publish engine deliberately never ingests.
// ─────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import { chat, isAIAvailable, type AIMessage } from "../lib/aiClient.js";
import { isPathVisible } from "../lib/devStudioSnapshot.js";

export type ReviewGateStatus = "pass" | "warn" | "fail";
export type ReviewVerdict = "approve" | "warn" | "reject";

export interface ReviewGate {
  gate: string;                 // scope | stats | danger_scan | ai_review
  label: string;                // Arabic label for the UI
  status: ReviewGateStatus;
  summary: string;              // Arabic, human-readable
  details?: unknown;
}

export interface ReviewStats {
  addedLines: number;
  removedLines: number;
  filesTouched: string[];
}

export interface ProposalReviewReport {
  verdict: ReviewVerdict;
  gates: ReviewGate[];
  stats: ReviewStats;
  diffHash: string;             // sha256(diff) hex — tamper-evident
  aiProvider?: string;
  generatedAt: string;          // ISO timestamp
}

export interface ReviewInput {
  diff: string;
  targetPath: string | null;
  allowedPrefixes: string[];    // the developer's visibility allow-list
  request?: string;             // the proposal description (context for the AI)
}

// ─── Diff parsing ───────────────────────────────────────────────────────────
// Pull touched files from `+++ b/<path>` headers and count real +/- body lines
// (excluding the `+++`/`---` file headers).
function parseDiff(diff: string): ReviewStats {
  const files = new Set<string>();
  let addedLines = 0;
  let removedLines = 0;
  for (const raw of (diff ?? "").split(/\r?\n/)) {
    if (raw.startsWith("+++")) {
      const m = raw.replace(/^\+\+\+\s+/, "").trim();
      const p = m.replace(/^b\//, "").replace(/^a\//, "");
      if (p && p !== "/dev/null") files.add(p);
      continue;
    }
    if (raw.startsWith("---")) continue;
    if (raw.startsWith("+")) addedLines++;
    else if (raw.startsWith("-")) removedLines++;
  }
  return { addedLines, removedLines, filesTouched: [...files] };
}

// Only the ADDED lines (new code the developer wants merged) are risk-scanned.
function addedBody(diff: string): string {
  return (diff ?? "")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
}

// ─── Gate: scope ─────────────────────────────────────────────────────────────
// Every touched path (and the declared targetPath) must fall inside the
// developer's granted visibility prefixes. A path outside scope is a real
// integrity red flag → fail (the SA still makes the final call).
function gateScope(input: ReviewInput, stats: ReviewStats): ReviewGate {
  const allowed = input.allowedPrefixes ?? [];
  const candidates = [input.targetPath, ...stats.filesTouched].filter(
    (p): p is string => !!p && p.trim().length > 0,
  );
  if (!allowed.length) {
    return {
      gate: "scope", label: "النطاق", status: "fail",
      summary: "لا توجد صلاحيات مسارات معيّنة لهذا المطوّر — كل مسار يقع خارج النطاق.",
      details: { outOfScope: [...new Set(candidates)] },
    };
  }
  const outOfScope = [...new Set(candidates)].filter((p) => !isPathVisible(p, allowed));
  if (outOfScope.length) {
    return {
      gate: "scope", label: "النطاق", status: "fail",
      summary: `يلمس المقترح ملفات خارج نطاق صلاحيات المطوّر (${outOfScope.length}).`,
      details: { outOfScope, allowedPrefixes: allowed },
    };
  }
  return {
    gate: "scope", label: "النطاق", status: "pass",
    summary: "كل الملفات ضمن النطاق المسموح للمطوّر.",
    details: { filesTouched: stats.filesTouched },
  };
}

// ─── Gate: stats / size ──────────────────────────────────────────────────────
const LARGE_DIFF_LINES = 400;
function gateStats(stats: ReviewStats): ReviewGate {
  const total = stats.addedLines + stats.removedLines;
  if (total === 0) {
    return {
      gate: "stats", label: "الحجم", status: "warn",
      summary: "المقترح لا يحتوي على تغييرات فعلية (diff فارغ).", details: stats,
    };
  }
  if (total > LARGE_DIFF_LINES || stats.filesTouched.length > 8) {
    return {
      gate: "stats", label: "الحجم", status: "warn",
      summary: `تغيير كبير (${total} سطر، ${stats.filesTouched.length} ملف) — راجِع بعناية.`,
      details: stats,
    };
  }
  return {
    gate: "stats", label: "الحجم", status: "pass",
    summary: `تغيير ضمن الحدود المعتادة (+${stats.addedLines} / -${stats.removedLines}).`,
    details: stats,
  };
}

// ─── Gate: danger_scan ───────────────────────────────────────────────────────
// Flag high-risk constructs in the ADDED lines. Advisory (warn) — a legitimate
// code change can contain these; the SA decides. Surfaced so nothing slips by.
const DANGER_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bchild_process\b|\bexecSync\b|\bspawnSync\b|\bexec\s*\(/, label: "تنفيذ أوامر النظام (child_process/exec)" },
  { re: /\beval\s*\(|new\s+Function\s*\(/, label: "تنفيذ ديناميكي للشيفرة (eval/Function)" },
  { re: /\bprocess\.env\b/, label: "قراءة متغيّرات البيئة/الأسرار (process.env)" },
  { re: /require\(\s*['"]fs['"]\s*\)|from\s+['"]fs['"]|require\(\s*['"]node:fs['"]\s*\)/, label: "وصول مباشر لنظام الملفات (fs)" },
  { re: /https?:\/\/(?!localhost|127\.0\.0\.1)[^\s'"]+/, label: "اتصال شبكي بعنوان خارجي" },
  { re: /\b(DROP|TRUNCATE)\s+TABLE\b/i, label: "أمر SQL مدمّر (DROP/TRUNCATE)" },
  { re: /\bDELETE\s+FROM\b(?![\s\S]{0,120}\bWHERE\b)/i, label: "حذف SQL بدون شرط WHERE" },
  { re: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i, label: "قيمة سرية مضمّنة (مفتاح/كلمة مرور)" },
];

function gateDangerScan(diff: string): ReviewGate {
  const body = addedBody(diff);
  const hits: { label: string; sample: string }[] = [];
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    for (const { re, label } of DANGER_PATTERNS) {
      if (re.test(line)) {
        hits.push({ label, sample: line.trim().slice(0, 160) });
        break; // one flag per line is enough
      }
    }
  }
  if (!hits.length) {
    return {
      gate: "danger_scan", label: "فحص الأنماط الخطرة", status: "pass",
      summary: "لم تُرصد أنماط برمجية عالية الخطورة في الأسطر المضافة.",
    };
  }
  const labels = [...new Set(hits.map((h) => h.label))];
  return {
    gate: "danger_scan", label: "فحص الأنماط الخطرة", status: "warn",
    summary: `رُصدت ${hits.length} إشارة محتملة الخطورة: ${labels.join("، ")}.`,
    details: { hits: hits.slice(0, 30) },
  };
}

// ─── Gate: ai_review (with deterministic rule-based fallback) ─────────────────
const AI_SYSTEM = [
  "You are a senior security + code reviewer for an Arabic/RTL TypeScript+React /",
  "Express ERP. You are given a UNIFIED DIFF a developer proposes for an isolated",
  "code snapshot. Assess RISK only — do NOT rewrite the code.",
  "Respond as STRICT JSON: { \"verdict\": \"approve\"|\"warn\"|\"reject\", \"summary\": string }.",
  "- reject: clearly malicious, destructive, exfiltrates data/secrets, or wildly out of scope.",
  "- warn: risky or large but plausibly legitimate; needs careful human review.",
  "- approve: small, safe, focused change.",
  "summary: a short Arabic sentence explaining the verdict.",
].join("\n");

function ruleBasedAi(danger: ReviewGate, stats: ReviewStats): { verdict: ReviewVerdict; summary: string } {
  const total = stats.addedLines + stats.removedLines;
  if (danger.status === "warn") {
    return { verdict: "warn", summary: "تقييم بقواعد ثابتة (بدون ذكاء اصطناعي): توجد أنماط تستدعي مراجعة بشرية دقيقة." };
  }
  if (total > LARGE_DIFF_LINES) {
    return { verdict: "warn", summary: "تقييم بقواعد ثابتة: التغيير كبير الحجم ويُنصح بمراجعته يدوياً." };
  }
  return { verdict: "approve", summary: "تقييم بقواعد ثابتة: تغيير صغير ولا يحتوي أنماطاً خطرة ظاهرة." };
}

async function gateAiReview(input: ReviewInput, danger: ReviewGate, stats: ReviewStats): Promise<{ gate: ReviewGate; provider?: string }> {
  const fallback = (reason: string): { gate: ReviewGate; provider?: string } => {
    const r = ruleBasedAi(danger, stats);
    return {
      provider: "rule-based",
      gate: {
        gate: "ai_review", label: "مراجعة الذكاء الاصطناعي",
        status: r.verdict === "reject" ? "fail" : r.verdict === "warn" ? "warn" : "pass",
        summary: r.summary, details: { provider: "rule-based", reason, verdict: r.verdict },
      },
    };
  };

  if (!isAIAvailable()) return fallback("ai-unavailable");

  const messages: AIMessage[] = [
    { role: "system", content: AI_SYSTEM },
    {
      role: "user",
      content:
        `# Proposal description:\n${(input.request ?? "(none)").slice(0, 2000)}\n\n` +
        `# Touched files: ${stats.filesTouched.join(", ") || "(none)"}\n` +
        `# Diff (truncated):\n${(input.diff ?? "").slice(0, 24_000)}`,
    },
  ];

  let r;
  try {
    r = await chat(messages, { json: true, maxTokens: 800, timeoutMs: 40_000 });
  } catch {
    return fallback("ai-exception");
  }
  if (!r.ok) return fallback(r.reason ? `ai-error:${r.reason}` : "ai-error");

  const data = (r.data ?? {}) as { verdict?: string; summary?: string };
  const v = data.verdict === "reject" ? "reject" : data.verdict === "approve" ? "approve" : "warn";
  return {
    provider: r.provider,
    gate: {
      gate: "ai_review", label: "مراجعة الذكاء الاصطناعي",
      status: v === "reject" ? "fail" : v === "warn" ? "warn" : "pass",
      summary: typeof data.summary === "string" && data.summary.trim()
        ? data.summary.trim()
        : "تمت المراجعة بالذكاء الاصطناعي.",
      details: { provider: r.provider, verdict: v },
    },
  };
}

// ─── Aggregate ───────────────────────────────────────────────────────────────
function aggregate(gates: ReviewGate[]): ReviewVerdict {
  if (gates.some((g) => g.status === "fail")) return "reject";
  if (gates.some((g) => g.status === "warn")) return "warn";
  return "approve";
}

export async function reviewProposalDiff(input: ReviewInput): Promise<ProposalReviewReport> {
  const diff = input.diff ?? "";
  const stats = parseDiff(diff);
  const scope = gateScope(input, stats);
  const size = gateStats(stats);
  const danger = gateDangerScan(diff);
  const ai = await gateAiReview(input, danger, stats);
  const gates = [scope, size, danger, ai.gate];
  return {
    verdict: aggregate(gates),
    gates,
    stats,
    diffHash: createHash("sha256").update(diff, "utf8").digest("hex"),
    aiProvider: ai.provider,
    generatedAt: new Date().toISOString(),
  };
}
