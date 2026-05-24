// Root component for the Tauri desktop POS.
//
// Boot flow:
//   1. Load device token from secure storage (Tauri keyring / browser localStorage)
//   2. If found: call POST /api/device-licenses/validate to confirm it's still valid
//       - valid → render PosShell
//       - 401/403 (revoked, expired, deleted) → clear token, fall through to Activation
//   3. If no token: render Activation wizard
//
// Server URL is persisted in localStorage during activation (`pos_desktop_server_url`)
// so subsequent boots know which cloud to talk to.

import { useState, useEffect } from "react";
import Activation from "./pages/Activation";
import PosShell from "./pages/PosShell";
import { createApi } from "./lib/api";
import { loadDeviceToken, clearDeviceToken, TAURI_MODE } from "./lib/tauri-shim";

type BootState =
  | { phase: "checking" }
  | { phase: "needs-activation" }
  | { phase: "activated"; baseUrl: string; token: string; companyId: number; companyName?: string; deviceId: number };

const DEFAULT_BASE = "https://zacoderp.com";

export default function App() {
  const [state, setState] = useState<BootState>({ phase: "checking" });

  useEffect(() => { void boot(); }, []);

  async function boot() {
    const token = await loadDeviceToken();
    if (!token) { setState({ phase: "needs-activation" }); return; }

    const baseUrl = localStorage.getItem("pos_desktop_server_url") ?? DEFAULT_BASE;
    const api = createApi({ baseUrl, deviceToken: token });
    try {
      const v = await api.safeValidate();
      if (!v) {
        // Token rejected by server — wipe and re-activate
        await clearDeviceToken();
        setState({ phase: "needs-activation" });
        return;
      }
      setState({
        phase: "activated",
        baseUrl, token,
        companyId: v.companyId,
        deviceId: v.deviceId,
      });
    } catch (e) {
      // Network error — be optimistic and let user use offline mode anyway.
      // The desktop app's job IS to work offline; we shouldn't block on a
      // failed network call. Status badge in PosShell will say "offline".
      console.warn("Boot validate failed (offline?), entering POS shell anyway", e);
      setState({
        phase: "activated",
        baseUrl, token,
        companyId: 0, deviceId: 0,
      });
    }
  }

  async function handleSignOut() {
    await clearDeviceToken();
    setState({ phase: "needs-activation" });
  }

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
          // Avoid race with the secure-store write: Activation hands us the
          // token directly so we don't depend on a fresh disk read here.
          const baseUrl = localStorage.getItem("pos_desktop_server_url") ?? DEFAULT_BASE;
          setState({
            phase: "activated", baseUrl,
            token: info.deviceToken,
            companyId: info.companyId,
            deviceId: info.deviceId,
            companyName: info.companyName,
          });
        }}
      />
    );
  }

  return (
    <PosShell
      baseUrl={state.baseUrl}
      deviceToken={state.token}
      companyName={state.companyName}
      deviceId={state.deviceId}
      onSignOut={handleSignOut}
    />
  );
}

const loaderStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
  height: "100vh", fontFamily: "'Segoe UI', system-ui, sans-serif",
};
