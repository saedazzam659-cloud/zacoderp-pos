import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft, ChevronRight, Users, Banknote, Clock, FileSignature, FileWarning,
  HandCoins, LogOut, Coins, BarChart3, CalendarDays,
} from "lucide-react";

export default function HRReportsHub() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string) => t(`hrPages.reportsHub.${k}`) as string;

  const REPORTS = [
    { href: "/hr/reports/employees",      titleKey: "rptEmployeesTitle",     descKey: "rptEmployeesDesc",     icon: Users,         color: "from-sky-50 to-sky-100/40 text-sky-700 border-sky-200" },
    { href: "/hr/reports/payroll",        titleKey: "rptPayrollTitle",       descKey: "rptPayrollDesc",       icon: Banknote,      color: "from-emerald-50 to-emerald-100/40 text-emerald-700 border-emerald-200" },
    { href: "/hr/reports/attendance",     titleKey: "rptAttendanceTitle",    descKey: "rptAttendanceDesc",    icon: Clock,         color: "from-indigo-50 to-indigo-100/40 text-indigo-700 border-indigo-200" },
    { href: "/hr/reports/contracts",      titleKey: "rptContractsTitle",     descKey: "rptContractsDesc",     icon: FileSignature, color: "from-violet-50 to-violet-100/40 text-violet-700 border-violet-200" },
    { href: "/hr/reports/documents",      titleKey: "rptDocumentsTitle",     descKey: "rptDocumentsDesc",     icon: FileWarning,   color: "from-amber-50 to-amber-100/40 text-amber-700 border-amber-200" },
    { href: "/hr/reports/loans",          titleKey: "rptLoansTitle",         descKey: "rptLoansDesc",         icon: HandCoins,     color: "from-orange-50 to-orange-100/40 text-orange-700 border-orange-200" },
    { href: "/hr/reports/eos",            titleKey: "rptEosTitle",           descKey: "rptEosDesc",           icon: LogOut,        color: "from-rose-50 to-rose-100/40 text-rose-700 border-rose-200" },
    { href: "/hr/reports/employee-cost",  titleKey: "rptEmployeeCostTitle",  descKey: "rptEmployeeCostDesc",  icon: Coins,         color: "from-teal-50 to-teal-100/40 text-teal-700 border-teal-200" },
    { href: "/hr/reports/leaves",         titleKey: "rptLeavesTitle",        descKey: "rptLeavesDesc",        icon: CalendarDays,  color: "from-cyan-50 to-cyan-100/40 text-cyan-700 border-cyan-200" },
  ];

  const Chevron = isRtl ? ChevronLeft : ChevronRight;

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-primary" /> {tr("title")}
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          {tr("subtitle")}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {REPORTS.map(r => (
          <Link key={r.href} href={r.href}>
            <a className={`group rounded-xl border bg-gradient-to-br ${r.color} p-5 transition-all hover:shadow-md hover:-translate-y-0.5 cursor-pointer block`}>
              <div className="flex items-start justify-between mb-3">
                <r.icon className="h-7 w-7" />
                <Chevron className={`h-4 w-4 opacity-40 group-hover:opacity-100 ${isRtl ? "group-hover:-translate-x-1" : "group-hover:translate-x-1"} transition-all`} />
              </div>
              <h3 className="text-base font-bold mb-1.5">{tr(r.titleKey)}</h3>
              <p className="text-xs opacity-80 leading-relaxed">{tr(r.descKey)}</p>
            </a>
          </Link>
        ))}
      </div>
    </div>
  );
}
