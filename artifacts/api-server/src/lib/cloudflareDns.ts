// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare DNS service — A-record management via Cloudflare v4 API.
//
// Design principles:
//   • Token comes only from CLOUDFLARE_API_TOKEN or CF_API_TOKEN env vars.
//   • Never log or return the token.
//   • fetch is injectable (fetchImpl param) so tests run without network.
//   • Errors carry a stable `code` field and never leak credentials.
//   • Only A records are created/updated. Conflicting record types ⇒ conflict.
//   • No wildcard mutations. No deletions. Ever.
// ─────────────────────────────────────────────────────────────────────────────

// ── Types ──────────────────────────────────────────────────────────────────

export type FetchImpl = typeof fetch;

export interface CfZone {
  id: string;
  name: string;
  status: string;
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

export type PlanAction = "create" | "update" | "noop" | "conflict";

export interface CloudflareARecordPlan {
  zoneId: string;
  zoneName: string;
  domain: string;
  originIp: string;
  desiredProxied: boolean;
  action: PlanAction;
  existingRecordId: string | null;
  existingType: string | null;
  existingContent: string | null;
  existingProxied: boolean | null;
  explanation: string;
}

export interface ApplyOptions {
  fetchImpl?: FetchImpl;
  token?: string;
  forceProxied?: boolean;
}

export interface AppliedRecord {
  id: string;
  name: string;
  content: string;
  proxied: boolean;
}

export interface ProxyUpdateOptions {
  zoneId: string;
  recordId: string;
  domain: string;
  originIp: string;
  proxied: boolean;
  fetchImpl?: FetchImpl;
  token?: string;
}

// ── Custom error ────────────────────────────────────────────────────────────

export class CfDnsError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "CfDnsError";
    this.code = code;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns true when at least one Cloudflare token env var is present and
 * non-empty. Never returns the token itself.
 */
export function isCloudflareDnsConfigured(): boolean {
  return Boolean(
    (process.env.CLOUDFLARE_API_TOKEN ?? "").trim() ||
      (process.env.CF_API_TOKEN ?? "").trim()
  );
}

/** Resolve token from args > env vars. Throws if missing. */
function resolveToken(provided?: string): string {
  const t =
    provided ||
    (process.env.CLOUDFLARE_API_TOKEN ?? "").trim() ||
    (process.env.CF_API_TOKEN ?? "").trim();
  if (!t) {
    throw new CfDnsError(
      "Cloudflare API token is not configured. Set CLOUDFLARE_API_TOKEN or CF_API_TOKEN.",
      "CF_TOKEN_MISSING"
    );
  }
  return t;
}

const CF_BASE = "https://api.cloudflare.com/client/v4";

/** Safely call the Cloudflare v4 API, parse and validate the envelope. */
async function cfFetch<T>(
  path: string,
  opts: RequestInit,
  token: string,
  fetchImpl: FetchImpl
): Promise<T> {
  let res: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    // Build headers separately to avoid duplicate keys and keep token out of
    // any intermediate spread that could surface it in error messages.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(opts.headers as Record<string, string> | undefined ?? {}),
    };
    headers["Authorization"] = `Bearer ${token}`;
    res = await fetchImpl(`${CF_BASE}${path}`, {
      ...opts,
      headers,
      signal: controller.signal,
    });
  } catch (e: unknown) {
    clearTimeout(timeout);
    throw new CfDnsError(
      `Cloudflare API network error: ${(e as Error).message ?? "unknown"}`,
      "CF_NETWORK_ERROR"
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    clearTimeout(timeout);
    throw new CfDnsError(
      `Cloudflare API returned non-JSON response (HTTP ${res.status}).`,
      "CF_BAD_RESPONSE"
    );
  }
  clearTimeout(timeout);

  const envelope = body as {
    success: boolean;
    errors?: Array<{ code: number; message: string }>;
    result?: T;
    result_info?: unknown;
  };

  if (!envelope.success) {
    const msgs = (envelope.errors ?? [])
      .map((e) => `[${e.code}] ${e.message}`)
      .join("; ");
    throw new CfDnsError(
      `Cloudflare API error: ${msgs || `HTTP ${res.status}`}`,
      "CF_API_ERROR"
    );
  }

  return envelope.result as T;
}

