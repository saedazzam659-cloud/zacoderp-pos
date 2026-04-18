import React from "react";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  Building2, 
  FileText, 
  Users, 
  Settings,
  Bell,
  Search,
  Menu
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface LayoutProps {
  children: React.ReactNode;
}

const navigation = [
  { name: "لوحة التحكم", nameEn: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "الشركات", nameEn: "Companies", href: "/companies", icon: Building2 },
  { name: "الفواتير", nameEn: "Invoices", href: "/invoices", icon: FileText },
  { name: "العملاء", nameEn: "Customers", href: "/customers", icon: Users },
];

export default function Layout({ children }: LayoutProps) {
  const [location] = useLocation();

  return (
    <div className="flex min-h-screen w-full flex-col bg-background text-right" dir="rtl">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 right-0 z-20 hidden w-64 flex-col border-l border-border bg-sidebar md:flex">
        <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-6">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold">
              Z
            </div>
            <span className="text-lg font-bold text-sidebar-foreground">نظام الفاتورة</span>
          </div>
        </div>
        <nav className="flex-1 space-y-1 p-4">
          {navigation.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link key={item.name} href={item.href} className="block">
                <span
                  className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-sidebar-primary text-sidebar-primary-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  }`}
                >
                  <item.icon className="h-5 w-5" />
                  {item.name}
                </span>
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-sidebar-border p-4">
          <div className="flex items-center gap-3">
            <Avatar>
              <AvatarImage src="" />
              <AvatarFallback>م</AvatarFallback>
            </Avatar>
            <div className="flex flex-col">
              <span className="text-sm font-medium">مدير النظام</span>
              <span className="text-xs text-muted-foreground">admin@zatca.sa</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-col md:mr-64">
        <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-4 border-b bg-background px-4 sm:px-6">
          <Button variant="ghost" size="icon" className="md:hidden">
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex flex-1 items-center justify-end gap-4">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon">
                <Bell className="h-5 w-5" />
              </Button>
              <Button variant="ghost" size="icon">
                <Settings className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6 md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
