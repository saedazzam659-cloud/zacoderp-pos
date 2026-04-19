import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, Building2, FileText, Users, Settings,
  Bell, Menu, Truck, LogOut, ChevronDown, ChevronRight, ShieldCheck,
  Package, Clock, Settings2, Link2, SlidersHorizontal, Sliders, BarChart3,
  Warehouse, Ruler, ArrowRightLeft, ClipboardList, BookOpen, BarChart2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuth } from "@/contexts/AuthContext";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface LayoutProps { children: React.ReactNode; }

// ─── Superadmin navigation ─────────────────────────────────────────────────────
const superAdminNav = [
  { name: "لوحة التحكم",       href: "/",                         icon: LayoutDashboard, exact: true },
  { name: "طلبات التسجيل",     href: "/admin/requests",            icon: Clock },
  { name: "إدارة الاشتراكات",  href: "/admin/subscriptions",       icon: Package },
  { name: "إعدادات الباقات",   href: "/admin/plans",               icon: Settings2 },
  { name: "صلاحيات القوائم",   href: "/admin/menu-permissions",    icon: SlidersHorizontal },
  { name: "الشركات",            href: "/companies",                 icon: Building2 },
];

// ─── Company user navigation ──────────────────────────────────────────────────
const companyNav = [
  { name: "لوحة التحكم", href: "/", icon: LayoutDashboard, exact: true },
];

const companyBusinessNav = [
  { name: "الفواتير",       href: "/invoices",         icon: FileText,  permKey: "invoices" },
  { name: "العملاء",        href: "/customers",        icon: Users,     permKey: "customers" },
  { name: "الموردون",       href: "/suppliers",        icon: Truck,     permKey: "suppliers" },
  { name: "الإقرار الضريبي", href: "/vat-declaration", icon: BarChart3, permKey: "reports" },
];

const companySystemNav = [
  { name: "ربط ZATCA",      href: "/zatca",             icon: Link2,    permKey: "zatca" },
  { name: "الإعدادات العامة", href: "/general-settings",  icon: Sliders,  permKey: "always" },
];

// Inventory module: header item (dashboard) + sub-items
const inventoryHeader = { name: "لوحة المخازن", href: "/inventory", icon: LayoutDashboard, exact: true, permKey: "inventory" };
const inventorySubNav = [
  { name: "الأصناف",              href: "/inventory/items",        icon: Package,           permKey: "inventory" },
  { name: "وحدات القياس",         href: "/inventory/units",        icon: Ruler,             permKey: "inventory" },
  { name: "المخازن",              href: "/inventory/warehouses",   icon: Warehouse,         permKey: "inventory" },
  { name: "التحويل بين المخازن",   href: "/inventory/transfers",    icon: ArrowRightLeft,    permKey: "inventory" },
  { name: "التسوية المخزنية",     href: "/inventory/adjustments",  icon: SlidersHorizontal, permKey: "inventory" },
  { name: "الجرد المخزني",        href: "/inventory/counts",       icon: ClipboardList,     permKey: "inventory" },
  { name: "دفتر الحركة",          href: "/inventory/ledger",       icon: BookOpen,          permKey: "inventory" },
  { name: "رصيد المخزون",         href: "/inventory/balance",      icon: BarChart2,         permKey: "inventory" },
];

// ─── Parse menu permissions ────────────────────────────────────────────────────
const DEFAULT_PERMS: Record<string, boolean> = {
  dashboard: true, invoices: true, customers: true, suppliers: true, zatca: true, reports: true, inventory: true,
};
function parseMenuPerms(raw: string | null | undefined): Record<string, boolean> {
  try { return { ...DEFAULT_PERMS, ...JSON.parse(raw ?? "{}") }; }
  catch { return { ...DEFAULT_PERMS }; }
}

