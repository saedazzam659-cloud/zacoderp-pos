/**
 * One-shot visual verification for the real simple-manufacturing screen.
 *
 * This is intentionally a script, not a Playwright test suite. It creates a
 * uniquely-owned sandbox tenant, signs that tenant in through the real
 * `/api/auth/login` endpoint from a browser page, waits for the real catalog
 * and orders requests to succeed, captures the actual SPA route, and removes
 * only the tenant it can prove it owns.
 *
 * Required safety opt-in:
 *   VISUAL_ALLOW_DEV_DB=1
 *
 * Base URL resolution follows the existing E2E setup:
 *   VISUAL_BASE_URL, then E2E_BASE_URL, then REPLIT_DEV_DOMAIN.
 * Only localhost/loopback and Replit development hosts are accepted. The
 * script refuses production NODE_ENV and never prints credentials or tokens.
 *
 * Example (run only when a capture is wanted):
 *   VISUAL_ALLOW_DEV_DB=1 E2E_BASE_URL=https://<dev-domain> \
 *     pnpm --filter @workspace/api-server run visual:simple-manufacturing -- \
 *     --capture /tmp/simple-manufacturing.png
 */

import { chromium } from "@playwright/test";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { and, eq, or } from "drizzle-orm";
import {
  centralPool,
  db,
  companiesTable,
  subscriptionsTable,
  usersTable,
} from "@workspace/db";
import { CANONICAL_MENU_PERMISSION_KEYS } from "../src/lib/menuPermissionCatalog.js";

type Fixture = {
  tag: string;
  companyId: number;
  adminUserId: number;
  companyCode: string;
  username: string;
  password: string;
  nameAr: string;
  nameEn: string;
  crNumber: string;
};

const VISUAL_TIMEOUT_MS = 15_000;
let activeStage = "startup";

async function runStage<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
  activeStage = name;
  console.log(`[visual] stage=${name} status=start`);
  try {
    const result = await operation();
    console.log(`[visual] stage=${name} status=success`);
    return result;
  } catch {
    console.error(`[visual] stage=${name} status=failed`);
    throw new Error(`Visual verification stage failed: ${name}`);
  }
}

function capturePathFromArgs(args: string[]): string {
  const inline = args.find((arg) => arg.startsWith("--capture="));
  const value = inline
    ? inline.slice("--capture=".length)
    : (() => {
        const index = args.indexOf("--capture");
        return index >= 0 ? args[index + 1] : undefined;
      })();

  if (!value || value.startsWith("-")) {
    throw new Error("A capture path is required: pass --capture <path>.");
  }
  return resolve(value);
}

function derivedCapturePath(outputPath: string, suffix: string): string {
  return outputPath.toLowerCase().endsWith(".png")
    ? `${outputPath.slice(0, -4)}${suffix}.png`
    : `${outputPath}${suffix}.png`;
}

function visualBaseUrl(): string {
  if (
    process.env.NODE_ENV === "production"
    || process.env.REPLIT_DEPLOYMENT === "1"
    || process.env.REPLIT_DEPLOYMENT === "true"
  ) {
    throw new Error("Visual verification is disabled with NODE_ENV=production.");
  }
  if (process.env.VISUAL_ALLOW_DEV_DB !== "1") {
    throw new Error("Set VISUAL_ALLOW_DEV_DB=1 for the disposable development fixture.");
  }

  const configured = process.env.VISUAL_BASE_URL
    ?? process.env.E2E_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : undefined);
  if (!configured) {
    throw new Error("Set VISUAL_BASE_URL or E2E_BASE_URL to the running development web app.");
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("The visual verification base URL is invalid.");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const localHost = host === "localhost"
    || host === "127.0.0.1"
    || host === "::1";
  const replitDevelopmentHost = host.endsWith(".replit.dev");
  if (!localHost && !replitDevelopmentHost) {
    throw new Error("Only localhost or a Replit development host is allowed.");
  }
  // The repository's local web artifact runs on 19225. Accepting the
  // operator's shorthand `http://127.0.0.1` is useful, but never silently
  // guess a remote/prod port; callers can override this development-only
  // default when their local web process uses another port.
  if (localHost && !parsed.port) {
    const localWebPort = process.env.VISUAL_WEB_PORT ?? "19225";
    if (!/^\d+$/.test(localWebPort) || Number(localWebPort) <= 0 || Number(localWebPort) > 65535) {
      throw new Error("VISUAL_WEB_PORT must be a valid development port.");
    }
    parsed.port = localWebPort;
  }
  return parsed.toString().replace(/\/$/, "");
}

