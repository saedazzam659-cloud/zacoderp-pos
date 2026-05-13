// ─── Local-disk archive for journal-entry attachments ─────────────────────
// Uses the File System Access API (Chrome / Edge / Brave) to write files
// directly to a folder on the user's machine that they pick **once**. The
// FileSystemDirectoryHandle is persisted in IndexedDB so subsequent saves
// happen silently with no further prompts.
//
// Falls back to a regular browser download (Downloads folder) on Safari /
// Firefox where the API is not yet available.
//
// A lightweight per-JE index lives in localStorage so the UI can show a
// "📎 N مستندات" badge and list previously archived files for a given JE.

import { openDB, type IDBPDatabase } from "idb";

// ─── IndexedDB: stores the FileSystemDirectoryHandle ──────────────────────
const DB_NAME = "zacode-archive";
const DB_VERSION = 1;
const STORE = "fs-handles";
const HANDLE_KEY = "root-folder";

let dbPromise: Promise<IDBPDatabase> | null = null;
function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      },
    });
  }
  return dbPromise;
}

export function isFsAccessSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

/** Returns the previously chosen archive folder handle, or null. */
export async function getArchiveFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFsAccessSupported()) return null;
  const db = await getDb();
  const handle = (await db.get(STORE, HANDLE_KEY)) as FileSystemDirectoryHandle | undefined;
  if (!handle) return null;

  // Re-check permission — the browser may have evicted it between sessions.
  const opts = { mode: "readwrite" as const };
  const perm = await (handle as any).queryPermission(opts);
  if (perm === "granted") return handle;
  const req = await (handle as any).requestPermission(opts);
  return req === "granted" ? handle : null;
}

/** Prompts the user to pick a folder; persists the handle for future use. */
export async function pickArchiveFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFsAccessSupported()) return null;
  // @ts-expect-error — Chrome-only API not yet in TS lib
  const handle: FileSystemDirectoryHandle = await window.showDirectoryPicker({
    id: "zacode-archive",
    mode: "readwrite",
    startIn: "documents",
  });
  const db = await getDb();
  await db.put(STORE, handle, HANDLE_KEY);
  return handle;
}

/** Forgets the saved folder so the user can re-pick it. */
export async function clearArchiveFolder(): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, HANDLE_KEY);
}

/** Walks/creates a nested sub-folder path inside the root handle. */
async function ensureSubfolder(
  root: FileSystemDirectoryHandle,
  parts: string[],
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const raw of parts) {
    const safe = sanitizeName(raw);
    if (!safe) continue;
    dir = await dir.getDirectoryHandle(safe, { create: true });
  }
  return dir;
}

function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * Writes `file` into <root>/<subPath...>/<filename>. Returns the final
 * relative path so the caller can show / index it.
 *
 * If the FS Access API is unavailable OR no folder handle is supplied,
 * falls back to a regular browser download.
 */
export async function saveToArchive(
  root: FileSystemDirectoryHandle | null,
  subPath: string[],
  filename: string,
  blob: Blob,
): Promise<{ ok: true; path: string; viaDownload: boolean }> {
  const safeName = sanitizeName(filename);
  if (!root) {
    // Fallback: regular download
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = safeName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { ok: true, path: safeName, viaDownload: true };
  }
  const dir = await ensureSubfolder(root, subPath);
  const fileHandle = await dir.getFileHandle(safeName, { create: true });
  const writable = await (fileHandle as any).createWritable();
  await writable.write(blob);
  await writable.close();
  return { ok: true, path: [...subPath.map(sanitizeName), safeName].join("/"), viaDownload: false };
}

// ─── Per-JE index in localStorage ─────────────────────────────────────────
const INDEX_KEY = "zacode-archive-index";

export interface ArchivedFileMeta {
  filename: string;
  path: string;          // relative to archive root
  bytes: number;
  pages?: number;
  savedAt: string;       // ISO
  viaDownload: boolean;
}

type IndexShape = Record<string, ArchivedFileMeta[]>;

function readIndex(): IndexShape {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeIndex(idx: IndexShape) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(idx)); } catch { /* quota — ignore */ }
}

export function getArchivedFiles(jeKey: string): ArchivedFileMeta[] {
  return readIndex()[jeKey] ?? [];
}

export function recordArchivedFile(jeKey: string, meta: ArchivedFileMeta): void {
  const idx = readIndex();
  if (!idx[jeKey]) idx[jeKey] = [];
  idx[jeKey].push(meta);
  writeIndex(idx);
}

export function removeArchivedFile(jeKey: string, filename: string): void {
  const idx = readIndex();
  if (!idx[jeKey]) return;
  idx[jeKey] = idx[jeKey].filter((f) => f.filename !== filename);
  if (idx[jeKey].length === 0) delete idx[jeKey];
  writeIndex(idx);
}

/**
 * Tries to open a previously archived file by reading it back through the
 * stored folder handle. Returns a blob URL that the caller should revoke.
 */
export async function openArchivedFile(meta: ArchivedFileMeta): Promise<string | null> {
  if (meta.viaDownload) return null;     // can't reach the user's Downloads folder
  const root = await getArchiveFolder();
  if (!root) return null;
  try {
    const parts = meta.path.split("/");
    const filename = parts.pop()!;
    let dir = root;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: false });
    const fh = await dir.getFileHandle(filename, { create: false });
    const file = await fh.getFile();
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}
