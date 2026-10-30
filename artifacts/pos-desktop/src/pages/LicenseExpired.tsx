// Full-screen "subscription expired" block (Task #185).
//
// Shown when the cloud returns 403 from /api/device-licenses/validate
// (license revoked or expired) OR when the cached expiresAt is in the
// past while offline. There is intentionally NO way out except:
//   1. "إعادة المحاولة" — re-runs boot(); if the SuperAdmin has renewed
//      the subscription, the device unlocks immediately.
//   2. "إلغاء تفعيل الجهاز" — destructive escape hatch that wipes the
//      device token and returns to the activation screen. Use only when
//      switching the device to a different license.
//
// The device token itself is NOT wiped automatically — renewing the
// subscription on the cloud should be a one-click recovery, not a
// re-activation walkthrough.

import { useState } from "react";
import { formatUiDate, uiText, useUiLanguage } from "../lib/appSettings";

type Props = {
  expiresAt: string | null;
  companyName?: string;
  onRetry: () => void | Promise<void>;
  onDeactivate: () => void | Promise<void>;
};

export default function LicenseExpired({ expiresAt, companyName, onRetry, onDeactivate }: Props) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [retrying, setRetrying] = useState(false);

  const expiresText = expiresAt
    ? formatUiDate(expiresAt, language)
    : null;

  async function handleRetry() {
    setRetrying(true);
    try { await onRetry(); }
    finally { setRetrying(false); }
  }

  async function handleDeactivate() {
    if (!confirm(text(
      "سيتم إلغاء تفعيل الجهاز ومسح بياناته من هذا الجهاز. هل أنت متأكد؟",
      "This will deactivate the device and erase its local data. Are you sure?",
    ))) return;
    await onDeactivate();
  }

  return (
    <div dir={language === "en" ? "ltr" : "rtl"} style={S.shell}>
      <div style={S.card}>
        <div style={S.iconWrap}>
          <div style={S.iconCircle}>⏱️</div>
        </div>
        <h1 style={S.title}>{text("انتهى اشتراك هذا الجهاز", "This device's subscription has expired")}</h1>
        <p style={S.lead}>
          {text("تواصل مع الدعم الفني للتجديد", "Contact support to renew")}
        </p>

        {companyName && (
          <div style={S.companyChip}>{companyName}</div>
        )}

        {expiresText && (
          <div style={S.expiryRow}>
            <span style={S.expiryLabel}>{text("تاريخ انتهاء الاشتراك:", "Subscription expiry date:")}</span>
            <span style={S.expiryValue}>{expiresText}</span>
          </div>
        )}

        <div style={{ ...S.help, textAlign: language === "en" ? "left" : "right" }}>
          <div style={S.helpTitle}>{text("📞 الدعم الفني — م/ كرم عزام", "📞 Technical support — Eng. Karam Azzam")}</div>
          <div style={S.helpText}>
            {text(
              "تواصل مع فريق الدعم الفني لتجديد الاشتراك. بعد التجديد، اضغط «إعادة المحاولة» أدناه ليعود الجهاز للعمل مباشرة بدون الحاجة لإعادة التفعيل.",
              "Contact technical support to renew the subscription. After renewal, select “Retry” below to resume using this device without reactivating it.",
            )}
          </div>
          <div style={S.contactBlock}>
            <div style={S.contactRow}>
              <span style={S.contactLabel}>{text("من داخل مصر:", "From within Egypt:")}</span>
              <a href="tel:01000903159" style={S.contactLink}>📞 01000903159</a>
              <a href="https://wa.me/201000903159" target="_blank" rel="noreferrer" style={S.contactLinkWa}>💬 {text("واتساب", "WhatsApp")}</a>
            </div>
            <div style={S.contactRow}>
              <span style={S.contactLabel}>{text("من خارج مصر:", "From outside Egypt:")}</span>
              <a href="tel:+201000903159" style={S.contactLink} dir="ltr">📞 00201000903159</a>
              <a href="https://wa.me/201000903159" target="_blank" rel="noreferrer" style={S.contactLinkWa}>💬 {text("واتساب", "WhatsApp")}</a>
            </div>
          </div>
        </div>

        <div style={S.actions}>
          <button onClick={handleRetry} disabled={retrying} style={S.btnPrimary}>
            {retrying ? text("جارٍ التحقق…", "Checking…") : `🔄 ${text("إعادة المحاولة", "Retry")}`}
          </button>
          <button onClick={handleDeactivate} style={S.btnGhost}>
            {text("إلغاء تفعيل الجهاز", "Deactivate device")}
          </button>
        </div>

        <div style={S.footer}>
          {text("لن تتمكن من استخدام نقطة البيع حتى يتم تجديد الاشتراك.", "You cannot use the point of sale until the subscription is renewed.")}
        </div>
      </div>
    </div>
  );
}

