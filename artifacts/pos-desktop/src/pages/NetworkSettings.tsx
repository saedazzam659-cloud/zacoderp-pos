// LAN shared-database settings (Task #207).
//
// Lets the operator put this device into one of three network roles:
//   • single — the default standalone behaviour (own local DB, no LAN).
//   • host   — this device owns the shared SQLite file AND runs a small LAN
//              server so the other tills route their reads/writes here.
//   • client — this device owns NO data; every shared call is forwarded to
//              the host over the LAN.
//
// Starting / stopping the host's HTTP server happens in the Rust `setup()`
// at launch, so after switching to/from "host" the app must be restarted for
// the server to bind (or release) the port. We surface that clearly.

import { useCallback, useEffect, useState } from "react";
import { IS_TAURI, tauriInvoke } from "../lib/localStore";
import {
  getNetRole, setNetRole,
  getLanHostUrl, setLanHostUrl,
  getLanToken, setLanToken,
  getLanPort, setLanPort,
  generateLanToken, DEFAULT_LAN_PORT,
  type NetRole,
} from "../lib/standalone";
import { refreshBridge, pingHostAt } from "../lib/bridge";
import { uiText, useUiLanguage } from "../lib/appSettings";

type Saved = "idle" | "saving" | "saved";
type ConnState = "unknown" | "checking" | "ok" | "bad_token" | "unreachable";

