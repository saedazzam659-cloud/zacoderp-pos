import { useTranslation } from "react-i18next";
import {
  Users, UserSquare2, Target, CalendarRange, Megaphone, TrendingUp, Sparkles,
} from "lucide-react";
import { MenuHub, type HubTile } from "@/components/MenuHub";

const tiles: HubTile[] = [
  { nameKey: "nav.crmLeads",         href: "/crm/leads",         icon: UserSquare2,   tone: "rose",    permKey: "crm" },
  { nameKey: "nav.crmOpportunities", href: "/crm/opportunities", icon: Target,        tone: "amber",   permKey: "crm" },
  { nameKey: "nav.crmActivities",    href: "/crm/activities",    icon: CalendarRange, tone: "emerald", permKey: "crm" },
  { nameKey: "nav.crmCampaigns",     href: "/crm/campaigns",     icon: Megaphone,     tone: "violet",  permKey: "crm" },
  { nameKey: "nav.crmPipeline",      href: "/crm/pipeline",      icon: TrendingUp,    tone: "indigo",  permKey: "crm" },
  { nameKey: "nav.crmAI",            href: "/crm/ai",            icon: Sparkles,      tone: "pink",    permKey: "crm" },
];

export default function CrmHub() {
  const { t } = useTranslation();
  return (
    <MenuHub
      title={t("nav.crmGroup")}
      subtitle={t("hub.crmSubtitle")}
      icon={Users}
      headerTone="pink"
      tiles={tiles}
    />
  );
}
