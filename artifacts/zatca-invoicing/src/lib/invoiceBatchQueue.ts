export interface InvoiceBatchQueueFailure<T> {
  entry: T;
  error: string;
}

/**
 * Bounded extraction queue for large invoice batches. Results stay associated
 * with their input index; one bad file never discards successful extractions.
 */
export async function processInvoiceBatchQueue<TEntry, TResult>(
  entries: readonly { entry: TEntry; index: number }[],
  processEntry: (entry: TEntry, index: number) => Promise<TResult>,
  options: {
    concurrency?: number;
    onProgress?: (completed: number, total: number) => void;
  } = {},
): Promise<{
  successes: Map<number, TResult>;
  failures: InvoiceBatchQueueFailure<TEntry>[];
}> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  const successes = new Map<number, TResult>();
  const failures: InvoiceBatchQueueFailure<TEntry>[] = [];
  let nextIndex = 0;
  let completed = 0;
  let quotaStopReason = "";

  const worker = async () => {
    while (nextIndex < entries.length) {
      if (quotaStopReason) return;
      const current = entries[nextIndex++];
      try {
        successes.set(current.index, await processEntry(current.entry, current.index));
      } catch (error: any) {
        const message = error?.message ?? "تعذرت قراءة الملف";
        failures.push({ entry: current.entry, error: message });
        if (error?.status === 429) quotaStopReason = message;
      } finally {
        completed += 1;
        options.onProgress?.(completed, entries.length);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()));
  if (quotaStopReason) {
    for (const skipped of entries.slice(nextIndex)) {
      failures.push({
        entry: skipped.entry,
        error: `لم يبدأ تحويل هذا الملف بسبب حد الاستخدام: ${quotaStopReason}`,
      });
    }
  }
  return { successes, failures };
}
