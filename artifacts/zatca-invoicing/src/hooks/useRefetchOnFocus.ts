import { useEffect, useRef } from "react";

/**
 * Re-runs `refetch` whenever the browser tab regains focus or
 * becomes visible again. Used by screens that load reference data
 * (items, customers, suppliers, …) into local `useState` via plain
 * `fetch` instead of React Query — it gives them the same
 * "always-fresh on focus" behaviour the React Query global config
 * provides for `useQuery`-based screens.
 *
 * The callback should be wrapped in `useCallback` (or stable) by the
 * caller; this hook depends on its identity to attach/detach
 * listeners.
 *
 * Returning to a tab fires `focus` AND `visibilitychange` back-to-back,
 * so we dedupe both ways: a 300 ms cooldown skips the second event
 * and an in-flight flag prevents overlapping refetches if the first
 * one is still resolving.
 */
export function useRefetchOnFocus(refetch: () => void | Promise<void>) {
  const lastRunRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    const handler = async () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (inFlightRef.current) return;
      if (now - lastRunRef.current < 300) return;
      lastRunRef.current = now;
      inFlightRef.current = true;
      try {
        await refetch();
      } finally {
        inFlightRef.current = false;
      }
    };
    window.addEventListener("focus", handler);
    document.addEventListener("visibilitychange", handler);
    return () => {
      window.removeEventListener("focus", handler);
      document.removeEventListener("visibilitychange", handler);
    };
  }, [refetch]);
}
