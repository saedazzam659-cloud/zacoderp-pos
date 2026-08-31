export type PublicBrandingAgent = {
  status: string;
  brandName: string | null;
  brandLogoUrl: string | null;
  brandColor: string | null;
  contactPhone: string | null;
};

/** Match only an agent's normalized primary or explicitly registered domains. */
export function agentOwnsHost(
  host: string,
  agent: { domain: string; extraDomains: unknown },
): boolean {
  const extras = Array.isArray(agent.extraDomains)
    ? agent.extraDomains.filter((value): value is string => typeof value === "string")
    : [];
  return agent.domain === host || extras.includes(host);
}

/** Explicit allow-list for the unauthenticated branding response. */
export function resolvedAgentBranding(agent: PublicBrandingAgent) {
  return {
    isAgentDomain: true,
    localSuperadminEnabled: false,
    localSuperadminScreens: [] as string[],
    suspended: agent.status !== "active",
    brandName: agent.brandName,
    brandLogoUrl: agent.brandLogoUrl,
    brandColor: agent.brandColor,
    contactPhone: agent.contactPhone,
  };
}