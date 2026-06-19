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

import { useState, useEffect, useRef } from "react";
import Activation from "./pages/Activation";
import CashierLogin from "./pages/CashierLogin";
import PosShell from "./pages/PosShell";
import LicenseExpired from "./pages/LicenseExpired";
import FirstRunWizard from "./pages/FirstRunWizard";
import VerticalSelector from "./pages/VerticalSelector";
import CountrySelector from "./pages/CountrySelector";
import ProfileSelector from "./pages/ProfileSelector";
import { hasChosenCountry } from "./lib/currency";
import StandaloneOnboard from "./pages/StandaloneOnboard";
import StandaloneCompanyRegistration from "./pages/StandaloneCompanyRegistration";
import StandaloneLogin from "./pages/StandaloneLogin";
import StandaloneRevalidationNeeded, { type RevalidationReason } from "./pages/StandaloneRevalidationNeeded";
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
  getVertical, getAppProfile,
  revalidateLicense, saveLicense,
  getLastLicenseCheck, setLastLicenseCheck, isGraceExpired,
  getPendingLicenseKey,
  type AppMode, type OfflineLicensePayload, type LocalSession,
} from "./lib/standalone";
import { getFingerprint } from "./lib/tauri-shim";
import { initBridge } from "./lib/bridge";
import { clockGuardCheck, clockGuardClearOnline } from "./lib/clockGuard";
import ClockTamperLocked from "./pages/ClockTamperLocked";

type BootState =
  | { phase: "checking" }
  // Boot failed unexpectedly (uncaught error or a hung startup step). Shown
  // INSTEAD of an endless "checking…" / blank white screen so the user always
  // gets a visible, recoverable screen with the real error + a retry.
  | { phase: "boot-error"; message: string }
  // Clock-rollback guard tripped — device HARD-LOCKED until a SuperAdmin unlock
  // (offline signed code or online one-click). `cloud` is present when a cloud
  // device token exists so the lock screen can poll for the online unblock.
  | { phase: "clock-locked"; deviceCode: string; cloud?: { baseUrl: string; deviceToken: string } }
  | { phase: "needs-mode" }
  | { phase: "needs-vertical" }
  | { phase: "needs-country" }
  | { phase: "needs-profile" }
  // Cloud paths
  | { phase: "needs-activation" }
  | { phase: "license-expired"; baseUrl: string; deviceToken: string; expiresAt: string | null; companyName?: string }
  | { phase: "needs-cashier"; baseUrl: string; deviceToken: string; companyId: number; deviceId: number; companyName?: string; expiresAt: string | null }
  | { phase: "signed-in"; baseUrl: string; deviceToken: string; userToken: string; companyId: number; deviceId: number; companyName?: string; cashierContext: CashierContext; expiresAt: string | null }
  // Standalone paths
  | { phase: "needs-standalone-license" }
  | { phase: "needs-standalone-approval"; licenseKey: string }
  | { phase: "needs-standalone-login"; license: OfflineLicensePayload }
  | { phase: "standalone-revalidation-needed"; reason: RevalidationReason }
  | { phase: "standalone-signed-in"; license: OfflineLicensePayload; session: LocalSession };

const DEFAULT_BASE = "https://zacoderp.com";
const EXPIRES_AT_KEY = "pos_desktop_license_expires_at";
const COMPANY_NAME_KEY = "pos_desktop_company_name";

