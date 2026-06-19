// Local customers catalog — mirrors items.ts pattern.
// Browser mode: localStorage. Tauri mode: SQLite via Rust commands
// (customers::list_customers / upsert_customers / create_customer).

import { LS_KEYS, lsRead, lsWrite } from "./localStore";
// Task #207: shared-data Rust commands route through the bridge (a LAN
// client forwards them to the host; single/host call the local command).
import { bridgeInvoke as tauriInvoke, shouldUseBridge } from "./bridge";
import { enqueuePush } from "./pushQueue";

export interface LocalCustomer {
  id: number;
  cloudId?: number | null;
  nameAr: string;
  nameEn?: string | null;
  phone?: string | null;
  vatNumber?: string | null;
  currencyCode?: string;
  /** Shadow balance in base currency. Positive = customer owes us (مدين). */
  balance?: number;
  /** Credit control — max outstanding AR allowed (0 = unlimited). */
  creditLimit?: number;
  /** When true, a credit sale that exceeds creditLimit is rejected. */
  enforceCreditLimit?: boolean;
  /** Grace days before an unpaid credit invoice is overdue (0 = no check). */
  paymentTermsDays?: number;
  // ── Profile parity with web (Phase 1A) ──
  crNumber?: string | null;
  email?: string | null;
  city?: string | null;
  district?: string | null;
  street?: string | null;
  buildingNumber?: string | null;
  postalCode?: string | null;
  country?: string | null;
  nationalAddressShort?: string | null;
  locationLat?: string | null;
  locationLng?: string | null;
  locationLink?: string | null;
  /** When false, excluded from per-customer AR statement/ageing reports. */
  includeInStatements?: boolean;
  /** Default home branch (FK to branches_local.id). */
  branchId?: number | null;
  /** Dedicated GL receivable account (FK to accounts_local.id). null = default POS AR. */
  accountId?: number | null;
  createdAt?: string;
  updatedAt?: string;
  /** Soft-delete tombstone (overlay). When true, listCustomers filters this row out. */
  deleted?: boolean;
}

interface RustCustomer {
  id: number;
  cloud_id: number | null;
  name_ar: string;
  name_en: string | null;
  phone: string | null;
  vat_number: string | null;
  updated_at: string | null;
  currency_code?: string;
  balance?: number;
  credit_limit?: number;
  enforce_credit_limit?: boolean;
  payment_terms_days?: number;
  cr_number?: string | null;
  email?: string | null;
  city?: string | null;
  district?: string | null;
  street?: string | null;
  building_number?: string | null;
  postal_code?: string | null;
  country?: string | null;
  national_address_short?: string | null;
  location_lat?: string | null;
  location_lng?: string | null;
  location_link?: string | null;
  include_in_statements?: boolean;
  branch_id?: number | null;
  account_id?: number | null;
}

function fromRust(r: RustCustomer): LocalCustomer {
  return {
    id: r.id,
    cloudId: r.cloud_id,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    phone: r.phone,
    vatNumber: r.vat_number,
    currencyCode: r.currency_code ?? "SAR",
    balance: r.balance ?? 0,
    creditLimit: r.credit_limit ?? 0,
    enforceCreditLimit: r.enforce_credit_limit ?? false,
    paymentTermsDays: r.payment_terms_days ?? 0,
    crNumber: r.cr_number ?? null,
    email: r.email ?? null,
    city: r.city ?? null,
    district: r.district ?? null,
    street: r.street ?? null,
    buildingNumber: r.building_number ?? null,
    postalCode: r.postal_code ?? null,
    country: r.country ?? null,
    nationalAddressShort: r.national_address_short ?? null,
    locationLat: r.location_lat ?? null,
    locationLng: r.location_lng ?? null,
    locationLink: r.location_link ?? null,
    includeInStatements: r.include_in_statements ?? true,
    branchId: r.branch_id ?? null,
    accountId: r.account_id ?? null,
    updatedAt: r.updated_at ?? undefined,
  };
}

