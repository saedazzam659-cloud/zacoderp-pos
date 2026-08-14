/** Tiny in-memory bus so the barcode scan screen can hand the code back to whoever opened it. */

type Handler = (code: string) => void;

let handler: Handler | null = null;

export function onScan(h: Handler) {
  handler = h;
}

export function emitScan(code: string) {
  const h = handler;
  handler = null;
  h?.(code);
}

export function clearScan() {
  handler = null;
}
