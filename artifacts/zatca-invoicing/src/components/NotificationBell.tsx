import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Bell, Sparkles } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Notification = {
  id: number; title: string; body: string;
  severity: "info" | "low" | "medium" | "high";
  category: string; sourceKey: string | null;
  isRead: boolean; createdAt: string;
};

const SEV_DOT: Record<string, string> = {
  high:   "bg-red-500",
  medium: "bg-amber-500",
  low:    "bg-blue-500",
  info:   "bg-slate-400",
};

export function NotificationBell() {
  const { token } = useAuth();
  const [, navigate] = useLocation();
  const headers = { Authorization: `Bearer ${token}` };

  // Poll every 30s for new notifications. Cheap COUNT query.
  const { data: countData } = useQuery({
    queryKey: ["notif-unread"],
    queryFn: async () => (await fetch(`${API}/api/notifications/unread-count`, { headers })).json(),
    refetchInterval: 30_000,
    enabled: !!token,
  });
  const unread = countData?.count ?? 0;

  const { data: listData } = useQuery({
    queryKey: ["notif-list-recent"],
    queryFn: async () => (await fetch(`${API}/api/notifications`, { headers })).json(),
    enabled: !!token,
  });
  const items: Notification[] = (listData?.notifications ?? []).slice(0, 8);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-muted-foreground hover:text-foreground relative"
          title="التنبيهات"
        >
          <Bell className="h-[18px] w-[18px]" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -end-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="px-3 py-2.5 border-b flex items-center justify-between">
          <span className="text-sm font-semibold">التنبيهات</span>
          <span className="text-xs text-muted-foreground">{unread} غير مقروء</span>
        </div>
        <div className="max-h-80 overflow-auto">
          {items.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-8">لا توجد تنبيهات</div>
          ) : items.map(n => (
            <button
              key={n.id}
              onClick={() => navigate("/notifications")}
              className={`w-full text-start px-3 py-2.5 border-b last:border-b-0 hover:bg-accent transition-colors flex items-start gap-2 ${
                !n.isRead ? "bg-violet-50/40" : ""
              }`}
            >
              <span className={`h-2 w-2 rounded-full mt-1.5 shrink-0 ${SEV_DOT[n.severity] || "bg-slate-400"}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 text-xs text-muted-foreground mb-0.5">
                  {n.category === "ai_diagnostic" && <Sparkles className="h-3 w-3 text-violet-500" />}
                  <span>{new Date(n.createdAt).toLocaleString("ar-SA")}</span>
                </div>
                <p className={`text-sm leading-snug truncate ${!n.isRead ? "font-semibold" : ""}`}>{n.title}</p>
              </div>
            </button>
          ))}
        </div>
        <Link href="/notifications" className="block px-3 py-2 text-center text-xs font-medium text-violet-700 hover:bg-violet-50 border-t">
          عرض كل التنبيهات
        </Link>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
