import { and, eq, sql } from "drizzle-orm";
import {
  accountsTable,
  contractingSettingsTable,
  db,
  getActiveExternalDb,
  type ContractingSettingsRow,
} from "@workspace/db";

export const DEFAULT_CONTRACTING_ADJUSTMENT_TYPES = [
  "advance_recovery",
  "retention",
  "material_deduction",
  "penalty",
  "addition",
  "other_deduction",
] as const;

export const DEFAULT_OVERRIDE_APPROVER_ROLES = ["admin", "user", "cashier"] as const;

export type ContractingAdjustmentType = typeof DEFAULT_CONTRACTING_ADJUSTMENT_TYPES[number] | "other_deduction";

export type ContractingSettingsPatch = {
  defaultAdvanceRecoveryEnabled?: boolean;
  defaultAdvanceRecoveryPercent?: number | string;
  defaultAdvanceRecoveryStartProgressPercent?: number | string;
  defaultRetentionEnabled?: boolean;
  defaultRetentionPercent?: number | string;
  defaultRetentionCapPercent?: number | string;
  adjustmentTypes?: unknown;
  adjustmentAccountMappings?: unknown;
  advanceRecoveryAccountId?: number | null;
  retentionAccountId?: number | null;
  materialDeductionAccountId?: number | null;
  penaltyAccountId?: number | null;
  additionAccountId?: number | null;
  otherDeductionAccountId?: number | null;
  overrideApprovalRequired?: boolean;
  overrideApproverRoles?: unknown;
};

type SettingsWithDefaults = ContractingSettingsRow & {
  defaultAdvanceRecoveryPercent: string;
  defaultAdvanceRecoveryStartProgressPercent: string;
  defaultRetentionPercent: string;
  defaultRetentionCapPercent: string;
};

// The schema healer runs against both the central database and many external
// agent databases. A process-global promise would bind the first successful
// DDL run to whichever database happened to initialize first, leaving every
// later database (including an agent being upgraded) without this table.
const centralDbScope = {};
const settingsTablePromises = new WeakMap<object, Promise<void>>();

/**
 * This table is an additive module extension and is intentionally healed
 * separately from the generic Drizzle column walker: older agent databases
 * may not have the table at all.
 */
export function ensureContractingSettingsTable(): Promise<void> {
  const scope = getActiveExternalDb() ?? centralDbScope;
  const existing = settingsTablePromises.get(scope);
  if (existing) return existing;
  const promise = (async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS contracting_settings (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        default_advance_recovery_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        default_advance_recovery_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
        default_advance_recovery_start_progress_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
        default_retention_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        default_retention_percent NUMERIC(5,2) NOT NULL DEFAULT 5,
        default_retention_cap_percent NUMERIC(5,2) NOT NULL DEFAULT 100,
        adjustment_types JSONB NOT NULL DEFAULT
          '["advance_recovery","retention","material_deduction","penalty","addition","other_deduction"]'::jsonb,
        adjustment_account_mappings JSONB NOT NULL DEFAULT '{}'::jsonb,
        advance_recovery_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        retention_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        material_deduction_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        penalty_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        addition_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        other_deduction_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        override_approval_required BOOLEAN NOT NULL DEFAULT TRUE,
        override_approver_roles JSONB NOT NULL DEFAULT '["admin","user","cashier"]'::jsonb,
        updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT contracting_settings_company_uidx UNIQUE (company_id)
      )
    `);
    const ddl = [
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS default_advance_recovery_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS default_advance_recovery_percent NUMERIC(5,2) NOT NULL DEFAULT 0`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS default_advance_recovery_start_progress_percent NUMERIC(5,2) NOT NULL DEFAULT 0`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS default_retention_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS default_retention_percent NUMERIC(5,2) NOT NULL DEFAULT 5`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS default_retention_cap_percent NUMERIC(5,2) NOT NULL DEFAULT 100`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS adjustment_types JSONB NOT NULL DEFAULT '[\"advance_recovery\",\"retention\",\"material_deduction\",\"penalty\",\"addition\",\"other_deduction\"]'::jsonb`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS adjustment_account_mappings JSONB NOT NULL DEFAULT '{}'::jsonb`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS advance_recovery_account_id INTEGER`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS retention_account_id INTEGER`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS material_deduction_account_id INTEGER`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS penalty_account_id INTEGER`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS addition_account_id INTEGER`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS other_deduction_account_id INTEGER`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS override_approval_required BOOLEAN NOT NULL DEFAULT TRUE`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS override_approver_roles JSONB NOT NULL DEFAULT '[\"admin\",\"user\",\"cashier\"]'::jsonb`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()`,
      `ALTER TABLE contracting_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`,
      `CREATE UNIQUE INDEX IF NOT EXISTS contracting_settings_company_idx ON contracting_settings(company_id)`,
    ];
    for (const statement of ddl) await db.execute(sql.raw(statement));
  })();
  settingsTablePromises.set(scope, promise);
  // A failed DDL attempt must not poison retries for this database, while a
  // successful attempt remains single-flight within the same DB context.
  void promise.catch(() => {
    if (settingsTablePromises.get(scope) === promise) settingsTablePromises.delete(scope);
  });
  return promise;
}