export async function listCustomers(search?: string): Promise<LocalCustomer[]> {
  // MERGE strategy (mirrors items.ts): read both SQLite and localStorage.
  // updateCustomer/deleteCustomer write to localStorage only, so the merged
  // view is what makes those edits visible after the change.
  const fromTauri: LocalCustomer[] = [];
  if (shouldUseBridge()) {
    try {
      const rows = await tauriInvoke<RustCustomer[]>("list_customers", { search: search ?? null });
      fromTauri.push(...rows.map(fromRust));
    } catch { /* fall through */ }
  }
  const fromLs = lsRead<LocalCustomer[]>(LS_KEYS.customers, []);
  // OVERLAY: LS rows that match a Tauri row (by id OR cloudId) SUPERSEDE
  // the Tauri version — this is how updateCustomer/deleteCustomer can
  // mutate cloud-pulled rows without Rust write commands.
  const lsById = new Map<number, LocalCustomer>();
  const lsByCloud = new Map<number, LocalCustomer>();
  for (const r of fromLs) {
    lsById.set(r.id, r);
    if (r.cloudId) lsByCloud.set(r.cloudId, r);
  }
  const usedLs = new Set<number>();
  const merged: LocalCustomer[] = [];
  for (const t of fromTauri) {
    const overlay = lsById.get(t.id) ?? (t.cloudId ? lsByCloud.get(t.cloudId) : undefined);
    if (overlay) {
      merged.push(overlay);
      usedLs.add(overlay.id);
    } else {
      merged.push(t);
    }
  }
  for (const r of fromLs) {
    if (usedLs.has(r.id)) continue;
    merged.push(r);
  }
  // Filter tombstones (deleted rows the user removed locally).
  const visible = merged.filter((c) => !c.deleted);
  if (!search) return visible;
  const q2 = search.toLowerCase();
  return visible.filter((c) =>
    c.nameAr.includes(search) ||
    (c.nameEn ?? "").toLowerCase().includes(q2) ||
    (c.phone ?? "").includes(search) ||
    (c.vatNumber ?? "").includes(search),
  );
}

export async function getCustomer(id: number): Promise<LocalCustomer | null> {
  const all = await listCustomers();
  return all.find((c) => c.id === id) ?? null;
}

