import { Router } from "express";
import { db } from "@workspace/db";
import { auditLogTable, userVisitsTable, trackingZonesTable } from "@workspace/db";
import { and, eq, gte, lte, desc, sql, like, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requireAdminRole, writeAudit } from "../middleware/permissions.js";

// ─── Audit log viewer API ─────────────────────────────────────────────────
//   GET /api/audit-log
//     ?companyId   superadmin only — defaults to admin's own companyId
//     ?userId      filter to a single user (numeric)
//     ?module      e.g. "sales_invoices"
//     ?action      view | create | edit | delete | post | export | denied
//     ?from, ?to   ISO date strings (inclusive)
//     ?q           free text against username/path
//     ?limit       default 50, max 200
//     ?offset      default 0
//
//   Returns: { rows: AuditLogRow[], total: number, limit, offset }
// ──────────────────────────────────────────────────────────────────────────

const router = Router();
router.use(extractAuth);
router.use(requireAdminRole);   // admin or superadmin only

router.get("/", async (req, res) => {
  try {
    const u = req.authUser!;
    const isSuper = u.role === "superadmin";

    // Tenant scoping: superadmin may pass ?companyId (or omit for ALL),
    // every other admin is locked to their own company.
    const cid = isSuper
      ? resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined)
      : (u.companyId ?? undefined);

    const userId = req.query.userId ? Number(req.query.userId) : undefined;
    const mod    = typeof req.query.module === "string" ? req.query.module.slice(0, 80) : undefined;
    const act    = typeof req.query.action === "string" ? req.query.action.slice(0, 32) : undefined;
    const from   = typeof req.query.from === "string" ? new Date(req.query.from) : undefined;
    const to     = typeof req.query.to   === "string" ? new Date(req.query.to)   : undefined;
    const q      = typeof req.query.q    === "string" ? req.query.q.trim().slice(0, 80) : "";
    const limit  = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    const conds: any[] = [];
    if (cid != null && Number.isFinite(cid))   conds.push(eq(auditLogTable.companyId, cid));
    if (userId && Number.isFinite(userId))     conds.push(eq(auditLogTable.userId,    userId));
    if (mod)                                   conds.push(eq(auditLogTable.module,    mod));
    if (act)                                   conds.push(eq(auditLogTable.action,    act));
    if (from && !isNaN(from.getTime()))        conds.push(gte(auditLogTable.createdAt, from));
    if (to   && !isNaN(to.getTime()))          conds.push(lte(auditLogTable.createdAt, to));
    if (q) {
      const pat = `%${q}%`;
      conds.push(
        sql`(${auditLogTable.username} ILIKE ${pat} OR ${auditLogTable.path} ILIKE ${pat})`
      );
    }
    const where = conds.length ? and(...conds) : undefined;

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogTable)
      .where(where as any);

    const rows = await db
      .select()
      .from(auditLogTable)
      .where(where as any)
      .orderBy(desc(auditLogTable.createdAt))
      .limit(limit)
      .offset(offset);

    // ─── Login-location enrichment (auto-checkin user_visits) ─────────
    // For each row that represents an actual login (module=auth, action=login)
    // look up the auto-checkin visit created at login time (±10 minutes
    // of createdAt) and attach place/address/lat/lng/zone so the UI can
    // show WHERE the user signed in from. Non-login rows pass through
    // with null location fields. Scoped to userIds appearing on the page
    // so the lookup cost is bounded by `limit`.
    const loginRows = rows.filter(r => r.module === "auth" && r.action === "login" && r.userId != null);
    type EnrichedRow = typeof rows[number] & {
      loginPlace: string | null; loginAddress: string | null;
      loginLat: number | null;   loginLng: number | null;
      loginAccuracy: number | null;
      loginZoneName: string | null;
    };
    const enriched: EnrichedRow[] = rows.map(r => ({
      ...r,
      loginPlace: null, loginAddress: null,
      loginLat: null,   loginLng: null,
      loginAccuracy: null,
      loginZoneName: null,
    }));
    // Only enrich login rows that have a known companyId so the
    // tenant-scoped predicates below remain effective. Login rows
    // without a companyId (extremely rare) skip enrichment.
    const loginRowsScoped = loginRows.filter(r => r.companyId != null);
    if (loginRowsScoped.length > 0) {
      const loginUserIds = Array.from(new Set(loginRowsScoped.map(r => r.userId!).filter(Boolean)));
      const loginCompanyIds = Array.from(new Set(loginRowsScoped.map(r => r.companyId!).filter((x): x is number => x != null)));
      // Pull a bounded window of recent visits for these users — only the
      // ones whose checkinAt overlaps the page's time range. Using the
      // page's min/max createdAt as the window keeps the scan tight, and
      // adding companyId to the predicate hits the composite
      // (company_id, user_id, checkin_at) index AND prevents any
      // cross-tenant leakage if userIds ever collide.
      const times = loginRowsScoped.map(r => new Date(r.createdAt).getTime());
      const minT = new Date(Math.min(...times) - 10 * 60 * 1000);
      const maxT = new Date(Math.max(...times) + 10 * 60 * 1000);
      const visits = await db.select({
        companyId: userVisitsTable.companyId,
        userId: userVisitsTable.userId,
        checkinAt: userVisitsTable.checkinAt,
        checkinPlace: userVisitsTable.checkinPlace,
        checkinAddress: userVisitsTable.checkinAddress,
        checkinLat: userVisitsTable.checkinLat,
        checkinLng: userVisitsTable.checkinLng,
        checkinAccuracy: userVisitsTable.checkinAccuracy,
        zoneId: userVisitsTable.zoneId,
      })
        .from(userVisitsTable)
        .where(and(
          inArray(userVisitsTable.companyId, loginCompanyIds),
          inArray(userVisitsTable.userId, loginUserIds),
          gte(userVisitsTable.checkinAt, minT),
          lte(userVisitsTable.checkinAt, maxT),
        ));
      const zoneIds = Array.from(new Set(visits.map(v => v.zoneId).filter((x): x is number => x != null)));
      // Zone name lookup is keyed by `${companyId}:${zoneId}` so a stray
      // zoneId from another tenant can never leak its name back.
      const zoneNameMap = new Map<string, string>();
      if (zoneIds.length > 0) {
        const zs = await db.select({
          id: trackingZonesTable.id, companyId: trackingZonesTable.companyId, name: trackingZonesTable.name,
        })
          .from(trackingZonesTable)
          .where(and(
            inArray(trackingZonesTable.companyId, loginCompanyIds),
            inArray(trackingZonesTable.id, zoneIds),
          ));
        for (const z of zs) zoneNameMap.set(`${z.companyId}:${z.id}`, z.name);
      }
      const TEN_MIN_MS = 10 * 60 * 1000;
      for (const er of enriched) {
        if (!(er.module === "auth" && er.action === "login" && er.userId != null && er.companyId != null)) continue;
        const target = new Date(er.createdAt).getTime();
        let best: typeof visits[number] | null = null;
        let bestDelta = Infinity;
        for (const v of visits) {
          if (v.userId !== er.userId) continue;
          if (v.companyId !== er.companyId) continue;
          const d = Math.abs(new Date(v.checkinAt).getTime() - target);
          if (d <= TEN_MIN_MS && d < bestDelta) { best = v; bestDelta = d; }
        }
        if (best) {
          er.loginPlace = best.checkinPlace;
          er.loginAddress = best.checkinAddress;
          er.loginLat = best.checkinLat != null ? Number(best.checkinLat) : null;
          er.loginLng = best.checkinLng != null ? Number(best.checkinLng) : null;
          er.loginAccuracy = best.checkinAccuracy != null ? Number(best.checkinAccuracy) : null;
          er.loginZoneName = best.zoneId != null ? (zoneNameMap.get(`${best.companyId}:${best.zoneId}`) ?? null) : null;
        }
      }
    }

    res.json({ rows: enriched, total: Number(count ?? 0), limit, offset });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "تعذر جلب سجل النشاط" });
  }
});

