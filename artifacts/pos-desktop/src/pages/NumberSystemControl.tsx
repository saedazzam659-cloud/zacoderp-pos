import { setNumberSystem, uiText, useNumberSystem, useUiLanguage } from "../lib/appSettings";

export default function NumberSystemControl({ compact = false }: { compact?: boolean }) {
  const system = useNumberSystem();
  const language = useUiLanguage();
  const next = system === "arabic" ? "latin" : "arabic";
  return (
    <button
      type="button"
      onClick={() => setNumberSystem(next)}
      aria-label={uiText(
        `تغيير شكل الأرقام إلى ${next === "latin" ? "الإنجليزية" : "العربية"}`,
        `Switch digits to ${next === "latin" ? "Latin" : "Arabic"}`,
        language,
      )}
      title={uiText(
        `شكل الأرقام الحالي: ${system === "arabic" ? "عربي" : "إنجليزي"}`,
        `Current digits: ${system === "arabic" ? "Arabic-Indic" : "Latin"}`,
        language,
      )}
      style={{
        border: "1px solid #cbd5e1",
        borderRadius: 8,
        padding: compact ? "5px 8px" : "8px 12px",
        background: "#fff",
        color: "#0f172a",
        fontWeight: 700,
        fontSize: compact ? 12 : 13,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {system === "arabic" ? "١٢٣" : "123"}
    </button>
  );
}
