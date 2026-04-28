import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Helmet } from "react-helmet-async";
import {
  ShieldCheck, Sparkles, ArrowLeft, Check, Play, ChevronDown,
  Smartphone, Wifi, Receipt, BarChart3, Package, CreditCard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────
// Public /pos-system landing page — addresses the SEO AI medium-impact
// recommendation: this page should rank for "نظام نقاط بيع سعودي" and lift
// dwell time. Layout adds:
//   • An embedded explainer video (the install-guide-video artifact).
//   • A FAQ section (with FAQPage JSON-LD) targeting common Saudi POS
//     questions, lifting dwell time and rich-result coverage.
// Path note: the bare `/pos` is owned by the standalone POS artifact in
// this monorepo, so this public landing lives at `/pos-system` instead.
// ─────────────────────────────────────────────────────────────────────────

export default function PosLanding() {
  const [, setLocation] = useLocation();
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const canonical = `${origin}/pos-system`;
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [videoStarted, setVideoStarted] = useState(false);

  const faqs = useMemo(() => [
    {
      q: "هل نظام نقاط البيع متوافق مع ZATCA المرحلة الثانية؟",
      a: "نعم، النظام يصدر فواتير مبسطة (B2C) موقَّعة رقمياً بصيغة UBL 2.1، مع QR Code موسّع يحوي تجزئة الفاتورة والتوقيع، ويُبلغ ZATCA تلقائياً خلال 24 ساعة عبر بوابة فاتورة (FATOORA).",
    },
    {
      q: "هل يعمل النظام دون إنترنت (Offline)؟",
      a: "نعم، الكاشير يستمر في إصدار الفواتير حتى عند انقطاع الاتصال. تُحفظ الفواتير محلياً وتُرفع تلقائياً لـ ZATCA فور عودة الاتصال — بدون فقدان أي عملية بيع.",
    },
    {
      q: "ما الأجهزة المدعومة (طابعات، قارئ باركود، درج نقد)؟",
      a: "النظام يعمل على أي حاسب أو تابلت بمتصفح حديث. يدعم طابعات الفواتير الحرارية الشائعة (80mm)، قارئات الباركود USB أو Bluetooth، أدراج النقد المتصلة بالطابعة، وموازين الإلكترونية لمتاجر التجزئة.",
    },
    {
      q: "كم سعر نظام نقاط البيع؟ وهل توجد رسوم لكل فاتورة؟",
      a: "النظام يبدأ بسعر شهري ثابت من الباقة المبتدئة، بدون أي رسوم على عدد الفواتير أو حجم المبيعات. اطّلع على صفحة الباقات للتفاصيل الكاملة.",
    },
    {
      q: "هل يدمج نقاط البيع مع المخزون والمحاسبة تلقائياً؟",
      a: "نعم، كل عملية بيع تُخصم من المخزون مباشرة وتُسجَّل في قيود اليومية المحاسبية وتقارير ضريبة القيمة المضافة 15% بدون أي خطوة يدوية إضافية.",
    },
    {
      q: "كم يستغرق إعداد نقطة بيع جديدة؟",
      a: "أقل من 15 دقيقة: أنشئ حساباً، أضف فروعك ومنتجاتك، اربط طابعتك، وابدأ البيع. الفيديو التعليمي في الأعلى يشرح الخطوات كاملة.",
    },
    {
      q: "هل يدعم النظام عدة فروع وعدة كاشيرات في نفس الوقت؟",
      a: "نعم، يمكنك إدارة عدد غير محدود من الفروع والكاشيرات من لوحة تحكم واحدة، مع تقارير منفصلة لكل فرع وصلاحيات مخصصة لكل موظف.",
    },
    {
      q: "هل أحتاج معرفة محاسبية لاستخدام النظام؟",
      a: "لا. النظام مصمم بحيث يستخدمه أي كاشير في دقائق، بينما تُدار التعقيدات المحاسبية وضريبة القيمة المضافة تلقائياً في الخلفية.",
    },
  ], []);

  // JSON-LD: Product/SoftwareApplication + FAQPage. The FAQPage tag is
  // the explicit deliverable from the SEO AI recommendation — it makes
  // the FAQ eligible for Google "People also ask" rich results.
  const schemas = useMemo(() => [
    {
      "@context": "https://schema.org",
      "@type":    "SoftwareApplication",
      "name":     "نظام نقاط البيع السعودي (POS)",
      "applicationCategory": "BusinessApplication",
      "operatingSystem":     "Web, Windows, Android, iOS",
      "url":      canonical,
      "description": "نظام نقاط بيع سعودي معتمد من ZATCA يدعم العمل دون إنترنت، الطابعات الحرارية، تكامل المخزون والمحاسبة، ومتعدد الفروع.",
      "offers":   { "@type": "Offer", "priceCurrency": "SAR", "availability": "https://schema.org/InStock" },
      "inLanguage": "ar-SA",
    },
    {
      "@context": "https://schema.org",
      "@type":    "FAQPage",
      "mainEntity": faqs.map(f => ({
        "@type": "Question", "name": f.q,
        "acceptedAnswer": { "@type": "Answer", "text": f.a },
      })),
    },
  ], [canonical, faqs]);

  useEffect(() => {
    const tag = "data-pos-jsonld";
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

  useEffect(() => {
    const prev = document.title;
    document.title = "نظام نقاط بيع سعودي معتمد من ZATCA — POS مع فيديو تعريفي";
    return () => { document.title = prev; };
  }, []);

  const features = [
    { icon: Smartphone, title: "يعمل على أي جهاز",      desc: "تابلت، حاسب، أو هاتف — أي متصفح حديث يكفي." },
    { icon: Wifi,       title: "دون إنترنت (Offline)",   desc: "استمر بالبيع حتى أثناء انقطاع الاتصال." },
    { icon: Receipt,    title: "فاتورة معتمدة من ZATCA", desc: "QR Code موسّع وتوقيع رقمي UBL 2.1." },
    { icon: Package,    title: "مخزون متكامل",          desc: "خصم تلقائي بكل عملية بيع، تنبيهات نفاد." },
    { icon: BarChart3,  title: "تقارير لحظية",          desc: "مبيعات الفرع، أداء الكاشير، وتقارير ZATCA." },
    { icon: CreditCard, title: "كل وسائل الدفع",        desc: "نقد، شبكة، تحويل، Apple Pay، STC Pay." },
  ];

  return (
    <div dir="rtl" className="min-h-screen bg-gradient-to-b from-primary/5 via-background to-muted">
      <Helmet>
        <html lang="ar" dir="rtl" />
        <title>نظام نقاط بيع سعودي معتمد من ZATCA — POS مع فيديو تعريفي</title>
        <meta name="description" content="نظام نقاط بيع (POS) سعودي معتمد من ZATCA: يعمل دون إنترنت، يصدر فواتير مبسطة موقّعة رقمياً، يتكامل مع المخزون والمحاسبة، ويدعم عدة فروع. شاهد الفيديو التعريفي وابدأ تجربتك المجانية." />
        <link rel="canonical" href={canonical} />
        <meta name="keywords" content="نقاط بيع, نظام نقاط بيع سعودي, POS سعودي, ZATCA POS, كاشير, فاتورة مبسطة" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="نظام نقاط بيع سعودي معتمد من ZATCA" />
        <meta property="og:description" content="POS سعودي يعمل دون إنترنت ومتكامل مع المخزون والمحاسبة." />
        <meta property="og:url" content={canonical} />
        <meta property="og:locale" content="ar_SA" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="robots" content="index,follow,max-image-preview:large" />
      </Helmet>

      <PublicHeader setLocation={setLocation} />

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-4 pt-14 pb-10 text-center">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-bold mb-4">
          <ShieldCheck className="h-3.5 w-3.5" />
          POS معتمد ومتوافق مع ZATCA
        </span>
        <h1 className="text-4xl md:text-5xl font-extrabold leading-tight mb-5" data-testid="pos-hero-title">
          نظام نقاط بيع سعودي <br/>
          <span className="text-primary">يعمل دون إنترنت ومعتمد من ZATCA</span>
        </h1>
        <p className="text-lg md:text-xl text-muted-foreground max-w-3xl mx-auto leading-relaxed mb-7">
          كاشير سريع وبسيط يصدر فواتير مبسطة موقَّعة رقمياً، متكامل مع المخزون والمحاسبة،
          ويدعم عدة فروع وأجهزة طابعات الباركود والدرج تلقائياً.
        </p>
        <div className="flex flex-wrap justify-center gap-3 mb-3">
          <Button size="lg" onClick={() => setLocation("/register")} className="gap-1.5 shadow-lg" data-testid="pos-cta-register">
            <Sparkles className="h-4 w-4" /> ابدأ تجربتك المجانية
          </Button>
          <Button size="lg" variant="outline" onClick={() => setLocation("/pricing")} className="gap-1.5" data-testid="pos-cta-pricing">
            عرض الباقات والأسعار <ArrowLeft className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-wrap justify-center items-center gap-x-6 gap-y-2 text-xs text-muted-foreground mt-3">
          <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5 text-primary" /> بدون بطاقة دفع</span>
          <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5 text-primary" /> دعم عربي</span>
          <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5 text-primary" /> Offline mode</span>
          <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5 text-primary" /> فيديو تعليمي 3 دقائق</span>
        </div>
      </section>

      {/* Video — embedded explainer */}
      <section className="max-w-5xl mx-auto px-4 py-8">
        <div className="rounded-3xl overflow-hidden border-2 border-primary/20 shadow-2xl bg-black aspect-video relative" data-testid="pos-video-frame">
          {!videoStarted ? (
            <button
              type="button"
              onClick={() => setVideoStarted(true)}
              className="absolute inset-0 w-full h-full flex flex-col items-center justify-center gap-4 bg-gradient-to-br from-primary/90 to-primary/70 text-primary-foreground hover:from-primary hover:to-primary/80 transition-all"
              data-testid="pos-video-play"
              aria-label="تشغيل الفيديو التعريفي"
            >
              <span className="inline-flex h-20 w-20 items-center justify-center rounded-full bg-white text-primary shadow-2xl">
                <Play className="h-9 w-9 mr-1" fill="currentColor" />
              </span>
              <div className="text-center px-6">
                <div className="text-xl md:text-2xl font-bold mb-1">شاهد كيف يعمل النظام في 3 دقائق</div>
                <div className="text-sm opacity-90">دليل تركيب وتشغيل نقاط البيع — من الصفر إلى أول فاتورة</div>
              </div>
            </button>
          ) : (
            <iframe
              src="/install-guide-video/"
              title="دليل تركيب نظام نقاط البيع السعودي"
              className="w-full h-full border-0"
              allow="autoplay; fullscreen"
              data-testid="pos-video-iframe"
            />
          )}
        </div>
        <p className="text-xs text-center text-muted-foreground mt-3">
          الفيديو التعليمي يستعرض شاشات النظام وسير العمل الفعلي للكاشير، التركيب على جهازك، وإصدار أول فاتورة معتمدة.
        </p>
      </section>

      {/* Features grid */}
      <section className="max-w-7xl mx-auto px-4 py-14">
        <h2 className="text-3xl font-bold text-center mb-3">لماذا يختار التجار السعوديون نقاط بيعنا؟</h2>
        <p className="text-center text-muted-foreground mb-10 max-w-2xl mx-auto">
          ميزات مصممة خصيصاً للسوق السعودي، مع أداء سريع يثق به أكثر الكاشيرات ازدحاماً.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map((f, i) => (
            <div key={i} className="rounded-2xl border bg-white p-6 shadow-sm hover:shadow-md transition-shadow" data-testid={`pos-feature-${i}`}>
              <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary mb-4">
                <f.icon className="h-6 w-6" />
              </div>
              <h3 className="font-bold text-lg mb-2">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ — the explicit SEO AI recommendation deliverable */}
      <section className="max-w-3xl mx-auto px-4 py-14" data-testid="pos-faq-section">
        <h2 className="text-3xl font-bold text-center mb-3">أسئلة شائعة عن نظام نقاط البيع</h2>
        <p className="text-center text-muted-foreground mb-10">
          إجابات على أكثر ما يسأل عنه التجار قبل اختيار نظام POS سعودي.
        </p>
        <div className="space-y-3">
          {faqs.map((f, i) => {
            const isOpen = openFaq === i;
            return (
              <div
                key={i}
                className={cn(
                  "rounded-xl border bg-white shadow-sm transition-all overflow-hidden",
                  isOpen && "border-primary/40 shadow-md",
                )}
                data-testid={`pos-faq-${i}`}
              >
                <button
                  type="button"
                  onClick={() => setOpenFaq(isOpen ? null : i)}
                  className="w-full flex items-center justify-between gap-3 p-4 text-right hover:bg-muted/40"
                  data-testid={`pos-faq-toggle-${i}`}
                  aria-expanded={isOpen}
                >
                  <span className="font-semibold text-base flex-1">{f.q}</span>
                  <ChevronDown className={cn("h-5 w-5 text-muted-foreground transition-transform shrink-0", isOpen && "rotate-180 text-primary")} />
                </button>
                {isOpen && (
                  <div className="px-4 pb-4 text-sm text-muted-foreground leading-relaxed border-t pt-3">
                    {f.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-5xl mx-auto px-4 py-14">
        <div className="rounded-3xl p-10 text-center text-primary-foreground shadow-xl bg-gradient-to-l from-primary to-primary/80">
          <h2 className="text-3xl md:text-4xl font-extrabold mb-3">جاهز تنطلق بأول كاشير معتمد من ZATCA؟</h2>
          <p className="text-base md:text-lg opacity-90 max-w-2xl mx-auto mb-7">
            ابدأ تجربتك المجانية خلال دقيقتين — بدون بطاقة دفع وبدعم عربي مباشر.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button size="lg" variant="secondary" onClick={() => setLocation("/register")} className="gap-1.5" data-testid="pos-final-cta-register">
              <Sparkles className="h-4 w-4" /> ابدأ مجاناً الآن
            </Button>
            <Button size="lg" variant="outline" onClick={() => setLocation("/pricing")}
              className="gap-1.5 bg-white/10 border-white/40 text-white hover:bg-white/20 hover:text-white"
              data-testid="pos-final-cta-pricing">
              قارن الباقات <ArrowLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </section>

      <footer className="text-center text-xs text-muted-foreground pb-8 px-4">
        © 2026 نظام نقاط بيع سعودي معتمد من ZATCA — جميع الحقوق محفوظة.
      </footer>
    </div>
  );
}

function PublicHeader({ setLocation }: { setLocation: (p: string) => void }) {
  return (
    <header className="border-b bg-white/80 backdrop-blur sticky top-0 z-20">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => setLocation("/")}
          className="flex items-center gap-2 text-sm font-bold text-foreground hover:opacity-80"
          data-testid="pos-home-link"
        >
          <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold shadow">Z</div>
          نظام محاسبة سعودي معتمد من ZATCA
        </button>
        <nav className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setLocation("/pricing")} data-testid="pos-nav-pricing">
            الباقات
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setLocation("/login")} data-testid="pos-nav-login">
            تسجيل الدخول
          </Button>
          <Button size="sm" onClick={() => setLocation("/register")} data-testid="pos-nav-register">
            ابدأ مجاناً
          </Button>
        </nav>
      </div>
    </header>
  );
}
