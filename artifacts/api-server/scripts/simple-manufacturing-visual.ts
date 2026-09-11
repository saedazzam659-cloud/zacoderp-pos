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
  unitsTable,
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
  unitCode: string;
  fallbackUnitCode: string;
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

    // Units are master data rather than a simple-manufacturing mutation. Keep
    // them inside this owned fixture transaction; the browser then exercises
    // the real facade using these tenant-scoped unit codes.
    await tx.insert(unitsTable).values([
      { companyId: company.id, code: "PCE", nameAr: "حبة", nameEn: "Piece", conversionFactor: "1" },
      { companyId: company.id, code: "BAG", nameAr: "كيس", nameEn: "Bag", conversionFactor: "1" },
    ]);

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
      unitCode: "BAG",
      fallbackUnitCode: "PCE",
    };
    await assertOwnedFixture(tx, transactionFixture);
    return { companyId: company.id, adminUserId: admin.id };
  });

  return {
    ...created,
    tag,
    companyCode,
    username,
    password,
    nameAr,
    nameEn,
    crNumber,
    unitCode: "BAG",
    fallbackUnitCode: "PCE",
  };
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
    // tsx preserves nested function names through this helper; evaluated
    // browser functions do not inherit the Node-side helper.
    await page.addInitScript("window.__name = (fn) => fn;");
    page.on("console", (message) => {
      if (message.text().startsWith("[visual]")) console.log(message.text());
    });
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

    const seeded = await runStage("setup-seed", async () => page.evaluate(async (seed) => {
      const token = localStorage.getItem("zatca_token");
      if (!token) throw new Error("The browser session token is missing.");

      async function request(path: string, body: Record<string, unknown>): Promise<any> {
        const response = await fetch(path, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        console.log(`[visual] stage=setup-request path=${path} status=${response.status}`);
        if (!response.ok) {
          throw new Error(`Setup request failed: ${path} (${response.status})`);
        }
        return payload;
      }

      const material = await request("/api/simple-manufacturing/setup/materials", {
        code: "RAW-FLOUR",
        nameAr: "دقيق",
        nameEn: "Flour",
        itemNature: "raw",
      });
      const secondMaterial = await request("/api/simple-manufacturing/setup/materials", {
        code: "RAW-YEAST",
        nameAr: "خميرة",
        nameEn: "Yeast",
        itemNature: "raw",
      });
      const product = await request("/api/simple-manufacturing/setup/products", {
        code: "FG-BREAD",
        nameAr: "خبز عربي",
        nameEn: "Arabic Bread",
        itemNature: "finished",
      });
      if (!Number.isInteger(material?.id) || !Number.isInteger(secondMaterial?.id)
          || !Number.isInteger(product?.id)) {
        throw new Error("The setup item responses did not contain numeric ids.");
      }

      const bom = await request("/api/simple-manufacturing/setup/bom", {
        productItemId: product.id,
        nameAr: "وصفة الخبز اليومية",
        nameEn: "Daily Bread Recipe",
        outputQty: 12,
        outputUnitCode: seed.unitCode,
        lines: [{
          itemId: material.id,
          quantity: 2.5,
          description: material.nameAr,
          unitCode: seed.unitCode,
          notes: "وحدة شراء اختيارية",
        }, {
          itemId: secondMaterial.id,
          quantity: 0.1,
          description: secondMaterial.nameAr,
          // Deliberately omitted: the facade must store the real PCE fallback.
        }],
      });
      const routing = await request("/api/simple-manufacturing/setup/routing", {
        productItemId: product.id,
        nameAr: "خط إنتاج الخبز",
        nameEn: "Bread Production Line",
        stages: [
          {
            code: "MIX",
            nameAr: "العجن",
            nameEn: "Mixing",
            expectedDurationMinutes: 15,
            expectedWasteRatio: 0.01,
            expectedCost: 12,
          },
          {
            code: "PACK",
            nameAr: "التعبئة",
            nameEn: "Packing",
            expectedDurationMinutes: 20,
            expectedWasteRatio: 0.02,
            expectedCost: 8,
          },
        ],
      });
      const template = await request("/api/simple-manufacturing/templates", {
        name: "إنتاج الخبز اليومي",
        configuration: {
          productItemId: product.id,
          plannedQty: 12,
          unitCode: seed.unitCode,
          bomTemplateId: bom?.id ?? null,
          routingId: routing?.id ?? null,
        },
      });
      const warehouse = await request("/api/simple-manufacturing/setup/warehouses", {
        code: "WH-MAIN",
        nameAr: "مخزن الإنتاج",
        nameEn: "Production Warehouse",
        isDefault: true,
      });
      if (!Number.isInteger(bom?.id) || !Number.isInteger(routing?.id)
          || !Number.isInteger(template?.id) || !Number.isInteger(warehouse?.id)) {
        throw new Error("A setup response did not contain a numeric id.");
      }

      const bomDetailResponse = await fetch(`/api/simple-manufacturing/bom-templates/${bom.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const bomDetail = await bomDetailResponse.json().catch(() => ({}));
      const explicitUnitLine = Array.isArray(bomDetail?.lines)
        ? bomDetail.lines.find((line: any) => line.itemId === material.id)
        : undefined;
      const defaultUnitLine = Array.isArray(bomDetail?.lines)
        ? bomDetail.lines.find((line: any) => line.itemId === secondMaterial.id)
        : undefined;
      console.log(`[visual] stage=setup-bom-detail path=/api/simple-manufacturing/bom-templates/:id status=${bomDetailResponse.status}`
        + ` lines=${Array.isArray(bomDetail?.lines) ? bomDetail.lines.length : "none"}`
        + ` outputUnit=${typeof bomDetail?.outputUnitCode === "string" ? bomDetail.outputUnitCode : "missing"}`
        + ` explicitUnit=${explicitUnitLine?.unitCode ?? "missing"}`
        + ` defaultUnit=${defaultUnitLine?.unitCode ?? "missing"}`);
      if (!bomDetailResponse.ok || bomDetail?.outputUnitCode !== seed.unitCode
          || !Array.isArray(bomDetail?.lines) || bomDetail.lines.length !== 2
          || explicitUnitLine?.unitCode !== seed.unitCode
          || defaultUnitLine?.unitCode !== seed.fallbackUnitCode) {
        throw new Error("The BOM detail did not preserve explicit and default unit codes.");
      }

      return {
        unitCode: seed.unitCode,
        fallbackUnitCode: seed.fallbackUnitCode,
        materialCode: material.code,
        secondMaterialCode: secondMaterial.code,
        productCode: product.code,
        productId: product.id,
        bomId: bom.id,
        bomName: bom.nameAr,
        routingId: routing.id,
        routingName: routing.nameAr,
        templateId: template.id,
        templateName: template.name,
        warehouseCode: warehouse.code,
        warehouseName: warehouse.nameAr,
      };
    }, {
      unitCode: fixture.unitCode,
      fallbackUnitCode: fixture.fallbackUnitCode,
    }));

    await runStage("setup-reload-and-assert", async () => {
      const catalogResponse = page.waitForResponse(
        (response) => response.request().method() === "GET"
          && new URL(response.url()).pathname.endsWith("/api/simple-manufacturing/catalog"),
        { timeout: VISUAL_TIMEOUT_MS },
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      const response = await catalogResponse;
      if (!response.ok()) throw new Error("The catalog reload request did not succeed.");
      const catalog = await response.json();
      const unit = Array.isArray(catalog.units)
        ? catalog.units.find((row: any) => row.code === seeded.unitCode)
        : undefined;
      const material = catalog.items?.find((row: any) => row.code === seeded.materialCode);
      const product = catalog.items?.find((row: any) => row.code === seeded.productCode);
      const bom = Array.isArray(catalog.bomTemplates)
        ? catalog.bomTemplates.find((row: any) => row.id === seeded.bomId
          || row.nameAr === seeded.bomName)
        : undefined;
      const routing = catalog.routings?.find((row: any) => row.id === seeded.routingId
        || row.nameAr === seeded.routingName);
      const template = catalog.templates?.find((row: any) => row.id === seeded.templateId
        || row.name === seeded.templateName);
      const stageCount = Array.isArray(routing?.stages)
        ? routing.stages.length
        : Number(routing?.stagesCount ?? 0);
      if (!unit || !material || !product || !bom || !routing || !template
          || !catalog.warehouses?.some((row: any) => row.code === seeded.warehouseCode)
          || !catalog.units?.some((row: any) => row.code === seeded.fallbackUnitCode)
          || Number(bom.linesCount ?? 0) !== 2
          || stageCount < 2) {
        throw new Error("Reloaded catalog did not contain all saved setup records.");
      }
      console.log("[visual] stage=setup-catalog status=contains-seeded-records");
    });

    const listPath = outputPath;
    await runStage("screenshot-list", async () => {
      await page.screenshot({ path: listPath, fullPage: true });
      console.log(`[visual] stage=screenshot-list artifact=${listPath}`);
    });

    await runStage("settings-tab", async () => {
      await page.getByRole("tab", { name: "الإعدادات", exact: true }).click();
      await Promise.race([
        page.getByText(seeded.templateName, { exact: true }).waitFor({ state: "visible" }),
        page.getByText(seeded.warehouseName, { exact: true }).waitFor({ state: "visible" }),
      ]);
    });
    const settingsPath = "/tmp/simple-manufacturing-settings.png";
    await runStage("screenshot-settings", async () => {
      await page.screenshot({ path: settingsPath, fullPage: true });
      console.log(`[visual] stage=screenshot-settings artifact=${settingsPath}`);
    });

    await runStage("unit-dialog", async () => {
      const unitButton = page.getByRole("button", {
        name: /إضافة وحدة|وحدة جديدة/,
      }).first();
      if (await unitButton.count() === 0) {
        console.log("[visual] stage=unit-dialog status=selector-not-present");
        return;
      }
      await unitButton.click();
      await page.getByRole("dialog").waitFor({ state: "visible" });
      const unitPath = derivedCapturePath(outputPath, "-setup-unit");
      await page.screenshot({ path: unitPath, fullPage: true });
      console.log(`[visual] stage=screenshot-setup-unit artifact=${unitPath}`);
      await page.keyboard.press("Escape");
    });

    await runStage("bom-dialog", async () => {
      const bomButton = page.getByRole("button", {
        name: /إضافة وصفة|ربط قائمة مكونات|قائمة مكونات/,
      }).first();
      await bomButton.waitFor({ state: "visible" });
      await bomButton.click();
      await page.getByRole("dialog").waitFor({ state: "visible" });
    });
    const bomPath = derivedCapturePath(outputPath, "-setup-bom");
    await runStage("screenshot-setup-bom", async () => {
      await page.screenshot({ path: bomPath, fullPage: true });
      console.log(`[visual] stage=screenshot-setup-bom artifact=${bomPath}`);
      await page.keyboard.press("Escape");
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