import * as pdfjsLib from "pdfjs-dist";

export const PDF_FILE_RANGE_CHUNK_SIZE = 256 * 1024;

export class NoPdfTextLayerError extends Error {
  readonly code = "PDF_NO_TEXT_LAYER";

  constructor() {
    super("لا يوجد نص قابل للقراءة في الملف؛ قد يكون ممسوحًا كصورة.");
    this.name = "NoPdfTextLayerError";
  }
}

export class LocalPdfFileRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  private readonly file: Blob;
  private readonly onProgress?: (loaded: number, total: number) => void;
  private aborted = false;
  private failureReasonValue: unknown = null;
  private receivedRanges: Array<[number, number]> = [];
  private loadedByteCount = 0;
  private largestRangeByteCount = 0;

  constructor(
    file: Blob,
    fileName: string,
    onProgress?: (loaded: number, total: number) => void,
  ) {
    super(file.size, null, false, fileName);
    this.file = file;
    this.onProgress = onProgress;
    this.transportReady();
  }

  get failureReason(): unknown {
    return this.failureReasonValue;
  }

  get bytesRead(): number {
    return this.loadedByteCount;
  }

  get largestRangeRequested(): number {
    return this.largestRangeByteCount;
  }

  requestDataRange(begin: number, end: number): void {
    if (this.aborted) return;

    const start = Math.min(this.file.size, Math.max(0, Math.floor(begin)));
    const finish = Math.min(this.file.size, Math.max(start, Math.floor(end)));
    this.largestRangeByteCount = Math.max(this.largestRangeByteCount, finish - start);
    void this.file.slice(start, finish).arrayBuffer().then((buffer) => {
      if (this.aborted) return;

      const chunk = new Uint8Array(buffer);
      this.onDataRange(start, chunk);
      this.recordLoadedRange(start, finish);
    }).catch((error: unknown) => {
      this.failureReasonValue = error;
      // Resolve PDF.js's pending range read so its loading task can reject;
      // callers then receive the original Blob read failure below.
      if (!this.aborted) this.onDataRange(start, new Uint8Array(0));
    });
  }

  abort(): void {
    this.aborted = true;
  }

  private recordLoadedRange(start: number, end: number): void {
    if (end <= start) return;
    const ranges = [...this.receivedRanges, [start, end] as [number, number]]
      .sort((left, right) => left[0] - right[0]);
    const merged: Array<[number, number]> = [];

    for (const [rangeStart, rangeEnd] of ranges) {
      const last = merged[merged.length - 1];
      if (!last || rangeStart > last[1]) {
        merged.push([rangeStart, rangeEnd]);
      } else {
        last[1] = Math.max(last[1], rangeEnd);
      }
    }

    this.receivedRanges = merged;
    this.loadedByteCount = merged.reduce((total, [rangeStart, rangeEnd]) => total + rangeEnd - rangeStart, 0);
    this.onProgress?.(this.loadedByteCount, this.file.size);
    this.onDataProgress(this.loadedByteCount, this.file.size);
  }
}

export async function openLocalPdf(
  file: Blob,
  fileName: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ document: pdfjsLib.PDFDocumentProxy; transport: LocalPdfFileRangeTransport }> {
  const transport = new LocalPdfFileRangeTransport(file, fileName, onProgress);
  const loadingTask = pdfjsLib.getDocument({
    range: transport,
    length: file.size,
    rangeChunkSize: PDF_FILE_RANGE_CHUNK_SIZE,
    disableAutoFetch: true,
    disableStream: true,
  });

  try {
    return { document: await loadingTask.promise, transport };
  } catch (error) {
    try {
      await loadingTask.destroy();
    } catch {
      // Preserve the original PDF or local-file read error.
    }
    throw transport.failureReason ?? error;
  }
}

export function describeFileReadError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "خطأ غير معروف";
  if (typeof error === "string" && error.trim()) return error;

  if (error && typeof error === "object") {
    const value = error as { name?: unknown; message?: unknown; code?: unknown };
    const name = typeof value.name === "string" && value.name !== "Error" ? value.name : "";
    const code = typeof value.code === "string" ? value.code : "";
    const message = typeof value.message === "string" ? value.message : "";
    const detail = [name, code, message].filter(Boolean).join(": ");
    if (detail) return detail;
    try {
      return JSON.stringify(error) || "خطأ غير معروف من قارئ PDF";
    } catch {
      return "خطأ غير معروف من قارئ PDF";
    }
  }

  return error == null ? "سبب غير معروف" : String(error);
}
