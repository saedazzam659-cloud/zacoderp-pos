// Per-request AsyncLocalStorage context.
//
// Purpose: let deep library code (e.g. resolvePostingStatus → per-user
// posting rights) see WHO is making the current request without threading
// `req.authUser` through every helper signature (sales/purchase JE builders,
// hr-journals, fa-journals, adjustmentPosting, …).
//
// Wiring:
//   • app.ts mounts `runAuthContext` early — every request runs inside a
//     fresh `{ user: null }` holder.
//   • extractAuth (middleware/auth.ts) calls `setContextAuthUser(req.authUser)`
//     right after it resolves the caller.
//   • Anyone may call `getContextAuthUser()`; it returns null outside a
//     request (schedulers, boot code) — callers must treat null as
//     "system context, no user-level restriction".
import { AsyncLocalStorage } from "node:async_hooks";

type Holder = { user: unknown | null };

const als = new AsyncLocalStorage<Holder>();

/** Express middleware — establishes the per-request context. */
export function runAuthContext(_req: any, _res: any, next: any) {
  als.run({ user: null }, () => next());
}

/** Called by extractAuth once the caller is resolved. No-op outside a request. */
export function setContextAuthUser(user: unknown | null | undefined) {
  const h = als.getStore();
  if (h) h.user = user ?? null;
}

/** The authUser of the current request, or null in system/scheduler context. */
export function getContextAuthUser(): unknown | null {
  return als.getStore()?.user ?? null;
}