// ── IP validation ────────────────────────────────────────────────────────────

/**
 * Validates that `ip` is a routable public IPv4 address.
 * Rejects:
 *   - Non-IPv4 format
 *   - Loopback          127.0.0.0/8
 *   - Private           10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *   - Link-local        169.254.0.0/16
 *   - Multicast         224.0.0.0/4
 *   - Documentation     192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24
 *   - Unspecified       0.0.0.0/8
 *   - CGNAT             100.64.0.0/10
 *   - Broadcast         255.255.255.255
 *   - Reserved          240.0.0.0/4
 */
export function validatePublicIpv4(ip: string): void {
  if (typeof ip !== "string" || !ip.trim()) {
    throw new CfDnsError("IP address is required.", "INVALID_IP");
  }
  const parts = ip.trim().split(".");
  if (parts.length !== 4) {
    throw new CfDnsError(`"${ip}" is not a valid IPv4 address.`, "INVALID_IP");
  }
  const octets = parts.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255 || String(n) !== p) {
      throw new CfDnsError(
        `"${ip}" is not a valid IPv4 address.`,
        "INVALID_IP"
      );
    }
    return n;
  });

  const [a, b, c] = octets;
  const checks: Array<[boolean, string]> = [
    [a === 0, "unspecified (0.0.0.0/8)"],
    [a === 10, "private (10.0.0.0/8)"],
    [a === 127, "loopback (127.0.0.0/8)"],
    [a === 100 && b >= 64 && b <= 127, "CGNAT (100.64.0.0/10)"],
    [a === 169 && b === 254, "link-local (169.254.0.0/16)"],
    [a === 172 && b >= 16 && b <= 31, "private (172.16.0.0/12)"],
    [a === 192 && b === 0 && c === 2, "documentation (192.0.2.0/24)"],
    [a === 192 && b === 168, "private (192.168.0.0/16)"],
    [a === 198 && b === 51 && c === 100, "documentation (198.51.100.0/24)"],
    [a === 203 && b === 0 && c === 113, "documentation (203.0.113.0/24)"],
    [a >= 224 && a <= 239, "multicast (224.0.0.0/4)"],
    [a >= 240, "reserved/broadcast (240.0.0.0/4)"],
  ];

  for (const [cond, label] of checks) {
    if (cond) {
      throw new CfDnsError(
        `"${ip}" is a ${label} address and cannot be used as a public origin.`,
        "INVALID_IP_RANGE"
      );
    }
  }
}

/**
 * Validates that `domain` looks like a reasonable hostname.
 * Does not resolve — purely syntactic.
 */
export function validateDomain(domain: string): void {
  if (typeof domain !== "string" || !domain.trim()) {
    throw new CfDnsError("Domain is required.", "INVALID_DOMAIN");
  }
  const d = domain.trim().toLowerCase();
  // Max 253 chars, each label 1-63 chars, only alnum+hyphen, no leading/trailing hyphen per label.
  if (d.length > 253) {
    throw new CfDnsError(`Domain "${d}" exceeds 253 characters.`, "INVALID_DOMAIN");
  }
  const labelRe = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const labels = d.split(".");
  if (labels.length < 2) {
    throw new CfDnsError(
      `Domain "${d}" must have at least two labels.`,
      "INVALID_DOMAIN"
    );
  }
  for (const label of labels) {
    if (!label || !labelRe.test(label)) {
      throw new CfDnsError(
        `Domain "${d}" contains an invalid label: "${label}".`,
        "INVALID_DOMAIN"
      );
    }
  }
}

