import { useEffect, useRef, type KeyboardEvent } from "react";

/**
 * Per-input handler. Add `onKeyDown={enterNav()}` and
 * `data-enter-nav="true"` to participating inputs.
 */
export function enterNav(opts?: { onAppend?: () => void }) {
  return (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const all = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'input[data-enter-nav="true"], textarea[data-enter-nav="true"]'
      )
    );
    const i = all.indexOf(e.currentTarget as HTMLInputElement);
    if (i < 0) return;
    if (i + 1 < all.length) {
      const next = all[i + 1];
      next.focus();
      (next as HTMLInputElement).select?.();
      return;
    }
    if (opts?.onAppend) {
      opts.onAppend();
      setTimeout(() => {
        const after = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input[data-enter-nav="true"], textarea[data-enter-nav="true"]'
          )
        );
        after[i + 1]?.focus();
      }, 30);
    }
  };
}

/**
 * Document-level Enter-to-next-input delegation, scoped by data-attribute.
 *
 * Mark the wrapper of the participating inputs with
 * `data-enter-nav-container="lines"` (or any custom value passed via
 * `containerName`). When Enter is pressed on a text input/textarea
 * inside that container, focus moves to the next visible input within
 * the same container. On the last input, `onAppend` is invoked.
 *
 * - Inputs/buttons inside Radix popovers (combobox / select) are skipped
 *   so combobox search Enter behavior is preserved.
 * - Uses document-level capture so it works even when the container is
 *   mounted lazily (e.g., inside a Radix Tab that becomes active later).
 */
export function useEnterNavContainer(opts?: {
  onAppend?: () => void;
  containerName?: string;
}) {
  const onAppendRef = useRef(opts?.onAppend);
  useEffect(() => { onAppendRef.current = opts?.onAppend; }, [opts?.onAppend]);

  const containerName = opts?.containerName ?? "lines";

  useEffect(() => {
    const SELECTOR = [
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"]):not([disabled]):not([readonly])',
      'textarea:not([disabled]):not([readonly])',
    ].join(",");

    function isVisible(node: HTMLElement) {
      if (node.closest('[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper]')) return false;
      const r = node.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function handler(e: globalThis.KeyboardEvent) {
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA") return;
      if (tag === "INPUT") {
        const t = (target as HTMLInputElement).type;
        if (["checkbox", "radio", "submit", "button", "reset", "file"].includes(t)) return;
      }
      // Don't hijack Enter inside popovers (combobox search).
      if (target.closest('[role="listbox"],[data-radix-popper-content-wrapper]')) return;

      const container = target.closest(`[data-enter-nav-container="${containerName}"]`) as HTMLElement | null;
      if (!container) return;

      e.preventDefault();
      const all = Array.from(container.querySelectorAll<HTMLElement>(SELECTOR)).filter(isVisible);
      const i = all.indexOf(target);
      if (i < 0) return;
      if (i + 1 < all.length) {
        const next = all[i + 1] as HTMLInputElement;
        next.focus();
        next.select?.();
        return;
      }
      const append = onAppendRef.current;
      if (append) {
        append();
        setTimeout(() => {
          const after = Array.from(container.querySelectorAll<HTMLElement>(SELECTOR)).filter(isVisible);
          (after[i + 1] as HTMLInputElement | undefined)?.focus();
        }, 30);
      }
    }

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [containerName]);
}

/**
 * Backwards-compat alias for older call sites that used the ref-based hook.
 * The `ref` argument is now ignored — mark the container with
 * `data-enter-nav-container="lines"` instead.
 */
export function useContainerEnterNav(
  _ref: unknown,
  opts?: { onAppend?: () => void }
) {
  useEnterNavContainer(opts);
}
