import { useCallback, useRef } from "react";

/**
 * Professional Enter-key navigation for forms.
 *
 * - Pressing Enter on any input/select/combobox/date moves focus to the next
 *   focusable field in DOM order within the container.
 * - On the last field, Enter triggers the primary save action (either the
 *   provided `onSubmit` callback, or a click on the first element carrying
 *   `data-enter-submit="true"`).
 * - Textareas keep default behavior (Enter = newline) unless Ctrl/Cmd is held.
 * - Fields inside `[data-enter-nav-container]` (e.g. invoice line items) are
 *   handled by `useEnterNavContainer` instead — we skip them here to avoid
 *   double-handling.
 * - Add `data-enter-skip="true"` to any element you want the navigator to
 *   ignore (e.g. Cancel / action buttons).
 * - Add `data-enter-field="true"` to any custom element (e.g. popover trigger
 *   button) that you want included in the navigation order.
 *
 * Usage:
 *   const { containerRef, onKeyDown } = useEnterNavigation(() => saveMut.mutate());
 *   <div ref={containerRef} onKeyDown={onKeyDown}> ... </div>
 */
export function useEnterNavigation(onSubmit?: () => void) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key !== "Enter") return;
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (!target) return;

      const tag = target.tagName;

      // Allow newline inside textareas.
      if (tag === "TEXTAREA") return;

      // Explicit opt-out.
      if (target.getAttribute("data-enter-skip") === "true") return;

      // Defer to useEnterNavContainer for line-item rows.
      if (target.closest("[data-enter-nav-container]")) return;

      // Never hijack Enter inside Radix popovers (combobox search box etc.).
      if (
        target.closest(
          '[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper]',
        )
      ) {
        return;
      }

      const container = containerRef.current;
      if (!container || !container.contains(target)) return;

      const selectors = [
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"]):not([disabled]):not([readonly])',
        "textarea:not([disabled]):not([readonly])",
        "select:not([disabled])",
        '[role="combobox"]:not([disabled])',
        '[data-enter-field="true"]:not([disabled])',
      ].join(",");

      const isVisible = (el: HTMLElement) => {
        if (el.getAttribute("aria-hidden") === "true") return false;
        if (el.getAttribute("data-enter-skip") === "true") return false;
        // Skip fields living inside the line-items container (handled elsewhere).
        if (el.closest("[data-enter-nav-container]")) return false;
        if (
          el.closest(
            '[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper]',
          )
        )
          return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      // If focus is on an explicit submit button, click it.
      if (target.getAttribute("data-enter-submit") === "true") {
        e.preventDefault();
        e.stopPropagation();
        (target as HTMLButtonElement).click();
        return;
      }

      // Only hijack Enter on actual participating fields — never on plain
      // buttons, tabs, or other non-field controls inside the container.
      const isParticipatingField =
        tag === "INPUT" ||
        tag === "SELECT" ||
        target.getAttribute("role") === "combobox" ||
        target.getAttribute("data-enter-field") === "true";
      if (!isParticipatingField) return;

      const all = Array.from(
        container.querySelectorAll<HTMLElement>(selectors),
      ).filter(isVisible);

      const idx = all.indexOf(target);
      if (idx === -1) return;

      e.preventDefault();
      e.stopPropagation();

      if (idx < all.length - 1) {
        const next = all[idx + 1];
        next.focus();
        if (
          next instanceof HTMLInputElement &&
          next.type !== "checkbox" &&
          next.type !== "radio" &&
          next.type !== "date" &&
          next.type !== "file"
        ) {
          try { next.select(); } catch { /* ignore */ }
        }
        return;
      }

      // End of form — trigger save.
      if (onSubmit) {
        onSubmit();
      } else {
        const submitBtn = container.querySelector<HTMLButtonElement>(
          '[data-enter-submit="true"]',
        );
        submitBtn?.click();
      }
    },
    [onSubmit],
  );

  return { containerRef, onKeyDown };
}
