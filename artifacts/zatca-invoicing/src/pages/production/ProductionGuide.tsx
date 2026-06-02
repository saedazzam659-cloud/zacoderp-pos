import { Link } from "wouter";
import {
  Settings2, Factory, Cog, CalendarClock, FileText, GitBranch, ListTree,
  Calculator, ClipboardList, ShieldCheck, Activity, Trophy,
  BarChart3, Gauge, DollarSign, Trash2, Users,
  CheckCircle2, ArrowLeftCircle, BookOpen, Lightbulb,
  ShieldAlert, AlertTriangle,
} from "lucide-react";

type Step = {
  n: number;
  title: string;
  desc: string;
  href: string;
  icon: any;
  optional?: boolean;
};

type Phase = {
  key: string;
  number: string;
  title: string;
  subtitle: string;
  tone: { bar: string; chip: string; ring: string; text: string };
  steps: Step[];
};

const phases: Phase[] = [
  {
    key: "setup",
    number: "١",
    title: "المرحلة الأولى: الإعداد الأولي (مرة واحدة)",
    subtitle:
      "قبل إنشاء أول أمر إنتاج، اضبط البيانات الأساسية لمصنعك. كل خطوة هنا تنفّذ مرة واحدة فقط، وتستفيد منها كل أوامر الإنتاج اللاحقة.",
    tone: {
      bar: "bg-indigo-500",
      chip: "bg-indigo-50 text-indigo-700 border-indigo-200",
      ring: "ring-indigo-100",
      text: "text-indigo-700",
    },
    steps: [
      {
        n: 1,
        title: "إعدادات التصنيع",
        desc: "حدّد المستودعات الافتراضية (المواد الخام/المنتج النهائي)، مركز التكلفة، والحسابات المحاسبية السبعة (WIP، مخزون المواد الخام، الأجور، التحميل، المنتج النهائي، الانحراف، الهالك). تنطبق تلقائيًا على كل أمر إنتاج جديد إذا لم تُحدَّد يدويًا. كذلك فعِّل اعتماد أوامر الإنتاج وحدّ الموافقة (Approval Threshold).",
        href: "/production/settings",
        icon: Settings2,
      },
      {
        n: 2,
        title: "مراكز العمل",
        desc: "أنشئ مراكز التشغيل في مصنعك (خط التقطيع، خط التغليف، ورشة الخراطة... إلخ). كل مركز عمل بيكون مرتبط بمستودع وله طاقة استيعابية محدّدة، وعليه بتترتب جداول الورديات والمراحل.",
        href: "/production/work-centers",
        icon: Factory,
      },
      {
        n: 3,
        title: "الماكينات والموارد",
        desc: "سجِّل الماكينات والعمالة كموارد قابلة للتخصيص. كل مورد له تكلفة بالساعة (تُستعمل في حساب تكلفة الإنتاج الفعلية) ويُربط بمركز عمل.",
        href: "/production/resources",
        icon: Cog,
      },
      {
        n: 4,
        title: "تقويم الورديات",
        desc: "حدّد جدول العمل الأسبوعي/الشهري لكل مركز عمل (الورديات، أيام الإجازة). يُستعمل في حساب الطاقة المتاحة وقياس OEE.",
        href: "/production/shifts",
        icon: CalendarClock,
        optional: true,
      },
      {
        n: 5,
        title: "قوالب فحص الجودة",
        desc: "أنشئ قوالب الفحوصات المعيارية (مثلاً: فحص الأبعاد، فحص اللون، فحص الوزن). كل قالب بيتطبّق على عدة منتجات ويوفّر وقت إعداد الفحص.",
        href: "/production/quality-templates",
        icon: FileText,
        optional: true,
      },
      {
        n: 6,
        title: "قوالب مراحل الإنتاج (Routings)",
        desc: "عرّف تسلسل المراحل القياسي لكل منتج (مثلاً: تقطيع → تجميع → فحص → تغليف). كل مرحلة بتكون مرتبطة بمركز عمل + الزمن المعياري + الموارد المطلوبة.",
        href: "/production/routings",
        icon: GitBranch,
      },
      {
        n: 7,
        title: "قوالب المكوّنات (BOM)",
        desc: "أهم خطوة في الإعداد! عرّف لكل منتج نهائي قائمة المواد الخام التي تدخل في تصنيعه وكمياتها. عند إنشاء أمر إنتاج لهذا المنتج، يتم نسخ المكوّنات تلقائيًا مع تكبير/تصغير الكميات حسب الكمية المخططة.",
        href: "/production/bom-templates",
        icon: ListTree,
      },
    ],
  },
  {
    key: "planning",
    number: "٢",
    title: "المرحلة الثانية: التخطيط",
    subtitle:
      "قبل الإنتاج الفعلي، خطّط احتياجاتك من المواد الخام بناءً على الطلبات المستقبلية والمخزون الحالي.",
    tone: {
      bar: "bg-amber-500",
      chip: "bg-amber-50 text-amber-700 border-amber-200",
      ring: "ring-amber-100",
      text: "text-amber-700",
    },
    steps: [
      {
        n: 8,
        title: "تخطيط احتياجات المواد (MRP)",
        desc: "النظام بيحسب لك تلقائيًا: المواد الخام المطلوبة لكل أوامر الإنتاج المخطّطة، يطرح المخزون المتاح، ويقترح أوامر شراء بالكمية والتاريخ المطلوبين. خطوة ذكية بتمنعك من توقف الإنتاج بسبب نقص المواد.",
        href: "/production/mrp",
        icon: Calculator,
        optional: true,
      },
    ],
  },
  {
    key: "execution",
    number: "٣",
    title: "المرحلة الثالثة: التنفيذ اليومي",
    subtitle:
      "دورة حياة أمر الإنتاج: من إنشاء المسودة، إلى الاعتماد، إلى صرف المواد، إلى الإكمال. هذه هي العمليات اليومية لقسم الإنتاج.",
    tone: {
      bar: "bg-emerald-500",
      chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
      ring: "ring-emerald-100",
      text: "text-emerald-700",
    },
    steps: [
      {
        n: 9,
        title: "أوامر الإنتاج — إنشاء أمر جديد",
        desc: "اختر المنتج النهائي والكمية المخططة وتاريخ البدء/الانتهاء. بمجرد اختيار المنتج، يتم نسخ مكوّنات BOM تلقائيًا. الأمر يبدأ بحالة 'مسودة'.",
        href: "/production/orders",
        icon: ClipboardList,
      },
      {
        n: 10,
        title: "اعتماد أوامر الإنتاج",
        desc: "إذا كان الاعتماد مفعّلًا في الإعدادات، أو إذا تجاوزت التكلفة المتوقعة حدّ الموافقة، الأمر يدخل قائمة الانتظار. المشرف يفتح هذه الشاشة، يراجع التكلفة والمكوّنات، ويعتمد أو يرفض مع سبب.",
        href: "/production/approvals",
        icon: ShieldCheck,
        optional: true,
      },
      {
        n: 11,
        title: "خط الإنتاج المرئي (Board)",
        desc: "لوحة كانبان للأوامر النشطة. هنا تنقل الأمر بين الحالات: مسوّدة ← معتمد ← قيد التصنيع (هنا يحدث صرف المواد وتسجيل قيد DR WIP / CR المخزون) ← فحص جودة ← مكتمل (هنا قيد DR المنتج النهائي / CR WIP، ويتم حساب التكلفة النهائية للوحدة).",
        href: "/production/board",
        icon: Activity,
      },
      {
        n: 12,
        title: "فحوصات الجودة",
        desc: "للأوامر التي وصلت لمرحلة فحص الجودة. سجّل نتائج الفحص (نجاح/فشل + ملاحظات). يمكنك إضافة هالك (waste) هنا والذي يُسجّل تلقائيًا بقيد DR هالك / CR WIP.",
        href: "/production/quality",
        icon: ShieldCheck,
      },
      {
        n: 13,
        title: "التوقفات وكفاءة المعدات (OEE)",
        desc: "سجّل توقفات الماكينات (سبب التوقف + المدة). النظام يحسب مؤشر OEE (الجودة × التوافر × الأداء) لكل مركز عمل، وهو المؤشر المعياري عالميًا لقياس كفاءة المصنع.",
        href: "/production/downtime",
        icon: Activity,
        optional: true,
      },
    ],
  },
  {
    key: "reports",
    number: "٤",
    title: "المرحلة الرابعة: التقارير والتحليل",
    subtitle:
      "بعد ما الأوامر تتنفّذ، استخدم هذه الشاشات لمتابعة الأداء، تحليل التكلفة، وتحديد فرص التحسين.",
    tone: {
      bar: "bg-violet-500",
      chip: "bg-violet-50 text-violet-700 border-violet-200",
      ring: "ring-violet-100",
      text: "text-violet-700",
    },
    steps: [
      {
        n: 14,
        title: "لوحة الإنتاج",
        desc: "نظرة عامة سريعة: عدد الأوامر بكل حالة، المخطّط مقابل المُنتج، نسبة الإكمال، نسبة الهالك، استخدام الماكينات، وإجمالي التكلفة.",
        href: "/production",
        icon: BarChart3,
      },
      {
        n: 15,
        title: "لوحة مؤشرات التصنيع (KPIs)",
        desc: "مؤشرات أداء رئيسية مع رسوم بيانية ومقارنة بالفترات السابقة: متوسط زمن دورة الأمر، إنتاجية كل مركز عمل، نسبة الفاقد، الالتزام بالتسليم في الموعد.",
        href: "/production/kpis",
        icon: Gauge,
      },
      {
        n: 16,
        title: "تكلفة المنتج المعيارية",
        desc: "احسب التكلفة المعيارية لأي منتج نهائي بناءً على قوالب BOM الحالية وأسعار المواد الخام. يساعدك في التسعير والمقارنة بين التكلفة الفعلية والمتوقعة.",
        href: "/production/cost-rollup",
        icon: DollarSign,
      },
      {
        n: 17,
        title: "تقرير مراقبة الجودة",
        desc: "إحصائيات الفحوصات: نسبة النجاح، أكثر أسباب الفشل تكرارًا، المنتجات الأعلى انحرافًا. مدخل ممتاز لتحسين العمليات.",
        href: "/production/quality-report",
        icon: ShieldCheck,
      },
      {
        n: 18,
        title: "تقرير الهالك والتالف",
        desc: "تحليل الهالك حسب المنتج، مركز العمل، السبب، والفترة. يكشف لك الخسائر الخفية ومصادر الإهدار.",
        href: "/production/waste-report",
        icon: Trash2,
      },
      {
        n: 19,
        title: "أداء المشغّلين",
        desc: "مقارنة بين المشغّلين: عدد الأوامر المُسلّمة، الجودة، الالتزام بالوقت. أداة للمكافآت وتحديد الاحتياجات التدريبية.",
        href: "/production/operator-performance",
        icon: Users,
      },
      {
        n: 20,
        title: "أدائي (للمشغّل)",
        desc: "صفحة شخصية يفتحها كل عامل ليرى أدائه الشخصي: أوامره، نسبة إنتاجيته، تقييمه.",
        href: "/production/my-performance",
        icon: Trophy,
        optional: true,
      },
      {
        n: 21,
        title: "تتبّع التشغيلات (Traceability)",
        desc: "تتبّع كامل لأي دفعة منتج: من أي مواد خام صُنعت، من نفّذها، متى، ونتائج الفحوصات. ضروري لاسترداد المنتجات ومتطلبات شهادات ISO.",
        href: "/production/traceability",
        icon: GitBranch,
        optional: true,
      },
    ],
  },
  {
    key: "safety",
    number: "٥",
    title: "المرحلة الخامسة: السلامة والصحة المهنية (ISO 45001)",
    subtitle:
      "السلامة جزء لا يتجزأ من التصنيع. هذه المرحلة تُدير المخاطر قبل وقوعها وتتعامل مع الحوادث بشكل منهجي وفق المواصفة الدولية ISO 45001:2018 ومتطلبات السلامة السعودية. ابدأ بحصر المخاطر، وسجّل أي حادث فور وقوعه، وتابع المؤشرات باستمرار.",
    tone: {
      bar: "bg-red-500",
      chip: "bg-red-50 text-red-700 border-red-200",
      ring: "ring-red-100",
      text: "text-red-700",
    },
    steps: [
      {
        n: 22,
        title: "سجل المخاطر",
        desc: "احصر مخاطر كل عملية ومركز عمل قبل وقوع الضرر. قيّم كل خطر بمصفوفة 5×5 (الاحتمالية × الشدة) لتحديد درجته (منخفض/متوسط/عالٍ/حرج)، ثم طبّق هرمية الضوابط (الإزالة ← الاستبدال ← الهندسية ← الإدارية ← معدات الوقاية الشخصية) وسجّل المخاطر المتبقية بعد الضوابط. خطوة وقائية أساسية في ISO 45001.",
        href: "/safety/risk-assessments",
        icon: ClipboardList,
      },
      {
        n: 23,
        title: "الحوادث والإصابات",
        desc: "سجّل أي حادث فور وقوعه — من الحوادث الوشيكة (Near-miss) والحالات غير الآمنة حتى الإصابات والوفيات. صنّف الشدة (إسعافات أولية/علاج طبي/فقد وقت/وفاة)، وحلّل السبب الجذري بتقنية «5 لماذا»، ثم افتح إجراءات تصحيحية ووقائية (CAPA) لمنع التكرار. الحوادث «علاج طبي» فأعلى تُحتسب حوادث مسجَّلة تلقائيًا.",
        href: "/safety/incidents",
        icon: AlertTriangle,
      },
      {
        n: 24,
        title: "لوحة السلامة",
        desc: "تابع مؤشرات الأداء المعيارية عالميًا: معدل الإصابات المسجَّلة (TRIR)، معدل تكرار الإصابات بفقد الوقت (LTIFR)، معدل الشدة، وأيام منذ آخر إصابة بفقد الوقت. أدخل إجمالي ساعات العمل خلال الفترة لحساب المعدلات النسبية بدقة. اللوحة تعطيك صورة فورية عن حالة المخاطر المفتوحة وإجراءات CAPA المتأخرة.",
        href: "/safety",
        icon: BarChart3,
      },
    ],
  },
];

