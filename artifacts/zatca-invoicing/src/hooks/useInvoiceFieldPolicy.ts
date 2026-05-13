// React hook + helpers for consuming the per-company invoice field policy.
//
// The bundle is fetched once per session and cached for 5 minutes.
// `useFieldPolicy(scope)` gives every form a tight API:
//
//   const fp = useFieldPolicy("sales");
//   if (!fp.isVisible("notes")) return null;
//   <Input ... readOnly={fp.isReadOnly("date")} required={fp.isRequired("date")} />
//   const dateBounds = fp.dateBounds("date"); // { min, max } or null
//
// Admins get an all-editable bundle so existing UX is unchanged for them.

import { useQuery } from "@tanstack/react-query";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export type FieldMode = "editable" | "readonly" | "hidden" | "required";
export type DateConstraint = "none" | "today_only";
export type PolicyScope = "sales" | "purchase" | "pos";

export interface FieldRule {
  mode: FieldMode;
  dateConstraint?: DateConstraint;
}
export type PolicyMap = Record<string, FieldRule>;

interface BundleResponse {
  isAdmin: boolean;
  bundle: Record<PolicyScope, PolicyMap>;
}

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function fetchBundle(): Promise<BundleResponse> {
  const token = localStorage.getItem("zatca_token") ?? "";
  return fetch(`${API}/api/invoice-field-policies/me`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).then(async (r) => {
    if (!r.ok) {
      // Fail-safe: when the policy endpoint can't answer (network blip, server
      // error), return an empty bundle WITHOUT admin bypass. The default rule
      // for unknown keys is `editable`, so all fields stay usable but the
      // admin's intent (hidden / readonly / required / today_only) is NOT
      // silently revoked just because one fetch failed.
      return { isAdmin: false, bundle: { sales: {}, purchase: {}, pos: {} } } as BundleResponse;
    }
    return r.json();
  });
}

export function useInvoiceFieldPolicyBundle() {
  return useQuery({
    queryKey: ["invoice-field-policies", "me"],
    queryFn: fetchBundle,
    staleTime: 5 * 60 * 1000,
  });
}

export interface FieldPolicy {
  /** True for admins/superadmins — all checks are bypassed (everything is editable). */
  bypass: boolean;
  rule: (key: string) => FieldRule;
  isVisible: (key: string) => boolean;
  isReadOnly: (key: string) => boolean;
  isRequired: (key: string) => boolean;
  /** For date fields locked to today: returns `{ min, max }` for <input type="date">, else `null`. */
  dateBounds: (key: string) => { min?: string; max?: string } | null;
}

export function useFieldPolicy(scope: PolicyScope): FieldPolicy {
  const { data, isLoading } = useInvoiceFieldPolicyBundle();
  // While loading, bypass (avoid flicker — fields render immediately).
  // Once data arrives, only bypass if the server says the user is admin.
  const bypass = isLoading ? true : (data?.isAdmin ?? false);
  const map = data?.bundle?.[scope] ?? {};

  function rule(key: string): FieldRule {
    if (bypass) return { mode: "editable" };
    return map[key] ?? { mode: "editable" };
  }
  function isVisible(key: string)  { return rule(key).mode !== "hidden"; }
  function isReadOnly(key: string) { return rule(key).mode === "readonly"; }
  function isRequired(key: string) { return rule(key).mode === "required"; }
  function dateBounds(key: string) {
    const r = rule(key);
    if (r.dateConstraint === "today_only") {
      const t = todayIso();
      return { min: t, max: t };
    }
    return null;
  }
  return { bypass, rule, isVisible, isReadOnly, isRequired, dateBounds };
}
