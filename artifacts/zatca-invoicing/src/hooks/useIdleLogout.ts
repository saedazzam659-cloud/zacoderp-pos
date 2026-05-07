import { useEffect, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const STORAGE_KEY = "zatca_idle_logout_minutes";
const LAST_ACTIVITY_KEY = "zatca_idle_last_activity";
const WARNING_BEFORE_MS = 30_000;

export const IDLE_LOGOUT_STORAGE_KEY = STORAGE_KEY;

export function getIdleLogoutMinutes(): number {
  if (typeof localStorage === "undefined") return 0;
  const raw = localStorage.getItem(STORAGE_KEY);
  const n = raw == null ? 0 : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function setIdleLogoutMinutes(minutes: number): void {
  if (typeof localStorage === "undefined") return;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, String(Math.floor(minutes)));
  }
  try {
    window.dispatchEvent(new CustomEvent("zatca:idle-settings-changed"));
  } catch { /* ignore */ }
}

export function useIdleLogout(): void {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const lastActivityRef = useRef<number>(Date.now());
  const warnedRef = useRef<boolean>(false);
  const minutesRef = useRef<number>(getIdleLogoutMinutes());

  useEffect(() => {
    if (!user) return;

    const refreshMinutes = () => {
      minutesRef.current = getIdleLogoutMinutes();
      lastActivityRef.current = Date.now();
      warnedRef.current = false;
    };
    refreshMinutes();

    const markActivity = () => {
      lastActivityRef.current = Date.now();
      warnedRef.current = false;
      try { localStorage.setItem(LAST_ACTIVITY_KEY, String(lastActivityRef.current)); } catch { /* ignore */ }
    };

    const events: (keyof WindowEventMap)[] = [
      "mousemove", "mousedown", "keydown", "scroll", "touchstart", "click", "wheel",
    ];
    events.forEach((ev) => window.addEventListener(ev, markActivity, { passive: true }));

    const onStorage = (e: StorageEvent) => {
      if (e.key === LAST_ACTIVITY_KEY && e.newValue) {
        const ts = Number(e.newValue);
        if (Number.isFinite(ts) && ts > lastActivityRef.current) {
          lastActivityRef.current = ts;
          warnedRef.current = false;
        }
      }
      if (e.key === STORAGE_KEY) refreshMinutes();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("zatca:idle-settings-changed", refreshMinutes);

    const tick = setInterval(() => {
      const minutes = minutesRef.current;
      if (minutes <= 0) return;
      const limitMs = minutes * 60_000;
      const idleMs = Date.now() - lastActivityRef.current;
      if (idleMs >= limitMs) {
        warnedRef.current = false;
        try { localStorage.removeItem(LAST_ACTIVITY_KEY); } catch { /* ignore */ }
        toast({
          title: "تم تسجيل الخروج تلقائياً",
          description: `لم يُسجَّل أي نشاط لمدة ${minutes} دقيقة.`,
          variant: "destructive",
        });
        void logout().catch(() => { /* ignore */ });
        return;
      }
      if (!warnedRef.current && limitMs - idleMs <= WARNING_BEFORE_MS) {
        warnedRef.current = true;
        toast({
          title: "تنبيه الخمول",
          description: "سيتم تسجيل الخروج خلال 30 ثانية بسبب عدم النشاط. حرّك الفأرة أو اضغط أي مفتاح للاستمرار.",
        });
      }
    }, 5_000);

    return () => {
      events.forEach((ev) => window.removeEventListener(ev, markActivity));
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("zatca:idle-settings-changed", refreshMinutes);
      clearInterval(tick);
    };
  }, [user, logout, toast]);
}
