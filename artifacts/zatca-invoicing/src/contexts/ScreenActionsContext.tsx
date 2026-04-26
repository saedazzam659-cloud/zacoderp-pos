import {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
  type MutableRefObject,
} from "react";
import { navigate as wouterNavigate } from "wouter/use-browser-location";

// ─────────────────────────────────────────────────────────────────────────
// ScreenActionsContext
// ─────────────────────────────────────────────────────────────────────────
// Lets any "actionable" screen (e.g. SalesDocumentForm) advertise to the
// global ScreenAssistant which fields/actions it exposes, plus the lookup
// data the AI needs to resolve human names → ids ("شركة النجاح" → 42).
//
// The assistant reads the registration, sends it (with the current state)
// to /api/ai/command, then plays back the returned commands by calling
// `setField` / `callAction` on the same registration.
//
// We store the live registration in a REF (not state) because heavy forms
// like SalesDocumentForm rebuild the registration on every state change
// — re-rendering the assistant 100x while the user types would burn cycles
// and break voice-recording focus. Only the screenContext key (a string) is
// reactive, so the assistant knows "is there a controllable screen here?".
// ─────────────────────────────────────────────────────────────────────────

export type ScreenFieldDef = {
  /** Stable machine name. The AI references this in commands. */
  name: string;
  /** Human label (use the same wording the user sees on screen). */
  label: string;
  /**
   * Field kind. Drives how the AI is told to format `value`:
   *  - text/number/date → the raw value
   *  - select → MUST be one of the `options[].value`
   *  - lookup → MUST be one of the lookup item ids (resolves names to ids)
   *  - boolean → true / false
   */
  type: "text" | "number" | "date" | "select" | "lookup" | "boolean";
  /** For type="select" — the allowed values. */
  options?: { value: string; label: string }[];
  /** For type="lookup" — key into `lookups` map (e.g. "customers"). */
  lookup?: string;
  /** Optional human description for the AI (units, format, constraints). */
  description?: string;
};

export type ScreenActionParam = {
  name: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  description?: string;
  /** If the param resolves against a lookup list, the lookup key. */
  lookup?: string;
};

export type ScreenActionDef = {
  name: string;
  label: string;
  description?: string;
  params?: ScreenActionParam[];
  /** If true, ScreenAssistant could ask the user to confirm — currently
   *  informational only; the AI is told to confirm verbally instead. */
  destructive?: boolean;
};

export type LookupItem = {
  id: string;
  name: string;
  /** Optional secondary label shown to the AI (code, price, etc.). */
  meta?: Record<string, any>;
};

export type ScreenActionsRegistration = {
  /** Stable identifier for the screen (matches ScreenAssistant's screen_context). */
  screenContext: string;
  /** Short human description of what this screen lets the user do. */
  description?: string;
  fields: ScreenFieldDef[];
  actions: ScreenActionDef[];
  lookups: Record<string, LookupItem[]>;
  /** Returns a JSON-serialisable snapshot of the form state for the AI. */
  getState: () => Record<string, any>;
  /** Apply a value to a registered field. */
  setField: (name: string, value: any) => void;
  /** Invoke a registered action. May be async. */
  callAction: (name: string, params: Record<string, any>) => Promise<void> | void;
};

type Ctx = {
  /** Live registration — read on demand; not React state. */
  ref: MutableRefObject<ScreenActionsRegistration | null>;
  /** Reactive: which screen is active right now (or null). Drives UI. */
  activeScreenContext: string | null;
  publish: (reg: ScreenActionsRegistration | null) => void;
};

const ScreenActionsContext = createContext<Ctx | null>(null);

export function ScreenActionsProvider({ children }: { children: ReactNode }) {
  const ref = useRef<ScreenActionsRegistration | null>(null);
  const [activeScreenContext, setActiveScreenContext] = useState<string | null>(null);

  const publish = useCallback((reg: ScreenActionsRegistration | null) => {
    ref.current = reg;
    setActiveScreenContext(reg?.screenContext ?? null);
  }, []);

  const value = useMemo<Ctx>(
    () => ({ ref, activeScreenContext, publish }),
    [activeScreenContext, publish],
  );

  return (
    <ScreenActionsContext.Provider value={value}>
      {children}
    </ScreenActionsContext.Provider>
  );
}

/**
 * Read the currently-active screen's registration — call this AT THE TIME
 * you need it (e.g. inside a request handler). Returns `null` when no
 * screen has registered.
 */
