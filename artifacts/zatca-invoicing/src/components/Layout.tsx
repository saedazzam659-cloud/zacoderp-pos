import React, { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, Building2, FileText, Users, Settings,
  Bell, Menu, Truck, LogOut, ChevronDown, ChevronRight, ShieldCheck,
  Package, Clock, Settings2, Link2, SlidersHorizontal, Sliders, BarChart3,
  Warehouse, Ruler, ArrowRightLeft, ClipboardList, BookOpen, BarChart2,
  Tag, Layers, BookMarked, MapPin, Building2 as BranchIcon, DollarSign,
  TrendingUp, Scale, PieChart, ShoppingCart, CreditCard, RotateCcw, Banknote,
  Wallet, Landmark, ArrowDownCircle, ArrowUpCircle, ArrowLeftRight,
  Search, Home, HelpCircle, Plus, ChevronLeft,
  ShoppingBag, FileSignature,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuth } from "@/contexts/AuthContext";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// ─── Nav definitions ───────────────────────────────────────────────────────────
const superAdminNav = [
  { name: "لوحة التحكم",       href: "/",                         icon: LayoutDashboard, exact: true },
  { name: "طلبات التسجيل",     href: "/admin/requests",            icon: Clock },
  { name: "إدارة الاشتراكات",  href: "/admin/subscriptions",       icon: Package },
  { name: "إعدادات الباقات",   href: "/admin/plans",               icon: Settings2 },
  { name: "صلاحيات القوائم",   href: "/admin/menu-permissions",    icon: SlidersHorizontal },
  { name: "الشركات",            href: "/companies",                 icon: Building2 },
];
const companyBusinessNav: { name: string; href: string; icon: any; permKey?: string }[] = [];
const dashboardSubNav = [
  { name: "المناطق الجغرافية", href: "/org/regions",          icon: MapPin     },
  { name: "الفروع",            href: "/org/branches",         icon: BranchIcon },
  { name: "ربط ZATCA",         href: "/zatca",                 icon: Link2      },
  { name: "الإعدادات العامة",  href: "/general-settings",     icon: Sliders    },
  { name: "العملات والتحويل",  href: "/settings/currencies",  icon: DollarSign },
  { name: "الفواتير",          href: "/invoices",             icon: FileText   },
  { name: "الإقرار الضريبي",  href: "/vat-declaration",      icon: BarChart3  },
];

// ─── Purchasing Sub Nav ────────────────────────────────────────────────────────
const purchasingSubNav = [
  { name: "الموردون",                href: "/suppliers",                  icon: Truck        },
  { name: "مجموعات الموردين",        href: "/purchasing/supplier-groups", icon: Users        },
  { name: "الاعتمادات المستندية",    href: "/purchasing/lc",              icon: CreditCard   },
  { name: "فواتير المشتريات",        href: "/purchasing/invoices",        icon: ShoppingCart },
  { name: "مرتجعات المشتريات",      href: "/purchasing/returns",         icon: RotateCcw    },
  { name: "تسوية الموردين",          href: "/purchasing/settlements",     icon: Banknote     },
];
// ─── Sales Sub Nav ─────────────────────────────────────────────────────────────
const salesSubNav = [
  { name: "العملاء",              href: "/customers",          icon: Users           },
  { name: "عروض الأسعار",         href: "/sales/quotations",   icon: FileSignature   },
  { name: "فواتير المبيعات",      href: "/sales/invoices",     icon: ShoppingBag     },
  { name: "مرتجعات المبيعات",    href: "/sales/returns",      icon: RotateCcw       },
  { name: "تحصيل العملاء",        href: "/sales/settlements",  icon: ArrowDownCircle },
];
const companySystemNav: { name: string; href: string; icon: any; permKey?: string }[] = [];

