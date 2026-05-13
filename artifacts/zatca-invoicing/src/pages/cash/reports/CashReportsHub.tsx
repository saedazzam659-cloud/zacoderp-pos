import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft, ChevronRight, Wallet, Landmark, FileText, Banknote,
  ArrowDownCircle, ArrowUpCircle, ArrowLeftRight, CalendarRange, GitCompareArrows,
} from "lucide-react";

export default function CashReportsHub() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";

  const REPORTS = [
    { href: "/cash/reports/cash-balances",     title: t("cashReports.hub.cashBalances"),     desc: t("cashReports.hub.cashBalancesDesc"),     icon: Wallet,          color: "from-emerald-50 to-emerald-100/40 text-emerald-700 border-emerald-200" },
    { href: "/cash/reports/bank-balances",     title: t("cashReports.hub.bankBalances"),     desc: t("cashReports.hub.bankBalancesDesc"),     icon: Landmark,        color: "from-sky-50 to-sky-100/40 text-sky-700 border-sky-200" },
    { href: "/cash/reports/cash-box-statement",title: t("cashReports.hub.cashBoxStatement"), desc: t("cashReports.hub.cashBoxStatementDesc"), icon: FileText,        color: "from-indigo-50 to-indigo-100/40 text-indigo-700 border-indigo-200" },
    { href: "/cash/reports/bank-statement",    title: t("cashReports.hub.bankStatement"),    desc: t("cashReports.hub.bankStatementDesc"),    icon: Banknote,        color: "from-cyan-50 to-cyan-100/40 text-cyan-700 border-cyan-200" },
    { href: "/cash/reports/bank-reconciliation", title: "مطابقة كشف البنك",                  desc: "قارن قيود البنك الدفترية مع كشف الحساب الفعلي (Excel/CSV/PDF/Word)", icon: GitCompareArrows, color: "from-teal-50 to-teal-100/40 text-teal-700 border-teal-200" },
    { href: "/cash/reports/daily-summary",     title: t("cashReports.hub.cashFlow"),         desc: t("cashReports.hub.cashFlowDesc"),         icon: CalendarRange,   color: "from-purple-50 to-purple-100/40 text-purple-700 border-purple-200" },
    { href: "/cash/reports/receipts",          title: t("cashReports.hub.receipts"),         desc: t("cashReports.hub.receiptsDesc"),         icon: ArrowDownCircle, color: "from-green-50 to-green-100/40 text-green-700 border-green-200" },
    { href: "/cash/reports/payments",          title: t("cashReports.hub.payments"),         desc: t("cashReports.hub.paymentsDesc"),         icon: ArrowUpCircle,   color: "from-rose-50 to-rose-100/40 text-rose-700 border-rose-200" },
    { href: "/cash/reports/transfers",         title: t("cashReports.hub.transfers"),        desc: t("cashReports.hub.transfersDesc"),        icon: ArrowLeftRight,  color: "from-amber-50 to-amber-100/40 text-amber-700 border-amber-200" },
  ];

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Wallet className="h-6 w-6 text-primary" /> {t("cashReports.hub.title")}
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          {t("cashReports.hub.subtitle")}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {REPORTS.map(r => (
          <Link key={r.href} href={r.href} className={`group rounded-xl border bg-gradient-to-br ${r.color} p-5 transition-all hover:shadow-md hover:-translate-y-0.5 cursor-pointer block`}>
            <div className="flex items-start justify-between mb-3">
              <r.icon className="h-7 w-7" />
              {isRtl
                ? <ChevronLeft className="h-4 w-4 opacity-40 group-hover:opacity-100 group-hover:-translate-x-1 transition-all" />
                : <ChevronRight className="h-4 w-4 opacity-40 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />}
            </div>
            <h3 className="text-base font-bold mb-1.5">{r.title}</h3>
            <p className="text-xs opacity-80 leading-relaxed">{r.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
