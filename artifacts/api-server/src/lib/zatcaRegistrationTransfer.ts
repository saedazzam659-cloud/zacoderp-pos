/**
 * Shared primitives for the ZATCA registration hand-off.  This module never
 * serializes credentials to a response and deliberately keeps its envelope
 * format independent from HTTP routes so it can be policy-tested directly.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { db, pool } from "@workspace/db";
import { companiesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { GENESIS_HASH } from "./zatca-env.js";

export type ZatcaTransferEnvelope = {
  version: 1; sourceCompanyId: number; vatNumber: string; environment: string;
  target: { agentId: number; installationId: string; dbFingerprint: string; companyId: number };
  credentials: Record<string, string>; chain: { icv: number; pih: string };
  nonce: string; issuedAt: string; expiresAt: string;
};
export type EncryptedTransferEnvelope = { version: 1; iv: string; tag: string; ciphertext: string };
const AAD_PREFIX = "zacod:zatca-registration-transfer:v1:";
const key = () => {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new Error("SESSION_SECRET is required for registration transfers");
  return scryptSync(secret, "zacod-zatca-transfer-v1", 32);
};
export const normalizeVat = (value: string) => value.replace(/[\s-]/g, "");
export const transferBinding = (target: ZatcaTransferEnvelope["target"]) =>
  createHash("sha256").update(`${target.agentId}:${target.installationId}:${target.dbFingerprint}:${target.companyId}`).digest("hex");
export const credentialFingerprint = (credentials: Record<string, string>) =>
  createHash("sha256").update(JSON.stringify(Object.keys(credentials).sort().map(k => [k, credentials[k]]))).digest("hex");
export function validateTransferEnvelope(value: unknown, target?: ZatcaTransferEnvelope["target"], now = new Date(), allowExpired = false): ZatcaTransferEnvelope {
  const e = value as ZatcaTransferEnvelope;
  if (!e || e.version !== 1 || !Number.isInteger(e.sourceCompanyId) || !normalizeVat(e.vatNumber || "") ||
      !e.environment || !e.target || !e.credentials || !e.nonce || !e.issuedAt || !e.expiresAt) throw new Error("Invalid transfer envelope");
  if (!Number.isFinite(Date.parse(e.issuedAt)) || (!allowExpired && Date.parse(e.expiresAt) <= now.getTime())) throw new Error("Transfer envelope expired");
  if (target && transferBinding(e.target) !== transferBinding(target)) throw new Error("Transfer target mismatch");
  return e;
}
export function encryptTransferEnvelope(envelope: ZatcaTransferEnvelope): EncryptedTransferEnvelope {
  validateTransferEnvelope(envelope);
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(AAD_PREFIX + transferBinding(envelope.target)));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}
export function decryptTransferEnvelope(blob: EncryptedTransferEnvelope, target: ZatcaTransferEnvelope["target"], now = new Date(), allowExpired = false): ZatcaTransferEnvelope {
  if (!blob || blob.version !== 1) throw new Error("Invalid transfer ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(blob.iv, "base64"));
  decipher.setAAD(Buffer.from(AAD_PREFIX + transferBinding(target))); decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, "base64")), decipher.final()]).toString("utf8");
  return validateTransferEnvelope(JSON.parse(plain), target, now, allowExpired);
}

export const ZATCA_CHAIN_LOCK_KEY = 0x5a43;
export async function withZatcaChainLock<T>(companyId: number, work: () => Promise<T>, lockPool: any = pool): Promise<T> {
  const client = await lockPool.connect(); let locked = false;
  try { await client.query("SELECT pg_advisory_lock($1, $2)", [companyId, ZATCA_CHAIN_LOCK_KEY]); locked = true; return await work(); }
  finally { if (locked) await client.query("SELECT pg_advisory_unlock($1, $2)", [companyId, ZATCA_CHAIN_LOCK_KEY]).catch(() => {}); client.release(); }
}
export function transferGateError(state: string | null | undefined): string | null {
  return state === "active" || !state ? null : "تسجيل ZATCA للشركة قيد النقل أو تم نقله، ولا يمكن إرسال مستندات جديدة.";
}
export function mayCompleteExpiredTransfer(expiresAt: Date, targetAlreadyActiveAndBound: boolean, now = new Date()): boolean {
  return expiresAt > now || targetAlreadyActiveAndBound;
}
export function hasFrozenTransferBinding(
  party: { zatcaTransferState?: string | null; zatcaTransferId?: string | null; zatcaTransferTargetBinding?: string | null },
  transferId: string,
  binding: string,
): boolean {
  return party.zatcaTransferState === "frozen" &&
    party.zatcaTransferId === transferId &&
    party.zatcaTransferTargetBinding === binding;
}
export function hasActivatedTransferBinding(
  party: { zatcaTransferState?: string | null; zatcaTransferId?: string | null; zatcaTransferTargetBinding?: string | null },
  transferId: string,
  binding: string,
): boolean {
  return (party.zatcaTransferState === "active" || party.zatcaTransferState === "completed") &&
    party.zatcaTransferId === transferId &&
    party.zatcaTransferTargetBinding === binding;
}
export function completionChainAllowed(
  party: { zatcaTransferState?: string | null; zatcaTransferId?: string | null; zatcaTransferTargetBinding?: string | null },
  transferId: string,
  binding: string,
  current: { maxIcv: number; previousInvoiceHash: string },
  snapshot: { icv: number; pih: string },
): boolean {
  // Once exact binding proves activation committed, subsequent legitimate
  // submissions may have advanced the chain. Snapshot equality is only a
  // prerequisite for the first frozen -> active transition.
  return hasActivatedTransferBinding(party, transferId, binding) ||
    (current.maxIcv === snapshot.icv && current.previousInvoiceHash === snapshot.pih);
}
export function chooseZatcaChain(seed: { icv?: number | null; pih?: string | null }, accepted?: { icv?: number | null; hash?: string | null }): { maxIcv: number; previousInvoiceHash: string } {
  const acceptedIcv = Number(accepted?.icv ?? 0);
  const seedIcv = Number(seed.icv ?? 0);
  if (seedIcv > acceptedIcv) return { maxIcv: seedIcv, previousInvoiceHash: seed.pih || GENESIS_HASH };
  return { maxIcv: acceptedIcv, previousInvoiceHash: accepted?.hash || seed.pih || GENESIS_HASH };
}
export async function assertZatcaSubmissionAllowed(companyId: number): Promise<void> {
  const [company] = await db.select({ state: companiesTable.zatcaTransferState }).from(companiesTable).where(eq(companiesTable.id, companyId));
  const error = transferGateError(company?.state);
  if (error) throw Object.assign(new Error(error), { code: "ZATCA_TRANSFER_LOCKED", httpStatus: 409 });
}
/** Shared invoices+returns resolver; seeds are for a receiving company. */
export async function resolveZatcaChain(companyId: number): Promise<{ maxIcv: number; previousInvoiceHash: string }> {
  const seed = await db.select({ icv: companiesTable.zatcaChainSeedIcv, pih: companiesTable.zatcaChainSeedPih })
    .from(companiesTable).where(eq(companiesTable.id, companyId));
  const r = await db.execute(sql`SELECT zatca_icv AS icv, invoice_hash AS hash FROM (
    SELECT zatca_icv, invoice_hash, id, 1 AS source_rank FROM sales_invoices WHERE company_id=${companyId} AND zatca_status IN ('cleared','reported')
    UNION ALL SELECT zatca_icv, invoice_hash, id, 0 AS source_rank FROM sales_returns WHERE company_id=${companyId} AND zatca_status IN ('cleared','reported')
  ) c WHERE zatca_icv IS NOT NULL ORDER BY zatca_icv DESC, id DESC, source_rank DESC LIMIT 1`);
  const row = ((r as any).rows ?? r as any)[0] as { icv?: number; hash?: string } | undefined;
  // A seed represents a historical accepted chain.  It must not be overwritten
  // by a lower local record after receiving a registration.  On an equal ICV,
  // the concrete accepted record wins deterministically (it is the newest
  // locally evidenced PIH; query ties are ordered by id).
  return chooseZatcaChain(seed[0] ?? {}, row);
}