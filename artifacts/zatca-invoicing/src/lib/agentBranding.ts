import { useEffect, useState } from "react";

/**
 * Agent-domain branding for the LOGGED-IN app (App.tsx keeps its own boolean
 * cache for routing decisions; this module additionally exposes brandName so
 * the header / sidebar / document.title show the agent's brand — e.g. «طفرة»
 * — instead of the default Zacode name on every screen inside agent
 * companies). One fetch per session, module-level cache.
 */
type AgentBranding = { isAgentDomain: boolean; brandName: string | null; brandLogoUrl: string | null };

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
      }))
      .catch(() => (cache = { isAgentDomain: false, brandName: null, brandLogoUrl: null }));
  }
  return inflight;
}

/** Agent brand name when on an agent domain, else null. */
export function useAgentBrandName(): string | null {
  const [v, setV] = useState<string | null>(cache?.isAgentDomain ? cache.brandName : null);
  useEffect(() => {
    if (cache == null) fetchBranding().then(b => setV(b.isAgentDomain ? b.brandName : null));
  }, []);
  return v;
}
