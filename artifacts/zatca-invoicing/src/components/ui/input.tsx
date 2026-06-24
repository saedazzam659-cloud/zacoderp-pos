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

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, value, placeholder, ...props }, ref) => {
    const auth = React.useContext(AuthContext);
    const showZeros = (auth?.user as any)?.company?.showZeros === true;

    let displayValue = value;
    let displayPlaceholder = placeholder;
    // Only ever touch the rendered value of a CONTROLLED input — one that
    // supplies both `value` and `onChange`. Such inputs submit from their
    // parent's React state (which still holds 0), so blanking the box is
    // purely cosmetic. Uncontrolled / ref-driven fields (e.g. react-hook-form
    // `register()`, which passes no `value`) are read from the DOM on submit,
    // so we must never blank them — they're left exactly as-is.
    const isControlled = value !== undefined && typeof props.onChange === "function";
    if (type === "number" && isControlled && !showZeros && isZeroValue(value)) {
      displayValue = "";
      // Faint "0" hint (placeholder:text-muted-foreground in the class list).
      if (displayPlaceholder == null) displayPlaceholder = "0";
    }

    return (
      <input
        type={type}
        value={displayValue}
        placeholder={displayPlaceholder}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
