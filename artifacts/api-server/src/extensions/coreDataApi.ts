import {
  db,
  customersTable,
  itemsTable,
  invoicesTable,
  suppliersTable,
  accountsTable,
} from "@workspace/db";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import type { ExtensionManifest } from "./manifest.js";
import type { ExtensionContext } from "./registry.js";

// ─────────────────────────────────────────────────────────────────────────
// Core Data API — the ONLY bridge between an extension and the system core.
//
// Extensions never import, query, or mutate a core table. They call this
// gated gateway, which:
//   1. EXPOSES only a hand-picked, read-shaped projection of each resource
//      (no secrets, no internal columns),
//   2. ENFORCES the extension's SIGNED manifest permissions
//      (`<resource>:read` / `<resource>:write`),
//   3. ISOLATES every query to the caller's tenant (company_id is forced
//      server-side — an extension can never read another company's data),
//   4. is AUDITED by the router on every call.
//
// This file is the single, deliberate, reviewed seam where core data leaves
// the core. Everything else in the extension subsystem stays core-blind.
// ─────────────────────────────────────────────────────────────────────────

export type CoreAction = "read" | "write";

export interface CoreListOptions {
  search?: string | null;
  limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clampLimit(n: number | undefined): number {
  if (!Number.isFinite(n) || !n || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n as number), MAX_LIMIT);
}

interface CoreResourceDef {
  resource: string;
  // Human labels for catalog/discovery.
  titleAr: string;
  titleEn: string;
  actions: CoreAction[];
  list: (companyId: number, opts: CoreListOptions) => Promise<unknown[]>;
  create?: (companyId: number, body: Record<string, unknown>) => Promise<unknown>;
}

// ── Resource registry ─────────────────────────────────────────────────────
const RESOURCES: Record<string, CoreResourceDef> = {
  customers: {
    resource: "customers",
    titleAr: "العملاء",
    titleEn: "Customers",
    actions: ["read", "write"],
    async list(companyId, opts) {
      const limit = clampLimit(opts.limit);
      const term = (opts.search ?? "").trim();
      const where = term
        ? and(
            eq(customersTable.companyId, companyId),
            or(
              ilike(customersTable.nameAr, `%${term}%`),
              ilike(customersTable.nameEn, `%${term}%`),
              ilike(customersTable.phone, `%${term}%`),
            ),
          )
        : eq(customersTable.companyId, companyId);
      return db
        .select({
          id: customersTable.id,
          nameAr: customersTable.nameAr,
          nameEn: customersTable.nameEn,
          phone: customersTable.phone,
          email: customersTable.email,
          city: customersTable.city,
          vatNumber: customersTable.vatNumber,
        })
        .from(customersTable)
        .where(where)
        .orderBy(desc(customersTable.id))
        .limit(limit);
    },
    async create(companyId, body) {
      const nameAr = String(body.nameAr ?? "").trim();
      if (!nameAr) throw new CoreApiError(400, "EXT_CORE_VALIDATION", "اسم العميل (nameAr) مطلوب");
      const nameEn = body.nameEn != null ? String(body.nameEn).trim() || null : null;
      const phone = body.phone != null ? String(body.phone).trim() || null : null;
      const email = body.email != null ? String(body.email).trim() || null : null;
      const city = body.city != null ? String(body.city).trim() || null : null;
      const vatNumber = body.vatNumber != null ? String(body.vatNumber).trim() || null : null;
      const [row] = await db
        .insert(customersTable)
        .values({ companyId, nameAr, nameEn, phone, email, city, vatNumber })
        .returning({
          id: customersTable.id,
          nameAr: customersTable.nameAr,
          nameEn: customersTable.nameEn,
          phone: customersTable.phone,
        });
      return row;
    },
  },

  items: {
    resource: "items",
    titleAr: "الأصناف",
    titleEn: "Items",
    actions: ["read"],
    async list(companyId, opts) {
      const limit = clampLimit(opts.limit);
      const term = (opts.search ?? "").trim();
      const where = term
        ? and(
            eq(itemsTable.companyId, companyId),
            or(
              ilike(itemsTable.nameAr, `%${term}%`),
              ilike(itemsTable.nameEn, `%${term}%`),
              ilike(itemsTable.code, `%${term}%`),
              ilike(itemsTable.barcode, `%${term}%`),
            ),
          )
        : eq(itemsTable.companyId, companyId);
      return db
        .select({
          id: itemsTable.id,
          code: itemsTable.code,
          nameAr: itemsTable.nameAr,
          nameEn: itemsTable.nameEn,
          barcode: itemsTable.barcode,
          salePrice: itemsTable.salePrice,
          vatRate: itemsTable.vatRate,
          status: itemsTable.status,
        })
        .from(itemsTable)
        .where(where)
        .orderBy(desc(itemsTable.id))
        .limit(limit);
    },
  },

  invoices: {
    resource: "invoices",
    titleAr: "الفواتير",
    titleEn: "Invoices",
    actions: ["read"],
    async list(companyId, opts) {
      const limit = clampLimit(opts.limit);
      const term = (opts.search ?? "").trim();
      const where = term
        ? and(
            eq(invoicesTable.companyId, companyId),
            or(
              ilike(invoicesTable.invoiceNumber, `%${term}%`),
              ilike(invoicesTable.buyerName, `%${term}%`),
            ),
          )
        : eq(invoicesTable.companyId, companyId);
      return db
        .select({
          id: invoicesTable.id,
          invoiceNumber: invoicesTable.invoiceNumber,
          invoiceType: invoicesTable.invoiceType,
          status: invoicesTable.status,
          issueDate: invoicesTable.issueDate,
          currency: invoicesTable.currency,
          grandTotal: invoicesTable.grandTotal,
          vatTotal: invoicesTable.vatTotal,
        })
        .from(invoicesTable)
        .where(where)
        .orderBy(desc(invoicesTable.id))
        .limit(limit);
    },
  },

  suppliers: {
    resource: "suppliers",
    titleAr: "الموردون",
    titleEn: "Suppliers",
    actions: ["read"],
    async list(companyId, opts) {
      const limit = clampLimit(opts.limit);
      const term = (opts.search ?? "").trim();
      const where = term
        ? and(
            eq(suppliersTable.companyId, companyId),
            or(
              ilike(suppliersTable.nameAr, `%${term}%`),
              ilike(suppliersTable.nameEn, `%${term}%`),
              ilike(suppliersTable.phone, `%${term}%`),
            ),
          )
        : eq(suppliersTable.companyId, companyId);
      return db
        .select({
          id: suppliersTable.id,
          code: suppliersTable.code,
          nameAr: suppliersTable.nameAr,
          nameEn: suppliersTable.nameEn,
          phone: suppliersTable.phone,
          email: suppliersTable.email,
          vatNumber: suppliersTable.vatNumber,
        })
        .from(suppliersTable)
        .where(where)
        .orderBy(desc(suppliersTable.id))
        .limit(limit);
    },
  },

  accounts: {
    resource: "accounts",
    titleAr: "دليل الحسابات",
    titleEn: "Chart of Accounts",
    actions: ["read"],
    async list(companyId, opts) {
      const limit = clampLimit(opts.limit);
      const term = (opts.search ?? "").trim();
      const where = term
        ? and(
            eq(accountsTable.companyId, companyId),
            or(
              ilike(accountsTable.nameAr, `%${term}%`),
              ilike(accountsTable.nameEn, `%${term}%`),
              ilike(accountsTable.code, `%${term}%`),
            ),
          )
        : eq(accountsTable.companyId, companyId);
      return db
        .select({
          id: accountsTable.id,
          code: accountsTable.code,
          nameAr: accountsTable.nameAr,
          nameEn: accountsTable.nameEn,
          accountType: accountsTable.accountType,
          isPosting: accountsTable.isPosting,
          isActive: accountsTable.isActive,
        })
        .from(accountsTable)
        .where(where)
        .orderBy(accountsTable.code)
        .limit(limit);
    },
  },
};

