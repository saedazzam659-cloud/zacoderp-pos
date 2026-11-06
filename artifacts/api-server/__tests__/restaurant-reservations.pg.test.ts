import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  branchesTable,
  companiesTable,
  db,
  pool,
  posOrdersTable,
  posRestaurantReservationsTable,
  posTablesTable,
  usersTable,
} from "@workspace/db";
import app from "../src/app.ts";

const TEST_TAG = `tt_restaurant_reservations_${randomBytes(8).toString("hex")}`;
let server: http.Server | undefined;
let baseUrl = "";
let companyId = 0;
let branchId = 0;
let tableId = 0;
let token = "";

async function api(path: string, method: string, body?: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${path}?companyId=${companyId}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const responseBody = await response.json() as Record<string, any>;
  return { status: response.status, body: responseBody };
}

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [company] = await db.insert(companiesTable).values({
    nameAr: `${TEST_TAG} شركة اختبار`,
    nameEn: `${TEST_TAG} restaurant reservations test`,
    vatNumber: "300000000000003",
    crNumber: "1010000001",
    city: "Riyadh",
    street: "Test Street",
    buildingNumber: "1",
    postalCode: "12345",
    country: "SA",
    invoiceType: "both",
    status: "active",
    isInternalDemoWorkspace: false,
    menuPermissions: JSON.stringify({ pos_waiter: true }),
  }).returning({ id: companiesTable.id });
  companyId = company.id;

  const [branch] = await db.insert(branchesTable).values({
    companyId,
    code: `${TEST_TAG}-BR`,
    nameAr: "فرع اختبار",
    nameEn: "Test branch",
  }).returning({ id: branchesTable.id });
  branchId = branch.id;

  token = `${TEST_TAG}_${randomBytes(16).toString("hex")}`;
  await db.insert(usersTable).values({
    username: `${TEST_TAG}_admin`,
    passwordHash: "unused-test-token",
    role: "admin",
    isActive: true,
    sessionToken: token,
    sessionId: "test",
    companyId,
  });

  const [table] = await db.insert(posTablesTable).values({
    companyId, branchId, code: `${TEST_TAG}-T1`, nameAr: "طاولة اختبار",
    capacity: 4, status: "free",
  }).returning({ id: posTablesTable.id });
  tableId = table.id;
});

after(async () => {
  try {
    if (companyId) {
      await db.delete(posRestaurantReservationsTable)
        .where(eq(posRestaurantReservationsTable.companyId, companyId));
      await db.delete(posOrdersTable).where(eq(posOrdersTable.companyId, companyId));
      await db.delete(posTablesTable).where(eq(posTablesTable.companyId, companyId));
      await db.delete(usersTable).where(eq(usersTable.companyId, companyId));
      await db.delete(branchesTable).where(eq(branchesTable.companyId, companyId));
      await db.delete(companiesTable).where(and(
        eq(companiesTable.id, companyId),
        eq(companiesTable.nameEn, `${TEST_TAG} restaurant reservations test`),
        eq(companiesTable.isInternalDemoWorkspace, false),
      ));
    }
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    try { await pool.end(); } catch { /* test process may already be closing */ }
  }
});

test("reservations and waitlist stay planning-only and enforce table overlap", async () => {
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const reservation = await api("/api/pos-restaurant/reservations", "POST", {
    branchId,
    tableId,
    kind: "reservation",
    customerName: "اختبار الحجز",
    guestCount: 2,
    scheduledAt: startsAt.toISOString(),
    durationMinutes: 90,
  });
  assert.equal(reservation.status, 201, JSON.stringify(reservation.body));
  assert.equal(reservation.body.status, "confirmed");

  const overlapping = await api("/api/pos-restaurant/reservations", "POST", {
    branchId,
    tableId,
    kind: "reservation",
    customerName: "حجز متعارض",
    guestCount: 2,
    scheduledAt: new Date(startsAt.getTime() + 30 * 60 * 1000).toISOString(),
    durationMinutes: 60,
  });
  assert.equal(overlapping.status, 409, JSON.stringify(overlapping.body));

  const waitlist = await api("/api/pos-restaurant/reservations", "POST", {
    branchId,
    kind: "waitlist",
    customerName: "اختبار قائمة الانتظار",
    guestCount: 3,
  });
  assert.equal(waitlist.status, 201, JSON.stringify(waitlist.body));
  assert.equal(waitlist.body.status, "waiting");
  assert.equal(waitlist.body.tableId, null);

  const seatedReservation = await api(
    `/api/pos-restaurant/reservations/${reservation.body.id}/status`,
    "PATCH",
    { status: "seated" },
  );
  assert.equal(seatedReservation.status, 200, JSON.stringify(seatedReservation.body));
  assert.equal(seatedReservation.body.status, "seated");
  const seatedWaitlist = await api(
    `/api/pos-restaurant/reservations/${waitlist.body.id}/status`,
    "PATCH",
    { status: "seated" },
  );
  assert.equal(seatedWaitlist.status, 200, JSON.stringify(seatedWaitlist.body));
  assert.equal(seatedWaitlist.body.status, "seated");

  const [table] = await db.select().from(posTablesTable).where(eq(posTablesTable.id, tableId));
  const orders = await db.select({ id: posOrdersTable.id }).from(posOrdersTable)
    .where(eq(posOrdersTable.companyId, companyId));
  assert.equal(table.status, "free");
  assert.equal(table.currentOrderId, null);
  assert.deepEqual(orders, [], "reservation status changes must not create restaurant orders");
});
