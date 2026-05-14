import { Router } from "express";
import { db } from "@workspace/db";
import {
  fieldLocationsTable,
  fieldVisitsTable,
  fieldVisitPlansTable,
  fieldVisitPlanItemsTable,
  fieldServiceTicketsTable,
  employeesTable,
  customersTable,
} from "@workspace/db";
import { and, eq, desc, asc, sql, gte, lte, isNull, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId, denyKiosk } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// Manager-or-above gate for admin/supervisor screens (locations, plans,
// tickets list, reports, tracking dashboard). The mobile self check-in
// endpoints stay open to any authenticated user.
function requireManager(req: any, res: any): boolean {
  const role = req.authUser?.role;
  if (role !== "superadmin" && role !== "admin" && role !== "manager") {
    res.status(403).json({ error: "صلاحيات غير كافية — مطلوب مدير" });
    return true;
  }
  return false;
}

function isManager(req: any): boolean {
  const role = req.authUser?.role;
  return role === "superadmin" || role === "admin" || role === "manager";
}

// Verify a soft-FK belongs to the same tenant. Used to harden cross-tenant
// reference injection on visits.start (ticketId, planItemId), tickets.assign
// (employeeId), plans.create (employeeId), etc.
async function assertTenant<T extends { companyId: number }>(
  table: any, id: number, cid: number,
): Promise<boolean> {
  const [row] = await db.select({ companyId: table.companyId })
    .from(table).where(eq(table.id, id)).limit(1);
  return !!row && row.companyId === cid;
}

const N = (v: any) => (v == null || v === "" ? null : v);
const numOrNull = (v: any): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Haversine distance in metres.
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Validate a coordinate pair — rejects NaN, non-finite and out-of-range
// values so a malformed payload can't silently pass the geofence check.
function validCoord(lat: number | null, lng: number | null): boolean {
  if (lat == null || lng == null) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return true;
}

// ════════════════════════════════════════════════════════════════════════
// LOCATIONS — manage the registry of physical sites
// ════════════════════════════════════════════════════════════════════════

