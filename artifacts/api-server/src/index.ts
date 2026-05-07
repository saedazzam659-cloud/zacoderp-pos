import http from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { ensureSchemaUpToDate } from "./lib/ensureSchema";
import { attachCobrowseHub } from "./lib/cobrowseHub";
import { db } from "@workspace/db";
import { usersTable, planConfigsTable, subscriptionsTable, companiesTable, systemSettingsTable, auditLogTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

const AUTO_SUSPEND_KEY = "auto_suspend_expired";
const AUTO_SUSPEND_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_SUSPEND_INITIAL_DELAY_MS = 30 * 1000;

interface ExpiredCompanyRow {
  company_id: number | string;
  end_date: string;
  prev_status: string | null;
}

async function runAutoSuspendOnce() {
  try {
    const [flag] = await db.select().from(systemSettingsTable)
      .where(eq(systemSettingsTable.key, AUTO_SUSPEND_KEY));
    if (flag?.value !== "on") return;

    const result = await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (company_id)
               company_id, end_date
          FROM subscriptions
         ORDER BY company_id, end_date DESC, id DESC
      )
      SELECT l.company_id, l.end_date, c.status AS prev_status
        FROM latest l
        JOIN companies c ON c.id = l.company_id
       WHERE l.end_date::date < CURRENT_DATE
         AND c.status <> 'suspended'
    `);
    const rowsValue = (result as { rows?: unknown }).rows ?? result;
    const candidates = (Array.isArray(rowsValue) ? rowsValue : []) as ExpiredCompanyRow[];
    if (candidates.length === 0) return;

    const cids = candidates.map(c => Number(c.company_id));
    await db.update(companiesTable).set({ status: "suspended" }).where(inArray(companiesTable.id, cids));

    for (const c of candidates) {
      try {
        await db.insert(auditLogTable).values({
          userId: null,
          username: "system",
          role: "system",
          companyId: Number(c.company_id),
          module: "subscriptions",
          action: "edit",
          entityType: "company",
          entityId: String(c.company_id),
          metadata: { op: "auto-suspend", reason: "subscription expired", endDate: c.end_date, previousStatus: c.prev_status },
        });
      } catch { /* never break the job on audit failure */ }
    }
    logger.info({ count: candidates.length }, "auto-suspend: companies suspended due to expired subscription");
  } catch (err) {
    logger.error({ err }, "auto-suspend job failed");
  }
}

function startAutoSuspendScheduler() {
  setTimeout(() => {
    void runAutoSuspendOnce();
    setInterval(() => { void runAutoSuspendOnce(); }, AUTO_SUSPEND_INTERVAL_MS);
  }, AUTO_SUSPEND_INITIAL_DELAY_MS);
}

async function seedSuperAdmin() {
  try {
    const [existing] = await db.select().from(usersTable).where(eq(usersTable.role, "superadmin"));
    if (!existing) {
      const passwordHash = await bcrypt.hash("SuperAdmin@2026", 12);
      await db.insert(usersTable).values({
        username: "superadmin",
        email: null,
        passwordHash,
        companyId: null,
        role: "superadmin",
        isActive: true,
      });
      logger.info("Superadmin created successfully");
    }

    if (process.env.BOOTSTRAP_SA_RESET === "1" || process.env.BOOTSTRAP_SA_RESET === "true") {
      const newPassword = process.env.BOOTSTRAP_SA_PASSWORD;
      const newEmail = process.env.BOOTSTRAP_SA_EMAIL;
      if (!newPassword) {
        logger.warn("[BOOTSTRAP_SA_RESET] enabled but BOOTSTRAP_SA_PASSWORD missing; aborting reset (no side effects). Either set BOOTSTRAP_SA_PASSWORD or remove BOOTSTRAP_SA_RESET.");
      } else {
        const passwordHash = await bcrypt.hash(newPassword, 12);
        const updates: Record<string, unknown> = { passwordHash, updatedAt: new Date() };
        if (newEmail) updates.email = newEmail;
        await db.update(usersTable).set(updates).where(eq(usersTable.role, "superadmin"));
        logger.warn({ emailUpdated: !!newEmail }, "[BOOTSTRAP_SA_RESET] SuperAdmin password reset (and email if provided).");
        try {
          const { superAdminLoginAttemptsTable } = await import("@workspace/db");
          await db.delete(superAdminLoginAttemptsTable);
          logger.warn("[BOOTSTRAP_SA_RESET] Cleared SuperAdmin login attempts (risk-score history). REMOVE BOOTSTRAP_SA_RESET env var now to avoid repeated resets.");
        } catch (clearErr) {
          logger.error({ err: clearErr }, "[BOOTSTRAP_SA_RESET] Failed to clear login attempts");
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to seed superadmin");
  }
}

async function seedIndustries() {
  try {
    const { industriesTable } = await import("@workspace/db");
    const { DEFAULT_INDUSTRIES } = await import("./routes/adminIndustries.js");
    // Idempotent insert: if two instances boot concurrently they would
    // otherwise race past the "is empty?" check and both attempt the same
    // insert, hitting the unique-on-code constraint. ON CONFLICT DO NOTHING
    // makes this safe regardless of how many nodes run it in parallel and
    // also preserves any operator edits to existing rows.
    const result = await db.insert(industriesTable)
      .values(DEFAULT_INDUSTRIES)
      .onConflictDoNothing({ target: industriesTable.code })
      .returning({ code: industriesTable.code });
    if (result.length > 0) {
      logger.info({ inserted: result.length }, "Default industries seeded");
    }
    // After seeding (or for an existing DB that was seeded with the older
    // high-level module-key shape), upgrade any rows whose
    // recommendedModuleKeys still hold legacy module keys ("inventory",
    // "sales", …) to the new GRANULAR menu-permission keys
    // ("inventory_mobile", "sales_module", "customers", …). This is what
    // makes the registration handler able to OR them straight into the
    // new company's menuPermissions JSON.
    await migrateIndustriesToMenuKeys();
  } catch (err) {
    logger.error({ err }, "Failed to seed industries");
  }
}

// One-time (idempotent) migration: convert legacy high-level module keys
// stored in `industries.recommendedModuleKeys` to the granular menu-
// permission keys used by the new SuperAdmin picker. Detection is
// stateless — a row is considered "legacy" iff it contains any key
// from LEGACY_KEY_EXPANSIONS. Already-migrated rows are skipped.
async function migrateIndustriesToMenuKeys() {
  try {
    const { industriesTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const { DEFAULT_INDUSTRIES } = await import("./routes/adminIndustries.js");

    // Each legacy high-level module key expands to the granular menu
    // permission keys it used to imply. Non-listed keys (already
    // granular, like "production" / "contracting" / "pos") pass through
    // unchanged. Mirrors PERMISSION_TO_MODULE in lib/menuItems.ts in
    // reverse + the always-on core (dashboard / invoices / customers).
    const LEGACY_KEY_EXPANSIONS: Record<string, string[]> = {
      inventory:   ["inventory_mobile", "inventory_reports"],
      sales:       ["sales_module", "sales_reports", "customers"],
      purchasing:  ["purchases_module", "purchases_reports", "suppliers"],
      cash:        ["cash_module", "cash_reports"],
      accounting:  ["accounts", "accounting_reports"],
      hr:          ["hr_module"],
      zatca:       ["zatca", "reports"],
      security:    ["security_events"],
    };
    const ALWAYS_ON_CORE = ["dashboard", "invoices", "customers"];
    const LEGACY_KEYS = new Set(Object.keys(LEGACY_KEY_EXPANSIONS));

    // For the 5 built-in default codes we have a curated, up-to-date
    // recommended set in DEFAULT_INDUSTRIES — prefer that over the
    // mechanical expansion so a row migrated today picks up any new
    // permission keys that were added to the spec since (e.g. cash_*
    // was added to "commercial" after the original v1 seed shipped).
    // Custom operator-created industries never match a default code, so
    // they always go through the safe per-key expansion path below.
    const DEFAULTS_BY_CODE = new Map(DEFAULT_INDUSTRIES.map(d => [d.code, d.recommendedModuleKeys ?? []]));

    const rows = await db.select({
      id:   industriesTable.id,
      code: industriesTable.code,
      keys: industriesTable.recommendedModuleKeys,
    }).from(industriesTable);

    let migrated = 0;
    for (const r of rows) {
      const keys = (r.keys ?? []) as string[];
      const hasLegacy = keys.some(k => LEGACY_KEYS.has(k));
      if (!hasLegacy) continue;            // already granular → skip

      // Build the migrated set in TWO non-destructive layers so an
      // operator who customized a default code (added a custom granular
      // key) doesn't lose their edit:
      //   1. Always start by mechanically expanding legacy keys + keeping
      //      every existing granular key + the always-on core. This
      //      preserves 100% of any edits the operator made.
      //   2. For known default codes, ALSO union the latest curated set
      //      from DEFAULT_INDUSTRIES so newly-added recommended keys
      //      (e.g. cash_* added to "commercial" post-v1) are picked up.
      // Result: union of (operator's expanded edits, curated defaults).
      const merged = new Set<string>(ALWAYS_ON_CORE);
      for (const k of keys) {
        if (LEGACY_KEYS.has(k)) {
          for (const nk of LEGACY_KEY_EXPANSIONS[k]) merged.add(nk);
        } else {
          merged.add(k);          // already-granular operator addition
        }
      }
      const curated = DEFAULTS_BY_CODE.get(r.code);
      if (curated && curated.length > 0) {
        for (const k of curated) merged.add(k);
      }
      const nextKeys = Array.from(merged);

      await db.update(industriesTable)
        .set({ recommendedModuleKeys: nextKeys, updatedAt: new Date() })
        .where(eq(industriesTable.id, r.id));
      migrated++;
    }
    if (migrated > 0) {
      logger.info({ migrated }, "Migrated industries to granular menu-permission keys");
    }
  } catch (err) {
    logger.error({ err }, "Failed to migrate industries to menu keys");
  }
}

async function seedPlanConfigs() {
  try {
    const existing = await db.select().from(planConfigsTable);
    if (existing.length === 0) {
      // Per-plan `includedModulesCount` mirrors the legacy static
      // PLAN_INCLUDED map (starter:2, pro:5, ent:100). Without these the
      // schema default of 0 would mean every selected module gets billed
      // on a freshly-seeded environment, breaking the "free with plan"
      // story shown to users in the registration wizard.
      const defaults = [
        {
          key: "starter",
          nameAr: "مبتدئ",
          nameEn: "Starter",
          monthlyPrice: "99",
          annualPrice: "990",
          maxUsers: 1,
          maxInvoices: 50,
          includedModulesCount: 2,
          features: JSON.stringify(["مستخدم واحد", "50 فاتورة شهرياً", "فواتير ضريبية ومبسطة", "دعم بريد إلكتروني"]),
          isRecommended: false,
          isActive: true,
          sortOrder: 1,
        },
        {
          key: "professional",
          nameAr: "احترافي",
          nameEn: "Professional",
          monthlyPrice: "299",
          annualPrice: "2990",
          maxUsers: 5,
          maxInvoices: 500,
          includedModulesCount: 5,
          features: JSON.stringify(["5 مستخدمين", "500 فاتورة شهرياً", "تقارير متقدمة", "API مفتوح", "دعم أولوية"]),
          isRecommended: true,
          isActive: true,
          sortOrder: 2,
        },
        {
          key: "enterprise",
          nameAr: "مؤسسي",
          nameEn: "Enterprise",
          monthlyPrice: "899",
          annualPrice: "8990",
          maxUsers: 999,
          maxInvoices: 999999,
          includedModulesCount: 100,
          features: JSON.stringify(["مستخدمون غير محدودين", "فواتير غير محدودة", "تقارير مخصصة", "SLA 99.9%", "مدير حساب مخصص"]),
          isRecommended: false,
          isActive: true,
          sortOrder: 3,
        },
      ];
      await db.insert(planConfigsTable).values(defaults);
      logger.info("Default plan configs seeded");
    }
  } catch (err) {
    logger.error({ err }, "Failed to seed plan configs");
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function bootstrap() {
  try {
    await ensureSchemaUpToDate();
  } catch (err) {
    logger.error({ err }, "Failed to ensure schema is up to date — server will continue but auth may fail");
  }

  // Eagerly read DB-stored SMTP config so `emailConfigured()` (sync) reflects
  // it from the very first request. Failures are swallowed; env-only path
  // still works.
  try {
    const { warmEmailConfig } = await import("./lib/email");
    await warmEmailConfig();
  } catch (err) {
    logger.warn({ err }, "warmEmailConfig failed at startup");
  }

  const httpServer = http.createServer(app);
  // Attach the WebSocket signaling hub for the Co-browse feature. It hooks
  // into the http upgrade event for path "/api/cobrowse/ws".
  attachCobrowseHub(httpServer);

  httpServer.listen(port, (err?: Error) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    seedSuperAdmin();
    seedPlanConfigs();
    seedIndustries();
    // Start automatic-backup scheduler (checks every 15 min; creates snapshot per
    // company on its configured frequency).
    import("./routes/backup.js").then(m => m.startBackupScheduler?.()).catch(() => {});
    // Auto-suspend expired subscriptions (only when superadmin enables the flag).
    startAutoSuspendScheduler();
    // Weekly/monthly digest of cross-company reports for the SuperAdmin (opt-in).
    import("./lib/reportScheduler.js").then(m => m.startReportDigestScheduler?.()).catch(() => {});
    // Daily maintenance scan across active companies (default 03:00 KSA).
    import("./lib/maintenanceScheduler.js").then(m => m.startMaintenanceScheduler?.()).catch(() => {});
  });
}

bootstrap();
