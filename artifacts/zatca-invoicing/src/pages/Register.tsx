import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth, type RegisterData } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  Building2, User, Package, Check, ChevronLeft, ChevronRight,
  Eye, EyeOff, Loader2, ShieldCheck, Star, Crown, Globe2, Sparkles
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  COUNTRIES, DEFAULT_COUNTRY_CODE,
  getCountryByCode, getCountryPolicy,
} from "@/lib/countries";
import { INDUSTRIES as INDUSTRIES_FALLBACK } from "@/lib/industries";
import { MENU_ITEM_BY_KEY, deriveModulesFromMenuKeys } from "@/lib/menuItems";

// Live row from /api/admin/industries/public — derived from the
// `industries` table (SuperAdmin-managed in /admin/industries). Falls
// back to the bundled INDUSTRIES_FALLBACK on a hard fetch error so the
// chip strip never renders empty mid-registration.
//
// `recommendedModuleKeys` holds GRANULAR menu-permission keys (matching
// MENU_ITEMS in lib/menuItems.ts) — those keys get OR'd straight into
// the new company's menuPermissions on the server, AND we also derive
// the parent billable modules from them here on the client so the
// pricing display stays accurate.
type LiveIndustry = {
  code:                  string;
  nameAr:                string;
  nameEn:                string;
  emoji:                 string;
  recommendedModuleKeys: string[];
  sortOrder:             number;
};

// Convert the static fallback (which uses `recommendedModules`) into the
// live shape so downstream code can treat both identically.
const INDUSTRIES_FALLBACK_LIVE: LiveIndustry[] = INDUSTRIES_FALLBACK.map((i, idx) => ({
  code:                  i.code,
  nameAr:                i.nameAr,
  nameEn:                i.nameEn,
  emoji:                 i.emoji,
  recommendedModuleKeys: i.recommendedModules,
  sortOrder:             (idx + 1) * 10,
}));

// ── Plan card UI shape ────────────────────────────────────────────────
// Each plan rendered in Step 2 has a stable structural shape (id, name,
// monthly/annual price, feature bullet-list, recommended flag) plus a
// visual style (icon + colour palette). The structural fields come from
// the SuperAdmin-managed `plan_configs` table at runtime; the visual
// style is mapped per-key from STYLE_BY_KEY below so any plans the
// SuperAdmin adds in PlanSettings show up here without a code change
// (unknown keys fall back to the neutral "default" palette).
type PlanCard = {
  id: string;
  icon: React.ReactNode;
  name: string;
  nameEn: string;
  color: string;
  activeColor: string;
  badgeColor: string;
  monthly: number;
  annual: number;
  maxUsers: number;
  maxInvoices: number;
  // How many of the user's selected modules are included free under
  // this plan tier — sourced from `plan_configs.included_modules_count`.
  includedModulesCount: number;
  features: string[];
  recommended?: boolean;
};

// One module row as returned from /api/admin/modules/public — derived from
// the `modules` table (SuperAdmin-managed in /admin/modules).
type LiveModule = {
  key:          string;
  nameAr:       string;
  nameEn:       string;
  description:  string;
  monthlyPrice: string;        // text in DB; parsed to Number for math
  icon:         string;        // lucide icon name (display-only)
  iconColor:    string;
  category:     string;        // free-text Arabic label, used as section header
  sortOrder:    number;
};

const STYLE_BY_KEY: Record<string, Pick<PlanCard, "icon" | "color" | "activeColor" | "badgeColor">> = {
  starter: {
    icon: <Package className="h-6 w-6" />,
    color: "border-blue-200 bg-blue-50",
    activeColor: "border-blue-500 ring-2 ring-blue-200",
    badgeColor: "bg-blue-100 text-blue-700",
  },
  professional: {
    icon: <Star className="h-6 w-6" />,
    color: "border-primary/30 bg-primary/5",
    activeColor: "border-primary ring-2 ring-primary/20",
    badgeColor: "bg-primary/10 text-primary",
  },
  enterprise: {
    icon: <Crown className="h-6 w-6" />,
    color: "border-amber-200 bg-amber-50",
    activeColor: "border-amber-500 ring-2 ring-amber-200",
    badgeColor: "bg-amber-100 text-amber-700",
  },
  custom: {
    icon: <Sparkles className="h-6 w-6" />,
    color: "border-purple-200 bg-purple-50",
    activeColor: "border-purple-500 ring-2 ring-purple-200",
    badgeColor: "bg-purple-100 text-purple-700",
  },
};
const DEFAULT_STYLE: Pick<PlanCard, "icon" | "color" | "activeColor" | "badgeColor"> = {
  icon: <Package className="h-6 w-6" />,
  color: "border-slate-200 bg-slate-50",
  activeColor: "border-slate-500 ring-2 ring-slate-200",
  badgeColor: "bg-slate-100 text-slate-700",
};

// Static fallback used only if the /api/admin/plans fetch fails. Mirrors
// the legacy hardcoded catalog so first-paint never shows an empty form
// on a transient network error.
const FALLBACK_PLANS: PlanCard[] = [
  { id: "starter", ...STYLE_BY_KEY.starter, name: "مبتدئ", nameEn: "Starter",
    monthly: 99, annual: 990, maxUsers: 1, maxInvoices: 50, includedModulesCount: 2,
    features: ["مستخدم واحد", "50 فاتورة شهرياً", "فواتير ضريبية ومبسطة", "دعم بريد إلكتروني"] },
  { id: "professional", ...STYLE_BY_KEY.professional, name: "احترافي", nameEn: "Professional",
    monthly: 299, annual: 2990, maxUsers: 5, maxInvoices: 500, includedModulesCount: 5,
    features: ["5 مستخدمين", "500 فاتورة شهرياً", "تقارير متقدمة", "API مفتوح", "دعم أولوية"],
    recommended: true },
  { id: "enterprise", ...STYLE_BY_KEY.enterprise, name: "مؤسسي", nameEn: "Enterprise",
    monthly: 899, annual: 8990, maxUsers: 999, maxInvoices: 999999, includedModulesCount: 100,
    features: ["مستخدمون غير محدودين", "فواتير غير محدودة", "تقارير مخصصة", "SLA 99.9%", "مدير حساب مخصص"] },
];

const STEPS = [
  { id: "company",  label: "بيانات الشركة", icon: <Building2 className="h-4 w-4" /> },
  { id: "plan",     label: "الباقة",         icon: <Package className="h-4 w-4" /> },
  { id: "user",     label: "حساب الإدارة",   icon: <User className="h-4 w-4" /> },
  { id: "confirm",  label: "تأكيد",          icon: <Check className="h-4 w-4" /> },
];

