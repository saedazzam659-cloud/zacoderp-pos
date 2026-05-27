// 6-step activation wizard — Task #174 Step 8 (UI half).
//
// Step layout (all RTL Arabic):
//   1. Welcome
//   2. License agreement
//   3. Server URL + country
//   4. Network reachability check (calls /api/public/download/countries)
//   5. License key entry
//   6. Hardware fingerprint preview + activate → store token
//
// The wizard talks to the cloud via createApi() and persists the device token
// through tauri-shim's saveDeviceToken(). Hardware fingerprint comes from
// tauri-shim's getFingerprint() — real Tauri build collects 4 hw identifiers,
// browser dev build uses a localStorage-backed pseudo-fingerprint.

import { useState, useEffect } from "react";
import { createApi, ApiError } from "../lib/api";
import {
  getFingerprint, getDeviceName, getOsInfo, getAppVersion,
  saveDeviceToken, TAURI_MODE,
} from "../lib/tauri-shim";
import { setAppMode } from "../lib/standalone";

type Country = { code: string; name: string };

const STEP_TITLES = [
  "مرحباً بك في ZACOD POS",
  "اتفاقية الترخيص",
  "إعدادات الاتصال",
  "اختبار الاتصال بالخادم",
  "إدخال مفتاح الترخيص",
  "بصمة الجهاز والتفعيل",
];

const SERVER_PRESETS = [
  { label: "السحابة الرسمية (zacoderp.com)", url: "https://zacoderp.com" },
  { label: "مخصص…", url: "" },
];

export type ActivatedInfo = {
  deviceToken: string;
  deviceId: number;
  companyId: number;
  companyName: string;
  expiresAt: string | null;
};

