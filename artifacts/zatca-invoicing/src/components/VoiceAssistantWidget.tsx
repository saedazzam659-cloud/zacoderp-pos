// Floating microphone widget rendered globally from `Layout.tsx` whenever the
// voice assistant is enabled for the current company.
//
// Visual contract:
//   - Bottom-end (start in RTL) FAB with a Mic icon.
//   - States visualised:
//       idle/disabled/unsupported → grey static circle
//       listening                  → primary colour with animated pulse rings
//       processing                 → spinner overlay
//       error                      → red ring
//   - Click toggles listen on/off.
//   - While listening, a small Arabic toast above the FAB shows the live
//     transcript so the user knows what was heard.
//   - Last result is announced via the existing toast() helper.
//
// Keyboard shortcut: Alt+M toggles listen (push-to-talk style).

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Loader2, AlertTriangle } from "lucide-react";
import { useVoiceAssistant } from "@/hooks/useVoiceAssistant";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";

export default function VoiceAssistantWidget() {
  const v = useVoiceAssistant();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const isRtl = i18n.dir() === "rtl";
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number; moved: boolean } | null>(null);
  const skipClickRef = useRef(false);
  const positionKey = `zacode.voiceAssistantPosition.v1:${user?.id ?? "guest"}`;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(positionKey);
      if (!raw) { setPosition(null); return; }
      const saved = JSON.parse(raw);
      if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
        setPosition({
          x: Math.max(0, Math.min(window.innerWidth - 56, saved.x)),
          y: Math.max(0, Math.min(window.innerHeight - 56, saved.y)),
        });
      }
    } catch { setPosition(null); }
  }, [positionKey]);

  const onDragStart = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      x: rect.left,
      y: rect.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
  };
  const onDragMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
    if (!drag.moved) return;
    setPosition({
      x: Math.max(0, Math.min(window.innerWidth - 56, drag.x + dx)),
      y: Math.max(0, Math.min(window.innerHeight - 56, drag.y + dy)),
    });
  };
  const onDragEnd = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (!drag.moved) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const next = {
      x: Math.max(0, Math.min(window.innerWidth - 56, rect.left)),
      y: Math.max(0, Math.min(window.innerHeight - 56, rect.top)),
    };
    setPosition(next);
    localStorage.setItem(positionKey, JSON.stringify(next));
    skipClickRef.current = true;
    window.setTimeout(() => { skipClickRef.current = false; }, 0);
  };

  // Keyboard shortcut Alt+M ----------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey && (e.key === "m" || e.key === "M" || e.key === "ه")) {
        e.preventDefault();
        void v.toggle();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [v]);

  // Show last action result as a toast --------------------------------------
  useEffect(() => {
    if (!v.lastResult) return;
    toast({
      title: v.lastResult.ok ? t("voiceAssistant.toastOk") : t("voiceAssistant.toastFail"),
      description: v.lastResult.label,
      variant: v.lastResult.ok ? "default" : "destructive",
    });
    // Intentional: react to result change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.lastResult]);

  if (v.state === "disabled") return null;

  const isListening  = v.state === "listening" || v.state === "starting";
  const isProcessing = v.state === "processing";
  const isError      = v.state === "error";
  const isUnsupported = v.state === "unsupported";

  const baseColour = isError       ? "bg-red-600 hover:bg-red-700"
                   : isListening   ? "bg-primary  hover:bg-primary/90"
                   : isProcessing  ? "bg-amber-500 hover:bg-amber-600"
                   : isUnsupported ? "bg-muted text-muted-foreground cursor-not-allowed"
                   :                 "bg-primary  hover:bg-primary/90";

  return (
    <div
      className="fixed z-50 flex flex-col items-center gap-2 pointer-events-none"
      style={position
        ? { left: position.x, top: position.y }
        : { bottom: "1.5rem", [isRtl ? "right" : "left"]: "1.5rem" } as React.CSSProperties}
      data-testid="voice-assistant-widget"
    >
      {/* Live transcript bubble — only when listening */}
      {(isListening || isProcessing) && v.transcript && (
        <div className="pointer-events-none rounded-lg bg-background/95 backdrop-blur border border-border px-3 py-1.5 text-sm shadow-lg max-w-[260px] text-center">
          <span className="text-muted-foreground">{v.transcript}</span>
        </div>
      )}

      {/* The FAB itself */}
      <button
        type="button"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onClick={() => {
          if (skipClickRef.current) { skipClickRef.current = false; return; }
          if (!isUnsupported) void v.toggle();
        }}
        disabled={isUnsupported}
        title={`اسحب لتحريك الميكروفون. ${
          isUnsupported  ? t("voiceAssistant.unsupportedTooltip") :
          isError        ? t("voiceAssistant.errorTooltip") :
          isListening    ? t("voiceAssistant.listeningTooltip") :
          isProcessing   ? t("voiceAssistant.processingTooltip") :
                           t("voiceAssistant.idleTooltip")
        }`}
        className={`pointer-events-auto relative flex h-14 w-14 items-center justify-center rounded-full text-white shadow-xl transition-all ${baseColour}`}
        data-testid="voice-assistant-fab"
        aria-label={t("voiceAssistant.toggle")}
      >
        {/* Animated rings while listening */}
        {isListening && (
          <>
            <span className="absolute inset-0 rounded-full bg-primary opacity-40 animate-ping" />
            <span className="absolute -inset-2 rounded-full border-2 border-primary opacity-50 animate-pulse" />
          </>
        )}
        {/* Icon */}
        {isProcessing
          ? <Loader2 className="h-6 w-6 animate-spin" />
          : isError
            ? <AlertTriangle className="h-6 w-6" />
            : isUnsupported
              ? <MicOff className="h-6 w-6" />
              : <Mic className="h-6 w-6" />}
      </button>
    </div>
  );
}
