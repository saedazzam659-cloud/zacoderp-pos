/* eslint-disable @typescript-eslint/no-explicit-any */
//
// Offers module — full advanced version.
//
// What this router does:
//   • CRUD for the `offers` master table (multi-tenant via companyId).
//   • Manages the three "scope" junction tables (customers / items / sales-reps)
//     in a single atomic transaction so an offer is never half-saved.
//   • Provides a `match` engine the invoice screen calls to get the best
//     applicable offer per item line.
//
// Business rules enforced here (mirroring the spec in the user request):
//   1. Once an offer is `active`, the master record cannot be edited or
//      deleted — admins must `expire` it first.  This protects historical
//      pricing from silent rewrites.
//   2. `priority` 1-10; ties on priority break on the highest discount or
//      the lowest fixed price (handled in the match engine).
//   3. Match engine ignores expired offers (`expiry_date < today`) and any
//      offer whose status isn't `active`.
//   4. Each scope axis is independent: ALL of one + SPECIFIC of another is
//      a perfectly valid combination.
//
import { Router } from "express";
import { db } from "@workspace/db";
import {
  offersTable, offerCustomersTable, offerItemsTable, offerSalesRepsTable,
  customersTable, itemsTable, salesRepsTable,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { nextSequenceOrFallback } from "../lib/sequences.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
// Offers piggy-back on the `items` permission key — same family as everything
// else under the inventory module, so existing role grants Just Work.
router.use(requireModulePermission("items"));
router.use(moduleAudit("items"));
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

// ─── helpers ───────────────────────────────────────────────────────────────
function requireCid(req: any, res: any): number | null {
  const raw = req.query.companyId ? Number(req.query.companyId) : undefined;
  const cid = resolveCompanyId(req, raw);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function bodyCid(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query.companyId);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// Per-tenant offer-number generator: OF0001, OF0002…
async function nextOfferNumber(cid: number): Promise<string> {
  const rows = await db.select({ n: offersTable.offerNumber })
    .from(offersTable).where(eq(offersTable.companyId, cid));
  let max = 0;
  for (const r of rows) {
    const m = /^OF(\d+)$/.exec(String(r.n).trim());
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > max) max = n; }
  }
  return `OF${String(max + 1).padStart(4, "0")}`;
}

// Coerce text/number/null to a clean numeric string Drizzle will accept,
// or `null` when the caller didn't supply a value.
function num(v: any): string | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : null;
}
// Same as `num` but for integers (max-uses, buy/get qty, …).
function intOrNull(v: any): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
// Coerce truthy / "true" / 1 → boolean; falsy / undefined → false.
function bool(v: any): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1";
  return !!v;
}
// Trim + uppercase the coupon so "abc" and "ABC" can never both exist for
// the same tenant — keeps the partial unique index honest.
function couponNorm(v: any): string | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return s ? s : null;
}
// White-list the discountType / applyTo values so a malicious client can't
// inject a random enum string and bypass logic that switches on it.
const DISCOUNT_TYPES = new Set(["line_pricing", "percentage_total", "fixed_total", "buy_x_get_y"]);
const APPLY_TO_VALS  = new Set(["all", "pos", "invoice"]);

// Translate a Drizzle/postgres-js error into a friendly Arabic 409 message
// when it's a unique-constraint violation we know about, or null otherwise.
//
// Drizzle wraps the original PostgresError so the meaningful fields
// (`code`, `constraint_name`) live on `e.cause` — we look at both layers
// because some integration paths surface them on `e` directly.  Falling back
// to a substring scan over the message keeps us robust if either lib changes
// the wrapping shape in a future minor release.
function classifyDuplicate(e: any): string | null {
  const code  = e?.code ?? e?.cause?.code;
  const cname = e?.constraint_name ?? e?.cause?.constraint_name ?? e?.constraint ?? e?.cause?.constraint;
  const blob  = `${e?.message ?? ""}\n${e?.cause?.message ?? ""}\n${e?.detail ?? ""}\n${e?.cause?.detail ?? ""}`;
  const isDup = code === "23505" || /duplicate key/i.test(blob);
  if (!isDup) return null;
  if (cname === "offers_company_coupon_idx" || /offers_company_coupon_idx/.test(blob)) {
    return "رمز الكوبون مستخدم في عرض آخر";
  }
  if (cname === "offers_company_number_idx" || /offers_company_number_idx/.test(blob)) {
    return "رقم العرض مستخدم مسبقاً";
  }
  // Generic dup we don't recognize — still return a helpful message.
  return "قيمة مكررة — تأكد من رقم العرض ورمز الكوبون";
}

