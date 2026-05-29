// First-run wizard — Task #199 (app-mode) + Task #207 (network-role).
//
// Step 1 — operating mode (persisted as `pos_desktop_app_mode`):
//   • Cloud      — keeps the original activation flow (license key → cloud sync)
//   • Standalone — switches to local SQLite + signed-license-file flow
//
// Step 2 — network role (persisted as `net_role` + LAN settings):
//   • single — one device, own local DB, no LAN (default).
//   • host   — sells + holds the shared DB + runs the LAN server.
//   • client — sells, but routes all shared reads/writes to the host over LAN.
//
// The mode choice is destructive to switch later; the network role can be
// changed freely from Settings → مشاركة الشبكة.

import { useState } from "react";
import {
  setAppMode, type AppMode,
  setNetRole, setLanHostUrl, setLanToken, setLanPort,
  generateLanToken, DEFAULT_LAN_PORT, type NetRole,
} from "../lib/standalone";
import { refreshBridge, pingHostAt } from "../lib/bridge";

type Step = "mode" | "role";
type ConnState = "unknown" | "checking" | "ok" | "bad";

export default function FirstRunWizard({ onChosen }: { onChosen: (m: AppMode) => void }) {
  const [step, setStep] = useState<Step>("mode");
  const [mode, setMode] = useState<AppMode | null>(null);
  const [role, setRole] = useState<NetRole>("single");
  const [hostUrl, setHostUrl] = useState("");
  const [token, setToken] = useState("");
  const [port, setPort] = useState<number>(DEFAULT_LAN_PORT);
  const [conn, setConn] = useState<ConnState>("unknown");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pickMode(m: AppMode) {
    await setAppMode(m);
    setMode(m);
    setStep("role");
  }

  async function testConnection() {
    setConn("checking");
    // Side-effect-FREE probe — do NOT persist role/host/token here; the choice
    // is only committed in finish().
    const res = await pingHostAt(hostUrl.trim(), token.trim());
    setConn(res.ok ? "ok" : "bad");
  }

  async function finish() {
    if (!mode) return;
    setErr(null);
    if (role === "host" && !token.trim()) { setErr("أنشئ رمز إقران للفرع أولاً."); return; }
    if (role === "client") {
      if (!hostUrl.trim()) { setErr("أدخل عنوان الجهاز الرئيسي."); return; }
      if (!token.trim()) { setErr("أدخل رمز الإقران."); return; }
    }
    setBusy(true);
    try {
      await setNetRole(role);
      if (role === "host") {
        await setLanToken(token);
        await setLanPort(port);
      } else if (role === "client") {
        await setLanHostUrl(hostUrl.trim().replace(/\/+$/, ""));
        await setLanToken(token);
      }
      await refreshBridge();
      onChosen(mode);
    } catch (e: any) {
      setErr(e?.message ?? "تعذّر الحفظ");
      setBusy(false);
    }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.card}>
        <div style={S.brand}>
          <div style={S.brandIcon}>zacode</div>
          <div>
            <div style={S.brandName}>مرحباً بك في ZACOD POS</div>
            <div style={S.brandTag}>
              {step === "mode" ? "اختر طريقة التشغيل قبل المتابعة" : "اختر دور الجهاز في الشبكة"}
            </div>
          </div>
        </div>

        {step === "mode" && (
          <>
            <div style={S.grid}>
              <button onClick={() => void pickMode("cloud")} style={S.option}>
                <div style={S.optionIcon}>☁️</div>
                <div style={S.optionTitle}>وضع السحابة</div>
                <div style={S.optionDesc}>
                  متصل بـ <code>zacoderp.com</code> — مزامنة تلقائية للفواتير والعملاء،
                  لوحة تحكم سحابية، تقارير مركزية، وإدارة عبر السوبر-أدمن.
                </div>
                <ul style={S.optionList}>
                  <li>✅ مفتاح ترخيص + تفعيل سحابي</li>
                  <li>✅ مزامنة دورية مع السحابة</li>
                  <li>✅ دعم متعدد الأجهزة والفروع</li>
                  <li>✅ نسخ احتياطي سحابي</li>
                </ul>
                <div style={S.cta}>اختيار الوضع السحابي ←</div>
              </button>

              <button onClick={() => void pickMode("standalone")} style={{ ...S.option, borderColor: "#fbbf24", background: "#fffbeb" }}>
                <div style={S.optionIcon}>🖥️</div>
                <div style={S.optionTitle}>وضع مستقل (بدون سحابة)</div>
                <div style={S.optionDesc}>
                  يعمل بالكامل محلياً بدون أي اتصال بالإنترنت. الترخيص ملف موقّع رقمياً تتسلّمه
                  من مزوّد الخدمة. مناسب للمحلات التي لا تريد السحابة أو في مناطق بدون إنترنت موثوق.
                </div>
                <ul style={S.optionList}>
                  <li>✅ ملف ترخيص محلي (.zacolic.json)</li>
                  <li>✅ مستخدمون محليون (اسم وكلمة مرور)</li>
                  <li>✅ بدون أي اتصال خارجي</li>
                  <li>⚠️ لا مزامنة ولا نسخ احتياطي تلقائي</li>
                </ul>
                <div style={S.cta}>اختيار الوضع المستقل ←</div>
              </button>
            </div>
            <div style={S.foot}>
              يمكن تغيير الاختيار لاحقاً، لكن الانتقال يمحو كل البيانات المحلية في الجهاز.
            </div>
          </>
        )}

        {step === "role" && (
          <>
            <div style={S.roleGrid}>
              <RoleCard active={role === "single"} icon="🖥️" title="مستقل"
                desc="جهاز واحد فقط بدون مشاركة عبر الشبكة. (الأنسب لمعظم المحلات)"
                onClick={() => { setRole("single"); setConn("unknown"); }} />
              <RoleCard active={role === "host"} icon="🗄️" title="رئيسي (Host)"
                desc="يبيع + يحتفظ بقاعدة البيانات + يشغّل خادم الشبكة لبقية الأجهزة."
                onClick={() => { setRole("host"); if (!token) setToken(generateLanToken()); }} />
              <RoleCard active={role === "client"} icon="📡" title="فرعي (Client)"
                desc="يبيع، لكن يوجّه كل القراءة والكتابة للجهاز الرئيسي عبر الشبكة."
                onClick={() => { setRole("client"); setConn("unknown"); }} />
            </div>

            {role === "host" && (
              <div style={S.panel}>
                <div style={S.field}>
                  <label style={S.label}>رمز إقران الفرع (أدخِله في كل جهاز فرعي)</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input style={S.input} value={token} readOnly />
                    <button style={S.btn} onClick={() => setToken(generateLanToken())}>إنشاء رمز جديد</button>
                  </div>
                </div>
                <div style={S.field}>
                  <label style={S.label}>المنفذ (Port)</label>
                  <input style={{ ...S.input, maxWidth: 160 }} type="number" value={port}
                    onChange={(e) => setPort(Number(e.target.value))} />
                </div>
                <div style={S.warnBox}>⚠️ بعد الإنهاء يجب إعادة تشغيل التطبيق حتى يبدأ خادم الشبكة.</div>
              </div>
            )}

            {role === "client" && (
              <div style={S.panel}>
                <div style={S.field}>
                  <label style={S.label}>عنوان الجهاز الرئيسي</label>
                  <input style={S.input} value={hostUrl}
                    onChange={(e) => { setHostUrl(e.target.value); setConn("unknown"); }}
                    placeholder={`http://192.168.1.10:${DEFAULT_LAN_PORT}`} />
                </div>
                <div style={S.field}>
                  <label style={S.label}>رمز الإقران</label>
                  <input style={S.input} value={token}
                    onChange={(e) => { setToken(e.target.value); setConn("unknown"); }}
                    placeholder="الرمز الظاهر على الجهاز الرئيسي" />
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button style={S.btn} onClick={() => void testConnection()} disabled={conn === "checking"}>
                    {conn === "checking" ? "جارٍ الفحص…" : "اختبار الاتصال"}
                  </button>
                  {conn === "ok" && <span style={{ ...S.badge, background: "#dcfce7", color: "#166534" }}>✅ متصل</span>}
                  {conn === "bad" && <span style={{ ...S.badge, background: "#fee2e2", color: "#991b1b" }}>❌ تعذّر الوصول</span>}
                </div>
              </div>
            )}

            {err && <div style={S.errBox}>{err}</div>}

            <div style={{ display: "flex", gap: 12, justifyContent: "space-between", marginTop: 20 }}>
              <button style={S.btnGhost} onClick={() => setStep("mode")} disabled={busy}>→ رجوع</button>
              <button style={S.btnPrimary} onClick={() => void finish()} disabled={busy}>
                {busy ? "جارٍ الحفظ…" : "إنهاء والمتابعة ←"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RoleCard({ active, icon, title, desc, onClick }: {
  active: boolean; icon: string; title: string; desc: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={{ ...S.roleCard, ...(active ? S.roleCardActive : {}) }}>
      <div style={{ fontSize: 32 }}>{icon}</div>
      <div style={S.roleTitle}>{title}</div>
      <div style={S.roleDesc}>{desc}</div>
    </button>
  );
}

const S = {
  wrap: { minHeight: "100vh", background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'Segoe UI', system-ui, sans-serif" } as const,
  card: { maxWidth: 1000, width: "100%", background: "#fff", borderRadius: 16, padding: 32, boxShadow: "0 20px 60px rgba(0,0,0,.3)" } as const,
  brand: { display: "flex", gap: 16, alignItems: "center", marginBottom: 24, paddingBottom: 24, borderBottom: "1px solid #e2e8f0" } as const,
  brandIcon: { minWidth: 72, height: 48, borderRadius: 12, background: "linear-gradient(135deg, #22d3ee, #2563eb)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 14, letterSpacing: 0.5 } as const,
  brandName: { fontSize: 22, fontWeight: 700, color: "#0f172a" } as const,
  brandTag: { fontSize: 13, color: "#64748b", marginTop: 4 } as const,
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 } as const,
  option: { textAlign: "right" as const, padding: 24, borderRadius: 12, border: "2px solid #cbd5e1", background: "#f8fafc", cursor: "pointer", fontFamily: "inherit", transition: "all .15s", display: "flex", flexDirection: "column" as const, gap: 8 } as const,
  optionIcon: { fontSize: 40, marginBottom: 8 } as const,
  optionTitle: { fontSize: 18, fontWeight: 700, color: "#0f172a" } as const,
  optionDesc: { fontSize: 13, lineHeight: 1.7, color: "#475569" } as const,
  optionList: { listStyle: "none", padding: 0, margin: "8px 0", fontSize: 13, lineHeight: 2, color: "#334155" } as const,
  cta: { marginTop: "auto", paddingTop: 12, fontWeight: 700, color: "#2563eb" } as const,
  foot: { marginTop: 20, fontSize: 12, color: "#94a3b8", textAlign: "center" as const } as const,
  roleGrid: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 } as const,
  roleCard: { textAlign: "right" as const, padding: 16, borderRadius: 12, border: "2px solid #cbd5e1", background: "#f8fafc", cursor: "pointer", fontFamily: "inherit", display: "flex", flexDirection: "column" as const, gap: 6 } as const,
  roleCardActive: { borderColor: "#2563eb", background: "#eff6ff", boxShadow: "0 0 0 3px rgba(37,99,235,.12)" } as const,
  roleTitle: { fontSize: 16, fontWeight: 700, color: "#0f172a" } as const,
  roleDesc: { fontSize: 12, lineHeight: 1.6, color: "#64748b" } as const,
  panel: { padding: 20, borderRadius: 12, border: "1px solid #e2e8f0", background: "#f8fafc", marginBottom: 12 } as const,
  field: { marginBottom: 16 } as const,
  label: { display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 } as const,
  input: { width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" as const } as const,
  btn: { padding: "10px 16px", borderRadius: 8, border: "1px solid #cbd5e1", background: "#f1f5f9", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" as const } as const,
  btnPrimary: { padding: "12px 28px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 15, fontWeight: 700 } as const,
  btnGhost: { padding: "12px 20px", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff", color: "#475569", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600 } as const,
  warnBox: { padding: 12, borderRadius: 8, background: "#fffbeb", border: "1px solid #fde68a", fontSize: 13, color: "#92400e", lineHeight: 1.7 } as const,
  errBox: { marginTop: 12, padding: 12, borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", fontSize: 13, color: "#991b1b" } as const,
  badge: { padding: "6px 12px", borderRadius: 999, fontSize: 12, fontWeight: 700 } as const,
};