function menuPermissionsForVisualFixture(): string {
  const permissions: Record<string, boolean> = {};
  for (const key of CANONICAL_MENU_PERMISSION_KEYS) {
    permissions[key] = key === "simple_manufacturing";
  }
  return JSON.stringify(permissions);
}

function vatNumberForTag(tag: string): string {
  const digits = BigInt(`0x${tag}`).toString().slice(-14).padStart(14, "0");
  return `3${digits}`;
}

async function assertOwnedFixture(tx: any, fixture: Fixture): Promise<void> {
  const [company] = await tx
    .select({
      id: companiesTable.id,
      code: companiesTable.code,
      crNumber: companiesTable.crNumber,
      nameAr: companiesTable.nameAr,
      isSandbox: companiesTable.isSandbox,
    })
    .from(companiesTable)
    .where(and(
      eq(companiesTable.id, fixture.companyId),
      eq(companiesTable.code, fixture.companyCode),
      eq(companiesTable.crNumber, fixture.crNumber),
      eq(companiesTable.nameAr, fixture.nameAr),
      eq(companiesTable.isSandbox, true),
    ))
    .limit(1);
  if (!company) {
    throw new Error("The visual fixture ownership check failed for the company.");
  }

  const [admin] = await tx
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(
      eq(usersTable.id, fixture.adminUserId),
      eq(usersTable.companyId, fixture.companyId),
      eq(usersTable.username, fixture.username),
      eq(usersTable.role, "admin"),
    ))
    .limit(1);
  if (!admin) {
    throw new Error("The visual fixture ownership check failed for the admin.");
  }
}

async function createFixture(): Promise<Fixture> {
  const tag = randomBytes(8).toString("hex");
  const companyCode = `SMV-${tag.toUpperCase()}`;
  const username = `smv_admin_${tag}`;
  const password = `SMV-${randomBytes(24).toString("base64url")}`;
  const nameAr = `بيئة معاينة التصنيع المبسط — ${tag}`;
  const nameEn = `Simple Manufacturing Visual Fixture — ${tag}`;
  const crNumber = `SMV-CR-${tag.toUpperCase()}`;
  const passwordHash = await bcrypt.hash(password, 12);

  const created = await db.transaction(async (tx) => {
    const [collision] = await tx
      .select({ id: companiesTable.id })
      .from(companiesTable)
      .where(or(
        eq(companiesTable.code, companyCode),
        eq(companiesTable.crNumber, crNumber),
      ))
      .limit(1);
    if (collision) {
      throw new Error("A visual fixture marker unexpectedly already exists.");
    }

    const [company] = await tx
      .insert(companiesTable)
      .values({
        nameAr,
        nameEn,
        vatNumber: vatNumberForTag(tag),
        crNumber,
        city: "Riyadh",
        street: "Development visual verification",
        buildingNumber: "1",
        postalCode: "00000",
        country: "SA",
        code: companyCode,
        status: "active",
        isSandbox: true,
        menuPermissions: menuPermissionsForVisualFixture(),
      })
      .returning({ id: companiesTable.id });

    await tx.insert(subscriptionsTable).values({
      companyId: company.id,
      plan: "starter",
      maxUsers: 2,
      maxBranches: 1,
      maxWarehouses: 2,
      maxInvoices: 50,
      maxHrUsers: 2,
      billingCycle: "monthly",
      startDate: "2020-01-01",
      endDate: "2999-12-31",
      isActive: true,
      price: "0",
    });

    const [admin] = await tx
      .insert(usersTable)
      .values({
        username,
        passwordHash,
        companyId: company.id,
        role: "admin",
        nameAr: "مدير معاينة التصنيع المبسط",
        nameEn: "Simple Manufacturing Visual Admin",
        permissions: {},
        isActive: true,
      })
      .returning({ id: usersTable.id });

    // Keep the ownership proof inside the creation transaction. If this
    // assertion fails, the transaction rolls back instead of leaving a tenant
    // that the caller cannot safely identify for cleanup.
    const transactionFixture: Fixture = {
      companyId: company.id,
      adminUserId: admin.id,
      tag,
      companyCode,
      username,
      password,
      nameAr,
      nameEn,
      crNumber,
    };
    await assertOwnedFixture(tx, transactionFixture);
    return { companyId: company.id, adminUserId: admin.id };
  });

  return { ...created, tag, companyCode, username, password, nameAr, nameEn, crNumber };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await db.transaction(async (tx) => {
    // Verify the marker, code, sandbox bit, and owned admin before allowing a
    // cascading tenant delete. If any identity changed, fail closed.
    await assertOwnedFixture(tx, fixture);
    const deleted = await tx
      .delete(companiesTable)
      .where(and(
        eq(companiesTable.id, fixture.companyId),
        eq(companiesTable.code, fixture.companyCode),
        eq(companiesTable.crNumber, fixture.crNumber),
        eq(companiesTable.nameAr, fixture.nameAr),
        eq(companiesTable.isSandbox, true),
      ))
      .returning({ id: companiesTable.id });
    if (deleted.length !== 1 || deleted[0].id !== fixture.companyId) {
      throw new Error("The visual fixture cleanup ownership check failed.");
    }
  });

  const [remaining] = await db
    .select({ id: companiesTable.id })
    .from(companiesTable)
    .where(eq(companiesTable.id, fixture.companyId))
    .limit(1);
  if (remaining) {
    throw new Error("The disposable visual fixture still exists after cleanup.");
  }
}

