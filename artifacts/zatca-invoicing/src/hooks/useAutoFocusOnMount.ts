import { useEffect, useRef, type RefObject } from "react";

/**
 * Reliably auto-focus an input on mount (or when a trigger flips true),
 * beating any competing autoFocus (e.g. Radix combobox onFocus auto-openers).
 *
 * Strategy: keep a warm-up window of ~1500ms during which we reclaim focus
 * whenever anything other than the target (or a real user button press) gets
 * focus. The window ends on the first genuine user interaction (mousedown /
 * keydown on an unrelated target) or when the timeout expires.
 */
export function useAutoFocusOnMount<T extends HTMLElement>(
  ref: RefObject<T | null>,
  trigger: boolean = true,
) {
  useEffect(() => {
    if (!trigger) return;

    let stopped = false;

    const tryFocus = () => {
      if (stopped) return;
      const el = ref.current;
      if (!el) return;
      if (document.activeElement === el) return;
      try {
        el.focus({ preventScroll: true });
        if (el instanceof HTMLInputElement &&
            el.type !== "checkbox" && el.type !== "radio" &&
            el.type !== "date" && el.type !== "file") {
          el.select();
        }
      } catch { /* ignore */ }
    };

    // Initial burst + periodic retries across the first ~1500ms.
    const delays = [0, 60, 140, 240, 400, 600, 900, 1300];
    const timers: ReturnType<typeof setTimeout>[] = [];
    delays.forEach((d) => timers.push(setTimeout(tryFocus, d)));

    // Reclaim focus whenever something else grabs it during the warm-up.
    const onFocusIn = (e: FocusEvent) => {
      if (stopped) return;
      const el = ref.current;
      if (!el) return;
      const tgt = e.target as HTMLElement | null;
      if (!tgt || tgt === el) return;
      // Don't fight when focus lands on a real button — tabs/icons/menu
      // triggers are legitimate competitors that the user may want.
      if (tgt.tagName === "BUTTON") return;
      // Defer by a microtask so any competing focus() call finishes first.
      queueMicrotask(tryFocus);
    };
    document.addEventListener("focusin", onFocusIn, true);

    // End the warm-up on the first real user interaction or after 1500ms.
    const endWarmup = () => {
      stopped = true;
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("mousedown", onUserInteract, true);
      document.removeEventListener("keydown", onUserInteract, true);
    };
    const onUserInteract = (e: Event) => {
      // Tab / Escape / Arrow keys always end the warm-up immediately —
      // these are deliberate navigation signals even if fired on the target.
      if (e.type === "keydown") {
        const k = (e as KeyboardEvent).key;
        if (k === "Tab" || k === "Escape" || k === "ArrowDown" ||
            k === "ArrowUp" || k === "ArrowLeft" || k === "ArrowRight") {
          endWarmup();
          return;
        }
      }
      const el = ref.current;
      const tgt = e.target as HTMLElement | null;
      // Typing/clicking on the target itself is fine — don't stop yet.
      if (el && tgt && (tgt === el || el.contains(tgt))) return;
      endWarmup();
    };
    document.addEventListener("mousedown", onUserInteract, true);
    document.addEventListener("keydown", onUserInteract, true);
    const stopTimer = setTimeout(endWarmup, 1500);

    return () => {
      stopped = true;
      timers.forEach(clearTimeout);
      clearTimeout(stopTimer);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("mousedown", onUserInteract, true);
      document.removeEventListener("keydown", onUserInteract, true);
    };
  }, [trigger, ref]);
}
