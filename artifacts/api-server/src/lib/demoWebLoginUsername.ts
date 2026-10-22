// This exception is only for the known demo usernames; do not case-fold
// arbitrary tenant usernames (or Unicode lookalikes).
const DEMO_LOGIN_USERNAMES = ["demo", "tafrah"] as const;

function asciiCaseVariants(value: string): string[] {
  return [...value].reduce<string[]>(
    (variants, char) => variants.flatMap(prefix => [
      `${prefix}${char.toLowerCase()}`,
      `${prefix}${char.toUpperCase()}`,
    ]),
    [""],
  );
}

export function isAsciiDemoUsername(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z]+$/.test(value)
    && DEMO_LOGIN_USERNAMES.some(username => value.toLowerCase() === username);
}

export const ASCII_DEMO_USERNAME_VARIANTS = DEMO_LOGIN_USERNAMES.flatMap(asciiCaseVariants);

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