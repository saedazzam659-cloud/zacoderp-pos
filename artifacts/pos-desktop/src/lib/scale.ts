// Task #201 — scale (weighing) integration.
//
// Two completely independent code paths live here:
//
//   1. SERIAL SCALE READOUT
//      A real RS-232 / USB-serial scale wired to the till. We open the
//      port for a single 1500 ms read on demand (no background thread,
//      no port leak) via the `read_weight_once` Tauri command and parse
//      whichever protocol the operator configured (CAS, Bizerba, or a
//      generic ASCII "  1.234 kg <CR><LF>" frame). All weights are
//      normalised to kilograms by the Rust side.
//
//   2. EMBEDDED-WEIGHT BARCODE
//      A barcode-printing scale at the deli/produce station prints
//      EAN-13 stickers whose digits encode prefix(2) + PLU(N) +
//      weight(N) + check(1). Lookup by PLU resolves the item; weight
//      becomes the line qty and pricePerKg becomes the unit price.
//      The default profile follows the common 20/22 "weight item"
//      convention used in MENA grocery markets.

import { IS_TAURI, tauriInvoke } from "./localStore";

export type ScaleProtocol = "cas" | "bizerba" | "generic_ascii";
export type ScaleParity = "none" | "odd" | "even";
export type ScaleDataBits = 5 | 6 | 7 | 8;

export interface EmbeddedBarcodeProfile {
  /** Master switch for the embedded-weight barcode path. When false,
   * `parseEmbeddedWeightBarcode` returns null regardless of the barcode
   * shape, so scans always go through the normal item lookup. Round-3
   * review fix — settings now expose an explicit on/off toggle. */
  enabled: boolean;
  /** Two-digit "weight item" prefix (commonly 20 or 22). */
  prefix: string;
  /** PLU length in digits (typically 5). */
  pluLen: number;
  /** Weight digits — includes the implicit decimals (typically 5). */
  weightLen: number;
  /** How many of those weight digits are the fraction (typically 3). */
  weightDecimals: number;
}

export interface ScaleConfig {
  /** Serial port path. "" disables the live readout. */
  port: string;
  /** Baud rate (9600 is by far the most common). */
  baud: number;
  protocol: ScaleProtocol;
  /** Parity bit. Most scales use "none"; CAS DS-series ships "even". */
  parity: ScaleParity;
  /** Data bits per frame. Always 8 unless the scale documentation says otherwise. */
  dataBits: ScaleDataBits;
  embedded: EmbeddedBarcodeProfile;
}

export const DEFAULT_SCALE_CONFIG: ScaleConfig = {
  port: "",
  baud: 9600,
  protocol: "generic_ascii",
  parity: "none",
  dataBits: 8,
  embedded: { enabled: true, prefix: "20", pluLen: 5, weightLen: 5, weightDecimals: 3 },
};

const LS_KEY = "pos_desktop_scale_cfg_v1";

export function getScaleConfig(): ScaleConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_SCALE_CONFIG;
    const parsed = JSON.parse(raw) as Partial<ScaleConfig>;
    return {
      ...DEFAULT_SCALE_CONFIG,
      ...parsed,
      embedded: { ...DEFAULT_SCALE_CONFIG.embedded, ...(parsed.embedded ?? {}) },
    };
  } catch {
    return DEFAULT_SCALE_CONFIG;
  }
}

export function setScaleConfig(cfg: ScaleConfig): void {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
}

/**
 * One-shot weight read from the configured scale. Returns kg as a
 * number. Throws when no port is configured or the read times out.
 * Safe to call repeatedly (each call is independently scoped — the
 * Rust side closes the port at the end of every call).
 */
export async function readWeightOnce(): Promise<number> {
  const cfg = getScaleConfig();
  if (!cfg.port) throw new Error("لم يتم اختيار منفذ الميزان");
  if (!IS_TAURI) {
    // Browser preview has no serial access — surface a clear error so
    // the modal falls back to manual entry.
    throw new Error("قراءة الميزان متاحة فقط داخل تطبيق الويندوز");
  }
  // Rust returns Option<Weight> with { valueKg, stable, raw } (serde
  // rename_all = "camelCase"). null = no frame captured within the
  // 1.5s window — surface as a clear error so the modal can fall back
  // to manual entry without a silent "0.000 kg" reading.
  const w = await tauriInvoke<{ valueKg: number; stable: boolean; raw: string } | null>(
    "read_weight_once",
    { port: cfg.port, baud: cfg.baud, protocol: cfg.protocol,
      parity: cfg.parity, data_bits: cfg.dataBits },
  );
  if (!w) throw new Error("لم يصل وزن من الميزان خلال المهلة");
  return w.valueKg;
}

/** Enumerate serial ports visible to the OS. Empty array on browser preview. */
export async function listScalePorts(): Promise<string[]> {
  if (!IS_TAURI) return [];
  try {
    return await tauriInvoke<string[]>("list_scale_ports");
  } catch {
    return [];
  }
}

/**
 * Try to parse a scanned code as a scale-embedded weight barcode.
 * Returns `{ plu, weightKg }` on a match, or null otherwise. The check
 * digit (the final character of an EAN-13) is intentionally NOT
 * validated here because scale printers vary in whether they emit a
 * recomputed CD; trust the scanner's own validation.
 */
export function parseEmbeddedWeightBarcode(
  code: string,
  profile: EmbeddedBarcodeProfile = getScaleConfig().embedded,
): { plu: string; weightKg: number } | null {
  if (!profile.enabled) return null;
  if (!code || !/^[0-9]+$/.test(code)) return null;
  const need = profile.prefix.length + profile.pluLen + profile.weightLen + 1; // +CD
  if (code.length !== need) return null;
  if (!code.startsWith(profile.prefix)) return null;
  const plu = code.slice(profile.prefix.length, profile.prefix.length + profile.pluLen);
  const weightDigits = code.slice(
    profile.prefix.length + profile.pluLen,
    profile.prefix.length + profile.pluLen + profile.weightLen,
  );
  const n = Number(weightDigits);
  if (!Number.isFinite(n)) return null;
  const weightKg = n / Math.pow(10, profile.weightDecimals);
  if (weightKg <= 0) return null;
  return { plu, weightKg };
}
