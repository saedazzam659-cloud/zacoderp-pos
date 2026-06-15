import * as React from "react";

import { SmartDateInput } from "@/components/ui/smart-date-input";

export type DateFieldProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "type" | "value"
> & {
  /** ISO `YYYY-MM-DD` (mirrors the native date input's string value). */
  value?: string | number | readonly string[];
  /** Native-style change handler — `e.target.value` is the ISO `YYYY-MM-DD`. */
  onChange?: (e: { target: { value: string; name?: string } }) => void;
};

/**
 * Drop-in replacement for the native `<input type="date">`.
 *
 * Renders the locale-independent `SmartDateInput` (familiar `DD/MM/YYYY`
 * display + calendar popover + Arabic-Indic digit support) so the field looks
 * identical on every device regardless of the OS language/calendar (the native
 * picker shows a Hijri/garbled placeholder on some Saudi devices). The stored /
 * emitted value stays ISO `YYYY-MM-DD`, and the event-style `onChange` keeps the
 * exact same call-site contract as the native input, so swapping
 * `<Input type="date" …>` → `<DateField …>` needs no logic changes.
 */
export const DateField = React.forwardRef<HTMLInputElement, DateFieldProps>(
  function DateField(props, ref) {
    const {
      value,
      onChange,
      name,
      min,
      max,
      // Native-only props that SmartDateInput manages itself — drop them so they
      // don't fight the DD/MM/YYYY text editor.
      dir: _dir,
      step: _step,
      autoComplete: _autoComplete,
      inputMode: _inputMode,
      // Everything else (onBlur, onFocus, data-*, aria-*, tabIndex, readOnly,
      // disabled, required, className, title, id, placeholder, …) passes through.
      ...rest
    } = props;
    void _dir;
    void _step;
    void _autoComplete;
    void _inputMode;

    return (
      <SmartDateInput
        {...rest}
        ref={ref}
        name={name}
        value={typeof value === "string" ? value : ""}
        onChange={(iso) => onChange?.({ target: { value: iso, name } })}
        min={typeof min === "string" ? min : undefined}
        max={typeof max === "string" ? max : undefined}
      />
    );
  },
);

export default DateField;
