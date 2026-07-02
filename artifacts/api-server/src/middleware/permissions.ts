import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { auditLogTable } from "@workspace/db";

// ─────────────────────────────────────────────────────────────────────────
// Granular permission middleware
//
// Pairs with `extractAuth`. Call AFTER auth has populated req.authUser.
//   router.post("/", requirePermission("sales_invoices", "create"), handler)
//
// Rules:
//   - unauthenticated → 401
//   - role === "superadmin" or "admin" → bypass (full access)
//   - else → check `permissions[module][action] === true`, else 403
//
// IMPORTANT:
//   - We log the denial to the audit table so admins can see attempted access.
//   - Do NOT use this on read endpoints that intentionally allow any logged-in
//     user — only call where granular gating is desired.
// ─────────────────────────────────────────────────────────────────────────

export type PermAction = "view" | "create" | "edit" | "delete" | "post" | "export";

// Maps the granular per-action module key (used by users.permissions and by
// every requirePermission(...) call below) to the high-level company-module
// key shown on the SuperAdmin → MenuPermissions screen (companies.menuPermissions).
//
// Keep in sync with COMPANY_MODULE_GATE in artifacts/zatca-invoicing/src/components/Layout.tsx
// and with MENU_ITEMS in artifacts/zatca-invoicing/src/pages/MenuPermissions.tsx.
// When a module key is NOT in this map (system settings like "users", "branches",
// "sequences") no company-level gate applies — only the per-user permission map.
const COMPANY_MODULE_GATE: Record<string, string> = {
  // Sales / Customers
  customers: "sales_module",
  sales_reps: "sales_module",
  sales_quotations: "sales_module",
  sales_invoices: "sales_module",
  sales_returns: "sales_module",
  sales_settlements: "sales_module",
  sales_reports: "sales_reports",
  customer_notes: "sales_module",
  // Purchasing / Suppliers
  suppliers: "purchases_module",
  purchase_invoices: "purchases_module",
  purchase_returns: "purchases_module",
  supplier_settlements: "purchases_module",
  supplier_notes: "purchases_module",
  // Cash & Banks
  cash_boxes: "cash_module",
  bank_accounts: "cash_module",
  receipt_vouchers: "cash_module",
  payment_vouchers: "cash_module",
  // Accounting / Ledger
  accounts: "accounts",
  taxes: "accounts",
  journal_entries: "accounts",
  accounting_reports: "accounting_reports",
  accounting_maintenance: "accounting_maintenance",
  // POS
  pos: "pos",
  // Inventory
  items: "inventory_reports",
  warehouses: "inventory_reports",
  stock_transfers: "inventory_reports",
  stock_adjustments: "inventory_reports",
  stock_counts: "inventory_reports",
  // HR
  hr_employees: "hr_module",
  hr_attendance: "hr_module",
  hr_face_attendance: "hr_module",
  hr_loans: "hr_module",
  hr_payroll: "hr_module",
  hr_eos: "hr_module",
  hr_calculators: "hr_module",
  hr_settings: "hr_module",
  // ZATCA
  zatca_setup: "zatca",
  zatca_bridge: "zatca",
  zatca_report: "zatca",
  // Operations
  contracting: "contracting",
  production: "production",
  // Occupational Safety & Health (OSH / ISO 45001). Standalone company gate
  // keyed `safety`; mirror in frontend COMPANY_MODULE_GATE. Disabling it hides
  // the sidebar group AND 403s every /api/safety/* call regardless of per-user
  // grants. The three per-screen permission keys (dashboard / risk / incidents)
  // all roll up to the single `safety` company toggle while remaining
  // independently grantable per user.
  safety: "safety",
  safety_dashboard: "safety",
  safety_risk: "safety",
  safety_incidents: "safety",
  maintenance: "maintenance",
  installments: "installments",
  hotel: "hotel",
  hospital: "hospital",
  crm: "crm",
  fixed_assets: "fixed_assets",
  security_events: "security_events",
  // SEO Manager — per-company analytics surface backed by the platform-wide
  // /api/admin/seo router. Disabling this gate hides the entire SEO dashboard
  // for that company AND 403s any /api/seo/* call.
  seo_dashboard: "seo_dashboard",
  // AI Tools & spun-out groups — keep in sync with frontend gate. AI Reports
  // stays under the `ai_tools` company toggle; the voice assistant, sessions,
  // internal chat, and data import/export screens each have their own
  // top-level company toggle now (voice_assistant / sessions / chat /
  // company_maintenance). Disabling a toggle hides its sidebar group AND
  // 403s any backend access to its gated modules.
  data_io: "company_maintenance",
  voiceAssistant: "voice_assistant",
  sessions: "sessions",
  chat: "chat",
  ai_reports: "ai_tools",
  // VAT / general invoices
  vat_declaration: "reports",
  // Field Service Management (FSM) — standalone billable module. Mirror
  // of frontend COMPANY_MODULE_GATE; keep both maps in sync. Disabling
  // `field_service` on a company hides the menu AND 403s every
  // /api/hr/field/* call, regardless of per-user grants.
  field_service_locations: "field_service",
  // User Location Tracking — gated standalone module. Disabling
  // `user_tracking` on a company hides the menu AND 403s every
  // /api/user-tracking/* call, regardless of per-user grants.
  user_tracking: "user_tracking",
  field_service_visits:    "field_service",
  field_service_plans:     "field_service",
  field_service_tickets:   "field_service",
  field_service_tracking:  "field_service",
  field_service_reports:   "field_service",
  // Extension Platform (Phase 0) — additive "outer shell". Default OFF: a
  // company sees/uses extensions ONLY after SuperAdmin grants the
  // `extensions_platform` toggle. Mirror in frontend companyModuleGate.ts.
  extensions: "extensions_platform",
  // Zacode Office (أوفيس زاكود) — additive in-browser Word + Excel editor.
  // Default OFF; mirror in frontend companyModuleGate.ts. Single key gates
  // every office route + the sidebar group.
  office: "office",
  // Goods Receipt / Delivery documents (مستندات الاستلام والتسليم) — pure
  // archive module linked to invoices. Single company toggle gates the sidebar
  // group + every /api/delivery-receipt-documents/* call. Mirror in frontend
  // companyModuleGate.ts + Layout.tsx.
  delivery_receipt_docs: "delivery_receipt_docs",
};

