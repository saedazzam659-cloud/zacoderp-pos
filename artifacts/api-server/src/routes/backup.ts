import { Router } from "express";
import { db } from "@workspace/db";
import {
  branchesTable, regionsTable,
  warehouseGroupsTable, warehousesTable,
  itemGroupsTable, unitsTable, itemsTable,
  customersTable, suppliersTable, supplierGroupsTable,
  accountsTable,
  cashBoxesTable, bankAccountsTable,
  companiesTable, autoBackupsTable,
} from "@workspace/db";
import { eq, and, sql, desc, asc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { writeAudit } from "../middleware/permissions.js";
import { chat as aiChat, isAIAvailable } from "../lib/aiClient.js";
import { logAiUsage, requireAiFeature } from "../middleware/requireAiFeature.js";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Helper: when a superadmin operates against a tenant from cross-tenant tools
 * (e.g. the Backup Operations Center), we want the action recorded in the
 * audit log even though tenant-side users would normally see this without
 * audit. The check is cheap and safe to call from any backup write handler.
 */
function isCrossTenantSuperadmin(req: any): boolean {
  return req.authUser?.role === "superadmin";
}

const router = Router();
  // ─────────────────────────────────────────────────────────────────────────
  // Gemini-first transparent redirect (see notes in routes/ai.ts).
  // Re-binds OPENAI_BASE/KEY (declared elsewhere in this file) to a sentinel
  // "AI_PROXY" string and shadows the global fetch with a local one that
  // intercepts the sentinel URL, dispatches via aiChat, and returns a
  // Response-shaped object so existing r.ok/r.json()/r.text() callsites
  // continue to work unchanged. AsyncLocalStorage threads `req` through
  // so the feature-gate's logAiUsage counter still advances.
  // ─────────────────────────────────────────────────────────────────────────
  const __aiReqStore = new AsyncLocalStorage<any>();
  router.use((req, _res, next) => { __aiReqStore.run(req, () => next()); });

  const __nativeFetch = globalThis.fetch;
  async function fetch(input: any, init?: any): Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }> {
    if (typeof input === "string" && input.startsWith("AI_PROXY")) {
      const body = (() => { try { return JSON.parse(init?.body ?? "{}"); } catch { return {}; } })();
      const result = await aiChat(body.messages ?? [], {
        json:      body.response_format?.type === "json_object",
        maxTokens: body.max_completion_tokens ?? body.max_tokens ?? 2048,
        providers: ["gemini"],
      });
      const req = __aiReqStore.getStore();
      if (req) {
        try {
          await logAiUsage(req, result.ok
            ? { status: "allowed", provider: result.provider }
            : { status: "error",   meta: { reason: result.reason } });
        } catch { /* logging must never break the call */ }
      }
      if (!result.ok) {
        return { ok: false, status: 502, json: async () => ({ error: result.reason }), text: async () => result.reason };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: result.text } }] }),
        text: async () => result.text,
      };
    }
    return (__nativeFetch as any)(input, init);
  }
  
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  // Only admin-level users may export/import backups
  const role = (req.authUser as any).role;
  if (role && !["superadmin", "admin", "owner"].includes(role)) {
    res.status(403).json({ error: "هذه العملية تتطلب صلاحيات مدير" });
    return;
  }
  next();
});

// Foreign-key column → name of the table key whose id-map resolves it.
type FkRef = { col: string; ref: string };

type TableDef = {
  key: string;
  table: any;
  label: string;
  hasCompanyId: boolean;
  // Priority-ordered natural keys used for idempotent upsert / FK remapping.
  // First non-null value in a row wins; empty list ⇒ always insert.
  businessKeys: string[];
  fks: FkRef[];
  selfRef?: string; // column inside this table that points to another row in the same table
};

