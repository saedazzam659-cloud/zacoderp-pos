import { setNumberSystem, useNumberSystem } from "../lib/appSettings";

export default function NumberSystemControl({ compact = false }: { compact?: boolean }) {
  const system = useNumberSystem();
  const next = system === "arabic" ? "latin" : "arabic";
  return (
    <button
      type="button"
      onClick={() => setNumberSystem(next)}
      aria-label={`تغيير شكل الأرقام إلى ${next === "latin" ? "الإنجليزية" : "العربية"}`}
      title={`شكل الأرقام الحالي: ${system === "arabic" ? "عربي" : "إنجليزي"}`}
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
