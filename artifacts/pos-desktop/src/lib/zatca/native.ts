// Thin TypeScript wrappers around the Rust ZATCA commands (Task #233, Option B).
//
// These are DEVICE-LOCAL commands (keyring secrets + the onboarding/PIH-chain
// SQLite tables live on the machine that signs). Per the bridge.ts contract,
// device-local commands NEVER route through `bridgeInvoke` — they always use
// the local Tauri `invoke` directly. The webview calls these; the OS keyring +
// SQLite are reached only on the host machine.
//
// Tauri auto-maps camelCase JS arg keys → snake_case Rust params, so the JS
// shapes below mirror the Rust signatures in `src-tauri/src/zatca.rs`.

import { tauriInvoke } from "../localStore";

export type ZatcaSecretSlot = "privkey" | "compliance" | "production";
export type ZatcaEnvironment = "sandbox" | "production";
export type ZatcaOnboardingStatus =
  | "none" | "csr" | "compliance" | "production" | string;

export interface ZatcaOnboardingState {
  environment: ZatcaEnvironment;
  status: ZatcaOnboardingStatus;
  csrPem: string | null;
  orgJson: string | null;
  complianceRequestId: string | null;
  productionRequestId: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface ZatcaChainHead {
  icv: number;
  invoiceHash: string;
}

export interface ZatcaInvoiceRow {
  localUuid: string;
  icv: number;
  pih: string;
  invoiceHash: string;
  invoiceNo: string | null;
  invoiceType: string | null;
  /** Only present from `zatcaGetInvoice` (the list omits the heavy XML). */
  signedXml?: string | null;
  qrBase64: string | null;
  status: string;
  zatcaStatus: string | null;
  warningsJson: string | null;
  responseJson: string | null;
  submittedAt: string | null;
  createdAt: string;
}

export interface ZatcaHttpResponse {
  status: number;
  body: string;
}

// ── Keyring secrets ──────────────────────────────────────────────────
export function zatcaSaveSecret(slot: ZatcaSecretSlot, value: string): Promise<void> {
  return tauriInvoke<void>("zatca_save_secret", { slot, value });
}
export function zatcaLoadSecret(slot: ZatcaSecretSlot): Promise<string | null> {
  return tauriInvoke<string | null>("zatca_load_secret", { slot });
}
export function zatcaClearSecret(slot: ZatcaSecretSlot): Promise<void> {
  return tauriInvoke<void>("zatca_clear_secret", { slot });
}

// ── Onboarding singleton ─────────────────────────────────────────────
export function zatcaGetOnboarding(): Promise<ZatcaOnboardingState> {
  return tauriInvoke<ZatcaOnboardingState>("zatca_get_onboarding");
}

export interface ZatcaSaveOnboardingPatch {
  environment?: ZatcaEnvironment | null;
  status?: ZatcaOnboardingStatus | null;
  csrPem?: string | null;
  orgJson?: string | null;
  complianceRequestId?: string | null;
  productionRequestId?: string | null;
  /** Always written verbatim — pass `null` to clear a prior error. */
  lastError?: string | null;
}
export function zatcaSaveOnboarding(patch: ZatcaSaveOnboardingPatch): Promise<void> {
  return tauriInvoke<void>("zatca_save_onboarding", patch as Record<string, unknown>);
}

// ── PIH/ICV chain + per-invoice status ───────────────────────────────
export function zatcaChainHead(): Promise<ZatcaChainHead | null> {
  return tauriInvoke<ZatcaChainHead | null>("zatca_chain_head");
}

export interface ZatcaRecordInvoiceInput {
  localUuid: string;
  icv: number;
  pih: string;
  invoiceHash: string;
  invoiceNo?: string | null;
  invoiceType?: string | null;
  signedXml?: string | null;
  qrBase64?: string | null;
  status?: string | null;
}
export function zatcaRecordInvoice(input: ZatcaRecordInvoiceInput): Promise<void> {
  return tauriInvoke<void>("zatca_record_invoice", input as unknown as Record<string, unknown>);
}

export interface ZatcaUpdateInvoiceStatusInput {
  localUuid: string;
  status: string;
  zatcaStatus?: string | null;
  warningsJson?: string | null;
  responseJson?: string | null;
}
export function zatcaUpdateInvoiceStatus(input: ZatcaUpdateInvoiceStatusInput): Promise<void> {
  return tauriInvoke<void>("zatca_update_invoice_status", input as unknown as Record<string, unknown>);
}

export function zatcaListInvoices(status?: string | null): Promise<ZatcaInvoiceRow[]> {
  return tauriInvoke<ZatcaInvoiceRow[]>("zatca_list_invoices", { status: status ?? null });
}
export function zatcaGetInvoice(localUuid: string): Promise<ZatcaInvoiceRow | null> {
  return tauriInvoke<ZatcaInvoiceRow | null>("zatca_get_invoice", { localUuid });
}

// ── Direct HTTPS proxy to the ZATCA gateway ──────────────────────────
export function zatcaHttpsPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<ZatcaHttpResponse> {
  return tauriInvoke<ZatcaHttpResponse>("zatca_https_post", { url, headers, body });
}
