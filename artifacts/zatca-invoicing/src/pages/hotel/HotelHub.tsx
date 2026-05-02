import { useTranslation } from "react-i18next";
import { Hotel, Building2, BedDouble, UserSquare2, CalendarRange, BrushCleaning, Sparkles } from "lucide-react";
import { MenuHub, type HubTile } from "@/components/MenuHub";

const tiles: HubTile[] = [
  { nameKey: "nav.hotels",            href: "/hotel/hotels",       icon: Building2,     tone: "teal",    permKey: "hotel" },
  { nameKey: "nav.hotelRooms",        href: "/hotel/rooms",        icon: BedDouble,     tone: "cyan",    permKey: "hotel" },
  { nameKey: "nav.hotelGuests",       href: "/hotel/guests",       icon: UserSquare2,   tone: "indigo",  permKey: "hotel" },
  { nameKey: "nav.hotelBookings",     href: "/hotel/bookings",     icon: CalendarRange, tone: "emerald", permKey: "hotel" },
  { nameKey: "nav.hotelHousekeeping", href: "/hotel/housekeeping", tone: "amber",   icon: BrushCleaning, permKey: "hotel" },
  { nameKey: "nav.hotelAI",           href: "/hotel/ai",           icon: Sparkles,      tone: "violet",  permKey: "hotel" },
];

export default function HotelHub() {
  const { t } = useTranslation();
  return (
    <MenuHub
      title={t("nav.hotelGroup")}
      subtitle={t("hub.hotelSubtitle")}
      icon={Hotel}
      headerTone="teal"
      tiles={tiles}
    />
  );
}
