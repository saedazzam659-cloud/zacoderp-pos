import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Helmet } from "react-helmet-async";
import {
  ShieldCheck, Sparkles, ArrowLeft, Check, FileText, BarChart3,
  Users, Package, Zap, Globe2, Brain, Building2, Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CountrySelector } from "@/components/CountrySelector";
import { useVisitorCountry } from "@/lib/useVisitorCountry";
import { getCountryByCode } from "@/lib/countries";
import SaudiContactCta from "@/components/SaudiContactCta";

// ─────────────────────────────────────────────────────────────────────────
// Public "/" Home landing page — the canonical homepage Google sees.
// Optimized for the keyword "نظام محاسبة سعودي" per the SEO AI
// recommendation. Authenticated users hit their dashboard instead; this
// page is only rendered for guests.
// ─────────────────────────────────────────────────────────────────────────

const BASE = (import.meta as any).env.BASE_URL?.replace(/\/$/, "") || "";

type ArticleLite = {
  id: number;
  title: string;
  slug: string;
  metaDescription: string;
  targetCountries?: string;
  updatedAt: string;
};

// English country names for schema.org "areaServed" — Google's structured
// data parser expects them in English regardless of page language.
const COUNTRY_AREA_EN: Record<string, string> = {
  SA: "Saudi Arabia", AE: "United Arab Emirates", KW: "Kuwait",
  QA: "Qatar", BH: "Bahrain", OM: "Oman", EG: "Egypt",
  GLOBAL: "Middle East",
};

