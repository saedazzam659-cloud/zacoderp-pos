import { useEffect, useState } from "react";

/**
 * Agent-domain branding for the LOGGED-IN app (App.tsx keeps its own boolean
 * cache for routing decisions; this module additionally exposes brandName so
 * the header / sidebar / document.title show the agent's brand — e.g. «طفرة»
 * — instead of the default Zacode name on every screen inside agent
 * companies). One fetch per session, module-level cache.
 */
type AgentBranding = {
  isAgentDomain: boolean;
  brandName: string | null;
  brandLogoUrl: string | null;
  localSuperadminScreens: string[] | null;
};

let cache: AgentBranding | null = null;
let inflight: Promise<AgentBranding> | null = null;

function fetchBranding(): Promise<AgentBranding> {
  if (!inflight) {
    const base = import.meta.env.VITE_API_URL ?? "";
    inflight = fetch(`${base}/api/branding?host=${encodeURIComponent(window.location.hostname)}`)
      .then(r => r.json())
      .then(j => (cache = {
        isAgentDomain: !!j?.isAgentDomain,
        brandName: typeof j?.brandName === "string" && j.brandName.trim() ? j.brandName.trim() : null,
        brandLogoUrl: typeof j?.brandLogoUrl === "string" && j.brandLogoUrl ? j.brandLogoUrl : null,
        localSuperadminScreens: Array.isArray(j?.localSuperadminScreens)
          ? j.localSuperadminScreens.filter((id: unknown): id is string => typeof id === "string")
          : null,
      }))
      .catch(() => (cache = { isAgentDomain: false, brandName: null, brandLogoUrl: null, localSuperadminScreens: null }))
      .then(b => { try { applyDocumentBranding(b); } catch { /* cosmetic only */ } return b; });
  }
  return inflight;
}

/**
 * Document-level white-labeling on agent domains: the static index.html ships
 * the Zacode <title>/meta/manifest, so on agent domains we rewrite them
 * client-side too (the server also serves a rebranded index.html on agent
 * domains — this is the belt-and-braces fallback for cached/edge-served HTML):
 *  • <title> and description/og/twitter metas → brand name;
 *  • <link rel="manifest"> → /api/branding/manifest so the PWA install
 *    prompt («تثبيت …») shows the agent brand instead of زاكود.
 */
function applyDocumentBranding(b: AgentBranding): void {
  if (!b.isAgentDomain || !b.brandName) return;
  const brand = b.brandName;
  const swap = (s: string) =>
    s.split("زاكود المحاسبي").join(brand).split("زاكود").join(brand)
      .split("Zacoderp").join(brand).split("Zacod ERP").join(brand).split("Zacode").join(brand);
  if (document.title.includes("زاكود") || document.title.includes("Zacode")) {
    document.title = swap(document.title);
  }
  const metaSel = [
    'meta[name="description"]', 'meta[name="apple-mobile-web-app-title"]', 'meta[name="application-name"]',
    'meta[property="og:site_name"]', 'meta[property="og:title"]', 'meta[property="og:description"]',
    'meta[name="twitter:title"]', 'meta[name="twitter:description"]',
  ].join(",");
  document.querySelectorAll<HTMLMetaElement>(metaSel).forEach(m => {
    const v = m.getAttribute("content");
    if (v && (v.includes("زاكود") || v.includes("Zacode"))) m.setAttribute("content", swap(v));
  });
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (manifest && !manifest.href.includes("/api/branding/manifest")) {
    const base = import.meta.env.VITE_API_URL ?? "";
    manifest.href = `${base}/api/branding/manifest?host=${encodeURIComponent(window.location.hostname)}`;
  }
}

// Kick off at module load so the tab title / manifest are fixed as early as
// possible on agent domains (result is cached; hooks reuse the same promise).
if (typeof window !== "undefined") void fetchBranding();

/** Agent brand name when on an agent domain, else null. */
export function useAgentBrandName(): string | null {
  const [v, setV] = useState<string | null>(cache?.isAgentDomain ? cache.brandName : null);
  useEffect(() => {
    if (cache == null) fetchBranding().then(b => setV(b.isAgentDomain ? b.brandName : null));
  }, []);
  return v;
}

/** True when the current host is registered as an agent domain. */
export function useIsAgentDomain(): boolean {
  const [v, setV] = useState<boolean>(cache?.isAgentDomain ?? false);
  useEffect(() => {
    if (cache == null) fetchBranding().then(b => setV(b.isAgentDomain));
  }, []);
  return v;
}

/** Null means the central platform/default policy: every SA screen is allowed. */
export function useLocalSuperadminScreens(): string[] | null {
  const [v, setV] = useState<string[] | null>(cache?.localSuperadminScreens ?? null);
  useEffect(() => {
    if (cache == null) fetchBranding().then(b => setV(b.localSuperadminScreens));
  }, []);
  return v;
}
