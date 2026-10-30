// One-time picker for the machine's app profile (Task #226), shown at first run
// after the country step. The choice writes the shared `app_profile` setting
// (lib/standalone.ts) which decides how much of the system this install shows:
//
//   • "pos" — نقطة بيع فقط: a lean cash register (selling, returns, daily Z,
//             customers + the catalog basics). ERP back-office screens stay
//             hidden so cashiers see a focused, fast screen.
//   • "erp" — النظام الكامل: every screen (purchases, accounting, warehouses,
//             reports…), still subject to per-user permissions and the
//             SuperAdmin's per-company module gate.
//
// It applies to BOTH cloud and standalone modes and can be changed later from
// the settings screen, so the wording says "تقدر تغيّرها لاحقًا".

import { useState } from "react";
import { setAppProfile } from "../lib/standalone";
import { uiText, useUiLanguage } from "../lib/appSettings";

export default function ProfileSelector({ onChosen }: { onChosen: (p: "pos" | "erp") => void }) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<"pos" | "erp" | null>(null);

  function commit(p: "pos" | "erp") {
    setSaving(true);
    setPicked(p);
    void (async () => {
      try {
        await setAppProfile(p);
        onChosen(p);
      } finally {
        setSaving(false);
      }
    })();
  }

  const opts: { key: "pos" | "erp"; icon: string; titleAr: string; titleEn: string; descAr: string; descEn: string }[] = [
    {
      key: "pos",
      icon: "🛒",
      titleAr: "نقطة بيع فقط",
      titleEn: "Point of sale only",
      descAr: "شاشة كاشير سريعة ومركّزة: بيع، مرتجعات، تقرير يومي، عملاء والأصناف الأساسية. تُخفى شاشات الإدارة الخلفية.",
      descEn: "A focused cashier screen for sales, returns, daily reports, customers, and core items. Back-office screens stay hidden.",
    },
    {
      key: "erp",
      icon: "🏢",
      titleAr: "النظام الكامل (ERP)",
      titleEn: "Full system (ERP)",
      descAr: "كل الشاشات: مشتريات، حسابات، مخازن، تقارير… (تظل خاضعة لصلاحيات المستخدم وتفعيل الوحدات من الإدارة).",
      descEn: "All screens, including purchasing, accounting, warehouses, and reports, subject to user permissions and enabled modules.",
    },
  ];

  return (
    <div dir={language === "en" ? "ltr" : "rtl"} style={S.wrap}>
      <div style={S.card}>
        <h1 style={S.title}>{text("اختر طريقة استخدام البرنامج", "Choose how to use the app")}</h1>
        <p style={S.sub}>
          {text("حدد هل ستستخدم هذا الجهاز كنقطة بيع فقط أم كنظام محاسبي متكامل. تقدر تغيّرها لاحقًا من الإعدادات.", "Choose whether this device will run as a point of sale or as the full accounting system. You can change this later in Settings.")}
        </p>

        <div style={S.grid}>
          {opts.map((o) => (
            <button
              key={o.key}
              disabled={saving}
              onClick={() => commit(o.key)}
              style={{
                ...S.opt,
                ...(picked === o.key ? S.optPicked : {}),
                ...(saving && picked !== o.key ? S.optDim : {}),
              }}
            >
              <div style={S.icon}>{o.icon}</div>
              <div style={S.name}>{language === "en" ? o.titleEn : o.titleAr}</div>
              <div style={S.desc}>{language === "en" ? o.descEn : o.descAr}</div>
            </button>
          ))}
        </div>

        {saving && <div style={S.savingMsg}>{text("جاري الحفظ...", "Saving…")}</div>}
      </div>
    </div>
  );
}

const S = {
  wrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f1f5f9", padding: 24, fontFamily: "'Segoe UI', system-ui, sans-serif" } as const,
  card: { background: "#fff", borderRadius: 16, padding: 40, maxWidth: 760, width: "100%", display: "flex", flexDirection: "column" as const, boxShadow: "0 20px 50px rgba(0,0,0,.08)" } as const,
  title: { margin: 0, fontSize: 28, color: "#0f172a", textAlign: "center" as const } as const,
  sub: { margin: "8px 0 24px", color: "#64748b", textAlign: "center" as const, fontSize: 14, lineHeight: 1.7 } as const,
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 } as const,
  opt: { background: "#fff", border: "2px solid #e2e8f0", borderRadius: 14, padding: "28px 20px", cursor: "pointer", transition: "all .15s", textAlign: "center" as const, fontFamily: "inherit" } as const,
  optPicked: { borderColor: "#2563eb", background: "#eff6ff" } as const,
  optDim: { opacity: 0.5, cursor: "default" } as const,
  icon: { fontSize: 46, marginBottom: 12, lineHeight: 1 } as const,
  name: { fontSize: 19, fontWeight: 800, color: "#0f172a", marginBottom: 10 } as const,
  desc: { fontSize: 13, color: "#64748b", lineHeight: 1.7 } as const,
  savingMsg: { marginTop: 20, textAlign: "center" as const, color: "#64748b", fontSize: 13 } as const,
};