export default function Home() {
  const [, setLocation] = useLocation();
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const canonical = `${origin}/`;

  // Auto-detected (CF-IPCountry) or user-overridden via the country
  // selector at the top of the page. Drives the JSON-LD areaServed, the
  // welcome strip copy, the currency hint, and the public articles fetch
  // (which echoes the same country in its query string so the cache key
  // changes whenever the visitor flips countries).
  const [visitorCountry, , countryExplicit] = useVisitorCountry();
  const countryInfo = getCountryByCode(visitorCountry);

  // Click-to-play video poster: the heavy iframe (Framer Motion + GSAP +
  // multiple gradient layers) is only mounted after the user clicks Play
  // so the homepage stays light on first paint and Lighthouse stays happy.
  const [videoStarted, setVideoStarted] = useState(false);

  // Fetch latest published articles to feature in the "أحدث المقالات"
  // section — both for visitors and as internal links Google can follow
  // from the homepage. The ?country override is forwarded so the API
  // applies its CSV LIKE filter (visitor's country OR GLOBAL fallback).
  const { data: articles = [] } = useQuery<ArticleLite[]>({
    // When the visitor hasn't picked a country yet, the cache key folds
    // to a single bucket ("auto") so the very first request goes out
    // _without_ a ?country= override and the API gets to honour the
    // CF-IPCountry header. Once the visitor explicitly picks one, the
    // bucket flips to that country code and we start sending the param.
    queryKey: ["public-articles", "home", countryExplicit ? visitorCountry : "auto"],
    queryFn: async () => {
      try {
        // Only attach ?country=… when the visitor explicitly picked one
        // (query string or cookie). Otherwise let the server's geo-IP
        // middleware decide so first-time non-SA visitors don't get
        // forced into the SA default just because that's our UI fallback.
        const url = countryExplicit
          ? `${BASE}/api/seo/public/articles?country=${encodeURIComponent(visitorCountry)}`
          : `${BASE}/api/seo/public/articles`;
        const r = await fetch(url);
        if (!r.ok) return [];
        return await r.json();
      } catch {
        // Network errors must not break the homepage render.
        return [];
      }
    },
    staleTime: 5 * 60 * 1000,
  });
  const featured = articles.slice(0, 6);

  // JSON-LD: Organization + WebSite (with SearchAction) + FAQPage. These
  // are the strongest schemas for ranking the homepage on brand and
  // long-tail accounting queries.
  const schemas = useMemo(() => {
    const faqs = [
      { q: "ما هو أفضل نظام محاسبة سعودي معتمد من ZATCA؟",
        a: "النظام السعودي المعتمد هو الذي يلتزم بمعايير الفاتورة الإلكترونية في مرحلتيها الأولى والثانية: توقيع رقمي UBL 2.1، QR Code متوافق، تكامل مباشر مع بوابة فاتورة، ودعم كامل للغة العربية. نظامنا يلبي جميع هذه المتطلبات." },
      { q: "هل النظام يدعم المحاسبة وضريبة القيمة المضافة (VAT) معاً؟",
        a: "نعم، النظام يدمج الفوترة الإلكترونية مع المحاسبة المالية الكاملة وضريبة القيمة المضافة 15%، ميزان المراجعة، الحسابات الختامية، وتقارير ZATCA الجاهزة." },
      { q: "هل يصلح النظام للشركات الصغيرة والمتوسطة في السعودية؟",
        a: "النظام مصمم خصيصاً للسوق السعودي بجميع أحجام نشاطاته — من المتاجر الفردية إلى المؤسسات متعددة الفروع. الباقة المبتدئة تبدأ بسعر مناسب جداً للمشاريع الصغيرة." },
      { q: "هل يدعم النظام نقاط البيع (POS) والمخزون؟",
        a: "نعم، النظام يشمل نقاط بيع متكاملة، إدارة مخزون متعددة المستودعات، إدارة الموردين والعملاء، الموارد البشرية، وكل ذلك مرتبط بالمحاسبة والفوترة الإلكترونية في منصة واحدة." },
      { q: "هل توجد فترة تجريبية مجانية؟",
        a: "نعم، يمكنك إنشاء حساب الآن والبدء فوراً بفترة تجريبية على الباقة المختارة بدون بطاقة دفع. يمكنك الترقية أو التغيير في أي وقت." },
    ];
    // areaServed is dynamic per visitor country: an SA visitor sees
    // "Saudi Arabia", a UAE visitor sees "United Arab Emirates", etc.
    // For "GLOBAL" we widen the area to "Middle East" so Google still
    // gets a legal value (an empty/unknown name throws structured-data
    // warnings).
    const areaName = COUNTRY_AREA_EN[visitorCountry] ?? "Middle East";
    return [
      {
        "@context": "https://schema.org",
        "@type":    "Organization",
        "name":     "زاكود المحاسبي",
        "alternateName": ["Zacoderp", "Zacode ERP", "زاكود", "نظام محاسبة سعودي معتمد من ZATCA"],
        "url":      origin,
        "logo":     `${origin}${BASE}/favicon.svg`,
        "image":    `${origin}${BASE}/opengraph.jpg`,
        "description": "زاكود المحاسبي — نظام محاسبة سعودي شامل ومعتمد من ZATCA: فوترة إلكترونية، محاسبة مالية، نقاط بيع، ومخزون.",
        "areaServed": { "@type": "Country", "name": areaName },
      },
      {
        "@context": "https://schema.org",
        "@type":    "WebSite",
        "url":      origin,
        "name":     "زاكود المحاسبي",
        "alternateName": "نظام محاسبة سعودي معتمد من ZATCA",
        "inLanguage": "ar-SA",
        // SearchAction intentionally omitted: there is no /search endpoint
        // on this site, so emitting a fake target would trigger Google
        // structured-data warnings and hurt rich-result eligibility.
      },
      {
        "@context": "https://schema.org",
        "@type":    "SoftwareApplication",
        "name":     "زاكود المحاسبي",
        "alternateName": "Zacoderp",
        "operatingSystem": "Web, Windows, macOS, Linux, iOS, Android",
        "applicationCategory": "BusinessApplication",
        "applicationSubCategory": "AccountingSoftware",
        "url":      origin,
        "image":    `${origin}${BASE}/opengraph.jpg`,
        "description": "نظام محاسبة وفوترة إلكترونية سعودي معتمد من ZATCA — يشمل المحاسبة المالية، نقاط البيع، المخزون، والموارد البشرية.",
        "inLanguage": "ar-SA",
        "offers": {
          "@type": "Offer",
          "price": "0",
          "priceCurrency": "SAR",
          "description": "تجربة مجانية بدون بطاقة دفع",
        },
      },
      {
        "@context": "https://schema.org",
        "@type":    "FAQPage",
        "mainEntity": faqs.map(f => ({
          "@type": "Question",
          "name":  f.q,
          "acceptedAnswer": { "@type": "Answer", "text": f.a },
        })),
      },
    ];
  }, [origin, visitorCountry]);

  useEffect(() => {
    const tag = "data-home-jsonld";
    document.head.querySelectorAll(`script[${tag}]`).forEach(el => el.remove());
    const created: HTMLScriptElement[] = [];
    for (const s of schemas) {
      const el = document.createElement("script");
      el.type = "application/ld+json";
      el.setAttribute(tag, "1");
      el.text = JSON.stringify(s);
      document.head.appendChild(el);
      created.push(el);
    }
    return () => { created.forEach(el => el.remove()); };
  }, [schemas]);

  // Helmet@3 + React 19 doesn't reliably populate document.title.
  useEffect(() => {
    const prev = document.title;
    document.title = "زاكود المحاسبي | نظام محاسبة سعودي معتمد ZATCA وفاتورة إلكترونية";
    return () => { document.title = prev; };
  }, []);

  const features = [
    { icon: FileText,    title: "فوترة إلكترونية معتمدة", desc: "فاتورة ضريبية متوافقة مع ZATCA المرحلة الثانية، توقيع رقمي UBL 2.1، QR Code، وتكامل مباشر مع بوابة فاتورة." },
    { icon: BarChart3,   title: "محاسبة مالية كاملة",     desc: "دفتر الأستاذ، ميزان المراجعة، قائمة الدخل، الميزانية العمومية، وتقارير ZATCA جاهزة لضريبة القيمة المضافة 15%." },
    { icon: Package,     title: "نقاط بيع ومخزون",        desc: "POS سريع وسهل، مخزون متعدد المستودعات، تتبّع التكاليف بطرق FIFO/المتوسط، وجرد دوري ومستمر." },
    { icon: Users,       title: "موارد بشرية ورواتب",     desc: "موظفون، حضور وانصراف، إجازات، ورواتب تتوافق مع نظام التأمينات الاجتماعية ومكتب العمل السعودي." },
    { icon: Brain,       title: "ذكاء اصطناعي مدمج",      desc: "تحليلات تلقائية، تنبيهات ذكية للأداء، تقارير SEO، وتنبؤات مبيعات تساعدك على اتخاذ قرارات أفضل." },
    { icon: Globe2,      title: "عربي وإنجليزي",          desc: "واجهة كاملة باللغة العربية ودعم RTL، مع إمكانية التبديل للإنجليزية للموظفين والشركاء الدوليين." },
  ];

  return (
    <div dir="rtl" className="min-h-screen bg-gradient-to-b from-primary/5 via-background to-muted">
      <Helmet>
        <html lang="ar" dir="rtl" />
        <title>زاكود المحاسبي | نظام محاسبة سعودي معتمد ZATCA وفاتورة إلكترونية</title>
        <meta name="description" content="زاكود المحاسبي — نظام محاسبة سعودي معتمد من ZATCA. فاتورة إلكترونية، محاسبة مالية، ضريبة القيمة المضافة 15%، نقاط بيع، ومخزون في منصة عربية واحدة. ابدأ مجاناً بدون بطاقة دفع." />
        <link rel="canonical" href={canonical} />
        <meta name="keywords" content="زاكود, زاكود المحاسبي, Zacoderp, Zacode ERP, نظام محاسبة سعودي, نظام محاسبي سعودي, فاتورة إلكترونية, ZATCA, زاتكا, FATOORA, محاسبة سعودية, نقاط بيع, مخزون, ضريبة القيمة المضافة, ERP سعودي" />
        <meta name="author" content="زاكود المحاسبي" />
        <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1" />
        <meta name="theme-color" content="#0d9488" />
        <meta name="application-name" content="زاكود المحاسبي" />
        <meta name="apple-mobile-web-app-title" content="زاكود" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="زاكود المحاسبي" />
        <meta property="og:title" content="زاكود المحاسبي | نظام محاسبة سعودي معتمد ZATCA" />
        <meta property="og:description" content="فاتورة إلكترونية، محاسبة مالية، نقاط بيع، ومخزون لشركتك السعودية في منصة واحدة معتمدة من ZATCA. ابدأ مجاناً." />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={`${origin}${BASE}/opengraph.jpg`} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="زاكود المحاسبي - نظام محاسبة سعودي معتمد من ZATCA" />
        <meta property="og:locale" content="ar_SA" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="زاكود المحاسبي | نظام محاسبة سعودي معتمد ZATCA" />
        <meta name="twitter:description" content="فاتورة إلكترونية ومحاسبة شاملة معتمدة من ZATCA لشركتك السعودية." />
        <meta name="twitter:image" content={`${origin}${BASE}/opengraph.jpg`} />
        <link rel="alternate" hrefLang="ar-SA" href={canonical} />
        <link rel="alternate" hrefLang="ar" href={canonical} />
        <link rel="alternate" hrefLang="x-default" href={canonical} />
      </Helmet>

      {/* Top bar */}
      <header className="border-b bg-white/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-bold min-w-0">
            <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold shadow">Z</div>
            <span className="hidden sm:inline truncate">زاكود المحاسبي</span>
          </div>
          <nav className="flex items-center gap-1 sm:gap-1.5 shrink-0">
            <CountrySelector variant="compact" testId="home-country-selector" className="hidden sm:flex" />
            <Button variant="ghost" size="sm" onClick={() => setLocation("/pricing")} className="hidden xs:inline-flex sm:inline-flex px-2 sm:px-3" data-testid="home-nav-pricing">
              الباقات
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setLocation("/login")} className="px-2 sm:px-3" data-testid="home-nav-login">
              دخول
            </Button>
            <Button size="sm" onClick={() => setLocation("/register")} className="gap-1 px-2 sm:px-3" data-testid="home-nav-register">
              ابدأ
            </Button>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-4 pt-12 pb-12 text-center">
        {/* Country-aware welcome strip — pulls the regulator/policy line
            and currency from countries.ts based on the auto-detected /
            user-selected country. The compact selector on mobile lives
            here (the desktop one is in the top bar). */}
        <div
          className="mb-5 inline-flex flex-wrap items-center justify-center gap-2 rounded-2xl border bg-white/70 px-4 py-2 text-xs text-foreground shadow-sm"
          data-testid="home-country-welcome"
        >
          <Globe2 className="h-3.5 w-3.5 text-primary" />
          <span className="font-semibold">مرحباً بزوار {countryInfo.nameAr}</span>
          <span className="text-muted-foreground">•</span>
          <span>{countryInfo.policyAr}</span>
          <span className="text-muted-foreground">•</span>
          <span>العملة: {countryInfo.currency.nameAr} ({countryInfo.currency.symbol})</span>
          <div className="block sm:hidden mt-1 w-full">
            <CountrySelector variant="compact" testId="home-country-selector-mobile" />
          </div>
        </div>

        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-bold mb-4">
          <ShieldCheck className="h-3.5 w-3.5" />
          معتمد ومتوافق مع ZATCA — المرحلة الثانية
        </span>
        <h1 className="text-4xl md:text-5xl font-extrabold leading-tight mb-5" data-testid="home-hero-title">
          نظام محاسبة سعودي شامل <br/>
          <span className="text-primary">للشركات والمؤسسات الحديثة</span>
        </h1>
        <p className="text-lg md:text-xl text-muted-foreground max-w-3xl mx-auto leading-relaxed mb-8">
          فاتورة إلكترونية معتمدة، محاسبة مالية كاملة، نقاط بيع، إدارة مخزون، وموارد بشرية —
          منصة عربية واحدة مصمّمة للسوق السعودي ومتكاملة مع بوابة فاتورة (FATOORA).
        </p>
        <div className="flex flex-wrap justify-center gap-3 mb-6">
          <Button size="lg" onClick={() => setLocation("/register")} className="gap-1.5 shadow-lg" data-testid="home-cta-register">
            <Sparkles className="h-4 w-4" /> ابدأ تجربتك المجانية
          </Button>
          <Button size="lg" variant="outline" onClick={() => setLocation("/pricing")} className="gap-1.5" data-testid="home-cta-pricing">
            عرض الباقات والأسعار <ArrowLeft className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-wrap justify-center items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5 text-primary" /> بدون بطاقة دفع</span>
          <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5 text-primary" /> تجربة فورية</span>
          <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5 text-primary" /> دعم عربي مباشر</span>
          <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5 text-primary" /> تكامل ZATCA UBL 2.1</span>
        </div>

        {/* ── Hero video ─────────────────────────────────────────────
            Click-to-play poster pattern (lightweight static markup
            until clicked, then mounts the iframe pointing at the
            standalone install-guide-video artifact). The video is a
            ≤90s ease-of-use + AI piece — the poster surfaces both of
            those promises with two badges and a clear Play target. */}
        <div className="mt-10 mx-auto max-w-3xl">
          <div
            className="relative aspect-video rounded-2xl overflow-hidden border shadow-xl bg-gradient-to-br from-slate-900 via-primary/30 to-slate-900"
            data-testid="home-video"
          >
            {videoStarted ? (
              <iframe
                src="/install-guide-video/"
                title="نظام محاسبة ذكي وسهل الاستخدام"
                className="absolute inset-0 w-full h-full"
                allow="autoplay; fullscreen"
                data-testid="home-video-iframe"
              />
            ) : (
              <button
                type="button"
                onClick={() => setVideoStarted(true)}
                className="absolute inset-0 w-full h-full flex flex-col items-center justify-center text-white group"
                data-testid="home-video-play"
                aria-label="شغّل الفيديو التعريفي"
              >
                <span className="absolute inset-0 bg-black/40 group-hover:bg-black/30 transition-colors" />
                <span className="relative inline-flex h-20 w-20 items-center justify-center rounded-full bg-primary shadow-2xl group-hover:scale-110 transition-transform">
                  <Play className="h-9 w-9 ms-1 fill-white text-white" />
                </span>
                <span className="relative mt-5 text-lg md:text-xl font-bold">
                  شاهد كيف يجمع نظامنا بين السهولة والذكاء الاصطناعي
                </span>
                <span className="relative mt-3 flex flex-wrap justify-center gap-2 text-xs">
                  <span className="rounded-full bg-white/15 backdrop-blur px-3 py-1 inline-flex items-center gap-1">
                    <Sparkles className="h-3 w-3" /> ذكاء اصطناعي مدمج
                  </span>
                  <span className="rounded-full bg-white/15 backdrop-blur px-3 py-1 inline-flex items-center gap-1">
                    <Zap className="h-3 w-3" /> أقل من ٩٠ ثانية
                  </span>
                </span>
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Why-us / Trust strip */}
      <section className="max-w-7xl mx-auto px-4 py-8">
        <div className="rounded-2xl border bg-white shadow-sm p-6 md:p-8 grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          {[
            { k: "ZATCA", v: "متوافق مع المرحلة الثانية" },
            { k: "UBL 2.1", v: "توقيع رقمي معتمد" },
            { k: "VAT 15%", v: "تقارير ضريبية جاهزة" },
            { k: "FATOORA", v: "تكامل مباشر مع بوابة فاتورة" },
          ].map((b, i) => (
            <div key={i} className="flex flex-col items-center gap-1">
              <div className="text-xl md:text-2xl font-extrabold text-primary">{b.k}</div>
              <div className="text-xs text-muted-foreground">{b.v}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-7xl mx-auto px-4 py-14">
        <h2 className="text-3xl font-bold text-center mb-3" data-testid="home-features-title">
          منصة محاسبة كاملة في مكان واحد
        </h2>
        <p className="text-center text-muted-foreground mb-10 max-w-2xl mx-auto">
          كل ما تحتاجه شركتك السعودية لإدارة الفوترة، المحاسبة، المبيعات، والمخزون — بدون تكامل معقد ولا تكاليف خفية.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map((f, i) => (
            <div
              key={i}
              className="rounded-2xl border bg-white p-6 shadow-sm hover:shadow-md transition-shadow"
              data-testid={`home-feature-${i}`}
            >
              <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary mb-4">
                <f.icon className="h-6 w-6" />
              </div>
              <h3 className="font-bold text-lg mb-2">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Featured articles (internal links — recommended by SEO AI) */}
      {featured.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 py-14">
          <div className="flex items-end justify-between mb-8 flex-wrap gap-3">
            <div>
              <h2 className="text-3xl font-bold mb-2">أحدث المقالات والأدلة</h2>
              <p className="text-muted-foreground text-sm">
                دروس عملية حول الفاتورة الإلكترونية، ZATCA، وضريبة القيمة المضافة في السعودية.
              </p>
            </div>
            <Button variant="ghost" onClick={() => setLocation("/pricing")} className="gap-1">
              تصفّح الباقات <ArrowLeft className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {featured.map(a => (
              <a
                key={a.id}
                href={`/blog/${encodeURIComponent(a.slug)}`}
                onClick={(e) => { e.preventDefault(); setLocation(`/blog/${a.slug}`); }}
                className="block rounded-2xl border bg-white p-5 shadow-sm hover:shadow-md hover:border-primary/40 transition-all"
                data-testid={`home-article-${a.id}`}
              >
                <div className="inline-flex items-center gap-1.5 text-xs text-primary font-bold mb-3">
                  <FileText className="h-3.5 w-3.5" /> مقالة
                </div>
                <h3 className="font-bold text-base mb-2 line-clamp-2 leading-snug">{a.title}</h3>
                <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">
                  {a.metaDescription}
                </p>
                <div className="mt-3 text-xs text-primary font-semibold inline-flex items-center gap-1">
                  اقرأ المقالة <ArrowLeft className="h-3 w-3" />
                </div>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* For-whom strip */}
      <section className="max-w-7xl mx-auto px-4 py-14">
        <h2 className="text-3xl font-bold text-center mb-10">مناسب لمختلف الأنشطة في السعودية</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { icon: Building2, label: "مؤسسات وشركات" },
            { icon: Package,   label: "متاجر التجزئة والجملة" },
            { icon: Zap,       label: "خدمات ومكاتب مهنية" },
            { icon: Users,     label: "مطاعم ومقاهي" },
          ].map((g, i) => (
            <div key={i} className="rounded-xl border bg-white p-5 text-center shadow-sm">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary mb-3">
                <g.icon className="h-6 w-6" />
              </div>
              <div className="font-semibold text-sm">{g.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Saudi-only contact card (auto-hides when visitor country !== SA) */}
      <SaudiContactCta />

      {/* CTA */}
      <section className="max-w-5xl mx-auto px-4 py-14">
        <div className={cn(
          "rounded-3xl p-10 text-center text-primary-foreground shadow-xl",
          "bg-gradient-to-l from-primary to-primary/80",
        )}>
          <h2 className="text-3xl md:text-4xl font-extrabold mb-3">جاهز تنقل محاسبتك إلى منصة سعودية حديثة؟</h2>
          <p className="text-base md:text-lg opacity-90 max-w-2xl mx-auto mb-7">
            ابدأ تجربتك المجانية خلال دقيقتين — بدون بطاقة دفع، وبدعم عربي مباشر يساعدك على الانطلاق.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button size="lg" variant="secondary" onClick={() => setLocation("/register")} className="gap-1.5" data-testid="home-final-cta-register">
              <Sparkles className="h-4 w-4" /> ابدأ مجاناً الآن
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => setLocation("/pricing")}
              className="gap-1.5 bg-white/10 border-white/40 text-white hover:bg-white/20 hover:text-white"
              data-testid="home-final-cta-pricing"
            >
              قارن الباقات <ArrowLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </section>

      <footer className="text-center text-xs text-muted-foreground pb-8 px-4">
        © 2026 زاكود المحاسبي — نظام محاسبة سعودي معتمد من ZATCA. جميع الحقوق محفوظة.
        <span className="mx-2">•</span>
        <a href="/login" onClick={(e) => { e.preventDefault(); setLocation("/login"); }} className="hover:underline">تسجيل الدخول</a>
        <span className="mx-2">•</span>
        <a href="/pricing" onClick={(e) => { e.preventDefault(); setLocation("/pricing"); }} className="hover:underline">الباقات</a>
        <span className="mx-2">•</span>
        <a href="/register" onClick={(e) => { e.preventDefault(); setLocation("/register"); }} className="hover:underline">إنشاء حساب</a>
      </footer>
    </div>
  );
}
