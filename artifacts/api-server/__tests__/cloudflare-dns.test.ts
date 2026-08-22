// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for cloudflareDns.ts
//
// All tests use an injectable fetchImpl — no real network calls are made.
// Token is injected via the `token` parameter so tests are not env-dependent.
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import test from "node:test";

import {
  isCloudflareDnsConfigured,
  planCloudflareARecord,
  applyCloudflareARecord,
  updateCloudflareProxy,
  pickBestZone,
  validatePublicIpv4,
  validateDomain,
  CfDnsError,
  type CfZone,
  type CfDnsRecord,
  type CloudflareARecordPlan,
  type FetchImpl,
} from "../src/lib/cloudflareDns.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "fake-test-token-abc123";
const PUBLIC_IP = "203.0.113.1"; // documentation range — but we override validatePublicIpv4 via fetch mock

// Actually 203.0.113.0/24 is blocked. Use a real public-looking IP for tests.
const ORIGIN_IP = "1.2.3.4";

/** Build a minimal Cloudflare v4 success envelope. */
function cfOk<T>(result: T): string {
  return JSON.stringify({ success: true, errors: [], result });
}

/** Build a Cloudflare v4 error envelope. */
function cfErr(code: number, message: string): string {
  return JSON.stringify({ success: false, errors: [{ code, message }], result: null });
}

/** Minimal zone list response: one zone. */
function zoneListResponse(zones: CfZone[]): string {
  return JSON.stringify({ success: true, errors: [], result: zones });
}