// Modules whose gate is LOCKED by default — an ABSENT key means OFF (must be
// explicitly enabled), the inverse of the normal default-on behavior. Used for
// SuperAdmin platform modules that must stay hidden until turned on. Keep in
// sync with companyModuleGate.ts (frontend) + DEFAULT_OFF_KEYS in
// MenuPermissions.tsx.
const MODULE_GATE_DEFAULT_OFF = new Set<string>(["extensions_platform", "office"]);

// True when the company has NOT explicitly disabled the high-level module
// associated with `module`. Mirrors companyAllowsModule() in Layout.tsx —
// missing keys, missing JSON, and unparseable JSON all default to "allowed"
// to avoid breaking legacy companies that never had menuPermissions set —
// EXCEPT for default-locked modules (MODULE_GATE_DEFAULT_OFF) which default OFF.
export function companyAllowsModule(authUser: any, module: string): boolean {
  const gateKey = COMPANY_MODULE_GATE[module];
  if (!gateKey) return true;
  const defaultOff = MODULE_GATE_DEFAULT_OFF.has(gateKey);
  const mp = authUser?.companyMenuPermissions;
  if (!mp || typeof mp !== "object") return !defaultOff;
  return defaultOff ? mp[gateKey] === true : mp[gateKey] !== false;
}

