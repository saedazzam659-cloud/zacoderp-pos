// Playwright config for the SuperAdmin UI E2E suite (task #66).
//
// Why this lives in @workspace/api-server:
//   - The sole spec under __tests__/e2e seeds and verifies state in the same
//     Postgres database the api-server reads/writes, so the test imports
//     `@workspace/db` exactly like our other __tests__/*.test.ts files do.
//     Co-locating with the other tests keeps the dependency surface (drizzle,
//     @workspace/db, tsx) in a single workspace package.
//   - A separate `pnpm --filter @workspace/api-server run test:e2e` script
//     (added in package.json) keeps the existing `pnpm --filter
//     @workspace/api-server test` (node:test backend suites) untouched, so
//     the admin-reports-tests workflow stays green.
//
// Required runtime:
//   - Both the `artifacts/api-server: API Server` and `artifacts/zatca-invoicing:
//     web` workflows must be running (the spec navigates the live SPA).
//   - REPLIT_DEV_DOMAIN must be set (provided by Replit). The base URL is
//     overridable with E2E_BASE_URL for local/CI runs against another host.
//   - DATABASE_URL must point at the same DB the api-server is using.

import { defineConfig } from "@playwright/test";

const baseURL =
  process.env.E2E_BASE_URL
  ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : undefined);

if (!baseURL) {
  throw new Error(
    "E2E base URL is not set. Either export E2E_BASE_URL or run inside a "
    + "Replit environment that provides REPLIT_DEV_DOMAIN.",
  );
}

export default defineConfig({
  testDir: "./__tests__/e2e",
  testMatch: /.*\.spec\.ts$/,
  // One spec, one worker — the suite seeds shared global rows
  // (maintenance_email_runs is not company-scoped) and keying every assertion
  // to the seeded `criticalSignature` plus a 1985-01-15 date filter is what
  // keeps it deterministic against a shared dev DB. Parallel workers would
  // race on cleanup, not on assertions.
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  // The dev SPA + first-page network round-trip can be slow on cold cache;
  // 60s leaves room without masking real regressions.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    headless: true,
    // Vite's HMR/runtime overlay is harmless for this audit panel; keep
    // navigation timeouts generous so a slow first paint doesn't false-fail.
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
    // Locale matters because the UI is Arabic and we assert literal strings.
    locale: "ar-SA",
    // Headless shell binary (already installed by `npx playwright install
    // chromium`); avoid downloading the full browser at CI time.
    channel: undefined,
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: {
        // Use the headless-shell variant we install — same engine, ~110 MB
        // smaller than the full chromium build and good enough for this test.
        browserName: "chromium",
      },
    },
  ],
});
