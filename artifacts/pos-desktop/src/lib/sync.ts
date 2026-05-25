// Sync helpers — pull (cloud → local) and push (local → cloud).
//
// pullAndPersist:
//   Hits POST /api/sync/pull, then writes the returned customers/items
//   to the local store (SQLite in Tauri, localStorage in browser). Without
//   this step, the dashboard would happily report "184 items pulled" while
//   the sales screen stayed empty — which was the original bug.
//
// syncPushNow:
//   Pushes pending offline_invoices via the Rust Tauri command. In browser
//   mode there is no local DB of invoices, so it returns a no-op summary.

import { LS_KEYS, lsWrite, IS_TAURI } from "./localStore";
import { createApi } from "./api";
import { upsertItemsFromCloud } from "./items";
import { upsertCustomersFromCloud } from "./customers";

export type PushSummary = {
  attempted: number;
  synced: number;
  failed: number;
  server_time?: string | null;
};

export type PullSummary = {
  customers: number;
  items: number;
  serverTime: string | null;
};

export async function pullAndPersist(
  baseUrl: string,
  deviceToken: string,
): Promise<PullSummary> {
  const api = createApi({ baseUrl, deviceToken });
  const r = await api.pull({ entities: ["customers", "items", "settings"] });

  let customers = 0, items = 0;
  if (r.entities.customers?.length) {
    customers = await upsertCustomersFromCloud(r.entities.customers);
  }
  if (r.entities.items?.length) {
    items = await upsertItemsFromCloud(r.entities.items);
  }
  lsWrite(LS_KEYS.lastPullAt, new Date().toISOString());
  return { customers, items, serverTime: r.serverTime ?? null };
}

export async function syncPushNow(
  serverUrl: string,
  deviceToken: string,
): Promise<PushSummary> {
  if (!IS_TAURI) {
    // No local DB in browser preview — nothing to push.
    return { attempted: 0, synced: 0, failed: 0, server_time: null };
  }
  const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core");
  const raw = (await mod.invoke("sync_push_now", {
    serverUrl,
    deviceToken,
  })) as Record<string, unknown>;
  return {
    attempted: Number(raw.attempted ?? 0),
    synced: Number(raw.synced ?? 0),
    failed: Number(raw.failed ?? 0),
    server_time:
      (raw.server_time as string | null | undefined) ??
      (raw.serverTime as string | null | undefined) ??
      null,
  };
}
