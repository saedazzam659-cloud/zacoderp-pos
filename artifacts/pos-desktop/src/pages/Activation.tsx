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
import { wipeStandalone } from "../lib/standalone";
import { getCountryIso, setCountryIso } from "../lib/currency";
import { SearchCombobox } from "./_adminUi";
import { uiText, useUiLanguage } from "../lib/appSettings";

type Country = { code: string; name: string };

const SERVER_PRESETS = [
  { url: "https://zacoderp.com" },
  { url: "" },
];

export type ActivatedInfo = {
  deviceToken: string;
  deviceId: number;
  companyId: number;
  companyName: string;
  expiresAt: string | null;
};

export default function Activation({ onActivated }: { onActivated: (info: ActivatedInfo) => void }) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const stepTitles = [
    text("مرحباً بك في ZACOD POS", "Welcome to ZACOD POS"),
    text("اتفاقية الترخيص", "License agreement"),
    text("إعدادات الاتصال", "Connection settings"),
    text("اختبار الاتصال بالخادم", "Server connection test"),
    text("إدخال مفتاح الترخيص", "Enter license key"),
    text("بصمة الجهاز والتفعيل", "Device fingerprint and activation"),
  ];
  const [step, setStep] = useState(0);
  const [accepted, setAccepted] = useState(false);

  const [serverPreset, setServerPreset] = useState(0);
  const [serverUrl, setServerUrl] = useState(SERVER_PRESETS[0].url);
  const [country, setCountry] = useState(() => getCountryIso());

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
      setErr(e?.message ?? text("تعذّر الاتصال بالخادم. تأكد من الإنترنت والعنوان.", "Could not connect to the server. Check the internet connection and address."));
    } finally {
      setBusy(false);
    }
  }

  // ─── Step 6: finalize activation ────────────────────────────────────
  async function finalize() {
    if (!fingerprint) { setErr(text("بصمة الجهاز غير جاهزة", "Device fingerprint is not ready.")); return; }
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
      setCountryIso(country);
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
          400: text("بيانات غير صحيحة. راجع مفتاح الترخيص.", "Invalid details. Check the license key."),
          403: text("الترخيص غير مفعّل لشركتك. تواصل مع الإدارة.", "This license is not enabled for your company. Contact your administrator."),
          404: text("مفتاح الترخيص غير موجود.", "License key not found."),
          409: text("هذا الترخيص مرتبط بجهاز آخر. اطلب من المسؤول فكّ الربط أولاً.", "This license is linked to another device. Ask an administrator to unlink it first."),
        };
        setErr(codeMap[e.status] ?? text(`خطأ ${e.status}: ${e.message}`, `Error ${e.status}: ${e.message}`));
      } else {
        setErr(e?.message ?? text("فشل التفعيل", "Activation failed."));
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
    setStep(Math.min(stepTitles.length - 1, step + 1));
  }

  // ─── Render ────────────────────────────────────────────────────────
  return (
    <div dir={language === "en" ? "ltr" : "rtl"} style={S.wrap}>
      <header style={S.header}>
        <h1 style={S.title}>{stepTitles[step]}</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={async () => {
              if (!confirm(text("⚠️ تغيير وضع التطبيق سيؤدي إلى مسح كل البيانات المحلية على هذا الجهاز (السلال المعلّقة، الفواتير غير المرفوعة، ذاكرة الكتالوج). الترخيص السحابي على السيرفر لن يتأثر. هل أنت متأكد؟", "⚠️ Changing the app mode erases all local data on this device (parked carts, unsent invoices, and catalog cache). The cloud license is not affected. Continue?"))) return;
              await wipeStandalone();
              location.reload();
            }}
            style={{ padding: "6px 12px", fontSize: 13, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", color: "#475569" }}
            title={text("مسح بيانات الجهاز والعودة لاختيار طريقة التشغيل", "Erase device data and return to operating mode selection")}
          >
            {language === "en" ? "Change mode →" : "← تغيير الوضع"}
          </button>
          <div style={S.mode}>
            {TAURI_MODE === "tauri" ? text("🪟 وضع التطبيق الأصلي", "🪟 Native app mode") : text("🌐 وضع المتصفح (تطوير)", "🌐 Browser mode (development)")}
          </div>
        </div>
      </header>

      <div style={S.progressBg}>
        <div style={{ ...S.progressFg, width: `${((step + 1) / stepTitles.length) * 100}%` }} />
      </div>
        <div style={{ ...S.stepCounter, textAlign: language === "en" ? "left" : "right" }}>{text("الخطوة", "Step")} {step + 1} {text("من", "of")} {stepTitles.length}</div>

      <main style={S.main}>
        {step === 0 && (
          <div>
            <p style={S.lead}>{text("سيتم تثبيت تطبيق نقاط البيع المتصل بحسابك السحابي.", "This will install the point-of-sale app connected to your cloud account.")}</p>
            <ul style={S.bullets}>
              <li>✅ {text("يعمل أثناء انقطاع الإنترنت (قاعدة بيانات محلية مشفّرة)", "Works during internet outages (encrypted local database)")}</li>
              <li>✅ {text("مزامنة تلقائية للفواتير والعملاء فور عودة الاتصال", "Automatically syncs invoices and customers when the connection returns")}</li>
              <li>✅ {text("توقيع فواتير ZATCA Phase 2 محلياً", "Signs ZATCA Phase 2 invoices locally")}</li>
              <li>✅ {text("دعم الطابعات الحرارية ودرج النقود وقارئ الباركود", "Supports thermal printers, cash drawers, and barcode scanners")}</li>
            </ul>
          </div>
        )}

        {step === 1 && (
          <div>
            <p>{text("راجع شروط الاستخدام واتفاقية ترخيص المستخدم النهائي (EULA) قبل المتابعة.", "Review the terms of use and end-user license agreement (EULA) before continuing.")}</p>
            <div style={S.eulaBox}>
              {text("يحق لك تثبيت هذا التطبيق على عدد الأجهزة المُصرّح به في باقتك. يُمنع تعديل الكود البرمجي أو الهندسة العكسية. مفتاح الترخيص شخصي لشركتك ويُلغى تلقائياً عند انتهاء الاشتراك أو فكّ الارتباط من قِبل المسؤول.", "You may install this app on the number of devices allowed by your plan. Modifying or reverse engineering the software is prohibited. The license key is assigned to your company and is revoked when the subscription expires or an administrator unlinks it.")}
            </div>
            <label style={S.check}>
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              {text("أوافق على الشروط", "I agree to the terms")}
            </label>
          </div>
        )}

        {step === 2 && (
          <div>
            <Field label={text("الخادم", "Server")}>
              <SearchCombobox
                value={serverPreset}
                onChange={(v) => setServerPreset(Number(v))}
                options={SERVER_PRESETS.map((p, i) => ({
                  value: i,
                  label: i === 0 ? text("السحابة الرسمية (zacoderp.com)", "Official cloud (zacoderp.com)") : text("مخصص…", "Custom…"),
                }))}
                style={S.input}
              />
            </Field>
            {serverPreset === 1 && (
              <Field label={text("عنوان مخصص", "Custom address")}>
                <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://your-domain.com" style={S.input} />
              </Field>
            )}
            <Field label={text("الدولة", "Country")}>
              <SearchCombobox
                value={country}
                onChange={(v) => setCountry(String(v))}
                options={[
                  { value: "SA", label: text("🇸🇦 المملكة العربية السعودية", "🇸🇦 Saudi Arabia") },
                  { value: "EG", label: text("🇪🇬 مصر", "🇪🇬 Egypt") },
                  { value: "AE", label: text("🇦🇪 الإمارات", "🇦🇪 United Arab Emirates") },
                  { value: "KW", label: text("🇰🇼 الكويت", "🇰🇼 Kuwait") },
                  { value: "BH", label: text("🇧🇭 البحرين", "🇧🇭 Bahrain") },
                  { value: "OM", label: text("🇴🇲 عُمان", "🇴🇲 Oman") },
                  { value: "QA", label: text("🇶🇦 قطر", "🇶🇦 Qatar") },
                  { value: "JO", label: text("🇯🇴 الأردن", "🇯🇴 Jordan") },
                  { value: "IQ", label: text("🇮🇶 العراق", "🇮🇶 Iraq") },
                  { value: "LB", label: text("🇱🇧 لبنان", "🇱🇧 Lebanon") },
                  { value: "SY", label: text("🇸🇾 سوريا", "🇸🇾 Syria") },
                  { value: "YE", label: text("🇾🇪 اليمن", "🇾🇪 Yemen") },
                  { value: "PS", label: text("🇵🇸 فلسطين", "🇵🇸 Palestine") },
                  { value: "SD", label: text("🇸🇩 السودان", "🇸🇩 Sudan") },
                  { value: "LY", label: text("🇱🇾 ليبيا", "🇱🇾 Libya") },
                  { value: "TN", label: text("🇹🇳 تونس", "🇹🇳 Tunisia") },
                  { value: "DZ", label: text("🇩🇿 الجزائر", "🇩🇿 Algeria") },
                  { value: "MA", label: text("🇲🇦 المغرب", "🇲🇦 Morocco") },
                  { value: "MR", label: text("🇲🇷 موريتانيا", "🇲🇷 Mauritania") },
                  { value: "SO", label: text("🇸🇴 الصومال", "🇸🇴 Somalia") },
                  { value: "DJ", label: text("🇩🇯 جيبوتي", "🇩🇯 Djibouti") },
                  { value: "KM", label: text("🇰🇲 جزر القمر", "🇰🇲 Comoros") },
                  { value: "ALL", label: text("🌍 دولة أخرى", "🌍 Other country") },
                ]}
                style={S.input}
              />
            </Field>
          </div>
        )}

        {step === 3 && (
          <div>
            <p>{text("جاري اختبار الاتصال بـ", "Testing connection to")} <code style={S.code}>{effectiveUrl()}</code></p>
            <div style={S.pingBox}>
              {ping === "idle" && <span>⏳ {text("جارٍ الاختبار…", "Testing…")}</span>}
              {ping === "ok" && (
                <span style={{ color: "#059669" }}>
                  ✅ {text(`الاتصال ناجح (${countries?.length ?? 0} دولة مدعومة)`, `Connection successful (${countries?.length ?? 0} supported countries)`)}
                </span>
              )}
              {ping === "fail" && <span style={{ color: "#dc2626" }}>❌ {text("فشل الاتصال", "Connection failed")}</span>}
            </div>
            {ping === "fail" && (
              <button onClick={testConnection} disabled={busy} style={S.btnSecondary}>{text("إعادة المحاولة", "Try again")}</button>
            )}
          </div>
        )}

        {step === 4 && (
          <div>
            <Field label={text("مفتاح الترخيص", "License key")}>
              <input value={licenseKey} onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" style={{ ...S.input, fontFamily: "ui-monospace, monospace", letterSpacing: 1 }} autoFocus />
            </Field>
            <p style={S.hint}>
              {text('المفتاح يصلك من SuperAdmin بعد شراء الباقة (24 خانة على شكل 5 مجموعات بـ "-").', 'Your Super Admin provides the key after plan purchase (24 characters in 5 groups separated by hyphens).')}
            </p>
          </div>
        )}

        {step === 5 && (
          <div>
            <p>{text("سيتم الآن جمع بصمة الجهاز وتفعيل الترخيص.", "The device fingerprint will now be collected and the license activated.")}</p>
            <div style={S.fpBox}>
              <KV k={text("اسم الجهاز", "Device name")} v={deviceName} />
              <KV k={text("نظام التشغيل", "Operating system")} v={osInfo} />
              <KV k={text("إصدار التطبيق", "App version")} v={appVersion} />
              <KV k={text("بصمة الجهاز (SHA-256 مُختصرة)", "Device fingerprint (short SHA-256)")} v={fingerprint ? fingerprint.slice(0, 32) + "…" : "..."} mono />
            </div>
            {err && <div style={S.err}>⚠️ {err}</div>}
            <button onClick={finalize} disabled={busy || !fingerprint || !licenseKey} style={S.btnPrimary}>
              {busy ? text("جارٍ التفعيل...", "Activating…") : text("تفعيل الجهاز الآن", "Activate device")}
            </button>
          </div>
        )}
      </main>

      <footer style={S.footer}>
        <button onClick={() => { setErr(null); setStep(Math.max(0, step - 1)); }} disabled={step === 0 || busy} style={S.btnSecondary}>{text("السابق", "Previous")}</button>
        {step < stepTitles.length - 1 && (
          <button onClick={next} disabled={!canAdvance() || busy} style={S.btnPrimary}>
            {step === 2 ? text("اختبار الاتصال", "Test connection") : text("التالي", "Next")}
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
