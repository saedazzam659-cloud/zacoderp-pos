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

type Saved = "idle" | "saving" | "saved";
type ConnState = "unknown" | "checking" | "ok" | "bad_token" | "unreachable";

export default function NetworkSettings() {
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
    const ip = localIp ?? "<عنوان-الجهاز>";
    return `http://${ip}:${port}`;
  }, [localIp, port]);

  async function save() {
    setErr(null);
    // Validate per-role before persisting.
    if (role === "host") {
      if (!token.trim()) { setErr("أنشئ رمز إقران للفرع أولاً."); return; }
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
        setErr("منفذ غير صالح (1–65535)."); return;
      }
    }
    if (role === "client") {
      if (!hostUrl.trim()) { setErr("أدخل عنوان الجهاز الرئيسي (مثل http://192.168.1.10:7711)."); return; }
      if (!token.trim()) { setErr("أدخل رمز الإقران الظاهر على الجهاز الرئيسي."); return; }
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
      setErr(e?.message ?? "تعذّر الحفظ");
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

  if (!loaded) return <div style={S.muted}>جارٍ التحميل…</div>;

  return (
    <div dir="rtl" style={S.wrap}>
      <h2 style={S.h2}>مشاركة قاعدة البيانات عبر الشبكة المحلية (LAN)</h2>
      <p style={S.intro}>
        شغّل أكثر من جهاز كاشير في نفس الفرع على قاعدة بيانات واحدة بدون إنترنت.
        جهاز واحد يكون «الرئيسي» (يحتفظ بالبيانات)، والباقي «أجهزة فرعية» تتصل به
        عبر شبكة الفرع (Wi-Fi أو سويتش).
      </p>

      {/* Role selector */}
      <div style={S.roleGrid}>
        <RoleCard
          active={role === "single"} icon="🖥️" title="مستقل"
          desc="جهاز واحد فقط — قاعدة بيانات محلية بدون مشاركة (الوضع الافتراضي)."
          onClick={() => setRole("single")}
        />
        <RoleCard
          active={role === "host"} icon="🗄️" title="رئيسي (Host)"
          desc="يبيع + يحتفظ بقاعدة البيانات + يشغّل خادم الشبكة لبقية الأجهزة."
          onClick={() => setRole("host")}
        />
        <RoleCard
          active={role === "client"} icon="📡" title="فرعي (Client)"
          desc="يبيع، لكن كل القراءة والكتابة تُوجَّه للجهاز الرئيسي عبر الشبكة."
          onClick={() => setRole("client")}
        />
      </div>

      {/* Host config */}
      {role === "host" && (
        <div style={S.panel}>
          <h3 style={S.h3}>إعداد الجهاز الرئيسي</h3>
          <div style={S.field}>
            <label style={S.label}>رمز إقران الفرع</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input style={S.input} value={token} readOnly placeholder="اضغط «إنشاء رمز»" />
              <button style={S.btn} onClick={() => setToken(generateLanToken())}>إنشاء رمز</button>
            </div>
            <div style={S.hint}>أدخِل هذا الرمز نفسه في كل جهاز فرعي عند الإقران.</div>
          </div>
          <div style={S.field}>
            <label style={S.label}>المنفذ (Port)</label>
            <input
              style={{ ...S.input, maxWidth: 160 }}
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </div>
          <div style={S.addrBox}>
            <div style={S.addrLabel}>عنوان الجهاز الرئيسي (أدخِله في الأجهزة الفرعية):</div>
            <code style={S.addrCode}>{hostAddress()}</code>
            {!localIp && IS_TAURI && (
              <div style={S.hint}>تعذّر اكتشاف عنوان IP تلقائياً — استخدم <code>ipconfig</code> لمعرفته.</div>
            )}
          </div>
          <div style={S.warnBox}>
            ⚠️ بعد الحفظ يجب <b>إعادة تشغيل التطبيق</b> على هذا الجهاز حتى يبدأ خادم الشبكة بالعمل.
          </div>
        </div>
      )}

      {/* Client config */}
      {role === "client" && (
        <div style={S.panel}>
          <h3 style={S.h3}>إعداد الجهاز الفرعي</h3>
          <div style={S.field}>
            <label style={S.label}>عنوان الجهاز الرئيسي</label>
            <input
              style={S.input}
              value={hostUrl}
              onChange={(e) => { setHostUrl(e.target.value); setConn("unknown"); }}
              placeholder={`http://192.168.1.10:${DEFAULT_LAN_PORT}`}
            />
          </div>
          <div style={S.field}>
            <label style={S.label}>رمز الإقران</label>
            <input
              style={S.input}
              value={token}
              onChange={(e) => { setToken(e.target.value); setConn("unknown"); }}
              placeholder="الرمز الظاهر على الجهاز الرئيسي"
            />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button style={S.btn} onClick={() => void testConnection()} disabled={conn === "checking"}>
              {conn === "checking" ? "جارٍ الفحص…" : "اختبار الاتصال"}
            </button>
            <ConnBadge state={conn} />
          </div>
          <div style={S.warnBox}>
            ℹ️ على الجهاز الفرعي لا تتوفّر المزامنة السحابية — تتم من الجهاز الرئيسي فقط.
          </div>
        </div>
      )}

      {err && <div style={S.errBox}>{err}</div>}

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16 }}>
        <button style={S.btnPrimary} onClick={() => void save()} disabled={saved === "saving"}>
          {saved === "saving" ? "جارٍ الحفظ…" : "حفظ الإعدادات"}
        </button>
        {saved === "saved" && <span style={S.okText}>✅ تم الحفظ</span>}
      </div>
    </div>
  );
}

function RoleCard({ active, icon, title, desc, onClick }: {
  active: boolean; icon: string; title: string; desc: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={{ ...S.roleCard, ...(active ? S.roleCardActive : {}) }}>
      <div style={{ fontSize: 30 }}>{icon}</div>
      <div style={S.roleTitle}>{title}</div>
      <div style={S.roleDesc}>{desc}</div>
    </button>
  );
}

function ConnBadge({ state }: { state: ConnState }) {
  if (state === "ok") return <span style={{ ...S.badge, background: "#dcfce7", color: "#166534" }}>✅ متصل بالجهاز الرئيسي</span>;
  if (state === "unreachable") return <span style={{ ...S.badge, background: "#fee2e2", color: "#991b1b" }}>❌ تعذّر الوصول — تأكد من الشبكة والعنوان والرمز</span>;
  if (state === "checking") return <span style={{ ...S.badge, background: "#fef9c3", color: "#854d0e" }}>… جارٍ الفحص</span>;
  return null;
}

const S = {
  wrap: { maxWidth: 820 } as const,
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