const S = {
  shell: {
    display: "flex", alignItems: "center", justifyContent: "center",
    height: "100vh", width: "100vw",
    background: "linear-gradient(135deg, #fef2f2 0%, #fff7ed 100%)",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    padding: 24, boxSizing: "border-box" as const,
  } as const,
  card: {
    background: "#fff", borderRadius: 16, padding: "40px 48px",
    maxWidth: 560, width: "100%",
    boxShadow: "0 20px 60px rgba(0,0,0,.12)",
    border: "1px solid #fecaca",
    textAlign: "center" as const,
  } as const,
  iconWrap: { display: "flex", justifyContent: "center", marginBottom: 16 } as const,
  iconCircle: {
    width: 80, height: 80, borderRadius: "50%",
    background: "linear-gradient(135deg, #fef2f2, #fee2e2)",
    border: "2px solid #fecaca",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 40,
  } as const,
  title: { fontSize: 24, fontWeight: 800, color: "#991b1b", margin: "0 0 8px" } as const,
  lead: { fontSize: 18, color: "#475569", margin: "0 0 24px", fontWeight: 600 } as const,
  companyChip: {
    display: "inline-block",
    padding: "6px 14px",
    background: "#f1f5f9",
    color: "#334155",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 16,
  } as const,
  expiryRow: {
    display: "flex", justifyContent: "center", gap: 8, alignItems: "center",
    padding: "10px 14px", background: "#fef2f2", borderRadius: 8,
    marginBottom: 20, border: "1px solid #fecaca",
  } as const,
  expiryLabel: { color: "#7f1d1d", fontSize: 13 } as const,
  expiryValue: { color: "#991b1b", fontSize: 14, fontWeight: 700 } as const,
  help: {
    background: "#f8fafc", border: "1px solid #e2e8f0",
    borderRadius: 12, padding: 16, marginBottom: 24, textAlign: "right" as const,
  } as const,
  helpTitle: { fontSize: 14, fontWeight: 700, color: "#0f172a", marginBottom: 6 } as const,
  helpText: { fontSize: 13, color: "#475569", lineHeight: 1.6 } as const,
  contactBlock: {
    marginTop: 12, paddingTop: 12, borderTop: "1px dashed #e2e8f0",
    display: "flex", flexDirection: "column" as const, gap: 8,
  } as const,
  contactRow: {
    display: "flex", flexWrap: "wrap" as const, alignItems: "center", gap: 10,
    fontSize: 13,
  } as const,
  contactLabel: { color: "#64748b", fontWeight: 600, minWidth: 90 } as const,
  contactLink: {
    color: "#1d4ed8", textDecoration: "none", fontWeight: 700,
    background: "#eff6ff", padding: "4px 10px", borderRadius: 6,
    border: "1px solid #bfdbfe",
  } as const,
  contactLinkWa: {
    color: "#15803d", textDecoration: "none", fontWeight: 700,
    background: "#f0fdf4", padding: "4px 10px", borderRadius: 6,
    border: "1px solid #bbf7d0",
  } as const,
  actions: { display: "flex", flexDirection: "column" as const, gap: 10 } as const,
  btnPrimary: {
    padding: "12px 24px", background: "#2563eb", color: "#fff",
    border: "none", borderRadius: 10, cursor: "pointer",
    fontSize: 15, fontWeight: 700, fontFamily: "inherit",
  } as const,
  btnGhost: {
    padding: "10px 24px", background: "transparent", color: "#94a3b8",
    border: "1px solid #e2e8f0", borderRadius: 10, cursor: "pointer",
    fontSize: 13, fontFamily: "inherit",
  } as const,
  footer: {
    marginTop: 20, fontSize: 12, color: "#94a3b8",
  } as const,
};
