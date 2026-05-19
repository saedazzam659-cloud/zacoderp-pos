import { useEffect } from "react";
import { useLocation } from "wouter";
import { Helmet } from "react-helmet-async";
import {
  Crown, Shield, Sparkles, Factory, Building2, Layers, Zap, Globe,
  ArrowLeft, Banknote, Users, BarChart3, GitBranch, Lock, Activity,
  Mic, Brain, Store, ShoppingBag, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// ─────────────────────────────────────────────────────────────────────────
// Public /why-zacod page — focused, opinionated landing page that
// converts visitors who already know they want an ERP but aren't sure
// which one. Complements /compare (matrix) and /pricing (cost).
//
// Each "reason" maps to a real capability documented in replit.md, not
// marketing fluff, so the page survives a technical reviewer.
// ─────────────────────────────────────────────────────────────────────────

type Reason = {
  icon: any;
  title: string;
  body: string;
  proof: string;
  tag: string;
};

const REASONS: Reason[] = [
  {
    icon: Factory,
    tag: "تصنيع",
    title: "دورة إنتاج كاملة بنمط SAP — لا يقدمها أي نظام سعودي آخر",
    body: "أوامر الإنتاج عندنا تنشئ قيد WIP فعلي (DR WIP / CR Raw) عند الإصدار، وقيد FG (+ DR Variance/Waste / CR WIP) عند الإكمال. تكلفة الوحدة المنتجة تُحسب تلقائياً باحتساب الهدر، والعمالة والتحميل الصناعي يُخصَّصان على رأس الأمر.",
    proof: "لو ألغيت الأمر بعد الإصدار، النظام يعكس قيد الإصدار تلقائياً ويحرر المخزون الخام. شيء لا تجده في قيود أو وافق أو فوم.",
  },
  {
    icon: Building2,
    tag: "متعدد الشركات",
    title: "Multi-tenancy حقيقي — شركاتك على نظام واحد بفصل تام",
    body: "كل شركة بياناتها معزولة على مستوى قاعدة البيانات (company_id) ومستوى الفرع (branch_id). تقارير مالية مستقلة، شجرة حسابات مستقلة، إعدادات ZATCA مستقلة.",
    proof: "SuperAdmin يدخل أي شركة بنقرة (Impersonation آمن مع شريط تنبيه دائم)، والـ React Query cache يُنظَّف تلقائياً عند الخروج حتى لا تتسرب بيانات بين المستأجرين.",
  },
  {
    icon: Banknote,
    tag: "إقفال مالي",
    title: "دورة إقفال فترات IFRS من 5 خطوات — ليست زر واحد",
    body: "تحقق ← إقفال P&L ← تحويل أرباح ← إقفال مؤقت ← إقفال نهائي. كل خطوة منفصلة، قابلة للتراجع، ومحمية بضوابط مثل رفض الإقفال المؤقت إن كانت حسابات الإيرادات والمصروفات بأرصدة مفتوحة.",
    proof: "حتى الإقفال النهائي محمي: ما يتم إلا بوجود قيدي إغلاق إيرادات/مصروفات وقيد تحويل أرباح/خسائر. الاسترجاع يحتاج SuperAdmin + سبب موثّق ≥ 10 أحرف (يُسجَّل).",
  },
  {
    icon: ShoppingBag,
    tag: "اعتمادات مستندية",
    title: "إدارة LC (اعتمادات مستندية) — للمستوردين الحقيقيين",
    body: "نظام محاسبي عادي يعجز عن تتبع مصاريف الاستيراد، شحن، تأمين، رسوم بنكية، وتأثيرها على تكلفة البضاعة. زاكود يدير دورة LC كاملة مع مصاريفها بعملات مختلفة وأسعار صرف.",
    proof: "حتى الافتراضات الذكية موجودة: لو فتحت LC بعملة غير الريال، أي مصروف جديد يفترض الريال بسعر صرف 1، والسيرفر يرفض أي محاولة لخلطها.",
  },
  {
    icon: Shield,
    tag: "ZATCA",
    title: "امتثال ZATCA أصلي — مرحلتين 1 و 2 من اليوم الأول",
    body: "إدارة CSR و CSID داخل النظام، توليد UBL 2.1 مع توقيع رقمي، TLV QR Code، تكامل مع بوابة فاتورة. واجهة عربية RTL أصلية (مش ترجمة)، ثنائية اللغة في كل شاشة.",
    proof: "ZATCA ليست ميزة مضافة — هي أساس النظام. كل تغيير تشريعي نتعامل معه قبل أن يصل عميلك.",
  },
  {
    icon: Lock,
    tag: "أمان",
    title: "عزل بيانات على مستوى الفرع — يحمي عملك من أخطاء الموظفين",
    body: "المستخدمون بصلاحية محدودة الفروع يرون فقط بيانات فروعهم. الصناديق، البنوك، المستودعات، الفواتير — كلها مفلترة تلقائياً. RBAC دقيق على مستوى المنطقة، الوحدة، والإجراء.",
    proof: "Audit Log شامل لكل عملية حساسة + سجل تسجيل دخول SuperAdmin مستقل. تشوف بالضبط من فعل ماذا ومتى.",
  },
  {
    icon: Store,
    tag: "POS + متجر",
    title: "نقاط بيع POS مدمجة + متجر إلكتروني — لا تحتاج تطبيقاً خارجياً",
    body: "نظام كاشير كامل يعمل offline، متعدد المحطات، مرتبط مباشرة بالمخزون والمحاسبة. متجر إلكتروني مدمج مع إدارة منتجات، طلبات، وتحليلات بالذكاء الاصطناعي.",
    proof: "تكلفة قيود + Shopify + تكامل = ضعف زاكود وحدوده. زاكود يفعل الثلاثة في منصة واحدة بقاعدة بيانات واحدة بدون تكاملات هشة.",
  },
  {
    icon: Mic,
    tag: "ذكاء اصطناعي",
    title: "أوامر صوتية + مساعد ذكي ينفّذ داخل النظام",
    body: "تقول 'أضف عميل أحمد محمد جواله 0501234567' فيتم — بدون فتح شاشات. مساعد إنتاج يحلل BOM ويقترح تكاليف. تقارير مالية مولّدة بالذكاء الاصطناعي بالعربية.",
    proof: "ليست واجهة Chat فقط — هي Actions حقيقية تتنفذ مع تأكيد. تحليل أمني ذكي للعمليات المريبة يعمل في الخلفية.",
  },
  {
    icon: Activity,
    tag: "Realtime",
    title: "تحديثات لحظية بدون إعادة تحميل (SSE Streaming)",
    body: "تغيير الصلاحيات، تفعيل/تعطيل اشتراك شركة، تحديثات SuperAdmin — تظهر فوراً للمستخدم المتأثر، بدون F5.",
    proof: "تجربة قريبة من تطبيقات Native بدون تعقيد WebSocket. بنية تتسع لآلاف المستخدمين المتزامنين.",
  },
  {
    icon: Crown,
    tag: "تكلفة",
    title: "تكلفة عقلانية — 80% من SAP بأقل من 10% من السعر",
    body: "اشتراك شهري شفاف بالريال السعودي، بدون عقود طويلة، بدون رسوم تطبيق، بدون رسوم ترقيات، مع تجربة فورية بدون بطاقة دفع.",
    proof: "ادفع فقط ما تستخدمه. باقة Starter تكفي لشركة كاملة فعلياً، والترقية بنقرة عند النمو.",
  },
];

export default function WhyZacod() {
  const [, setLocation] = useLocation();
  const origin = typeof window !== "undefined" ? window.location.origin : "https://zacoderp.com";
  const canonical = `${origin}/why-zacod`;

  useEffect(() => { window.scrollTo(0, 0); }, []);

  // Article schema so search/AI assistants treat this as authoritative
  // editorial content rather than just another marketing page.
  useEffect(() => {
    const articleSchema = {
      "@context": "https://schema.org",
      "@type": "Article",
      "headline": "لماذا تختار زاكود — 10 أسباب جوهرية",
      "author": { "@type": "Organization", "name": "زاكود المحاسبي" },
      "publisher": { "@type": "Organization", "name": "زاكود المحاسبي", "logo": { "@type": "ImageObject", "url": `${origin}/icon-512.png` } },
      "datePublished": "2026-01-01",
      "dateModified": new Date().toISOString().slice(0, 10),
      "image": `${origin}/opengraph.jpg`,
      "url": canonical,
      "mainEntityOfPage": canonical,
      "description": "عشرة أسباب موثقة (لا تسويقية) تجعل زاكود الخيار الأقوى للشركات السعودية الجادة: دورة إنتاج WIP، اعتمادات مستندية، متعدد شركات حقيقي، إقفال IFRS، وذكاء اصطناعي قابل للتنفيذ.",
    };
    const breadcrumb = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "الرئيسية", "item": `${origin}/` },
        { "@type": "ListItem", "position": 2, "name": "لماذا زاكود", "item": canonical },
      ],
    };
    const tags: HTMLScriptElement[] = [];
    for (const s of [articleSchema, breadcrumb]) {
      const el = document.createElement("script");
      el.type = "application/ld+json";
      el.text = JSON.stringify(s);
      el.dataset.whyZacod = "1";
      document.head.appendChild(el);
      tags.push(el);
    }
    return () => { for (const t of tags) t.remove(); };
  }, [origin, canonical]);

  return (
    <div dir="rtl" className="min-h-screen bg-gradient-to-b from-primary/5 via-background to-muted">
      <Helmet>
        <html lang="ar" dir="rtl" />
        <title>لماذا زاكود؟ 10 أسباب تجعله الـ ERP الأقوى للسوق السعودي</title>
        <meta name="description" content="عشرة أسباب موثقة (وليست تسويقية) تجعل زاكود الخيار الأمثل للشركات السعودية الجادة: دورة إنتاج SAP، اعتمادات مستندية، متعدد شركات حقيقي، إقفال IFRS، ذكاء اصطناعي قابل للتنفيذ، وامتثال ZATCA أصلي." />
        <link rel="canonical" href={canonical} />
        <meta name="keywords" content="لماذا زاكود, مميزات زاكود, أفضل ERP سعودي, بديل SAP عربي, نظام تصنيع سعودي, اعتمادات مستندية LC, إقفال IFRS, ZATCA" />
        <meta property="og:type" content="article" />
        <meta property="og:title" content="لماذا زاكود؟ 10 أسباب تجعله الـ ERP الأقوى للسوق السعودي" />
        <meta property="og:description" content="عشرة أسباب موثقة تجعل زاكود الخيار الأمثل للشركات السعودية الجادة." />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={`${origin}/opengraph.jpg`} />
        <meta property="og:locale" content="ar_SA" />
        <meta name="twitter:card" content="summary_large_image" />
      </Helmet>

      {/* Hero */}
      <header className="px-4 sm:px-6 pt-12 pb-10 max-w-5xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 bg-amber-50 text-amber-700 text-xs font-semibold px-3 py-1.5 rounded-full mb-4 border border-amber-200">
          <Crown className="h-3.5 w-3.5" /> أكثر من مجرد نظام محاسبة
        </div>
        <h1 className="text-3xl sm:text-5xl font-extrabold leading-tight">
          لماذا يختار العملاء <span className="bg-gradient-to-l from-primary to-emerald-500 bg-clip-text text-transparent">زاكود</span>؟
        </h1>
        <p className="mt-4 text-base sm:text-lg text-muted-foreground max-w-3xl mx-auto">
          10 أسباب موثقة — وليست تسويقية — تجعل زاكود ينافس <strong>SAP Business One</strong> و<strong>Odoo</strong>
          في القدرات، ويتفوق على <strong>قيود</strong> و<strong>وافق</strong> و<strong>فوم</strong> في العمق الوظيفي
          والامتثال السعودي. كل سبب أدناه مدعوم بدليل تقني حقيقي.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button size="lg" onClick={() => setLocation("/register")}>
            <Zap className="h-4 w-4 me-2" /> جرّب مجاناً الآن
          </Button>
          <Button size="lg" variant="outline" onClick={() => setLocation("/compare")}>
            شاهد المقارنة الكاملة <ArrowLeft className="h-4 w-4 me-2" />
          </Button>
        </div>
      </header>

      {/* Reasons grid */}
      <main className="px-4 sm:px-6 pb-16 max-w-6xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {REASONS.map((r, i) => {
            const Icon = r.icon;
            return (
              <Card key={i} className="hover:shadow-lg transition-shadow border-2 hover:border-primary/30">
                <CardContent className="p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-primary to-emerald-500 flex items-center justify-center text-white shadow-md">
                      <Icon className="h-6 w-6" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded">
                          {r.tag}
                        </span>
                        <span className="text-xs text-muted-foreground tabular-nums">#{i + 1}</span>
                      </div>
                      <h3 className="text-lg font-bold mb-2 leading-snug">{r.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed mb-3">{r.body}</p>
                      <div className="text-xs bg-emerald-50 border-r-4 border-emerald-500 px-3 py-2 rounded text-emerald-900">
                        <strong className="text-emerald-700">الدليل: </strong>{r.proof}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Final big CTA */}
        <section className="text-center bg-gradient-to-l from-primary/10 via-emerald-50 to-primary/10 rounded-2xl py-12 px-6 mt-12">
          <Sparkles className="h-12 w-12 mx-auto text-primary mb-4" />
          <h2 className="text-2xl sm:text-3xl font-extrabold mb-3">
            جاهز لتنقل عملك على ERP حقيقي؟
          </h2>
          <p className="text-muted-foreground mb-6 max-w-2xl mx-auto">
            ابدأ بدقيقة، بدون بطاقة دفع، وانتقل بياناتك من نظامك القديم خلال أيام بمساعدة فريقنا.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button size="lg" onClick={() => setLocation("/register")}>
              <Zap className="h-4 w-4 me-2" /> ابدأ التجربة المجانية
            </Button>
            <Button size="lg" variant="outline" onClick={() => setLocation("/pricing")}>
              شاهد الباقات
            </Button>
            <Button size="lg" variant="outline" onClick={() => setLocation("/compare")}>
              قارن مع المنافسين
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
