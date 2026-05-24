import { useState } from "react";

const STEPS = [
  "مرحباً بك في ZACOD POS",
  "اتفاقية الترخيص",
  "اختيار اللغة والدولة",
  "إعدادات الاتصال بالخادم",
  "إدخال مفتاح الترخيص",
  "اختبار الاتصال وحفظ الإعدادات",
];

export default function Activation({ onActivated }: { onActivated: () => void }) {
  const [step, setStep] = useState(0);
  const [licenseKey, setLicenseKey] = useState("");
  const [serverUrl, setServerUrl] = useState("https://zacoderp.com");
  const [country, setCountry] = useState("SA");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function finalize() {
    setBusy(true); setErr(null);
    try {
      // TODO Step 8: replace with `invoke("activate_device", { req: { licenseKey, serverUrl } })`
      // and store the returned deviceToken in keyring.
      const r = await fetch(`${serverUrl}/api/device-licenses/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          licenseKey,
          deviceName: "DEV-MACHINE",
          fingerprint: "stub-fingerprint",
          appVersion: "0.1.0-dev",
          osInfo: "Windows DEV",
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "فشل التفعيل");
      const j = await r.json();
      localStorage.setItem("device_token_dev_stub", j.deviceToken);
      onActivated();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div dir="rtl" style={{ maxWidth: 720, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>{STEPS[step]}</h1>
      <div style={{ background: "#f1f5f9", borderRadius: 8, height: 6, margin: "16px 0" }}>
        <div style={{ width: `${((step + 1) / STEPS.length) * 100}%`, height: 6, background: "#2563eb", borderRadius: 8 }} />
      </div>

      {step === 0 && <p>سيتم تثبيت تطبيق نقاط البيع المرتبط بحسابك السحابي. يدعم العمل دون اتصال.</p>}

      {step === 1 && (
        <div>
          <p>راجع شروط الاستخدام واتفاقية الترخيص قبل المتابعة.</p>
          <label><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /> أوافق على الشروط</label>
        </div>
      )}

      {step === 2 && (
        <div>
          <label>الدولة:&nbsp;
            <select value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="SA">السعودية</option>
              <option value="AE">الإمارات</option>
              <option value="KW">الكويت</option>
              <option value="ALL">أخرى</option>
            </select>
          </label>
        </div>
      )}

      {step === 3 && (
        <div>
          <label>عنوان الخادم: <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} style={{ width: "100%" }} /></label>
        </div>
      )}

      {step === 4 && (
        <div>
          <label>مفتاح الترخيص: <input value={licenseKey} onChange={(e) => setLicenseKey(e.target.value)} style={{ width: "100%", fontFamily: "monospace" }} /></label>
        </div>
      )}

      {step === 5 && (
        <div>
          <p>سيتم الآن الاتصال بالخادم وتفعيل الجهاز.</p>
          {err && <p style={{ color: "red" }}>{err}</p>}
          <button onClick={finalize} disabled={busy || !licenseKey}>{busy ? "..." : "تفعيل الآن"}</button>
        </div>
      )}

      <div style={{ marginTop: 24, display: "flex", justifyContent: "space-between" }}>
        <button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>السابق</button>
        {step < STEPS.length - 1 && (
          <button onClick={() => setStep(step + 1)} disabled={step === 1 && !accepted}>التالي</button>
        )}
      </div>
    </div>
  );
}