// ─── Bulk CSV export of an explicit row selection ────────────────────────
//   POST /api/audit-log/export
//     body: { ids: number[] }
//
// Streams the selected audit rows as a UTF-8 BOM CSV download. The selection
// is delivered in the request BODY (not the query string) so a few hundred
// hand-picked ids don't blow past URL-length limits in a proxied browser
// environment. Tenant scoping mirrors the listing handler: superadmin can
// pull any id, every other admin is limited to their own company — rows
// outside the caller's tenant are silently dropped from the file (and from
// the recorded count) so this endpoint never leaks the existence of
// cross-tenant entries.
//
// Caps the request at AUDIT_EXPORT_MAX_IDS (1000) to match the safety cap
// every other CSV exporter in the system uses; over-cap requests fail with
// 400 instead of being clipped silently so the operator always knows the
// file matches the picked selection 1:1.
//
// We write a single export_csv audit row through `writeAudit` so the export
// shows up in the audit log itself — the existing inspector body on
// /admin/audit-log renders the metadata grid (count, format, etc.); the
// hand-picked id list is persisted in metadata as `ids` so the batch can
// be reproduced (or audited) later. The selection is recorded as
// `selection: "manual"` so future readers can tell it apart from a
// filter-driven export.
const AUDIT_EXPORT_MAX_IDS = 1000;

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvDate(v: unknown): string {
  if (v == null || v === "") return "";
  const s = String(v);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

router.post("/export", async (req, res) => {
  try {
    const u = req.authUser!;
    const isSuper = u.role === "superadmin";

    // Accept ids from the body. Be tolerant of strings/numbers since some
    // JSON serialisers (and our own clipboard tooling) emit ids as strings.
    const raw = (req.body as { ids?: unknown } | undefined)?.ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      res.status(400).json({ error: "يجب تحديد سجل واحد على الأقل" });
      return;
    }

    // Normalize → unique positive integers, sorted ascending so the audit
    // metadata and the CSV row order are deterministic regardless of which
    // order the reviewer happened to tick rows in.
    const ids = Array.from(
      new Set(
        raw
          .map((v) => (typeof v === "number" ? v : Number(v)))
          .filter((n) => Number.isFinite(n) && n > 0 && Number.isInteger(n))
      ),
    ).sort((a, b) => a - b);

    if (ids.length === 0) {
      res.status(400).json({ error: "يجب تحديد سجل واحد على الأقل" });
      return;
    }
    if (ids.length > AUDIT_EXPORT_MAX_IDS) {
      res.status(400).json({
        error: `لا يمكن تصدير أكثر من ${AUDIT_EXPORT_MAX_IDS} سجل دفعة واحدة`,
        max: AUDIT_EXPORT_MAX_IDS,
      });
      return;
    }

    // Build the same tenant filter the listing/single-entry handlers use:
    // superadmin sees everything, every other admin is pinned to their
    // own company. An admin without an assigned companyId gets a
    // never-matches predicate so we return an empty (but valid) CSV
    // rather than leaking cross-tenant rows.
    const conds: any[] = [inArray(auditLogTable.id, ids)];
    if (!isSuper) {
      if (u.companyId != null) {
        conds.push(eq(auditLogTable.companyId, u.companyId));
      } else {
        conds.push(sql`1 = 0`);
      }
    }

    const rows = await db
      .select()
      .from(auditLogTable)
      .where(and(...conds))
      .orderBy(desc(auditLogTable.createdAt));

    // CSV columns mirror the on-screen table plus the id and the metadata
    // JSON blob so a reviewer pasting the file into Excel sees the same
    // information as the live listing without losing the fine-grained
    // metadata. Header text is bilingual on purpose — the existing audit
    // log UI uses Arabic labels, but the CSV is shared across reviewers
    // who may not read Arabic.
    const headers = [
      "ID",
      "Time",
      "User",
      "Role",
      "Company ID",
      "Module",
      "Action",
      "Method",
      "Path",
      "Entity Type",
      "Entity ID",
      "Status",
      "IP",
      "User Agent",
      "Metadata",
    ];
    const csvRows = rows.map((r) => [
      r.id,
      csvDate(r.createdAt),
      r.username ?? "",
      r.role ?? "",
      r.companyId ?? "",
      r.module,
      r.action,
      r.method ?? "",
      r.path ?? "",
      r.entityType ?? "",
      r.entityId ?? "",
      r.statusCode ?? "",
      r.ip ?? "",
      r.userAgent ?? "",
      r.metadata != null ? JSON.stringify(r.metadata) : "",
    ]);

    // Audit the export itself. Metadata records the manual selection so
    // the batch is reproducible: `ids` is the canonicalized request, `count`
    // is what actually made it into the file (may be lower than `ids.length`
    // if some ids were missing or filtered out by tenant scoping). Format
    // matches the existing maintenance CSV writers so the inspector body
    // on /admin/audit-log renders the same metric grid + filters block.
    await writeAudit({
      userId:    u.id ?? null,
      username:  u.username ?? null,
      role:      u.role ?? null,
      companyId: u.companyId ?? null,
      module:    "audit_log",
      action:    "export_csv",
      method:    req.method,
      path:      req.originalUrl,
      entityType: "audit_log",
      entityId:   null,
      statusCode: 200,
      metadata: {
        count: rows.length,
        requestedCount: ids.length,
        format: "csv",
        selection: "manual",
        ids,
      },
    });

    const lines = [headers.map(csvEscape).join(",")];
    for (const r of csvRows) lines.push(r.map(csvEscape).join(","));
    // \uFEFF = UTF-8 BOM. Excel needs this to display Arabic correctly.
    const body = "\uFEFF" + lines.join("\r\n") + "\r\n";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-log-selection-${Date.now()}.csv"`,
    );
    res.setHeader("X-Csv-Row-Count", String(rows.length));
    res.setHeader("X-Csv-Requested-Count", String(ids.length));
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Disposition, X-Csv-Row-Count, X-Csv-Requested-Count",
    );
    res.send(body);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "تعذر تصدير السجلات المحددة" });
  }
});

