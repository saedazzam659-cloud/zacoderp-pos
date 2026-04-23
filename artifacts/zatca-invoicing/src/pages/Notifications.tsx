import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Bell, Sparkles, Check, AlertCircle, AlertTriangle, Info } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Notification = {
  id: number; title: string; body: string;
  severity: "info" | "low" | "medium" | "high";
  category: string; sourceKey: string | null;
  isRead: boolean; createdAt: string;
};

const SEV: Record<string, { bg: string; border: string; text: string; icon: any; label: string }> = {
  high:   { bg: "bg-red-50",    border: "border-red-200",    text: "text-red-800",    icon: AlertCircle,   label: "خطورة عالية" },
  medium: { bg: "bg-amber-50",  border: "border-amber-200",  text: "text-amber-900",  icon: AlertTriangle, label: "خطورة متوسطة" },
  low:    { bg: "bg-blue-50",   border: "border-blue-200",   text: "text-blue-900",   icon: Info,          label: "خطورة منخفضة" },
  info:   { bg: "bg-slate-50",  border: "border-slate-200",  text: "text-slate-800",  icon: Info,          label: "للعلم" },
};

function renderMarkdown(md: string) {
  const html = md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, '<h3 class="font-bold text-base mt-3 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2 class="font-bold text-lg mt-4 mb-2">$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1 class="font-bold text-xl mt-4 mb-2">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^\s*\d+\.\s+(.+)$/gm, '<li class="ml-5 list-decimal">$1</li>')
    .replace(/^\s*[-*]\s+(.+)$/gm,  '<li class="ml-5 list-disc">$1</li>')
    .replace(/\n\n/g, '<br/><br/>');
  return { __html: html };
}

export default function Notifications() {
  const { token } = useAuth();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const { data, isLoading } = useQuery({
    queryKey: ["notif-list-full"],
    queryFn: async () => (await fetch(`${API}/api/notifications`, { headers })).json(),
  });
  const items: Notification[] = data?.notifications ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["notif-list-full"] });
    qc.invalidateQueries({ queryKey: ["notif-list-recent"] });
    qc.invalidateQueries({ queryKey: ["notif-unread"] });
  };

  const readMut = useMutation({
    mutationFn: async (id: number) => (await fetch(`${API}/api/notifications/${id}/read`, { method: "POST", headers })).json(),
    onSuccess: invalidate,
  });
  const readAllMut = useMutation({
    mutationFn: async () => (await fetch(`${API}/api/notifications/read-all`, { method: "POST", headers })).json(),
    onSuccess: invalidate,
  });

  const unreadCount = items.filter(n => !n.isRead).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bell className="h-6 w-6 text-violet-600" />
            التنبيهات
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            تنبيهات النظام والمشاكل المكتشفة في بيانات الشركة مع توصيات الحل.
          </p>
        </div>
        {unreadCount > 0 && (
          <Button variant="outline" size="sm" onClick={() => readAllMut.mutate()} disabled={readAllMut.isPending}>
            <Check className="h-4 w-4 me-1.5" />
            تعليم الكل كمقروء
          </Button>
        )}
      </div>

      {isLoading ? (
        <Card><CardContent className="pt-6 text-center text-sm text-muted-foreground">جارٍ التحميل...</CardContent></Card>
      ) : items.length === 0 ? (
        <Card><CardContent className="pt-8 pb-8 text-center text-sm text-muted-foreground">
          <Bell className="h-10 w-10 mx-auto mb-2 opacity-30" />
          لا توجد تنبيهات حتى الآن
        </CardContent></Card>
      ) : (
        <div className="space-y-2.5">
          {items.map(n => {
            const sev = SEV[n.severity] || SEV.info;
            const Icon = sev.icon;
            return (
              <Card key={n.id} className={`${sev.border} ${!n.isRead ? "ring-1 ring-violet-200" : ""}`}>
                <CardContent className="pt-4">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${sev.text}`} />
                      <div className="min-w-0">
                        <h3 className={`text-base font-semibold ${sev.text}`}>{n.title}</h3>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                          {n.category === "ai_diagnostic" && (
                            <span className="inline-flex items-center gap-1 text-violet-700">
                              <Sparkles className="h-3 w-3" /> توصية ذكاء اصطناعي
                            </span>
                          )}
                          <span>•</span>
                          <span>{sev.label}</span>
                          <span>•</span>
                          <span>{new Date(n.createdAt).toLocaleString("ar-SA")}</span>
                        </div>
                      </div>
                    </div>
                    {!n.isRead && (
                      <Button size="sm" variant="ghost" onClick={() => readMut.mutate(n.id)} disabled={readMut.isPending}>
                        <Check className="h-4 w-4 me-1" />
                        تعليم كمقروء
                      </Button>
                    )}
                  </div>
                  <div className={`text-sm leading-7 mt-2 p-3 rounded-md ${sev.bg}`}
                       dir="rtl"
                       dangerouslySetInnerHTML={renderMarkdown(n.body)} />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
