import { useTranslation } from "react-i18next";
import { CreditCard, FileText, Wallet, BarChart3, Settings as SettingsIcon } from "lucide-react";
import { MenuHub, type HubTile } from "@/components/MenuHub";

const tiles: HubTile[] = [
  { nameKey: "nav.installmentsContracts",  href: "/installments/contracts",  icon: FileText,  tone: "indigo",  permKey: "installments" },
  { nameKey: "nav.installmentsCollection", href: "/installments/collection", icon: Wallet,    tone: "emerald", permKey: "installments" },
  { nameKey: "nav.installmentsReports",    href: "/installments/reports",    icon: BarChart3, tone: "amber",   permKey: "installments" },
  { nameKey: "nav.installmentsSettings",   href: "/installments/settings",   icon: SettingsIcon, tone: "slate", permKey: "installments" },
];

export default function InstallmentsHub() {
  const { t } = useTranslation();
  return (
    <MenuHub
      title={t("nav.installmentsGroup")}
      subtitle={t("hub.installmentsSubtitle")}
      icon={CreditCard}
      headerTone="indigo"
      tiles={tiles}
    />
  );
}
