import { useEffect, useRef, useState } from "react";
import { clockGuardUnlockOffline, clockGuardClearOnline, clockGuardCheck } from "../lib/clockGuard";
import { createApi } from "../lib/api";
import { revalidateLicense } from "../lib/standalone";
import { getFingerprint } from "../lib/tauri-shim";
import { uiText, useUiLanguage } from "../lib/appSettings";

const offlineErrorEn: Record<string, string> = {
  "أدخل رمز فك الحظر": "Enter an unlock code.",
  "رمز غير صالح": "Invalid unlock code.",
  "فشل التحقق من التوقيع": "Could not verify the signature.",
  "توقيع غير صحيح — الرمز غير صادر من الجهة المصرّح لها": "Invalid signature — this code was not issued by an authorized administrator.",
  "محتوى الرمز غير صالح": "The unlock code content is invalid.",
  "نوع الرمز غير صحيح": "This is not a clock-unlock code.",
  "هذا الرمز صادر لجهاز آخر": "This code was issued for a different device.",
  "انتهت صلاحية هذا الرمز — اطلب رمزًا جديدًا بالرمز المعروض حاليًا": "This code has expired. Request a new code using the device code shown now.",
};

// Clock-rollback HARD-LOCK screen (Task #237).
//
// Shown when the monotonic time guard detects the system clock was rolled
// BACKWARD past tolerance. The device is unusable until a SuperAdmin unlocks it
// one of two ways:
//   1. OFFLINE — the cashier reads the on-screen device code to the SuperAdmin,
//      who signs an Ed25519 unlock code that the cashier pastes back. Zero net.
//   2. ONLINE  — the SuperAdmin clicks "فك الحظر" in /admin/pos-devices; this
//      screen polls /validate and clears itself automatically (cloud devices).
export default function ClockTamperLocked({
  deviceCode,
  cloud,
  standalone,
  onUnlocked,
}: {
  deviceCode: string;
  cloud?: { baseUrl: string; deviceToken: string };
  // Self-register standalone licenses revalidate online, so they too can be
  // unblocked online — by polling the public revalidate endpoint for the
  // SuperAdmin's clockUnblockAt stamp. Admin file licenses never get this.
  standalone?: { licenseKey: string };
  onUnlocked: () => void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [polling, setPolling] = useState(false);
  const onUnlockedRef = useRef(onUnlocked);
  onUnlockedRef.current = onUnlocked;

  // ── Online auto-pickup: poll /validate for the SuperAdmin's unblock ─────
  useEffect(() => {
    if (!cloud) return;
    let cancelled = false;
    const api = createApi({ baseUrl: cloud.baseUrl, deviceToken: cloud.deviceToken });
    const poll = async () => {
      try {
        const v = await api.validate();
        const cleared = await clockGuardClearOnline(v.clockUnblockAt, v.serverTime);
        if (cleared && !cancelled) {
          const g = await clockGuardCheck({ trustedNowMs: new Date(v.serverTime).getTime() });
          if (!g.locked && !cancelled) onUnlockedRef.current();
        }
      } catch { /* offline / 401 / 403 — keep waiting, offline unlock still works */ }
    };
    const id = window.setInterval(() => { void poll(); }, 20_000);
    void poll();
    return () => { cancelled = true; window.clearInterval(id); };
  }, [cloud]);

  // ── Online auto-pickup for STANDALONE self-register licenses ───────────
  // They have no device token; instead we hit the public revalidate endpoint,
  // which now returns the SuperAdmin's clockUnblockAt + authoritative serverTime.
  useEffect(() => {
    if (!standalone) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const fp = await getFingerprint();
        const out = await revalidateLicense(standalone.licenseKey, fp);
        if (!out.reachable || cancelled) return;
        const cleared = await clockGuardClearOnline(out.clockUnblockAt, out.serverTime);
        if (cleared && !cancelled) {
          const st = out.serverTime ? new Date(out.serverTime).getTime() : NaN;
          const g = await clockGuardCheck({ trustedNowMs: Number.isFinite(st) ? st : undefined });
          if (!g.locked && !cancelled) onUnlockedRef.current();
        }
      } catch { /* offline — offline unlock code still works */ }
    };
    const id = window.setInterval(() => { void poll(); }, 20_000);
    void poll();
    return () => { cancelled = true; window.clearInterval(id); };
  }, [standalone]);

  async function copyCode() {
    try { await navigator.clipboard.writeText(deviceCode); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard blocked — user can select manually */ }
  }

  async function submitOffline() {
    setBusy(true); setError(null);
    try {
      const r = await clockGuardUnlockOffline(code);
      if (r.ok) { onUnlockedRef.current(); return; }
      setError(language === "en" ? offlineErrorEn[r.error] ?? r.error : r.error);
    } finally { setBusy(false); }
  }

  async function checkOnlineNow() {
    if (!cloud && !standalone) return;
    setPolling(true); setError(null);
    try {
      let clockUnblockAt: string | null | undefined;
      let serverTime: string | undefined;
      if (cloud) {
        const api = createApi({ baseUrl: cloud.baseUrl, deviceToken: cloud.deviceToken });
        const v = await api.validate();
        clockUnblockAt = v.clockUnblockAt; serverTime = v.serverTime;
      } else if (standalone) {
        const fp = await getFingerprint();
        const out = await revalidateLicense(standalone.licenseKey, fp);
        if (!out.reachable) throw new Error("unreachable");
        clockUnblockAt = out.clockUnblockAt; serverTime = out.serverTime;
      }
      const cleared = await clockGuardClearOnline(clockUnblockAt, serverTime);
      if (cleared) {
        const st = serverTime ? new Date(serverTime).getTime() : NaN;
        const g = await clockGuardCheck({ trustedNowMs: Number.isFinite(st) ? st : undefined });
        if (!g.locked) { onUnlockedRef.current(); return; }
      }
      setError(text("لم يتم رصد فكّ حظر من المسؤول بعد. تأكد من الضغط على «فك الحظر» في لوحة التحكم ثم أعد المحاولة.", "No administrator unlock was detected yet. Select “Unblock” for this device in the admin console, then try again."));
    } catch {
      setError(text("تعذّر الاتصال بالخادم. استخدم رمز فكّ الحظر دون اتصال، أو تحقق من الإنترنت.", "Could not connect to the server. Use the offline unlock code or check your internet connection."));
    } finally { setPolling(false); }
  }

  return (
    <div dir={language === "en" ? "ltr" : "rtl"} style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 48 }}>🔒</div>
        <h1 style={{ fontSize: 22, margin: 0, fontWeight: 800, color: "#b91c1c" }}>
          {text("تم قفل الجهاز — تم رصد تلاعب بساعة النظام", "Device locked — system clock tampering detected")}
        </h1>
        <p style={{ margin: 0, color: "#475569", lineHeight: 1.8, maxWidth: 560 }}>
          {text(
            "رُصِد إرجاع ساعة الويندوز إلى الخلف، وهو إجراء يُستخدم لتمديد صلاحية الترخيص. تم قفل التطبيق لحماية الاشتراك. يتطلب إلغاء القفل تدخّل المسؤول (KarmAzzam) عبر أحد الخيارين أدناه.",
            "The Windows clock was moved backward, which can be used to extend a license. The app is locked to protect the subscription. An administrator (KarmAzzam) must unlock it using one of the options below.",
          )}
        </p>

        <div style={{ ...section, textAlign: language === "en" ? "left" : "right" }}>
          <div style={sectionTitle}>{text("① فكّ الحظر دون اتصال (Offline)", "① Offline unlock")}</div>
          <p style={hint}>{text("أرسل «رمز الجهاز» التالي للمسؤول ليُصدر لك رمز فكّ حظر موقّعًا:", "Send this device code to the administrator to receive a signed unlock code:")}</p>
          <div style={codeRow}>
            <code style={codeBox}>{deviceCode || "—"}</code>
            <button onClick={() => void copyCode()} style={btnGhost}>{copied ? text("تم النسخ ✓", "Copied ✓") : text("نسخ", "Copy")}</button>
          </div>
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={text("ألصق رمز فكّ الحظر هنا…", "Paste the unlock code here…")}
            rows={3}
            style={textarea}
            dir="ltr"
          />
          <button onClick={() => void submitOffline()} disabled={busy || !code.trim()} style={btnPrimary}>
            {busy ? text("جارٍ التحقق…", "Checking…") : text("فكّ الحظر بالرمز", "Unlock with code")}
          </button>
        </div>

        {cloud || standalone ? (
          <div style={{ ...section, textAlign: language === "en" ? "left" : "right" }}>
            <div style={sectionTitle}>{text("② فكّ الحظر عبر الإنترنت (Online)", "② Online unlock")}</div>
            <p style={hint}>
              {text(
                "يطلب من المسؤول الضغط على «فك الحظر» لهذا الجهاز في لوحة التحكم. سيتم إلغاء القفل تلقائيًا خلال لحظات، أو اضغط للتحقق الآن:",
                "Ask the administrator to select “Unblock” for this device in the admin console. It will unlock automatically shortly, or check now:",
              )}
            </p>
            <button onClick={() => void checkOnlineNow()} disabled={polling} style={btnSecondary}>
              {polling ? text("جارٍ التحقق…", "Checking…") : text("تحقق الآن", "Check now")}
            </button>
          </div>
        ) : null}

        {error ? <div style={{ ...errBox, textAlign: language === "en" ? "left" : "right" }}>{error}</div> : null}
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = {
  minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
  padding: 24, background: "#0f172a", fontFamily: "'Segoe UI', system-ui, sans-serif",
};
const card: React.CSSProperties = {
  background: "#fff", borderRadius: 16, padding: "32px 28px", maxWidth: 640, width: "100%",
  display: "flex", flexDirection: "column", alignItems: "center", gap: 16, textAlign: "center",
  boxShadow: "0 20px 60px rgba(0,0,0,.4)",
};
const section: React.CSSProperties = {
  width: "100%", border: "1px solid #e2e8f0", borderRadius: 12, padding: 16,
  display: "flex", flexDirection: "column", gap: 10, textAlign: "right",
};
const sectionTitle: React.CSSProperties = { fontWeight: 700, color: "#0f172a", fontSize: 16 };
const hint: React.CSSProperties = { margin: 0, color: "#64748b", fontSize: 13, lineHeight: 1.7 };
const codeRow: React.CSSProperties = { display: "flex", gap: 8, alignItems: "stretch" };
const codeBox: React.CSSProperties = {
  flex: 1, background: "#f1f5f9", borderRadius: 8, padding: "10px 12px", fontFamily: "monospace",
  fontSize: 12, wordBreak: "break-all", textAlign: "left", direction: "ltr", color: "#0f172a",
};
const textarea: React.CSSProperties = {
  width: "100%", borderRadius: 8, border: "1px solid #cbd5e1", padding: "10px 12px",
  fontFamily: "monospace", fontSize: 12, resize: "vertical", boxSizing: "border-box",
};
const btnPrimary: React.CSSProperties = {
  padding: "10px 24px", fontSize: 15, fontWeight: 700, color: "#fff", background: "#2563eb",
  border: "none", borderRadius: 8, cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  padding: "10px 24px", fontSize: 15, fontWeight: 700, color: "#fff", background: "#059669",
  border: "none", borderRadius: 8, cursor: "pointer", alignSelf: "flex-start",
};
const btnGhost: React.CSSProperties = {
  padding: "8px 16px", fontSize: 13, fontWeight: 600, color: "#2563eb", background: "#eff6ff",
  border: "1px solid #bfdbfe", borderRadius: 8, cursor: "pointer", whiteSpace: "nowrap",
};
const errBox: React.CSSProperties = {
  width: "100%", background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca",
  borderRadius: 8, padding: "10px 12px", fontSize: 13, textAlign: "right", lineHeight: 1.7,
};