// Ordered so that dependencies come before dependents.
const TABLES: readonly TableDef[] = [
  { key: "regions",         table: regionsTable,         label: "المناطق",         hasCompanyId: false, businessKeys: ["code", "nameAr"],       fks: [] },
  { key: "branches",        table: branchesTable,        label: "الفروع",          hasCompanyId: true,  businessKeys: ["code", "nameAr"],       fks: [{ col: "regionId", ref: "regions" }] },
  { key: "accounts",        table: accountsTable,        label: "شجرة الحسابات",   hasCompanyId: true,  businessKeys: ["code"],                 fks: [], selfRef: "parentId" },
  { key: "warehouseGroups", table: warehouseGroupsTable, label: "مجموعات المخازن",  hasCompanyId: true,  businessKeys: ["code", "nameAr"],       fks: [] },
  { key: "warehouses",      table: warehousesTable,      label: "المخازن",         hasCompanyId: true,  businessKeys: ["code"],                 fks: [{ col: "groupId", ref: "warehouseGroups" }, { col: "accountId", ref: "accounts" }] },
  { key: "itemGroups",      table: itemGroupsTable,      label: "مجموعات الأصناف",  hasCompanyId: true,  businessKeys: ["code", "nameAr"],       fks: [] },
  { key: "units",           table: unitsTable,           label: "الوحدات",         hasCompanyId: true,  businessKeys: ["code", "nameAr"],       fks: [] },
  { key: "items",           table: itemsTable,           label: "الأصناف",         hasCompanyId: true,  businessKeys: ["code", "barcode"],      fks: [{ col: "groupId", ref: "itemGroups" }, { col: "unitId", ref: "units" }] },
  { key: "supplierGroups",  table: supplierGroupsTable,  label: "مجموعات الموردين", hasCompanyId: true,  businessKeys: ["code", "nameAr"],       fks: [] },
  { key: "suppliers",       table: suppliersTable,       label: "الموردون",        hasCompanyId: true,  businessKeys: ["code", "vatNumber", "nameAr"], fks: [{ col: "accountId", ref: "accounts" }, { col: "groupId", ref: "supplierGroups" }] },
  { key: "customers",       table: customersTable,       label: "العملاء",         hasCompanyId: true,  businessKeys: ["vatNumber", "nameAr"],  fks: [{ col: "accountId", ref: "accounts" }] },
  { key: "cashBoxes",       table: cashBoxesTable,       label: "الخزن النقدية",   hasCompanyId: true,  businessKeys: ["code"],                 fks: [{ col: "branchId", ref: "branches" }, { col: "accountId", ref: "accounts" }] },
  { key: "bankAccounts",    table: bankAccountsTable,    label: "الحسابات البنكية", hasCompanyId: true,  businessKeys: ["code", "accountNumber"], fks: [{ col: "branchId", ref: "branches" }, { col: "accountId", ref: "accounts" }] },
] as const;

/** Build a composite key: "<col>:<value>" for the first non-empty business key. */
function makeBusinessKey(row: any, keys: string[]): string | null {
  for (const k of keys) {
    const v = row?.[k];
    if (v != null && String(v).trim() !== "") return `${k}:${String(v).trim()}`;
  }
  return null;
}