// Pure predicate for the per-action permission decision (NO company gate,
// NO superadmin bypass — those are handled by the callers). Mirrors the
// per-action map check + the POS / sales-rep read bypasses used by
// requirePermission so both stay in lockstep. Company admins always pass.
function userActionAllowed(u: any, module: string, action: PermAction): boolean {
  if (u.role === "admin") return true;
  const map = (u as any).permissions ?? {};
  if (map[module]?.[action]) return true;
  // POS bypass — see requirePermission for the rationale.
  if (
    (module === "sales_invoices" || module === "customers") &&
    map["pos"]?.create &&
    (action === "create" || action === "post" || action === "view" || action === "edit")
  ) {
    return true;
  }
  // Sales-rep lookup bypass — read-only items/warehouses for invoice creators.
  if (
    (module === "items" || module === "warehouses") &&
    action === "view" &&
    (map["sales_invoices"]?.create || map["sales_quotations"]?.create)
  ) {
    return true;
  }
  return false;
}

// Non-middleware boolean form of requirePermission: returns true when the
// user may perform `action` on `module`, applying the same superadmin
// bypass + company module gate + per-action map (with bypasses). Used where
// we must evaluate several modules in one request (e.g. Posting Center
// "عرض الكل" iterates every postable module and keeps only the allowed ones)
// without short-circuiting the whole request the way the middleware does.
export function canAccessModule(authUser: any, module: string, action: PermAction): boolean {
  if (!authUser) return false;
  if (authUser.role === "superadmin") return true;
  if (!companyAllowsModule(authUser, module)) return false;
  return userActionAllowed(authUser, module, action);
}

export function requirePermission(module: string, action: PermAction) {
  return function permGuard(req: Request, res: Response, next: NextFunction) {
    const u = req.authUser;
    if (!u) { res.status(401).json({ error: "غير مصرح" }); return; }
    // Superadmin (platform operator) bypasses every gate.
    if (u.role === "superadmin") { next(); return; }
    // Company-level upper bound — applies to admin AND regular users.
    // When SuperAdmin disables a module on the company, no user from that
    // company (including its own admin) may reach the protected route.
    if (!companyAllowsModule(u, module)) {
      void writeAudit({
        userId: u.id, username: u.username, role: u.role, companyId: u.companyId,
        module, action: "denied",
        method: req.method, path: req.originalUrl, statusCode: 403,
        ip: clientIp(req), userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500),
        metadata: { attemptedAction: action, reason: "company_module_disabled" },
      });
      res.status(403).json({ error: `هذا الموديل غير مفعّل لشركتك — يرجى مراجعة المسؤول` });
      return;
    }
    // Per-action map + admin / POS / sales-rep bypasses.
    if (userActionAllowed(u, module, action)) { next(); return; }
    // Fire-and-forget denial audit (don't block the response)
    void writeAudit({
      userId: u.id, username: u.username, role: u.role, companyId: u.companyId,
      module, action: "denied",
      method: req.method, path: req.originalUrl, statusCode: 403,
      ip: clientIp(req), userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500),
      metadata: { attemptedAction: action },
    });
    res.status(403).json({ error: `صلاحيات غير كافية للوصول إلى ${module}` });
  };
}

// Convenience for legacy usage: "must be admin/superadmin" (no granular check).
export function requireAdminRole(req: Request, res: Response, next: NextFunction) {
  const role = req.authUser?.role;
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (role === "superadmin" || role === "admin") { next(); return; }
  res.status(403).json({ error: "صلاحيات غير كافية — مطلوب مدير" });
}

// ─────────────────────────────────────────────────────────────────────────
// Audit middleware
//
// Use as: router.post("/", audit("sales_invoices", "create"), handler)
// Records the request after the response is sent. Never blocks or throws.
// ─────────────────────────────────────────────────────────────────────────

export interface AuditOpts {
  // Pull entityId from response.locals or request body after handler completes
  getEntityId?: (req: Request, res: Response) => string | number | null | undefined;
  entityType?: string;
}

export function audit(module: string, action: PermAction | "login" | "logout", opts: AuditOpts = {}) {
  return function auditMw(req: Request, res: Response, next: NextFunction) {
    res.on("finish", () => {
      try {
        // Skip audit if request was a permission denial (already logged by requirePermission)
        if (res.statusCode === 401 || res.statusCode === 403) return;
        const u = req.authUser;
        const entityId = opts.getEntityId?.(req, res);
        void writeAudit({
          userId:    u?.id ?? null,
          username:  u?.username ?? null,
          role:      u?.role ?? null,
          companyId: u?.companyId ?? null,
          module, action,
          method:    req.method,
          path:      req.originalUrl?.slice(0, 500) ?? null,
          entityType: opts.entityType ?? null,
          entityId:   entityId != null ? String(entityId).slice(0, 64) : null,
          statusCode: res.statusCode,
          ip:         clientIp(req),
          userAgent:  req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null,
          metadata:   null,
        });
      } catch { /* never let audit failure surface */ }
    });
    next();
  };
}

