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
  type: "set_field" | "call_action";
  label: string;
  error?: string;
};

export type AICommand =
  | { type: "set_field"; field: string; value: any }
  | { type: "call_action"; action: string; params?: Record<string, any> };

/**
 * Convenience hook: returns a stable executor that plays back a list of AI
 * commands against the active registration. Returns step-by-step results so
 * the assistant can show what was done.
 */
export function useCommandExecutor() {
  const ref = useScreenActionsRef();
  return useCallback(
    async (
      commands: AICommand[],
      expectedScreenContext?: string,
    ): Promise<ExecutedStep[]> => {
      const reg = ref.current;
      const log: ExecutedStep[] = [];
      if (!reg) {
        return commands.map((c) => ({
          ok: false,
          type: c.type,
          label: c.type === "set_field" ? c.field : c.action,
          error: "no-active-screen",
        }));
      }
      // Race guard: if the user navigated to a different screen while the AI
      // was thinking, the registration may be for a totally different form
      // (different fields/actions). Abort instead of mis-applying commands.
      if (expectedScreenContext && reg.screenContext !== expectedScreenContext) {
        return [
          {
            ok: false,
            type: commands[0]?.type ?? "set_field",
            label: "screen-changed",
            error: `screen changed (was ${expectedScreenContext}, now ${reg.screenContext})`,
          },
        ];
      }
      for (const cmd of commands) {
        // Re-check the registration before every step — a fast-clicking user
        // could route mid-playback. Drop remaining commands instead of
        // executing them against a different screen.
        const live = ref.current;
        if (
          !live ||
          (expectedScreenContext && live.screenContext !== expectedScreenContext)
        ) {
          log.push({
            ok: false,
            type: cmd.type,
            label: cmd.type === "set_field" ? cmd.field : cmd.action,
            error: "screen-changed",
          });
          break;
        }
        try {
          if (cmd.type === "set_field") {
            const def = live.fields.find((f) => f.name === cmd.field);
            if (!def) throw new Error(`unknown field: ${cmd.field}`);
            const validated = validateFieldValue(def, cmd.value, live.lookups);
            live.setField(cmd.field, validated);
            const valueLabel = formatValueLabel(def, validated, live.lookups);
            log.push({ ok: true, type: "set_field", label: `${def.label}: ${valueLabel}` });
          } else if (cmd.type === "call_action") {
            const def = live.actions.find((a) => a.name === cmd.action);
            if (!def) throw new Error(`unknown action: ${cmd.action}`);
            await live.callAction(cmd.action, cmd.params ?? {});
            log.push({ ok: true, type: "call_action", label: def.label });
          } else {
            throw new Error(`unknown command type: ${(cmd as any).type}`);
          }
          // Tiny pause between commands — gives React state setters time to
          // settle so e.g. setField(customerId) is visible before addLine()
          // does its derived calculations.
          await new Promise((r) => setTimeout(r, 60));
        } catch (e: any) {
          log.push({
            ok: false,
            type: cmd.type,
            label: cmd.type === "set_field" ? cmd.field : cmd.action,
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
