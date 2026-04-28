import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { COUNTRIES } from "@/lib/countries";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sparkles, Save, Loader2, RefreshCcw, Eye, Trash2, FileText, Wand2, Settings2,
  CheckCircle2, Clock, Send, Copy as CopyIcon, Plus, X,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type AiSettings = {
  model: string;
  tone: string;
  length: string;
  language: string;
  defaultKeywords: string[];
  guidance: string;
};

type Article = {
  id: number;
  title: string;
  slug: string;
  metaDescription: string;
  content: string;
  targetKeyword: string;
  sourceTopic: string;
  aiModel: string;
  status: "draft" | "reviewed" | "published";
  // CSV of country codes (e.g. "SA,AE" or "GLOBAL"). May be missing on
  // legacy rows authored before the column existed — treat as "GLOBAL".
  targetCountries?: string;
  createdAt: string;
  updatedAt: string;
};

// Helper: parse the CSV column into an array, defaulting to ["GLOBAL"]
// for legacy rows. Used by both the country filter and the article table.
function parseCountries(raw: string | undefined | null): string[] {
  const list = (raw || "GLOBAL").split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
  return list.length ? list : ["GLOBAL"];
}
function countryLabelAr(code: string): string {
  return COUNTRIES.find(c => c.code === code)?.nameAr ?? code;
}

