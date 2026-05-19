import { useEffect, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { userTrackingApi, getCurrentPosition } from "@/lib/userTrackingApi";
import { useToast } from "@/hooks/use-toast";

/**
 * Auto-check-in for users assigned to a tracking zone.
 *
 * Runs once per authenticated session: when a user who is explicitly linked
 * to at least one tracking zone (via tracking_zone_users) logs in or refreshes
 * the page, the browser is asked for geolocation and a visit is auto-created
 * via POST /api/user-tracking/checkin.
 *
 * Skipped silently when:
 *   - user is not authenticated, or has no companyId (e.g. SuperAdmin not
 *     impersonating a company)
 *   - user is not linked to any zone (the all-employees fallback is
 *     intentionally NOT triggered by auto-checkin — see /me-status docstring)
 *   - user already has an active (open) visit
 *   - the browser refuses geolocation (no toast spam on permission denial
 *     unless this is the first call after explicit login)
 *
 * Idempotent inside a single page lifetime via the `ranRef` guard — the user
 * can always check in manually later from /user-tracking if they denied
 * the first prompt.
 */
export function useAutoCheckinOnLogin() {
  const { user, isAuthenticated, actingCompanyId } = useAuth();
  const { toast } = useToast();
  // Track which (userId, actingCompanyId) combo we last ran for, instead of a
  // bare boolean. A bare ref would survive a logout→login cycle inside the
  // same tab and silently skip the second auto-checkin — leaving the user
  // marked "غير متصل" on /user-tracking/live until they hard-refresh.
  // Resetting on userId/actingCompanyId change makes the hook re-fire for
  // every fresh authenticated session, including re-login as the same user.
  const ranForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !user) {
      // Logged out — clear the marker so the next login re-arms the hook.
      ranForRef.current = null;
      return;
    }
    const key = `${user.id}:${actingCompanyId ?? ""}`;
    if (ranForRef.current === key) return;
    // SuperAdmins viewing the platform without an acting company have no
    // companyId scope — skip auto-checkin entirely. Once they "enter" a
    // tenant, this effect re-runs because actingCompanyId changes.
    if (user.role === "superadmin" && !actingCompanyId) return;
    // Block SuperAdmins from being auto-tracked even while impersonating —
    // they should never appear in a tenant's attendance report.
    if (user.role === "superadmin") return;

    ranForRef.current = key;
    void (async () => {
      try {
        const st = await userTrackingApi.meStatus();
        if (!st.isAssignedToZone) return;          // user not bound → skip
        if (st.activeVisitId) return;              // already checked-in → skip

        // Ask the browser for a fix. If the user refuses, fail silently
        // (they'll see the manual check-in button on /user-tracking).
        let pos: { lat: number; lng: number; accuracy: number };
        try {
          pos = await getCurrentPosition();
        } catch (geoErr: any) {
          // Permission denied / timeout — surface a gentle hint exactly once.
          toast({
            title: "تتبع الزيارات",
            description: "أنت مُعيَّن على منطقة تتبع لكن المتصفح رفض تحديد موقعك. يمكنك تسجيل الزيارة يدوياً من شاشة تتبع المواقع.",
            variant: "destructive",
          });
          return;
        }

        await userTrackingApi.checkin({
          lat: pos.lat,
          lng: pos.lng,
          accuracy: pos.accuracy,
          purpose: "تسجيل دخول للنظام",
        });

        const zoneNames = st.zones.map(z => z.name).join("، ");
        toast({
          title: "✅ تم تسجيل بداية الدوام",
          description: zoneNames
            ? `تم تسجيل زيارة جديدة تلقائياً ضمن نطاق المنطقة: ${zoneNames}`
            : "تم تسجيل زيارة جديدة تلقائياً وفقاً للمنطقة المُعيَّنة لك.",
        });
      } catch {
        // Any other failure (offline, server error, race with manual checkin):
        // stay silent. User can still work — auto-checkin is a convenience.
      }
    })();
  }, [isAuthenticated, user, actingCompanyId, toast]);
}
