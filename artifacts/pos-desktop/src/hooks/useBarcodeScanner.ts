// Global keyboard-wedge barcode scanner listener.
//
// USB barcode scanners present as HID keyboards: they "type" the barcode at
// ~1000 chars/sec then send Enter. We detect that pattern by:
//   1. Buffering keypresses while the gap between them is < `maxCharInterval` ms
//   2. On Enter (or after `idleTimeout` ms of silence), flush the buffer
//   3. If length ≥ `minLength`, treat as a scan and call `onScan(code)`
//
// Manual typing is filtered out because human keystrokes are >50ms apart and
// rarely span 8+ characters without a pause.
//
// Hook is safe in browser dev mode (no Tauri required).

import { useEffect, useRef } from "react";

interface Options {
  onScan: (code: string) => void;
  enabled?: boolean;
  minLength?: number;        // minimum chars to count as a barcode (default 4)
  maxCharInterval?: number;  // max ms between chars to stay in same scan (default 50)
  idleTimeout?: number;      // ms of silence to auto-flush without Enter (default 100)
}

export function useBarcodeScanner({
  onScan,
  enabled = true,
  minLength = 4,
  maxCharInterval = 50,
  idleTimeout = 100,
}: Options) {
  const bufRef = useRef<string>("");
  const lastTsRef = useRef<number>(0);
  const flushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const flush = () => {
      const code = bufRef.current;
      bufRef.current = "";
      if (flushTimerRef.current) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (code.length >= minLength) onScan(code);
    };

    const onKey = (e: KeyboardEvent) => {
      // Skip when the user is typing into an input — they probably want to
      // search/edit, not scan into a global handler. The POS UI can opt back
      // in by setting `data-allow-scan` on the focused field.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inField =
        (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) &&
        !target?.dataset?.allowScan;
      if (inField) return;

      const now = performance.now();
      const gap = now - lastTsRef.current;
      lastTsRef.current = now;

      // Enter terminates a scan (most scanners send CR/LF as suffix)
      if (e.key === "Enter") {
        if (bufRef.current.length > 0) {
          e.preventDefault();
          flush();
        }
        return;
      }

      // Only single printable chars contribute to a scan
      if (e.key.length !== 1) return;

      // Gap too long → start a fresh buffer
      if (gap > maxCharInterval) bufRef.current = "";
      bufRef.current += e.key;

      // Reset idle flush timer
      if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = window.setTimeout(flush, idleTimeout);
    };

    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
    };
  }, [enabled, minLength, maxCharInterval, idleTimeout, onScan]);
}