// ─── Nav item ─────────────────────────────────────────────────────────────────
function NavItem({
  item, location, onClick, indent = false,
}: {
  item: any; location: string; onClick?: () => void; indent?: boolean;
}) {
  const isActive = item.exact
    ? location === item.href
    : location.startsWith(item.href) && item.href !== "/";
  return (
    <Link href={item.href} className="block" onClick={onClick}>
      <span className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all",
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

// ─── Collapsible inventory group ──────────────────────────────────────────────
function InventoryNavGroup({
  location, onNavigate, menuPerms,
}: {
  location: string; onNavigate: () => void; menuPerms: Record<string, boolean>;
}) {
  const isOnInventory = location.startsWith("/inventory");
  const [open, setOpen] = useState(isOnInventory);

  if (menuPerms.inventory === false) return null;

  const subItems = inventorySubNav.filter(i => menuPerms[i.permKey] !== false);

  return (
    <div>
      {/* Collapsible toggle header */}
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all",
          isOnInventory
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <Warehouse className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-right">موديل المخازن</span>
        {open
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
        }
      </button>

      {/* Expanded items */}
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          {/* Vertical guide line */}
          <div className="absolute top-0 bottom-0 right-7 w-px bg-sidebar-border" />

          {/* Dashboard (لوحة المخازن) */}
          <NavItem item={inventoryHeader} location={location} onClick={onNavigate} indent />

          {/* Sub items */}
          {subItems.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main layout ──────────────────────────────────────────────────────────────
export default function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isSuperAdmin = user?.role === "superadmin";

  const menuPerms = parseMenuPerms(user?.company?.menuPermissions);
  const filteredBusinessNav = companyBusinessNav.filter(item => menuPerms[item.permKey] !== false);
  const filteredSystemNav   = companySystemNav.filter(item => menuPerms[item.permKey] !== false);

  const PLAN_LABELS: Record<string, string> = {
    starter: "مبتدئ", professional: "احترافي", enterprise: "مؤسسي",
  };
  const planColor =
    user?.subscription?.plan === "starter"      ? "text-blue-700 bg-blue-50 border-blue-200" :
    user?.subscription?.plan === "professional" ? "text-primary bg-primary/10 border-primary/20" :
    user?.subscription?.plan === "enterprise"   ? "text-amber-700 bg-amber-50 border-amber-200" :
    "text-muted-foreground bg-muted border-border";

  const closeMobile = () => setMobileOpen(false);

  const SidebarContent = () => (
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
              <NavItem key={item.href} item={item} location={location} onClick={closeMobile} />
            ))}
          </div>
        ) : (
          <>
            {/* Dashboard */}
            {menuPerms.dashboard !== false && (
              <div className="space-y-0.5">
                {companyNav.map(item => (
                  <NavItem key={item.href} item={item} location={location} onClick={closeMobile} />
                ))}
              </div>
            )}

            {/* Business */}
            {filteredBusinessNav.length > 0 && (
              <div>
                <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">الأعمال</p>
                <div className="space-y-0.5">
                  {filteredBusinessNav.map(item => (
                    <NavItem key={item.href} item={item} location={location} onClick={closeMobile} />
                  ))}
                </div>
              </div>
            )}

            {/* Inventory — collapsible accordion */}
            {menuPerms.inventory !== false && (
              <div>
                <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">المخزون</p>
                <div className="space-y-0.5">
                  <InventoryNavGroup
                    location={location}
                    onNavigate={closeMobile}
                    menuPerms={menuPerms}
                  />
                </div>
              </div>
            )}

            {/* System */}
            {filteredSystemNav.length > 0 && (
              <div>
                <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">النظام</p>
                <div className="space-y-0.5">
                  {filteredSystemNav.map(item => (
                    <NavItem key={item.href} item={item} location={location} onClick={closeMobile} />
                  ))}
                </div>
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
                <AvatarFallback className={cn("text-xs font-bold", isSuperAdmin ? "bg-purple-100 text-purple-700" : "bg-primary text-primary-foreground")}>
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
            <DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive gap-2">
              <LogOut className="h-4 w-4" />تسجيل الخروج
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen w-full flex-col bg-background text-right" dir="rtl">
      {/* Desktop Sidebar */}
      <aside className="fixed inset-y-0 right-0 z-20 hidden w-64 flex-col border-l border-border bg-sidebar md:flex">
        <SidebarContent />
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={closeMobile} />}
      <aside className={cn(
        "fixed inset-y-0 right-0 z-40 flex w-72 flex-col border-l border-border bg-sidebar transition-transform duration-200 md:hidden",
        mobileOpen ? "translate-x-0" : "translate-x-full"
      )}>
        <SidebarContent />
      </aside>

      {/* Main content */}
      <div className="flex flex-col md:mr-64">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-4 border-b bg-background/95 backdrop-blur px-4 sm:px-6">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(true)}>
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex flex-1 items-center justify-end gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8"><Bell className="h-4 w-4" /></Button>
            <div className="h-5 w-px bg-border mx-1" />
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={logout} title="تسجيل الخروج">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6 md:p-8">{children}</main>
      </div>
    </div>
  );
}
