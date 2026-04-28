import { useCallback, useState } from "react";

const STORAGE_KEY = "zatca:priceIncludesVat";

function readPersisted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "1" || raw === "true";
  } catch {
    return false;
  }
}

function writePersisted(value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* storage may be disabled (private mode, quota) — silently ignore */
  }
}

export function useStickyPriceIncludesVat() {
  const [initial] = useState<boolean>(() => readPersisted());

  const persist = useCallback((value: boolean) => {
    writePersisted(value);
  }, []);

  // Always reads the latest persisted value — useful inside event handlers
  // (e.g. "new document" reset) where the value may have changed since the
  // component first rendered. Falls back to the initial snapshot if storage
  // is unavailable.
  const read = useCallback((): boolean => readPersisted(), []);

  return { initial, persist, read };
}
