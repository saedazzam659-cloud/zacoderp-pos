/**
 * Legacy agent cron jobs do not send this marker. Keeping the policy as an
 * exact opt-in means a central publish can advertise a release without making
 * any previously-installed cron download or restart the agent.
 */
export function isManualAgentReleaseRequest(value: unknown): boolean {
  return value === "1";
}

type ReleaseCredentialInput = {
  manual: boolean;
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
};

function one(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Manual downloads must authenticate through headers so credentials never
 * enter request URLs. Query credentials remain accepted only for the old
 * manifest poller, whose response intentionally contains no release version.
 */
export function resolveAgentReleaseCredentials(input: ReleaseCredentialInput): {
  installationId: string;
  licenseKey: string;
} {
  const headerCredentials = {
    installationId: one(input.headers["x-zacod-installation-id"]),
    licenseKey: one(input.headers["x-zacod-license-key"]),
  };
  if (input.manual) return headerCredentials;
  return {
    installationId: headerCredentials.installationId || one(input.query.installationId),
    licenseKey: headerCredentials.licenseKey || one(input.query.licenseKey),
  };
}

/** Remove legacy bearer credentials before application request logs serialize. */
export function stripAgentReleaseCredentialsFromUrl(value: string): string {
  try {
    const parsed = new URL(value, "http://local.invalid");
    parsed.searchParams.delete("installationId");
    parsed.searchParams.delete("licenseKey");
    const query = parsed.searchParams.toString();
    return `${parsed.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return value
      .replace(/([?&])installationId=[^&]*/g, "$1")
      .replace(/([?&])licenseKey=[^&]*/g, "$1")
      .replace(/[?&]+$/, "")
      .replace(/\?&/, "?");
  }
}

export function buildCustomAgentReleaseUrl(
  origin: string,
  kind: "backend" | "frontend" | "db",
  encrypted: boolean,
): string {
  const url = new URL("/api/agent/release/custom", origin);
  url.searchParams.set("kind", kind);
  if (encrypted) url.searchParams.set("enc", "1");
  return url.toString();
}