// Distinct module list — used by the filter dropdown so the UI doesn't have
// to hardcode the catalogue. Cheap because the index covers it.
//
// NOTE: Registered BEFORE `/:id` so a request for `/modules` doesn't get
// captured by the dynamic-id route (which would then 400 on the
// non-numeric "modules" param).
router.get("/modules", async (req, res) => {
  try {
    const u = req.authUser!;
    const isSuper = u.role === "superadmin";
    const cid = isSuper
      ? resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined)
      : (u.companyId ?? undefined);
    const where = cid != null ? eq(auditLogTable.companyId, cid) : undefined;
    const rows = await db
      .selectDistinct({ module: auditLogTable.module })
      .from(auditLogTable)
      .where(where as any)
      .orderBy(auditLogTable.module);
    res.json(rows.map(r => r.module).filter(Boolean));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "تعذر جلب القائمة" });
  }
});

// ─── Bulk DELETE matching the same filter set as the listing handler ────
//   DELETE /api/audit-log
//     query params: same as GET / (companyId, userId, module, action, from,
//                   to, q). Acts on EVERY row that matches — there is no
//                   ?ids= override here; the audit-log page already gives
//                   the reviewer a per-row checkbox flow for surgical work,
//                   so this endpoint is the "clean by filter" companion.
//
// Returns: { deleted: number }
//
// Tenant scoping mirrors the listing handler:
//   • Non-superadmin admins are PINNED to their own company and CANNOT
//     widen via ?companyId — the value is ignored.
//   • SuperAdmin may pass ?companyId to constrain, OR omit it to clean
//     across every tenant. Because that is destructive, we record a
//     dedicated `delete` audit row capturing the resolved filter set
//     and the affected count BEFORE returning so the action itself is
//     auditable (the new row is written with `module: "audit_log"` so
//     it is filterable from the UI).
//
// Registered BEFORE `/:id` so the literal "/" delete path wins over the
// `:id` placeholder.
router.delete("/", async (req, res) => {
  try {
    const u = req.authUser!;
    const isSuper = u.role === "superadmin";

    const cid = isSuper
      ? resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined)
      : (u.companyId ?? undefined);

    const userId = req.query.userId ? Number(req.query.userId) : undefined;
    const mod    = typeof req.query.module === "string" ? req.query.module.slice(0, 80) : undefined;
    const act    = typeof req.query.action === "string" ? req.query.action.slice(0, 32) : undefined;
    const from   = typeof req.query.from === "string" ? new Date(req.query.from) : undefined;
    const to     = typeof req.query.to   === "string" ? new Date(req.query.to)   : undefined;
    const q      = typeof req.query.q    === "string" ? req.query.q.trim().slice(0, 80) : "";

    const conds: any[] = [];
    if (cid != null && Number.isFinite(cid))   conds.push(eq(auditLogTable.companyId, cid));
    if (userId && Number.isFinite(userId))     conds.push(eq(auditLogTable.userId,    userId));
    if (mod)                                   conds.push(eq(auditLogTable.module,    mod));
    if (act)                                   conds.push(eq(auditLogTable.action,    act));
    if (from && !isNaN(from.getTime()))        conds.push(gte(auditLogTable.createdAt, from));
    if (to   && !isNaN(to.getTime()))          conds.push(lte(auditLogTable.createdAt, to));
    if (q) {
      const pat = `%${q}%`;
      conds.push(
        sql`(${auditLogTable.username} ILIKE ${pat} OR ${auditLogTable.path} ILIKE ${pat})`
      );
    }

    // Defense in depth: a non-superadmin call with no companyId resolved
    // (e.g. malformed token) MUST NOT wipe global rows. Bail rather than
    // silently match everything.
    if (!isSuper && (cid == null || !Number.isFinite(cid))) {
      res.status(400).json({ error: "تعذر تحديد نطاق الشركة" });
      return;
    }

    const where = conds.length ? and(...conds) : undefined;

    // Count first so we can report what we deleted AND so the audit row we
    // write below carries the exact figure.
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogTable)
      .where(where as any);
    const matched = Number(count ?? 0);

    if (matched > 0) {
      await db.delete(auditLogTable).where(where as any);
    }

    // Self-record the deletion so future readers see who cleaned what.
    // Filter set is captured verbatim so a follow-up reviewer can replay
    // the same query on the (now empty) result.
    try {
      // writeAudit takes a single payload (see middleware/permissions.ts:363)
      // — the export_csv handler in this same file at line 224 is the
      // canonical pattern. Mirror it so the self-recorded row carries the
      // same actor/method/path triple every other audit row does, otherwise
      // the row would silently fail to insert and we'd lose accountability
      // for every bulk-clean.
      await writeAudit({
        userId:     u.id ?? null,
        username:   u.username ?? null,
        role:       u.role ?? null,
        companyId:  u.companyId ?? null,
        module:     "audit_log",
        action:     "delete",
        method:     req.method,
        path:       req.originalUrl,
        entityType: "audit_log",
        entityId:   null,
        statusCode: 200,
        metadata: {
          deletedCount: matched,
          filters: {
            companyId: cid ?? null,
            userId:    userId ?? null,
            module:    mod ?? null,
            action:    act ?? null,
            from:      typeof req.query.from === "string" ? req.query.from : null,
            to:        typeof req.query.to   === "string" ? req.query.to   : null,
            q:         q || null,
          },
        },
      });
    } catch (logErr) {
      req.log?.warn?.({ err: logErr }, "audit-log: failed to record self-delete");
    }

    res.json({ deleted: matched });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "تعذر حذف سجل النشاط" });
  }
});

