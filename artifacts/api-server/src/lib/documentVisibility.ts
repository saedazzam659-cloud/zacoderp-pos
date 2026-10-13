import { eq } from "drizzle-orm";

export type DocumentVisibilityKey =
  | "salesInvoicesOwn"
  | "salesReturnsOwn"
  | "purchaseInvoicesOwn"
  | "purchaseReturnsOwn"
  | "salesReportsOwn"
  | "purchaseReportsOwn"
  | "receiptVouchersOwn"
  | "paymentVouchersOwn";

export function isOwnDocumentOnly(req: any, key: DocumentVisibilityKey): boolean {
  const role = req.authUser?.role;
  if (role === "admin" || role === "superadmin") return false;
  return req.authUser?.permissions?.__dataVisibility?.[key] === true;
}

/**
 * Per-user document/report visibility is opt-in. Company admins and
 * superadmins keep their existing company-wide visibility.
 */
export function ownDocumentFilter(req: any, key: DocumentVisibilityKey, ownerColumn: any): any[] {
  if (!isOwnDocumentOnly(req, key)) return [];
  const userId = Number(req.authUser?.id);
  return Number.isSafeInteger(userId) && userId > 0 ? [eq(ownerColumn, userId)] : [eq(ownerColumn, -1)];
}

