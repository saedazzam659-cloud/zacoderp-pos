// Support assistant page — free in-app help powered by the new
// /api/support-ai/ask endpoint. RTL-first Arabic UI with English fallback.
//
// Renders:
//   • Topic chips (categories) → browse mode
//   • Searchable Q&A list per category
//   • Live "ask anything" panel that hits the AI + KB retrieval
//
// All responses include a `source` field — we surface it as a small badge
// so users know whether the answer came from the AI or the KB fallback.
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Send, BookOpen, MessageCircle, RefreshCw, ThumbsUp, ThumbsDown } from "lucide-react";

const API = import.meta.env.VITE_API_URL || "";

interface Topic { category: string; n: number }
interface KBEntry { id: number; slug: string; category: string; question_ar: string; answer_ar: string }
interface AskResp {
  answer: string;
  source: "ai" | "kb" | "none";
  provider?: "openai" | "anthropic";
  citations: { id: number; slug: string; title: string }[];
}

const CATEGORY_LABEL_AR: Record<string, string> = {
  zatca: "زاتكا والفوترة",
  invoicing: "الفواتير",
  inventory: "المخزون",
  accounting: "المحاسبة",
  pos: "نقاط البيع",
  users: "المستخدمون والصلاحيات",
  reports: "التقارير",
  general: "عام",
};

export default function SupportAssistant() {
  const { i18n } = useTranslation();
  const [location] = useLocation();
  const isRtl = i18n.language === "ar";

  const [topics, setTopics] = useState<Topic[]>([]);
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [entries, setEntries] = useState<KBEntry[]>([]);
  const [search, setSearch] = useState("");

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<AskResp | null>(null);
  const [feedbackGiven, setFeedbackGiven] = useState<Record<number, "up" | "down">>({});

  // Load topic counts once on mount; entries lazily when a category is opened.
  useEffect(() => {
    fetch(`${API}/api/support-ai/topics`, { credentials: "include" })
      .then(r => r.json())
      .then(j => setTopics(j.topics ?? []))
      .catch(() => setTopics([]));
  }, []);

  useEffect(() => {
    const url = activeCat
      ? `${API}/api/support-ai/entries?category=${encodeURIComponent(activeCat)}`
      : `${API}/api/support-ai/entries`;
    fetch(url, { credentials: "include" })
      .then(r => r.json())
      .then(j => setEntries(j.entries ?? []))
      .catch(() => setEntries([]));
  }, [activeCat]);

  const filtered = useMemo(() => {
    if (!search.trim()) return entries;
    const q = search.toLowerCase();
    return entries.filter(e =>
      e.question_ar.toLowerCase().includes(q) || e.answer_ar.toLowerCase().includes(q));
  }, [entries, search]);

  async function ask() {
    if (!question.trim() || asking) return;
    setAsking(true);
    setAnswer(null);
    try {
      const r = await fetch(`${API}/api/support-ai/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ question, pagePath: location, locale: isRtl ? "ar" : "en" }),
      });
      const j: AskResp = await r.json();
      setAnswer(j);
    } catch {
      setAnswer({ answer: "تعذّر الوصول للخادم. حاول مرة أخرى.", source: "none", citations: [] });
    } finally {
      setAsking(false);
    }
  }

  async function sendFeedback(id: number, helpful: boolean) {
    setFeedbackGiven(s => ({ ...s, [id]: helpful ? "up" : "down" }));
    fetch(`${API}/api/support-ai/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ id, helpful }),
    }).catch(() => {});
  }

  return (
    <div className="container mx-auto py-6 space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      {/* ─── Header ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <Sparkles className="h-7 w-7 text-amber-500" />
        <div>
          <h1 className="text-2xl font-bold">مساعد الدعم الذكي</h1>
          <p className="text-sm text-muted-foreground">
            اسأل بلغتك الطبيعية — يردّ المساعد بإجابة من قاعدة معرفة النظام مدعومةً بالذكاء الاصطناعي.
          </p>
        </div>
      </div>

      {/* ─── Ask anything ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageCircle className="h-5 w-5 text-primary" />
            اسأل أي سؤال
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="مثال: كيف أرسل فاتورة لزاتكا؟"
            rows={2}
            className="resize-none"
            onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask(); }}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">اضغط Ctrl+Enter للإرسال</span>
            <Button onClick={ask} disabled={asking || !question.trim()} className="gap-2">
              {asking ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {asking ? "جارٍ البحث…" : "اسأل"}
            </Button>
          </div>

          {answer && (
            <div className="rounded-md border bg-muted/30 p-4 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={answer.source === "ai" ? "default" : answer.source === "kb" ? "secondary" : "outline"}>
                  {answer.source === "ai"
                    ? `بالذكاء الاصطناعي${answer.provider ? ` (${answer.provider})` : ""}`
                    : answer.source === "kb"
                      ? "من قاعدة المعرفة"
                      : "لا توجد إجابة"}
                </Badge>
                {answer.citations.map(c => (
                  <Badge key={c.id} variant="outline" className="font-normal max-w-[260px] truncate" title={c.title}>
                    📎 {c.title}
                  </Badge>
                ))}
              </div>
              <div className="whitespace-pre-wrap text-sm leading-7">{answer.answer}</div>
              {answer.citations[0] && feedbackGiven[answer.citations[0].id] === undefined && (
                <div className="flex items-center gap-2 pt-2 border-t text-sm">
                  <span className="text-muted-foreground">هل كانت الإجابة مفيدة؟</span>
                  <Button size="sm" variant="ghost" onClick={() => sendFeedback(answer.citations[0].id, true)}>
                    <ThumbsUp className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => sendFeedback(answer.citations[0].id, false)}>
                    <ThumbsDown className="h-4 w-4" />
                  </Button>
                </div>
              )}
              {answer.citations[0] && feedbackGiven[answer.citations[0].id] && (
                <div className="pt-2 border-t text-xs text-muted-foreground">شكراً لتقييمك ✅</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Browse by topic ──────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="h-5 w-5 text-primary" />
            تصفّح المواضيع
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button
              variant={activeCat === null ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveCat(null)}
            >
              الكل
            </Button>
            {topics.map(t => (
              <Button
                key={t.category}
                variant={activeCat === t.category ? "default" : "outline"}
                size="sm"
                onClick={() => setActiveCat(t.category)}
              >
                {CATEGORY_LABEL_AR[t.category] ?? t.category}
                <Badge variant="secondary" className="ms-2">{t.n}</Badge>
              </Button>
            ))}
          </div>

          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="ابحث في الأسئلة…"
          />

          <div className="space-y-2">
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">لا توجد نتائج.</p>
            ) : filtered.map(e => (
              <details key={e.id} className="rounded-md border bg-card">
                <summary className="cursor-pointer p-3 font-medium text-sm hover:bg-muted/30">
                  {e.question_ar}
                </summary>
                <div className="p-3 pt-0 border-t text-sm leading-7 whitespace-pre-wrap text-muted-foreground">
                  {e.answer_ar}
                </div>
              </details>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
