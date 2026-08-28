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
import { sendEmail, emailConfigured } from "../lib/email.js";
import {
  whatsappConfigured, normalizeWhatsappPhone,
  sendWhatsappOtp, sendWhatsappBackupNotice,
} from "../lib/whatsapp.js";
import { randomInt, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  buildFullCompanyBackup,
  restoreFullCompanyBackup,
  REQUIRED_FULL_COMPANY_TABLES,
} from "../lib/fullCompanyBackup.js";
import {
  MAX_PACKAGE_MANIFEST_BYTES,
  MAX_PACKAGE_TOTAL_BYTES,
  buildPortableBackupPackage,
  createPortablePackageUploadKey,
  restorePortableBackupPackage,
} from "../lib/companyBackupPackage.js";
import { ObjectStorageService } from "../lib/objectStorage.js";

/* ─── Auto-backup schedule + email helpers ──────────────────────────────────
 * The flexible schedule stores a (value, unit) pair; we normalise it to
 * minutes so a single scheduler tick can compare against elapsed time no
 * matter which unit the operator picked. A month is treated as 30 days — the
 * granularity users expect for "monthly" backups without a calendar library.
 * ─────────────────────────────────────────────────────────────────────────── */
// Accept both the plural forms the UI sends (minutes/hours/…) and the legacy
// singular forms, so the value round-trips: what the client stores is what it
// reads back to re-populate the picker. month ≈ 30 days.
const UNIT_MINUTES: Record<string, number> = {
  minute: 1,        minutes: 1,
  hour: 60,         hours: 60,
  day: 60 * 24,     days: 60 * 24,
  week: 60 * 24 * 7, weeks: 60 * 24 * 7,
  month: 60 * 24 * 30, months: 60 * 24 * 30,
};
const BACKUP_UNITS = Object.keys(UNIT_MINUTES);

/** Effective interval in minutes. Prefers (value, unit); falls back to frequencyHours. */
function effectiveIntervalMinutes(
  value: number | null | undefined,
  unit: string | null | undefined,
  frequencyHours: number | null | undefined,
): number {
  if (value && value > 0 && unit && UNIT_MINUTES[unit]) {
    return Math.max(1, Math.floor(value) * UNIT_MINUTES[unit]);
  }
  return Math.max(1, (frequencyHours ?? 24) * 60);
}

const OTP_TTL_MS = 10 * 60_000;      // verification code validity
const OTP_MAX_ATTEMPTS = 5;          // wrong-code attempts before the code is burnt
const OTP_RESEND_COOLDOWN_MS = 60_000; // min gap between OTP sends (anti-flood)
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const newOtp = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// ─── Signed, time-limited download links (for the WhatsApp destination) ──────
// A WhatsApp recipient clicking a link on their phone has NO app session, so
// the auth-guarded /auto/:id/download can't serve them. Instead we mint an
// HMAC-signed link (keyed off SESSION_SECRET) that a PUBLIC route validates.
// The signature IS the authorization — no login required, valid until expiry.
const SIGNED_DL_TTL_MS = Number(process.env.WHATSAPP_LINK_TTL_HOURS) > 0
  ? Number(process.env.WHATSAPP_LINK_TTL_HOURS) * 3_600_000
  : 7 * 24 * 3_600_000; // default 7 days

