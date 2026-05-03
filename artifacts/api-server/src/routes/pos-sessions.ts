import { Router } from "express";
import { db } from "@workspace/db";
import {
  posSessionsTable,
  salesInvoicesTable,
  cashBoxesTable,
  branchesTable,
  usersTable,
  posTerminalsTable,
  posTerminalUsersTable,
  customersTable,
  bankAccountsTable,
  journalEntriesTable,
  journalEntryLinesTable,
} from "@workspace/db";
import { eq, and, sql, desc, isNull, gte, lte, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { loadMappings, pickAccount } from "../lib/accountingMappings.js";

const router = Router();
router.use(extractAuth);
// Hard auth gate: every endpoint here requires a real authenticated user.
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرّح" }); return; }
  next();
});

// ─── GET /pos-sessions/current ────────────────────────────────────────────────
// POS calls this on login to find an existing open session for this user.
router.get("/current", async (req, res) => {
  const u = req.authUser;
  if (!u || !u.companyId) { res.status(401).json({ error: "غير مصرّح" }); return; }
  const [row] = await db.select().from(posSessionsTable)
    .where(and(
      eq(posSessionsTable.companyId, u.companyId),
      eq(posSessionsTable.userId, u.id),
      eq(posSessionsTable.status, "open"),
    ))
    .orderBy(desc(posSessionsTable.openedAt))
    .limit(1);
  res.json(row ?? null);
});

