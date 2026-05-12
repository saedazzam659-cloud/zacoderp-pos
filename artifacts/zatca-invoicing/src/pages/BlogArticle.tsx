import { useEffect, useMemo } from "react";
import { useRoute, useLocation, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Helmet } from "react-helmet-async";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronLeft, Calendar, Tag, FileText, ArrowLeft, Package, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type RelatedArticle = {
  id: number;
  title: string;
  slug: string;
  metaDescription: string;
};

// ─────────────────────────────────────────────────────────────────────────
// Public /blog/:slug page — renders a single published SEO article so the
// links emitted by /pricing and /sitemap.xml actually resolve to readable
// content for users and Google.
//
// • Fetches a single article from /api/seo/public/articles/:slug.
// • 404s return a gentle empty state (no redirect to /login).
// • All Helmet meta + JSON-LD Article schema are emitted from this page
//   so each article gets its own canonical URL, OG tags, and rich result.
// ─────────────────────────────────────────────────────────────────────────

const BASE = (import.meta as any).env.BASE_URL?.replace(/\/$/, "") || "";

type PublicArticle = {
  id: number;
  title: string;
  slug: string;
  metaDescription: string;
  content: string;
  targetKeyword: string;
  createdAt: string;
  updatedAt: string;
};

export default function BlogArticle() {
  const [, params] = useRoute("/blog/:slug");
  const [, setLocation] = useLocation();
  const slug = params?.slug || "";

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const canonical = `${origin}/blog/${encodeURIComponent(slug)}`;

  const { data, isLoading, isError } = useQuery<PublicArticle>({
    queryKey: ["public-article", slug],
    enabled: !!slug,
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/seo/public/articles/${encodeURIComponent(slug)}`);
      if (r.status === 404) throw new Error("not_found");
      if (!r.ok) throw new Error("fetch_failed");
      return r.json();
    },
    retry: false,
  });

  // Fetch up to 3 OTHER published articles to render at the bottom of
  // every article. Networking errors degrade silently to an empty list
  // so the article body still renders.
  const { data: related = [] } = useQuery<RelatedArticle[]>({
    queryKey: ["public-related", slug],
    enabled: !!slug && !!data,
    queryFn: async () => {
      try {
        const r = await fetch(`${BASE}/api/seo/public/related/${encodeURIComponent(slug)}`);
        if (!r.ok) return [];
        return await r.json();
      } catch { return []; }
    },
    staleTime: 5 * 60 * 1000,
  });

  // JSON-LD Article schema. React 19 + react-helmet-async@3 doesn't auto-
  // hoist inline <script> children, so we mount the schema ourselves into
  // <head> and clean up on unmount / re-fetch.
  const articleSchemas = useMemo(() => {
    if (!data) return null;
    const article = {
      "@context": "https://schema.org",
      "@type":    "Article",
      "headline": data.title,
      "description": data.metaDescription || undefined,
      "url":      canonical,
      "datePublished": data.createdAt,
      "dateModified":  data.updatedAt,
      "inLanguage":    "ar-SA",
      "keywords":      data.targetKeyword || undefined,
      "author":   { "@type": "Organization", "name": "زاكود المحاسبي" },
      "publisher": {
        "@type": "Organization",
        "name":  "زاكود المحاسبي",
        "alternateName": ["Zacoderp", "زاكود"],
        "logo":  { "@type": "ImageObject", "url": `${origin}${BASE}/favicon.svg` },
      },
      "image":   `${origin}${BASE}/opengraph.jpg`,
      "mainEntityOfPage": { "@type": "WebPage", "@id": canonical },
    };
    // Breadcrumb so Google shows "zacoderp.com › المدونة › {title}" under
    // the article result instead of the raw URL — improves CTR meaningfully.
    const breadcrumb = {
      "@context": "https://schema.org",
      "@type":    "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "الرئيسية",  "item": `${origin}/` },
        { "@type": "ListItem", "position": 2, "name": "المدونة",    "item": `${origin}/blog` },
        { "@type": "ListItem", "position": 3, "name": data.title,   "item": canonical },
      ],
    };
    return [article, breadcrumb];
  }, [data, canonical, origin]);

  useEffect(() => {
    const tag = "data-blog-jsonld";
    document.head.querySelectorAll(`script[${tag}]`).forEach(el => el.remove());
    if (!articleSchemas) return;
    const created: HTMLScriptElement[] = [];
    for (const s of articleSchemas) {
      const el = document.createElement("script");
      el.type = "application/ld+json";
      el.setAttribute(tag, "1");
      el.text = JSON.stringify(s);
      document.head.appendChild(el);
      created.push(el);
    }
    return () => { created.forEach(el => el.remove()); };
  }, [articleSchemas]);

  // Helmet's <title> child doesn't always populate document.title under
  // React 19, so we set it explicitly. Restoring the previous title on
  // unmount keeps non-blog navigations clean.
  useEffect(() => {
    if (!data?.title) return;
    const prev = document.title;
    document.title = `${data.title} | زاكود المحاسبي`;
    return () => { document.title = prev; };
  }, [data?.title]);

  // ── Loading state ──
  if (isLoading) {
    return (
      <div dir="rtl" className="min-h-screen bg-muted/30">
        <PublicHeader setLocation={setLocation} />
        <div className="max-w-3xl mx-auto px-4 py-16">
          <div className="h-10 w-2/3 bg-muted rounded animate-pulse mb-6" />
          <div className="h-4 w-full bg-muted rounded animate-pulse mb-3" />
          <div className="h-4 w-5/6 bg-muted rounded animate-pulse mb-3" />
          <div className="h-4 w-4/6 bg-muted rounded animate-pulse" />
        </div>
      </div>
    );
  }

  // ── 404 / error state ──
  if (isError || !data) {
    return (
      <div dir="rtl" className="min-h-screen bg-muted/30">
        <Helmet>
          <title>المقالة غير موجودة | زاكود المحاسبي</title>
          <meta name="robots" content="noindex,follow" />
        </Helmet>
        <PublicHeader setLocation={setLocation} />
        <div className="max-w-2xl mx-auto px-4 py-24 text-center" data-testid="blog-not-found">
          <FileText className="h-14 w-14 mx-auto text-muted-foreground mb-4" />
          <h1 className="text-2xl font-bold mb-2">عذراً، لم نجد هذه المقالة</h1>
          <p className="text-muted-foreground mb-6">
            ربما تم نقلها أو لم يتم نشرها بعد. يمكنك تصفّح الباقات أو الرجوع للرئيسية.
          </p>
          <div className="flex justify-center gap-3">
            <Button onClick={() => setLocation("/pricing")} data-testid="blog-cta-pricing">
              عرض الباقات والأسعار
            </Button>
            <Button variant="outline" onClick={() => setLocation("/login")}>
              تسجيل الدخول
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── Loaded article ──
  const updated = new Date(data.updatedAt).toLocaleDateString("ar-SA", {
    year: "numeric", month: "long", day: "numeric",
  });

  return (
    <div dir="rtl" className="min-h-screen bg-gradient-to-b from-primary/5 via-background to-muted">
      <Helmet>
        <html lang="ar" dir="rtl" />
        <title>{data.title} | زاكود المحاسبي</title>
        <meta name="description" content={data.metaDescription || data.title} />
        <link rel="canonical" href={canonical} />
        <meta name="author" content="زاكود المحاسبي" />
        <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1" />
        <meta name="theme-color" content="#0d9488" />
        <meta property="og:type" content="article" />
        <meta property="og:site_name" content="زاكود المحاسبي" />
        <meta property="og:title" content={data.title} />
        <meta property="og:description" content={data.metaDescription || data.title} />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={`${origin}${BASE}/opengraph.jpg`} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:locale" content="ar_SA" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={data.title} />
        <meta name="twitter:description" content={data.metaDescription || data.title} />
        <meta name="twitter:image" content={`${origin}${BASE}/opengraph.jpg`} />
        {data.targetKeyword ? <meta name="keywords" content={data.targetKeyword} /> : null}
        <meta property="article:published_time" content={data.createdAt} />
        <meta property="article:modified_time"  content={data.updatedAt} />
        <meta property="article:author" content="زاكود المحاسبي" />
        <link rel="alternate" hrefLang="ar-SA" href={canonical} />
        <link rel="alternate" hrefLang="ar" href={canonical} />
        <link rel="alternate" hrefLang="x-default" href={canonical} />
      </Helmet>

      <PublicHeader setLocation={setLocation} />

      <article className="max-w-3xl mx-auto px-4 pt-10 pb-20" data-testid="blog-article">
        {/* breadcrumbs */}
        <nav className="text-xs text-muted-foreground mb-4 flex items-center gap-2" aria-label="breadcrumbs">
          <button onClick={() => setLocation("/pricing")} className="hover:underline">الرئيسية</button>
          <ChevronLeft className="h-3 w-3" />
          <button onClick={() => setLocation("/pricing")} className="hover:underline">المدوّنة</button>
          <ChevronLeft className="h-3 w-3" />
          <span className="text-foreground">{data.title}</span>
        </nav>

        <header className="mb-8 pb-6 border-b">
          <h1 className="text-3xl md:text-4xl font-extrabold leading-tight mb-4" data-testid="blog-title">
            {data.title}
          </h1>
          {data.metaDescription ? (
            <p className="text-lg text-muted-foreground leading-relaxed">{data.metaDescription}</p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" /> آخر تحديث: {updated}
            </span>
            {data.targetKeyword ? (
              <span className="inline-flex items-center gap-1.5">
                <Tag className="h-3.5 w-3.5" /> {data.targetKeyword}
              </span>
            ) : null}
          </div>
        </header>

        <div
          className={cn(
            "prose prose-slate max-w-none",
            "prose-headings:font-bold prose-headings:text-foreground",
            "prose-h2:text-2xl prose-h2:mt-10 prose-h2:mb-4",
            "prose-h3:text-xl prose-h3:mt-8 prose-h3:mb-3",
            "prose-p:leading-relaxed prose-p:text-base",
            "prose-a:text-primary prose-a:no-underline hover:prose-a:underline",
            "prose-strong:text-foreground",
            "prose-ul:my-4 prose-ol:my-4 prose-li:my-1",
            "prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-sm",
            "prose-blockquote:border-r-4 prose-blockquote:border-l-0 prose-blockquote:border-primary",
            "prose-blockquote:pr-4 prose-blockquote:pl-0 prose-blockquote:italic",
            "prose-table:border prose-th:bg-muted prose-th:p-2 prose-td:p-2 prose-td:border",
          )}
          data-testid="blog-content"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {data.content || ""}
          </ReactMarkdown>
        </div>

        {/* Internal-link strip → POS landing + Pricing. Lifts revenue-page
            rank and dwell time per the SEO AI low-impact recommendation.
            Rendered as real <a href> via wouter Link so crawlers can follow
            the internal graph and pass link equity. */}
        <aside className="mt-12 grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="blog-product-links">
          <Link
            href="/pos-system"
            className="text-right rounded-xl border bg-white p-4 hover:border-primary/40 hover:shadow-md transition-all flex items-center gap-3 no-underline text-foreground"
            data-testid="blog-product-link-pos"
          >
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
              <Package className="h-5 w-5" />
            </span>
            <span className="flex-1">
              <span className="block font-semibold text-sm">نظام نقاط البيع المعتمد</span>
              <span className="block text-xs text-muted-foreground">شاهد الفيديو واطّلع على الميزات.</span>
            </span>
            <ArrowLeft className="h-4 w-4 text-muted-foreground" />
          </Link>
          <Link
            href="/pricing"
            className="text-right rounded-xl border bg-white p-4 hover:border-primary/40 hover:shadow-md transition-all flex items-center gap-3 no-underline text-foreground"
            data-testid="blog-product-link-pricing"
          >
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
              <CreditCard className="h-5 w-5" />
            </span>
            <span className="flex-1">
              <span className="block font-semibold text-sm">الباقات والأسعار</span>
              <span className="block text-xs text-muted-foreground">قارن الخطط واختر المناسب لنشاطك.</span>
            </span>
            <ArrowLeft className="h-4 w-4 text-muted-foreground" />
          </Link>
        </aside>

        {/* "اقرأ أيضاً" — real <a href> internal links to other articles
            so Google's crawl graph picks them up. */}
        {related.length > 0 && (
          <section className="mt-10" data-testid="blog-related-section">
            <h2 className="text-xl font-bold mb-4 inline-flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" /> اقرأ أيضاً
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {related.map(r => (
                <Link
                  key={r.id}
                  href={`/blog/${r.slug}`}
                  className="text-right rounded-xl border bg-white p-4 hover:border-primary/40 hover:shadow-md transition-all block no-underline text-foreground"
                  data-testid={`blog-related-${r.id}`}
                >
                  <div className="font-semibold text-sm mb-1.5 line-clamp-2 leading-snug">{r.title}</div>
                  <div className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">{r.metaDescription}</div>
                  <div className="mt-2 text-xs text-primary font-semibold inline-flex items-center gap-1">
                    اقرأ المقالة <ArrowLeft className="h-3 w-3" />
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* CTA card at the end of every article — turns readers into trial users */}
        <div className="mt-12 rounded-2xl border-2 border-primary/30 bg-primary/5 p-6 text-center">
          <h2 className="text-xl font-bold mb-2">جاهز للبدء بنظامك المعتمد من ZATCA؟</h2>
          <p className="text-muted-foreground text-sm mb-5">
            استكشف الباقات الشفافة واختر ما يناسب نشاطك — تجربة فورية بدون بطاقة دفع.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button size="lg" onClick={() => setLocation("/pricing")} className="gap-1" data-testid="blog-cta-pricing-final">
              عرض الباقات والأسعار <ArrowLeft className="h-4 w-4" />
            </Button>
            <Button size="lg" variant="outline" onClick={() => setLocation("/register")}>
              ابدأ التسجيل المجاني
            </Button>
          </div>
        </div>
      </article>

      <footer className="text-center text-xs text-muted-foreground pb-8">
        © 2026 زاكود المحاسبي — نظام محاسبة سعودي معتمد من ZATCA. جميع الحقوق محفوظة.
      </footer>
    </div>
  );
}

// Reusable thin top bar for public pages — mirrors the look of the
// /pricing header so the site feels coherent for first-time visitors
// arriving from a Google search result.
function PublicHeader({ setLocation }: { setLocation: (p: string) => void }) {
  return (
    <header className="border-b bg-white/80 backdrop-blur sticky top-0 z-20">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => setLocation("/pricing")}
          className="flex items-center gap-2 text-sm font-bold text-foreground hover:opacity-80"
          data-testid="blog-home-link"
        >
          <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold shadow">Z</div>
          زاكود المحاسبي
        </button>
        <nav className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setLocation("/login")} data-testid="blog-login-link">
            تسجيل الدخول
          </Button>
          <Button size="sm" onClick={() => setLocation("/pricing")} data-testid="blog-pricing-link">
            عرض الباقات
          </Button>
        </nav>
      </div>
    </header>
  );
}