export default function NetworkSettings() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [role, setRole] = useState<NetRole>("single");
  const [hostUrl, setHostUrl] = useState("");
  const [token, setToken] = useState("");
  const [port, setPort] = useState<number>(DEFAULT_LAN_PORT);
  const [localIp, setLocalIp] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<Saved>("idle");
  const [conn, setConn] = useState<ConnState>("unknown");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [r, h, t, p] = await Promise.all([
        getNetRole(), getLanHostUrl(), getLanToken(), getLanPort(),
      ]);
      if (cancelled) return;
      setRole(r);
      setHostUrl(h ?? "");
      setToken(t ?? "");
      setPort(p);
      setLoaded(true);
      if (IS_TAURI) {
        try {
          const ip = await tauriInvoke<string | null>("lan_local_ip");
          if (!cancelled) setLocalIp(ip);
        } catch { /* ignore — IP is informational only */ }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const hostAddress = useCallback(() => {
    const ip = localIp ?? (language === "en" ? "<device-address>" : "<عنوان-الجهاز>");
    return `http://${ip}:${port}`;
  }, [localIp, port, language]);

  async function save() {
    setErr(null);
    // Validate per-role before persisting.
    if (role === "host") {
      if (!token.trim()) { setErr(text("أنشئ رمز إقران للفرع أولاً.", "Generate a pairing token for this branch first.")); return; }
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
        setErr(text("منفذ غير صالح (1–65535).", "Enter a valid port (1–65535).")); return;
      }
    }
    if (role === "client") {
      if (!hostUrl.trim()) { setErr(text("أدخل عنوان الجهاز الرئيسي (مثل http://192.168.1.10:7711).", "Enter the host device address (for example, http://192.168.1.10:7711).")); return; }
      if (!token.trim()) { setErr(text("أدخل رمز الإقران الظاهر على الجهاز الرئيسي.", "Enter the pairing token shown on the host device.")); return; }
    }
    setSaved("saving");
    try {
      await setNetRole(role);
      if (role === "host") {
        await setLanToken(token);
        await setLanPort(port);
      } else if (role === "client") {
        await setLanHostUrl(hostUrl);
        await setLanToken(token);
      }
      await refreshBridge();
      setSaved("saved");
      setTimeout(() => setSaved("idle"), 2500);
    } catch (e: any) {
      setErr(e?.message ?? text("تعذّر الحفظ", "Could not save network settings."));
      setSaved("idle");
    }
  }

  async function testConnection() {
    setConn("checking");
    // Side-effect-FREE probe against the form values — must NOT persist
    // net_role/host_url/token, or testing would silently flip this device to
    // client mode before the operator hits Save.
    const res = await pingHostAt(hostUrl.trim(), token.trim());
    setConn(res.ok ? "ok" : "unreachable");
  }

  if (!loaded) return <div style={S.muted}>{text("جارٍ التحميل…", "Loading…")}</div>;

  return (
    <div dir={language === "en" ? "ltr" : "rtl"} style={S.wrap}>
      <h2 style={S.h2}>{text("مشاركة قاعدة البيانات عبر الشبكة المحلية (LAN)", "Share the database over the local network (LAN)")}</h2>
      <p style={S.intro}>
        {text(
          "شغّل أكثر من جهاز كاشير في نفس الفرع على قاعدة بيانات واحدة بدون إنترنت. جهاز واحد يكون «الرئيسي» (يحتفظ بالبيانات)، والباقي «أجهزة فرعية» تتصل به عبر شبكة الفرع (Wi-Fi أو سويتش).",
          "Run multiple tills in one branch against a shared database without internet. One device is the host and stores the data; the other devices connect to it over the branch network (Wi-Fi or Ethernet switch).",
        )}
      </p>

      {/* Role selector */}
      <div style={S.roleGrid}>
        <RoleCard
          active={role === "single"} icon="🖥️" title={text("مستقل", "Standalone")}
          desc={text("جهاز واحد فقط — قاعدة بيانات محلية بدون مشاركة (الوضع الافتراضي).", "One device with its own local database (default mode).")}
          onClick={() => setRole("single")}
        />
        <RoleCard
          active={role === "host"} icon="🗄️" title={text("رئيسي (Host)", "Host")}
          desc={text("يبيع + يحتفظ بقاعدة البيانات + يشغّل خادم الشبكة لبقية الأجهزة.", "Processes sales, stores the shared database, and runs the network server for other devices.")}
          onClick={() => setRole("host")}
        />
        <RoleCard
          active={role === "client"} icon="📡" title={text("فرعي (Client)", "Client")}
          desc={text("يبيع، لكن كل القراءة والكتابة تُوجَّه للجهاز الرئيسي عبر الشبكة.", "Processes sales while all reads and writes are routed to the host over the network.")}
          onClick={() => setRole("client")}
        />
      </div>

      {/* Host config */}
      {role === "host" && (
        <div style={S.panel}>
          <h3 style={S.h3}>{text("إعداد الجهاز الرئيسي", "Host setup")}</h3>
          <div style={S.field}>
            <label style={S.label}>{text("رمز إقران الفرع", "Branch pairing token")}</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input style={{ ...S.input, direction: "ltr" }} value={token} readOnly placeholder={text("اضغط «إنشاء رمز»", "Select “Generate token”")} />
              <button style={S.btn} onClick={() => setToken(generateLanToken())}>{text("إنشاء رمز", "Generate token")}</button>
            </div>
            <div style={S.hint}>{text("أدخِل هذا الرمز نفسه في كل جهاز فرعي عند الإقران.", "Enter this same token on each client device when pairing.")}</div>
          </div>
          <div style={S.field}>
            <label style={S.label}>{text("المنفذ (Port)", "Port")}</label>
            <input
              style={{ ...S.input, maxWidth: 160 }}
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </div>
          <div style={S.addrBox}>
            <div style={S.addrLabel}>{text("عنوان الجهاز الرئيسي (أدخِله في الأجهزة الفرعية):", "Host address (enter this on the client devices):")}</div>
            <code style={S.addrCode}>{hostAddress()}</code>
            {!localIp && IS_TAURI && (
              <div style={S.hint}>{text("تعذّر اكتشاف عنوان IP تلقائياً — استخدم", "Could not detect the IP address automatically. Use")} <code>ipconfig</code> {text("لمعرفته.", "to find it.")}</div>
            )}
          </div>
          <div style={S.warnBox}>
            ⚠️ {text("بعد الحفظ يجب", "After saving,")} <b>{text("إعادة تشغيل التطبيق", "restart the app")}</b> {text("على هذا الجهاز حتى يبدأ خادم الشبكة بالعمل.", "on this device so the network server can start.")}
          </div>
        </div>
      )}

      {/* Client config */}
      {role === "client" && (
        <div style={S.panel}>
          <h3 style={S.h3}>{text("إعداد الجهاز الفرعي", "Client setup")}</h3>
          <div style={S.field}>
            <label style={S.label}>{text("عنوان الجهاز الرئيسي", "Host address")}</label>
            <input
              style={{ ...S.input, direction: "ltr" }}
              value={hostUrl}
              onChange={(e) => { setHostUrl(e.target.value); setConn("unknown"); }}
              placeholder={`http://192.168.1.10:${DEFAULT_LAN_PORT}`}
            />
          </div>
          <div style={S.field}>
            <label style={S.label}>{text("رمز الإقران", "Pairing token")}</label>
            <input
              style={{ ...S.input, direction: "ltr" }}
              value={token}
              onChange={(e) => { setToken(e.target.value); setConn("unknown"); }}
              placeholder={text("الرمز الظاهر على الجهاز الرئيسي", "Token shown on the host device")}
            />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button style={S.btn} onClick={() => void testConnection()} disabled={conn === "checking"}>
              {conn === "checking" ? text("جارٍ الفحص…", "Checking…") : text("اختبار الاتصال", "Test connection")}
            </button>
            <ConnBadge state={conn} language={language} />
          </div>
          <div style={S.warnBox}>
            ℹ️ {text("على الجهاز الفرعي لا تتوفّر المزامنة السحابية — تتم من الجهاز الرئيسي فقط.", "Cloud sync is unavailable on client devices and runs on the host only.")}
          </div>
        </div>
      )}

      {err && <div style={S.errBox}>{err}</div>}

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16 }}>
        <button style={S.btnPrimary} onClick={() => void save()} disabled={saved === "saving"}>
          {saved === "saving" ? text("جارٍ الحفظ…", "Saving…") : text("حفظ الإعدادات", "Save settings")}
        </button>
        {saved === "saved" && <span style={S.okText}>✅ {text("تم الحفظ", "Saved")}</span>}
      </div>
    </div>
  );
}

