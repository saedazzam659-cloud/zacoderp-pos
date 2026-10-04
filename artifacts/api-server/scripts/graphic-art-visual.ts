/**
 * One-shot capture of real Arabic ERP screens for the Graphic Art proposal.
 * Creates a uniquely-owned development sandbox tenant, captures real routes,
 * then deletes only that tenant. Never run against production.
 */
import { chromium } from "@playwright/test";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import {
  centralPool,
  db,
  branchesTable,
  companiesTable,
  warehousesTable,
  subscriptionsTable,
  usersTable,
  unitsTable,
} from "@workspace/db";
import { CANONICAL_MENU_PERMISSION_KEYS } from "../src/lib/menuPermissionCatalog.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(scriptDir, "../../system-deck-ar/public/graphic-art");
const timeout = 20_000;
let stage = "startup";

type Fixture = {
  tag: string;
  companyId: number;
  adminUserId: number;
  branchId: number;
  companyCode: string;
  username: string;
  password: string;
  nameAr: string;
  crNumber: string;
  unitId: number;
};

function baseUrl(): string {
  if (process.env.NODE_ENV === "production"
    || process.env.REPLIT_DEPLOYMENT === "1"
    || process.env.REPLIT_DEPLOYMENT === "true") {
    throw new Error("Refusing to capture against production.");
  }
  if (process.env.VISUAL_ALLOW_DEV_DB !== "1") {
    throw new Error("Set VISUAL_ALLOW_DEV_DB=1 to use the disposable development tenant.");
  }
  const raw = process.env.VISUAL_BASE_URL
    ?? process.env.E2E_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : undefined);
  if (!raw) throw new Error("A local or Replit development URL is required.");
  const parsed = new URL(raw);
  const host = parsed.hostname.toLowerCase();
  if (!(host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".replit.dev"))) {
    throw new Error("Only localhost and Replit development URLs are allowed.");
  }
  if ((host === "localhost" || host === "127.0.0.1" || host === "::1") && !parsed.port) {
    parsed.port = process.env.VISUAL_WEB_PORT ?? "19225";
  }
  return parsed.toString().replace(/\/$/, "");
}

function vatNumber(tag: string): string {
  return `3${BigInt(`0x${tag}`).toString().slice(-14).padStart(14, "0")}`;
}

async function createFixture(): Promise<Fixture> {
  const tag = randomBytes(8).toString("hex");
  const companyCode = `GAV-${tag.toUpperCase()}`;
  const username = "demo";
  const password = `GAV-${randomBytes(24).toString("base64url")}`;
  const nameAr = "بيانات تجريبية";
  const crNumber = `GAV-CR-${tag.toUpperCase()}`;
  const passwordHash = await bcrypt.hash(password, 12);
  const permissions: Record<string, boolean> = {};
  for (const key of CANONICAL_MENU_PERMISSION_KEYS) permissions[key] = false;
  for (const key of [
    "dashboard",
    "sales_module",
    "purchases_module",
    "cash_module",
    "accounts",
    "accounting_reports",
    "inventory_reports",
  ]) permissions[key] = true;

  const created = await db.transaction(async (tx) => {
    const [company] = await tx.insert(companiesTable).values({
      nameAr,
      nameEn: "Demonstration data",
      vatNumber: vatNumber(tag),
      crNumber,
      city: "بيانات توضيحية",
      street: "بيانات توضيحية",
      buildingNumber: "0",
      postalCode: "00000",
      country: "SA",
      code: companyCode,
      status: "active",
      isSandbox: true,
      menuLayout: "topnav",
      menuPermissions: JSON.stringify(permissions),
    }).returning({ id: companiesTable.id });

    const [branch] = await tx.insert(branchesTable).values({
      companyId: company.id,
      code: "DEMO-BR",
      nameAr: "فرع تجريبي",
      nameEn: "Demo branch",
      isMain: true,
      status: "active",
    }).returning({ id: branchesTable.id });

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

    const [admin] = await tx.insert(usersTable).values({
      username,
      passwordHash,
      companyId: company.id,
      role: "admin",
      nameAr: "مستخدم تجريبي",
      nameEn: "Demo user",
      permissions: {},
      isActive: true,
    }).returning({ id: usersTable.id });

    const [unit] = await tx.insert(unitsTable).values({
      companyId: company.id,
      code: "PCE",
      nameAr: "قطعة",
      nameEn: "Piece",
      conversionFactor: "1",
    }).returning({ id: unitsTable.id });

    return { companyId: company.id, adminUserId: admin.id, branchId: branch.id, unitId: unit.id };
  });

  return { ...created, tag, companyCode, username, password, nameAr, crNumber };
}

