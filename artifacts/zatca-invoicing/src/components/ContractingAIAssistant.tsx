import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sparkles, Lightbulb, ArrowRight, AlertTriangle, Send, RefreshCw,
} from "lucide-react";

const API = import.meta.env.VITE_API_URL || "";

type AssistResponse = {
  explanation: string;
  suggestion: string;
  next_step: string;
  warning_if_any: string;
  source: "ai" | "fallback";
};

interface Props {
  screenContext: string;
  projectId?: number | null;
  currentAction?: string;
  className?: string;
}

export default function ContractingAIAssistant({
  screenContext,
  projectId = null,
  currentAction = "",
  className = "",
}: Props) {
  const { t, i18n } = useTranslation();
  const { token } = useAuth() as any;
  const [data, setData] = useState<AssistResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followup, setFollowup] = useState("");

  const fetchAssist = useCallback(async (userMessage = "") => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API}/api/contracting-ai/assist`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          screen_context: screenContext,
          current_action: currentAction,
          user_message: userMessage,
          project_id: projectId,
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
  }, [screenContext, projectId, currentAction, token, i18n.language]);

  useEffect(() => {
    if (token) void fetchAssist();
    // re-run when project context changes
  }, [token, screenContext, projectId, fetchAssist]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = followup.trim();
    if (!q) return;
    void fetchAssist(q);
    setFollowup("");
  };

  return (
    <div className={`rounded-lg border bg-gradient-to-br from-orange-50 to-amber-50 dark:from-slate-900 dark:to-slate-800 p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="rounded-md bg-gradient-to-br from-orange-500 to-amber-500 p-1.5 text-white">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-bold">{t("contracting.ai.title", "مساعد المقاولات الذكي")}</div>
            <div className="text-[11px] text-slate-500">
              {data?.source === "ai" ? t("contracting.ai.poweredAi", "مدعوم بالذكاء الاصطناعي") : t("contracting.ai.poweredLocal", "اقتراحات محلية")}
            </div>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => fetchAssist()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {loading && !data && (
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </div>
      )}

      {error && (
        <div className="text-sm text-red-600 mb-2">{t("contracting.ai.error", "تعذّر تحميل اقتراحات المساعد")} — {error}</div>
      )}

      {data && (
        <div className="space-y-3 text-sm">
          <div>
            <div className="text-xs font-semibold text-slate-500 mb-0.5">{t("contracting.ai.whatIsThis", "ما هذه الشاشة؟")}</div>
            <div className="leading-relaxed">{data.explanation}</div>
          </div>
          <div className="flex items-start gap-2">
            <Lightbulb className="h-4 w-4 mt-0.5 text-amber-500 shrink-0" />
            <div className="leading-relaxed"><span className="font-semibold">{t("contracting.ai.suggestion", "اقتراح:")}</span> {data.suggestion}</div>
          </div>
          <div className="flex items-start gap-2">
            <ArrowRight className="h-4 w-4 mt-0.5 text-emerald-600 shrink-0" />
            <div className="leading-relaxed"><span className="font-semibold">{t("contracting.ai.nextStep", "الخطوة التالية:")}</span> {data.next_step}</div>
          </div>
          {data.warning_if_any && (
            <div className="flex items-start gap-2 rounded-md bg-amber-100 dark:bg-amber-900/40 px-2 py-1.5">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-700 shrink-0" />
              <div className="text-amber-900 dark:text-amber-100">{data.warning_if_any}</div>
            </div>
          )}
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-3 flex gap-2">
        <Input
          value={followup}
          onChange={e => setFollowup(e.target.value)}
          placeholder={t("contracting.ai.askPlaceholder", "اسأل المساعد عن هذه الشاشة…")}
          className="text-sm"
        />
        <Button type="submit" size="sm" disabled={loading || !followup.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
