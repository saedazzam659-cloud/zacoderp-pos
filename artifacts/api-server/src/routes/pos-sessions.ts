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

  // ── Consolidated journal entry for the shift ─────────────────────────────
  // Pulls every posted invoice in this session and books one summary JE:
  //   Dr Cash (cashbox)              ── total of cash sales
  //   Dr Bank (per bank account)     ── total of bank/card sales
  //   Dr Customer A/R (per customer) ── total of credit sales
  //   Dr Sales Discount              ── sum of header discounts
  //   Cr Sales Revenue               ── sum of subtotals (gross of discount)
  //   Cr VAT Output                  ── sum of VAT
  // The COGS / inventory side is already booked per-invoice at /post time, so
  // the close JE only handles the sales side. Failures here do NOT roll the
  // session back — the cashier has already counted the drawer; we surface the
  // error in `journalError` so the operator can fix mappings and retry later.
  let journalEntryId: number | null = null;
  let journalError: string | null = null;
  try {
    const sessionInvoices = await db.select({
      id:             salesInvoicesTable.id,
      docNumber:      salesInvoicesTable.docNumber,
      customerId:     salesInvoicesTable.customerId,
      paymentType:    salesInvoicesTable.paymentType,
      cashBoxId:      salesInvoicesTable.cashBoxId,
      bankAccountId:  salesInvoicesTable.bankAccountId,
      branchId:       salesInvoicesTable.branchId,
      subtotal:       salesInvoicesTable.subtotal,
      discountAmount: salesInvoicesTable.discountAmount,
      vatAmount:      salesInvoicesTable.vatAmount,
      totalAmount:    salesInvoicesTable.totalAmount,
    }).from(salesInvoicesTable).where(and(
      eq(salesInvoicesTable.companyId, s.companyId),
      eq(salesInvoicesTable.posSessionId, id),
      eq(salesInvoicesTable.status, "posted"),
    ));

    if (sessionInvoices.length > 0) {
      const totalSubtotal = sessionInvoices.reduce((t, i) => t + Number(i.subtotal || 0), 0);
      const totalDiscount = sessionInvoices.reduce((t, i) => t + Number(i.discountAmount || 0), 0);
      const totalVat      = sessionInvoices.reduce((t, i) => t + Number(i.vatAmount || 0), 0);

      // Group by destination party-account so the JE has one debit line per
      // distinct cashbox / bank / customer instead of one per invoice — that's
      // the whole point of consolidation.
      const cashByBox    = new Map<number, number>();
      const bankByAcc    = new Map<number, number>();
      const arByCustomer = new Map<number, number>();

      for (const inv of sessionInvoices) {
        const total = Number(inv.totalAmount || 0);
        if (inv.paymentType === "cash" && inv.cashBoxId) {
          cashByBox.set(inv.cashBoxId, (cashByBox.get(inv.cashBoxId) ?? 0) + total);
        } else if (inv.paymentType === "bank" && inv.bankAccountId) {
          bankByAcc.set(inv.bankAccountId, (bankByAcc.get(inv.bankAccountId) ?? 0) + total);
        } else if (inv.customerId) {
          // credit (or any non-cash/non-bank) → customer receivable
          arByCustomer.set(inv.customerId, (arByCustomer.get(inv.customerId) ?? 0) + total);
        }
      }

      // Resolve the GL accounts behind each cashbox / bank / customer in one
      // query each — tenant-scoped to prevent cross-company FK leakage.
      const cashBoxIds = [...cashByBox.keys()];
      const bankAccIds = [...bankByAcc.keys()];
      const custIds    = [...arByCustomer.keys()];

      const [cbRows, baRows, custRows, mapSi] = await Promise.all([
        cashBoxIds.length
          ? db.select({ id: cashBoxesTable.id, accountId: cashBoxesTable.accountId, nameAr: cashBoxesTable.nameAr })
              .from(cashBoxesTable)
              .where(and(eq(cashBoxesTable.companyId, s.companyId), inArray(cashBoxesTable.id, cashBoxIds)))
          : Promise.resolve([] as Array<{ id: number; accountId: number | null; nameAr: string }>),
        bankAccIds.length
          ? db.select({ id: bankAccountsTable.id, accountId: bankAccountsTable.accountId, nameAr: bankAccountsTable.nameAr })
              .from(bankAccountsTable)
              .where(and(eq(bankAccountsTable.companyId, s.companyId), inArray(bankAccountsTable.id, bankAccIds)))
          : Promise.resolve([] as Array<{ id: number; accountId: number | null; nameAr: string }>),
        custIds.length
          ? db.select({ id: customersTable.id, accountId: customersTable.accountId, nameAr: customersTable.nameAr })
              .from(customersTable)
              .where(and(eq(customersTable.companyId, s.companyId), inArray(customersTable.id, custIds)))
          : Promise.resolve([] as Array<{ id: number; accountId: number | null; nameAr: string }>),
        loadMappings(s.companyId, "sales_invoice"),
      ]);

      const cbMap = new Map(cbRows.map(r => [r.id, r]));
      const baMap = new Map(baRows.map(r => [r.id, r]));
      const cuMap = new Map(custRows.map(r => [r.id, r]));

      const salesAccId    = pickAccount(null, mapSi("sales_invoice", "revenue"));
      const taxAccId      = pickAccount(null, mapSi("sales_invoice", "vat_output"));
      const discountAccId = pickAccount(null, mapSi("sales_invoice", "discount"));

      type JLine = { accountId: number; debit?: number; credit?: number; description?: string };
      const lines: JLine[] = [];

      // ── Debits: cash boxes ───────────────────────────────────────────────
      for (const [cbId, amt] of cashByBox) {
        const cb = cbMap.get(cbId);
        if (!cb?.accountId) throw new Error(`الخزنة "${cb?.nameAr ?? cbId}" لا تحتوي على حساب محاسبي مرتبط`);
        if (amt > 0) lines.push({ accountId: cb.accountId, debit: amt, description: `تحصيل نقدي — ${cb.nameAr}` });
      }
      for (const [baId, amt] of bankByAcc) {
        const ba = baMap.get(baId);
        if (!ba?.accountId) throw new Error(`الحساب البنكي "${ba?.nameAr ?? baId}" لا يحتوي على حساب محاسبي مرتبط`);
        if (amt > 0) lines.push({ accountId: ba.accountId, debit: amt, description: `تحصيل بنكي — ${ba.nameAr}` });
      }
      for (const [cuId, amt] of arByCustomer) {
        const cu = cuMap.get(cuId);
        if (!cu?.accountId) throw new Error(`العميل "${cu?.nameAr ?? cuId}" لا يحتوي على حساب ذمم مرتبط`);
        if (amt > 0) lines.push({ accountId: cu.accountId, debit: amt, description: `ذمم العميل — ${cu.nameAr}` });
      }

      // Discount debit (one consolidated line)
      if (totalDiscount > 0) {
        if (!discountAccId) throw new Error("لم يتم تحديد حساب الخصم المسموح به (اضبطه من ربط القيود المحاسبية)");
        lines.push({ accountId: discountAccId, debit: totalDiscount, description: "خصم مسموح به (نقاط بيع)" });
      }

      // ── Credits ──────────────────────────────────────────────────────────
      // In this schema `subtotal` is already net of header discount and VAT,
      // and `totalAmount = subtotal + vat - headerDiscount`. So crediting sales
      // at `totalSubtotal` together with the `totalDiscount` debit balances:
      //   Dr cash (=Σ totalAmount = Σ(subtotal+vat-disc)) + Dr discount (=Σdisc)
      //     = Σ(subtotal + vat)
      //   Cr sales (=Σsubtotal) + Cr vat (=Σvat) = Σ(subtotal + vat)  ✓
      // Crediting at gross (subtotal+discount) — as an earlier draft did — would
      // overstate revenue by the discount amount and fail the balance check.
      if (totalSubtotal > 0) {
        if (!salesAccId) throw new Error("لم يتم تحديد حساب إيراد المبيعات (اضبطه من ربط القيود المحاسبية)");
        lines.push({ accountId: salesAccId, credit: totalSubtotal, description: "إيراد مبيعات نقاط البيع" });
      }
      if (totalVat > 0) {
        if (!taxAccId) throw new Error("لم يتم تحديد حساب ضريبة القيمة المضافة مخرجات (اضبطه من ربط القيود المحاسبية)");
        lines.push({ accountId: taxAccId, credit: totalVat, description: "ضريبة القيمة المضافة (مخرجات) — نقاط بيع" });
      }

      // Sanity: balance check before insert (defensive — schema also enforces).
      const dr = lines.reduce((t, l) => t + (l.debit  ?? 0), 0);
      const cr = lines.reduce((t, l) => t + (l.credit ?? 0), 0);
      if (Math.abs(dr - cr) > 0.01) {
        throw new Error(`القيد غير متوازن: مدين ${dr.toFixed(2)} ≠ دائن ${cr.toFixed(2)}`);
      }

      if (lines.length >= 2) {
        const docNumber = `POS-${id}`;
        const closeDate = new Date().toISOString().slice(0, 10);
        const [entry] = await db.insert(journalEntriesTable).values({
          companyId:    s.companyId,
          branchId:     s.branchId ?? null,
          docNumber,
          entryDate:    closeDate,
          currency:     "SAR",
          exchangeRate: "1",
          description:  `قيد إقفال وردية نقاط البيع رقم ${id} (${sessionInvoices.length} فاتورة)`,
          entryType:    "pos_session_close",
          status:       "posted",
        }).returning();
        await db.insert(journalEntryLinesTable).values(
          lines.map((l, i) => ({
            entryId:     entry.id,
            accountId:   l.accountId,
            debit:       String((l.debit  ?? 0).toFixed(2)),
            credit:      String((l.credit ?? 0).toFixed(2)),
            description: l.description ?? `إقفال وردية ${id}`,
            sortOrder:   i,
          }))
        );
        journalEntryId = entry.id;
      }
    }
  } catch (e: any) {
    journalError = e?.message ?? String(e);
    req.log?.warn?.({ sessionId: id, err: journalError }, "pos-session close: consolidated JE failed");
  }

  res.json({ ...row, journalEntryId, journalError });
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