// ─── Accounting Sub Nav ───────────────────────────────────────────────────────
const accountingSubNav = [
  { name: "شجرة الحسابات",    href: "/accounting/accounts", icon: BookMarked },
  { name: "القيود المحاسبية", href: "/accounting/journals", icon: BookOpen   },
];
const reportsSubNav = [
  { name: "كشف حساب",               href: "/accounting/reports/account-statement", icon: FileText    },
  { name: "ميزان المراجعة بالمجاميع", href: "/accounting/reports/trial-balance",     icon: Scale       },
  { name: "المركز المالي",           href: "/accounting/reports/balance-sheet",     icon: PieChart    },
  { name: "قائمة الدخل",            href: "/accounting/reports/income-statement",  icon: TrendingUp  },
];
// ─── Cash Sub Nav ─────────────────────────────────────────────────────────────
const cashSubNav = [
  { name: "الخزن",          href: "/cash/boxes",             icon: Wallet           },
  { name: "البنوك",          href: "/cash/banks",             icon: Landmark         },
  { name: "سندات القبض",    href: "/cash/receipt-vouchers",  icon: ArrowDownCircle  },
  { name: "سندات الصرف",    href: "/cash/payment-vouchers",  icon: ArrowUpCircle    },
  { name: "التحويلات",       href: "/cash/transfers",         icon: ArrowLeftRight   },
];

const inventoryHeader = { name: "لوحة المخازن", href: "/inventory", icon: LayoutDashboard, exact: true };
const inventorySubNav = [
  { name: "الأصناف",             href: "/inventory/items",            icon: Package           },
  { name: "مجموعات الأصناف",     href: "/inventory/item-groups",      icon: Tag               },
  { name: "وحدات القياس",        href: "/inventory/units",            icon: Ruler             },
  { name: "المخازن",             href: "/inventory/warehouses",       icon: Warehouse         },
  { name: "مجموعات المخازن",     href: "/inventory/warehouse-groups", icon: Layers            },
  { name: "التحويل بين المخازن",  href: "/inventory/transfers",        icon: ArrowRightLeft    },
  { name: "التسوية المخزنية",    href: "/inventory/adjustments",      icon: SlidersHorizontal },
  { name: "الجرد المخزني",       href: "/inventory/counts",           icon: ClipboardList     },
];

// ─── Inventory Reports Sub Nav ─────────────────────────────────────────────────
const inventoryReportsHeader = { name: "كل التقارير", href: "/inventory/reports", icon: LayoutDashboard, exact: true };
const inventoryReportsSubNav = [
  { name: "رصيد المخزون",            href: "/inventory/reports/stock-balance", icon: BarChart2     },
  { name: "دفتر حركة المخزون",        href: "/inventory/reports/stock-ledger",  icon: BookOpen      },
  { name: "كارت الصنف",               href: "/inventory/reports/item-card",     icon: ClipboardList },
  { name: "الأصناف منخفضة المخزون",   href: "/inventory/reports/low-stock",     icon: SlidersHorizontal },
  { name: "تقييم المخزون حسب المخزن", href: "/inventory/reports/valuation",     icon: Wallet        },
  { name: "الأصناف الراكدة",          href: "/inventory/reports/slow-moving",   icon: Layers        },
];