function RoleCard({ active, icon, title, desc, onClick }: {
  active: boolean; icon: string; title: string; desc: string; onClick: () => void;
}) {
  return (
      <button onClick={onClick} style={{ ...S.roleCard, textAlign: useUiLanguage() === "en" ? "left" : "right", ...(active ? S.roleCardActive : {}) }}>
      <div style={{ fontSize: 30 }}>{icon}</div>
      <div style={S.roleTitle}>{title}</div>
      <div style={S.roleDesc}>{desc}</div>
    </button>
  );
}

function ConnBadge({ state, language }: { state: ConnState; language: "ar" | "en" }) {
  if (state === "ok") return <span style={{ ...S.badge, background: "#dcfce7", color: "#166534" }}>{uiText("✅ متصل بالجهاز الرئيسي", "✅ Connected to host", language)}</span>;
  if (state === "unreachable") return <span style={{ ...S.badge, background: "#fee2e2", color: "#991b1b" }}>{uiText("❌ تعذّر الوصول — تأكد من الشبكة والعنوان والرمز", "❌ Host unreachable — check the network, address, and token", language)}</span>;
  if (state === "checking") return <span style={{ ...S.badge, background: "#fef9c3", color: "#854d0e" }}>{uiText("… جارٍ الفحص", "… Checking", language)}</span>;
  return null;
}

const S = {
  wrap: { width: "100%", maxWidth: "none", minWidth: 0, boxSizing: "border-box" as const },
  h2: { fontSize: 20, fontWeight: 800, color: "#0f172a", marginBottom: 8 } as const,
  h3: { fontSize: 15, fontWeight: 700, color: "#0f172a", marginBottom: 12 } as const,
  intro: { fontSize: 13, lineHeight: 1.8, color: "#475569", marginBottom: 20 } as const,
  muted: { color: "#94a3b8", padding: 24 } as const,
  roleGrid: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 } as const,
  roleCard: { textAlign: "right" as const, padding: 16, borderRadius: 12, border: "2px solid #cbd5e1", background: "#f8fafc", cursor: "pointer", fontFamily: "inherit", display: "flex", flexDirection: "column" as const, gap: 6 } as const,
  roleCardActive: { borderColor: "#2563eb", background: "#eff6ff", boxShadow: "0 0 0 3px rgba(37,99,235,.12)" } as const,
  roleTitle: { fontSize: 16, fontWeight: 700, color: "#0f172a" } as const,
  roleDesc: { fontSize: 12, lineHeight: 1.6, color: "#64748b" } as const,
  panel: { padding: 20, borderRadius: 12, border: "1px solid #e2e8f0", background: "#fff", marginBottom: 16 } as const,
  field: { marginBottom: 16 } as const,
  label: { display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 } as const,
  input: { width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" as const } as const,
  hint: { fontSize: 12, color: "#94a3b8", marginTop: 6 } as const,
  btn: { padding: "10px 16px", borderRadius: 8, border: "1px solid #cbd5e1", background: "#f1f5f9", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" as const } as const,
  btnPrimary: { padding: "12px 24px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700 } as const,
  addrBox: { padding: 14, borderRadius: 8, background: "#f0fdf4", border: "1px solid #bbf7d0", marginTop: 4 } as const,
  addrLabel: { fontSize: 12, color: "#166534", marginBottom: 6, fontWeight: 600 } as const,
  addrCode: { fontSize: 16, fontWeight: 700, color: "#15803d", direction: "ltr" as const, display: "inline-block" } as const,
  warnBox: { marginTop: 12, padding: 12, borderRadius: 8, background: "#fffbeb", border: "1px solid #fde68a", fontSize: 13, color: "#92400e", lineHeight: 1.7 } as const,
  errBox: { marginTop: 12, padding: 12, borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", fontSize: 13, color: "#991b1b" } as const,
  okText: { color: "#16a34a", fontWeight: 700, fontSize: 14 } as const,
  badge: { padding: "6px 12px", borderRadius: 999, fontSize: 12, fontWeight: 700 } as const,
};
