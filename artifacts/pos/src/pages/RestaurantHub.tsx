import { useLocation } from "wouter";
import { useEffect } from "react";
import { Utensils, Coffee, ChefHat, Receipt, AlertTriangle, Sparkles, LogOut, ChevronLeft, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clearAuth, getStoredUser, getToken } from "@/lib/api";

export default function RestaurantHub() {
  const [, setLocation] = useLocation();
  const user = getStoredUser();

  useEffect(() => {
    if (!getToken()) setLocation("/login");
  }, [setLocation]);

  const tiles = [
    { to: "/waiter",  label: "تطبيق النادل",   sub: "إدارة الطاولات والطلبات", icon: Utensils,      color: "from-amber-500 to-orange-600" },
    { to: "/kitchen", label: "شاشة المطبخ",   sub: "تذاكر المطبخ المباشرة",   icon: ChefHat,       color: "from-rose-500 to-red-600" },
    { to: "/pos",     label: "الكاشير",       sub: "إصدار الفواتير والتحصيل",  icon: Receipt,       color: "from-emerald-500 to-teal-600" },
    { to: "/super",   label: "السوبرماركت",   sub: "البيع بالباركود والميزان", icon: Coffee,        color: "from-sky-500 to-blue-600" },
    { to: "/restaurant-ai", label: "التحليلات الذكية", sub: "ساعات الذروة والتوصيات والمراقبة", icon: Sparkles, color: "from-fuchsia-500 to-pink-600" },
    { to: "/restaurant-settings", label: "الإعدادات", sub: "الطاولات والقائمة والفئات", icon: Settings, color: "from-violet-500 to-purple-600" },
  ];

  return (
    <div dir="rtl" className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      <header className="flex items-center justify-between p-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <Sparkles className="text-amber-400" />
          <div>
            <div className="font-bold text-lg">نظام نقاط البيع — المطعم / المقهى</div>
            <div className="text-xs text-white/60">{user?.company?.nameAr ?? user?.username}</div>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { clearAuth(); setLocation("/login"); }}>
          <LogOut className="h-4 w-4 ml-2" /> خروج
        </Button>
      </header>

      <main className="max-w-5xl mx-auto p-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {tiles.map(t => {
            const Icon = t.icon;
            return (
              <button
                key={t.to}
                onClick={() => setLocation(t.to)}
                className={`group relative overflow-hidden rounded-2xl p-6 text-right shadow-xl bg-gradient-to-br ${t.color} hover:scale-[1.02] transition`}
              >
                <Icon className="h-10 w-10 mb-3 opacity-90" />
                <div className="text-2xl font-bold">{t.label}</div>
                <div className="text-sm text-white/80 mt-1">{t.sub}</div>
                <ChevronLeft className="absolute left-4 bottom-4 opacity-70 group-hover:opacity-100" />
              </button>
            );
          })}
        </div>

        <div className="mt-8 p-4 rounded-xl bg-white/5 border border-white/10 flex items-center gap-3">
          <AlertTriangle className="text-amber-400" />
          <div className="text-sm text-white/80">
            للحصول على توصيات الذكاء الاصطناعي ومراقبة العمليات المشبوهة، افتح الكاشير ثم اضغط "تحليل ذكي".
          </div>
        </div>
      </main>
    </div>
  );
}