// ─── CashNavGroup ──────────────────────────────────────────────────────────────
function CashNavGroup({
  location, onNavigate, open, onToggle,
}: { location: string; onNavigate: () => void; open: boolean; onToggle: () => void }) {
  const isOnCash = location.startsWith("/cash");
  return (
    <div>
      <button onClick={onToggle} className={cn("w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors", isOnCash && !open ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm" : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground")}>
        <Wallet className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-right">النقد والبنوك</span>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />}
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 right-[26px] w-px bg-sidebar-border/60" />
          {cashSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
const DEFAULT_PERMS: Record<string, boolean> = {
  dashboard: true, invoices: true, customers: true, suppliers: true,
  zatca: true, reports: true, inventory: true,
};
function parseMenuPerms(raw: string | null | undefined): Record<string, boolean> {
  try { return { ...DEFAULT_PERMS, ...JSON.parse(raw ?? "{}") }; }
  catch { return { ...DEFAULT_PERMS }; }
}
const PLAN_LABELS: Record<string, string> = {
  starter: "مبتدئ", professional: "احترافي", enterprise: "مؤسسي",
};

// ─── NavItem (stable, top-level component) ─────────────────────────────────────
function NavItem({
  item, location, onClick, indent = false,
}: {
  item: { name: string; href: string; icon: React.ElementType; exact?: boolean };
  location: string;
  onClick?: () => void;
  indent?: boolean;
}) {
  const isActive = item.exact
    ? location === item.href
    : location.startsWith(item.href) && item.href !== "/";
  return (
    <Link href={item.href} className="block" onClick={onClick}>
      <span className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        indent && "pr-8",
        isActive
          ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}>
        <item.icon className="h-4 w-4 shrink-0" />
        {item.name}
      </span>
    </Link>
  );
}

// ─── PurchasingNavGroup ────────────────────────────────────────────────────────
function PurchasingNavGroup({
  location, onNavigate, open, onToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const isOnPurchasing = location.startsWith("/purchasing") || location.startsWith("/suppliers");
  return (
    <div>
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isOnPurchasing && !open
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <ShoppingCart className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-right">الموردون والمشتريات</span>
        {open
          ? <ChevronDown  className="h-3.5 w-3.5 shrink-0 opacity-60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
        }
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 right-[26px] w-px bg-sidebar-border/60" />
          {purchasingSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SalesNavGroup ─────────────────────────────────────────────────────────────
function SalesNavGroup({
  location, onNavigate, open, onToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const isOnSales = location.startsWith("/sales") || location.startsWith("/customers");
  return (
    <div>
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isOnSales && !open
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <ShoppingBag className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-right">العملاء والمبيعات</span>
        {open
          ? <ChevronDown  className="h-3.5 w-3.5 shrink-0 opacity-60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
        }
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 right-[26px] w-px bg-sidebar-border/60" />
          {salesSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── InventoryNavGroup (stable, top-level component) ──────────────────────────
function InventoryNavGroup({
  location, onNavigate, open, onToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const isOnInventory = location.startsWith("/inventory") && !location.startsWith("/inventory/reports");
  return (
    <div>
      {/* Toggle button */}
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isOnInventory && !open
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <Warehouse className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-right">موديل المخازن</span>
        {open
          ? <ChevronDown  className="h-3.5 w-3.5 shrink-0 opacity-60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
        }
      </button>

      {/* Sub-items */}
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 right-[26px] w-px bg-sidebar-border/60" />
          <NavItem item={inventoryHeader} location={location} onClick={onNavigate} indent />
          {inventorySubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── InventoryReportsNavGroup ─────────────────────────────────────────────────
function InventoryReportsNavGroup({
  location, onNavigate, open, onToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const isOnReports = location.startsWith("/inventory/reports");
  return (
    <div>
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isOnReports && !open
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <BarChart2 className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-right">تقارير المخازن</span>
        {open
          ? <ChevronDown  className="h-3.5 w-3.5 shrink-0 opacity-60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />}
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 right-[26px] w-px bg-sidebar-border/60" />
          <NavItem item={inventoryReportsHeader} location={location} onClick={onNavigate} indent />
          {inventoryReportsSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ReportsNavGroup ───────────────────────────────────────────────────────────
function ReportsNavGroup({
  location, onNavigate, open, onToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const isOnReports = location.startsWith("/accounting/reports");
  return (
    <div>
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isOnReports && !open
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <BarChart2 className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-right">التقارير المحاسبية</span>
        {open
          ? <ChevronDown  className="h-3.5 w-3.5 shrink-0 opacity-60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
        }
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 right-[26px] w-px bg-sidebar-border/60" />
          {reportsSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── DashboardNavGroup ─────────────────────────────────────────────────────────
function DashboardNavGroup({
  location, onNavigate, open, onToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const isActive = location === "/";
  const isOnSub  = dashboardSubNav.some(i => location.startsWith(i.href) && i.href !== "/");
  return (
    <div>
      <div className={cn(
        "flex items-center rounded-lg transition-colors",
        (isActive || (isOnSub && !open))
          ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}>
        <Link href="/" className="flex items-center gap-3 flex-1 px-3 py-2 text-sm font-medium" onClick={onNavigate}>
          <LayoutDashboard className="h-4 w-4 shrink-0" />
          <span>لوحة التحكم</span>
        </Link>
        <button onClick={onToggle} className="px-2 py-2 rounded-lg" title="عرض القائمة الفرعية">
          {open
            ? <ChevronDown  className="h-3.5 w-3.5 shrink-0 opacity-60" />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
          }
        </button>
      </div>
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 right-[26px] w-px bg-sidebar-border/60" />
          {dashboardSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── AccountingNavGroup ───────────────────────────────────────────────────────
function AccountingNavGroup({
  location, onNavigate, open, onToggle,
}: { location: string; onNavigate: () => void; open: boolean; onToggle: () => void }) {
  const isOnSub = accountingSubNav.some(i => location.startsWith(i.href));
  return (
    <div>
      <button onClick={onToggle} className={cn(
        "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        isOnSub && !open
          ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}>
        <BookMarked className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-right">الحسابات العامة</span>
        {open
          ? <ChevronDown  className="h-3.5 w-3.5 shrink-0 opacity-60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />}
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 right-[26px] w-px bg-sidebar-border/60" />
          {accountingSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SidebarInner (stable, top-level component) ───────────────────────────────
// All state that needs to persist lives in Layout and is passed as props here.
function SidebarInner({
  location,
  isSuperAdmin,
  user,
  menuPerms,
  dashboardOpen,
  onDashboardToggle,
  inventoryOpen,
  onInventoryToggle,
  invReportsOpen,
  onInvReportsToggle,
  reportsOpen,
  onReportsToggle,
  purchasingOpen,
  onPurchasingToggle,
  salesOpen,
  onSalesToggle,
  cashOpen,
  onCashToggle,
  accountingOpen,
  onAccountingToggle,
  onNavigate,
  onLogout,
}: {
  location: string;
  isSuperAdmin: boolean;
  user: any;
  menuPerms: Record<string, boolean>;
  dashboardOpen: boolean;
  onDashboardToggle: () => void;
  inventoryOpen: boolean;
  onInventoryToggle: () => void;
  invReportsOpen: boolean;
  onInvReportsToggle: () => void;
  reportsOpen: boolean;
  onReportsToggle: () => void;
  purchasingOpen: boolean;
  onPurchasingToggle: () => void;
  salesOpen: boolean;
  onSalesToggle: () => void;
  cashOpen: boolean;
  onCashToggle: () => void;
  accountingOpen: boolean;
  onAccountingToggle: () => void;
  onNavigate: () => void;
  onLogout: () => void;
}) {
  const filteredBusiness = companyBusinessNav.filter(i => !i.permKey || menuPerms[i.permKey] !== false);
  const filteredSystem   = companySystemNav.filter(i => !i.permKey || menuPerms[i.permKey] !== false);

  const planColor =
    user?.subscription?.plan === "starter"      ? "text-blue-700 bg-blue-50 border-blue-200" :
    user?.subscription?.plan === "professional" ? "text-primary bg-primary/10 border-primary/20" :
    user?.subscription?.plan === "enterprise"   ? "text-amber-700 bg-amber-50 border-amber-200" :
    "text-muted-foreground bg-muted border-border";

  return (
    <>
      {/* Logo */}
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-sidebar-border px-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm shadow">Z</div>
          <div>
            <p className="text-sm font-bold text-sidebar-foreground leading-tight">نظام الفاتورة</p>
            <p className="text-[10px] text-sidebar-foreground/50 leading-tight">ZATCA e-Invoicing</p>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-1 text-[10px] text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
          <ShieldCheck className="h-2.5 w-2.5" /><span>ZATCA</span>
        </div>
      </div>

      {/* Context badge */}
      {isSuperAdmin ? (
        <div className="mx-3 mt-3 mb-1 rounded-lg border bg-purple-50 border-purple-200 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-purple-600 shrink-0" />
            <span className="text-xs font-semibold text-purple-800">لوحة المشرف العام</span>
          </div>
          <p className="text-[10px] text-purple-600 mt-0.5">إدارة الشركات والطلبات</p>
        </div>
      ) : user?.company ? (
        <div className="mx-3 mt-3 mb-1 rounded-lg border bg-sidebar-accent/40 px-3 py-2.5">
          <div className="flex items-center gap-2 mb-0.5">
            <Building2 className="h-3.5 w-3.5 text-sidebar-foreground/60 shrink-0" />
            <span className="text-xs font-semibold text-sidebar-foreground truncate">{user.company.nameAr}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-sidebar-foreground/50 truncate">{user.company.vatNumber}</span>
            {user.subscription?.plan && (
              <span className={cn("text-[10px] border rounded-full px-1.5 py-0 font-medium shrink-0", planColor)}>
                {PLAN_LABELS[user.subscription.plan] ?? user.subscription.plan}
              </span>
            )}
          </div>
        </div>
      ) : null}

      {/* Navigation */}
      <nav className="flex-1 px-3 py-2 space-y-4 overflow-y-auto">
        {isSuperAdmin ? (
          <div className="space-y-0.5">
            {superAdminNav.map(item => (
              <NavItem key={item.href} item={item} location={location} onClick={onNavigate} />
            ))}
          </div>
        ) : (
          <>
            {menuPerms.dashboard !== false && (
              <div className="space-y-0.5">
                <DashboardNavGroup
                  location={location}
                  onNavigate={onNavigate}
                  open={dashboardOpen}
                  onToggle={onDashboardToggle}
                />
              </div>
            )}

            {menuPerms.inventory !== false && (
              <div className="space-y-0.5">
                <InventoryNavGroup
                  location={location}
                  onNavigate={onNavigate}
                  open={inventoryOpen}
                  onToggle={onInventoryToggle}
                />
              </div>
            )}

            {menuPerms.inventory !== false && (
              <div className="space-y-0.5">
                <InventoryReportsNavGroup
                  location={location}
                  onNavigate={onNavigate}
                  open={invReportsOpen}
                  onToggle={onInvReportsToggle}
                />
              </div>
            )}

            <div className="space-y-0.5">
              <SalesNavGroup
                location={location}
                onNavigate={onNavigate}
                open={salesOpen}
                onToggle={onSalesToggle}
              />
            </div>

            <div className="space-y-0.5">
              <PurchasingNavGroup
                location={location}
                onNavigate={onNavigate}
                open={purchasingOpen}
                onToggle={onPurchasingToggle}
              />
            </div>

            <div className="space-y-0.5">
              <CashNavGroup
                location={location}
                onNavigate={onNavigate}
                open={cashOpen}
                onToggle={onCashToggle}
              />
            </div>

            <div className="space-y-0.5">
              <AccountingNavGroup
                location={location}
                onNavigate={onNavigate}
                open={accountingOpen}
                onToggle={onAccountingToggle}
              />
            </div>

            <div className="space-y-0.5">
              <ReportsNavGroup
                location={location}
                onNavigate={onNavigate}
                open={reportsOpen}
                onToggle={onReportsToggle}
              />
            </div>

            {filteredBusiness.length > 0 && (
              <div className="space-y-0.5">
                {filteredBusiness.map(item => (
                  <NavItem key={item.href} item={item} location={location} onClick={onNavigate} />
                ))}
              </div>
            )}

            {filteredSystem.length > 0 && (
              <div className="space-y-0.5">
                {filteredSystem.map(item => (
                  <NavItem key={item.href} item={item} location={location} onClick={onNavigate} />
                ))}
              </div>
            )}
          </>
        )}
      </nav>

      {/* User footer */}
      <div className="border-t border-sidebar-border p-3">
        {!isSuperAdmin && user?.subscription && (
          <div className="mb-2 flex items-center gap-2 px-2 py-1.5 rounded-md bg-sidebar-accent/30 text-xs text-sidebar-foreground/60">
            <Package className="h-3 w-3 shrink-0" />
            <span>ينتهي: {user.subscription.endDate ? new Date(user.subscription.endDate).toLocaleDateString("ar-SA") : "—"}</span>
          </div>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-3 rounded-lg px-2 py-2 hover:bg-sidebar-accent transition-colors text-right">
              <Avatar className="h-8 w-8 shrink-0">
                <AvatarFallback className={cn(
                  "text-xs font-bold",
                  isSuperAdmin ? "bg-purple-100 text-purple-700" : "bg-primary text-primary-foreground"
                )}>
                  {user?.username?.[0]?.toUpperCase() ?? "م"}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0 text-right">
                <p className="text-sm font-medium text-sidebar-foreground truncate">{user?.username ?? "مستخدم"}</p>
                <p className="text-xs text-sidebar-foreground/50 truncate">
                  {isSuperAdmin ? "مشرف عام" : user?.role === "admin" ? "مدير" : "مستخدم"}
                </p>
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-sidebar-foreground/40 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-52">
            <DropdownMenuLabel className="font-normal">
              <div>
                <p className="text-sm font-medium">{user?.username}</p>
                <p className="text-xs text-muted-foreground">
                  {isSuperAdmin ? "مشرف عام" : user?.role === "admin" ? "مدير الشركة" : "مستخدم"}
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="gap-2 cursor-pointer">
              <Link href="/settings">
                <Settings className="h-4 w-4" />إعدادات الحساب
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onLogout} className="text-destructive focus:text-destructive gap-2">
              <LogOut className="h-4 w-4" />تسجيل الخروج
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

// ─── Breadcrumb Resolver ──────────────────────────────────────────────────────
// Build a complete map of href → { label, parent } from all nav definitions
type CrumbInfo = { label: string; parent?: string };
const ROUTE_MAP: Record<string, CrumbInfo> = (() => {
  const map: Record<string, CrumbInfo> = {
    "/":                              { label: "لوحة التحكم" },
    "/companies":                     { label: "الشركات" },
    "/customers":                     { label: "العملاء" },
    "/customers/new":                 { label: "عميل جديد",       parent: "/customers" },
    "/suppliers/new":                 { label: "مورد جديد",       parent: "/suppliers" },
    "/invoices/new":                  { label: "فاتورة جديدة",    parent: "/invoices" },
    "/settings":                      { label: "الإعدادات" },
    "/admin/requests":                { label: "طلبات التسجيل" },
    "/admin/subscriptions":           { label: "إدارة الاشتراكات" },
    "/admin/plans":                   { label: "إعدادات الباقات" },
    "/admin/menu-permissions":        { label: "صلاحيات القوائم" },
    // Section roots (parents for sub items)
    "/inventory":                     { label: "المخزون" },
    "/cash":                          { label: "النقد والبنوك" },
    "/purchasing":                    { label: "الموردون والمشتريات" },
    "/sales":                         { label: "العملاء والمبيعات" },
    "/sales/invoices/new":            { label: "فاتورة مبيعات جديدة", parent: "/sales/invoices" },
    "/sales/quotations/new":          { label: "عرض سعر جديد",        parent: "/sales/quotations" },
    "/accounting":                    { label: "المحاسبة" },
    "/accounting/reports":            { label: "التقارير المحاسبية", parent: "/accounting" },
    "/org":                           { label: "إعدادات الشركة" },
  };
  const all = [
    ...dashboardSubNav,
    ...purchasingSubNav.map(i => ({ ...i, parent: "/purchasing" })),
    ...salesSubNav.map(i => ({ ...i, parent: "/sales" })),
    ...companySystemNav.map(i => ({ ...i, parent: "/accounting" })),
    ...reportsSubNav.map(i => ({ ...i, parent: "/accounting/reports" })),
    ...cashSubNav.map(i => ({ ...i, parent: "/cash" })),
    inventoryHeader,
    ...inventorySubNav.map(i => ({ ...i, parent: "/inventory" })),
    ...companyBusinessNav,
  ];
  for (const item of all) {
    map[item.href] = {
      label: item.name,
      parent: (item as any).parent,
    };
  }
  return map;
})();

function getBreadcrumbs(location: string): { label: string; href?: string }[] {
  // Try exact match first, then progressively trim segments
  const tryPaths: string[] = [];
  if (location === "/") return [{ label: "لوحة التحكم" }];
  let current: string | undefined = location;
  // Find longest matching prefix in ROUTE_MAP
  while (current && current !== "/") {
    if (ROUTE_MAP[current]) { tryPaths.unshift(current); break; }
    const idx = current.lastIndexOf("/");
    current = idx > 0 ? current.slice(0, idx) : "/";
  }
  // Walk up via parent chain
  const chain: string[] = [];
  let cursor: string | undefined = tryPaths[0];
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    chain.unshift(cursor);
    cursor = ROUTE_MAP[cursor]?.parent;
  }
  const crumbs: { label: string; href?: string }[] = [{ label: "الرئيسية", href: "/" }];
  for (let i = 0; i < chain.length; i++) {
    const path = chain[i];
    const info = ROUTE_MAP[path];
    if (!info) continue;
    crumbs.push({
      label: info.label,
      href: i === chain.length - 1 ? undefined : path,
    });
  }
  // If nothing matched, fall back to a generic crumb
  if (crumbs.length === 1) crumbs.push({ label: "صفحة" });
  return crumbs;
}

// ─── TopBar (Odoo-style header) ───────────────────────────────────────────────
function TopBar({
  location, user, isSuperAdmin, onMobileMenu, onLogout,
}: {
  location: string;
  user: any;
  isSuperAdmin: boolean;
  onMobileMenu: () => void;
  onLogout: () => void;
}) {
  const crumbs = useMemo(() => getBreadcrumbs(location), [location]);
  const currentLabel = crumbs[crumbs.length - 1]?.label ?? "";

  return (
    <header className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      {/* Row 1: search + actions */}
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
        <Button
          variant="ghost" size="icon" className="md:hidden -mr-2"
          onClick={onMobileMenu}
        >
          <Menu className="h-5 w-5" />
        </Button>

        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            type="search"
            placeholder="بحث سريع..."
            className="h-9 pr-9 pl-3 bg-muted/40 border-transparent focus-visible:bg-card focus-visible:border-input"
          />
        </div>

        <div className="flex-1" />

        {/* Right cluster */}
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-foreground" title="المساعدة">
            <HelpCircle className="h-[18px] w-[18px]" />
          </Button>
          <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-foreground relative" title="الإشعارات">
            <Bell className="h-[18px] w-[18px]" />
            <span className="absolute top-1.5 left-2 h-1.5 w-1.5 rounded-full bg-primary" />
          </Button>
          <div className="h-5 w-px bg-border mx-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-accent transition-colors">
                <Avatar className="h-7 w-7">
                  <AvatarFallback className={cn(
                    "text-[11px] font-bold",
                    isSuperAdmin ? "bg-purple-100 text-purple-700" : "bg-primary text-primary-foreground"
                  )}>
                    {user?.username?.[0]?.toUpperCase() ?? "م"}
                  </AvatarFallback>
                </Avatar>
                <div className="hidden lg:block text-right">
                  <p className="text-xs font-medium leading-tight">{user?.username ?? "مستخدم"}</p>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    {isSuperAdmin ? "مشرف عام" : user?.role === "admin" ? "مدير" : "مستخدم"}
                  </p>
                </div>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground hidden lg:block" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="font-normal">
                <div>
                  <p className="text-sm font-medium">{user?.username}</p>
                  <p className="text-xs text-muted-foreground">
                    {isSuperAdmin ? "مشرف عام" : user?.role === "admin" ? "مدير الشركة" : "مستخدم"}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild className="gap-2 cursor-pointer">
                <Link href="/settings">
                  <Settings className="h-4 w-4" />إعدادات الحساب
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onLogout} className="text-destructive focus:text-destructive gap-2">
                <LogOut className="h-4 w-4" />تسجيل الخروج
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Row 2: breadcrumb + page title */}
      <div className="flex items-center gap-3 px-4 sm:px-6 py-2.5 border-t border-border/60 bg-muted/20">
        <nav className="flex items-center gap-1.5 text-xs flex-1 min-w-0 overflow-hidden">
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <React.Fragment key={`${c.label}-${i}`}>
                {i > 0 && <ChevronLeft className="h-3 w-3 text-muted-foreground/50 shrink-0" />}
                {c.href && !isLast ? (
                  <Link
                    href={c.href}
                    className="text-muted-foreground hover:text-foreground transition-colors truncate"
                  >
                    {i === 0 ? <Home className="h-3.5 w-3.5 inline -mt-0.5" /> : c.label}
                  </Link>
                ) : (
                  <span className={cn(
                    "truncate",
                    isLast ? "font-semibold text-foreground" : "text-muted-foreground"
                  )}>
                    {i === 0 && !isLast ? <Home className="h-3.5 w-3.5 inline -mt-0.5" /> : c.label}
                  </span>
                )}
              </React.Fragment>
            );
          })}
        </nav>
        <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-md bg-card border border-border/60 text-muted-foreground shrink-0">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          متصل
        </span>
      </div>
    </header>
  );
}

// ─── Main Layout ───────────────────────────────────────────────────────────────
export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen]           = useState(false);
  const [dashboardOpen, setDashboardOpen]     = useState(() =>
    location === "/" ||
    ["/org/", "/zatca", "/general-settings", "/settings/currencies", "/invoices", "/vat-declaration"].some(p => location.startsWith(p))
  );
  const [inventoryOpen, setInventoryOpen]     = useState(() => location.startsWith("/inventory") && !location.startsWith("/inventory/reports"));
  const [invReportsOpen, setInvReportsOpen]   = useState(() => location.startsWith("/inventory/reports"));
  const [reportsOpen, setReportsOpen]         = useState(() => location.startsWith("/accounting/reports"));
  const [purchasingOpen, setPurchasingOpen]   = useState(() => location.startsWith("/purchasing") || location.startsWith("/suppliers"));
  const [salesOpen,      setSalesOpen]        = useState(() => location.startsWith("/sales") || location.startsWith("/customers"));
  const [cashOpen,       setCashOpen]         = useState(() => location.startsWith("/cash"));
  const [accountingOpen, setAccountingOpen]   = useState(() => location.startsWith("/accounting/accounts") || location.startsWith("/accounting/journals"));

  const isSuperAdmin = user?.role === "superadmin";
  const menuPerms    = parseMenuPerms(user?.company?.menuPermissions);

  const handleDashboardToggle  = () => setDashboardOpen(v => !v);
  const handleInventoryToggle  = () => setInventoryOpen(v => !v);
  const handleInvReportsToggle = () => setInvReportsOpen(v => !v);
  const handleReportsToggle    = () => setReportsOpen(v => !v);
  const handlePurchasingToggle = () => setPurchasingOpen(v => !v);
  const handleSalesToggle      = () => setSalesOpen(v => !v);
  const handleCashToggle       = () => setCashOpen(v => !v);
  const handleAccountingToggle = () => setAccountingOpen(v => !v);
  const closeMobile = () => setMobileOpen(false);

  const sharedProps = {
    location,
    isSuperAdmin,
    user,
    menuPerms,
    dashboardOpen,
    onDashboardToggle: handleDashboardToggle,
    inventoryOpen,
    onInventoryToggle: handleInventoryToggle,
    invReportsOpen,
    onInvReportsToggle: handleInvReportsToggle,
    reportsOpen,
    onReportsToggle: handleReportsToggle,
    purchasingOpen,
    onPurchasingToggle: handlePurchasingToggle,
    salesOpen,
    onSalesToggle: handleSalesToggle,
    cashOpen,
    onCashToggle: handleCashToggle,
    accountingOpen,
    onAccountingToggle: handleAccountingToggle,
    onNavigate: closeMobile,
    onLogout: logout,
  };

  return (
    <div className="flex min-h-screen w-full flex-col bg-background text-right" dir="rtl">
      {/* Desktop Sidebar */}
      <aside className="fixed inset-y-0 right-0 z-20 hidden w-64 flex-col border-l border-border bg-sidebar md:flex">
        <SidebarInner {...sharedProps} />
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={closeMobile} />
      )}
      <aside className={cn(
        "fixed inset-y-0 right-0 z-40 flex w-72 flex-col border-l border-border bg-sidebar transition-transform duration-200 md:hidden",
        mobileOpen ? "translate-x-0" : "translate-x-full"
      )}>
        <SidebarInner {...sharedProps} />
      </aside>

      {/* Main content */}
      <div className="flex flex-col md:mr-64 min-h-screen">
        <TopBar
          location={location}
          user={user}
          isSuperAdmin={isSuperAdmin}
          onMobileMenu={() => setMobileOpen(true)}
          onLogout={logout}
        />
        <main className="flex-1 p-4 sm:p-6 md:p-8 bg-muted/30">{children}</main>
      </div>
    </div>
  );
}