export function useScreenActionsRef(): MutableRefObject<ScreenActionsRegistration | null> {
  const ctx = useContext(ScreenActionsContext);
  if (!ctx) {
    throw new Error("useScreenActionsRef must be used inside <ScreenActionsProvider>");
  }
  return ctx.ref;
}

/**
 * Reactive signal: which screen has registered actions. Use this to decide
 * whether to show the "I can drive this screen" UI. The actual registration
 * (fields, actions, callbacks) is read via useScreenActionsRef() so that
 * heavy forms don't re-render the assistant on every keystroke.
 */
export function useActiveScreenContext(): string | null {
  const ctx = useContext(ScreenActionsContext);
  if (!ctx) return null;
  return ctx.activeScreenContext;
}

/**
 * Register the current screen as actionable. Pass a registration object
 * — it can be rebuilt on every render (the hook updates an underlying ref,
 * which is cheap). The `screenContext` value is what triggers reactivity:
 * consumers re-render when it changes, but NOT when the form state inside
 * the registration changes.
 *
 * The registration is automatically cleared on unmount.
 */
export function useRegisterScreenActions(reg: ScreenActionsRegistration | null): void {
  const ctx = useContext(ScreenActionsContext);
  if (!ctx) {
    throw new Error("useRegisterScreenActions must be used inside <ScreenActionsProvider>");
  }
  const { ref, publish } = ctx;
  const screenContext = reg?.screenContext ?? null;

  // Always update the ref so callbacks/lookups/state are fresh — cheap.
  ref.current = reg;

  // Publish reactivity ONLY when the screen identity changes.
  useEffect(() => {
    if (!reg) {
      publish(null);
      return;
    }
    publish(reg);
    return () => {
      // Only clear if WE were the active publisher (guard against a race
      // where another screen registered before our cleanup ran).
      if (ref.current === reg) {
        publish(null);
        ref.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenContext, publish]);
}

// ─────────────────────────────────────────────────────────────────────────
// Command playback
// ─────────────────────────────────────────────────────────────────────────

export type ExecutedStep = {
  ok: boolean;
  type:
    | "set_field"
    | "call_action"
    | "navigate"
    | "click"
    | "double_click"
    | "type_text"
    | "select_option";
  label: string;
  error?: string;
};

/**
 * Discriminated union of every command shape the AI is allowed to emit.
 *
 * The first two (`set_field`, `call_action`) are *screen-scoped* — they
 * require the active screen to have called useRegisterScreenActions.
 *
 * The remaining ones are *global*: they run against the live DOM (visible
 * buttons, inputs, comboboxes) or the wouter router, so they work on every
 * screen without per-screen registration. This is what makes voice control
 * usable on the entire app, not just data-entry forms.
 */
export type AICommand =
  | { type: "set_field"; field: string; value: any }
  | { type: "call_action"; action: string; params?: Record<string, any> }
  | { type: "navigate"; path: string; label?: string }
  | { type: "click"; label?: string; selector?: string; testid?: string }
  | { type: "double_click"; label?: string; selector?: string; testid?: string }
  | { type: "type_text"; label?: string; selector?: string; value: string }
  | { type: "select_option"; label?: string; selector?: string; option: string };

/**
 * Convenience hook: returns a stable executor that plays back a list of AI
 * commands against the active registration. Returns step-by-step results so
 * the assistant can show what was done.
 */
/** Short label for an AI command, used in the chat log when something fails. */
function describeCommand(cmd: AICommand): string {
  switch (cmd.type) {
    case "set_field":
      return cmd.field;
    case "call_action":
      return cmd.action;
    case "navigate":
      return cmd.label || cmd.path;
    case "click":
    case "double_click":
      return cmd.label || cmd.testid || cmd.selector || cmd.type;
    case "type_text":
      return cmd.label || cmd.selector || "text";
    case "select_option":
      return `${cmd.label || cmd.selector || "select"} → ${cmd.option}`;
    default:
      return "command";
  }
}

/**
 * Labels (AR + EN) that we treat as destructive. Voice/AI is denied from
 * clicking these without explicit user re-confirmation, so a misheard
 * "next" doesn't fire "حذف" / "Delete" / "Post".
 */
const DESTRUCTIVE_LABEL_PATTERNS: RegExp[] = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bvoid\b/i,
  /\bcancel\s+invoice\b/i,
  /\bdiscard\b/i,
  /\bdestroy\b/i,
  /\bdrop\b/i,
  /\breset\b/i,
  /حذف/,
  /إزالة/,
  /إلغاء\s*(الفاتورة|الطلب|المستند)/,
  /تدمير/,
  /مسح\s*الكل/,
];

function isDestructiveLabel(label: string | undefined): boolean {
  if (!label) return false;
  const norm = label.replace(/[\u064B-\u065F\u0670]/g, "").trim();
  return DESTRUCTIVE_LABEL_PATTERNS.some((p) => p.test(norm));
}

export function useCommandExecutor() {
  const ref = useScreenActionsRef();
  return useCallback(
    async (
      commands: AICommand[],
      expectedScreenContext?: string,
    ): Promise<ExecutedStep[]> => {
      const log: ExecutedStep[] = [];
      // Snapshot the route at the start. If the user (or a previous command)
      // navigates while we're still iterating, GLOBAL DOM-targeting commands
      // would land on the wrong screen, so we abort the rest.
      const startPath =
        typeof window !== "undefined" ? window.location.pathname : "";

      // Track if we've executed a navigate command in this run. After
      // navigation the new screen is loading, so any further click/type/
      // select would target the previous screen's stale DOM. Drop them.
      let navigated = false;

      for (const cmd of commands) {
        const live = ref.current;

        // After a navigate, refuse to run any further commands in the same
        // batch. The model is told this is the rule, but we enforce it here.
        if (navigated) {
          log.push({
            ok: false,
            type: cmd.type,
            label: describeCommand(cmd),
            error: "navigated-mid-batch",
          });
          break;
        }

        // For DOM-targeting commands (anything that is NOT navigate), abort
        // if the user (or earlier code) navigated since the batch started —
        // the stored DOM from when the model planned this no longer applies.
        if (
          cmd.type !== "navigate" &&
          typeof window !== "undefined" &&
          window.location.pathname !== startPath
        ) {
          log.push({
            ok: false,
            type: cmd.type,
            label: describeCommand(cmd),
            error: "screen-changed",
          });
          break;
        }

        // Refuse destructive button clicks without explicit user re-confirm.
        // The AI is told to ask first; this catches it if it doesn't.
        if (
          (cmd.type === "click" || cmd.type === "double_click") &&
          isDestructiveLabel(cmd.label)
        ) {
          log.push({
            ok: false,
            type: cmd.type,
            label: describeCommand(cmd),
            error: "destructive-action-blocked",
          });
          break;
        }

        // Screen-scoped commands need a registration AND, if the caller cares
        // which screen they're for, that the screen hasn't changed mid-flight.
        const isScreenScoped =
          cmd.type === "set_field" || cmd.type === "call_action";

        if (isScreenScoped) {
          if (!live) {
            log.push({
              ok: false,
              type: cmd.type,
              label: describeCommand(cmd),
              error: "no-active-screen",
            });
            break;
          }
          if (
            expectedScreenContext &&
            live.screenContext !== expectedScreenContext
          ) {
            log.push({
              ok: false,
              type: cmd.type,
              label: describeCommand(cmd),
              error: "screen-changed",
            });
            break;
          }
        }

        try {
          if (cmd.type === "set_field") {
            const def = live!.fields.find((f) => f.name === cmd.field);
            if (!def) throw new Error(`unknown field: ${cmd.field}`);
            const validated = validateFieldValue(def, cmd.value, live!.lookups);
            live!.setField(cmd.field, validated);
            const valueLabel = formatValueLabel(def, validated, live!.lookups);
            log.push({ ok: true, type: "set_field", label: `${def.label}: ${valueLabel}` });
          } else if (cmd.type === "call_action") {
            const def = live!.actions.find((a) => a.name === cmd.action);
            if (!def) throw new Error(`unknown action: ${cmd.action}`);
            await live!.callAction(cmd.action, cmd.params ?? {});
            log.push({ ok: true, type: "call_action", label: def.label });
          } else if (cmd.type === "navigate") {
            const path = String(cmd.path || "").trim();
            if (!path || !path.startsWith("/")) throw new Error(`bad path: ${path}`);
            wouterNavigate(path);
            log.push({
              ok: true,
              type: "navigate",
              label: cmd.label ? `${cmd.label} (${path})` : path,
            });
            navigated = true;
            // Stop the loop here. Any further commands the model emitted are
            // either unsafe (DOM has changed) or against our policy.
            break;
          } else if (cmd.type === "click" || cmd.type === "double_click") {
            const el = findClickable(cmd);
            if (!el) {
              throw new Error(
                `لم أجد زراً مطابقاً لـ "${cmd.label || cmd.testid || cmd.selector}"`,
              );
            }
            scrollIntoViewSafe(el);
            if (cmd.type === "double_click") {
              fireMouseEvent(el, "dblclick");
            } else {
              (el as HTMLElement).click();
            }
            log.push({
              ok: true,
              type: cmd.type,
              label: describeCommand(cmd),
            });
          } else if (cmd.type === "type_text") {
            const el = findInput(cmd);
            if (!el) {
              throw new Error(`لم أجد حقل إدخال مطابقاً لـ "${cmd.label || cmd.selector}"`);
            }
            scrollIntoViewSafe(el);
            setNativeInputValue(el, String(cmd.value ?? ""));
            log.push({
              ok: true,
              type: "type_text",
              label: `${cmd.label || cmd.selector}: ${cmd.value}`,
            });
          } else if (cmd.type === "select_option") {
            await selectOption(cmd);
            log.push({
              ok: true,
              type: "select_option",
              label: describeCommand(cmd),
            });
          } else {
            throw new Error(`unknown command type: ${(cmd as any).type}`);
          }
          // Tiny pause between commands — gives React state setters time to
          // settle so e.g. setField(customerId) is visible before addLine()
          // does its derived calculations.
          await new Promise((r) => setTimeout(r, 80));
        } catch (e: any) {
          log.push({
            ok: false,
            type: cmd.type,
            label: describeCommand(cmd),
            error: String(e?.message ?? e),
          });
          // Stop on first failure — the AI's plan was sequential.
          break;
        }
      }
      return log;
    },
    [ref],
  );
}

// ─────────────────────────────────────────────────────────────────────────
// DOM-based command primitives
//
// These let voice commands work on every screen without per-screen
// registration. We try a few selector strategies in priority order and
// only return visible elements so we don't accidentally click hidden /
// off-screen widgets.
// ─────────────────────────────────────────────────────────────────────────

function isVisible(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.hidden) return false;
  const cs = window.getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  // Allow 0×0 as long as it's in the document — Radix sometimes positions
  // triggers oddly during animation. Filter out only obviously off-screen.
  if (rect.bottom < 0 || rect.right < 0) return false;
  if (rect.top > (window.innerHeight + 200)) return false;
  return true;
}

