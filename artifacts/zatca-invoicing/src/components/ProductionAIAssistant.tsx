import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkles, Lightbulb, ArrowRight, AlertTriangle, Send, RefreshCw } from "lucide-react";

const API = import.meta.env.VITE_API_URL || "";

type AssistResponse = {
  explanation: string;
  suggestion: string;
  next_step: string;
  warning_if_any: string;
  source: "ai" | "fallback";
};

interface Props {
  /**
   * Stable identifier of the screen the assistant is rendered on. Examples:
   *   - "production.orders.list"
   *   - "production.orders.detail"
   *   - "production.resources"
   *   - "production.dashboard"
   * Sent to the backend as `screen_context` so the model can tailor its
   * answer to the right page.
   */
  screenContext: string;
  /**
   * Optional production order id. When provided, the backend loads a
   * compact snapshot of the order (status, items, recent events) so the
   * suggestion / warning are grounded in real data.
   */
  orderId?: number | null;
  /**
   * Free-text label of the action the user just took (e.g. "viewed order",
   * "added item"). Helps the model produce a more relevant next step.
   */
  currentAction?: string;
  className?: string;
}

export default function ProductionAIAssistant({
  screenContext,
  orderId = null,
  currentAction = "",
  className = "",
}: Props) {
  const { t, i18n } = useTranslation();
  const { token } = useAuth() as any;
  const [data, setData] = useState<AssistResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followup, setFollowup] = useState("");

  const fetchAssist = useCallback(
    async (userMessage = "") => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`${API}/api/ai/assist`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            screen_context: screenContext,
            current_action: currentAction,
            user_message: userMessage,
            order_id: orderId,
            lang: i18n.language?.startsWith("en") ? "en" : "ar",
          }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as AssistResponse;
        setData(j);
      } catch (e: any) {
        setError(e?.message || "error");
      } finally {
        setLoading(false);
      }
    },
    [screenContext, orderId, currentAction, token, i18n.language],
  );

  // Auto-load contextual explanation on mount + whenever the screen context
  // (or the order being viewed) changes. The backend has a deterministic
  // fallback so the panel is never empty.
  useEffect(() => {
    if (!token) return;
    void fetchAssist("");
  }, [fetchAssist, token]);

  const handleAsk = (e: React.FormEvent) => {
    e.preventDefault();
    const q = followup.trim();
    if (!q) return;
    setFollowup("");
    void fetchAssist(q);
  };

  return (
    <div
      className={`rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-4 shadow-sm dark:border-violet-900/40 dark:from-violet-950/30 dark:to-slate-950 ${className}`}
      data-testid="production-ai-assistant"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="rounded-full bg-violet-100 p-2 dark:bg-violet-900/40">
            <Sparkles className="h-4 w-4 text-violet-600 dark:text-violet-300" />
          </div>
          <div>
            <div className="font-semibold text-slate-900 dark:text-slate-100">
              {t("production.aiTitle")}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {t("production.aiSubtitle")}
            </div>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => fetchAssist("")}
          disabled={loading}
          aria-label={t("production.aiRetry")}
          data-testid="ai-retry-btn"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {loading && !data && (
        <div className="text-sm text-slate-500 dark:text-slate-400">
          {t("production.aiLoading")}
        </div>
      )}

      {error && !data && (
        <div className="text-sm text-red-600">{t("production.errorOccurred")}</div>
      )}

      {data && (
        <div className="space-y-3 text-sm">
          <Section
            icon={<Sparkles className="h-3.5 w-3.5" />}
            label={t("production.aiExplanation")}
            text={data.explanation}
            tone="violet"
          />
          {data.suggestion && (
            <Section
              icon={<Lightbulb className="h-3.5 w-3.5" />}
              label={t("production.aiSuggestion")}
              text={data.suggestion}
              tone="amber"
            />
          )}
          {data.next_step && (
            <Section
              icon={<ArrowRight className="h-3.5 w-3.5" />}
              label={t("production.aiNextStep")}
              text={data.next_step}
              tone="emerald"
            />
          )}
          {data.warning_if_any && (
            <Section
              icon={<AlertTriangle className="h-3.5 w-3.5" />}
              label={t("production.aiWarning")}
              text={data.warning_if_any}
              tone="red"
            />
          )}
          <div className="pt-1 text-[11px] text-slate-400">
            {data.source === "ai"
              ? t("production.aiSource_ai")
              : t("production.aiSource_fallback")}
          </div>
        </div>
      )}

      <form onSubmit={handleAsk} className="mt-3 flex gap-2">
        <Input
          value={followup}
          onChange={(e) => setFollowup(e.target.value)}
          placeholder={t("production.aiAsk")}
          disabled={loading}
          data-testid="ai-followup-input"
          className="flex-1"
        />
        <Button
          type="submit"
          size="sm"
          disabled={loading || !followup.trim()}
          data-testid="ai-followup-send"
        >
          <Send className="h-4 w-4" />
          <span className="sr-only">{t("production.aiSend")}</span>
        </Button>
      </form>
    </div>
  );
}

function Section({
  icon,
  label,
  text,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  text: string;
  tone: "violet" | "amber" | "emerald" | "red";
}) {
  const toneCls: Record<typeof tone, string> = {
    violet: "text-violet-700 dark:text-violet-300",
    amber: "text-amber-700 dark:text-amber-300",
    emerald: "text-emerald-700 dark:text-emerald-300",
    red: "text-red-700 dark:text-red-300",
  };
  return (
    <div>
      <div className={`mb-1 flex items-center gap-1.5 text-xs font-semibold ${toneCls[tone]}`}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-slate-700 dark:text-slate-200 leading-relaxed">{text}</div>
    </div>
  );
}