async function assertOwnedFixture(tx: any, fixture: Fixture): Promise<void> {
  const [company] = await tx.select({ id: companiesTable.id })
    .from(companiesTable)
    .where(and(
      eq(companiesTable.id, fixture.companyId),
      eq(companiesTable.code, fixture.companyCode),
      eq(companiesTable.crNumber, fixture.crNumber),
      eq(companiesTable.nameAr, fixture.nameAr),
      eq(companiesTable.isSandbox, true),
    )).limit(1);
  const [admin] = await tx.select({ id: usersTable.id })
    .from(usersTable)
    .where(and(
      eq(usersTable.id, fixture.adminUserId),
      eq(usersTable.companyId, fixture.companyId),
      eq(usersTable.username, fixture.username),
      eq(usersTable.role, "admin"),
    )).limit(1);
  if (!company || !admin) throw new Error("Fixture ownership check failed; cleanup stopped.");
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await db.transaction(async (tx) => {
    await assertOwnedFixture(tx, fixture);
    const expectedBranchCode = "DEMO-BR";
    const [branch] = await tx.select({
      id: branchesTable.id,
      code: branchesTable.code,
      nameAr: branchesTable.nameAr,
    }).from(branchesTable).where(and(
      eq(branchesTable.id, fixture.branchId),
      eq(branchesTable.companyId, fixture.companyId),
    )).limit(1);
    const branches = await tx.select({ id: branchesTable.id })
      .from(branchesTable)
      .where(eq(branchesTable.companyId, fixture.companyId));
    const warehouses = await tx.select({
      id: warehousesTable.id,
      code: warehousesTable.code,
      branchId: warehousesTable.branchId,
    }).from(warehousesTable).where(eq(warehousesTable.companyId, fixture.companyId));
    if (
      !branch
      || branch.code !== expectedBranchCode
      || branch.nameAr !== "فرع تجريبي"
      || branches.length !== 1
      || warehouses.length > 1
      || (warehouses.length === 1
        && (warehouses[0].code !== "DEMO-WH" || warehouses[0].branchId !== fixture.branchId))
    ) {
      throw new Error("Fixture child ownership check failed; cleanup stopped.");
    }

    if (warehouses.length === 1) {
      const deletedWarehouse = await tx.delete(warehousesTable).where(and(
        eq(warehousesTable.id, warehouses[0].id),
        eq(warehousesTable.companyId, fixture.companyId),
        eq(warehousesTable.code, "DEMO-WH"),
        eq(warehousesTable.branchId, fixture.branchId),
      )).returning({ id: warehousesTable.id });
      if (deletedWarehouse.length !== 1) throw new Error("Fixture warehouse cleanup did not delete exactly one owned row.");
    }

    const deletedBranch = await tx.delete(branchesTable).where(and(
      eq(branchesTable.id, fixture.branchId),
      eq(branchesTable.companyId, fixture.companyId),
      eq(branchesTable.code, expectedBranchCode),
      eq(branchesTable.nameAr, "فرع تجريبي"),
    )).returning({ id: branchesTable.id });
    if (deletedBranch.length !== 1) throw new Error("Fixture branch cleanup did not delete exactly one owned row.");

    const deleted = await tx.delete(companiesTable).where(and(
      eq(companiesTable.id, fixture.companyId),
      eq(companiesTable.code, fixture.companyCode),
      eq(companiesTable.crNumber, fixture.crNumber),
      eq(companiesTable.nameAr, fixture.nameAr),
      eq(companiesTable.isSandbox, true),
    )).returning({ id: companiesTable.id });
    if (deleted.length !== 1) throw new Error("Fixture cleanup did not delete exactly one owned tenant.");
    await tx.execute(sql`delete from audit_log where company_id = ${fixture.companyId}`);
    await tx.execute(sql`delete from work_sessions where company_id = ${fixture.companyId}`);
  });
}