/* ─── GET /export ─── download JSON backup of all master data ─────────────── */
router.get("/export", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }

    const data: Record<string, any[]> = {};
    for (const t of TABLES) {
      const rows = t.hasCompanyId
        ? await db.select().from(t.table).where(eq(t.table.companyId, companyId))
        : await db.select().from(t.table);
      data[t.key] = rows;
    }

    res.json({
      meta: {
        schemaVersion: 1,
        companyId,
        exportedAt: new Date().toISOString(),
        exportedBy: (req.authUser as any)?.username ?? null,
        appName: "ZATCA Invoicing",
      },
      counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
      data,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── POST /ai-analyze ─── AI natural-language summary of an uploaded backup  */
router.post("/ai-analyze", requireAiFeature("report_analyzer"), async (req, res) => {
  try {
    const payload = req.body?.backup;
    if (!payload || typeof payload !== "object" || !payload.data) {
      res.status(400).json({ error: "ملف نسخة احتياطية غير صالح" });
      return;
    }

    const counts: Record<string, number> = {};
    for (const t of TABLES) {
      counts[t.key] = Array.isArray(payload.data[t.key]) ? payload.data[t.key].length : 0;
    }
    const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);

    const samples: Record<string, any> = {};
    for (const t of TABLES) {
      const first = Array.isArray(payload.data[t.key]) ? payload.data[t.key][0] : null;
      if (first) {
        const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = first;
        samples[t.key] = rest;
      }
    }

    const OPENAI_BASE = "AI_PROXY";
    const OPENAI_KEY  = "AI_PROXY";

    const fallbackSummary = () => {
      const parts = TABLES.filter(t => counts[t.key] > 0).map(t => `• ${t.label}: ${counts[t.key]}`);
      return `نسخة احتياطية تحتوي على ${totalRows} سجلاً.\n${parts.join("\n")}`;
    };

    if (!isAIAvailable()) {
      res.json({ summary: fallbackSummary(), warnings: [], counts });
      return;
    }

    const tableList = TABLES.map(t => `- ${t.key} (${t.label}): ${counts[t.key]} سجل`).join("\n");
    const prompt = `هذه نسخة احتياطية من نظام فاتورة إلكترونية سعودي (ZATCA).
معلومات النسخة:
- شركة رقم: ${payload.meta?.companyId ?? "?"}
- تاريخ التصدير: ${payload.meta?.exportedAt ?? "?"}
- إصدار التخطيط: ${payload.meta?.schemaVersion ?? "?"}

جداول النسخة (البيانات الرئيسية):
${tableList}

عيّنات من كل جدول:
${JSON.stringify(samples, null, 2).slice(0, 3500)}

اكتب ملخصاً عربياً موجزاً (5-8 أسطر) يشرح محتوى هذه النسخة الاحتياطية، وأهم الملاحظات، والتحذيرات إن وُجدت (مثل: جداول فارغة، اختلاف نسخة التخطيط، إلخ).
أرجع JSON فقط بهذا الشكل:
{ "summary": "<نص عربي>", "warnings": ["<تحذير1>", "<تحذير2>"] }`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    let aiRes: any;
    try {
      aiRes = await fetch(`${OPENAI_BASE.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "أنت مساعد محاسبي. أعد JSON صالحاً فقط بدون أي نص إضافي." },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          response_format: { type: "json_object" },
        }),
        signal: ctrl.signal,
      });
    } catch (e: any) {
      clearTimeout(timer);
      res.json({ summary: fallbackSummary(), warnings: [e?.name === "AbortError" ? "انتهت مهلة الذكاء الاصطناعي" : "تعذّر الاتصال بالذكاء الاصطناعي"], counts });
      return;
    }
    clearTimeout(timer);

    if (!aiRes.ok) { res.json({ summary: fallbackSummary(), warnings: [], counts }); return; }

    const data = await aiRes.json() as any;
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(content); } catch {}

    res.json({
      summary: String(parsed.summary || fallbackSummary()).slice(0, 1500),
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.slice(0, 10).map((w: any) => String(w).slice(0, 300)) : [],
      counts,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── POST /restore ───────────────────────────────────────────────────────────
 * Restore is idempotent and non-destructive:
 *   • For every incoming row we look for an existing row in the TARGET company
 *     with the same business key (`code`). If found, we DON'T insert —
 *     instead we record oldId→existingId in the table's id-map.
 *   • If not found, we remap any FK columns via prior tables' id-maps,
 *     strip id/timestamps, force companyId to the current tenant, then insert
 *     ONE row at a time (so one bad row doesn't poison the transaction).
 *   • Accounts are inserted root-first by breadth so self-ref parentId can be
 *     remapped from the same table's in-progress id-map.
 * ─────────────────────────────────────────────────────────────────────────── */
/**
 * Reusable restore worker — extracted so SuperAdmin admin routes can re-use
 * the same idempotent restore logic without HTTP-forwarding into this
 * tenant-scoped router.
 */
// A snapshot row. Backup payloads are user-supplied JSON, so individual rows
// are unknown shapes — we narrow with a Record<string, unknown> and read each
// field defensively below. This avoids `any` casts entirely.
type SnapshotRow = Record<string, unknown>;

export async function restoreFromSnapshotPayload(
  companyId: number,
  payload: { data?: Record<string, unknown> } | null | undefined,
): Promise<{
  ok: true;
  companyId: number;
  report: Record<string, { received: number; inserted: number; matched: number; failed: number }>;
}> {
  if (!payload || typeof payload !== "object" || !payload.data) {
    throw new Error("ملف نسخة احتياطية غير صالح");
  }
  const report: Record<string, { received: number; inserted: number; matched: number; failed: number }> = {};
  const idMap: Record<string, Map<number, number>> = {};
  const data = payload.data;

  await db.transaction(async (tx) => {
      for (const t of TABLES) {
        idMap[t.key] = new Map();
        const raw = data[t.key];
        const rows: SnapshotRow[] = Array.isArray(raw) ? raw as SnapshotRow[] : [];
        report[t.key] = { received: rows.length, inserted: 0, matched: 0, failed: 0 };
        if (!rows.length) continue;

        const existingByKey = new Map<string, number>();
        if (t.businessKeys.length) {
          const existing: SnapshotRow[] = t.hasCompanyId
            ? await tx.select().from(t.table).where(eq(t.table.companyId, companyId))
            : await tx.select().from(t.table);
          for (const r of existing) {
            for (const k of t.businessKeys) {
              const v = r[k];
              if (v != null && String(v).trim() !== "") {
                const idVal = Number(r.id);
                if (Number.isFinite(idVal)) existingByKey.set(`${k}:${String(v).trim()}`, idVal);
              }
            }
          }
        }

        const ordered = t.selfRef
          ? sortByParentDepth(rows, "id", t.selfRef)
          : rows;

        for (const r of ordered) {
          const oldId = typeof r.id === "number" ? r.id : Number(r.id);
          const bkComposite = makeBusinessKey(r, t.businessKeys);

          if (bkComposite && existingByKey.has(bkComposite)) {
            const existingId = existingByKey.get(bkComposite)!;
            if (Number.isFinite(oldId)) idMap[t.key].set(oldId, existingId);
            report[t.key].matched++;
            continue;
          }

          // Build the insert payload by stripping system fields and remapping FKs.
          const rest: Record<string, unknown> = { ...r };
          delete rest.id;
          delete rest.createdAt;
          delete rest.updatedAt;
          if (t.hasCompanyId) rest.companyId = companyId;

          for (const fk of t.fks) {
            const oldFk = rest[fk.col];
            if (oldFk == null) continue;
            const mapped = idMap[fk.ref]?.get(Number(oldFk));
            rest[fk.col] = mapped ?? null;
          }

          if (t.selfRef) {
            const oldSelf = rest[t.selfRef];
            if (oldSelf != null) {
              const mapped = idMap[t.key].get(Number(oldSelf));
              rest[t.selfRef] = mapped ?? null;
            }
          }

          try {
            const inserted: SnapshotRow[] = await tx.transaction(async (inner) => {
              return await inner.insert(t.table).values(rest).returning();
            });
            const newIdRaw = inserted[0]?.id;
            const newId = typeof newIdRaw === "number" ? newIdRaw : Number(newIdRaw);
            if (Number.isFinite(newId) && Number.isFinite(oldId)) idMap[t.key].set(oldId, newId);
            // Re-index the just-inserted row by every business key so
            // subsequent rows in the same payload can dedup against it.
            if (Number.isFinite(newId)) {
              for (const k of t.businessKeys) {
                const v = rest[k];
                if (v != null && String(v).trim() !== "") {
                  existingByKey.set(`${k}:${String(v).trim()}`, newId);
                }
              }
            }
            report[t.key].inserted++;
          } catch {
            report[t.key].failed++;
          }
        }
      }
    });

  return { ok: true, companyId, report };
}

router.post("/restore", async (req, res) => {
  let companyId: number | undefined;
  try {
    companyId = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }

    const out = await restoreFromSnapshotPayload(companyId, req.body?.backup);
    // Audit successful restore (module="backups") so all backup write paths
    // share a uniform accountability trail.
    await writeAudit({
      userId: req.authUser?.id ?? null,
      username: req.authUser?.username ?? null,
      companyId, module: "backups", action: "restore",
      success: true,
      message: `استعادة ملف نسخة احتياطية للشركة #${companyId}`,
    });
    res.json(out);
  } catch (e: any) {
    if (companyId) {
      await writeAudit({
        userId: req.authUser?.id ?? null,
        username: req.authUser?.username ?? null,
        companyId, module: "backups", action: "restore",
        success: false,
        message: `فشل استعادة ملف نسخة احتياطية للشركة #${companyId}: ${e?.message ?? "خطأ"}`,
      });
    }
    res.status(400).json({ error: e.message });
  }
});

/* ═════════════════════════════════════════════════════════════════════════
 * Automatic backups
 * Scheduler builds a snapshot per company every N hours and keeps the last K.
 * Users can list / download / restore / delete snapshots and tweak the
 * schedule per company.
 * ═════════════════════════════════════════════════════════════════════════ */

/** Reusable: build a full snapshot payload for one company (same shape as /export). */
export async function buildSnapshot(companyId: number): Promise<{ payload: any; counts: Record<string, number> }> {
  const data: Record<string, any[]> = {};
  for (const t of TABLES) {
    const rows = t.hasCompanyId
      ? await db.select().from(t.table).where(eq(t.table.companyId, companyId))
      : await db.select().from(t.table);
    data[t.key] = rows;
  }
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
  const payload = {
    meta: { schemaVersion: 1, companyId, exportedAt: new Date().toISOString(), exportedBy: "scheduler", appName: "ZATCA Invoicing" },
    counts, data,
  };
  return { payload, counts };
}

/** Write a snapshot row and enforce per-company retention. */
export async function persistSnapshot(companyId: number, reason: "scheduled" | "manual"): Promise<number> {
  const { payload, counts } = await buildSnapshot(companyId);
  const sizeBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  const [row] = await db.insert(autoBackupsTable).values({
    companyId, reason, sizeBytes, counts, data: payload,
  }).returning({ id: autoBackupsTable.id });

  // Rotate: keep only the most recent `autoBackupRetention` per company.
  const [company] = await db.select({ retention: companiesTable.autoBackupRetention })
    .from(companiesTable).where(eq(companiesTable.id, companyId));
  const retention = Math.max(1, Math.min(30, company?.retention ?? 7));
  const old = await db.select({ id: autoBackupsTable.id })
    .from(autoBackupsTable)
    .where(eq(autoBackupsTable.companyId, companyId))
    .orderBy(desc(autoBackupsTable.createdAt))
    .offset(retention);
  if (old.length) {
    for (const o of old) {
      await db.delete(autoBackupsTable).where(eq(autoBackupsTable.id, o.id));
    }
  }

  await db.update(companiesTable)
    .set({ lastAutoBackupAt: new Date() })
    .where(eq(companiesTable.id, companyId));

  return row.id;
}

/* ─── GET /auto/list?companyId=X ─── list snapshot metadata (no data blob) ── */
router.get("/auto/list", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const rows = await db.select({
      id: autoBackupsTable.id,
      createdAt: autoBackupsTable.createdAt,
      reason: autoBackupsTable.reason,
      sizeBytes: autoBackupsTable.sizeBytes,
      counts: autoBackupsTable.counts,
    }).from(autoBackupsTable)
      .where(eq(autoBackupsTable.companyId, companyId))
      .orderBy(desc(autoBackupsTable.createdAt))
      // Cap on-screen history to the last 30 snapshots (per Backup Operations
      // Center spec). Older snapshots remain on disk subject to retention.
      .limit(30);

    const [company] = await db.select({
      enabled: companiesTable.autoBackupEnabled,
      frequencyHours: companiesTable.autoBackupFrequencyHours,
      retention: companiesTable.autoBackupRetention,
      lastAt: companiesTable.lastAutoBackupAt,
    }).from(companiesTable).where(eq(companiesTable.id, companyId));

    if (isCrossTenantSuperadmin(req)) {
      await writeAudit({
        userId: req.authUser?.id ?? null,
        username: req.authUser?.username ?? null,
        companyId, module: "backups", action: "view",
        success: true, message: `عرض سجل النسخ للشركة #${companyId}`,
      });
    }

    res.json({ settings: company ?? null, snapshots: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── GET /auto/:id/download ─── download one snapshot as JSON file ────────── */
router.get("/auto/:id/download", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const id = Number(req.params.id);
    const [row] = await db.select().from(autoBackupsTable).where(eq(autoBackupsTable.id, id));
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    if (companyId && row.companyId !== companyId) { res.status(403).json({ error: "ممنوع" }); return; }
    res.json(row.data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── POST /auto/:id/restore ─── restore one stored snapshot ───────────────── */
router.post("/auto/:id/restore", async (req, res) => {
  try {
    // Allow superadmin to pass companyId in the body for cross-tenant restore;
    // tenant users always restore into their own tenant.
    const companyId = resolveCompanyId(
      req,
      req.body?.companyId ? Number(req.body.companyId) : undefined,
    );
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const id = Number(req.params.id);
    const [row] = await db.select().from(autoBackupsTable).where(eq(autoBackupsTable.id, id));
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    if (row.companyId !== companyId) { res.status(403).json({ error: "ممنوع" }); return; }

    // VAT confirmation: if the caller provides confirmVatNumber it MUST match
    // the company's stored VAT — used by the Backup Operations Center's inline
    // typed-confirmation panel to prevent accidental cross-tenant restores.
    if (typeof req.body?.confirmVatNumber === "string") {
      const [c] = await db.select({ vatNumber: companiesTable.vatNumber })
        .from(companiesTable).where(eq(companiesTable.id, companyId));
      if (!c || String(c.vatNumber).trim() !== String(req.body.confirmVatNumber).trim()) {
        res.status(400).json({ error: "الرقم الضريبي غير مطابق" });
        return;
      }
    }

    // Mandatory pre-restore safety snapshot — if it fails we abort with NO
    // data changes so the operator never loses state silently. We also keep
    // the resulting preRestoreId so the response contract matches what the
    // Backup Operations Center expects (used to build a recovery toast link).
    let preRestoreId: number | null = null;
    try {
      preRestoreId = await persistSnapshot(companyId, "manual");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "تعذّر إنشاء نسخة الأمان";
      // Audit the failed write attempt so the operator is accountable.
      await writeAudit({
        userId: req.authUser?.id ?? null,
        username: req.authUser?.username ?? null,
        companyId, module: "backups", action: "restore",
        success: false, message: `فشل إنشاء نسخة الأمان قبل الاستعادة #${id}: ${msg}`,
      });
      res.status(500).json({ error: `فشل إنشاء نسخة الأمان قبل الاستعادة: ${msg}` });
      return;
    }

    const out = await restoreFromSnapshotPayload(companyId, row.data);

    // ALL successful writes are audited under module="backups", regardless of
    // whether the caller is the tenant or a cross-tenant superadmin — this is
    // the contract the Backup Operations Center relies on.
    await writeAudit({
      userId: req.authUser?.id ?? null,
      username: req.authUser?.username ?? null,
      companyId, module: "backups", action: "restore",
      success: true,
      message: `استعادة نسخة #${id} للشركة #${companyId} (نسخة أمان #${preRestoreId})`,
    });
    res.json({ ...out, snapshotId: id, preRestoreId });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── DELETE /auto/:id ─── remove a snapshot ───────────────────────────────── */
router.delete("/auto/:id", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const id = Number(req.params.id);
    const [row] = await db.select({ companyId: autoBackupsTable.companyId }).from(autoBackupsTable).where(eq(autoBackupsTable.id, id));
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    if (companyId && row.companyId !== companyId) { res.status(403).json({ error: "ممنوع" }); return; }
    await db.delete(autoBackupsTable).where(eq(autoBackupsTable.id, id));
    await writeAudit({
      userId: req.authUser?.id ?? null,
      username: req.authUser?.username ?? null,
      companyId: row.companyId, module: "backups", action: "delete",
      success: true, message: `حذف نسخة #${id} للشركة #${row.companyId}`,
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── POST /auto/settings ─── update per-company auto-backup settings ──────── */
router.post("/auto/settings", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }

    const patch: any = {};
    if (typeof req.body.enabled === "boolean")   patch.autoBackupEnabled = req.body.enabled;
    if (Number.isFinite(Number(req.body.frequencyHours))) {
      const h = Math.max(1, Math.min(168, Number(req.body.frequencyHours)));
      patch.autoBackupFrequencyHours = h;
    }
    if (Number.isFinite(Number(req.body.retention))) {
      const r = Math.max(1, Math.min(30, Number(req.body.retention)));
      patch.autoBackupRetention = r;
    }
    if (!Object.keys(patch).length) { res.status(400).json({ error: "لا توجد تغييرات" }); return; }

    await db.update(companiesTable).set(patch).where(eq(companiesTable.id, companyId));
    await writeAudit({
      userId: req.authUser?.id ?? null,
      username: req.authUser?.username ?? null,
      companyId, module: "backups", action: "edit",
      success: true,
      message: `تعديل إعدادات النسخ للشركة #${companyId}: ${Object.keys(patch).join(", ")}`,
    });
    res.json({ ok: true, settings: patch });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── POST /auto/run-now ─── manual snapshot on demand ─────────────────────── */
router.post("/auto/run-now", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    try {
      const id = await persistSnapshot(companyId, "manual");
      await writeAudit({
        userId: req.authUser?.id ?? null,
        username: req.authUser?.username ?? null,
        companyId, module: "backups", action: "create",
        success: true, message: `أخذ نسخة يدوية #${id} للشركة #${companyId}`,
      });
      res.json({ ok: true, id });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "فشل أخذ النسخة";
      await writeAudit({
        userId: req.authUser?.id ?? null,
        username: req.authUser?.username ?? null,
        companyId, module: "backups", action: "create",
        success: false, message: `فشل أخذ نسخة يدوية للشركة #${companyId}: ${msg}`,
      });
      throw e;
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── Scheduler ───────────────────────────────────────────────────────────────
 * Runs every 15 minutes. For each company with autoBackupEnabled=true,
 * if (now - lastAutoBackupAt) >= frequencyHours, a new scheduled snapshot is
 * created. Runs guard-railed so one company's failure doesn't abort others.
 * ─────────────────────────────────────────────────────────────────────────── */
let schedulerStarted = false;
export function startBackupScheduler(intervalMs = 15 * 60_000) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  async function tick() {
    try {
      const companies = await db.select({
        id: companiesTable.id,
        enabled: companiesTable.autoBackupEnabled,
        frequencyHours: companiesTable.autoBackupFrequencyHours,
        lastAt: companiesTable.lastAutoBackupAt,
      }).from(companiesTable);

      for (const c of companies) {
        if (!c.enabled) continue;
        const dueMs = (c.frequencyHours ?? 24) * 60 * 60_000;
        const lastMs = c.lastAt ? new Date(c.lastAt).getTime() : 0;
        if (Date.now() - lastMs < dueMs) continue;
        try {
          await persistSnapshot(c.id, "scheduled");
          console.log(`[auto-backup] snapshot saved for company ${c.id}`);
        } catch (e: any) {
          console.error(`[auto-backup] failed for company ${c.id}:`, e.message);
        }
      }
    } catch (e: any) {
      console.error("[auto-backup] scheduler tick error:", e.message);
    }
  }

  // Run soon after startup (5 s), then every `intervalMs`.
  setTimeout(tick, 5_000);
  setInterval(tick, intervalMs);
}

/** Topological-ish sort for a self-referencing table (roots first). */
function sortByParentDepth(rows: any[], idKey: string, parentKey: string): any[] {
  const byId = new Map<number, any>();
  for (const r of rows) byId.set(r[idKey], r);
  const depthCache = new Map<number, number>();
  function depth(r: any, seen = new Set<number>()): number {
    const id = r[idKey];
    if (depthCache.has(id)) return depthCache.get(id)!;
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const parentId = r[parentKey];
    const parent = parentId != null ? byId.get(parentId) : null;
    const d = parent ? depth(parent, seen) + 1 : 0;
    depthCache.set(id, d);
    return d;
  }
  return [...rows].sort((a, b) => depth(a) - depth(b));
}

export default router;