export default function App() {
  const [state, setState] = useState<BootState>({ phase: "checking" });
  // Monotonic id for the current boot attempt. A retry (or the watchdog firing)
  // starts a new attempt; if a STALE attempt later rejects/resolves it must not
  // clobber the newer one's state. Every terminal setState checks this id.
  const bootRunId = useRef(0);
  // Clock-rollback guard's effectiveNow = max(systemNow, high-water-mark). ALL
  // expiry comparisons read this (never bare Date.now()) so a rolled-back clock
  // can never extend validity. Refreshed on boot AND by the periodic tick.
  const effectiveNowRef = useRef<number>(Date.now());

  useEffect(() => { void boot(); }, []);

  // ── Clock-rollback guard tick ─────────────────────────────────────────
  // Re-checks the monotonic time guard once a minute while the app is in any
  // active phase, so rolling the Windows clock back DURING a session locks the
  // device too (not just at boot). On lock we carry the cloud context (if any)
  // so the lock screen can poll for the online unblock.
  useEffect(() => {
    if (state.phase === "checking" || state.phase === "boot-error" || state.phase === "clock-locked") return;
    let cancelled = false;
    const cloud = (state.phase === "signed-in" || state.phase === "needs-cashier" || state.phase === "license-expired")
      ? { baseUrl: state.baseUrl, deviceToken: state.deviceToken }
      : undefined;
    const tick = async () => {
      const g = await clockGuardCheck();
      if (cancelled) return;
      effectiveNowRef.current = g.effectiveNow;
      if (g.locked) setState({ phase: "clock-locked", deviceCode: g.deviceCode ?? "", cloud });
    };
    const id = window.setInterval(() => { void tick(); }, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // ── Boot watchdog ─────────────────────────────────────────────────────
  // A startup step could HANG (e.g. a native invoke that never resolves) — a
  // rejection is caught by boot()'s try/catch, but a hang would otherwise sit
  // on the "checking…" screen forever (the user's "blank white screen"). If we
  // are still "checking" after a generous window, surface a recoverable error
  // instead. Re-armed every time we re-enter "checking" (e.g. on retry).
  useEffect(() => {
    if (state.phase !== "checking") return;
    const id = window.setTimeout(() => {
      setState((s) => s.phase === "checking"
        ? { phase: "boot-error", message: "تعذّر إكمال بدء التشغيل خلال المدة المتوقعة (قد تكون هناك خطوة معلّقة)." }
        : s);
    }, 20000);
    return () => window.clearTimeout(id);
  }, [state.phase]);

  // ── Periodic remote revalidation (Task #236) ──────────────────────────
  // While a self-registered standalone device is signed in, re-check the cloud
  // every 6h and whenever the window regains focus. This picks up remote
  // revoke/expiry promptly and resets the offline-grace timer on success. A
  // mere network failure is ignored here — only an authoritative lock verdict
  // or an elapsed grace window (evaluated inside revalidateStandalone) locks.
  useEffect(() => {
    if (state.phase !== "standalone-signed-in") return;
    if (state.license.source !== "self_register") return;
    let cancelled = false;
    const license = state.license;
    const run = async () => {
      const verdict = await revalidateStandalone(license);
      if (cancelled) return;
      if (verdict.lock) { setState({ phase: "standalone-revalidation-needed", reason: verdict.reason }); return; }
      // Apply a refreshed payload (e.g. SuperAdmin renewed/extended expiry) so
      // the change takes effect immediately without waiting for a restart.
      if (verdict.license) {
        setState((s) => (s.phase === "standalone-signed-in"
          ? { ...s, license: verdict.license! }
          : s));
      }
    };
    const id = window.setInterval(() => { void run(); }, 6 * 60 * 60 * 1000);
    const onFocus = () => { void run(); };
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.clearInterval(id); window.removeEventListener("focus", onFocus); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.phase === "standalone-signed-in" ? state.license.licenseKey : ""]);

  // Thin wrapper: NEVER let a boot failure leave the app hanging on the
  // "checking…" screen (which the user perceives as a blank white screen).
  // Any uncaught error from a startup step lands on a visible, recoverable
  // "boot-error" screen that shows the real message and offers a retry.
  async function boot() {
    const runId = ++bootRunId.current;
    try {
      await bootInner();
    } catch (e) {
      if (runId !== bootRunId.current) return; // a newer attempt superseded us
      console.error("[pos-desktop] boot failed:", e);
      const message = e instanceof Error ? (e.stack || e.message) : String(e);
      setState({ phase: "boot-error", message });
    }
  }

  async function bootInner() {
    // ── LAN bridge (Task #207) ────────────────────────────────────────
    // Must run before any shared-data load so a `client` device routes its
    // reads/writes to the host. No-op for single/host (local Tauri invoke).
    await initBridge();
    // ── Clock-rollback guard (Task #237) ──────────────────────────────
    // Runs FIRST so a tampered clock locks the device regardless of mode or
    // onboarding state. effectiveNow feeds every downstream expiry check.
    {
      const g = await clockGuardCheck();
      effectiveNowRef.current = g.effectiveNow;
      if (g.locked) {
        let cloud: { baseUrl: string; deviceToken: string } | undefined;
        try {
          const dt = await loadDeviceToken();
          if (dt) cloud = { baseUrl: localStorage.getItem("pos_desktop_server_url") ?? DEFAULT_BASE, deviceToken: dt };
        } catch { /* no cloud token — offline unlock only */ }
        setState({ phase: "clock-locked", deviceCode: g.deviceCode ?? "", cloud });
        return;
      }
    }
    // ── First-run mode selection ──────────────────────────────────────
    const mode = await getAppMode();
    if (!mode) { setState({ phase: "needs-mode" }); return; }
    // ── Vertical preset (Task #200) — applies to BOTH cloud + standalone.
    // We block boot here so first-launch users land on the catalog flavor
    // that matches their business. Returning users skip this branch.
    const vertical = await getVertical();
    if (!vertical) { setState({ phase: "needs-vertical" }); return; }
    // ── Country / currency (applies to BOTH cloud + standalone). Sets the
    // default POS currency symbol + VAT rate. Returning users skip this.
    if (!hasChosenCountry()) { setState({ phase: "needs-country" }); return; }
    // ── App profile (Task #226) — POS-only vs Full ERP. Applies to BOTH
    // cloud + standalone. Chosen once at first run; returning users skip it.
    const profile = await getAppProfile();
    if (!profile) { setState({ phase: "needs-profile" }); return; }
    if (mode === "standalone") return bootStandalone();
    return bootCloud();
  }

  async function bootStandalone() {
    // Layer 1: signed license file
    const file = await loadLicense();
    if (!file) {
      // No signed file yet — but if a self-registration is still awaiting
      // SuperAdmin approval, resume the "awaiting approval" wait instead of
      // restarting from a blank activation screen.
      const pendingKey = await getPendingLicenseKey();
      if (pendingKey) { setState({ phase: "needs-standalone-approval", licenseKey: pendingKey }); return; }
      setState({ phase: "needs-standalone-license" });
      return;
    }
    const r = await verifyLicenseFile(file, effectiveNowRef.current);
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
    // Layer 1c: remote revalidation. Self-registered (online) licenses must
    // phone home within their grace window. Admin-issued file licenses also
    // revalidate WHEN ONLINE so the SuperAdmin's remote expiry/revoke takes
    // effect — but they tolerate being offline indefinitely (no grace lock),
    // preserving their 100%-offline design (Task #233). revalidateStandalone
    // branches on license.source for that difference.
    let license = r.payload;
    {
      const verdict = await revalidateStandalone(license);
      if (verdict.lock) { setState({ phase: "standalone-revalidation-needed", reason: verdict.reason }); return; }
      if (verdict.license) license = verdict.license;
    }
    // Layer 2: local user session
    const session = await loadLocalSession();
    if (!session) { setState({ phase: "needs-standalone-login", license }); return; }
    setState({ phase: "standalone-signed-in", license, session });
  }

  // Revalidate an online-registered license against the cloud. Returns a lock
  // verdict (revoked / expired / grace-expired) or, on success, the possibly-
  // refreshed payload so the SuperAdmin's remote renew/expiry changes apply.
  // A transport failure is tolerated up to the offline grace window.
  async function revalidateStandalone(license: OfflineLicensePayload): Promise<
    | { lock: true; reason: RevalidationReason }
    | { lock: false; license?: OfflineLicensePayload }
  > {
    // Admin-issued FILE licenses (source !== 'self_register') are designed to run
    // 100% offline forever (Task #233). They still honour a SuperAdmin's remote
    // expiry/revoke WHEN ONLINE, but an unreachable server (or a server that no
    // longer knows the key) must NEVER lock them — only an explicit revoked /
    // expired verdict does. Self-registered (online) licenses keep the strict
    // grace-window behaviour: offline beyond grace, or unknown/mismatched, locks.
    const offlineTolerant = license.source !== "self_register";
    let fp = "";
    try { fp = await getFingerprint(); } catch { /* fingerprint backend down */ }
    const out = await revalidateLicense(license.licenseKey, fp);
    if (out.reachable) {
      if (out.status === "revoked") return { lock: true, reason: "revoked" };
      if (!offlineTolerant) {
        if (out.status === "not_found") return { lock: true, reason: "revoked" };
        if (out.status === "fingerprint_mismatch") return { lock: true, reason: "revoked" };
      }
      // active OR expired: persist the freshly-signed file (carries the SA's
      // latest expiry) and re-verify it locally.
      if (out.signedFile) {
        const v = await verifyLicenseFile(out.signedFile, effectiveNowRef.current);
        if (v.ok) {
          await saveLicense(out.signedFile);
          await setLastLicenseCheck(Date.now());
          if (v.payload.expiresAt && new Date(v.payload.expiresAt).getTime() < effectiveNowRef.current) {
            return { lock: true, reason: "expired" };
          }
          return { lock: false, license: v.payload };
        }
        // Re-signed file fails local verify (e.g. now expired) → lock as expired.
        if (out.status === "expired") return { lock: true, reason: "expired" };
      }
      if (out.status === "expired") return { lock: true, reason: "expired" };
      await setLastLicenseCheck(Date.now());
      return { lock: false };
    }
    // Offline. Admin file licenses tolerate this indefinitely (never phone-home
    // required); self-registered licenses tolerate it only until the grace window
    // elapses. If we have never recorded a successful check (lastCheck null), the
    // window anchors to the license's signed issuedAt so an imported self-register
    // file cannot run forever offline.
    if (offlineTolerant) return { lock: false };
    const lastCheck = await getLastLicenseCheck();
    const issuedTs = license.issuedAt ? new Date(license.issuedAt).getTime() : null;
    if (isGraceExpired(lastCheck, license.graceDays, issuedTs, effectiveNowRef.current)) {
      return { lock: true, reason: "grace-expired" };
    }
    return { lock: false };
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
      // Online clock-guard sync: a SuperAdmin "فك الحظر" stamps clockUnblockAt;
      // anchor the HWM to authoritative server time and clear any standing lock.
      try {
        await clockGuardClearOnline(v.clockUnblockAt, v.serverTime);
        const st = new Date(v.serverTime).getTime();
        const g = await clockGuardCheck({ trustedNowMs: Number.isFinite(st) ? st : undefined });
        effectiveNowRef.current = g.effectiveNow;
        if (g.locked) {
          setState({ phase: "clock-locked", deviceCode: g.deviceCode ?? "", cloud: { baseUrl, deviceToken: dToken } });
          return;
        }
      } catch (ge) { console.warn("clock-guard online sync failed", ge); }
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

    if (expiresAt && new Date(expiresAt).getTime() < effectiveNowRef.current) {
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

  if (state.phase === "boot-error") {
    return (
      <div
        dir="rtl"
        style={{
          minHeight: "100vh", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 16, padding: 24,
          textAlign: "center", fontFamily: "'Segoe UI', system-ui, sans-serif",
          background: "#0f172a", color: "#e2e8f0",
        }}
      >
        <div style={{ fontSize: 48 }}>⚠️</div>
        <h1 style={{ fontSize: 22, margin: 0, fontWeight: 700 }}>تعذّر بدء تشغيل التطبيق</h1>
        <p style={{ margin: 0, color: "#94a3b8", maxWidth: 480, lineHeight: 1.7 }}>
          حدثت مشكلة أثناء بدء التشغيل. بياناتك المحفوظة محلياً آمنة. جرّب إعادة
          المحاولة، وإن استمرت المشكلة أعد تشغيل التطبيق أو تواصل مع الدعم.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
          <button
            onClick={() => { void (async () => { setState({ phase: "checking" }); await boot(); })(); }}
            style={{
              padding: "10px 28px", fontSize: 16, fontWeight: 600, color: "#fff",
              background: "#2563eb", border: "none", borderRadius: 8, cursor: "pointer",
            }}
          >
            إعادة المحاولة
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "10px 28px", fontSize: 16, fontWeight: 600, color: "#e2e8f0",
              background: "transparent", border: "1px solid #334155", borderRadius: 8, cursor: "pointer",
            }}
          >
            إعادة تحميل
          </button>
        </div>
        {state.message ? (
          <pre
            style={{
              marginTop: 12, maxWidth: 560, whiteSpace: "pre-wrap", wordBreak: "break-word",
              fontSize: 12, color: "#64748b", direction: "ltr",
            }}
          >
            {state.message}
          </pre>
        ) : null}
      </div>
    );
  }

  if (state.phase === "clock-locked") {
    return (
      <ClockTamperLocked
        deviceCode={state.deviceCode}
        cloud={state.cloud}
        onUnlocked={handleRetryLicense}
      />
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

  if (state.phase === "needs-vertical") {
    return <VerticalSelector onChosen={() => {
      void (async () => { setState({ phase: "checking" }); await boot(); })();
    }} />;
  }

  if (state.phase === "needs-country") {
    return <CountrySelector onChosen={() => {
      void (async () => { setState({ phase: "checking" }); await boot(); })();
    }} />;
  }

  if (state.phase === "needs-profile") {
    return <ProfileSelector onChosen={() => {
      void (async () => { setState({ phase: "checking" }); await boot(); })();
    }} />;
  }

  // ── Standalone branch ─────────────────────────────────────────────
  if (state.phase === "needs-standalone-license") {
    return (
      <StandaloneOnboard
        onDone={() => {
          // Re-run boot so a freshly registered/imported license immediately
          // goes through verify + remote revalidation (revoked/expired/grace
          // checks) before we let the operator in — don't short-circuit to the
          // signed-in state from here.
          void (async () => { setState({ phase: "checking" }); await boot(); })();
        }}
        onCancel={() => { void (async () => { await wipeStandalone(); setState({ phase: "needs-mode" }); })(); }}
      />
    );
  }
  if (state.phase === "needs-standalone-approval") {
    return (
      <StandaloneCompanyRegistration
        resumePendingKey={state.licenseKey}
        onDone={() => {
          void (async () => { setState({ phase: "checking" }); await boot(); })();
        }}
        onBack={() => { void (async () => { await wipeStandalone(); setState({ phase: "needs-mode" }); })(); }}
      />
    );
  }
  if (state.phase === "standalone-revalidation-needed") {
    return (
      <StandaloneRevalidationNeeded
        reason={state.reason}
        onRetry={handleRetryLicense}
        onReset={handleStandaloneFullReset}
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
