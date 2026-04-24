// Express request augmentation: superadmin routes set `req.adminUser` after
// the requireSuperAdmin middleware resolves the bearer token. Declared here
// so handlers can access it without `any` casts.
import type { usersTable } from "@workspace/db";

type ResolvedAdminUser = typeof usersTable.$inferSelect;

declare global {
  namespace Express {
    interface Request {
      adminUser?: ResolvedAdminUser;
    }
  }
}

export {};
