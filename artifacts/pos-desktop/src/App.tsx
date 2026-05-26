// Root component for the Tauri desktop POS.
//
// Boot flow now has TWO modes (Task #199):
//
//   CLOUD MODE (original — Task #174/#175):
//     1. checking          — load device token + (if present) cashier token
//     2. needs-activation  — device not yet bound → Activation wizard
//     3. needs-cashier     — device OK but no cashier → CashierLogin
//     4. signed-in         — full PosShell with cloud cashierContext
//
//   STANDALONE MODE (Task #199):
//     1. checking
//     2. needs-standalone-license  — no signed license file → StandaloneActivation
//     3. needs-standalone-login    — license OK but no session → StandaloneLogin
//     4. standalone-signed-in      — PosShell rendered with standalone=true
//
// First-time launch shows FirstRunWizard which writes the chosen mode to
// localStorage; later boots skip straight into the matching path.

import { useState, useEffect } from "react";
import Activation from "./pages/Activation";
import CashierLogin from "./pages/CashierLogin";
import PosShell from "./pages/PosShell";
import LicenseExpired from "./pages/LicenseExpired";
import FirstRunWizard from "./pages/FirstRunWizard";
import StandaloneActivation from "./pages/StandaloneActivation";
import StandaloneLogin from "./pages/StandaloneLogin";
import { createApi, ApiError } from "./lib/api";
import {
  loadDeviceToken, clearDeviceToken,
  loadUserToken, clearUserToken,
  loadCashierContext, saveCashierContext, clearCashierContext,
  type CashierContext,
  TAURI_MODE,
} from "./lib/tauri-shim";
import { clearSessionParkedCarts } from "./lib/parkedCarts";
import {
  getAppMode, setAppMode, loadLicense, loadLocalSession,
  clearLocalSession, verifyLicenseFile, wipeStandalone,
  type AppMode, type OfflineLicensePayload, type LocalSession,
} from "./lib/standalone";
import { getFingerprint } from "./lib/tauri-shim";

type BootState =
  | { phase: "checking" }
  | { phase: "needs-mode" }
  // Cloud paths
  | { phase: "needs-activation" }
  | { phase: "license-expired"; baseUrl: string; deviceToken: string; expiresAt: string | null; companyName?: string }
  | { phase: "needs-cashier"; baseUrl: string; deviceToken: string; companyId: number; deviceId: number; companyName?: string; expiresAt: string | null }
  | { phase: "signed-in"; baseUrl: string; deviceToken: string; userToken: string; companyId: number; deviceId: number; companyName?: string; cashierContext: CashierContext; expiresAt: string | null }
  // Standalone paths
  | { phase: "needs-standalone-license" }
  | { phase: "needs-standalone-login"; license: OfflineLicensePayload }
  | { phase: "standalone-signed-in"; license: OfflineLicensePayload; session: LocalSession };

const DEFAULT_BASE = "https://zacoderp.com";
const EXPIRES_AT_KEY = "pos_desktop_license_expires_at";
const COMPANY_NAME_KEY = "pos_desktop_company_name";