function failure(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function percentage(value: unknown, label: string, fallback: string): string {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw failure(`${label} يجب أن يكون بين 0 و100`);
  }
  return parsed.toFixed(2);
}

function positiveAccountId(value: unknown, label: string): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw failure(`${label} غير صالح`);
  return parsed;
}

const TYPE_ALIASES: Record<string, ContractingAdjustmentType> = {
  advance: "advance_recovery",
  advance_recovery: "advance_recovery",
  retention: "retention",
  materials: "material_deduction",
  material: "material_deduction",
  material_deduction: "material_deduction",
  penalty: "penalty",
  penalties: "penalty",
  addition: "addition",
  additions: "addition",
  other: "other_deduction",
  other_deduction: "other_deduction",
};

export function normalizeContractingAdjustmentTypes(
  value: unknown,
  fallback: string[] = [...DEFAULT_CONTRACTING_ADJUSTMENT_TYPES],
): ContractingAdjustmentType[] {
  if (value === undefined) return [...fallback] as ContractingAdjustmentType[];
  if (!Array.isArray(value)) throw failure("أنواع التسويات يجب أن تكون قائمة");
  const result: ContractingAdjustmentType[] = [];
  for (const raw of value) {
    const key = TYPE_ALIASES[String(raw ?? "").trim().toLowerCase()];
    if (!key) throw failure(`نوع التسوية غير مدعوم: ${String(raw)}`);
    if (!result.includes(key)) result.push(key);
  }
  if (result.length === 0) throw failure("يجب اختيار نوع تسوية واحد على الأقل");
  return result;
}

export function normalizeAdjustmentAccountMappings(
  value: unknown,
  fallback: Record<string, number> = {},
): Record<string, number> {
  if (value === undefined) return { ...fallback };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure("ربط حسابات التسويات غير صالح");
  }
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const cleanKey = String(key).trim().toLowerCase();
    if (!cleanKey) continue;
    const accountId = positiveAccountId(raw, `حساب التسوية ${cleanKey}`);
    if (accountId != null) result[cleanKey] = accountId;
  }
  return result;
}

function defaults(companyId: number): Omit<ContractingSettingsRow, "id" | "createdAt" | "updatedAt"> {
  return {
    companyId,
    defaultAdvanceRecoveryEnabled: false,
    defaultAdvanceRecoveryPercent: "0",
    defaultAdvanceRecoveryStartProgressPercent: "0",
    defaultRetentionEnabled: true,
    defaultRetentionPercent: "5",
    defaultRetentionCapPercent: "100",
    adjustmentTypes: [...DEFAULT_CONTRACTING_ADJUSTMENT_TYPES],
    adjustmentAccountMappings: {},
    advanceRecoveryAccountId: null,
    retentionAccountId: null,
    materialDeductionAccountId: null,
    penaltyAccountId: null,
    additionAccountId: null,
    otherDeductionAccountId: null,
    overrideApprovalRequired: true,
    overrideApproverRoles: [...DEFAULT_OVERRIDE_APPROVER_ROLES],
    updatedByUserId: null,
  };
}

