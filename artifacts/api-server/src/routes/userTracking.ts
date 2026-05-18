import { Router } from "express";
import { db } from "@workspace/db";
import { userVisitsTable, trackingZonesTable, usersTable, branchesTable } from "@workspace/db";
import { eq, and, desc, sql, gte, lte, isNull, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import { extractAuth, resolveCompanyId, branchScopeFilter } from "../middleware/auth.js";
import { requireModulePermission, moduleAudit } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("user_tracking"));
router.use(moduleAudit("user_tracking"));

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

// Server-side reverse geocode via Mapbox. Returns { placeName, address } or
// nulls when the token is missing / the call fails. Never throws — geocoding
// is best-effort; the visit still records lat/lng even without place names.
async function reverseGeocode(lat: number, lng: number, log: any): Promise<{ placeName: string | null; address: string | null }> {
  const token = process.env.MAPBOX_ACCESS_TOKEN;
  if (!token) return { placeName: null, address: null };
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?language=ar&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url);
    if (!r.ok) {
      log?.warn?.({ status: r.status }, "mapbox reverse geocode failed");
      return { placeName: null, address: null };
    }
    const j: any = await r.json();
    const feat = j?.features?.[0];
    const poi = j?.features?.find((f: any) => f?.place_type?.includes("poi"));
    return {
      placeName: (poi?.text || feat?.text || feat?.place_name || null) as string | null,
      address: (feat?.place_name || null) as string | null,
    };
  } catch (e: any) {
    log?.warn?.({ err: e?.message }, "mapbox reverse geocode threw");
    return { placeName: null, address: null };
  }
}

// Match a visit lat/lng to the nearest active zone for the company. Returns
// the zone id + a flag string when relevant (out_of_allowed_zone if the point
// is inside an `is_allowed=false` zone, or outside all `is_allowed=true` zones
// when at least one allowed zone is defined).
async function matchZone(cid: number, lat: number, lng: number): Promise<{ zoneId: number | null; flag: string | null }> {
  const zones = await db.select().from(trackingZonesTable).where(
    and(eq(trackingZonesTable.companyId, cid), eq(trackingZonesTable.isActive, true)),
  );
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
  const zoneMatch = await matchZone(cid, lat, lng);

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
router.get("/dashboard", async (req: any, res) => {
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
router.get("/zones", async (req: any, res) => {
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

router.post("/zones", async (req: any, res) => {
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

router.patch("/zones/:id", async (req: any, res) => {
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

router.delete("/zones/:id", async (req: any, res) => {
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