// ─── POST /pos-sessions/open ──────────────────────────────────────────────────
// POS opens a new session.
router.post("/open", async (req, res) => {
  const u = req.authUser;
  if (!u || !u.companyId) { res.status(401).json({ error: "غير مصرّح" }); return; }
  const { branchId, cashBoxId, openingCash, device, posTerminalId, machineCode } = req.body ?? {};

  // If user already has an open session, return it instead of creating a duplicate.
  const [existing] = await db.select().from(posSessionsTable)
    .where(and(
      eq(posSessionsTable.companyId, u.companyId),
      eq(posSessionsTable.userId, u.id),
      eq(posSessionsTable.status, "open"),
    ))
    .orderBy(desc(posSessionsTable.openedAt))
    .limit(1);
  if (existing) { res.json(existing); return; }

  // ─── Terminal validation + auto-pairing ──────────────────────────────────
  // Wrapped in a transaction with SELECT … FOR UPDATE so two cashiers cannot
  // grab the same terminal concurrently and two devices cannot race to claim
  // the same unpaired terminal.
  // Tenant guard for the manual (no-terminal) path: branchId / cashBoxId, if
  // supplied, must belong to the caller's company. Without this check a user
  // in company A could open a session referencing branch/cashbox IDs from
  // company B, causing cross-tenant linkage corruption and metadata leakage
  // through later joins on session listing endpoints.
  if (!posTerminalId) {
    if (branchId) {
      const [b] = await db.select({ id: branchesTable.id })
        .from(branchesTable)
        .where(and(eq(branchesTable.id, Number(branchId)), eq(branchesTable.companyId, u.companyId)))
        .limit(1);
      if (!b) { res.status(400).json({ error: "الفرع غير موجود في هذه الشركة" }); return; }
    }
    if (cashBoxId) {
      const [c] = await db.select({ id: cashBoxesTable.id })
        .from(cashBoxesTable)
        .where(and(eq(cashBoxesTable.id, Number(cashBoxId)), eq(cashBoxesTable.companyId, u.companyId)))
        .limit(1);
      if (!c) { res.status(400).json({ error: "الصندوق النقدي غير موجود في هذه الشركة" }); return; }
    }
  }

  try {
    const row = await db.transaction(async (tx) => {
      let resolvedBranchId  = branchId  ?? null;
      let resolvedCashBoxId = cashBoxId ?? null;

      if (posTerminalId) {
        // Lock the terminal row.
        const lockRes = await tx.execute(sql`
          SELECT id, branch_id, cash_box_id, machine_code, is_active
          FROM pos_terminals
          WHERE id = ${Number(posTerminalId)} AND company_id = ${u.companyId}
          FOR UPDATE
        `);
        const t = (lockRes as any).rows?.[0];
        if (!t)            throw Object.assign(new Error("محطة البيع غير موجودة"), { status: 404 });
        if (!t.is_active)  throw Object.assign(new Error("محطة البيع غير مفعّلة"), { status: 400 });

        // Reject if another open session already holds this terminal (also
        // re-reads under the same transaction, after the lock is held).
        const [busy] = await tx.select({ id: posSessionsTable.id, userId: posSessionsTable.userId })
          .from(posSessionsTable)
          .where(and(
            eq(posSessionsTable.companyId, u.companyId),
            eq(posSessionsTable.posTerminalId, Number(posTerminalId)),
            eq(posSessionsTable.status, "open"),
          )).limit(1);
        if (busy) {
          throw Object.assign(new Error("محطة البيع قيد الاستخدام بواسطة مستخدم آخر"),
            { status: 409, busyUserId: busy.userId });
        }

        // Per-terminal user allow-list. When at least one row exists for this
        // terminal, only the listed users (plus admins of the company) may
        // open a session on it.
        if (u.role !== "admin" && u.role !== "superadmin") {
          const allow = await tx.select({ userId: posTerminalUsersTable.userId })
            .from(posTerminalUsersTable)
            .where(and(
              eq(posTerminalUsersTable.companyId, u.companyId),
              eq(posTerminalUsersTable.posTerminalId, Number(posTerminalId)),
            ));
          if (allow.length > 0 && !allow.some(a => a.userId === u.id)) {
            throw Object.assign(new Error("ليس لديك صلاحية استخدام هذه المحطة. اطلب من المسؤول إضافتك."),
              { status: 403 });
          }
        }

        // Pair / re-pair device under lock. Since the busy check above
        // already confirmed no other session is currently open on this
        // terminal, a different incoming device is allowed to take it over —
        // we simply re-write machine_code. This makes swapping the physical
        // device (browser reset, new tablet, replaced PC) self-service.
        const incoming = machineCode ? String(machineCode).trim() : null;
        if (incoming && t.machine_code !== incoming) {
          await tx.update(posTerminalsTable)
            .set({ machineCode: incoming, updatedAt: new Date() })
            .where(eq(posTerminalsTable.id, Number(posTerminalId)));
        }

        // Terminal drives the branch and (if set) the cash box.
        resolvedBranchId  = t.branch_id;
        if (t.cash_box_id) resolvedCashBoxId = t.cash_box_id;
      }

      const [inserted] = await tx.insert(posSessionsTable).values({
        companyId:     u.companyId,
        userId:        u.id,
        branchId:      resolvedBranchId,
        cashBoxId:     resolvedCashBoxId,
        posTerminalId: posTerminalId ? Number(posTerminalId) : null,
        openingCash:   String(openingCash ?? "0"),
        device:        device ?? null,
      }).returning();
      return inserted;
    });

    res.status(201).json(row);
  } catch (e: any) {
    const status = e?.status ?? 500;
    res.status(status).json({ error: e?.message ?? "تعذّر فتح الجلسة", busyUserId: e?.busyUserId });
  }
});

