const API_BASE = (import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "");

function getHeaders() {
  const token = localStorage.getItem("zatca_token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export const demoAnalyticsApi = {
  getStatus: async () => {
    const res = await fetch(`${API_BASE}/api/demo-analytics/status`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to get demo status");
    return res.json();
  },
  submitPhone: async (phone: string) => {
    const res = await fetch(`${API_BASE}/api/demo-analytics/phone`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ phone }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw { status: res.status, data };
    }
    return res.json();
  },
  startSession: async (payload: { sessionKey: string; deviceType?: string; os?: string; browser?: string; userAgent?: string }) => {
    const res = await fetch(`${API_BASE}/api/demo-analytics/sessions/start`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Failed to start session");
    return res.json();
  },
  heartbeatSession: async (sessionId: number) => {
    const res = await fetch(`${API_BASE}/api/demo-analytics/sessions/${sessionId}/heartbeat`, {
      method: "POST",
      headers: getHeaders(),
    });
    if (!res.ok) throw new Error("Failed to heartbeat session");
    return res.json();
  },
  endSession: async (sessionId: number) => {
    const res = await fetch(`${API_BASE}/api/demo-analytics/sessions/${sessionId}/end`, {
      method: "POST",
      headers: getHeaders(),
      keepalive: true
    });
    if (!res.ok) throw new Error("Failed to end session");
    return res.json();
  },
  batchEvents: async (events: any[]) => {
    if (!events.length) return;
    const res = await fetch(`${API_BASE}/api/demo-analytics/events/batch`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ events }),
      keepalive: true
    });
    if (!res.ok) throw new Error("Failed to batch events");
    return res.json();
  },
  consumeAction: async (action: "export" | "print" | "report", idempotencyKey: string) => {
    const res = await fetch(`${API_BASE}/api/demo-analytics/actions/consume`, {
      method: "POST",
      headers: { ...getHeaders(), "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ action })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw { status: res.status, data };
    }
    return res.json();
  },

  // Admin endpoints
  getAdminDashboard: async () => {
    const res = await fetch(`${API_BASE}/api/admin/demo-analytics/dashboard`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to load dashboard");
    return res.json();
  },
  getAdminProfiles: async (params: Record<string, string | number>) => {
    const query = new URLSearchParams(params as any).toString();
    const res = await fetch(`${API_BASE}/api/admin/demo-analytics?${query}`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to load profiles");
    // Returns a raw profile array
    return res.json();
  },
  getAdminProfile: async (id: number) => {
    const res = await fetch(`${API_BASE}/api/admin/demo-analytics/${id}`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to load profile");
    return res.json();
  },
  // Company-scoped, read-only endpoints. The server derives both company and
  // agent source from the authenticated request; no scope IDs are accepted.
  getCompanyDashboard: async () => {
    const res = await fetch(`${API_BASE}/api/company-demo-analytics/dashboard`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to load company demo dashboard");
    return res.json();
  },
  getCompanyProfiles: async (params: Record<string, string | number>) => {
    const query = new URLSearchParams(params as any).toString();
    const res = await fetch(`${API_BASE}/api/company-demo-analytics?${query}`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to load company demo profiles");
    return res.json();
  },
  getCompanyProfile: async (id: number) => {
    const res = await fetch(`${API_BASE}/api/company-demo-analytics/${id}`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to load company demo profile");
    return res.json();
  },
  updatePolicy: async (id: number, data: any) => {
    const res = await fetch(`${API_BASE}/api/admin/demo-analytics/${id}/policy`, {
      method: "PUT",
      headers: getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error("Failed to update policy");
    return res.json();
  },
  updateLead: async (id: number, data: any) => {
    const res = await fetch(`${API_BASE}/api/admin/demo-analytics/${id}/lead`, {
      method: "PUT",
      headers: getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error("Failed to update lead");
    return res.json();
  }
};

export function generateEventId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for missing crypto.randomUUID (e.g. non-secure context)
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c: any) => {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      return (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16);
    }
    return (c ^ Math.random() * 16 >> c / 4).toString(16);
  });
}

// Global fetch interceptor to catch quota errors for the demo system
let fetchIntercepted = false;
export function setupDemoApiInterceptor() {
  if (fetchIntercepted || typeof window === "undefined") return;
  fetchIntercepted = true;
  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (!response.ok && (response.status === 428 || response.status === 402 || response.status === 429)) {
      try {
        const clone = response.clone();
        const data = await clone.json();
        if (data && data.code && data.code.startsWith("DEMO_")) {
          window.dispatchEvent(new CustomEvent("demo-quota-error", { detail: { status: response.status, code: data.code, message: data.subscriptionMessage } }));
        }
      } catch (e) {
        // ignore JSON parse errors
      }
    }
    return response;
  };
}

export function sanitizeRouteForDemoAnalytics(route: string) {
  // Extract path without query string or hash
  let path = route.split('?')[0].split('#')[0];
  
  // Convert typical resource IDs to parameters
  path = path.replace(/\/[0-9a-fA-F-]{36}(?=\/|$)/g, '/:id');
  path = path.replace(/\/\d+(?=\/|$)/g, '/:id');
  
  const segments = path.split('/').filter(Boolean);
  let moduleKey = "home";
  let screenKey = "home";
  
  if (segments.length > 0) {
    moduleKey = segments[0];
    screenKey = segments.join('_');
  }

  return { path, moduleKey, screenKey };
}

export function getClientDeviceHeuristics() {
  const ua = navigator.userAgent;
  let deviceType = "desktop";
  
  if (/mobile/i.test(ua)) {
    deviceType = "mobile";
  } else if (/ipad|tablet/i.test(ua) || (typeof navigator !== "undefined" && navigator.maxTouchPoints && navigator.maxTouchPoints > 2 && /macintosh/i.test(ua))) {
    deviceType = "tablet";
  } else {
    // Documented heuristic: If screen width is small-ish or device has touch and it's a desktop OS, call it a laptop. 
    // We'll also treat machines with typical laptop resolutions (e.g. 1366x768, 1440x900) as laptops.
    if (typeof window !== "undefined") {
      const sw = window.screen?.width;
      if (sw && sw <= 1440) {
        deviceType = "laptop";
      }
    }
  }

  let os = "Unknown";
  if (/android/i.test(ua)) os = "Android";
  else if (/linux/i.test(ua)) os = "Linux";
  else if (/windows/i.test(ua)) os = "Windows";
  else if (/ios|iphone|ipad/i.test(ua)) os = "iOS";
  else if (/mac/i.test(ua)) os = "macOS";

  let browser = "Unknown";
  if (/edg/i.test(ua)) browser = "Edge";
  else if (/chrome|crios/i.test(ua)) browser = "Chrome";
  else if (/firefox|fxios/i.test(ua)) browser = "Firefox";
  else if (/safari/i.test(ua)) browser = "Safari";

  return { deviceType, os, browser, userAgent: ua };
}