// ── Zone selection ───────────────────────────────────────────────────────────

/** List all active zones accessible with the token. */
async function listActiveZones(
  token: string,
  fetchImpl: FetchImpl
): Promise<CfZone[]> {
  // Paginate — typically one page for most accounts.
  const allZones: CfZone[] = [];
  let page = 1;
  while (true) {
    const result = await cfFetch<{
      id: string;
      name: string;
      status: string;
    }[]>(
      `/zones?status=active&per_page=50&page=${page}`,
      { method: "GET" },
      token,
      fetchImpl
    );
    if (!result || result.length === 0) break;
    allZones.push(...result.map((z) => ({ id: z.id, name: z.name, status: z.status })));
    if (result.length < 50) break;
    page++;
  }
  return allZones;
}

/**
 * Choose the best (longest) zone whose name is either an exact match or a
 * suffix of the given domain.  e.g., for "sub.example.com":
 *   • "sub.example.com" > "example.com" > "com"
 */
export function pickBestZone(
  domain: string,
  zones: CfZone[]
): CfZone | null {
  const d = domain.toLowerCase();
  let best: CfZone | null = null;
  for (const zone of zones) {
    const zn = zone.name.toLowerCase();
    const matches = d === zn || d.endsWith(`.${zn}`);
    if (matches) {
      if (!best || zn.length > best.name.length) {
        best = zone;
      }
    }
  }
  return best;
}

// ── planCloudflareARecord ───────────────────────────────────────────────────

export interface PlanOptions {
  domain: string;
  originIp: string;
  desiredProxied: boolean;
  fetchImpl?: FetchImpl;
  token?: string;
}

/**
 * Determines what action is needed to point `domain` at `originIp` as an
 * A record in Cloudflare DNS, without making any changes.
 *
 * Returns a typed plan describing the intended action and the current state.
 */
export async function planCloudflareARecord(
  opts: PlanOptions
): Promise<CloudflareARecordPlan> {
  const { domain, originIp, desiredProxied } = opts;
  const fi: FetchImpl = opts.fetchImpl ?? fetch;
  const token = resolveToken(opts.token);

  validateDomain(domain);
  validatePublicIpv4(originIp);

  // 1. Find the best zone.
  const zones = await listActiveZones(token, fi);
  const zone = pickBestZone(domain, zones);
  if (!zone) {
    throw new CfDnsError(
      `No accessible Cloudflare zone found for domain "${domain}". ` +
        `Make sure the zone is added to your account and the token has Zone:Read permission.`,
      "CF_NO_ZONE"
    );
  }

  // 2. Fetch exact-name DNS records.
  const encodedDomain = encodeURIComponent(domain);
  const records = await cfFetch<CfDnsRecord[]>(
    `/zones/${zone.id}/dns_records?name=${encodedDomain}&per_page=100`,
    { method: "GET" },
    token,
    fi
  );

  // 3. Analyse existing records for the exact name.
  if (!records || records.length === 0) {
    return {
      zoneId: zone.id,
      zoneName: zone.name,
      domain,
      originIp,
      desiredProxied,
      action: "create",
      existingRecordId: null,
      existingType: null,
      existingContent: null,
      existingProxied: null,
      explanation: `No DNS records exist for "${domain}". A new A record will be created.`,
    };
  }

  // Conflict: any non-A record at this exact name.
  const nonA = records.filter((r) => r.type !== "A");
  if (nonA.length > 0) {
    const types = [...new Set(nonA.map((r) => r.type))].join(", ");
    return {
      zoneId: zone.id,
      zoneName: zone.name,
      domain,
      originIp,
      desiredProxied,
      action: "conflict",
      existingRecordId: nonA[0].id,
      existingType: nonA[0].type,
      existingContent: nonA[0].content,
      existingProxied: nonA[0].proxied,
      explanation:
        `Cannot manage "${domain}" as an A record: ` +
        `existing ${types} record(s) conflict. Remove them first.`,
    };
  }

  const aRecords = records.filter((r) => r.type === "A");

  // Conflict: multiple A records at this exact name.
  if (aRecords.length > 1) {
    return {
      zoneId: zone.id,
      zoneName: zone.name,
      domain,
      originIp,
      desiredProxied,
      action: "conflict",
      existingRecordId: aRecords[0].id,
      existingType: "A",
      existingContent: aRecords[0].content,
      existingProxied: aRecords[0].proxied,
      explanation:
        `Cannot manage "${domain}": multiple A records exist (${aRecords.length}). ` +
        `Reduce to one A record first.`,
    };
  }

  // Exactly one A record.
  const existing = aRecords[0];
  const sameIp = existing.content === originIp;
  const sameProxied = existing.proxied === desiredProxied;

  if (sameIp && sameProxied) {
    return {
      zoneId: zone.id,
      zoneName: zone.name,
      domain,
      originIp,
      desiredProxied,
      action: "noop",
      existingRecordId: existing.id,
      existingType: "A",
      existingContent: existing.content,
      existingProxied: existing.proxied,
      explanation: `A record for "${domain}" already points to ${originIp} with proxied=${desiredProxied}. No changes needed.`,
    };
  }

  return {
    zoneId: zone.id,
    zoneName: zone.name,
    domain,
    originIp,
    desiredProxied,
    action: "update",
    existingRecordId: existing.id,
    existingType: "A",
    existingContent: existing.content,
    existingProxied: existing.proxied,
    explanation:
      `A record for "${domain}" exists (id=${existing.id}) pointing to ${existing.content} ` +
      `(proxied=${existing.proxied}). Will update to ${originIp} (proxied=${desiredProxied}).`,
  };
}

