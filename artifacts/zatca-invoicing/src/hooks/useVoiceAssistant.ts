// Browser SpeechRecognition wrapper + intent execution for the Voice Assistant.
//
// Responsibilities:
//   1. Lifecycle of the browser SpeechRecognition object (start/stop, errors,
//      auto-restart on no-speech timeouts when in continuous mode).
//   2. Push the recognised transcript through `/api/voice-assistant/parse-command`
//      to get a structured action.
//   3. Execute the action: navigate via wouter, run a generic verb (back / save /
//      cancel / new / search / home / logout / reload).
//   4. Surface state for the floating widget (idle / listening / processing /
//      error, last transcript, last action).
//
// The hook is driven by a per-company `enabled` flag (loaded from
// /settings/me/effective). When disabled, every method becomes a no-op so
// pages that import it can call them unconditionally.

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { matchOffline, type ParsedCommand } from "@/lib/voiceCommands";
import { useAuth } from "@/contexts/AuthContext";

// Vite serves the app under a base path (e.g. "/" in dev). Mirror the
// pattern used by WorkSessionSettings so requests reach the correct origin.
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
function apiUrl(path: string): string {
  return `${API}${path.startsWith("/") ? path : `/${path}`}`;
}

// AuthContext stores the bearer token in localStorage under "zatca_token".
// Without this header the API rejects voice-assistant calls with 401, which
// would print noisy errors in the browser console even though the FAB still
// renders correctly. Cookie-only credentials are insufficient because the
// server uses Bearer-token sessions.
function authHeaders(extra?: Record<string, string>): HeadersInit {
  const t = typeof localStorage !== "undefined" ? localStorage.getItem("zatca_token") : null;
  return { ...(extra ?? {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

// ─── Types for the prefixed Web Speech API ───────────────────────────────────
//
// The browsers that ship SpeechRecognition still use the `webkit` prefix
// (Chrome, Edge, Brave, Opera). Firefox & Safari currently expose nothing.
// We declare the minimum surface we touch instead of pulling a typings package.
interface ISpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string; confidence: number };
    length: number;
  }>;
}
interface ISpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: ((this: ISpeechRecognition, ev: Event) => any) | null;
  onresult: ((this: ISpeechRecognition, ev: ISpeechRecognitionEvent) => any) | null;
  onerror: ((this: ISpeechRecognition, ev: Event & { error?: string; message?: string }) => any) | null;
  onend: ((this: ISpeechRecognition, ev: Event) => any) | null;
}
type SpeechRecognitionCtor = new () => ISpeechRecognition;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return (w.SpeechRecognition || w.webkitSpeechRecognition || null) as SpeechRecognitionCtor | null;
}

export type VoiceState = "idle" | "starting" | "listening" | "processing" | "error" | "unsupported" | "disabled";

export interface VoiceActionResult {
  ok: boolean;
  label: string;       // Arabic feedback shown in toast
  kind: ParsedCommand["kind"];
  reason?: string;
}

export interface EffectiveVoiceSettings {
  enabled: boolean;
  autoActivateOnLogin: boolean;
  language: string;
  confidenceThreshold: number;
}

const DEFAULT_EFFECTIVE: EffectiveVoiceSettings = {
  enabled: false,
  autoActivateOnLogin: false,
  language: "ar-SA",
  confidenceThreshold: 50,
};

export interface UseVoiceAssistantApi {
  state:           VoiceState;
  isSupported:     boolean;
  settings:        EffectiveVoiceSettings;
  transcript:      string;          // live (interim or final)
  finalTranscript: string;          // last accepted final
  lastResult:      VoiceActionResult | null;
  start:           () => Promise<void>;
  stop:            () => void;
  toggle:          () => Promise<void>;
  /** Allow callers to feed a typed-in command (used by the input fallback). */
  submitText:      (text: string) => Promise<void>;
}

const PARSE_URL  = "/api/voice-assistant/parse-command";
const SETTINGS_URL = "/api/voice-assistant/settings/me/effective";

