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
  createdAt?: string;
  updatedAt?: string;
}

interface RustCustomer {
  id: number;
  cloud_id: number | null;
  name_ar: string;
  name_en: string | null;
  phone: string | null;
  vat_number: string | null;
  updated_at: string | null;
}

function fromRust(r: RustCustomer): LocalCustomer {
  return {
    id: r.id,
    cloudId: r.cloud_id,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    phone: r.phone,
    vatNumber: r.vat_number,
    updatedAt: r.updated_at ?? undefined,
  };
}

export async function listCustomers(search?: string): Promise<LocalCustomer[]> {
  if (IS_TAURI) {
    try {
      const rows = await tauriInvoke<RustCustomer[]>("list_customers", { search: search ?? null });
      return rows.map(fromRust);
    } catch {
      // fall through to localStorage cache
    }
  }
  const all = lsRead<LocalCustomer[]>(LS_KEYS.customers, []);
  if (!search) return all;
  const q = search.toLowerCase();
  return all.filter((c) =>
    c.nameAr.includes(search) ||
    (c.nameEn ?? "").toLowerCase().includes(q) ||
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
  if (idx < 0) return null;
  all[idx] = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };
  lsWrite(LS_KEYS.customers, all);
  enqueuePush({
    clientId: `cust-upd-${id}-${Date.now()}`,
    entityType: "customer",
    operation: "update",
    payload: { localId: id, cloudId: all[idx].cloudId, ...patch },
  });
  return all[idx];
}

export async function deleteCustomer(id: number): Promise<void> {
  const all = lsRead<LocalCustomer[]>(LS_KEYS.customers, []);
  const target = all.find((c) => c.id === id);
  lsWrite(LS_KEYS.customers, all.filter((c) => c.id !== id));
  if (target) {
    enqueuePush({
      clientId: `cust-del-${id}-${Date.now()}`,
      entityType: "customer",
      operation: "delete",
      payload: { localId: id, cloudId: target.cloudId },
    });
  }
}

export async function countCustomers(): Promise<number> {
  return (await listCustomers()).length;
}
