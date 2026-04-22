import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ar from "./locales/ar.json";
import en from "./locales/en.json";

export const SUPPORTED_LANGUAGES = [
  { code: "ar", label: "العربية", dir: "rtl" as const },
  { code: "en", label: "English", dir: "ltr" as const },
];

export function normalizeLang(lang: string | undefined | null): string {
  if (!lang) return "ar";
  const base = lang.toLowerCase().split("-")[0];
  return SUPPORTED_LANGUAGES.some(l => l.code === base) ? base : "ar";
}

const STORAGE_KEY = "app:lang";

function getInitialLang(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeLang(saved);
  } catch {}
  return "ar";
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      ar: { translation: ar },
      en: { translation: en },
    },
    lng: getInitialLang(),
    fallbackLng: "ar",
    interpolation: { escapeValue: false },
    returnNull: false,
  });

export function applyLangToDocument(lang: string) {
  const code = normalizeLang(lang);
  const meta = SUPPORTED_LANGUAGES.find(l => l.code === code) ?? SUPPORTED_LANGUAGES[0];
  if (typeof document !== "undefined") {
    document.documentElement.lang = meta.code;
    document.documentElement.dir = meta.dir;
  }
}

export function setAppLanguage(lang: string) {
  const code = normalizeLang(lang);
  i18n.changeLanguage(code);
  try { localStorage.setItem(STORAGE_KEY, code); } catch {}
  applyLangToDocument(code);
}

applyLangToDocument(i18n.language);

export default i18n;
