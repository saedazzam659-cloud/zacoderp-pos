import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Clock, AlertTriangle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface SettingsResp {
  sessionStartTime: string | null;
  sessionEndTime:   string | null;
  endWarningMinutes: number;
}

function parseHM(hm: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  const h = Number(m[1]); const mn = Number(m[2]);
  if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
  return { h, m: mn };
}

// Build today's local Date for the given "HH:MM" — used as the countdown
// target. We anchor on local time (the company configures hours in their own
// TZ, and clients run in that TZ), so this is intentionally not UTC.
function todayAt(hm: string, ref: Date = new Date()): Date | null {
  const t = parseHM(hm); if (!t) return null;
  const d = new Date(ref);
  d.setHours(t.h, t.m, 0, 0);
  return d;
}

function fmt2(n: number) { return String(n).padStart(2, "0"); }

/**
 * Working-hours countdown clock.
 *
 * - Reads `/api/work-session-settings` once per mount (cached for 60s).
 * - If `sessionEndTime` is set, ticks every second toward today's end time.
 * - Pops a single warning toast when the remaining time first crosses the
 *   `endWarningMinutes` threshold (idempotent across renders via a ref).
 * - When the countdown hits zero, calls `auth.logout()` once and routes to
 *   /login. Renders nothing if auth/settings are missing or end time is unset.
 *
 * Mounted in the topbar so it's always visible; it deliberately stays small
 * (icon + digital readout) and uses a hard-to-miss color when ≤ 5 minutes
 * remain so cashiers notice without us interrupting their flow with a modal.
 */
export default function SessionCountdown() {
  const { token, user, logout } = useAuth();
  const { t } = useTranslation();
  const { toast } = useToast();
  const tr = (k: string) => t(`workSessions.${k}`) as string;

  // Company managers (role === "admin") are EXEMPT from the working-hours
  // auto-logout per the user's request: that policy applies only to their
  // subordinate users (cashiers / regular "user" role). SuperAdmins are
  // exempt as well since they're platform-level and don't belong to any
  // single company's working-hours configuration.
  //
  // Implementation note: by gating `enabled` we short-circuit BOTH the
  // countdown query AND the per-second tick effect — managers see no
  // countdown badge and never get auto-logged-out when the company's
  // sessionEndTime is reached.
  const exemptFromAutoLogout =
    user?.role === "admin" || user?.role === "superadmin";

  // Disabled if not signed in. (Topbar only renders when signed in anyway,
  // but be defensive — on logout the component unmounts mid-tick.)
  const enabled = Boolean(token && user) && !exemptFromAutoLogout;

  // Use the non-admin-safe /me/effective endpoint: it only returns the 3
  // working-hours fields, so cashiers (non-admins) get a countdown without us
  // leaking emailRecipients / AI model / branch policy. Refetch every 60s so
  // an admin's update propagates to all open sessions within a minute.
  const { data: settings } = useQuery<SettingsResp>({
    queryKey: ["work-session-settings", "me", "effective"],
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const r = await fetch(`${API}/api/work-session-settings/me/effective`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  // Re-tick every second. We don't depend on `now` itself in any memo other
  // than the digital readout, so 1Hz is cheap.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!enabled || !settings?.sessionEndTime) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [enabled, settings?.sessionEndTime]);

  // Track the warning + auto-logout one-shots so re-renders don't fire them
  // again. Reset whenever the configured end time changes.
  const warnedRef = useRef(false);
  const loggedOutRef = useRef(false);
  useEffect(() => {
    warnedRef.current = false;
    loggedOutRef.current = false;
  }, [settings?.sessionEndTime]);

  const target = useMemo(() => {
    if (!settings?.sessionEndTime) return null;
    return todayAt(settings.sessionEndTime, new Date(now));
  }, [settings?.sessionEndTime, now]);

  if (!enabled || !settings?.sessionEndTime || !target) return null;

  const remainMs = target.getTime() - now;
  const totalSec = Math.max(0, Math.floor(remainMs / 1000));
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  const remainMinutes = Math.floor(totalSec / 60);

  const warningThreshold = Math.max(1, Number(settings.endWarningMinutes) || 15);

  // Fire the warning toast exactly once when we cross into the danger window.
  if (!warnedRef.current && totalSec > 0 && remainMinutes < warningThreshold) {
    warnedRef.current = true;
    toast({
      title: tr("countdown.warningTitle"),
      description: tr("countdown.warningBody").replace("{n}", String(warningThreshold)),
      variant: "destructive",
    });
  }

  // Hit zero → log the user out exactly once.
  if (!loggedOutRef.current && totalSec === 0 && remainMs <= 0) {
    loggedOutRef.current = true;
    toast({
      title: tr("countdown.endedTitle"),
      description: tr("countdown.endedBody"),
    });
    // Defer so React finishes this render before state changes from logout.
    queueMicrotask(() => {
      logout().finally(() => {
        try { window.location.assign("/login"); } catch { /* noop */ }
      });
    });
  }

  // Tone: green > 30 min, amber within warning window, red ≤ 5 min.
  const tone =
    remainMinutes < 5 ? "danger"
      : remainMinutes < warningThreshold ? "warn"
        : "ok";

  const toneClass = {
    ok:     "border-emerald-300/60 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200",
    warn:   "border-amber-300/60   bg-amber-50   text-amber-900   dark:bg-amber-950/30   dark:text-amber-200",
    danger: "border-rose-300/70    bg-rose-50    text-rose-900    dark:bg-rose-950/30    dark:text-rose-200 animate-pulse",
  }[tone];

  const iconClass = {
    ok:     "text-emerald-600",
    warn:   "text-amber-600",
    danger: "text-rose-600",
  }[tone];

  // Display: HH:MM:SS when ≥ 1h remains, else MM:SS. Bidi-isolated so RTL
  // surrounding context doesn't reverse the digits.
  const display = hh > 0
    ? `${fmt2(hh)}:${fmt2(mm)}:${fmt2(ss)}`
    : `${fmt2(mm)}:${fmt2(ss)}`;

  const tooltip = `${tr("countdown.tooltipPrefix")} ${settings.sessionEndTime}`;

  return (
    <div
      className={cn(
        "hidden sm:flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold tabular-nums shrink-0 select-none",
        toneClass,
      )}
      title={tooltip}
      data-testid="session-countdown"
    >
      {tone === "danger"
        ? <AlertTriangle className={cn("h-3.5 w-3.5", iconClass)} />
        : <Clock className={cn("h-3.5 w-3.5", iconClass)} />}
      <span className="text-[10px] font-normal opacity-70">{tr("countdown.label")}</span>
      <span dir="ltr" className="font-mono text-[13px] leading-none">{display}</span>
    </div>
  );
}
