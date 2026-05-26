// One-time picker for the store's business vertical (Task #200).
//
// Shown after the operator chooses cloud/standalone but BEFORE the
// activation/cashier-login flow. We surface this early because the vertical
// influences:
//   • catalog labels and optional fields on ItemsAdmin (الأصناف)
//   • presence of pharmacy-only navigation (تقرير الصلاحية, EDA import)
//   • SalesScreen receipt copy
//
// The choice is persisted via setVertical() → Tauri app_settings
// ("ui_vertical") or localStorage in the browser preview. It can be
// changed later from the settings page (planned), so the wording on this
// screen says "تقدر تغيّرها لاحقًا" rather than implying permanence.

import { useState } from "react";
import { setVertical, type Vertical } from "../lib/standalone";

type Opt = { id: Vertical; icon: string; title: string; desc: string };
const OPTIONS: Opt[] = [
  {
    id: "pharmacy", icon: "💊",
    title: "صيدلية",
    desc: "إدارة الأدوية مع تواريخ الصلاحية، رقم التشغيلة، روشتة المريض، واستيراد كتالوج الأدوية المصري (EDA).",
  },
  {
    id: "grocery", icon: "🛒",
    title: "بقالة / سوبر ماركت",
    desc: "كتالوج عام بأكواد باركود ووحدات قياس ووزن — مناسب للبقالات والمتاجر العامة.",
  },
  {
    id: "general", icon: "🏷️",
    title: "محل عام",
    desc: "بدون حقول إضافية — أبسط واجهة للملابس، الإلكترونيات، أو أي بضاعة معبأة.",
  },
];

export default function VerticalSelector({ onChosen }: { onChosen: (v: Vertical) => void }) {
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<Vertical | null>(null);

  async function commit(v: Vertical) {
    setSaving(true); setPicked(v);
    try { await setVertical(v); onChosen(v); }
    finally { setSaving(false); }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.card}>
        <h1 style={S.title}>اختر نوع نشاطك التجاري</h1>
        <p style={S.sub}>سيتم تخصيص الواجهة والتقارير حسب اختيارك — تقدر تغيّرها لاحقًا من الإعدادات.</p>

        <div style={S.grid}>
          {OPTIONS.map((o) => (
            <button
              key={o.id}
              disabled={saving}
              onClick={() => void commit(o.id)}
              style={{
                ...S.opt,
                ...(picked === o.id ? S.optPicked : {}),
                ...(saving && picked !== o.id ? S.optDim : {}),
              }}
            >
              <div style={S.optIcon}>{o.icon}</div>
              <div style={S.optTitle}>{o.title}</div>
              <div style={S.optDesc}>{o.desc}</div>
            </button>
          ))}
        </div>

        {saving && <div style={S.savingMsg}>جاري الحفظ...</div>}
      </div>
    </div>
  );
}

const S = {
  wrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f1f5f9", padding: 24, fontFamily: "'Segoe UI', system-ui, sans-serif" } as const,
  card: { background: "#fff", borderRadius: 16, padding: 40, maxWidth: 920, width: "100%", boxShadow: "0 20px 50px rgba(0,0,0,.08)" } as const,
  title: { margin: 0, fontSize: 28, color: "#0f172a", textAlign: "center" as const } as const,
  sub: { margin: "8px 0 32px", color: "#64748b", textAlign: "center" as const, fontSize: 14 } as const,
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 } as const,
  opt: { background: "#fff", border: "2px solid #e2e8f0", borderRadius: 12, padding: 24, cursor: "pointer", transition: "all .15s", textAlign: "right" as const, fontFamily: "inherit" } as const,
  optPicked: { borderColor: "#2563eb", background: "#eff6ff" } as const,
  optDim: { opacity: 0.5, cursor: "default" } as const,
  optIcon: { fontSize: 44, marginBottom: 8 } as const,
  optTitle: { fontSize: 18, fontWeight: 700, color: "#0f172a", marginBottom: 6 } as const,
  optDesc: { fontSize: 13, color: "#475569", lineHeight: 1.6 } as const,
  savingMsg: { marginTop: 16, textAlign: "center" as const, color: "#64748b", fontSize: 13 } as const,
};
