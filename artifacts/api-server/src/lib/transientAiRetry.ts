type HttpResponseLike = {
  ok: boolean;
  status: number;
  body?: { cancel: () => Promise<unknown> | undefined } | null;
};

const RETRYABLE_AI_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [800, 2_000];

/**
 * Retry transient provider overloads without repeating successful or
 * non-retryable requests. Only the final response is returned to the caller.
 */
export async function fetchWithTransientAiRetry<T extends HttpResponseLike>(
  request: () => Promise<T>,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request();
    if (!RETRYABLE_AI_STATUSES.has(response.status) || attempt >= RETRY_DELAYS_MS.length) {
      return response;
    }
    try {
      await response.body?.cancel();
    } catch {
      // The retry should not be blocked by failure to close an error response.
    }
    await pause(RETRY_DELAYS_MS[attempt]);
  }
}
