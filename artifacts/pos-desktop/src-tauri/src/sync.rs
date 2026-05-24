// Sync engine: heartbeat + pull (customers/items/settings) + push (offline invoices).
// TODO Step 9: retry/backoff, conflict resolution, chunked uploads.

use anyhow::Result;

pub async fn run_full_cycle() -> Result<String> {
    // 1. heartbeat → POST /api/sync/heartbeat
    // 2. pull deltas → GET /api/sync/pull?since=...
    // 3. push pending offline invoices → POST /api/sync/push
    // 4. update sync_status rows in offline_invoices
    Ok("sync stub — see Task #174 Step 9".into())
}
