import { Router } from "express";
import { db } from "@workspace/db";
import { userVisitsTable, trackingZonesTable, trackingZoneUsersTable, usersTable, branchesTable } from "@workspace/db";
import { eq, and, or, desc, sql, gte, lte, isNull, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import { extractAuth, resolveCompanyId, branchScopeFilter } from "../middleware/auth.js";
import { requireModulePermission, moduleAudit } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);

// ─── Permission policy ────────────────────────────────────────────────────
// SELF endpoints (checkin, checkout-own, cancel-own, /active, /me-status,
// /visits filtered to own rows, /config) are open to any authenticated
// non-superadmin user. This is required so that a sales rep assigned to a
// tracking zone can auto-checkin on login WITHOUT being granted the
// admin-level `user_tracking` module permission (which would also grant
// access to other employees' visit history).
//
// ADMIN endpoints (zones CRUD, zone-user assignment, /dashboard,
// /company-users, /geocode admin tool) stay gated by the module
// permission via the `adminGate` array below.
const adminGate = [requireModulePermission("user_tracking"), moduleAudit("user_tracking")];

function getCid(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}
function guard(req: any, res: any): number | null {
  const cid = getCid(req);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// Haversine distance (meters)
function distMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Server-side reverse geocode via the FREE OpenStreetMap Nominatim service.
// No API key required. Returns { placeName, address } in Arabic. Never throws
// — geocoding is best-effort; the visit still records lat/lng even on failure.
// Usage policy: max 1 req/sec, must send a descriptive User-Agent + Referer.
async function reverseGeocode(lat: number, lng: number, log: any): Promise<{ placeName: string | null; address: string | null }> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=ar&zoom=18`;
    const r = await fetch(url, {
      headers: {
        "User-Agent": "zatca-invoicing/1.0 (user-tracking module)",
        "Accept-Language": "ar,en;q=0.8",
      },
    });
    if (!r.ok) {
      log?.warn?.({ status: r.status }, "nominatim reverse geocode failed");
      return { placeName: null, address: null };
    }
    const j: any = await r.json();
    const a = j?.address ?? {};
    // Prefer a POI-style name (shop/amenity/building) then locality
    const placeName: string | null =
      a.shop || a.amenity || a.office || a.building || a.tourism ||
      a.leisure || a.industrial || a.public_building ||
      a.neighbourhood || a.suburb || a.village || a.town || a.city ||
      j?.name || null;
    const address: string | null = j?.display_name ?? null;
    return { placeName, address };
  } catch (e: any) {
    log?.warn?.({ err: e?.message }, "nominatim reverse geocode threw");
    return { placeName: null, address: null };
  }
}

// Match a visit lat/lng to the nearest active zone for the company. Returns
// the zone id + a flag string when relevant (out_of_allowed_zone if the point
// is inside an `is_allowed=false` zone, or outside all `is_allowed=true` zones
// when at least one allowed zone is defined).
async function matchZone(cid: number, lat: number, lng: number, userId: number): Promise<{ zoneId: number | null; flag: string | null }> {
  // Pull active zones + the set of users assigned to each. The rule:
  //   - A zone with NO assigned users is global (applies to everyone).
  //   - A zone WITH assigned users applies ONLY to those users.
  // So we filter out any zone that has assignments which do not include this user.
  const rawZones = await db.select({
    z: trackingZonesTable,
    assignedUserId: trackingZoneUsersTable.userId,
  }).from(trackingZonesTable)
    .leftJoin(trackingZoneUsersTable, eq(trackingZoneUsersTable.zoneId, trackingZonesTable.id))
    .where(and(eq(trackingZonesTable.companyId, cid), eq(trackingZonesTable.isActive, true)));

  // Group assignments per zone.
  const map = new Map<number, { zone: typeof trackingZonesTable.$inferSelect; users: Set<number> }>();
  for (const r of rawZones) {
    const e = map.get(r.z.id) ?? { zone: r.z, users: new Set<number>() };
    if (r.assignedUserId != null) e.users.add(r.assignedUserId);
    map.set(r.z.id, e);
  }
  const zones = Array.from(map.values())
    .filter(e => e.users.size === 0 || e.users.has(userId))
    .map(e => e.zone);
  if (zones.length === 0) return { zoneId: null, flag: null };
  let inside: typeof zones[number] | null = null;
  let nearestAllowed: typeof zones[number] | null = null;
  let nearestAllowedDist = Infinity;
  let anyAllowed = false;
  for (const z of zones) {
    const d = distMeters({ lat, lng }, { lat: Number(z.centerLat), lng: Number(z.centerLng) });
    if (d <= z.radiusMeters) inside = z;
    if (z.isAllowed) {
      anyAllowed = true;
      if (d < nearestAllowedDist) { nearestAllowedDist = d; nearestAllowed = z; }
    }
  }
  if (inside && !inside.isAllowed) return { zoneId: inside.id, flag: "in_forbidden_zone" };
  if (inside) return { zoneId: inside.id, flag: null };
  if (anyAllowed && nearestAllowed) {
    return { zoneId: nearestAllowed.id, flag: "out_of_allowed_zone" };
  }
  return { zoneId: null, flag: null };
}

// ───────────────────────── CHECK-IN ─────────────────────────
const checkinSchema = z.object({
  lat: z.coerce.number().refine(v => v >= -90 && v <= 90, "lat out of range"),
  lng: z.coerce.number().refine(v => v >= -180 && v <= 180, "lng out of range"),
  accuracy: z.coerce.number().nonnegative().optional().nullable(),
  purpose: z.string().trim().max(200).optional().nullable(),
  notes:   z.string().trim().max(2000).optional().nullable(),
  branchId: z.coerce.number().int().positive().optional().nullable(),
});

router.post("/checkin", async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  const uid = req.authUser?.id;
  if (!uid) { res.status(401).json({ error: "غير مصرح" }); return; }
  const parsed = checkinSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error.issues }); return; }
  const { lat, lng, accuracy, purpose, notes, branchId } = parsed.data;

  // refuse if an active visit already exists for this user
  const [active] = await db.select({ id: userVisitsTable.id }).from(userVisitsTable).where(and(
    eq(userVisitsTable.companyId, cid),
    eq(userVisitsTable.userId, uid),
    eq(userVisitsTable.status, "active"),
  )).limit(1);
  if (active) {
    res.status(409).json({ error: "لديك زيارة مفتوحة بالفعل. سجل الخروج أولاً.", activeVisitId: active.id });
    return;
  }

  const geo = await reverseGeocode(lat, lng, req.log);
  const zoneMatch = await matchZone(cid, lat, lng, uid);

  const [created] = await db.insert(userVisitsTable).values({
    companyId: cid,
    userId: uid,
    branchId: branchId ?? null,
    purpose: purpose ?? null,
    notes: notes ?? null,
    status: "active",
    checkinLat: String(lat),
    checkinLng: String(lng),
    checkinAccuracy: accuracy != null ? String(accuracy) : null,
    checkinPlace: geo.placeName,
    checkinAddress: geo.address,
    zoneId: zoneMatch.zoneId,
    alertFlags: zoneMatch.flag,
  }).returning();
  res.status(201).json(created);
});

// ───────────────────────── CHECK-OUT ────────────────────────
const checkoutSchema = z.object({
  lat: z.coerce.number().refine(v => v >= -90 && v <= 90, "lat out of range"),
  lng: z.coerce.number().refine(v => v >= -180 && v <= 180, "lng out of range"),
  accuracy: z.coerce.number().nonnegative().optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

router.post("/visits/:id/checkout", async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  const uid = req.authUser?.id;
  const role = req.authUser?.role;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error.issues }); return; }
  const { lat, lng, accuracy, notes } = parsed.data;

  const [visit] = await db.select().from(userVisitsTable).where(and(
    eq(userVisitsTable.id, id), eq(userVisitsTable.companyId, cid),
  )).limit(1);
  if (!visit) { res.status(404).json({ error: "زيارة غير موجودة" }); return; }
  // owner or admin only
  if (visit.userId !== uid && role !== "admin" && role !== "superadmin") {
    res.status(403).json({ error: "ممنوع" }); return;
  }
  if (visit.status !== "active") { res.status(409).json({ error: "لا يمكن إنهاء زيارة غير نشطة" }); return; }

  const geo = await reverseGeocode(lat, lng, req.log);
  const checkoutAt = new Date();
  const durationMin = Math.max(0, Math.round((checkoutAt.getTime() - new Date(visit.checkinAt).getTime()) / 60000));

  // long-stop flag (>8h sticks). Cheap, no per-company setting yet.
  let flags = visit.alertFlags ?? "";
  if (durationMin > 8 * 60) flags = (flags ? flags + "," : "") + "long_stop";

  const [updated] = await db.update(userVisitsTable).set({
    status: "completed",
    checkoutAt,
    checkoutLat: String(lat),
    checkoutLng: String(lng),
    checkoutAccuracy: accuracy != null ? String(accuracy) : null,
    checkoutPlace: geo.placeName,
    checkoutAddress: geo.address,
    durationMinutes: durationMin,
    notes: notes ?? visit.notes,
    alertFlags: flags || null,
    updatedAt: checkoutAt,
  }).where(eq(userVisitsTable.id, id)).returning();
  res.json(updated);
});

// ───────────────────────── CANCEL ───────────────────────────
router.post("/visits/:id/cancel", async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  const uid = req.authUser?.id;
  const role = req.authUser?.role;
  const id = Number(req.params.id);
  const [visit] = await db.select().from(userVisitsTable).where(and(
    eq(userVisitsTable.id, id), eq(userVisitsTable.companyId, cid),
  )).limit(1);
  if (!visit) { res.status(404).json({ error: "زيارة غير موجودة" }); return; }
  if (visit.userId !== uid && role !== "admin" && role !== "superadmin") {
    res.status(403).json({ error: "ممنوع" }); return;
  }
  if (visit.status !== "active") { res.status(409).json({ error: "غير نشطة" }); return; }
  const [u] = await db.update(userVisitsTable).set({
    status: "cancelled", updatedAt: new Date(),
  }).where(eq(userVisitsTable.id, id)).returning();
  res.json(u);
});

// ───────────────── ACTIVE VISIT (current user) ──────────────
router.get("/active", async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  const uid = req.authUser?.id;
  const [row] = await db.select().from(userVisitsTable).where(and(
    eq(userVisitsTable.companyId, cid),
    eq(userVisitsTable.userId, uid),
    eq(userVisitsTable.status, "active"),
  )).orderBy(desc(userVisitsTable.checkinAt)).limit(1);
  res.json(row ?? null);
});

// ───────────────── ME-STATUS (auto-checkin gate) ──────────────
// Lightweight endpoint used by the auth layer on login / page-load to decide
// whether to ask the browser for geolocation and auto-create a check-in visit.
// Returns:
//   - isAssignedToZone: true iff the user is explicitly linked to at least
//     one active zone via tracking_zone_users. Users who are NOT linked to
//     any zone are deliberately excluded from auto-tracking — the global-
//     fallback rule (zone with no assignments applies to all employees) is
//     INTENTIONALLY ignored here so the company doesn't accidentally start
//     tracking every accountant the moment they create one global zone.
//   - activeVisitId: id of an open visit if one exists (skip auto-checkin).
//   - zones: list of zone names the user is bound to (for UI / toast).
router.get("/me-status", async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  const uid = req.authUser?.id;
  if (!uid) { res.status(401).json({ error: "غير مصرح" }); return; }

  const zoneRows = await db.select({
    id: trackingZonesTable.id,
    name: trackingZonesTable.name,
    centerLat: trackingZonesTable.centerLat,
    centerLng: trackingZonesTable.centerLng,
  }).from(trackingZoneUsersTable)
    .innerJoin(trackingZonesTable, eq(trackingZonesTable.id, trackingZoneUsersTable.zoneId))
    .where(and(
      eq(trackingZoneUsersTable.userId, uid),
      eq(trackingZonesTable.companyId, cid),
      eq(trackingZonesTable.isActive, true),
    ));

  const [active] = await db.select({ id: userVisitsTable.id }).from(userVisitsTable).where(and(
    eq(userVisitsTable.companyId, cid),
    eq(userVisitsTable.userId, uid),
    eq(userVisitsTable.status, "active"),
  )).limit(1);

  // Expose each zone's centre coords so the client can fall back to them
  // when the browser denies/timeouts geolocation. Lets auto-checkin succeed
  // purely programmatically without the user needing to fix browser settings.
  res.json({
    isAssignedToZone: zoneRows.length > 0,
    activeVisitId: active?.id ?? null,
    zones: zoneRows.map(z => ({
      id: z.id,
      name: z.name,
      centerLat: Number(z.centerLat),
      centerLng: Number(z.centerLng),
    })),
  });
});

// ───────────────── LIVE TRACKING (admin) ───────────────────
// Returns one row per user that is explicitly assigned to any active zone in
// the company. Each row carries the user's open visit (if any) with its last
// known position and matched zone. Drives the live tracking map. Polled by
// the UI every ~10s. Admin-gated below via `adminGate`.
router.get("/live", ...adminGate, async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;

  // 1) Every user explicitly bound to an active zone in this company (distinct).
  const trackedUsers = await db.selectDistinct({
    id: usersTable.id,
    nameAr: usersTable.nameAr,
    nameEn: usersTable.nameEn,
    username: usersTable.username,
  }).from(trackingZoneUsersTable)
    .innerJoin(trackingZonesTable, and(
      eq(trackingZonesTable.id, trackingZoneUsersTable.zoneId),
      eq(trackingZonesTable.companyId, cid),
      eq(trackingZonesTable.isActive, true),
    ))
    .innerJoin(usersTable, eq(usersTable.id, trackingZoneUsersTable.userId))
    .orderBy(usersTable.username);

  if (trackedUsers.length === 0) { res.json({ users: [] }); return; }

  // 2) Active visits for these users.
  const userIds = trackedUsers.map(u => u.id);
  const activeVisits = await db.select().from(userVisitsTable).where(and(
    eq(userVisitsTable.companyId, cid),
    eq(userVisitsTable.status, "active"),
    inArray(userVisitsTable.userId, userIds),
  ));
  const visitByUser = new Map<number, typeof userVisitsTable.$inferSelect>();
  for (const v of activeVisits) visitByUser.set(v.userId, v);

  // 3) Zone names (for matched visits + assigned zones lookup).
  const zoneRows = await db.select({
    id: trackingZonesTable.id,
    name: trackingZonesTable.name,
    isAllowed: trackingZonesTable.isAllowed,
    centerLat: trackingZonesTable.centerLat,
    centerLng: trackingZonesTable.centerLng,
    radiusMeters: trackingZonesTable.radiusMeters,
    userId: trackingZoneUsersTable.userId,
  }).from(trackingZonesTable)
    .innerJoin(trackingZoneUsersTable, eq(trackingZoneUsersTable.zoneId, trackingZonesTable.id))
    .where(and(
      eq(trackingZonesTable.companyId, cid),
      eq(trackingZonesTable.isActive, true),
      inArray(trackingZoneUsersTable.userId, userIds),
    ));
  type ZoneLite = { id: number; name: string; isAllowed: boolean; centerLat: number; centerLng: number };
  const zonesByUser = new Map<number, ZoneLite[]>();
  const zoneById = new Map<number, ZoneLite>();
  for (const z of zoneRows) {
    const lite: ZoneLite = {
      id: z.id, name: z.name, isAllowed: z.isAllowed,
      centerLat: Number(z.centerLat), centerLng: Number(z.centerLng),
    };
    zoneById.set(z.id, lite);
    const arr = zonesByUser.get(z.userId) ?? [];
    if (!arr.find(x => x.id === z.id)) arr.push(lite);
    zonesByUser.set(z.userId, arr);
  }

  // 4) Today's visits per user (for the movement trail). We collect checkin
  //    and checkout points sorted chronologically so the UI can draw a
  //    polyline showing where the user moved during the day.
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const todayVisits = await db.select({
    userId: userVisitsTable.userId,
    checkinAt: userVisitsTable.checkinAt,
    checkinLat: userVisitsTable.checkinLat,
    checkinLng: userVisitsTable.checkinLng,
    checkinPlace: userVisitsTable.checkinPlace,
    checkoutAt: userVisitsTable.checkoutAt,
    checkoutLat: userVisitsTable.checkoutLat,
    checkoutLng: userVisitsTable.checkoutLng,
    checkoutPlace: userVisitsTable.checkoutPlace,
  }).from(userVisitsTable).where(and(
    eq(userVisitsTable.companyId, cid),
    inArray(userVisitsTable.userId, userIds),
    gte(userVisitsTable.checkinAt, startOfToday),
  )).orderBy(userVisitsTable.checkinAt);

  type TrailPt = { lat: number; lng: number; at: string; label: string; kind: "in" | "out" };
  const trailByUser = new Map<number, TrailPt[]>();
  for (const v of todayVisits) {
    const arr = trailByUser.get(v.userId) ?? [];
    if (v.checkinLat && v.checkinLng) {
      arr.push({
        lat: Number(v.checkinLat), lng: Number(v.checkinLng),
        at: new Date(v.checkinAt).toISOString(),
        label: v.checkinPlace ?? "دخول", kind: "in",
      });
    }
    if (v.checkoutAt && v.checkoutLat && v.checkoutLng) {
      arr.push({
        lat: Number(v.checkoutLat), lng: Number(v.checkoutLng),
        at: new Date(v.checkoutAt).toISOString(),
        label: v.checkoutPlace ?? "خروج", kind: "out",
      });
    }
    trailByUser.set(v.userId, arr);
  }

  const now = Date.now();
  const rows = trackedUsers.map(u => {
    const v = visitByUser.get(u.id) ?? null;
    const elapsedMin = v ? Math.max(0, Math.round((now - new Date(v.checkinAt).getTime()) / 60000)) : null;
    const assigned = zonesByUser.get(u.id) ?? [];
    // Fallback position for offline users (so they still appear on the map at
    // their primary zone's centre, in grey).
    const fallbackZone = assigned[0] ?? null;
    return {
      userId: u.id,
      userName: u.nameAr || u.nameEn || u.username,
      isActive: !!v,
      assignedZones: assigned.map(z => ({ id: z.id, name: z.name, isAllowed: z.isAllowed })),
      fallbackLat: fallbackZone ? fallbackZone.centerLat : null,
      fallbackLng: fallbackZone ? fallbackZone.centerLng : null,
      fallbackZoneName: fallbackZone?.name ?? null,
      todayTrail: trailByUser.get(u.id) ?? [],
      visit: v ? {
        id: v.id,
        checkinAt: v.checkinAt,
        lat: v.checkinLat,
        lng: v.checkinLng,
        place: v.checkinPlace,
        address: v.checkinAddress,
        purpose: v.purpose,
        elapsedMinutes: elapsedMin,
        zoneId: v.zoneId,
        zoneName: v.zoneId ? (zoneById.get(v.zoneId)?.name ?? null) : null,
        alertFlags: v.alertFlags,
      } : null,
    };
  });

  res.json({ users: rows, serverTime: new Date().toISOString() });
});

// ───────────────── ATTENDANCE REPORT (admin) ───────────────
// Per-user per-day attendance derived from the visit log. Every user who is
// explicitly bound to at least one active tracking zone is considered
// "expected to attend"; days with no visit are reported as Absent.
//
// Query params:
//   - from, to: ISO date (YYYY-MM-DD). Inclusive. Defaults to current month.
//   - userId: optional filter to a single user.
//   - includeWeekends: "1" to include Fridays in the absent days (default off).
//
// Returns:
//   { days: ISO date list,
//     users: [{ userId, userName, days: [{ day, status, firstIn, lastOut,
//                                          totalMinutes, visitCount, hasAlert }],
//              summary: { presentDays, absentDays, totalMinutes, avgDailyMinutes,
//                         alertDays } }],
//     overall: { totalUserDays, presentUserDays, absentUserDays,
//                totalMinutes, alertUserDays } }
router.get("/attendance", ...adminGate, async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const from = req.query.from ? new Date(String(req.query.from)) : monthStart;
  const to   = req.query.to   ? new Date(String(req.query.to))   : today;
  const userIdFilter = req.query.userId ? Number(req.query.userId) : null;
  const includeWeekends = String(req.query.includeWeekends ?? "") === "1";

  // Build list of calendar days in range (inclusive).
  const days: string[] = [];
  {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
    while (d <= end) {
      // Friday = 5 (0=Sun, 5=Fri). In Saudi Arabia the standard weekend is
      // Friday + Saturday but most ZATCA companies operate 6 days/week, so we
      // only skip Friday unless `includeWeekends=1` is passed.
      if (includeWeekends || d.getDay() !== 5) {
        days.push(d.toISOString().slice(0, 10));
      }
      d.setDate(d.getDate() + 1);
    }
  }

  // Tracked users (explicitly bound to any active zone in this company).
  const trackedUsers = await db.selectDistinct({
    id: usersTable.id,
    nameAr: usersTable.nameAr,
    nameEn: usersTable.nameEn,
    username: usersTable.username,
  }).from(trackingZoneUsersTable)
    .innerJoin(trackingZonesTable, and(
      eq(trackingZonesTable.id, trackingZoneUsersTable.zoneId),
      eq(trackingZonesTable.companyId, cid),
      eq(trackingZonesTable.isActive, true),
    ))
    .innerJoin(usersTable, eq(usersTable.id, trackingZoneUsersTable.userId))
    .orderBy(usersTable.username);

  const filteredUsers = userIdFilter
    ? trackedUsers.filter(u => u.id === userIdFilter)
    : trackedUsers;

  if (filteredUsers.length === 0 || days.length === 0) {
    res.json({ days, users: [], overall: { totalUserDays: 0, presentUserDays: 0, absentUserDays: 0, totalMinutes: 0, alertUserDays: 0 } });
    return;
  }

  // Fetch all visits in range for these users in one go.
  const userIds = filteredUsers.map(u => u.id);
  const periodStart = new Date(days[0] + "T00:00:00.000Z");
  const periodEndExclusive = new Date(days[days.length - 1] + "T23:59:59.999Z");

  const visits = await db.select({
    userId: userVisitsTable.userId,
    checkinAt: userVisitsTable.checkinAt,
    checkoutAt: userVisitsTable.checkoutAt,
    durationMinutes: userVisitsTable.durationMinutes,
    status: userVisitsTable.status,
    alertFlags: userVisitsTable.alertFlags,
  }).from(userVisitsTable).where(and(
    eq(userVisitsTable.companyId, cid),
    inArray(userVisitsTable.userId, userIds),
    gte(userVisitsTable.checkinAt, periodStart),
    lte(userVisitsTable.checkinAt, periodEndExclusive),
  ));

  // Group: userId → day → list of visits.
  type V = { checkinAt: Date; checkoutAt: Date | null; durationMinutes: number | null; status: string; alertFlags: string | null };
  const byUserDay = new Map<number, Map<string, V[]>>();
  for (const v of visits) {
    const day = new Date(v.checkinAt).toISOString().slice(0, 10);
    if (!days.includes(day)) continue; // weekend skipped
    let umap = byUserDay.get(v.userId);
    if (!umap) { umap = new Map(); byUserDay.set(v.userId, umap); }
    const arr = umap.get(day) ?? [];
    arr.push({
      checkinAt: new Date(v.checkinAt),
      checkoutAt: v.checkoutAt ? new Date(v.checkoutAt) : null,
      durationMinutes: v.durationMinutes,
      status: v.status,
      alertFlags: v.alertFlags,
    });
    umap.set(day, arr);
  }

  const usersOut = filteredUsers.map(u => {
    const umap = byUserDay.get(u.id) ?? new Map<string, V[]>();
    let presentDays = 0, totalMinutes = 0, alertDays = 0;
    const dayRows = days.map(day => {
      const vs = umap.get(day) ?? [];
      if (vs.length === 0) {
        return { day, status: "absent" as const, firstIn: null, lastOut: null, totalMinutes: 0, visitCount: 0, hasAlert: false };
      }
      vs.sort((a, b) => a.checkinAt.getTime() - b.checkinAt.getTime());
      const firstIn = vs[0].checkinAt.toISOString();
      // For "lastOut" prefer the latest checkout; if there is an open (active)
      // visit, fall back to its check-in time + null to signal "still active".
      const completedVisits = vs.filter(v => v.checkoutAt);
      const lastOut = completedVisits.length > 0
        ? completedVisits[completedVisits.length - 1].checkoutAt!.toISOString()
        : null;
      const mins = vs.reduce((s, v) => s + (v.durationMinutes ?? 0), 0);
      const hasAlert = vs.some(v => !!v.alertFlags);
      presentDays++;
      totalMinutes += mins;
      if (hasAlert) alertDays++;
      const stillActive = vs.some(v => v.status === "active");
      return {
        day,
        status: (stillActive ? "active" : "present") as "present" | "active",
        firstIn,
        lastOut,
        totalMinutes: mins,
        visitCount: vs.length,
        hasAlert,
      };
    });
    return {
      userId: u.id,
      userName: u.nameAr || u.nameEn || u.username,
      days: dayRows,
      summary: {
        presentDays,
        absentDays: days.length - presentDays,
        totalMinutes,
        avgDailyMinutes: presentDays > 0 ? Math.round(totalMinutes / presentDays) : 0,
        alertDays,
      },
    };
  });

  const overall = {
    totalUserDays: usersOut.length * days.length,
    presentUserDays: usersOut.reduce((s, u) => s + u.summary.presentDays, 0),
    absentUserDays: usersOut.reduce((s, u) => s + u.summary.absentDays, 0),
    totalMinutes: usersOut.reduce((s, u) => s + u.summary.totalMinutes, 0),
    alertUserDays: usersOut.reduce((s, u) => s + u.summary.alertDays, 0),
  };

  res.json({ days, users: usersOut, overall });
});

// ───────────────── MOVEMENT REPORT (admin) ────────────────
// Detailed per-user movement report for the users explicitly bound to a
// tracking zone. For a chosen day (default: today) it returns every
// check-in / check-out event in chronological order with timestamps,
// the place name + lat/lng, the matched zone, duration, and whether the
// visit fell OUTSIDE the user's allowed zone (alertFlags contains
// `out_of_allowed_zone` or `in_forbidden_zone`).
//
// Query params:
//   - day:  YYYY-MM-DD (single day, default today, server time)
//   - from / to: optional date range OVERRIDE (inclusive). When passed
//                they win over `day` and the report aggregates the full
//                range — each user's events are flattened in order.
//   - userId: optional single-user filter
//
// Returns:
//   { range: { from, to },
//     users: [{
//       userId, userName,
//       assignedZones: [{ id, name, isAllowed }],
//       events: [{                              // chronological
//         visitId, kind: "in"|"out", at, lat, lng, place, address,
//         zoneId, zoneName, alertFlags
//       }],
//       segments: [{                            // visit segments (in→out)
//         visitId, fromAt, toAt|null,           // null = still active
//         durationMinutes, isActive,
//         fromPlace, toPlace,
//         zoneId, zoneName, outOfZone
//       }],
//       summary: { checkinCount, checkoutCount, outOfZoneCount,
//                  totalMinutes, firstAt, lastAt } }],
//     overall: { trackedUsers, totalCheckins, totalCheckouts,
//                totalOutOfZone, totalMinutes } }
// Zod schema for the movement-report query string. Centralised here so
// malformed `day/from/to/userId` values return a clean 400 instead of
// silently flattening to an empty report.
const movementReportQuerySchema = z.object({
  day:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  userId: z.coerce.number().int().positive().optional(),
}).refine(v => !v.from || !v.to || v.from <= v.to, {
  message: "from must be <= to",
  path: ["from"],
});

router.get("/movement-report", ...adminGate, async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;

  const parsed = movementReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error.issues });
    return;
  }
  const { day, from, to, userId: userIdFilterRaw } = parsed.data;

  // Resolve the period in the SERVER's local timezone so the day
  // boundaries match what the user sees in the UI (toLocaleString).
  // We deliberately use a local-time `Date` constructor for the
  // default-today calculation too, instead of `toISOString().slice(0,10)`
  // (which can shift the date by ±1 day across UTC midnight).
  const nowLocal = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayLocalIso = `${nowLocal.getFullYear()}-${pad(nowLocal.getMonth() + 1)}-${pad(nowLocal.getDate())}`;
  const dayStr  = day  ?? todayLocalIso;
  const fromStr = from ?? dayStr;
  const toStr   = to   ?? dayStr;
  const [fy, fm, fd] = fromStr.split("-").map(Number);
  const [ty, tm, td] = toStr.split("-").map(Number);
  const periodStart = new Date(fy, (fm ?? 1) - 1, fd ?? 1, 0, 0, 0, 0);
  const periodEnd   = new Date(ty, (tm ?? 1) - 1, td ?? 1, 23, 59, 59, 999);
  const userIdFilter = userIdFilterRaw ?? null;

  // Users explicitly bound to at least one active zone in this company.
  const trackedUsers = await db.selectDistinct({
    id: usersTable.id,
    nameAr: usersTable.nameAr,
    nameEn: usersTable.nameEn,
    username: usersTable.username,
  }).from(trackingZoneUsersTable)
    .innerJoin(trackingZonesTable, and(
      eq(trackingZonesTable.id, trackingZoneUsersTable.zoneId),
      eq(trackingZonesTable.companyId, cid),
      eq(trackingZonesTable.isActive, true),
    ))
    .innerJoin(usersTable, eq(usersTable.id, trackingZoneUsersTable.userId))
    .orderBy(usersTable.username);

  const filteredUsers = userIdFilter
    ? trackedUsers.filter(u => u.id === userIdFilter)
    : trackedUsers;

  if (filteredUsers.length === 0) {
    res.json({
      range: { from: fromStr, to: toStr },
      users: [],
      overall: { trackedUsers: 0, totalCheckins: 0, totalCheckouts: 0, totalOutOfZone: 0, totalMinutes: 0 },
    });
    return;
  }

  const userIds = filteredUsers.map(u => u.id);

  // Zone names + assignment map per user (for labels and the "assignedZones"
  // header that the UI shows above each user's timeline).
  const zoneRows = await db.select({
    id: trackingZonesTable.id,
    name: trackingZonesTable.name,
    isAllowed: trackingZonesTable.isAllowed,
    userId: trackingZoneUsersTable.userId,
  }).from(trackingZonesTable)
    .innerJoin(trackingZoneUsersTable, eq(trackingZoneUsersTable.zoneId, trackingZonesTable.id))
    .where(and(
      eq(trackingZonesTable.companyId, cid),
      eq(trackingZonesTable.isActive, true),
      inArray(trackingZoneUsersTable.userId, userIds),
    ));
  const zoneById = new Map<number, { id: number; name: string; isAllowed: boolean }>();
  const zonesByUser = new Map<number, Array<{ id: number; name: string; isAllowed: boolean }>>();
  for (const z of zoneRows) {
    const lite = { id: z.id, name: z.name, isAllowed: z.isAllowed };
    zoneById.set(z.id, lite);
    const arr = zonesByUser.get(z.userId) ?? [];
    if (!arr.find(x => x.id === z.id)) arr.push(lite);
    zonesByUser.set(z.userId, arr);
  }

  // Pull every visit overlapping the period for the tracked users in one go.
  const visits = await db.select({
    id: userVisitsTable.id,
    userId: userVisitsTable.userId,
    checkinAt: userVisitsTable.checkinAt,
    checkinLat: userVisitsTable.checkinLat,
    checkinLng: userVisitsTable.checkinLng,
    checkinPlace: userVisitsTable.checkinPlace,
    checkinAddress: userVisitsTable.checkinAddress,
    checkoutAt: userVisitsTable.checkoutAt,
    checkoutLat: userVisitsTable.checkoutLat,
    checkoutLng: userVisitsTable.checkoutLng,
    checkoutPlace: userVisitsTable.checkoutPlace,
    checkoutAddress: userVisitsTable.checkoutAddress,
    durationMinutes: userVisitsTable.durationMinutes,
    status: userVisitsTable.status,
    zoneId: userVisitsTable.zoneId,
    alertFlags: userVisitsTable.alertFlags,
  }).from(userVisitsTable).where(and(
    eq(userVisitsTable.companyId, cid),
    inArray(userVisitsTable.userId, userIds),
    // OVERLAP semantics: include any visit that touches the requested
    // window — even if it started before periodStart (overnight visit)
    // or is still active (no checkoutAt). Without this, days near
    // midnight would silently lose check-outs whose corresponding
    // check-in was on the previous calendar day.
    lte(userVisitsTable.checkinAt, periodEnd),
    or(
      isNull(userVisitsTable.checkoutAt),
      gte(userVisitsTable.checkoutAt, periodStart),
    ),
  )).orderBy(userVisitsTable.checkinAt);

  type Ev = {
    visitId: number; kind: "in" | "out"; at: string;
    lat: number | null; lng: number | null; place: string | null; address: string | null;
    zoneId: number | null; zoneName: string | null; alertFlags: string | null;
  };
  type Seg = {
    visitId: number; fromAt: string; toAt: string | null;
    durationMinutes: number | null; isActive: boolean;
    fromPlace: string | null; toPlace: string | null;
    zoneId: number | null; zoneName: string | null; outOfZone: boolean;
  };
  const evByUser  = new Map<number, Ev[]>();
  const segByUser = new Map<number, Seg[]>();
  const visitsByUser = new Map<number, typeof visits>();
  for (const v of visits) {
    const arr = visitsByUser.get(v.userId) ?? [];
    arr.push(v); visitsByUser.set(v.userId, arr);
  }

  const isOutFlag = (f: string | null) =>
    !!f && /(out_of_allowed_zone|in_forbidden_zone)/.test(f);

  for (const [uid, vs] of visitsByUser.entries()) {
    const evs: Ev[] = [];
    const segs: Seg[] = [];
    for (const v of vs) {
      const zName = v.zoneId ? (zoneById.get(v.zoneId)?.name ?? null) : null;
      evs.push({
        visitId: v.id, kind: "in",
        at: new Date(v.checkinAt).toISOString(),
        lat: v.checkinLat ? Number(v.checkinLat) : null,
        lng: v.checkinLng ? Number(v.checkinLng) : null,
        place: v.checkinPlace, address: v.checkinAddress,
        zoneId: v.zoneId, zoneName: zName, alertFlags: v.alertFlags,
      });
      if (v.checkoutAt) {
        evs.push({
          visitId: v.id, kind: "out",
          at: new Date(v.checkoutAt).toISOString(),
          lat: v.checkoutLat ? Number(v.checkoutLat) : null,
          lng: v.checkoutLng ? Number(v.checkoutLng) : null,
          place: v.checkoutPlace, address: v.checkoutAddress,
          zoneId: v.zoneId, zoneName: zName, alertFlags: v.alertFlags,
        });
      }
      segs.push({
        visitId: v.id,
        fromAt: new Date(v.checkinAt).toISOString(),
        toAt: v.checkoutAt ? new Date(v.checkoutAt).toISOString() : null,
        // For still-active visits the running duration is computed on the
        // client to stay live; we send null here.
        durationMinutes: v.durationMinutes,
        isActive: v.status === "active",
        fromPlace: v.checkinPlace, toPlace: v.checkoutPlace,
        zoneId: v.zoneId, zoneName: zName,
        outOfZone: isOutFlag(v.alertFlags),
      });
    }
    evs.sort((a, b) => a.at.localeCompare(b.at));
    segs.sort((a, b) => a.fromAt.localeCompare(b.fromAt));
    evByUser.set(uid, evs);
    segByUser.set(uid, segs);
  }

  let oCheckins = 0, oCheckouts = 0, oOut = 0, oMin = 0;
  const usersOut = filteredUsers.map(u => {
    const evs  = evByUser.get(u.id)  ?? [];
    const segs = segByUser.get(u.id) ?? [];
    const checkinCount  = evs.filter(e => e.kind === "in").length;
    const checkoutCount = evs.filter(e => e.kind === "out").length;
    const outOfZoneCount = segs.filter(s => s.outOfZone).length;
    const totalMinutes = segs.reduce((s, x) => s + (x.durationMinutes ?? 0), 0);
    oCheckins += checkinCount; oCheckouts += checkoutCount;
    oOut += outOfZoneCount;    oMin += totalMinutes;
    return {
      userId: u.id,
      userName: u.nameAr || u.nameEn || u.username,
      assignedZones: zonesByUser.get(u.id) ?? [],
      events: evs,
      segments: segs,
      summary: {
        checkinCount, checkoutCount, outOfZoneCount,
        totalMinutes,
        firstAt: evs.length ? evs[0].at : null,
        lastAt:  evs.length ? evs[evs.length - 1].at : null,
      },
    };
  });

  res.json({
    range: { from: fromStr, to: toStr },
    users: usersOut,
    overall: {
      trackedUsers: usersOut.length,
      totalCheckins: oCheckins,
      totalCheckouts: oCheckouts,
      totalOutOfZone: oOut,
      totalMinutes: oMin,
    },
  });
});

// ───────────────── LIST VISITS (admin / dashboard) ──────────
router.get("/visits", async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to   = req.query.to   ? new Date(String(req.query.to))   : null;
  const userId = req.query.userId ? Number(req.query.userId) : null;
  const status = req.query.status ? String(req.query.status) : null;
  const limit  = Math.min(1000, Number(req.query.limit) || 200);

  const conds: any[] = [eq(userVisitsTable.companyId, cid)];
  if (from) conds.push(gte(userVisitsTable.checkinAt, from));
  if (to)   conds.push(lte(userVisitsTable.checkinAt, to));
  if (userId) conds.push(eq(userVisitsTable.userId, userId));
  if (status) conds.push(eq(userVisitsTable.status, status));

  // Non-admins may only see their own visits.
  if (req.authUser?.role !== "admin" && req.authUser?.role !== "superadmin") {
    conds.push(eq(userVisitsTable.userId, req.authUser.id));
  }
  // Branch-level isolation: respects view_all_branches=false grants.
  const bvCond = branchScopeFilter(req, userVisitsTable.branchId);
  if (bvCond) conds.push(bvCond);

  const rows = await db.select({
    id: userVisitsTable.id,
    userId: userVisitsTable.userId,
    userName: sql<string>`COALESCE(${usersTable.nameAr}, ${usersTable.nameEn}, ${usersTable.username})`,
    branchId: userVisitsTable.branchId,
    branchName: branchesTable.nameAr,
    purpose: userVisitsTable.purpose,
    notes: userVisitsTable.notes,
    status: userVisitsTable.status,
    checkinAt: userVisitsTable.checkinAt,
    checkinLat: userVisitsTable.checkinLat,
    checkinLng: userVisitsTable.checkinLng,
    checkinPlace: userVisitsTable.checkinPlace,
    checkinAddress: userVisitsTable.checkinAddress,
    checkoutAt: userVisitsTable.checkoutAt,
    checkoutLat: userVisitsTable.checkoutLat,
    checkoutLng: userVisitsTable.checkoutLng,
    checkoutPlace: userVisitsTable.checkoutPlace,
    checkoutAddress: userVisitsTable.checkoutAddress,
    durationMinutes: userVisitsTable.durationMinutes,
    zoneId: userVisitsTable.zoneId,
    alertFlags: userVisitsTable.alertFlags,
  })
    .from(userVisitsTable)
    .leftJoin(usersTable, eq(usersTable.id, userVisitsTable.userId))
    .leftJoin(branchesTable, eq(branchesTable.id, userVisitsTable.branchId))
    .where(and(...conds))
    .orderBy(desc(userVisitsTable.checkinAt))
    .limit(limit);
  res.json(rows);
});

// ───────────────── DASHBOARD STATS ──────────────────────────
router.get("/dashboard", ...adminGate, async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 86400000);
  const to   = req.query.to   ? new Date(String(req.query.to))   : new Date();
  const userId = req.query.userId ? Number(req.query.userId) : null;

  const conds: any[] = [
    eq(userVisitsTable.companyId, cid),
    gte(userVisitsTable.checkinAt, from),
    lte(userVisitsTable.checkinAt, to),
  ];
  if (userId) conds.push(eq(userVisitsTable.userId, userId));
  if (req.authUser?.role !== "admin" && req.authUser?.role !== "superadmin") {
    conds.push(eq(userVisitsTable.userId, req.authUser.id));
  }
  const bdCond = branchScopeFilter(req, userVisitsTable.branchId);
  if (bdCond) conds.push(bdCond);

  // per-user aggregate
  const perUser = await db.select({
    userId: userVisitsTable.userId,
    userName: sql<string>`COALESCE(${usersTable.nameAr}, ${usersTable.nameEn}, ${usersTable.username})`,
    visitCount: sql<number>`COUNT(*)::int`,
    completedCount: sql<number>`COUNT(*) FILTER (WHERE ${userVisitsTable.status} = 'completed')::int`,
    activeCount: sql<number>`COUNT(*) FILTER (WHERE ${userVisitsTable.status} = 'active')::int`,
    totalMinutes: sql<number>`COALESCE(SUM(${userVisitsTable.durationMinutes}), 0)::int`,
    avgMinutes: sql<number>`COALESCE(AVG(${userVisitsTable.durationMinutes}), 0)::int`,
    alertCount: sql<number>`COUNT(*) FILTER (WHERE ${userVisitsTable.alertFlags} IS NOT NULL AND ${userVisitsTable.alertFlags} <> '')::int`,
    distinctPlaces: sql<number>`COUNT(DISTINCT ${userVisitsTable.checkinPlace})::int`,
  })
    .from(userVisitsTable)
    .leftJoin(usersTable, eq(usersTable.id, userVisitsTable.userId))
    .where(and(...conds))
    .groupBy(userVisitsTable.userId, usersTable.nameAr, usersTable.nameEn, usersTable.username)
    .orderBy(desc(sql`COUNT(*)`));

  // per-day buckets
  const perDay = await db.select({
    day: sql<string>`TO_CHAR(${userVisitsTable.checkinAt}::date, 'YYYY-MM-DD')`,
    visitCount: sql<number>`COUNT(*)::int`,
    totalMinutes: sql<number>`COALESCE(SUM(${userVisitsTable.durationMinutes}), 0)::int`,
  })
    .from(userVisitsTable)
    .where(and(...conds))
    .groupBy(sql`${userVisitsTable.checkinAt}::date`)
    .orderBy(sql`${userVisitsTable.checkinAt}::date`);

  // top places
  const topPlaces = await db.select({
    place: userVisitsTable.checkinPlace,
    visitCount: sql<number>`COUNT(*)::int`,
    totalMinutes: sql<number>`COALESCE(SUM(${userVisitsTable.durationMinutes}), 0)::int`,
  })
    .from(userVisitsTable)
    .where(and(...conds, sql`${userVisitsTable.checkinPlace} IS NOT NULL`))
    .groupBy(userVisitsTable.checkinPlace)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(10);

  // totals
  const [totals] = await db.select({
    visitCount: sql<number>`COUNT(*)::int`,
    totalMinutes: sql<number>`COALESCE(SUM(${userVisitsTable.durationMinutes}), 0)::int`,
    activeUsers: sql<number>`COUNT(DISTINCT ${userVisitsTable.userId})::int`,
    alertCount: sql<number>`COUNT(*) FILTER (WHERE ${userVisitsTable.alertFlags} IS NOT NULL AND ${userVisitsTable.alertFlags} <> '')::int`,
  }).from(userVisitsTable).where(and(...conds));

  res.json({ totals, perUser, perDay, topPlaces });
});

// ───────────────── ZONES (admin) ────────────────────────────
router.get("/zones", ...adminGate, async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  const rows = await db.select().from(trackingZonesTable)
    .where(eq(trackingZonesTable.companyId, cid))
    .orderBy(desc(trackingZonesTable.id));
  res.json(rows);
});

const zoneSchema = z.object({
  name: z.string().trim().min(1).max(120),
  centerLat: z.coerce.number(),
  centerLng: z.coerce.number(),
  radiusMeters: z.coerce.number().int().positive().max(50000).default(500),
  isAllowed: z.coerce.boolean().default(true),
  isActive: z.coerce.boolean().default(true),
  notes: z.string().trim().max(500).optional().nullable(),
});

router.post("/zones", ...adminGate, async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  if (req.authUser?.role !== "admin" && req.authUser?.role !== "superadmin") {
    res.status(403).json({ error: "ممنوع" }); return;
  }
  const p = zoneSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "بيانات غير صالحة", details: p.error.issues }); return; }
  const [row] = await db.insert(trackingZonesTable).values({
    companyId: cid,
    name: p.data.name,
    centerLat: String(p.data.centerLat),
    centerLng: String(p.data.centerLng),
    radiusMeters: p.data.radiusMeters,
    isAllowed: p.data.isAllowed,
    isActive: p.data.isActive,
    notes: p.data.notes ?? null,
  }).returning();
  res.status(201).json(row);
});

router.patch("/zones/:id", ...adminGate, async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  if (req.authUser?.role !== "admin" && req.authUser?.role !== "superadmin") {
    res.status(403).json({ error: "ممنوع" }); return;
  }
  const id = Number(req.params.id);
  const p = zoneSchema.partial().safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "بيانات غير صالحة" }); return; }
  const patch: any = { ...p.data };
  if (patch.centerLat != null) patch.centerLat = String(patch.centerLat);
  if (patch.centerLng != null) patch.centerLng = String(patch.centerLng);
  const [row] = await db.update(trackingZonesTable).set(patch).where(and(
    eq(trackingZonesTable.id, id), eq(trackingZonesTable.companyId, cid),
  )).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

// List users assigned to a zone (empty array means "global — applies to everyone").
router.get("/zones/:id/users", ...adminGate, async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  const zoneId = Number(req.params.id);
  if (!Number.isFinite(zoneId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  // ensure zone belongs to company
  const [z] = await db.select({ id: trackingZonesTable.id }).from(trackingZonesTable)
    .where(and(eq(trackingZonesTable.id, zoneId), eq(trackingZonesTable.companyId, cid))).limit(1);
  if (!z) { res.status(404).json({ error: "غير موجود" }); return; }
  const rows = await db.select({
    userId: trackingZoneUsersTable.userId,
    assignedAt: trackingZoneUsersTable.assignedAt,
    userName: sql<string>`COALESCE(${usersTable.nameAr}, ${usersTable.nameEn}, ${usersTable.username})`,
    username: usersTable.username,
  }).from(trackingZoneUsersTable)
    .leftJoin(usersTable, eq(usersTable.id, trackingZoneUsersTable.userId))
    .where(eq(trackingZoneUsersTable.zoneId, zoneId))
    .orderBy(desc(trackingZoneUsersTable.assignedAt));
  res.json(rows);
});

router.post("/zones/:id/users", ...adminGate, async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  if (req.authUser?.role !== "admin" && req.authUser?.role !== "superadmin") {
    res.status(403).json({ error: "ممنوع" }); return;
  }
  const zoneId = Number(req.params.id);
  const body = z.object({ userId: z.coerce.number().int().positive() }).safeParse(req.body);
  if (!body.success || !Number.isFinite(zoneId)) { res.status(400).json({ error: "بيانات غير صالحة" }); return; }
  // verify zone belongs to company AND user belongs to company
  const [z1] = await db.select({ id: trackingZonesTable.id }).from(trackingZonesTable)
    .where(and(eq(trackingZonesTable.id, zoneId), eq(trackingZonesTable.companyId, cid))).limit(1);
  if (!z1) { res.status(404).json({ error: "المنطقة غير موجودة" }); return; }
  const [u1] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(eq(usersTable.id, body.data.userId), eq(usersTable.companyId, cid))).limit(1);
  if (!u1) { res.status(404).json({ error: "المستخدم غير موجود" }); return; }
  await db.insert(trackingZoneUsersTable).values({
    zoneId, userId: body.data.userId,
  }).onConflictDoNothing();
  res.status(201).json({ zoneId, userId: body.data.userId });
});

router.delete("/zones/:id/users/:userId", ...adminGate, async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  if (req.authUser?.role !== "admin" && req.authUser?.role !== "superadmin") {
    res.status(403).json({ error: "ممنوع" }); return;
  }
  const zoneId = Number(req.params.id), userId = Number(req.params.userId);
  if (!Number.isFinite(zoneId) || !Number.isFinite(userId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  // verify zone belongs to company (prevents cross-tenant deletes)
  const [z1] = await db.select({ id: trackingZonesTable.id }).from(trackingZonesTable)
    .where(and(eq(trackingZonesTable.id, zoneId), eq(trackingZonesTable.companyId, cid))).limit(1);
  if (!z1) { res.status(404).json({ error: "غير موجود" }); return; }
  await db.delete(trackingZoneUsersTable).where(and(
    eq(trackingZoneUsersTable.zoneId, zoneId),
    eq(trackingZoneUsersTable.userId, userId),
  ));
  res.status(204).end();
});

// Forward-geocode (place name → lat/lng) via the FREE OpenStreetMap Nominatim
// search API. Proxied through the server so we can set the User-Agent header
// required by Nominatim's usage policy (browsers can't override User-Agent).
// Returns up to 5 candidate places, biased to Saudi Arabia.
router.get("/geocode", ...adminGate, async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) { res.json([]); return; }
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&accept-language=ar&limit=5&countrycodes=sa&addressdetails=1`;
    const r = await fetch(url, {
      headers: {
        "User-Agent": "zatca-invoicing/1.0 (user-tracking module)",
        "Accept-Language": "ar,en;q=0.8",
      },
    });
    if (!r.ok) { res.json([]); return; }
    const j = (await r.json()) as any[];
    const out = (j ?? []).map((x: any) => ({
      displayName: x.display_name as string,
      lat: Number(x.lat),
      lng: Number(x.lon),
      type: x.type as string,
      importance: Number(x.importance ?? 0),
    })).filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lng));
    res.json(out);
  } catch (e: any) {
    req.log?.warn?.({ err: e?.message }, "nominatim search threw");
    res.json([]);
  }
});

