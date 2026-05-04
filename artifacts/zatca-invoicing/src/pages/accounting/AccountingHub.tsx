import { useTranslation } from "react-i18next";
import {
  BookMarked, Target, CalendarRange, BookOpen, PieChart,
  Calculator, ScrollText, Layers,
} from "lucide-react";
import { MenuHub, type HubTile } from "@/components/MenuHub";

const tiles: HubTile[] = [
  { nameKey: "nav.chartOfAccounts",      href: "/accounting/accounts",          icon: BookMarked,    tone: "indigo",  permKey: "accounts" },
  { nameKey: "nav.costCenters",          href: "/accounting/cost-centers",      icon: Target,        tone: "fuchsia", permKey: "accounts" },
  { nameKey: "nav.fiscalPeriods",        href: "/accounting/fiscal-periods",    icon: CalendarRange, tone: "amber",   permKey: "accounts" },
  { nameKey: "nav.journals",             href: "/accounting/journals",          icon: BookOpen,      tone: "teal",    permKey: "journal_entries" },
  { nameKey: "nav.postingCenter",        href: "/accounting/posting-center",    icon: Layers,        tone: "rose",    permKey: "journal_entries" },
  { nameKey: "nav.openingBalancesEntry", href: "/accounting/opening-balances",  icon: ScrollText,    tone: "violet",  permKey: "journal_entries" },
  { nameKey: "navExtra.accountingReports", href: "/accounting/reports",         icon: PieChart,      tone: "sky",     permKey: "accounting_reports" },
];

export default function AccountingHub() {
  const { t } = useTranslation();
  return (
    <MenuHub
      title={t("navExtra.accountingRoot")}
      subtitle={t("hub.accountingSubtitle")}
      icon={Calculator}
      headerTone="indigo"
      tiles={tiles}
    />
  );
}
