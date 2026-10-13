import { eq } from "drizzle-orm";

export type DocumentVisibilityKey =
  | "salesInvoicesOwn"
  | "salesReturnsOwn"
  | "purchaseInvoicesOwn"
  | "purchaseReturnsOwn"
  | "salesReportsOwn"
  | "purchaseReportsOwn";

/**
 * Per-user document/report visibility is opt-in. Company admins and
 * superadmins keep their existing company-wide visibility.
 */
export function ownDocumentFilter(req: any, key: DocumentVisibilityKey, ownerColumn: any): any[] {
  const role = req.authUser?.role;
  if (role === "admin" || role === "superadmin") return [];
  const settings = req.authUser?.permissions?.__dataVisibility;
  if (settings?.[key] !== true) return [];
  const userId = Number(req.authUser?.id);
  return Number.isSafeInteger(userId) && userId > 0 ? [eq(ownerColumn, userId)] : [eq(ownerColumn, -1)];
}