export default function Activation({ onActivated }: { onActivated: (info: ActivatedInfo) => void }) {
  const [step, setStep] = useState(0);
  const [accepted, setAccepted] = useState(false);

  const [serverPreset, setServerPreset] = useState(0);
  const [serverUrl, setServerUrl] = useState(SERVER_PRESETS[0].url);
  const [country, setCountry] = useState("SA");

  const [licenseKey, setLicenseKey] = useState("");

  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string>("");
  const [appVersion, setAppVersion] = useState<string>("");
  const [osInfo, setOsInfo] = useState<string>("");

  const [countries, setCountries] = useState<Country[] | null>(null);
  const [ping, setPing] = useState<"idle" | "ok" | "fail">("idle");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ─── Load hardware identifiers once at mount ────────────────────────
  useEffect(() => {
    (async () => {
      setFingerprint(await getFingerprint());
      setDeviceName(await getDeviceName());
      setOsInfo(await getOsInfo());
      setAppVersion(await getAppVersion());
    })();
  }, []);

  function effectiveUrl() {
    const u = (serverPreset === 0 ? SERVER_PRESETS[0].url : serverUrl).trim();
    return u.replace(/\/$/, "");
  }

  // ─── Step 4: network test ───────────────────────────────────────────
  async function testConnection() {
    setBusy(true); setErr(null); setPing("idle");
    try {
      const api = createApi({ baseUrl: effectiveUrl() });
      const cs = await api.publicCountries();
      setCountries(cs);
      setPing("ok");
    } catch (e: any) {
      setPing("fail");
      setErr(e?.message ?? "تعذّر الاتصال بالخادم. تأكد من الإنترنت والعنوان.");
    } finally {
      setBusy(false);
    }
  }

  // ─── Step 6: finalize activation ────────────────────────────────────
  async function finalize() {
    if (!fingerprint) { setErr("بصمة الجهاز غير جاهزة"); return; }
    setBusy(true); setErr(null);
    try {
      const api = createApi({ baseUrl: effectiveUrl() });
      const r = await api.activate({
        licenseKey: licenseKey.trim(),
        fingerprint,
        deviceName,
        osInfo,
        appVersion,
      });
      await saveDeviceToken(r.deviceToken);
      localStorage.setItem("pos_desktop_server_url", effectiveUrl());
      localStorage.setItem("pos_desktop_country", country);
      onActivated({
        deviceToken: r.deviceToken,
        deviceId: r.deviceId,
        companyId: r.companyId,
        companyName: r.companyName,
        expiresAt: r.expiresAt,
      });
    } catch (e: any) {
      if (e instanceof ApiError) {
        const codeMap: Record<number, string> = {
          400: "بيانات غير صحيحة. راجع مفتاح الترخيص.",
          403: "الترخيص غير مفعّل لشركتك. تواصل مع الإدارة.",
          404: "مفتاح الترخيص غير موجود.",
          409: "هذا الترخيص مرتبط بجهاز آخر. اطلب من المسؤول فكّ الربط أولاً.",
        };
        setErr(codeMap[e.status] ?? `خطأ ${e.status}: ${e.message}`);
      } else {
        setErr(e?.message ?? "فشل التفعيل");
      }
    } finally {
      setBusy(false);
    }
  }

  // ─── Step-gating ────────────────────────────────────────────────────
  function canAdvance(): boolean {
    switch (step) {
      case 0: return true;
      case 1: return accepted;
      case 2: return effectiveUrl().startsWith("http");
      case 3: return ping === "ok";
      case 4: return licenseKey.trim().length >= 8;
      case 5: return false;
      default: return false;
    }
  }

  function next() {
    if (step === 2) { setStep(3); setTimeout(testConnection, 100); return; }
    setStep(Math.min(STEP_TITLES.length - 1, step + 1));
  }

  // ─── Render ────────────────────────────────────────────────────────
  return (
    <div dir="rtl" style={S.wrap}>
      <header style={S.header}>
        <h1 style={S.title}>{STEP_TITLES[step]}</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={async () => {
              if (!confirm("هل تريد العودة لاختيار طريقة التشغيل (سحابي / مستقل)؟")) return;
              await setAppMode(null as never);
              location.reload();
            }}
            style={{ padding: "6px 12px", fontSize: 13, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", color: "#475569" }}
            title="العودة لاختيار طريقة التشغيل"
          >
            ← تغيير الوضع
          </button>
          <div style={S.mode}>
            {TAURI_MODE === "tauri" ? "🪟 وضع التطبيق الأصلي" : "🌐 وضع المتصفح (تطوير)"}
          </div>
        </div>
      </header>

      <div style={S.progressBg}>
        <div style={{ ...S.progressFg, width: `${((step + 1) / STEP_TITLES.length) * 100}%` }} />
      </div>
      <div style={S.stepCounter}>الخطوة {step + 1} من {STEP_TITLES.length}</div>

      <main style={S.main}>
        {step === 0 && (
          <div>
            <p style={S.lead}>سيتم تثبيت تطبيق نقاط البيع المتصل بحسابك السحابي.</p>
            <ul style={S.bullets}>
              <li>✅ يعمل أثناء انقطاع الإنترنت (قاعدة بيانات محلية مشفّرة)</li>
              <li>✅ مزامنة تلقائية للفواتير والعملاء فور عودة الاتصال</li>
              <li>✅ توقيع فواتير ZATCA Phase 2 محلياً</li>
              <li>✅ دعم الطابعات الحرارية ودرج النقود وقارئ الباركود</li>
            </ul>
          </div>
        )}

        {step === 1 && (
          <div>
            <p>راجع شروط الاستخدام واتفاقية ترخيص المستخدم النهائي (EULA) قبل المتابعة.</p>
            <div style={S.eulaBox}>
              يحق لك تثبيت هذا التطبيق على عدد الأجهزة المُصرّح به في باقتك. يُمنع تعديل
              الكود البرمجي أو الهندسة العكسية. مفتاح الترخيص شخصي لشركتك ويُلغى تلقائياً
              عند انتهاء الاشتراك أو فكّ الارتباط من قِبل المسؤول.
            </div>
            <label style={S.check}>
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              أوافق على الشروط
            </label>
          </div>
        )}

        {step === 2 && (
          <div>
            <Field label="الخادم">
              <select value={serverPreset} onChange={(e) => setServerPreset(Number(e.target.value))} style={S.input}>
                {SERVER_PRESETS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
              </select>
            </Field>
            {serverPreset === 1 && (
              <Field label="عنوان مخصص">
                <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://your-domain.com" style={S.input} />
              </Field>
            )}
            <Field label="الدولة">
              <select value={country} onChange={(e) => setCountry(e.target.value)} style={S.input}>
                <option value="SA">🇸🇦 المملكة العربية السعودية</option>
                <option value="EG">🇪🇬 مصر</option>
                <option value="AE">🇦🇪 الإمارات</option>
                <option value="KW">🇰🇼 الكويت</option>
                <option value="BH">🇧🇭 البحرين</option>
                <option value="OM">🇴🇲 عُمان</option>
                <option value="QA">🇶🇦 قطر</option>
                <option value="JO">🇯🇴 الأردن</option>
                <option value="IQ">🇮🇶 العراق</option>
                <option value="LB">🇱🇧 لبنان</option>
                <option value="SY">🇸🇾 سوريا</option>
                <option value="YE">🇾🇪 اليمن</option>
                <option value="PS">🇵🇸 فلسطين</option>
                <option value="SD">🇸🇩 السودان</option>
                <option value="LY">🇱🇾 ليبيا</option>
                <option value="TN">🇹🇳 تونس</option>
                <option value="DZ">🇩🇿 الجزائر</option>
                <option value="MA">🇲🇦 المغرب</option>
                <option value="MR">🇲🇷 موريتانيا</option>
                <option value="SO">🇸🇴 الصومال</option>
                <option value="DJ">🇩🇯 جيبوتي</option>
                <option value="KM">🇰🇲 جزر القمر</option>
                <option value="ALL">🌍 دولة أخرى</option>
              </select>
            </Field>
          </div>
        )}

        {step === 3 && (
          <div>
            <p>جاري اختبار الاتصال بـ <code style={S.code}>{effectiveUrl()}</code></p>
            <div style={S.pingBox}>
              {ping === "idle" && <span>⏳ جارٍ الاختبار…</span>}
              {ping === "ok" && (
                <span style={{ color: "#059669" }}>
                  ✅ الاتصال ناجح ({countries?.length ?? 0} دولة مدعومة)
                </span>
              )}
              {ping === "fail" && <span style={{ color: "#dc2626" }}>❌ فشل الاتصال</span>}
            </div>
            {ping === "fail" && (
              <button onClick={testConnection} disabled={busy} style={S.btnSecondary}>إعادة المحاولة</button>
            )}
          </div>
        )}

        {step === 4 && (
          <div>
            <Field label="مفتاح الترخيص">
              <input value={licenseKey} onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" style={{ ...S.input, fontFamily: "ui-monospace, monospace", letterSpacing: 1 }} autoFocus />
            </Field>
            <p style={S.hint}>
              المفتاح يصلك من SuperAdmin بعد شراء الباقة (24 خانة على شكل 5 مجموعات بـ "-").
            </p>
          </div>
        )}

        {step === 5 && (
          <div>
            <p>سيتم الآن جمع بصمة الجهاز وتفعيل الترخيص.</p>
            <div style={S.fpBox}>
              <KV k="اسم الجهاز" v={deviceName} />
              <KV k="نظام التشغيل" v={osInfo} />
              <KV k="إصدار التطبيق" v={appVersion} />
              <KV k="بصمة الجهاز (SHA-256 مُختصرة)" v={fingerprint ? fingerprint.slice(0, 32) + "…" : "..."} mono />
            </div>
            {err && <div style={S.err}>⚠️ {err}</div>}
            <button onClick={finalize} disabled={busy || !fingerprint || !licenseKey} style={S.btnPrimary}>
              {busy ? "جارٍ التفعيل..." : "تفعيل الجهاز الآن"}
            </button>
          </div>
        )}
      </main>

      <footer style={S.footer}>
        <button onClick={() => { setErr(null); setStep(Math.max(0, step - 1)); }} disabled={step === 0 || busy} style={S.btnSecondary}>السابق</button>
        {step < STEP_TITLES.length - 1 && (
          <button onClick={next} disabled={!canAdvance() || busy} style={S.btnPrimary}>
            {step === 2 ? "اختبار الاتصال" : "التالي"}
          </button>
        )}
      </footer>
    </div>
  );
}

// ─── Tiny presentational components ──────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "block", marginBottom: 16 }}>
    <div style={{ marginBottom: 6, fontWeight: 600, fontSize: 14 }}>{label}</div>
    {children}
  </label>;
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #e2e8f0" }}>
    <span style={{ color: "#475569" }}>{k}</span>
    <span style={{ fontFamily: mono ? "ui-monospace, monospace" : undefined, fontSize: mono ? 12 : 14 }}>{v}</span>
  </div>;
}

// ─── Inline styles (no CSS framework dependency in scaffold phase) ────
const S = {
  wrap: { maxWidth: 720, margin: "40px auto", padding: 32, background: "#fff", borderRadius: 12, boxShadow: "0 4px 24px rgba(0,0,0,.06)", fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif" } as const,
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } as const,
  title: { margin: 0, fontSize: 22, color: "#0f172a" } as const,
  mode: { fontSize: 11, padding: "4px 10px", background: "#f1f5f9", borderRadius: 999, color: "#475569" } as const,
  progressBg: { background: "#f1f5f9", borderRadius: 999, height: 6, margin: "16px 0 4px", overflow: "hidden" } as const,
  progressFg: { height: 6, background: "linear-gradient(90deg, #2563eb, #1d4ed8)", borderRadius: 999, transition: "width .3s" } as const,
  stepCounter: { fontSize: 12, color: "#64748b", textAlign: "right", marginBottom: 24 } as const,
  main: { minHeight: 280 } as const,
  lead: { fontSize: 16, lineHeight: 1.7 } as const,
  bullets: { listStyle: "none", padding: 0, lineHeight: 2 } as const,
  eulaBox: { background: "#f8fafc", border: "1px solid #e2e8f0", padding: 16, borderRadius: 8, fontSize: 13, lineHeight: 1.8, margin: "12px 0" } as const,
  check: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } as const,
  input: { width: "100%", padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14, boxSizing: "border-box" } as const,
  code: { background: "#f1f5f9", padding: "2px 6px", borderRadius: 4, fontSize: 13 } as const,
  pingBox: { padding: 16, background: "#f8fafc", borderRadius: 8, margin: "16px 0", fontSize: 14 } as const,
  hint: { fontSize: 12, color: "#64748b", marginTop: 8 } as const,
  fpBox: { background: "#f8fafc", border: "1px solid #e2e8f0", padding: 16, borderRadius: 8, margin: "12px 0" } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 12, borderRadius: 6, margin: "12px 0", fontSize: 14 } as const,
  footer: { display: "flex", justifyContent: "space-between", marginTop: 24, paddingTop: 16, borderTop: "1px solid #e2e8f0" } as const,
  btnPrimary: { padding: "10px 24px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnSecondary: { padding: "10px 24px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontSize: 14 } as const,
};
