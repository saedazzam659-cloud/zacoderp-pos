/**
 * Per-connection forwarding configuration.
 *
 * Stored as JSONB on integration_connections.forwarding_config so the shape
 * can evolve without DDL changes. Every field is optional in storage; this
 * module provides defaults so callers always work with a fully-populated
 * object via `withDefaults(raw)`.
 */
export type ZatcaSendMode = "manual" | "delayed" | "immediate" | "scheduled_batch";
export type OnMissingMode = "create" | "freeze" | "default";
export type BranchMode    = "fixed" | "from_source" | "map";
export type WarehouseMode = "fixed" | "by_branch";
export type DedupMode     = "source_number" | "content_hash" | "none";

export interface MatchByCustomer { vat: boolean; phone: boolean; email: boolean; name: boolean }
export interface MatchByItem     { sku: boolean; barcode: boolean; nameAr: boolean; nameEn: boolean }

export interface ForwardingConfig {
  /** Master switch — when false, ingested invoices stay in sync_runs only and never enqueue. */
  enabled: boolean;
  zatcaMode: ZatcaSendMode;
  delayMinutes: number;            // 0–1440 (24h)
  scheduledTime: string;           // "HH:MM" (24h) for scheduled_batch
  allowEarlySend: boolean;         // user can press "send now" before timer

  customer: {
    onMissing: OnMissingMode;
    defaultCustomerId: number | null;
    matchBy: MatchByCustomer;
  };
  item: {
    onMissing: OnMissingMode;
    defaultItemId: number | null;
    matchBy: MatchByItem;
  };
  branch: {
    mode: BranchMode;
    fixedBranchId: number | null;
    map: Record<string, number>;   // sourceBranchName → branchId
  };
  warehouse: {
    mode: WarehouseMode;
    fixedWarehouseId: number | null;
  };
  notifications: {
    onZatcaFail: boolean;
    onFreeze: boolean;
    dailySummary: boolean;
    email: string | null;
  };
  dedupBy: DedupMode;
}

export const DEFAULT_FORWARDING_CONFIG: ForwardingConfig = {
  enabled: false,                  // OFF by default — user must opt in (safe)
  zatcaMode: "manual",             // safest default
  delayMinutes: 15,
  scheduledTime: "23:00",
  allowEarlySend: true,

  customer: {
    onMissing: "freeze",           // safer than auto-create
    defaultCustomerId: null,
    matchBy: { vat: true, phone: true, email: true, name: false },
  },
  item: {
    onMissing: "freeze",
    defaultItemId: null,
    matchBy: { sku: true, barcode: true, nameAr: true, nameEn: false },
  },
  branch: {
    mode: "fixed",
    fixedBranchId: null,
    map: {},
  },
  warehouse: {
    mode: "fixed",
    fixedWarehouseId: null,
  },
  notifications: {
    onZatcaFail: true,
    onFreeze: true,
    dailySummary: false,
    email: null,
  },
  dedupBy: "source_number",
};

/**
 * Deep-merge a stored partial config with the defaults. Tolerant of `null`,
 * `undefined`, or completely missing nested objects (which is what you get
 * for connections created before Phase B).
 */
export function withDefaults(raw: unknown): ForwardingConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ForwardingConfig>;
  const d = DEFAULT_FORWARDING_CONFIG;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    zatcaMode: (["manual","delayed","immediate","scheduled_batch"] as const).includes(r.zatcaMode as ZatcaSendMode)
      ? (r.zatcaMode as ZatcaSendMode) : d.zatcaMode,
    delayMinutes: clamp(Number(r.delayMinutes ?? d.delayMinutes), 0, 1440),
    scheduledTime: typeof r.scheduledTime === "string" && /^\d{2}:\d{2}$/.test(r.scheduledTime)
      ? r.scheduledTime : d.scheduledTime,
    allowEarlySend: typeof r.allowEarlySend === "boolean" ? r.allowEarlySend : d.allowEarlySend,
    customer: {
      onMissing: (["create","freeze","default"] as const).includes((r.customer?.onMissing) as OnMissingMode)
        ? (r.customer!.onMissing as OnMissingMode) : d.customer.onMissing,
      defaultCustomerId: numOrNull(r.customer?.defaultCustomerId),
      matchBy: {
        vat:   r.customer?.matchBy?.vat   ?? d.customer.matchBy.vat,
        phone: r.customer?.matchBy?.phone ?? d.customer.matchBy.phone,
        email: r.customer?.matchBy?.email ?? d.customer.matchBy.email,
        name:  r.customer?.matchBy?.name  ?? d.customer.matchBy.name,
      },
    },
    item: {
      onMissing: (["create","freeze","default"] as const).includes((r.item?.onMissing) as OnMissingMode)
        ? (r.item!.onMissing as OnMissingMode) : d.item.onMissing,
      defaultItemId: numOrNull(r.item?.defaultItemId),
      matchBy: {
        sku:     r.item?.matchBy?.sku     ?? d.item.matchBy.sku,
        barcode: r.item?.matchBy?.barcode ?? d.item.matchBy.barcode,
        nameAr:  r.item?.matchBy?.nameAr  ?? d.item.matchBy.nameAr,
        nameEn:  r.item?.matchBy?.nameEn  ?? d.item.matchBy.nameEn,
      },
    },
    branch: {
      mode: (["fixed","from_source","map"] as const).includes((r.branch?.mode) as BranchMode)
        ? (r.branch!.mode as BranchMode) : d.branch.mode,
      fixedBranchId: numOrNull(r.branch?.fixedBranchId),
      map: (r.branch?.map && typeof r.branch.map === "object" ? r.branch.map : {}) as Record<string, number>,
    },
    warehouse: {
      mode: (["fixed","by_branch"] as const).includes((r.warehouse?.mode) as WarehouseMode)
        ? (r.warehouse!.mode as WarehouseMode) : d.warehouse.mode,
      fixedWarehouseId: numOrNull(r.warehouse?.fixedWarehouseId),
    },
    notifications: {
      onZatcaFail:  r.notifications?.onZatcaFail   ?? d.notifications.onZatcaFail,
      onFreeze:     r.notifications?.onFreeze      ?? d.notifications.onFreeze,
      dailySummary: r.notifications?.dailySummary  ?? d.notifications.dailySummary,
      email:        typeof r.notifications?.email === "string" ? r.notifications.email : d.notifications.email,
    },
    dedupBy: (["source_number","content_hash","none"] as const).includes(r.dedupBy as DedupMode)
      ? (r.dedupBy as DedupMode) : d.dedupBy,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}
function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Compute when a queue item should be sent to ZATCA, given the mode + now.
 * Returns `null` for "manual" (never auto-sent) and a Date for the others.
 */
export function computeScheduledFor(cfg: ForwardingConfig, now: Date = new Date()): Date | null {
  switch (cfg.zatcaMode) {
    case "manual":          return null;
    case "immediate":       return now;
    case "delayed":         return new Date(now.getTime() + cfg.delayMinutes * 60_000);
    case "scheduled_batch": {
      const [hh, mm] = cfg.scheduledTime.split(":").map(Number);
      const target = new Date(now);
      target.setHours(hh, mm, 0, 0);
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
      return target;
    }
  }
}
