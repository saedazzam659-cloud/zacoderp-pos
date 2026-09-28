// Per-user POST / UNPOST rights (صلاحيات الترحيل وفك الترحيل).
//
// Stored on `users.posting_permissions` as a jsonb map keyed by the SAME
// document categories used by the auto-posting toggles (AutoPostDocType):
//   { "<docType>": { post?: boolean, unpost?: boolean }, ... }
//
// Semantics (chosen explicitly by the product owner):
//   • admin / superadmin → ALWAYS allowed (both post and unpost), regardless
//     of the map. The tab in /users is therefore only meaningful for role=user.
//   • Missing map / missing key / undefined value → ALLOWED (back-compat:
//     every existing user keeps today's behaviour until an admin unchecks).
//   • Explicit `false` → DENIED.
//
// Enforcement points:
//   1. resolvePostingStatus(cid, docType, authUser) — a user without the
//      post right for a doc type gets their auto-generated JE saved as a
//      DRAFT even when the company auto-posting toggle is ON. Someone with
//      the right must post it later from مركز الترحيل.
//   2. /:id/post endpoints → requirePostRight / canPostDoc.
//   3. /:id/unpost endpoints → requireUnpostRight / canUnpostDoc.
import type { AutoPostDocType } from "./postingStatus";
import { canAccessModule } from "../middleware/permissions.js";

const DEMO_POST_MODULE: Record<string, string> = {
  journalEntry: "journal_entries", sales: "sales_invoices", purchase: "purchase_invoices",
  receipt: "receipt_vouchers", payment: "payment_vouchers", financial: "journal_entries",
  cashTransfer: "journal_entries", payroll: "hr_payroll", production: "production",
  stockMovement: "stock_transfers", goodsReceipt: "warehouses",
  goodsDelivery: "warehouses", adjustment: "stock_adjustments",
  faAcquisition: "fixed_assets", faDepreciation: "fixed_assets", faDisposal: "fixed_assets",
  ctgOutgoingBill: "contracting", ctgIncomingBill: "contracting",
};

function demoPostingRight(user: any, docType: string, action: "post" | "unpost"): boolean | null {
  const module = DEMO_POST_MODULE[docType];
  if (user?.demoOperationalVerified !== true || !module) return null;
  return canAccessModule(user, module, action);
}

type PostingPermsMap = Partial<Record<string, { post?: boolean; unpost?: boolean }>>;

type AuthUserLike = {
  role?: string | null;
  postingPermissions?: PostingPermsMap | null;
  posting_permissions?: PostingPermsMap | null;
} | null | undefined;

function permsOf(user: AuthUserLike): PostingPermsMap | null {
  if (!user) return null;
  const raw = (user as any).postingPermissions ?? (user as any).posting_permissions;
  return raw && typeof raw === "object" ? raw as PostingPermsMap : null;
}

function isPrivileged(user: AuthUserLike): boolean {
  const role = String(user?.role ?? "");
  return role === "admin" || role === "superadmin";
}

/** True unless the user's map EXPLICITLY sets post:false for this doc type. */
export function canPostDoc(user: AuthUserLike, docType: AutoPostDocType | string): boolean {
  if (!user) return true;                 // system/scheduler paths — no user context
  if (isPrivileged(user)) return true;
  const demoRight = demoPostingRight(user, String(docType), "post");
  if (demoRight !== null) return demoRight;
  return permsOf(user)?.[String(docType)]?.post !== false;
}

/** True unless the user's map EXPLICITLY sets unpost:false for this doc type. */
export function canUnpostDoc(user: AuthUserLike, docType: AutoPostDocType | string): boolean {
  if (!user) return true;
  if (isPrivileged(user)) return true;
  const demoRight = demoPostingRight(user, String(docType), "unpost");
  if (demoRight !== null) return demoRight;
  return permsOf(user)?.[String(docType)]?.unpost !== false;
}

const DENY_POST_MSG   = "ليس لديك صلاحية ترحيل هذا النوع من المستندات";
const DENY_UNPOST_MSG = "ليس لديك صلاحية فك ترحيل هذا النوع من المستندات";

/** Express middleware: 403 when the caller lacks the POST right for docType. */
export function requirePostRight(docType: AutoPostDocType | string) {
  return (req: any, res: any, next: any) => {
    if (canPostDoc(req.authUser, docType)) return next();
    res.status(403).json({ error: DENY_POST_MSG });
  };
}

/** Express middleware: 403 when the caller lacks the UNPOST right for docType. */
export function requireUnpostRight(docType: AutoPostDocType | string) {
  return (req: any, res: any, next: any) => {
    if (canUnpostDoc(req.authUser, docType)) return next();
    res.status(403).json({ error: DENY_UNPOST_MSG });
  };
}
