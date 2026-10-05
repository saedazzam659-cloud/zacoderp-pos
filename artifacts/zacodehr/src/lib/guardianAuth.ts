export type GuardianSessionAccount = {
  displayName: string;
  username: string;
  childrenCount: number;
};

const TOKEN_KEY = "zacodehr_guardian_token";
const ACCOUNT_KEY = "zacodehr_guardian_account";

export function getGuardianToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getGuardianAccount(): GuardianSessionAccount | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    return raw ? JSON.parse(raw) as GuardianSessionAccount : null;
  } catch {
    return null;
  }
}

export function setGuardianSession(token: string, account: GuardianSessionAccount): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
}

export function clearGuardianSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // Storage can be unavailable in restrictive browser modes.
  }
}
