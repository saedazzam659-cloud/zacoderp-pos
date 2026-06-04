import { useSyncExternalStore } from "react";

export type Lang = "ar" | "en";

const STORAGE_KEY = "deck_lang";

function readInitial(): Lang {
  if (typeof localStorage === "undefined") return "ar";
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "en" ? "en" : "ar";
  } catch {
    return "ar";
  }
}

let current: Lang = readInitial();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore persistence errors */
  }
  listeners.forEach((fn) => fn());
}

export function toggleLang(): void {
  setLang(current === "ar" ? "en" : "ar");
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}