function normalize(s: string): string {
  return (s || "")
    .replace(/[\u064B-\u065F\u0670]/g, "") // strip Arabic diacritics
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function elementText(el: Element): string {
  // Prefer aria-label / title / value if present, else visible text.
  const aria = (el as HTMLElement).getAttribute?.("aria-label");
  if (aria) return aria;
  const title = (el as HTMLElement).getAttribute?.("title");
  if (title) return title;
  const value = (el as HTMLInputElement).value;
  if (value && (el.tagName === "INPUT" || el.tagName === "BUTTON")) return value;
  return (el.textContent || "").trim();
}

function labelMatches(elText: string, target: string): boolean {
  const a = normalize(elText);
  const b = normalize(target);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  return false;
}

function findClickable(cmd: { label?: string; selector?: string; testid?: string }): HTMLElement | null {
  // 1. Explicit selector wins.
  if (cmd.selector) {
    const el = document.querySelector(cmd.selector);
    if (isVisible(el)) return el;
  }
  // 2. data-testid match.
  if (cmd.testid) {
    const el = document.querySelector(`[data-testid="${cssEscape(cmd.testid)}"]`);
    if (isVisible(el)) return el;
  }
  // 3. Label-based fuzzy search across plausible click targets.
  if (cmd.label) {
    const candidates = document.querySelectorAll<HTMLElement>(
      [
        "button",
        '[role="button"]',
        "a[href]",
        '[role="menuitem"]',
        '[role="tab"]',
        "[data-voice-action]",
      ].join(","),
    );
    // Two-pass: prefer exact match, then fall back to a substring match.
    let exact: HTMLElement | null = null;
    let partial: HTMLElement | null = null;
    candidates.forEach((el) => {
      if (!isVisible(el)) return;
      const text = elementText(el);
      const a = normalize(text);
      const b = normalize(cmd.label!);
      if (!a || !b) return;
      if (a === b && !exact) exact = el;
      else if (!partial && (a.includes(b) || b.includes(a))) partial = el;
    });
    return exact || partial;
  }
  return null;
}

/**
 * Refuse to type into sensitive fields (passwords, PIN codes, payment
 * card numbers, etc). Even if the user *asks* the AI to fill the password
 * with their actual password, we don't want a stray transcription leak.
 */
function isSensitiveInput(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  const t = (el.getAttribute("type") || "").toLowerCase();
  if (t === "password") return true;
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (
    ac.includes("password") ||
    ac.includes("cc-number") ||
    ac.includes("cc-csc") ||
    ac.includes("one-time-code")
  ) {
    return true;
  }
  const name = (el.getAttribute("name") || "").toLowerCase();
  if (/(password|passcode|pin|cvc|cvv|otp)/.test(name)) return true;
  return false;
}

function pickSafeInput(
  el: Element | null,
): HTMLInputElement | HTMLTextAreaElement | null {
  if (!isVisible(el)) return null;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    return null;
  }
  if (isSensitiveInput(el)) return null;
  return el;
}

