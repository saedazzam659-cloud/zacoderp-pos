// ─────────────────────────────────────────────────────────────────────────
// Unified AI client — single entry point for every AI feature in the ERP.
//
// Goals:
//   1. End-users never need their own keys: we route through Replit's AI
//      Integrations proxy for OpenAI + Anthropic.
//   2. If one provider's key is unapproved / rate-limited / down, we fall
//      through to the next instead of breaking every AI feature at once
//      (the symptom that produced today's "ApiKey not approved" outage).
//   3. Callers stay simple — they ask for `chat(messages)` and either get
//      text/JSON back or a clear `{ ok: false }` so they can run their
//      existing rule-based fallback.
//
// Provider chain (in order):
//   1. OpenAI   — gpt-5.4   (chat completions API)
//   2. Anthropic — claude-sonnet-4-6 (messages API)
//
// Both providers expose OpenAI/Anthropic-compatible endpoints via the
// proxy, so we issue raw fetch calls and keep zero SDK dependencies.
// This avoids dragging in @anthropic-ai/sdk on every code path.
// ─────────────────────────────────────────────────────────────────────────

import { logger } from "./logger";

const OPENAI_BASE     = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const OPENAI_KEY      = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
const ANTHROPIC_BASE  = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
const ANTHROPIC_KEY   = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;

export type AIRole = "system" | "user" | "assistant";
export interface AIMessage { role: AIRole; content: string }

export interface AIChatOptions {
  /** Request JSON-mode response (provider-specific implementation). */
  json?: boolean;
  /** Max output tokens (default 2048; raise for long synthesis). */
  maxTokens?: number;
  /** Per-call provider override; default is "openai" then "anthropic". */
  providers?: ("openai" | "anthropic")[];
  /** Soft total deadline in ms — passed to each provider attempt. */
  timeoutMs?: number;
}

export type AIChatResult =
  | { ok: true; text: string; data?: any; provider: "openai" | "anthropic" }
  | { ok: false; reason: string };

const DEFAULT_PROVIDERS: ("openai" | "anthropic")[] = ["openai", "anthropic"];
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 30_000;

// Errors with these HTTP statuses are unrecoverable for THIS provider —
// no point retrying the same provider, jump straight to the next one.
const HARD_FAIL_STATUSES = new Set([400, 401, 403, 404, 422]);

function isProviderConfigured(p: "openai" | "anthropic"): boolean {
  if (p === "openai")    return Boolean(OPENAI_BASE && OPENAI_KEY);
  if (p === "anthropic") return Boolean(ANTHROPIC_BASE && ANTHROPIC_KEY);
  return false;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ─── OpenAI attempt ───────────────────────────────────────────────────────
async function tryOpenAI(
  messages: AIMessage[],
  opts: Required<Omit<AIChatOptions, "providers">>,
): Promise<AIChatResult> {
  if (!isProviderConfigured("openai")) return { ok: false, reason: "openai-not-configured" };
  try {
    const body = {
      model: "gpt-5.4",
      max_completion_tokens: opts.maxTokens,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      messages,
    };
    const r = await fetchWithTimeout(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify(body),
    }, opts.timeoutMs);

    if (!r.ok) {
      const status = r.status;
      const errText = await r.text().catch(() => "");
      logger.warn({ status, errText: errText.slice(0, 300) }, "aiClient.openai non-ok");
      // Hard fail → don't retry openai, let the caller try anthropic.
      return { ok: false, reason: `openai-http-${status}` };
    }

    const j: any = await r.json();
    const txt: string | undefined = j?.choices?.[0]?.message?.content;
    if (!txt) return { ok: false, reason: "openai-empty" };

    if (opts.json) {
      try { return { ok: true, text: txt, data: JSON.parse(txt), provider: "openai" }; }
      catch { return { ok: false, reason: "openai-bad-json" }; }
    }
    return { ok: true, text: String(txt), provider: "openai" };
  } catch (e: any) {
    logger.warn({ err: e?.message }, "aiClient.openai threw");
    return { ok: false, reason: `openai-err-${e?.name ?? "unknown"}` };
  }
}

