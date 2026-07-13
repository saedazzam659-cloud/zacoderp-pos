import * as React from "react"

import { cn } from "@/lib/utils"
import { AuthContext } from "@/contexts/AuthContext"

// Display-only "hide zeros" behavior for numeric inputs.
// When the active company's `showZeros` setting is OFF (the default), a numeric
// input whose value is 0 renders BLANK with a faint "0" placeholder instead of
// showing "0". This NEVER changes the value the parent holds or submits — it is
// purely what is painted in the box. Read via useContext (not the throwing
// useAuth hook) so <Input> still works on screens rendered outside AuthProvider
// (e.g. the login / SuperAdmin-login pages).
function isZeroValue(value: React.ComponentProps<"input">["value"]): boolean {
  if (value === 0) return true;
  if (typeof value === "string") {
    const t = value.trim();
    return t !== "" && Number(t) === 0;
  }
  return false;
}

// Strip trailing fractional zeros from a numeric value for DISPLAY only.
// e.g. "10.0000" -> "10", "300000.00" -> "300000", "10.50" -> "10.5".
// Only touches plain decimal strings that actually have a fractional part;
// integers, blanks, partial input ("10.") and non-numeric text pass through
// unchanged. Never mutates the value the parent holds or submits.
function trimTrailingZeros(value: React.ComponentProps<"input">["value"]): React.ComponentProps<"input">["value"] {
  const s = typeof value === "number" ? String(value) : value;
  if (typeof s !== "string") return value;
  const t = s.trim();
  if (!/^-?\d*\.\d+$/.test(t)) return value;
  const trimmed = t.replace(/0+$/, "").replace(/\.$/, "");
  if (trimmed === "" || trimmed === "-" || trimmed === "-0") return value;
  return trimmed;
}

// Live thousands grouping (Excel-style) for AMOUNT inputs — DISPLAY ONLY.
// Applies exclusively to CONTROLLED text inputs with inputMode="decimal"
// (the app-wide money/amount pattern). The parent's state and everything
// submitted stay RAW ("100000.34"); only the painted text shows "100,000.34".
// inputMode="numeric" is intentionally excluded — it is shared by OTP codes,
// VAT numbers, postal codes, phone-like ids where commas would be wrong.
// Opt out per-field with data-no-group.
function groupDigits(value: React.ComponentProps<"input">["value"]): React.ComponentProps<"input">["value"] {
  const s = typeof value === "number" ? String(value) : value;
  if (typeof s !== "string") return value;
  const m = s.trim().match(/^(-?)(\d+)((?:\.\d*)?)$/);
  if (!m) return value;
  return m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + m[3];
}

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, value, placeholder, onFocus, onBlur, ...props }, ref) => {
    const auth = React.useContext(AuthContext);
    const showZeros = (auth?.user as any)?.company?.showZeros === true;
    const innerRef = React.useRef<HTMLInputElement | null>(null);
    // Pending caret position expressed as "number of non-comma chars before
    // the caret" — restored after React repaints the grouped display.
    const caretRef = React.useRef<number | null>(null);
    // While the field is focused we render the EXACT parent value so the user
    // can type decimals freely ("10.0" must not collapse to "10" mid-edit).
    // The trailing-zero trim only applies once the field is at rest (blurred).
    const [focused, setFocused] = React.useState(false);

    let displayValue = value;
    let displayPlaceholder = placeholder;
    // Only ever touch the rendered value of a CONTROLLED input — one that
    // supplies both `value` and `onChange`. Such inputs submit from their
    // parent's React state (which still holds 0), so blanking the box is
    // purely cosmetic. Uncontrolled / ref-driven fields (e.g. react-hook-form
    // `register()`, which passes no `value`) are read from the DOM on submit,
    // so we must never blank them — they're left exactly as-is.
    const isControlled = value !== undefined && typeof props.onChange === "function";
    // A "numeric" field is either type=number OR a type=text box that declares a
    // numeric inputMode. The line-item grids (sales/purchase invoices, orders,
    // quotations, returns) use `type="text" inputMode="numeric|decimal"` with a
    // sanitizing onChange instead of type=number, so they must be covered too.
    const isNumericField =
      type === "number" ||
      props.inputMode === "numeric" ||
      props.inputMode === "decimal";
    // Excel-style live thousands separators for amount fields. Only controlled
    // text inputs declaring inputMode="decimal" (never type="number" — the
    // browser rejects commas there, and never inputMode="numeric" — that
    // pattern is shared with OTP/VAT/postal-code fields).
    const isGroupable =
      isControlled &&
      props.inputMode === "decimal" &&
      (type === undefined || type === "text") &&
      (props as any)["data-no-group"] == null;
    if (isNumericField && isControlled) {
      if (!showZeros && isZeroValue(value)) {
        displayValue = "";
        // Faint "0" hint (placeholder:text-muted-foreground in the class list).
        if (displayPlaceholder == null) displayPlaceholder = "0";
      } else if (!focused) {
        // Drop ugly trailing zeros (e.g. DB numeric strings like "10.0000")
        // from the resting display, globally across every numeric input.
        displayValue = trimTrailingZeros(value);
      }
    }
    if (isGroupable) displayValue = groupDigits(displayValue);

    // Strip our display commas from the DOM value BEFORE the parent's
    // onChange sees it — parents parse with Number()/parseFloat and their
    // sanitizers, so they must always receive the RAW ungrouped string.
    // Caret is remembered as "non-comma chars before caret" and restored
    // after the grouped repaint below.
    const parentOnChange = props.onChange;
    const handleChange = !isGroupable ? parentOnChange : (e: React.ChangeEvent<HTMLInputElement>) => {
      const el = e.target;
      const typed = el.value;
      const caret = el.selectionStart ?? typed.length;
      caretRef.current = typed.slice(0, caret).replace(/,/g, "").length;
      if (typed.includes(",")) el.value = typed.replace(/,/g, "");
      parentOnChange?.(e);
    };

    React.useLayoutEffect(() => {
      const el = innerRef.current;
      if (caretRef.current == null || !el) return;
      const want = caretRef.current;
      caretRef.current = null;
      if (document.activeElement !== el) return;
      const dv = el.value;
      let pos = 0, need = want;
      while (pos < dv.length && need > 0) {
        if (dv[pos] !== ",") need--;
        pos++;
      }
      try { el.setSelectionRange(pos, pos); } catch { /* unsupported input types */ }
    });

    const setRefs = (node: HTMLInputElement | null) => {
      innerRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
    };

    return (
      <input
        type={type}
        value={displayValue}
        placeholder={displayPlaceholder}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className
        )}
        ref={setRefs}
        onFocus={(e) => { setFocused(true); onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); onBlur?.(e); }}
        {...props}
        onChange={handleChange}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