// ─── POST /pos-sessions/:id/close ─────────────────────────────────────────────
router.post("/:id/close", async (req, res) => {
  const u = req.authUser!;
  const id = Number(req.params.id);
  const { closingCash, notes } = req.body ?? {};

  const [s] = await db.select().from(posSessionsTable).where(eq(posSessionsTable.id, id));
  if (!s) { res.status(404).json({ error: "الجلسة غير موجودة" }); return; }

  // Tenant isolation: superadmins may close any session, otherwise the session
  // must belong to the caller's company AND the caller must be the owning user
  // OR an admin within that same company.
  if (u.role !== "superadmin") {
    if (!u.companyId || s.companyId !== u.companyId) {
      res.status(403).json({ error: "لا تملك صلاحية إغلاق هذه الجلسة" }); return;
    }
    const isAdmin = u.role === "admin";
    if (s.userId !== u.id && !isAdmin) {
      res.status(403).json({ error: "لا تملك صلاحية إغلاق هذه الجلسة" }); return;
    }
  }
  if (s.status !== "open") { res.json(s); return; }

  // Compute expected cash = openingCash + sum(cash sales in this session, scoped to its company).
  const [{ totalCash } = { totalCash: "0" }] = await db.select({
    totalCash: sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}), 0)`,
  }).from(salesInvoicesTable).where(and(
    eq(salesInvoicesTable.posSessionId, id),
    eq(salesInvoicesTable.companyId, s.companyId),
    eq(salesInvoicesTable.status, "posted"),
    eq(salesInvoicesTable.paymentType, "cash"),
  ));
  const expected = Number(s.openingCash || 0) + Number(totalCash || 0);
  const closing = closingCash != null && closingCash !== "" ? Number(closingCash) : expected;
  const diff = closing - expected;

  const [row] = await db.update(posSessionsTable).set({
    status:       u.id === s.userId ? "closed" : "force_closed",
    closingCash:  String(closing.toFixed(2)),
    expectedCash: String(expected.toFixed(2)),
    difference:   String(diff.toFixed(2)),
    closedAt:     new Date(),
    closedNotes:  notes ?? null,
  }).where(eq(posSessionsTable.id, id)).returning();

  // Note: each POS invoice posts its own complete JE (Dr cash/bank/AR + Dr
  // discount + Dr COGS / Cr sales + Cr VAT + Cr inventory) at /post time, so
  // there's no shift-close consolidated JE to create here — doing so would
  // double-book the sales side.
  res.json(row);
});

// ─── GET /pos-sessions ────────────────────────────────────────────────────────
// Admin monitoring list. Filters: status, from, to, branchId, userId.
router.get("/", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
  const filters: any[] = [];
  if (cid) filters.push(eq(posSessionsTable.companyId, cid));
  const status = String(req.query.status ?? "");
  if (status === "open" || status === "closed" || status === "force_closed") {
    filters.push(eq(posSessionsTable.status, status));
  }
  if (req.query.branchId) filters.push(eq(posSessionsTable.branchId, Number(req.query.branchId)));
  if (req.query.userId)   filters.push(eq(posSessionsTable.userId,   Number(req.query.userId)));
  if (req.query.from)     filters.push(gte(posSessionsTable.openedAt, new Date(String(req.query.from))));
  if (req.query.to)       filters.push(lte(posSessionsTable.openedAt, new Date(String(req.query.to) + "T23:59:59.999Z")));

  const rows = await db.select({
    s:      posSessionsTable,
    user:   { id: usersTable.id, username: usersTable.username, nameAr: usersTable.nameAr, nameEn: usersTable.nameEn },
    branch: { id: branchesTable.id, nameAr: branchesTable.nameAr },
    box:    { id: cashBoxesTable.id, nameAr: cashBoxesTable.nameAr },
  })
    .from(posSessionsTable)
    .leftJoin(usersTable,    eq(posSessionsTable.userId,    usersTable.id))
    .leftJoin(branchesTable, eq(posSessionsTable.branchId,  branchesTable.id))
    .leftJoin(cashBoxesTable,eq(posSessionsTable.cashBoxId, cashBoxesTable.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(posSessionsTable.openedAt))
    .limit(500);

  // Aggregate sales totals per session.
  const ids = rows.map(r => r.s.id);
  const aggMap = new Map<number, { invoices: number; totalSales: number }>();
  if (ids.length) {
    const aggs = await db.select({
      sid: salesInvoicesTable.posSessionId,
      cnt: sql<number>`COUNT(*)::int`,
      tot: sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}), 0)`,
    }).from(salesInvoicesTable)
      .where(and(
        eq(salesInvoicesTable.status, "posted"),
        sql`${salesInvoicesTable.posSessionId} IN (${sql.join(ids.map(i => sql`${i}`), sql`,`)})`,
      ))
      .groupBy(salesInvoicesTable.posSessionId);
    for (const a of aggs) {
      if (a.sid != null) aggMap.set(a.sid, { invoices: Number(a.cnt), totalSales: Number(a.tot) });
    }
  }

  res.json(rows.map(r => ({
    ...r.s,
    user:   r.user?.id   ? r.user   : null,
    branch: r.branch?.id ? r.branch : null,
    cashBox:r.box?.id    ? r.box    : null,
    invoiceCount: aggMap.get(r.s.id)?.invoices ?? 0,
    totalSales:   aggMap.get(r.s.id)?.totalSales ?? 0,
  })));
});

