/**
 * Keeps a create request safe to repeat when the server committed it but the
 * browser lost the response. The key is deliberately tied to the exact
 * outgoing payload: an unchanged retry reuses it, while an edited form starts
 * a distinct operation instead of conflicting with the original claim.
 */
export type RetryableCreateAttempt = {
  idempotencyKey: string;
  payloadSignature: string;
};

/**
 * A gateway timeout can be returned after the API completed its transaction.
 * Treat only transport/gateway failures as uncertain; validation and business
 * errors are conclusive and must release the claim for a corrected request.
 */
export function shouldRetainCreateAttemptAfterFailure(
  status?: number,
  error?: unknown,
): boolean {
  if (error instanceof TypeError) return true;
  return status != null && [408, 429, 500, 502, 503, 504].includes(status);
}

function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `contracting-bill-${globalThis.crypto.randomUUID()}`;
  }
  return `contracting-bill-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function payloadSignature(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

export function retryableCreateAttempt(
  payload: Record<string, unknown>,
  previous: RetryableCreateAttempt | null,
): RetryableCreateAttempt {
  const nextSignature = payloadSignature(payload);
  if (previous?.payloadSignature === nextSignature) return previous;
  return { idempotencyKey: newIdempotencyKey(), payloadSignature: nextSignature };
}