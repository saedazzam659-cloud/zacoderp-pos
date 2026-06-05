// Standalone ONLINE registration — Task #236.
//
// The newer alternative to the offline file-drop (StandaloneActivation). The
// operator fills in their company profile (mirroring the web company sign-up),
// the device pushes it to the cloud, and the cloud returns an Ed25519-signed
// license bound to this machine's fingerprint. From then on the SuperAdmin can
// remotely renew / shorten expiry or revoke from /admin/offline-licenses, and
// the device re-validates over the internet on a schedule.
//
// After the license is stored we walk the operator through creating the FIRST
// admin user (same final step as StandaloneActivation) so the device has a
// local login on first run.

import { useEffect, useState } from "react";
import {
  registerStandalone, verifyLicenseFile, saveLicense,
  setLastLicenseCheck, createLocalUser, countLocalUsers,
  DEV_PUBKEY_UNPINNED, PINNED_PUBKEY_FINGERPRINT,
  type OfflineLicensePayload, type StandaloneCompanyInfo,
} from "../lib/standalone";
import { getFingerprint } from "../lib/tauri-shim";
import { getCountryIso } from "../lib/currency";

type Phase = "form" | "submitting" | "license-ok" | "admin-create" | "done";

export default function StandaloneCompanyRegistration({ onDone, onBack }: {
  onDone: (payload: OfflineLicensePayload) => void;
  onBack: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("form");
  const [err, setErr] = useState<string | null>(null);
  const [payload, setPayload] = useState<OfflineLicensePayload | null>(null);
  const [needsAdmin, setNeedsAdmin] = useState<boolean>(true);
  useEffect(() => { void countLocalUsers().then((n) => setNeedsAdmin(n === 0)); }, []);

  const [c, setC] = useState<StandaloneCompanyInfo>({
    customerName: "",
    vertical: "retail",
    country: getCountryIso(),
    companyTaxNumber: "",
    companyCrNumber: "",
    companyAddress: "",
    companyPhone: "",
    companyEmail: "",
  });

  const [a, setA] = useState({ username: "admin", displayName: "المسؤول", password: "", password2: "" });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr(null);
    if (!c.customerName.trim()) { setErr("اسم الشركة / المنشأة مطلوب"); return; }
    setPhase("submitting");
    try {
      const fp = await getFingerprint();
      const clean: StandaloneCompanyInfo = {
        customerName: c.customerName.trim(),
        vertical: c.vertical,
        country: c.country?.trim() || undefined,
        companyTaxNumber: c.companyTaxNumber?.trim() || undefined,
        companyCrNumber: c.companyCrNumber?.trim() || undefined,
        companyAddress: c.companyAddress?.trim() || undefined,
        companyPhone: c.companyPhone?.trim() || undefined,
        companyEmail: c.companyEmail?.trim() || undefined,
      };
      const reg = await registerStandalone(clean, fp);
      if (!reg.ok) { setErr(reg.error); setPhase("form"); return; }
      // Verify the returned file against the build's pinned key (same gate as
      // the file-drop path) before trusting/storing it.
      const res = await verifyLicenseFile(reg.signedFile);
      if (!res.ok) { setErr(res.error); setPhase("form"); return; }
      await saveLicense(reg.signedFile);
      await setLastLicenseCheck(Date.now());
      setPayload(res.payload);
      if (needsAdmin) setPhase("admin-create");
      else { setPhase("done"); onDone(res.payload); }
    } catch (e: any) {
      setErr(e?.message ?? "فشل التسجيل");
      setPhase("form");
    }
  }

  async function createAdmin() {
    setErr(null);
    if (a.password !== a.password2) { setErr("كلمتا المرور غير متطابقتين"); return; }
    setBusy(true);
    try {
      await createLocalUser({
        username: a.username, displayName: a.displayName,
        password: a.password, role: "admin",
      });
      setPhase("done");
      if (payload) onDone(payload);
    } catch (e: any) {
      setErr(typeof e === "string" ? e : (e?.message ?? "فشل إنشاء المستخدم"));
    } finally { setBusy(false); }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.card}>
        <header style={S.head}>
          <h1 style={S.title}>تسجيل جديد عبر الإنترنت</h1>
          <button onClick={onBack} style={S.linkBtn}>← رجوع</button>
        </header>
        <div style={{ fontSize: 11, color: PINNED_PUBKEY_FINGERPRINT === "EMPTY" ? "#dc2626" : "#16a34a", fontFamily: "monospace", padding: "4px 8px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 4, marginBottom: 12, direction: "ltr", textAlign: "left" }}>
          build v{__APP_VERSION__} · pinned pubkey: {PINNED_PUBKEY_FINGERPRINT}
        </div>

        {DEV_PUBKEY_UNPINNED && (
          <div style={S.warn}>
            ⚠️ هذه نسخة تطوير — لم يُضمَّن مفتاح عام مثبّت. التحقق يقبل أي توقيع. في الإنتاج
            عيّن <code>VITE_OFFLINE_LICENSE_PUBLIC_KEY_B64</code> عند البناء.
          </div>
        )}

        {(phase === "form" || phase === "submitting") && (
          <div>
            <p style={S.lead}>
              أدخل بيانات منشأتك. سيتم إنشاء ترخيص موقّع مرتبط بهذا الجهاز، ويمكن لمزوّد الخدمة
              التحكم في تجديده أو إيقافه لاحقاً عن بُعد. يتطلب هذا اتصالاً بالإنترنت لمرة واحدة على الأقل.
            </p>
            <Field label="اسم الشركة / المنشأة *">
              <input value={c.customerName} onChange={(e) => setC({ ...c, customerName: e.target.value })} style={S.input} placeholder="مؤسسة ..." />
            </Field>
            <div style={S.row2}>
              <Field label="النشاط">
                <select value={c.vertical} onChange={(e) => setC({ ...c, vertical: e.target.value as StandaloneCompanyInfo["vertical"] })} style={S.input}>
                  <option value="retail">تجزئة عامة</option>
                  <option value="grocery">بقالة/سوبرماركت</option>
                  <option value="pharmacy">صيدلية</option>
                  <option value="restaurant">مطعم</option>
                </select>
              </Field>
              <Field label="الدولة (رمز ISO)">
                <input value={c.country ?? ""} maxLength={2} onChange={(e) => setC({ ...c, country: e.target.value.toUpperCase() })} style={S.input} placeholder="SA" />
              </Field>
            </div>
            <div style={S.row2}>
              <Field label="الرقم الضريبي">
                <input value={c.companyTaxNumber ?? ""} onChange={(e) => setC({ ...c, companyTaxNumber: e.target.value })} style={S.input} placeholder="3xxxxxxxxxxxxx3" />
              </Field>
              <Field label="السجل التجاري">
                <input value={c.companyCrNumber ?? ""} onChange={(e) => setC({ ...c, companyCrNumber: e.target.value })} style={S.input} placeholder="10xxxxxxxx" />
              </Field>
            </div>
            <div style={S.row2}>
              <Field label="هاتف الشركة">
                <input value={c.companyPhone ?? ""} onChange={(e) => setC({ ...c, companyPhone: e.target.value })} style={S.input} placeholder="+9665xxxxxxxx" />
              </Field>
              <Field label="البريد الإلكتروني">
                <input value={c.companyEmail ?? ""} onChange={(e) => setC({ ...c, companyEmail: e.target.value })} style={S.input} placeholder="info@example.com" />
              </Field>
            </div>
            <Field label="عنوان الشركة">
              <input value={c.companyAddress ?? ""} onChange={(e) => setC({ ...c, companyAddress: e.target.value })} style={S.input} placeholder="الرياض، حي العليا" />
            </Field>
            <button onClick={() => void submit()} disabled={phase === "submitting"} style={S.btnPrimary}>
              {phase === "submitting" ? "جارٍ التسجيل…" : "تسجيل واستلام الترخيص"}
            </button>
          </div>
        )}

        {phase === "admin-create" && (
          <div>
            <div style={S.success}>✅ تم التسجيل وإصدار الترخيص بنجاح</div>
            <p style={S.lead}>
              أنشئ أول مستخدم مسؤول لإدارة هذا الجهاز. يمكنه لاحقاً إضافة مستخدمين آخرين (كاشير).
            </p>
            <Field label="اسم المستخدم">
              <input value={a.username} onChange={(e) => setA({ ...a, username: e.target.value })} style={S.input} placeholder="admin" />
            </Field>
            <Field label="الاسم الكامل (يظهر في الفواتير)">
              <input value={a.displayName} onChange={(e) => setA({ ...a, displayName: e.target.value })} style={S.input} placeholder="المسؤول" />
            </Field>
            <Field label="كلمة المرور">
              <input type="password" value={a.password} onChange={(e) => setA({ ...a, password: e.target.value })} style={S.input} />
            </Field>
            <Field label="تأكيد كلمة المرور">
              <input type="password" value={a.password2} onChange={(e) => setA({ ...a, password2: e.target.value })} style={S.input} />
            </Field>
            <button onClick={() => void createAdmin()} disabled={busy || !a.password} style={S.btnPrimary}>
              {busy ? "جارٍ الإنشاء…" : "إنشاء المستخدم وتسجيل الدخول"}
            </button>
          </div>
        )}

        {err && <div style={{ ...S.err, whiteSpace: "pre-wrap" }}>⚠️ {err}</div>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "block", marginBottom: 12 }}>
    <div style={{ marginBottom: 4, fontSize: 13, fontWeight: 600 }}>{label}</div>
    {children}
  </label>;
}

const S = {
  wrap: { minHeight: "100vh", background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'Segoe UI', system-ui, sans-serif" } as const,
  card: { maxWidth: 640, width: "100%", background: "#fff", borderRadius: 16, padding: 28, boxShadow: "0 20px 60px rgba(0,0,0,.3)" } as const,
  head: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid #e2e8f0" } as const,
  title: { margin: 0, fontSize: 20, color: "#0f172a" } as const,
  linkBtn: { background: "none", border: "none", color: "#2563eb", cursor: "pointer", fontFamily: "inherit", fontSize: 13 } as const,
  lead: { fontSize: 14, lineHeight: 1.7, color: "#334155", marginBottom: 16 } as const,
  row2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } as const,
  btnPrimary: { display: "inline-block", padding: "10px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600 } as const,
  success: { padding: 12, background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", borderRadius: 8, marginBottom: 16, fontSize: 14 } as const,
  warn: { padding: 10, background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a", borderRadius: 8, marginBottom: 16, fontSize: 13 } as const,
  err: { padding: 12, background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 8, marginTop: 12, fontSize: 14 } as const,
  input: { width: "100%", padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14, boxSizing: "border-box" } as const,
};
