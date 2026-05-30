// One-time picker for the store's country, shown at first run (after the
// vertical step, before activation/login). The choice writes the shared
// `pos_desktop_country` setting which drives BOTH the default VAT rate
// (taxSettings.ts) and the POS display currency (lib/currency.ts).
//
// Example: choosing مصر sets the Egyptian Pound (ج.م) as the currency shown
// on every price across the POS. The choice can be changed later from the
// settings screen, so the wording says "تقدر تغيّرها لاحقًا".

import { useMemo, useState } from "react";
import { ARAB_COUNTRIES, setCountryIso, type CountryInfo } from "../lib/currency";

export default function CountrySelector({ onChosen }: { onChosen: (iso: string) => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const filtered = useMemo<CountryInfo[]>(() => {
    const t = q.trim();
    if (!t) return ARAB_COUNTRIES;
    return ARAB_COUNTRIES.filter(
      (c) =>
        c.nameAr.includes(t) ||
        c.currencySymbol.includes(t) ||
        c.currencyCode.toLowerCase().includes(t.toLowerCase()) ||
        c.iso.toLowerCase().includes(t.toLowerCase()),
    );
  }, [q]);

  function commit(c: CountryInfo) {
    setSaving(true);
    setPicked(c.iso);
    try {
      setCountryIso(c.iso);
      onChosen(c.iso);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.card}>
        <h1 style={S.title}>اختر دولتك</h1>
        <p style={S.sub}>
          سيتم ضبط العملة الافتراضية ونسبة الضريبة حسب دولتك — مثال: اختيار مصر
          يجعل العملة بالجنيه (ج.م) في نقاط البيع. تقدر تغيّرها لاحقًا من الإعدادات.
        </p>

        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ابحث باسم الدولة أو العملة…"
          style={S.search}
        />

        <div style={S.grid}>
          {filtered.map((c) => (
            <button
              key={c.iso}
              disabled={saving}
              onClick={() => commit(c)}
              style={{
                ...S.opt,
                ...(picked === c.iso ? S.optPicked : {}),
                ...(saving && picked !== c.iso ? S.optDim : {}),
              }}
            >
              <div style={S.flag}>{c.flag}</div>
              <div style={S.name}>{c.nameAr}</div>
              <div style={S.cur}>
                {c.currencySymbol} <span style={S.curCode}>({c.currencyCode})</span>
              </div>
            </button>
          ))}
          {filtered.length === 0 && <div style={S.empty}>لا توجد نتائج مطابقة</div>}
        </div>

        {saving && <div style={S.savingMsg}>جاري الحفظ...</div>}
      </div>
    </div>
  );
}

const S = {
  wrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f1f5f9", padding: 24, fontFamily: "'Segoe UI', system-ui, sans-serif" } as const,
  card: { background: "#fff", borderRadius: 16, padding: 40, maxWidth: 960, width: "100%", maxHeight: "92vh", display: "flex", flexDirection: "column" as const, boxShadow: "0 20px 50px rgba(0,0,0,.08)" } as const,
  title: { margin: 0, fontSize: 28, color: "#0f172a", textAlign: "center" as const } as const,
  sub: { margin: "8px 0 20px", color: "#64748b", textAlign: "center" as const, fontSize: 14, lineHeight: 1.7 } as const,
  search: { width: "100%", boxSizing: "border-box" as const, padding: "12px 16px", border: "2px solid #e2e8f0", borderRadius: 10, fontSize: 15, marginBottom: 16, fontFamily: "inherit", outline: "none" } as const,
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12, overflowY: "auto" as const, paddingInlineEnd: 4 } as const,
  opt: { background: "#fff", border: "2px solid #e2e8f0", borderRadius: 12, padding: "16px 12px", cursor: "pointer", transition: "all .15s", textAlign: "center" as const, fontFamily: "inherit" } as const,
  optPicked: { borderColor: "#2563eb", background: "#eff6ff" } as const,
  optDim: { opacity: 0.5, cursor: "default" } as const,
  flag: { fontSize: 38, marginBottom: 6, lineHeight: 1 } as const,
  name: { fontSize: 15, fontWeight: 700, color: "#0f172a", marginBottom: 4 } as const,
  cur: { fontSize: 13, color: "#2563eb", fontWeight: 600 } as const,
  curCode: { fontSize: 11, color: "#94a3b8", fontWeight: 400 } as const,
  empty: { gridColumn: "1 / -1", textAlign: "center" as const, color: "#94a3b8", padding: 24 } as const,
  savingMsg: { marginTop: 16, textAlign: "center" as const, color: "#64748b", fontSize: 13 } as const,
};