// ═══════════════════════════════════════════════════════════════════════════
// LIST + READ
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/offers — list with optional ?status=active filter.
router.get("/", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const status = String(req.query.status ?? "").trim();
    const where = status === "active" || status === "draft" || status === "expired"
      ? and(eq(offersTable.companyId, cid), eq(offersTable.status, status as any))
      : eq(offersTable.companyId, cid);
    const rows = await db.select().from(offersTable).where(where).orderBy(desc(offersTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Convenience endpoint used by the invoice screen — only returns offers that
// are currently usable so the cache stays small on the client.
router.get("/active", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const today = new Date().toISOString().slice(0, 10);
    // Both ends of the validity window are gated — a future-dated offer is
    // hidden until its startDate, and a past-dated one disappears after its
    // expiryDate.  Either side may be NULL → "open".
    const rows = await db.select().from(offersTable).where(and(
      eq(offersTable.companyId, cid),
      eq(offersTable.status, "active"),
      sql`(${offersTable.startDate}  IS NULL OR ${offersTable.startDate}  <= ${today})`,
      sql`(${offersTable.expiryDate} IS NULL OR ${offersTable.expiryDate} >= ${today})`,
    )).orderBy(desc(offersTable.priority), desc(offersTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/offers/:id — full record + the three junction lists.
router.get("/:id", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.select().from(offersTable)
      .where(and(eq(offersTable.id, id), eq(offersTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "العرض غير موجود" }); return; }

    // Pull all three junctions in parallel — none depend on each other.
    const [customers, items, salesReps] = await Promise.all([
      db.select().from(offerCustomersTable).where(eq(offerCustomersTable.offerId, id)),
      db.select().from(offerItemsTable).where(eq(offerItemsTable.offerId, id)),
      db.select().from(offerSalesRepsTable).where(eq(offerSalesRepsTable.offerId, id)),
    ]);
    res.json({ ...row, customers, items, salesReps });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// CREATE / UPDATE
// ═══════════════════════════════════════════════════════════════════════════

// Validate scope payloads so we reject obviously-malformed bodies early — the
// frontend should never submit "specific" with an empty list.
function validatePayload(b: any): string | null {
  const scopes = ["all", "specific"];
  if (!scopes.includes(b.customerScope)) return "نطاق العملاء غير صالح";
  if (!scopes.includes(b.itemsScope))    return "نطاق الأصناف غير صالح";
  if (!scopes.includes(b.salesRepScope)) return "نطاق المناديب غير صالح";
  if (b.customerScope === "specific" && (!Array.isArray(b.customers) || b.customers.length === 0))
    return "اختر عميلًا واحدًا على الأقل";
  if (b.itemsScope === "specific" && (!Array.isArray(b.items) || b.items.length === 0))
    return "اختر صنفًا واحدًا على الأقل";
  if (b.salesRepScope === "specific" && (!Array.isArray(b.salesReps) || b.salesReps.length === 0))
    return "اختر مندوبًا واحدًا على الأقل";
  const p = Number(b.priority);
  if (!Number.isFinite(p) || p < 1 || p > 10) return "الأولوية يجب أن تكون رقمًا من 1 إلى 10";

  // ── New ERP-grade fields ────────────────────────────────────────────────
  // Validity range — allow either side to be open, but if both are set the
  // start must come on or before the end.  Strings compare lexicographically
  // because both are ISO yyyy-mm-dd dates.
  const start = (typeof b.startDate === "string"  && b.startDate.trim())  || null;
  const end   = (typeof b.expiryDate === "string" && b.expiryDate.trim()) || null;
  if (start && end && start > end) return "تاريخ البداية يجب أن يكون قبل تاريخ الانتهاء";

  // Discount type — default to legacy "line_pricing" so a caller that omits it
  // keeps today's behaviour.  Reject anything outside the white-list.
  const dt = b.discountType ?? "line_pricing";
  if (!DISCOUNT_TYPES.has(dt)) return "نوع الخصم غير صالح";

  // Per-type required fields.
  if (dt === "percentage_total") {
    const v = Number(b.discountValue);
    if (!Number.isFinite(v) || v <= 0 || v > 100) return "نسبة الخصم يجب أن تكون من 0 إلى 100";
  }
  if (dt === "fixed_total") {
    const v = Number(b.discountValue);
    if (!Number.isFinite(v) || v <= 0) return "قيمة الخصم يجب أن تكون أكبر من صفر";
  }
  if (dt === "buy_x_get_y") {
    const bq = Number(b.buyQty);
    const gq = Number(b.getQty);
    const gp = Number(b.getDiscountPercent);
    if (!Number.isFinite(bq) || bq < 1) return "كمية الشراء (Buy X) يجب أن تكون 1 على الأقل";
    if (!Number.isFinite(gq) || gq < 1) return "كمية المجانية (Get Y) يجب أن تكون 1 على الأقل";
    if (!Number.isFinite(gp) || gp <= 0 || gp > 100) return "نسبة الخصم على الكمية المجانية يجب أن تكون من 0 إلى 100";
  }

  // Eligibility constraints — non-negative, integer where applicable.
  if (b.minPurchaseAmount !== undefined && b.minPurchaseAmount !== null && b.minPurchaseAmount !== "") {
    const m = Number(b.minPurchaseAmount);
    if (!Number.isFinite(m) || m < 0) return "الحد الأدنى للشراء غير صالح";
  }
  for (const k of ["maxUses", "maxUsesPerCustomer"] as const) {
    const v = b[k];
    if (v !== undefined && v !== null && v !== "") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) return "حد الاستخدام يجب أن يكون رقمًا صحيحًا موجبًا";
    }
  }

  // Channel — default to "all" if missing.
  if (b.applyTo !== undefined && !APPLY_TO_VALS.has(b.applyTo)) return "قناة التطبيق غير صالحة";

  // Coupon code length sanity (defence-in-depth — also enforced by DB type).
  if (typeof b.couponCode === "string" && b.couponCode.trim().length > 50) {
    return "رمز الكوبون طويل جدًا (الحد الأقصى 50 حرفًا)";
  }
  return null;
}

// Pull the new ERP-grade columns out of a request body into the shape Drizzle
// expects.  Centralised so the POST and PUT handlers stay symmetrical and
// nobody forgets to persist a new field.
function buildExtras(b: any) {
  return {
    startDate:          b.startDate || null,
    discountType:       (DISCOUNT_TYPES.has(b.discountType) ? b.discountType : "line_pricing") as
                          "line_pricing" | "percentage_total" | "fixed_total" | "buy_x_get_y",
    discountValue:      num(b.discountValue),
    buyQty:             intOrNull(b.buyQty),
    getQty:             intOrNull(b.getQty),
    getDiscountPercent: num(b.getDiscountPercent),
    minPurchaseAmount:  num(b.minPurchaseAmount) ?? "0",
    couponCode:         couponNorm(b.couponCode),
    maxUses:            intOrNull(b.maxUses),
    maxUsesPerCustomer: intOrNull(b.maxUsesPerCustomer),
    stackable:          bool(b.stackable),
    applyTo:            (APPLY_TO_VALS.has(b.applyTo) ? b.applyTo : "all") as "all" | "pos" | "invoice",
    notes:              (typeof b.notes === "string" && b.notes.trim()) ? b.notes.trim() : null,
  };
}

// Confirm every referenced child row belongs to the same tenant — prevents a
// caller from attaching another company's customer/item/sales-rep to an offer.
async function checkOwnership(cid: number, b: any): Promise<string | null> {
  if (b.customerScope === "specific") {
    const ids: number[] = (b.customers ?? []).map((x: any) => Number(x)).filter(Number.isFinite);
    if (ids.length) {
      const rows = await db.select({ id: customersTable.id }).from(customersTable)
        .where(and(eq(customersTable.companyId, cid), inArray(customersTable.id, ids)));
      if (rows.length !== new Set(ids).size) return "بعض العملاء غير موجودين أو لا ينتمون للشركة";
    }
  }
  if (b.itemsScope === "specific") {
    const ids: number[] = (b.items ?? []).map((x: any) => Number(x.itemId)).filter(Number.isFinite);
    if (ids.length) {
      const rows = await db.select({ id: itemsTable.id }).from(itemsTable)
        .where(and(eq(itemsTable.companyId, cid), inArray(itemsTable.id, ids)));
      if (rows.length !== new Set(ids).size) return "بعض الأصناف غير موجودة أو لا تنتمي للشركة";
    }
  }
  if (b.salesRepScope === "specific") {
    const ids: number[] = (b.salesReps ?? []).map((x: any) => Number(x)).filter(Number.isFinite);
    if (ids.length) {
      const rows = await db.select({ id: salesRepsTable.id }).from(salesRepsTable)
        .where(and(eq(salesRepsTable.companyId, cid), inArray(salesRepsTable.id, ids)));
      if (rows.length !== new Set(ids).size) return "بعض المناديب غير موجودين أو لا ينتمون للشركة";
    }
  }
  return null;
}

router.post("/", async (req, res) => {
  try {
    const cid = bodyCid(req, res); if (!cid) return;
    const b = req.body ?? {};

    const err = validatePayload(b); if (err) { res.status(400).json({ error: err }); return; }
    const ownErr = await checkOwnership(cid, b);
    if (ownErr) { res.status(400).json({ error: ownErr }); return; }

    const status = b.status === "active" ? "active" : "draft";
    const offerNumber = String(b.offerNumber ?? "").trim() || await nextSequenceOrFallback(
      cid,
      "offer",
      { userId: (req as any).authUser?.id ?? null, refTable: "offers" },
      () => nextOfferNumber(cid),
    );
    const extras = buildExtras(b);

    // Wrap everything in one transaction so a failure on the junctions rolls
    // back the master row too.
    const created = await db.transaction(async (tx) => {
      const [offer] = await tx.insert(offersTable).values({
        companyId:     cid,
        offerNumber,
        nameAr:        b.nameAr || null,
        description:   b.description || null,
        customerScope: b.customerScope,
        itemsScope:    b.itemsScope,
        salesRepScope: b.salesRepScope,
        status,
        priority:      Number(b.priority),
        expiryDate:    b.expiryDate || null,
        ...extras,
      }).returning();

      if (b.customerScope === "specific" && Array.isArray(b.customers) && b.customers.length) {
        await tx.insert(offerCustomersTable).values(
          (b.customers as any[]).map((id) => ({ offerId: offer.id, customerId: Number(id) })),
        );
      }
      if (b.itemsScope === "specific" && Array.isArray(b.items) && b.items.length) {
        await tx.insert(offerItemsTable).values(
          (b.items as any[]).map((it) => ({
            offerId:  offer.id,
            itemId:   Number(it.itemId),
            price:    num(it.price),
            discount: num(it.discount),
            qty:      num(it.qty),
          })),
        );
      }
      if (b.salesRepScope === "specific" && Array.isArray(b.salesReps) && b.salesReps.length) {
        await tx.insert(offerSalesRepsTable).values(
          (b.salesReps as any[]).map((id) => ({ offerId: offer.id, salesRepId: Number(id) })),
        );
      }
      return offer;
    });

    res.status(201).json(created);
  } catch (e: any) {
    const r = classifyDuplicate(e);
    if (r) { res.status(409).json({ error: r }); return; }
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/offers/:id — replace the offer + the three junction lists.
// Locked once `active` per spec rule #11 ("منع تعديل العرض بعد تفعيله"). Use
// /expire then re-create if you need to change a live offer.
//
// Concurrency note: we enforce the active-lock atomically inside the UPDATE
// itself by including `status <> 'active'` in the WHERE clause. This way a
// concurrent /:id/activate call cannot slip in between a TOCTOU check and
// the write — if the offer became active while the request was in flight,
// the UPDATE returns zero rows and we surface a 409.
router.put("/:id", async (req, res) => {
  try {
    const cid = bodyCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};

    // Cheap up-front existence check just so we can give a clean 404 message.
    // The real lock is enforced atomically below by the conditional UPDATE.
    const [existing] = await db.select({ id: offersTable.id }).from(offersTable)
      .where(and(eq(offersTable.id, id), eq(offersTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "العرض غير موجود" }); return; }

    const err = validatePayload(b); if (err) { res.status(400).json({ error: err }); return; }
    const ownErr = await checkOwnership(cid, b);
    if (ownErr) { res.status(400).json({ error: ownErr }); return; }

    const status = b.status === "active" ? "active" : (b.status === "expired" ? "expired" : "draft");
    const extras = buildExtras(b);

    const ok = await db.transaction(async (tx) => {
      // Conditional update: ONLY when status isn't 'active'. If a concurrent
      // /activate raced ahead, this matches zero rows and we abort the txn.
      const updated = await tx.update(offersTable).set({
        nameAr:        b.nameAr || null,
        description:   b.description || null,
        customerScope: b.customerScope,
        itemsScope:    b.itemsScope,
        salesRepScope: b.salesRepScope,
        status,
        priority:      Number(b.priority),
        expiryDate:    b.expiryDate || null,
        ...extras,
        updatedAt:     new Date(),
      }).where(and(
        eq(offersTable.id, id),
        eq(offersTable.companyId, cid),
        sql`${offersTable.status} <> 'active'`,
      )).returning({ id: offersTable.id });
      if (updated.length === 0) return false;

      // Wipe-and-replace is fine here because the junctions carry no audit
      // history — the master record is the source of truth.
      await tx.delete(offerCustomersTable).where(eq(offerCustomersTable.offerId, id));
      await tx.delete(offerItemsTable).where(eq(offerItemsTable.offerId, id));
      await tx.delete(offerSalesRepsTable).where(eq(offerSalesRepsTable.offerId, id));

      if (b.customerScope === "specific" && Array.isArray(b.customers) && b.customers.length) {
        await tx.insert(offerCustomersTable).values(
          (b.customers as any[]).map((cid) => ({ offerId: id, customerId: Number(cid) })),
        );
      }
      if (b.itemsScope === "specific" && Array.isArray(b.items) && b.items.length) {
        await tx.insert(offerItemsTable).values(
          (b.items as any[]).map((it) => ({
            offerId:  id,
            itemId:   Number(it.itemId),
            price:    num(it.price),
            discount: num(it.discount),
            qty:      num(it.qty),
          })),
        );
      }
      if (b.salesRepScope === "specific" && Array.isArray(b.salesReps) && b.salesReps.length) {
        await tx.insert(offerSalesRepsTable).values(
          (b.salesReps as any[]).map((rid) => ({ offerId: id, salesRepId: Number(rid) })),
        );
      }
      return true;
    });

    if (!ok) {
      res.status(409).json({ error: "لا يمكن تعديل عرض مفعّل — قم بإيقافه أولاً" });
      return;
    }
    res.json({ ok: true });
  } catch (e: any) {
    // Same duplicate-key handling as the POST handler — without this, an
    // attempt to rename a coupon to one already used by another draft offer
    // surfaces as an unhelpful 500.
    const r = classifyDuplicate(e);
    if (r) { res.status(409).json({ error: r }); return; }
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

router.post("/:id/activate", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.select().from(offersTable)
      .where(and(eq(offersTable.id, id), eq(offersTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "العرض غير موجود" }); return; }
    if (row.status === "expired") { res.status(409).json({ error: "العرض منتهي" }); return; }
    await db.update(offersTable).set({ status: "active", updatedAt: new Date() })
      .where(eq(offersTable.id, id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/:id/expire", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.select().from(offersTable)
      .where(and(eq(offersTable.id, id), eq(offersTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "العرض غير موجود" }); return; }
    await db.update(offersTable).set({ status: "expired", updatedAt: new Date() })
      .where(eq(offersTable.id, id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/:id", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);

    // Atomic delete with active-lock built into the WHERE clause so a
    // concurrent activate can't slip past us. We then read back rowCount
    // to figure out whether the offer simply didn't exist (404) or was
    // active (409). The follow-up SELECT after a 0-row delete is safe
    // because the only way row count is 0 is one of those two cases.
    const deleted = await db.delete(offersTable).where(and(
      eq(offersTable.id, id),
      eq(offersTable.companyId, cid),
      sql`${offersTable.status} <> 'active'`,
    )).returning({ id: offersTable.id });

    if (deleted.length === 0) {
      const [row] = await db.select({ status: offersTable.status }).from(offersTable)
        .where(and(eq(offersTable.id, id), eq(offersTable.companyId, cid)));
      if (!row) { res.status(404).json({ error: "العرض غير موجود" }); return; }
      res.status(409).json({ error: "لا يمكن حذف عرض مفعّل — قم بإيقافه أولاً" });
      return;
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// MATCH ENGINE
// ═══════════════════════════════════════════════════════════════════════════
//
// POST /api/offers/match
//
// Two payload shapes are accepted:
//
//   • LEGACY (kept for any caller still using the simple per-item probe):
//       Body: { customerId, salesRepId, items: [{ itemId }, …] }
//       Returns: { matches: { [itemId]: { offerId, offerNumber, priority, … } } }
//     The legacy mode just identifies which offer wins for each item — it
//     does NOT compute discount amounts, so the caller can't actually price
//     the cart from the response.  Used only by experimental probes.
//
//   • RICH (used by the sales invoice form — server is authoritative for
//     promotion math so two browsers can't disagree):
//       Body: { customerId, salesRepId?, applyTo?, lines: [{ lineKey, itemId, qty, unitPrice }] }
//       Returns: { lineMatches, documentMatch }
//
// The algorithm:
//   1. Pull all `active` non-expired offers for this tenant, optionally
//      filtered by `applyTo` (so POS-only offers don't bleed into invoices
//      and vice-versa — `all` matches both channels).
//   2. Build O(1) indices for the three scope junctions (customers / items /
//      sales-reps) so the inner loop stays cheap.
//   3. RICH mode walks lines twice:
//       a. Per-line: best line_pricing or buy_x_get_y offer wins (by
//          priority, ties break on larger absolute discount).
//       b. Document-level: best percentage_total or fixed_total offer wins
//          against the cart subtotal (after honouring minPurchaseAmount).
//      Document-level discount is returned separately so the form can show
//      it as its own row instead of mangling per-line discounts.
//
router.post("/match", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const customerId = req.body?.customerId ? Number(req.body.customerId) : null;
    const salesRepId = req.body?.salesRepId ? Number(req.body.salesRepId) : null;
    const applyToRaw = String(req.body?.applyTo ?? "").trim();
    const filterApplyTo: "invoice" | "pos" | null =
      applyToRaw === "invoice" || applyToRaw === "pos" ? applyToRaw : null;

    // Detect rich vs legacy shape.  A request with `lines` is rich; one with
    // only `items` is legacy.  An empty cart in either shape returns empty.
    const richLines: Array<{ lineKey: string; itemId: number; qty: number; unitPrice: number }> =
      Array.isArray(req.body?.lines)
        ? req.body.lines.map((l: any) => ({
            lineKey:   String(l?.lineKey ?? l?.itemId ?? ""),
            itemId:    Number(l?.itemId),
            qty:       Number(l?.qty)       || 0,
            unitPrice: Number(l?.unitPrice) || 0,
          })).filter((l: any) => Number.isFinite(l.itemId) && l.lineKey)
        : [];
    const isRich = richLines.length > 0 || Array.isArray(req.body?.lines);

    if (!customerId) { res.status(400).json({ error: "العميل مطلوب لتطبيق العروض" }); return; }

    const today = new Date().toISOString().slice(0, 10);
    // Mirror /active — both ends of the validity window are honoured so the
    // matcher never fires a future-dated promo before its start.
    const baseConds: any[] = [
      eq(offersTable.companyId, cid),
      eq(offersTable.status, "active"),
      sql`(${offersTable.startDate}  IS NULL OR ${offersTable.startDate}  <= ${today})`,
      sql`(${offersTable.expiryDate} IS NULL OR ${offersTable.expiryDate} >= ${today})`,
    ];
    if (filterApplyTo) {
      // 'all' applies to every channel; the channel-specific value matches
      // exactly.  Other values (impossible by enum) get no offers — safe.
      baseConds.push(sql`(${offersTable.applyTo} = 'all' OR ${offersTable.applyTo} = ${filterApplyTo})`);
    }
    const offers = await db.select().from(offersTable).where(and(...baseConds))
      .orderBy(desc(offersTable.priority));

    if (offers.length === 0) {
      if (isRich) { res.json({ lineMatches: {}, documentMatch: null }); return; }
      res.json({ matches: {} }); return;
    }

    const offerIds = offers.map((o) => o.id);
    const [custLinks, itemLinks, repLinks] = await Promise.all([
      db.select().from(offerCustomersTable).where(inArray(offerCustomersTable.offerId, offerIds)),
      db.select().from(offerItemsTable).where(inArray(offerItemsTable.offerId, offerIds)),
      db.select().from(offerSalesRepsTable).where(inArray(offerSalesRepsTable.offerId, offerIds)),
    ]);

    // Build indices keyed by offerId so the per-offer check below is O(1).
    const custByOffer  = new Map<number, Set<number>>();
    const repByOffer   = new Map<number, Set<number>>();
    const itemsByOffer = new Map<number, Map<number, { price: string | null; discount: string | null; qty: string | null }>>();
    for (const r of custLinks)  { (custByOffer.get(r.offerId)  ?? custByOffer.set(r.offerId,  new Set()).get(r.offerId)!).add(r.customerId); }
    for (const r of repLinks)   { (repByOffer.get(r.offerId)   ?? repByOffer.set(r.offerId,   new Set()).get(r.offerId)!).add(r.salesRepId); }
    for (const r of itemLinks)  {
      const m = itemsByOffer.get(r.offerId) ?? itemsByOffer.set(r.offerId, new Map()).get(r.offerId)!;
      m.set(r.itemId, { price: r.price, discount: r.discount, qty: r.qty });
    }

    // Customer + sales-rep scopes are item-independent; item scope is only
    // meaningful for line-level decisions, so we pass it as an option.
    function passesCustRepScopes(o: typeof offers[number]): boolean {
      if (o.customerScope === "specific") {
        if (!custByOffer.get(o.id)?.has(customerId!)) return false;
      }
      if (o.salesRepScope === "specific") {
        if (!salesRepId || !repByOffer.get(o.id)?.has(salesRepId)) return false;
      }
      return true;
    }

    // ── RICH MODE: compute line-level + document-level discounts ──────────
    if (isRich) {
      const lineMatches: Record<string, any> = {};
      // Per-line: line_pricing + buy_x_get_y compete; only one offer can win
      // per line so non-stackable behaviour is the default (matches Odoo).
      for (const ln of richLines) {
        if (ln.qty <= 0 || ln.unitPrice <= 0) continue;
        const lineGross = ln.qty * ln.unitPrice;
        let best: {
          offer: typeof offers[number];
          effectivePct: number;      // 0–100, applied to the line's gross
          lineDiscAmt: number;       // currency amount this offer saves
          price: string | null;      // suggested unit price (line_pricing only)
          pct:   string | null;      // suggested discount % (line_pricing only)
          bxgY:  { buyQty: number; getQty: number; getDiscountPercent: number; freeQty: number } | null;
          mode:  "price" | "percent" | "bxgy"; // which lever won
        } | null = null;

        for (const o of offers) {
          if (o.discountType !== "line_pricing" && o.discountType !== "buy_x_get_y") continue;
          if (!passesCustRepScopes(o)) continue;
          if (o.itemsScope === "specific" && !itemsByOffer.get(o.id)?.has(ln.itemId)) continue;

          let effPct = 0, discAmt = 0;
          let price: string | null = null, pct: string | null = null;
          let bxgY: { buyQty: number; getQty: number; getDiscountPercent: number; freeQty: number } | null = null;
          // Which lever actually won this offer's evaluation. Sent to the
          // client so it knows whether to apply price OR discount % — never
          // both. Without this signal the form would double-discount and
          // could oscillate when the engine picks "price" but the client
          // still writes the implicit % derived from it.
          let mode: "price" | "percent" | "bxgy" = "percent";

          if (o.discountType === "line_pricing") {
            // Per-item override — only meaningful when itemsScope='specific'
            // (the user wired the item explicitly).  When 'all', line_pricing
            // has no concrete numbers to apply, so it's a no-op.
            const link = itemsByOffer.get(o.id)?.get(ln.itemId);
            if (!link) continue;
            const minQty = Number(link.qty ?? 0) || 0;
            if (ln.qty < minQty) continue;
            price = link.price;
            pct   = link.discount;
            // Pick whichever lever (price override OR % off) saves the customer
            // more money.  Either or both may be set.
            const np = price != null ? Number(price) : NaN;
            if (Number.isFinite(np) && np >= 0 && np < ln.unitPrice) {
              const a = (ln.unitPrice - np) * ln.qty;
              if (a > discAmt) { discAmt = a; effPct = (1 - np / ln.unitPrice) * 100; mode = "price"; }
            }
            const dp = pct != null ? Number(pct) : NaN;
            if (Number.isFinite(dp) && dp > 0) {
              const a = lineGross * (Math.min(100, dp) / 100);
              if (a > discAmt) { discAmt = a; effPct = Math.min(100, dp); mode = "percent"; }
            }
          } else {
            // buy_x_get_y — every (X+Y) units triggers Y units at the configured
            // discount %.  Remainder qty pays full price.  Matches Odoo / SAP B1.
            const X = Number(o.buyQty ?? 0);
            const Y = Number(o.getQty ?? 0);
            const pctOff = Number(o.getDiscountPercent ?? 0);
            if (X <= 0 || Y <= 0 || pctOff <= 0) continue;
            const cycles = Math.floor(ln.qty / (X + Y));
            const freeQty = cycles * Y;
            if (freeQty <= 0) continue;
            discAmt = freeQty * ln.unitPrice * (Math.min(100, pctOff) / 100);
            effPct  = lineGross > 0 ? (discAmt / lineGross) * 100 : 0;
            bxgY    = { buyQty: X, getQty: Y, getDiscountPercent: pctOff, freeQty };
            mode    = "bxgy";
          }

          if (discAmt <= 0) continue;
          // Tie-break: higher priority first, then bigger absolute saving.
          if (!best
              || o.priority > best.offer.priority
              || (o.priority === best.offer.priority && discAmt > best.lineDiscAmt)) {
            best = { offer: o, effectivePct: effPct, lineDiscAmt: discAmt, price, pct, bxgY, mode };
          }
        }

        if (best) {
          lineMatches[ln.lineKey] = {
            offerId:              best.offer.id,
            offerNumber:          best.offer.offerNumber,
            nameAr:               best.offer.nameAr,
            discountType:         best.offer.discountType,
            suggestedPrice:       best.price,
            suggestedDiscountPct: best.pct,
            // Round to 4 decimals so "12.5" stays clean and we don't surface
            // floating-point dust in the discount cell.
            effectiveDiscountPct: Math.round(best.effectivePct * 10000) / 10000,
            lineDiscountAmount:   Math.round(best.lineDiscAmt   * 100)   / 100,
            buyXGetY:             best.bxgY,
            // Authoritative signal for the form: tells it which lever to
            // apply (and therefore which fields it owns).
            //   "price"  → set unitPrice = suggestedPrice, discount = 0
            //   "percent"→ set discount = effectiveDiscountPct, leave price
            //   "bxgy"   → set discount = effectiveDiscountPct, leave price
            appliedMode:          best.mode,
          };
        }
      }

      // Document-level: best percentage_total / fixed_total against the cart's
      // gross-before-VAT.  Item scope is intentionally ignored at this layer —
      // these promos are by definition cart-wide.
      const cartGross = richLines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
      let docBest: { offer: typeof offers[number]; amount: number } | null = null;
      for (const o of offers) {
        if (o.discountType !== "percentage_total" && o.discountType !== "fixed_total") continue;
        if (!passesCustRepScopes(o)) continue;
        const minPurchase = Number(o.minPurchaseAmount ?? 0) || 0;
        if (cartGross < minPurchase) continue;
        const dv = Number(o.discountValue ?? 0) || 0;
        if (dv <= 0) continue;
        const amt = o.discountType === "percentage_total"
          ? cartGross * (Math.min(100, dv) / 100)
          : Math.min(dv, cartGross);
        if (amt <= 0) continue;
        if (!docBest
            || o.priority > docBest.offer.priority
            || (o.priority === docBest.offer.priority && amt > docBest.amount)) {
          docBest = { offer: o, amount: amt };
        }
      }
      const documentMatch = docBest ? {
        offerId:                docBest.offer.id,
        offerNumber:            docBest.offer.offerNumber,
        nameAr:                 docBest.offer.nameAr,
        discountType:           docBest.offer.discountType,
        discountValue:          String(docBest.offer.discountValue ?? "0"),
        documentDiscountAmount: Math.round(docBest.amount * 100) / 100,
      } : null;

      res.json({ lineMatches, documentMatch });
      return;
    }

    // ── LEGACY MODE: per-item winner only, no compute ─────────────────────
    const itemsIn: number[] = Array.isArray(req.body?.items)
      ? req.body.items.map((x: any) => Number(x?.itemId ?? x)).filter(Number.isFinite)
      : [];
    if (itemsIn.length === 0) { res.json({ matches: {} }); return; }

    const matches: Record<number, any> = {};
    for (const itemId of itemsIn) {
      let best: { offer: typeof offers[number]; price: string | null; discount: string | null; qty: string | null } | null = null;
      for (const o of offers) {
        if (!passesCustRepScopes(o)) continue;
        let price: string | null = null, discount: string | null = null, qty: string | null = null;
        if (o.itemsScope === "specific") {
          const link = itemsByOffer.get(o.id)?.get(itemId);
          if (!link) continue;
          price = link.price; discount = link.discount; qty = link.qty;
        }
        if (!best) { best = { offer: o, price, discount, qty }; continue; }
        if (o.priority < best.offer.priority) continue;
        if (o.priority === best.offer.priority) {
          const d  = Number(discount       ?? 0);
          const bd = Number(best.discount  ?? 0);
          if (d < bd) continue;
          if (d === bd) {
            const p  = Number(price       ?? Infinity);
            const bp = Number(best.price  ?? Infinity);
            if (p >= bp) continue;
          }
        }
        best = { offer: o, price, discount, qty };
      }
      if (best) {
        matches[itemId] = {
          offerId:     best.offer.id,
          offerNumber: best.offer.offerNumber,
          priority:    best.offer.priority,
          nameAr:      best.offer.nameAr,
          price:       best.price,
          discount:    best.discount,
          qty:         best.qty,
        };
      }
    }
    res.json({ matches });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