// Module-level cache for the effective voice settings.
//
// Layout mounts on every authenticated route, and TanStack Query's user
// object reference can change on each /auth/me refresh — without a cache
// the hook would refetch SETTINGS_URL on every navigation and on every
// background poll. Settings change rarely (admin toggle), so we hold the
// last successful result in memory for the lifetime of the page and
// dedupe concurrent fetches behind a single in-flight promise.
let _settingsCache: EffectiveVoiceSettings | null = null;
let _settingsInflight: Promise<EffectiveVoiceSettings | null> | null = null;
let _settingsCacheUserId: number | null = null;
function clearVoiceSettingsCache() {
  _settingsCache = null;
  _settingsInflight = null;
  _settingsCacheUserId = null;
}
// Expose for logout flow if it ever needs to invalidate.
(globalThis as any).__clearVoiceSettingsCache = clearVoiceSettingsCache;

export function useVoiceAssistant(): UseVoiceAssistantApi {
  const [, navigate] = useLocation();
  const { user, logout } = useAuth();

  const [settings,    setSettings]    = useState<EffectiveVoiceSettings>(DEFAULT_EFFECTIVE);
  const [state,       setState]       = useState<VoiceState>("idle");
  const [transcript,  setTranscript]  = useState<string>("");
  const [finalText,   setFinalText]   = useState<string>("");
  const [lastResult,  setLastResult]  = useState<VoiceActionResult | null>(null);
  const recognitionRef                = useRef<ISpeechRecognition | null>(null);
  const settingsLoadedRef             = useRef<boolean>(false);
  const autoActivatedRef              = useRef<boolean>(false);

  const Ctor = getRecognitionCtor();
  const isSupported = !!Ctor;

  // ─── Load per-company settings (cached at module scope) ────────────────
  // We deliberately depend on `user?.id` (a primitive) instead of the whole
  // `user` object so the effect doesn't re-run every time AuthContext
  // refreshes the user reference (which happens on every poll/SSE tick).
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    // If a cached value exists for the SAME signed-in user, use it without
    // hitting the network. (Different user → drop cache and refetch.)
    if (_settingsCacheUserId !== userId) clearVoiceSettingsCache();
    if (_settingsCache) {
      setSettings(_settingsCache);
      settingsLoadedRef.current = true;
      return;
    }
    let cancelled = false;
    if (!_settingsInflight) {
      _settingsInflight = (async () => {
        try {
          const r = await fetch(apiUrl(SETTINGS_URL), { credentials: "include", headers: authHeaders() });
          if (!r.ok) return null;
          const j = await r.json();
          const eff: EffectiveVoiceSettings = {
            enabled:              !!j.enabled,
            autoActivateOnLogin:  !!j.autoActivateOnLogin,
            language:             j.language ?? "ar-SA",
            confidenceThreshold:  Number(j.confidenceThreshold ?? 50),
          };
          _settingsCache = eff;
          _settingsCacheUserId = userId;
          return eff;
        } catch {
          return null;
        } finally {
          _settingsInflight = null;
        }
      })();
    }
    void _settingsInflight.then((eff) => {
      if (cancelled || !eff) return;
      setSettings(eff);
      settingsLoadedRef.current = true;
    });
    return () => { cancelled = true; };
  }, [userId]);

  // ─── Compute the current high-level state ──────────────────────────────
  const effectiveState: VoiceState =
    !isSupported            ? "unsupported" :
    !settings.enabled       ? "disabled"    :
    state;

  // ─── Execute a parsed action ───────────────────────────────────────────
  const executeAction = useCallback(async (parsed: ParsedCommand): Promise<VoiceActionResult> => {
    if (parsed.kind === "navigate" && parsed.route) {
      navigate(parsed.route);
      return { ok: true, kind: "navigate", label: `الانتقال إلى ${parsed.label ?? parsed.route}` };
    }
    if (parsed.kind === "verb" && parsed.verb) {
      switch (parsed.verb) {
        case "back":
          window.history.back();
          return { ok: true, kind: "verb", label: "رجوع" };
        case "home":
          navigate("/");
          return { ok: true, kind: "verb", label: "الانتقال إلى الرئيسية" };
        case "reload":
          window.location.reload();
          return { ok: true, kind: "verb", label: "تحديث الصفحة" };
        case "logout":
          await logout();
          return { ok: true, kind: "verb", label: "تسجيل الخروج" };
        case "save": {
          const btn = document.querySelector<HTMLElement>('[data-voice="save"], button[type="submit"]');
          if (btn) { btn.click(); return { ok: true, kind: "verb", label: "تم الضغط على حفظ" }; }
          return { ok: false, kind: "verb", label: "لا يوجد زر حفظ في هذه الشاشة", reason: "no_save" };
        }
        case "cancel": {
          const btn = document.querySelector<HTMLElement>('[data-voice="cancel"]');
          if (btn) { btn.click(); return { ok: true, kind: "verb", label: "تم الإلغاء" }; }
          // Fallback: dispatch ESC to close a dialog.
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
          return { ok: true, kind: "verb", label: "إغلاق النافذة الحالية" };
        }
        case "new": {
          const btn = document.querySelector<HTMLElement>('[data-voice="new"], a[data-voice="new"]');
          if (btn) { btn.click(); return { ok: true, kind: "verb", label: "زر جديد" }; }
          return { ok: false, kind: "verb", label: "لا يوجد زر إضافة في هذه الشاشة", reason: "no_new" };
        }
        case "search": {
          const el = document.querySelector<HTMLElement>(
            '[data-voice="search"], input[type="search"], input[placeholder*="بحث"]',
          );
          if (el) { (el as HTMLInputElement).focus(); return { ok: true, kind: "verb", label: "تم تفعيل البحث" }; }
          return { ok: false, kind: "verb", label: "لا يوجد بحث في هذه الشاشة", reason: "no_search" };
        }
      }
    }
    return { ok: false, kind: "unknown", label: parsed.reason ?? "لم أفهم الأمر", reason: parsed.reason };
  }, [navigate, logout]);

  // ─── Process a final transcript (offline first → AI fallback) ──────────
  const processTranscript = useCallback(async (text: string, browserConfidence: number | null) => {
    setState("processing");
    setFinalText(text);
    // Per-company confidence gate: reject low-confidence recognition BEFORE
    // dispatching anything (navigate / save / logout / etc.). The browser
    // returns confidence on a 0..1 scale; settings.confidenceThreshold is
    // 0..100. A null/undefined browser confidence means the recogniser
    // didn't supply one — we let those through (some Chrome builds report
    // null even on perfect matches).
    if (
      browserConfidence != null &&
      Math.round(browserConfidence * 100) < settings.confidenceThreshold
    ) {
      setLastResult({
        ok: false,
        kind: "unknown",
        label: `ثقة منخفضة جداً (${Math.round(browserConfidence * 100)}%)، تجاهلت الأمر`,
        reason: "low_confidence",
      });
      // Still log the rejected attempt so admins can see false negatives.
      void fetch(apiUrl(PARSE_URL), {
        method: "POST",
        credentials: "include",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          transcript: text,
          contextRoute: window.location.pathname,
          confidence: Math.round(browserConfidence * 100),
          rejectedReason: "low_confidence",
        }),
      }).catch(() => { /* best-effort */ });
      setState("idle");
      return;
    }
    // Try local match first — instant, no network.
    const local = matchOffline(text);
    if (local) {
      const parsed: ParsedCommand = {
        kind: local.entry.kind === "route" ? "navigate" : "verb",
        route: local.entry.kind === "route" ? local.entry.route : undefined,
        verb:  local.entry.kind === "verb"  ? local.entry.verb  : undefined,
        label: local.entry.label,
        confidence: local.exact ? 100 : 80,
        source: "offline",
      };
      const result = await executeAction(parsed);
      setLastResult(result);
      // Fire-and-forget: log the offline hit on the server too so admins see it.
      void fetch(apiUrl(PARSE_URL), {
        method: "POST",
        credentials: "include",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          transcript: text,
          contextRoute: window.location.pathname,
          confidence: browserConfidence == null ? null : Math.round(browserConfidence * 100),
        }),
      }).catch(() => { /* best-effort */ });
      setState("idle");
      return;
    }

    // No local hit → ask the server (which may invoke Anthropic).
    try {
      const r = await fetch(apiUrl(PARSE_URL), {
        method: "POST",
        credentials: "include",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          transcript: text,
          contextRoute: window.location.pathname,
          confidence: browserConfidence == null ? null : Math.round(browserConfidence * 100),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setLastResult({ ok: false, kind: "unknown", label: j?.error ?? "تعذّر الاتصال بالخادم" });
      } else {
        const parsed: ParsedCommand = {
          kind: j.kind, route: j.route, verb: j.verb, label: j.label,
          confidence: j.confidence, source: j.source ?? "ai", reason: j.reason,
        };
        const result = await executeAction(parsed);
        setLastResult(result);
      }
    } catch (e: any) {
      setLastResult({ ok: false, kind: "unknown", label: "تعذّر الاتصال بالخادم", reason: e?.message });
    } finally {
      setState("idle");
    }
  }, [executeAction]);

  // ─── Start / stop ──────────────────────────────────────────────────────
  const start = useCallback(async () => {
    if (!Ctor || !settings.enabled) return;
    if (recognitionRef.current) return;
    setState("starting");
    setTranscript("");
    setFinalText("");
    const rec = new Ctor();
    rec.lang            = settings.language;
    rec.continuous      = false;
    rec.interimResults  = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => setState("listening");
    rec.onresult = (ev) => {
      let interim = "";
      let finalT  = "";
      let conf: number | null = null;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const txt = r[0]?.transcript ?? "";
        if (r.isFinal) { finalT += txt; conf = r[0]?.confidence ?? null; }
        else interim += txt;
      }
      setTranscript((interim || finalT).trim());
      if (finalT.trim()) {
        // Stop the recogniser before processing so the next click can restart cleanly.
        try { rec.stop(); } catch { /* ignore */ }
        recognitionRef.current = null;
        void processTranscript(finalT.trim(), conf);
      }
    };
    rec.onerror = (ev) => {
      // Common errors:
      //   "no-speech"       – user didn't say anything; just go back to idle silently.
      //   "not-allowed"     – mic permission denied; surface to user.
      //   "audio-capture"   – no mic device.
      //   "network"         – upstream Google service hiccup.
      const code = ev.error ?? "unknown";
      if (code === "no-speech" || code === "aborted") {
        setState("idle");
        return;
      }
      setState("error");
      setLastResult({
        ok: false, kind: "unknown",
        label: code === "not-allowed"
          ? "تم رفض الإذن بالميكروفون. الرجاء السماح من إعدادات المتصفح."
          : `خطأ في الميكروفون: ${code}`,
      });
    };
    rec.onend = () => {
      recognitionRef.current = null;
      // Don't override "processing" — it'll flip to idle when processing finishes.
      setState((prev) => (prev === "processing" ? prev : "idle"));
    };
    recognitionRef.current = rec;
    try { rec.start(); }
    catch (e: any) {
      recognitionRef.current = null;
      setState("error");
      setLastResult({ ok: false, kind: "unknown", label: e?.message ?? "تعذّر تشغيل الميكروفون" });
    }
  }, [Ctor, settings.enabled, settings.language, processTranscript]);

  const stop = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) { try { rec.abort(); } catch { /* ignore */ } recognitionRef.current = null; }
    setState("idle");
    setTranscript("");
  }, []);

  const toggle = useCallback(async () => {
    if (state === "listening" || state === "starting" || state === "processing") stop();
    else await start();
  }, [state, start, stop]);

  const submitText = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || !settings.enabled) return;
    await processTranscript(t, null);
  }, [settings.enabled, processTranscript]);

  // ─── Auto-activate on first login ───────────────────────────────────────
  useEffect(() => {
    if (!user || autoActivatedRef.current) return;
    if (!settingsLoadedRef.current) return;
    if (!settings.enabled || !settings.autoActivateOnLogin) return;
    if (!isSupported) return;
    autoActivatedRef.current = true;
    // Defer one tick so the page is mounted; gracefully ignore permission denial.
    const t = setTimeout(() => { void start(); }, 800);
    return () => clearTimeout(t);
  }, [user, settings.enabled, settings.autoActivateOnLogin, isSupported, start]);

  // ─── Cleanup on unmount ────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      const rec = recognitionRef.current;
      if (rec) { try { rec.abort(); } catch { /* ignore */ } recognitionRef.current = null; }
    };
  }, []);

  return {
    state:           effectiveState,
    isSupported,
    settings,
    transcript,
    finalTranscript: finalText,
    lastResult,
    start, stop, toggle, submitText,
  };
}