export default function Register() {
  const [, setLocation] = useLocation();
  const { register } = useAuth();
  const { toast } = useToast();
  // Pre-selected plan + billing cycle from the public /pricing page CTA.
  // The /pricing → /register hand-off uses ?plan=KEY&cycle=monthly|annual
  // so users land directly inside the wizard with their choice already
  // applied. Read once at mount to avoid re-running on every URL change.
  const initialQuery = useMemo(() => {
    if (typeof window === "undefined") return { plan: null as string | null, cycle: null as "monthly" | "annual" | null };
    const sp = new URLSearchParams(window.location.search);
    const p = sp.get("plan");
    const c = sp.get("cycle");
    return {
      plan:  p && p.length < 50 ? p : null,
      cycle: c === "annual" ? "annual" as const : c === "monthly" ? "monthly" as const : null,
    };
  }, []);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPass, setShowPass] = useState(false);
  // Success view state. After a SELF-registration succeeds the server
  // returns `pending: true` plus the auto-generated companyCode that the
  // tenant will need to log in once the SuperAdmin approves them. We
  // surface that code on a dedicated success card with a copy button so
  // the user is much less likely to lose it. The previous flow redirected
  // straight to /pending-approval, which never showed the code anywhere.
  const [successCode, setSuccessCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">(
    initialQuery.cycle ?? "monthly",
  );
  // Country/policy acceptance gate. Defaults to Saudi Arabia, the default
  // country for the platform. The acceptance flag blocks the final submit
  // in Step 3 — it is reset to false whenever the country changes so users
  // can't accept policy A and silently submit under country B.
  const [acceptedPolicy, setAcceptedPolicy] = useState(false);

  // ── Industry + module selection state (Step 1 rework) ───────────────
  // Multi-select industry chips. Picking one or more pre-selects each
  // industry's recommended modules (UNION); the user can then add/remove
  // individual modules. Empty = no recommendations applied yet.
  const [selectedIndustries, setSelectedIndustries] = useState<string[]>([]);
  // Per-module checkbox state — keys from the live /api/admin/modules/public
  // catalog (sourced from the SuperAdmin-managed `modules` table).
  const [selectedModules, setSelectedModules] = useState<string[]>([]);
  // Escape hatch: when the user has picked an industry we hide irrelevant
  // modules by default (per spec — registration should only surface what
  // belongs to that activity). This toggle lets a power-user override the
  // filter and see the full system catalog if they need to add an
  // unrelated module manually.
  const [showAllModules, setShowAllModules] = useState(false);

  const [form, setForm] = useState<Partial<RegisterData>>(() => {
    const cycle = initialQuery.cycle ?? "monthly";
    const days  = cycle === "annual" ? 365 : 30;
    return {
      country: DEFAULT_COUNTRY_CODE,
      currency: getCountryByCode(DEFAULT_COUNTRY_CODE).currency.code,
      invoiceType: "both",
      // If /pricing pre-selected a plan, honour it; otherwise fall back
      // to the legacy default so the wizard keeps working when entered
      // directly without query string.
      plan: initialQuery.plan ?? "professional",
      billingCycle: cycle,
      startDate: new Date().toISOString().split("T")[0],
      endDate: new Date(Date.now() + days * 86400000).toISOString().split("T")[0],
    };
  });

  // ── Live plan + module catalogs (sourced from SuperAdmin tables) ─────
  // /api/admin/plans and /api/admin/modules/public are both intentionally
  // public-readable so the sign-up wizard can show exactly what's active
  // in /admin/plans and /admin/modules. Cached for 30s — short enough that
  // a SuperAdmin edit shows up almost immediately on the next page open,
  // long enough that a stuck/slow user doesn't refetch on every keystroke.
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const plansQ = useQuery<PlanCard[]>({
    queryKey: ["public-plans"],
    staleTime: 30 * 1000,
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/admin/plans`);
      if (!r.ok) throw new Error("plans fetch failed");
      const rows = await r.json() as Array<{
        key: string; nameAr: string; nameEn: string;
        monthlyPrice: string; annualPrice: string;
        maxUsers: number; maxInvoices: number;
        includedModulesCount?: number;
        features: string[] | string;
        isRecommended: boolean; isActive: boolean; sortOrder: number;
      }>;
      return rows
        .filter(p => p.isActive)
        .map<PlanCard>(p => {
          const style = STYLE_BY_KEY[p.key] ?? DEFAULT_STYLE;
          // Server returns features pre-parsed (admin.ts JSON.parses it),
          // but defensively handle the legacy string form too.
          const featureList = Array.isArray(p.features)
            ? p.features
            : (() => { try { return JSON.parse(p.features ?? "[]"); } catch { return []; } })();
          return {
            id: p.key,
            ...style,
            name: p.nameAr,
            nameEn: p.nameEn,
            monthly: Number(p.monthlyPrice) || 0,
            annual: Number(p.annualPrice) || 0,
            maxUsers: p.maxUsers,
            maxInvoices: p.maxInvoices,
            includedModulesCount: Number(p.includedModulesCount ?? 0),
            features: featureList,
            recommended: p.isRecommended,
          };
        });
    },
  });
  // Fall back to the hardcoded catalog *only* on a hard fetch error so a
  // legitimately empty `plan_configs` table is shown as such (and not
  // silently masked by stale defaults). When the live request resolves
  // with zero active plans we render an explicit empty state below.
  const PLANS: PlanCard[] = plansQ.isError
    ? FALLBACK_PLANS
    : (plansQ.data ?? []);
  const plansLoading = plansQ.isLoading;
  const plansEmpty   = !plansLoading && !plansQ.isError && PLANS.length === 0;

  // Live system-module catalog (from /admin/modules). Active rows only.
  // We keep the public endpoint sorted server-side so categories render in
  // the same order an operator would see them in /admin/modules.
  const modulesQ = useQuery<LiveModule[]>({
    queryKey: ["public-modules"],
    staleTime: 30 * 1000,
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/admin/modules/public`);
      if (!r.ok) throw new Error("modules fetch failed");
      return r.json();
    },
  });
  // On a hard fetch error fall back to an empty catalog so the picker
  // section renders an empty/dim state — better than crashing the wizard
  // mid-registration. plansEmpty already handles the "no plans" case.
  const MODULES: LiveModule[] = modulesQ.data ?? [];
  // Group modules by category in their server-supplied order. Using a Map
  // (insertion-ordered) preserves the SuperAdmin's intended grouping
  // without needing a separate hardcoded category whitelist.
  const MODULE_GROUPS: Array<{ name: string; mods: LiveModule[] }> = useMemo(() => {
    const map = new Map<string, LiveModule[]>();
    for (const m of MODULES) {
      const cat = (m.category || "أخرى").trim();
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(m);
    }
    return Array.from(map.entries()).map(([name, mods]) => ({ name, mods }));
  }, [MODULES]);
  // Quick lookup by key for the price-summary + confirm step.
  const MODULE_BY_KEY: Record<string, LiveModule> = useMemo(
    () => Object.fromEntries(MODULES.map(m => [m.key, m])),
    [MODULES],
  );

  // Live industry catalog (from /admin/industries). On a hard fetch error
  // we fall back to the bundled static list so the wizard's chip strip
  // never renders empty. Active rows only — the public endpoint already
  // filters out `isActive=false` rows, so a SuperAdmin can hide an
  // activity type without deleting it.
  const industriesQ = useQuery<LiveIndustry[]>({
    queryKey: ["public-industries"],
    staleTime: 30 * 1000,
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/admin/industries/public`);
      if (!r.ok) throw new Error("industries fetch failed");
      return r.json();
    },
  });
  const INDUSTRIES_LIVE: LiveIndustry[] = (industriesQ.data && industriesQ.data.length > 0)
    ? industriesQ.data
    : INDUSTRIES_FALLBACK_LIVE;

  // Helper: collect the granular menu-permission keys recommended by the
  // given industry codes against the live catalog (or fallback). Deduped.
  const unionMenuKeysLive = (industryCodes: string[]): string[] => {
    const set = new Set<string>();
    for (const code of industryCodes) {
      const ind = INDUSTRIES_LIVE.find(i => i.code === code);
      if (ind) for (const k of ind.recommendedModuleKeys) set.add(k);
    }
    return Array.from(set);
  };

  // Helper: derive the high-level BILLABLE module keys (matching the
  // /admin/modules catalog) implied by the granular menu-permission keys
  // attached to the given industries. This is what gets folded into
  // `selectedModules` so the pricing total + module-multiselect UI stay
  // in sync. Permissions whose parent module is `null` (always-on core
  // like dashboard/invoices/customers, or SuperAdmin-only seo/ai_tools)
  // contribute nothing here — they're free.
  const unionBillableModulesLive = (industryCodes: string[]): string[] =>
    deriveModulesFromMenuKeys(unionMenuKeysLive(industryCodes));

  // Industry-scoped module visibility (per spec):
  //   • No industry picked  → show every active module (no signal to filter on yet)
  //   • Industry picked     → show only modules whose key is in the union of
  //                            recommended billable modules across the picked
  //                            industries — this is what the user actually
  //                            "belongs to" given their activity selection.
  // The `showAllModules` toggle bypasses the filter so the user can still
  // add a module that isn't part of their industry recommendation set
  // (e.g., a hotel adding "online_store"). Already-selected modules are
  // ALWAYS shown so toggling industries off can never silently hide a
  // module the user has paid for. Computed against the live catalog so
  // SuperAdmin edits in /admin/industries take effect immediately.
  const allowedModuleKeys: Set<string> = useMemo(() => {
    if (selectedIndustries.length === 0) return new Set(MODULES.map(m => m.key));
    return new Set(unionBillableModulesLive(selectedIndustries));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndustries, INDUSTRIES_LIVE, MODULES]);

  const VISIBLE_MODULE_GROUPS = useMemo(() => {
    if (showAllModules || selectedIndustries.length === 0) return MODULE_GROUPS;
    return MODULE_GROUPS
      .map(g => ({
        name: g.name,
        mods: g.mods.filter(m => allowedModuleKeys.has(m.key) || selectedModules.includes(m.key)),
      }))
      .filter(g => g.mods.length > 0);
  }, [MODULE_GROUPS, allowedModuleKeys, selectedIndustries.length, showAllModules, selectedModules]);

  // Total count of modules currently visible in the picker — used in the
  // "محددة X من Y" badge so the denominator reflects what the user can
  // actually see, not the full system catalog when industry-filtered.
  const visibleModulesCount = useMemo(
    () => VISIBLE_MODULE_GROUPS.reduce((acc, g) => acc + g.mods.length, 0),
    [VISIBLE_MODULE_GROUPS],
  );
  const isFiltered = selectedIndustries.length > 0 && !showAllModules;
  // Count of modules that *would* be hidden by the industry filter,
  // independent of whether the user has currently toggled `showAllModules`
  // on. We need this so the "show industry-only" / "show all" toggle stays
  // visible even after the user expands to the full catalog — otherwise
  // the button disappears the moment it's pressed and there's no way back.
  const wouldHideCount = useMemo(() => {
    if (selectedIndustries.length === 0) return 0;
    let visibleIfFiltered = 0;
    for (const m of MODULES) {
      if (allowedModuleKeys.has(m.key) || selectedModules.includes(m.key)) visibleIfFiltered++;
    }
    return Math.max(0, MODULES.length - visibleIfFiltered);
  }, [selectedIndustries.length, MODULES, allowedModuleKeys, selectedModules]);
  // Reset to filtered view whenever the user clears all industries — keeps
  // the default "industry-only" behavior consistent across cycles of
  // adding / removing industry chips.
  useEffect(() => {
    if (selectedIndustries.length === 0 && showAllModules) setShowAllModules(false);
  }, [selectedIndustries.length, showAllModules]);

  // Prune any selected module keys that are no longer in the live catalog.
  // This handles the case where an industry template auto-added a key
  // (via unionRecommendedModulesLive above) that has since been deactivated
  // by SuperAdmin in /admin/modules. Without this prune the count "محددة X
  // من Y" would be wrong, the price summary would silently drop the row, and
  // the server would refuse to grant permissions for it anyway. Skip while
  // the catalog is still loading or empty so we never wipe valid picks.
  useEffect(() => {
    if (!modulesQ.isSuccess || MODULES.length === 0) return;
    setSelectedModules(curr => {
      const filtered = curr.filter(k => k in MODULE_BY_KEY);
      return filtered.length === curr.length ? curr : filtered;
    });
  }, [modulesQ.isSuccess, MODULES.length, MODULE_BY_KEY]);

  const set = (k: keyof RegisterData, v: string) => setForm(f => ({ ...f, [k]: v }));

  // Toggle industry chip. Module behaviour is intentionally ADDITIVE so
  // any manual module edits the user has already made are NEVER lost:
  //  - Activating an industry  → ADDS its recommended modules (union)
  //  - Deactivating an industry → leaves modules untouched (user can
  //    deselect manually). Avoids the surprise of recommendations being
  //    silently revoked.
  const toggleIndustry = (code: string) => {
    setSelectedIndustries(prev => {
      const isActivating = !prev.includes(code);
      const next = isActivating ? [...prev, code] : prev.filter(c => c !== code);
      if (isActivating) {
        // Merge the BILLABLE parent modules for the newly-activated
        // industry into the selection so the price summary updates and
        // the user can see what they're being charged for. The granular
        // menu permissions themselves are auto-granted server-side from
        // the industry codes — no need to ship them in selectedModules.
        setSelectedModules(curr => Array.from(
          new Set([...curr, ...unionBillableModulesLive([code])]),
        ));
      }
      return next;
    });
  };
  // "اختيار الكل" merges every industry's recommendations into the
  // current selection (additive). It never removes user picks.
  const selectAllIndustries = () => {
    const all = INDUSTRIES_LIVE.map(i => i.code);
    setSelectedIndustries(all);
    setSelectedModules(curr => Array.from(
      new Set([...curr, ...unionBillableModulesLive(all)]),
    ));
  };
  // "مسح" clears BOTH industries and modules. Explicit, predictable.
  const clearIndustries = () => {
    setSelectedIndustries([]);
    setSelectedModules([]);
  };
  const toggleModule = (key: string) => {
    setSelectedModules(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key],
    );
  };

  // Country selection: cascades the country code AND the matching default
  // currency, and revokes any prior policy acceptance so the user has to
  // re-confirm the new country's compliance line.
  const selectedCountry = getCountryByCode(form.country);
  const policyText      = getCountryPolicy(form.country, "ar");
  const handleCountryChange = (code: string) => {
    const c = getCountryByCode(code);
    setForm(f => ({ ...f, country: c.code, currency: c.currency.code }));
    setAcceptedPolicy(false);
  };

  // Selected plan, with two fallbacks: the recommended plan, or the first
  // available plan. Guards against the user landing here before plansQ
  // resolves (PLANS is FALLBACK_PLANS in that window) AND against the
  // SuperAdmin renaming/disabling whatever was previously selected.
  const selectedPlan =
    PLANS.find(p => p.id === form.plan)
    ?? PLANS.find(p => p.recommended)
    ?? PLANS[0]
    ?? FALLBACK_PLANS[1];

  // Live price breakdown (memoized) — recomputed only when the plan, the
  // module selection, or the live module catalog change.
  //
  // Pricing model (mirrors api-server/src/routes/auth.ts so the client
  // and server agree on the final price):
  //   monthlyTotal = plan.monthly + sum(selected module prices)
  //                                - sum(cheapest `includedModulesCount` prices)
  //   annualTotal  = plan.annual  + (extraSubtotal × 10)
  //
  // Note: the annual base (`plan.annual`) is taken straight from the
  // plan_configs row, NOT computed as monthly × 10. This lets a SuperAdmin
  // configure a custom annual price (e.g. promo) and have it flow through
  // both the displayed total and the price submitted to /register.
  // Unknown / inactive module keys are ignored — a module deactivated in
  // /admin/modules between picker render and submit just falls out.
  const priceCalc = useMemo(() => {
    const base       = selectedPlan.monthly;
    const annualBase = selectedPlan.annual;
    const included   = selectedPlan.includedModulesCount;
    const prices     = selectedModules
      .map(k => MODULE_BY_KEY[k])
      .filter((m): m is LiveModule => !!m)
      .map(m => Number(m.monthlyPrice))
      .filter(n => Number.isFinite(n) && n >= 0)
      .sort((a, b) => a - b);
    const freeCount     = Math.min(included, prices.length);
    const freeAmount    = prices.slice(0, freeCount).reduce((s, p) => s + p, 0);
    const grossTotal    = prices.reduce((s, p) => s + p, 0);
    const extraSubtotal = grossTotal - freeAmount;
    return {
      base,
      selectedCount: prices.length,
      includedFree:  freeCount,
      extraCount:    prices.length - freeCount,
      extraSubtotal,
      total:         base + extraSubtotal,
      annualTotal:   annualBase + extraSubtotal * 10,
    };
  }, [selectedPlan.monthly, selectedPlan.annual, selectedPlan.includedModulesCount, selectedModules, MODULE_BY_KEY]);

  const selectPlan = (planId: string) => {
    const plan = PLANS.find(p => p.id === planId)!;
    const price = billingCycle === "annual" ? plan.annual : plan.monthly;
    const endDate = billingCycle === "annual"
      ? new Date(Date.now() + 365 * 86400000).toISOString().split("T")[0]
      : new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
    setForm(f => ({ ...f, plan: planId, billingCycle, price: String(price), endDate }));
  };

  const toggleBilling = (cycle: "monthly" | "annual") => {
    setBillingCycle(cycle);
    const endDate = cycle === "annual"
      ? new Date(Date.now() + 365 * 86400000).toISOString().split("T")[0]
      : new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
    setForm(f => ({ ...f, billingCycle: cycle, endDate }));
  };

  const handleSubmit = async () => {
    setError("");
    setLoading(true);
    try {
      const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          billingCycle,
          // New: industry classification + per-module selection from Step 1.
          selectedIndustries,
          selectedModules,
          // Send the dynamically-computed price (base + module add-ons) so
          // the subscription record matches what the user actually saw.
          price: String(billingCycle === "annual" ? priceCalc.annualTotal : priceCalc.total),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "حدث خطأ");

      if (data.pending) {
        // Self-registration: show the success card with the auto-generated
        // companyCode BEFORE redirecting. The code is the only way the
        // tenant will be able to log in once SuperAdmin approves them, so
        // we make the user explicitly acknowledge it. Falls back to the
        // legacy redirect if the server somehow didn't include a code
        // (defensive: keeps registration usable during partial deploys).
        if (typeof data.companyCode === "string" && data.companyCode.length > 0) {
          setSuccessCode(data.companyCode);
        } else {
          setLocation("/pending-approval");
        }
      } else if (data.token) {
        // Admin-created: auto-login
        await register(form as RegisterData);
        setLocation("/");
      } else {
        setLocation("/pending-approval");
      }
    } catch (err: any) {
      setError(err.message ?? "حدث خطأ. حاول مرة أخرى.");
    } finally {
      setLoading(false);
    }
  };

  // ── Success view (post-registration) ───────────────────────────────
  // Shown only after a self-registration succeeds. Displays the
  // freshly-generated companyCode prominently with a copy button so the
  // user is forced to acknowledge it before moving on. Without this
  // code, they would not be able to log in once SuperAdmin approves
  // them — usernames are no longer globally unique, so login needs
  // (companyCode, username, password).
  if (successCode) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-muted flex items-center justify-center p-4" dir="rtl">
        <div className="w-full max-w-xl">
          <Card className="shadow-xl border-primary/30">
            <CardContent className="pt-8 pb-6 space-y-5 text-center">
              <div className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                <Check className="h-7 w-7" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-foreground">تم استلام طلب التسجيل</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  سيتم مراجعة الحساب من قِبل الإدارة. ستتمكن من تسجيل الدخول بعد الموافقة.
                </p>
              </div>

              {/* The kingpin: company code + copy. */}
              <div className="rounded-xl border-2 border-primary bg-primary/5 p-5 space-y-3">
                <div className="text-xs font-medium text-muted-foreground">
                  كود شركتك (لتسجيل الدخول)
                </div>
                <div
                  className="text-3xl font-bold font-mono tracking-widest text-primary select-all"
                  dir="ltr"
                  data-testid="register-success-company-code"
                >
                  {successCode}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(successCode);
                      setCodeCopied(true);
                      toast({ title: "تم نسخ الكود" });
                      setTimeout(() => setCodeCopied(false), 2000);
                    } catch {
                      toast({ title: "تعذر النسخ، انسخه يدوياً", variant: "destructive" as any });
                    }
                  }}
                  data-testid="register-success-copy-code"
                >
                  {codeCopied ? <Check className="h-4 w-4" /> : null}
                  {codeCopied ? "تم النسخ" : "نسخ الكود"}
                </Button>
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2 mt-2">
                  احتفظ بهذا الكود في مكان آمن — ستحتاجه مع اسم المستخدم وكلمة المرور في كل مرة تُسجّل فيها الدخول.
                </p>
              </div>

              <Button
                className="w-full gap-2"
                onClick={() => setLocation("/pending-approval")}
                data-testid="register-success-continue"
              >
                <ChevronLeft className="h-4 w-4" />
                المتابعة
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-muted flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-2xl">

        {/* Logo */}
        <div className="text-center mb-6">
          <img
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt="زاكود Zacode"
            width={48}
            height={48}
            className="inline-block h-12 w-12 rounded-xl mb-3 shadow-lg"
            data-testid="register-brand-mark"
          />
          <h1 className="text-2xl font-bold text-foreground">إنشاء حساب جديد</h1>
          <p className="text-muted-foreground mt-1 text-sm">سجّل شركتك وابدأ إصدار فواتير متوافقة مع ZATCA</p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center mb-6 gap-0">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex items-center">
              <button
                onClick={() => i < step && setStep(i)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all",
                  i === step ? "bg-primary text-primary-foreground shadow" :
                  i < step  ? "bg-primary/20 text-primary cursor-pointer hover:bg-primary/30" :
                              "bg-muted text-muted-foreground"
                )}>
                {i < step ? <Check className="h-3 w-3" /> : s.icon}
                {s.label}
              </button>
              {i < STEPS.length - 1 && <div className={cn("h-px w-6 mx-1", i < step ? "bg-primary" : "bg-border")} />}
            </div>
          ))}
        </div>

        <Card className="shadow-xl">
          <CardContent className="pt-6">

            {/* ─── Step 0: Company ─── */}
            {step === 0 && (
              <div className="space-y-5">
                <h3 className="font-semibold text-foreground flex items-center gap-2"><Building2 className="h-4 w-4" />بيانات الشركة</h3>

                {/* Country + currency. Country drives the displayed
                    compliance policy and seeds the company's default
                    currency on the backend. */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium flex items-center gap-1.5">
                      <Globe2 className="h-4 w-4 text-muted-foreground" />الدولة <span className="text-destructive">*</span>
                    </label>
                    <select
                      value={form.country ?? DEFAULT_COUNTRY_CODE}
                      onChange={e => handleCountryChange(e.target.value)}
                      className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {COUNTRIES.map(c => (
                        <option key={c.code} value={c.code}>{c.nameAr}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">العملة الافتراضية</label>
                    <Input
                      value={`${selectedCountry.currency.nameAr} (${selectedCountry.currency.code}) ${selectedCountry.currency.symbol}`}
                      readOnly
                      className="bg-muted/30 cursor-not-allowed"
                    />
                    <p className="text-xs text-muted-foreground">يتم تعيينها تلقائياً حسب الدولة، يمكنك تعديلها لاحقاً من إعدادات العملات</p>
                  </div>
                </div>

                {/* Country-specific compliance policy preview */}
                <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 text-sm">
                  <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
                  <div className="space-y-0.5">
                    <div className="font-medium">سياسة التسجيل في {selectedCountry.nameAr}</div>
                    <div className="text-xs opacity-90">{policyText}</div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="sm:col-span-2 space-y-1.5">
                    <label className="text-sm font-medium">اسم الشركة (عربي) <span className="text-destructive">*</span></label>
                    <Input value={form.nameAr ?? ""} onChange={e => set("nameAr", e.target.value)} placeholder="شركة النجاح للتجارة" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">اسم الشركة (إنجليزي)</label>
                    <Input value={form.nameEn ?? ""} onChange={e => set("nameEn", e.target.value)} placeholder="AlNajah Trading Co." dir="ltr" className="text-left" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">الرقم الضريبي (VAT) <span className="text-destructive">*</span></label>
                    <Input value={form.vatNumber ?? ""} onChange={e => set("vatNumber", e.target.value)} placeholder="310000000000003" dir="ltr" className="text-left font-mono" maxLength={15} />
                    <p className="text-xs text-muted-foreground">15 رقماً — يبدأ بـ 3</p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">رقم السجل التجاري <span className="text-destructive">*</span></label>
                    <Input value={form.crNumber ?? ""} onChange={e => set("crNumber", e.target.value)} placeholder="1010000001" dir="ltr" className="text-left font-mono" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">المدينة</label>
                    <Input value={form.city ?? ""} onChange={e => set("city", e.target.value)} placeholder="الرياض" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">اسم الشارع</label>
                    <Input value={form.street ?? ""} onChange={e => set("street", e.target.value)} placeholder="شارع الأمير محمد" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">رقم المبنى</label>
                    <Input value={form.buildingNumber ?? ""} onChange={e => set("buildingNumber", e.target.value)} placeholder="1234" dir="ltr" className="text-left" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">الرمز البريدي</label>
                    <Input value={form.postalCode ?? ""} onChange={e => set("postalCode", e.target.value)} placeholder="12345" dir="ltr" className="text-left" maxLength={5} />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">رقم الهاتف</label>
                    <Input value={form.phone ?? ""} onChange={e => set("phone", e.target.value)} placeholder="0501234567" dir="ltr" className="text-left" maxLength={30} />
                  </div>
                </div>
                <div className="flex justify-end pt-2">
                  <Button onClick={() => {
                    if (!form.nameAr || !form.vatNumber || !form.crNumber) { setError("اسم الشركة والرقم الضريبي والسجل التجاري مطلوبة"); return; }
                    setError(""); setStep(1);
                  }} className="gap-2">
                    التالي <ChevronLeft className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* ─── Step 1: Industry + Plan + Modules ─── */}
            {step === 1 && (
              <div className="space-y-5">
                <h3 className="font-semibold text-foreground flex items-center gap-2">
                  <Package className="h-4 w-4" />اختر نشاطك ووحدات نظامك
                </h3>

                {/* ── 1. Industry multi-select chips ── */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <label className="text-sm font-medium flex items-center gap-1.5">
                      <Sparkles className="h-4 w-4 text-primary" />
                      نوع نشاط الشركة
                      <span className="text-xs font-normal text-muted-foreground">(اختر واحد أو أكثر)</span>
                    </label>
                    <div className="flex gap-3 text-xs">
                      <button type="button" onClick={selectAllIndustries}
                        className="text-primary hover:underline" data-testid="industry-select-all">
                        اختيار الكل
                      </button>
                      {selectedIndustries.length > 0 && (
                        <button type="button" onClick={clearIndustries}
                          className="text-muted-foreground hover:text-destructive" data-testid="industry-clear">
                          مسح
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {INDUSTRIES_LIVE.map(ind => {
                      const active = selectedIndustries.includes(ind.code);
                      return (
                        <button key={ind.code} type="button"
                          data-testid={`industry-chip-${ind.code}`}
                          onClick={() => toggleIndustry(ind.code)}
                          className={cn(
                            "flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 text-sm transition-all",
                            active
                              ? "border-primary bg-primary/10 text-primary font-medium shadow-sm"
                              : "border-border bg-card text-muted-foreground hover:border-primary/40"
                          )}>
                          <span className="text-base leading-none">{ind.emoji}</span>
                          {ind.nameAr}
                          {active && <Check className="h-3.5 w-3.5" />}
                        </button>
                      );
                    })}
                  </div>
                  {selectedIndustries.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      اختر نشاطاً واحداً أو أكثر لاقتراح الوحدات المناسبة تلقائياً، أو حدّد الوحدات يدوياً أسفله.
                    </p>
                  )}

                  {/* ── Live "what you'll get" panel ──
                      Shown the instant the user picks any industry, so they
                      can see exactly which sidebar items will appear after
                      registration AND which billable parent modules were
                      auto-added to their plan. Both lists are computed
                      purely on the client from INDUSTRIES_LIVE / MENU_ITEMS,
                      so the view always mirrors what the server will grant
                      (auth.ts performs the same OR-merge by industry code).
                      Keeping it inline (rather than only on the final review
                      step) is the whole point of the industry → permissions
                      link: the user must see the consequence of each chip
                      click immediately. */}
                  {selectedIndustries.length > 0 && (() => {
                    const grantedKeys = unionMenuKeysLive(selectedIndustries);
                    const billableMods = unionBillableModulesLive(selectedIndustries);
                    if (grantedKeys.length === 0) return null;
                    const labels = grantedKeys.map(k => MENU_ITEM_BY_KEY[k]?.label ?? k);
                    const moduleNames = billableMods.map(k => MODULE_BY_KEY[k]?.nameAr ?? k);
                    return (
                      <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 space-y-2 text-xs">
                        <div className="flex items-start gap-2">
                          <Check className="h-4 w-4 text-emerald-600 mt-0.5 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-emerald-800 mb-1">
                              صلاحيات القوائم المُفعَّلة تلقائياً ({grantedKeys.length})
                            </div>
                            <div
                              className="text-emerald-700 leading-relaxed"
                              data-testid="reg-summary-menu-perms"
                            >
                              {labels.join("، ")}
                            </div>
                          </div>
                        </div>
                        {moduleNames.length > 0 && (
                          <div className="flex items-start gap-2 pt-2 border-t border-emerald-200">
                            <Check className="h-4 w-4 text-emerald-600 mt-0.5 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold text-emerald-800 mb-1">
                                الوحدات المُضافة تلقائياً ({moduleNames.length})
                              </div>
                              <div
                                className="text-emerald-700 leading-relaxed"
                                data-testid="reg-summary-billable-modules"
                              >
                                {moduleNames.join("، ")}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* ── 2. Billing cycle ── */}
                <div className="flex items-center justify-center gap-3 pt-3 border-t">
                  <button onClick={() => toggleBilling("monthly")} type="button"
                    className={cn("px-4 py-1.5 rounded-full text-sm font-medium transition-all",
                      billingCycle === "monthly" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                    شهري
                  </button>
                  <button onClick={() => toggleBilling("annual")} type="button"
                    className={cn("px-4 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-1",
                      billingCycle === "annual" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                    سنوي
                    <span className="text-xs bg-green-100 text-green-700 rounded-full px-1.5 py-0.5">وفّر ~17%</span>
                  </button>
                </div>

                {/* ── 3. Plan tier picker (compact, with "X included free" tag) ── */}
                {plansLoading ? (
                  // Loading skeleton — three placeholder cards while live
                  // plans are being fetched from /api/admin/plans.
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="plans-loading">
                    {[0, 1, 2].map(i => (
                      <div key={i} className="rounded-xl border-2 border-border bg-card p-3 animate-pulse">
                        <div className="flex items-center gap-2 mb-2">
                          <div className="h-7 w-7 rounded-lg bg-muted" />
                          <div className="h-4 w-20 rounded bg-muted" />
                        </div>
                        <div className="h-6 w-24 rounded bg-muted mt-1" />
                        <div className="h-3 w-28 rounded bg-muted mt-2" />
                      </div>
                    ))}
                  </div>
                ) : plansEmpty ? (
                  // Live API responded with zero active plans — surface
                  // explicitly instead of silently masking with defaults.
                  <div
                    data-testid="plans-empty"
                    className="rounded-xl border-2 border-dashed border-amber-300 bg-amber-50 p-4 text-center text-sm text-amber-800"
                  >
                    لا توجد باقات اشتراك متاحة حالياً. يرجى المحاولة لاحقاً أو التواصل مع الدعم.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {PLANS.map(plan => {
                      const price = billingCycle === "annual" ? plan.annual : plan.monthly;
                      const isSelected = form.plan === plan.id;
                      const included = plan.includedModulesCount;
                      const includedLabel = included >= MODULES.length && MODULES.length > 0
                        ? "كل الوحدات مجاناً"
                        : `${included} وحدات مشمولة`;
                      return (
                        <button key={plan.id} type="button"
                          data-testid={`plan-${plan.id}`}
                          onClick={() => selectPlan(plan.id)}
                          className={cn(
                            "relative rounded-xl border-2 p-3 text-right transition-all hover:shadow-md",
                            isSelected ? plan.activeColor : "border-border bg-card hover:border-primary/40"
                          )}>
                          {plan.recommended && (
                            <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-[10px] bg-primary text-primary-foreground rounded-full px-2 py-0.5 whitespace-nowrap">
                              الأكثر شيوعاً
                            </span>
                          )}
                          <div className="flex items-center gap-2 mb-1">
                            <div className={cn("inline-flex p-1.5 rounded-lg", plan.badgeColor)}>{plan.icon}</div>
                            <span className="font-bold text-foreground text-sm">{plan.name}</span>
                          </div>
                          <div className="text-xl font-bold mt-0.5">
                            {price} <span className="text-[11px] font-normal text-muted-foreground">ر.س/{billingCycle === "annual" ? "سنة" : "شهر"}</span>
                          </div>
                          <div className="text-[11px] text-primary mt-1.5 font-medium">{includedLabel}</div>
                          {isSelected && <div className="absolute top-2 left-2"><Check className="h-3.5 w-3.5 text-primary" /></div>}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* ── 4. Module catalog (grouped by category) ── */}
                {/*
                  Sourced live from /api/admin/modules/public. Categories
                  and order come straight from the `modules` table — adding
                  a module in /admin/modules makes it appear here on the
                  next page-open without a code change.
                */}
                <div className="space-y-3 pt-3 border-t">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <h4 className="text-sm font-semibold flex items-center gap-2">
                      <Package className="h-4 w-4" />
                      وحدات النظام
                      <span className="text-xs font-normal text-muted-foreground">
                        (محددة {selectedModules.length} من {isFiltered ? visibleModulesCount : MODULES.length})
                      </span>
                    </h4>
                    {selectedIndustries.length > 0 && wouldHideCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowAllModules(s => !s)}
                        data-testid="toggle-show-all-modules"
                        className="text-xs text-primary hover:underline"
                      >
                        {showAllModules
                          ? `عرض وحدات النشاط فقط`
                          : `عرض كل الوحدات (${wouldHideCount} مخفية)`}
                      </button>
                    )}
                  </div>

                  {isFiltered && visibleModulesCount > 0 && (
                    <div
                      data-testid="industry-filter-hint"
                      className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] text-muted-foreground"
                    >
                      تُعرض فقط الوحدات الخاصة بالأنشطة المختارة. لإضافة وحدة خارج هذه الأنشطة استخدم زر «عرض كل الوحدات».
                    </div>
                  )}

                  {modulesQ.isLoading ? (
                    <div className="rounded-xl border border-dashed bg-muted/20 p-6 text-center text-xs text-muted-foreground">
                      جاري تحميل الوحدات...
                    </div>
                  ) : modulesQ.isError ? (
                    <div className="rounded-xl border-2 border-dashed border-amber-300 bg-amber-50 p-4 text-center text-xs text-amber-800">
                      تعذّر تحميل قائمة الوحدات. يمكنك المتابعة بدون اختيار وحدات إضافية.
                    </div>
                  ) : MODULES.length === 0 ? (
                    <div
                      data-testid="modules-empty"
                      className="rounded-xl border-2 border-dashed border-amber-300 bg-amber-50 p-4 text-center text-xs text-amber-800"
                    >
                      لا توجد وحدات إضافية متاحة حالياً.
                    </div>
                  ) : VISIBLE_MODULE_GROUPS.length === 0 ? (
                    <div
                      data-testid="modules-filtered-empty"
                      className="rounded-xl border-2 border-dashed border-amber-300 bg-amber-50 p-4 text-center text-xs text-amber-800"
                    >
                      لا توجد وحدات مرتبطة بالأنشطة المختارة. اضغط «عرض كل الوحدات» لاختيار وحدات إضافية.
                    </div>
                  ) : VISIBLE_MODULE_GROUPS.map(group => (
                    <div key={group.name} className="space-y-2">
                      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        {group.name}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {group.mods.map(m => {
                          const checked = selectedModules.includes(m.key);
                          return (
                            <label key={m.key}
                              data-testid={`module-${m.key}`}
                              className={cn(
                                "flex items-start gap-2 p-2.5 rounded-lg border-2 cursor-pointer transition-all hover:shadow-sm",
                                checked ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/40"
                              )}>
                              <input type="checkbox" checked={checked}
                                onChange={() => toggleModule(m.key)}
                                className="mt-0.5 h-4 w-4 accent-primary cursor-pointer" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-medium text-sm">
                                    {m.nameAr}
                                  </span>
                                  <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                                    +{Number(m.monthlyPrice).toLocaleString("en-US")} ر.س
                                  </span>
                                </div>
                                {m.description && (
                                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{m.description}</p>
                                )}
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                {/* ── 5. Live total / breakdown ── */}
                <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-4 space-y-2"
                     data-testid="price-summary">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">الباقة الأساسية ({selectedPlan.name}):</span>
                    <span className="font-medium">{priceCalc.base} ر.س/شهر</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">وحدات مجانية مشمولة بالباقة:</span>
                    <span className="font-medium text-green-700">{priceCalc.includedFree} وحدة</span>
                  </div>
                  {priceCalc.extraCount > 0 && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">
                        وحدات إضافية ({priceCalc.extraCount}):
                      </span>
                      <span className="font-medium">+{priceCalc.extraSubtotal} ر.س/شهر</span>
                    </div>
                  )}
                  <div className="border-t border-primary/20 pt-2 flex items-center justify-between">
                    <span className="font-bold text-foreground">الإجمالي:</span>
                    <span className="text-2xl font-bold text-primary" data-testid="price-total">
                      {billingCycle === "annual" ? priceCalc.annualTotal : priceCalc.total}
                      <span className="text-xs font-normal text-muted-foreground mr-1">
                        {" "}ر.س/{billingCycle === "annual" ? "سنة" : "شهر"}
                      </span>
                    </span>
                  </div>
                </div>

                {/* dates */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">تاريخ بدء الاشتراك</label>
                    <Input type="date" value={form.startDate ?? ""} onChange={e => set("startDate", e.target.value)} dir="ltr" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">تاريخ انتهاء الاشتراك</label>
                    <Input type="date" value={form.endDate ?? ""} onChange={e => set("endDate", e.target.value)} dir="ltr" />
                  </div>
                </div>

                <div className="flex justify-between pt-2">
                  <Button variant="ghost" onClick={() => setStep(0)} className="gap-2"><ChevronRight className="h-4 w-4" />رجوع</Button>
                  <Button onClick={() => { setError(""); setStep(2); }} className="gap-2" data-testid="step1-next">
                    التالي <ChevronLeft className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* ─── Step 2: Admin User ─── */}
            {step === 2 && (
              <div className="space-y-5">
                <h3 className="font-semibold text-foreground flex items-center gap-2"><User className="h-4 w-4" />حساب المدير</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">اسم المستخدم <span className="text-destructive">*</span></label>
                    <Input value={form.username ?? ""} onChange={e => set("username", e.target.value.toLowerCase())}
                      placeholder="admin_company" dir="ltr" className="text-left" autoComplete="off" />
                    <p className="text-xs text-muted-foreground">حروف صغيرة وأرقام فقط، بدون مسافات</p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">البريد الإلكتروني</label>
                    <Input value={form.email ?? ""} onChange={e => set("email", e.target.value)}
                      placeholder="admin@company.com" dir="ltr" className="text-left" type="email" />
                  </div>
                  <div className="sm:col-span-2 space-y-1.5">
                    <label className="text-sm font-medium">كلمة المرور <span className="text-destructive">*</span></label>
                    <div className="relative">
                      <Input
                        type={showPass ? "text" : "password"}
                        value={form.password ?? ""}
                        onChange={e => set("password", e.target.value)}
                        placeholder="8 أحرف على الأقل"
                        dir="ltr" className="text-left pl-10"
                        autoComplete="new-password"
                      />
                      <button type="button" onClick={() => setShowPass(!showPass)}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    {form.password && form.password.length < 8 && (
                      <p className="text-xs text-amber-600">كلمة المرور يجب أن تكون 8 أحرف على الأقل</p>
                    )}
                  </div>
                </div>
                <div className="flex justify-between pt-2">
                  <Button variant="ghost" onClick={() => setStep(1)} className="gap-2"><ChevronRight className="h-4 w-4" />رجوع</Button>
                  <Button onClick={() => {
                    if (!form.username || !form.password) { setError("اسم المستخدم وكلمة المرور مطلوبان"); return; }
                    if (form.password.length < 8) { setError("كلمة المرور يجب أن تكون 8 أحرف على الأقل"); return; }
                    setError(""); setStep(3);
                  }} className="gap-2">التالي <ChevronLeft className="h-4 w-4" /></Button>
                </div>
              </div>
            )}

            {/* ─── Step 3: Confirm ─── */}
            {step === 3 && (
              <div className="space-y-5">
                <h3 className="font-semibold text-foreground flex items-center gap-2"><Check className="h-4 w-4" />مراجعة وتأكيد</h3>
                <div className="rounded-xl border bg-muted/20 p-4 space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-muted-foreground">الشركة:</span><span className="font-medium">{form.nameAr}</span>
                    <span className="text-muted-foreground">الدولة:</span><span className="font-medium">{selectedCountry.nameAr}</span>
                    <span className="text-muted-foreground">العملة:</span><span className="font-medium">{selectedCountry.currency.nameAr} ({selectedCountry.currency.code})</span>
                    <span className="text-muted-foreground">الرقم الضريبي:</span><span className="font-mono text-xs">{form.vatNumber}</span>
                    <span className="text-muted-foreground">الباقة:</span>
                    <span className="font-medium">{selectedPlan.name} — {billingCycle === "annual" ? priceCalc.annualTotal : priceCalc.total} ر.س/{billingCycle === "annual" ? "سنة" : "شهر"}</span>
                    <span className="text-muted-foreground">المستخدمون:</span><span>{selectedPlan.maxUsers === 999 ? "غير محدود" : selectedPlan.maxUsers}</span>
                    <span className="text-muted-foreground">الفواتير الشهرية:</span><span>{selectedPlan.maxInvoices === 999999 ? "غير محدودة" : selectedPlan.maxInvoices}</span>
                    <span className="text-muted-foreground">نشاط الشركة:</span>
                    <span className="font-medium">
                      {selectedIndustries.length === 0
                        ? "—"
                        : selectedIndustries
                            .map(c => INDUSTRIES_LIVE.find(i => i.code === c)?.nameAr ?? c)
                            .join("، ")}
                    </span>
                    <span className="text-muted-foreground">الوحدات المختارة:</span>
                    <span className="font-medium">
                      {selectedModules.length === 0
                        ? "الأساسيات فقط"
                        : `${selectedModules.length} وحدة (${selectedModules.map(k => MODULE_BY_KEY[k]?.nameAr ?? k).join("، ")})`}
                    </span>
                    {/* Granular menu permissions auto-granted by the chosen
                        industries — gives the user transparency about which
                        sidebar items will appear on first login. Computed
                        purely on the client from INDUSTRIES_LIVE so it
                        always mirrors what the server will actually grant. */}
                    {selectedIndustries.length > 0 && (() => {
                      const grantedKeys = unionMenuKeysLive(selectedIndustries);
                      if (grantedKeys.length === 0) return null;
                      const labels = grantedKeys.map(k => MENU_ITEM_BY_KEY[k]?.label ?? k);
                      return (
                        <>
                          <span className="text-muted-foreground">صلاحيات القوائم المُفعَّلة:</span>
                          <span className="font-medium" data-testid="reg-summary-menu-perms">
                            {grantedKeys.length} صلاحية ({labels.join("، ")})
                          </span>
                        </>
                      );
                    })()}
                    <span className="text-muted-foreground">تاريخ البدء:</span><span>{form.startDate}</span>
                    <span className="text-muted-foreground">تاريخ الانتهاء:</span><span>{form.endDate}</span>
                    <span className="text-muted-foreground">اسم المستخدم:</span><span className="font-mono text-xs">{form.username}</span>
                  </div>
                </div>

                {/* Country-policy acceptance gate. Required to submit. */}
                <label className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg cursor-pointer hover:bg-amber-100/60 transition-colors">
                  <input
                    type="checkbox"
                    checked={acceptedPolicy}
                    onChange={e => setAcceptedPolicy(e.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-amber-400 accent-amber-600 cursor-pointer"
                  />
                  <span className="text-sm text-amber-900">
                    أوافق على <span className="font-semibold">{policyText}</span> وأقرّ بأن البيانات المُدخلة صحيحة.
                  </span>
                </label>

                <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 text-sm">
                  <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-blue-600" />
                  <span>بالتسجيل، أنت توافق على الشروط والأحكام وسياسة الخصوصية.</span>
                </div>

                {error && <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">{error}</div>}

                <div className="flex justify-between pt-2">
                  <Button variant="ghost" onClick={() => setStep(2)} className="gap-2"><ChevronRight className="h-4 w-4" />رجوع</Button>
                  <Button
                    onClick={() => {
                      if (!acceptedPolicy) {
                        setError("يجب الموافقة على سياسة الدولة لإكمال التسجيل");
                        return;
                      }
                      setError("");
                      handleSubmit();
                    }}
                    className="gap-2"
                    disabled={loading || !acceptedPolicy}
                    title={!acceptedPolicy ? "يجب الموافقة على سياسة الدولة أولاً" : undefined}
                  >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    {loading ? "جاري الإنشاء..." : "إنشاء الحساب"}
                  </Button>
                </div>
              </div>
            )}

            {error && step < 3 && (
              <p className="text-sm text-destructive mt-3">{error}</p>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground mt-4">
          لديك حساب بالفعل؟{" "}
          <a href="/login" onClick={e => { e.preventDefault(); setLocation("/login"); }}
            className="text-primary font-medium hover:underline">تسجيل الدخول</a>
        </p>
      </div>
    </div>
  );
}

