// Local customers catalog — mirrors items.ts pattern.
// Browser mode: localStorage. Tauri mode: SQLite via Rust commands
// (customers::list_customers / upsert_customers / create_customer).

import { LS_KEYS, lsRead, lsWrite, IS_TAURI, tauriInvoke } from "./localStore";
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
    updatedAt: r.updated_at ?? undefined,
  };
}

export async function listCustomers(search?: string): Promise<LocalCustomer[]> {
  // MERGE strategy (mirrors items.ts): read both SQLite and localStorage.
  // updateCustomer/deleteCustomer write to localStorage only, so the merged
  // view is what makes those edits visible after the change.
  const fromTauri: LocalCustomer[] = [];
  if (IS_TAURI) {
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
  if (IS_TAURI) {
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
}

export async function createCustomer(input: CreateCustomerInput): Promise<LocalCustomer> {
  const now = new Date().toISOString();
  let created: LocalCustomer;
  if (IS_TAURI) {
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
    createdAt: now,
    updatedAt: now,
  };
  all.push(row);
  lsWrite(LS_KEYS.customers, all);
  return row;
}

export async function updateCustomer(id: number, patch: CreateCustomerInput): Promise<LocalCustomer | null> {
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