const MODEL_OPTIONS = [
  { value: "claude-haiku-4-5",  label: "Claude Haiku 4.5 — أسرع وأرخص" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — متوازن (موصى به)" },
  { value: "claude-opus-4-7",   label: "Claude Opus 4.7 — أعلى جودة" },
];
const TONE_OPTIONS = [
  { value: "professional", label: "احترافي" },
  { value: "friendly",     label: "ودي وقريب" },
  { value: "marketing",    label: "تسويقي مقنع" },
  { value: "educational",  label: "تعليمي تثقيفي" },
];
const LENGTH_OPTIONS = [
  { value: "short",  label: "قصير ‑ ~500 كلمة" },
  { value: "medium", label: "متوسط ‑ ~1000 كلمة" },
  { value: "long",   label: "طويل ‑ ~1800 كلمة" },
];
const LANG_OPTIONS = [
  { value: "ar",   label: "العربية" },
  { value: "en",   label: "الإنجليزية" },
  { value: "both", label: "ثنائية (عربي مع مصطلحات إنجليزية)" },
];

function statusBadge(status: Article["status"]) {
  if (status === "published") return <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><CheckCircle2 className="h-3 w-3 ms-1" /> منشور</Badge>;
  if (status === "reviewed")  return <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100"><Eye className="h-3 w-3 ms-1" /> مُراجَع</Badge>;
  return <Badge variant="secondary"><Clock className="h-3 w-3 ms-1" /> مسودة</Badge>;
}

export default function SeoAiStudio() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // ── Settings ───────────────────────────────────────────────────────────
  const settingsQuery = useQuery<AiSettings>({
    queryKey: ["seo-ai-settings"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/seo/ai-settings`, { headers });
      if (!r.ok) throw new Error("فشل التحميل");
      return r.json();
    },
  });
  const [draft, setDraft] = useState<AiSettings | null>(null);
  const s = draft ?? settingsQuery.data ?? null;
  const [newKeyword, setNewKeyword] = useState("");

  const saveSettings = useMutation({
    mutationFn: async (next: AiSettings) => {
      const r = await fetch(`${API}/api/admin/seo/ai-settings`, {
        method: "PUT", headers, body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error((await r.json()).error || "فشل الحفظ");
      return r.json();
    },
    onSuccess: (data) => {
      setDraft(null);
      qc.setQueryData(["seo-ai-settings"], data);
      toast({ title: "تم حفظ الإعدادات" });
    },
    onError: (e: any) => toast({ title: "تعذّر الحفظ", description: e.message, variant: "destructive" }),
  });

  function patchDraft(patch: Partial<AiSettings>) {
    if (!s) return;
    setDraft({ ...s, ...patch });
  }
  function addKeyword() {
    const v = newKeyword.trim();
    if (!s || !v) return;
    if (s.defaultKeywords.includes(v)) { setNewKeyword(""); return; }
    patchDraft({ defaultKeywords: [...s.defaultKeywords, v] });
    setNewKeyword("");
  }
  function removeKeyword(k: string) {
    if (!s) return;
    patchDraft({ defaultKeywords: s.defaultKeywords.filter(x => x !== k) });
  }
  const isDirty = !!draft;

  // ── Articles ───────────────────────────────────────────────────────────
  const articlesQuery = useQuery<Article[]>({
    queryKey: ["seo-ai-articles"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/seo/ai-articles`, { headers });
      if (!r.ok) throw new Error("فشل التحميل");
      return r.json();
    },
  });

  const [topic, setTopic] = useState("");
  const [keyword, setKeyword] = useState("");
  // Multi-select country chips for the generation form. Defaults to
  // ["GLOBAL"] which produces a country-neutral article that the public
  // /api/seo/public/articles endpoint surfaces to every visitor.
  const [genCountries, setGenCountries] = useState<string[]>(["GLOBAL"]);
  function toggleGenCountry(code: string) {
    setGenCountries(prev => {
      // Picking GLOBAL clears all other selections (and vice-versa) — the
      // two states are mutually exclusive: GLOBAL is the "any country"
      // sentinel, so combining it with specific codes is meaningless.
      if (code === "GLOBAL") return ["GLOBAL"];
      const without = prev.filter(c => c !== "GLOBAL" && c !== code);
      const next = prev.includes(code) ? without : [...without, code];
      return next.length ? next : ["GLOBAL"];
    });
  }

  const generate = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/seo/ai-articles/generate`, {
        method: "POST", headers,
        body: JSON.stringify({
          topic, targetKeyword: keyword, sourceTopic: topic,
          targetCountries: genCountries,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "فشل التوليد");
      return data as Article;
    },
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ["seo-ai-articles"] });
      setOpenArticle(a);
      setTopic(""); setKeyword("");
      // Keep the country selection sticky so the admin can generate a
      // batch of articles for the same target audience without re-picking.
      toast({ title: "تم توليد المقال", description: a.title });
    },
    onError: (e: any) => toast({ title: "فشل التوليد", description: e.message, variant: "destructive" }),
  });

  // ── Country filter for the articles table (separate from generation) ─
  const [filterCountry, setFilterCountry] = useState<string>("ALL");
  const filteredArticles = useMemo(() => {
    const all = articlesQuery.data ?? [];
    if (filterCountry === "ALL") return all;
    return all.filter(a => parseCountries(a.targetCountries).includes(filterCountry));
  }, [articlesQuery.data, filterCountry]);

  // Quick-suggest topics inspired by the SEO dashboard recommendations.
  // Default seed list used until the AI suggestion mutation replaces it.
  const DEFAULT_SUGGESTIONS = [
    "أفضل برنامج محاسبة سعودي لعام 2026",
    "دليل شامل للفاتورة الإلكترونية المرحلة الثانية",
    "كيف تُطبّق متطلبات هيئة الزكاة والضريبة في 5 خطوات؟",
    "نظام نقاط البيع POS المتكامل مع ZATCA",
    "قائمة بأخطاء الفوترة الشائعة وكيفية تجنّبها",
  ];
  const [suggestions, setSuggestions] = useState<string[]>(DEFAULT_SUGGESTIONS);

  // Calls /api/admin/seo/ai-suggestions to refresh the chips with a fresh
  // batch tailored by the optional keyword + currently-selected countries.
  const refreshSuggestions = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/seo/ai-suggestions`, {
        method: "POST", headers,
        body: JSON.stringify({
          keyword: keyword.trim() || undefined,
          targetCountries: genCountries,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "فشل توليد الاقتراحات");
      return (data?.suggestions ?? []) as string[];
    },
    onSuccess: (list) => {
      if (list.length) setSuggestions(list);
      toast({ title: "تم تحديث الاقتراحات" });
    },
    onError: (e: any) => toast({ title: "تعذّر توليد الاقتراحات", description: e.message, variant: "destructive" }),
  });

  // ── Article dialog (preview/edit/delete) ──────────────────────────────
  const [openArticle, setOpenArticle] = useState<Article | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Article | null>(null);

  const updateStatus = useMutation({
    mutationFn: async (input: { id: number; status: Article["status"] }) => {
      const r = await fetch(`${API}/api/admin/seo/ai-articles/${input.id}`, {
        method: "PATCH", headers, body: JSON.stringify({ status: input.status }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "فشل التحديث");
      return r.json();
    },
    onSuccess: (a: Article) => {
      qc.invalidateQueries({ queryKey: ["seo-ai-articles"] });
      setOpenArticle(prev => prev && prev.id === a.id ? a : prev);
      toast({ title: "تم تحديث الحالة" });
    },
    onError: (e: any) => toast({ title: "تعذّر التحديث", description: e.message, variant: "destructive" }),
  });

  // Inline mutation for editing the article's geographic targeting from
  // within the preview dialog. We send the chosen codes as an array — the
  // backend normalizes/validates (allowlist + GLOBAL exclusivity) and
  // rejects mixed selections with a 400.
  const updateCountries = useMutation({
    mutationFn: async (input: { id: number; countries: string[] }) => {
      const r = await fetch(`${API}/api/admin/seo/ai-articles/${input.id}`, {
        method: "PATCH", headers,
        body: JSON.stringify({ targetCountries: input.countries }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "فشل تحديث الدول");
      return data as Article;
    },
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ["seo-ai-articles"] });
      setOpenArticle(prev => prev && prev.id === a.id ? a : prev);
      toast({ title: "تم تحديث الاستهداف الجغرافي" });
    },
    onError: (e: any) => toast({ title: "تعذّر التحديث", description: e.message, variant: "destructive" }),
  });

  // Toggle a country code on the currently-open article and immediately
  // commit the change. Mirrors the generation form's mutual-exclusivity:
  // GLOBAL clears all specific codes (and vice-versa).
  function toggleArticleCountry(code: string) {
    if (!openArticle) return;
    const current = parseCountries(openArticle.targetCountries);
    let next: string[];
    if (code === "GLOBAL") {
      next = ["GLOBAL"];
    } else {
      const without = current.filter(c => c !== "GLOBAL" && c !== code);
      next = current.includes(code) ? without : [...without, code];
      if (!next.length) next = ["GLOBAL"];
    }
    // Skip a no-op write if the user clicked the only-selected chip
    // and we ended up at the same set.
    const sameSet = next.length === current.length && next.every(c => current.includes(c));
    if (sameSet) return;
    updateCountries.mutate({ id: openArticle.id, countries: next });
  }

  const deleteArticle = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/seo/ai-articles/${id}`, { method: "DELETE", headers });
      if (!r.ok) throw new Error((await r.json()).error || "فشل الحذف");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["seo-ai-articles"] });
      setConfirmDelete(null);
      setOpenArticle(null);
      toast({ title: "تم الحذف" });
    },
    onError: (e: any) => toast({ title: "تعذّر الحذف", description: e.message, variant: "destructive" }),
  });

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(
      () => toast({ title: `تم نسخ ${label}` }),
      () => toast({ title: "تعذّر النسخ", variant: "destructive" }),
    );
  }

  if (settingsQuery.isLoading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (settingsQuery.isError || !s) {
    return (
      <div className="p-8 max-w-xl mx-auto" dir="rtl">
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">تعذّر تحميل إعدادات استوديو SEO</CardTitle>
            <CardDescription>
              تأكّد من تشغيل الخادم وصلاحيات المسؤول الأعلى، ثم أعد المحاولة.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => settingsQuery.refetch()}>
              <RefreshCcw className="h-4 w-4 ms-1" />
              إعادة المحاولة
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto" dir="rtl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-fuchsia-500 to-purple-600 flex items-center justify-center text-white shadow-md">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-bold">استوديو الذكاء الاصطناعي لـ SEO</h1>
            <p className="text-sm text-muted-foreground">
              ولّد مقالات محسّنة لمحركات البحث آلياً لرفع ترافيك الموقع، وتحكّم بإعدادات التوليد.
            </p>
          </div>
        </div>
      </div>

      <Tabs defaultValue="generate" className="w-full">
        <TabsList className="grid w-full max-w-md grid-cols-3">
          <TabsTrigger value="generate"><Wand2 className="h-4 w-4 ms-1" /> التوليد</TabsTrigger>
          <TabsTrigger value="articles"><FileText className="h-4 w-4 ms-1" /> المقالات</TabsTrigger>
          <TabsTrigger value="settings"><Settings2 className="h-4 w-4 ms-1" /> الإعدادات</TabsTrigger>
        </TabsList>

        {/* ── Generate ────────────────────────────────────────────────── */}
        <TabsContent value="generate" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <Wand2 className="h-5 w-5 text-fuchsia-600" />
                توليد مقال جديد
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2 space-y-2">
                  <Label>موضوع المقال</Label>
                  <Input
                    placeholder="مثال: دليل التحول للفاتورة الإلكترونية للشركات الصغيرة"
                    value={topic}
                    onChange={e => setTopic(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>الكلمة المفتاحية المستهدفة (اختياري)</Label>
                  <Input
                    placeholder="مثال: فاتورة إلكترونية"
                    value={keyword}
                    onChange={e => setKeyword(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2 gap-2">
                  <p className="text-xs text-muted-foreground">اقتراحات سريعة:</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-fuchsia-700 hover:text-fuchsia-800 hover:bg-fuchsia-50"
                    onClick={() => refreshSuggestions.mutate()}
                    disabled={refreshSuggestions.isPending}
                    title="توليد اقتراحات جديدة بالذكاء الاصطناعي بناءً على الكلمة المفتاحية والدول المختارة"
                  >
                    {refreshSuggestions.isPending
                      ? <Loader2 className="h-3.5 w-3.5 ms-1 animate-spin" />
                      : <Sparkles className="h-3.5 w-3.5 ms-1" />}
                    اقتراحات بالذكاء الاصطناعي
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {suggestions.map(sg => (
                    <button
                      key={sg}
                      type="button"
                      onClick={() => setTopic(sg)}
                      className="text-xs rounded-full border border-dashed border-fuchsia-300 bg-fuchsia-50 px-3 py-1 text-fuchsia-700 hover:bg-fuchsia-100 transition-colors"
                    >
                      {sg}
                    </button>
                  ))}
                  {suggestions.length === 0 && (
                    <p className="text-xs text-muted-foreground italic">لا توجد اقتراحات حالياً.</p>
                  )}
                </div>
              </div>

              {/* Country targeting chips. The selected codes are stored on
                  the article and used by /api/seo/public/articles to surface
                  the right content per visitor (CF-IPCountry → cookie). */}
              <div>
                <Label className="block mb-2">الدول المستهدفة</Label>
                <div className="flex flex-wrap gap-2">
                  {COUNTRIES.map(c => {
                    const selected = genCountries.includes(c.code);
                    const isGlobal = c.code === "GLOBAL";
                    return (
                      <button
                        key={c.code}
                        type="button"
                        data-testid={`country-chip-${c.code}`}
                        onClick={() => toggleGenCountry(c.code)}
                        className={[
                          "text-xs rounded-full border px-3 py-1 transition-colors",
                          selected
                            ? (isGlobal
                                ? "bg-amber-100 border-amber-400 text-amber-800 font-semibold"
                                : "bg-emerald-100 border-emerald-400 text-emerald-800 font-semibold")
                            : "bg-white border-muted text-muted-foreground hover:border-fuchsia-300 hover:text-fuchsia-700",
                        ].join(" ")}
                      >
                        {c.nameAr}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground mt-2">
                  «دول أخرى» = محتوى عام يظهر لكل الزوار حين لا يوجد محتوى
                  مخصّص لدولتهم. اختيار دولة واحدة أو أكثر يخصّص المقال لها.
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">النموذج: {s.model}</Badge>
                  <Badge variant="outline">النبرة: {TONE_OPTIONS.find(o => o.value === s.tone)?.label ?? s.tone}</Badge>
                  <Badge variant="outline">الطول: {LENGTH_OPTIONS.find(o => o.value === s.length)?.label ?? s.length}</Badge>
                </div>
                <Button
                  onClick={() => generate.mutate()}
                  disabled={generate.isPending || topic.trim().length < 4}
                  className="bg-gradient-to-r from-fuchsia-600 to-purple-600 hover:from-fuchsia-700 hover:to-purple-700"
                >
                  {generate.isPending
                    ? <><Loader2 className="h-4 w-4 ms-2 animate-spin" /> جارٍ التوليد...</>
                    : <><Sparkles className="h-4 w-4 ms-2" /> توليد المقال</>}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Articles ────────────────────────────────────────────────── */}
        <TabsContent value="articles" className="mt-4">
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between flex-wrap gap-3">
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-fuchsia-600" /> المقالات المُولَّدة
                {articlesQuery.data && (
                  <Badge variant="secondary" className="ms-2">
                    {filterCountry === "ALL"
                      ? articlesQuery.data.length
                      : `${filteredArticles.length}/${articlesQuery.data.length}`}
                  </Badge>
                )}
              </CardTitle>
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground hidden md:block">فلتر بالدولة:</Label>
                <Select value={filterCountry} onValueChange={setFilterCountry}>
                  <SelectTrigger className="w-44 h-9" data-testid="articles-country-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">كل الدول</SelectItem>
                    {COUNTRIES.map(c => (
                      <SelectItem key={c.code} value={c.code}>{c.nameAr}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline" size="sm"
                  onClick={() => articlesQuery.refetch()}
                  disabled={articlesQuery.isFetching}
                >
                  <RefreshCcw className={`h-4 w-4 ms-1 ${articlesQuery.isFetching ? "animate-spin" : ""}`} />
                  تحديث
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {articlesQuery.isLoading ? (
                <div className="py-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
              ) : articlesQuery.isError ? (
                <div className="py-12 text-center">
                  <p className="text-destructive mb-3">تعذّر تحميل المقالات</p>
                  <Button variant="outline" size="sm" onClick={() => articlesQuery.refetch()}>
                    <RefreshCcw className="h-4 w-4 ms-1" />
                    إعادة المحاولة
                  </Button>
                </div>
              ) : (articlesQuery.data?.length ?? 0) === 0 ? (
                <div className="py-12 text-center text-muted-foreground">
                  <FileText className="mx-auto h-10 w-10 opacity-30 mb-2" />
                  لا توجد مقالات بعد. ابدأ من تبويب «التوليد».
                </div>
              ) : filteredArticles.length === 0 ? (
                <div className="py-12 text-center text-muted-foreground">
                  <FileText className="mx-auto h-10 w-10 opacity-30 mb-2" />
                  لا توجد مقالات تطابق الفلتر الحالي.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-start text-muted-foreground border-b">
                        <th className="py-2 ps-2 text-start">العنوان</th>
                        <th className="py-2 text-start hidden md:table-cell">الكلمة المفتاحية</th>
                        <th className="py-2 text-start">الدولة</th>
                        <th className="py-2 text-start">الحالة</th>
                        <th className="py-2 text-start hidden md:table-cell">التاريخ</th>
                        <th className="py-2 pe-2 text-end">إجراءات</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredArticles.map(a => {
                        const codes = parseCountries(a.targetCountries);
                        return (
                          <tr key={a.id} className="border-b last:border-0 hover:bg-muted/30" data-testid={`article-row-${a.id}`}>
                            <td className="py-3 ps-2">
                              <div className="font-medium line-clamp-1">{a.title}</div>
                              <div className="text-xs text-muted-foreground line-clamp-1">/{a.slug}</div>
                            </td>
                            <td className="py-3 hidden md:table-cell">
                              {a.targetKeyword
                                ? <Badge variant="outline">{a.targetKeyword}</Badge>
                                : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="py-3">
                              <div className="flex flex-wrap gap-1 max-w-[180px]">
                                {codes.map(code => (
                                  <Badge
                                    key={code}
                                    variant={code === "GLOBAL" ? "outline" : "secondary"}
                                    className={code === "GLOBAL"
                                      ? "text-[10px] border-amber-400 text-amber-800 bg-amber-50"
                                      : "text-[10px] bg-emerald-100 text-emerald-800"}
                                  >
                                    {countryLabelAr(code)}
                                  </Badge>
                                ))}
                              </div>
                            </td>
                            <td className="py-3">{statusBadge(a.status)}</td>
                            <td className="py-3 hidden md:table-cell text-muted-foreground text-xs">
                              {new Date(a.createdAt).toLocaleString("ar-SA", { dateStyle: "short", timeStyle: "short" })}
                            </td>
                            <td className="py-3 pe-2">
                              <div className="flex justify-end gap-1">
                                <Button variant="ghost" size="sm" onClick={() => setOpenArticle(a)}>
                                  <Eye className="h-4 w-4 ms-1" /> فتح
                                </Button>
                                <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmDelete(a)}>
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Settings ────────────────────────────────────────────────── */}
        <TabsContent value="settings" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <Settings2 className="h-5 w-5 text-fuchsia-600" /> إعدادات المُولِّد
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>نموذج الذكاء الاصطناعي</Label>
                  <Select value={s.model} onValueChange={v => patchDraft({ model: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MODEL_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>نبرة الكتابة</Label>
                  <Select value={s.tone} onValueChange={v => patchDraft({ tone: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TONE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>طول المقال</Label>
                  <Select value={s.length} onValueChange={v => patchDraft({ length: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LENGTH_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>اللغة</Label>
                  <Select value={s.language} onValueChange={v => patchDraft({ language: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LANG_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>كلمات مفتاحية افتراضية للموقع</Label>
                <div className="flex flex-wrap gap-2">
                  {s.defaultKeywords.map(k => (
                    <Badge key={k} variant="secondary" className="text-sm gap-1 ps-2 pe-1 py-1">
                      {k}
                      <button onClick={() => removeKeyword(k)} className="rounded-full hover:bg-destructive/20 p-0.5">
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="أضف كلمة مفتاحية…"
                    value={newKeyword}
                    onChange={e => setNewKeyword(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addKeyword(); } }}
                  />
                  <Button type="button" variant="outline" onClick={addKeyword}>
                    <Plus className="h-4 w-4 ms-1" /> إضافة
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label>توجيهات للنموذج</Label>
                <Textarea
                  rows={4}
                  value={s.guidance}
                  onChange={e => patchDraft({ guidance: e.target.value })}
                  placeholder="صف الجمهور المستهدف، نبرة العلامة، أسلوب التسويق المفضّل…"
                />
                <p className="text-xs text-muted-foreground">
                  هذه التوجيهات تُحقن في كل عملية توليد لضبط أسلوب الكتابة.
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t">
                <Button variant="ghost" disabled={!isDirty || saveSettings.isPending} onClick={() => setDraft(null)}>
                  إلغاء
                </Button>
                <Button
                  disabled={!isDirty || saveSettings.isPending}
                  onClick={() => draft && saveSettings.mutate(draft)}
                >
                  {saveSettings.isPending
                    ? <><Loader2 className="h-4 w-4 ms-2 animate-spin" /> جارٍ الحفظ...</>
                    : <><Save className="h-4 w-4 ms-2" /> حفظ الإعدادات</>}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Article preview/edit dialog ─────────────────────────────── */}
      <Dialog open={!!openArticle} onOpenChange={(o) => !o && setOpenArticle(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" dir="rtl">
          {openArticle && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {statusBadge(openArticle.status)}
                  <span>{openArticle.title}</span>
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">المسار (Slug)</p>
                    <div className="flex items-center gap-1">
                      <code className="bg-muted rounded px-2 py-1 text-xs flex-1 truncate">/{openArticle.slug}</code>
                      <Button variant="ghost" size="sm" onClick={() => copy(openArticle.slug, "المسار")}>
                        <CopyIcon className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">الكلمة المفتاحية</p>
                    <Badge variant="outline">{openArticle.targetKeyword || "—"}</Badge>
                  </div>
                </div>

                <div>
                  <p className="text-xs text-muted-foreground mb-1">وصف ميتا</p>
                  <div className="rounded-md border bg-muted/30 p-2 text-sm">{openArticle.metaDescription || "—"}</div>
                </div>

                {/* Editable geographic targeting — clicking a chip toggles
                    membership and immediately PATCHes the article. The
                    GLOBAL chip is mutually-exclusive with the per-country
                    chips, mirroring the generation form. */}
                <div data-testid="article-country-editor">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs text-muted-foreground">الاستهداف الجغرافي</p>
                    {updateCountries.isPending && (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {COUNTRIES.map(c => {
                      const active = parseCountries(openArticle.targetCountries).includes(c.code);
                      return (
                        <button
                          key={c.code}
                          type="button"
                          onClick={() => toggleArticleCountry(c.code)}
                          disabled={updateCountries.isPending}
                          data-testid={`article-country-chip-${c.code}`}
                          aria-pressed={active}
                          className={
                            "px-2 py-1 rounded-full text-xs border transition-colors disabled:opacity-60 " +
                            (active
                              ? "bg-fuchsia-600 text-white border-fuchsia-600"
                              : "bg-background hover:bg-muted border-input")
                          }
                        >
                          {c.nameAr}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs text-muted-foreground">المحتوى (Markdown)</p>
                    <Button variant="ghost" size="sm" onClick={() => copy(openArticle.content, "المحتوى")}>
                      <CopyIcon className="h-3 w-3 ms-1" /> نسخ
                    </Button>
                  </div>
                  <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm font-sans leading-relaxed max-h-[50vh] overflow-y-auto">
                    {openArticle.content}
                  </pre>
                </div>

                <div className="text-xs text-muted-foreground">
                  وُلِّد بواسطة {openArticle.aiModel} · {new Date(openArticle.createdAt).toLocaleString("ar-SA")}
                </div>
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setConfirmDelete(openArticle)} className="text-destructive">
                  <Trash2 className="h-4 w-4 ms-1" /> حذف
                </Button>
                {openArticle.status !== "reviewed" && openArticle.status !== "published" && (
                  <Button variant="outline" onClick={() => updateStatus.mutate({ id: openArticle.id, status: "reviewed" })}>
                    <Eye className="h-4 w-4 ms-1" /> اعتمدها للمراجعة
                  </Button>
                )}
                {openArticle.status !== "published" && (
                  <Button onClick={() => updateStatus.mutate({ id: openArticle.id, status: "published" })}>
                    <Send className="h-4 w-4 ms-1" /> اعتبارها منشورة
                  </Button>
                )}
                {openArticle.status === "published" && (
                  <Button variant="outline" onClick={() => updateStatus.mutate({ id: openArticle.id, status: "draft" })}>
                    إعادة لمسودة
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف المقال</AlertDialogTitle>
            <AlertDialogDescription>
              سيتم حذف «{confirmDelete?.title}» نهائياً. لا يمكن التراجع.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDelete && deleteArticle.mutate(confirmDelete.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              حذف
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