router.get("/locations", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    const type = req.query.type as string | undefined;
    const includeInactive = req.query.includeInactive === "1";
    const rows = await db.select().from(fieldLocationsTable)
      .where(and(
        eq(fieldLocationsTable.companyId, cid),
        type ? eq(fieldLocationsTable.type, type) : sql`true`,
        includeInactive ? sql`true` : eq(fieldLocationsTable.isActive, true),
      ))
      .orderBy(asc(fieldLocationsTable.name))
      .limit(500);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/locations", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const b = req.body ?? {};
    const lat = numOrNull(b.lat);
    const lng = numOrNull(b.lng);
    const radius = numOrNull(b.radiusM) ?? 150;
    if (!b.name || typeof b.name !== "string") {
      res.status(400).json({ error: "اسم الموقع مطلوب" }); return;
    }
    if (!validCoord(lat, lng)) {
      res.status(400).json({ error: "إحداثيات غير صالحة" }); return;
    }
    if (radius < 10 || radius > 10000) {
      res.status(400).json({ error: "نصف القطر يجب أن يكون بين 10 و 10000 متر" }); return;
    }
    const [row] = await db.insert(fieldLocationsTable).values({
      companyId: cid,
      branchId: numOrNull(b.branchId),
      name: String(b.name).trim(),
      type: String(b.type ?? "customer"),
      lat: String(lat), lng: String(lng), radiusM: radius,
      customerId: numOrNull(b.customerId),
      projectId: numOrNull(b.projectId),
      assetId: numOrNull(b.assetId),
      costCenterId: numOrNull(b.costCenterId),
      address: N(b.address),
      city: N(b.city),
      contactPerson: N(b.contactPerson),
      contactPhone: N(b.contactPhone),
      isActive: b.isActive !== false,
      notes: N(b.notes),
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/locations/:id", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const patch: any = { updatedAt: new Date() };
    if (b.name != null) patch.name = String(b.name).trim();
    if (b.type != null) patch.type = String(b.type);
    if (b.branchId !== undefined) patch.branchId = numOrNull(b.branchId);
    if (b.lat !== undefined || b.lng !== undefined) {
      const lat = numOrNull(b.lat);
      const lng = numOrNull(b.lng);
      if (!validCoord(lat, lng)) { res.status(400).json({ error: "إحداثيات غير صالحة" }); return; }
      patch.lat = String(lat); patch.lng = String(lng);
    }
    if (b.radiusM !== undefined) {
      const r = numOrNull(b.radiusM);
      if (r == null || r < 10 || r > 10000) { res.status(400).json({ error: "نصف القطر غير صالح" }); return; }
      patch.radiusM = r;
    }
    for (const k of ["customerId","projectId","assetId","costCenterId"] as const) {
      if (b[k] !== undefined) patch[k] = numOrNull(b[k]);
    }
    for (const k of ["address","city","contactPerson","contactPhone","notes"] as const) {
      if (b[k] !== undefined) patch[k] = N(b[k]);
    }
    if (b.isActive !== undefined) patch.isActive = !!b.isActive;
    const [row] = await db.update(fieldLocationsTable).set(patch)
      .where(and(eq(fieldLocationsTable.id, id), eq(fieldLocationsTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "موقع غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/locations/:id", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const id = Number(req.params.id);
    // Soft-delete by deactivating to preserve historical visits.
    const [row] = await db.update(fieldLocationsTable).set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(fieldLocationsTable.id, id), eq(fieldLocationsTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "موقع غير موجود" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Bulk-import locations from existing customers (one-click). Skips customers
// that already have a corresponding field_location row.
router.post("/locations/import-customers", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const customers = await db.select({
      id: customersTable.id, nameAr: customersTable.nameAr,
      lat: customersTable.locationLat, lng: customersTable.locationLng,
      city: customersTable.city, phone: customersTable.phone,
      address: customersTable.street,
    }).from(customersTable)
      .where(and(eq(customersTable.companyId, cid),
        sql`${customersTable.locationLat} IS NOT NULL AND ${customersTable.locationLng} IS NOT NULL`));
    const existing = await db.select({ id: fieldLocationsTable.customerId })
      .from(fieldLocationsTable)
      .where(and(eq(fieldLocationsTable.companyId, cid),
        sql`${fieldLocationsTable.customerId} IS NOT NULL`));
    const existingIds = new Set(existing.map(r => r.id).filter(Boolean) as number[]);
    let imported = 0;
    for (const c of customers) {
      if (existingIds.has(c.id)) continue;
      const lat = Number(c.lat); const lng = Number(c.lng);
      if (!validCoord(lat, lng)) continue;
      await db.insert(fieldLocationsTable).values({
        companyId: cid, name: c.nameAr, type: "customer",
        lat: String(lat), lng: String(lng), radiusM: 150,
        customerId: c.id, city: c.city, contactPhone: c.phone, address: c.address,
      });
      imported++;
    }
    res.json({ imported, total: customers.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// VISITS — start / end / list
// ════════════════════════════════════════════════════════════════════════

// Start a visit. Open to any authenticated user — the employee starts their
// own visit from the mobile page. employeeId is required (front-end resolves
// it from the logged-in user). Distance + status computed against location.
router.post("/visits/start", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const employeeId = numOrNull(b.employeeId);
    if (!employeeId) { res.status(400).json({ error: "employeeId مطلوب" }); return; }
    const [emp] = await db.select().from(employeesTable)
      .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid))).limit(1);
    if (!emp) { res.status(404).json({ error: "موظف غير موجود" }); return; }

    // Refuse if there's already an open visit for this employee — they must
    // close it first. Prevents accidentally double-tapping "start".
    const [open] = await db.select({ id: fieldVisitsTable.id }).from(fieldVisitsTable)
      .where(and(
        eq(fieldVisitsTable.employeeId, employeeId),
        eq(fieldVisitsTable.companyId, cid),
        eq(fieldVisitsTable.status, "open"),
      )).limit(1);
    if (open) {
      res.status(409).json({ error: "لديك زيارة مفتوحة بالفعل — أنهها أولاً", openVisitId: open.id });
      return;
    }

    const locationId = numOrNull(b.locationId);
    let location: any = null;
    if (locationId) {
      [location] = await db.select().from(fieldLocationsTable)
        .where(and(eq(fieldLocationsTable.id, locationId), eq(fieldLocationsTable.companyId, cid))).limit(1);
      if (!location) { res.status(404).json({ error: "موقع غير موجود" }); return; }
    }

    const lat = numOrNull(b.lat);
    const lng = numOrNull(b.lng);
    const accuracy = numOrNull(b.accuracy);
    let distanceM: number | null = null;
    let locStatus = "no_gps";
    if (b.mocked) {
      locStatus = "mock_suspected";
    } else if (!validCoord(lat, lng)) {
      locStatus = "denied";
    } else if (accuracy != null && (!Number.isFinite(accuracy) || accuracy > 100)) {
      locStatus = "low_accuracy";
    } else if (location) {
      const lLat = Number(location.lat); const lLng = Number(location.lng);
      distanceM = haversineMeters(lat as number, lng as number, lLat, lLng);
      const radius = location.radiusM ?? 150;
      locStatus = distanceM > radius ? "out_of_geofence" : "ok";
    } else {
      locStatus = "ok";
    }

    // Tenant-scope validation for soft-FKs (no DB constraint).
    const ticketIdRaw = numOrNull(b.ticketId);
    if (ticketIdRaw && !(await assertTenant(fieldServiceTicketsTable, ticketIdRaw, cid))) {
      res.status(400).json({ error: "تذكرة غير صالحة" }); return;
    }
    const customerIdRaw = numOrNull(b.customerId);
    if (customerIdRaw && !(await assertTenant(customersTable, customerIdRaw, cid))) {
      res.status(400).json({ error: "عميل غير صالح" }); return;
    }
    const planItemIdRaw = numOrNull(b.planItemId);
    if (planItemIdRaw) {
      const [pi] = await db.select({ planId: fieldVisitPlanItemsTable.planId })
        .from(fieldVisitPlanItemsTable).where(eq(fieldVisitPlanItemsTable.id, planItemIdRaw)).limit(1);
      if (!pi || !(await assertTenant(fieldVisitPlansTable, pi.planId, cid))) {
        res.status(400).json({ error: "بند خطة غير صالح" }); return;
      }
    }

    const [row] = await db.insert(fieldVisitsTable).values({
      companyId: cid,
      employeeId,
      locationId: locationId ?? null,
      locationName: location?.name ?? N(b.locationName),
      locationType: location?.type ?? null,
      customerId: customerIdRaw ?? location?.customerId ?? null,
      projectId: numOrNull(b.projectId) ?? location?.projectId ?? null,
      assetId: numOrNull(b.assetId) ?? location?.assetId ?? null,
      ticketId: ticketIdRaw,
      costCenterId: numOrNull(b.costCenterId) ?? location?.costCenterId ?? null,
      purpose: String(b.purpose ?? "site_visit"),
      status: "open",
      arrivedAt: new Date(),
      arrivalLat: validCoord(lat, lng) ? String(lat) : null,
      arrivalLng: validCoord(lat, lng) ? String(lng) : null,
      arrivalAccuracyM: accuracy != null && Number.isFinite(accuracy) ? String(accuracy) : null,
      arrivalDistanceM: distanceM != null ? String(distanceM.toFixed(2)) : null,
      arrivalLocStatus: locStatus,
      photoUrl: N(b.photoUrl),
      notes: N(b.notes),
    }).returning();

    // If this visit closes a service-ticket assignment, mark the ticket as
    // "in_progress" and stamp respondedAt (first-arrival SLA).
    if (row.ticketId) {
      const [t] = await db.select().from(fieldServiceTicketsTable)
        .where(and(eq(fieldServiceTicketsTable.id, row.ticketId), eq(fieldServiceTicketsTable.companyId, cid)))
        .limit(1);
      if (t && !t.respondedAt) {
        const responseMin = Math.round((Date.now() - new Date(t.openedAt).getTime()) / 60000);
        await db.update(fieldServiceTicketsTable).set({
          respondedAt: new Date(),
          status: "in_progress",
          slaResponseBreached: responseMin > t.slaResponseMin,
          updatedAt: new Date(),
        }).where(eq(fieldServiceTicketsTable.id, row.ticketId));
      }
    }

    // If this visit corresponds to a planned-route item, mark it done.
    const planItemId = numOrNull(b.planItemId);
    if (planItemId) {
      await db.update(fieldVisitPlanItemsTable).set({ status: "done", visitId: row.id })
        .where(eq(fieldVisitPlanItemsTable.id, planItemId));
    }

    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/visits/:id/end", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const [v] = await db.select().from(fieldVisitsTable)
      .where(and(eq(fieldVisitsTable.id, id), eq(fieldVisitsTable.companyId, cid))).limit(1);
    if (!v) { res.status(404).json({ error: "زيارة غير موجودة" }); return; }
    if (v.status !== "open") { res.status(409).json({ error: "الزيارة مغلقة بالفعل" }); return; }
    // Ownership: non-managers must pass the matching employeeId. AuthUser
    // currently has no employeeId mapping, so this is the strongest check
    // available short of a full user↔employee link migration.
    if (!isManager(req)) {
      const claimedEmpId = numOrNull(b.employeeId);
      if (!claimedEmpId || claimedEmpId !== v.employeeId) {
        res.status(403).json({ error: "لا يمكنك إنهاء زيارة موظف آخر" }); return;
      }
    }
    const lat = numOrNull(b.lat);
    const lng = numOrNull(b.lng);
    const accuracy = numOrNull(b.accuracy);
    const now = new Date();
    const durationMin = Math.max(1, Math.round((now.getTime() - new Date(v.arrivedAt).getTime()) / 60000));
    const [row] = await db.update(fieldVisitsTable).set({
      status: "completed",
      leftAt: now,
      durationMin,
      departureLat: validCoord(lat, lng) ? String(lat) : null,
      departureLng: validCoord(lat, lng) ? String(lng) : null,
      departureAccuracyM: accuracy != null && Number.isFinite(accuracy) ? String(accuracy) : null,
      outcome: N(b.outcome),
      notes: b.notes != null ? N(b.notes) : v.notes,
      signatureUrl: N(b.signatureUrl) ?? v.signatureUrl,
      signedByName: N(b.signedByName) ?? v.signedByName,
      formData: b.formData ?? v.formData,
      updatedAt: now,
    }).where(eq(fieldVisitsTable.id, id)).returning();

    // Auto-resolve the linked ticket if requested. Tenant-scoped on both
    // SELECT and UPDATE — prevents foreign-tenant ticket mutation.
    if (v.ticketId && (b.resolveTicket || b.resolveTicket === "1")) {
      const [t] = await db.select().from(fieldServiceTicketsTable)
        .where(and(
          eq(fieldServiceTicketsTable.id, v.ticketId),
          eq(fieldServiceTicketsTable.companyId, cid),
        )).limit(1);
      if (t && !t.resolvedAt) {
        const resolutionMin = Math.round((Date.now() - new Date(t.openedAt).getTime()) / 60000);
        await db.update(fieldServiceTicketsTable).set({
          resolvedAt: now,
          status: "resolved",
          slaResolutionBreached: resolutionMin > t.slaResolutionMin,
          resolution: N(b.resolution) ?? t.resolution,
          updatedAt: now,
        }).where(and(
          eq(fieldServiceTicketsTable.id, v.ticketId),
          eq(fieldServiceTicketsTable.companyId, cid),
        ));
      }
    }

    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/visits/:id/cancel", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const [v] = await db.select({ employeeId: fieldVisitsTable.employeeId, status: fieldVisitsTable.status })
      .from(fieldVisitsTable)
      .where(and(eq(fieldVisitsTable.id, id), eq(fieldVisitsTable.companyId, cid))).limit(1);
    if (!v) { res.status(404).json({ error: "زيارة غير موجودة" }); return; }
    if (v.status !== "open") { res.status(409).json({ error: "الزيارة مغلقة بالفعل" }); return; }
    if (!isManager(req)) {
      const claimedEmpId = numOrNull(b.employeeId);
      if (!claimedEmpId || claimedEmpId !== v.employeeId) {
        res.status(403).json({ error: "لا يمكنك إلغاء زيارة موظف آخر" }); return;
      }
    }
    const [row] = await db.update(fieldVisitsTable).set({
      status: "cancelled", leftAt: new Date(), updatedAt: new Date(),
      notes: N(b.notes),
    }).where(and(eq(fieldVisitsTable.id, id), eq(fieldVisitsTable.companyId, cid),
      eq(fieldVisitsTable.status, "open"))).returning();
    if (!row) { res.status(404).json({ error: "زيارة غير موجودة أو مغلقة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// List visits with rich filters. Manager-gated.
router.get("/visits", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const employeeId = numOrNull(req.query.employeeId);
    const status = req.query.status as string | undefined;
    const from = (req.query.from as string) || null;
    const to = (req.query.to as string) || null;
    const rows = await db.select({
      id: fieldVisitsTable.id,
      employeeId: fieldVisitsTable.employeeId,
      employeeName: employeesTable.nameAr,
      employeeCode: employeesTable.code,
      employeePhotoUrl: employeesTable.photoUrl,
      locationId: fieldVisitsTable.locationId,
      locationName: fieldVisitsTable.locationName,
      locationType: fieldVisitsTable.locationType,
      customerId: fieldVisitsTable.customerId,
      ticketId: fieldVisitsTable.ticketId,
      purpose: fieldVisitsTable.purpose,
      status: fieldVisitsTable.status,
      arrivedAt: fieldVisitsTable.arrivedAt,
      leftAt: fieldVisitsTable.leftAt,
      durationMin: fieldVisitsTable.durationMin,
      arrivalLat: fieldVisitsTable.arrivalLat,
      arrivalLng: fieldVisitsTable.arrivalLng,
      arrivalDistanceM: fieldVisitsTable.arrivalDistanceM,
      arrivalLocStatus: fieldVisitsTable.arrivalLocStatus,
      outcome: fieldVisitsTable.outcome,
      notes: fieldVisitsTable.notes,
    }).from(fieldVisitsTable)
      .innerJoin(employeesTable, eq(employeesTable.id, fieldVisitsTable.employeeId))
      .where(and(
        eq(fieldVisitsTable.companyId, cid),
        employeeId ? eq(fieldVisitsTable.employeeId, employeeId) : sql`true`,
        status ? eq(fieldVisitsTable.status, status) : sql`true`,
        from ? gte(fieldVisitsTable.arrivedAt, new Date(from)) : sql`true`,
        to ? lte(fieldVisitsTable.arrivedAt, new Date(`${to}T23:59:59`)) : sql`true`,
      ))
      .orderBy(desc(fieldVisitsTable.arrivedAt))
      .limit(500);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Mobile-friendly: today's visits for a single employee (open + closed).
// Manager-gated for now — non-manager self-serve requires a future
// user↔employee mapping (AuthUser has no employeeId today). Without it,
// any authed user could query another employee's day via :employeeId,
// which is an IDOR. Mobile check-in's start/end paths still work (start
// requires picking the employee; end requires matching employeeId).
router.get("/visits/today/:employeeId", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const employeeId = Number(req.params.employeeId);
    const today = new Date(); today.setHours(0,0,0,0);
    const rows = await db.select().from(fieldVisitsTable)
      .where(and(
        eq(fieldVisitsTable.companyId, cid),
        eq(fieldVisitsTable.employeeId, employeeId),
        gte(fieldVisitsTable.arrivedAt, today),
      ))
      .orderBy(desc(fieldVisitsTable.arrivedAt));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// VISIT PLANS — manager pre-builds daily route for sales reps / techs
// ════════════════════════════════════════════════════════════════════════

router.get("/plans", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const employeeId = numOrNull(req.query.employeeId);
    const date = req.query.date as string | undefined;
    const plans = await db.select({
      id: fieldVisitPlansTable.id,
      employeeId: fieldVisitPlansTable.employeeId,
      employeeName: employeesTable.nameAr,
      date: fieldVisitPlansTable.date,
      status: fieldVisitPlansTable.status,
      notes: fieldVisitPlansTable.notes,
      createdAt: fieldVisitPlansTable.createdAt,
    }).from(fieldVisitPlansTable)
      .innerJoin(employeesTable, eq(employeesTable.id, fieldVisitPlansTable.employeeId))
      .where(and(
        eq(fieldVisitPlansTable.companyId, cid),
        employeeId ? eq(fieldVisitPlansTable.employeeId, employeeId) : sql`true`,
        date ? eq(fieldVisitPlansTable.date, date) : sql`true`,
      ))
      .orderBy(desc(fieldVisitPlansTable.date))
      .limit(200);
    res.json(plans);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/plans/:id", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const id = Number(req.params.id);
    const [plan] = await db.select().from(fieldVisitPlansTable)
      .where(and(eq(fieldVisitPlansTable.id, id), eq(fieldVisitPlansTable.companyId, cid))).limit(1);
    if (!plan) { res.status(404).json({ error: "خطة غير موجودة" }); return; }
    const items = await db.select({
      id: fieldVisitPlanItemsTable.id,
      sequenceNo: fieldVisitPlanItemsTable.sequenceNo,
      locationId: fieldVisitPlanItemsTable.locationId,
      locationName: fieldVisitPlanItemsTable.locationName,
      plannedAt: fieldVisitPlanItemsTable.plannedAt,
      purpose: fieldVisitPlanItemsTable.purpose,
      status: fieldVisitPlanItemsTable.status,
      visitId: fieldVisitPlanItemsTable.visitId,
      notes: fieldVisitPlanItemsTable.notes,
      lat: fieldLocationsTable.lat,
      lng: fieldLocationsTable.lng,
      address: fieldLocationsTable.address,
    }).from(fieldVisitPlanItemsTable)
      .leftJoin(fieldLocationsTable, eq(fieldLocationsTable.id, fieldVisitPlanItemsTable.locationId))
      .where(eq(fieldVisitPlanItemsTable.planId, id))
      .orderBy(asc(fieldVisitPlanItemsTable.sequenceNo));
    res.json({ ...plan, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/plans", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const b = req.body ?? {};
    const employeeId = numOrNull(b.employeeId);
    const date = String(b.date ?? "").slice(0, 10);
    if (!employeeId || !date) { res.status(400).json({ error: "employeeId و date مطلوبان" }); return; }
    if (!(await assertTenant(employeesTable, employeeId, cid))) {
      res.status(400).json({ error: "موظف غير صالح" }); return;
    }
    const items = Array.isArray(b.items) ? b.items : [];
    const [plan] = await db.insert(fieldVisitPlansTable).values({
      companyId: cid, employeeId, date, status: String(b.status ?? "published"),
      notes: N(b.notes), createdBy: req.authUser?.id ?? null,
    }).returning();
    if (items.length > 0) {
      const locIds = items.map((it: any) => numOrNull(it.locationId)).filter(Boolean) as number[];
      const locs = locIds.length > 0 ? await db.select().from(fieldLocationsTable)
        .where(and(eq(fieldLocationsTable.companyId, cid), inArray(fieldLocationsTable.id, locIds))) : [];
      const locMap = new Map(locs.map(l => [l.id, l.name]));
      await db.insert(fieldVisitPlanItemsTable).values(items.map((it: any, i: number) => ({
        planId: plan.id,
        sequenceNo: numOrNull(it.sequenceNo) ?? (i + 1),
        locationId: numOrNull(it.locationId),
        locationName: locMap.get(numOrNull(it.locationId) ?? -1) ?? N(it.locationName),
        plannedAt: it.plannedAt ? new Date(it.plannedAt) : null,
        purpose: N(it.purpose),
        status: "pending",
        notes: N(it.notes),
      })));
    }
    res.status(201).json(plan);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/plans/:id", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const id = Number(req.params.id);
    const [row] = await db.delete(fieldVisitPlansTable)
      .where(and(eq(fieldVisitPlansTable.id, id), eq(fieldVisitPlansTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "خطة غير موجودة" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Today's plan items. Manager-gated for the same IDOR reason as
// /visits/today/:employeeId above.
router.get("/plans/today/:employeeId", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const employeeId = Number(req.params.employeeId);
    const today = new Date().toISOString().slice(0, 10);
    const [plan] = await db.select().from(fieldVisitPlansTable)
      .where(and(
        eq(fieldVisitPlansTable.companyId, cid),
        eq(fieldVisitPlansTable.employeeId, employeeId),
        eq(fieldVisitPlansTable.date, today),
      )).limit(1);
    if (!plan) { res.json({ plan: null, items: [] }); return; }
    const items = await db.select({
      id: fieldVisitPlanItemsTable.id,
      sequenceNo: fieldVisitPlanItemsTable.sequenceNo,
      locationId: fieldVisitPlanItemsTable.locationId,
      locationName: fieldVisitPlanItemsTable.locationName,
      plannedAt: fieldVisitPlanItemsTable.plannedAt,
      purpose: fieldVisitPlanItemsTable.purpose,
      status: fieldVisitPlanItemsTable.status,
      visitId: fieldVisitPlanItemsTable.visitId,
      lat: fieldLocationsTable.lat,
      lng: fieldLocationsTable.lng,
      address: fieldLocationsTable.address,
      radiusM: fieldLocationsTable.radiusM,
    }).from(fieldVisitPlanItemsTable)
      .leftJoin(fieldLocationsTable, eq(fieldLocationsTable.id, fieldVisitPlanItemsTable.locationId))
      .where(eq(fieldVisitPlanItemsTable.planId, plan.id))
      .orderBy(asc(fieldVisitPlanItemsTable.sequenceNo));
    res.json({ plan, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// SERVICE TICKETS — FSM with SLA timers
// ════════════════════════════════════════════════════════════════════════

const PRIORITY_SLA: Record<string, { resp: number; res: number }> = {
  urgent: { resp: 30,  res: 240 },
  high:   { resp: 60,  res: 480 },
  medium: { resp: 240, res: 1440 },
  low:    { resp: 480, res: 4320 },
};

async function nextTicketNo(companyId: number): Promise<string> {
  // Race-safe: caller wraps insert in try/catch and retries on 23505 unique
  // violation. The (company_id, ticket_no) unique index is enforced in
  // ensureSchema.
  const year = new Date().getFullYear();
  const prefix = `SR-${year}-`;
  const [last] = await db.select({ ticketNo: fieldServiceTicketsTable.ticketNo })
    .from(fieldServiceTicketsTable)
    .where(and(
      eq(fieldServiceTicketsTable.companyId, companyId),
      sql`${fieldServiceTicketsTable.ticketNo} LIKE ${prefix + "%"}`,
    ))
    .orderBy(desc(fieldServiceTicketsTable.id)).limit(1);
  const n = last?.ticketNo ? Number(last.ticketNo.split("-")[2]) : 0;
  return `${prefix}${String((Number.isFinite(n) ? n : 0) + 1).padStart(4, "0")}`;
}

router.get("/tickets", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const status = req.query.status as string | undefined;
    const assignedTo = numOrNull(req.query.assignedTo);
    const rows = await db.select({
      id: fieldServiceTicketsTable.id,
      ticketNo: fieldServiceTicketsTable.ticketNo,
      title: fieldServiceTicketsTable.title,
      category: fieldServiceTicketsTable.category,
      priority: fieldServiceTicketsTable.priority,
      status: fieldServiceTicketsTable.status,
      openedAt: fieldServiceTicketsTable.openedAt,
      respondedAt: fieldServiceTicketsTable.respondedAt,
      resolvedAt: fieldServiceTicketsTable.resolvedAt,
      slaResponseMin: fieldServiceTicketsTable.slaResponseMin,
      slaResolutionMin: fieldServiceTicketsTable.slaResolutionMin,
      slaResponseBreached: fieldServiceTicketsTable.slaResponseBreached,
      slaResolutionBreached: fieldServiceTicketsTable.slaResolutionBreached,
      customerId: fieldServiceTicketsTable.customerId,
      customerName: customersTable.nameAr,
      assignedTo: fieldServiceTicketsTable.assignedTo,
      assignedToName: employeesTable.nameAr,
      locationId: fieldServiceTicketsTable.locationId,
      totalCost: fieldServiceTicketsTable.totalCost,
    }).from(fieldServiceTicketsTable)
      .leftJoin(customersTable, eq(customersTable.id, fieldServiceTicketsTable.customerId))
      .leftJoin(employeesTable, eq(employeesTable.id, fieldServiceTicketsTable.assignedTo))
      .where(and(
        eq(fieldServiceTicketsTable.companyId, cid),
        status ? eq(fieldServiceTicketsTable.status, status) : sql`true`,
        assignedTo ? eq(fieldServiceTicketsTable.assignedTo, assignedTo) : sql`true`,
      ))
      .orderBy(desc(fieldServiceTicketsTable.openedAt))
      .limit(300);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/tickets/:id", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const id = Number(req.params.id);
    const [t] = await db.select().from(fieldServiceTicketsTable)
      .where(and(eq(fieldServiceTicketsTable.id, id), eq(fieldServiceTicketsTable.companyId, cid))).limit(1);
    if (!t) { res.status(404).json({ error: "تذكرة غير موجودة" }); return; }
    const visits = await db.select().from(fieldVisitsTable)
      .where(and(
        eq(fieldVisitsTable.ticketId, id),
        eq(fieldVisitsTable.companyId, cid),
      ))
      .orderBy(desc(fieldVisitsTable.arrivedAt));
    res.json({ ...t, visits });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/tickets", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const b = req.body ?? {};
    if (!b.title) { res.status(400).json({ error: "عنوان التذكرة مطلوب" }); return; }
    const priority = String(b.priority ?? "medium");
    const sla = PRIORITY_SLA[priority] ?? PRIORITY_SLA.medium;
    const customerIdT = numOrNull(b.customerId);
    if (customerIdT && !(await assertTenant(customersTable, customerIdT, cid))) {
      res.status(400).json({ error: "عميل غير صالح" }); return;
    }
    // Retry once on unique-violation (23505) — concurrent ticket creates can
    // race nextTicketNo otherwise.
    let row: any = null;
    for (let attempt = 0; attempt < 3 && !row; attempt++) {
      const ticketNo = await nextTicketNo(cid);
      try {
        [row] = await db.insert(fieldServiceTicketsTable).values({
          companyId: cid,
          branchId: numOrNull(b.branchId),
          ticketNo,
          customerId: customerIdT,
          assetId: numOrNull(b.assetId),
          locationId: numOrNull(b.locationId),
          title: String(b.title).trim(),
          description: N(b.description),
          category: String(b.category ?? "repair"),
          priority,
          status: "open",
          openedAt: new Date(),
          openedBy: req.authUser?.id ?? null,
          slaResponseMin: numOrNull(b.slaResponseMin) ?? sla.resp,
          slaResolutionMin: numOrNull(b.slaResolutionMin) ?? sla.res,
          notes: N(b.notes),
        }).returning();
      } catch (err: any) {
        if (err?.code !== "23505") throw err;
      }
    }
    if (!row) { res.status(500).json({ error: "تعذر إنشاء رقم تذكرة فريد" }); return; }
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/tickets/:id", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const patch: any = { updatedAt: new Date() };
    for (const k of ["title","description","category","priority","status","resolution","notes"] as const) {
      if (b[k] !== undefined) patch[k] = N(b[k]);
    }
    for (const k of ["customerId","assetId","locationId","branchId","slaResponseMin","slaResolutionMin","customerRating"] as const) {
      if (b[k] !== undefined) patch[k] = numOrNull(b[k]);
    }
    for (const k of ["laborHours","laborCost","partsCost","totalCost"] as const) {
      if (b[k] !== undefined) {
        const n = numOrNull(b[k]);
        patch[k] = n != null ? String(n) : null;
      }
    }
    const [row] = await db.update(fieldServiceTicketsTable).set(patch)
      .where(and(eq(fieldServiceTicketsTable.id, id), eq(fieldServiceTicketsTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "تذكرة غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/tickets/:id/assign", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const id = Number(req.params.id);
    const employeeId = numOrNull(req.body?.employeeId);
    if (!employeeId) { res.status(400).json({ error: "employeeId مطلوب" }); return; }
    if (!(await assertTenant(employeesTable, employeeId, cid))) {
      res.status(400).json({ error: "موظف غير صالح" }); return;
    }
    const [row] = await db.update(fieldServiceTicketsTable).set({
      assignedTo: employeeId,
      assignedAt: new Date(),
      status: "assigned",
      updatedAt: new Date(),
    }).where(and(eq(fieldServiceTicketsTable.id, id), eq(fieldServiceTicketsTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "تذكرة غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/tickets/:id/resolve", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const id = Number(req.params.id);
    const [t] = await db.select().from(fieldServiceTicketsTable)
      .where(and(eq(fieldServiceTicketsTable.id, id), eq(fieldServiceTicketsTable.companyId, cid))).limit(1);
    if (!t) { res.status(404).json({ error: "تذكرة غير موجودة" }); return; }
    if (t.status === "resolved" || t.status === "closed") {
      res.status(409).json({ error: "التذكرة محلولة بالفعل" }); return;
    }
    const now = new Date();
    const resolutionMin = Math.round((now.getTime() - new Date(t.openedAt).getTime()) / 60000);
    const [row] = await db.update(fieldServiceTicketsTable).set({
      status: "resolved",
      resolvedAt: now,
      slaResolutionBreached: resolutionMin > t.slaResolutionMin,
      resolution: N(req.body?.resolution) ?? t.resolution,
      updatedAt: now,
    }).where(eq(fieldServiceTicketsTable.id, id)).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/tickets/:id/close", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const id = Number(req.params.id);
    const [row] = await db.update(fieldServiceTicketsTable).set({
      status: "closed", closedAt: new Date(), updatedAt: new Date(),
      customerRating: numOrNull(req.body?.customerRating),
    }).where(and(eq(fieldServiceTicketsTable.id, id), eq(fieldServiceTicketsTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "تذكرة غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// REPORTS & TRACKING
// ════════════════════════════════════════════════════════════════════════

// Per-employee field summary for a date range — visits, on-site time,
// avg distance per visit, outcome breakdown.
router.get("/reports/summary", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const employeeId = numOrNull(req.query.employeeId);
    const from = (req.query.from as string) || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
    const rows = await db.select({
      employeeId: fieldVisitsTable.employeeId,
      employeeName: employeesTable.nameAr,
      totalVisits: sql<number>`count(*)::int`,
      completedVisits: sql<number>`count(*) filter (where ${fieldVisitsTable.status} = 'completed')::int`,
      openVisits: sql<number>`count(*) filter (where ${fieldVisitsTable.status} = 'open')::int`,
      totalMinutes: sql<number>`coalesce(sum(${fieldVisitsTable.durationMin}), 0)::int`,
      flaggedVisits: sql<number>`count(*) filter (where ${fieldVisitsTable.arrivalLocStatus} <> 'ok')::int`,
      uniqueLocations: sql<number>`count(distinct ${fieldVisitsTable.locationId})::int`,
    }).from(fieldVisitsTable)
      .innerJoin(employeesTable, eq(employeesTable.id, fieldVisitsTable.employeeId))
      .where(and(
        eq(fieldVisitsTable.companyId, cid),
        gte(fieldVisitsTable.arrivedAt, new Date(from)),
        lte(fieldVisitsTable.arrivedAt, new Date(`${to}T23:59:59`)),
        employeeId ? eq(fieldVisitsTable.employeeId, employeeId) : sql`true`,
      ))
      .groupBy(fieldVisitsTable.employeeId, employeesTable.nameAr)
      .orderBy(desc(sql`count(*)`));
    res.json({ from, to, rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// SLA dashboard — open/breached/avg-response/avg-resolution.
router.get("/reports/sla", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const from = (req.query.from as string) || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
    const [agg] = await db.select({
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${fieldServiceTicketsTable.status} in ('open','assigned','in_progress','on_hold'))::int`,
      resolved: sql<number>`count(*) filter (where ${fieldServiceTicketsTable.status} in ('resolved','closed'))::int`,
      respBreached: sql<number>`count(*) filter (where ${fieldServiceTicketsTable.slaResponseBreached} = true)::int`,
      resBreached: sql<number>`count(*) filter (where ${fieldServiceTicketsTable.slaResolutionBreached} = true)::int`,
      avgResponseMin: sql<number>`coalesce(avg(extract(epoch from (${fieldServiceTicketsTable.respondedAt} - ${fieldServiceTicketsTable.openedAt})) / 60) filter (where ${fieldServiceTicketsTable.respondedAt} is not null), 0)::int`,
      avgResolutionMin: sql<number>`coalesce(avg(extract(epoch from (${fieldServiceTicketsTable.resolvedAt} - ${fieldServiceTicketsTable.openedAt})) / 60) filter (where ${fieldServiceTicketsTable.resolvedAt} is not null), 0)::int`,
      avgRating: sql<number>`coalesce(avg(${fieldServiceTicketsTable.customerRating}), 0)::float`,
    }).from(fieldServiceTicketsTable)
      .where(and(
        eq(fieldServiceTicketsTable.companyId, cid),
        gte(fieldServiceTicketsTable.openedAt, new Date(from)),
        lte(fieldServiceTicketsTable.openedAt, new Date(`${to}T23:59:59`)),
      ));
    const byPriority = await db.select({
      priority: fieldServiceTicketsTable.priority,
      total: sql<number>`count(*)::int`,
      respBreached: sql<number>`count(*) filter (where ${fieldServiceTicketsTable.slaResponseBreached} = true)::int`,
      resBreached: sql<number>`count(*) filter (where ${fieldServiceTicketsTable.slaResolutionBreached} = true)::int`,
    }).from(fieldServiceTicketsTable)
      .where(and(
        eq(fieldServiceTicketsTable.companyId, cid),
        gte(fieldServiceTicketsTable.openedAt, new Date(from)),
        lte(fieldServiceTicketsTable.openedAt, new Date(`${to}T23:59:59`)),
      ))
      .groupBy(fieldServiceTicketsTable.priority);
    res.json({ from, to, summary: agg, byPriority });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Live tracking — latest known position per active employee (open visit OR
// most recent completed visit today). Used by the manager's tracking map.
router.get("/tracking/live", async (req, res) => {
  try {
    if (denyKiosk(req, res)) return;
    const cid = guard(req, res); if (!cid) return;
    if (requireManager(req, res)) return;
    const today = new Date(); today.setHours(0,0,0,0);
    const rows = await db.execute(sql`
      SELECT DISTINCT ON (v.employee_id)
        v.employee_id, e.name_ar as employee_name, e.code as employee_code,
        e.photo_url as employee_photo_url,
        v.id as visit_id, v.status, v.location_name, v.arrived_at, v.left_at,
        v.arrival_lat, v.arrival_lng, v.departure_lat, v.departure_lng,
        v.purpose, v.duration_min
      FROM field_visits v
      JOIN employees e ON e.id = v.employee_id
      WHERE v.company_id = ${cid}
        AND v.arrived_at >= ${today}
      ORDER BY v.employee_id, v.arrived_at DESC
    `);
    res.json(rows.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
