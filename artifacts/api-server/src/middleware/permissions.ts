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

export function requirePermission(module: string, action: PermAction) {
  return function permGuard(req: Request, res: Response, next: NextFunction) {
    const u = req.authUser;
    if (!u) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (u.role === "superadmin" || u.role === "admin") { next(); return; }
    const map = (u as any).permissions ?? {};
    const ok = !!map[module]?.[action];
    if (ok) { next(); return; }
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

// Router-level granular gate. Same idea as moduleAudit, but checks the
// user's permission for the inferred action before allowing the request
// through. GET/HEAD/OPTIONS are NOT gated here (read access remains
// authentication-based, scoped by tenant via resolveCompanyId).
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
    const action = inferAction(req);
    if (!action) { next(); return; }   // GET/HEAD/OPTIONS pass after auth check
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
    const action = inferAction(req);
    if (!action) { next(); return; }                    // GET/HEAD/OPTIONS untouched after auth check
    const path = req.path || "";
    const hit = map.find(([prefix]) => path.startsWith(prefix));
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
