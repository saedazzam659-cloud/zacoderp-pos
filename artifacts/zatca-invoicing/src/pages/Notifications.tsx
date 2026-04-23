import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Bell, Sparkles, Check, AlertCircle, AlertTriangle, Info, X, Trash2, Undo2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const AUTO_DISMISS_MS = 5000; // grace window after a notification is read

type Notification = {
  id: number; title: string; body: string;
  severity: "info" | "low" | "medium" | "high";
  category: string; sourceKey: string | null;
  isRead: boolean; createdAt: string;
};

const SEV: Record<string, { bg: string; border: string; text: string; ring: string; icon: any; label: string }> = {
  high:   { bg: "bg-red-50",    border: "border-red-200",    text: "text-red-800",    ring: "stroke-red-500",    icon: AlertCircle,   label: "خطورة عالية" },
  medium: { bg: "bg-amber-50",  border: "border-amber-200",  text: "text-amber-900",  ring: "stroke-amber-500",  icon: AlertTriangle, label: "خطورة متوسطة" },
  low:    { bg: "bg-blue-50",   border: "border-blue-200",   text: "text-blue-900",   ring: "stroke-blue-500",   icon: Info,          label: "خطورة منخفضة" },
  info:   { bg: "bg-slate-50",  border: "border-slate-200",  text: "text-slate-800",  ring: "stroke-slate-400",  icon: Info,          label: "للعلم" },
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

// ─── single notification card with swipe + auto-dismiss countdown ────────────
function NotificationItem({
  n, headers, onDismissed, onRead, toast,
}: {
  n: Notification;
  headers: Record<string, string>;
  onDismissed: (id: number) => void;
  onRead: (id: number) => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const sev = SEV[n.severity] || SEV.info;
  const Icon = sev.icon;

  const [drag, setDrag] = useState(0);            // px translation while dragging
  const [removing, setRemoving] = useState(false); // play exit animation
  const startX = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // ── auto-dismiss countdown (only after the user marks the card as read) ────
  const [countdown, setCountdown] = useState<number | null>(null); // 0..1 progress
  const cdTimer = useRef<number | null>(null);
  const cdStart = useRef<number>(0);

  const cancelCountdown = () => {
    if (cdTimer.current) { cancelAnimationFrame(cdTimer.current); cdTimer.current = null; }
    setCountdown(null);
  };

  const startCountdown = () => {
    cancelCountdown();
    cdStart.current = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - cdStart.current) / AUTO_DISMISS_MS);
      setCountdown(t);
      if (t < 1) {
        cdTimer.current = requestAnimationFrame(tick);
      } else {
        cdTimer.current = null;
        triggerRemove();
      }
    };
    cdTimer.current = requestAnimationFrame(tick);
  };

  useEffect(() => () => cancelCountdown(), []);

  const triggerRemove = async () => {
    setRemoving(true);
    // wait for the slide-out CSS transition then call API + parent
    setTimeout(async () => {
      try {
        await fetch(`${API}/api/notifications/${n.id}`, { method: "DELETE", headers });
      } catch {}
      onDismissed(n.id);
      toast({
        title: "تم حذف التنبيه",
        description: n.title,
        action: (
          <ToastAction
            altText="تراجع"
            onClick={async () => {
              try {
                await fetch(`${API}/api/notifications/${n.id}/restore`, { method: "POST", headers });
              } catch {}
              onDismissed(-1);
            }}
          >
            تراجع
          </ToastAction>
        ),
      });
    }, 320);
  };

  const markRead = async () => {
    try {
      await fetch(`${API}/api/notifications/${n.id}/read`, { method: "POST", headers });
    } catch {}
    onRead(n.id);
    startCountdown(); // gives the user 5s to undo before auto-clear
  };

  // ── drag-to-dismiss handlers (mouse + touch) ───────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button,a")) return;
    startX.current = e.clientX;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (startX.current == null) return;
    setDrag(e.clientX - startX.current);
  };
  const onPointerUp = () => {
    if (startX.current == null) return;
    const w = cardRef.current?.offsetWidth || 400;
    if (Math.abs(drag) > w * 0.35) {
      // commit dismissal
      setDrag(drag > 0 ? w + 100 : -(w + 100));
      setTimeout(() => triggerRemove(), 180);
    } else {
      setDrag(0);
    }
    startX.current = null;
  };

  const exitTransform = removing
    ? "translateX(120%) rotate(-3deg) scale(0.95)"
    : `translateX(${drag}px) rotate(${drag * 0.02}deg)`;
  const opacity = removing ? 0 : Math.max(0.25, 1 - Math.abs(drag) / 400);

  // SVG ring geometry for the countdown around the X button
  const R = 14, C = 2 * Math.PI * R;
  const dash = countdown == null ? 0 : C * countdown;

  return (
    <div
      ref={cardRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="touch-pan-y select-none"
      style={{
        transform: exitTransform,
        opacity,
        transition: removing
          ? "transform 320ms cubic-bezier(.4,0,.2,1), opacity 320ms ease"
          : (startX.current == null ? "transform 200ms ease, opacity 200ms ease" : "none"),
      }}
    >
      <Card className={`${sev.border} ${!n.isRead ? "ring-1 ring-violet-200" : ""} relative`}>
        <CardContent className="pt-4">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="flex items-start gap-2 min-w-0 flex-1">
              <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${sev.text}`} />
              <div className="min-w-0">
                <h3 className={`text-base font-semibold ${sev.text}`}>{n.title}</h3>
                <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 flex-wrap">
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

            <div className="flex items-center gap-1 shrink-0">
              {!n.isRead && (
                <Button size="sm" variant="ghost" onClick={markRead}>
                  <Check className="h-4 w-4 me-1" />
                  تعليم كمقروء
                </Button>
              )}

              {/* Dismiss button with optional countdown ring */}
              <button
                onClick={() => {
                  cancelCountdown();
                  triggerRemove();
                }}
                title={countdown != null ? "حذف فوري (تراجع متاح)" : "حذف التنبيه"}
                className="relative h-8 w-8 inline-flex items-center justify-center rounded-full hover:bg-red-50 hover:text-red-600 text-muted-foreground transition-colors"
              >
                {countdown != null && (
                  <svg className="absolute inset-0" viewBox="0 0 32 32">
                    <circle cx="16" cy="16" r={R} className="stroke-slate-200" strokeWidth="2" fill="none" />
                    <circle
                      cx="16" cy="16" r={R}
                      className={sev.ring}
                      strokeWidth="2"
                      fill="none"
                      strokeLinecap="round"
                      strokeDasharray={`${dash} ${C}`}
                      transform="rotate(-90 16 16)"
                    />
                  </svg>
                )}
                <X className="h-4 w-4 relative" />
              </button>
            </div>
          </div>

          <div className={`text-sm leading-7 mt-2 p-3 rounded-md ${sev.bg}`}
               dir="rtl"
               dangerouslySetInnerHTML={renderMarkdown(n.body)} />

          {countdown != null && (
            <div className="mt-3 flex items-center justify-between rounded-md bg-violet-50 border border-violet-200 px-3 py-1.5 text-xs text-violet-800">
              <span>سيتم حذف هذا التنبيه تلقائيًا بعد {Math.max(0, Math.ceil((1 - countdown) * (AUTO_DISMISS_MS / 1000)))} ثانية</span>
              <button
                onClick={cancelCountdown}
                className="inline-flex items-center gap-1 font-semibold hover:underline"
              >
                <Undo2 className="h-3.5 w-3.5" />
                إيقاف
              </button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── page ───────────────────────────────────────────────────────────────────
export default function Notifications() {
  const { token } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
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

  // optimistic local removal on dismissal so the card disappears instantly
  const onDismissed = (id: number) => {
    if (id < 0) return invalidate(); // restore path
    qc.setQueryData<{ notifications: Notification[] }>(["notif-list-full"], (old) => {
      if (!old?.notifications) return old;
      return { ...old, notifications: old.notifications.filter(n => n.id !== id) };
    });
    qc.invalidateQueries({ queryKey: ["notif-list-recent"] });
    qc.invalidateQueries({ queryKey: ["notif-unread"] });
  };
  const onRead = (id: number) => {
    qc.setQueryData<{ notifications: Notification[] }>(["notif-list-full"], (old) => {
      if (!old?.notifications) return old;
      return { ...old, notifications: old.notifications.map(n => n.id === id ? { ...n, isRead: true } : n) };
    });
    qc.invalidateQueries({ queryKey: ["notif-unread"] });
  };

  const readAllMut = useMutation({
    mutationFn: async () => (await fetch(`${API}/api/notifications/read-all`, { method: "POST", headers })).json(),
    onSuccess: invalidate,
  });

  const cleanupReadMut = useMutation({
    mutationFn: async () => (await fetch(`${API}/api/notifications/cleanup/read`, { method: "DELETE", headers })).json(),
    onSuccess: (data) => {
      invalidate();
      const n = data?.dismissed ?? 0;
      const ids: number[] = data?.ids ?? [];
      if (n > 0) {
        toast({
          title: `تم حذف ${n} تنبيه مقروء`,
          action: ids.length ? (
            <ToastAction
              altText="تراجع"
              onClick={async () => {
                await Promise.all(ids.map(id =>
                  fetch(`${API}/api/notifications/${id}/restore`, { method: "POST", headers }).catch(() => {})
                ));
                invalidate();
              }}
            >
              تراجع
            </ToastAction>
          ) : undefined,
        });
      } else {
        toast({ title: "لا يوجد تنبيهات مقروءة للحذف" });
      }
    },
  });

  const unreadCount = items.filter(n => !n.isRead).length;
  const readCount = items.length - unreadCount;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bell className="h-6 w-6 text-violet-600" />
            التنبيهات
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            تنبيهات النظام والمشاكل المكتشفة في بيانات الشركة مع توصيات الحل. اسحب التنبيه جانبًا أو اضغط × لحذفه.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {unreadCount > 0 && (
            <Button variant="outline" size="sm" onClick={() => readAllMut.mutate()} disabled={readAllMut.isPending}>
              <Check className="h-4 w-4 me-1.5" />
              تعليم الكل كمقروء
            </Button>
          )}
          {readCount > 0 && (
            <Button
              variant="outline" size="sm"
              onClick={() => cleanupReadMut.mutate()}
              disabled={cleanupReadMut.isPending}
              className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
            >
              <Trash2 className="h-4 w-4 me-1.5" />
              تنظيف المقروء ({readCount})
            </Button>
          )}
        </div>
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
          {items.map(n => (
            <NotificationItem
              key={n.id}
              n={n}
              headers={headers}
              onDismissed={onDismissed}
              onRead={onRead}
              toast={toast}
            />
          ))}
        </div>
      )}
    </div>
  );
}
