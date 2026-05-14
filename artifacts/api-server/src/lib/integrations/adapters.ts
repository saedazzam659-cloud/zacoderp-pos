/**
 * Adapter contract + reference implementations.
 *
 * An adapter knows how to (a) verify credentials, (b) pull invoices since
 * a watermark, and (c) translate provider-native invoice payloads to the
 * canonical gateway shape the rest of the pipeline already understands
 * (zatca-gateway-builder).
 *
 * We deliberately keep adapters PURE — they never touch the DB. The
 * routes layer persists results into integration_sync_runs and forwards
 * canonical invoices to the gateway for ZATCA submission.
 */
import { logger } from "../logger.js";
import type { GatewayCanonical } from "../zatca-gateway-builder.js";

export interface AdapterPullOpts {
  baseUrl?: string | null;
  credentials: Record<string, string>;
  config: Record<string, unknown>;
  /** ISO date string of the last successful sync; null for first run. */
  since: string | null;
}

export interface AdapterPullResult {
  invoices: GatewayCanonical[];
  /** Provider-native rows that failed to translate (kept for the audit run). */
  errors: Array<{ ref: string; reason: string }>;
  /** Raw response sample (truncated) for debugging. */
  rawSample: unknown;
}

export interface Adapter {
  /** Throw if credentials are missing/invalid; return on success. */
  testConnection(opts: AdapterPullOpts): Promise<{ ok: true; info?: Record<string, unknown> }>;
  pull(opts: AdapterPullOpts): Promise<AdapterPullResult>;
  /** Translate an inbound push payload from this provider to canonical shape. */
  translatePush(payload: unknown): GatewayCanonical;
}

