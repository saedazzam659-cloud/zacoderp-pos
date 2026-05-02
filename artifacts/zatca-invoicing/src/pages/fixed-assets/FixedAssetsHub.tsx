import { useTranslation } from "react-i18next";
import {
  Boxes, Tag, Wrench, ArrowRightLeft, TrendingUp, Trash2, Sparkles, Package,
} from "lucide-react";
import { MenuHub, type HubTile } from "@/components/MenuHub";

const tiles: HubTile[] = [
  { nameKey: "nav.faAssets",       href: "/fixed-assets/assets",       icon: Package,         tone: "emerald", permKey: "fixed_assets" },
  { nameKey: "nav.faCategories",   href: "/fixed-assets/categories",   icon: Tag,             tone: "amber",   permKey: "fixed_assets" },
  { nameKey: "nav.faMaintenance",  href: "/fixed-assets/maintenance",  icon: Wrench,          tone: "orange",  permKey: "fixed_assets" },
  { nameKey: "nav.faTransfers",    href: "/fixed-assets/transfers",    icon: ArrowRightLeft,  tone: "indigo",  permKey: "fixed_assets" },
  { nameKey: "nav.faDepreciation", href: "/fixed-assets/depreciation", icon: TrendingUp,      tone: "violet",  permKey: "fixed_assets" },
  { nameKey: "nav.faDisposals",    href: "/fixed-assets/disposals",    icon: Trash2,          tone: "rose",    permKey: "fixed_assets" },
  { nameKey: "nav.faAI",           href: "/fixed-assets/ai",           icon: Sparkles,        tone: "pink",    permKey: "fixed_assets" },
];

export default function FixedAssetsHub() {
  const { t } = useTranslation();
  return (
    <MenuHub
      title={t("nav.fixedAssetsGroup")}
      subtitle={t("hub.fixedAssetsSubtitle")}
      icon={Boxes}
      headerTone="emerald"
      tiles={tiles}
    />
  );
}
