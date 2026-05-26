// First-run mode selector — Task #199.
//
// Shown the very first time the app boots (no `pos_desktop_app_mode` set).
// The user picks one of:
//   • Cloud      — keeps the original activation flow (license key → cloud sync)
//   • Standalone — switches to local SQLite + signed-license-file flow
//
// The choice is persisted; the user can later wipe & re-pick from the topbar
// (admin only) but not casually — it's a destructive op.

import { setAppMode, type AppMode } from "../lib/standalone";

export default function FirstRunWizard({ onChosen }: { onChosen: (m: AppMode) => void }) {
  async function pick(m: AppMode) {
    await setAppMode(m);
    onChosen(m);
  }
  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.card}>
        <div style={S.brand}>
          <div style={S.brandIcon}>zacode</div>
          <div>
            <div style={S.brandName}>مرحباً بك في ZACOD POS</div>
            <div style={S.brandTag}>اختر طريقة التشغيل قبل المتابعة</div>
          </div>
        </div>

        <div style={S.grid}>
          <button onClick={() => void pick("cloud")} style={S.option}>
            <div style={S.optionIcon}>☁️</div>
            <div style={S.optionTitle}>وضع السحابة</div>
            <div style={S.optionDesc}>
              متصل بـ <code>zacoderp.com</code> — مزامنة تلقائية للفواتير والعملاء،
              لوحة تحكم سحابية، تقارير مركزية، وإدارة عبر السوبر-أدمن.
            </div>
            <ul style={S.optionList}>
              <li>✅ مفتاح ترخيص + تفعيل سحابي</li>
              <li>✅ مزامنة دورية مع السحابة</li>
              <li>✅ دعم متعدد الأجهزة والفروع</li>
              <li>✅ نسخ احتياطي سحابي</li>
            </ul>
            <div style={S.cta}>اختيار الوضع السحابي ←</div>
          </button>

          <button onClick={() => void pick("standalone")} style={{ ...S.option, borderColor: "#fbbf24", background: "#fffbeb" }}>
            <div style={S.optionIcon}>🖥️</div>
            <div style={S.optionTitle}>وضع مستقل (بدون سحابة)</div>
            <div style={S.optionDesc}>
              يعمل بالكامل محلياً بدون أي اتصال بالإنترنت. الترخيص ملف موقّع رقمياً تتسلّمه
              من مزوّد الخدمة. مناسب للمحلات التي لا تريد السحابة أو في مناطق بدون إنترنت موثوق.
            </div>
            <ul style={S.optionList}>
              <li>✅ ملف ترخيص محلي (.zacolic.json)</li>
              <li>✅ مستخدمون محليون (اسم وكلمة مرور)</li>
              <li>✅ بدون أي اتصال خارجي</li>
              <li>⚠️ لا مزامنة ولا نسخ احتياطي تلقائي</li>
            </ul>
            <div style={S.cta}>اختيار الوضع المستقل ←</div>
          </button>
        </div>

        <div style={S.foot}>
          يمكن تغيير الاختيار لاحقاً، لكن الانتقال يمحو كل البيانات المحلية في الجهاز.
        </div>
      </div>
    </div>
  );
}

const S = {
  wrap: { minHeight: "100vh", background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'Segoe UI', system-ui, sans-serif" } as const,
  card: { maxWidth: 1000, width: "100%", background: "#fff", borderRadius: 16, padding: 32, boxShadow: "0 20px 60px rgba(0,0,0,.3)" } as const,
  brand: { display: "flex", gap: 16, alignItems: "center", marginBottom: 24, paddingBottom: 24, borderBottom: "1px solid #e2e8f0" } as const,
  brandIcon: { minWidth: 72, height: 48, borderRadius: 12, background: "linear-gradient(135deg, #22d3ee, #2563eb)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 14, letterSpacing: 0.5 } as const,
  brandName: { fontSize: 22, fontWeight: 700, color: "#0f172a" } as const,
  brandTag: { fontSize: 13, color: "#64748b", marginTop: 4 } as const,
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 } as const,
  option: { textAlign: "right" as const, padding: 24, borderRadius: 12, border: "2px solid #cbd5e1", background: "#f8fafc", cursor: "pointer", fontFamily: "inherit", transition: "all .15s", display: "flex", flexDirection: "column" as const, gap: 8 } as const,
  optionIcon: { fontSize: 40, marginBottom: 8 } as const,
  optionTitle: { fontSize: 18, fontWeight: 700, color: "#0f172a" } as const,
  optionDesc: { fontSize: 13, lineHeight: 1.7, color: "#475569" } as const,
  optionList: { listStyle: "none", padding: 0, margin: "8px 0", fontSize: 13, lineHeight: 2, color: "#334155" } as const,
  cta: { marginTop: "auto", paddingTop: 12, fontWeight: 700, color: "#2563eb" } as const,
  foot: { marginTop: 20, fontSize: 12, color: "#94a3b8", textAlign: "center" as const } as const,
};
