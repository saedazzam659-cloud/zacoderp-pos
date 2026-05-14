import { useTranslation } from "react-i18next";
import { Wrench, Boxes, HardHat, ClipboardList, MapPin } from "lucide-react";
import { MenuHub, type HubTile } from "@/components/MenuHub";

const tiles: HubTile[] = [
  { nameKey: "nav.maintenanceAssets",      href: "/maintenance/assets",      icon: Boxes,         tone: "amber",   permKey: "maintenance" },
  { nameKey: "nav.maintenanceTechnicians", href: "/maintenance/technicians", icon: HardHat,       tone: "indigo",  permKey: "maintenance" },
  { nameKey: "nav.maintenanceOrders",      href: "/maintenance/orders",      icon: ClipboardList, tone: "emerald", permKey: "maintenance" },
  { nameKey: "الخدمة الميدانية والزيارات", descKey: "تذاكر SLA، خطط الزيارات، وتتبع الفنيين في الميدان",
    href: "/hr/field", icon: MapPin, tone: "blue", permKey: "hr_face_attendance" },
];

export default function MaintenanceHub() {
  const { t } = useTranslation();
  return (
    <MenuHub
      title={t("nav.maintenanceGroup")}
      subtitle={t("hub.maintenanceSubtitle")}
      icon={Wrench}
      headerTone="orange"
      tiles={tiles}
    />
  );
}