function findInput(cmd: { label?: string; selector?: string }): HTMLInputElement | HTMLTextAreaElement | null {
  if (cmd.selector) {
    const el = pickSafeInput(document.querySelector(cmd.selector));
    if (el) return el;
  }
  if (cmd.label) {
    // Check every <label> for matching text and follow its `for` / nested input.
    const labels = Array.from(document.querySelectorAll<HTMLLabelElement>("label"));
    for (const l of labels) {
      if (!labelMatches(l.textContent || "", cmd.label)) continue;
      const forId = l.getAttribute("for");
      if (forId) {
        const target = pickSafeInput(document.getElementById(forId));
        if (target) return target;
      }
      const nested = pickSafeInput(l.querySelector("input,textarea"));
      if (nested) return nested;
    }
    // Fall back: aria-label / placeholder / name / data-testid match.
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "input:not([type=hidden]):not([type=password]),textarea",
      ),
    );
    for (const i of inputs) {
      if (!isVisible(i)) continue;
      if (isSensitiveInput(i)) continue;
      const candidates = [
        i.getAttribute("aria-label"),
        i.getAttribute("placeholder"),
        i.getAttribute("name"),
        i.getAttribute("data-testid"),
      ];
      if (candidates.some((c) => c && labelMatches(c, cmd.label!))) {
        return i;
      }
    }
  }
  return null;
}

