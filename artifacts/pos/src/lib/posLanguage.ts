import { useEffect, useState } from "react";

export type PosLanguage = "ar" | "en";

const POS_LANGUAGE_KEY = "super_pos_lang";
const LANGUAGE_EVENT = "pos-language-change";

export function getPosLanguage(): PosLanguage {
  try {
    return localStorage.getItem(POS_LANGUAGE_KEY) === "en" ? "en" : "ar";
  } catch {
    return "ar";
  }
}

export function setPosLanguage(language: PosLanguage) {
  try {
    localStorage.setItem(POS_LANGUAGE_KEY, language);
  } catch {
    // Keep the current page usable if storage is unavailable.
  }
  window.dispatchEvent(new Event(LANGUAGE_EVENT));
}

export function usePosLanguage() {
  const [language, setLanguage] = useState<PosLanguage>(getPosLanguage);

  useEffect(() => {
    const syncLanguage = () => setLanguage(getPosLanguage());
    window.addEventListener(LANGUAGE_EVENT, syncLanguage);
    window.addEventListener("storage", syncLanguage);
    return () => {
      window.removeEventListener(LANGUAGE_EVENT, syncLanguage);
      window.removeEventListener("storage", syncLanguage);
    };
  }, []);

  return { language, setLanguage: setPosLanguage };
}

export function tr(language: PosLanguage, arabic: string, english: string) {
  return language === "ar" ? arabic : english;
}