export class CoreApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Discovery: what resources/actions the platform offers (for docs/SDK/UI).
export function listCoreResources(): Array<{
  resource: string;
  titleAr: string;
  titleEn: string;
  actions: CoreAction[];
}> {
  return Object.values(RESOURCES).map((r) => ({
    resource: r.resource,
    titleAr: r.titleAr,
    titleEn: r.titleEn,
    actions: r.actions,
  }));
}

// Does the SIGNED manifest grant `<resource>:<action>`?
export function manifestGrants(manifest: ExtensionManifest, resource: string, action: CoreAction): boolean {
  const perms = manifest.permissions ?? [];
  return perms.includes(`${resource}:${action}`);
}

function requireResource(resource: string): CoreResourceDef {
  const def = RESOURCES[resource];
  if (!def) throw new CoreApiError(404, "EXT_CORE_RESOURCE_NOT_FOUND", `مورد غير معروف: ${resource}`);
  return def;
}

function requireCompany(ctx: ExtensionContext): number {
  if (ctx.companyId == null) throw new CoreApiError(400, "EXT_NO_COMPANY", "لم يتم تحديد الشركة");
  return ctx.companyId;
}

function ensureGranted(manifest: ExtensionManifest, resource: string, action: CoreAction): void {
  if (!manifestGrants(manifest, resource, action)) {
    throw new CoreApiError(
      403,
      "EXT_PERMISSION_DENIED",
      `الإضافة لا تملك صلاحية ${resource}:${action}`,
    );
  }
}

// ── The gated operations ────────────────────────────────────────────────
export async function coreList(
  manifest: ExtensionManifest,
  ctx: ExtensionContext,
  resource: string,
  opts: CoreListOptions,
): Promise<unknown[]> {
  const def = requireResource(resource);
  if (!def.actions.includes("read")) {
    throw new CoreApiError(405, "EXT_CORE_ACTION_UNSUPPORTED", `القراءة غير مدعومة لـ ${resource}`);
  }
  ensureGranted(manifest, resource, "read");
  const companyId = requireCompany(ctx);
  return def.list(companyId, opts);
}

export async function coreCreate(
  manifest: ExtensionManifest,
  ctx: ExtensionContext,
  resource: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const def = requireResource(resource);
  if (!def.actions.includes("write") || !def.create) {
    throw new CoreApiError(405, "EXT_CORE_ACTION_UNSUPPORTED", `الكتابة غير مدعومة لـ ${resource}`);
  }
  ensureGranted(manifest, resource, "write");
  const companyId = requireCompany(ctx);
  return def.create(companyId, body);
}
