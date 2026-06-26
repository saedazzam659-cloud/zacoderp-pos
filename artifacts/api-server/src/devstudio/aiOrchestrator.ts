// ─────────────────────────────────────────────────────────────────────────
// DevStudio AI orchestrator — turns a developer's natural-language request +
// scoped source context into a PROPOSED unified diff. It NEVER executes code and
// NEVER writes to the live filesystem; the result is a proposal the developer
// can save/submit, and which the SuperAdmin can later route to the signed
// publish engine. Reuses the shared multi-provider aiClient (Gemini free first).
// ─────────────────────────────────────────────────────────────────────────

import { chat, isAIAvailable, type AIMessage } from "../lib/aiClient.js";

export interface ProposeInput {
  request: string;                       // developer's natural-language ask
  files: { path: string; content: string }[]; // scoped context files (already authorized)
  developerName?: string;                // for the watermark line in the diff
}

export interface ProposeResult {
  ok: boolean;
  explanation: string;
  diff: string;       // unified-diff style text (may be empty if AI unavailable)
  provider?: string;
  reason?: string;
}

const SYSTEM = [
  "You are DevStudio, an assistant that proposes SAFE, minimal code changes for an",
  "existing TypeScript/React + Express monorepo (Arabic/RTL ERP).",
  "Rules:",
  "1. You may ONLY propose changes as a unified diff. Never run code.",
  "2. Keep changes minimal and additive; do not rewrite whole files.",
  "3. Only touch files included in the provided context. If you need a file that",
  "   was not provided, say so in the explanation instead of guessing.",
  "4. Respond as STRICT JSON: { \"explanation\": string, \"diff\": string }.",
  "   - explanation: a short Arabic summary of what you changed and why.",
  "   - diff: a unified diff (--- a/path / +++ b/path / @@ hunks). Empty string if",
  "     no change is warranted.",
].join("\n");

// Deterministic, AI-free fallback. When no AI office is configured (or the
// provider call fails) we still return a usable, SAFE scaffold: a unified-diff
// that injects a clearly-marked TODO block describing the requested change at the
// top of the first in-scope file. It never invents code — it only annotates — so
// the developer always has a concrete, reviewable starting point to edit + save.
function ruleBasedProposal(input: ProposeInput, reason: string): ProposeResult {
  const request = (input.request ?? "").trim();
  const stamp = input.developerName ? ` (طلب: ${input.developerName})` : "";
  const target = input.files[0];
  if (!target) {
    return {
      ok: true,
      provider: "rule-based",
      reason,
      explanation:
        "تم إنشاء مقترح مبدئي بدون ذكاء اصطناعي. أضف الملفات المطلوبة إلى النطاق أولاً، " +
        "ثم اكتب التعديل في صيغة diff واحفظه كمقترح.",
      diff: "",
    };
  }
  const commentFor = (path: string): { open: string; line: string; close: string } => {
    const p = path.toLowerCase();
    if (/\.(tsx?|jsx?|css|scss|java|c|cpp|go|rs|php)$/.test(p)) return { open: "/*", line: " *", close: " */" };
    if (/\.(py|sh|yml|yaml|toml|env|conf)$/.test(p) || /dockerfile/.test(p)) return { open: "#", line: "#", close: "#" };
    if (/\.(html?|xml|vue|svg)$/.test(p)) return { open: "<!--", line: "  ", close: "-->" };
    return { open: "//", line: "//", close: "//" };
  };
  const c = commentFor(target.path);
  const reqLines = request.split(/\r?\n/).map((l) => `${c.line} ${l}`).join("\n");
  const block = [
    c.open,
    `${c.line} TODO (DevStudio proposal${stamp}):`,
    reqLines,
    `${c.line} — حرّر هذا الاقتراح يدوياً ثم احفظه/أرسله. (مولّد بقواعد ثابتة، بدون ذكاء اصطناعي)`,
    c.close,
  ].join("\n");
  const diff = [
    `--- a/${target.path}`,
    `+++ b/${target.path}`,
    `@@ -1,1 +1,${block.split("\n").length + 1} @@`,
    ...block.split("\n").map((l) => `+${l}`),
    `+`,
  ].join("\n");
  return {
    ok: true,
    provider: "rule-based",
    reason,
    explanation:
      "تم إنشاء مقترح مبدئي بقواعد ثابتة (بدون ذكاء اصطناعي): أُضيفت كتلة TODO تصف التعديل المطلوب " +
      `في أعلى الملف ${target.path}. عدّل الـ diff حسب حاجتك ثم احفظه كمقترح.`,
    diff,
  };
}

function buildContext(files: { path: string; content: string }[]): string {
  if (!files.length) return "(no files were shared in scope)";
  // Cap context so we never blow the model window; developers work file-by-file.
  const MAX_CHARS = 48_000;
  let used = 0;
  const blocks: string[] = [];
  for (const f of files) {
    const header = `\n===== FILE: ${f.path} =====\n`;
    const body = f.content.length > 16_000 ? f.content.slice(0, 16_000) + "\n... (truncated)" : f.content;
    if (used + header.length + body.length > MAX_CHARS) break;
    blocks.push(header + body);
    used += header.length + body.length;
  }
  return blocks.join("\n");
}

export async function proposeChange(input: ProposeInput): Promise<ProposeResult> {
  const request = (input.request ?? "").trim();
  if (!request) {
    return { ok: false, explanation: "الطلب فارغ.", diff: "", reason: "empty-request" };
  }
  if (!isAIAvailable()) {
    // No AI office configured → deterministic rule-based scaffold (never blocks the developer).
    return ruleBasedProposal(input, "ai-unavailable");
  }

  const watermark = input.developerName ? `\n# proposed-by: ${input.developerName}` : "";
  const messages: AIMessage[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        `# Developer request (Arabic ok):\n${request}\n\n` +
        `# In-scope files:\n${buildContext(input.files)}${watermark}`,
    },
  ];

  const r = await chat(messages, { json: true, maxTokens: 3072, timeoutMs: 45_000 });
  if (!r.ok) {
    // Provider call failed → fall back to the deterministic rule-based scaffold.
    return ruleBasedProposal(input, r.reason ? `ai-error:${r.reason}` : "ai-error");
  }

  const data = (r.data ?? {}) as { explanation?: string; diff?: string };
  return {
    ok: true,
    provider: r.provider,
    explanation: typeof data.explanation === "string" ? data.explanation : (r.text || "تم إنشاء مقترح."),
    diff: typeof data.diff === "string" ? data.diff : "",
  };
}