/** Create a mock FetchImpl that returns a sequence of responses. */
function mockFetch(responses: Array<{ status?: number; body: string }>): FetchImpl {
  let i = 0;
  return async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    if (i >= responses.length) {
      throw new Error(`mockFetch: unexpected call #${i + 1} (only ${responses.length} responses configured). URL: ${String(_url)}`);
    }
    const { status = 200, body } = responses[i++];
    return new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const ZONE_EXAMPLE: CfZone = { id: "zone-example-123", name: "example.com", status: "active" };
const ZONE_SUB: CfZone = { id: "zone-sub-456", name: "sub.example.com", status: "active" };
const ZONE_COM: CfZone = { id: "zone-com-789", name: "com", status: "active" };

function makeRecord(overrides: Partial<CfDnsRecord> = {}): CfDnsRecord {
  return {
    id: "rec-001",
    type: "A",
    name: "app.example.com",
    content: ORIGIN_IP,
    proxied: false,
    ttl: 1,
    ...overrides,
  };
}

// ── isCloudflareDnsConfigured ─────────────────────────────────────────────────

test("isCloudflareDnsConfigured returns false when no token env vars set", () => {
  const prev1 = process.env.CLOUDFLARE_API_TOKEN;
  const prev2 = process.env.CF_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CF_API_TOKEN;
  try {
    assert.equal(isCloudflareDnsConfigured(), false);
  } finally {
    if (prev1 !== undefined) process.env.CLOUDFLARE_API_TOKEN = prev1;
    if (prev2 !== undefined) process.env.CF_API_TOKEN = prev2;
  }
});

test("isCloudflareDnsConfigured returns true with CLOUDFLARE_API_TOKEN set", () => {
  const prev = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = "some-token";
  try {
    assert.equal(isCloudflareDnsConfigured(), true);
  } finally {
    if (prev === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = prev;
  }
});

test("isCloudflareDnsConfigured returns true with CF_API_TOKEN set", () => {
  const prev1 = process.env.CLOUDFLARE_API_TOKEN;
  const prev2 = process.env.CF_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  process.env.CF_API_TOKEN = "fallback-token";
  try {
    assert.equal(isCloudflareDnsConfigured(), true);
  } finally {
    if (prev1 !== undefined) process.env.CLOUDFLARE_API_TOKEN = prev1;
    if (prev2 === undefined) delete process.env.CF_API_TOKEN;
    else process.env.CF_API_TOKEN = prev2;
  }
});

// ── Token missing ────────────────────────────────────────────────────────────

test("planCloudflareARecord throws CF_TOKEN_MISSING when no token provided and env vars absent", async () => {
  const prev1 = process.env.CLOUDFLARE_API_TOKEN;
  const prev2 = process.env.CF_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CF_API_TOKEN;
  try {
    await assert.rejects(
      () => planCloudflareARecord({ domain: "app.example.com", originIp: ORIGIN_IP, desiredProxied: false }),
      (err: unknown) => {
        assert.ok(err instanceof CfDnsError, "should be CfDnsError");
        assert.equal((err as CfDnsError).code, "CF_TOKEN_MISSING");
        // Ensure no token is in the message (trivially true here since there is none)
        return true;
      }
    );
  } finally {
    if (prev1 !== undefined) process.env.CLOUDFLARE_API_TOKEN = prev1;
    if (prev2 !== undefined) process.env.CF_API_TOKEN = prev2;
  }
});

test("error messages never contain the token value", async () => {
  const fi = mockFetch([
    { status: 200, body: cfErr(9109, "Invalid access token") },
  ]);
  await assert.rejects(
    () =>
      planCloudflareARecord({
        domain: "app.example.com",
        originIp: ORIGIN_IP,
        desiredProxied: false,
        token: FAKE_TOKEN,
        fetchImpl: fi,
      }),
    (err: unknown) => {
      assert.ok(err instanceof CfDnsError);
      assert.ok(
        !String((err as CfDnsError).message).includes(FAKE_TOKEN),
        "Error message must not include the token"
      );
      return true;
    }
  );
});

// ── validatePublicIpv4 ────────────────────────────────────────────────────────

test("validatePublicIpv4 accepts a genuine public IP", () => {
  assert.doesNotThrow(() => validatePublicIpv4("8.8.8.8"));
  assert.doesNotThrow(() => validatePublicIpv4("1.2.3.4"));
  assert.doesNotThrow(() => validatePublicIpv4("185.220.101.1"));
});

test("validatePublicIpv4 rejects loopback", () => {
  assert.throws(() => validatePublicIpv4("127.0.0.1"), (e: unknown) => {
    assert.ok(e instanceof CfDnsError);
    assert.equal((e as CfDnsError).code, "INVALID_IP_RANGE");
    return true;
  });
});

test("validatePublicIpv4 rejects private ranges", () => {
  for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1"]) {
    assert.throws(() => validatePublicIpv4(ip), (e: unknown) => {
      assert.ok(e instanceof CfDnsError);
      assert.equal((e as CfDnsError).code, "INVALID_IP_RANGE");
      return true;
    }, `Expected ${ip} to be rejected`);
  }
});

test("validatePublicIpv4 rejects link-local", () => {
  assert.throws(() => validatePublicIpv4("169.254.0.1"), (e: unknown) => {
    assert.equal((e as CfDnsError).code, "INVALID_IP_RANGE");
    return true;
  });
});

test("validatePublicIpv4 rejects CGNAT", () => {
  assert.throws(() => validatePublicIpv4("100.64.0.1"), (e: unknown) => {
    assert.equal((e as CfDnsError).code, "INVALID_IP_RANGE");
    return true;
  });
  assert.throws(() => validatePublicIpv4("100.127.255.255"), (e: unknown) => {
    assert.equal((e as CfDnsError).code, "INVALID_IP_RANGE");
    return true;
  });
  // 100.128.0.0 is NOT CGNAT — should pass
  assert.doesNotThrow(() => validatePublicIpv4("100.128.0.1"));
});

test("validatePublicIpv4 rejects documentation ranges", () => {
  for (const ip of ["192.0.2.1", "198.51.100.1", "203.0.113.1"]) {
    assert.throws(() => validatePublicIpv4(ip), (e: unknown) => {
      assert.equal((e as CfDnsError).code, "INVALID_IP_RANGE");
      return true;
    }, `Expected ${ip} to be rejected`);
  }
});

test("validatePublicIpv4 rejects multicast and reserved", () => {
  assert.throws(() => validatePublicIpv4("224.0.0.1"), (e: unknown) => {
    assert.equal((e as CfDnsError).code, "INVALID_IP_RANGE");
    return true;
  });
  assert.throws(() => validatePublicIpv4("240.0.0.1"), (e: unknown) => {
    assert.equal((e as CfDnsError).code, "INVALID_IP_RANGE");
    return true;
  });
  assert.throws(() => validatePublicIpv4("255.255.255.255"), (e: unknown) => {
    assert.equal((e as CfDnsError).code, "INVALID_IP_RANGE");
    return true;
  });
});

test("validatePublicIpv4 rejects unspecified 0.0.0.0", () => {
  assert.throws(() => validatePublicIpv4("0.0.0.1"), (e: unknown) => {
    assert.equal((e as CfDnsError).code, "INVALID_IP_RANGE");
    return true;
  });
});

test("validatePublicIpv4 rejects non-IPv4 strings", () => {
  for (const bad of ["", "abc", "1.2.3", "1.2.3.4.5", "1.2.3.256", "1.2.3.-1"]) {
    assert.throws(() => validatePublicIpv4(bad), (e: unknown) => {
      assert.ok(e instanceof CfDnsError);
      return true;
    }, `Expected "${bad}" to be rejected`);
  }
});

// ── validateDomain ────────────────────────────────────────────────────────────

test("validateDomain accepts valid hostnames", () => {
  assert.doesNotThrow(() => validateDomain("example.com"));
  assert.doesNotThrow(() => validateDomain("sub.example.com"));
  assert.doesNotThrow(() => validateDomain("my-app.example.co.uk"));
});

test("validateDomain rejects single-label or empty", () => {
  assert.throws(() => validateDomain(""), (e: unknown) => {
    assert.ok(e instanceof CfDnsError);
    return true;
  });
  assert.throws(() => validateDomain("localhost"), (e: unknown) => {
    assert.equal((e as CfDnsError).code, "INVALID_DOMAIN");
    return true;
  });
});

test("validateDomain rejects labels with invalid chars", () => {
  assert.throws(() => validateDomain("app_.example.com"), (e: unknown) => {
    assert.equal((e as CfDnsError).code, "INVALID_DOMAIN");
    return true;
  });
  assert.throws(() => validateDomain("-app.example.com"), (e: unknown) => {
    assert.equal((e as CfDnsError).code, "INVALID_DOMAIN");
    return true;
  });
});

// ── pickBestZone ──────────────────────────────────────────────────────────────

test("pickBestZone selects longest matching zone (suffix win)", () => {
  const zones: CfZone[] = [ZONE_COM, ZONE_EXAMPLE, ZONE_SUB];
  const best = pickBestZone("app.sub.example.com", zones);
  assert.equal(best?.name, "sub.example.com");
});

test("pickBestZone selects exact match", () => {
  const zones: CfZone[] = [ZONE_EXAMPLE, ZONE_COM];
  const best = pickBestZone("example.com", zones);
  assert.equal(best?.name, "example.com");
});

test("pickBestZone returns null when no zone matches", () => {
  const zones: CfZone[] = [ZONE_EXAMPLE];
  const best = pickBestZone("other.org", zones);
  assert.equal(best, null);
});

test("pickBestZone does not false-positive on partial suffix", () => {
  const zones: CfZone[] = [{ id: "z1", name: "ample.com", status: "active" }];
  const best = pickBestZone("example.com", zones);
  assert.equal(best, null);
});

// ── planCloudflareARecord — action: create ────────────────────────────────────

test("plan returns action=create when no DNS records exist", async () => {
  const fi = mockFetch([
    // GET /zones?status=active&per_page=50&page=1
    { body: zoneListResponse([ZONE_EXAMPLE]) },
    // GET /zones/:id/dns_records?name=app.example.com
    { body: cfOk([]) },
  ]);

  const plan = await planCloudflareARecord({
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: false,
    token: FAKE_TOKEN,
    fetchImpl: fi,
  });

  assert.equal(plan.action, "create");
  assert.equal(plan.zoneId, ZONE_EXAMPLE.id);
  assert.equal(plan.zoneName, ZONE_EXAMPLE.name);
  assert.equal(plan.domain, "app.example.com");
  assert.equal(plan.originIp, ORIGIN_IP);
  assert.equal(plan.existingRecordId, null);
});

// ── planCloudflareARecord — action: noop ─────────────────────────────────────

test("plan returns action=noop when A record already matches", async () => {
  const rec = makeRecord({ name: "app.example.com", content: ORIGIN_IP, proxied: false });
  const fi = mockFetch([
    { body: zoneListResponse([ZONE_EXAMPLE]) },
    { body: cfOk([rec]) },
  ]);

  const plan = await planCloudflareARecord({
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: false,
    token: FAKE_TOKEN,
    fetchImpl: fi,
  });

  assert.equal(plan.action, "noop");
  assert.equal(plan.existingRecordId, rec.id);
  assert.equal(plan.existingContent, ORIGIN_IP);
  assert.equal(plan.existingProxied, false);
});

// ── planCloudflareARecord — action: update ────────────────────────────────────

test("plan returns action=update when A record has a different IP", async () => {
  const rec = makeRecord({ name: "app.example.com", content: "9.9.9.9", proxied: false });
  const fi = mockFetch([
    { body: zoneListResponse([ZONE_EXAMPLE]) },
    { body: cfOk([rec]) },
  ]);

  const plan = await planCloudflareARecord({
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: false,
    token: FAKE_TOKEN,
    fetchImpl: fi,
  });

  assert.equal(plan.action, "update");
  assert.equal(plan.existingContent, "9.9.9.9");
  assert.equal(plan.existingRecordId, rec.id);
});

test("plan returns action=update when proxied differs", async () => {
  const rec = makeRecord({ name: "app.example.com", content: ORIGIN_IP, proxied: false });
  const fi = mockFetch([
    { body: zoneListResponse([ZONE_EXAMPLE]) },
    { body: cfOk([rec]) },
  ]);

  const plan = await planCloudflareARecord({
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: true,
    token: FAKE_TOKEN,
    fetchImpl: fi,
  });

  assert.equal(plan.action, "update");
  assert.equal(plan.existingProxied, false);
  assert.equal(plan.desiredProxied, true);
});

// ── planCloudflareARecord — action: conflict ──────────────────────────────────

test("plan returns action=conflict for CNAME at same name", async () => {
  const rec = makeRecord({ id: "cname-1", type: "CNAME", name: "app.example.com", content: "other.host.com" });
  const fi = mockFetch([
    { body: zoneListResponse([ZONE_EXAMPLE]) },
    { body: cfOk([rec]) },
  ]);

  const plan = await planCloudflareARecord({
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: false,
    token: FAKE_TOKEN,
    fetchImpl: fi,
  });

  assert.equal(plan.action, "conflict");
  assert.equal(plan.existingType, "CNAME");
  assert.ok(plan.explanation.includes("CNAME"));
});

test("plan returns action=conflict for AAAA at same name", async () => {
  const rec = makeRecord({ id: "aaaa-1", type: "AAAA", name: "app.example.com", content: "2001:db8::1" });
  const fi = mockFetch([
    { body: zoneListResponse([ZONE_EXAMPLE]) },
    { body: cfOk([rec]) },
  ]);

  const plan = await planCloudflareARecord({
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: false,
    token: FAKE_TOKEN,
    fetchImpl: fi,
  });

  assert.equal(plan.action, "conflict");
  assert.equal(plan.existingType, "AAAA");
});

test("plan returns action=conflict for multiple A records", async () => {
  const rec1 = makeRecord({ id: "rec-a1", content: "1.2.3.4" });
  const rec2 = makeRecord({ id: "rec-a2", content: "5.6.7.8" });
  const fi = mockFetch([
    { body: zoneListResponse([ZONE_EXAMPLE]) },
    { body: cfOk([rec1, rec2]) },
  ]);

  const plan = await planCloudflareARecord({
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: false,
    token: FAKE_TOKEN,
    fetchImpl: fi,
  });

  assert.equal(plan.action, "conflict");
  assert.ok(plan.explanation.includes("multiple A records"));
});

// ── planCloudflareARecord — zone selection ────────────────────────────────────

test("plan throws CF_NO_ZONE when no zone matches domain", async () => {
  const fi = mockFetch([
    { body: zoneListResponse([ZONE_EXAMPLE]) },
  ]);

  await assert.rejects(
    () =>
      planCloudflareARecord({
        domain: "app.other.org",
        originIp: ORIGIN_IP,
        desiredProxied: false,
        token: FAKE_TOKEN,
        fetchImpl: fi,
      }),
    (err: unknown) => {
      assert.ok(err instanceof CfDnsError);
      assert.equal((err as CfDnsError).code, "CF_NO_ZONE");
      return true;
    }
  );
});

test("plan picks longest zone when multiple zones match", async () => {
  const rec = makeRecord({ name: "app.sub.example.com", content: ORIGIN_IP, proxied: false });
  const fi = mockFetch([
    { body: zoneListResponse([ZONE_COM, ZONE_EXAMPLE, ZONE_SUB]) },
    { body: cfOk([rec]) },
  ]);

  const plan = await planCloudflareARecord({
    domain: "app.sub.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: false,
    token: FAKE_TOKEN,
    fetchImpl: fi,
  });

  assert.equal(plan.zoneId, ZONE_SUB.id);
  assert.equal(plan.zoneName, "sub.example.com");
});

// ── applyCloudflareARecord — create ───────────────────────────────────────────

test("applyCloudflareARecord creates a new A record", async () => {
  const createdRec: CfDnsRecord = {
    id: "new-rec-001",
    type: "A",
    name: "app.example.com",
    content: ORIGIN_IP,
    proxied: false,
    ttl: 1,
  };

  const plan: CloudflareARecordPlan = {
    zoneId: ZONE_EXAMPLE.id,
    zoneName: ZONE_EXAMPLE.name,
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: false,
    action: "create",
    existingRecordId: null,
    existingType: null,
    existingContent: null,
    existingProxied: null,
    explanation: "create",
  };

  const fi = mockFetch([
    // Re-plan: zone list
    { body: zoneListResponse([ZONE_EXAMPLE]) },
    // Re-plan: dns_records query (empty)
    { body: cfOk([]) },
    // POST create
    { body: cfOk(createdRec) },
  ]);

  const result = await applyCloudflareARecord(plan, { token: FAKE_TOKEN, fetchImpl: fi });

  assert.equal(result.id, "new-rec-001");
  assert.equal(result.name, "app.example.com");
  assert.equal(result.content, ORIGIN_IP);
  assert.equal(result.proxied, false);
});

// ── applyCloudflareARecord — update ───────────────────────────────────────────

test("applyCloudflareARecord updates existing A record", async () => {
  const existingRec: CfDnsRecord = {
    id: "rec-existing",
    type: "A",
    name: "app.example.com",
    content: "9.9.9.9",
    proxied: false,
    ttl: 3600,
  };
  const updatedRec: CfDnsRecord = {
    ...existingRec,
    content: ORIGIN_IP,
    ttl: 1,
  };

  const plan: CloudflareARecordPlan = {
    zoneId: ZONE_EXAMPLE.id,
    zoneName: ZONE_EXAMPLE.name,
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: false,
    action: "update",
    existingRecordId: "rec-existing",
    existingType: "A",
    existingContent: "9.9.9.9",
    existingProxied: false,
    explanation: "update",
  };

  const fi = mockFetch([
    // Re-plan: zone list
    { body: zoneListResponse([ZONE_EXAMPLE]) },
    // Re-plan: dns_records query — returns the old record (action=update confirmed)
    { body: cfOk([existingRec]) },
    // PUT update
    { body: cfOk(updatedRec) },
  ]);

  const result = await applyCloudflareARecord(plan, { token: FAKE_TOKEN, fetchImpl: fi });

  assert.equal(result.id, "rec-existing");
  assert.equal(result.content, ORIGIN_IP);
});

// ── applyCloudflareARecord — noop plan ───────────────────────────────────────

test("applyCloudflareARecord with noop plan returns existing record without API mutation", async () => {
  const rec: CfDnsRecord = makeRecord({ content: ORIGIN_IP, proxied: false });

  const plan: CloudflareARecordPlan = {
    zoneId: ZONE_EXAMPLE.id,
    zoneName: ZONE_EXAMPLE.name,
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: false,
    action: "noop",
    existingRecordId: rec.id,
    existingType: "A",
    existingContent: ORIGIN_IP,
    existingProxied: false,
    explanation: "noop",
  };

  // Re-plan only (2 calls), no mutation call
  const fi = mockFetch([
    { body: zoneListResponse([ZONE_EXAMPLE]) },
    { body: cfOk([rec]) },
  ]);

  const result = await applyCloudflareARecord(plan, { token: FAKE_TOKEN, fetchImpl: fi });
  assert.equal(result.id, rec.id);
  assert.equal(result.content, ORIGIN_IP);
});

// ── applyCloudflareARecord — conflict rejection ───────────────────────────────

test("applyCloudflareARecord rejects conflict plans immediately", async () => {
  const plan: CloudflareARecordPlan = {
    zoneId: ZONE_EXAMPLE.id,
    zoneName: ZONE_EXAMPLE.name,
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: false,
    action: "conflict",
    existingRecordId: "cname-1",
    existingType: "CNAME",
    existingContent: "other.com",
    existingProxied: false,
    explanation: "conflict because CNAME",
  };

  await assert.rejects(
    () => applyCloudflareARecord(plan, { token: FAKE_TOKEN, fetchImpl: mockFetch([]) }),
    (err: unknown) => {
      assert.ok(err instanceof CfDnsError);
      assert.equal((err as CfDnsError).code, "CF_PLAN_CONFLICT");
      return true;
    }
  );
});

// ── TOCTOU rejection ──────────────────────────────────────────────────────────

test("applyCloudflareARecord rejects when zone changed between plan and apply", async () => {
  // Plan says zone-example-123, but zone lookup now returns a different zone.
  const differentZone: CfZone = { id: "zone-different-000", name: "example.com", status: "active" };

  const plan: CloudflareARecordPlan = {
    zoneId: ZONE_EXAMPLE.id, // zone-example-123
    zoneName: ZONE_EXAMPLE.name,
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: false,
    action: "create",
    existingRecordId: null,
    existingType: null,
    existingContent: null,
    existingProxied: null,
    explanation: "create",
  };

  const fi = mockFetch([
    // Re-plan returns a different zone id
    { body: zoneListResponse([differentZone]) },
    { body: cfOk([]) },
  ]);

  await assert.rejects(
    () => applyCloudflareARecord(plan, { token: FAKE_TOKEN, fetchImpl: fi }),
    (err: unknown) => {
      assert.ok(err instanceof CfDnsError);
      assert.equal((err as CfDnsError).code, "CF_TOCTOU_ZONE");
      return true;
    }
  );
});

test("applyCloudflareARecord rejects when state changed from create to conflict", async () => {
  // Plan says create, but a CNAME appeared in the meantime.
  const cnameRec = makeRecord({ id: "cname-new", type: "CNAME", content: "other.host" });

  const plan: CloudflareARecordPlan = {
    zoneId: ZONE_EXAMPLE.id,
    zoneName: ZONE_EXAMPLE.name,
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: false,
    action: "create",
    existingRecordId: null,
    existingType: null,
    existingContent: null,
    existingProxied: null,
    explanation: "create",
  };

  const fi = mockFetch([
    { body: zoneListResponse([ZONE_EXAMPLE]) },
    { body: cfOk([cnameRec]) }, // CNAME appeared → re-plan yields conflict
  ]);

  await assert.rejects(
    () => applyCloudflareARecord(plan, { token: FAKE_TOKEN, fetchImpl: fi }),
    (err: unknown) => {
      assert.ok(err instanceof CfDnsError);
      assert.equal((err as CfDnsError).code, "CF_TOCTOU_CONFLICT");
      return true;
    }
  );
});

test("applyCloudflareARecord rejects when record id changed between plan and apply", async () => {
  // Plan has record id rec-existing, but re-plan returns a new id.
  const newRec: CfDnsRecord = makeRecord({ id: "rec-NEW-id", content: "9.9.9.9" });

  const plan: CloudflareARecordPlan = {
    zoneId: ZONE_EXAMPLE.id,
    zoneName: ZONE_EXAMPLE.name,
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    desiredProxied: false,
    action: "update",
    existingRecordId: "rec-existing",
    existingType: "A",
    existingContent: "9.9.9.9",
    existingProxied: false,
    explanation: "update",
  };

  const fi = mockFetch([
    { body: zoneListResponse([ZONE_EXAMPLE]) },
    { body: cfOk([newRec]) }, // different id → re-plan has id=rec-NEW-id
  ]);

  await assert.rejects(
    () => applyCloudflareARecord(plan, { token: FAKE_TOKEN, fetchImpl: fi }),
    (err: unknown) => {
      assert.ok(err instanceof CfDnsError);
      assert.equal((err as CfDnsError).code, "CF_TOCTOU_CHANGED");
      return true;
    }
  );
});

// ── updateCloudflareProxy ─────────────────────────────────────────────────────

test("updateCloudflareProxy updates proxied flag after GET verification", async () => {
  const currentRec: CfDnsRecord = makeRecord({ id: "rec-pin-001", name: "app.example.com", content: ORIGIN_IP, proxied: false, ttl: 1 });
  const updatedRec: CfDnsRecord = { ...currentRec, proxied: true };

  const fi = mockFetch([
    // GET current record
    { body: cfOk(currentRec) },
    // PUT update
    { body: cfOk(updatedRec) },
  ]);

  const result = await updateCloudflareProxy({
    zoneId: ZONE_EXAMPLE.id,
    recordId: "rec-pin-001",
    domain: "app.example.com",
    originIp: ORIGIN_IP,
    proxied: true,
    token: FAKE_TOKEN,
    fetchImpl: fi,
  });

  assert.equal(result.proxied, true);
  assert.equal(result.id, "rec-pin-001");
  assert.equal(result.content, ORIGIN_IP);
});

test("updateCloudflareProxy rejects when record name has drifted", async () => {
  const driftedRec: CfDnsRecord = makeRecord({
    id: "rec-pin-001",
    name: "different.example.com", // drifted
    content: ORIGIN_IP,
    proxied: false,
  });

  const fi = mockFetch([
    { body: cfOk(driftedRec) },
  ]);

  await assert.rejects(
    () =>
      updateCloudflareProxy({
        zoneId: ZONE_EXAMPLE.id,
        recordId: "rec-pin-001",
        domain: "app.example.com",
        originIp: ORIGIN_IP,
        proxied: true,
        token: FAKE_TOKEN,
        fetchImpl: fi,
      }),
    (err: unknown) => {
      assert.ok(err instanceof CfDnsError);
      assert.equal((err as CfDnsError).code, "CF_RECORD_MISMATCH");
      return true;
    }
  );
});

test("updateCloudflareProxy rejects when record type is not A", async () => {
  const cnameRec: CfDnsRecord = makeRecord({
    id: "rec-pin-001",
    type: "CNAME",
    name: "app.example.com",
    content: "other.host.com",
    proxied: false,
  });

  const fi = mockFetch([
    { body: cfOk(cnameRec) },
  ]);

  await assert.rejects(
    () =>
      updateCloudflareProxy({
        zoneId: ZONE_EXAMPLE.id,
        recordId: "rec-pin-001",
        domain: "app.example.com",
        originIp: ORIGIN_IP,
        proxied: true,
        token: FAKE_TOKEN,
        fetchImpl: fi,
      }),
    (err: unknown) => {
      assert.ok(err instanceof CfDnsError);
      assert.equal((err as CfDnsError).code, "CF_RECORD_MISMATCH");
      return true;
    }
  );
});

test("updateCloudflareProxy rejects when content (IP) has drifted", async () => {
  const driftedRec: CfDnsRecord = makeRecord({
    id: "rec-pin-001",
    name: "app.example.com",
    type: "A",
    content: "9.9.9.9", // different from expected ORIGIN_IP
    proxied: false,
  });

  const fi = mockFetch([
    { body: cfOk(driftedRec) },
  ]);

  await assert.rejects(
    () =>
      updateCloudflareProxy({
        zoneId: ZONE_EXAMPLE.id,
        recordId: "rec-pin-001",
        domain: "app.example.com",
        originIp: ORIGIN_IP,
        proxied: true,
        token: FAKE_TOKEN,
        fetchImpl: fi,
      }),
    (err: unknown) => {
      assert.ok(err instanceof CfDnsError);
      assert.equal((err as CfDnsError).code, "CF_RECORD_MISMATCH");
      return true;
    }
  );
});

// ── Cloudflare API error surfacing ────────────────────────────────────────────

test("plan throws CF_API_ERROR with friendly message on Cloudflare error response", async () => {
  const fi = mockFetch([
    { status: 200, body: cfErr(7003, "Could not route to /zones") },
  ]);

  await assert.rejects(
    () =>
      planCloudflareARecord({
        domain: "app.example.com",
        originIp: ORIGIN_IP,
        desiredProxied: false,
        token: FAKE_TOKEN,
        fetchImpl: fi,
      }),
    (err: unknown) => {
      assert.ok(err instanceof CfDnsError);
      assert.equal((err as CfDnsError).code, "CF_API_ERROR");
      assert.ok(String((err as CfDnsError).message).includes("7003"));
      assert.ok(!String((err as CfDnsError).message).includes(FAKE_TOKEN));
      return true;
    }
  );
});

test("plan throws CF_NETWORK_ERROR on fetch failure", async () => {
  const failFetch: FetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };

  await assert.rejects(
    () =>
      planCloudflareARecord({
        domain: "app.example.com",
        originIp: ORIGIN_IP,
        desiredProxied: false,
        token: FAKE_TOKEN,
        fetchImpl: failFetch,
      }),
    (err: unknown) => {
      assert.ok(err instanceof CfDnsError);
      assert.equal((err as CfDnsError).code, "CF_NETWORK_ERROR");
      return true;
    }
  );
});
