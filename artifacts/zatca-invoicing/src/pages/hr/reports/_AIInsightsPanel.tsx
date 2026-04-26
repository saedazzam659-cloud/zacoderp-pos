import { useState } from "react";
import { Sparkles, Loader2, AlertTriangle, Lightbulb, TrendingUp, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { employeesApi } from "@/lib/employeesApi";

type Props = {
  reportType: string;
  title: string;
  summary: any;
  rows: any[];
  period?: any;
};

type AIResult = {
  source: "ai" | "fallback";
  headline: string;
  insights: string[];
  recommendations: string[];
  risks: string[];
};

export default function AIInsightsPanel({ reportType, title, summary, rows, period }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AIResult | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const res = await employeesApi.aiAnalyzeHrReport({ reportType, title, summary, rows, period });
      setResult(res);
    } catch (e: any) {
      setError(e?.message || "تعذّر تشغيل التحليل");
    } finally {
      setLoading(false);
    }
  }

  if (!summary || (!rows?.length && !Object.keys(summary || {}).length)) {
    return null;
  }

  return (
    <div className="rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50/60 via-white to-indigo-50/40 p-4 sm:p-5" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-violet-100 p-2">
            <Sparkles className="h-5 w-5 text-violet-600" />
          </div>
          <div>
            <h3 className="text-base font-bold text-violet-900">تحليل بالذكاء الاصطناعي</h3>
            <p className="text-xs text-violet-700/80">
              يقوم الذكاء الاصطناعي بتحليل بيانات التقرير وتقديم الملاحظات والتوصيات والمخاطر.
            </p>
          </div>
        </div>
        <Button
          onClick={run}
          disabled={loading}
          size="sm"
          className="bg-violet-600 hover:bg-violet-700 text-white gap-2"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : result ? <RefreshCw className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
          {loading ? "جاري التحليل…" : result ? "إعادة التحليل" : "تحليل التقرير"}
        </Button>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 space-y-4">
          {result.headline && (
            <div className="rounded-lg border border-violet-200 bg-white px-4 py-3">
              <div className="text-xs font-semibold text-violet-700 mb-1">الخلاصة</div>
              <div className="text-sm font-bold text-slate-900">{result.headline}</div>
            </div>
          )}

          {result.insights?.length > 0 && (
            <Section
              icon={<TrendingUp className="h-4 w-4 text-blue-600" />}
              title="ملاحظات تحليلية"
              items={result.insights}
              tone="blue"
            />
          )}

          {result.recommendations?.length > 0 && (
            <Section
              icon={<Lightbulb className="h-4 w-4 text-emerald-600" />}
              title="توصيات للتحسين"
              items={result.recommendations}
              tone="emerald"
            />
          )}

          {result.risks?.length > 0 && (
            <Section
              icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}
              title="مخاطر محتملة"
              items={result.risks}
              tone="amber"
            />
          )}

          <div className="text-[11px] text-slate-500 text-left">
            المصدر: {result.source === "ai" ? "تحليل ذكاء اصطناعي" : "تحليل تلقائي محلي"}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  icon, title, items, tone,
}: { icon: React.ReactNode; title: string; items: string[]; tone: "blue" | "emerald" | "amber" }) {
  const colors = {
    blue: "border-blue-200 bg-blue-50/40",
    emerald: "border-emerald-200 bg-emerald-50/40",
    amber: "border-amber-200 bg-amber-50/40",
  }[tone];
  return (
    <div className={`rounded-lg border ${colors} p-3`}>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <h4 className="text-sm font-semibold text-slate-800">{title}</h4>
      </div>
      <ul className="space-y-1.5 text-sm text-slate-700 leading-relaxed">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-slate-400 mt-0.5">•</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