// Combine guard + audit in one middleware chain.
// Returns an array suitable for Express's middleware varargs.
export function rbac(module: string, action: PermAction, opts: AuditOpts = {}) {
  return [requirePermission(module, action), audit(module, action, opts)] as const;
}

// ─────────────────────────────────────────────────────────────────────────
// Router-level audit middleware.
//
//   router.use(moduleAudit("sales_invoices"));
//
// Records every mutation (POST/PUT/PATCH/DELETE) against the given module
// without touching individual handlers. Reads (GET/HEAD/OPTIONS) are not
// audited to keep the table small. Use this for sweeping coverage; for
// fine-grained module mapping (e.g. multi-purpose routers) call audit()
// per handler instead.
// ─────────────────────────────────────────────────────────────────────────

const METHOD_ACTION: Record<string, PermAction> = {
  POST:   "create",
  PUT:    "edit",
  PATCH:  "edit",
  DELETE: "delete",
};

// Path-suffix → action override. Lets /:id/post, /:id/cancel, /:id/approve,
// /export, etc. be gated and audited as the correct semantic action rather
// than the generic create/edit inferred from the HTTP method.
//
// Order matters: first match wins. Suffixes are checked against the END of
// req.path so they apply to both /:id/post and /post-batch style routes.
const PATH_ACTION_OVERRIDES: Array<[RegExp, PermAction]> = [
  [/\/(post|posting)(\/|$)/i,   "post"],
  [/\/(approve|confirm)(\/|$)/i,"post"],
  [/\/(unpost|reverse|cancel|void)(\/|$)/i, "post"],
  [/\/export(\/|$)/i,           "export"],
];

function inferAction(req: Request): PermAction | null {
  const base = METHOD_ACTION[req.method];
  if (!base) return null;
  // Only override mutating methods — never reclassify GET.
  const path = req.path || "";
  for (const [re, act] of PATH_ACTION_OVERRIDES) {
    if (re.test(path)) return act;
  }
  return base;
}

export function moduleAudit(defaultModule: string) {
  return function moduleAuditMw(req: Request, res: Response, next: NextFunction) {
    const action = inferAction(req);
    if (!action) { next(); return; }   // skip GET/HEAD/OPTIONS
    return audit(defaultModule, action)(req, res, next);
  };
}

// Router-level granular gate. Same idea as moduleAudit, but also checks the
// caller's permission for the inferred action before allowing the request
// through. GET/HEAD/OPTIONS are NOT gated for the per-action map (read access
// remains authentication-based, scoped by tenant via resolveCompanyId), BUT
// they DO go through the company-level module gate so SuperAdmin disabling a
// module on a company also blocks read endpoints for that company.
//
// Apply alongside moduleAudit on routers whose URL paths all belong to
// the same module:
//   router.use(extractAuth);
//   router.use(requireModulePermission("sales_invoices"));
//   router.use(moduleAudit("sales_invoices"));
export function requireModulePermission(defaultModule: string) {
  return function moduleGateMw(req: Request, res: Response, next: NextFunction) {
    // Hard auth gate on EVERY method (incl. GET) — otherwise reads can leak
    // tenant data when extractAuth ran but no Bearer token was supplied.
    if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
    const u = req.authUser;
    // Company-level upper bound also applies to GET/HEAD/OPTIONS — so a
    // disabled module is fully unreachable, not just non-mutable.
    // SuperAdmin (platform operator) bypasses every gate.
    if (u.role !== "superadmin" && !companyAllowsModule(u, defaultModule)) {
      void writeAudit({
        userId: u.id, username: u.username, role: u.role, companyId: u.companyId,
        module: defaultModule, action: "denied",
        method: req.method, path: req.originalUrl, statusCode: 403,
        ip: clientIp(req), userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500),
        metadata: { reason: "company_module_disabled", method: req.method },
      });
      res.status(403).json({ error: `هذا الموديل غير مفعّل لشركتك — يرجى مراجعة المسؤول` });
      return;
    }
    const action = inferAction(req);
    if (!action) { next(); return; }   // GET/HEAD/OPTIONS pass after company gate
    return requirePermission(defaultModule, action)(req, res, next);
  };
}

