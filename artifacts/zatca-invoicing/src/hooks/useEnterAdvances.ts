import { useEffect } from "react";

/**
 * Move focus from `from` to the next focusable form control inside its
 * nearest <form> / [role="dialog"] / [data-enter-scope] (falls back to
 * <body>). When the next control is a submit button, it is clicked.
 *
 * Exported so non-input widgets (e.g. a custom combobox after a selection)
 * can hand off focus exactly like a real Enter-as-Tab keystroke would.
 */
export function advanceFocusFrom(from: HTMLElement | null | undefined): boolean {
  if (!from) return false;
  const scope =
    (from.closest("form, [role='dialog'], [data-enter-scope]") as HTMLElement | null)
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
      // Exclude landmark chrome (sidebar, top-nav, breadcrumbs, banners,
      // footers, pagination ...). Without this, when an invoice form has
      // no <form> wrapper the search falls back to <body> and Enter would
      // jump from a field into the sidebar instead of the next field.
      if (el.closest('aside, nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="menubar"], [role="menu"], [role="tablist"], [role="toolbar"]')) return false;
      return true;
    });

  const idx = nodes.indexOf(from);
  if (idx < 0) return false;

  const next = nodes[idx + 1];
  if (!next) return false;

  if (next.tagName === "BUTTON" && (next as HTMLButtonElement).type === "submit") {
    next.click();
    return true;
  }

  next.focus();
  if (next instanceof HTMLInputElement) {
    const t = next.type;
    if (/^(text|number|email|search|tel|url|password|date|time|datetime-local|month|week)$/.test(t)) {
      try { next.select(); } catch { /* ignore */ }
    }
  }
  return true;
}

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
 *   - Open comboboxes (aria-expanded="true") and listbox options — those
 *     own their Enter behaviour (select + advance) themselves.
 *   - Modifier-key combos (Ctrl/Alt/Shift/Meta + Enter) and IME composition
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

      if (target.getAttribute("aria-expanded") === "true") return;
      if (target.getAttribute("role") === "option") return;

      const role = target.getAttribute("role") ?? "";
      const isCombobox = role === "combobox";
      const isFormCtrl = tag === "INPUT" || tag === "SELECT" || isCombobox;
      if (!isFormCtrl) return;

      if (tag === "INPUT") {
        const type = (target as HTMLInputElement).type;
        if (
          type === "submit" || type === "button" || type === "reset" ||
          type === "file"   || type === "checkbox" || type === "radio" ||
          type === "image"
        ) return;
      }

      if (advanceFocusFrom(target)) {
        e.preventDefault();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