// ── applyCloudflareARecord ──────────────────────────────────────────────────

/**
 * Applies the given plan after re-planning to verify state hasn't changed
 * (TOCTOU safety). Creates or updates the A record accordingly.
 *
 * Never deletes records. Rejects conflict plans.
 */
export async function applyCloudflareARecord(
  plan: CloudflareARecordPlan,
  opts: ApplyOptions = {}
): Promise<AppliedRecord> {
  const fi: FetchImpl = opts.fetchImpl ?? fetch;
  const token = resolveToken(opts.token);

  if (plan.action === "conflict") {
    throw new CfDnsError(
      `Cannot apply plan for "${plan.domain}": action is conflict. ${plan.explanation}`,
      "CF_PLAN_CONFLICT"
    );
  }

  const effectiveProxied =
    opts.forceProxied !== undefined ? opts.forceProxied : plan.desiredProxied;

  // Re-plan to detect TOCTOU changes.
  const fresh = await planCloudflareARecord({
    domain: plan.domain,
    originIp: plan.originIp,
    desiredProxied: effectiveProxied,
    fetchImpl: fi,
    token,
  });

  // TOCTOU: verify that the fresh plan matches what we intend.
  if (fresh.zoneId !== plan.zoneId) {
    throw new CfDnsError(
      `Zone changed between plan and apply for "${plan.domain}". Aborting.`,
      "CF_TOCTOU_ZONE"
    );
  }

  if (fresh.action === "conflict") {
    throw new CfDnsError(
      `State changed between plan and apply for "${plan.domain}": conflict detected. ${fresh.explanation}`,
      "CF_TOCTOU_CONFLICT"
    );
  }

  // Check action-relevant state change:
  // - plan was create but now there's a record (or vice-versa)
  // - plan was update but the existing record id or content changed
  if (plan.action === "create" && fresh.action !== "create") {
    throw new CfDnsError(
      `State changed between plan and apply for "${plan.domain}": ` +
        `expected to create but record now exists (action=${fresh.action}). Aborting.`,
      "CF_TOCTOU_CHANGED"
    );
  }

  if (
    plan.action === "update" &&
    fresh.action !== "update" &&
    fresh.action !== "noop"
  ) {
    throw new CfDnsError(
      `State changed between plan and apply for "${plan.domain}": ` +
        `expected to update (id=${plan.existingRecordId}) but state is now "${fresh.action}". Aborting.`,
      "CF_TOCTOU_CHANGED"
    );
  }

  if (
    plan.action === "update" &&
    fresh.existingRecordId !== plan.existingRecordId
  ) {
    throw new CfDnsError(
      `Record id changed between plan and apply for "${plan.domain}". Aborting.`,
      "CF_TOCTOU_CHANGED"
    );
  }

  if (fresh.action === "noop") {
    // Already correct — return the existing record details.
    return {
      id: fresh.existingRecordId!,
      name: fresh.domain,
      content: fresh.originIp,
      proxied: effectiveProxied,
    };
  }

  const payload = {
    type: "A",
    name: plan.domain,
    content: plan.originIp,
    ttl: 1,
    proxied: effectiveProxied,
  };

  if (plan.action === "create") {
    const created = await cfFetch<CfDnsRecord>(
      `/zones/${plan.zoneId}/dns_records`,
      { method: "POST", body: JSON.stringify(payload) },
      token,
      fi
    );
    return {
      id: created.id,
      name: created.name,
      content: created.content,
      proxied: created.proxied,
    };
  }

  // update
  const updated = await cfFetch<CfDnsRecord>(
    `/zones/${plan.zoneId}/dns_records/${plan.existingRecordId}`,
    { method: "PUT", body: JSON.stringify(payload) },
    token,
    fi
  );
  return {
    id: updated.id,
    name: updated.name,
    content: updated.content,
    proxied: updated.proxied,
  };
}

