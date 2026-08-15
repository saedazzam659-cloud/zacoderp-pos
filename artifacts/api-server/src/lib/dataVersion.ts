import { sessionEvents, type SessionEvent } from "./sessionEvents.js";

// ─── Per-company data version (live sync) ───────────────────────────────────
// In-memory counter bumped after every successful mutating /api request for a
// company. Clients discover changes two ways:
//   • Web: SSE "data_changed" event on /api/realtime/session-events.
//   • Mobile: polls GET /api/realtime/data-version every few seconds
//     (EventSource is not available in React Native fetch).
// Single-process state by design — the app runs as one deployment instance,
// and a lost bump only means the client waits for its next natural refetch.

const MAX_TRACKED_COMPANIES = 20_000;
const versions = new Map<number, number>();
const pendingEmit = new Map<number, ReturnType<typeof setTimeout>>();

export function getDataVersion(companyId: number): number {
  return versions.get(companyId) ?? 0;
}

/** Bump the company's data version and emit a debounced SSE ping (400ms). */
export function bumpDataVersion(companyId: number | null | undefined): void {
  if (companyId == null || !Number.isFinite(Number(companyId))) return;
  const cid = Number(companyId);
  // حارس نمو الذاكرة: عدد الشركات محدود عملياً، لكن لو تجاوزنا السقف نبدأ
  // من جديد — أسوأ أثر هو إعادة جلب واحدة لدى العملاء المفتوحين.
  if (!versions.has(cid) && versions.size >= MAX_TRACKED_COMPANIES) versions.clear();
  versions.set(cid, (versions.get(cid) ?? 0) + 1);
  if (pendingEmit.has(cid)) return; // debounce burst mutations
  pendingEmit.set(
    cid,
    setTimeout(() => {
      pendingEmit.delete(cid);
      const payload: SessionEvent = {
        type: "data_changed",
        companyId: cid,
        meta: { v: versions.get(cid) ?? 0 },
      };
      sessionEvents.emit("event", payload);
    }, 400),
  );
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Express middleware: after any successful mutating /api request, bump the
 * acting company's data version. companyId is resolved from the authenticated
 * user (set by the per-router auth middleware before the response finishes).
 */
export function dataVersionMiddleware(req: any, res: any, next: any): void {
  if (MUTATING.has(req.method)) {
    res.on("finish", () => {
      try {
        if (res.statusCode >= 400) return;
        const p = String(req.originalUrl || req.url || "");
        // auth endpoints (login/logout/refresh) are not data mutations
        if (p.startsWith("/api/auth/")) return;
        // الهوية من المستخدم الموثَّق فقط (auth middleware يضبط req.authUser
        // قبل اكتمال الاستجابة). السوبر أدمن يعمل باسم شركة أخرى عبر
        // companyId في الطلب — نقبله له حصراً، ولا نثق بجسم الطلب لغيره.
        const au = req.authUser;
        if (!au) return;
        let cid: number | null = au.companyId != null ? Number(au.companyId) : null;
        if (au.role === "superadmin") {
          const acting = req.body?.companyId ?? req.query?.companyId;
          const n = Number(acting);
          if (acting != null && Number.isFinite(n)) cid = n;
        }
        bumpDataVersion(cid);
      } catch {
        /* never break the response path */
      }
    });
  }
  next();
}
