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
import { uiText, useUiLanguage } from "../lib/appSettings";

type Step = "mode" | "role";
type ConnState = "unknown" | "checking" | "ok" | "bad";

export default function FirstRunWizard({ onChosen }: { onChosen: (m: AppMode) => void }) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
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
    if (role === "host" && !token.trim()) { setErr(text("أنشئ رمز إقران للفرع أولاً.", "Create a branch pairing code first.")); return; }
    if (role === "client") {
      if (!hostUrl.trim()) { setErr(text("أدخل عنوان الجهاز الرئيسي.", "Enter the host device address.")); return; }
      if (!token.trim()) { setErr(text("أدخل رمز الإقران.", "Enter the pairing code.")); return; }
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
      setErr(e?.message ?? text("تعذّر الحفظ", "Could not save settings."));
      setBusy(false);
    }
  }

  return (
    <div dir={language === "en" ? "ltr" : "rtl"} style={S.wrap}>
      <div style={S.card}>
        <div style={S.brand}>
          <div style={S.brandIcon}>zacode</div>
          <div>
            <div style={S.brandName}>{text("مرحباً بك في ZACOD POS", "Welcome to ZACOD POS")}</div>
            <div style={S.brandTag}>
              {step === "mode" ? text("اختر طريقة التشغيل قبل المتابعة", "Choose an operating mode to continue") : text("اختر دور الجهاز في الشبكة", "Choose this device’s network role")}
            </div>
          </div>
        </div>

        {step === "mode" && (
          <>
            <div style={S.grid}>
              <button onClick={() => void pickMode("cloud")} style={{ ...S.option, textAlign: language === "en" ? "left" : "right" }}>
                <div style={S.optionIcon}>☁️</div>
                <div style={S.optionTitle}>{text("وضع السحابة", "Cloud mode")}</div>
                <div style={S.optionDesc}>
                  {text("متصل بـ", "Connects to")} <code>zacoderp.com</code>{text(" — مزامنة تلقائية للفواتير والعملاء، لوحة تحكم سحابية، تقارير مركزية، وإدارة عبر السوبر-أدمن.", " — automatically syncs invoices and customers, with a cloud dashboard, central reports, and Super Admin management.")}
                </div>
                <ul style={S.optionList}>
                  <li>✅ {text("مفتاح ترخيص + تفعيل سحابي", "License key and cloud activation")}</li>
                  <li>✅ {text("مزامنة دورية مع السحابة", "Scheduled cloud sync")}</li>
                  <li>✅ {text("دعم متعدد الأجهزة والفروع", "Multiple devices and branches")}</li>
                  <li>✅ {text("نسخ احتياطي سحابي", "Cloud backups")}</li>
                </ul>
                <div style={S.cta}>{text("اختيار الوضع السحابي", "Choose cloud mode")} {language === "en" ? "→" : "←"}</div>
              </button>

              <button onClick={() => void pickMode("standalone")} style={{ ...S.option, textAlign: language === "en" ? "left" : "right", borderColor: "#fbbf24", background: "#fffbeb" }}>
                <div style={S.optionIcon}>🖥️</div>
                <div style={S.optionTitle}>{text("وضع مستقل (بدون سحابة)", "Standalone mode (no cloud)")}</div>
                <div style={S.optionDesc}>
                  {text("يعمل بالكامل محلياً بدون أي اتصال بالإنترنت. الترخيص ملف موقّع رقمياً تتسلّمه من مزوّد الخدمة. مناسب للمحلات التي لا تريد السحابة أو في مناطق بدون إنترنت موثوق.", "Runs locally without an internet connection. The service provider supplies a digitally signed license file. Suitable for shops that prefer not to use cloud services or have unreliable internet.")}
                </div>
                <ul style={S.optionList}>
                  <li>✅ {text("ملف ترخيص محلي", "Local license file")} (.zacolic.json)</li>
                  <li>✅ {text("مستخدمون محليون (اسم وكلمة مرور)", "Local users (username and password)")}</li>
                  <li>✅ {text("بدون أي اتصال خارجي", "No external connection")}</li>
                  <li>⚠️ {text("لا مزامنة ولا نسخ احتياطي تلقائي", "No sync or automatic backups")}</li>
                </ul>
                <div style={S.cta}>{text("اختيار الوضع المستقل", "Choose standalone mode")} {language === "en" ? "→" : "←"}</div>
              </button>
            </div>
            <div style={S.foot}>
              {text("يمكن تغيير الاختيار لاحقاً، لكن الانتقال يمحو كل البيانات المحلية في الجهاز.", "You can change this choice later, but switching modes erases all local data on this device.")}
            </div>
          </>
        )}

        {step === "role" && (
          <>
            <div style={S.roleGrid}>
              <RoleCard active={role === "single"} icon="🖥️" title={text("مستقل", "Standalone")}
                desc={text("جهاز واحد فقط بدون مشاركة عبر الشبكة. (الأنسب لمعظم المحلات)", "One device with no network sharing. (Best for most shops)")} language={language}
                onClick={() => { setRole("single"); setConn("unknown"); }} />
              <RoleCard active={role === "host"} icon="🗄️" title={text("رئيسي (Host)", "Host")}
                desc={text("يبيع + يحتفظ بقاعدة البيانات + يشغّل خادم الشبكة لبقية الأجهزة.", "Processes sales, stores the shared database, and runs the network server for other devices.")} language={language}
                onClick={() => { setRole("host"); if (!token) setToken(generateLanToken()); }} />
              <RoleCard active={role === "client"} icon="📡" title={text("فرعي (Client)", "Client")}
                desc={text("يبيع، لكن يوجّه كل القراءة والكتابة للجهاز الرئيسي عبر الشبكة.", "Processes sales but sends all reads and writes to the host over the network.")} language={language}
                onClick={() => { setRole("client"); setConn("unknown"); }} />
            </div>

            {role === "host" && (
              <div style={S.panel}>
                <div style={S.field}>
                  <label style={S.label}>{text("رمز إقران الفرع (أدخِله في كل جهاز فرعي)", "Branch pairing code (enter it on each client device)")}</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input style={S.input} value={token} readOnly />
                    <button style={S.btn} onClick={() => setToken(generateLanToken())}>{text("إنشاء رمز جديد", "Generate new code")}</button>
                  </div>
                </div>
                <div style={S.field}>
                  <label style={S.label}>{text("المنفذ (Port)", "Port")}</label>
                  <input style={{ ...S.input, maxWidth: 160 }} type="number" value={port}
                    onChange={(e) => setPort(Number(e.target.value))} />
                </div>
                <div style={S.warnBox}>{text("⚠️ بعد الإنهاء يجب إعادة تشغيل التطبيق حتى يبدأ خادم الشبكة.", "⚠️ Restart the app after finishing to start the network server.")}</div>
              </div>
            )}

            {role === "client" && (
              <div style={S.panel}>
                <div style={S.field}>
                  <label style={S.label}>{text("عنوان الجهاز الرئيسي", "Host device address")}</label>
                  <input style={S.input} value={hostUrl}
                    onChange={(e) => { setHostUrl(e.target.value); setConn("unknown"); }}
                    placeholder={`http://192.168.1.10:${DEFAULT_LAN_PORT}`} />
                </div>
                <div style={S.field}>
                  <label style={S.label}>{text("رمز الإقران", "Pairing code")}</label>
                  <input style={S.input} value={token}
                    onChange={(e) => { setToken(e.target.value); setConn("unknown"); }}
                    placeholder={text("الرمز الظاهر على الجهاز الرئيسي", "Code shown on the host device")} />
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button style={S.btn} onClick={() => void testConnection()} disabled={conn === "checking"}>
                    {conn === "checking" ? text("جارٍ الفحص…", "Checking…") : text("اختبار الاتصال", "Test connection")}
                  </button>
                  {conn === "ok" && <span style={{ ...S.badge, background: "#dcfce7", color: "#166534" }}>✅ {text("متصل", "Connected")}</span>}
                  {conn === "bad" && <span style={{ ...S.badge, background: "#fee2e2", color: "#991b1b" }}>❌ {text("تعذّر الوصول", "Could not reach host")}</span>}
                </div>
              </div>
            )}

            {err && <div style={S.errBox}>{err}</div>}

            <div style={{ display: "flex", gap: 12, justifyContent: "space-between", marginTop: 20 }}>
              <button style={S.btnGhost} onClick={() => setStep("mode")} disabled={busy}>{language === "en" ? "←" : "→"} {text("رجوع", "Back")}</button>
              <button style={S.btnPrimary} onClick={() => void finish()} disabled={busy}>
                {busy ? text("جارٍ الحفظ…", "Saving…") : `${text("إنهاء والمتابعة", "Finish and continue")} ${language === "en" ? "→" : "←"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RoleCard({ active, icon, title, desc, onClick, language }: {
  active: boolean; icon: string; title: string; desc: string; onClick: () => void; language: "ar" | "en";
}) {
  return (
    <button onClick={onClick} style={{ ...S.roleCard, textAlign: language === "en" ? "left" : "right", ...(active ? S.roleCardActive : {}) }}>
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
