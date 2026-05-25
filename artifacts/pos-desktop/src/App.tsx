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
import { createApi } from "./lib/api";
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
  | { phase: "needs-cashier"; baseUrl: string; deviceToken: string; companyId: number; deviceId: number; companyName?: string }
  | { phase: "signed-in"; baseUrl: string; deviceToken: string; userToken: string; companyId: number; deviceId: number; companyName?: string; cashierContext: CashierContext };

const DEFAULT_BASE = "https://zacoderp.com";

export default function App() {
  const [state, setState] = useState<BootState>({ phase: "checking" });

  useEffect(() => { void boot(); }, []);

  async function boot() {
    // ── Layer 1: device token ─────────────────────────────────────────
    const dToken = await loadDeviceToken();
    if (!dToken) { setState({ phase: "needs-activation" }); return; }

    const baseUrl = localStorage.getItem("pos_desktop_server_url") ?? DEFAULT_BASE;
    const api = createApi({ baseUrl, deviceToken: dToken });

    let companyId = 0, deviceId = 0;
    let companyName: string | undefined;
    try {
      const v = await api.safeValidate();
      if (!v) {
        // Device token rejected — wipe both layers and re-activate.
        await clearDeviceToken();
        await clearUserToken();
        clearCashierContext();
        setState({ phase: "needs-activation" });
        return;
      }
      companyId = v.companyId; deviceId = v.deviceId;
    } catch (e) {
      // Network error — keep going (POS desktop's whole point is offline-tolerance).
      console.warn("Boot validate failed (offline?), continuing with cached context", e);
    }

    // ── Layer 2: cashier token + context ──────────────────────────────
    const uToken = await loadUserToken();
    const ctx = loadCashierContext();
    if (!uToken || !ctx) {
      // Defensive: a token without context (or vice versa) is an orphan from
      // an aborted login mid-flow. Wipe BOTH so the next login starts clean.
      if (uToken || ctx) { await clearUserToken(); clearCashierContext(); }
      setState({ phase: "needs-cashier", baseUrl, deviceToken: dToken, companyId, deviceId, companyName });
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
        setState({ phase: "signed-in", baseUrl, deviceToken: dToken, userToken: uToken, companyId, deviceId, companyName: refreshed.companyName, cashierContext: refreshed });
        return;
      }
      // me() returned null/401 → token expired; fall through to login.
      await clearUserToken();
      clearCashierContext();
      setState({ phase: "needs-cashier", baseUrl, deviceToken: dToken, companyId, deviceId, companyName });
    } catch {
      // Offline — trust the cached context.
      setState({ phase: "signed-in", baseUrl, deviceToken: dToken, userToken: uToken, companyId, deviceId, companyName: ctx.companyName, cashierContext: ctx });
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
    setState({ phase: "needs-activation" });
  }

  // ── Logout cashier (user-level) ──────────────────────────────────────
  // Keeps the device activated. Tries to close the POS session on the cloud
  // and revoke the user token; falls back gracefully if offline.
  async function handleLogoutCashier() {
    if (state.phase !== "signed-in") return;
    const { baseUrl, deviceToken, userToken, cashierContext, companyId, deviceId, companyName } = state;
    const api = createApi({ baseUrl, deviceToken, userToken });
    // Fire-and-forget the cloud-side cleanup so a slow network can't strand the cashier.
    try { await api.closePosSession(cashierContext.posSessionId); } catch (e) { console.warn("closePosSession failed (offline?)", e); }
    try { await api.cashierLogout(); } catch (e) { console.warn("cashierLogout failed (offline?)", e); }
    try { await clearSessionParkedCarts(cashierContext.posSessionId); } catch { /* ignore */ }
    await clearUserToken();
    clearCashierContext();
    setState({ phase: "needs-cashier", baseUrl, deviceToken, companyId, deviceId, companyName });
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

  if (state.phase === "needs-activation") {
    return (
      <Activation
        onActivated={(info) => {
          const baseUrl = localStorage.getItem("pos_desktop_server_url") ?? DEFAULT_BASE;
          // After activation, drop into cashier login — NOT straight into the
          // shell — because no human is logged in yet.
          setState({
            phase: "needs-cashier", baseUrl,
            deviceToken: info.deviceToken,
            companyId: info.companyId,
            deviceId: info.deviceId,
            companyName: info.companyName,
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
          setState({
            phase: "signed-in",
            baseUrl: state.baseUrl,
            deviceToken: state.deviceToken,
            userToken,
            companyId: state.companyId,
            deviceId: state.deviceId,
            companyName: ctx.companyName ?? state.companyName,
            cashierContext: ctx,
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
      onSignOut={handleSignOut}
      onLogoutCashier={handleLogoutCashier}
    />
  );
}

const loaderStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
  height: "100vh", fontFamily: "'Segoe UI', system-ui, sans-serif",
};
