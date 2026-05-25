// Root component for the Tauri desktop POS.
//
// Boot flow (4 phases — Task #175 added the cashier-login layer):
//   1. checking          — load device token + (if present) cashier token
//   2. needs-activation  — device not yet bound to a company → Activation wizard
//   3. needs-cashier     — device OK but no logged-in cashier → CashierLogin
//   4. signed-in         — full PosShell with cashier context + posSessionId
//
// Two auth layers ride together on every cloud call from PosShell:
//   * X-Device-Token  — pins the request to the physical terminal
//   * Authorization   — Bearer <userToken>, identifies the human cashier
//
// Server URL is persisted in localStorage during activation (`pos_desktop_server_url`)
// so subsequent boots know which cloud to talk to. The cashier token lives in
// the keyring (or localStorage fallback) so a hard refresh mid-shift restores
// the same context without re-typing the password.

import { useState, useEffect } from "react";
import Activation from "./pages/Activation";
import CashierLogin from "./pages/CashierLogin";
import PosShell from "./pages/PosShell";
import LicenseExpired from "./pages/LicenseExpired";
import { createApi, ApiError } from "./lib/api";
import {
  loadDeviceToken, clearDeviceToken,
  loadUserToken, clearUserToken,
  loadCashierContext, saveCashierContext, clearCashierContext,
  type CashierContext,
  TAURI_MODE,
} from "./lib/tauri-shim";
import { clearSessionParkedCarts } from "./lib/parkedCarts";

type BootState =
  | { phase: "checking" }
  | { phase: "needs-activation" }
  | { phase: "license-expired"; baseUrl: string; deviceToken: string; expiresAt: string | null; companyName?: string }
  | { phase: "needs-cashier"; baseUrl: string; deviceToken: string; companyId: number; deviceId: number; companyName?: string; expiresAt: string | null }
  | { phase: "signed-in"; baseUrl: string; deviceToken: string; userToken: string; companyId: number; deviceId: number; companyName?: string; cashierContext: CashierContext; expiresAt: string | null };

const DEFAULT_BASE = "https://zacoderp.com";
const EXPIRES_AT_KEY = "pos_desktop_license_expires_at";
const COMPANY_NAME_KEY = "pos_desktop_company_name";