async function capture(fixture: Fixture, targetUrl: string): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.VISUAL_CHROMIUM_PATH
      ? { executablePath: process.env.VISUAL_CHROMIUM_PATH }
      : {}),
  });
  try {
    const context = await browser.newContext({
      baseURL: targetUrl,
      locale: "ar-SA",
      timezoneId: "Africa/Cairo",
      viewport: { width: 1600, height: 1000 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    await page.addInitScript({
      content: "globalThis.__name = globalThis.__name ?? ((target, name) => { Object.defineProperty(target, 'name', { value: name, configurable: true }); return target; });",
    });
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    const login = await page.evaluate(async (credentials) => {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.token !== "string" || typeof body.sessionId !== "string") {
        return { ok: false, status: response.status };
      }
      localStorage.setItem("zatca_token", body.token);
      localStorage.setItem("zatca_session", body.sessionId);
      return { ok: true, status: response.status };
    }, {
      username: fixture.username,
      password: fixture.password,
      companyCode: fixture.companyCode,
    });
    if (!login.ok) throw new Error(`Sandbox login failed with HTTP ${login.status}.`);
    await page.evaluate(() => localStorage.setItem("i18nextLng", "ar"));

    const seed = await page.evaluate(async ({ unitId, branchId }) => {
      const token = localStorage.getItem("zatca_token");
      if (!token) throw new Error("Browser session was not established.");
      async function post(path: string, body: Record<string, unknown>) {
        const response = await fetch(path, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-App-Language": "ar",
          },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const reason = typeof payload.error === "string" ? payload.error : JSON.stringify(payload);
          throw new Error(`Sandbox seed request failed: ${path} (${response.status}) — ${reason}`);
        }
        return payload;
      }
      const warehouse = await post("/api/inventory/warehouses", {
        code: "DEMO-WH",
        nameAr: "مخزن تجريبي",
        nameEn: "Demo warehouse",
        branchId,
        isDefault: true,
      });
      const materialRows = await Promise.all([
        post("/api/inventory/items", {
          code: "DEMO-ACRYLIC",
          nameAr: "لوح أكريليك · عينة",
          nameEn: "Acrylic sheet · sample",
          itemType: "stock",
          itemNature: "raw",
          unitId,
          costPrice: "80",
          salePrice: "0",
          vatRate: "15",
        }),
        post("/api/inventory/items", {
          code: "DEMO-VINYL",
          nameAr: "رول فينيل · عينة",
          nameEn: "Vinyl roll · sample",
          itemType: "stock",
          itemNature: "raw",
          unitId,
          costPrice: "45",
          salePrice: "0",
          vatRate: "15",
        }),
      ]);
      const finished = await post("/api/inventory/items", {
        code: "DEMO-SIGN",
        nameAr: "لوحة إعلانية مضيئة · عينة",
        nameEn: "Illuminated sign · sample",
        itemType: "stock",
        itemNature: "finished",
        unitId,
        costPrice: "0",
        salePrice: "950",
        vatRate: "15",
        isBundle: true,
      });
      for (const [index, material] of materialRows.entries()) {
        await post(`/api/inventory/items/${finished.id}/bundle/components`, {
          childItemId: material.id,
          qty: index === 0 ? "2" : "1",
          notes: "",
        });
      }
      return { warehouseId: warehouse.id };
    }, { unitId: fixture.unitId, branchId: fixture.branchId });
    if (!Number.isInteger(seed.warehouseId)) throw new Error("Warehouse setup did not return an id.");

    const screens = [
      ["dashboard", "/"],
      ["purchasing", "/purchasing/invoices/new"],
      ["inventory", "/inventory/items"],
      ["quotation", "/sales/quotations/new"],
      ["sales-invoice", "/sales/invoices/new"],
      ["collection", "/sales/settlements"],
      ["cash-receipt", "/cash/receipt-vouchers/new"],
      ["accounting", "/accounting/reports/trial-balance"],
    ] as const;

    for (const [name, route] of screens) {
      stage = `capture-${name}`;
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.getByTestId("topnav-bar").waitFor({ state: "visible" });
      await page.waitForTimeout(900);
      await page.screenshot({ path: resolve(outputDir, `${name}.png`) });
    }

    await context.close();
  } finally {
    await browser.close();
  }
}

let fixture: Fixture | undefined;
try {
  const targetUrl = baseUrl();
  await mkdir(outputDir, { recursive: true });
  stage = "create-sandbox";
  fixture = await createFixture();
  stage = "capture-screens";
  await capture(fixture, targetUrl);
  stage = "cleanup-sandbox";
  await cleanupFixture(fixture);
  fixture = undefined;
  console.log("Captured real Arabic app screens and removed the disposable sandbox tenant.");
} catch (error) {
  console.error(`Graphic Art visual capture stopped at ${stage}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (fixture) {
    try {
      await cleanupFixture(fixture);
      console.log("Removed the disposable sandbox tenant after the failed capture.");
    } catch {
      console.error("Could not prove ownership of the remaining sandbox tenant; no broader cleanup was attempted.");
    }
  }
  await centralPool.end();
}