function signBackupDownload(id: number, expMs: number): string {
  const sig = createHmac("sha256", process.env.SESSION_SECRET || "")
    .update(`bkp.${id}.${expMs}`).digest("base64url");
  return `${expMs}.${sig}`;
}
function verifyBackupDownload(id: number, token: string): boolean {
  const [expStr, sig = ""] = String(token).split(".");
  const expMs = Number(expStr);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  const expected = createHmac("sha256", process.env.SESSION_SECRET || "")
    .update(`bkp.${id}.${expMs}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function buildSignedDownloadUrl(id: number, baseUrl: string): string {
  const expMs = Date.now() + SIGNED_DL_TTL_MS;
  const token = signBackupDownload(id, expMs);
  return `${baseUrl.replace(/\/$/, "")}/api/backup/auto/${id}/signed-download?token=${encodeURIComponent(token)}`;
}

// Best-effort public origin: prefer the proxied request headers, else the first
// published domain. Used to build absolute links the scheduler (no req) can send.
function backupPublicBaseUrl(req?: any): string {
  if (req?.headers) {
    const proto = ((req.headers["x-forwarded-proto"] as string) || "https").split(",")[0].trim();
    const host = ((req.headers["x-forwarded-host"] as string) || (req.headers.host as string) || "");
    if (host) return `${proto}://${host}`;
  }
  const domains = (process.env.REPLIT_DOMAINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (domains.length) return `https://${domains[0]}`;
  return "";
}

/**
 * If the company has a VERIFIED backup email AND email delivery is enabled,
 * send the freshly-built snapshot as a JSON attachment. Best-effort: never
 * throws so a mail outage can't abort the snapshot itself. Returns whether a
 * message was actually dispatched.
 */
async function deliverSnapshotEmail(
  companyId: number,
  companyName: string | null,
  toEmail: string,
  payload: any,
): Promise<boolean> {
  try {
    if (!emailConfigured()) return false;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filename = `backup-company-${companyId}-${stamp}.json`;
    const json = JSON.stringify(payload, null, 2);
    const countsList = Object.entries(payload?.counts ?? {})
      .filter(([, n]) => (n as number) > 0)
      .map(([k, n]) => `<li>${k}: <b>${n as number}</b></li>`)
      .join("");
    const body = `
      <p>مرفق بهذه الرسالة أحدث نسخة احتياطية لبيانات شركة <strong>${companyName ?? companyId}</strong>.</p>
      <p>تاريخ النسخة: <strong>${new Date().toLocaleString("ar-EG")}</strong></p>
      ${countsList ? `<p>محتويات النسخة:</p><ul style="line-height:1.9;">${countsList}</ul>` : ""}
      <p style="color:#64748b; font-size:12px;">احتفظ بهذا الملف في مكان آمن — يمكن استعادته من تبويب النسخ الاحتياطية داخل النظام.</p>`;
    const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;color:#334155;line-height:1.7;">${body}</div>`;
    const r = await sendEmail({
      to: toEmail,
      subject: `النسخة الاحتياطية — ${companyName ?? `شركة #${companyId}`} — ${stamp}`,
      html,
      attachments: [{ filename, content: json, contentType: "application/json; charset=utf-8" }],
      companyId,
    });
    if (!r.ok) console.error(`[auto-backup] email delivery failed for company ${companyId}: ${r.reason}`);
    return r.ok;
  } catch (e: any) {
    console.error(`[auto-backup] email delivery error for company ${companyId}:`, e?.message ?? e);
    return false;
  }
}

/** Gate on opt-in (enabled + verified) then deliver. Used by the scheduler/manual runs. */
async function maybeEmailSnapshot(companyId: number, payload: any): Promise<boolean> {
  const [c] = await db.select({
    name: companiesTable.nameAr,
    email: companiesTable.backupEmail,
    verified: companiesTable.backupEmailVerified,
    enabled: companiesTable.autoBackupEmailEnabled,
  }).from(companiesTable).where(eq(companiesTable.id, companyId));
  if (!c || !c.enabled || !c.verified || !c.email) return false;
  return deliverSnapshotEmail(companyId, c.name ?? null, c.email, payload);
}

/**
 * Send a WhatsApp text notification with a signed download link for a snapshot.
 * Best-effort: never throws so a WhatsApp outage can't abort the snapshot.
 */
async function deliverSnapshotWhatsapp(
  companyId: number,
  companyName: string | null,
  toPhone: string,
  payload: any,
  snapshotId: number,
  baseUrl: string,
): Promise<boolean> {
  try {
    if (!whatsappConfigured()) return false;
    if (!baseUrl) {
      console.error(`[auto-backup] no public base URL for whatsapp link (company ${companyId})`);
      return false;
    }
    const downloadUrl = buildSignedDownloadUrl(snapshotId, baseUrl);
    const countsSummary = Object.entries(payload?.counts ?? {})
      .filter(([, n]) => (n as number) > 0)
      .map(([k, n]) => `${k}: ${n as number}`)
      .join("، ") || "—";
    const dateStr = new Date().toLocaleString("ar-EG");
    const r = await sendWhatsappBackupNotice(toPhone, {
      companyName: companyName ?? `#${companyId}`,
      dateStr, countsSummary, downloadUrl,
    });
    if (!r.ok) console.error(`[auto-backup] whatsapp delivery failed for company ${companyId}: ${r.reason}`);
    return r.ok;
  } catch (e: any) {
    console.error(`[auto-backup] whatsapp delivery error for company ${companyId}:`, e?.message ?? e);
    return false;
  }
}

/** Gate on opt-in (enabled + verified) then deliver the WhatsApp notification. */
async function maybeWhatsappSnapshot(
  companyId: number, payload: any, snapshotId: number, baseUrl: string,
): Promise<boolean> {
  const [c] = await db.select({
    name: companiesTable.nameAr,
    phone: companiesTable.backupWhatsapp,
    verified: companiesTable.backupWhatsappVerified,
    enabled: companiesTable.autoBackupWhatsappEnabled,
  }).from(companiesTable).where(eq(companiesTable.id, companyId));
  if (!c || !c.enabled || !c.verified || !c.phone) return false;
  return deliverSnapshotWhatsapp(companyId, c.name ?? null, c.phone, payload, snapshotId, baseUrl);
}

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

/* ─── PUBLIC (pre-auth): GET /auto/:id/signed-download?token=… ──────────────
 * Streams one snapshot as a JSON file when the HMAC token validates. The
 * WhatsApp notification links here so the recipient can download from a phone
 * without an app login. Registered BEFORE extractAuth so it stays public. */
router.get("/auto/:id/signed-download", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const token = String(req.query.token ?? "");
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرف غير صالح" }); return; }
    if (!verifyBackupDownload(id, token)) { res.status(403).json({ error: "رابط غير صالح أو منتهي الصلاحية" }); return; }
    const [row] = await db.select().from(autoBackupsTable).where(eq(autoBackupsTable.id, id));
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="backup-company-${row.companyId}-${stamp}.json"`);
    res.send(JSON.stringify(row.data, null, 2));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

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

/* ─── GET /export ─── download a schema-v2 full-company JSON backup ───────── */
router.get("/export", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }

    const { payload } = await buildFullCompanyBackup(companyId, (req.authUser as any)?.username ?? null);
    res.json(payload);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── Portable v3 package: database + actual private object bytes ─────────── */
router.get("/export-portable", async (req, res) => {
  let cleanup: (() => Promise<void>) | undefined;
  let companyId: number | undefined;
  try {
    companyId = resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const built = await buildPortableBackupPackage(companyId, (req.authUser as any)?.username ?? null);
    cleanup = built.cleanup;
    const info = await stat(built.path);
    res.setHeader("Content-Type", "application/x-zacode-company-backup");
    res.setHeader("Content-Length", String(info.size));
    res.setHeader("Content-Disposition", `attachment; filename="${built.filename}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Backup-File-Count", String(built.summary.files));
    res.setHeader("X-Backup-File-Bytes", String(built.summary.bytes));
    res.setHeader("X-Backup-Skipped-External", String(built.summary.skippedExternal));
    await writeAudit({
      userId: req.authUser?.id ?? null,
      username: req.authUser?.username ?? null,
      companyId,
      module: "backups",
      action: "export",
      success: true,
      message: `تصدير حزمة شركة محمولة للشركة #${companyId}: ${built.summary.files} ملف`,
    });
    const stream = createReadStream(built.path);
    const done = () => { void cleanup?.(); cleanup = undefined; };
    stream.once("error", (error) => {
      done();
      if (!res.headersSent) res.status(500).json({ error: error.message });
      else res.destroy(error);
    });
    res.once("close", done);
    stream.pipe(res);
  } catch (e: any) {
    await cleanup?.().catch(() => {});
    if (companyId) {
      await writeAudit({
        userId: req.authUser?.id ?? null,
        username: req.authUser?.username ?? null,
        companyId,
        module: "backups",
        action: "export",
        success: false,
        message: `فشل تصدير حزمة الشركة #${companyId}: ${e?.message ?? "خطأ"}`,
      }).catch(() => {});
    }
    if (!res.headersSent) res.status(500).json({ error: e?.message ?? "فشل تصدير الحزمة" });
  }
});

