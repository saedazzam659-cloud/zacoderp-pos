// Accounting standards browser + AI Q&A.
//
// Reads from /api/accounting-ai/standards (filterable list) and
// /api/accounting-ai/ask (RAG-style answer with citations).
//
// Used by finance/accountant roles to look up IFRS / US GAAP / ZATCA
// rules in Arabic, with the option of asking a free-form question.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sparkles, Send, BookOpen, RefreshCw, ExternalLink, Library } from "lucide-react";

const API = import.meta.env.VITE_API_URL || "";

interface StdSummary {
  id: number;
  standard: "ifrs" | "gaap" | "zatca";
  code: string;
  title_ar: string;
  title_en: string | null;
  summary_ar: string;
  tags: string[];
}

interface StdFull extends StdSummary {
  summary_en: string | null;
  full_text_ar: string;
  full_text_en: string | null;
  source_refs: { titleAr?: string; titleEn?: string; url: string }[];
}

interface AskResp {
  answer: string;
  source: "ai" | "kb" | "none";
  provider?: "openai" | "anthropic";
  citations: { id: number; code: string; standard: string; title: string }[];
}

const STANDARDS_TABS: { id: "all" | "ifrs" | "gaap" | "zatca"; labelAr: string; color: string }[] = [
  { id: "all",   labelAr: "الكل",   color: "bg-gray-100 text-gray-800" },
  { id: "ifrs",  labelAr: "IFRS",   color: "bg-blue-100 text-blue-800" },
  { id: "gaap",  labelAr: "US GAAP", color: "bg-emerald-100 text-emerald-800" },
  { id: "zatca", labelAr: "زاتكا",  color: "bg-amber-100 text-amber-800" },
];