export default function App() {
  const [state, setState] = useState<BootState>({ phase: "checking" });

  useEffect(() => { void boot(); }, []);

  async function boot() {
    // ── First-run mode selection ──────────────────────────────────────
    const mode = await getAppMode();
    if (!mode) { setState({ phase: "needs-mode" }); return; }
    if (mode === "standalone") return bootStandalone();
    return bootCloud();
  }

  async function bootStandalone() {
    // Layer 1: signed license file
    const file = await loadLicense();
    if (!file) { setState({ phase: "needs-standalone-license" }); return; }
    const r = await verifyLicenseFile(file);
    if (!r.ok) {
      // Tampered or expired — force re-activation but keep mode = standalone.
      console.warn("standalone license invalid:", r.error);
      setState({ phase: "needs-standalone-license" });
      return;
    }
    // Layer 1b: hardware binding — re-check on EVERY boot (not just activation).
    // Without this, a bound pos.db + license copied to another machine would
    // continue to boot. Mismatch clears the local session and forces the user
    // back to the activation screen with a sticky error.
    if (r.payload.fingerprintHash) {
      try {
        const fp = await getFingerprint();
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fp) as BufferSource);
        const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
        if (hex !== r.payload.fingerprintHash) {
          console.warn("standalone license fingerprint mismatch — refusing boot");
          await clearLocalSession();
          setState({ phase: "needs-standalone-license" });
          return;
        }
      } catch (e) {
        // Fingerprint backend itself failed — fail closed for bound licenses.
        console.warn("standalone fingerprint check failed:", e);
        await clearLocalSession();
        setState({ phase: "needs-standalone-license" });
        return;
      }
    }
    // Layer 2: local user session
    const session = await loadLocalSession();
    if (!session) { setState({ phase: "needs-standalone-login", license: r.payload }); return; }
    setState({ phase: "standalone-signed-in", license: r.payload, session });
  }

  async function bootCloud() {
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

    try {
      const v = await api.validate();
      companyId = v.companyId; deviceId = v.deviceId;
      expiresAt = v.expiresAt;
      if (v.expiresAt) localStorage.setItem(EXPIRES_AT_KEY, v.expiresAt);
      else localStorage.removeItem(EXPIRES_AT_KEY);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await clearDeviceToken();
        await clearUserToken();
        clearCashierContext();
        localStorage.removeItem(EXPIRES_AT_KEY);
        setState({ phase: "needs-activation" });
        return;
      }
      if (e instanceof ApiError && e.status === 403) {
        const details = (e.details as { expiresAt?: string } | undefined);
        const exp = details?.expiresAt ?? cachedExpiresAt ?? null;
        if (exp) localStorage.setItem(EXPIRES_AT_KEY, exp);
        setState({ phase: "license-expired", baseUrl, deviceToken: dToken, expiresAt: exp, companyName: cachedCompanyName });
        return;
      }
      console.warn("Boot validate failed (offline?), continuing with cached context", e);
    }

    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
      setState({ phase: "license-expired", baseUrl, deviceToken: dToken, expiresAt, companyName });
      return;
    }

    const uToken = await loadUserToken();
    const ctx = loadCashierContext();
    if (!uToken || !ctx) {
      if (uToken || ctx) { await clearUserToken(); clearCashierContext(); }
      setState({ phase: "needs-cashier", baseUrl, deviceToken: dToken, companyId, deviceId, companyName, expiresAt });
      return;
    }

    try {
      const apiBoth = createApi({ baseUrl, deviceToken: dToken, userToken: uToken });
      const me = await apiBoth.cashierMe();
      if (me) {
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
      await clearUserToken();
      clearCashierContext();
      setState({ phase: "needs-cashier", baseUrl, deviceToken: dToken, companyId, deviceId, companyName, expiresAt });
    } catch {
      setState({ phase: "signed-in", baseUrl, deviceToken: dToken, userToken: uToken, companyId, deviceId, companyName: ctx.companyName, cashierContext: ctx, expiresAt });
    }
  }

  // ── Cloud sign-out (device-level) ───────────────────────────────────
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

  async function handleRetryLicense() {
    setState({ phase: "checking" });
    await boot();
  }

  async function handleLogoutCashier() {
    if (state.phase !== "signed-in") return;
    const { baseUrl, deviceToken, userToken, cashierContext, companyId, deviceId, companyName, expiresAt } = state;
    const api = createApi({ baseUrl, deviceToken, userToken });
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

  // ── Standalone logout / wipe ────────────────────────────────────────
  async function handleStandaloneLogout() {
    if (state.phase !== "standalone-signed-in") return;
    await clearLocalSession();
    setState({ phase: "needs-standalone-login", license: state.license });
  }

  async function handleStandaloneFullReset() {
    if (!confirm("سيؤدي هذا إلى حذف كل بيانات الوضع المستقل (الترخيص، المستخدمين، الجلسة) والعودة لاختيار الوضع. متأكد؟")) return;
    await wipeStandalone();
    setState({ phase: "needs-mode" });
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

  if (state.phase === "needs-mode") {
    return <FirstRunWizard onChosen={(m: AppMode) => {
      void (async () => {
        await setAppMode(m);
        setState({ phase: "checking" });
        await boot();
      })();
    }} />;
  }

  // ── Standalone branch ─────────────────────────────────────────────
  if (state.phase === "needs-standalone-license") {
    return (
      <StandaloneActivation
        onDone={(payload) => {
          void (async () => {
            const session = await loadLocalSession();
            if (session) setState({ phase: "standalone-signed-in", license: payload, session });
            else setState({ phase: "needs-standalone-login", license: payload });
          })();
        }}
        onCancel={() => { void (async () => { await wipeStandalone(); setState({ phase: "needs-mode" }); })(); }}
      />
    );
  }
  if (state.phase === "needs-standalone-login") {
    return (
      <StandaloneLogin
        customerName={state.license.customerName}
        onSignedIn={(s) => setState({ phase: "standalone-signed-in", license: state.license, session: s })}
      />
    );
  }
  if (state.phase === "standalone-signed-in") {
    return (
      <PosShell
        baseUrl=""
        deviceToken=""
        standalone
        standaloneLicense={state.license}
        standaloneSession={state.session}
        deviceId={0}
        expiresAt={state.license.expiresAt}
        companyName={state.license.customerName}
        onSignOut={handleStandaloneFullReset}
        onLogoutCashier={handleStandaloneLogout}
      />
    );
  }

  // ── Cloud branch ──────────────────────────────────────────────────
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
          if (info.expiresAt) localStorage.setItem(EXPIRES_AT_KEY, info.expiresAt);
          else localStorage.removeItem(EXPIRES_AT_KEY);
          if (info.companyName) localStorage.setItem(COMPANY_NAME_KEY, info.companyName);
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
