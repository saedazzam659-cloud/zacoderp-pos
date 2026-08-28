import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useLocation } from "wouter";
import {
  demoAnalyticsApi,
  setupDemoApiInterceptor,
  sanitizeRouteForDemoAnalytics,
  getClientDeviceHeuristics,
  generateEventId,
} from "@/lib/demoAnalyticsApi";
import PhoneCaptureDialog from "@/components/demo-analytics/PhoneCaptureDialog";

import DemoQuotaBanner from "@/components/demo-analytics/DemoQuotaBanner";

export interface DemoAnalyticsStatus {
  applicable: boolean;
  phoneRequired: boolean;
  profileId?: number;
  enabled?: boolean;
  actionLimit?: number | null;
  actionsUsed?: number;
  remaining?: number | null;
  warningRemaining?: number;
  subscriptionMessage?: string;
  blocked?: boolean;
  currentSessionId?: number;
}

interface DemoAnalyticsContextType {
  status: DemoAnalyticsStatus | null;
  trackEvent: (type: string, data?: { moduleKey?: string; screenKey?: string; actionKey?: string; route?: string; durationMs?: number }) => void;
  refreshStatus: () => Promise<void>;
  consumeAction: (action: "export" | "print" | "report", idempotencyKey?: string) => Promise<void>;
}

export const DemoAnalyticsContext = createContext<DemoAnalyticsContextType | null>(null);

export function useDemoAnalytics() {
  const ctx = useContext(DemoAnalyticsContext);
  if (!ctx) throw new Error("useDemoAnalytics must be used within DemoAnalyticsProvider");
  return ctx;
}

const FLUSH_INTERVAL_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 60000;
const STATUS_REFRESH_MS = 60000;
const SESSION_STORAGE_KEY = "zacode_demo_session_key";

export function DemoAnalyticsProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated } = useAuth();
  const [location] = useLocation();
  const [status, setStatus] = useState<DemoAnalyticsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  
  const eventQueue = useRef<any[]>([]);
  const currentRouteRef = useRef<{ route: string; startedAt: number; moduleKey: string; screenKey: string } | null>(null);
  const sessionIdRef = useRef<number | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!isAuthenticated || user?.role === "superadmin") {
      setStatus(null);
      setLoading(false);
      return;
    }
    try {
      const data = await demoAnalyticsApi.getStatus();
      setStatus(data);
      if (data.currentSessionId) {
        sessionIdRef.current = data.currentSessionId;
      }
    } catch (e) {
      setStatus({ applicable: false, phoneRequired: false });
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, user]);

  const consumeAction = useCallback(async (action: "export" | "print" | "report", idempKey?: string) => {
    const key = idempKey || generateEventId();
    await demoAnalyticsApi.consumeAction(action, key);
    await refreshStatus(); // refresh to get updated remaining counts
  }, [refreshStatus]);

  useEffect(() => {
    setupDemoApiInterceptor();
    const onQuotaError = (e: any) => {
      refreshStatus();
    };
    window.addEventListener("demo-quota-error", onQuotaError);
    return () => window.removeEventListener("demo-quota-error", onQuotaError);
  }, [refreshStatus]);

  useEffect(() => {
    refreshStatus();
    const intv = setInterval(refreshStatus, STATUS_REFRESH_MS);
    return () => clearInterval(intv);
  }, [refreshStatus]);

  // Session Management
  useEffect(() => {
    if (!status?.applicable || status.phoneRequired || !isAuthenticated) return;

    let isMounted = true;
    let sessionKey = sessionStorage.getItem(SESSION_STORAGE_KEY) || "";
    if (!sessionKey) {
      sessionKey = generateEventId();
      sessionStorage.setItem(SESSION_STORAGE_KEY, sessionKey);
    }

    const initSession = async () => {
      try {
        const devInfo = getClientDeviceHeuristics();
        const res = await demoAnalyticsApi.startSession({ sessionKey, ...devInfo });
        if (isMounted && res.sessionId) {
          sessionIdRef.current = res.sessionId;
        }
      } catch (e) {
        // silent
      }
    };

    if (!sessionIdRef.current) {
      initSession();
    }

    const hbInterval = setInterval(() => {
      if (sessionIdRef.current && !document.hidden) {
        demoAnalyticsApi.heartbeatSession(sessionIdRef.current).catch(() => {});
      }
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      isMounted = false;
      clearInterval(hbInterval);
    };
  }, [status?.applicable, status?.phoneRequired, isAuthenticated]);

  const flushEvents = useCallback(() => {
    if (eventQueue.current.length > 0) {
      const batch = [...eventQueue.current];
      eventQueue.current = [];
      demoAnalyticsApi.batchEvents(batch).catch(() => {
        eventQueue.current = [...batch, ...eventQueue.current];
      });
    }
  }, []);

  const trackEvent = useCallback((type: string, data: any = {}) => {
    if (!status?.applicable || status.phoneRequired) return;
    eventQueue.current.push({
      eventId: generateEventId(),
      type,
      occurredAt: new Date().toISOString(),
      ...data
    });
  }, [status]);

  // Periodic flush & visibility/pagehide
  useEffect(() => {
    const flushInt = setInterval(flushEvents, FLUSH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.hidden) {
        flushEvents();
      }
    };
    const onPageHide = () => {
      if (currentRouteRef.current) {
        const current = currentRouteRef.current;
        eventQueue.current.push({
          eventId: generateEventId(),
          type: "screen_view",
          occurredAt: new Date().toISOString(),
          route: current.route,
          moduleKey: current.moduleKey,
          screenKey: current.screenKey,
          durationMs: Math.max(0, Date.now() - current.startedAt),
        });
        currentRouteRef.current = null;
      }
      flushEvents();
      if (sessionIdRef.current) {
        demoAnalyticsApi.endSession(sessionIdRef.current).catch(() => {});
        sessionIdRef.current = null;
      }
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    };
    window.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      clearInterval(flushInt);
      window.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [flushEvents]);

  // Route tracking
  useEffect(() => {
    if (!status?.applicable || status.phoneRequired) return;

    const { path, moduleKey, screenKey } = sanitizeRouteForDemoAnalytics(location);
    const now = Date.now();

    if (currentRouteRef.current) {
      const durationMs = now - currentRouteRef.current.startedAt;
      trackEvent("screen_view", { 
        route: currentRouteRef.current.route,
        moduleKey: currentRouteRef.current.moduleKey,
        screenKey: currentRouteRef.current.screenKey,
        durationMs
      });
    }

    currentRouteRef.current = { route: path, moduleKey, screenKey, startedAt: now };
  }, [location, status, trackEvent]);

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">جاري تحميل بيانات البيئة...</div>;
  }

  if (status?.applicable && status.phoneRequired) {
    return <PhoneCaptureDialog onSuccess={() => refreshStatus()} />;
  }

  return (
    <DemoAnalyticsContext.Provider value={{ status, trackEvent, refreshStatus, consumeAction }}>
      {status?.applicable && status.warningRemaining !== undefined && status.remaining != null && (
        <DemoQuotaBanner status={status} />
      )}
      {children}
    </DemoAnalyticsContext.Provider>
  );
}