// Bulk upsert from cloud Pull. Matches on cloudId.
export async function upsertCustomersFromCloud(remote: Array<{
  id: number; nameAr: string; nameEn: string | null; phone: string | null;
  vatNumber: string | null; createdAt?: string;
}>): Promise<number> {
  if (shouldUseBridge()) {
    try {
      return await tauriInvoke<number>("upsert_customers_from_cloud", {
        rows: remote.map((c) => ({
          cloud_id: c.id,
          name_ar: c.nameAr,
          name_en: c.nameEn,
          phone: c.phone,
          vat_number: c.vatNumber,
        })),
      });
    } catch {
      // fall through
    }
  }
  const existing = lsRead<LocalCustomer[]>(LS_KEYS.customers, []);
  const byCloud = new Map<number, LocalCustomer>();
  for (const c of existing) if (c.cloudId) byCloud.set(c.cloudId, c);
  let maxId = existing.reduce((m, c) => Math.max(m, c.id), 0);

  for (const r of remote) {
    const prev = byCloud.get(r.id);
    if (prev) {
      Object.assign(prev, {
        nameAr: r.nameAr,
        nameEn: r.nameEn,
        phone: r.phone,
        vatNumber: r.vatNumber,
        updatedAt: new Date().toISOString(),
      });
    } else {
      maxId += 1;
      existing.push({
        id: maxId,
        cloudId: r.id,
        nameAr: r.nameAr,
        nameEn: r.nameEn,
        phone: r.phone,
        vatNumber: r.vatNumber,
        createdAt: r.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  lsWrite(LS_KEYS.customers, existing);
  return remote.length;
}

export interface CreateCustomerInput {
  nameAr: string;
  nameEn?: string | null;
  phone?: string | null;
  vatNumber?: string | null;
  currencyCode?: string;
  /** Opening balance amount (native, > 0). Posted as a JE on create only. */
  openingBalance?: number;
  /** "debit" (مدين — owes us) or "credit" (دائن — we owe them). */
  openingNature?: "debit" | "credit";
  openingDate?: string;
  /** Credit control. */
  creditLimit?: number;
  enforceCreditLimit?: boolean;
  paymentTermsDays?: number;
  // ── Profile parity with web (Phase 1A) ──
  crNumber?: string | null;
  email?: string | null;
  city?: string | null;
  district?: string | null;
  street?: string | null;
  buildingNumber?: string | null;
  postalCode?: string | null;
  country?: string | null;
  nationalAddressShort?: string | null;
  locationLat?: string | null;
  locationLng?: string | null;
  locationLink?: string | null;
  includeInStatements?: boolean;
  branchId?: number | null;
  accountId?: number | null;
}

/** Build the Rust `profile` struct arg from a customer input (camelCase keys). */
function toProfile(input: CreateCustomerInput) {
  return {
    crNumber: input.crNumber ?? null,
    email: input.email ?? null,
    city: input.city ?? null,
    district: input.district ?? null,
    street: input.street ?? null,
    buildingNumber: input.buildingNumber ?? null,
    postalCode: input.postalCode ?? null,
    country: input.country ?? null,
    nationalAddressShort: input.nationalAddressShort ?? null,
    locationLat: input.locationLat ?? null,
    locationLng: input.locationLng ?? null,
    locationLink: input.locationLink ?? null,
    includeInStatements: input.includeInStatements ?? null,
    // branch_id tri-state on the Rust wire: undefined → null (preserve via
    // COALESCE), explicit null ("— بدون —") → 0 sentinel (clear to NULL),
    // a real id → that id. SQLite branch ids start at 1, so 0 is never valid.
    branchId: input.branchId === null ? 0 : (input.branchId ?? null),
    // Same tri-state as branchId: undefined → null (preserve via COALESCE/CASE),
    // explicit null ("— بدون —") → 0 sentinel (clear to NULL), real id → that id.
    accountId: input.accountId === null ? 0 : (input.accountId ?? null),
  };
}

export async function createCustomer(input: CreateCustomerInput): Promise<LocalCustomer> {
  const now = new Date().toISOString();
  let created: LocalCustomer;
  if (shouldUseBridge()) {
    try {
      const r = await tauriInvoke<RustCustomer>("create_customer_local", {
        nameAr: input.nameAr,
        nameEn: input.nameEn ?? null,
        phone: input.phone ?? null,
        vatNumber: input.vatNumber ?? null,
        currencyCode: input.currencyCode ?? "SAR",
        openingBalance: input.openingBalance ?? null,
        openingNature: input.openingNature ?? null,
        openingDate: input.openingDate ?? null,
        creditLimit: input.creditLimit ?? null,
        enforceCreditLimit: input.enforceCreditLimit ?? null,
        paymentTermsDays: input.paymentTermsDays ?? null,
        profile: toProfile(input),
      });
      created = fromRust(r);
    } catch {
      created = createInLocalStorage(input, now);
    }
  } else {
    created = createInLocalStorage(input, now);
  }
  // Queue for cloud push (idempotent via clientId).
  enqueuePush({
    clientId: `cust-${created.id}-${Date.now()}`,
    entityType: "customer",
    operation: "create",
    payload: {
      localId: created.id,
      nameAr: created.nameAr,
      nameEn: created.nameEn,
      phone: created.phone,
      vatNumber: created.vatNumber,
    },
  });
  return created;
}

function createInLocalStorage(input: CreateCustomerInput, now: string): LocalCustomer {
  const all = lsRead<LocalCustomer[]>(LS_KEYS.customers, []);
  const id = all.reduce((m, c) => Math.max(m, c.id), 0) + 1;
  const row: LocalCustomer = {
    id,
    cloudId: null,
    nameAr: input.nameAr,
    nameEn: input.nameEn ?? null,
    phone: input.phone ?? null,
    vatNumber: input.vatNumber ?? null,
    currencyCode: input.currencyCode ?? "SAR",
    balance: 0,
    creditLimit: input.creditLimit ?? 0,
    enforceCreditLimit: input.enforceCreditLimit ?? false,
    paymentTermsDays: input.paymentTermsDays ?? 0,
    crNumber: input.crNumber ?? null,
    email: input.email ?? null,
    city: input.city ?? null,
    district: input.district ?? null,
    street: input.street ?? null,
    buildingNumber: input.buildingNumber ?? null,
    postalCode: input.postalCode ?? null,
    country: input.country ?? null,
    nationalAddressShort: input.nationalAddressShort ?? null,
    locationLat: input.locationLat ?? null,
    locationLng: input.locationLng ?? null,
    locationLink: input.locationLink ?? null,
    includeInStatements: input.includeInStatements ?? true,
    branchId: input.branchId ?? null,
    accountId: input.accountId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  all.push(row);
  lsWrite(LS_KEYS.customers, all);
  return row;
}

export async function updateCustomer(id: number, patch: CreateCustomerInput): Promise<LocalCustomer | null> {
  // Persist to SQLite first so the Rust-side credit-limit enforcement on sales
  // reads the true values (the LS overlay below is invisible to Rust). Browser
  // mode and any bridge failure fall through to the LS-overlay path.
  if (shouldUseBridge()) {
    try {
      await tauriInvoke<RustCustomer>("update_customer_local", {
        id,
        nameAr: patch.nameAr ?? null,
        nameEn: patch.nameEn ?? null,
        phone: patch.phone ?? null,
        vatNumber: patch.vatNumber ?? null,
        currencyCode: patch.currencyCode ?? null,
        creditLimit: patch.creditLimit ?? null,
        enforceCreditLimit: patch.enforceCreditLimit ?? null,
        paymentTermsDays: patch.paymentTermsDays ?? null,
        profile: toProfile(patch),
      });
    } catch { /* fall through to LS overlay */ }
  }
  const all = lsRead<LocalCustomer[]>(LS_KEYS.customers, []);
  const idx = all.findIndex((c) => c.id === id);
  let updated: LocalCustomer;
  if (idx >= 0) {
    updated = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };
    all[idx] = updated;
  } else {
    // Row originates from SQLite — write a full overlay to LS so the
    // edit becomes visible and the next update can find it.
    const merged = await listCustomers();
    const base = merged.find((c) => c.id === id);
    if (!base) return null;
    updated = { ...base, ...patch, updatedAt: new Date().toISOString() };
    all.push(updated);
  }
  lsWrite(LS_KEYS.customers, all);
  enqueuePush({
    clientId: `cust-upd-${id}-${Date.now()}`,
    entityType: "customer",
    operation: "update",
    payload: { localId: id, cloudId: updated.cloudId, ...patch },
  });
  return updated;
}

export async function deleteCustomer(id: number): Promise<void> {
  // Tombstone strategy — same as deleteItem. Cloud-backed rows get a
  // `deleted:true` overlay so the merged listCustomers hides them even
  // when SQLite still has the original; pure-local rows are dropped.
  const all = lsRead<LocalCustomer[]>(LS_KEYS.customers, []);
  const idx = all.findIndex((c) => c.id === id);
  let cloudId: number | null = null;
  if (idx >= 0) {
    cloudId = all[idx].cloudId ?? null;
    if (cloudId) {
      all[idx] = { ...all[idx], deleted: true, updatedAt: new Date().toISOString() };
    } else {
      all.splice(idx, 1);
    }
  } else {
    const merged = await listCustomers();
    const base = merged.find((c) => c.id === id);
    if (!base) return;
    cloudId = base.cloudId ?? null;
    all.push({ ...base, deleted: true, updatedAt: new Date().toISOString() });
  }
  lsWrite(LS_KEYS.customers, all);
  enqueuePush({
    clientId: `cust-del-${id}-${Date.now()}`,
    entityType: "customer",
    operation: "delete",
    payload: { localId: id, cloudId },
  });
}

export async function countCustomers(): Promise<number> {
  return (await listCustomers()).length;
}