/** Get (and lazily create) the single settings row for a company. */
export async function getContractingSettings(companyId: number): Promise<SettingsWithDefaults> {
  await ensureContractingSettingsTable();
  const [row] = await db.select().from(contractingSettingsTable)
    .where(eq(contractingSettingsTable.companyId, companyId)).limit(1);
  if (row) return row as SettingsWithDefaults;
  const [created] = await db.insert(contractingSettingsTable)
    .values(defaults(companyId))
    .onConflictDoNothing({ target: contractingSettingsTable.companyId })
    .returning();
  if (created) return created as SettingsWithDefaults;
  const [raced] = await db.select().from(contractingSettingsTable)
    .where(eq(contractingSettingsTable.companyId, companyId)).limit(1);
  if (!raced) throw failure("تعذر إنشاء إعدادات المقاولات", 500);
  return raced as SettingsWithDefaults;
}

export async function updateContractingSettings(
  companyId: number,
  patch: ContractingSettingsPatch,
  updatedByUserId: number | null,
): Promise<SettingsWithDefaults> {
  const current = await getContractingSettings(companyId);
  const adjustmentTypes = normalizeContractingAdjustmentTypes(
    patch.adjustmentTypes,
    Array.isArray(current.adjustmentTypes) ? current.adjustmentTypes : undefined,
  );
  const mappings = normalizeAdjustmentAccountMappings(
    patch.adjustmentAccountMappings,
    (current.adjustmentAccountMappings ?? {}) as Record<string, number>,
  );
  const [updated] = await db.update(contractingSettingsTable).set({
    defaultAdvanceRecoveryEnabled: patch.defaultAdvanceRecoveryEnabled === undefined
      ? current.defaultAdvanceRecoveryEnabled
      : patch.defaultAdvanceRecoveryEnabled === true,
    defaultAdvanceRecoveryPercent: percentage(
      patch.defaultAdvanceRecoveryPercent,
      "نسبة استرداد الدفعة المقدمة",
      String(current.defaultAdvanceRecoveryPercent ?? "0"),
    ),
    defaultAdvanceRecoveryStartProgressPercent: percentage(
      patch.defaultAdvanceRecoveryStartProgressPercent,
      "بداية استرداد الدفعة المقدمة",
      String(current.defaultAdvanceRecoveryStartProgressPercent ?? "0"),
    ),
    defaultRetentionEnabled: patch.defaultRetentionEnabled === undefined
      ? current.defaultRetentionEnabled
      : patch.defaultRetentionEnabled === true,
    defaultRetentionPercent: percentage(
      patch.defaultRetentionPercent,
      "نسبة المحتجزات الافتراضية",
      String(current.defaultRetentionPercent ?? "5"),
    ),
    defaultRetentionCapPercent: percentage(
      patch.defaultRetentionCapPercent,
      "سقف المحتجزات الافتراضي",
      String(current.defaultRetentionCapPercent ?? "100"),
    ),
    adjustmentTypes,
    adjustmentAccountMappings: mappings,
    advanceRecoveryAccountId: patch.advanceRecoveryAccountId === undefined
      ? current.advanceRecoveryAccountId
      : positiveAccountId(patch.advanceRecoveryAccountId, "حساب استرداد الدفعة المقدمة"),
    retentionAccountId: patch.retentionAccountId === undefined
      ? current.retentionAccountId
      : positiveAccountId(patch.retentionAccountId, "حساب المحتجزات"),
    materialDeductionAccountId: patch.materialDeductionAccountId === undefined
      ? current.materialDeductionAccountId
      : positiveAccountId(patch.materialDeductionAccountId, "حساب خصم المواد"),
    penaltyAccountId: patch.penaltyAccountId === undefined
      ? current.penaltyAccountId
      : positiveAccountId(patch.penaltyAccountId, "حساب الغرامات"),
    additionAccountId: patch.additionAccountId === undefined
      ? current.additionAccountId
      : positiveAccountId(patch.additionAccountId, "حساب الإضافات"),
    otherDeductionAccountId: patch.otherDeductionAccountId === undefined
      ? current.otherDeductionAccountId
      : positiveAccountId(patch.otherDeductionAccountId, "حساب الاستقطاعات الأخرى"),
    overrideApprovalRequired: patch.overrideApprovalRequired === undefined
      ? current.overrideApprovalRequired
      : patch.overrideApprovalRequired === true,
    overrideApproverRoles: patch.overrideApproverRoles === undefined
      ? current.overrideApproverRoles
      : normalizeRoles(patch.overrideApproverRoles),
    updatedByUserId,
    updatedAt: new Date(),
  }).where(eq(contractingSettingsTable.companyId, companyId)).returning();
  if (!updated) throw failure("تعذر حفظ إعدادات المقاولات", 500);
  return updated as SettingsWithDefaults;
}

