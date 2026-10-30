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
import { uiText, useUiLanguage } from "../lib/appSettings";

type Opt = { id: Vertical; icon: string; titleAr: string; titleEn: string; descAr: string; descEn: string };
const OPTIONS: Opt[] = [
  {
    id: "pharmacy", icon: "💊",
    titleAr: "صيدلية", titleEn: "Pharmacy",
    descAr: "إدارة الأدوية مع تواريخ الصلاحية، رقم التشغيلة، روشتة المريض، واستيراد كتالوج الأدوية المصري (EDA).",
    descEn: "Manage medicines, expiry dates, batch numbers, prescriptions, and imports from Egypt’s EDA drug catalog.",
  },
  {
    id: "grocery", icon: "🛒",
    titleAr: "بقالة / سوبر ماركت", titleEn: "Grocery / Supermarket",
    descAr: "كتالوج عام بأكواد باركود ووحدات قياس ووزن — مناسب للبقالات والمتاجر العامة. يبدأ بكتالوج 50 صنف جاهز.",
    descEn: "A general catalog with barcodes, units, and weighed items. Starts with 50 sample products.",
  },
  {
    id: "restaurant", icon: "🍽️",
    titleAr: "مطعم / كافيه", titleEn: "Restaurant / Cafe",
    descAr: "قائمة أصناف بدون باركود — برجر، شاورما، مشروبات، حلويات. يبدأ بقائمة 45 صنف جاهزة.",
    descEn: "A no-barcode menu for meals, drinks, and desserts. Starts with 45 sample products.",
  },
  {
    id: "retail", icon: "🛍️",
    titleAr: "محل تجزئة", titleEn: "Retail shop",
    descAr: "إلكترونيات، قرطاسية، إكسسوارات — كتالوج 30 صنف جاهز كنقطة انطلاق.",
    descEn: "For electronics, stationery, and accessories. Starts with 30 sample products.",
  },
  {
    id: "plumbing", icon: "🔧",
    titleAr: "أدوات صحية وسباكة", titleEn: "Plumbing supplies",
    descAr: "مواسير، خلاطات، وصلات، عدد سباكة — واجهة بيع حديثة بأعمدة كمية ووحدة وسعر.",
    descEn: "For pipes, faucets, fittings, and tools, with a sales view for quantity, unit, and price.",
  },
  {
    id: "paints", icon: "🎨",
    titleAr: "دهانات وأصباغ", titleEn: "Paint and coatings",
    descAr: "بويات، ديكورات، فرش ورولات — واجهة بيع حديثة مناسبة لمحلات الدهانات.",
    descEn: "For paints, decor, brushes, and rollers, with a sales view designed for paint shops.",
  },
  {
    id: "auto_parts", icon: "🔩",
    titleAr: "قطع غيار سيارات", titleEn: "Auto parts",
    descAr: "قطع غيار وإكسسوارات وزيوت — بحث سريع وواجهة بيع حديثة بأعمدة منظّمة.",
    descEn: "For parts, accessories, and oils, with quick search and organized sales columns.",
  },
  {
    id: "auto_workshop", icon: "🚗",
    titleAr: "ورشة سيارات", titleEn: "Auto workshop",
    descAr: "خدمات صيانة وقطع غيار في فاتورة واحدة — واجهة بيع حديثة للورش.",
    descEn: "Combine repair services and spare parts on one invoice with a workshop-focused sales view.",
  },
  {
    id: "mobiles", icon: "📱",
    titleAr: "موبايلات وإكسسوارات", titleEn: "Mobiles and accessories",
    descAr: "أجهزة، شواحن، سماعات، إكسسوارات — واجهة بيع حديثة لمحلات الموبايل.",
    descEn: "For phones, chargers, headphones, and accessories, with a mobile-shop sales view.",
  },
  {
    id: "general", icon: "🏷️",
    titleAr: "محل عام", titleEn: "General shop",
    descAr: "بدون حقول أو كتالوج إضافي — أبسط واجهة للملابس أو أي بضاعة خاصة بك.",
    descEn: "A simple setup without extra fields or a starter catalog, for clothing or other goods.",
  },
];

export default function VerticalSelector({ onChosen }: { onChosen: (v: Vertical) => void }) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<Vertical | null>(null);

  async function commit(v: Vertical) {
    setSaving(true); setPicked(v);
    try { await setVertical(v); onChosen(v); }
    finally { setSaving(false); }
  }

  return (
    <div dir={language === "en" ? "ltr" : "rtl"} style={S.wrap}>
      <div style={S.card}>
        <h1 style={S.title}>{text("اختر نوع نشاطك التجاري", "Choose your business type")}</h1>
        <p style={S.sub}>{text("سيتم تخصيص الواجهة والتقارير حسب اختيارك — تقدر تغيّرها لاحقًا من الإعدادات.", "The interface and reports will be tailored to your choice. You can change it later in Settings.")}</p>

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
                textAlign: language === "en" ? "left" : "right",
              }}
            >
              <div style={S.optIcon}>{o.icon}</div>
              <div style={S.optTitle}>{language === "en" ? o.titleEn : o.titleAr}</div>
              <div style={S.optDesc}>{language === "en" ? o.descEn : o.descAr}</div>
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
