// ─── Central "Save As" file writer ───────────────────────────────────────────
// Prefers the native OS save-location dialog (File System Access API — Chromium
// desktop: Chrome/Edge) with a smart suggested filename and a remembered
// last-used folder (via a stable `id`). Falls back to a classic auto-download
// when the API is unavailable (Firefox / Safari / mobile / cross-origin iframe)
// or when the transient user gesture has expired (heavy async PDF renders).
//
// GESTURE SAFETY: `showSaveFilePicker` requires transient user activation, so
// callers must reach `saveBlob` WITHOUT an intervening `await` after the click.
// `saveWorkbook` therefore serialises the workbook synchronously before handing
// off to `saveBlob` (whose first `await` is the picker itself).
import * as XLSX from "xlsx";

const EXT_MIME: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

const EXT_DESC: Record<string, string> = {
  ".xlsx": "ملف Excel",
  ".xls": "ملف Excel",
  ".csv": "ملف CSV",
  ".pdf": "ملف PDF",
  ".json": "ملف JSON",
  ".txt": "ملف نصي",
  ".xml": "ملف XML",
  ".zip": "ملف مضغوط",
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

type SaveFilePicker = (opts: {
  suggestedName?: string;
  id?: string;
  startIn?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<{
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
}>;

function classicDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Save a Blob to disk, prompting the user to choose a location when possible.
 * Never throws — user-cancel is a silent no-op, and any picker failure degrades
 * to a classic download so the user always gets their file.
 */
export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  if (typeof picker === "function") {
    const ext = extOf(filename);
    const mime = blob.type || EXT_MIME[ext] || "application/octet-stream";
    const types = ext
      ? [{ description: EXT_DESC[ext] ?? "ملف", accept: { [mime]: [ext] } }]
      : undefined;
    try {
      const handle = await picker({
        suggestedName: filename,
        id: "zacode-exports",
        startIn: "documents",
        ...(types ? { types } : {}),
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      // User dismissed the dialog → honour the cancel, do nothing.
      if ((err as { name?: string })?.name === "AbortError") return;
      // SecurityError (expired gesture), NotAllowedError, iframe block, etc.
      // → fall through to the classic download so the export still succeeds.
    }
  }
  classicDownload(blob, filename);
}

/**
 * Drop-in replacement for XLSX.writeFile(wb, filename) that routes through the
 * Save-As dialog. Serialises synchronously to preserve the click gesture.
 */
export function saveWorkbook(
  wb: XLSX.WorkBook,
  filename: string,
): Promise<void> {
  const bookType = extOf(filename) === ".xls" ? "xls" : "xlsx";
  const data = XLSX.write(wb, { bookType, type: "array" }) as ArrayBuffer;
  const blob = new Blob([data], {
    type: EXT_MIME["." + bookType] ?? "application/octet-stream",
  });
  return saveBlob(blob, filename);
}