// Simple users picker for the assignment UI (just id + display name).
router.get("/company-users", ...adminGate, async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  const rows = await db.select({
    id: usersTable.id,
    username: usersTable.username,
    name: sql<string>`COALESCE(${usersTable.nameAr}, ${usersTable.nameEn}, ${usersTable.username})`,
  }).from(usersTable)
    .where(and(eq(usersTable.companyId, cid), eq(usersTable.isActive, true)))
    .orderBy(usersTable.username);
  res.json(rows);
});

router.delete("/zones/:id", ...adminGate, async (req: any, res) => {
  const cid = guard(req, res); if (!cid) return;
  if (req.authUser?.role !== "admin" && req.authUser?.role !== "superadmin") {
    res.status(403).json({ error: "ممنوع" }); return;
  }
  const id = Number(req.params.id);
  await db.delete(trackingZonesTable).where(and(
    eq(trackingZonesTable.id, id), eq(trackingZonesTable.companyId, cid),
  ));
  res.status(204).end();
});

// ───────────────── PUBLIC: Mapbox token ─────────────────────
// Returns whether a public token is available so the frontend can render
// the map. We do NOT return the token here — the frontend uses
// VITE_MAPBOX_ACCESS_TOKEN at build time.
router.get("/config", async (_req, res) => {
  res.json({
    mapboxConfigured: !!process.env.MAPBOX_ACCESS_TOKEN,
  });
});

export default router;