// ── updateCloudflareProxy ───────────────────────────────────────────────────

/**
 * Toggles only the `proxied` flag on a pinned A record.
 *
 * Performs a GET first to verify that the record id, name, type, and content
 * still match what we expect. Rejects if anything has drifted.
 */
export async function updateCloudflareProxy(
  opts: ProxyUpdateOptions
): Promise<AppliedRecord> {
  const { zoneId, recordId, domain, originIp, proxied } = opts;
  const fi: FetchImpl = opts.fetchImpl ?? fetch;
  const token = resolveToken(opts.token);

  validateDomain(domain);
  validatePublicIpv4(originIp);

  // GET to verify current state.
  const current = await cfFetch<CfDnsRecord>(
    `/zones/${zoneId}/dns_records/${recordId}`,
    { method: "GET" },
    token,
    fi
  );

  if (current.id !== recordId) {
    throw new CfDnsError(
      `Record id mismatch for "${domain}": expected ${recordId}, got ${current.id}.`,
      "CF_RECORD_MISMATCH"
    );
  }
  if (current.name.toLowerCase() !== domain.toLowerCase()) {
    throw new CfDnsError(
      `Record name mismatch for "${domain}": got "${current.name}".`,
      "CF_RECORD_MISMATCH"
    );
  }
  if (current.type !== "A") {
    throw new CfDnsError(
      `Record type mismatch for "${domain}": expected A, got ${current.type}.`,
      "CF_RECORD_MISMATCH"
    );
  }
  if (current.content !== originIp) {
    throw new CfDnsError(
      `Record content mismatch for "${domain}": expected ${originIp}, got ${current.content}.`,
      "CF_RECORD_MISMATCH"
    );
  }

  const updated = await cfFetch<CfDnsRecord>(
    `/zones/${zoneId}/dns_records/${recordId}`,
    {
      method: "PUT",
      body: JSON.stringify({
        type: "A",
        name: domain,
        content: originIp,
        ttl: current.ttl,
        proxied,
      }),
    },
    token,
    fi
  );

  return {
    id: updated.id,
    name: updated.name,
    content: updated.content,
    proxied: updated.proxied,
  };
}
