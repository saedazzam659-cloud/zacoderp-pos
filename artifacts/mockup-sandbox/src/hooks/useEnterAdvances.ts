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
    .filter(element => {
      if (element.offsetParent === null && element.getClientRects().length === 0) return false;
      if (element.closest("[data-no-enter-advance]")) return false;
      if (element.getAttribute("aria-hidden") === "true") return false;
      if (element.closest('aside, nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="menubar"], [role="menu"], [role="tablist"], [role="toolbar"]')) return false;
      return true;
    });

  const index = nodes.indexOf(from);
  if (index < 0) return false;

  const next = nodes[index + 1];
  if (!next) return false;
  if (next.tagName === "BUTTON" && (next as HTMLButtonElement).type === "submit") {
    next.click();
    return true;
  }

  next.focus();
  if (next instanceof HTMLInputElement && /^(text|number|email|search|tel|url|password|date|time|datetime-local|month|week)$/.test(next.type)) {
    try { next.select(); } catch { /* ignore */ }
  }
  return true;
}