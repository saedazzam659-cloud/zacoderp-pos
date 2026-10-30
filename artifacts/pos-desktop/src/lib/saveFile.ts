// Unified "Save As" export helper for the POS-desktop app.
//   • Desktop (Tauri): routes through a native Windows save dialog
//     (`save_text_file` for text, `save_export_file` for binary) so the
//     cashier picks the destination instead of a silent WebView2 download.
//   • Browser/Vite preview: uses the File System Access API save picker when
//     available, otherwise falls back to a classic anchor download.
//
// GESTURE SAFETY: `showSaveFilePicker` needs transient user activation, so
// callers must build the payload synchronously and reach these helpers WITHOUT
// an intervening `await` after the click — the first `await` here is the
// picker/dialog itself.
import * as XLSX from "xlsx";
import { invoke } from "./tauri-shim";

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

const EXT_MIME: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv;charset=utf-8;",
  pdf: "application/pdf",
  txt: "text/plain;charset=utf-8;",
};
const EXT_FILTER: Record<string, string> = {
  xlsx: "Excel",
  csv: "CSV",
  pdf: "PDF",
  txt: "Text",
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function classicDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

async function webPicker(blob: Blob, filename: string): Promise<boolean> {
  const w = window as unknown as {
    showSaveFilePicker?: (opts: unknown) => Promise<{
      createWritable: () => Promise<{
        write: (data: Blob) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }>;
  };
  if (typeof w.showSaveFilePicker !== "function") return false;
  try {
    const handle = await w.showSaveFilePicker({
      suggestedName: filename,
      id: "pos-desktop-exports",
      startIn: "documents",
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (e) {
    // User cancelled → treat as handled (do NOT fall back to auto-download).
    if ((e as { name?: string })?.name === "AbortError") return true;
    return false;
  }
}

// Save UTF-8 text (CSV, etc.) via a Save-As prompt.
export async function saveText(content: string, filename: string): Promise<void> {
  const ext = extOf(filename);
  const mime = EXT_MIME[ext] ?? "text/plain;charset=utf-8;";
  if (isTauri()) {
    try {
      await invoke<string | null>("save_text_file", {
        content,
        suggestedName: filename,
        filterName: EXT_FILTER[ext] ?? "File",
        filterExt: ext || "txt",
      });
      return;
    } catch {
      /* fall through to browser download */
    }
  } else if (await webPicker(new Blob([content], { type: mime }), filename)) {
    return;
  }
  classicDownload(new Blob([content], { type: mime }), filename);
}

// Save binary bytes (xlsx, pdf, etc.) via a Save-As prompt.
async function saveBinary(data: ArrayBuffer, filename: string): Promise<void> {
  const ext = extOf(filename);
  const mime = EXT_MIME[ext] ?? "application/octet-stream";
  if (isTauri()) {
    try {
      await invoke<string | null>("save_export_file", {
        bytes: Array.from(new Uint8Array(data)),
        suggestedName: filename,
        filterName: EXT_FILTER[ext] ?? "File",
        filterExt: ext || "bin",
      });
      return;
    } catch {
      /* fall through to browser download */
    }
  } else if (await webPicker(new Blob([data], { type: mime }), filename)) {
    return;
  }
  classicDownload(new Blob([data], { type: mime }), filename);
}

// Drop-in replacement for XLSX.writeFile(wb, filename): serialises the workbook
// synchronously (gesture-safe), then routes through the Save-As prompt.
export function saveWorkbook(wb: XLSX.WorkBook, filename: string): void {
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  void saveBinary(out, filename);
}