/**
 * Set an <input> / <textarea> value in a way React's controlled inputs accept.
 * React tracks the value via a hidden setter on the element prototype; calling
 * `el.value = x` directly bypasses that and React reverts the change on the
 * next render. We invoke the prototype setter, then dispatch input + change.
 */
function setNativeInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.focus();
}

/**
 * Open a Radix Select / shadcn Combobox by clicking its trigger, then click
 * the option whose text matches `option`. Falls back to native <select> with
 * a direct value assignment.
 */
async function selectOption(cmd: { label?: string; selector?: string; option: string }) {
  // Native <select> first — easier and cheaper.
  const native = (() => {
    if (cmd.selector) {
      const el = document.querySelector(cmd.selector);
      if (el instanceof HTMLSelectElement && isVisible(el)) return el;
    }
    if (cmd.label) {
      const labels = Array.from(document.querySelectorAll<HTMLLabelElement>("label"));
      for (const l of labels) {
        if (!labelMatches(l.textContent || "", cmd.label)) continue;
        const forId = l.getAttribute("for");
        if (forId) {
          const t = document.getElementById(forId);
          if (t instanceof HTMLSelectElement && isVisible(t)) return t;
        }
        const nested = l.querySelector("select");
        if (nested instanceof HTMLSelectElement && isVisible(nested)) return nested;
      }
    }
    return null;
  })();

  if (native) {
    const want = normalize(cmd.option);
    const opt = Array.from(native.options).find(
      (o) => normalize(o.label || o.textContent || "") === want || normalize(o.value) === want,
    );
    if (!opt) throw new Error(`الخيار "${cmd.option}" غير موجود`);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (setter) setter.call(native, opt.value);
    else native.value = opt.value;
    native.dispatchEvent(new Event("input", { bubbles: true }));
    native.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  // Radix / shadcn combobox: find a [role=combobox] whose label / trigger
  // matches, click to open, then click the option in the popover.
  const trigger = (() => {
    if (cmd.selector) {
      const el = document.querySelector(cmd.selector);
      if (isVisible(el)) return el as HTMLElement;
    }
    if (cmd.label) {
      // Try associating via label.
      const labels = Array.from(document.querySelectorAll<HTMLLabelElement>("label"));
      for (const l of labels) {
        if (!labelMatches(l.textContent || "", cmd.label)) continue;
        const forId = l.getAttribute("for");
        if (forId) {
          const t = document.getElementById(forId);
          if (isVisible(t)) return t as HTMLElement;
        }
        const nested = l.querySelector('[role="combobox"],button[aria-haspopup]');
        if (isVisible(nested)) return nested as HTMLElement;
      }
      // Fall back: any visible combobox whose own text matches.
      const combos = Array.from(
        document.querySelectorAll<HTMLElement>('[role="combobox"],button[aria-haspopup]'),
      );
      for (const c of combos) {
        if (!isVisible(c)) continue;
        const text = c.getAttribute("aria-label") || c.textContent || "";
        if (labelMatches(text, cmd.label)) return c;
      }
    }
    return null;
  })();

  if (!trigger) throw new Error(`لم أجد قائمة منسدلة مطابقة لـ "${cmd.label}"`);
  scrollIntoViewSafe(trigger);
  trigger.click();
  // Wait for the popover to mount.
  await new Promise((r) => setTimeout(r, 180));
  // Search visible options across the document (Radix renders into a portal).
  const options = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="option"],[role="menuitem"],[cmdk-item],[data-radix-collection-item]',
    ),
  );
  const want = normalize(cmd.option);
  let target: HTMLElement | null = null;
  for (const o of options) {
    if (!isVisible(o)) continue;
    const text = elementText(o);
    if (normalize(text) === want) {
      target = o;
      break;
    }
  }
  if (!target) {
    for (const o of options) {
      if (!isVisible(o)) continue;
      if (labelMatches(elementText(o), cmd.option)) {
        target = o;
        break;
      }
    }
  }
  if (!target) {
    // Close the popover so the screen isn't left in a weird state.
    document.body.click();
    throw new Error(`الخيار "${cmd.option}" غير معروض في القائمة`);
  }
  target.click();
}

