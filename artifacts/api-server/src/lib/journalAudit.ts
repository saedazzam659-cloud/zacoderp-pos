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

// Convenience for system-generated entries that are inserted directly
// in `posted` status (sales invoices, vouchers, stock movements, …).
// One call returns BOTH the created* and posted* audit fields, all
// stamped with the same user/ip/ua + timestamp so the audit dialog
// shows a coherent "created and posted simultaneously" trail.
export function fullAuditFor(req: Request | undefined | null) {
  return { ...createdAuditFor(req), ...postedAuditFor(req) };
}
