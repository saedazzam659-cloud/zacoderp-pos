import { useEffect } from "react";

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
 */
export function useRefetchOnFocus(refetch: () => void | Promise<void>) {
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") {
        void refetch();
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