export default function App() {
  const [state, setState] = useState<BootState>({ phase: "checking" });

  useEffect(() => { void boot(); }, []);

  async function boot() {
    // ── Layer 1: device token ─────────────────────────────────────────
    const dToken = await loadDeviceToken();
    if (!dToken) { setState({ phase: "needs-activation" }); return; }

    const baseUrl = localStorage.getItem("pos_desktop_server_url") ?? DEFAULT_BASE;
    const cachedCompanyName = localStorage.getItem(COMPANY_NAME_KEY) ?? undefined;
    let cachedExpiresAt = localStorage.getItem(EXPIRES_AT_KEY);
    const api = createApi({ baseUrl, deviceToken: dToken });

    let companyId = 0, deviceId = 0;
    let companyName: string | undefined = cachedCompanyName;
    let expiresAt: string | null = cachedExpiresAt;

    // ── Validate device token + license with the cloud ────────────────
    // Distinguish 3 outcomes:
    //   • 200            → token + license OK; refresh cached expiresAt
    //   • 401            → token rejected (revoked / wiped server-side) → re-activate
    //   • 403            → license revoked or expired → show expired screen, KEEP token
    //   • network / 5xx  → continue with cached context (offline tolerance)
    try {
      const v = await api.validate();
      companyId = v.companyId; deviceId = v.deviceId;
      expiresAt = v.expiresAt;
      if (v.expiresAt) localStorage.setItem(EXPIRES_AT_KEY, v.expiresAt);
      else localStorage.removeItem(EXPIRES_AT_KEY);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // Token was revoked or device deactivated — wipe and re-activate.
        await clearDeviceToken();
        await clearUserToken();
        clearCashierContext();
        localStorage.removeItem(EXPIRES_AT_KEY);
        setState({ phase: "needs-activation" });
        return;
      }
      if (e instanceof ApiError && e.status === 403) {
        // License revoked or expired. Keep the device token — when the
        // subscription is renewed, "إعادة المحاولة" on the expired screen
        // re-runs boot() with the same token and gets through.
        const details = (e.details as { expiresAt?: string } | undefined);
        const exp = details?.expiresAt ?? cachedExpiresAt ?? null;
        if (exp) localStorage.setItem(EXPIRES_AT_KEY, exp);
        setState({ phase: "license-expired", baseUrl, deviceToken: dToken, expiresAt: exp, companyName: cachedCompanyName });
        return;
      }
      // Network error / 5xx — keep going (POS desktop's whole point is offline-tolerance).
      console.warn("Boot validate failed (offline?), continuing with cached context", e);
    }

    // ── Offline expiry guard ──────────────────────────────────────────
    // Even when offline, refuse to open the POS if the cached expiry date
    // is already in the past. Without this guard a customer could cut the
    // network cable to keep selling forever after the subscription lapsed.
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
      setState({ phase: "license-expired", baseUrl, deviceToken: dToken, expiresAt, companyName });
      return;
    }

    // ── Layer 2: cashier token + context ──────────────────────────────
    const uToken = await loadUserToken();
    const ctx = loadCashierContext();
    if (!uToken || !ctx) {
      // Defensive: a token without context (or vice versa) is an orphan from
      // an aborted login mid-flow. Wipe BOTH so the next login starts clean.
      if (uToken || ctx) { await clearUserToken(); clearCashierContext(); }
      setState({ phase: "needs-cashier", baseUrl, deviceToken: dToken, companyId, deviceId, companyName, expiresAt });
      return;
    }

    // Re-validate the user token if the server is reachable. We do NOT block
    // boot if the server is offline — the cached context is good enough to
    // keep ringing sales until the network is back.
    try {
      const apiBoth = createApi({ baseUrl, deviceToken: dToken, userToken: uToken });
      const me = await apiBoth.cashierMe();
      if (me) {
        // Refresh names in case the cashier was renamed on the cloud since last login.
        const refreshed: CashierContext = {
          ...ctx,
          username: me.username,
          nameAr: me.nameAr,
          companyName: me.company?.name ?? ctx.companyName,
        };
        saveCashierContext(refreshed);
        if (refreshed.companyName) localStorage.setItem(COMPANY_NAME_KEY, refreshed.companyName);
        setState({ phase: "signed-in", baseUrl, deviceToken: dToken, userToken: uToken, companyId, deviceId, companyName: refreshed.companyName, cashierContext: refreshed, expiresAt });
        return;
      }
      // me() returned null/401 → token expired; fall through to login.
      await clearUserToken();
      clearCashierContext();
      setState({ phase: "needs-cashier", baseUrl, deviceToken: dToken, companyId, deviceId, companyName, expiresAt });
    } catch {
      // Offline — trust the cached context.
      setState({ phase: "signed-in", baseUrl, deviceToken: dToken, userToken: uToken, companyId, deviceId, companyName: ctx.companyName, cashierContext: ctx, expiresAt });
    }
  }

  // ── Sign out (device-level) ──────────────────────────────────────────
  // Wipes BOTH layers since the device is no longer bound to the company.
  async function handleSignOut() {
    const sid = loadCashierContext()?.posSessionId;
    if (sid) { try { await clearSessionParkedCarts(sid); } catch { /* ignore */ } }
    await clearDeviceToken();
    await clearUserToken();
    clearCashierContext();
    localStorage.removeItem(EXPIRES_AT_KEY);
    localStorage.removeItem(COMPANY_NAME_KEY);
    setState({ phase: "needs-activation" });
  }

  // ── Retry from the license-expired screen ────────────────────────────
  // Just re-runs boot. If the cloud now reports a renewed expiresAt, boot
  // falls through to needs-cashier; otherwise it lands back on this screen.
  async function handleRetryLicense() {
    setState({ phase: "checking" });
    await boot();
  }

  // ── Logout cashier (user-level) ──────────────────────────────────────
  // Keeps the device activated. Tries to close the POS session on the cloud
  // and revoke the user token; falls back gracefully if offline.
  async function handleLogoutCashier() {
    if (state.phase !== "signed-in") return;
    const { baseUrl, deviceToken, userToken, cashierContext, companyId, deviceId, companyName, expiresAt } = state;
    const api = createApi({ baseUrl, deviceToken, userToken });
    // Try the cloud-side close. If the network is down (or the server errors),
    // queue it into the pending-closes retry queue so PosShell's heartbeat
    // tick can drain it once connectivity returns. Without this fallback the
    // session would sit "open" on the cloud forever, blocking the same user
    // from opening a session on any other terminal next time. The server-side
    // janitor will eventually auto-close it, but that produces force_closed
    // with the last-heartbeat timestamp instead of the cashier's actual
    // logout time — the deferred-close gives us a cleaner record.
    const closedAt = new Date().toISOString();
    try {
      await api.closePosSession(cashierContext.posSessionId);
    } catch (e) {
      console.warn("closePosSession failed (offline?) — queued for retry", e);
      const { enqueuePendingClose } = await import("./lib/pendingSessionCloses");
      enqueuePendingClose({ posSessionId: cashierContext.posSessionId, closedAt });
    }
    try { await api.cashierLogout(); } catch (e) { console.warn("cashierLogout failed (offline?)", e); }
    try { await clearSessionParkedCarts(cashierContext.posSessionId); } catch { /* ignore */ }
    await clearUserToken();
    clearCashierContext();
    setState({ phase: "needs-cashier", baseUrl, deviceToken, companyId, deviceId, companyName, expiresAt });
  }

  // ── Render ──────────────────────────────────────────────────────────
  if (state.phase === "checking") {
    return (
      <div dir="rtl" style={loaderStyle}>
        <div style={{ fontSize: 18, color: "#0f172a" }}>جاري التحقق من الجهاز…</div>
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>
          {TAURI_MODE === "tauri" ? "وضع التطبيق الأصلي" : "وضع المتصفح (تطوير)"}
        </div>
      </div>
    );
  }

  if (state.phase === "license-expired") {
    return (
      <LicenseExpired
        expiresAt={state.expiresAt}
        companyName={state.companyName}
        onRetry={handleRetryLicense}
        onDeactivate={handleSignOut}
      />
    );
  }

  if (state.phase === "needs-activation") {
    return (
      <Activation
        onActivated={(info) => {
          const baseUrl = localStorage.getItem("pos_desktop_server_url") ?? DEFAULT_BASE;
          // Cache for offline boot + expiry guard.
          if (info.expiresAt) localStorage.setItem(EXPIRES_AT_KEY, info.expiresAt);
          else localStorage.removeItem(EXPIRES_AT_KEY);
          if (info.companyName) localStorage.setItem(COMPANY_NAME_KEY, info.companyName);
          // After activation, drop into cashier login — NOT straight into the
          // shell — because no human is logged in yet.
          setState({
            phase: "needs-cashier", baseUrl,
            deviceToken: info.deviceToken,
            companyId: info.companyId,
            deviceId: info.deviceId,
            companyName: info.companyName,
            expiresAt: info.expiresAt ?? null,
          });
        }}
      />
    );
  }

  if (state.phase === "needs-cashier") {
    return (
      <CashierLogin
        baseUrl={state.baseUrl}
        deviceToken={state.deviceToken}
        onSignedIn={(ctx, userToken) => {
          if (ctx.companyName) localStorage.setItem(COMPANY_NAME_KEY, ctx.companyName);
          setState({
            phase: "signed-in",
            baseUrl: state.baseUrl,
            deviceToken: state.deviceToken,
            userToken,
            companyId: state.companyId,
            deviceId: state.deviceId,
            companyName: ctx.companyName ?? state.companyName,
            cashierContext: ctx,
            expiresAt: state.expiresAt,
          });
        }}
      />
    );
  }

  return (
    <PosShell
      baseUrl={state.baseUrl}
      deviceToken={state.deviceToken}
      userToken={state.userToken}
      cashierContext={state.cashierContext}
      companyName={state.companyName}
      deviceId={state.deviceId}
      expiresAt={state.expiresAt}
      onSignOut={handleSignOut}
      onLogoutCashier={handleLogoutCashier}
    />
  );
}

const loaderStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
  height: "100vh", fontFamily: "'Segoe UI', system-ui, sans-serif",
};
