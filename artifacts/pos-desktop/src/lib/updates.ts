// In-app update notifier — polls /api/public/download/release periodically
// and exposes the latest published version so PosShell can render an
// "update available" banner without forcing the user to open the
// Updates screen manually.
//
// Failures (offline, 404, 5xx) are swallowed silently: the banner
// simply doesn't appear. We never block the cashier on this check.

import { useEffect, useState } from "react";

export const APP_VERSION = "0.3.3";

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export type ReleaseInfo = {
  version: string;
  downloadUrl: string;
  fileSizeBytes?: number | null;
  checksumSha256?: string | null;
  releaseNotes?: string | null;
  publishedAt?: string;
  countryCode?: string;
  platform?: string;
  fallback?: boolean;
};

/**
 * Compare two dotted semver-ish strings ("0.3.3", "v1.2.0"). Returns
 * positive if a > b, negative if a < b, zero if equal. Non-numeric
 * suffixes are stripped (so "0.3.3-beta" compares as "0.3.3").
 */
export function compareSemver(a: string, b: string): number {
  const norm = (s: string) =>
    s.replace(/[^\d.]/g, "").split(".").map((n) => parseInt(n || "0", 10));
  const pa = norm(a);
  const pb = norm(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Polls the release endpoint and reports whether a newer version is
 * available than what's bundled in this app. Errors are swallowed —
 * the hook just keeps reporting `isNewer: false` until a successful
 * check returns a higher version.
 */
export function useLatestVersion(baseUrl: string): {
  latest: ReleaseInfo | null;
  isNewer: boolean;
} {
  const [latest, setLatest] = useState<ReleaseInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const country = (localStorage.getItem("pos_desktop_country") || "SA").toUpperCase();

    const check = async () => {
      try {
        const url = `${baseUrl}/api/public/download/release?country=${encodeURIComponent(country)}&platform=win-x64`;
        const r = await fetch(url, { method: "GET" });
        if (!r.ok) return; // 404 / 5xx → silently skip
        const data = (await r.json()) as ReleaseInfo;
        if (!cancelled && data?.version) setLatest(data);
      } catch {
        // offline / network error → silent
      }
    };

    void check();
    const id = setInterval(check, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [baseUrl]);

  const isNewer = !!latest && compareSemver(latest.version, APP_VERSION) > 0;
  return { latest, isNewer };
}
