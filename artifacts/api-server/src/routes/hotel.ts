// ─────────────────────────────────────────────────────────────────────────
// Hotel ERP — multi-company hotel management.
// Hotels, rooms, guests, bookings, payments, housekeeping. Multi-tenant
// (companyId scoped). RBAC gate: module key "hotel". SuperAdmin bypasses.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  hotelsTable,
  hotelRoomsTable,
  hotelGuestsTable,
  hotelBookingsTable,
  hotelPaymentsTable,
  hotelHousekeepingTable,
} from "@workspace/db";
import { and, desc, eq, sql, inArray, gte, lte, ne } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { nextSequenceOrFallback } from "../lib/sequences.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("hotel"));
router.use(moduleAudit("hotel"));
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query.companyId);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function requireCid(req: any, res: any): number | null {
  const raw = req.query.companyId ? Number(req.query.companyId) : undefined;
  const cid = resolveCompanyId(req, raw);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// Cross-tenant FK guard. Returns true if the referenced row exists AND belongs to cid.
async function ownsRow(table: any, id: number, cid: number): Promise<boolean> {
  if (!Number.isFinite(id) || id <= 0) return false;
  const [r] = await db.select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.companyId, cid)));
  return !!r;
}
async function assertOwn(
  res: any, table: any, id: number, cid: number, label: string,
): Promise<boolean> {
  const ok = await ownsRow(table, id, cid);
  if (!ok) { res.status(404).json({ error: `${label} غير موجود` }); return false; }
  return true;
}

async function nextCode(
  cid: number,
  table: any,
  prefix: string,
  field: "code" | "docNumber" | "roomNumber",
): Promise<string> {
  const col = field === "docNumber" ? table.docNumber : (field === "roomNumber" ? table.roomNumber : table.code);
  const rows = await db.select({ v: col }).from(table).where(eq(table.companyId, cid));
  let max = 0;
  for (const r of rows) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(String(r.v).trim());
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > max) max = n; }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

const HOTEL_STATUSES   = ["active","inactive","under_renovation"] as const;
const ROOM_TYPES       = ["single","double","twin","triple","suite","deluxe","family"] as const;
const ROOM_STATUSES    = ["available","occupied","reserved","cleaning","maintenance","out_of_service"] as const;
const BOOKING_STATUSES = ["pending","confirmed","checked_in","checked_out","cancelled","no_show"] as const;
const PAYMENT_METHODS  = ["cash","card","bank_transfer","online","other"] as const;
const PAYMENT_STATUSES = ["pending","completed","failed","refunded"] as const;
const HK_STATUSES      = ["pending","in_progress","done","skipped"] as const;
const HK_PRIORITIES    = ["low","medium","high","urgent"] as const;
const HK_TASK_TYPES    = ["cleaning","linen_change","deep_clean","inspection","restock","other"] as const;

