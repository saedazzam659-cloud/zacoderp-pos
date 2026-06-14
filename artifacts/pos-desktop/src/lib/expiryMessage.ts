// ─────────────────────────────────────────────────────────────────────────
// License-expiry renewal message (SuperAdmin-editable)
//
// The text shown on the desktop license-expiry banner ("للتجديد تواصل مع …")
// is controlled by the vendor from the web SuperAdmin panel
// (LicenseManagement → بيانات التواصل) and stored globally in the cloud
// `system_settings.subscription_contact_info` key. It rides down to the
// device inside the /api/sync/pull settings payload and is cached here so the
// banner can render it even between pulls / while briefly offline.
//
// Standalone devices never pull, so this stays empty and the banner falls
// back to its built-in default text.
// ─────────────────────────────────────────────────────────────────────────

const LS_MSG = "pos_desktop_renewal_message";

/** Persist the cloud-pushed renewal message (called from sync.ts after a pull). */
export function saveRenewalMessage(msg: string | null | undefined): void {
  try {
    if (typeof msg === "string") localStorage.setItem(LS_MSG, msg);
  } catch { /* storage full / unavailable — non-fatal */ }
}

/** Read the last cloud-pushed renewal message. Empty string when none yet. */
export function loadRenewalMessage(): string {
  try {
    return localStorage.getItem(LS_MSG) ?? "";
  } catch { return ""; }
}