export default function AccountingStandards() {
  const { i18n } = useTranslation();
  const isRtl = i18n.language === "ar";

  const [tab, setTab] = useState<"all" | "ifrs" | "gaap" | "zatca">("all");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<StdSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<StdFull | null>(null);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<AskResp | null>(null);

  // ── List + filter ────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (tab !== "all") qs.set("standard", tab);
    if (search.trim()) qs.set("q", search.trim());
    fetch(`${API}/api/accounting-ai/standards?${qs.toString()}`, { credentials: "include" })
      .then(r => r.json())
      .then(j => setItems(j.entries ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [tab, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { ifrs: 0, gaap: 0, zatca: 0 };
    for (const x of items) if (c[x.standard] !== undefined) c[x.standard]++;
    return c;
  }, [items]);

  async function openEntry(id: number) {
    try {
      const r = await fetch(`${API}/api/accounting-ai/standards/${id}`, { credentials: "include" });
      const j: StdFull = await r.json();
      setSelected(j);
    } catch { /* ignore */ }
  }

  async function ask() {
    if (!question.trim() || asking) return;
    setAsking(true);
    setAnswer(null);
    try {
      const r = await fetch(`${API}/api/accounting-ai/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          question,
          standard: tab === "all" ? undefined : tab,
          locale: isRtl ? "ar" : "en",
        }),
      });
      const j: AskResp = await r.json();
      setAnswer(j);
    } catch {
      setAnswer({ answer: "تعذّر الوصول للخادم.", source: "none", citations: [] });
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="container mx-auto py-6 space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <Library className="h-7 w-7 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">مكتبة المعايير المحاسبية</h1>
          <p className="text-sm text-muted-foreground">
            مرجع سريع لمعايير IFRS و US GAAP ولوائح زاتكا — مع مستشار ذكي مجاني للأسئلة المحاسبية.
          </p>
        </div>
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        {STANDARDS_TABS.map(t => (
          <Button
            key={t.id}
            size="sm"
            variant={tab === t.id ? "default" : "outline"}
            onClick={() => setTab(t.id)}
          >
            {t.labelAr}
            {tab === "all" && t.id !== "all" && counts[t.id] !== undefined && (
              <Badge variant="secondary" className="ms-2">{counts[t.id]}</Badge>
            )}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── List + search ────────────────────────────────────────────── */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-5 w-5 text-primary" />
              المعايير ({items.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="ابحث برمز المعيار أو الاسم أو الكلمة المفتاحية…"
            />
            {loading ? (
              <p className="text-sm text-muted-foreground text-center py-8">جارٍ التحميل…</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">لا توجد نتائج.</p>
            ) : (
              <ScrollArea className="h-[520px] pr-2">
                <div className="space-y-2">
                  {items.map(it => (
                    <button
                      key={it.id}
                      onClick={() => openEntry(it.id)}
                      className="w-full text-start rounded-md border p-3 hover:bg-muted/40 transition"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                        <span className="font-mono text-xs px-2 py-0.5 rounded bg-primary/10 text-primary">
                          {it.code}
                        </span>
                        <span className="text-xs text-muted-foreground uppercase">{it.standard}</span>
                      </div>
                      <div className="font-medium text-sm">{it.title_ar}</div>
                      <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{it.summary_ar}</div>
                      {it.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {it.tags.slice(0, 4).map(tag => (
                            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-muted">{tag}</span>
                          ))}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        {/* ── Ask AI ───────────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-5 w-5 text-amber-500" />
              اسأل المستشار المحاسبي
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={question}
              onChange={e => setQuestion(e.target.value)}
              rows={3}
              placeholder="مثال: متى أعترف بإيراد مشروع طويل الأجل وفقاً لـ IFRS 15؟"
            />
            <Button onClick={ask} disabled={asking || !question.trim()} className="w-full gap-2">
              {asking ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {asking ? "جارٍ التحليل…" : "اسأل"}
            </Button>
            {answer && (
              <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-sm">
                <div className="flex items-center gap-1 flex-wrap">
                  <Badge variant={answer.source === "ai" ? "default" : "secondary"} className="text-[10px]">
                    {answer.source === "ai"
                      ? `ذكاء اصطناعي${answer.provider ? ` (${answer.provider})` : ""}`
                      : answer.source === "kb" ? "قاعدة معرفة" : "بدون نتائج"}
                  </Badge>
                  {answer.citations.map(c => (
                    <Badge key={c.id} variant="outline" className="text-[10px] font-mono">{c.code}</Badge>
                  ))}
                </div>
                <div className="whitespace-pre-wrap leading-7">{answer.answer}</div>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground leading-5">
              ⚠️ هذه إجابات استرشادية مبنية على ملخصات المعايير المتاحة، وليست استشارة قانونية أو ضريبية رسمية.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Detail modal ─────────────────────────────────────────────────── */}
      {selected && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setSelected(null)}
        >
          <Card className="max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <CardHeader className="pb-3 border-b">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm px-2 py-1 rounded bg-primary/10 text-primary">{selected.code}</span>
                  <span className="text-xs uppercase text-muted-foreground">{selected.standard}</span>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>إغلاق</Button>
              </div>
              <CardTitle className="text-lg pt-2">{selected.title_ar}</CardTitle>
              {selected.title_en && <p className="text-sm text-muted-foreground">{selected.title_en}</p>}
            </CardHeader>
            <ScrollArea className="flex-1">
              <CardContent className="space-y-4 pt-4">
                <div>
                  <h3 className="font-semibold text-sm mb-1">ملخص</h3>
                  <p className="text-sm leading-7 whitespace-pre-wrap">{selected.summary_ar}</p>
                </div>
                <div>
                  <h3 className="font-semibold text-sm mb-1">التفاصيل</h3>
                  <p className="text-sm leading-7 whitespace-pre-wrap">{selected.full_text_ar}</p>
                </div>
                {selected.full_text_en && (
                  <details className="text-sm">
                    <summary className="cursor-pointer font-semibold">English version</summary>
                    <p className="leading-7 whitespace-pre-wrap mt-2" dir="ltr">{selected.full_text_en}</p>
                  </details>
                )}
                {selected.source_refs?.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-sm mb-1">المراجع</h3>
                    <ul className="space-y-1">
                      {selected.source_refs.map((ref, i) => (
                        <li key={i}>
                          <a
                            href={ref.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-primary hover:underline text-sm inline-flex items-center gap-1"
                          >
                            {ref.titleAr || ref.titleEn || ref.url}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {selected.tags?.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-2 border-t">
                    {selected.tags.map(t => (
                      <span key={t} className="text-[11px] px-2 py-0.5 rounded bg-muted">{t}</span>
                    ))}
                  </div>
                )}
              </CardContent>
            </ScrollArea>
          </Card>
        </div>
      )}
    </div>
  );
}
