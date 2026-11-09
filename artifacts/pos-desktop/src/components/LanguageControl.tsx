import { useEffect, useState } from "react";
import { setUiLanguage, useUiLanguage } from "../lib/appSettings";

type Props = {
  compact?: boolean;
  hideInSystem?: boolean;
};

export default function LanguageControl({ compact = false, hideInSystem = false }: Props) {
  const language = useUiLanguage();
  const [insideSystem, setInsideSystem] = useState(false);

  useEffect(() => {
    if (!hideInSystem) return;
    const check = () => setInsideSystem(Boolean(document.querySelector("[data-pos-shell-root]")));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [hideInSystem]);

  if (hideInSystem && insideSystem) return null;

  if (compact) {
    const nextLanguage = language === "ar" ? "en" : "ar";
    return (
      <button
        type="button"
        data-testid="button-switch-language"
        aria-label={language === "ar" ? "Switch interface to English" : "Switch interface to Arabic"}
        title={language === "ar" ? "English" : "العربية"}
        onClick={() => setUiLanguage(nextLanguage)}
        style={S.compactButton}
      >
        {language === "ar" ? "EN" : "عربي"}
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label="Interface language"
      dir="ltr"
      data-testid="language-switcher"
      style={S.floating}
    >
      <button
        type="button"
        data-testid="button-language-arabic"
        aria-pressed={language === "ar"}
        onClick={() => setUiLanguage("ar")}
        style={language === "ar" ? S.activeOption : S.option}
      >
        العربية
      </button>
      <button
        type="button"
        data-testid="button-language-english"
        aria-pressed={language === "en"}
        onClick={() => setUiLanguage("en")}
        style={language === "en" ? S.activeOption : S.option}
      >
        English
      </button>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  floating: {
    position: "fixed",
    left: 14,
    bottom: 14,
    zIndex: 10000,
    display: "flex",
    alignItems: "center",
    gap: 3,
    padding: 4,
    border: "1px solid #cbd5e1",
    borderRadius: 10,
    background: "rgba(255,255,255,.96)",
    boxShadow: "0 4px 16px rgba(15,23,42,.16)",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  },
  option: {
    border: 0,
    borderRadius: 7,
    background: "transparent",
    color: "#334155",
    padding: "7px 10px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  activeOption: {
    border: 0,
    borderRadius: 7,
    background: "#1d4ed8",
    color: "#fff",
    padding: "7px 10px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  compactButton: {
    minWidth: 40,
    height: 32,
    border: "1px solid #cbd5e1",
    borderRadius: 8,
    background: "#fff",
    color: "#1e293b",
    padding: "0 8px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
};
