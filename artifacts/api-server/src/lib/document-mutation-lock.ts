import type { NextFunction, Request, RequestHandler, Response } from "express";
import { centralPool, getActiveExternalDb, pool } from "@workspace/db";
import { resolveCompanyId } from "../middleware/auth.js";
import { DocumentMutationAdmissionError, DocumentMutationAdmissionGate } from "./document-mutation-admission.js";

const lockTails = new Map<string, Promise<void>>();
const admissionGates = new WeakMap<object, DocumentMutationAdmissionGate>();
const MAX_LOCK_CLIENTS_PER_POOL = 4;
const MUTATION_ADMISSION_WAIT_MS = 2_000;
const MAX_QUEUED_MUTATIONS_PER_POOL = 100;

function getMutationAdmissionGate(): DocumentMutationAdmissionGate {
  const databasePool = getActiveExternalDb()?.pool ?? centralPool;
  const poolKey = databasePool as object;
  const existing = admissionGates.get(poolKey);
  if (existing) return existing;

  const poolMax = Number((databasePool as any).options?.max);
  const safePoolMax = Number.isInteger(poolMax) && poolMax > 0 ? poolMax : 10;
  // This lock consumes one pool client while the handler issues its own
  // queries. A one-client pool cannot safely run these handlers at all.
  const limit = safePoolMax < 2
    ? 0
    : Math.max(1, Math.min(MAX_LOCK_CLIENTS_PER_POOL, Math.floor(safePoolMax / 3)));
  const gate = new DocumentMutationAdmissionGate(
    limit,
    MUTATION_ADMISSION_WAIT_MS,
    MAX_QUEUED_MUTATIONS_PER_POOL,
  );
  admissionGates.set(poolKey, gate);
  return gate;
}

function advisoryScopeKey(type: string, companyId: number): number {
  let hash = 0x811c9dc5;
  for (const char of `${type}:${companyId}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  }
  return hash | 0;
}

export async function withDocumentMutationLock<T>(
  type: string,
  companyId: number,
  documentId: number,
  operation: () => Promise<T> | T,
): Promise<T> {
  const key = `${type}:${companyId}:${documentId}`;
  const previous = lockTails.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => { unlock = resolve; });
  lockTails.set(key, current);
  await previous;
  let operationError: unknown;
  let client: any;
  let releaseAdmission: (() => void) | undefined;
  let lockAcquired = false;
  let lockAttempted = false;
  try {
    releaseAdmission = await getMutationAdmissionGate().acquire();
    if (
      !Number.isSafeInteger(companyId) || companyId <= 0 ||
      !Number.isSafeInteger(documentId) || documentId <= 0 || documentId > 2_147_483_647
    ) {
      throw new Error("Invalid document identity for mutation lock");
    }
    client = await pool.connect();
    const scopeKey = advisoryScopeKey(type, companyId);
    lockAttempted = true;
    await client.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [scopeKey, documentId]);
    lockAcquired = true;
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let unlockError: unknown;
    if (client && lockAcquired) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock($1::integer, $2::integer)",
          [advisoryScopeKey(type, companyId), documentId],
        );
      } catch (error) {
        unlockError = error;
      }
    }
    if (client) {
      client.release(
        unlockError
          ? unlockError instanceof Error ? unlockError : new Error(String(unlockError))
          : lockAttempted && !lockAcquired
            ? new Error("Advisory lock acquisition failed; discard database connection")
          : undefined,
      );
    }
    unlock();
    if (lockTails.get(key) === current) lockTails.delete(key);
    releaseAdmission?.();
    if (unlockError && operationError === undefined) throw unlockError;
  }
}

/**
 * Serialize posting against cancel/restore across API processes with a
 * PostgreSQL session advisory lock. The local queue prevents same-process
 * requests from consuming one pool connection each while waiting.
 */
export function documentMutationLock(
  type: string | ((req: Request) => string | null | undefined),
  handler: (req: Request, res: Response, next: NextFunction) => unknown,
  idParam = "id",
): RequestHandler {
  return async (req, res, next) => {
    const rawCompanyId = req.body?.companyId ?? req.query.companyId;
    const companyId = resolveCompanyId(
      req,
      rawCompanyId != null && rawCompanyId !== "" ? Number(rawCompanyId) : undefined,
    );
    const documentId = Number(req.params[idParam]);
    const lockType = typeof type === "function" ? type(req) : type;
    if (!lockType || !companyId || !Number.isSafeInteger(documentId) || documentId <= 0) {
      return handler(req, res, next);
    }
    try {
      return await withDocumentMutationLock(lockType, companyId, documentId, () =>
        handler(req, res, next),
      );
    } catch (error) {
      if (error instanceof DocumentMutationAdmissionError) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
        return res.status(error.status).json({
          error: error.message,
          code: "DOCUMENT_MUTATION_CAPACITY",
        });
      }
      return next(error);
    }
  };
}