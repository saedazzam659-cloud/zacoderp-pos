// Thin shim over the Rust `sync_push_now` Tauri command.
//
// Pushes every offline_invoices row with sync_status='pending' to
// POST /api/sync/push, then marks the acked rows as synced. Returns a
// summary the UI can show.
//
// Browser fallback (Vite dev / Replit preview): there is no local
// SQLite to read from, so this returns a no-op summary so the button
// still works and the UX doesn't lie about success.

const IS_TAURI =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export type PushSummary = {
  attempted: number;
  synced: number;
  failed: number;
  server_time?: string | null;
};

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
  // Normalize snake_case (Rust serde default) → object the UI consumes.
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
