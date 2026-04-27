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

import { useEffect } from "react";
import { Mic, MicOff, Loader2, AlertTriangle } from "lucide-react";
import { useVoiceAssistant } from "@/hooks/useVoiceAssistant";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";

export default function VoiceAssistantWidget() {
  const v = useVoiceAssistant();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.dir() === "rtl";

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
      className="fixed bottom-6 z-50 flex flex-col items-center gap-2 pointer-events-none"
      style={{ [isRtl ? "right" : "left"]: "1.5rem" } as React.CSSProperties}
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
        onClick={() => { if (!isUnsupported) void v.toggle(); }}
        disabled={isUnsupported}
        title={
          isUnsupported  ? t("voiceAssistant.unsupportedTooltip") :
          isError        ? t("voiceAssistant.errorTooltip") :
          isListening    ? t("voiceAssistant.listeningTooltip") :
          isProcessing   ? t("voiceAssistant.processingTooltip") :
                           t("voiceAssistant.idleTooltip")
        }
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
