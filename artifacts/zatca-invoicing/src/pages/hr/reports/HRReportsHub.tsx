import { Link } from "wouter";
import {
  ChevronLeft, Users, Banknote, Clock, FileSignature, FileWarning,
  HandCoins, LogOut, Coins, BarChart3, CalendarDays,
} from "lucide-react";

const REPORTS = [
  {
    href: "/hr/reports/employees",
    title: "تقرير الموظفين",
    desc: "قائمة تفصيلية بالموظفين مع حالة العمل والرواتب الأساسية والبدلات",
    icon: Users,
    color: "from-sky-50 to-sky-100/40 text-sky-700 border-sky-200",
  },
  {
    href: "/hr/reports/payroll",
    title: "تقرير الرواتب",
    desc: "ملخص مسيرات الرواتب لفترة محددة مع إجمالي الإجمالي والاستقطاعات والصافي",
    icon: Banknote,
    color: "from-emerald-50 to-emerald-100/40 text-emerald-700 border-emerald-200",
  },
  {
    href: "/hr/reports/attendance",
    title: "تقرير الحضور والانصراف",
    desc: "إحصائيات الحضور والغياب والتأخير وساعات العمل لكل موظف",
    icon: Clock,
    color: "from-indigo-50 to-indigo-100/40 text-indigo-700 border-indigo-200",
  },
  {
    href: "/hr/reports/contracts",
    title: "تقرير العقود",
    desc: "حالة العقود (نشطة، منتهية، قاربت على الانتهاء) مع تفاصيل قيم العقود",
    icon: FileSignature,
    color: "from-violet-50 to-violet-100/40 text-violet-700 border-violet-200",
  },
  {
    href: "/hr/reports/documents",
    title: "تقرير وثائق منتهية الصلاحية",
    desc: "الإقامات وجوازات السفر التي انتهت أو قاربت على الانتهاء",
    icon: FileWarning,
    color: "from-amber-50 to-amber-100/40 text-amber-700 border-amber-200",
  },
  {
    href: "/hr/reports/loans",
    title: "تقرير السلف والقروض",
    desc: "السلف القائمة والمسددة مع نسبة التقدم والأقساط المتبقية",
    icon: HandCoins,
    color: "from-orange-50 to-orange-100/40 text-orange-700 border-orange-200",
  },
  {
    href: "/hr/reports/eos",
    title: "تقرير نهاية الخدمة",
    desc: "الموظفون المنتهية خدمتهم مع تقدير المستحقات وفق نظام العمل السعودي",
    icon: LogOut,
    color: "from-rose-50 to-rose-100/40 text-rose-700 border-rose-200",
  },
  {
    href: "/hr/reports/employee-cost",
    title: "تقرير تكلفة الموظفين",
    desc: "التكلفة الإجمالية الشهرية والسنوية للموظف شاملة حصة صاحب العمل من التأمينات",
    icon: Coins,
    color: "from-teal-50 to-teal-100/40 text-teal-700 border-teal-200",
  },
  {
    href: "/hr/reports/leaves",
    title: "تقرير الإجازات",
    desc: "ملخص الإجازات لكل موظف خلال فترة محددة مع التصنيف حسب النوع والحالة",
    icon: CalendarDays,
    color: "from-cyan-50 to-cyan-100/40 text-cyan-700 border-cyan-200",
  },
];

export default function HRReportsHub() {
  return (
    <div className="space-y-6" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-primary" /> تقارير شؤون الموظفين
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          مجموعة شاملة من تقارير الموارد البشرية مع تحليل ذكاء اصطناعي للملاحظات والتوصيات
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {REPORTS.map(r => (
          <Link key={r.href} href={r.href}>
            <a className={`group rounded-xl border bg-gradient-to-br ${r.color} p-5 transition-all hover:shadow-md hover:-translate-y-0.5 cursor-pointer block`}>
              <div className="flex items-start justify-between mb-3">
                <r.icon className="h-7 w-7" />
                <ChevronLeft className="h-4 w-4 opacity-40 group-hover:opacity-100 group-hover:-translate-x-1 transition-all" />
              </div>
              <h3 className="text-base font-bold mb-1.5">{r.title}</h3>
              <p className="text-xs opacity-80 leading-relaxed">{r.desc}</p>
            </a>
          </Link>
        ))}
      </div>
    </div>
  );
}