function normalizeRoles(value: unknown): string[] {
  if (!Array.isArray(value)) throw failure("أدوار اعتماد التجاوز يجب أن تكون قائمة");
  const roles = value
    .map((role) => String(role ?? "").trim().toLowerCase())
    .filter((role) => ["admin", "user", "cashier"].includes(role));
  if (roles.length === 0) throw failure("يجب اختيار دور واحد لاعتماد التجاوز");
  return [...new Set(roles)];
}

/**
 * Account validation belongs here as well as in the settings route so a
 * future non-HTTP caller cannot link a different tenant's or non-posting
 * account.  All selected accounts must be active posting accounts.
 */
export async function validateContractingSettingAccounts(
  companyId: number,
  settings: ContractingSettingsPatch,
): Promise<void> {
  const rawIds = [
    settings.advanceRecoveryAccountId,
    settings.retentionAccountId,
    settings.materialDeductionAccountId,
    settings.penaltyAccountId,
    settings.additionAccountId,
    settings.otherDeductionAccountId,
  ];
  const ids = rawIds
    .filter((id) => id != null)
    .map((id) => Number(id));
  const mappings = settings.adjustmentAccountMappings;
  if (mappings && typeof mappings === "object" && !Array.isArray(mappings)) {
    for (const id of Object.values(mappings as Record<string, unknown>)) {
      if (id != null && id !== "") ids.push(Number(id));
    }
  }
  const unique = [...new Set(ids)];
  if (unique.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw failure("أحد حسابات التسويات غير صالح");
  }
  if (unique.length === 0) return;
  const rows = await db.select({ id: accountsTable.id }).from(accountsTable).where(and(
    eq(accountsTable.companyId, companyId),
    eq(accountsTable.isActive, true),
    eq(accountsTable.isPosting, true),
  ));
  const valid = new Set(rows.map((row) => row.id));
  const invalid = unique.find((id) => !valid.has(id));
  if (invalid != null) throw failure("يجب اختيار حساب ترحيل نشط من نفس الشركة");
}

export async function canApproveContractingOverride(
  companyId: number,
  user: { role?: string; permissions?: Record<string, Record<string, boolean>> | null } | null | undefined,
): Promise<boolean> {
  if (!user) return false;
  if (user.role === "admin" || user.role === "superadmin") return true;
  // An explicit exception capability is required; ordinary contracting post
  // authority is intentionally not a fallback for financial overrides.
  return user.permissions?.contracting?.overrun === true;
}

export function contractingAdjustmentAccountId(
  settings: ContractingSettingsRow,
  key: string,
): number | null {
  const normalized = TYPE_ALIASES[String(key ?? "").trim().toLowerCase()];
  const builtIn: Record<string, number | null | undefined> = {
    advance_recovery: settings.advanceRecoveryAccountId,
    retention: settings.retentionAccountId,
    material_deduction: settings.materialDeductionAccountId,
    penalty: settings.penaltyAccountId,
    addition: settings.additionAccountId,
    other_deduction: settings.otherDeductionAccountId,
  };
  return (normalized ? builtIn[normalized] : undefined)
    ?? (settings.adjustmentAccountMappings ?? {})[String(key ?? "").trim().toLowerCase()]
    ?? null;
}