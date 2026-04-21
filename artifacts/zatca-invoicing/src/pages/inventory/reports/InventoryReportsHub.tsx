import { Link } from "wouter";
import {
  BarChart2, BookOpen, IdCard, AlertTriangle, Wallet, Hourglass, ChevronLeft,
} from "lucide-react";

const REPORTS = [
  {
    href: "/inventory/reports/stock-balance",
    title: "رصيد المخزون",
    desc: "أرصدة الأصناف التفصيلية بالكميات والقيم حسب المخزن",
    icon: BarChart2,
    color: "from-emerald-50 to-emerald-100/40 text-emerald-700 border-emerald-200",
  },
  {
    href: "/inventory/reports/stock-ledger",
    title: "دفتر حركة المخزون",
    desc: "سجل تفصيلي لكل حركات الإدخال والإخراج خلال الفترة",
    icon: BookOpen,
    color: "from-sky-50 to-sky-100/40 text-sky-700 border-sky-200",
  },
  {
    href: "/inventory/reports/item-card",
    title: "كارت الصنف",
    desc: "حركة صنف واحد مع الرصيد التراكمي بعد كل عملية",
    icon: IdCard,
    color: "from-indigo-50 to-indigo-100/40 text-indigo-700 border-indigo-200",
  },
  {
    href: "/inventory/reports/low-stock",
    title: "الأصناف منخفضة المخزون",
    desc: "الأصناف التي وصلت لحد إعادة الطلب أو نفدت",
    icon: AlertTriangle,
    color: "from-amber-50 to-amber-100/40 text-amber-700 border-amber-200",
  },
  {
    href: "/inventory/reports/valuation",
    title: "تقييم المخزون حسب المخزن",
    desc: "إجمالي قيمة المخزون مجمعة لكل مخزن مع نسبة المساهمة",
    icon: Wallet,
    color: "from-purple-50 to-purple-100/40 text-purple-700 border-purple-200",
  },
  {
    href: "/inventory/reports/slow-moving",
    title: "الأصناف الراكدة",
    desc: "الأصناف التي لم تشهد حركة خلال فترة محددة",
    icon: Hourglass,
    color: "from-rose-50 to-rose-100/40 text-rose-700 border-rose-200",
  },
];

export default function InventoryReportsHub() {
  return (
    <div className="space-y-6" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart2 className="h-6 w-6 text-primary" /> تقارير المخازن
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          تقارير شاملة لإدارة ومراقبة المخزون مع إمكانية التصدير لـ Excel و PDF والطباعة
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
