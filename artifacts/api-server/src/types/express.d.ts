// Express request augmentation: superadmin routes set `req.adminUser` after
// the requireSuperAdmin middleware resolves the bearer token. Declared here
// so handlers can access it without `any` casts.
import type { usersTable } from "@workspace/db";

type ResolvedAdminUser = typeof usersTable.$inferSelect;

declare global {
  namespace Express {
    interface Request {
      adminUser?: ResolvedAdminUser;
      // SuperAdmin "Acting As" target — set by extractAuth from the
      // x-acting-company-id header ONLY for role==="superadmin". Used by
      // resolveCompanyId and audit/log child contexts so impersonated
      // actions remain traceable to the SA.
      actingAsCompanyId?: number;
      // Multi-Domain Management: when a request arrives on a known + active
      // mapped company domain, resolveDomainCompany sets this to that company.
      // It is a LOWEST-priority FALLBACK consumed by resolveCompanyId for
      // superadmins only (explicit ?companyId= and x-acting-company-id still
      // win). Tenant users are always scoped to their own companyId regardless.
      domainCompanyId?: number;
    }
  }
}

export {};
