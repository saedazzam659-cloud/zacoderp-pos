import { Link, useLocation } from "wouter";
import { 
  Home, 
  CalendarDays, 
  FileText, 
  User, 
  CreditCard,
  Building2
} from "lucide-react";
import { cn } from "@/lib/utils";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "الرئيسية", icon: Home },
    { href: "/attendance", label: "الحضور", icon: CalendarDays },
    { href: "/requests", label: "الطلبات", icon: FileText },
    { href: "/payslips", label: "الرواتب", icon: CreditCard },
    { href: "/profile", label: "حسابي", icon: User },
  ];

  return (
    <div className="min-h-[100dvh] bg-muted/30 pb-20 md:pb-0 md:pe-64">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex flex-col w-64 fixed top-0 end-0 h-full border-s bg-card z-50">
        <div className="p-6 flex items-center gap-3 border-b border-border/50">
          <div className="bg-primary/10 text-primary p-2 rounded-xl">
            <Building2 className="w-6 h-6" />
          </div>
          <div>
            <h1 className="font-bold text-lg leading-none">ZacodeHR</h1>
            <p className="text-xs text-muted-foreground mt-1">بوابة الموظف</p>
          </div>
        </div>
        <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 rounded-xl transition-colors",
                  isActive 
                    ? "bg-primary text-primary-foreground font-medium shadow-sm" 
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <item.icon className="w-5 h-5" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto w-full p-4 md:p-8 animate-in fade-in duration-300">
        {children}
      </main>

      {/* Mobile Bottom Nav */}
      <nav className="md:hidden fixed bottom-0 start-0 end-0 bg-card border-t z-50 flex items-center justify-around px-2 pb-safe pt-2">
        {navItems.map((item) => {
          const isActive = location === item.href;
          return (
            <Link 
              key={item.href} 
              href={item.href}
              className={cn(
                "flex flex-col items-center justify-center w-full py-2 gap-1 transition-colors relative",
                isActive ? "text-primary" : "text-muted-foreground"
              )}
            >
              <item.icon className={cn("w-6 h-6", isActive && "fill-primary/20")} strokeWidth={isActive ? 2.5 : 2} />
              <span className="text-[10px] font-medium">{item.label}</span>
              {isActive && (
                <span className="absolute top-0 w-8 h-1 bg-primary rounded-b-full shadow-[0_0_8px_rgba(var(--primary),0.5)]" />
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