async function loginAndCapture(
  fixture: Fixture,
  baseURL: string,
  outputPath: string,
): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.VISUAL_CHROMIUM_PATH ? { executablePath: process.env.VISUAL_CHROMIUM_PATH } : {}),
  });
  try {
    const context = await browser.newContext({
      baseURL,
      locale: "ar-SA",
      viewport: { width: 1440, height: 1000 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(VISUAL_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(VISUAL_TIMEOUT_MS);

    await runStage("auth-page", () => page.goto("/login", { waitUntil: "domcontentloaded" }));

    await runStage("auth-login", async () => {
      const loginResult = await page.evaluate(async (credentials) => {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(credentials),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || typeof body.token !== "string" || typeof body.sessionId !== "string") {
          return { ok: false, status: response.status };
        }
        // Keep the real session entirely inside the browser context. The token
        // is never returned to Node, logged, or written to a file.
        localStorage.setItem("zatca_token", body.token);
        localStorage.setItem("zatca_session", body.sessionId);
        return { ok: true, status: response.status };
      }, {
        username: fixture.username,
        password: fixture.password,
        companyCode: fixture.companyCode,
      });
      console.log(`[visual] stage=auth-login-http status=${loginResult.status}`);
      if (!loginResult.ok) {
        throw new Error("The disposable admin could not sign in through the real login endpoint.");
      }
    });

    await runStage("auth-me", async () => {
      const authResult = await page.evaluate(async (expectedCompanyId) => {
        const token = localStorage.getItem("zatca_token");
        if (!token) return { ok: false, status: 0 };
        const response = await fetch("/api/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await response.json().catch(() => ({}));
        return {
          ok: response.ok
            && body.role === "admin"
            && body.companyId === expectedCompanyId,
          status: response.status,
        };
      }, fixture.companyId);
      console.log(`[visual] stage=auth-me-http status=${authResult.status}`);
      if (!authResult.ok) {
        throw new Error("The browser session did not resolve to the owned admin tenant.");
      }
    });

    await runStage("route-api-readiness", async () => {
      const catalogResponse = page.waitForResponse(
        (response) => {
          const path = new URL(response.url()).pathname;
          return response.request().method() === "GET"
            && path.endsWith("/api/simple-manufacturing/catalog");
        },
        { timeout: VISUAL_TIMEOUT_MS },
      );
      const ordersResponse = page.waitForResponse(
        (response) => {
          const path = new URL(response.url()).pathname;
          return response.request().method() === "GET"
            && path.endsWith("/api/simple-manufacturing/orders");
        },
        { timeout: VISUAL_TIMEOUT_MS },
      );
      await page.goto("/simple-manufacturing", { waitUntil: "domcontentloaded" });
      const [catalogResult, ordersResult] = await Promise.allSettled([catalogResponse, ordersResponse]);

      if (catalogResult.status === "fulfilled") {
        console.log(`[visual] stage=api-catalog status=http-${catalogResult.value.status()}`);
      } else {
        console.log("[visual] stage=api-catalog status=timeout-or-missing");
      }
      if (ordersResult.status === "fulfilled") {
        console.log(`[visual] stage=api-orders status=http-${ordersResult.value.status()}`);
      } else {
        console.log("[visual] stage=api-orders status=timeout-or-missing");
      }
      if (
        catalogResult.status !== "fulfilled"
        || ordersResult.status !== "fulfilled"
        || !catalogResult.value.ok()
        || !ordersResult.value.ok()
      ) {
        throw new Error("Simple-manufacturing data requests did not succeed.");
      }
    });

    await runStage("ui-list", async () => {
      if (new URL(page.url()).pathname !== "/simple-manufacturing") {
        throw new Error("The browser did not stay on the real simple-manufacturing route.");
      }
      await page.getByRole("heading", { name: "التصنيع المبسط", exact: true }).waitFor({
        state: "visible",
      });
      await page.getByText("لا توجد أوامر بعد", { exact: true }).waitFor({
        state: "visible",
      });
    });

    const listPath = outputPath;
    await runStage("screenshot-list", async () => {
      await page.screenshot({ path: listPath, fullPage: true });
      console.log(`[visual] stage=screenshot-list artifact=${listPath}`);
    });

    await runStage("wizard-tab", () => page.getByRole("tab", { name: "أمر تصنيع جديد", exact: true }).click());
    const wizardPath = derivedCapturePath(outputPath, "-wizard");
    await runStage("screenshot-wizard", async () => {
      await page.screenshot({ path: wizardPath, fullPage: true });
      console.log(`[visual] stage=screenshot-wizard artifact=${wizardPath}`);
    });

    await runStage("costs-tab", async () => {
      await page.getByRole("button", { name: "التكاليف", exact: true }).click();
      await page.getByText("أجور ورواتب (HR)", { exact: true }).waitFor({ state: "visible" });
    });
    const costsPath = derivedCapturePath(outputPath, "-costs");
    await runStage("screenshot-costs", async () => {
      await page.screenshot({ path: costsPath, fullPage: true });
      console.log(`[visual] stage=screenshot-costs artifact=${costsPath}`);
    });
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const outputPath = await runStage("arguments", () => capturePathFromArgs(process.argv.slice(2)));
  const baseURL = await runStage("safety-check", () => visualBaseUrl());
  let fixture: Fixture | null = null;
  try {
    fixture = await runStage("fixture-create", createFixture);
    await runStage("browser-auth-and-capture", () => loginAndCapture(fixture!, baseURL, outputPath));
    console.log("Simple-manufacturing visual capture complete.");
  } finally {
    if (fixture) {
      await runStage("fixture-cleanup", () => cleanupFixture(fixture!));
    } else {
      console.log("[visual] stage=fixture-cleanup status=skipped");
    }
  }
}

try {
  await main();
} catch {
  // Deliberately avoid logging the error object: request bodies, URLs, and
  // driver errors can contain credentials or connection details.
  console.error(`[visual] stage=${activeStage} status=failed`);
  console.error("Simple-manufacturing visual verification failed; no credentials or tokens were printed.");
  process.exitCode = 1;
} finally {
  await centralPool.end().catch(() => undefined);
}