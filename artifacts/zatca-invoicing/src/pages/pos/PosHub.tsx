import { useTranslation } from "react-i18next";
import { Activity, ClipboardList, MonitorSmartphone, Settings, Store } from "lucide-react";
import { MenuHub, type HubTile } from "@/components/MenuHub";

const tiles: HubTile[] = [
  { nameKey: "nav.posMonitoring", href: "/pos-monitoring", icon: Activity,          tone: "emerald", permKey: "pos" },
  { nameKey: "nav.posOperations", href: "/pos-operations", icon: ClipboardList,     tone: "violet",  permKey: "pos" },
  { nameKey: "nav.posTerminals",  href: "/pos-terminals",  icon: MonitorSmartphone, tone: "indigo",  permKey: "pos" },
  { nameKey: "nav.posSettings",   href: "/pos-settings",   icon: Settings,          tone: "slate",   permKey: "pos" },
];

export default function PosHub() {
  const { t } = useTranslation();
  return (
    <MenuHub
      title={t("nav.posManagement")}
      subtitle={t("hub.posSubtitle")}
      icon={Store}
      headerTone="violet"
      tiles={tiles}
    />
  );
}
