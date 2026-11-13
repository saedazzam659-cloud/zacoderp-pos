import { useState } from "react";
import StandaloneActivation from "./StandaloneActivation";
import StandaloneCompanyRegistration from "./StandaloneCompanyRegistration";
import type { OfflineLicensePayload } from "../lib/standalone";

type Choice = "menu" | "register" | "file";

/** Standalone-only activation choices; neither route offers cloud mode. */
export default function StandaloneOnboard({ onDone, onCancel }: {
  onDone: (payload: OfflineLicensePayload) => void;
  onCancel?: () => void;
}) {
  const [choice, setChoice] = useState<Choice>("menu");
  if (choice === "register") {
    return <StandaloneCompanyRegistration onDone={onDone} onBack={() => setChoice("menu")} />;
  }
  if (choice === "file") {
    return <StandaloneActivation onDone={onDone} onCancel={() => setChoice("menu")} />;
  }
  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.card}>
        <header style={S.head}>
          <h1 style={S.title}>تفعيل نسخة Standalone</h1>
          {onCancel && <button onClick={onCancel} style={S.linkBtn}>العودة</button>}
        </header>
        <p style={S.lead}>سجّل بيانات المنشأة لانتظار الموافقة، أو استخدم ملف ترخيص جاهز.</p>
        <button onClick={() => setChoice("register")} style={S.option}>
          <div style={{ fontSize: 28 }}>🌐</div>
          <div style={{ textAlign: "right" }}>
            <div style={S.optTitle}>تسجيل منشأة جديدة</div>
            <div style={S.optDesc}>أدخل بيانات المنشأة فقط. يختار المشرف إعدادات النسخة والوحدات قبل الموافقة.</div>
          </div>
        </button>
        <button onClick={() => setChoice("file")} style={S.option}>
          <div style={{ fontSize: 28 }}>📄</div>
          <div style={{ textAlign: "right" }}>
            <div style={S.optTitle}>لدي ملف ترخيص</div>
            <div style={S.optDesc}>فعّل ملف الترخيص المستقل الموقّع الذي سلّمه لك المشرف.</div>
          </div>
        </button>
      </div>
    </div>
  );
}

const S = {
  wrap: { minHeight: "100vh", background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'Segoe UI', system-ui, sans-serif" } as const,
  card: { maxWidth: 560, width: "100%", background: "#fff", borderRadius: 16, padding: 28, boxShadow: "0 20px 60px rgba(0,0,0,.3)" } as const,
  head: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid #e2e8f0" } as const,
  title: { margin: 0, fontSize: 20, color: "#0f172a" } as const,
  linkBtn: { background: "none", border: "none", color: "#2563eb", cursor: "pointer", fontFamily: "inherit", fontSize: 13 } as const,
  lead: { fontSize: 14, lineHeight: 1.7, color: "#334155", marginBottom: 16 } as const,
  option: { display: "flex", gap: 16, alignItems: "center", width: "100%", textAlign: "right" as const, padding: 16, marginBottom: 12, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, cursor: "pointer", fontFamily: "inherit" } as const,
  optTitle: { fontSize: 16, fontWeight: 700, color: "#0f172a", marginBottom: 4 } as const,
  optDesc: { fontSize: 13, lineHeight: 1.6, color: "#64748b" } as const,
};
