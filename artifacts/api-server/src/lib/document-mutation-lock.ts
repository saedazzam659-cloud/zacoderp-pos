import type { NextFunction, Request, RequestHandler, Response } from "express";
import { pool } from "@workspace/db";
import { resolveCompanyId } from "../middleware/auth.js";

const lockTails = new Map<string, Promise<void>>();

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
  let lockAcquired = false;
  let lockAttempted = false;
  try {
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
      return next(error);
    }
  };
}