// ────────────────────────────────────────────────────────────────────
//  Generic REST adapter — covers any system that returns invoices as
//  a JSON array under a configurable path. Used both as a real adapter
//  and as the fallback shape that the others map onto.
// ────────────────────────────────────────────────────────────────────
const genericRest: Adapter = {
  async testConnection({ baseUrl, credentials }) {
    if (!baseUrl) throw new Error("baseUrl مطلوب");
    if (!credentials.secret) throw new Error("secret مطلوب");
    const resp = await fetch(baseUrl, {
      method: "GET",
      headers: buildAuthHeader(credentials.authType ?? "bearer", credentials.secret),
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status >= 500) throw new Error(`الخادم غير متاح: HTTP ${resp.status}`);
    return { ok: true, info: { httpStatus: resp.status } };
  },
  async pull({ baseUrl, credentials, config, since }) {
    if (!baseUrl) throw new Error("baseUrl مطلوب");
    const tmpl = String(config.invoicesPath ?? "/invoices");
    const path = tmpl.replace("{lastSync}", since ?? "");
    const url  = baseUrl.replace(/\/$/, "") + (path.startsWith("/") ? path : "/" + path);
    const resp = await fetch(url, {
      headers: buildAuthHeader(String(credentials.authType ?? "bearer"), credentials.secret ?? ""),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json() as unknown;
    const arr = Array.isArray(json) ? json : Array.isArray((json as { data?: unknown[] }).data) ? (json as { data: unknown[] }).data : [];
    const invoices: GatewayCanonical[] = [];
    const errors: Array<{ ref: string; reason: string }> = [];
    for (const r of arr) {
      try { invoices.push(genericRest.translatePush(r)); }
      catch (e) {
        const ref = (r as { id?: string | number; invoiceNumber?: string })?.invoiceNumber
                  ?? String((r as { id?: string | number })?.id ?? "(unknown)");
        errors.push({ ref: String(ref), reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { invoices, errors, rawSample: arr.slice(0, 3) };
  },
  translatePush(payload) {
    const p = payload as Record<string, unknown>;
    const num = (v: unknown): number => Number(v ?? 0);
    const str = (v: unknown): string => String(v ?? "");
    const linesIn = Array.isArray(p.lines) ? p.lines as Array<Record<string, unknown>> : [];
    if (!str(p.invoiceNumber)) throw new Error("invoiceNumber مفقود");
    if (linesIn.length === 0) throw new Error("بدون أسطر");
    const first = linesIn[0];
    const qty       = num(first.quantity ?? 1);
    const unitPrice = num(first.unitPrice ?? first.price);
    const vatRate   = num(first.vatRate ?? 15);
    return buildCanonical({
      number:    str(p.invoiceNumber),
      issueDate: str(p.invoiceDate ?? p.date ?? new Date().toISOString().slice(0, 10)),
      flow:      str(p.flow ?? p.invoiceFlow) === "simplified" ? "simplified" : "standard",
      currency:  str(p.currency ?? "SAR"),
      buyerName: str(p.buyerName ?? p.customerName ?? "عميل غير محدد"),
      buyerVat:  p.buyerVat ? str(p.buyerVat) : null,
      itemDescription: str(first.description ?? first.name ?? "صنف"),
      qty, unitPrice, vatRate,
    });
  },
};

/**
 * Builds a GatewayCanonical from flat fields. Computes line totals and
 * supplies safe defaults for `icv` and `pih` (real values are assigned
 * by the gateway pipeline when forwarding to ZATCA).
 */
function buildCanonical(input: {
  number: string; issueDate: string; flow: "standard" | "simplified";
  currency: string; buyerName: string; buyerVat: string | null;
  itemDescription: string; qty: number; unitPrice: number; vatRate: number;
}): GatewayCanonical {
  const totalExclVat = +(input.qty * input.unitPrice).toFixed(2);
  const vatAmount    = +(totalExclVat * (input.vatRate / 100)).toFixed(2);
  const totalInclVat = +(totalExclVat + vatAmount).toFixed(2);
  return {
    buyer: { name: input.buyerName, vat: input.buyerVat },
    invoice: {
      number: input.number,
      flow:   input.flow,
      issueDate: input.issueDate.slice(0, 10),
      currency:  input.currency,
      icv: 0,           // assigned by gateway pipeline at submission time
      pih: "",          // ditto (previous invoice hash)
    },
    line: {
      item: input.itemDescription,
      qty: input.qty,
      unitPrice: input.unitPrice,
      vatRate: input.vatRate,
      totalExclVat,
      vatAmount,
      totalInclVat,
    },
  };
}

// ────────────────────────────────────────────────────────────────────
//  Odoo adapter — JSON-RPC over /web/session/authenticate + /jsonrpc.
//  We rely on Odoo 14+ API-key auth (no password). Credentials:
//    baseUrl, database, username, apiKey
// ────────────────────────────────────────────────────────────────────
const odoo: Adapter = {
  async testConnection({ baseUrl, credentials }) {
    if (!baseUrl) throw new Error("baseUrl مطلوب");
    const need = ["database", "username", "apiKey"];
    for (const k of need) if (!credentials[k]) throw new Error(`${k} مطلوب`);
    const uid = await odooLogin(baseUrl, credentials);
    if (!uid) throw new Error("فشل المصادقة مع Odoo");
    return { ok: true, info: { uid } };
  },
  async pull({ baseUrl, credentials, since }) {
    if (!baseUrl) throw new Error("baseUrl مطلوب");
    const uid = await odooLogin(baseUrl, credentials);
    const domain: unknown[] = [["state", "=", "posted"], ["move_type", "=", "out_invoice"]];
    if (since) domain.push(["write_date", ">=", since]);
    const records = await odooCall<Array<Record<string, unknown>>>(baseUrl, credentials, {
      service: "object", method: "execute_kw",
      args: [
        credentials.database, uid, credentials.apiKey,
        "account.move", "search_read",
        [domain],
        { fields: ["name", "invoice_date", "partner_id", "amount_total", "currency_id", "invoice_line_ids"], limit: 200 },
      ],
    });
    const invoices: GatewayCanonical[] = [];
    const errors: Array<{ ref: string; reason: string }> = [];
    for (const r of records) {
      try { invoices.push(odooMoveToCanonical(r)); }
      catch (e) { errors.push({ ref: String(r.name ?? r.id), reason: e instanceof Error ? e.message : String(e) }); }
    }
    return { invoices, errors, rawSample: records.slice(0, 3) };
  },
  translatePush(payload) {
    return odooMoveToCanonical(payload as Record<string, unknown>);
  },
};

async function odooLogin(baseUrl: string, c: Record<string, string>): Promise<number> {
  const r = await odooCall<{ uid?: number } | number>(baseUrl, c, {
    service: "common", method: "login",
    args: [c.database, c.username, c.apiKey],
  });
  if (typeof r === "number") return r;
  if (r && typeof r === "object" && typeof r.uid === "number") return r.uid;
  throw new Error("Odoo login returned no uid");
}
async function odooCall<T>(baseUrl: string, _c: Record<string, string>, params: { service: string; method: string; args: unknown[] }): Promise<T> {
  const resp = await fetch(baseUrl.replace(/\/$/, "") + "/jsonrpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params, id: Date.now() }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`Odoo HTTP ${resp.status}`);
  const j = await resp.json() as { result?: T; error?: { data?: { message?: string }; message?: string } };
  if (j.error) throw new Error(j.error.data?.message ?? j.error.message ?? "Odoo error");
  if (j.result === undefined) throw new Error("Odoo: empty result");
  return j.result;
}
function odooMoveToCanonical(r: Record<string, unknown>): GatewayCanonical {
  const partner  = Array.isArray(r.partner_id)  ? (r.partner_id  as [number, string])[1] : "عميل";
  const currency = Array.isArray(r.currency_id) ? (r.currency_id as [number, string])[1] : "SAR";
  const total = Number(r.amount_total ?? 0);
  return buildCanonical({
    number:    String(r.name ?? ""),
    issueDate: String(r.invoice_date ?? new Date().toISOString().slice(0, 10)),
    flow:      "standard",
    currency,
    buyerName: partner,
    buyerVat:  null,
    // Odoo line details require a follow-up read; for MVP we emit one
    // aggregate line. Phase B will expand to per-line read_group.
    itemDescription: `Invoice ${r.name ?? ""}`,
    qty: 1,
    unitPrice: total / 1.15,
    vatRate: 15,
  });
}

// ────────────────────────────────────────────────────────────────────
//  Salla adapter — REST + Bearer token. Endpoints:
//   GET https://api.salla.dev/admin/v2/orders?per_page=...&from_date=...
// ────────────────────────────────────────────────────────────────────
const salla: Adapter = {
  async testConnection({ credentials }) {
    if (!credentials.accessToken) throw new Error("accessToken مطلوب");
    const r = await fetch("https://api.salla.dev/admin/v2/store/info", {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 401) throw new Error("توكن سلة غير صالح");
    if (!r.ok) throw new Error(`Salla HTTP ${r.status}`);
    return { ok: true };
  },
  async pull({ credentials, since }) {
    const url = new URL("https://api.salla.dev/admin/v2/orders");
    url.searchParams.set("per_page", "50");
    if (since) url.searchParams.set("from_date", since.slice(0, 10));
    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`Salla HTTP ${r.status}`);
    const j = await r.json() as { data?: Array<Record<string, unknown>> };
    const orders = Array.isArray(j.data) ? j.data : [];
    const invoices: GatewayCanonical[] = [];
    const errors: Array<{ ref: string; reason: string }> = [];
    for (const o of orders) {
      try { invoices.push(sallaOrderToCanonical(o)); }
      catch (e) { errors.push({ ref: String(o.reference_id ?? o.id), reason: e instanceof Error ? e.message : String(e) }); }
    }
    return { invoices, errors, rawSample: orders.slice(0, 2) };
  },
  translatePush(payload) {
    const env = payload as { event?: string; data?: Record<string, unknown> };
    if (!env.data) throw new Error("Salla webhook: data مفقود");
    return sallaOrderToCanonical(env.data);
  },
};

function sallaOrderToCanonical(o: Record<string, unknown>): GatewayCanonical {
  const customer = (o.customer ?? {}) as { first_name?: string; last_name?: string };
  const total = (o.total ?? {}) as { amount?: number; currency?: string };
  const items = Array.isArray(o.items) ? o.items as Array<Record<string, unknown>> : [];
  const first = items[0] as Record<string, unknown> | undefined;
  let itemDescription = "إجمالي الطلب";
  let qty = 1;
  let unitPrice = Number(total.amount ?? 0) / 1.15;
  if (first) {
    itemDescription = String(first.name ?? "صنف");
    qty = Number(first.quantity ?? 1);
    unitPrice = Number((first.amounts as { price_without_tax?: { amount?: number } } | undefined)?.price_without_tax?.amount
                        ?? (first as { price?: { amount?: number } }).price?.amount ?? 0);
  }
  return buildCanonical({
    number:    String(o.reference_id ?? o.id ?? ""),
    issueDate: String(o.date ?? new Date().toISOString().slice(0, 10)).slice(0, 10),
    flow:      "simplified",
    currency:  String(total.currency ?? "SAR"),
    buyerName: `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim() || "عميل سلة",
    buyerVat:  null,
    itemDescription, qty, unitPrice, vatRate: 15,
  });
}

const ADAPTERS: Partial<Record<string, Adapter>> = {
  generic_rest: genericRest,
  odoo,
  salla,
};

export function getAdapter(provider: string): Adapter | null {
  return ADAPTERS[provider] ?? null;
}

function buildAuthHeader(authType: string, secret: string): Record<string, string> {
  const t = authType.toLowerCase();
  if (t === "basic")  return { Authorization: `Basic ${Buffer.from(secret).toString("base64")}` };
  if (t === "apikey") return { "X-API-Key": secret };
  return { Authorization: `Bearer ${secret}` };
}

export function safeLogAdapterError(connectionId: number, err: unknown): void {
  logger.warn({ connectionId, err: err instanceof Error ? err.message : String(err) }, "integration.adapter-error");
}