// ─── GET /pos-sessions/:id ────────────────────────────────────────────────────
// Session detail with its invoices.
router.get("/:id", async (req, res) => {
  const cid = resolveCompanyId(req);
  const id = Number(req.params.id);
  const [r] = await db.select({
    s:      posSessionsTable,
    user:   { id: usersTable.id, username: usersTable.username, nameAr: usersTable.nameAr, nameEn: usersTable.nameEn },
    branch: { id: branchesTable.id, nameAr: branchesTable.nameAr },
    box:    { id: cashBoxesTable.id, nameAr: cashBoxesTable.nameAr },
  })
    .from(posSessionsTable)
    .leftJoin(usersTable,    eq(posSessionsTable.userId,    usersTable.id))
    .leftJoin(branchesTable, eq(posSessionsTable.branchId,  branchesTable.id))
    .leftJoin(cashBoxesTable,eq(posSessionsTable.cashBoxId, cashBoxesTable.id))
    .where(and(
      eq(posSessionsTable.id, id),
      ...(cid ? [eq(posSessionsTable.companyId, cid)] : []),
    ));
  if (!r) { res.status(404).json({ error: "الجلسة غير موجودة" }); return; }

  const invoices = await db.select({
    id: salesInvoicesTable.id,
    docNumber: salesInvoicesTable.docNumber,
    invoiceDate: salesInvoicesTable.invoiceDate,
    totalAmount: salesInvoicesTable.totalAmount,
    vatAmount: salesInvoicesTable.vatAmount,
    status: salesInvoicesTable.status,
    paymentType: salesInvoicesTable.paymentType,
    createdAt: salesInvoicesTable.createdAt,
  }).from(salesInvoicesTable)
    .where(eq(salesInvoicesTable.posSessionId, id))
    .orderBy(desc(salesInvoicesTable.createdAt));

  const totalSales = invoices.filter(i => i.status === "posted")
    .reduce((s, i) => s + Number(i.totalAmount || 0), 0);

  res.json({
    ...r.s,
    user:    r.user?.id   ? r.user   : null,
    branch:  r.branch?.id ? r.branch : null,
    cashBox: r.box?.id    ? r.box    : null,
    invoices,
    invoiceCount: invoices.filter(i => i.status === "posted").length,
    totalSales,
  });
});

// ─── GET /pos-sessions/summary/today ──────────────────────────────────────────
// Top dashboard cards: openSessions, closedToday, totalSalesToday, invoiceCountToday.
router.get("/summary/today", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
  const today = new Date(); today.setHours(0,0,0,0);
  const cidFilter = cid ? [eq(posSessionsTable.companyId, cid)] : [];

  const [{ openCount } = { openCount: 0 }] = await db.select({
    openCount: sql<number>`COUNT(*)::int`,
  }).from(posSessionsTable).where(and(eq(posSessionsTable.status, "open"), ...cidFilter));

  const [{ closedToday } = { closedToday: 0 }] = await db.select({
    closedToday: sql<number>`COUNT(*)::int`,
  }).from(posSessionsTable).where(and(
    eq(posSessionsTable.status, "closed"),
    gte(posSessionsTable.closedAt, today),
    ...cidFilter,
  ));

  const cidInv = cid ? [eq(salesInvoicesTable.companyId, cid)] : [];
  const [{ invoiceCount, totalSales } = { invoiceCount: 0, totalSales: "0" }] = await db.select({
    invoiceCount: sql<number>`COUNT(*)::int`,
    totalSales:   sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}), 0)`,
  }).from(salesInvoicesTable).where(and(
    eq(salesInvoicesTable.status, "posted"),
    sql`${salesInvoicesTable.posSessionId} IS NOT NULL`,
    gte(salesInvoicesTable.createdAt, today),
    ...cidInv,
  ));

  res.json({
    openSessions: Number(openCount),
    closedToday:  Number(closedToday),
    invoiceCount: Number(invoiceCount),
    totalSales:   Number(totalSales),
  });
});

export default router;