router.post("/portable/upload-target", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body?.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const sizeBytes = Number(req.body?.sizeBytes);
    const maxUploadBytes = MAX_PACKAGE_TOTAL_BYTES + MAX_PACKAGE_MANIFEST_BYTES + 1024 * 1024;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > maxUploadBytes) {
      res.status(400).json({ error: "حجم حزمة النسخة غير صالح أو يتجاوز الحد المسموح" });
      return;
    }
    const service = new ObjectStorageService();
    const target = await service.getPrivateUploadTarget(createPortablePackageUploadKey(companyId), {
      sizeBytes,
      origin: req.get("origin"),
    });
    res.json(target);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "تعذر تجهيز رفع الحزمة" });
  }
});

router.post("/portable/restore", async (req, res) => {
  let companyId: number | undefined;
  try {
    companyId = resolveCompanyId(req, req.body?.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    if (typeof req.body?.objectPath !== "string") {
      res.status(400).json({ error: "مسار حزمة النسخة مطلوب" });
      return;
    }
    const out = await restorePortableBackupPackage(companyId, req.body.objectPath);
    await writeAudit({
      userId: req.authUser?.id ?? null,
      username: req.authUser?.username ?? null,
      companyId,
      module: "backups",
      action: "restore",
      success: true,
      message: `استعادة حزمة شركة محمولة للشركة #${companyId}: ${out.files.copied} ملف`,
    });
    res.json({ ok: true, companyId, restoreMode: "full_company_v3_portable", ...out });
  } catch (e: any) {
    if (companyId) {
      await writeAudit({
        userId: req.authUser?.id ?? null,
        username: req.authUser?.username ?? null,
        companyId,
        module: "backups",
        action: "restore",
        success: false,
        message: `فشل استعادة حزمة الشركة #${companyId}: ${e?.message ?? "خطأ"}`,
      }).catch(() => {});
    }
    res.status(400).json({ error: e?.message ?? "فشل استعادة الحزمة" });
  }
});

/* ─── POST /ai-analyze ─── AI natural-language summary of an uploaded backup  */
router.post("/ai-analyze", requireAiFeature("report_analyzer"), async (req, res) => {
  try {
    const payload = req.body?.backup;
    if (!payload || typeof payload !== "object" || !payload.data) {
      res.status(400).json({ error: "ملف نسخة احتياطية غير صالح" });
      return;
    }

    const counts: Record<string, number> = Object.fromEntries(Object.entries(payload.data)
      .map(([name, value]) => [name, Array.isArray(value) ? value.length : 0]));
    const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);

    const samples: Record<string, any> = {};
    for (const [name, tableRows] of Object.entries(payload.data)) {
      const first = Array.isArray(tableRows) ? tableRows[0] : null;
      if (first) {
        const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = first;
        samples[name] = rest;
      }
    }

    const OPENAI_BASE = "AI_PROXY";
    const OPENAI_KEY  = "AI_PROXY";

    const coreLabels: Record<string, string> = {
      accounts: "الحسابات",
      journal_entries: "القيود المحاسبية",
      sales_invoices: "فواتير المبيعات",
      purchase_invoices: "فواتير المشتريات",
      employees: "الموظفون",
      cash_boxes: "الخزن النقدية",
      bank_accounts: "الحسابات البنكية",
    };
    const deterministicSummary = () => {
      const parts = REQUIRED_FULL_COMPANY_TABLES.map((name) =>
        Object.prototype.hasOwnProperty.call(counts, name)
          ? `• ${coreLabels[name] ?? name}: ${counts[name]}`
          : `• ${coreLabels[name] ?? name}: غير موجود في الملف`,
      );
      return `نسخة احتياطية تحتوي فعليًا على ${totalRows} سجلاً في جميع الجداول.\n${parts.join("\n")}`;
    };
    const missingCoreTables = REQUIRED_FULL_COMPANY_TABLES
      .filter((name) => !Object.prototype.hasOwnProperty.call(counts, name));

    if (!isAIAvailable()) {
      res.json({
        summary: deterministicSummary(),
        warnings: missingCoreTables.length
          ? [`الملف لا يحتوي جداول أساسية: ${missingCoreTables.join(", ")}`]
          : [],
        counts,
      });
      return;
    }

    const tableList = Object.entries(counts).map(([name, count]) => `- ${name}: ${count} سجل`).join("\n");
    const prompt = `هذه نسخة احتياطية من نظام فاتورة إلكترونية سعودي (ZATCA).
معلومات النسخة:
- شركة رقم: ${payload.meta?.companyId ?? "?"}
- تاريخ التصدير: ${payload.meta?.exportedAt ?? "?"}
- إصدار التخطيط: ${payload.meta?.schemaVersion ?? "?"}

جداول النسخة الكاملة:
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
      res.json({
        summary: deterministicSummary(),
        warnings: [
          ...(missingCoreTables.length ? [`الملف لا يحتوي جداول أساسية: ${missingCoreTables.join(", ")}`] : []),
          e?.name === "AbortError" ? "انتهت مهلة الذكاء الاصطناعي" : "تعذّر الاتصال بالذكاء الاصطناعي",
        ],
        counts,
      });
      return;
    }
    clearTimeout(timer);

    if (!aiRes.ok) {
      res.json({
        summary: deterministicSummary(),
        warnings: missingCoreTables.length
          ? [`الملف لا يحتوي جداول أساسية: ${missingCoreTables.join(", ")}`]
          : [],
        counts,
      });
      return;
    }

    const data = await aiRes.json() as any;
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(content); } catch {}

    res.json({
      // Counts are authoritative and must never be summarized/calculated by
      // the model. AI contributes warnings only.
      summary: deterministicSummary(),
      warnings: [
        ...(missingCoreTables.length ? [`الملف لا يحتوي جداول أساسية: ${missingCoreTables.join(", ")}`] : []),
        ...(Array.isArray(parsed.warnings)
          ? parsed.warnings.slice(0, 10).map((w: any) => String(w).slice(0, 300))
          : []),
      ],
      counts,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── POST /restore ───────────────────────────────────────────────────────────
 * Schema v1 restore is idempotent and non-destructive:
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
  restoreMode: "full_company_v2" | "legacy_limited";
  report: Record<string, { received: number; inserted: number; matched: number; failed: number }>;
}> {
  if (!payload || typeof payload !== "object" || !payload.data) {
    throw new Error("ملف نسخة احتياطية غير صالح");
  }
  if ((payload as any).meta?.schemaVersion === 2) {
    const report = await restoreFullCompanyBackup(companyId, payload as any);
    return { ok: true, companyId, restoreMode: "full_company_v2", report: report as any };
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

  return { ok: true, companyId, restoreMode: "legacy_limited", report };
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
  return buildFullCompanyBackup(companyId, "scheduler");
}

/** Write a snapshot row and enforce per-company retention. */
export async function persistSnapshot(
  companyId: number,
  reason: "scheduled" | "manual",
  deliverCloud = false,
  baseUrl = "",
): Promise<number> {
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

  // Deliver to the cloud destinations (email + WhatsApp) when the caller asked
  // for it and the company opted in. Best-effort — a delivery failure never
  // fails the backup. WhatsApp needs the persisted snapshot id for its link.
  if (deliverCloud) {
    await maybeEmailSnapshot(companyId, payload).catch(() => {});
    await maybeWhatsappSnapshot(companyId, payload, row.id, baseUrl || backupPublicBaseUrl()).catch(() => {});
  }

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
      intervalValue: companiesTable.autoBackupIntervalValue,
      intervalUnit: companiesTable.autoBackupIntervalUnit,
      backupEmail: companiesTable.backupEmail,
      backupEmailVerified: companiesTable.backupEmailVerified,
      autoBackupEmailEnabled: companiesTable.autoBackupEmailEnabled,
      backupEmailPending: companiesTable.backupEmailPending,
      backupWhatsapp: companiesTable.backupWhatsapp,
      backupWhatsappVerified: companiesTable.backupWhatsappVerified,
      autoBackupWhatsappEnabled: companiesTable.autoBackupWhatsappEnabled,
      backupWhatsappPending: companiesTable.backupWhatsappPending,
    }).from(companiesTable).where(eq(companiesTable.id, companyId));

    // Surface whether each transport is configured so the UI can warn the
    // operator that a destination won't deliver until the server is set up.
    const settings = company
      ? { ...company, emailTransportReady: emailConfigured(), whatsappTransportReady: whatsappConfigured() }
      : null;

    if (isCrossTenantSuperadmin(req)) {
      await writeAudit({
        userId: req.authUser?.id ?? null,
        username: req.authUser?.username ?? null,
        companyId, module: "backups", action: "view",
        success: true, message: `عرض سجل النسخ للشركة #${companyId}`,
      });
    }

    res.json({ settings, snapshots: rows });
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
    // Flexible schedule: (value, unit). When a valid pair is supplied we store
    // it AND keep autoBackupFrequencyHours roughly in sync (min 1h) so any
    // legacy reader still behaves sanely; the scheduler prefers (value, unit).
    if (req.body.intervalUnit !== undefined || req.body.intervalValue !== undefined) {
      const unit = String(req.body.intervalUnit ?? "");
      const rawVal = Number(req.body.intervalValue);
      if (!BACKUP_UNITS.includes(unit)) { res.status(400).json({ error: "وحدة زمنية غير صالحة" }); return; }
      if (!Number.isFinite(rawVal) || rawVal < 1) { res.status(400).json({ error: "قيمة الفترة غير صالحة" }); return; }
      const value = Math.max(1, Math.min(999, Math.floor(rawVal)));
      patch.autoBackupIntervalValue = value;
      patch.autoBackupIntervalUnit = unit;
      const mins = effectiveIntervalMinutes(value, unit, null);
      patch.autoBackupFrequencyHours = Math.max(1, Math.min(168, Math.round(mins / 60)));
    }
    if (typeof req.body.autoBackupEmailEnabled === "boolean") {
      // Only allow enabling email delivery once the address is verified.
      if (req.body.autoBackupEmailEnabled) {
        const [c] = await db.select({ verified: companiesTable.backupEmailVerified })
          .from(companiesTable).where(eq(companiesTable.id, companyId));
        if (!c?.verified) { res.status(400).json({ error: "يجب توثيق البريد الإلكتروني أولاً" }); return; }
      }
      patch.autoBackupEmailEnabled = req.body.autoBackupEmailEnabled;
    }
    if (typeof req.body.autoBackupWhatsappEnabled === "boolean") {
      // Only allow enabling WhatsApp delivery once the number is verified.
      if (req.body.autoBackupWhatsappEnabled) {
        const [c] = await db.select({ verified: companiesTable.backupWhatsappVerified })
          .from(companiesTable).where(eq(companiesTable.id, companyId));
        if (!c?.verified) { res.status(400).json({ error: "يجب توثيق رقم الواتساب أولاً" }); return; }
      }
      patch.autoBackupWhatsappEnabled = req.body.autoBackupWhatsappEnabled;
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

/* ═════════════════════════════════════════════════════════════════════════
 * Email (cloud) destination — secure linking via OTP verification
 * An address never becomes an active destination until a one-time code sent to
 * that inbox is confirmed, proving the operator controls the mailbox.
 * ═════════════════════════════════════════════════════════════════════════ */

/* ─── POST /email/request ─── send an OTP to the address to be linked ──────── */
router.post("/email/request", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const email = String(req.body.email ?? "").trim().toLowerCase();
    if (!isValidEmail(email)) { res.status(400).json({ error: "بريد إلكتروني غير صالح" }); return; }
    if (!emailConfigured()) { res.status(503).json({ error: "خدمة البريد غير مهيأة على الخادم" }); return; }

    // Anti-flood: refuse a resend within the cooldown window. lastSent is derived
    // from the pending code's expiry (expiresAt = sentAt + OTP_TTL_MS).
    const [prev] = await db.select({ expiresAt: companiesTable.backupEmailOtpExpiresAt })
      .from(companiesTable).where(eq(companiesTable.id, companyId));
    if (prev?.expiresAt) {
      const lastSentMs = new Date(prev.expiresAt).getTime() - OTP_TTL_MS;
      const waitMs = OTP_RESEND_COOLDOWN_MS - (Date.now() - lastSentMs);
      if (waitMs > 0) {
        res.status(429).json({ error: "يرجى الانتظار قبل طلب رمز جديد", retryAfterSec: Math.ceil(waitMs / 1000) });
        return;
      }
    }

    const code = newOtp();
    await db.update(companiesTable).set({
      backupEmailPending: email,
      backupEmailOtpHash: sha256(code),
      backupEmailOtpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
      backupEmailOtpAttempts: 0,
    }).where(eq(companiesTable.id, companyId));

    const body = `
      <p>رمز توثيق البريد الإلكتروني لاستقبال النسخ الاحتياطية:</p>
      <p style="font-size:34px;font-weight:bold;letter-spacing:6px;text-align:center;background:#ecfdf5;color:#065f46;padding:14px;border-radius:8px;margin:12px 0;">${code}</p>
      <p>صالح لمدة <strong>10 دقائق</strong>. أدخله في الشاشة لإتمام ربط البريد.</p>
      <p style="color:#94a3b8;font-size:12px;">إذا لم تطلب هذا الرمز، تجاهل الرسالة.</p>`;
    const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;color:#334155;line-height:1.7;">${body}</div>`;
    const r = await sendEmail({ to: email, subject: "رمز توثيق البريد — النسخ الاحتياطية", html, companyId });
    if (!r.ok) { res.status(502).json({ error: "تعذّر إرسال رمز التحقق، تحقق من إعدادات البريد" }); return; }

    await writeAudit({
      userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null,
      companyId, module: "backups", action: "edit",
      success: true, message: `طلب توثيق بريد النسخ الاحتياطية للشركة #${companyId}`,
    });
    res.json({ ok: true, expiresInSec: OTP_TTL_MS / 1000 });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── POST /email/verify ─── confirm the OTP → activate the address ────────── */
router.post("/email/verify", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const code = String(req.body.code ?? "").trim();
    if (!/^\d{6}$/.test(code)) { res.status(400).json({ error: "رمز غير صالح" }); return; }

    const [c] = await db.select({
      pending: companiesTable.backupEmailPending,
      hash: companiesTable.backupEmailOtpHash,
      expiresAt: companiesTable.backupEmailOtpExpiresAt,
      attempts: companiesTable.backupEmailOtpAttempts,
    }).from(companiesTable).where(eq(companiesTable.id, companyId));

    if (!c?.pending || !c.hash || !c.expiresAt) { res.status(400).json({ error: "لا يوجد طلب توثيق نشط" }); return; }
    if (new Date(c.expiresAt).getTime() < Date.now()) { res.status(400).json({ error: "انتهت صلاحية الرمز، أعد الإرسال" }); return; }
    if ((c.attempts ?? 0) >= OTP_MAX_ATTEMPTS) { res.status(429).json({ error: "محاولات كثيرة، أعد إرسال رمز جديد" }); return; }

    if (sha256(code) !== c.hash) {
      await db.update(companiesTable)
        .set({ backupEmailOtpAttempts: (c.attempts ?? 0) + 1 })
        .where(eq(companiesTable.id, companyId));
      res.status(400).json({ error: "الرمز غير صحيح" });
      return;
    }

    await db.update(companiesTable).set({
      backupEmail: c.pending,
      backupEmailVerified: true,
      autoBackupEmailEnabled: true,        // linking implies wanting delivery
      backupEmailPending: null,
      backupEmailOtpHash: null,
      backupEmailOtpExpiresAt: null,
      backupEmailOtpAttempts: 0,
    }).where(eq(companiesTable.id, companyId));

    await writeAudit({
      userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null,
      companyId, module: "backups", action: "edit",
      success: true, message: `توثيق بريد النسخ الاحتياطية (${c.pending}) للشركة #${companyId}`,
    });
    res.json({ ok: true, email: c.pending });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── POST /email/disable ─── unlink the email destination ─────────────────── */
router.post("/email/disable", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    await db.update(companiesTable).set({
      backupEmail: null,
      backupEmailVerified: false,
      autoBackupEmailEnabled: false,
      backupEmailPending: null,
      backupEmailOtpHash: null,
      backupEmailOtpExpiresAt: null,
      backupEmailOtpAttempts: 0,
    }).where(eq(companiesTable.id, companyId));
    await writeAudit({
      userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null,
      companyId, module: "backups", action: "edit",
      success: true, message: `إلغاء ربط بريد النسخ الاحتياطية للشركة #${companyId}`,
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── POST /email/send-now ─── build a fresh snapshot and email it now ─────── */
router.post("/email/send-now", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const [c] = await db.select({
      email: companiesTable.backupEmail,
      verified: companiesTable.backupEmailVerified,
    }).from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!c?.verified || !c.email) { res.status(400).json({ error: "لا يوجد بريد موثّق" }); return; }
    if (!emailConfigured()) { res.status(503).json({ error: "خدمة البريد غير مهيأة على الخادم" }); return; }

    const [nameRow] = await db.select({ name: companiesTable.nameAr })
      .from(companiesTable).where(eq(companiesTable.id, companyId));
    const { payload } = await buildSnapshot(companyId);
    const sent = await deliverSnapshotEmail(companyId, nameRow?.name ?? null, c.email, payload);
    if (!sent) { res.status(502).json({ error: "تعذّر إرسال النسخة عبر البريد" }); return; }

    await writeAudit({
      userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null,
      companyId, module: "backups", action: "create",
      success: true, message: `إرسال نسخة احتياطية بالبريد للشركة #${companyId} (${c.email})`,
    });
    res.json({ ok: true, email: c.email });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═════════════════════════════════════════════════════════════════════════
 * WhatsApp (cloud) destination — secure linking via OTP verification, mirrors
 * the email flow. A number never becomes active until an OTP sent to it (via a
 * Meta-approved template) is confirmed. Delivery is a TEXT notification with a
 * signed, time-limited download link — the file itself is never attached.
 * ═════════════════════════════════════════════════════════════════════════ */

/* ─── POST /whatsapp/request ─── send an OTP to the number to be linked ─────── */
router.post("/whatsapp/request", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const phone = normalizeWhatsappPhone(String(req.body.phone ?? ""));
    if (!phone) { res.status(400).json({ error: "رقم واتساب غير صالح" }); return; }
    if (!whatsappConfigured()) { res.status(503).json({ error: "خدمة الواتساب غير مهيأة على الخادم" }); return; }

    // Anti-flood: refuse a resend within the cooldown window.
    const [prev] = await db.select({ expiresAt: companiesTable.backupWhatsappOtpExpiresAt })
      .from(companiesTable).where(eq(companiesTable.id, companyId));
    if (prev?.expiresAt) {
      const lastSentMs = new Date(prev.expiresAt).getTime() - OTP_TTL_MS;
      const waitMs = OTP_RESEND_COOLDOWN_MS - (Date.now() - lastSentMs);
      if (waitMs > 0) {
        res.status(429).json({ error: "يرجى الانتظار قبل طلب رمز جديد", retryAfterSec: Math.ceil(waitMs / 1000) });
        return;
      }
    }

    const code = newOtp();
    await db.update(companiesTable).set({
      backupWhatsappPending: phone,
      backupWhatsappOtpHash: sha256(code),
      backupWhatsappOtpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
      backupWhatsappOtpAttempts: 0,
    }).where(eq(companiesTable.id, companyId));

    const r = await sendWhatsappOtp(phone, code);
    if (!r.ok) { res.status(502).json({ error: "تعذّر إرسال رمز التحقق عبر الواتساب" }); return; }

    await writeAudit({
      userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null,
      companyId, module: "backups", action: "edit",
      success: true, message: `طلب توثيق واتساب النسخ الاحتياطية للشركة #${companyId}`,
    });
    res.json({ ok: true, expiresInSec: OTP_TTL_MS / 1000 });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── POST /whatsapp/verify ─── confirm the OTP → activate the number ───────── */
router.post("/whatsapp/verify", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const code = String(req.body.code ?? "").trim();
    if (!/^\d{6}$/.test(code)) { res.status(400).json({ error: "رمز غير صالح" }); return; }

    const [c] = await db.select({
      pending: companiesTable.backupWhatsappPending,
      hash: companiesTable.backupWhatsappOtpHash,
      expiresAt: companiesTable.backupWhatsappOtpExpiresAt,
      attempts: companiesTable.backupWhatsappOtpAttempts,
    }).from(companiesTable).where(eq(companiesTable.id, companyId));

    if (!c?.pending || !c.hash || !c.expiresAt) { res.status(400).json({ error: "لا يوجد طلب توثيق نشط" }); return; }
    if (new Date(c.expiresAt).getTime() < Date.now()) { res.status(400).json({ error: "انتهت صلاحية الرمز، أعد الإرسال" }); return; }
    if ((c.attempts ?? 0) >= OTP_MAX_ATTEMPTS) { res.status(429).json({ error: "محاولات كثيرة، أعد إرسال رمز جديد" }); return; }

    if (sha256(code) !== c.hash) {
      await db.update(companiesTable)
        .set({ backupWhatsappOtpAttempts: (c.attempts ?? 0) + 1 })
        .where(eq(companiesTable.id, companyId));
      res.status(400).json({ error: "الرمز غير صحيح" });
      return;
    }

    await db.update(companiesTable).set({
      backupWhatsapp: c.pending,
      backupWhatsappVerified: true,
      autoBackupWhatsappEnabled: true,        // linking implies wanting delivery
      backupWhatsappPending: null,
      backupWhatsappOtpHash: null,
      backupWhatsappOtpExpiresAt: null,
      backupWhatsappOtpAttempts: 0,
    }).where(eq(companiesTable.id, companyId));

    await writeAudit({
      userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null,
      companyId, module: "backups", action: "edit",
      success: true, message: `توثيق واتساب النسخ الاحتياطية (${c.pending}) للشركة #${companyId}`,
    });
    res.json({ ok: true, phone: c.pending });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── POST /whatsapp/disable ─── unlink the WhatsApp destination ───────────── */
router.post("/whatsapp/disable", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    await db.update(companiesTable).set({
      backupWhatsapp: null,
      backupWhatsappVerified: false,
      autoBackupWhatsappEnabled: false,
      backupWhatsappPending: null,
      backupWhatsappOtpHash: null,
      backupWhatsappOtpExpiresAt: null,
      backupWhatsappOtpAttempts: 0,
    }).where(eq(companiesTable.id, companyId));
    await writeAudit({
      userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null,
      companyId, module: "backups", action: "edit",
      success: true, message: `إلغاء ربط واتساب النسخ الاحتياطية للشركة #${companyId}`,
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── POST /whatsapp/send-now ─── snapshot now + WhatsApp the download link ── */
router.post("/whatsapp/send-now", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, req.body.companyId ? Number(req.body.companyId) : undefined);
    if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const [c] = await db.select({
      name: companiesTable.nameAr,
      phone: companiesTable.backupWhatsapp,
      verified: companiesTable.backupWhatsappVerified,
    }).from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!c?.verified || !c.phone) { res.status(400).json({ error: "لا يوجد رقم واتساب موثّق" }); return; }
    if (!whatsappConfigured()) { res.status(503).json({ error: "خدمة الواتساب غير مهيأة على الخادم" }); return; }

    // WhatsApp links to a PERSISTED snapshot, so take one now and link to it.
    const id = await persistSnapshot(companyId, "manual");
    const [row] = await db.select({ data: autoBackupsTable.data }).from(autoBackupsTable).where(eq(autoBackupsTable.id, id));
    const sent = await deliverSnapshotWhatsapp(companyId, c.name ?? null, c.phone, row?.data, id, backupPublicBaseUrl(req));
    if (!sent) { res.status(502).json({ error: "تعذّر إرسال الإشعار عبر الواتساب" }); return; }

    await writeAudit({
      userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null,
      companyId, module: "backups", action: "create",
      success: true, message: `إرسال إشعار نسخة احتياطية بالواتساب للشركة #${companyId} (${c.phone})`,
    });
    res.json({ ok: true, phone: c.phone });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── Scheduler ───────────────────────────────────────────────────────────────
 * Runs every 15 minutes. For each company with autoBackupEnabled=true,
 * if (now - lastAutoBackupAt) >= frequencyHours, a new scheduled snapshot is
 * created. Runs guard-railed so one company's failure doesn't abort others.
 * ─────────────────────────────────────────────────────────────────────────── */
let schedulerStarted = false;
export function startBackupScheduler(intervalMs = 60_000) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Single-flight guard: a slow tick (many companies / large snapshots) must
  // never overlap the next 60s tick, or two runs read the same stale `lastAt`
  // and each write a duplicate snapshot for the same company.
  let tickInFlight = false;

  async function tick() {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const companies = await db.select({
        id: companiesTable.id,
        enabled: companiesTable.autoBackupEnabled,
        frequencyHours: companiesTable.autoBackupFrequencyHours,
        intervalValue: companiesTable.autoBackupIntervalValue,
        intervalUnit: companiesTable.autoBackupIntervalUnit,
        lastAt: companiesTable.lastAutoBackupAt,
      }).from(companiesTable);

      for (const c of companies) {
        if (!c.enabled) continue;
        // Effective cadence honours the flexible (value, unit) pair — down to a
        // one-minute granularity — falling back to the legacy hour cadence.
        const dueMs = effectiveIntervalMinutes(c.intervalValue, c.intervalUnit, c.frequencyHours) * 60_000;
        const lastMs = c.lastAt ? new Date(c.lastAt).getTime() : 0;
        if (Date.now() - lastMs < dueMs) continue;
        try {
          // deliverEmail=true → also push to the cloud (email) destination when
          // the company has a verified address and delivery is enabled.
          await persistSnapshot(c.id, "scheduled", true);
          console.log(`[auto-backup] snapshot saved for company ${c.id}`);
        } catch (e: any) {
          console.error(`[auto-backup] failed for company ${c.id}:`, e.message);
        }
      }
    } catch (e: any) {
      console.error("[auto-backup] scheduler tick error:", e.message);
    } finally {
      tickInFlight = false;
    }
  }

  // Run soon after startup (5 s), then every `intervalMs` (default 1 min so
  // minute-granularity schedules fire on time).
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