// Single-entry fetch — powers the shareable permalink (task #126). The
// audit-log page encodes the open dialog's row id in `?entry=N` so a URL
// like `/admin/audit-log?entry=12345` reopens the same details modal. When
// the entry isn't on the current filter page (or the page was loaded fresh
// from the link), the UI falls back to this endpoint to fetch it directly.
//
// Same tenant-scoping rules as the listing handler: superadmin can fetch
// any entry, every other admin is locked to their own company. We return
// 404 — not 403 — for cross-tenant ids so we don't leak whether a given id
// exists in some other company.
//
// Registered AFTER `/modules` so the static segment wins over `:id`.
router.get("/:id", async (req, res) => {
  try {
    const u = req.authUser!;
    const isSuper = u.role === "superadmin";
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }

    const conds: any[] = [eq(auditLogTable.id, id)];
    if (!isSuper) {
      // Non-superadmins are pinned to their own company. If they have no
      // company assigned at all (unusual but possible), fall through to a
      // condition that can never match so we return 404 cleanly instead of
      // exposing every entry.
      if (u.companyId != null) {
        conds.push(eq(auditLogTable.companyId, u.companyId));
      } else {
        res.status(404).json({ error: "السجل غير موجود" });
        return;
      }
    }

    const [row] = await db
      .select()
      .from(auditLogTable)
      .where(and(...conds))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "السجل غير موجود" });
      return;
    }
    res.json(row);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "تعذر جلب السجل" });
  }
});

export default router;
