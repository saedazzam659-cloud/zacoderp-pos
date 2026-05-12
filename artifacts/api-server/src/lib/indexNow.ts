// IndexNow — instant search-index notification protocol supported by
// Bing, Yandex, Yahoo, Naver, Seznam, and Yep. When we publish a new
// article (or re-publish with material changes), we POST the URL list
// to https://api.indexnow.org/IndexNow and those engines will crawl
// the URL within minutes instead of waiting for their next scheduled
// pass (which can be days or weeks for low-authority new sites).
//
// Setup:
//   1. A 32-char hex key file is served at the site root:
//      https://zacoderp.com/<INDEXNOW_KEY>.txt  (file content = the key).
//      The protocol uses this to verify we own the domain.
//   2. We POST {host, key, keyLocation, urlList} to api.indexnow.org.
//
// Failures are logged but never thrown — IndexNow is best-effort, and
// Google's main crawler doesn't honor it anyway (Search Console is the
// canonical channel for Google).

import { logger } from "./logger.js";

// The IndexNow key is generated once and committed alongside the key
// file in artifacts/zatca-invoicing/public/<key>.txt. It is NOT a
// secret — the protocol literally requires it be served publicly.
// Override via env in non-production environments where the key file
// at the root may differ.
const INDEXNOW_KEY =
  process.env.INDEXNOW_KEY || "beda0e66658a3c397e3cca461c59ad06";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/IndexNow";

// Soft cap so we never POST more than the protocol's recommended
// batch size (10,000) and never spend more than ~5s on the call.
const MAX_URLS_PER_BATCH = 10_000;
const TIMEOUT_MS = 5000;

export interface PingOptions {
  /** Production host without protocol, e.g. "zacoderp.com". */
  host: string;
  /** Absolute URLs to notify (must be on the same host). */
  urls: string[];
}

export async function pingIndexNow({ host, urls }: PingOptions): Promise<void> {
  if (!urls.length) return;
  const trimmed = urls.slice(0, MAX_URLS_PER_BATCH);
  const body = {
    host,
    key:         INDEXNOW_KEY,
    keyLocation: `https://${host}/${INDEXNOW_KEY}.txt`,
    urlList:     trimmed,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(INDEXNOW_ENDPOINT, {
      method:  "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body:    JSON.stringify(body),
      signal:  ctrl.signal,
    });
    // 200 = accepted, 202 = accepted (queued). Anything else is a soft
    // failure we just log; we do NOT retry — the next publish will
    // re-ping and the engines also have their own scheduled crawl.
    if (r.status >= 200 && r.status < 300) {
      logger.info({ host, count: trimmed.length, status: r.status },
        "indexnow: notified");
    } else {
      const txt = await r.text().catch(() => "");
      logger.warn({ host, status: r.status, body: txt.slice(0, 200) },
        "indexnow: non-2xx response");
    }
  } catch (err) {
    logger.warn({ err }, "indexnow: ping failed (non-fatal)");
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience wrapper for "an article just got published" notifications. */
export async function pingArticleUrls(origin: string, slugs: string[]): Promise<void> {
  if (!slugs.length) return;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    logger.warn({ origin }, "indexnow: invalid origin, skipping");
    return;
  }
  // Don't ping localhost / preview URLs — IndexNow rejects unreachable hosts.
  if (host === "localhost" || host.endsWith(".replit.dev") || host.includes("127.0.0.1")) {
    logger.info({ host }, "indexnow: skipping non-production host");
    return;
  }
  const urls = slugs.map(s => `${origin.replace(/\/$/, "")}/blog/${encodeURIComponent(s)}`);
  await pingIndexNow({ host, urls });
}
