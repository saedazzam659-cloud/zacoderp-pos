// React hook + helpers for consuming the invoice field policy.
//
// Each user has at most one assigned policy "profile" (set in
// /admin/invoice-field-policies). The hook fetches the effective bundle
// once per session and exposes per-field helpers used by invoice forms:
//
//   const fp = useFieldPolicy("sales");
//   if (!fp.isVisible("notes")) return null;
//   <Input ... readOnly={fp.isReadOnly("date")} required={fp.isRequired("date")} />
//   const dateBounds = fp.dateBounds("date"); // { min, max } or null
//
// Admins/superadmins always get an all-editable bundle.

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
export type PolicyBundle = Record<PolicyScope, PolicyMap>;

interface BundleResponse {
  isAdmin: boolean;
  bundle: PolicyBundle;
  profile: { id: number; name: string } | null;
}

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function emptyBundle(): PolicyBundle {
  return { sales: {}, purchase: {}, pos: {} };
}

function fetchBundle(): Promise<BundleResponse> {
  const token = localStorage.getItem("zatca_token") ?? "";
  return fetch(`${API}/api/invoice-field-policies/me`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).then(async (r) => {
    if (!r.ok) {
      // Fail-safe: empty bundle (defaults to editable) WITHOUT admin bypass.
      return { isAdmin: false, bundle: emptyBundle(), profile: null };
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
  bypass: boolean;
  profileName: string | null;
  rule: (key: string) => FieldRule;
  isVisible: (key: string) => boolean;
  isReadOnly: (key: string) => boolean;
  isRequired: (key: string) => boolean;
  dateBounds: (key: string) => { min?: string; max?: string } | null;
}

export function useFieldPolicy(scope: PolicyScope): FieldPolicy {
  const { data, isLoading } = useInvoiceFieldPolicyBundle();
  const bypass = isLoading ? true : (data?.isAdmin ?? false);
  const map = data?.bundle?.[scope] ?? {};
  const profileName = data?.profile?.name ?? null;

  function rule(key: string): FieldRule {
    if (bypass) return { mode: "editable" };
    return map[key] ?? { mode: "editable" };
  }
  function isVisible(key: string)  { return rule(key).mode !== "hidden"; }
  function isReadOnly(key: string) { return rule(key).mode === "readonly"; }
  function isRequired(key: string) { return rule(key).mode === "required"; }
  function dateBounds(key: string) {
    if (rule(key).dateConstraint === "today_only") {
      const t = todayIso();
      return { min: t, max: t };
    }
    return null;
  }
  return { bypass, profileName, rule, isVisible, isReadOnly, isRequired, dateBounds };
}
