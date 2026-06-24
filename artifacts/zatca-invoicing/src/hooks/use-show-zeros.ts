import { useAuth } from "@/contexts/AuthContext";

/**
 * useShowZeros — company-wide display preference for numeric INPUT fields.
 *
 * Returns `true` when the active company wants a value of 0 shown literally as
 * "0", and `false` (the default for existing + new companies) when zeros should
 * be hidden (blank field + faint "0" placeholder). Display-only: it must NEVER
 * influence stored values, calculations, or reports.
 *
 * The actual blanking is applied centrally by the shared <Input> component, so
 * most screens need nothing. This hook is for surfaces that render their own
 * numeric markup or need to reflect the toggle (e.g. General Settings).
 */
export function useShowZeros(): boolean {
  const { user } = useAuth();
  return (user as any)?.company?.showZeros === true;
}
