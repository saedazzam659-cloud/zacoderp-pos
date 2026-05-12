import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Helmet } from "react-helmet-async";
import {
  Check, Star, Crown, Package, Sparkles, ShieldCheck, ChevronLeft,
  Zap, BarChart3, Users, FileText, Brain, Globe2, ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import SaudiContactCta from "@/components/SaudiContactCta";

// ─────────────────────────────────────────────────────────────────────────
// Public /pricing page — the new top-of-funnel entry point.
//
// Why this page exists:
//   • Plans were previously buried inside step 2 of the multi-step
//     Register wizard, so search engines never indexed them and there
//     was no canonical URL to share.
//   • This page is unauthenticated, server-side meta-tag friendly via
//     react-helmet-async, and emits JSON-LD Product + Offer markup so
//     Google can render rich pricing snippets.
//   • Each plan card CTAs into /register?plan=KEY&cycle=monthly|annual
//     so the wizard skips straight past plan selection.
// ─────────────────────────────────────────────────────────────────────────

type ApiPlan = {
  key:                  string;
  nameAr:               string;
  nameEn:               string;
  monthlyPrice:         string;
  annualPrice:          string;
  maxUsers:             number;
  maxBranches?:         number;
  maxWarehouses?:       number;
  maxInvoices:          number;
  includedModulesCount: number;
  features:             string[] | string;
  isRecommended:        boolean;
  isActive:             boolean;
  sortOrder:            number;
  seoLandingSlug?:      string | null;
  seoArticleIds?:       number[];
};

type ApiArticle = {
  id:              number;
  title:           string;
  slug:            string;
  metaDescription: string;
  updatedAt:       string;
};

const STYLE_BY_KEY: Record<string, { icon: JSX.Element; ring: string; chip: string; accent: string }> = {
  starter:      { icon: <Package className="h-7 w-7" />,   ring: "ring-blue-200",   chip: "bg-blue-100 text-blue-700",   accent: "from-blue-50 to-white" },
  professional: { icon: <Star className="h-7 w-7" />,      ring: "ring-primary/30", chip: "bg-primary/10 text-primary",  accent: "from-primary/5 to-white" },
  enterprise:   { icon: <Crown className="h-7 w-7" />,     ring: "ring-amber-200",  chip: "bg-amber-100 text-amber-700", accent: "from-amber-50 to-white" },
  custom:       { icon: <Sparkles className="h-7 w-7" />,  ring: "ring-purple-200", chip: "bg-purple-100 text-purple-700", accent: "from-purple-50 to-white" },
};
const DEFAULT_STYLE = { icon: <Package className="h-7 w-7" />, ring: "ring-slate-200", chip: "bg-slate-100 text-slate-700", accent: "from-slate-50 to-white" };

// Helper — keep features always array.
function asFeatures(v: string[] | string | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
}

export default function Pricing() {
  const [, setLocation] = useLocation();
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("monthly");

  // Read the canonical origin once for the JSON-LD + canonical link tag.
  // Using window.location keeps it correct under both replit.app preview
  // and the production custom domain.
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const canonical = `${origin}/pricing`;

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const plansQ = useQuery<ApiPlan[]>({
    queryKey: ["public-pricing-plans"],
    staleTime: 30 * 1000,
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/admin/plans`);
      if (!r.ok) throw new Error("plans fetch failed");
      return r.json();
    },
  });
  const articlesQ = useQuery<ApiArticle[]>({
    queryKey: ["public-seo-articles"],
    staleTime: 60 * 1000,
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/seo/public/articles`);
      if (!r.ok) return [];
      return r.json();
    },
  });

  const plans = useMemo(
    () => (plansQ.data ?? []).filter(p => p.isActive),
    [plansQ.data],
  );
  const articlesById = useMemo(() => {
    const m = new Map<number, ApiArticle>();
    for (const a of articlesQ.data ?? []) m.set(a.id, a);
    return m;
  }, [articlesQ.data]);

  // Optional ?plan=KEY → highlight + auto-scroll to that card so a Google
  // result like "/pricing?plan=professional" lands the user precisely on
  // their plan instead of the top of the page.
  const highlightedKey = (() => {
    if (typeof window === "undefined") return null;
    const k = new URLSearchParams(window.location.search).get("plan");
    return k && k.length < 50 ? k : null;
  })();
  useEffect(() => {
    if (!highlightedKey || plans.length === 0) return;
    const el = document.getElementById(`plan-${highlightedKey}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightedKey, plans.length]);

  // Helmet's <title> child does not reliably populate document.title under
  // React 19, so set it explicitly. Restore the previous title on unmount.
  useEffect(() => {
    const prev = document.title;
    document.title = "باقات وأسعار زاكود المحاسبي | نظام محاسبة سعودي معتمد ZATCA";
    return () => { document.title = prev; };
  }, []);

  const goToRegister = (planKey: string) => {
    setLocation(`/register?plan=${encodeURIComponent(planKey)}&cycle=${billingCycle}`);
  };

  // JSON-LD — emit one `Product` per plan with a single `Offer`. Both the
  // monthly and annual price are exposed via `priceSpecification`, with
  // SAR as the currency and the plan name in Arabic.
  const productSchema = useMemo(() => {
    return plans.map(p => ({
      "@context":  "https://schema.org/",
      "@type":     "Product",
      "name":      p.nameAr,
      "alternateName": p.nameEn || undefined,
      "description": asFeatures(p.features).slice(0, 3).join("، "),
      "brand":     { "@type": "Brand", "name": "زاكود المحاسبي" },
      "url":       `${origin}/pricing?plan=${encodeURIComponent(p.key)}`,
      "offers": {
        "@type":         "Offer",
        "url":           `${origin}/register?plan=${encodeURIComponent(p.key)}&cycle=${billingCycle}`,
        "priceCurrency": "SAR",
        "price":         String(billingCycle === "annual" ? Number(p.annualPrice) : Number(p.monthlyPrice)),
        "availability":  "https://schema.org/InStock",
        "priceSpecification": [
          { "@type": "UnitPriceSpecification", "price": String(Number(p.monthlyPrice)), "priceCurrency": "SAR", "billingDuration": "P1M", "name": "شهري" },
          { "@type": "UnitPriceSpecification", "price": String(Number(p.annualPrice)),  "priceCurrency": "SAR", "billingDuration": "P1Y", "name": "سنوي" },
        ],
      },
    }));
  }, [plans, billingCycle, origin]);

  // Aggregate FAQ schema — also good for Google's rich-result panel.
  const faqs: Array<{ q: string; a: string }> = [
    { q: "هل النظام معتمد من هيئة الزكاة والضريبة والجمارك (ZATCA)؟",
      a: "نعم، النظام يلتزم بمعايير الفوترة الإلكترونية السعودية في مرحلتيها الأولى والثانية، مع توقيع رقمي UBL 2.1، QR Code، وتكامل مع بوابة فاتورة." },
    { q: "هل أستطيع تجربة النظام قبل الاشتراك؟",
      a: "نعم، يمكنك إنشاء حساب جديد والبدء فوراً بفترة تجريبية على الباقة المختارة، مع إمكانية الترقية في أي وقت من إعدادات الاشتراك." },
    { q: "هل تدعم الباقات المستخدمين والفروع المتعددة؟",
      a: "نعم، تختلف حدود المستخدمين والفروع والمستودعات حسب الباقة. يمكنك مراجعة جدول المقارنة أعلاه أو التواصل معنا للحصول على باقة مخصصة لمؤسستك." },
    { q: "ما الفرق بين الاشتراك الشهري والسنوي؟",
      a: "الاشتراك السنوي يمنحك خصماً مكافئاً لشهرين تقريباً مقارنة بالشهري، إضافة إلى ثبات السعر طوال السنة. يمكنك التبديل بين الدورتين من زر التبديل أعلى الصفحة." },
    { q: "كيف يتم احتساب الوحدات الإضافية (المخزون، نقاط البيع، الموارد البشرية…)؟",
      a: "كل باقة تشمل عدداً من الوحدات مجاناً (الأرخص أولاً)، وأي وحدة إضافية تُضاف بسعرها الشهري الخاص. ترى الإجمالي مباشرة عند اختيار الوحدات في صفحة التسجيل." },
  ];
  const faqSchema = {
    "@context": "https://schema.org",
    "@type":    "FAQPage",
    "mainEntity": faqs.map(f => ({
      "@type":          "Question",
      "name":           f.q,
      "acceptedAnswer": { "@type": "Answer", "text": f.a },
    })),
  };
  // Breadcrumb so the search result reads "zacoderp.com › الباقات"
  // instead of the raw URL — improves CTR.
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type":    "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "الرئيسية", "item": `${origin}/` },
      { "@type": "ListItem", "position": 2, "name": "الباقات",   "item": canonical },
    ],
  };

  return (
    <div dir="rtl" className="min-h-screen bg-gradient-to-b from-primary/5 via-background to-muted">
      <Helmet>
        <html lang="ar" dir="rtl" />
        <title>باقات وأسعار زاكود المحاسبي | نظام محاسبة سعودي معتمد ZATCA</title>
        <meta name="description" content="باقات زاكود المحاسبي — نظام محاسبة سعودي معتمد من ZATCA: مبتدئ، احترافي، ومؤسسي. أسعار شفافة بالشهر والسنة، فترة تجريبية فورية بدون بطاقة دفع، توقيع رقمي UBL 2.1، نقاط بيع، مخزون، ومحاسبة." />
        <link rel="canonical" href={canonical} />
        <meta name="keywords" content="باقات زاكود, أسعار زاكود المحاسبي, Zacoderp pricing, باقات نظام محاسبة سعودي, أسعار ZATCA, اشتراك فاتورة إلكترونية, خصم سنوي" />
        <meta name="author" content="زاكود المحاسبي" />
        <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1" />
        <meta name="theme-color" content="#0d9488" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="زاكود المحاسبي" />
        <meta property="og:title" content="باقات وأسعار زاكود المحاسبي | معتمد ZATCA" />
        <meta property="og:description" content="قارن باقات زاكود المحاسبي واختر ما يناسب نشاطك — شهري أو سنوي، بأسعار شفافة بالريال السعودي." />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={`${origin}${BASE}/opengraph.jpg`} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="باقات وأسعار زاكود المحاسبي" />
        <meta property="og:locale" content="ar_SA" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="باقات وأسعار زاكود المحاسبي | معتمد ZATCA" />
        <meta name="twitter:description" content="باقات نظام محاسبة سعودي معتمد من ZATCA — أسعار شفافة وتجربة مجانية." />
        <meta name="twitter:image" content={`${origin}${BASE}/opengraph.jpg`} />
        <link rel="alternate" hrefLang="ar-SA" href={canonical} />
        <link rel="alternate" hrefLang="ar" href={canonical} />
        <link rel="alternate" hrefLang="x-default" href={canonical} />
      </Helmet>
      <PricingJsonLd schemas={[...productSchema, faqSchema, breadcrumbSchema]} />

      {/* Top nav strip */}
      <header className="border-b bg-white/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-3 flex items-center justify-between gap-2">
          <button
            onClick={() => setLocation("/login")}
            className="flex items-center gap-2 text-sm font-bold text-foreground hover:opacity-80 min-w-0"
            data-testid="pricing-home-link"
          >
            <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold shadow">Z</div>
            <span className="hidden sm:inline truncate">زاكود المحاسبي</span>
          </button>
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            <Button variant="ghost" size="sm" onClick={() => setLocation("/login")} className="px-2 sm:px-3">
              دخول
            </Button>
            <Button size="sm" onClick={() => setLocation("/register")} className="gap-1 px-2 sm:px-3">
              ابدأ <ArrowLeft className="h-4 w-4 hidden sm:inline-block" />
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-4 pt-12 pb-8 text-center">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
          <ShieldCheck className="h-3.5 w-3.5" /> معتمد ومتوافق مع ZATCA — المرحلة الثانية
        </div>
        <h1 className="text-3xl sm:text-5xl font-extrabold leading-tight text-foreground">
          باقات زاكود المحاسبي — نظام محاسبة سعودي معتمد ZATCA
        </h1>
        <p className="mt-4 text-base sm:text-lg text-muted-foreground max-w-2xl mx-auto">
          اختر الباقة المناسبة لحجم نشاطك — تبدأ بفترة تجريبية فورية بدون بطاقة دفع.
          جميع الباقات تشمل التوقيع الرقمي، QR Code، وتكامل مع بوابة فاتورة.
        </p>

        {/* Billing toggle */}
        <div className="mt-7 inline-flex items-center bg-muted rounded-full p-1 gap-1">
          <button
            onClick={() => setBillingCycle("monthly")}
            data-testid="pricing-cycle-monthly"
            className={cn(
              "px-4 py-1.5 rounded-full text-sm font-medium transition-all",
              billingCycle === "monthly" ? "bg-white text-foreground shadow" : "text-muted-foreground hover:text-foreground",
            )}>
            شهري
          </button>
          <button
            onClick={() => setBillingCycle("annual")}
            data-testid="pricing-cycle-annual"
            className={cn(
              "px-4 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-1",
              billingCycle === "annual" ? "bg-white text-foreground shadow" : "text-muted-foreground hover:text-foreground",
            )}>
            سنوي
            <span className="text-[10px] bg-emerald-100 text-emerald-700 rounded-full px-1.5 py-0.5">وفّر شهرين</span>
          </button>
        </div>
      </section>

      {/* Plan cards */}
      <section className="max-w-7xl mx-auto px-4 pb-16">
        {plansQ.isLoading && (
          <div className="text-center text-muted-foreground py-16">جاري تحميل الباقات…</div>
        )}
        {plansQ.isError && (
          <div className="text-center text-destructive py-16">تعذّر تحميل الباقات. حدّث الصفحة لاحقاً.</div>
        )}
        {!plansQ.isLoading && plans.length === 0 && !plansQ.isError && (
          <div className="text-center text-muted-foreground py-16">
            لا توجد باقات نشطة حالياً. تواصل معنا لإعداد باقة مخصصة.
          </div>
        )}

        <div className={cn(
          "grid gap-6",
          plans.length === 1 && "max-w-md mx-auto",
          plans.length === 2 && "sm:grid-cols-2 max-w-3xl mx-auto",
          plans.length >= 3  && "sm:grid-cols-2 lg:grid-cols-3",
          plans.length >= 4  && "lg:grid-cols-4",
        )}>
          {plans.map(p => {
            const style = STYLE_BY_KEY[p.key] ?? DEFAULT_STYLE;
            const features = asFeatures(p.features);
            const monthly  = Number(p.monthlyPrice) || 0;
            const annual   = Number(p.annualPrice)  || 0;
            const display  = billingCycle === "annual" ? annual : monthly;
            const cycleLbl = billingCycle === "annual" ? "ر.س / سنوياً" : "ر.س / شهرياً";
            const isRec    = p.isRecommended;
            const isHighlighted = highlightedKey === p.key;
            const linkedArticles = (p.seoArticleIds ?? [])
              .map(id => articlesById.get(id))
              .filter((a): a is ApiArticle => !!a)
              .slice(0, 3);

            return (
              <Card
                key={p.key}
                id={`plan-${p.key}`}
                data-testid={`pricing-card-${p.key}`}
                className={cn(
                  "relative overflow-hidden transition-all flex flex-col",
                  "bg-gradient-to-b", style.accent,
                  isRec && "ring-2 ring-primary scale-[1.02] shadow-2xl",
                  !isRec && isHighlighted && "ring-2", style.ring,
                )}>
                {isRec && (
                  <div className="absolute top-0 inset-x-0 bg-primary text-primary-foreground text-center text-[11px] font-bold py-1 tracking-wide">
                    الأكثر اختياراً
                  </div>
                )}
                <CardContent className={cn("p-6 flex flex-col flex-1", isRec && "pt-9")}>
                  <div className={cn("inline-flex h-12 w-12 items-center justify-center rounded-xl mb-3", style.chip)}>
                    {style.icon}
                  </div>
                  <h3 className="text-xl font-bold">{p.nameAr}</h3>
                  {p.nameEn && <p className="text-xs text-muted-foreground mt-0.5">{p.nameEn}</p>}

                  <div className="mt-5">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-4xl font-extrabold tabular-nums">{display.toLocaleString("ar-SA")}</span>
                      <span className="text-sm text-muted-foreground">{cycleLbl}</span>
                    </div>
                    {billingCycle === "annual" && monthly > 0 && annual < monthly * 12 && (
                      <p className="text-xs text-emerald-700 mt-1">
                        وفّر {(monthly * 12 - annual).toLocaleString("ar-SA")} ر.س في السنة
                      </p>
                    )}
                  </div>

                  <ul className="mt-5 space-y-2 text-sm flex-1">
                    <li className="flex items-start gap-2"><Users className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                      <span>{p.maxUsers >= 999 ? "مستخدمون غير محدودين" : `${p.maxUsers} مستخدم${p.maxUsers > 1 ? "/مستخدمون" : ""}`}</span>
                    </li>
                    <li className="flex items-start gap-2"><FileText className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                      <span>{p.maxInvoices >= 999999 ? "فواتير غير محدودة" : `${p.maxInvoices.toLocaleString("ar-SA")} فاتورة شهرياً`}</span>
                    </li>
                    {p.includedModulesCount > 0 && (
                      <li className="flex items-start gap-2"><Package className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                        <span>{p.includedModulesCount} وحدة مشمولة مجاناً</span>
                      </li>
                    )}
                    {features.map((f, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <Check className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>

                  <Button
                    onClick={() => goToRegister(p.key)}
                    data-testid={`pricing-cta-${p.key}`}
                    className={cn("mt-6 w-full gap-1", isRec ? "" : "bg-primary/90 hover:bg-primary")}
                    size="lg">
                    اختر باقة {p.nameAr}
                    <ChevronLeft className="h-4 w-4" />
                  </Button>

                  {/* Linked SEO content — gives the user (and Google) a deeper
                      contextual jump from each plan into the relevant guide. */}
                  {(linkedArticles.length > 0 || p.seoLandingSlug) && (
                    <div className="mt-5 pt-4 border-t border-border/60">
                      <div className="text-xs font-semibold text-muted-foreground mb-2">اقرأ المزيد</div>
                      <ul className="space-y-1.5">
                        {p.seoLandingSlug && (
                          <li>
                            <a href={`/blog/${encodeURIComponent(p.seoLandingSlug)}`}
                               className="text-xs text-primary hover:underline line-clamp-1">
                              دليل باقة {p.nameAr}
                            </a>
                          </li>
                        )}
                        {linkedArticles.map(a => (
                          <li key={a.id}>
                            <a href={`/blog/${encodeURIComponent(a.slug)}`}
                               className="text-xs text-primary hover:underline line-clamp-1">
                              {a.title}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Comparison strip */}
      {plans.length >= 2 && (
        <section className="max-w-7xl mx-auto px-4 pb-16">
          <h2 className="text-2xl font-bold text-center mb-2">قارن بين الباقات</h2>
          <p className="text-center text-muted-foreground mb-6 text-sm">
            كل الباقات تشمل التوقيع الرقمي، QR، وتكامل ZATCA — الفروقات بالأرقام أدناه.
          </p>
          <div className="overflow-x-auto rounded-xl border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-right p-3 font-semibold">الميزة</th>
                  {plans.map(p => (
                    <th key={p.key} className="text-center p-3 font-semibold">
                      {p.nameAr}
                      {p.isRecommended && (
                        <span className="block text-[10px] font-normal text-primary mt-0.5">الأكثر اختياراً</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                <tr>
                  <td className="p-3 text-muted-foreground">السعر الشهري</td>
                  {plans.map(p => (
                    <td key={p.key} className="p-3 text-center font-semibold tabular-nums">
                      {Number(p.monthlyPrice).toLocaleString("ar-SA")} ر.س
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="p-3 text-muted-foreground">السعر السنوي</td>
                  {plans.map(p => (
                    <td key={p.key} className="p-3 text-center font-semibold tabular-nums">
                      {Number(p.annualPrice).toLocaleString("ar-SA")} ر.س
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="p-3 text-muted-foreground">عدد المستخدمين</td>
                  {plans.map(p => (
                    <td key={p.key} className="p-3 text-center">
                      {p.maxUsers >= 999 ? "غير محدود" : p.maxUsers}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="p-3 text-muted-foreground">الفواتير الشهرية</td>
                  {plans.map(p => (
                    <td key={p.key} className="p-3 text-center">
                      {p.maxInvoices >= 999999 ? "غير محدود" : p.maxInvoices.toLocaleString("ar-SA")}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="p-3 text-muted-foreground">الوحدات المشمولة مجاناً</td>
                  {plans.map(p => (
                    <td key={p.key} className="p-3 text-center">
                      {p.includedModulesCount > 0 ? p.includedModulesCount : "—"}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Trust bar */}
      <section className="bg-white border-y">
        <div className="max-w-6xl mx-auto px-4 py-8 grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
          <div className="flex flex-col items-center gap-1.5">
            <ShieldCheck className="h-7 w-7 text-emerald-600" />
            <div className="text-sm font-semibold">معتمد ZATCA</div>
            <div className="text-xs text-muted-foreground">التزام كامل بالمرحلتين 1 و 2</div>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <Zap className="h-7 w-7 text-amber-500" />
            <div className="text-sm font-semibold">إصدار فوري</div>
            <div className="text-xs text-muted-foreground">QR + توقيع UBL 2.1 خلال ثوانٍ</div>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <BarChart3 className="h-7 w-7 text-primary" />
            <div className="text-sm font-semibold">تقارير ذكية</div>
            <div className="text-xs text-muted-foreground">تحليلات مبيعات، مشتريات، نقدية</div>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <Brain className="h-7 w-7 text-purple-600" />
            <div className="text-sm font-semibold">مدعوم بالذكاء الاصطناعي</div>
            <div className="text-xs text-muted-foreground">مساعد محاسبي + تقارير تلقائية</div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="max-w-3xl mx-auto px-4 py-14">
        <h2 className="text-2xl font-bold text-center mb-6">الأسئلة الشائعة</h2>
        <div className="space-y-3">
          {faqs.map((f, i) => (
            <details key={i} className="rounded-xl border bg-white p-4 group">
              <summary className="cursor-pointer font-semibold text-foreground flex items-start justify-between gap-3 list-none">
                <span>{f.q}</span>
                <ChevronLeft className="h-4 w-4 text-muted-foreground transition-transform group-open:-rotate-90 mt-1 shrink-0" />
              </summary>
              <p className="mt-3 text-sm text-muted-foreground leading-relaxed">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="max-w-4xl mx-auto px-4 pb-16">
        <div className="rounded-2xl bg-gradient-to-l from-primary to-primary/80 text-primary-foreground p-8 sm:p-10 text-center shadow-xl">
          <h3 className="text-2xl sm:text-3xl font-bold">جاهز تبدأ؟</h3>
          <p className="mt-2 opacity-90">سجّل شركتك خلال دقيقتين وابدأ إصدار فواتير ZATCA فوراً.</p>
          <Button
            onClick={() => setLocation("/register")}
            size="lg"
            variant="secondary"
            className="mt-5 gap-1"
            data-testid="pricing-final-cta">
            ابدأ التسجيل المجاني <ArrowLeft className="h-4 w-4" />
          </Button>
        </div>
      </section>

      <SaudiContactCta />

      <footer className="text-center text-xs text-muted-foreground pb-8">
        © 2026 زاكود المحاسبي — نظام محاسبة سعودي معتمد من ZATCA. جميع الحقوق محفوظة.
        <span className="mx-2">•</span>
        <a href="/login" className="hover:underline">تسجيل الدخول</a>
        <span className="mx-2">•</span>
        <a href="/register" className="hover:underline">إنشاء حساب</a>
      </footer>
    </div>
  );
}

// React 19 + react-helmet-async@3 doesn't auto-hoist inline <script>
// children to <head>, so we mount the JSON-LD blocks ourselves.
// Each schema gets its own <script type="application/ld+json"> tag,
// tagged with data-pricing-jsonld so we can clean them up on unmount
// or whenever the underlying schema list changes.
function PricingJsonLd({ schemas }: { schemas: any[] }) {
  useEffect(() => {
    const tag = "data-pricing-jsonld";
    document.head.querySelectorAll(`script[${tag}]`).forEach(el => el.remove());
    const created: HTMLScriptElement[] = [];
    for (const schema of schemas) {
      if (!schema) continue;
      const el = document.createElement("script");
      el.type = "application/ld+json";
      el.setAttribute(tag, "1");
      el.text = JSON.stringify(schema);
      document.head.appendChild(el);
      created.push(el);
    }
    return () => { created.forEach(el => el.remove()); };
  }, [schemas]);
  return null;
}