// ─── Anthropic attempt ────────────────────────────────────────────────────
// Anthropic's messages endpoint expects a separate `system` string +
// conversation messages, so we rearrange the array. JSON-mode is faked
// by asking the model to return ONLY a JSON object — Anthropic doesn't
// expose a strict response_format flag yet.
async function tryAnthropic(
  messages: AIMessage[],
  opts: Required<Omit<AIChatOptions, "providers">>,
): Promise<AIChatResult> {
  if (!isProviderConfigured("anthropic")) return { ok: false, reason: "anthropic-not-configured" };
  try {
    const systemParts = messages.filter(m => m.role === "system").map(m => m.content);
    const convo = messages
      .filter(m => m.role !== "system")
      .map(m => ({ role: m.role, content: m.content }));
    if (convo.length === 0) {
      // Anthropic requires at least one user message; promote any system text.
      convo.push({ role: "user", content: systemParts.join("\n\n") || "..." });
    }

    let systemText = systemParts.join("\n\n");
    if (opts.json) {
      systemText = `${systemText}\n\nReturn ONLY a valid JSON object. No prose, no markdown fences.`;
    }

    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: opts.maxTokens,
      ...(systemText ? { system: systemText } : {}),
      messages: convo,
    };

    const r = await fetchWithTimeout(`${ANTHROPIC_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    }, opts.timeoutMs);

    if (!r.ok) {
      const status = r.status;
      const errText = await r.text().catch(() => "");
      logger.warn({ status, errText: errText.slice(0, 300) }, "aiClient.anthropic non-ok");
      return { ok: false, reason: `anthropic-http-${status}` };
    }

    const j: any = await r.json();
    const blocks: any[] = Array.isArray(j?.content) ? j.content : [];
    const txt = blocks.filter(b => b?.type === "text").map(b => b.text).join("").trim();
    if (!txt) return { ok: false, reason: "anthropic-empty" };

    if (opts.json) {
      // Anthropic sometimes wraps in ```json fences despite the instruction.
      const cleaned = txt
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```$/i, "")
        .trim();
      try { return { ok: true, text: cleaned, data: JSON.parse(cleaned), provider: "anthropic" }; }
      catch { return { ok: false, reason: "anthropic-bad-json" }; }
    }
    return { ok: true, text: txt, provider: "anthropic" };
  } catch (e: any) {
    logger.warn({ err: e?.message }, "aiClient.anthropic threw");
    return { ok: false, reason: `anthropic-err-${e?.name ?? "unknown"}` };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Send a chat completion through the AI proxy chain.
 *
 * Behaviour:
 *   - Walks `opts.providers ?? ["openai", "anthropic"]` in order.
 *   - Returns the first successful result.
 *   - If every provider fails, returns `{ ok: false }` so the caller can
 *     render its rule-based fallback (every AI route in this codebase
 *     already has one). We never throw on AI failure — the ERP must keep
 *     functioning even when no AI is available.
 */
export async function chat(
  messages: AIMessage[],
  opts: AIChatOptions = {},
): Promise<AIChatResult> {
  const providers = opts.providers ?? DEFAULT_PROVIDERS;
  const required: Required<Omit<AIChatOptions, "providers">> = {
    json:       opts.json       ?? false,
    maxTokens:  opts.maxTokens  ?? DEFAULT_MAX_TOKENS,
    timeoutMs:  opts.timeoutMs  ?? DEFAULT_TIMEOUT_MS,
  };

  const reasons: string[] = [];
  for (const p of providers) {
    const result = p === "openai"
      ? await tryOpenAI(messages, required)
      : await tryAnthropic(messages, required);
    if (result.ok) return result;
    reasons.push(`${p}:${result.reason}`);
    // Some failures (timeout, 5xx) are worth not hammering — small backoff.
    if (result.reason.includes("http-5") || result.reason.includes("AbortError")) {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  return { ok: false, reason: reasons.join(",") || "no-provider" };
}

/**
 * Convenience wrapper that always asks for JSON and returns the parsed
 * object (or null on failure). Use this for "extract fields" tasks where
 * a free-form text response would be useless.
 */
export async function chatJSON<T = any>(
  messages: AIMessage[],
  opts: Omit<AIChatOptions, "json"> = {},
): Promise<T | null> {
  const r = await chat(messages, { ...opts, json: true });
  if (!r.ok) return null;
  return (r.data ?? null) as T | null;
}

/**
 * True iff at least one provider has both env vars set. UI surfaces use
 * this to render the assistant button conditionally.
 */
export function isAIAvailable(): boolean {
  return isProviderConfigured("openai") || isProviderConfigured("anthropic");
}
