type NumberEditState = {
  defaultValue: string;
  hasEdited: boolean;
  clearedWhileEditing: boolean;
};

/**
 * Lets a cashier type over a displayed numeric default (0 or 1) without
 * changing the value until they actually enter a replacement. If an edited
 * field is left empty, its original default is restored through the normal
 * input event so controlled React forms keep their existing state logic.
 */
export function installNumberInputDefaultReplacement(doc: Document): () => void {
  const editStates = new WeakMap<HTMLInputElement, NumberEditState>();

  function getEditableNumber(target: EventTarget | null): HTMLInputElement | null {
    if (!(target instanceof HTMLInputElement) || (target.type !== "number" && target.inputMode !== "decimal")) return null;
    if (target.disabled || target.readOnly) return null;
    return target;
  }

  function handleFocusIn(event: FocusEvent) {
    const input = getEditableNumber(event.target);
    if (!input) return;

    const numericValue = Number(input.value);
    if (input.value.trim() !== "" && (numericValue === 0 || numericValue === 1)) {
      editStates.set(input, {
        defaultValue: input.value,
        hasEdited: false,
        clearedWhileEditing: false,
      });
    } else {
      editStates.delete(input);
    }
  }

  function restoreDefault(input: HTMLInputElement, state: NumberEditState) {
    input.value = state.defaultValue;
    state.hasEdited = false;
    state.clearedWhileEditing = false;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // The dispatched event marks the field as edited; it is a restored default,
    // so the next first digit should still replace it.
    state.hasEdited = false;
    state.clearedWhileEditing = false;
  }

  function handleKeyDown(event: KeyboardEvent) {
    const input = getEditableNumber(event.target);
    if (!input || event.isComposing) return;

    const state = editStates.get(input);
    if (!state) return;

    if (event.key === "Enter" && (state.clearedWhileEditing || input.value === "")) {
      restoreDefault(input, state);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || !(/^[0-9]$/.test(event.key) || event.key === "-")) return;

    if ((!state.hasEdited && input.value === state.defaultValue) || state.clearedWhileEditing) {
      // Leave the actual key event alone: the browser's normal input event
      // will carry the replacement through the existing controlled onChange.
      input.value = "";
    }
  }

  function handlePaste(event: ClipboardEvent) {
    const input = getEditableNumber(event.target);
    if (!input) return;

    const state = editStates.get(input);
    if (state && ((!state.hasEdited && input.value === state.defaultValue) || state.clearedWhileEditing)) {
      input.value = "";
    }
  }

  function handleInput(event: Event) {
    const input = getEditableNumber(event.target);
    if (!input) return;

    const state = editStates.get(input);
    if (!state) return;

    state.hasEdited = true;
    // Browsers can report an incomplete decimal/sign as an empty value while
    // the user is still entering it. Do not treat that as an intentional clear.
    state.clearedWhileEditing = input.value === "" && !input.validity.badInput;
  }

  function handleFocusOut(event: FocusEvent) {
    const input = getEditableNumber(event.target);
    if (!input) return;

    const state = editStates.get(input);
    if (!state) return;

    if (state.clearedWhileEditing || input.value === "") {
      restoreDefault(input, state);
    }
    editStates.delete(input);
  }

  doc.addEventListener("focusin", handleFocusIn, true);
  doc.addEventListener("keydown", handleKeyDown, true);
  doc.addEventListener("paste", handlePaste, true);
  doc.addEventListener("input", handleInput, true);
  doc.addEventListener("focusout", handleFocusOut, true);

  return () => {
    doc.removeEventListener("focusin", handleFocusIn, true);
    doc.removeEventListener("keydown", handleKeyDown, true);
    doc.removeEventListener("paste", handlePaste, true);
    doc.removeEventListener("input", handleInput, true);
    doc.removeEventListener("focusout", handleFocusOut, true);
  };
}
