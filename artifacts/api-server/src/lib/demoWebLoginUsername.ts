// This exception is only for the literal four ASCII letters "demo"; do not
// case-fold arbitrary tenant usernames (or Unicode lookalikes).
export function isAsciiDemoUsername(value: unknown): value is string {
  return typeof value === "string" && /^[dD][eE][mM][oO]$/.test(value);
}

export const ASCII_DEMO_USERNAME_VARIANTS = [
  "demo", "demO", "deMo", "deMO", "dEmo", "dEmO", "dEMo", "dEMO",
  "Demo", "DemO", "DeMo", "DeMO", "DEmo", "DEmO", "DEMo", "DEMO",
] as const;

export function isDemoWebLoginAttempt(input: {
  username: unknown;
  appChannel: unknown;
  surface: unknown;
  agentDomainHit: boolean;
  isLocalAgent: boolean;
  intent: unknown;
  demoPhone: unknown;
}): boolean {
  return isAsciiDemoUsername(input.username)
    && input.appChannel !== "mobile"
    && input.surface == null
    && !input.agentDomainHit
    && !input.isLocalAgent
    && (input.intent === "check_demo_preparation" || !!input.demoPhone);
}

type DemoCandidate = {
  user: { username: string; demoDeviceIsolation: boolean; isDemoShadow: boolean };
  hasHistory: boolean;
};

// A demo source is identified by its isolation policy or its sticky workspace
// history, never by its username alone. Ambiguous case variants fail closed.
export function selectDemoWebUsernameFallback<T extends DemoCandidate>(
  submitted: unknown,
  candidates: readonly T[],
): T | null {
  if (!isAsciiDemoUsername(submitted)) return null;
  const eligible = candidates.filter(({ user, hasHistory }) =>
    isAsciiDemoUsername(user.username)
    && !user.isDemoShadow
    && (user.demoDeviceIsolation || hasHistory));
  return eligible.length === 1 ? eligible[0] : null;
}