export class DocumentMutationAdmissionError extends Error {
  readonly status = 503;
  readonly retryAfterSeconds = 2;

  constructor(message = "قاعدة البيانات مشغولة بعمليات ترحيل أخرى؛ أعد المحاولة بعد قليل") {
    super(message);
    this.name = "DocumentMutationAdmissionError";
  }
}

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: DocumentMutationAdmissionError) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Limits the number of document-mutation handlers that can hold dedicated
 * advisory-lock clients at once. Those handlers also need pool connections
 * for their business queries, so letting every pool slot hold a lock client
 * can starve the queries that would finish and release those locks.
 */
export class DocumentMutationAdmissionGate {
  private activeCount = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly limit: number,
    private readonly waitTimeoutMs = 2_000,
    private readonly maxQueued = 100,
  ) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("Document mutation admission limit must be a non-negative integer");
    }
  }

  get active(): number {
    return this.activeCount;
  }

  get queued(): number {
    return this.waiters.length;
  }

  acquire(): Promise<() => void> {
    if (this.limit === 0) {
      return Promise.reject(new DocumentMutationAdmissionError());
    }

    if (this.activeCount < this.limit) {
      this.activeCount += 1;
      return Promise.resolve(this.createRelease());
    }

    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(new DocumentMutationAdmissionError());
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new DocumentMutationAdmissionError());
        }, this.waitTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      while (this.waiters.length) {
        const next = this.waiters.shift()!;
        clearTimeout(next.timer);
        next.resolve(this.createRelease());
        return;
      }

      this.activeCount = Math.max(0, this.activeCount - 1);
    };
  }
}