// Path-based router middleware for multi-purpose routers (e.g. sales.ts which
// hosts /sales-invoices, /sales-returns, /sales-quotations under one router).
//
// Pass an ordered list of [pathPrefix, module] pairs. The first matching prefix
// wins. If nothing matches, the request passes through (no audit, no gate).
//
//   router.use(pathRbac([
//     ["/sales-invoices",     "sales_invoices"],
//     ["/sales-returns",      "sales_returns"],
//     ["/sales-quotations",   "sales_quotations"],
//   ]));
//
// Combines BOTH the granular permission gate (mutations only) AND the audit
// logger (mutations only) for the matched module.
export function pathRbac(map: Array<[string, string]>) {
  return function pathRbacMw(req: Request, res: Response, next: NextFunction) {
    // Hard auth gate on EVERY method (incl. GET) — see requireModulePermission.
    if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
    const path = req.path || "";
    const hit = map.find(([prefix]) => path.startsWith(prefix));
    const matchedMod = hit?.[1] ?? null;
    const u = req.authUser;
    // Company-level upper bound applies to ALL methods (incl. GET) when we
    // know which module this path belongs to, so disabling a module on a
    // company also blocks read endpoints. SuperAdmin bypasses every gate.
    if (matchedMod && u.role !== "superadmin" && !companyAllowsModule(u, matchedMod)) {
      void writeAudit({
        userId: u.id, username: u.username, role: u.role, companyId: u.companyId,
        module: matchedMod, action: "denied",
        method: req.method, path: req.originalUrl, statusCode: 403,
        ip: clientIp(req), userAgent: req.headers["user-agent"]?.toString()?.slice(0, 500),
        metadata: { reason: "company_module_disabled", method: req.method },
      });
      res.status(403).json({ error: `هذا الموديل غير مفعّل لشركتك — يرجى مراجعة المسؤول` });
      return;
    }
    const action = inferAction(req);
    if (!action) { next(); return; }                    // GET/HEAD/OPTIONS untouched after company gate
    if (!hit) { next(); return; }
    const [, mod] = hit;
    // Chain perm gate → audit
    return requirePermission(mod, action)(req, res, (err?: any) => {
      if (err) { next(err); return; }
      return audit(mod, action)(req, res, next);
    });
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────

function clientIp(req: Request): string | null {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0]!.trim().slice(0, 64);
  if (Array.isArray(xf) && xf.length) return String(xf[0]).slice(0, 64);
  return (req.socket?.remoteAddress ?? null)?.slice(0, 64) ?? null;
}

interface WriteRow {
  userId: number | null;
  username: string | null;
  role: string | null;
  companyId: number | null;
  module: string;
  action: string;
  method?: string | null;
  path?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  statusCode?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: any;
}

export async function writeAudit(row: WriteRow): Promise<void> {
  try {
    await db.insert(auditLogTable).values({
      userId:     row.userId,
      username:   row.username,
      role:       row.role,
      companyId:  row.companyId,
      module:     row.module,
      action:     row.action,
      method:     row.method ?? null,
      path:       row.path ?? null,
      entityType: row.entityType ?? null,
      entityId:   row.entityId ?? null,
      statusCode: row.statusCode ?? null,
      ip:         row.ip ?? null,
      userAgent:  row.userAgent ?? null,
      metadata:   row.metadata ?? null,
    });
  } catch (e) {
    // Audit must NEVER break a real request; just log to stderr
    // eslint-disable-next-line no-console
    console.error("[audit] insert failed:", (e as any)?.message ?? e);
  }
}
