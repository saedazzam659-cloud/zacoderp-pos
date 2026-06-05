// Standalone revalidation lock — Task #236.
//
// Shown when an online-registered (`source='self_register'`) device can no
// longer run:
//   • "grace-expired" — it has not reached the cloud within its offline grace
//     window (default 7 days). It must re-validate over the internet to unlock.
//   • "revoked"       — the SuperAdmin revoked the license remotely.
//   • "expired"       — the license term lapsed and was not renewed.
//
// Only "grace-expired" is recoverable by simply reconnecting (the Retry button
// re-runs boot, which revalidates). The others require the SuperAdmin to renew
// or re-issue, so we surface the support contact instead of a false promise.

import { useState } from "react";

export type RevalidationReason = "grace-expired" | "revoked" | "expired";

const COPY: Record<RevalidationReason, { title: string; body: string; icon: string }> = {
  "grace-expired": {
    icon: "📡",
    title: "انتهت مهلة العمل دون اتصال",
    body:
      "لم يتمكن التطبيق من التحقق من الترخيص عبر الإنترنت خلال الفترة المسموح بها. " +
      "يرجى توصيل الجهاز بالإنترنت ثم الضغط على «إعادة المحاولة» لاستئناف العمل.",
  },
  "revoked": {
    icon: "🚫",
    title: "تم إيقاف الترخيص",
    body:
      "تم إيقاف ترخيص هذا الجهاز من قِبل مزوّد الخدمة. للاستفسار أو إعادة التفعيل تواصل مع مزوّد الخدمة.",
  },
  "expired": {
    icon: "⏰",
    title: "انتهت صلاحية الترخيص",
    body:
      "انتهت صلاحية ترخيص هذا الجهاز ولم يتم تجديده. تواصل مع مزوّد الخدمة لتجديد الاشتراك.",
  },
};

const SUPPORT =
  "للتجديد أو الدعم تواصل مع م/ كرم عزام — داخل مصر: 01000903159 — خارج مصر: 00201000903159 — واتساب: https://wa.me/201000903159";

export default function StandaloneRevalidationNeeded({ reason, onRetry, onReset }: {
  reason: RevalidationReason;
  onRetry: () => void | Promise<void>;
  onReset: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const copy = COPY[reason];
  const canRetry = reason === "grace-expired";

  async function retry() {
    setBusy(true);
    try { await onRetry(); } finally { setBusy(false); }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.card}>
        <div style={{ fontSize: 56, marginBottom: 12 }}>{copy.icon}</div>
        <h1 style={S.title}>{copy.title}</h1>
        <p style={S.body}>{copy.body}</p>
        <div style={S.support}>{SUPPORT}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 20, flexWrap: "wrap" }}>
          {canRetry && (
            <button onClick={() => void retry()} disabled={busy} style={S.btnPrimary}>
              {busy ? "جارٍ التحقق…" : "إعادة المحاولة (تحقق عبر الإنترنت)"}
            </button>
          )}
          <button onClick={() => void onReset()} style={S.btnSecondary}>
            تغيير الوضع / إعادة التفعيل
          </button>
        </div>
      </div>
    </div>
  );
}

const S = {
  wrap: { minHeight: "100vh", background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'Segoe UI', system-ui, sans-serif" } as const,
  card: { maxWidth: 520, width: "100%", background: "#fff", borderRadius: 16, padding: 32, boxShadow: "0 20px 60px rgba(0,0,0,.3)", textAlign: "center" as const } as const,
  title: { margin: "0 0 12px", fontSize: 22, color: "#0f172a" } as const,
  body: { fontSize: 15, lineHeight: 1.8, color: "#334155", marginBottom: 16 } as const,
  support: { fontSize: 13, lineHeight: 1.7, color: "#64748b", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 12 } as const,
  btnPrimary: { padding: "10px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600 } as const,
  btnSecondary: { padding: "10px 20px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 14 } as const,
};
