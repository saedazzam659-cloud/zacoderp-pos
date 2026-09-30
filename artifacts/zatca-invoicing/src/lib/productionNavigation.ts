import {
  Activity,
  BarChart3,
  BookOpen,
  CalendarClock,
  Calculator,
  ClipboardList,
  Cog,
  DollarSign,
  Factory,
  FileText,
  Gauge,
  GitBranch,
  ListTree,
  Settings2,
  ShieldCheck,
  Trash2,
  Trophy,
  Users,
  type LucideIcon,
} from "lucide-react";

export type ProductionNavItem = {
  nameKey: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
  permKey: "production";
};

// Shared source for the production sidebar and its optional agent tile hub.
export const productionSubNav: ProductionNavItem[] = [
  // Guide & dashboard
  { nameKey: "nav.productionGuide", href: "/production/guide", icon: BookOpen, permKey: "production" },
  { nameKey: "nav.productionDashboard", href: "/production", icon: BarChart3, permKey: "production", exact: true },
  // Initial setup
  { nameKey: "nav.manufacturingSettings", href: "/production/settings", icon: Settings2, permKey: "production" },
  { nameKey: "nav.workCenters", href: "/production/work-centers", icon: Factory, permKey: "production" },
  { nameKey: "nav.productionResources", href: "/production/resources", icon: Cog, permKey: "production" },
  { nameKey: "nav.shiftCalendar", href: "/production/shifts", icon: CalendarClock, permKey: "production" },
  { nameKey: "nav.qualityTemplates", href: "/production/quality-templates", icon: FileText, permKey: "production" },
  { nameKey: "nav.productionRoutings", href: "/production/routings", icon: GitBranch, permKey: "production" },
  { nameKey: "nav.bomTemplates", href: "/production/bom-templates", icon: ListTree, permKey: "production" },
  // Planning
  { nameKey: "nav.mrpPlanning", href: "/production/mrp", icon: Calculator, permKey: "production" },
  // Daily execution
  { nameKey: "nav.productionOrders", href: "/production/orders", icon: ClipboardList, permKey: "production" },
  { nameKey: "nav.pendingApprovals", href: "/production/approvals", icon: ShieldCheck, permKey: "production" },
  { nameKey: "nav.productionBoard", href: "/production/board", icon: Activity, permKey: "production" },
  { nameKey: "nav.productionQuality", href: "/production/quality", icon: ShieldCheck, permKey: "production" },
  { nameKey: "nav.downtimeOee", href: "/production/downtime", icon: Activity, permKey: "production" },
  // Reports & analytics
  { nameKey: "nav.manufacturingKpis", href: "/production/kpis", icon: Gauge, permKey: "production" },
  { nameKey: "nav.costRollup", href: "/production/cost-rollup", icon: DollarSign, permKey: "production" },
  { nameKey: "nav.productionQualityReport", href: "/production/quality-report", icon: ShieldCheck, permKey: "production" },
  { nameKey: "nav.productionWasteReport", href: "/production/waste-report", icon: Trash2, permKey: "production" },
  { nameKey: "nav.operatorPerformance", href: "/production/operator-performance", icon: Users, permKey: "production" },
  { nameKey: "nav.myPerformance", href: "/production/my-performance", icon: Trophy, permKey: "production" },
  { nameKey: "nav.productionTraceability", href: "/production/traceability", icon: GitBranch, permKey: "production" },
];