export default function ProductionGuide() {
  return (
    <div className="container mx-auto px-3 sm:px-6 py-5 max-w-6xl" dir="rtl">
      {/* Header banner */}
      <div className="rounded-2xl border bg-gradient-to-l from-indigo-50 via-violet-50 to-fuchsia-50 p-6 mb-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl bg-indigo-500 text-white flex items-center justify-center shrink-0">
            <BookOpen className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-slate-900">
              دليل تشغيل موديل الإنتاج والتصنيع
            </h1>
            <p className="text-sm text-slate-600 mt-1 leading-relaxed">
              ترتيب منطقي خطوة بخطوة لإعداد المصنع وتشغيل أوامر الإنتاج بشكل
              صحيح. اتّبع المراحل الخمس بالترتيب: <strong>الإعداد الأولي</strong>{" "}
              مرة واحدة، ثم <strong>التخطيط</strong> الأسبوعي/الشهري، ثم{" "}
              <strong>التنفيذ اليومي</strong>، ثم <strong>التقارير</strong>{" "}
              للمتابعة والتحسين، وأخيرًا <strong>السلامة والصحة المهنية</strong>{" "}
              لإدارة المخاطر والحوادث وفق ISO 45001.
            </p>
          </div>
        </div>
      </div>

      {/* Quick tips */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 mb-6">
        <div className="flex items-start gap-3">
          <Lightbulb className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
          <div className="text-sm text-amber-900 space-y-1">
            <p>
              <strong>قبل ما تبدأ:</strong> تأكّد إنك سجّلت الأصناف (المواد الخام
              والمنتجات النهائية) من <Link href="/inventory/items" className="underline font-semibold">إدارة الأصناف</Link>،
              والمستودعات من <Link href="/inventory/warehouses" className="underline font-semibold">المستودعات</Link>،
              والحسابات المحاسبية من شجرة الحسابات. الإنتاج بيعتمد عليهم.
            </p>
            <p>
              <strong>الخطوات المعلَّمة بـ (اختياري)</strong> ممكن تتخطّاها في أول تشغيل
              وترجعلها بعدين، لكنها بتضيف قيمة قوية للنظام.
            </p>
          </div>
        </div>
      </div>

      {/* Phases */}
      <div className="space-y-6">
        {phases.map((phase) => (
          <section key={phase.key} className="rounded-2xl border bg-card shadow-sm overflow-hidden">
            <div className={`${phase.tone.bar} text-white px-5 py-4 flex items-center gap-3`}>
              <div className="h-9 w-9 rounded-lg bg-white/20 flex items-center justify-center text-lg font-bold shrink-0">
                {phase.number}
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-bold">{phase.title}</h2>
                <p className="text-xs text-white/90 mt-0.5 leading-relaxed">{phase.subtitle}</p>
              </div>
            </div>

            <ol className="divide-y">
              {phase.steps.map((step) => {
                const Icon = step.icon;
                return (
                  <li key={step.n} className="p-4 hover:bg-slate-50 transition-colors">
                    <div className="flex items-start gap-3">
                      <div className={`h-8 w-8 rounded-full ring-4 ${phase.tone.ring} bg-white border ${phase.tone.text} flex items-center justify-center text-sm font-bold shrink-0`}>
                        {step.n}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <Icon className={`h-4 w-4 ${phase.tone.text}`} />
                          <h3 className="font-semibold text-slate-900">{step.title}</h3>
                          {step.optional && (
                            <span className={`text-[10px] px-2 py-0.5 rounded-full border ${phase.tone.chip}`}>
                              اختياري
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-slate-600 leading-relaxed mb-2">{step.desc}</p>
                        <Link
                          href={step.href}
                          className={`inline-flex items-center gap-1.5 text-xs font-semibold ${phase.tone.text} hover:underline`}
                          data-testid={`link-step-${step.n}`}
                          aria-label={`افتح شاشة: ${step.title}`}
                        >
                          <ArrowLeftCircle className="h-3.5 w-3.5" />
                          افتح الشاشة
                        </Link>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>

      {/* Footer summary */}
      <div className="rounded-2xl border bg-slate-50 p-5 mt-6">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
          <div className="text-sm text-slate-700 space-y-2">
            <p className="font-semibold text-slate-900">ملخّص دورة حياة الأمر المحاسبية</p>
            <ul className="space-y-1 list-disc pr-5 leading-relaxed">
              <li>
                <strong>عند الصرف (in_production):</strong> قيد{" "}
                <code className="text-xs bg-white px-1 rounded">DR WIP + DR أجور + DR تحميل / CR مخزون المواد الخام</code>.
              </li>
              <li>
                <strong>عند الإكمال (completed):</strong> قيد{" "}
                <code className="text-xs bg-white px-1 rounded">DR المنتج النهائي (+ DR انحراف/هالك) / CR WIP</code>،
                وتكلفة الوحدة = <code className="text-xs bg-white px-1 rounded">رصيد WIP × الكمية المُنتجة / (المنتج + الهالك)</code>.
              </li>
              <li>
                <strong>عند الإلغاء بعد الصرف:</strong> النظام يعكس قيد الصرف تلقائيًا ويعيد المواد للمخزون.
              </li>
              <li>
                <strong>قفل ما بعد الصرف:</strong> بمجرد دخول الأمر مرحلة{" "}
                <em>قيد التصنيع</em>، حسابات WIP/المواد الخام تصبح للقراءة فقط — لتغييرها يجب إلغاء الأمر وإعادة الدورة.
              </li>
            </ul>
            <p className="text-xs text-slate-500 mt-3">
              للمزيد من التفاصيل في كل خطوة، افتح الشاشة الخاصة بها واضغط على أيقونة المساعدة بداخلها.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