function scrollIntoViewSafe(el: HTMLElement) {
  try {
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
  } catch {
    /* noop */
  }
}

function fireMouseEvent(el: HTMLElement, type: string) {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/["\\]/g, "\\$&");
}

/**
 * Coerce / validate a value against the field definition. Throws if the
 * value cannot be made to fit (e.g. select option not in list, lookup id
 * not in lookup table). Numbers/booleans are coerced when possible.
 */
function validateFieldValue(
  def: ScreenFieldDef,
  value: any,
  lookups: Record<string, LookupItem[]>,
): any {
  if (def.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === 1) return true;
    if (value === "false" || value === 0 || value == null) return false;
    return Boolean(value);
  }
  if (def.type === "number") {
    const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
    if (!Number.isFinite(n)) throw new Error(`invalid number for ${def.name}`);
    return n;
  }
  if (def.type === "select" && def.options) {
    const match = def.options.find((o) => String(o.value) === String(value));
    if (!match) {
      throw new Error(
        `invalid option for ${def.name} — got "${value}", expected one of [${def.options
          .map((o) => o.value)
          .join(", ")}]`,
      );
    }
    return match.value;
  }
  if (def.type === "lookup" && def.lookup) {
    const list = lookups[def.lookup] ?? [];
    const idStr = String(value);
    if (!list.some((it) => String(it.id) === idStr)) {
      throw new Error(`unknown ${def.lookup} id: ${idStr}`);
    }
    return idStr;
  }
  if (def.type === "date") {
    const s = String(value ?? "");
    if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new Error(`invalid date for ${def.name}: ${s}`);
    return s.slice(0, 10);
  }
  // text — just stringify
  return value == null ? "" : String(value);
}

function formatValueLabel(
  def: ScreenFieldDef,
  value: any,
  lookups: Record<string, LookupItem[]>,
): string {
  if (def.type === "select" && def.options) {
    const o = def.options.find((o) => String(o.value) === String(value));
    if (o) return o.label;
  }
  if (def.type === "lookup" && def.lookup) {
    const list = lookups[def.lookup] ?? [];
    const it = list.find((i) => String(i.id) === String(value));
    if (it) return it.name;
  }
  if (def.type === "boolean") return value ? "✓" : "✗";
  return value === null || value === undefined ? "—" : String(value);
}
