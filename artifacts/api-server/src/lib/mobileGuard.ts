import { and, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { isMobileChannel, mobilePermAllowed } from "./mobilePerms.js";

// ─── Server-side gate for mobile-app action permissions ─────────────────────
// Applies ONLY when the request comes from the mobile companion app —
// decided by the SESSION's opening channel (users.session_channel, set at
// login) OR the per-request x-app-channel header, so dropping the header on
// a mobile session cannot un-bind enforcement. Web/desktop callers pass.
//
// Returns true when allowed; otherwise writes the 403 response and returns
// false (caller must `return` immediately).
export async function requireMobilePerm(
  req: any,
  res: any,
  companyId: number,
  key: string,
  message: string,
): Promise<boolean> {
  const role = req.authUser?.role;
  if (role === "admin" || role === "superadmin") return true;
  const uid = Number(req.authUser?.id);
  if (!Number.isFinite(uid) || uid <= 0) return true; // other guards handle auth
  const [u] = await db
    .select({
      mobilePermissions: usersTable.mobilePermissions,
      role: usersTable.role,
      sessionChannel: usersTable.sessionChannel,
    })
    .from(usersTable)
    .where(and(eq(usersTable.id, uid), eq(usersTable.companyId, companyId)));
  if (!u) return true;
  if (u.sessionChannel !== "mobile" && !isMobileChannel(req)) return true;
  if (mobilePermAllowed({ role: u.role, mobilePermissions: u.mobilePermissions }, key)) return true;
  res.status(403).json({ error: message });
  return false;
}
