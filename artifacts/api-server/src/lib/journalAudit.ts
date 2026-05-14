import type { Request } from "express";
import { clientIpFrom } from "./deviceFingerprint.js";

// ─── Journal-entry audit-trail helpers ────────────────────────────────
// Captures the authenticated user, IP, and user-agent at the moment a
// journal entry is created or posted. Returns plain objects you can
// spread into a Drizzle .values({...}) or .set({...}) call so the
// audit fields survive every insert/update site without bespoke wiring.
//
// All fields are optional so call sites that don't have a `req` (e.g.
// background jobs, admin data-copy) can simply skip them.

const UA_LIMIT = 500;

export function createdAuditFor(req: Request | undefined | null) {
  if (!req) return {};
  const ua = req.headers?.["user-agent"]?.toString().slice(0, UA_LIMIT) ?? null;
  return {
    createdBy:        (req as any).authUser?.id ?? null,
    createdIp:        clientIpFrom(req as any),
    createdUserAgent: ua,
  };
}

export function postedAuditFor(req: Request | undefined | null, when: Date = new Date()) {
  if (!req) return { postedAt: when };
  const ua = req.headers?.["user-agent"]?.toString().slice(0, UA_LIMIT) ?? null;
  return {
    postedBy:        (req as any).authUser?.id ?? null,
    postedAt:        when,
    postedIp:        clientIpFrom(req as any),
    postedUserAgent: ua,
  };
}

// Convenience for system-generated entries (sales/purchase invoices,
// vouchers, stock movements, production, …). Always returns the
// created_* fields; the posted_* fields are included **only** when the
// JE is actually being inserted with status "posted". This prevents
// false forensic data when the tenant has auto-post turned OFF and the
// resolved status comes back as "draft" — in that case the entry hasn't
// been posted yet and the posted_* trail must remain NULL until a
// human (or downstream automation) explicitly posts it.
//
// Pass the resolved status whenever you have it; omitting it keeps the
// legacy "stamp both" behaviour for the rare caller that knows the row
// is going in as posted.
export function fullAuditFor(req: Request | undefined | null, status?: string) {
  const created = createdAuditFor(req);
  if (status !== undefined && status !== "posted") return created;
  return { ...created, ...postedAuditFor(req) };
}
