import { useEffect } from "react";

/**
 * Global Enter-as-Tab navigation.
 *
 * Pressing Enter inside a text/number/date/email/select/combobox jumps focus
 * to the next focusable form control in DOM order. When the next control is
 * a submit button, it is clicked instead — so Enter inside the last field
 * saves the form (e.g. an invoice).
 *
 * Skipped automatically:
 *   - <textarea> (Enter still inserts a newline)
 *   - Buttons, links, contenteditable
 *   - File / checkbox / radio / submit / button / reset inputs
 *   - Any element inside [data-no-enter-advance]
 *   - Open comboboxes (aria-expanded="true") and listbox options — so the
 *     Enter keystroke still confirms a dropdown selection.
 *   - Modifier-key combos (Ctrl/Alt/Shift/Meta + Enter) and IME composition
 *
 * Scope: nearest <form>, [role="dialog"], or [data-enter-scope]. Falls back
 * to <body> so single-page forms work without changes.
 */
export function useEnterAdvances(enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if ((e as any).isComposing) return;

      const target = e.target as HTMLElement | null;
      if (!target) return;

      const tag = target.tagName;
      if (tag === "TEXTAREA" || tag === "BUTTON" || tag === "A") return;
      if (target.isContentEditable) return;
      if (target.closest("[data-no-enter-advance]")) return;

      // Open combobox / listbox option → Enter confirms selection. Bail out.
      if (target.getAttribute("aria-expanded") === "true") return;
      if (target.getAttribute("role") === "option") return;

      const role = target.getAttribute("role") ?? "";
      const isCombobox = role === "combobox";
      const isFormCtrl =
        tag === "INPUT" || tag === "SELECT" || isCombobox;
      if (!isFormCtrl) return;

      if (tag === "INPUT") {
        const type = (target as HTMLInputElement).type;
        if (
          type === "submit" || type === "button" || type === "reset" ||
          type === "file"   || type === "checkbox" || type === "radio" ||
          type === "image"
        ) return;
      }

      const scope =
        (target.closest("form, [role='dialog'], [data-enter-scope]") as HTMLElement | null)
        ?? document.body;

      const selector = [
        'input:not([disabled]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="image"]):not([type="checkbox"]):not([type="radio"]):not([tabindex="-1"])',
        'select:not([disabled]):not([tabindex="-1"])',
        '[role="combobox"]:not([aria-disabled="true"]):not([disabled])',
        'button[type="submit"]:not([disabled])',
      ].join(",");

      const nodes = Array.from(scope.querySelectorAll<HTMLElement>(selector))
        .filter(el => {
          if (el.offsetParent === null && el.getClientRects().length === 0) return false;
          if (el.closest("[data-no-enter-advance]")) return false;
          if (el.getAttribute("aria-hidden") === "true") return false;
          return true;
        });

      const idx = nodes.indexOf(target);
      if (idx < 0) return;

      e.preventDefault();
      const next = nodes[idx + 1];
      if (!next) return;

      if (next.tagName === "BUTTON" && (next as HTMLButtonElement).type === "submit") {
        next.click();
        return;
      }

      next.focus();
      if (next instanceof HTMLInputElement) {
        const t = next.type;
        if (/^(text|number|email|search|tel|url|password|date|time|datetime-local|month|week)$/.test(t)) {
          try { next.select(); } catch { /* ignore */ }
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