// ════════════════════════════════════════════════════════════════════════
// HOTELS
// ════════════════════════════════════════════════════════════════════════
router.get("/hotels", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(hotelsTable)
      .where(eq(hotelsTable.companyId, cid))
      .orderBy(desc(hotelsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/hotels/:id", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.select().from(hotelsTable)
      .where(and(eq(hotelsTable.id, id), eq(hotelsTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "الفندق غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/hotels", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const nameAr = String(b.nameAr ?? "").trim();
    if (!nameAr) { res.status(400).json({ error: "اسم الفندق مطلوب" }); return; }
    const code = String(b.code ?? "").trim() || await nextCode(cid, hotelsTable, "HOT", "code");
    const ratingNum = Math.max(1, Math.min(5, Number(b.rating ?? 3)));
    const [row] = await db.insert(hotelsTable).values({
      companyId:    cid,
      branchId:     b.branchId ? Number(b.branchId) : null,
      code,
      nameAr,
      nameEn:       b.nameEn || null,
      location:     b.location || null,
      rating:       ratingNum,
      status:       (HOTEL_STATUSES as readonly string[]).includes(b.status) ? b.status : "active",
      contactPhone: b.contactPhone || null,
      contactEmail: b.contactEmail || null,
      notes:        b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    if (String(e?.message).includes("duplicate") || e?.code === "23505")
      return res.status(409).json({ error: "كود الفندق مستخدم مسبقاً" });
    res.status(500).json({ error: e.message });
  }
});

router.put("/hotels/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const ratingNum = b.rating != null ? Math.max(1, Math.min(5, Number(b.rating))) : undefined;
    const [row] = await db.update(hotelsTable).set({
      branchId:     b.branchId ? Number(b.branchId) : null,
      code:         b.code != null ? String(b.code).trim() : undefined,
      nameAr:       b.nameAr != null ? String(b.nameAr).trim() : undefined,
      nameEn:       b.nameEn ?? null,
      location:     b.location ?? null,
      rating:       ratingNum,
      status:       (HOTEL_STATUSES as readonly string[]).includes(b.status) ? b.status : undefined,
      contactPhone: b.contactPhone ?? null,
      contactEmail: b.contactEmail ?? null,
      notes:        b.notes ?? null,
      updatedAt:    new Date(),
    }).where(and(eq(hotelsTable.id, id), eq(hotelsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الفندق غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/hotels/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(hotelRoomsTable).where(and(eq(hotelRoomsTable.companyId, cid), eq(hotelRoomsTable.hotelId, id)));
    if (n > 0) {
      res.status(409).json({ error: `لا يمكن حذف الفندق — يحتوي على ${n} غرفة. احذف الغرف أولاً أو غيّر حالة الفندق.` });
      return;
    }
    await db.delete(hotelsTable).where(and(eq(hotelsTable.id, id), eq(hotelsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// ROOMS
// ════════════════════════════════════════════════════════════════════════
router.get("/rooms", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const hotelId = req.query.hotelId ? Number(req.query.hotelId) : undefined;
    const where = hotelId
      ? and(eq(hotelRoomsTable.companyId, cid), eq(hotelRoomsTable.hotelId, hotelId))
      : eq(hotelRoomsTable.companyId, cid);
    const rows = await db.select({
      r: hotelRoomsTable,
      hotelName: hotelsTable.nameAr,
    })
      .from(hotelRoomsTable)
      .leftJoin(hotelsTable, eq(hotelsTable.id, hotelRoomsTable.hotelId))
      .where(where)
      .orderBy(desc(hotelRoomsTable.id));
    res.json(rows.map(r => ({ ...r.r, hotelName: r.hotelName })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Available rooms in a date range (excludes ones blocked by overlapping bookings).
router.get("/rooms/available", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const hotelId = req.query.hotelId ? Number(req.query.hotelId) : undefined;
    const checkIn  = req.query.checkIn  ? String(req.query.checkIn)  : null;
    const checkOut = req.query.checkOut ? String(req.query.checkOut) : null;
    if (!checkIn || !checkOut) { res.status(400).json({ error: "تاريخ الدخول والخروج مطلوبان" }); return; }

    // Find rooms with overlapping bookings (status confirmed | checked_in).
    const blocked = await db.select({ id: hotelBookingsTable.roomId })
      .from(hotelBookingsTable)
      .where(and(
        eq(hotelBookingsTable.companyId, cid),
        sql`${hotelBookingsTable.status} IN ('confirmed','checked_in','pending')`,
        lte(hotelBookingsTable.checkIn, checkOut),
        gte(hotelBookingsTable.checkOut, checkIn),
      ));
    const blockedIds = blocked.map(b => b.id);
    const conditions = [
      eq(hotelRoomsTable.companyId, cid),
      sql`${hotelRoomsTable.status} NOT IN ('out_of_service','maintenance')`,
    ];
    if (hotelId) conditions.push(eq(hotelRoomsTable.hotelId, hotelId));
    if (blockedIds.length > 0) conditions.push(sql`${hotelRoomsTable.id} NOT IN (${sql.join(blockedIds.map(i => sql`${i}`), sql`, `)})`);

    const rows = await db.select().from(hotelRoomsTable).where(and(...conditions));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/rooms", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    if (!b.hotelId)    { res.status(400).json({ error: "الفندق مطلوب" }); return; }
    if (!b.roomNumber) { res.status(400).json({ error: "رقم الغرفة مطلوب" }); return; }
    if (!await assertOwn(res, hotelsTable, Number(b.hotelId), cid, "الفندق")) return;
    const [row] = await db.insert(hotelRoomsTable).values({
      companyId:  cid,
      hotelId:    Number(b.hotelId),
      roomNumber: String(b.roomNumber).trim(),
      roomType:   (ROOM_TYPES as readonly string[]).includes(b.roomType) ? b.roomType : "double",
      basePrice:  b.basePrice != null ? String(b.basePrice) : "0",
      status:     (ROOM_STATUSES as readonly string[]).includes(b.status) ? b.status : "available",
      capacity:   Math.max(1, Number(b.capacity ?? 2)),
      floor:      b.floor || null,
      features:   b.features || null,
      notes:      b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/rooms/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    if (b.hotelId && !await assertOwn(res, hotelsTable, Number(b.hotelId), cid, "الفندق")) return;
    const [row] = await db.update(hotelRoomsTable).set({
      hotelId:    b.hotelId ? Number(b.hotelId) : undefined,
      roomNumber: b.roomNumber != null ? String(b.roomNumber).trim() : undefined,
      roomType:   (ROOM_TYPES as readonly string[]).includes(b.roomType) ? b.roomType : undefined,
      basePrice:  b.basePrice != null ? String(b.basePrice) : undefined,
      status:     (ROOM_STATUSES as readonly string[]).includes(b.status) ? b.status : undefined,
      capacity:   b.capacity != null ? Math.max(1, Number(b.capacity)) : undefined,
      floor:      b.floor ?? null,
      features:   b.features ?? null,
      notes:      b.notes ?? null,
      updatedAt:  new Date(),
    }).where(and(eq(hotelRoomsTable.id, id), eq(hotelRoomsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الغرفة غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/rooms/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(hotelBookingsTable).where(and(eq(hotelBookingsTable.companyId, cid), eq(hotelBookingsTable.roomId, id)));
    if (n > 0) {
      res.status(409).json({ error: `لا يمكن حذف الغرفة — مرتبطة بـ ${n} حجز. غيّر حالتها بدلاً من ذلك.` });
      return;
    }
    await db.delete(hotelRoomsTable).where(and(eq(hotelRoomsTable.id, id), eq(hotelRoomsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// GUESTS
// ════════════════════════════════════════════════════════════════════════
router.get("/guests", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(hotelGuestsTable)
      .where(eq(hotelGuestsTable.companyId, cid))
      .orderBy(desc(hotelGuestsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/guests", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const fullNameAr = String(b.fullNameAr ?? "").trim();
    if (!fullNameAr) { res.status(400).json({ error: "اسم النزيل مطلوب" }); return; }
    const code = String(b.code ?? "").trim() || await nextCode(cid, hotelGuestsTable, "G", "code");
    const [row] = await db.insert(hotelGuestsTable).values({
      companyId:   cid,
      code,
      fullNameAr,
      fullNameEn:  b.fullNameEn || null,
      phone:       b.phone || null,
      email:       b.email || null,
      nationality: b.nationality || null,
      idType:      b.idType || null,
      idNumber:    b.idNumber || null,
      preferences: b.preferences || null,
      customerId:  b.customerId ? Number(b.customerId) : null,
      notes:       b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    if (String(e?.message).includes("duplicate") || e?.code === "23505")
      return res.status(409).json({ error: "كود النزيل مستخدم مسبقاً" });
    res.status(500).json({ error: e.message });
  }
});

router.put("/guests/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const [row] = await db.update(hotelGuestsTable).set({
      code:        b.code != null ? String(b.code).trim() : undefined,
      fullNameAr:  b.fullNameAr != null ? String(b.fullNameAr).trim() : undefined,
      fullNameEn:  b.fullNameEn ?? null,
      phone:       b.phone ?? null,
      email:       b.email ?? null,
      nationality: b.nationality ?? null,
      idType:      b.idType ?? null,
      idNumber:    b.idNumber ?? null,
      preferences: b.preferences ?? null,
      customerId:  b.customerId ? Number(b.customerId) : null,
      notes:       b.notes ?? null,
      updatedAt:   new Date(),
    }).where(and(eq(hotelGuestsTable.id, id), eq(hotelGuestsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "النزيل غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/guests/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(hotelBookingsTable).where(and(eq(hotelBookingsTable.companyId, cid), eq(hotelBookingsTable.guestId, id)));
    if (n > 0) {
      res.status(409).json({ error: `لا يمكن حذف النزيل — مرتبط بـ ${n} حجز.` });
      return;
    }
    await db.delete(hotelGuestsTable).where(and(eq(hotelGuestsTable.id, id), eq(hotelGuestsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// BOOKINGS
// ════════════════════════════════════════════════════════════════════════
function nightsBetween(checkIn: string, checkOut: string): number {
  const a = new Date(checkIn).getTime();
  const b = new Date(checkOut).getTime();
  const days = Math.round((b - a) / 86400000);
  return Math.max(1, days);
}

router.get("/bookings", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select({
      b: hotelBookingsTable,
      hotelName: hotelsTable.nameAr,
      roomNumber: hotelRoomsTable.roomNumber,
      guestName:  hotelGuestsTable.fullNameAr,
      guestPhone: hotelGuestsTable.phone,
    })
      .from(hotelBookingsTable)
      .leftJoin(hotelsTable,      eq(hotelsTable.id,      hotelBookingsTable.hotelId))
      .leftJoin(hotelRoomsTable,  eq(hotelRoomsTable.id,  hotelBookingsTable.roomId))
      .leftJoin(hotelGuestsTable, eq(hotelGuestsTable.id, hotelBookingsTable.guestId))
      .where(eq(hotelBookingsTable.companyId, cid))
      .orderBy(desc(hotelBookingsTable.id));
    res.json(rows.map(r => ({
      ...r.b,
      hotelName:  r.hotelName,
      roomNumber: r.roomNumber,
      guestName:  r.guestName,
      guestPhone: r.guestPhone,
    })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/bookings/:id", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.select().from(hotelBookingsTable)
      .where(and(eq(hotelBookingsTable.id, id), eq(hotelBookingsTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "الحجز غير موجود" }); return; }
    const payments = await db.select().from(hotelPaymentsTable)
      .where(eq(hotelPaymentsTable.bookingId, id))
      .orderBy(desc(hotelPaymentsTable.id));
    res.json({ ...row, payments });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/bookings", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    if (!b.hotelId)  { res.status(400).json({ error: "الفندق مطلوب" }); return; }
    if (!b.guestId)  { res.status(400).json({ error: "النزيل مطلوب" }); return; }
    if (!b.roomId)   { res.status(400).json({ error: "الغرفة مطلوبة" }); return; }
    if (!b.checkIn || !b.checkOut) { res.status(400).json({ error: "تاريخ الدخول والخروج مطلوبان" }); return; }
    if (new Date(b.checkOut) <= new Date(b.checkIn)) { res.status(400).json({ error: "تاريخ الخروج يجب أن يكون بعد الدخول" }); return; }

    // Cross-tenant FK guards.
    if (!await assertOwn(res, hotelsTable,      Number(b.hotelId), cid, "الفندق")) return;
    if (!await assertOwn(res, hotelGuestsTable, Number(b.guestId), cid, "النزيل")) return;
    if (!await assertOwn(res, hotelRoomsTable,  Number(b.roomId),  cid, "الغرفة")) return;

    // Conflict check: any overlapping booking on the same room (excluding cancelled/no_show).
    const [conflict] = await db.select({ id: hotelBookingsTable.id })
      .from(hotelBookingsTable)
      .where(and(
        eq(hotelBookingsTable.companyId, cid),
        eq(hotelBookingsTable.roomId, Number(b.roomId)),
        sql`${hotelBookingsTable.status} NOT IN ('cancelled','no_show','checked_out')`,
        lte(hotelBookingsTable.checkIn, String(b.checkOut)),
        gte(hotelBookingsTable.checkOut, String(b.checkIn)),
      ));
    if (conflict) { res.status(409).json({ error: "الغرفة محجوزة في الفترة المحددة" }); return; }

    const docNumber = String(b.docNumber ?? "").trim() || await nextSequenceOrFallback(
      cid,
      "hotel_booking",
      { userId: (req as any).authUser?.id ?? null, refTable: "hotel_bookings" },
      () => nextCode(cid, hotelBookingsTable, "BK", "docNumber"),
    );
    const nights = nightsBetween(String(b.checkIn), String(b.checkOut));
    const nightly = Number(b.nightlyRate ?? 0);
    const total = b.totalPrice != null ? Number(b.totalPrice) : nightly * nights;

    const [row] = await db.insert(hotelBookingsTable).values({
      companyId:        cid,
      hotelId:          Number(b.hotelId),
      docNumber,
      guestId:          Number(b.guestId),
      roomId:           Number(b.roomId),
      checkIn:          String(b.checkIn),
      checkOut:         String(b.checkOut),
      status:           (BOOKING_STATUSES as readonly string[]).includes(b.status) ? b.status : "pending",
      nightlyRate:      String(nightly),
      nightsCount:      nights,
      totalPrice:       String(total),
      aiSuggestedPrice: b.aiSuggestedPrice != null ? String(b.aiSuggestedPrice) : null,
      aiFactors:        b.aiFactors || null,
      paidAmount:       b.paidAmount != null ? String(b.paidAmount) : "0",
      guestsCount:      Math.max(1, Number(b.guestsCount ?? 1)),
      specialRequests:  b.specialRequests || null,
      notes:            b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/bookings/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    if (b.hotelId && !await assertOwn(res, hotelsTable,      Number(b.hotelId), cid, "الفندق")) return;
    if (b.guestId && !await assertOwn(res, hotelGuestsTable, Number(b.guestId), cid, "النزيل")) return;
    if (b.roomId  && !await assertOwn(res, hotelRoomsTable,  Number(b.roomId),  cid, "الغرفة")) return;
    const updates: any = {
      hotelId:          b.hotelId ? Number(b.hotelId) : undefined,
      docNumber:        b.docNumber != null ? String(b.docNumber).trim() : undefined,
      guestId:          b.guestId ? Number(b.guestId) : undefined,
      roomId:           b.roomId  ? Number(b.roomId)  : undefined,
      status:           (BOOKING_STATUSES as readonly string[]).includes(b.status) ? b.status : undefined,
      nightlyRate:      b.nightlyRate != null ? String(b.nightlyRate) : undefined,
      paidAmount:       b.paidAmount != null ? String(b.paidAmount) : undefined,
      guestsCount:      b.guestsCount != null ? Math.max(1, Number(b.guestsCount)) : undefined,
      specialRequests:  b.specialRequests ?? null,
      notes:            b.notes ?? null,
      updatedAt:        new Date(),
    };
    if (b.checkIn && b.checkOut) {
      const nights = nightsBetween(String(b.checkIn), String(b.checkOut));
      updates.checkIn = String(b.checkIn);
      updates.checkOut = String(b.checkOut);
      updates.nightsCount = nights;
      const nightly = b.nightlyRate != null ? Number(b.nightlyRate) : 0;
      if (b.totalPrice == null && b.nightlyRate != null) updates.totalPrice = String(nightly * nights);
    }
    if (b.totalPrice != null) updates.totalPrice = String(b.totalPrice);
    const [row] = await db.update(hotelBookingsTable).set(updates)
      .where(and(eq(hotelBookingsTable.id, id), eq(hotelBookingsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الحجز غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/bookings/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(hotelBookingsTable).where(and(eq(hotelBookingsTable.id, id), eq(hotelBookingsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Check-in / check-out workflow actions.
router.post("/bookings/:id/checkin", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.update(hotelBookingsTable).set({
      status: "checked_in", checkInAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(hotelBookingsTable.id, id), eq(hotelBookingsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الحجز غير موجود" }); return; }
    // Mark room as occupied.
    await db.update(hotelRoomsTable).set({ status: "occupied", updatedAt: new Date() })
      .where(and(eq(hotelRoomsTable.id, row.roomId), eq(hotelRoomsTable.companyId, cid)));
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/bookings/:id/checkout", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.update(hotelBookingsTable).set({
      status: "checked_out", checkOutAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(hotelBookingsTable.id, id), eq(hotelBookingsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الحجز غير موجود" }); return; }
    // Mark room as needs cleaning.
    await db.update(hotelRoomsTable).set({ status: "cleaning", updatedAt: new Date() })
      .where(and(eq(hotelRoomsTable.id, row.roomId), eq(hotelRoomsTable.companyId, cid)));
    // Auto-create housekeeping task.
    const docNumber = await nextCode(cid, hotelHousekeepingTable, "HK", "docNumber");
    await db.insert(hotelHousekeepingTable).values({
      companyId: cid,
      hotelId:   row.hotelId,
      roomId:    row.roomId,
      docNumber,
      taskType:  "cleaning",
      status:    "pending",
      priority:  "high",
      notes:     `تنظيف بعد خروج الحجز ${row.docNumber}`,
    });
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// PAYMENTS
// ════════════════════════════════════════════════════════════════════════
router.get("/payments", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const bookingId = req.query.bookingId ? Number(req.query.bookingId) : undefined;
    const where = bookingId
      ? and(eq(hotelPaymentsTable.companyId, cid), eq(hotelPaymentsTable.bookingId, bookingId))
      : eq(hotelPaymentsTable.companyId, cid);
    const rows = await db.select({
      p: hotelPaymentsTable,
      bookingDoc: hotelBookingsTable.docNumber,
    })
      .from(hotelPaymentsTable)
      .leftJoin(hotelBookingsTable, eq(hotelBookingsTable.id, hotelPaymentsTable.bookingId))
      .where(where)
      .orderBy(desc(hotelPaymentsTable.id));
    res.json(rows.map(r => ({ ...r.p, bookingDoc: r.bookingDoc })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/payments", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    if (!b.bookingId) { res.status(400).json({ error: "الحجز مطلوب" }); return; }
    if (!b.amount)    { res.status(400).json({ error: "المبلغ مطلوب" }); return; }
    if (!await assertOwn(res, hotelBookingsTable, Number(b.bookingId), cid, "الحجز")) return;
    const docNumber = String(b.docNumber ?? "").trim() || await nextCode(cid, hotelPaymentsTable, "PY", "docNumber");
    const [row] = await db.insert(hotelPaymentsTable).values({
      companyId:  cid,
      bookingId:  Number(b.bookingId),
      docNumber,
      amount:     String(b.amount),
      method:     (PAYMENT_METHODS as readonly string[]).includes(b.method) ? b.method : "cash",
      status:     (PAYMENT_STATUSES as readonly string[]).includes(b.status) ? b.status : "completed",
      reference:  b.reference || null,
      notes:      b.notes || null,
    }).returning();
    // Recompute paidAmount on the booking.
    await refreshBookingPaid(cid, Number(b.bookingId));
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/payments/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [existing] = await db.select({ bookingId: hotelPaymentsTable.bookingId }).from(hotelPaymentsTable)
      .where(and(eq(hotelPaymentsTable.id, id), eq(hotelPaymentsTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "الدفعة غير موجودة" }); return; }
    await db.delete(hotelPaymentsTable).where(and(eq(hotelPaymentsTable.id, id), eq(hotelPaymentsTable.companyId, cid)));
    await refreshBookingPaid(cid, existing.bookingId);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

async function refreshBookingPaid(cid: number, bookingId: number) {
  const [{ s }] = await db.select({
    s: sql<string>`COALESCE(SUM(CASE WHEN ${hotelPaymentsTable.status} = 'completed' THEN ${hotelPaymentsTable.amount} ELSE 0 END), 0)`,
  })
    .from(hotelPaymentsTable)
    .where(eq(hotelPaymentsTable.bookingId, bookingId));
  await db.update(hotelBookingsTable).set({
    paidAmount: String(s ?? 0),
    updatedAt:  new Date(),
  }).where(and(eq(hotelBookingsTable.id, bookingId), eq(hotelBookingsTable.companyId, cid)));
}

// ════════════════════════════════════════════════════════════════════════
// HOUSEKEEPING
// ════════════════════════════════════════════════════════════════════════
router.get("/housekeeping", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select({
      h: hotelHousekeepingTable,
      hotelName:  hotelsTable.nameAr,
      roomNumber: hotelRoomsTable.roomNumber,
    })
      .from(hotelHousekeepingTable)
      .leftJoin(hotelsTable,     eq(hotelsTable.id,     hotelHousekeepingTable.hotelId))
      .leftJoin(hotelRoomsTable, eq(hotelRoomsTable.id, hotelHousekeepingTable.roomId))
      .where(eq(hotelHousekeepingTable.companyId, cid))
      .orderBy(desc(hotelHousekeepingTable.id));
    res.json(rows.map(r => ({ ...r.h, hotelName: r.hotelName, roomNumber: r.roomNumber })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/housekeeping", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    if (!b.hotelId) { res.status(400).json({ error: "الفندق مطلوب" }); return; }
    if (!await assertOwn(res, hotelsTable, Number(b.hotelId), cid, "الفندق")) return;
    if (b.roomId && !await assertOwn(res, hotelRoomsTable, Number(b.roomId), cid, "الغرفة")) return;
    const docNumber = String(b.docNumber ?? "").trim() || await nextCode(cid, hotelHousekeepingTable, "HK", "docNumber");
    const [row] = await db.insert(hotelHousekeepingTable).values({
      companyId:   cid,
      hotelId:     Number(b.hotelId),
      roomId:      b.roomId ? Number(b.roomId) : null,
      docNumber,
      taskType:    (HK_TASK_TYPES as readonly string[]).includes(b.taskType) ? b.taskType : "cleaning",
      status:      (HK_STATUSES as readonly string[]).includes(b.status) ? b.status : "pending",
      priority:    (HK_PRIORITIES as readonly string[]).includes(b.priority) ? b.priority : "medium",
      assignedTo:  b.assignedTo || null,
      scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : null,
      notes:       b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/housekeeping/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    if (b.hotelId && !await assertOwn(res, hotelsTable,     Number(b.hotelId), cid, "الفندق")) return;
    if (b.roomId  && !await assertOwn(res, hotelRoomsTable, Number(b.roomId),  cid, "الغرفة")) return;
    const status = (HK_STATUSES as readonly string[]).includes(b.status) ? b.status : undefined;
    const completedAt = status === "done" ? new Date() : null;
    const [row] = await db.update(hotelHousekeepingTable).set({
      hotelId:     b.hotelId ? Number(b.hotelId) : undefined,
      roomId:      b.roomId ? Number(b.roomId) : null,
      taskType:    (HK_TASK_TYPES as readonly string[]).includes(b.taskType) ? b.taskType : undefined,
      status,
      priority:    (HK_PRIORITIES as readonly string[]).includes(b.priority) ? b.priority : undefined,
      assignedTo:  b.assignedTo ?? null,
      scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : null,
      completedAt: status === "done" ? completedAt : (b.completedAt ? new Date(b.completedAt) : null),
      notes:       b.notes ?? null,
      updatedAt:   new Date(),
    }).where(and(eq(hotelHousekeepingTable.id, id), eq(hotelHousekeepingTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "المهمة غير موجودة" }); return; }
    // If marking room as cleaned, free up the room.
    if (status === "done" && row.roomId) {
      await db.update(hotelRoomsTable).set({ status: "available", updatedAt: new Date() })
        .where(and(
          eq(hotelRoomsTable.id, row.roomId),
          eq(hotelRoomsTable.companyId, cid),
          eq(hotelRoomsTable.status, "cleaning"),
        ));
    }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/housekeeping/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(hotelHousekeepingTable).where(and(eq(hotelHousekeepingTable.id, id), eq(hotelHousekeepingTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// HUB STATS
// ════════════════════════════════════════════════════════════════════════
router.get("/stats", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const [hotels]       = await db.select({ n: sql<number>`count(*)::int` }).from(hotelsTable).where(eq(hotelsTable.companyId, cid));
    const [rooms]        = await db.select({ n: sql<number>`count(*)::int` }).from(hotelRoomsTable).where(eq(hotelRoomsTable.companyId, cid));
    const [occupied]     = await db.select({ n: sql<number>`count(*)::int` }).from(hotelRoomsTable)
      .where(and(eq(hotelRoomsTable.companyId, cid), eq(hotelRoomsTable.status, "occupied")));
    const [guests]       = await db.select({ n: sql<number>`count(*)::int` }).from(hotelGuestsTable).where(eq(hotelGuestsTable.companyId, cid));
    const [bookings]     = await db.select({ n: sql<number>`count(*)::int` }).from(hotelBookingsTable).where(eq(hotelBookingsTable.companyId, cid));
    const [activeBookings] = await db.select({ n: sql<number>`count(*)::int` }).from(hotelBookingsTable)
      .where(and(eq(hotelBookingsTable.companyId, cid), sql`${hotelBookingsTable.status} IN ('confirmed','checked_in','pending')`));
    const [openHk] = await db.select({ n: sql<number>`count(*)::int` }).from(hotelHousekeepingTable)
      .where(and(eq(hotelHousekeepingTable.companyId, cid), sql`${hotelHousekeepingTable.status} IN ('pending','in_progress')`));
    const [revenue] = await db.select({ s: sql<string>`COALESCE(SUM(${hotelPaymentsTable.amount}),0)` }).from(hotelPaymentsTable)
      .where(and(eq(hotelPaymentsTable.companyId, cid), eq(hotelPaymentsTable.status, "completed")));
    const totalRooms = rooms?.n ?? 0;
    const occupiedN  = occupied?.n ?? 0;
    res.json({
      hotels:         hotels?.n ?? 0,
      rooms:          totalRooms,
      occupiedRooms:  occupiedN,
      occupancyRate:  totalRooms > 0 ? Math.round((occupiedN / totalRooms) * 1000) / 10 : 0,
      guests:         guests?.n ?? 0,
      bookings:       bookings?.n ?? 0,
      activeBookings: activeBookings?.n ?? 0,
      openHousekeeping: openHk?.n ?? 0,
      totalRevenue:   Number(revenue?.s ?? 0),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

// Suppress lint for imports that may become used as the module evolves.
void inArray; void ne;
